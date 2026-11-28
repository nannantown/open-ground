// @vitest-environment node
//
// A SUCCESSFUL /usage SCRAPE IS A READING THE GATE KEEPS (AUTONOMY-SPEC R-D1).
//
// The display cache in claudeUsageCli is wiped 30 s after any transcript write —
// i.e. exactly while workers run — so a gate that read only that cache answered
// `usage-unknown` (allow) most of the time and the 60–80% ceilings never bit.
// Every successful scrape is now also written into the window store with its
// own capture time; invalidating the display cache no longer erases it.
//
// The scrape runs through the production fetchClaudeUsageCli with a fake PTY
// (node-pty mocked) that renders a /usage screen; nothing real is spawned.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const SCREEN = [
  'Current session',
  '█████████ 85% used',
  'Resets in 2 hours',
  '',
  'Current week (all models)',
  '██ 20% used',
  'Resets Dec 1 at 3pm (UTC)',
  '',
  'Current week (Sonnet)',
  '█ 5% used',
  'Resets Dec 1 at 3pm (UTC)',
].join('\r\n')

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => {
    let onData: (d: string) => void = () => {}
    return {
      onData: (cb: (d: string) => void) => { onData = cb },
      onExit: () => {},
      write: (d: string) => { if (d.startsWith('/usage')) onData(SCREEN) },
      kill: () => {},
    }
  }),
}))
vi.mock('./claudeConnection', () => ({
  claudeConnection: async () => ({ installed: true, loggedIn: true }),
  resolvedClaudeBin: () => '/fake/claude',
  absoluteClaudeOnPath: () => null,
}))
// The activity watcher would otherwise watch the real ~/.claude/projects.
vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('fs')>()),
  watch: vi.fn(() => ({ unref: () => {}, close: () => {} })),
}))

import { spawn as ptySpawn } from 'node-pty'
import { fetchClaudeUsageCli, invalidateUsageCache, peekCachedUsage, refreshUsageCacheDetached } from './claudeUsageCli'
import { budgetReadings, claimUsageRefresh, flushUsageWindowsPersist, __resetUsageWindowsForTest } from './usageWindows'
import { budgetGate, DEFAULT_SWARM_BUDGET, USAGE_FRESH_MS } from './swarmBudget'

const T0 = Date.parse('2026-11-28T06:00:00Z')
const standard = { title: 'standard card', notes: 'done when it works', tier: 'standard' as const }

beforeEach(() => {
  __resetUsageWindowsForTest()
  invalidateUsageCache()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(async () => {
  vi.useRealTimers()
  await flushUsageWindowsPersist()
  __resetUsageWindowsForTest()
  invalidateUsageCache()
})

const scrape = async () => {
  const p = fetchClaudeUsageCli()
  await vi.advanceTimersByTimeAsync(6_000) // boot grace, '/usage', the 800 ms settle
  const u = await p
  expect(u.status).toBe('ok')
  return Date.parse(u.capturedAt)
}

describe('a scrape survives the display cache', () => {
  it('a reading captured 40 s ago still gates after the display cache is invalidated', async () => {
    const capturedAt = await scrape()
    vi.setSystemTime(capturedAt + 40_000)
    invalidateUsageCache() // what the activity watcher does 30 s after any transcript write
    expect(peekCachedUsage()).toBeNull()

    const now = Date.now()
    expect(budgetReadings(now).five_hour).toMatchObject({ usedPct: 85, at: capturedAt, source: 'usage' })
    expect(budgetGate(budgetReadings(now), now, DEFAULT_SWARM_BUDGET, standard)).toMatchObject({
      allow: false,
      kind: 'window-headroom',
      usedPct: 85,
      until: capturedAt + 2 * 3_600_000,
    })
  })

  it('a 31-minute-old reading is not a reading: allow, said as usage-unknown', async () => {
    const capturedAt = await scrape()
    const now = capturedAt + 31 * 60_000
    expect(now - capturedAt).toBeGreaterThan(USAGE_FRESH_MS)
    expect(budgetGate(budgetReadings(now), now, DEFAULT_SWARM_BUDGET, standard)).toEqual({ allow: true, note: 'usage-unknown' })
  })
})

// THE ENGINE'S REQUEST IS A NEW READING (review 2026-11-28 B-S2). While a budget
// hold keeps every worker parked, no transcript is written, so the display cache
// is never invalidated: a request served from it produced nothing newer, the 85%
// reading went stale at 30 minutes, and the gate allowed a start above its
// ceiling. The engine's request therefore skips the display cache (still one
// scrape at a time); the HUD's own poll keeps using it.
describe("the engine's refresh bypasses the display cache", () => {
  it('a request 5 minutes after a scrape spawns a new one and the hold still stands at 30.5 minutes', async () => {
    vi.mocked(ptySpawn).mockClear()
    const first = await scrape()
    vi.setSystemTime(first + 5 * 60_000)
    expect(claimUsageRefresh(Date.now())).toBe(true)
    refreshUsageCacheDetached({ bypassCache: true })
    await vi.advanceTimersByTimeAsync(6_000)
    await flushUsageWindowsPersist()
    expect(ptySpawn).toHaveBeenCalledTimes(2)
    expect(budgetReadings(Date.now()).five_hour!.at).toBeGreaterThan(first)

    const now = first + 30.5 * 60_000
    expect(budgetGate(budgetReadings(now), now, DEFAULT_SWARM_BUDGET, standard)).toMatchObject({ allow: false, kind: 'window-headroom' })
  })

  it("the HUD's poll still answers from the cache (one scrape)", async () => {
    vi.mocked(ptySpawn).mockClear()
    const first = await scrape()
    vi.setSystemTime(first + 5 * 60_000)
    expect((await fetchClaudeUsageCli()).capturedAt).toBe(new Date(first).toISOString())
    expect(ptySpawn).toHaveBeenCalledOnce()
  })

  it('two engine requests at once share one scrape', async () => {
    vi.mocked(ptySpawn).mockClear()
    const a = fetchClaudeUsageCli({ bypassCache: true })
    const b = fetchClaudeUsageCli({ bypassCache: true })
    await vi.advanceTimersByTimeAsync(6_000)
    await Promise.all([a, b])
    expect(ptySpawn).toHaveBeenCalledOnce()
  })
})

// The scrape is free only in essential-traffic mode: an interactive subscriber
// session otherwise sends a billed 1-token "quota" request at startup (the CLI's
// startup prefetch, skipped when CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set).
describe('the scrape spawns claude in essential-traffic mode', () => {
  it('every scrape passes CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 and keeps the rest of the env', async () => {
    vi.mocked(ptySpawn).mockClear()
    await scrape()
    expect(ptySpawn).toHaveBeenCalledOnce()
    const env = (vi.mocked(ptySpawn).mock.calls[0][2] as { env: Record<string, string> }).env
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
    expect(env.PATH).toBe(process.env.PATH)
  })
})
