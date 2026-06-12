import { describe, it, expect } from 'vitest'
import { buildReviewPrompt } from './reviewPrompt'

// Wording contract of the "Review with claude" instruction (F064). The text is
// pasted UNSENT into the claude input — these tests pin the parts the flow
// depends on: branch + worktree named, the diff command anchored with -C (no
// cd), the configured target branch (or a default-branch fallback), and the
// read-only ground rule.

describe('buildReviewPrompt', () => {
  it('names branch, worktree dir and the configured target branch', () => {
    const p = buildReviewPrompt({
      branch: 'task/fix-login',
      dir: '/home/u/.openground/projects/uuid/worktrees/review-task-fix-login',
      base: 'main',
    })
    expect(p).toContain('branch task/fix-login')
    expect(p).toContain(
      'worktree: /home/u/.openground/projects/uuid/worktrees/review-task-fix-login',
    )
    expect(p).toContain('against main.')
    // The diff command is anchored to the worktree — works from any cwd.
    expect(p).toContain(
      'git -C /home/u/.openground/projects/uuid/worktrees/review-task-fix-login diff main...HEAD',
    )
    // No cd — the session may be reused with a different cwd.
    expect(p).not.toMatch(/(^|\s)cd\s/)
    expect(p).toContain('Do not modify any files.')
    expect(p).toContain('file:line')
  })

  it('falls back to the default branch when no target is configured', () => {
    const p = buildReviewPrompt({ branch: 'task/x', dir: '/wt' })
    expect(p).toContain('against the default branch.')
    expect(p).toContain('git -C /wt diff origin/HEAD...HEAD')
  })

  it('treats a whitespace-only base as unset', () => {
    const p = buildReviewPrompt({ branch: 'task/x', dir: '/wt', base: '   ' })
    expect(p).toContain('against the default branch.')
  })
})
