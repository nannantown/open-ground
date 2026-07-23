// swarmEnvPreflight.ts — the git/shell run-gate every route that SPAWNS a swarm
// session (worker / supply / manager) goes through, alongside claudePreflight's
// claude-CLI gate. A worker spawn creates a git worktree (`createSwarmWorktree`
// in swarmWorker.ts) and starts an interactive PTY through a shell (terminal.ts
// `pickShell`) — if either prerequisite is missing the spawn fails deep inside
// `git worktree add` / `pty.spawn` with a raw, unlocalized error, and (for git)
// AFTER the route has already claimed a Board card off the todo queue. This
// module checks the prerequisites UP FRONT so a route can refuse before doing
// any of that work, and hands back machine-readable issue ids the client maps
// to localized copy (mirrors ClaudePreflightResult / claudeMissing/claudeLoggedOut).
//
// Distinct from claudePreflight: that gate is about claude's own auth state;
// this one is about the HOST environment claude will run inside (git binary,
// a git working tree to branch from, a shell to spawn).
//
// Two independent knobs, not one (2026-07-22 review round 2): `requireGit` (is
// git installed AT ALL) and `requireGitRepo` (is `projectPath` itself a git
// working tree). Only the worker spawn (POST /api/swarm/worker) needs
// `requireGitRepo` — it is the only one of the three whose OWN server code
// calls git (createSwarmWorktree). The commander's /og-manage CONVERSATION runs
// git constantly (status/merge/branch -d — swarmManager.ts), so it still needs
// `requireGit`, just not `requireGitRepo` — the manager desk itself never shells
// out to git, only the claude session it launches does, and gating it on "is
// this a git repo" would refuse a perfectly usable session in any non-git
// registered project (measured 2026-07-22: 15 of 42). Supply needs neither — it
// only reads/writes the Board, no git at all.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { existsSync } from 'fs'
import { resolveViaLoginShell } from './cliResolve'
import { pickShell } from './terminal'

const execFile = promisify(execFileCb)
const isWindows = process.platform === 'win32'

export type SwarmEnvIssueId = 'gitMissing' | 'notAGitRepo' | 'shellMissing'

export interface SwarmEnvIssue {
  id: SwarmEnvIssueId
  /** Human-readable one-liner (English) — the client maps `id` to its own
   *  localized copy; this is only a fallback for non-UI callers (curl / logs). */
  message: string
}

export interface SwarmEnvPreflightResult {
  ok: boolean
  issues: SwarmEnvIssue[]
}

export interface SwarmEnvPreflightOptions {
  /** Bypass the cache (spawn routes want the freshest answer — see the cache
   *  note below; a Swarm-tab poll leaves this off). */
  force?: boolean
  /** Check that git is installed at all. Default true — worker AND manager both
   *  need it (see the module header); only supply passes false. */
  requireGit?: boolean
  /** Check that `projectPath` is a git working tree (implies requireGit — a repo
   *  check without git installed makes no sense). Default true (the worker
   *  spawn path). supply/manager pass false — see the module header. */
  requireGitRepo?: boolean
}

const MESSAGES: Record<SwarmEnvIssueId, string> = {
  gitMissing:
    'git was not found. The swarm spawns each worker in its own git worktree, so git must be installed and on PATH.',
  notAGitRepo:
    "This project folder isn't a git repository. Swarm workers branch off it into isolated worktrees — run `git init` (and make an initial commit) here first.",
  shellMissing:
    'No usable shell was found to run a terminal session (checked the SHELL environment variable / the default shell path). Swarm workers run inside an interactive shell.',
}

// Cache briefly so a Swarm-tab poll landing right after a spawn attempt doesn't
// re-shell-out — but the cache is SHORT-LIVED (10s) and every spawn route
// passes force:true (see the routes), because a stale "not ready yet" answer
// would refuse a spawn the owner just fixed (e.g. ran `git init` moments ago).
// The cache exists for the GET poll only.
let cached: { at: number; key: string; result: SwarmEnvPreflightResult } | null = null
const CACHE_MS = 10_000

// Which git binary answered, cached separately from (and longer than) the
// per-project result cache below: it's a machine-level fact ("is git on this
// box at all") that almost never changes mid-session, unlike "is THIS project a
// repo" (which force:true exists to re-check promptly after a `git init`). This
// keeps a persistent gitMissing box from re-running the ~8s login-shell probe
// on every 5s Swarm-tab poll (2026-07-22 review, nit).
let gitBinCache: { at: number; bin: string | null } | null = null
const GIT_BIN_CACHE_MS = 60_000

/** Resolve the git binary: the server's own PATH first, then (like
 *  claudeConnection does for `claude`) a fresh login shell — the server's
 *  boot-time PATH snapshot can miss a git installed after launch, or one that
 *  only exists on a shell profile PATH line (nvm-style shims, Homebrew added
 *  post-boot). Returns an ABSOLUTE path (or the bare name when that one already
 *  ran) so every later `execFile` call uses the SAME binary this check found —
 *  re-trying the bare name against the server's stale `process.env.PATH` is
 *  what caused the notAGitRepo false-positive this replaces (2026-07-22 review). */
const resolveGitBin = async (force: boolean): Promise<string | null> => {
  if (!force && gitBinCache && Date.now() - gitBinCache.at < GIT_BIN_CACHE_MS) return gitBinCache.bin
  let bin: string | null = null
  if (
    // timeout: every other exec in this module has one (rev-parse 10s, the
    // login-shell fallback below 8s) — a shim (asdf/mise) doing first-run work
    // on this bare invocation must not hang a spawn route indefinitely.
    await execFile('git', ['--version'], { timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    bin = 'git'
  } else {
    const map = await resolveViaLoginShell(['git'])
    bin = map.git ?? null
  }
  gitBinCache = { at: Date.now(), bin }
  return bin
}

/** true = confirmed a working tree; false = confirmed NOT one (git said so,
 *  in as many words); 'unknown' = git ran into some OTHER failure (dubious
 *  ownership / safe.directory, a timeout under load, the folder itself gone) —
 *  none of which mean "not a repo", so this must NOT fold into `false` (that
 *  false-positive is exactly what a prior version of this function did). An
 *  'unknown' answer reports no issue: a wrong-but-confident "not a git
 *  repository, run git init" is worse than staying silent and letting the real
 *  spawn attempt surface its own concrete error. */
const isGitRepo = async (gitBin: string, projectPath: string): Promise<boolean | 'unknown'> => {
  try {
    const { stdout } = await execFile(gitBin, ['rev-parse', '--is-inside-work-tree'], {
      cwd: projectPath,
      timeout: 10_000,
      // Force git's own message to English regardless of the owner's locale
      // (LANG=ja_JP + a gettext-enabled git — Homebrew's `git-gettext`, Linux
      // distro `git-core-l10n` — translates "not a git repository", which the
      // stderr match below depends on; missing that match silently disables
      // the notAGitRepo check forever instead of just misreporting it once).
      env: { ...process.env, LC_ALL: 'C' },
    })
    return stdout.trim() === 'true'
  } catch (e: unknown) {
    const stderr = typeof (e as { stderr?: unknown })?.stderr === 'string'
      ? (e as { stderr: string }).stderr
      : ''
    if (/not a git repository/i.test(stderr)) return false
    return 'unknown'
  }
}

const shellAvailable = async (): Promise<boolean> => {
  // powershell.exe ships with every supported Windows version — nothing to check.
  if (isWindows) return true
  const shell = pickShell()
  if (shell.startsWith('/')) return existsSync(shell)
  // A bare command name (e.g. an OPENGROUND_TERMINAL_SHELL override without a
  // path) — resolve it the same way resolveGitBin falls back.
  const map = await resolveViaLoginShell([shell])
  return !!map[shell]
}

/** Gate a route that is about to spawn a swarm session in `projectPath`.
 *  Checks git is installed (when `requireGit` — default true), `projectPath`
 *  is a git working tree (when `requireGitRepo` — default true, implies
 *  `requireGit`), and a shell is resolvable to run the PTY. Returns every
 *  unmet prerequisite (not just the first) so a single failed spawn — or a
 *  Swarm-tab poll — can show them all at once instead of the owner fixing one
 *  only to hit the next. */
export const swarmEnvPreflight = async (
  projectPath: string,
  opts: SwarmEnvPreflightOptions = {},
): Promise<SwarmEnvPreflightResult> => {
  const { force = false, requireGitRepo = true } = opts
  // requireGit defaults to true independently of requireGitRepo — NOT derived
  // from it, or a caller that only sets requireGitRepo:false (the manager
  // route: it must still require git installed, just not THIS project being a
  // repo) would silently drop requireGit to false too. requireGitRepo:true DOES
  // force requireGit:true (a repo check without git installed is meaningless —
  // there'd be no binary to run `rev-parse` with), which is the one direction
  // that must hold regardless of what the caller passed.
  const requireGit = (opts.requireGit ?? true) || requireGitRepo
  const key = `${projectPath}:${requireGit}:${requireGitRepo}`
  if (!force && cached && cached.key === key && Date.now() - cached.at < CACHE_MS) {
    return cached.result
  }

  const issues: SwarmEnvIssue[] = []
  if (requireGit) {
    const gitBin = await resolveGitBin(force)
    if (!gitBin) {
      issues.push({ id: 'gitMissing', message: MESSAGES.gitMissing })
    } else if (requireGitRepo && (await isGitRepo(gitBin, projectPath)) === false) {
      issues.push({ id: 'notAGitRepo', message: MESSAGES.notAGitRepo })
    }
  }
  if (!(await shellAvailable())) {
    issues.push({ id: 'shellMissing', message: MESSAGES.shellMissing })
  }

  const result: SwarmEnvPreflightResult = { ok: issues.length === 0, issues }
  cached = { at: Date.now(), key, result }
  return result
}
