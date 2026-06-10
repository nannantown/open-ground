import { readFileSync, writeFileSync, renameSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// claude 2.1.167+ shows a BLOCKING "Is this a project you created or one you
// trust?" prompt the first time it starts in a directory it hasn't seen —
// and `--dangerously-skip-permissions` does NOT skip it (only `-p` print mode
// does, which we deliberately avoid because it bills the programmatic credit
// pool instead of the subscription rate-limit pool — see claudeTerminal.ts).
//
// Our runs launch claude inside a HIDDEN PTY, so nobody can answer that prompt:
// the PTY wedges, claude never starts a session (no JSONL transcript), and the
// run ends with an empty log marked "cancelled". Ephemeral git worktrees are a
// fresh directory every time, so bypass/worktree runs hit it every single run.
//
// claude records accepted folders in ~/.claude.json under
//   projects["<abs cwd>"].hasTrustDialogAccepted === true
// so we pre-seed that flag for the launch cwd RIGHT BEFORE spawning claude (and
// PRUNE it when the worktree is removed, so ephemeral worktree paths don't pile
// up in ~/.claude.json forever). The gate then never appears and we keep the
// interactive-PTY (subscription-billed) launch path. This is safe for OPEN
// GROUND specifically: every cwd we launch in is a project the user explicitly
// registered/created (or a worktree copy of one) — trust was implicitly granted
// when they added it.
//
// BEST-EFFORT: the key is undocumented (claude may change its schema), and a
// concurrent claude could in theory clobber our write. So we keep the
// read→modify→write window tiny, write atomically (tmp + rename, never a torn
// file), only write when something actually changed, and NEVER throw — if any
// step fails we simply leave claude's config as-is (no worse than today).

// Path to claude's global config. Overridable via env so unit tests never
// touch the real ~/.claude.json (CLAUDE_CONFIG_PATH points at a tmp file).
const claudeConfigPath = () =>
  process.env.CLAUDE_CONFIG_PATH || join(homedir(), '.claude.json')

// claude keys its projects map by the cwd it runs in. macOS paths here
// (/Users/…, ~/.openground/…) aren't symlinked, so realpath == path, but cover
// both forms defensively in case the spawn cwd differs from its realpath.
const pathKeys = (cwd: string): string[] => {
  const keys = new Set<string>([cwd])
  try {
    keys.add(realpathSync(cwd))
  } catch {
    /* cwd may not exist (already-removed worktree) — the literal key still covers it */
  }
  return Array.from(keys)
}

// Read ~/.claude.json, let `mutate` edit its projects map, atomically write back
// iff `mutate` reports a change. Shared by the add/remove helpers.
const updateProjects = (
  mutate: (projects: Record<string, Record<string, unknown>>) => boolean,
): void => {
  try {
    const p = claudeConfigPath()
    let data: unknown = {}
    try {
      data = JSON.parse(readFileSync(p, 'utf8'))
    } catch {
      data = {}
    }
    if (typeof data !== 'object' || data === null) return
    const root = data as Record<string, unknown>
    const projects =
      root.projects && typeof root.projects === 'object'
        ? (root.projects as Record<string, Record<string, unknown>>)
        : {}
    root.projects = projects
    if (!mutate(projects)) return
    const tmp = `${p}.openground-${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(root, null, 2))
    renameSync(tmp, p)
  } catch {
    // Never let trust bookkeeping break a launch or a worktree cleanup.
  }
}

/** Pre-accept claude's folder-trust gate for `cwd` (call right before launch). */
export const ensureClaudeFolderTrusted = (cwd: string): void => {
  updateProjects((projects) => {
    let changed = false
    for (const key of pathKeys(cwd)) {
      const existing =
        projects[key] && typeof projects[key] === 'object' ? projects[key] : {}
      if (existing.hasTrustDialogAccepted !== true) {
        projects[key] = { ...existing, hasTrustDialogAccepted: true }
        changed = true
      }
    }
    return changed
  })
}

/** Drop the trust entry for `cwd` (call when an ephemeral worktree is removed)
 *  so ~/.claude.json doesn't accumulate dead worktree paths over time. */
export const removeClaudeFolderTrust = (cwd: string): void => {
  updateProjects((projects) => {
    let changed = false
    for (const key of pathKeys(cwd)) {
      if (key in projects) {
        delete projects[key]
        changed = true
      }
    }
    return changed
  })
}
