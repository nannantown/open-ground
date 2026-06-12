// mergedBranches — detect which task branches are already merged into the
// project's target branch (Board flows F065/F085: a Review card whose branch
// landed offers an explicit "Merged → Done" affordance). Pure git, no gh /
// GitHub API:
//
//   merged(b)  ⟺  merge-base --is-ancestor <tip of b> <target ref>
//
// Target resolution: the caller-supplied targetBranch (the project's shared
// config) wins; otherwise origin/HEAD's symbolic target; otherwise 'main'.
// One best-effort `git fetch origin <target>` freshens the judgment (offline
// still works against the last-known remote ref). Every ref lookup prefers
// the LOCAL branch tip and falls back to origin/<name> — on a reviewer's
// machine the task branch usually exists only as a remote-tracking ref.
//
// Verdicts are deliberately three-valued: a branch whose tip can't be found
// (deleted after merge with no remote ref, never fetched, invalid name) is
// 'unknown' — never guessed. All git calls are execFile with argv arrays
// (never a shell string), and branch names pass sanitizeBranch (the same
// gate reviewWorktree uses) before touching argv.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import type { MergedBranchStatus } from '../types'
import { sanitizeBranch } from './reviewWorktree'

const execFile = promisify(execFileCb)

/** Run git in the project dir; null on any failure (no git, not a repo, …). */
// House convention (gitShare.ts): network git never hangs on a credential
// prompt and gets a hard timeout.
const GIT_OPTS = {
  timeout: 30_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}

const git = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', args, { cwd, ...GIT_OPTS })
    return stdout
  } catch {
    return null
  }
}

/** Does this FULL ref (refs/heads/x or refs/remotes/origin/x) exist? */
const refExists = async (cwd: string, ref: string): Promise<boolean> =>
  (await git(cwd, ['show-ref', '--verify', '--quiet', ref])) !== null

/** The full ref holding `branch`'s tip — local first, then origin — or null. */
const tipRefOf = async (cwd: string, branch: string): Promise<string | null> => {
  const local = `refs/heads/${branch}`
  if (await refExists(cwd, local)) return local
  const remote = `refs/remotes/origin/${branch}`
  if (await refExists(cwd, remote)) return remote
  return null
}

/** merge-base --is-ancestor verdict. Exit 0 = ancestor (merged), exit 1 =
 *  not an ancestor (open); anything else (bad ref, no git) = unknown. */
const isAncestor = async (
  cwd: string,
  tip: string,
  target: string,
): Promise<MergedBranchStatus> => {
  try {
    await execFile('git', ['merge-base', '--is-ancestor', tip, target], { cwd, ...GIT_OPTS })
    return 'merged'
  } catch (e: unknown) {
    const code = (e as { code?: unknown })?.code
    return code === 1 ? 'open' : 'unknown'
  }
}

/** Classify each branch as merged / open / unknown against the target branch.
 *  Never throws — a non-repo dir, a missing target, or git itself missing all
 *  degrade to all-'unknown' (the client simply shows no chip). */
export const checkMergedBranches = async (
  projectPath: string,
  branches: string[],
  targetBranch?: string,
): Promise<Record<string, MergedBranchStatus>> => {
  // Every requested branch gets a verdict; default = unknown.
  const result: Record<string, MergedBranchStatus> = {}
  for (const b of branches) result[b] = 'unknown'
  if (branches.length === 0) return result

  // ── Resolve the target branch NAME ──────────────────────────────────────
  let target: string
  if (targetBranch && targetBranch.trim()) {
    try {
      target = sanitizeBranch(targetBranch)
    } catch {
      return result // unjudgeable target → everything stays unknown
    }
  } else {
    // origin/HEAD → "refs/remotes/origin/<default>"; fall back to 'main'.
    const head = await git(projectPath, [
      'symbolic-ref',
      '--quiet',
      'refs/remotes/origin/HEAD',
    ])
    const m = head?.trim().match(/^refs\/remotes\/origin\/(.+)$/)
    target = m ? m[1] : 'main'
  }

  // Freshen the target once — best-effort (no remote / offline is fine; the
  // ancestry check then runs against the refs we already have).
  await git(projectPath, ['fetch', 'origin', target])

  // ── Resolve the target REF (local tip first, then origin's) ─────────────
  // TARGET ref prefers origin/<target>: the fetch above just freshened it,
  // while a stale LOCAL target (the author's checkout from this morning)
  // would judge freshly-merged branches as still open — backwards from the
  // feature's primary scenario. Task-branch TIPS stay local-first (a local
  // tip is exactly what the author means).
  const remoteTarget = `refs/remotes/origin/${target}`
  const targetRef = (await refExists(projectPath, remoteTarget))
    ? remoteTarget
    : await tipRefOf(projectPath, target)
  if (!targetRef) return result // no target to judge against → all unknown

  for (const raw of branches) {
    let branch: string
    try {
      branch = sanitizeBranch(raw)
    } catch {
      continue // invalid name → stays unknown (never reaches argv)
    }
    const tip = await tipRefOf(projectPath, branch)
    if (!tip) continue // tip nowhere to be found → stays unknown
    result[raw] = await isAncestor(projectPath, tip, targetRef)
  }
  return result
}
