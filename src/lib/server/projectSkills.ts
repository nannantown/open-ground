import { readdir, readFile, realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { join, sep } from 'path'
import type { ProjectSkill } from '../types'

// Lists the Claude Code skills available to a project: those defined INSIDE it
// (`<project>/.claude/skills/<name>/SKILL.md`) and the OG user's OWN GLOBAL
// skills (`~/.claude/skills/<name>/SKILL.md`). Each skill is one directory
// holding a SKILL.md whose YAML frontmatter declares `name` + `description`.
// This is a pure reader: it never executes a skill (OPEN GROUND only ever drives
// the user's `claude` CLI). For project skills the caller (the route) must run
// the validateProjectPath security check before handing us a path.

const SKILLS_SUBDIR = ['.claude', 'skills'] as const

// Hard caps so a pathological repo can't wedge the request: at most this many
// skill dirs are inspected, and only the head of each SKILL.md is read for
// frontmatter (the body can be arbitrarily long — we never need it).
const MAX_SKILLS = 500
const FRONTMATTER_READ_BYTES = 64 * 1024

/** Extract `name` / `description` from a SKILL.md's leading YAML frontmatter
 *  (the block between the first `---` line and the next `---`). Handles the
 *  common shapes: bare scalars, single/double-quoted values, `|` / `>` block
 *  scalars, and an empty-inline value whose (possibly quoted) text wraps onto
 *  the following indented lines. Returns {} when there is no frontmatter.
 *  Exported for tests. */
export const parseSkillFrontmatter = (
  raw: string,
): { name?: string; description?: string } => {
  // Frontmatter must START the file. `\s` already covers a leading BOM (U+FEFF)
  // and any blank lines, so no literal BOM is needed in the pattern.
  const m = /^\s*---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw)
  if (!m) return {}
  const lines = m[1].split(/\r?\n/)
  return {
    name: readScalar(lines, 'name'),
    description: readScalar(lines, 'description'),
  }
}

// Collect the run of more-indented lines starting at `from` (the body of a block
// scalar or a wrapped flow scalar), dedented; stops at a dedented sibling line.
const gatherIndented = (lines: string[], from: number): string[] => {
  const body: string[] = []
  for (let j = from; j < lines.length; j++) {
    const l = lines[j]
    if (l.trim() === '') {
      body.push('')
      continue
    }
    if (!/^[ \t]/.test(l)) break // dedent → next sibling key
    body.push(l.replace(/^[ \t]+/, ''))
  }
  return body
}

// Strip a single layer of matching surrounding quotes.
const stripQuotes = (v: string): string =>
  (v.startsWith('"') && v.endsWith('"') && v.length >= 2) ||
  (v.startsWith("'") && v.endsWith("'") && v.length >= 2)
    ? v.slice(1, -1)
    : v

// Read one top-level `key:` scalar out of the frontmatter lines. Top-level only
// (the key must be at column 0) so a nested `name:` under some other mapping is
// ignored. `undefined` when the key is absent or its value is empty.
const readScalar = (lines: string[], key: string): string | undefined => {
  const head = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`)
  for (let i = 0; i < lines.length; i++) {
    const hit = head.exec(lines[i])
    if (!hit) continue
    const inline = hit[1].trim()

    // Block scalar (`|`, `>`, with optional chomping indicator): gather the
    // following more-indented lines. `>` folds onto one line, `|` keeps breaks.
    if (/^[|>][+-]?$/.test(inline)) {
      const joined = gatherIndented(lines, i + 1).join(inline[0] === '>' ? ' ' : '\n').trim()
      return joined || undefined
    }

    // Empty inline value: a plain/quoted scalar wrapped onto the following
    // indented lines (common in real SKILL.md — `description:` then a quoted
    // sentence indented below). Fold the continuation with spaces, then unquote.
    if (inline === '') {
      const wrapped = gatherIndented(lines, i + 1)
        .filter((l) => l !== '')
        .join(' ')
        .trim()
      return wrapped ? stripQuotes(wrapped).trim() || undefined : undefined
    }

    return stripQuotes(inline).trim() || undefined
  }
  return undefined
}

interface ScanOpts {
  /** When set, every SKILL.md MUST realpath to a path under this root, else it
   *  is skipped — the symlink-escape guard for an untrusted/imported project
   *  tree. `null` disables containment (used for the user's OWN `~/.claude`,
   *  where there's no untrusted import and a dotfiles symlink is legitimate).
   *  The stat().isFile() guard below runs either way. */
  containmentRoot: string | null
  /** Build the displayed `file` path for a skill id (relative for project,
   *  `~/`-prefixed for global). */
  fileLabel: (id: string) => string
}

// Shared scanner for a `.../.claude/skills` directory. Returns [] when the dir
// is absent (the normal "no skills" case, not an error).
const scanSkillsDir = async (
  skillsDir: string,
  { containmentRoot, fileLabel }: ScanOpts,
): Promise<ProjectSkill[]> => {
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return [] // no skills dir → no skills
  }

  // A skill is a directory holding a SKILL.md; skip files and dotfiles. Inspect
  // in a STABLE order so the MAX_SKILLS cap takes a deterministic prefix
  // (readdir order is filesystem-dependent).
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const out: ProjectSkill[] = []
  for (const e of dirs) {
    if (out.length >= MAX_SKILLS) break
    const skillMd = join(skillsDir, e.name, 'SKILL.md')

    // Resolve symlinks; for an untrusted tree, refuse anything that escapes the
    // containment root (the symlink-exfiltration guard).
    let real: string
    try {
      real = await realpath(skillMd)
    } catch {
      continue // no readable SKILL.md here → not a skill
    }
    if (
      containmentRoot &&
      real !== containmentRoot &&
      !real.startsWith(containmentRoot + sep)
    ) {
      continue
    }

    // Must be a REGULAR file. `realpath` succeeds on a FIFO/socket/device too,
    // and `readFile` on a writer-less FIFO blocks forever — a few such entries
    // would exhaust the libuv threadpool and wedge the whole server. `stat` does
    // NOT block on a FIFO, so gate on it first. (A dir/non-file is skipped.)
    try {
      if (!(await stat(real)).isFile()) continue
    } catch {
      continue
    }

    let head: string
    try {
      const buf = await readFile(real)
      head = buf.subarray(0, FRONTMATTER_READ_BYTES).toString('utf8')
    } catch {
      continue
    }

    const fm = parseSkillFrontmatter(head)
    out.push({
      id: e.name,
      name: (fm.name || e.name).slice(0, 200),
      description: (fm.description || '').slice(0, 1000),
      file: fileLabel(e.name),
    })
  }

  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/** List the project's `<project>/.claude/skills/*` skills, sorted by display
 *  name. Symlink-escape hardened: every SKILL.md must resolve UNDER the
 *  project's real root (the route already allowlists the root via
 *  validateProjectPath; the tree is otherwise untrusted — e.g. an imported or
 *  git-shared repo). [] when the project has no skills dir. */
export const listProjectSkills = async (
  projectPath: string,
): Promise<ProjectSkill[]> => {
  const root = await realpath(projectPath).catch(() => null)
  if (!root) return []
  return scanSkillsDir(join(projectPath, ...SKILLS_SUBDIR), {
    containmentRoot: root,
    fileLabel: (id) => `.claude/skills/${id}/SKILL.md`,
  })
}

/** List the OG user's OWN GLOBAL skills (`~/.claude/skills/*`) — the ones
 *  available to them in every project. NO containment guard: this is the user's
 *  own home (not an untrusted import), and users legitimately symlink skills in
 *  from a dotfiles repo; the stat().isFile() guard still prevents a FIFO/device
 *  from hanging the read. `home` is injectable for tests. */
export const listGlobalSkills = async (
  home: string = homedir(),
): Promise<ProjectSkill[]> => {
  return scanSkillsDir(join(home, ...SKILLS_SUBDIR), {
    containmentRoot: null,
    fileLabel: (id) => `~/.claude/skills/${id}/SKILL.md`,
  })
}
