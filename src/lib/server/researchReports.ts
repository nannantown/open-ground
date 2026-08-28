// researchReports — the read-only library behind the per-project Research tab:
// list and read the research reports a project has accumulated under
// docs/research/ (the /research skill's default placement; the card can name
// another path, but the library deliberately indexes only the convention).
//
// SECURITY SHAPE (the same two-layer stance as projectSkills.ts):
//   - The ROUTE has already run validateProjectPath on the project root (the
//     registry allowlist — CONTRACT §3.3).
//   - THIS module then confines everything to <project>/docs/research/:
//     each path segment is checked (no separators ⇒ no traversal by
//     construction), every candidate is realpath'd and must resolve UNDER the
//     real reports dir (the symlink-escape guard), and only regular files are
//     read (a FIFO would wedge the libuv pool — projectSkills' lesson).
//     Directories are descended EXACTLY one level, so rendering a tab can
//     never become an unbounded walk of a repo that nests.
//   - Read-only. Nothing here writes, so the worst a hostile repo can do is
//     show the user their own file.

import { readdir, readFile, realpath, stat } from 'fs/promises'
import { join, sep } from 'path'
import type { ResearchReportMeta } from '../types'

const REPORTS_SUBDIR = ['docs', 'research'] as const

/** ONE path segment that is safe to join. Rejects, by construction: path
 *  separators, NUL and control characters, a leading dot (hidden files, and
 *  `.`/`..` with them), and anything absurdly long.
 *
 *  ⚠ It does NOT restrict the alphabet, and that is the point (fixed
 *  2026-08-15 after a real report never appeared in the tab). The old rule was
 *  an ASCII allowlist, so a report named in Japanese — the overwhelmingly
 *  likely case for this owner, and what the /research skill's `<slug>` becomes
 *  when the card is Japanese — was silently skipped. The tab then said
 *  「まだ調査レポートはありません」, which is indistinguishable from "no research
 *  ran". A filter whose failure mode is a lie is worse than no filter.
 *
 *  The security claim is unchanged: no separator can match, so traversal is
 *  impossible here, and the realpath containment below is the second,
 *  independent layer that does not depend on this regex being right. */
// eslint-disable-next-line no-control-regex -- excluding control chars is the point
const SAFE_SEGMENT = /^[^.\/\\\u0000-\u001f\u007f][^\/\\\u0000-\u001f\u007f]{0,200}$/

/** A report id as it crosses the wire: `name.md`, or `sub/name.md` ONE level
 *  deep. Workers do file things to directories — a report filed under
 *  `docs/research/<topic>/` was the other way this went silently missing. */
const MD_SUFFIX = /\.md$/i

const isSafeReportId = (id: string): boolean => {
  const parts = id.split('/')
  if (parts.length < 1 || parts.length > 2) return false
  if (!parts.every((p) => SAFE_SEGMENT.test(p))) return false
  return MD_SUFFIX.test(parts[parts.length - 1])
}

const MAX_REPORTS = 500
const TITLE_READ_BYTES = 8 * 1024
/** Reports are prose; anything bigger than this is not a report. */
export const MAX_REPORT_BYTES = 1024 * 1024

/** First `# ` heading in the head of the file, else null (caller falls back to
 *  the filename). Exported for blogPublish.ts, which must derive the SAME title
 *  the Research tab shows — a draft named differently from the row the owner
 *  clicked would read as a different document. */
export const titleFrom = (head: string): string | null => {
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

  /** Index one candidate `id` (`name.md` or `sub/name.md`). Every skip here is
   *  silent BY NECESSITY (a weird tree must not break the tab) — which is
   *  exactly why the id rule above must not be narrower than reality. */
  const consider = async (id: string): Promise<void> => {
    if (out.length >= MAX_REPORTS) return
    if (!isSafeReportId(id)) return
    // Symlink-escape guard: whatever the entry is, the file we read must
    // RESOLVE under the real reports dir.
    let real: string
    try {
      real = await realpath(join(dir, id))
    } catch {
      return
    }
    if (real !== realDir && !real.startsWith(realDir + sep)) return
    let st
    try {
      st = await stat(real)
    } catch {
      return
    }
    if (!st.isFile()) return
    let title: string | null = null
    try {
      const buf = await readFile(real)
      title = titleFrom(buf.subarray(0, TITLE_READ_BYTES).toString('utf8'))
    } catch {
      return
    }
    out.push({
      file: id,
      title: title ?? id.split('/').pop()!.replace(MD_SUFFIX, ''),
      mtime: st.mtimeMs,
      size: st.size,
    })
  }

  for (const e of entries) {
    if (out.length >= MAX_REPORTS) break
    // A DIRECTORY is descended exactly one level — no deeper, so a repo that
    // nests cannot turn a tab render into an unbounded walk.
    if (e.isDirectory()) {
      if (!SAFE_SEGMENT.test(e.name)) continue
      let sub
      try {
        sub = await readdir(join(dir, e.name), { withFileTypes: true })
      } catch {
        continue
      }
      for (const s of sub) {
        if (out.length >= MAX_REPORTS) break
        if (s.isDirectory()) continue
        await consider(`${e.name}/${s.name}`)
      }
      continue
    }
    await consider(e.name)
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
  if (!isSafeReportId(file)) throw new Error('not a research report name')
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
