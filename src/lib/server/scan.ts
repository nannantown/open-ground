import { stat } from 'fs/promises'
import { sep } from 'path'
import type { ProjectEntry, ProjectMeta, Settings } from '../types'
import { readProjectData, taskCounts } from './projectData'
import { descriptionForLang } from '../descriptionLang'

const hasGitDir = async (dir: string) => {
  try {
    const s = await stat(`${dir}${sep}.git`)
    return s.isDirectory() || s.isFile()
  } catch {
    return false
  }
}

// The project list is now the user-curated registry (Settings.projects), not a
// scan of one root. Each registered entry becomes one card; entries whose
// folder has vanished are surfaced with `missing: true` so the UI can offer
// "Remove from canvas" instead of silently dropping them.
export const scanProjects = async (settings: Settings): Promise<ProjectMeta[]> => {
  // Skip entries that merely link a member's local folder to a folder-less shared
  // project (collabProjectId set): the shared card already represents that project
  // on the Ground, so emitting a standalone card here would duplicate it. The
  // entry still lives in the registry (so the linked folder stays on the
  // validateProjectPath allowlist); it's just not its own card.
  const entries = (settings.projects ?? []).filter((e) => !e.collabProjectId)
  // Card descriptions follow the user's language setting (the data may hold a
  // generated ja/en pair — descriptionForLang picks, falling back to legacy).
  const lang = settings.language === 'ja' ? ('ja' as const) : ('en' as const)
  const metas = await Promise.all(entries.map((e) => projectMeta(e, lang)))
  // Newest-modified first; missing entries (lastModified='') sort to the bottom.
  metas.sort((a, b) => (a.lastModified < b.lastModified ? 1 : -1))
  return metas
}

const missingMeta = (entry: ProjectEntry, name: string): ProjectMeta => ({
  id: entry.id,
  name,
  path: entry.path,
  description: entry.description ?? '',
  lastModified: '',
  missing: true,
  hasGit: false,
  openTaskCount: 0,
  totalTaskCount: 0,
})

const projectMeta = async (entry: ProjectEntry, lang: 'en' | 'ja'): Promise<ProjectMeta> => {
  const absPath = entry.path
  // The card/header name is the owner-chosen display name when set, else the
  // folder's basename (the default). Cosmetic only — path stays entry.path.
  const name = entry.displayName?.trim() || absPath.split(sep).pop() || absPath

  let s
  try {
    s = await stat(absPath)
  } catch {
    return missingMeta(entry, name)
  }
  if (!s.isDirectory()) return missingMeta(entry, name)

  const [hasGit, data] = await Promise.all([
    hasGitDir(absPath),
    readProjectData(absPath),
  ])
  const counts = taskCounts(data)

  return {
    // The id is the registry entry's stable UUID — it survives rename/move, so
    // the card's canvas position (keyed by id) stays put.
    id: entry.id,
    name,
    path: absPath,
    description: descriptionForLang(data, lang),
    lastModified: s.mtime.toISOString(),
    hasGit,
    openTaskCount: counts.open,
    totalTaskCount: counts.total,
  }
}
