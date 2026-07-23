import { appendFile, mkdir, readFile, rename, stat } from 'fs/promises'
import { dirname, join } from 'path'
import type { OrchestratorLogLine } from '../types'
import { projectDataDir } from './projectDataPath'

// The commander engine's in-memory journal (swarmOrchestrator.ts's `engine.log`,
// capped at MAX_LOG_LINES) is a RING BUFFER — a process restart empties it, so
// 00-INDEX's "journal has no line about X" cannot mean "X never happened" (it
// may simply have scrolled off, or the process may have just restarted). This
// module gives the same lines a second, append-only home on disk
// (~/.openground/projects/<uuid>/engine-journal.jsonl) that a restart does NOT
// clear — see docs/ENGINE_PERSISTENCE_PLAN.md §6 card 1. The in-memory ring
// stays the API/UI contract (unchanged); this file is read-after-restart /
// post-mortem only, nothing currently reads it back into the ring on boot.

const JOURNAL_FILENAME = 'engine-journal.jsonl'
const ROTATE_MAX_BYTES = 5 * 1024 * 1024 // 5MB — one rotated generation (`.1`) kept.

export const engineJournalPath = async (projectPath: string): Promise<string> =>
  join(await projectDataDir(projectPath), JOURNAL_FILENAME)

/** Append one journal line as JSONL, rotating the file to a single `.1`
 *  generation once the NEXT append would push it past ROTATE_MAX_BYTES.
 *
 *  Fail-open BY DESIGN: every failure mode (ENOSPC, a project that isn't
 *  registered yet, a permissions error, a rotation race) is swallowed here.
 *  This is called from the engine's synchronous, fire-and-forget `logLine`
 *  chokepoint on every dispatch/promote/integrate/error event — the journal
 *  file existing is a nice-to-have for post-restart diagnosis, never a
 *  precondition for the engine to keep dispatching. A caller that wants to
 *  observe failures should not use this function. */
export const appendEngineJournalLine = async (
  projectPath: string,
  line: OrchestratorLogLine,
): Promise<void> => {
  try {
    const file = await engineJournalPath(projectPath)
    const text = `${JSON.stringify(line)}\n`
    await mkdir(dirname(file), { recursive: true })
    let size = 0
    try {
      size = (await stat(file)).size
    } catch {
      size = 0 // no file yet — first line of a fresh journal.
    }
    if (size > 0 && size + Buffer.byteLength(text, 'utf8') > ROTATE_MAX_BYTES) {
      // rename() overwrites an existing `.1` on POSIX, so exactly one
      // rotated generation is ever retained.
      await rename(file, `${file}.1`).catch(() => {})
    }
    await appendFile(file, text, 'utf8')
  } catch {
    // fail-open — see header comment.
  }
}

/** Read back the tail of the on-disk journal (oldest → newest, at most
 *  `limit` lines), the observable half of card 1's completion condition: "a
 *  restart can still read the line that was just written". A line that fails
 *  to parse (a write torn mid-append by a crash) is skipped rather than
 *  failing the whole read. Missing file ⇒ empty array (a fresh project, or
 *  the engine has never logged anything yet). */
export const readEngineJournalTail = async (
  projectPath: string,
  limit = 200,
): Promise<OrchestratorLogLine[]> => {
  let raw: string
  try {
    const file = await engineJournalPath(projectPath)
    raw = await readFile(file, 'utf8')
  } catch {
    return []
  }
  const lines = raw.split('\n').filter((l) => l.length > 0)
  const out: OrchestratorLogLine[] = []
  for (const l of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(l) as OrchestratorLogLine)
    } catch {
      // a torn trailing line from a mid-write crash — skip it.
    }
  }
  return out
}
