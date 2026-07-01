import { readFileSync, writeFileSync, renameSync, realpathSync, unlinkSync } from 'fs'
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
// BEST-EFFORT + LOST-UPDATE SAFE: the key is undocumented (claude may change its
// schema), and ~/.claude.json is ALSO written by every live claude session (it
// holds auth / session state, not just our trust flags). A full-file rewrite from
// a stale snapshot would silently REVERT a concurrent claude write that landed in
// our read→write window — and an atomic tmp+rename prevents a TORN file but NOT
// that lost update. So updateProjects (a) re-reads the LATEST file and applies
// ONLY the projects mutation onto it (never re-serializing a stale root over the
// top of claude's newer keys), (b) re-reads once more immediately before the
// rename and RETRIES onto the fresher copy if the file changed under us, (c) only
// writes when something actually changed, (d) refuses to overwrite an UNPARSEABLE
// file (most likely a torn read of a concurrent write — clobbering it would nuke
// claude's real state), and (e) NEVER throws — if any step fails we leave claude's
// config as-is (no worse than before the pre-seed). No OS lock is available for
// ~/.claude.json, so this NARROWS — it cannot fully close — the final rename gap.

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

// Number of read→patch→write passes before giving up. A concurrent claude write
// landing in our (tiny) read→rename window makes us re-read and re-apply onto its
// version rather than revert it; a handful of passes is ample — claude rewrites
// ~/.claude.json rarely, so a sustained race is not realistic. Giving up silently
// leaves claude's config untouched (the safe failure).
const MAX_WRITE_ATTEMPTS = 5

// Read ~/.claude.json, let `mutate` edit its projects map, and atomically write
// back iff `mutate` reports a change — WITHOUT reverting a concurrent claude
// write. Each pass re-reads the latest file and patches only the projects map
// onto it; a final re-read just before the rename retries onto a fresher copy if
// the file changed under us. Shared by the add/remove helpers. See the
// LOST-UPDATE SAFE note at the top of this file.
const updateProjects = (
  mutate: (projects: Record<string, Record<string, unknown>>) => boolean,
): void => {
  const p = claudeConfigPath()
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    try {
      // 1. Read the LATEST file every pass, so we patch onto whatever a concurrent
      //    claude last wrote (auth / session / other projects) — never a snapshot
      //    that predates its write (the lost update the old whole-root rewrite hit).
      let raw: string | null
      try {
        raw = readFileSync(p, 'utf8')
      } catch {
        raw = null // no file yet → we'll create it
      }
      // 2. Parse. An UNPARSEABLE existing file is most likely a torn read of a
      //    concurrent write (or hand corruption): never overwrite it with our
      //    minimal config — that would nuke claude's real auth/session state.
      let parsed: unknown = {}
      if (raw !== null) {
        try {
          parsed = JSON.parse(raw)
        } catch {
          return
        }
      }
      if (typeof parsed !== 'object' || parsed === null) return
      const root = parsed as Record<string, unknown>
      const projects =
        root.projects && typeof root.projects === 'object'
          ? (root.projects as Record<string, Record<string, unknown>>)
          : {}
      root.projects = projects
      // 3. Apply ONLY the projects mutation. No change → no write (zero clobber risk).
      if (!mutate(projects)) return
      // 4. Stage the patched root, then re-read the live file immediately before the
      //    rename. If it changed since step 1, a concurrent writer raced us in the
      //    read→write window — discard our tmp and retry onto their version rather
      //    than revert it (raw===null && fresh!==null = claude created it meanwhile;
      //    both null = still absent, so the create proceeds).
      const tmp = `${p}.openground-${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(root, null, 2))
      let fresh: string | null
      try {
        fresh = readFileSync(p, 'utf8')
      } catch {
        fresh = null
      }
      if (fresh !== raw) {
        try {
          unlinkSync(tmp)
        } catch {
          /* tmp already gone — ignore */
        }
        continue
      }
      renameSync(tmp, p)
      return
    } catch {
      // Never let trust bookkeeping break a launch or a worktree cleanup.
      return
    }
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
