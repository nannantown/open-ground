import { mkdir, readFile, rename, stat, realpath } from 'fs/promises'
import { basename, dirname, join, resolve, sep } from 'path'
import type { ProjectData, Settings } from '../types'
import { getSettings } from './store'
import { atomicWriteJson } from './atomicWrite'
import { pruneTaskImages } from './taskImages'
import { ensureOpenGroundProjectDir } from './projectMigration'
import {
  ProjectDataSchema,
  ProjectTaskSchema,
  ProjectMilestoneSchema,
  GoalSchema,
} from '../schemas'

const DATA_FILE = '.openground/tasks.json'

const empty = (): ProjectData => ({
  description: '',
  tasks: [],
  milestones: [],
  // Phase 6: Goals live alongside tasks/milestones in the same tasks.json.
  // Optional in the type so legacy files (missing the field) still load —
  // the `...empty(), ...parsed` spread in readProjectData ensures this
  // field is always defined after read.
  goals: [],
  notes: '',
  updatedAt: new Date().toISOString(),
})

export const readProjectData = async (projectPath: string): Promise<ProjectData> => {
  await ensureOpenGroundProjectDir(projectPath)
  let rawText: string
  try {
    rawText = await readFile(join(projectPath, DATA_FILE), 'utf8')
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
  // Schema-validate. When validation fails (claude wrote a half-formed
  // entry, an old format we didn't migrate, etc) we DON'T just return
  // empty — that would wipe the user's task list from their POV.
  // Instead we shallow-merge with empty() so missing/invalid sections
  // get sane defaults, and the per-field schema fields that DID validate
  // get preserved. This matches the prior behaviour of `{ ...empty(),
  // ...parsed }` but with a final schema pass to fix obvious wrong-shape
  // fields (e.g. milestones: null → milestones: []).
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
    milestones: filterValid(obj.milestones, ProjectMilestoneSchema) as ProjectData['milestones'],
    goals: filterValid(obj.goals, GoalSchema) as NonNullable<ProjectData['goals']>,
    notes: typeof obj.notes === 'string' ? obj.notes : '',
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : new Date().toISOString(),
  }
}

// Phase 6.E — automatic Goal status derivation from milestone children.
// Runs on every write so the GoalsTab and dashboard never go stale.
// Rules:
//   - all milestones verified → 'done'
//   - any milestone blocked   → 'blocked'
//   - any in_progress/verifying → 'running'
//   - otherwise → keep the existing status (draft / planning preserved)
const reconcileGoalStatuses = (data: ProjectData): ProjectData => {
  const goals = data.goals
  if (!goals || goals.length === 0) return data
  const next = goals.map(g => {
    const ms = data.milestones.filter(m => m.goalId === g.id)
    if (ms.length === 0) return g
    const allVerified = ms.every(m => m.status === 'verified')
    const anyBlocked = ms.some(m => m.status === 'blocked')
    const anyRunning = ms.some(
      m => m.status === 'in_progress' || m.status === 'verifying',
    )
    let derived = g.status
    if (allVerified) derived = 'done'
    else if (anyBlocked) derived = 'blocked'
    else if (anyRunning) derived = 'running'
    // else: leave existing status alone (draft / planning are user-driven)
    if (derived === g.status) return g
    return { ...g, status: derived, updatedAt: new Date().toISOString() }
  })
  return { ...data, goals: next }
}

export const writeProjectData = async (projectPath: string, data: ProjectData) => {
  await ensureOpenGroundProjectDir(projectPath)
  await mkdir(join(projectPath, '.openground'), { recursive: true })
  const reconciled = reconcileGoalStatuses(data)
  const next = { ...reconciled, updatedAt: new Date().toISOString() }
  await atomicWriteJson(join(projectPath, DATA_FILE), next)
  // Reclaim image files no surviving task references (best-effort, never throws).
  await pruneTaskImages(projectPath, next)
  return next
}

export const taskCounts = (data: ProjectData) => {
  const total = data.tasks.length
  const open = data.tasks.filter(t => !t.done).length
  return { total, open }
}

// Canonicalize a path by resolving symlinks. `resolve()` only collapses `..`
// lexically — it does NOT follow symlinks — so a symlink sitting inside
// projectsRoot but pointing OUTSIDE it would pass a naive prefix check and let
// fs ops (and `claude --dangerously-skip-permissions`) escape the sandbox. We
// realpath the nearest existing ancestor and re-append the not-yet-created
// tail, so creation flows still work while existing symlinks are fully
// resolved. ENOENT walks up; any other error falls back to the lexical path.
const canonicalize = async (p: string): Promise<string> => {
  let cur = resolve(p)
  const tail: string[] = []
  for (;;) {
    try {
      const real = await realpath(cur)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') return cur
      const parent = dirname(cur)
      if (parent === cur) return resolve(p) // hit the fs root, nothing real
      tail.push(basename(cur))
      cur = parent
    }
  }
}

// Security boundary (CONTRACT §3.3): the resolved-and-canonicalized path must
// sit at or under projectsRoot. Symlinks are followed (see canonicalize) so a
// symlink can't be used to escape the root.
export const validateProjectPath = async (projectPath: string): Promise<boolean> => {
  const settings = await getSettings()
  if (!settings.projectsRoot) return false
  const target = await canonicalize(projectPath)
  const root = await canonicalize(settings.projectsRoot)
  return target === root || target.startsWith(root + sep)
}

const ensureDir = (p: string) => mkdir(p, { recursive: true })

export const archiveProject = async (projectPath: string, settings: Settings) => {
  if (!settings.projectsRoot) throw new Error('projectsRoot not set')
  const root = resolve(settings.projectsRoot)
  const archiveDir = join(root, settings.archiveDirName)
  await ensureDir(archiveDir)
  const name = projectPath.split(sep).pop()!
  const target = join(archiveDir, name)
  try {
    await stat(target)
    throw new Error(`A project named "${name}" already exists in archive`)
  } catch (e: any) {
    if (e.code !== 'ENOENT' && !e.message?.includes('already exists')) {
      // not the "no exists" check
    }
    if (e.message?.includes('already exists')) throw e
  }
  await rename(projectPath, target)
  return target
}

export const restoreProject = async (projectPath: string, settings: Settings) => {
  if (!settings.projectsRoot) throw new Error('projectsRoot not set')
  const root = resolve(settings.projectsRoot)
  const name = projectPath.split(sep).pop()!
  const target = join(root, name)
  try {
    await stat(target)
    throw new Error(`A project named "${name}" already exists at the root`)
  } catch (e: any) {
    if (e.message?.includes('already exists')) throw e
  }
  await ensureDir(dirname(target))
  await rename(projectPath, target)
  return target
}
