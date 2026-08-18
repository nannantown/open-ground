import { mkdir, readFile, rename } from 'fs/promises'
import { join } from 'path'
import type { ProjectData } from '../types'
import { atomicWriteJson } from './atomicWrite'
import { isValidProjectPath, projectDataDir, projectDataFile } from './projectDataPath'
import { ProjectDataSchema, ProjectTaskSchema } from '../schemas'

const TASKS_FILE = 'tasks.json'

const empty = (): ProjectData => ({
  description: '',
  tasks: [],
  notes: '',
  updatedAt: new Date().toISOString(),
})

// Tasks are Board cards — the only task kind that survives. Legacy disk data
// may still carry the old `kind` discriminator ('board' | 'chat' | 'assistant')
// or kind-less entries from before the split. Filter on the RAW parsed JSON
// (before zod strips unknown keys like `kind`):
//   - kind === 'board'                     → keep
//   - kind absent AND has a boardColumn    → legacy board card → keep
//   - everything else (chat / assistant / kind-less without boardColumn) → DROP
// No migration write — the dropped items simply vanish on the next save.
// Local single-user tool; old chats live on in claude's own JSONL logs.
const isLegacyBoardCard = (t: unknown): boolean => {
  if (!t || typeof t !== 'object') return true // let the schema decide
  const o = t as Record<string, unknown>
  if (o.kind === 'board') return true
  return o.kind == null && o.boardColumn != null
}

const dropLegacyNonBoardTasks = (parsed: unknown): unknown => {
  if (!parsed || typeof parsed !== 'object') return parsed
  const obj = parsed as Record<string, unknown>
  if (!Array.isArray(obj.tasks)) return parsed
  const tasks = obj.tasks.filter(isLegacyBoardCard).map(t => {
    // A legacy kind:'board' card might lack boardColumn (the schema strips
    // `kind`, so without a column it would read as "legacy chat" on the NEXT
    // load and silently vanish). Materialize the column once here so a kept
    // card stays a board card across write cycles.
    if (!t || typeof t !== 'object') return t
    const o = t as Record<string, unknown>
    if (o.boardColumn != null) return t
    return { ...o, boardColumn: o.done === true ? 'done' : 'todo' }
  })
  return { ...obj, tasks }
}

// Read the CENTRAL tasks.json (~/.openground/projects/<uuid>/tasks.json) — the
// single source of truth for a project's Board data + description + notes +
// personal fields (tabOrder, customTabs, launch).
const readCentralProjectData = async (projectPath: string): Promise<ProjectData> => {
  // Resolve the central file path OUTSIDE the try: an unregistered path throws
  // loud (a real bug — every route here has passed validateProjectPath), while a
  // genuinely-missing file (registered, no data yet) falls through to empty().
  const file = await projectDataFile(projectPath, TASKS_FILE)
  let rawText: string
  try {
    rawText = await readFile(file, 'utf8')
  } catch {
    return empty()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawText)
  } catch {
    // Corrupt JSON — log to stderr and serve an empty default rather
    // than crash the cockpit. The original file is left on disk so the
    // user can inspect / recover manually.
    // eslint-disable-next-line no-console
    console.warn(`[projectData] tasks.json is not valid JSON at ${projectPath}`)
    return empty()
  }
  // Silently drop legacy chat/assistant tasks BEFORE schema validation (the
  // schema strips the legacy `kind` key, so the filter must see the raw JSON).
  parsed = dropLegacyNonBoardTasks(parsed)
  // Schema-validate. When validation fails (claude wrote a half-formed
  // entry, an old format we didn't migrate, etc) we DON'T just return
  // empty — that would wipe the user's task list from their POV.
  // Instead we shallow-merge with empty() so missing/invalid sections
  // get sane defaults, and the per-field schema fields that DID validate
  // get preserved. Legacy fields the schema no longer knows (milestones,
  // goals, kind, milestoneId) are stripped here and vanish on next write.
  const validated = ProjectDataSchema.safeParse(parsed)
  if (validated.success) {
    return { ...empty(), ...validated.data }
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[projectData] tasks.json failed schema validation at ${projectPath} — recovering with field-level fallbacks. issues: ${validated.error.issues.map(i => i.path.join('.')).slice(0, 5).join(', ')}`,
  )
  // Field-level recovery: salvage EVERY field the schema knows, one field at a
  // time through the schema's own shape — keep what individually validates,
  // default what doesn't. Tasks recover per-item.
  //
  // ⚠ SHAPE-DRIVEN, NOT A REMEMBERED LIST (owner report 2026-08-18: 「気がつい
  // たら生成した説明が消えている」, measured on the prod build). This branch used
  // to rebuild a hand-typed subset — description / tasks / tabOrder /
  // customTabs / notes — so ONE type flaw anywhere in the file made the read
  // drop descriptionJa/descriptionEn (and config / launch / disabledModules),
  // and the next ordinary save erased them from disk for good. The quarantine
  // kept the original, but the live file silently lost the generated pair.
  // Iterating the schema shape is the over-approximation this repo prefers: a
  // field added to ProjectDataSchema is salvaged here automatically, and can
  // never be forgotten by a list nobody re-reads.
  const obj = (parsed && typeof parsed === 'object') ? parsed as Record<string, unknown> : {}
  const filterValid = <T>(
    arr: unknown,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T } },
  ): T[] => {
    if (!Array.isArray(arr)) return []
    const out: T[] = []
    for (const item of arr) {
      const r = schema.safeParse(item)
      if (r.success && r.data !== undefined) out.push(r.data)
    }
    return out
  }
  const salvaged: Record<string, unknown> = {}
  for (const [key, fieldSchema] of Object.entries(ProjectDataSchema.shape)) {
    if (key === 'tasks') continue // per-item recovery below
    const r = (fieldSchema as { safeParse: (v: unknown) => { success: boolean; data?: unknown } })
      .safeParse(obj[key])
    if (r.success && r.data !== undefined) salvaged[key] = r.data
  }
  return {
    ...empty(),
    ...(salvaged as Partial<ProjectData>),
    tasks: filterValid(obj.tasks, ProjectTaskSchema) as ProjectData['tasks'],
    updatedAt:
      typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  }
}

export const readProjectData = async (projectPath: string): Promise<ProjectData> => {
  // Central read routes through projectDataPath, so an unregistered path throws
  // loud here before any data is served. A missing central file (registered, no
  // data yet) yields empty().
  return readCentralProjectData(projectPath)
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_board_writes: Map<string, Promise<unknown>> | undefined
}

// Per-project serial queue for CAS-guarded board writes. A compare-and-swap
// write must hold the compare and the write atomic against a concurrent writer;
// without the lock two writers could both pass the CAS and the second clobbers
// the first. The non-CAS path stays a single atomic whole-file write and is NOT
// queued. Survives tsx-watch reloads via globalThis (same shape as canvasData's
// index queue).
//
// The lock key MUST be the canonical central data dir (projectDataDir's output —
// a UUID-derived path), NEVER the raw projectPath. Two spellings of the same
// project — '/p/x' vs '/p/x/', or a /tmp↔/private/tmp symlink — resolve to the
// SAME tasks.json but are DIFFERENT raw strings. Keying on the raw path would
// split them across two queues; both writers then read the same updatedAt at T0,
// both pass the CAS, both write, and the second SILENTLY clobbers the first (no
// ProjectDataConflictError thrown). Keying on the resolved dir — the exact file
// the write touches — makes the lock spelling-independent, so same-project
// writes always serialize while different projects (different UUIDs ⇒ different
// dirs) stay parallel.
const boardWriteQueue: Map<string, Promise<unknown>> =
  globalThis.__openground_board_writes ??
  (globalThis.__openground_board_writes = new Map())

// `lockKey` is the RESOLVED central data dir (await projectDataDir(projectPath)),
// never the raw path — see the spelling-independence note above.
const withBoardLock = <T>(lockKey: string, fn: () => Promise<T>): Promise<T> => {
  const prev = boardWriteQueue.get(lockKey) ?? Promise.resolve()
  const myRun = prev.then(fn)
  // Keep the queue advancing even if one op throws.
  boardWriteQueue.set(lockKey, myRun.catch(() => undefined))
  return myRun
}

/** Thrown by {@link writeProjectData} when the caller's snapshot is stale —
 *  the store was written (by another window, another client) after the caller
 *  last read it. The route maps this to HTTP 409; the client reloads instead of
 *  clobbering. Born from a real incident: a second window holding a stale empty
 *  board persisted it and wiped a freshly-populated project. */
export class ProjectDataConflictError extends Error {
  constructor(readonly currentUpdatedAt: string | undefined) {
    super('project data conflict: store changed since the caller last read it')
    this.name = 'ProjectDataConflictError'
  }
}

/** Strictly-monotonic write stamp. `updatedAt` doubles as the CAS token, and
 *  ISO strings only carry millisecond resolution — two writes inside the same
 *  ms would mint IDENTICAL tokens and let a stale third writer slip past the
 *  compare. Bump past the stored stamp when the clock hasn't moved. */
const nextUpdatedAt = (current: string | undefined): string => {
  const now = Date.now()
  const cur = current ? Date.parse(current) : NaN
  return new Date(Number.isFinite(cur) && cur >= now ? cur + 1 : now).toISOString()
}

/** One read of the current central tasks.json yielding the CAS token
 *  (`updatedAt`) AND whether the file's contents would be LOST by an overwrite —
 *  either because it is present-but-unparseable (`corrupt`) or because it parses
 *  but the read path takes its lossy field-level recovery branch (`damaged`:
 *  the whole-file schema fails, so some tasks/sections get dropped on read).
 *  A missing file ⇒ all false ⇒ first-write semantics (CAS passes). A
 *  corrupt/damaged file reports stamp undefined (so CAS still passes, unchanged
 *  behaviour) so the writer can quarantine it before the overwrite destroys
 *  recoverable data. */
const readCasState = async (
  dir: string,
): Promise<{ stamp: string | undefined; corrupt: boolean; damaged: boolean }> => {
  let raw: string
  try {
    raw = await readFile(join(dir, TASKS_FILE), 'utf8')
  } catch {
    return { stamp: undefined, corrupt: false, damaged: false } // missing — nothing to quarantine
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { stamp: undefined, corrupt: true, damaged: false } // present but unparseable
  }
  const v = (parsed as { updatedAt?: unknown } | null)?.updatedAt
  const stamp = typeof v === 'string' ? v : undefined
  // `damaged` mirrors readCentralProjectData's decision to fall into field-level
  // recovery: parse the SAME post-legacy-drop shape through the whole-file
  // schema. If it fails, reading this file silently drops data — so a write that
  // overwrites it would make that loss permanent unless we quarantine first.
  // Legitimate files (extra/legacy keys, .catch() fields) still pass, so the
  // happy path never quarantines.
  const damaged = !ProjectDataSchema.safeParse(dropLegacyNonBoardTasks(parsed)).success
  return { stamp, corrupt: false, damaged }
}

/** Move a damaged tasks.json aside to a timestamped sibling so the write that
 *  follows can't silently destroy data the user might still recover by hand
 *  (goal: a corrupt/invalid file is QUARANTINED, never lost). The epoch-ms stamp
 *  is Windows-safe (no ':') and unique enough; concurrent writers race on the
 *  single rename and the loser simply finds the file gone (ENOENT, ignored).
 *  Best-effort: a quarantine failure must never block the write. */
const quarantineDamagedTasks = async (dir: string): Promise<void> => {
  await rename(join(dir, TASKS_FILE), join(dir, `tasks.corrupt-${Date.now()}.json`))
}

/** The CAS compare + the atomic single-file write as one indivisible unit.
 *  Locking is the CALLER's job: run this inside {@link withBoardLock} whenever a
 *  CAS token rides along, so the compare and the write stay atomic against a
 *  concurrent writer. `dir` is the already-resolved central data dir;
 *  `expectUpdatedAt` undefined ⇒ a trusting (non-CAS) write. */
const writeCasGuarded = async (
  dir: string,
  data: ProjectData,
  expectUpdatedAt: string | undefined,
): Promise<ProjectData> => {
  // ONE read of the current file: feeds the CAS compare, the next-stamp seed,
  // and corrupt-file detection from a single consistent snapshot.
  const current = await readCasState(dir)
  if (
    expectUpdatedAt !== undefined &&
    current.stamp !== undefined &&
    current.stamp !== expectUpdatedAt
  ) {
    throw new ProjectDataConflictError(current.stamp)
  }
  // A present-but-damaged file (unparseable, or schema-invalid so the read
  // dropped data) is about to be overwritten by the atomic write below — and
  // its (possibly recoverable) contents lost forever. Preserve it as a sibling
  // quarantine first. Best-effort: never let a quarantine failure block the
  // user's save.
  if (current.corrupt || current.damaged) {
    await quarantineDamagedTasks(dir).catch(() => {})
  }
  const next = { ...data, updatedAt: nextUpdatedAt(current.stamp) }
  // fsync: tasks.json is the user's irreplaceable WORK data (board cards +
  // notes). Pay the fsync(+dir fsync) cost so a power cut right after a save
  // can't resurrect an empty/zero file (see atomicWrite's durability note).
  // Board saves are user-driven (not high-frequency), so the latency is fine.
  await atomicWriteJson(join(dir, TASKS_FILE), next, { fsync: true })
  return next
}

// Fire-and-forget mirror of a successful board write into the project's collab
// Y.Doc (bug c2e4c57c: while shared, the doc is the board's authority — a write
// it never learns about is REVERTED on the next client (re)connect, which is how
// swarm/API moves kept rolling back). Dynamic import keeps yjs + the transport
// out of this module's static graph; a no-op unless the project is actually
// collab-shared (find-only lookup, cached). NEVER blocks or fails the save.
const queueBoardMirrorSafe = (projectPath: string, saved: ProjectData): void => {
  void import('./collabMirror')
    .then((m) => m.queueBoardMirror(projectPath, saved))
    .catch(() => {})
}

export const writeProjectData = async (
  projectPath: string,
  data: ProjectData,
  opts?: {
    /** Compare-and-swap guard: the `updatedAt` the caller last READ. When set
     *  and the store currently holds a DIFFERENT updatedAt, the write is
     *  refused with {@link ProjectDataConflictError}. Omit for trusting
     *  callers (migrations, server-side read-modify-write under the lock). */
    expectUpdatedAt?: string
  },
) => {
  // Resolve the central dir (also the registry check — throws on an
  // unregistered path).
  const dir = await projectDataDir(projectPath)
  await mkdir(dir, { recursive: true })
  // The single-file write, under the per-project lock when (and only when) a CAS
  // check rides along — the compare and the write must be atomic against a
  // concurrent writer.
  const write = () => writeCasGuarded(dir, data, opts?.expectUpdatedAt)
  // Lock on the RESOLVED central dir (not projectPath) so two CAS writes issued
  // under different spellings of the same project serialize instead of racing —
  // see withBoardLock's note. `dir` is projectDataDir's UUID-derived output.
  const saved = await (opts?.expectUpdatedAt !== undefined ? withBoardLock(dir, write) : write())
  queueBoardMirrorSafe(projectPath, saved)
  return saved
}

/** Atomic server-side read-modify-write of a project's central board data. The
 *  WHOLE cycle — read the current ProjectData, apply `mutate`, write it back —
 *  runs inside the per-project board lock, so two concurrent callers can never
 *  interleave between one's read and its write. The loser waits for the winner's
 *  write to land, then reads THAT and applies its own mutation on top, so BOTH
 *  mutations persist — no lost update, no 409/500.
 *
 *  This is the race-free way to mutate board cards from a route handler
 *  (POST /api/project/tasks). The bare `read → mutate →
 *  writeProjectData({expectUpdatedAt})` sequence races, because its read sits
 *  OUTSIDE the lock that only the write takes: two handlers read the same
 *  snapshot, the first write wins, the second fails CAS — which used to surface
 *  as a 500 with the second handler's mutation silently dropped.
 *
 *  `mutate` gets the freshly-read data and may edit it in place (returning
 *  nothing) or return a replacement. Returns the saved data (bumped updatedAt).
 *  Throws on an unregistered path like {@link writeProjectData}; can only throw
 *  {@link ProjectDataConflictError} in the rare case a NON-locked trusting
 *  writer interleaves — callers map that to 409. */
export const mutateProjectData = async (
  projectPath: string,
  mutate: (data: ProjectData) => void | ProjectData | Promise<void | ProjectData>,
): Promise<ProjectData> => {
  // Resolve + registry-check up front (mirrors writeProjectData) so a bad path
  // fails fast without taking a turn in the lock queue.
  const dir = await projectDataDir(projectPath)
  await mkdir(dir, { recursive: true })
  // Lock on the RESOLVED central dir (not projectPath) — spelling-independent,
  // so a read-modify-write under one spelling can't interleave with a CAS write
  // under another spelling of the same project. See withBoardLock's note.
  const saved = await withBoardLock(dir, async () => {
    const data = await readProjectData(projectPath)
    const next = (await mutate(data)) ?? data
    // The CAS token is the stamp we just read INSIDE the lock: other locked
    // writers serialize behind us so it can't have moved; the guard only fires
    // if a non-locked trusting writer slipped in, which is exactly when a
    // refusal is correct.
    return writeCasGuarded(
      dir,
      next,
      typeof data.updatedAt === 'string' ? data.updatedAt : undefined,
    )
  })
  queueBoardMirrorSafe(projectPath, saved)
  return saved
}

export const taskCounts = (data: ProjectData) => {
  const total = data.tasks.length
  const open = data.tasks.filter(t => !t.done).length
  return { total, open }
}

// Security boundary (CONTRACT §3.3): the resolved-and-canonicalized path must
// sit AT or UNDER one of the registered projects, OR under that project's
// central worktrees dir (~/.openground/projects/<uuid>/worktrees/). The registry
// (Settings.projects) is the allowlist — it can only grow via explicit user
// action (Create new / Import existing folder). Symlinks are followed (see
// canonicalize) so a symlink can't be used to escape a registered root.
//
// The full predicate (incl. the central-worktree arm, the UUID-from-registry-
// only rule and the bare-data-root rejection) lives in projectDataPath.ts so
// the security boundary and the data resolver can never drift. Kept exported
// here because middleware/projectPath.ts imports it from this module.
export const validateProjectPath = (projectPath: string): Promise<boolean> =>
  isValidProjectPath(projectPath)
