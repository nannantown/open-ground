import { mkdir, readFile } from 'fs/promises'
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
    customTabs: Array.isArray(obj.customTabs)
      ? obj.customTabs.filter((x): x is string => typeof x === 'string')
      : undefined,
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
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

/** The CAS token lives in the central tasks.json's `updatedAt`. Missing /
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
  // Resolve the central dir (also the registry check — throws on an
  // unregistered path).
  const dir = await projectDataDir(projectPath)
  await mkdir(dir, { recursive: true })
  const checkCas = async (): Promise<void> => {
    if (opts?.expectUpdatedAt === undefined) return
    const current = await storedUpdatedAt(dir)
    if (current !== undefined && current !== opts.expectUpdatedAt) {
      throw new ProjectDataConflictError(current)
    }
  }
  // The single-file write, under the per-project lock when (and only when) a CAS
  // check rides along — the compare and the write must be atomic against a
  // concurrent writer.
  const write = async () => {
    await checkCas()
    const next = { ...data, updatedAt: nextUpdatedAt(await storedUpdatedAt(dir)) }
    await atomicWriteJson(join(dir, TASKS_FILE), next)
    return next
  }
  return opts?.expectUpdatedAt !== undefined ? withBoardLock(projectPath, write) : write()
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
