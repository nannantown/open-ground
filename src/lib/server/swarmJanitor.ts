// swarmJanitor — sweeps the RESIDUAL leftovers an in-app swarm run accumulates,
// the ones the worktree/PTY *body* cleaner does NOT own:
//
//   (1) stale `swarm/*` BRANCHES        — merged-into-trunk or empty (no commits)
//                                          local branches, plus merged remote
//                                          `origin/swarm/*` branches (opt-in).
//   (2) orphaned HEARTBEAT files        — ~/.openground/swarm/<key>/<branch>.json
//                                          whose worker is provably gone.
//   (3) dead TERMINAL-POOL entries      — delegated to terminal.sweepTerminalPool.
//
// SAFETY is the whole point. Every sweep is conservative and reversible-by-default:
//   • Branches: ONLY `swarm/*` (the engine's ownership boundary — isSwarmBranch).
//     Deletion is pure-git `git branch -d` (git's own "fully merged" refusal is
//     the safety net, re-checked against the TRUNK via a temporary upstream), and
//     remote deletion is a non-force `git push --delete swarm/*`. NEVER a
//     force-delete (`-D`) or force-push — UNLESS the caller passes `force:true`
//     (a user-explicit override), which is the ONLY path that removes UNMERGED
//     work. Unmerged / unjudgeable / checked-out branches are KEPT and returned
//     in the warning list, never guessed-away.
//   • Heartbeats: swept only when STALE *and* the worker is provably gone (its
//     branch or worktree is missing). A fresh heartbeat (a live worker still
//     writing it) is always kept.
//   • Terminals: see terminal.sweepTerminalPool — reaps dead entries, never kills.
//
// All git calls are execFile with argv arrays (never a shell string); network
// git can never hang on a credential prompt (GIT_TERMINAL_PROMPT=0 + a hard
// timeout), matching the house convention in swarmIntegrate / mergedBranches.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { readdir, readFile, stat, unlink } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
import { createHash } from 'crypto'
import { canonicalize } from './canonicalize'
import { isGitRepoRoot } from './gitRepoGuard'
import { openGroundHome } from './paths'
import { checkMergedBranches } from './mergedBranches'
import { isSwarmBranch, resolveTarget } from './swarmIntegrate'
import { sanitizeBranch } from './reviewWorktree'
import { sweepTerminalPool, type SweepTerminalPoolOpts } from './terminal'
import type {
  SwarmBranchKept,
  SwarmBranchSweepResult,
  SwarmHeartbeatSweepResult,
  SwarmJanitorReport,
} from '../types'

const execFile = promisify(execFileCb)

// House convention (swarmIntegrate / mergedBranches): network git never hangs on
// a credential prompt and gets a hard timeout.
const GIT_OPTS = {
  timeout: 60_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}

/** Run git in `cwd`; null on any failure (no git, not a repo, bad ref…). */
const git = async (cwd: string, args: string[]): Promise<string | null> => {
  if (!isGitRepoRoot(cwd)) return null // gitRepoGuard: never spawn git in a non-repo/vanishing cwd
  try {
    const { stdout } = await execFile('git', args, { cwd, ...GIT_OPTS })
    return stdout
  } catch {
    return null
  }
}

/** Run git capturing only success/failure (for deletes/pushes where we just
 *  need "did it work"). */
const gitOk = async (cwd: string, args: string[]): Promise<boolean> => {
  if (!isGitRepoRoot(cwd)) return false // gitRepoGuard: never spawn git in a non-repo/vanishing cwd
  try {
    await execFile('git', args, { cwd, ...GIT_OPTS })
    return true
  } catch {
    return false
  }
}

/** Does this FULL ref exist (refs/heads/x, refs/remotes/origin/x)? */
const refExists = async (cwd: string, ref: string): Promise<boolean> =>
  (await git(cwd, ['show-ref', '--verify', '--quiet', ref])) !== null

/** A path that exists on disk? (worktree / heartbeat liveness checks.) */
const pathExists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// ── (1) branch sweep ─────────────────────────────────────────────────────────

export interface SweepSwarmBranchesOpts {
  /** Trunk override (the project's shared target-branch config). Else resolved
   *  from origin/HEAD → 'main' (resolveTarget). */
  target?: string
  /** Also delete MERGED remote `origin/swarm/*` branches (non-force
   *  `push --delete`). Default false — local-only, the common path. Outward and
   *  opt-in by design. */
  deleteRemote?: boolean
  /** USER-EXPLICIT override: also force-delete UNMERGED local `swarm/*` branches
   *  (`git branch -D`). The ONLY path that can drop unsaved commits — default
   *  false. Never applies to 'unknown' branches (ancestry unjudgeable ⇒ never
   *  forced). */
  force?: boolean
  /** Remote name for the remote sweep. Default 'origin'. */
  remote?: string
}

/** Map of branch short-name → its checked-out worktree path, across ALL
 *  worktrees (incl. the main checkout). A branch in here is live — never delete
 *  it (git would refuse anyway, and it's an active worker or a worktree the
 *  body-cleaner hasn't reaped yet). */
const checkedOutBranches = async (
  projectPath: string,
): Promise<Map<string, string>> => {
  const out = new Map<string, string>()
  const porcelain = await git(projectPath, ['worktree', 'list', '--porcelain'])
  if (!porcelain) return out
  let curPath: string | null = null
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) curPath = line.slice('worktree '.length)
    else if (line.startsWith('branch ') && curPath) {
      const ref = line.slice('branch '.length).trim()
      const short = ref.replace(/^refs\/heads\//, '')
      out.set(short, curPath)
    } else if (line === '') curPath = null
  }
  return out
}

/** Best-effort: does this checked-out worktree have uncommitted changes? */
const isWorktreeDirty = async (worktreePath: string): Promise<boolean> => {
  const s = await git(worktreePath, ['status', '--porcelain'])
  return s !== null && s.trim().length > 0
}

/** Resolve the upstream ref name to point a branch at before `git branch -d`, so
 *  git's "fully merged" refusal is checked against the TRUNK (not the cwd's
 *  HEAD). Prefers the remote-tracking trunk (freshest after a fetch), then the
 *  local trunk. null ⇒ no trunk ref to anchor on. */
const trunkUpstreamRef = async (
  projectPath: string,
  target: string,
  remote: string,
): Promise<string | null> => {
  if (await refExists(projectPath, `refs/remotes/${remote}/${target}`)) return `${remote}/${target}`
  if (await refExists(projectPath, `refs/heads/${target}`)) return target
  return null
}

/** Delete a MERGED local branch with git's own safety net: anchor its upstream
 *  on the trunk so `branch -d` re-verifies "fully merged in trunk" regardless of
 *  the cwd's HEAD, then `-d`. Returns whether the branch is gone. (set-upstream
 *  is best-effort; on a cwd already sitting on the trunk, plain `-d` suffices.) */
const deleteMergedLocal = async (
  projectPath: string,
  branch: string,
  upstream: string | null,
): Promise<boolean> => {
  if (upstream) {
    await gitOk(projectPath, ['branch', `--set-upstream-to=${upstream}`, branch])
  }
  return gitOk(projectPath, ['branch', '-d', branch])
}

/** Sweep merged/empty `swarm/*` branches (local + opt-in remote). Pure git, no
 *  force unless `force:true`. Unmerged/unknown/checked-out branches are kept and
 *  returned in `kept` (the warning list). */
export const sweepSwarmBranches = async (
  projectPath: string,
  opts: SweepSwarmBranchesOpts = {},
): Promise<SwarmBranchSweepResult> => {
  const remote = opts.remote ?? 'origin'
  const deletedLocal: string[] = []
  const deletedRemote: string[] = []
  const kept: SwarmBranchKept[] = []

  // ── Local sweep ──────────────────────────────────────────────────────────
  const localOut = await git(projectPath, [
    'for-each-ref',
    'refs/heads/swarm',
    '--format=%(refname:short)',
  ])
  const localBranches = (localOut ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((b) => b && isSwarmBranch(b))

  // Resolve trunk once for both the merge classification and the -d upstream
  // anchor. checkMergedBranches does its own fetch + ancestry; reuse its verdict.
  const target = (await resolveTarget(projectPath, opts.target, remote)) ?? 'main'

  if (localBranches.length > 0) {
    const checkedOut = await checkedOutBranches(projectPath)
    const upstream = await trunkUpstreamRef(projectPath, target, remote)
    // Classify only the branches we might delete (skip the checked-out ones).
    const candidates = localBranches.filter((b) => !checkedOut.has(b))
    const merged = await checkMergedBranches(projectPath, candidates, target)

    for (const branch of localBranches) {
      // Defense-in-depth: a ref from for-each-ref is already valid, but never
      // let an unexpected name reach argv.
      try {
        sanitizeBranch(branch)
      } catch {
        kept.push({ branch, reason: 'unknown' })
        continue
      }

      const wt = checkedOut.get(branch)
      if (wt) {
        kept.push({ branch, reason: 'checked-out', dirty: await isWorktreeDirty(wt) })
        continue
      }

      const status = merged[branch] ?? 'unknown'
      if (status === 'merged') {
        if (await deleteMergedLocal(projectPath, branch, upstream)) deletedLocal.push(branch)
        else kept.push({ branch, reason: 'unknown' }) // git refused — keep, never force
      } else if (status === 'open') {
        if (opts.force && (await gitOk(projectPath, ['branch', '-D', branch]))) {
          deletedLocal.push(branch)
        } else {
          kept.push({ branch, reason: 'unmerged' })
        }
      } else {
        // 'unknown' — ancestry unjudgeable. Never delete, never force.
        kept.push({ branch, reason: 'unknown' })
      }
    }
  }

  // ── Remote sweep (opt-in) ──────────────────────────────────────────────────
  if (opts.deleteRemote) {
    const remoteOut = await git(projectPath, [
      'for-each-ref',
      `refs/remotes/${remote}/swarm`,
      '--format=%(refname:short)',
    ])
    const remoteBranches = (remoteOut ?? '')
      .split('\n')
      .map((l) => l.trim())
      // Strip the `<remote>/` prefix by length (not a regex) so a remote name
      // with metacharacters can't misbehave.
      .map((b) => (b.startsWith(`${remote}/`) ? b.slice(remote.length + 1) : b))
      .filter((b) => b && isSwarmBranch(b))

    const targetRef = `refs/remotes/${remote}/${target}`
    const haveTarget = await refExists(projectPath, targetRef)
    for (const branch of remoteBranches) {
      try {
        sanitizeBranch(branch)
      } catch {
        continue // bogus name → leave the remote ref alone
      }
      if (!haveTarget) continue // no trunk to judge against → never delete remote
      const tipRef = `refs/remotes/${remote}/${branch}`
      // is-ancestor(remote tip, remote trunk): exit 0 = merged. Anything else
      // (open / bad ref) ⇒ keep the remote branch (never guessed-away).
      const ancestor = await gitOk(projectPath, ['merge-base', '--is-ancestor', tipRef, targetRef])
      if (!ancestor) continue
      // Non-force ref deletion (NOT a force-push). swarm/* only.
      if (await gitOk(projectPath, ['push', remote, '--delete', branch])) {
        deletedRemote.push(branch)
      }
    }
  }

  return { deletedLocal, deletedRemote, kept }
}

// ── (2) heartbeat sweep ──────────────────────────────────────────────────────

/** Repo-key for the heartbeat dir — mirrors swarm-beat.sh's `_repokey`
 *  (`<basename(repoRoot)>-<sha1(realpath(.git))[:8]>`, space/slash → '_'), and
 *  swarmOrchestrator's reader, so the path a worker WROTE is the one we sweep.
 *  null when `projectPath` isn't a git repo. Exported so tests can locate the
 *  exact heartbeat dir the sweep will read. */
export const swarmRepoKey = async (projectPath: string): Promise<string | null> => {
  const commonDir = await git(projectPath, ['rev-parse', '--git-common-dir'])
  if (commonDir === null) return null
  let abs: string
  try {
    abs = await canonicalize(resolve(projectPath, commonDir.trim()))
  } catch {
    return null
  }
  const h = createHash('sha1').update(abs).digest('hex').slice(0, 8)
  const base = basename(dirname(abs)).replace(/[ /]/g, '_')
  return `${base}-${h}`
}

export interface SweepSwarmHeartbeatsOpts {
  /** Injected clock (epoch ms) — pure-testable, house style. */
  now?: number
  /** A heartbeat younger than this is FRESH (a live worker is still writing it)
   *  and never swept. Default 15 min — a stalled-but-alive worker keeps its
   *  branch+worktree, so this only gates the provably-gone case. */
  staleMs?: number
}

const DEFAULT_HEARTBEAT_STALE_MS = 15 * 60_000

/** Sweep orphaned/stale heartbeat files under ~/.openground/swarm/<key>/. A file
 *  is removed only when it is STALE *and* its worker is provably gone (the
 *  branch it names no longer exists locally, OR its worktree path is gone) — or
 *  it's unparseable and stale. Fresh files, and files whose branch+worktree both
 *  still exist, are kept. */
export const sweepSwarmHeartbeats = async (
  projectPath: string,
  opts: SweepSwarmHeartbeatsOpts = {},
): Promise<SwarmHeartbeatSweepResult> => {
  const now = opts.now ?? Date.now()
  const staleMs = opts.staleMs ?? DEFAULT_HEARTBEAT_STALE_MS
  const swept: string[] = []
  const kept: string[] = []

  const key = await swarmRepoKey(projectPath)
  if (!key) return { swept, kept }
  const dir = join(openGroundHome(), 'swarm', key)

  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.json'))
  } catch {
    return { swept, kept } // no dir yet → nothing to sweep
  }

  for (const file of files) {
    const full = join(dir, file)
    let branch: string | null = null
    let worktree: string | null = null
    let updatedMs = NaN
    try {
      const j = JSON.parse(await readFile(full, 'utf8')) as {
        branch?: unknown
        worktree?: unknown
        updatedAt?: unknown
      }
      if (typeof j.branch === 'string') branch = j.branch
      if (typeof j.worktree === 'string') worktree = j.worktree
      if (typeof j.updatedAt === 'string') updatedMs = Date.parse(j.updatedAt)
    } catch {
      // Corrupt/unreadable → can't trust its contents; fall through with branch
      // and worktree treated as gone, freshness from the file's mtime.
    }
    // Freshness: prefer the heartbeat's own updatedAt; fall back to file mtime so
    // a corrupt-but-recent file (mid-write) is still protected.
    if (Number.isNaN(updatedMs)) {
      try {
        updatedMs = (await stat(full)).mtimeMs
      } catch {
        updatedMs = 0 // unreadable stat → treat as ancient
      }
    }
    const stale = now - updatedMs >= staleMs

    // A signal counts as "gone" only when it's PRESENT and we checked it missing.
    // An ABSENT field is unknown — NOT "gone" — so it can never by itself condemn
    // a heartbeat whose other signal is still alive (the real writer always emits
    // both; this only hardens malformed/foreign files: a live branch keeps the
    // file even if it lacks a worktree field).
    let branchGone = false
    if (branch) {
      try {
        branchGone = !(await refExists(projectPath, `refs/heads/${sanitizeBranch(branch)}`))
      } catch {
        branchGone = true // invalid name → no such ref
      }
    }
    const treeGone = worktree ? !(await pathExists(worktree)) : false
    // No checkable liveness signal at all (corrupt / foreign file) → staleness
    // alone governs, so a stale unparseable file is still reaped.
    const noSignal = !branch && !worktree

    if (stale && (branchGone || treeGone || noSignal)) {
      try {
        await unlink(full)
        swept.push(file)
      } catch {
        kept.push(file) // couldn't remove → report as kept (it's still there)
      }
    } else {
      kept.push(file)
    }
  }

  return { swept, kept }
}

// ── (3) full janitor ─────────────────────────────────────────────────────────

export interface RunSwarmJanitorOpts {
  branches?: SweepSwarmBranchesOpts
  heartbeats?: SweepSwarmHeartbeatsOpts
  terminals?: SweepTerminalPoolOpts
}

/** Run all three residual-cleanup sweeps and return a combined, observable
 *  report. Branches are swept FIRST so a freshly-deleted branch makes its
 *  heartbeat orphaned for the heartbeat pass; terminals (in-memory) are
 *  independent. Each sweep is independently safe and never throws on a
 *  non-repo / missing-dir (it degrades to empty results). */
export const runSwarmJanitor = async (
  projectPath: string,
  opts: RunSwarmJanitorOpts = {},
): Promise<SwarmJanitorReport> => {
  const branches = await sweepSwarmBranches(projectPath, opts.branches)
  const heartbeats = await sweepSwarmHeartbeats(projectPath, opts.heartbeats)
  const terminals = sweepTerminalPool(opts.terminals)
  return { branches, heartbeats, terminals }
}
