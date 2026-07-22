// selfUpdateOnIntegrate — reconnects the engine self-update trigger to the
// COMMANDER's manual integration flow (the 2026-07-15 manager-only rework).
//
// HISTORY. Until 2026-07-15 the engine itself landed swarm branches on main
// (runIntegratePass's FF push) and fired requestEngineSelfUpdate right after
// its own land. The manager-only rework removed the engine's whole land path —
// the ONLY way a swarm/* branch reaches origin/main now is the commander's
// manual `git push origin HEAD:main` (og-manage §マージ). That push happens in
// a terminal PTY the server never observes, so the trigger went dormant and
// the self-improvement loop (rebuild→canary→health→switch; electron/
// selfUpdate.js) could never ignite again (docs/commander/TARGET-STATE.md §5).
//
// THE SEAM. What the server DOES observe is the very next step of the same
// commander flow: og-manage §マージ step 7 — "confirm the merge landed
// (`merge-base --is-ancestor <branch> origin/main`), ONLY THEN clean up via
// POST /api/swarm/worktree/remove (force:false)". So a CONFIRMED non-force
// worktree removal whose branch tip is already reachable from the trunk IS the
// observable "the commander just integrated this" event. We re-run the
// commander's own ancestor check server-side and, when it holds, fire the
// (heavily gated) self-update signal. force:true removals are the kill/abandon
// lane — never an integration cleanup — and are excluded by the caller
// (removeSwarmWorktree snapshots the branch only for non-force removals).
//
// WHY NOT the engine's monitor tick: detecting "origin/main advanced" would
// need a `git fetch` (a network side-effect on a read path), fires on ANY main
// movement (not just swarm integrations), and needs the engine to be running —
// the remove API works engine-up or engine-down, and the commander's push has
// already refreshed the very remote-tracking ref we compare against (a push
// from this repo updates refs/remotes/origin/main locally), so no fetch is
// needed at all.
//
// KNOWN NARROW OVER-FIRE: a worker that committed NOTHING (branch tip == the
// main it was spawned from) also passes the ancestor check when swept
// non-force. Registry keeps no spawn-base to tell the two apart; the cost is
// one redundant rebuild of the identical source in armed dev runs only (the
// electron side single-flights and health-checks), so this is accepted.
//
// FAIL-SAFE BY CONSTRUCTION (mirrors selfUpdateSignal.ts): every step returns
// a no-op result instead of throwing, so the removal path that calls us can
// never be disturbed. READ-ONLY w.r.t. git — the only git commands here are
// rev-parse / merge-base, so the engine still has NO path that moves main
// (TARGET-STATE §5 condition 1, pinned by the manager-only regression tests).

import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { requestEngineSelfUpdate } from './selfUpdateSignal'
import { createSwarmInfoNotification } from './swarmNotifications'
import type { SelfUpdateFireResult } from '../types'

const execFile = promisify(execFileCb)

/** Run git in `cwd`; null on any failure (no git, not a repo, non-zero exit).
 *  env is composed per call so tests that re-point HOME/env mid-suite are not
 *  frozen out by a module-load snapshot. */
const git = async (cwd: string, args: string[]): Promise<string | null> => {
  try {
    const { stdout } = await execFile('git', args, {
      cwd,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return stdout
  } catch {
    return null
  }
}

/** What removeSwarmWorktree reads off the worker worktree BEFORE tearing it
 *  down — afterwards there is nothing left to ask. */
export interface WorktreeBranchSnapshot {
  /** The checked-out branch name (e.g. `swarm/fix-login-0717-...`). */
  branch: string
  /** The branch tip sha at removal time. */
  head: string
}

/** Read the branch name + HEAD sha of a (still-existing) worktree. Call BEFORE
 *  the worktree is removed. null on any failure (not a repo, detached HEAD,
 *  git missing) — fail-safe: no snapshot simply means no self-update check. */
export const snapshotWorktreeBranch = async (
  worktree: string,
): Promise<WorktreeBranchSnapshot | null> => {
  const branch = (await git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  if (!branch || branch === 'HEAD') return null // unreadable, or detached HEAD
  const head = (await git(worktree, ['rev-parse', 'HEAD']))?.trim()
  if (!head) return null
  return { branch, head }
}

/** Trunk-ref precedence for the integrated-check: the commander pushes to
 *  origin/main (og-manage §マージ), so that remote-tracking ref — which the
 *  commander's own push just updated — is the truth. Local `main` only covers
 *  a repo with no origin remote at all. Deliberately NO `HEAD` fallback
 *  (unlike SWARM_BASE_REF_PREFERENCE): the primary checkout's HEAD proves
 *  nothing about integration, and a wrong trunk here would over-fire. */
export const SELF_UPDATE_TRUNK_PREFERENCE = ['origin/main', 'main'] as const

const NO_FIRE: SelfUpdateFireResult = { detected: false, requested: false }

/**
 * After a CONFIRMED non-force worktree removal: if the removed worker's branch
 * tip is an ancestor of the trunk, the commander has integrated it — fire the
 * self-update trigger. The trigger itself stays double-gated
 * (selfUpdateSignal.ts: IPC channel + OPENGROUND_SOURCE_ROOT canonical match)
 * and electron/main.js additionally requires SELF_UPDATE_ARMED and
 * single-flights the cycle, so in every dev/test/unarmed context this resolves
 * to a harmless `{detected, requested:false}`. Never throws.
 *
 * When the trigger actually fires, a persisted 'self-update-requested' bell
 * notification (+ OS toast) is written — the observable record that the app is
 * about to rebuild and cut itself over; it survives the very restart it
 * announces.
 */
export const fireSelfUpdateIfIntegrated = async (
  projectPath: string,
  snap: WorktreeBranchSnapshot | null,
): Promise<SelfUpdateFireResult> => {
  if (!snap) return NO_FIRE
  try {
    // Pick the first trunk ref that exists in the project repo.
    let trunk: string | null = null
    for (const ref of SELF_UPDATE_TRUNK_PREFERENCE) {
      if ((await git(projectPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) !== null) {
        trunk = ref
        break
      }
    }
    if (!trunk) return NO_FIRE // no trunk at all — nothing can be "integrated"

    // The commander's own landed-check (og-manage §マージ step 7), re-run
    // server-side: exit 0 ⇔ the branch tip is reachable from the trunk.
    const isAncestor =
      (await git(projectPath, ['merge-base', '--is-ancestor', snap.head, trunk])) !== null
    if (!isAncestor) return NO_FIRE

    const requested = requestEngineSelfUpdate(projectPath)
    if (requested) {
      // Bell + OS toast only when the cycle was ACTUALLY requested — in normal
      // (unarmed) runs the commander's every sweep must stay silent. Best-effort:
      // a failed write never disturbs the removal that called us.
      await createSwarmInfoNotification({
        event: 'self-update-requested',
        detail: `マネージャーの統合を検知（${snap.branch} → ${trunk} 到達済み）— エンジン自己入替サイクル（rebuild→canary→切替）を要求しました`,
        projectPath,
        branch: snap.branch,
      }).catch(() => {})
    }
    return { detected: true, requested }
  } catch {
    return NO_FIRE // fail-safe: never disturb the removal path
  }
}
