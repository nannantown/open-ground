import { describe, it, expect } from 'vitest'
import { classifyBlogError } from './blogError'

// Pinned on the strings blogPublish.ts actually writes (wpRequest's self-made
// messages + the catch's appended cause code) — a mapping test over invented
// inputs would pass while the real reasons fell through to 'other'.
describe('classifyBlogError — the reason line the owner can act on', () => {
  it.each([
    ['POST /wp/v2/posts: HTTP 401', 'auth'],
    ['POST /wp/v2/posts: HTTP 403', 'forbidden'],
    ['POST /wp/v2/posts: 404', 'notFound'],
    ['POST /wp/v2/posts: HTTP 500', 'server'],
    ['POST /wp/v2/posts: HTTP 503', 'server'],
    ['fetch failed (ENOTFOUND)', 'network'],
    ['fetch failed (ECONNREFUSED)', 'network'],
    ['fetch failed (UNABLE_TO_VERIFY_LEAF_SIGNATURE)', 'network'],
    ['This operation was aborted', 'network'],
    ['something else entirely', 'other'],
    ['', 'other'],
    [undefined, 'other'],
  ])('%s → %s', (reason, kind) => {
    expect(classifyBlogError(reason as string | undefined)).toBe(kind)
  })
})
