// @vitest-environment jsdom
//
// The Swarm poll loop's CONCURRENCY contract. Sibling file useSwarmEngine.test.ts
// covers the pure sanitize layer; this one pins how the one poll lap behaves in
// time — the part that used to corrupt the Swarm tab's snapshot:
//
//   - the reads used to run as SERIAL awaits, so one lap cost the SUM of four
//     fs-reading routes (under swarm load, load average 5-7, that stretches past
//     ENGINE_POLL_MS — measured in card d44b5ff0),
//   - the interval's only guard was `busy`, which is the TOGGLE flag, not a poll
//     in-flight flag, so laps stacked on top of each other, and
//   - two overlapping laps applied their setState in COMPLETION order, so a slow
//     lap landing late overwrote a newer one — the Swarm tab flicking back to a
//     stale worker list / engine state ("the escalation I dismissed came back").
//
// Each test below has a matching mutation recorded in the card report: revert the
// fix and the test goes red (teeth verified, not assumed).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { I18nProvider } from '@/i18n/I18nContext'
import { useSwarmEngine, ENGINE_POLL_MS } from './useSwarmEngine'

// Under parallel vitest load the 5s default test timeout fires as a false red
// (vitest.config.ts sets none) — same pin as the server-side swarm tests.
// NOTE, measured at load average 7-8 while writing this file: this only covers
// hooks declared HERE. setup-home.ts's home fence (beforeEach/afterEach, fs
// work) is registered by a setup file before this runs, so it keeps the 10s
// default and is what times out first under load — "Hook timed out in 10000ms
// ❯ src/test/setup-home.ts" is a LOAD artefact, not a failure of these tests
// (they pass with `npx vitest run --hookTimeout=60000`). Fixing that globally
// belongs to the vitest-timeout card (d44b5ff0), not here.
// Pinned to the canonical ceiling (vitest.config.ts's 60s); shorter values here
// would silently re-cap that global back down (setConfig runs after it).
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

const wrapper = ({ children }: { children: ReactNode }) => <I18nProvider>{children}</I18nProvider>

/** fetch may be handed a string, URL or Request — normalise to the path string. */
const urlOf = (input: unknown): string => {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return (input as Request)?.url ?? ''
}

type PendingCall = {
  url: string
  /** Resolve this call — nothing settles until the test says so. */
  settle: (body: unknown, ok?: boolean) => void
}

/** A fetch stub that hands back a PENDING promise per call, so a test controls
 *  exactly when (and in which order) each route answers. */
const harness = () => {
  const calls: PendingCall[] = []
  const fetchMock = vi.fn((input: unknown) => {
    // The I18nProvider wrapper reads /api/settings on mount. It isn't part of
    // the poll lap under test, so answer it at once and keep it out of `calls`
    // — only /api/swarm/* traffic is what these tests count.
    if (!urlOf(input).startsWith('/api/swarm/')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as Response)
    }
    let resolve!: (r: Response) => void
    const promise = new Promise<Response>((res) => {
      resolve = res
    })
    calls.push({
      url: urlOf(input),
      settle: (body, ok = true) =>
        resolve({
          ok,
          status: ok ? 200 : 500,
          json: () => Promise.resolve(body),
        } as Response),
    })
    return promise
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, fetchMock }
}

/** Drain the microtask queue (fetch → res.json() → allSettled → apply is several
 *  ticks deep). Deliberately microtask-only: usable under fake timers. */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

const sortedUrls = (calls: PendingCall[]) => calls.map((c) => c.url).sort()

const ROUTES_P1 = [
  '/api/swarm/notifications',
  '/api/swarm/orchestrator/drain-tick',
  '/api/swarm/orchestrator?path=%2Fp1',
  '/api/swarm/preflight?path=%2Fp1',
  '/api/swarm/workers?path=%2Fp1',
].sort()

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useSwarmEngine poll — the four route reads run in parallel', () => {
  it('fires all four reads without waiting for the first one to resolve', async () => {
    const { calls } = harness()
    renderHook(() => useSwarmEngine('/p1'), { wrapper })

    // NOTHING has settled — every call handed back a pending promise. If the
    // reads were serial the lap would still be parked on the first await and
    // only the leading route would have been requested.
    await act(async () => {
      await flush()
    })

    expect(sortedUrls(calls)).toEqual(ROUTES_P1)
  })

  it('keeps the per-read degrade contract: one failing route does not take the others down', async () => {
    const { calls } = harness()
    const { result } = renderHook(() => useSwarmEngine('/p1'), { wrapper })

    await act(async () => {
      await flush()
    })
    await act(async () => {
      for (const c of calls) {
        if (c.url.startsWith('/api/swarm/orchestrator?')) c.settle({}, false) // 500 → not available
        else if (c.url === '/api/swarm/notifications') c.settle({}, false) // 403/404 → empty
        else if (c.url.startsWith('/api/swarm/workers')) c.settle({ workers: [{ worktree: '/wt/a', branch: 'swarm/a' }] })
        else c.settle({})
      }
      await flush()
    })

    // The dead engine + notifications routes degraded exactly as before, and the
    // healthy workers route still landed its snapshot.
    expect(result.current.available).toBe(false)
    expect(result.current.fatalNotifications).toEqual([])
    expect(result.current.realWorkers).toEqual([{ worktree: '/wt/a', branch: 'swarm/a' }])
  })
})

describe('useSwarmEngine poll — one lap at a time (in-flight guard)', () => {
  it('drops interval ticks that arrive while the previous lap is still running', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
    const { calls } = harness()
    renderHook(() => useSwarmEngine('/p1'), { wrapper })

    await act(async () => {
      await flush()
    })
    expect(calls).toHaveLength(5) // lap 1 is out, and stays unresolved

    // Three whole poll periods elapse while lap 1 is still in flight — exactly
    // the swarm-load case (a lap slower than ENGINE_POLL_MS). No lap may stack.
    await act(async () => {
      vi.advanceTimersByTime(ENGINE_POLL_MS * 3)
      await flush()
    })
    expect(calls).toHaveLength(5)

    // Once lap 1 lands the slot frees up and the next tick polls normally —
    // the guard must skip a tick, not wedge the loop shut.
    await act(async () => {
      for (const c of calls) c.settle({})
      await flush()
    })
    await act(async () => {
      vi.advanceTimersByTime(ENGINE_POLL_MS)
      await flush()
    })
    expect(calls).toHaveLength(10)
  })

  it('drops a focus-triggered poll mid-lap too', async () => {
    const { calls } = harness()
    renderHook(() => useSwarmEngine('/p1'), { wrapper })

    await act(async () => {
      await flush()
    })
    expect(calls).toHaveLength(5)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await flush()
    })
    expect(calls).toHaveLength(5)
  })
})

describe('useSwarmEngine poll — a stale lap never overwrites a newer one', () => {
  const W_OLD = { worktree: '/wt/old', branch: 'swarm/old' }
  const W_NEW = { worktree: '/wt/new', branch: 'swarm/new' }

  it('discards the slow lap that lands AFTER a newer lap already applied', async () => {
    const { calls } = harness()
    const { result, rerender } = renderHook(({ p }: { p: string }) => useSwarmEngine(p), {
      wrapper,
      initialProps: { p: '/p1' },
    })

    await act(async () => {
      await flush()
    })
    const lapA = calls.splice(0) // the SLOW lap — left unresolved on purpose
    expect(lapA).toHaveLength(5)

    // A newer lap starts (the hook moves to another project — the same
    // generation bump a `busy` flip or a re-run causes).
    rerender({ p: '/p2' })
    await act(async () => {
      await flush()
    })
    const lapB = calls.splice(0)
    expect(lapB).toHaveLength(5) // the cleanup freed the in-flight slot

    // Newer lap B lands FIRST…
    await act(async () => {
      for (const c of lapB) c.settle(c.url.startsWith('/api/swarm/workers') ? { workers: [W_NEW] } : {})
      await flush()
    })
    expect(result.current.realWorkers).toEqual([W_NEW])

    // …and the older lap A only now comes back. Completion order would make it
    // win; the generation stamp must throw it away.
    await act(async () => {
      for (const c of lapA) c.settle(c.url.startsWith('/api/swarm/workers') ? { workers: [W_OLD] } : {})
      await flush()
    })
    expect(result.current.realWorkers).toEqual([W_NEW])
  })
})
