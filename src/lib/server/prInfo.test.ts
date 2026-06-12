import { describe, it, expect, vi, beforeEach } from 'vitest'

// fetchPrInfo's gh precondition is probeGhCli — mock it so these tests never
// spawn the real gh (and never reach `gh pr view`: every fetchPrInfo case here
// exits on the unavailable path before the execFile).
vi.mock('./ghCli', () => ({
  probeGhCli: vi.fn(async () => ({ installed: false, authenticated: false })),
}))

import {
  parsePrUrl,
  fetchPrInfo,
  prInfoCacheGet,
  prInfoCachePut,
  prInfoCacheClear,
} from './prInfo'
import { probeGhCli } from './ghCli'

const probeMock = vi.mocked(probeGhCli)

beforeEach(() => {
  prInfoCacheClear()
  probeMock.mockClear()
  probeMock.mockResolvedValue({ installed: false, authenticated: false })
})

describe('parsePrUrl', () => {
  it('accepts the canonical GitHub PR URL', () => {
    expect(parsePrUrl('https://github.com/octo-org/my.repo/pull/123')).toEqual({
      owner: 'octo-org',
      repo: 'my.repo',
      number: 123,
    })
  })

  it.each([
    ['http (not https)', 'http://github.com/o/r/pull/1'],
    ['wrong host', 'https://gitlab.com/o/r/pull/1'],
    ['subdomain host', 'https://evil.github.com/o/r/pull/1'],
    ['issues path', 'https://github.com/o/r/issues/1'],
    ['non-numeric number', 'https://github.com/o/r/pull/abc'],
    ['trailing path', 'https://github.com/o/r/pull/1/files'],
    ['query string', 'https://github.com/o/r/pull/1?w=1'],
    ['fragment', 'https://github.com/o/r/pull/1#discussion'],
    ['owner with slash (extra segment)', 'https://github.com/o/x/r/pull/1'],
    ['empty string', ''],
    ['not a URL at all', 'gh pr view 1'],
  ])('rejects %s', (_label, url) => {
    expect(parsePrUrl(url)).toBeNull()
  })
})

describe('fetchPrInfo — unavailable paths', () => {
  it('returns { available: false } when gh is not installed', async () => {
    const info = await fetchPrInfo('/tmp/proj', 'https://github.com/o/r/pull/1')
    expect(info).toEqual({ available: false })
  })

  it('returns { available: false } when gh is installed but unauthenticated', async () => {
    probeMock.mockResolvedValue({ installed: true, authenticated: false })
    const info = await fetchPrInfo('/tmp/proj', 'https://github.com/o/r/pull/1')
    expect(info).toEqual({ available: false })
  })

  it('returns { available: false } for a malformed prUrl without probing gh', async () => {
    const info = await fetchPrInfo('/tmp/proj', 'https://github.com/o/r/pull/1/files')
    expect(info).toEqual({ available: false })
    // URL validation runs FIRST — a garbage URL never even costs a probe.
    expect(probeMock).not.toHaveBeenCalled()
  })
})

describe('pr-info cache shape', () => {
  const url = (n: number) => `https://github.com/o/r/pull/${n}`
  const open = { available: true, state: 'OPEN', title: 't', additions: 1, deletions: 2, isDraft: false } as const

  it('returns a stored entry within the 60s TTL and drops it after', () => {
    prInfoCachePut(url(1), open, 1_000_000)
    expect(prInfoCacheGet(url(1), 1_000_000 + 59_999)).toEqual(open)
    expect(prInfoCacheGet(url(1), 1_000_000 + 60_000)).toBeNull()
    // expiry is destructive — a later within-TTL read can't resurrect it
    expect(prInfoCacheGet(url(1), 1_000_000 + 1)).toBeNull()
  })

  it('caps at 100 entries, evicting the oldest-inserted first', () => {
    for (let i = 1; i <= 101; i++) prInfoCachePut(url(i), open, 2_000_000)
    expect(prInfoCacheGet(url(1), 2_000_000)).toBeNull() // oldest evicted
    expect(prInfoCacheGet(url(2), 2_000_000)).toEqual(open) // survivor floor
    expect(prInfoCacheGet(url(101), 2_000_000)).toEqual(open) // newest kept
  })

  it('re-putting an existing key refreshes its eviction slot', () => {
    for (let i = 1; i <= 100; i++) prInfoCachePut(url(i), open, 3_000_000)
    prInfoCachePut(url(1), open, 3_000_001) // touch the oldest
    prInfoCachePut(url(200), open, 3_000_002) // overflow → evicts url(2), not url(1)
    expect(prInfoCacheGet(url(1), 3_000_002)).toEqual(open)
    expect(prInfoCacheGet(url(2), 3_000_002)).toBeNull()
  })
})
