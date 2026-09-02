import { describe, it, expect, beforeEach } from 'vitest'
import {
  probeOnline,
  resetConnectivityForTests,
  CONNECTIVITY_PROBE_TTL_MS,
} from './swarmConnectivity'

// The probe's contract, pinned on its EFFECTS (what it answers, how often it
// asks), not on "fetch was called" — an implementation that never fetched and
// always said online would satisfy a call-count test and doom the hold.
describe('probeOnline — one cheap reachability verdict, cached', () => {
  beforeEach(() => resetConnectivityForTests())

  it('ANY HTTP answer means online — a 404 from the API root is a route that works', async () => {
    const fetch = (async () => new Response(null, { status: 404 })) as unknown as typeof globalThis.fetch
    expect(await probeOnline({ fetch, now: () => 1_000 })).toBe(true)
  })

  it('a fetch that throws (no route / DNS / refused) means offline', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed: ENOTFOUND api.anthropic.com')
    }) as unknown as typeof globalThis.fetch
    expect(await probeOnline({ fetch, now: () => 1_000 })).toBe(false)
  })

  it('a fetch that hangs past the deadline means offline — the abort is honoured', async () => {
    const fetch = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof globalThis.fetch
    expect(await probeOnline({ fetch, now: () => 1_000, timeoutMs: 20 })).toBe(false)
  })

  it('the verdict is CACHED for the TTL and re-probed after it — offline→online is seen on the next probe', async () => {
    let calls = 0
    let answer = false
    const fetch = (async () => {
      calls += 1
      if (!answer) throw new Error('offline')
      return new Response(null, { status: 404 })
    }) as unknown as typeof globalThis.fetch
    expect(await probeOnline({ fetch, now: () => 1_000 })).toBe(false)
    answer = true
    // Inside the TTL: the stale verdict stands, no second request.
    expect(await probeOnline({ fetch, now: () => 1_000 + CONNECTIVITY_PROBE_TTL_MS - 1 })).toBe(false)
    expect(calls).toBe(1)
    // Past the TTL: re-probed, and the route is back.
    expect(await probeOnline({ fetch, now: () => 1_000 + CONNECTIVITY_PROBE_TTL_MS + 1 })).toBe(true)
    expect(calls).toBe(2)
  })
})
