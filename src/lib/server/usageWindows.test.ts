// The window store (AUTONOMY-SPEC R-D2 design / R-C1 (1)): what one SDK
// `rate_limit_event` leaves behind per window, the /usage fallback, the reset
// instant a refusal is cooled until, and that it all survives a restart.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFile, rm } from 'fs/promises'
import {
  applyRateLimitEvent,
  budgetReadings,
  rejectedUntil,
  recordRateLimitEvent,
  recordUsageScrape,
  claimUsageRefresh,
  usageWindowsSnapshot,
  ensureUsageWindowsLoaded,
  flushUsageWindowsPersist,
  usageWindowsFile,
  __resetUsageWindowsForTest,
  __simulateUsageWindowsRestartForTest,
} from './usageWindows'
import { USAGE_FRESH_MS, USAGE_REFRESH_AFTER_MS, USAGE_REFRESH_BACKOFF_MS, USAGE_REFRESH_BACKOFF_MAX_MS } from './swarmBudget'
import type { CliUsage } from './claudeUsageCli'
import { ensureOpenGroundHome } from './paths'

const NOW = Date.parse('2026-11-28T12:00:00Z')
const HOUR = 3_600_000
const sec = (ms: number) => Math.round(ms / 1000)
const ev = (over: Partial<{ status: string; utilization: number | null; resetsAt: number | null; limitType: string }>) => ({
  kind: 'rate_limit' as const,
  status: 'allowed',
  utilization: null,
  resetsAt: sec(NOW + 2 * HOUR),
  limitType: 'five_hour',
  ...over,
})

beforeEach(async () => {
  __resetUsageWindowsForTest()
  await rm(usageWindowsFile(), { force: true })
})
afterEach(async () => {
  await flushUsageWindowsPersist()
  __resetUsageWindowsForTest()
  await rm(usageWindowsFile(), { force: true })
})

describe('applyRateLimitEvent — one event, one window', () => {
  it('stores utilization (a 0–1 fraction) as 0–100 and resetsAt (epoch seconds) as ms', () => {
    const w = applyRateLimitEvent({}, ev({ status: 'allowed_warning', utilization: 0.55, limitType: 'seven_day' }), NOW)
    expect(w.seven_day).toEqual({ usedPct: 55, resetsAt: sec(NOW + 2 * HOUR) * 1000, at: NOW, status: 'allowed_warning' })
  })

  it('a rejection without utilization is a spent window', () => {
    const w = applyRateLimitEvent({}, ev({ status: 'rejected' }), NOW)
    expect(w.five_hour).toMatchObject({ usedPct: 100, status: 'rejected', at: NOW })
  })

  it('a status-only event in the SAME window keeps the last measured share and its age', () => {
    const a = applyRateLimitEvent({}, ev({ status: 'allowed_warning', utilization: 0.9 }), NOW)
    const b = applyRateLimitEvent(a, ev({ status: 'allowed' }), NOW + 10 * 60_000)
    expect(b.five_hour).toMatchObject({ usedPct: 90, at: NOW, status: 'allowed' })
    // …but a new window (a different reset) starts unknown.
    const c = applyRateLimitEvent(a, ev({ status: 'allowed', resetsAt: sec(NOW + 6 * HOUR) }), NOW + 10 * 60_000)
    expect(c.five_hour).toMatchObject({ usedPct: null, status: 'allowed' })
  })

  it('an event naming no window changes nothing', () => {
    expect(applyRateLimitEvent({}, ev({ limitType: 'unknown', utilization: 0.9 }), NOW)).toEqual({})
  })
})

describe('rejectedUntil — the reset a refusal is cooled until', () => {
  it('a fresh rejection answers its reset; stale or past answers nothing', () => {
    recordRateLimitEvent(ev({ status: 'rejected', resetsAt: sec(NOW + 3 * 24 * HOUR), limitType: 'seven_day' }), NOW)
    expect(rejectedUntil(NOW + 1)).toBe(sec(NOW + 3 * 24 * HOUR) * 1000)
    expect(rejectedUntil(NOW + USAGE_FRESH_MS)).toBeNull()
    __resetUsageWindowsForTest()
    recordRateLimitEvent(ev({ status: 'rejected', resetsAt: sec(NOW) }), NOW)
    expect(rejectedUntil(NOW)).toBeNull()
  })

  it('a per-model week binds only its own tier (review 2026-11-28 B-M1)', () => {
    recordRateLimitEvent(ev({ status: 'rejected', resetsAt: sec(NOW + 96 * HOUR), limitType: 'seven_day_opus' }), NOW)
    recordRateLimitEvent(ev({ status: 'rejected', resetsAt: sec(NOW + 2 * HOUR), limitType: 'five_hour' }), NOW)
    expect(rejectedUntil(NOW + 1)).toBe(sec(NOW + 2 * HOUR) * 1000)
    expect(rejectedUntil(NOW + 1, 'sonnet')).toBe(sec(NOW + 2 * HOUR) * 1000)
    expect(rejectedUntil(NOW + 1, 'opus')).toBe(sec(NOW + 96 * HOUR) * 1000)
  })

  it('the per-model weeks map to their tiers: Fable is seven_day_overage_included (CLI "Fable 5 limit")', () => {
    recordRateLimitEvent(ev({ status: 'rejected', resetsAt: sec(NOW + 30 * HOUR), limitType: 'seven_day_overage_included' }), NOW)
    recordRateLimitEvent(ev({ status: 'rejected', resetsAt: sec(NOW + 40 * HOUR), limitType: 'seven_day_sonnet' }), NOW)
    expect(rejectedUntil(NOW + 1, 'fable')).toBe(sec(NOW + 30 * HOUR) * 1000)
    expect(rejectedUntil(NOW + 1, 'sonnet')).toBe(sec(NOW + 40 * HOUR) * 1000)
    expect(rejectedUntil(NOW + 1, 'opus')).toBeNull()
    expect(rejectedUntil(NOW + 1, 'haiku')).toBeNull()
    expect(rejectedUntil(NOW + 1)).toBeNull()
  })

  it('two walls: the later reset, because both must lift', () => {
    recordRateLimitEvent(ev({ status: 'rejected', resetsAt: sec(NOW + 2 * HOUR) }), NOW)
    recordRateLimitEvent(ev({ status: 'rejected', resetsAt: sec(NOW + 50 * HOUR), limitType: 'seven_day' }), NOW)
    expect(rejectedUntil(NOW + 1)).toBe(sec(NOW + 50 * HOUR) * 1000)
  })

  it('an allowed window is not a wall', () => {
    recordRateLimitEvent(ev({ status: 'allowed_warning', utilization: 0.95 }), NOW)
    expect(rejectedUntil(NOW + 1)).toBeNull()
  })
})

describe('budgetReadings — the structured event first, the recorded /usage scrape second', () => {
  const usage = (capturedAt: string | undefined): CliUsage =>
    ({
      session: { pct: 85, resetsAt: 'in 2 hours' },
      weekAll: { pct: 40, resetsAt: 'Dec 1 at 3pm (UTC)' },
      weekModels: [],
      status: 'ok',
      ...(capturedAt ? { capturedAt } : {}),
    }) as CliUsage

  it('a recorded scrape is a reading at its capture time, its reset read relative to that instant', () => {
    const at = NOW - 5 * 60_000
    recordUsageScrape(usage(new Date(at).toISOString()))
    const r = budgetReadings(NOW)
    expect(r.five_hour).toMatchObject({ usedPct: 85, at, resetsAt: at + 2 * HOUR, source: 'usage' })
    expect(r.seven_day).toMatchObject({ usedPct: 40, at, resetsAt: Date.parse('2026-12-01T15:00:00Z'), source: 'usage' })
  })

  it('a fresh event beats the scrape; a stale one does not', () => {
    recordRateLimitEvent(ev({ status: 'allowed_warning', utilization: 0.91 }), NOW)
    recordUsageScrape(usage(new Date(NOW + 60_000).toISOString()))
    expect(budgetReadings(NOW + 2 * 60_000).five_hour).toMatchObject({ usedPct: 91, source: 'event' })
    expect(budgetReadings(NOW + USAGE_FRESH_MS).five_hour).toMatchObject({ usedPct: 85, source: 'usage' })
  })

  it('a bare clock already past at capture is tomorrow: the scrape is fresh text (review B-N2)', () => {
    // "Resets 2:50am" read at 22:00 is the 5-hour reset after midnight, not stale
    // text; read as stale it became null and the hold lifted at capture + 30 min.
    const at = new Date(2026, 10, 28, 22, 0, 0).getTime()
    recordUsageScrape({ ...usage(new Date(at).toISOString()), session: { pct: 85, resetsAt: '2:50am' } } as CliUsage)
    expect(budgetReadings(at + 60_000).five_hour?.resetsAt).toBe(new Date(2026, 10, 29, 2, 50, 0).getTime())
  })

  it('a scrape with no capture time, or no scrape, is no reading', () => {
    recordUsageScrape(usage(undefined))
    expect(budgetReadings(NOW)).toEqual({})
  })
})

describe('persisted beside the cooling table — survives a restart', () => {
  it('a recorded window is read back after the process restarts', async () => {
    recordRateLimitEvent(ev({ status: 'rejected', resetsAt: sec(NOW + 2 * HOUR) }), NOW)
    await __simulateUsageWindowsRestartForTest()
    expect(usageWindowsSnapshot()).toEqual({})
    await ensureUsageWindowsLoaded()
    expect(usageWindowsSnapshot().five_hour).toMatchObject({ usedPct: 100, status: 'rejected', at: NOW })
    expect(rejectedUntil(NOW + 1)).toBe(sec(NOW + 2 * HOUR) * 1000)
  })

  it('a recorded scrape is read back after a restart too', async () => {
    recordUsageScrape({
      session: { pct: 70, resetsAt: 'in 2 hours' },
      weekAll: null,
      weekModels: [],
      status: 'ok',
      capturedAt: new Date(NOW).toISOString(),
    } as CliUsage)
    await __simulateUsageWindowsRestartForTest()
    expect(budgetReadings(NOW + 1)).toEqual({})
    await ensureUsageWindowsLoaded()
    expect(budgetReadings(NOW + 1).five_hour).toMatchObject({ usedPct: 70, at: NOW, source: 'usage' })
  })

  it('a live reading is not overwritten by an older one on disk', async () => {
    recordRateLimitEvent(ev({ status: 'allowed_warning', utilization: 0.5 }), NOW)
    await __simulateUsageWindowsRestartForTest()
    recordRateLimitEvent(ev({ status: 'allowed_warning', utilization: 0.7 }), NOW + 60_000)
    await ensureUsageWindowsLoaded()
    expect(usageWindowsSnapshot().five_hour).toMatchObject({ usedPct: 70 })
  })

  it('a corrupt file boots empty and does not throw', async () => {
    await __simulateUsageWindowsRestartForTest()
    await ensureOpenGroundHome()
    await writeFile(usageWindowsFile(), '{not json')
    await ensureUsageWindowsLoaded()
    expect(usageWindowsSnapshot()).toEqual({})
  })
})

describe('claimUsageRefresh — when the engine may ask for a /usage scrape', () => {
  const scrapeAt = (at: number) =>
    recordUsageScrape({ session: { pct: 40, resetsAt: 'in 2 hours' }, weekAll: null, weekModels: [], status: 'ok', capturedAt: new Date(at).toISOString() } as CliUsage)

  it('a reading younger than USAGE_REFRESH_AFTER_MS needs no scrape', () => {
    scrapeAt(NOW)
    expect(claimUsageRefresh(NOW + USAGE_REFRESH_AFTER_MS - 1)).toBe(false)
    expect(claimUsageRefresh(NOW + USAGE_REFRESH_AFTER_MS)).toBe(true)
  })

  it('no reading: one claim per backoff period, and the period doubles while no reading arrives (capped)', () => {
    expect(claimUsageRefresh(NOW)).toBe(true)
    expect(claimUsageRefresh(NOW + 3_000)).toBe(false)
    expect(claimUsageRefresh(NOW + USAGE_REFRESH_BACKOFF_MS - 1)).toBe(false)
    expect(claimUsageRefresh(NOW + USAGE_REFRESH_BACKOFF_MS)).toBe(true) // the first produced nothing ⇒ back off 2×
    const t2 = NOW + USAGE_REFRESH_BACKOFF_MS
    expect(claimUsageRefresh(t2 + 2 * USAGE_REFRESH_BACKOFF_MS - 1)).toBe(false)
    expect(claimUsageRefresh(t2 + 2 * USAGE_REFRESH_BACKOFF_MS)).toBe(true)
    let t = t2 + 2 * USAGE_REFRESH_BACKOFF_MS
    for (let i = 0; i < 6; i++) {
      t += USAGE_REFRESH_BACKOFF_MAX_MS
      expect(claimUsageRefresh(t)).toBe(true) // never longer than the cap
      expect(claimUsageRefresh(t + 1)).toBe(false)
    }
  })

  it('a scrape that lands resets the backoff', () => {
    expect(claimUsageRefresh(NOW)).toBe(true)
    expect(claimUsageRefresh(NOW + USAGE_REFRESH_BACKOFF_MS)).toBe(true) // failure #1 ⇒ next gap 2×
    scrapeAt(NOW + USAGE_REFRESH_BACKOFF_MS + 10_000) // …then the scrape lands
    const t = NOW + USAGE_REFRESH_BACKOFF_MS + 10_000 + USAGE_REFRESH_AFTER_MS
    expect(claimUsageRefresh(t)).toBe(true)
    expect(claimUsageRefresh(t + USAGE_REFRESH_BACKOFF_MS)).toBe(true) // base gap again, not 2× or 4×
  })
})
