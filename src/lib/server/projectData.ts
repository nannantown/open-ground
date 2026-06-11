import { mkdir, readFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import type { BoardColumn, ProjectConfig, ProjectData, ProjectTask } from '../types'
import { atomicWriteJson, atomicWriteText } from './atomicWrite'
import { isValidProjectPath, projectDataDir, projectDataFile } from './projectDataPath'
import { ProjectDataSchema, ProjectTaskSchema } from '../schemas'
import { noteSharedWrite } from './shareAutoSync'
import {
  SHARED_DATA_VERSION,
  boardCardsDir,
  boardNotesPath,
  isShared,
  readSharedMarker,
  writeSharedMarker,
} from './sharedData'

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

// Read the CENTRAL tasks.json (~/.openground/projects/<uuid>/tasks.json).
// This is the whole story in normal mode; in git-shared mode it still holds
// the PERSONAL fields (tabOrder, updatedAt) plus a stale backup of the shared
// ones (the marker decides the live source — see readProjectData).
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
  // Field-level recovery: keep only entries that individually pass their
  // schema, drop the rest. Anything not even an array becomes [].
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
  return {
    description: typeof obj.description === 'string' ? obj.description : '',
    tasks: filterValid(obj.tasks, ProjectTaskSchema) as ProjectData['tasks'],
    tabOrder: Array.isArray(obj.tabOrder)
      ? obj.tabOrder.filter((x): x is string => typeof x === 'string')
      : undefined,
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  }
}

// ── Git-shared mode (".openground/" inside the repo) ─────────────────────────
// When the repo carries a parseable .openground/openground.json marker, the
// SHARED fields live in the repo (one card file per task + notes.md + the
// marker's description) and only the PERSONAL fields (tabOrder, updatedAt)
// stay in the central tasks.json. The public readProjectData/writeProjectData
// API is unchanged — callers never know which mode a project is in. See
// docs/SHARED_DATA_PLAN.md.

// A card's file name is its task id. Task ids are crypto.randomUUID() from our
// own routes, but a claude session (or a teammate's hand edit) could invent
// one — never let an id traverse out of board/cards/.
const isSafeCardId = (id: string): boolean => /^[A-Za-z0-9._-]+$/.test(id) && id !== '.' && id !== '..'

// Stable on-disk shape: fixed key order, undefined keys omitted — so the
// "did it change?" diff (and git itself) never churns on key reordering.
const normalizeCard = (t: ProjectTask): ProjectTask => ({
  id: t.id,
  title: t.title,
  ...(t.notes !== undefined ? { notes: t.notes } : {}),
  done: t.done,
  createdAt: t.createdAt,
  ...(t.boardColumn !== undefined ? { boardColumn: t.boardColumn } : {}),
  ...(t.assignee !== undefined ? { assignee: t.assignee } : {}),
  ...(t.boardOrder !== undefined ? { boardOrder: t.boardOrder } : {}),
  ...(t.prUrl !== undefined ? { prUrl: t.prUrl } : {}),
  ...(t.branch !== undefined ? { branch: t.branch } : {}),
  ...(t.titleAuto !== undefined ? { titleAuto: t.titleAuto } : {}),
})

const serializeCard = (t: ProjectTask): string => JSON.stringify(normalizeCard(t), null, 2)

// Deterministic read order for cards composed from a directory listing
// (readdir order is filesystem-dependent): column → boardOrder → createdAt →
// id. Mirrors the Board UI's columnOf/byColumnOrder (BoardTab.tsx), with id as
// the final total-order tiebreak.
const COLUMN_RANK: Record<BoardColumn, number> = { todo: 0, doing: 1, review: 2, done: 3, blocked: 4 }
const columnRank = (t: ProjectTask): number =>
  COLUMN_RANK[t.boardColumn ?? (t.done ? 'done' : 'todo')]
const byBoardPosition = (a: ProjectTask, b: ProjectTask): number => {
  const col = columnRank(a) - columnRank(b)
  if (col !== 0) return col
  const ao = a.boardOrder
  const bo = b.boardOrder
  if (ao != null && bo != null && ao !== bo) return ao - bo
  if (ao != null && bo == null) return -1
  if (ao == null && bo != null) return 1
  if ((a.createdAt || '') !== (b.createdAt || '')) return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// One ProjectTask per file under .openground/board/cards/. A corrupt or
// schema-invalid file is SKIPPED (warn + keep the file on disk for the user /
// git to recover) — a teammate's bad merge must never nuke the whole board.
// Missing dir = no tasks (fresh share, or notes-only board).
const readSharedBoardTasks = async (projectPath: string): Promise<ProjectTask[]> => {
  const dir = boardCardsDir(projectPath)
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const tasks: ProjectTask[] = []
  for (const f of files) {
    try {
      const raw: unknown = JSON.parse(await readFile(join(dir, f), 'utf8'))
      const r = ProjectTaskSchema.safeParse(raw)
      if (r.success) {
        tasks.push(r.data)
      } else {
        // eslint-disable-next-line no-console
        console.warn(`[projectData] shared board card ${f} failed schema validation at ${projectPath} — skipped`)
      }
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[projectData] shared board card ${f} is not valid JSON at ${projectPath} — skipped`)
    }
  }
  return tasks.sort(byBoardPosition)
}

const readSharedNotes = async (projectPath: string): Promise<string> => {
  try {
    return await readFile(boardNotesPath(projectPath), 'utf8')
  } catch {
    return ''
  }
}

export const readProjectData = async (projectPath: string): Promise<ProjectData> => {
  // Central read FIRST in both modes: it routes through projectDataPath, so an
  // unregistered path throws loud here before we touch any repo files. In
  // shared mode it supplies the personal fields; a missing central file (fresh
  // clone on a new machine) just yields empty() = no tabOrder yet.
  const central = await readCentralProjectData(projectPath)
  if (!(await isShared(projectPath))) return central
  const [marker, tasks, notes] = await Promise.all([
    readSharedMarker(projectPath),
    readSharedBoardTasks(projectPath),
    readSharedNotes(projectPath),
  ])
  return {
    description: marker?.description ?? '',
    ...(marker?.descriptionJa ? { descriptionJa: marker.descriptionJa } : {}),
    ...(marker?.descriptionEn ? { descriptionEn: marker.descriptionEn } : {}),
    tasks,
    ...(central.tabOrder !== undefined ? { tabOrder: central.tabOrder } : {}),
    // Shared policy rides the marker; personal launch prefs stay central.
    ...(marker?.config ? { config: parseSharedConfig(marker.config) } : {}),
    ...(central.launch !== undefined ? { launch: central.launch } : {}),
    notes,
    updatedAt: central.updatedAt,
  }
}

// Validate a marker's raw config blob into ProjectConfig (drop junk fields /
// wrong types — a hand-edited marker must never crash the read).
const parseSharedConfig = (raw: Record<string, unknown>): ProjectConfig => {
  const out: ProjectConfig = {}
  if (raw.completionFlow === 'merge' || raw.completionFlow === 'pr') out.completionFlow = raw.completionFlow
  if (typeof raw.targetBranch === 'string') out.targetBranch = raw.targetBranch
  if (Array.isArray(raw.verifyCommands)) {
    out.verifyCommands = raw.verifyCommands.filter((c): c is string => typeof c === 'string')
  }
  if (typeof raw.reviewColumn === 'boolean') out.reviewColumn = raw.reviewColumn
  if (Array.isArray(raw.members)) {
    out.members = raw.members.filter((m): m is string => typeof m === 'string')
  }
  return out
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_board_writes: Map<string, Promise<unknown>> | undefined
}

// Per-project serial queue for SHARED board writes (and the share migrations).
// The shared write is a read-diff-write across many files (card files + notes
// + marker + central personal fields); two concurrent writes interleaving
// could resurrect a just-deleted card file. The central-only path stays a
// single atomic whole-file write and is NOT queued — exactly as before. Same
// shape as canvasData's index queue; survives tsx-watch reloads via globalThis.
const boardWriteQueue: Map<string, Promise<unknown>> =
  globalThis.__openground_board_writes ??
  (globalThis.__openground_board_writes = new Map())

const withBoardLock = <T>(projectPath: string, fn: () => Promise<T>): Promise<T> => {
  const prev = boardWriteQueue.get(projectPath) ?? Promise.resolve()
  const myRun = prev.then(fn)
  // Keep the queue advancing even if one op throws.
  boardWriteQueue.set(projectPath, myRun.catch(() => undefined))
  return myRun
}

// Write the SHARED side of a ProjectData into the repo: diff card files (write
// changed/new, unlink removed), notes.md only when changed, marker description
// preserving an existing marker's version (creating the marker only when
// `ensureMarker` — writeProjectData must never flip an unshared repo into
// shared mode; only the migration does). Caller holds the board lock.
const writeSharedBoard = async (
  projectPath: string,
  data: Pick<ProjectData, 'description' | 'descriptionJa' | 'descriptionEn' | 'config' | 'tasks' | 'notes'>,
  opts?: { ensureMarker?: boolean; ensureNotesFile?: boolean },
): Promise<void> => {
  const cardsDir = boardCardsDir(projectPath)
  await mkdir(cardsDir, { recursive: true })
  let existing: string[] = []
  try {
    existing = (await readdir(cardsDir)).filter((f) => f.endsWith('.json'))
  } catch {}
  const nextById = new Map<string, ProjectTask>()
  for (const t of data.tasks) {
    if (!isSafeCardId(t.id)) {
      // eslint-disable-next-line no-console
      console.warn(`[projectData] task id ${JSON.stringify(t.id)} is not a safe file name — not written to the shared board at ${projectPath}`)
      continue
    }
    nextById.set(t.id, t)
  }
  // Write changed/new cards. Skip-if-identical keeps git (and mtimes) quiet
  // when e.g. only the notes changed.
  for (const [id, task] of Array.from(nextById.entries())) {
    const file = join(cardsDir, `${id}.json`)
    const serialized = serializeCard(task)
    let current: string | null = null
    try {
      current = await readFile(file, 'utf8')
    } catch {}
    if (current !== serialized) await atomicWriteText(file, serialized)
  }
  // Unlink removed cards' files.
  for (const f of existing) {
    const id = f.slice(0, -'.json'.length)
    if (!nextById.has(id)) await unlink(join(cardsDir, f)).catch(() => {})
  }
  // notes.md — plain utf-8 markdown; write only when changed (a missing file
  // reads as '', so an empty-notes board doesn't churn the file — except the
  // migration, which materializes it so the shared layout is complete).
  let currentNotes: string | null = null
  try {
    currentNotes = await readFile(boardNotesPath(projectPath), 'utf8')
  } catch {}
  if ((currentNotes ?? '') !== data.notes || (opts?.ensureNotesFile && currentNotes === null)) {
    await atomicWriteText(boardNotesPath(projectPath), data.notes)
  }
  // Marker description (the Ground card's one-liner travels with the repo).
  // Preserve an existing marker's version — never downgrade a newer share.
  const marker = await readSharedMarker(projectPath)
  const descFields = {
    description: data.description,
    ...(data.descriptionJa !== undefined ? { descriptionJa: data.descriptionJa } : {}),
    ...(data.descriptionEn !== undefined ? { descriptionEn: data.descriptionEn } : {}),
    ...(data.config !== undefined ? { config: data.config as Record<string, unknown> } : {}),
  }
  if (marker) {
    if (
      (marker.description ?? '') !== data.description ||
      marker.descriptionJa !== data.descriptionJa ||
      marker.descriptionEn !== data.descriptionEn ||
      (data.config !== undefined &&
        JSON.stringify(marker.config ?? null) !== JSON.stringify(data.config))
    ) {
      await writeSharedMarker(projectPath, { ...marker, ...descFields })
    }
  } else if (opts?.ensureMarker) {
    await writeSharedMarker(projectPath, { version: SHARED_DATA_VERSION, ...descFields })
  }
}

/** Thrown by {@link writeProjectData} when the caller's snapshot is stale —
 *  the store was written (by another window, another client, or a git pull
 *  reflected through a later read) after the caller last read it. The route
 *  maps this to HTTP 409; the client reloads instead of clobbering. Born from
 *  a real incident: a second window holding a PRE-share empty board persisted
 *  it and wiped the shared card files of a freshly-shared project. */
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

/** The CAS token lives in the CENTRAL tasks.json's `updatedAt` in BOTH modes
 *  (shared writes bump it too — it's the personal-fields holder). Missing /
 *  unreadable file ⇒ undefined ⇒ first write always passes. */
const storedUpdatedAt = async (dir: string): Promise<string | undefined> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(dir, TASKS_FILE), 'utf8'))
    const v = (parsed as { updatedAt?: unknown } | null)?.updatedAt
    return typeof v === 'string' ? v : undefined
  } catch {
    return undefined
  }
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
  // Resolve the central dir FIRST in both modes — it is the registry check
  // (throws on an unregistered path) and shared mode needs it anyway.
  const dir = await projectDataDir(projectPath)
  await mkdir(dir, { recursive: true })
  const checkCas = async (): Promise<void> => {
    if (opts?.expectUpdatedAt === undefined) return
    const current = await storedUpdatedAt(dir)
    if (current !== undefined && current !== opts.expectUpdatedAt) {
      throw new ProjectDataConflictError(current)
    }
  }
  if (!(await isShared(projectPath))) {
    // Normal mode: the pre-share single-file write, under the same per-project
    // lock when (and only when) a CAS check rides along — the compare and the
    // write must be atomic against a concurrent writer.
    const write = async () => {
      await checkCas()
      const next = { ...data, updatedAt: nextUpdatedAt(await storedUpdatedAt(dir)) }
      await atomicWriteJson(join(dir, TASKS_FILE), next)
      return next
    }
    return opts?.expectUpdatedAt !== undefined ? withBoardLock(projectPath, write) : write()
  }
  return withBoardLock(projectPath, async () => {
    await checkCas()
    const now = nextUpdatedAt(await storedUpdatedAt(dir))
    await writeSharedBoard(projectPath, data)
    // Personal fields stay central. Keep whatever shared-fields backup the
    // central file holds from the enable migration (the marker decides the
    // live source); only tabOrder/updatedAt move.
    let centralRaw: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(await readFile(join(dir, TASKS_FILE), 'utf8'))
      centralRaw = parsed && typeof parsed === 'object' ? { ...(parsed as Record<string, unknown>) } : {}
    } catch {
      centralRaw = { description: '', tasks: [], notes: '' }
    }
    delete centralRaw.tabOrder
    if (data.tabOrder !== undefined) centralRaw.tabOrder = data.tabOrder
    delete centralRaw.launch
    if (data.launch !== undefined) centralRaw.launch = data.launch
    centralRaw.updatedAt = now
    await atomicWriteJson(join(dir, TASKS_FILE), centralRaw)
    // Shared data just changed on disk — wake the auto-sync engine (debounced
    // push + tighter fetch cadence). Fire-and-forget by design.
    noteSharedWrite(projectPath)
    return { ...data, updatedAt: now }
  })
}

// ── Share migrations (called by the enable/disable routes) ──────────────────

// central → repo: split tasks.json into one card file per task + notes.md, and
// carry the description into the marker. Creates the marker (version
// SHARED_DATA_VERSION) if absent, PRESERVES an existing one's version — the
// canvas migration also ensures the marker, so this must be idempotent and
// merge-safe in either order. The central file is left in place as a stale
// backup (the marker decides the live source from now on).
export const migrateBoardToShared = (projectPath: string): Promise<void> =>
  withBoardLock(projectPath, async () => {
    const central = await readCentralProjectData(projectPath)
    await writeSharedBoard(projectPath, central, { ensureMarker: true, ensureNotesFile: true })
  })

// repo → central: fold the shared files back into the central tasks.json
// (overwriting its tasks/notes/description backup) while KEEPING the central
// personal fields. Does NOT delete .openground/ — the disable route does that.
// No-op when the project isn't actually shared (defensive: overwriting central
// with an empty board because a route raced disable would lose data).
export const migrateBoardFromShared = (projectPath: string): Promise<ProjectData> =>
  withBoardLock(projectPath, async () => {
    const central = await readCentralProjectData(projectPath)
    const marker = await readSharedMarker(projectPath)
    if (!marker) return central
    const [tasks, notes] = await Promise.all([
      readSharedBoardTasks(projectPath),
      readSharedNotes(projectPath),
    ])
    const next: ProjectData = {
      description: marker.description ?? '',
      tasks,
      ...(central.tabOrder !== undefined ? { tabOrder: central.tabOrder } : {}),
      notes,
      updatedAt: new Date().toISOString(),
    }
    const dir = await projectDataDir(projectPath)
    await mkdir(dir, { recursive: true })
    await atomicWriteJson(join(dir, TASKS_FILE), next)
    return next
  })

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
