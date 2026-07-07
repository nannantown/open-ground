import { describe, it, expect, beforeEach } from 'vitest'
import {
  MODEL_TIER_LADDER,
  DEFAULT_COOLING_GRACE_MS,
  parseResetLabel,
  extractPtyResetUntil,
  resolveCoolingUntil,
  markCoolingUntil,
  markRateLimited,
  isTierCooling,
  highestAvailableTier,
  allCoolingUntil,
  __resetQuotaForTest,
} from './swarmQuota'

// A single FIXED injected clock — every function takes `now`, so nothing here
// touches the wall clock and each case is fully deterministic (Done ④). The
// cooling-table cases use absolute `until` values (markCoolingUntil) so they are
// timezone-independent; only the bare-clock label parsing is asserted by
// PROPERTY (>= now, within 24h) since setHours resolves in local time.
const NOW = 1_700_000_000_000
const SEC = 1000
const MIN = 60_000
const HOUR = 3_600_000

// The cooling table lives on globalThis (shared across the process), so reset it
// between cases to stay order-independent.
beforeEach(() => __resetQuotaForTest())

describe('MODEL_TIER_LADDER', () => {
  it('is fable → opus → sonnet → haiku (all four CLI-verified, none dropped)', () => {
    expect([...MODEL_TIER_LADDER]).toEqual(['fable', 'opus', 'sonnet', 'haiku'])
  })

  it('DEFAULT_COOLING_GRACE_MS matches the engine RATE_LIMIT_GRACE_MS default (20 min)', () => {
    expect(DEFAULT_COOLING_GRACE_MS).toBe(20 * MIN)
  })
})

describe('highestAvailableTier — cooling drops down the ladder (Done ①)', () => {
  it('returns the top tier when nothing is cooling', () => {
    expect(highestAvailableTier(NOW)).toBe('fable')
  })

  it('fable cooling ⇒ opus', () => {
    markCoolingUntil('fable', NOW + HOUR)
    expect(highestAvailableTier(NOW)).toBe('opus')
  })

  it('fable + opus cooling ⇒ sonnet', () => {
    markCoolingUntil('fable', NOW + HOUR)
    markCoolingUntil('opus', NOW + HOUR)
    expect(highestAvailableTier(NOW)).toBe('sonnet')
  })

  it('fable + opus + sonnet cooling ⇒ haiku (last rung)', () => {
    markCoolingUntil('fable', NOW + HOUR)
    markCoolingUntil('opus', NOW + HOUR)
    markCoolingUntil('sonnet', NOW + HOUR)
    expect(highestAvailableTier(NOW)).toBe('haiku')
  })

  it('all four cooling ⇒ null', () => {
    for (const tier of MODEL_TIER_LADDER) markCoolingUntil(tier, NOW + HOUR)
    expect(highestAvailableTier(NOW)).toBeNull()
  })
})

describe('auto-recovery when until passes (Done ②) — lazy expiry, no timer', () => {
  it('a tier is cooling only while now < until, available at/after it', () => {
    markCoolingUntil('fable', NOW + 10 * MIN)

    expect(highestAvailableTier(NOW)).toBe('opus') // fable cooling
    expect(highestAvailableTier(NOW + 5 * MIN)).toBe('opus') // still cooling
    expect(highestAvailableTier(NOW + 10 * MIN)).toBe('fable') // boundary: until<=now ⇒ available
    expect(highestAvailableTier(NOW + 20 * MIN)).toBe('fable') // long past reset
  })

  it('isTierCooling flips exactly at until', () => {
    markCoolingUntil('opus', NOW + 10 * MIN)
    expect(isTierCooling('opus', NOW + 10 * MIN - 1)).toBe(true)
    expect(isTierCooling('opus', NOW + 10 * MIN)).toBe(false)
    expect(isTierCooling('opus', NOW)).toBe(true)
    expect(isTierCooling('sonnet', NOW)).toBe(false) // never marked
  })
})

describe('allCoolingUntil — earliest reset iff every tier is cooling (Done ③)', () => {
  it('returns null when nothing is cooling (all available)', () => {
    expect(allCoolingUntil(NOW)).toBeNull()
  })

  it('returns null when even one tier is available', () => {
    markCoolingUntil('fable', NOW + HOUR) // opus/sonnet/haiku still free
    expect(allCoolingUntil(NOW)).toBeNull()
  })

  it('returns the earliest until when all four are cooling', () => {
    markCoolingUntil('fable', NOW + 5 * MIN)
    markCoolingUntil('opus', NOW + 3 * MIN) // earliest
    markCoolingUntil('sonnet', NOW + 8 * MIN)
    markCoolingUntil('haiku', NOW + 4 * MIN)
    expect(allCoolingUntil(NOW)).toBe(NOW + 3 * MIN)
  })

  it('drops back to null once the soonest tier resets (its until elapses)', () => {
    markCoolingUntil('fable', NOW + 5 * MIN)
    markCoolingUntil('opus', NOW + 3 * MIN)
    markCoolingUntil('sonnet', NOW + 8 * MIN)
    markCoolingUntil('haiku', NOW + 4 * MIN)
    // At NOW+3min the opus reset has arrived ⇒ a tier is available ⇒ no global wait.
    expect(allCoolingUntil(NOW + 3 * MIN)).toBeNull()
  })
})

describe('PURE — same clock ⇒ same result, state only moves with now (Done ④)', () => {
  it('repeated calls with the same now are identical (no wall-clock drift)', () => {
    markCoolingUntil('fable', NOW + 10 * MIN)
    expect(highestAvailableTier(NOW)).toBe(highestAvailableTier(NOW))
    expect(allCoolingUntil(NOW)).toBe(allCoolingUntil(NOW))
  })

  it('parseResetLabel is deterministic for a fixed now', () => {
    expect(parseResetLabel('in 30s', NOW)).toBe(parseResetLabel('in 30s', NOW))
  })
})

describe('parseResetLabel — relative / bare-clock / absolute, clock injected', () => {
  it('null / empty ⇒ null', () => {
    expect(parseResetLabel(null, NOW)).toBeNull()
    expect(parseResetLabel(undefined, NOW)).toBeNull()
    expect(parseResetLabel('   ', NOW)).toBeNull()
  })

  it('relative "in N unit" ⇒ now + delta', () => {
    expect(parseResetLabel('in 30s', NOW)).toBe(NOW + 30 * SEC)
    expect(parseResetLabel('in 45 minutes', NOW)).toBe(NOW + 45 * MIN)
    expect(parseResetLabel('in 2 hours', NOW)).toBe(NOW + 2 * HOUR)
  })

  it('bare clock ⇒ a future time within 24h (property — TZ-independent)', () => {
    const t = parseResetLabel('3pm', NOW)
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThan(NOW)
    expect(t!).toBeLessThanOrEqual(NOW + 24 * HOUR)
  })

  it('different clocks give different times', () => {
    expect(parseResetLabel('3pm', NOW)).not.toBe(parseResetLabel('3am', NOW))
  })

  it('absolute ISO ⇒ Date.parse', () => {
    expect(parseResetLabel('2030-01-01T15:00:00Z', NOW)).toBe(Date.parse('2030-01-01T15:00:00Z'))
  })

  it('A5 weekly form "May 25 at 3pm (Asia/Tokyo)" ⇒ null (Node cannot parse it; caller falls back to grace)', () => {
    // Documents the best-effort limit: Date.parse('May 25 3pm') is NaN. The
    // resolveCoolingUntil chain then uses PTY/grace instead — never throws.
    expect(parseResetLabel('May 25 at 3pm (Asia/Tokyo)', NOW)).toBeNull()
  })

  it('unparseable garbage ⇒ null', () => {
    expect(parseResetLabel('soon', NOW)).toBeNull()
  })
})

describe('extractPtyResetUntil — pull a reset time out of a claude screen', () => {
  it('null / no reset info ⇒ null', () => {
    expect(extractPtyResetUntil(null, NOW)).toBeNull()
    expect(extractPtyResetUntil('just some worker output', NOW)).toBeNull()
  })

  it('relative "retrying in 30s" ⇒ now + 30s', () => {
    expect(extractPtyResetUntil('API overloaded, retrying in 30s', NOW)).toBe(NOW + 30 * SEC)
  })

  it('relative "limit resets in 5 minutes" ⇒ now + 5min', () => {
    expect(extractPtyResetUntil('usage limit reached; limit resets in 5 minutes', NOW)).toBe(
      NOW + 5 * MIN,
    )
  })

  it('absolute "limit resets at 3pm (Asia/Tokyo)." ⇒ future within 24h', () => {
    const t = extractPtyResetUntil(
      'Claude usage limit reached. Your limit resets at 3pm (Asia/Tokyo).',
      NOW,
    )
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThan(NOW)
    expect(t!).toBeLessThanOrEqual(NOW + 24 * HOUR)
  })
})

describe('resolveCoolingUntil — PTY → A5 → grace priority (clock injected)', () => {
  it('PTY wording wins over A5', () => {
    expect(
      resolveCoolingUntil({ ptyText: 'limit resets in 30s', a5ResetsAt: 'in 10 minutes', now: NOW }),
    ).toBe(NOW + 30 * SEC)
  })

  it('A5 resetsAt used when the PTY has no reset time', () => {
    expect(
      resolveCoolingUntil({ ptyText: 'usage limit reached', a5ResetsAt: 'in 10 minutes', now: NOW }),
    ).toBe(NOW + 10 * MIN)
  })

  it('grace fallback when neither PTY nor A5 yields a time', () => {
    expect(resolveCoolingUntil({ now: NOW })).toBe(NOW + DEFAULT_COOLING_GRACE_MS)
    expect(resolveCoolingUntil({ ptyText: 'usage limit reached', a5ResetsAt: null, now: NOW })).toBe(
      NOW + DEFAULT_COOLING_GRACE_MS,
    )
  })

  it('explicit graceMs overrides the default', () => {
    expect(resolveCoolingUntil({ graceMs: 7 * MIN, now: NOW })).toBe(NOW + 7 * MIN)
  })

  it('a reset time already in the past is ignored and falls through', () => {
    // Past PTY time ⇒ skip; A5 also past ⇒ skip; land on grace.
    expect(
      resolveCoolingUntil({
        ptyText: 'limit resets at 2020-01-01T00:00:00Z',
        a5ResetsAt: '2019-01-01T00:00:00Z',
        graceMs: 7 * MIN,
        now: NOW,
      }),
    ).toBe(NOW + 7 * MIN)
  })
})

describe('markRateLimited — marks the tier and cascade emerges (Done ①, engine flow)', () => {
  it('marks a tier cooling via grace and returns the chosen until', () => {
    const until = markRateLimited('fable', { ptyText: 'usage limit reached', now: NOW })
    expect(until).toBe(NOW + DEFAULT_COOLING_GRACE_MS)
    expect(isTierCooling('fable', NOW)).toBe(true)
    expect(highestAvailableTier(NOW)).toBe('opus')
  })

  it('uses the PTY reset time when present, and recovers when it passes', () => {
    const until = markRateLimited('fable', { ptyText: 'limit resets in 15 minutes', now: NOW })
    expect(until).toBe(NOW + 15 * MIN)
    expect(highestAvailableTier(NOW)).toBe('opus')
    expect(highestAvailableTier(NOW + 15 * MIN)).toBe('fable') // reset arrived
  })

  it('cascade: successive rate-limits propagate downward, then a global wait', () => {
    markRateLimited('fable', { ptyText: 'usage limit reached', now: NOW })
    expect(highestAvailableTier(NOW)).toBe('opus')

    markRateLimited('opus', { now: NOW }) // dropped-to tier ALSO limited
    expect(highestAvailableTier(NOW)).toBe('sonnet')

    markRateLimited('sonnet', { now: NOW })
    expect(highestAvailableTier(NOW)).toBe('haiku')

    markRateLimited('haiku', { now: NOW })
    expect(highestAvailableTier(NOW)).toBeNull()
    // Every tier grace-cooled to the same until ⇒ that is the global reset.
    expect(allCoolingUntil(NOW)).toBe(NOW + DEFAULT_COOLING_GRACE_MS)
  })
})

describe('markCoolingUntil — newest signal wins', () => {
  it('a later mark overwrites an earlier until for the same tier', () => {
    markCoolingUntil('opus', NOW + 5 * MIN)
    markCoolingUntil('opus', NOW + 20 * MIN)
    expect(isTierCooling('opus', NOW + 10 * MIN)).toBe(true) // uses the 20-min until
  })
})
