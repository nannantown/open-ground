import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFile, writeFile, rm, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
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
  clearCooling,
  coolingSnapshot,
  isModelTier,
  MAX_MANUAL_COOLING_MS,
  ensureCoolingTableLoaded,
  flushQuotaPersist,
  __resetQuotaForTest,
  __simulateRestartForTest,
} from './swarmQuota'
import { ensureOpenGroundHome, swarmQuotaFile } from './paths'

// A single FIXED injected clock — every function takes `now`, so nothing here
// touches the wall clock and each case is fully deterministic (Done ④). The
// cooling-table cases use absolute `until` values (markCoolingUntil) so they are
// timezone-independent.
const NOW = 1_700_000_000_000
const SEC = 1000
const MIN = 60_000
const HOUR = 3_600_000

/** `NOW` pinned to a LOCAL wall-clock hour — the bare-clock cases below must be
 *  built from this, never from the raw `NOW`.
 *
 *  `parseResetLabel`'s bare-clock branch resolves through `setHours`, i.e. in
 *  the RUNNER's timezone, so "is 3pm later than NOW?" has a different answer per
 *  timezone: `NOW` is 07:13 in Asia/Tokyo (3pm still ahead) but 22:13 in UTC
 *  (3pm long gone). While the branch rolled a passed clock forward a day the
 *  answer was always "a future time" and the difference stayed invisible — the
 *  2026-07-29 change to return null instead (a passed bare clock means the SCREEN
 *  IS STALE, see swarmQuota.ts) made it visible as 3 tests that were green on the
 *  author's machine and red on CI. The label was the TZ-dependent part all along,
 *  not the assertion.
 *
 *  Anchoring `now` to local noon removes the dependency for real: 3pm is two
 *  hours later and 9am two hours earlier IN EVERY TIMEZONE, because both sides of
 *  the comparison are now expressed in the same local frame. */
const atLocalHour = (hour: number): number => {
  const d = new Date(NOW)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}
const LOCAL_NOON = atLocalHour(12)

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

  it('a bare clock STILL AHEAD today ⇒ that time today (property — TZ-independent)', () => {
    // 3pm against local noon — ahead in every timezone (see LOCAL_NOON).
    const t = parseResetLabel('3pm', LOCAL_NOON)
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThan(LOCAL_NOON)
    expect(t!).toBeLessThanOrEqual(LOCAL_NOON + 24 * HOUR)
  })

  it('a bare clock ALREADY PASSED today ⇒ null (stale screen, NOT tomorrow)', () => {
    // The other half of the 2026-07-29 rule, and the half with no coverage before
    // (the old branch rolled forward a day, so this could not be observed). A
    // worker's PTY keeps showing "resets at 3pm" at 3:10pm — reading that as
    // tomorrow-3pm parked the tier for ~23h and mirrored the figure to disk.
    // null lets resolveCoolingUntil fall through to A5 / the flat grace instead.
    expect(parseResetLabel('9am', LOCAL_NOON)).toBeNull()
  })

  it('different clocks give different times', () => {
    // Both must be AHEAD of the injected clock, else one is null by the rule
    // above and this compares nothing: anchor at local midnight-plus-one so 3am
    // and 3pm are both still to come today, in every timezone.
    const earlyMorning = atLocalHour(1)
    const pm = parseResetLabel('3pm', earlyMorning)
    const am = parseResetLabel('3am', earlyMorning)
    expect(pm).not.toBeNull()
    expect(am).not.toBeNull()
    expect(pm).not.toBe(am)
  })

  it('absolute ISO ⇒ Date.parse (…but a date years out is refused as a misread)', () => {
    // 2026-08-04: a reset is DAYS away at most, so the parse now bounds the
    // horizon — believing a years-out label would park the tier for months
    // (the 2026-07-29 "20 minutes read as 23 hours" incident, amplified).
    expect(parseResetLabel('2030-01-01T15:00:00Z', NOW)).toBeNull()
    const soon = new Date(NOW + 3 * 24 * 60 * 60_000).toISOString()
    expect(parseResetLabel(soon, NOW)).toBe(Date.parse(soon))
  })

  it('A5 weekly form "May 25 at 3pm (Asia/Tokyo)" now PARSES (was null — the 20-minute misread)', () => {
    // This used to assert null and was green while production lost days-long
    // weekly limits to the 20-minute grace: Date.parse('May 25 3pm') is NaN and
    // a year-less date resolves to 2001 in V8. Both are handled now, so the
    // label resolves to a real future moment near `now`.
    const may20 = Date.parse('2026-05-20T02:00:00Z')
    const ms = parseResetLabel('May 25 at 3pm (Asia/Tokyo)', may20)
    expect(ms).not.toBeNull()
    expect(ms! - may20).toBeGreaterThan(3 * 24 * 60 * 60_000)
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
    // LOCAL_NOON, not NOW: this reaches parseResetLabel's bare-clock branch, so
    // it inherits the same timezone trap — see LOCAL_NOON's note.
    const t = extractPtyResetUntil(
      'Claude usage limit reached. Your limit resets at 3pm (Asia/Tokyo).',
      LOCAL_NOON,
    )
    expect(t).not.toBeNull()
    expect(t!).toBeGreaterThan(LOCAL_NOON)
    expect(t!).toBeLessThanOrEqual(LOCAL_NOON + 24 * HOUR)
  })

  it('a screen whose reset clock ALREADY PASSED reads as stale ⇒ null (falls through)', () => {
    // The engine re-parses the SAME unchanged frame every pass. Once its clock is
    // behind, the frame is evidence of nothing — the resolver must not turn it
    // into a ~23h park. (Companion to the parseResetLabel case above, asserted
    // here at the screen level because that is where the stale frame lives.)
    expect(
      extractPtyResetUntil('Claude usage limit reached. Your limit resets at 9am (Asia/Tokyo).', LOCAL_NOON),
    ).toBeNull()
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

// ── The MANUAL override surface (POST /api/swarm/quota/cool|uncool) ──────────
// Together these are what lets an operator steer a packaged app away from a dry
// tier without stopping the engine: SEE the table (coolingSnapshot), cool a tier
// (markCoolingUntil, already covered above), release one (clearCooling), and
// reject an alias that is not on the ladder (isModelTier).

describe('clearCooling — the operator releases a tier', () => {
  it('makes a cooling tier available again immediately', () => {
    markCoolingUntil('fable', NOW + HOUR)
    expect(highestAvailableTier(NOW)).toBe('opus')
    clearCooling('fable')
    expect(isTierCooling('fable', NOW)).toBe(false)
    expect(highestAvailableTier(NOW)).toBe('fable')
  })

  it('is idempotent on an already-available tier', () => {
    expect(() => clearCooling('haiku')).not.toThrow()
    clearCooling('haiku')
    expect(isTierCooling('haiku', NOW)).toBe(false)
  })

  it('touches ONLY the named tier', () => {
    markCoolingUntil('fable', NOW + HOUR)
    markCoolingUntil('opus', NOW + HOUR)
    clearCooling('fable')
    expect(isTierCooling('opus', NOW)).toBe(true)
  })
})

describe('coolingSnapshot — the whole ladder at one instant', () => {
  it('lists every tier best→cheapest, none cooling on a clean table', () => {
    expect(coolingSnapshot(NOW)).toEqual(
      MODEL_TIER_LADDER.map((tier) => ({ tier, cooling: false, until: null })),
    )
  })

  it('reports until only for a tier that is STILL cooling (lazy expiry)', () => {
    markCoolingUntil('fable', NOW + HOUR)
    markCoolingUntil('opus', NOW - MIN) // elapsed — reads as available
    const rows = coolingSnapshot(NOW)
    expect(rows.find((r) => r.tier === 'fable')).toEqual({
      tier: 'fable',
      cooling: true,
      until: NOW + HOUR,
    })
    // A stale mark must never look live — same rule isTierCooling applies.
    expect(rows.find((r) => r.tier === 'opus')).toEqual({ tier: 'opus', cooling: false, until: null })
  })

  it('is a pure read — snapshotting does not mutate the table', () => {
    markCoolingUntil('fable', NOW + HOUR)
    coolingSnapshot(NOW + 2 * HOUR) // past fable's until
    expect(isTierCooling('fable', NOW + MIN)).toBe(true) // still there, just expired later
  })
})

describe('isModelTier — the routes fail-closed on an unknown alias', () => {
  it('accepts exactly the ladder', () => {
    for (const tier of MODEL_TIER_LADDER) expect(isModelTier(tier)).toBe(true)
  })

  it('rejects anything else (never cool a tier by guess)', () => {
    expect(isModelTier('gpt-5')).toBe(false)
    expect(isModelTier('FABLE')).toBe(false) // case-sensitive: it is a CLI alias
    expect(isModelTier('')).toBe(false)
    expect(isModelTier(undefined)).toBe(false)
    expect(isModelTier(null)).toBe(false)
    expect(isModelTier(0)).toBe(false)
    expect(isModelTier(['fable'])).toBe(false)
  })
})

describe('MAX_MANUAL_COOLING_MS — a hand cool cannot retire a tier forever', () => {
  it('is one week — longer than any real reset window, short enough to self-heal', () => {
    expect(MAX_MANUAL_COOLING_MS).toBe(7 * 24 * HOUR)
    expect(MAX_MANUAL_COOLING_MS).toBeGreaterThan(DEFAULT_COOLING_GRACE_MS)
  })
})

// ── Persistence — the table survives a process restart ───────────────────────
//
// THE BUG THIS PINS (2026-07-13, 0.11.25): the cooling table was memory-only, so
// every restart forgot which tiers were dry — and a restart usually follows a
// release. The app then re-learned the fact the expensive way: dispatch on fable
// → limit screen → cool. One burned session, per restart, forever.
//
// These cases assert against the FILE, not the in-memory table. A mutation that
// silently skipped the mirror would still pass every read-API test above (the Map
// is right; only the disk is empty) — so proving "cooling:true" after a mutation
// proves nothing about persistence. Each write path here is therefore read BACK
// off disk, and the restart cases drop the whole globalThis table first.
//
// HOME is isolated suite-wide by src/test/setup-home.ts (OPENGROUND_HOME → a tmp
// dir), so nothing here touches the real ~/.openground; the first case re-proves
// that for this file specifically.
describe('persistence — the cooling table survives a process restart', () => {
  const seedQuotaFile = async (raw: string): Promise<void> => {
    await ensureOpenGroundHome()
    await writeFile(swarmQuotaFile(), raw, 'utf8')
  }
  const readQuotaFile = async (): Promise<{ cooling: Record<string, number> }> =>
    JSON.parse(await readFile(swarmQuotaFile(), 'utf8'))

  beforeEach(async () => {
    // Drain first, THEN delete. Earlier cases mutate without awaiting the mirror
    // (the production sensor path can't await either), so a save can still be in
    // flight; deleting ahead of it would let it land afterwards and resurrect a
    // file this case expects to be absent. __resetQuotaForTest keeps the chain
    // drainable precisely so this is possible.
    // `recursive`: the write-failure cases below make the path a DIRECTORY.
    await flushQuotaPersist()
    await rm(swarmQuotaFile(), { force: true, recursive: true })
  })
  afterEach(async () => {
    await flushQuotaPersist()
    await rm(swarmQuotaFile(), { force: true, recursive: true })
    vi.restoreAllMocks()
  })

  /** Make the mirror write FAIL, the way a real filesystem does. atomicWrite
   *  renames a temp file onto the target; renaming a file onto a DIRECTORY is
   *  EISDIR. Stands in for the EACCES / ENOSPC / read-only-volume family. */
  const breakTheFile = () => mkdir(swarmQuotaFile(), { recursive: true })

  it('writes ONLY under ~/.openground — never into the user’s repo', async () => {
    // The whole point of the app-home store: a scanned project's working tree
    // stays free of OPEN GROUND files. Under test, OPENGROUND_HOME is a tmp dir.
    expect(swarmQuotaFile()).toBe(`${process.env.OPENGROUND_HOME}/swarm-quota.json`)
    expect(swarmQuotaFile().startsWith(tmpdir())).toBe(true)
    expect(swarmQuotaFile()).not.toContain(process.cwd())
  })

  it('THE ACCEPTANCE: cool a tier → restart → it is STILL cooling', async () => {
    markCoolingUntil('haiku', NOW + HOUR)
    await flushQuotaPersist()

    await __simulateRestartForTest() // the globalThis table is gone; only the file remains
    expect(isTierCooling('haiku', NOW)).toBe(false) // …and until boot reads it, nothing is known

    await ensureCoolingTableLoaded(NOW) // ← boot
    expect(isTierCooling('haiku', NOW)).toBe(true)
    expect(coolingSnapshot(NOW).find((t) => t.tier === 'haiku')).toEqual({
      tier: 'haiku',
      cooling: true,
      until: NOW + HOUR,
    })
    // Only the cooled tier came back — the rest of the ladder stays available.
    expect(highestAvailableTier(NOW)).toBe('fable')
  })

  it('markCoolingUntil mirrors to disk (write → read BACK → equal)', async () => {
    markCoolingUntil('haiku', NOW + HOUR)
    await flushQuotaPersist()
    expect(await readQuotaFile()).toEqual({ cooling: { haiku: NOW + HOUR } })
  })

  it('markRateLimited mirrors the RESOLVED until to disk', async () => {
    const until = markRateLimited('sonnet', { ptyText: 'usage limit reached — resets in 45 minutes', now: NOW })
    await flushQuotaPersist()

    expect(until).toBe(NOW + 45 * MIN) // resolved from the PTY wording, not the flat grace
    expect(await readQuotaFile()).toEqual({ cooling: { sonnet: until } })

    // …and it is that resolved figure — not a fresh grace window — that boots back.
    await __simulateRestartForTest()
    await ensureCoolingTableLoaded(NOW)
    expect(coolingSnapshot(NOW).find((t) => t.tier === 'sonnet')?.until).toBe(NOW + 45 * MIN)
  })

  it('clearCooling mirrors the REMOVAL — an uncool survives the restart too', async () => {
    markCoolingUntil('haiku', NOW + HOUR)
    markCoolingUntil('sonnet', NOW + HOUR)
    await flushQuotaPersist()
    expect(await readQuotaFile()).toEqual({ cooling: { sonnet: NOW + HOUR, haiku: NOW + HOUR } })

    clearCooling('haiku')
    await flushQuotaPersist()
    expect(await readQuotaFile()).toEqual({ cooling: { sonnet: NOW + HOUR } }) // gone from disk

    // The released tier must NOT come back at boot — otherwise the owner's uncool
    // would be quietly undone by the very hydration that fixes the cooling side.
    await __simulateRestartForTest()
    await ensureCoolingTableLoaded(NOW)
    expect(isTierCooling('haiku', NOW)).toBe(false)
    expect(isTierCooling('sonnet', NOW)).toBe(true)
  })

  it('every write path lands on disk — none is a silent no-op', async () => {
    // The three mutations are the ONLY writes (swarmQuota's own contract). Walk
    // them one at a time and demand the disk agree after each: a fourth mutation
    // added later without a mirror would have to break this case to land.
    markCoolingUntil('haiku', NOW + HOUR)
    await flushQuotaPersist()
    expect((await readQuotaFile()).cooling).toEqual({ haiku: NOW + HOUR })

    const until = markRateLimited('opus', { graceMs: DEFAULT_COOLING_GRACE_MS, now: NOW })
    await flushQuotaPersist()
    expect((await readQuotaFile()).cooling).toEqual({ opus: until, haiku: NOW + HOUR })

    clearCooling('opus')
    await flushQuotaPersist()
    expect((await readQuotaFile()).cooling).toEqual({ haiku: NOW + HOUR })

    clearCooling('haiku')
    await flushQuotaPersist()
    expect((await readQuotaFile()).cooling).toEqual({})
  })

  it('drops marks that EXPIRED while the app was down (lazy expiry, same rule as isTierCooling)', async () => {
    await seedQuotaFile(
      JSON.stringify({ cooling: { fable: NOW - 1, opus: NOW, sonnet: NOW + HOUR } }),
    )
    await __simulateRestartForTest()
    await ensureCoolingTableLoaded(NOW)

    // `until <= now` reads as AVAILABLE everywhere else in this module; the boot
    // load must agree, or a week-old file would resurrect a long-dead cooling.
    expect(isTierCooling('fable', NOW)).toBe(false) // already past
    expect(isTierCooling('opus', NOW)).toBe(false) // exactly now ⇒ available
    expect(isTierCooling('sonnet', NOW)).toBe(true) // still in the future
    expect(highestAvailableTier(NOW)).toBe('fable')
    expect(coolingSnapshot(NOW).find((t) => t.tier === 'fable')?.until).toBeNull()
  })

  it('FAIL-SAFE: a corrupt file boots with NO cooling and ONE log line — it never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seedQuotaFile('{ this is not json')
    await __simulateRestartForTest()

    await expect(ensureCoolingTableLoaded(NOW)).resolves.toBeUndefined() // boot continues
    expect(MODEL_TIER_LADDER.every((t) => !isTierCooling(t, NOW))).toBe(true)
    expect(highestAvailableTier(NOW)).toBe('fable') // degrades to today's behaviour
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('[openground:swarm-quota]')
  })

  it('FAIL-SAFE: a WRONG-SHAPED file (valid JSON, no cooling map) is refused the same way', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await seedQuotaFile(JSON.stringify({ cooling: ['fable'] })) // array, not a map
    await __simulateRestartForTest()

    await expect(ensureCoolingTableLoaded(NOW)).resolves.toBeUndefined()
    expect(MODEL_TIER_LADDER.every((t) => !isTierCooling(t, NOW))).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('a MISSING file is the normal first boot — no cooling, and NO log noise', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await __simulateRestartForTest() // beforeEach already removed the file

    await ensureCoolingTableLoaded(NOW)
    expect(MODEL_TIER_LADDER.every((t) => !isTierCooling(t, NOW))).toBe(true)
    expect(warn).not.toHaveBeenCalled() // "never cooled yet" is not a fault
  })

  it('drops garbage ENTRIES but keeps the sound ones (never cool a tier by guess)', async () => {
    await seedQuotaFile(
      JSON.stringify({
        cooling: {
          'gpt-5': NOW + HOUR, // not on the ladder
          FABLE: NOW + HOUR, // ladder aliases are case-sensitive
          opus: 'soon', // not a number
          sonnet: null,
          haiku: NOW + HOUR, // ← the only sound entry
        },
      }),
    )
    await __simulateRestartForTest()
    await ensureCoolingTableLoaded(NOW)

    expect(isTierCooling('haiku', NOW)).toBe(true)
    expect(isTierCooling('fable', NOW)).toBe(false)
    expect(isTierCooling('opus', NOW)).toBe(false)
    expect(isTierCooling('sonnet', NOW)).toBe(false)
  })

  it('a LIVE mark wins over the disk — hydration never clobbers a fresher signal', async () => {
    await seedQuotaFile(JSON.stringify({ cooling: { haiku: NOW + 5 * MIN } }))
    await __simulateRestartForTest()

    // Production shape: boot kicks the load, and a sighting lands while it is
    // still in flight (the engine is already up).
    const booting = ensureCoolingTableLoaded(NOW)
    markCoolingUntil('haiku', NOW + HOUR)
    await booting

    expect(coolingSnapshot(NOW).find((t) => t.tier === 'haiku')?.until).toBe(NOW + HOUR)
  })

  // ── The mirror must not LIE about durability ──────────────────────────────
  // A failed write used to be swallowed whole: the persist chain caught it, and
  // flushQuotaPersist returned that already-caught chain, so it could never
  // reject — and POST /cool answered 200 ("it is on disk") for a mark that lived
  // only in memory and died at the next restart. That is the very loop this module
  // exists to close, reopened by a 200 that lies.

  it('a FAILED mirror write is REPORTED, not swallowed', async () => {
    await breakTheFile()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    markCoolingUntil('haiku', NOW + HOUR)
    const flushed = await flushQuotaPersist()

    expect(flushed.persisted).toBe(false)
    expect(flushed.error).toBeTruthy()
    // …while the mark still STANDS in memory: a cache file that won't write must
    // not un-cool a tier the running engine is meant to avoid (fail-safe), and it
    // must not take the cockpit down either. Only durability was lost.
    expect(isTierCooling('haiku', NOW)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('FORGOTTEN on restart')
  })

  it('a mirror write that lands afterwards CLEARS the failure (the file is whole again)', async () => {
    await breakTheFile()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    markCoolingUntil('haiku', NOW + HOUR)
    expect((await flushQuotaPersist()).persisted).toBe(false)

    // Every write mirrors the WHOLE table, so one success makes the file current —
    // the earlier failure is moot, and the flush must stop reporting it.
    await rm(swarmQuotaFile(), { force: true, recursive: true })
    markCoolingUntil('sonnet', NOW + HOUR)
    expect(await flushQuotaPersist()).toEqual({ persisted: true, error: null })
    expect(await readQuotaFile()).toEqual({
      cooling: { sonnet: NOW + HOUR, haiku: NOW + HOUR }, // …including the mark the failed write lost
    })
  })

  // ── Ordering: a mutation that beats the boot load ─────────────────────────
  // Unreachable through today's callers (boot kicks the load before the server can
  // dispatch, and all three quota routes await it before mutating) — these pin the
  // module so it stays sound for the NEXT caller, which is what a structural
  // guarantee means.

  it('a mutation that beats the boot load does not CLOBBER the file (rule 1)', async () => {
    await seedQuotaFile(JSON.stringify({ cooling: { sonnet: NOW + HOUR } }))
    await __simulateRestartForTest() // nothing has read the disk…

    markCoolingUntil('haiku', NOW + HOUR) // …and nobody kicked ensureCoolingTableLoaded
    await flushQuotaPersist()

    // The write serialises the WHOLE table, so without the load it would have
    // written {haiku} over {sonnet} and silently dropped a cooling tier.
    expect(await readQuotaFile()).toEqual({ cooling: { sonnet: NOW + HOUR, haiku: NOW + HOUR } })
    expect(isTierCooling('sonnet', NOW)).toBe(true)
  })

  it('an uncool that beats the boot load is NOT resurrected by it (rule 2)', async () => {
    await seedQuotaFile(JSON.stringify({ cooling: { sonnet: NOW + HOUR, haiku: NOW + HOUR } }))
    await __simulateRestartForTest()

    clearCooling('sonnet') // released before ANYTHING has read the disk
    await flushQuotaPersist()

    // The load that the write itself had to trigger must leave `sonnet` alone. A
    // plain "in-memory wins" merge would NOT: a released tier is simply absent
    // from the map, which is indistinguishable from "never had it", so the load
    // would read the mark straight back in and the owner's uncool would be undone
    // — in memory AND on disk.
    expect(isTierCooling('sonnet', NOW)).toBe(false)
    expect(await readQuotaFile()).toEqual({ cooling: { haiku: NOW + HOUR } })

    await ensureCoolingTableLoaded(NOW)
    expect(isTierCooling('sonnet', NOW)).toBe(false)
    expect(isTierCooling('haiku', NOW)).toBe(true) // the untouched tier still loads
  })

  it('hydration is memoized — the file is read ONCE per process', async () => {
    await seedQuotaFile(JSON.stringify({ cooling: { haiku: NOW + HOUR } }))
    await __simulateRestartForTest()
    await ensureCoolingTableLoaded(NOW)
    expect(isTierCooling('haiku', NOW)).toBe(true)

    // Release it, then ask again: a second read would faithfully re-hydrate the
    // (still-present) file and undo the uncool. Every quota route awaits this, so
    // it is called constantly — it must be a no-op after the first.
    clearCooling('haiku')
    await flushQuotaPersist()
    await seedQuotaFile(JSON.stringify({ cooling: { haiku: NOW + HOUR } })) // even if the file says otherwise
    await ensureCoolingTableLoaded(NOW)
    expect(isTierCooling('haiku', NOW)).toBe(false)
  })

  it('a mutation racing the boot read still lands BOTH marks on disk', async () => {
    // The ordering rule inside schedulePersist: a save waits for the load. Without
    // it, this mutation would serialise a table that had not yet absorbed the
    // file's `sonnet`, and the mirror write would silently drop that tier.
    await seedQuotaFile(JSON.stringify({ cooling: { sonnet: NOW + HOUR } }))
    await __simulateRestartForTest()

    const booting = ensureCoolingTableLoaded(NOW) // in flight — deliberately not awaited
    markCoolingUntil('haiku', NOW + HOUR) // …a sighting cuts in
    await booting
    await flushQuotaPersist()

    expect(await readQuotaFile()).toEqual({
      cooling: { sonnet: NOW + HOUR, haiku: NOW + HOUR },
    })
  })
})

// ── A re-read of the SAME screen must not push the deadline later (0729) ────
// Every pass re-resolves from the worker's CURRENT screen, and a bare clock
// label ("resets at 3pm") is re-interpreted against the clock each time —
// parseResetLabel's rule being "if that time already passed today, it means
// tomorrow". The same unchanged screen therefore yields 20 minutes at 14:40 and
// ~23 HOURS at 15:10. That figure is mirrored to disk, so the tier stays parked
// for a day across restarts and the engine looks like it just stopped
// dispatching, with nothing in any log saying why.
describe('markRateLimited — an existing deadline is never pushed LATER', () => {
  const at = (h: number, m: number) => {
    const d = new Date(1_700_000_000_000)
    d.setHours(h, m, 0, 0)
    return d.getTime()
  }

  it('keeps the earlier deadline when the same bare-clock screen is re-read', () => {
    __resetQuotaForTest()
    const screen = 'usage limit reached — resets at 3pm'
    const first = markRateLimited('sonnet', { ptyText: screen, now: at(14, 40) })
    expect(first - at(14, 40)).toBeLessThanOrEqual(25 * 60_000) // ~20 min

    // 15:10 — 3pm has passed, so a fresh parse rolls to TOMORROW 3pm (~23h).
    const second = markRateLimited('sonnet', { ptyText: screen, now: at(15, 10) })
    // The stale clock is DISCARDED (not rolled to tomorrow), so the resolver
    // falls through to the flat grace — a short, self-correcting wait.
    // Pre-fix `second` was ~23h out and the tier was parked for the day.
    expect(second - at(15, 10)).toBeLessThan(60 * 60_000)
    expect(second).toBeGreaterThan(at(15, 10))
  })

  it('an ELAPSED mark is replaced, so a genuine second rate-limit still cools', () => {
    __resetQuotaForTest()
    const first = markRateLimited('haiku', { ptyText: 'resets in 5 minutes', now: at(10, 0) })
    // An hour later the first window is long gone; a NEW limit must take effect.
    const second = markRateLimited('haiku', { ptyText: 'resets in 30 minutes', now: at(11, 0) })
    expect(second).toBeGreaterThan(first)
    expect(isTierCooling('haiku', at(11, 5))).toBe(true)
  })

  it('a LEGITIMATE multi-day horizon (weekly reset) is not truncated', () => {
    __resetQuotaForTest()
    const now = at(9, 0)
    const weekly = new Date(now + 5 * 24 * 60 * 60_000).toISOString()
    const until = markRateLimited('fable', { a5ResetsAt: weekly, now })
    // Weekly windows are days out — clamping these to 24h (an earlier attempt at
    // this fix) silently told the engine a dry tier was ready.
    expect(until - now).toBeGreaterThan(4 * 24 * 60 * 60_000)
  })
})
