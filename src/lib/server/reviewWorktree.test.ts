import { describe, it, expect } from 'vitest'
import { sanitizeBranch, reviewWorktreeName } from './reviewWorktree'

// ensureReviewWorktree needs a REGISTERED project (projectUUIDFromPath throws
// otherwise), which the git-fixture harness covers elsewhere; here we pin
// the pure parts — the argv-safety gate and the deterministic dir naming.

describe('sanitizeBranch', () => {
  it('accepts normal and task/ branches', () => {
    expect(sanitizeBranch('main')).toBe('main')
    expect(sanitizeBranch('task/u2-153-assign-location')).toBe('task/u2-153-assign-location')
    expect(sanitizeBranch('  feature/x.y_z-1  '.trim())).toBe('feature/x.y_z-1')
  })

  it('rejects option-looking and path-escaping names', () => {
    for (const bad of [
      '-rf',
      '--force',
      '../etc',
      'a/../b',
      'a//b',
      'a/./b',
      '',
      '  ',
      'sp ace',
      'semi;colon',
      'tick`',
      'dollar$(x)',
      'x'.repeat(300),
    ]) {
      expect(() => sanitizeBranch(bad), bad).toThrow()
    }
  })
})

describe('reviewWorktreeName', () => {
  it('prefixes review-, flattens slashes, and hash-disambiguates', () => {
    expect(reviewWorktreeName('task/fix-login')).toMatch(/^review-task-fix-login-[0-9a-f]{6}$/)
    expect(reviewWorktreeName('main')).toMatch(/^review-main-[0-9a-f]{6}$/)
    // 'task/foo-bar' and 'task-foo-bar' flatten identically — the hash keeps
    // their dirs distinct (the old scheme collided and produced a misleading
    // 'not pushed' error for the second branch).
    expect(reviewWorktreeName('task/foo-bar')).not.toBe(reviewWorktreeName('task-foo-bar'))
    // Deterministic: same branch → same dir across calls.
    expect(reviewWorktreeName('task/foo-bar')).toBe(reviewWorktreeName('task/foo-bar'))
  })
})
