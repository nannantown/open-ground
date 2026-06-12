// Build the first prompt for a Board-card claude session. The card's TITLE and
// CONTENT both go in (the old behaviour passed the title alone), and on a git
// project the prompt carries the task-branch protocol: claude names its own
// branch from the task, creates a dedicated git worktree under the project's
// CENTRAL worktrees dir (outside the repo — validateProjectPath already
// admits it), and does all work there. That isolation is what makes "run
// several task cards at once" safe: no two sessions ever share a checkout.
//
// The optional ProjectConfig (shared per-project policy) shapes the protocol:
//  - targetBranch: names the merge/PR base explicitly (default: the branch
//    checked out at launch time).
//  - completionFlow 'pr': instead of merging back, push the branch and open a
//    PR via `gh pr create`; a HUMAN merges it. With reviewColumn on, the card
//    moves to the review column instead of done.
//
// (verifyCommands — the old "Definition of done" section — was retired
// 2026-06-11 with its Settings editor: hidden prompt-steering state with no
// UI to inspect or clear it is worse than no feature. Legacy saved values
// are preserved in project data but no longer injected.)
//
// Pure (the route resolves git-ness, the worktrees dir, and the config) so the
// exact prompt contract is unit-testable.

import type { ProjectConfig } from '../types'

export interface TaskPromptInput {
  /** The project root (the PTY's cwd). */
  cwd: string
  task: { id?: string; title: string; notes?: string }
  /** The app's API port (for the board-card curl). */
  port: number
  /** Central worktrees dir for this project, or null when the project is not
   *  a git repo (the branch protocol is omitted entirely then). */
  worktreesDir: string | null
  /** Shared per-project policy (completion flow / target branch / review
   *  column). Omitted or empty = legacy defaults: merge back into the
   *  launch-time branch. */
  config?: ProjectConfig
}

export const buildTaskPrompt = ({ cwd, task, port, worktreesDir, config }: TaskPromptInput): string => {
  const lines: string[] = [`# Task: ${task.title.trim()}`]
  const notes = (task.notes ?? '').trim()
  if (notes) lines.push('', '## Content', notes)

  const targetBranch = (config?.targetBranch ?? '').trim()
  // The merge/PR base, as prose: explicit when configured, launch-time branch
  // otherwise (the pre-config behaviour, kept verbatim).
  const baseProse = targetBranch
    ? `\`${targetBranch}\``
    : 'the branch that was checked out when you started'
  // completionFlow only means anything on a git project; non-git ignores it.
  const isPr = Boolean(worktreesDir) && config?.completionFlow === 'pr'

  if (worktreesDir) {
    lines.push(
      '',
      '## How to work on this task (git project, managed by OPEN GROUND)',
      'Implement this task on its OWN branch in its OWN git worktree, so other task sessions can run in parallel without sharing a checkout:',
      '1. Derive a short kebab-case branch name from the task and prefix it with `task/` (e.g. `task/u2-153-assign-location`). If that branch already exists, append a numeric suffix (`-2`, `-3`, …) instead of reusing it. Tell the user the name before you start.',
      `2. Create the worktree OUTSIDE the repo: git worktree add "${worktreesDir}/<branch-name-without-prefix>" -b <branch>`,
      `3. cd into that worktree and do ALL file changes and commits THERE. Never check out branches in the main working tree (${cwd}).`,
    )
    if (task.id) {
      // The app's drawer shows the branch in its session status strip — record
      // it the moment it exists so the user sees where the work lives.
      lines.push(
        `Right after creating the worktree, record the branch name on the task card (substitute the real branch name): curl -s -X POST http://127.0.0.1:${port}/api/project/tasks -H 'content-type: application/json' -d '{"path":"${cwd}","setBranch":[{"id":"${task.id}","branch":"<branch>"}]}'`,
      )
    }
    if (isPr) {
      lines.push(
        `4. When the task is complete AND the user confirms: push the task branch, then open a pull request against ${baseProse}: gh pr create --base ${targetBranch || '<launch-branch>'} --head <branch> (title from the task; body summarizing the work done).${targetBranch ? '' : ' <launch-branch> is the branch that was checked out when you started.'}`,
        '5. Report the PR URL to the user, then `git worktree remove` the worktree. KEEP the task branch — it belongs to the open PR.',
        '6. Do NOT merge the pull request yourself — a human reviews and merges it.',
      )
    } else {
      lines.push(
        `4. When the task is complete AND the user confirms: merge the task branch back into ${baseProse}, \`git worktree remove\` the worktree, delete the task branch, and report what was merged.`,
      )
    }
  }

  if (task.id) {
    if (isPr && config?.reviewColumn) {
      lines.push(
        '',
        'Once the PR is open, record its URL on the task card AND move the card to the review column on the app board (the human merges the PR and marks it done) — substitute the real PR URL:',
        `curl -s -X POST http://127.0.0.1:${port}/api/project/tasks -H 'content-type: application/json' -d '{"path":"${cwd}","setPrUrl":[{"id":"${task.id}","url":"<PR-URL>"}],"setColumn":[{"id":"${task.id}","column":"review"}]}'`,
      )
    } else if (isPr) {
      lines.push(
        '',
        'Once the PR is open, record its URL on the task card (substitute the real PR URL):',
        `curl -s -X POST http://127.0.0.1:${port}/api/project/tasks -H 'content-type: application/json' -d '{"path":"${cwd}","setPrUrl":[{"id":"${task.id}","url":"<PR-URL>"}]}'`,
      )
      lines.push(
        '',
        `When the task is finished and its PR is open, mark its card done on the app board:`,
        `curl -s -X POST http://127.0.0.1:${port}/api/project/tasks -H 'content-type: application/json' -d '{"path":"${cwd}","markDone":["${task.id}"]}'`,
      )
    } else {
      const when = worktreesDir ? ' and merged' : ''
      lines.push(
        '',
        `When the task is finished${when}, mark its card done on the app board:`,
        `curl -s -X POST http://127.0.0.1:${port}/api/project/tasks -H 'content-type: application/json' -d '{"path":"${cwd}","markDone":["${task.id}"]}'`,
      )
    }
  }

  return lines.join('\n')
}
