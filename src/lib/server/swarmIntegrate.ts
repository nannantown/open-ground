// Read-only branch readiness and target resolution. The commander owns merging.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { sanitizeBranch } from './reviewWorktree'
import { isGitRepoRoot } from './gitRepoGuard'

const execFile = promisify(execFileCb)

// Network git (fetch/push) gets a generous timeout; a wedged credential helper
// can never hang the engine loop.
const GIT_OPTS = {
  timeout: 60_000,
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  },
}

/** The `swarm/*` prefix is the engine's hard ownership boundary: integrate (and
 *  its later cleanup) only ever touch branches the swarm itself created. */
export const SWARM_BRANCH_PREFIX = 'swarm/'

export const isSwarmBranch = (branch: string): boolean =>
  branch.startsWith(SWARM_BRANCH_PREFIX)

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

/** Run git capturing the EXIT CODE — needed for the three-valued ancestry probe
 *  (`merge-base --is-ancestor`: 0=ancestor, 1=not, other=error) and to tell a
 *  rebase conflict (nonzero) from success. */
const gitExit = async (
  cwd: string,
  args: string[],
): Promise<{ ok: boolean; code: number | null }> => {
  if (!isGitRepoRoot(cwd)) return { ok: false, code: null } // gitRepoGuard: never spawn git in a non-repo/vanishing cwd
  try {
    await execFile('git', args, { cwd, ...GIT_OPTS })
    return { ok: true, code: 0 }
  } catch (e: unknown) {
    const code = (e as { code?: unknown })?.code
    return { ok: false, code: typeof code === 'number' ? code : null }
  }
}

/** Does this FULL ref exist (refs/heads/x or refs/remotes/origin/x)? */
const refExists = async (cwd: string, ref: string): Promise<boolean> =>
  (await git(cwd, ['show-ref', '--verify', '--quiet', ref])) !== null

/** The full ref holding `branch`'s tip — the worker's LOCAL branch first (that
 *  is where it committed; swarm branches are never pushed), then origin's. */
const tipRefOf = async (
  cwd: string,
  branch: string,
  remote: string,
): Promise<string | null> => {
  const local = `refs/heads/${branch}`
  if (await refExists(cwd, local)) return local
  const tracking = `refs/remotes/${remote}/${branch}`
  if (await refExists(cwd, tracking)) return tracking
  return null
}

/** is-ancestor(a, b): true iff commit `a` is an ancestor of (i.e. contained in)
 *  commit `b`. A bad ref / missing git is treated as "not an ancestor" (false)
 *  by the caller via the {found} flag, never guessed as merged. */
const isAncestor = async (cwd: string, a: string, b: string): Promise<{ found: boolean; yes: boolean }> => {
  const r = await gitExit(cwd, ['merge-base', '--is-ancestor', a, b])
  if (r.ok) return { found: true, yes: true }
  if (r.code === 1) return { found: true, yes: false }
  return { found: false, yes: false } // error (bad ref / no git)
}

// ── Target (trunk) resolution ────────────────────────────────────────────────

/** Best-effort `git fetch <remote> <target>` so the ancestry/push judgments run
 *  against the freshest trunk. Offline / no remote is fine — the callers then
 *  operate on whatever remote-tracking ref already exists (or none → skipped).
 *  Owned by the PASS (called once before classify+integrate), not by the pure
 *  ops below, so a batch of cards costs ONE fetch. */
export const fetchTarget = async (
  projectPath: string,
  target: string,
  remote = 'origin',
): Promise<void> => {
  await git(projectPath, ['fetch', remote, target])
}

/** Resolve the trunk branch NAME for this project, mirroring mergedBranches:
 *  an explicit override (the project's shared target-branch config) wins, else
 *  origin/HEAD's symbolic target, else 'main'. Returns null only when the name
 *  is unusable (rejected by sanitizeBranch). The caller still checks the
 *  remote-tracking ref EXISTS before trusting it as a push target. */
export const resolveTarget = async (
  projectPath: string,
  override?: string,
  remote = 'origin',
): Promise<string | null> => {
  if (override && override.trim()) {
    try {
      return sanitizeBranch(override)
    } catch {
      return null
    }
  }
  const head = await git(projectPath, ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`])
  const m = head?.trim().match(new RegExp(`^refs/remotes/${remote}/(.+)$`))
  return m ? m[1] : 'main'
}

// ── Read-only readiness classification ───────────────────────────────────────

/** How a review card's branch relates to the trunk, computed WITHOUT mutating
 *  anything (no push, no rebase, no checkout):
 *   - 'ff'      → trunk is an ancestor of the branch (a clean fast-forward), OR
 *                 the branch is already fully contained in the trunk (already
 *                 merged). Either way it can be finalized with no conflict risk.
 *   - 'rebase'  → branch and trunk have diverged; integration would need a rebase
 *                 (which MAY conflict — that is only known once attempted).
 *   - 'unknown' → not a swarm branch, tip not found, no remote trunk, or git
 *                 error. Never guessed. */
export type ReviewReadiness = 'ff' | 'rebase' | 'unknown'

export const classifyBranch = async (
  projectPath: string,
  branch: string,
  target: string,
  remote = 'origin',
): Promise<ReviewReadiness> => {
  if (!isSwarmBranch(branch)) return 'unknown'
  let safe: string
  try {
    safe = sanitizeBranch(branch)
  } catch {
    return 'unknown'
  }
  const targetRef = `refs/remotes/${remote}/${target}`
  if (!(await refExists(projectPath, targetRef))) return 'unknown'
  const tip = await tipRefOf(projectPath, safe, remote)
  if (!tip) return 'unknown'

  // Already merged (branch ⊆ trunk) → finalizable cleanly.
  const merged = await isAncestor(projectPath, tip, targetRef)
  if (!merged.found) return 'unknown'
  if (merged.yes) return 'ff'

  // Trunk ⊆ branch → clean fast-forward.
  const ff = await isAncestor(projectPath, targetRef, tip)
  if (!ff.found) return 'unknown'
  return ff.yes ? 'ff' : 'rebase'
}
