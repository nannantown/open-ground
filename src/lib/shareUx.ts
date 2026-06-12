// Pure presentation logic for the git-share UX (docs/SHARE_UX_FLOWS.md §2).
// Which sections the Project settings dialog shows, and where the share
// entry points appear, are decided HERE — testable without the DOM, and the
// single place the "no share vocabulary for solo users" rule lives.

import type { ShareStatus } from '@/lib/types'

/** The dialog only cares about these two booleans; accepting the narrow
 *  shape keeps tests free of full ShareStatus fixtures. */
export type ShareStateLike = Pick<ShareStatus, 'shared' | 'gitRepo'>

export interface SettingsSections {
  /** "共有 (Shared with your team)" — members, display name, auto-sync,
   *  invite + stop-sharing links. ONLY while actually shared (S033/S034). */
  team: boolean
  /** "タスクのワークフロー" — completionFlow + targetBranch. Hidden for a
   *  known non-git folder (S047); shown otherwise (incl. unknown status —
   *  conservative fallback so a transient status failure never hides the
   *  user's saved workflow settings). */
  workflow: boolean
  /** Worktrees listing/cleanup — a git concept; same visibility as workflow. */
  worktrees: boolean
  /** Bottom "share this project…" CTA — only when we positively know the
   *  project is an unshared git repo (never on unknown status). */
  shareCta: boolean
}

export const settingsSections = (status: ShareStateLike | null): SettingsSections => {
  if (status?.shared) {
    return { team: true, workflow: true, worktrees: true, shareCta: false }
  }
  if (status && !status.gitRepo) {
    // Known non-git: personal prefs only — no workflow, no share vocabulary.
    return { team: false, workflow: false, worktrees: false, shareCta: false }
  }
  // Unshared git repo, or status unknown (null = share routes unreachable):
  // workflow stays visible; the CTA needs a confirmed git repo.
  return {
    team: false,
    workflow: true,
    worktrees: true,
    shareCta: status?.gitRepo === true,
  }
}

/** Header "Share…" button (the pre-share occupant of the Sync/Live slot):
 *  only for a present, unshared git repo whose folder still exists. */
export const showHeaderShare = (
  status: ShareStateLike | null,
  missing: boolean,
): boolean => !!status && !status.shared && status.gitRepo && !missing

/** InvitePanel publish line: the shared data is on the remote when nothing
 *  is dirty or waiting to be pushed (and a remote exists at all). An upstream
 *  must exist too — without one ahead degrades to 0 even though nothing was
 *  ever pushed, so `ahead === 0` alone would claim "published" for a branch
 *  that never left the machine. */
export const sharePublished = (
  status: Pick<ShareStatus, 'dirty' | 'ahead' | 'remoteUrl' | 'upstream'> | null,
): boolean =>
  !!status &&
  !!status.remoteUrl &&
  status.upstream &&
  !status.dirty &&
  status.ahead === 0
