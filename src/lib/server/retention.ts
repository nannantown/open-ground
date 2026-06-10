import { readFile, readdir, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { runsDir } from './paths'
import { projectDataDir } from './projectDataPath'

// Retention for the EPISODIC layer: the raw run cache (~/.openground/runs/)
// and per-project task attachments are pruned after a retention window.
// (Formerly part of journal.ts; the journal itself is gone — Claude's own
// JSONL transcripts remain the durable record and are never touched here.)

/** Days the raw run cache + attachments are kept before pruning. */
export const RAW_RETENTION_DAYS = 14
const RETENTION_MS = RAW_RETENTION_DAYS * 24 * 60 * 60 * 1000

const olderThanRetention = (iso: string | undefined, mtimeMs: number): boolean => {
  const t = iso ? Date.parse(iso) : NaN
  const age = Date.now() - (Number.isNaN(t) ? mtimeMs : t)
  return age > RETENTION_MS
}

/** Delete run-cache files (~/.openground/runs/*.json) whose run finished more
 *  than RAW_RETENTION_DAYS ago. Claude's own JSONL transcripts are left
 *  untouched (Claude Code owns those). */
export const pruneOldRunFiles = async (): Promise<number> => {
  let removed = 0
  let files: string[]
  try {
    files = (await readdir(runsDir())).filter(f => f.endsWith('.json'))
  } catch {
    return 0
  }
  for (const f of files) {
    const full = join(runsDir(), f)
    try {
      const st = await stat(full)
      let finishedAt: string | undefined
      try {
        // Legacy run-cache shape (the batch runner is gone; this prunes the
        // files it left behind). Only `finishedAt` matters here.
        const s = JSON.parse(await readFile(full, 'utf8')) as { finishedAt?: string }
        finishedAt = s.finishedAt
        if (!finishedAt) continue // never delete an unfinished/in-flight run
      } catch {
        finishedAt = undefined
      }
      if (olderThanRetention(finishedAt, st.mtimeMs)) {
        await unlink(full)
        removed += 1
      }
    } catch {
      /* skip */
    }
  }
  return removed
}

/** Delete attachment files under a project's .openground/task-attachments/ that
 *  are older than the retention window (their paths already lived in past run
 *  instructions). */
export const pruneOldAttachments = async (projectPath: string): Promise<number> => {
  let removed = 0
  let files: string[]
  let dir: string
  try {
    dir = join(await projectDataDir(projectPath), 'task-attachments')
    files = await readdir(dir)
  } catch {
    return 0
  }
  for (const f of files) {
    const full = join(dir, f)
    try {
      const st = await stat(full)
      if (Date.now() - st.mtimeMs > RETENTION_MS) {
        await unlink(full)
        removed += 1
      }
    } catch {
      /* skip */
    }
  }
  return removed
}
