// swarmIntegrate — the COMMANDER engine's git integration primitive (司令官
// engine STAGE ③, project_inapp_swarm_port Phase 2): take a worker's finished
// `swarm/*` branch and land it on the project's trunk (origin/<target>), SAFELY.
//
// This is the single riskiest operation in the whole swarm, so the contract is
// deliberately narrow and every escape hatch is closed:
//
//   • FF / rebase ONLY — never a merge commit, NEVER `--force`. A push that the
//     remote rejects as non-fast-forward (someone moved the trunk between our
//     fetch and our push) just FAILS — we never force past it.
//   • NO automatic conflict resolution — a rebase that hits a conflict is
//     `--abort`ed and reported as 'conflict'; nothing is pushed, nothing is left
//     half-rebased. The caller surfaces it for a human and moves on.
//   • Only the worker's OWN branch is ever touched — the function refuses any
//     ref that is not a `swarm/*` branch, and the rebase happens in a THROWAWAY
//     detached worktree the engine owns, never in the user's main checkout and
//     never in the worker's own worktree. The shared primary checkout's working
//     tree / index / HEAD are never touched.
//   • origin-based — the trunk is a REMOTE branch (origin/<target>) and the only
//     write to it is a `git push`. A repo with no such remote target is reported
//     'skipped' (the trunk lives in the user's checked-out local `main`, which we
//     must never move underneath them) — integration there stays manual.
//
// READ-ONLY classification (classifyBranch) tells the dashboard whether a review
// card is fast-forwardable WITHOUT mutating anything, so the engine can DISPLAY
// "統合可" while auto-integrate is OFF (the default). It deliberately does not try
// to predict rebase conflicts (the host git is only guaranteed `merge-base
// --is-ancestor`, not `merge-tree --write-tree`); the authoritative conflict
// verdict comes from the real rebase in integrateBranch.
//
// All git calls are execFile with argv arrays (never a shell string); network
// git can never hang on a credential prompt (GIT_TERMINAL_PROMPT=0 + a hard
// timeout), matching the house convention in swarmWorker / mergedBranches.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { sanitizeBranch } from './reviewWorktree'

const execFile = promisify(execFileCb)

// Network git (fetch/push) gets a generous timeout; a wedged credential helper
// can never hang the engine loop.
const GIT_OPTS = {
  timeout: 60_000,
  // A rebase replays commits, so git needs a committer identity. In CI the
  // checkout often has no user.name/user.email AND git's auto-detection
  // (gecos / hostname) also fails, so `git rebase` exits 128 — which this
  // engine would misread as a rebase failure and report a CLEAN rebase as a
  // 'conflict'. Supply a fallback identity so integration never depends on
  // ambient git config. process.env wins (a CI/host that DOES configure an
  // identity is honored); a rebase preserves each commit's ORIGINAL author, so
  // only the committer takes this fallback (a rebase authors no new commits).
  env: {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'OPEN GROUND',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'swarm@openground.local',
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'OPEN GROUND',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'swarm@openground.local',
  },
}

/** The `swarm/*` prefix is the engine's hard ownership boundary: integrate (and
 *  its later cleanup) only ever touch branches the swarm itself created. */
export const SWARM_BRANCH_PREFIX = 'swarm/'

export const isSwarmBranch = (branch: string): boolean =>
  branch.startsWith(SWARM_BRANCH_PREFIX)

/** Run git in `cwd`; null on any failure (no git, not a repo, bad ref…). */
const git = async (cwd: string, args: string[]): Promise<string | null> => {
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

/** The files left UNMERGED by a failed rebase (the conflict surface), as repo-
 *  relative paths — `git diff --name-only --diff-filter=U` read from the
 *  mid-conflict worktree BEFORE the abort. A pure read: [] on any failure or a
 *  clean index. Capped so a pathological conflict can't bloat the surfaced log. */
const conflictedFiles = async (cwd: string): Promise<string[]> => {
  const out = await git(cwd, ['diff', '--name-only', '--diff-filter=U'])
  if (out === null) return []
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20)
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

// ── Integration (the mutating action) ────────────────────────────────────────

export type IntegrateMode = 'ff' | 'rebase'

/** The outcome of an integration attempt:
 *   - integrated → the branch's commits are on the trunk (mode tells how). The
 *     caller may now move the card review→done and clean up the worktree+branch.
 *   - conflict   → a rebase hit a conflict; it was ABORTED, nothing pushed. The
 *     caller leaves the card in review and marks it for manual integration.
 *   - skipped    → nothing to do safely (not a swarm branch, no remote trunk,
 *     tip missing). The card is left untouched; not an error.
 *   - error      → a git step failed (push rejected as non-FF, network/auth,
 *     rebase couldn't start…). The card is left in review; the engine retries
 *     on a later pass (the trunk may have moved). */
export type IntegrateOutcome =
  | { status: 'integrated'; mode: IntegrateMode }
  | { status: 'conflict'; files?: string[] }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string }

export interface IntegrateOpts {
  /** Trunk branch name (resolveTarget). */
  target: string
  /** Throwaway detached-worktree path for the rebase case. ENGINE-OWNED (built
   *  under the project's central worktrees dir) — never user input. Must not
   *  already exist; removed (forced) before return whether or not we used it. */
  integrateDir: string
  /** Remote name; default 'origin'. */
  remote?: string
}

/** Integrate one worker branch onto the trunk. See {@link IntegrateOutcome}.
 *  Never throws, never `--force`, never auto-resolves a conflict, never touches
 *  any ref but the worker's own branch and (via a plain push) the trunk. */
export const integrateBranch = async (
  projectPath: string,
  branch: string,
  opts: IntegrateOpts,
): Promise<IntegrateOutcome> => {
  const remote = opts.remote ?? 'origin'

  // Ownership boundary FIRST: only the swarm's own branches are ever integrated.
  if (!isSwarmBranch(branch)) return { status: 'skipped', reason: 'not a swarm branch' }
  let safe: string
  try {
    safe = sanitizeBranch(branch)
  } catch {
    return { status: 'skipped', reason: 'invalid branch name' }
  }

  const targetRef = `refs/remotes/${remote}/${opts.target}`
  if (!(await refExists(projectPath, targetRef))) {
    // No remote trunk to push to — the trunk is the user's local checkout, which
    // we must never move underneath them. Manual integration only.
    return { status: 'skipped', reason: 'no remote trunk' }
  }

  const tip = await tipRefOf(projectPath, safe, remote)
  if (!tip) return { status: 'skipped', reason: 'branch tip not found' }

  // 1. Already merged (branch ⊆ trunk) — nothing to push; finalize.
  const merged = await isAncestor(projectPath, tip, targetRef)
  if (!merged.found) return { status: 'error', reason: 'ancestry probe failed' }
  if (merged.yes) return { status: 'integrated', mode: 'ff' }

  // 2. Clean fast-forward (trunk ⊆ branch) — push the branch ref straight at the
  //    trunk. No --force: a remote that moved on rejects this, and we let it.
  const ff = await isAncestor(projectPath, targetRef, tip)
  if (!ff.found) return { status: 'error', reason: 'ancestry probe failed' }
  if (ff.yes) {
    const pushed = await git(projectPath, [
      'push',
      remote,
      `refs/heads/${safe}:refs/heads/${opts.target}`,
    ])
    return pushed !== null
      ? { status: 'integrated', mode: 'ff' }
      : { status: 'error', reason: 'fast-forward push rejected' }
  }

  // 3. Diverged — rebase the branch onto the trunk in a THROWAWAY detached
  //    worktree (never the main checkout, never the worker's own worktree), then
  //    fast-forward push the rebased result. A conflict aborts cleanly.
  return rebaseAndPush(projectPath, safe, targetRef, opts.target, remote, opts.integrateDir)
}

/** The rebase arm of integrateBranch. Isolated so the throwaway worktree's
 *  create/teardown is unconditional (always cleaned up, even on early return). */
const rebaseAndPush = async (
  projectPath: string,
  safeBranch: string,
  targetRef: string,
  target: string,
  remote: string,
  integrateDir: string,
): Promise<IntegrateOutcome> => {
  // Detached checkout at the branch tip: allowed even though the branch is
  // checked out in the worker's worktree (detach claims the commit, not the
  // branch ref), and it leaves the worker's branch + worktree untouched.
  const added = await git(projectPath, [
    'worktree',
    'add',
    '--detach',
    integrateDir,
    `refs/heads/${safeBranch}`,
  ])
  if (added === null) return { status: 'error', reason: 'could not create integration worktree' }

  try {
    const rebased = await gitExit(integrateDir, ['rebase', targetRef])
    if (!rebased.ok) {
      // Conflict (or any rebase failure): abort so nothing is left half-applied.
      // We NEVER resolve it automatically. Capture the unmerged files FIRST (a pure
      // read of the mid-conflict index) so the human resolving it knows WHERE the
      // conflict is — surfaced in the engine log. Best-effort: a read failure just
      // omits the list (the conflict verdict is unchanged either way).
      const files = await conflictedFiles(integrateDir)
      await git(integrateDir, ['rebase', '--abort'])
      return files.length ? { status: 'conflict', files } : { status: 'conflict' }
    }
    // Rebased HEAD now has the trunk as an ancestor → a true fast-forward push.
    // Still no --force: a trunk that moved again during the rebase rejects this.
    const pushed = await git(integrateDir, ['push', remote, `HEAD:refs/heads/${target}`])
    return pushed !== null
      ? { status: 'integrated', mode: 'rebase' }
      : { status: 'error', reason: 'fast-forward push rejected after rebase' }
  } finally {
    // Always tear the throwaway worktree down (forced — it is detached + ours),
    // then prune the bookkeeping. Best-effort; a leftover is swept by the
    // periodic central-worktree cleaner anyway.
    await git(projectPath, ['worktree', 'remove', '--force', integrateDir])
    await git(projectPath, ['worktree', 'prune'])
  }
}

// ── Conflict → worker rebase delegation (card 012a2848) ───────────────────────
//
// integrateBranch ABORTS a rebase that conflicts and reports {status:'conflict'}
// (it never auto-resolves — the safety contract above). What the COMMANDER then
// does today BY HAND is hand the conflict back to the branch's worker: "rebase
// your own branch onto the moved trunk, resolve it, commit, and I'll land it."
// The orchestrator automates exactly that, and THIS is the single source of the
// instruction it delegates — kept here, beside integrateBranch (the producer of
// the conflict), so the conflict contract lives in one module. Pure + total: the
// orchestrator uses the returned text BOTH as the live worker's PTY instruction
// AND as the durable /order injection a dead-worker re-dispatch carries.

/** Build the one-line directive handed to a worker whose finished `swarm/*` branch
 *  CONFLICTS with the trunk at integration. It names the conflicting files (the
 *  surface {@link integrateBranch} captured), the exact rebase command, and the
 *  HARD safety contract the worker must honor (the order goal's condition 2):
 *    • rebase its OWN branch ONLY — never the trunk, never another branch;
 *    • RESOLVE the conflict + commit, then re-report done (so the engine retries);
 *    • NEVER push, and NEVER force-push — landing (the push) stays the engine's job.
 *  The files list is capped so a pathological conflict can't bloat the line. Pure
 *  (no IO) — unit-tested in isolation. */
export const buildConflictRebaseInstruction = (opts: {
  branch: string
  target: string
  files?: readonly string[]
  remote?: string
}): string => {
  const remote = opts.remote ?? 'origin'
  const files = (opts.files ?? []).filter((f) => f && f.trim())
  const filesNote = files.length
    ? `競合ファイル: ${files.slice(0, 10).join(', ')}${files.length > 10 ? ` (他${files.length - 10}件)` : ''}`
    : '競合ファイルは git status で確認'
  return (
    `統合時に trunk(${remote}/${opts.target}) との rebase で競合し、自動統合できませんでした。` +
    `${filesNote}。自分のブランチ ${opts.branch} で ` +
    `\`git fetch ${remote} && git rebase ${remote}/${opts.target}\` を実行して trunk に乗せ直し、` +
    `競合を解消して commit してください(解消後は tsc/lint/test を緑に)。` +
    `push はしないでください — 統合(push)は engine が行います。force-push は絶対に禁止です。`
  )
}
