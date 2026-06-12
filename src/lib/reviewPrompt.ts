// buildReviewPrompt — the instruction text the Board drawer's "Review with
// claude" (F064) pastes UNSENT into the card's claude input box. Pure so the
// exact wording contract is unit-testable.
//
// Design notes:
//  - No `cd`: the session's cwd may be the project root (a reuse of the card's
//    live session), so the worktree dir is named explicitly and every git
//    command is anchored with `git -C <dir>` — works from any cwd.
//  - English-fixed: prompts to claude stay English regardless of UI language
//    (per spec — a ja variant isn't needed here).
//  - `base` is the project's configured target branch (config.targetBranch);
//    when unset the prompt falls back to "the default branch" and lets claude
//    resolve it (origin/HEAD).

export interface ReviewPromptOpts {
  /** The task branch under review. */
  branch: string
  /** Absolute path of the review worktree where the branch is checked out. */
  dir: string
  /** The merge target branch (config.targetBranch); empty/unset → default. */
  base?: string
}

export const buildReviewPrompt = (opts: ReviewPromptOpts): string => {
  const base = opts.base?.trim() || ''
  const target = base || 'the default branch'
  const diffBase = base || 'origin/HEAD'
  return [
    `Review the changes on branch ${opts.branch} (worktree: ${opts.dir}) against ${target}.`,
    `The branch is already checked out in that worktree — read files there and run git with \`git -C ${opts.dir} …\` (do not cd).`,
    `Read the diff (git -C ${opts.dir} diff ${diffBase}...HEAD), assess correctness and risks, and report findings with file:line references.`,
    'Do not modify any files.',
  ].join('\n')
}
