// researchReports — the read-only library behind the per-project Research tab:
// list and read the research reports a project has accumulated under
// docs/research/ (the /research skill's default placement; the card can name
// another path, but the library deliberately indexes only the convention).
//
// SECURITY SHAPE (the same two-layer stance as projectSkills.ts):
//   - The ROUTE has already run validateProjectPath on the project root (the
//     registry allowlist — CONTRACT §3.3).
//   - THIS module then confines everything to <project>/docs/research/:
//     filenames are a strict charset (no separators ⇒ no traversal by
//     construction), every candidate is realpath'd and must resolve UNDER the
//     real reports dir (the symlink-escape guard), and only regular files are
//     read (a FIFO would wedge the libuv pool — projectSkills' lesson).
//   - Read-only. Nothing here writes, so the worst a hostile repo can do is
//     show the user their own file.

import { readdir, readFile, realpath, stat } from 'fs/promises'
import { join, sep } from 'path'
import type { ResearchReportMeta } from '../types'

const REPORTS_SUBDIR = ['docs', 'research'] as const

/** Flat-name allowlist: letters/digits start, then a tame middle, `.md` end.
 *  No path separators can match, so traversal is impossible by construction —
 *  the realpath containment below is the second, independent layer. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,200}\.md$/

const MAX_REPORTS = 500
const TITLE_READ_BYTES = 8 * 1024
/** Reports are prose; anything bigger than this is not a report. */
export const MAX_REPORT_BYTES = 1024 * 1024

/** First `# ` heading in the head of the file, else null (caller falls back to
 *  the filename). */
const titleFrom = (head: string): string | null => {
  const m = /^#[ \t]+(.+?)[ \t]*$/m.exec(head)
  return m ? m[1].slice(0, 200) : null
}

export const researchReportsDir = (projectPath: string): string =>
  join(projectPath, ...REPORTS_SUBDIR)

/** List a project's research reports, newest first. [] when the dir is absent
 *  (the normal "no research yet" case). Never throws on a weird tree. */
export const listResearchReports = async (
  projectPath: string,
): Promise<ResearchReportMeta[]> => {
  const dir = researchReportsDir(projectPath)
  const realDir = await realpath(dir).catch(() => null)
  if (!realDir) return []

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const out: ResearchReportMeta[] = []
  for (const e of entries) {
    if (out.length >= MAX_REPORTS) break
    if (!SAFE_NAME.test(e.name)) continue
    const p = join(dir, e.name)
    // Symlink-escape guard: whatever the entry is, the file we read must
    // RESOLVE under the real reports dir.
    let real: string
    try {
      real = await realpath(p)
    } catch {
      continue
    }
    if (real !== realDir && !real.startsWith(realDir + sep)) continue
    let st
    try {
      st = await stat(real)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    let title: string | null = null
    try {
      const buf = await readFile(real)
      title = titleFrom(buf.subarray(0, TITLE_READ_BYTES).toString('utf8'))
    } catch {
      continue
    }
    out.push({
      file: e.name,
      title: title ?? e.name.replace(/\.md$/, ''),
      mtime: st.mtimeMs,
      size: st.size,
    })
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** Read one report's markdown. Throws on anything outside the contract —
 *  the route maps that to a 4xx. */
export const readResearchReport = async (
  projectPath: string,
  file: string,
): Promise<string> => {
  if (!SAFE_NAME.test(file)) throw new Error('not a research report name')
  const dir = researchReportsDir(projectPath)
  const realDir = await realpath(dir) // throws when the dir is absent
  const real = await realpath(join(dir, file))
  if (real !== realDir && !real.startsWith(realDir + sep)) {
    throw new Error('report resolves outside docs/research')
  }
  const st = await stat(real)
  if (!st.isFile()) throw new Error('not a regular file')
  if (st.size > MAX_REPORT_BYTES) throw new Error('report too large')
  return readFile(real, 'utf8')
}
