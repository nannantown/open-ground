import { readdir, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import { createHash } from 'crypto'
import type { ProjectData, ProjectMeta, RunSummaryInfo, Settings } from '../types'
import { readProjectData, taskCounts } from './projectData'

// Phase 5.A — derive the card-hero fallback from persisted task summaries.
// Picks the newest `task.latestRun` across the project (by finishedAt) and
// maps it onto the same RunSummaryInfo the live cockpit derives from run
// sessions, so the card hero looks identical whether it came from a live
// session or this disk fallback. Returns undefined when no task carries a
// persisted summary, or when the newest one is a non-narrative kind we never
// surface as a hero (mirrors useRuns.runSummaryByProject's filter).
const latestRunSummaryOf = (data: ProjectData): RunSummaryInfo | undefined => {
  let newest: ProjectData['tasks'][number]['latestRun'] | undefined
  let newestTitle = ''
  for (const t of data.tasks) {
    const lr = t.latestRun
    if (!lr || !lr.finishedAt) continue
    if (!newest || (newest.finishedAt ?? '') < lr.finishedAt) {
      newest = lr
      newestTitle = t.title
    }
  }
  if (!newest) return undefined
  return {
    kind: newest.kind,
    taskTitle: newest.topic?.trim() || newestTitle,
    summary: newest.summary?.trim() ?? '',
    blockers: newest.blockers?.trim() ?? '',
    followups: newest.followups ?? [],
    question: newest.question?.trim() || undefined,
    finishedAt: newest.finishedAt,
  }
}

const isExcluded = (name: string, patterns: string[]) =>
  patterns.includes(name)

const hasGitDir = async (dir: string) => {
  try {
    const s = await stat(join(dir, '.git'))
    return s.isDirectory() || s.isFile()
  } catch {
    return false
  }
}

const projectId = (stableKey: string) =>
  createHash('sha1').update(stableKey).digest('hex').slice(0, 12)

export const scanProjects = async (settings: Settings): Promise<ProjectMeta[]> => {
  const root = settings.projectsRoot
  if (!root) return []

  let entries: string[]
  try {
    entries = await readdir(root)
  } catch {
    return []
  }

  const archiveDir = settings.archiveDirName
  const tasks: Promise<ProjectMeta | null>[] = []

  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    if (entry === archiveDir) {
      const archivePath = join(root, archiveDir)
      let archived_entries: string[] = []
      try {
        archived_entries = await readdir(archivePath)
      } catch {
        continue
      }
      for (const sub of archived_entries) {
        tasks.push(projectMeta(join(archivePath, sub), root, true))
      }
      continue
    }
    if (isExcluded(entry, settings.excludePatterns)) continue
    tasks.push(projectMeta(join(root, entry), root, false))
  }

  const results = (await Promise.all(tasks)).filter(
    (m): m is ProjectMeta => m !== null,
  )
  results.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1))
  return results
}

const projectMeta = async (
  absPath: string,
  root: string,
  archived: boolean,
): Promise<ProjectMeta | null> => {
  let s
  try {
    s = await stat(absPath)
  } catch {
    return null
  }
  if (!s.isDirectory()) return null

  const name = absPath.split(sep).pop() || absPath
  const [hasGit, data] = await Promise.all([
    hasGitDir(absPath),
    readProjectData(absPath),
  ])
  const counts = taskCounts(data)
  const latestRunSummary = latestRunSummaryOf(data)
  const relativePath = relative(root, absPath)

  return {
    // ID is a hash of a STABLE key (survives moving the projectsRoot). For
    // active projects that key is the bare folder name (unchanged, so existing
    // canvas card positions keyed by id stay valid). Archived projects use
    // their `_archive/<name>` relative path so an archived project can't
    // collide with an active project of the same name — that collision made
    // both cards share one canvas position / selection slot.
    id: projectId(archived ? relativePath : name),
    name,
    path: absPath,
    relativePath,
    description: data.description,
    lastModified: s.mtime.toISOString(),
    archived,
    hasGit,
    openTaskCount: counts.open,
    totalTaskCount: counts.total,
    ...(latestRunSummary ? { latestRunSummary } : {}),
  }
}
