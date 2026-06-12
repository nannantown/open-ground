// Compose the FULL prompt for a Board card's claude session — the one shared
// definition of "what the task says". Used by BOTH injection paths so they can
// never drift:
//   - POST /api/terminal/:id/paste-task   → bracketed paste, UNSENT
//   - POST /api/terminal/claude (task 実行) → positional initialPrompt, auto-run
//
// The card is re-read from project data, but the LIVE field values the client
// sends win: drawer edits are debounced (~350ms) before they reach tasks.json,
// and a just-created card may not be on disk at all — composing only from the
// disk copy would inject stale or missing content. The card's image
// attachments are resolved to absolute paths (strictly validated asset ids,
// existing files only) and appended so claude can Read them.
//
// `flow` is the per-card completion-flow override (TaskRunSettings.flow):
// live value first, then the stored card's run.flow, then the project's
// shared config.completionFlow via buildTaskPrompt's own fallback.

import { mkdir, stat } from 'fs/promises'
import { join } from 'path'
import { buildTaskPrompt } from './taskPrompt'
import { centralWorktreesDir } from './paths'
import { projectUUIDFromPath } from './projectDataPath'
import { isValidTaskAssetId, taskAssetPath } from './taskAssets'
import type { ProjectData } from '../types'

export interface LiveTaskFields {
  taskId: string
  /** Live drawer values — absent keys fall back to the stored card. */
  title?: string
  notes?: string
  attachmentIds?: string[]
  flow?: 'merge' | 'pr'
}

/** Returns the composed prompt, or null when no title exists anywhere (the
 *  card is unfindable AND the client sent no live title — nothing to run). */
export const composeTaskPrompt = async (
  path: string,
  projectData: ProjectData,
  live: LiveTaskFields,
): Promise<string | null> => {
  const stored = projectData.tasks.find((t) => t.id === live.taskId)
  const title = (live.title ?? stored?.title ?? '').trim()
  if (!title) return null
  const notes = live.notes ?? stored?.notes

  const isGit = await stat(join(path, '.git')).then(() => true).catch(() => false)
  let worktreesDir: string | null = null
  if (isGit) {
    worktreesDir = centralWorktreesDir(await projectUUIDFromPath(path))
    await mkdir(worktreesDir, { recursive: true })
  }

  const flow = live.flow ?? stored?.run?.flow
  const config = flow
    ? { ...projectData.config, completionFlow: flow }
    : projectData.config

  let prompt = buildTaskPrompt({
    cwd: path,
    task: { id: live.taskId, title, notes },
    port: Number(process.env.PORT) || 47776,
    worktreesDir,
    config,
  })

  const attachmentIds = (
    live.attachmentIds ?? (stored?.attachments ?? []).map((a) => a.id)
  ).filter(isValidTaskAssetId)
  const attachmentPaths: string[] = []
  for (const assetId of attachmentIds) {
    const abs = await taskAssetPath(path, assetId)
    if (await stat(abs).then(() => true).catch(() => false)) attachmentPaths.push(abs)
  }
  if (attachmentPaths.length) {
    prompt += '\n\n## Attached images\n' + attachmentPaths.map((p) => `- ${p}`).join('\n')
  }
  return prompt
}
