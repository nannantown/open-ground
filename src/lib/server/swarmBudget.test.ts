// The budget gate (AUTONOMY-SPEC R-D1 / R-D2), pure and on a fixed clock: each
// hold kind's boundary on both sides, the `until` each one states, and the fail
// direction (no fresh reading ⇒ allow, said as `usage-unknown`).

import { describe, it, expect } from 'vitest'
import {
  budgetGate,
  normalizeSwarmBudget,
  DEFAULT_SWARM_BUDGET,
  TIER_START_CEILING_PCT,
  PACE_BURST_PCT,
  USAGE_FRESH_MS,
  WEEK_MS,
  type BudgetReading,
} from './swarmBudget'
import type { SwarmBudgetPolicy, TaskTier } from '../types'

const NOW = Date.parse('2026-11-28T12:00:00Z')
const HOUR = 3_600_000
const FREE: SwarmBudgetPolicy = DEFAULT_SWARM_BUDGET
const EVEN: SwarmBudgetPolicy = { pace: 'even', ownerReservePct: 10 }

const win = (usedPct: number | null, over: Partial<BudgetReading> = {}): BudgetReading => ({
  usedPct,
  resetsAt: NOW + 2 * HOUR,
  at: NOW - 60_000,
  ...over,
})
const week = (usedPct: number | null, over: Partial<BudgetReading> = {}): BudgetReading =>
  win(usedPct, { resetsAt: NOW + 3 * 24 * HOUR, ...over })
const card = (tier: TaskTier) => ({ title: 'tidy the list view', notes: 'done when the list reads well', tier })

describe('the owner decision is the default (§7-2: no even pacing, keep 10%)', () => {
  it('defaults to pace free with a 10% owner reserve', () => {
    expect(DEFAULT_SWARM_BUDGET).toEqual({ pace: 'free', ownerReservePct: 10 })
    expect(normalizeSwarmBudget(undefined)).toEqual({ pace: 'free', ownerReservePct: 10 })
    expect(normalizeSwarmBudget({ pace: 'sometimes', ownerReservePct: 'lots' })).toEqual({ pace: 'free', ownerReservePct: 10 })
    expect(normalizeSwarmBudget({ pace: 'even', ownerReservePct: 20 })).toEqual({ pace: 'even', ownerReservePct: 20 })
  })

  it('names the four start ceilings', () => {
    expect(TIER_START_CEILING_PCT).toEqual({ touch: 90, standard: 80, design: 70, ultra: 60 })
  })
})

describe('window-headroom — the 5-hour window, by the card tier', () => {
  for (const tier of ['touch', 'standard', 'design', 'ultra'] as const) {
    const ceiling = TIER_START_CEILING_PCT[tier]
    it(`${tier}: ${ceiling - 1}% starts, ${ceiling}% holds until the window resets`, () => {
      expect(budgetGate({ five_hour: win(ceiling - 1), seven_day: week(5) }, NOW, FREE, card(tier))).toEqual({ allow: true })
      expect(budgetGate({ five_hour: win(ceiling), seven_day: week(5) }, NOW, FREE, card(tier))).toEqual({
        allow: false,
        kind: 'window-headroom',
        until: NOW + 2 * HOUR,
        usedPct: ceiling,
        linePct: ceiling,
      })
    })
  }

  it('judges the EFFECTIVE tier: a "touch" card that trips the safety floor runs at design', () => {
    const floored = { title: 'delete the old auth tokens', notes: 'done when gone', tier: 'touch' as const }
    expect(budgetGate({ five_hour: win(75), seven_day: week(5) }, NOW, FREE, floored)).toMatchObject({
      allow: false,
      kind: 'window-headroom',
      linePct: 70,
    })
  })

  it('a reading without a reset time holds until the reading goes stale', () => {
    const r = win(95, { resetsAt: null })
    expect(budgetGate({ five_hour: r, seven_day: week(5) }, NOW, FREE, card('touch'))).toMatchObject({
      kind: 'window-headroom',
      until: r.at + USAGE_FRESH_MS,
    })
  })
})

describe('weekly-reserve — the owner keeps 100 − ownerReservePct', () => {
  it('89% starts, 90% holds until the week resets', () => {
    expect(budgetGate({ five_hour: win(5), seven_day: week(89) }, NOW, FREE, card('touch'))).toEqual({ allow: true })
    expect(budgetGate({ five_hour: win(5), seven_day: week(90) }, NOW, FREE, card('touch'))).toEqual({
      allow: false,
      kind: 'weekly-reserve',
      until: NOW + 3 * 24 * HOUR,
      usedPct: 90,
      linePct: 90,
    })
  })

  it('a 20% reserve moves the line to 80', () => {
    const policy = { pace: 'free' as const, ownerReservePct: 20 }
    expect(budgetGate({ five_hour: win(5), seven_day: week(79) }, NOW, policy, card('touch'))).toEqual({ allow: true })
    expect(budgetGate({ five_hour: win(5), seven_day: week(80) }, NOW, policy, card('touch'))).toMatchObject({ kind: 'weekly-reserve' })
  })

  it('outranks the window: a held week says so even when the window is also over', () => {
    expect(budgetGate({ five_hour: win(99), seven_day: week(95) }, NOW, FREE, card('touch'))).toMatchObject({ kind: 'weekly-reserve' })
  })
})

describe('weekly-pace — implemented, OFF under the owner\'s "free"', () => {
  // Exactly two days into the week: line = 2/7 × 100 + 15 ≈ 43.57.
  const start = NOW - 2 * 24 * HOUR
  const paced = (usedPct: number, at = NOW - 60_000) => week(usedPct, { resetsAt: start + WEEK_MS, at })
  const line = (2 / 7) * 100 + PACE_BURST_PCT

  it('even: 43% starts, 44% holds until the line reaches 44%', () => {
    expect(budgetGate({ five_hour: win(5), seven_day: paced(43) }, NOW, EVEN, card('touch'))).toEqual({ allow: true })
    const v = budgetGate({ five_hour: win(5), seven_day: paced(44) }, NOW, EVEN, card('touch'))
    expect(v).toMatchObject({ allow: false, kind: 'weekly-pace', usedPct: 44 })
    const until = start + ((44 - PACE_BURST_PCT) / 100) * WEEK_MS
    expect(v).toMatchObject({ until })
    expect((v as { linePct: number }).linePct).toBeCloseTo(line, 6)
    // At `until` the line has reached the used share: the gate lets the card start.
    expect(budgetGate({ five_hour: win(5, { at: until - 60_000, resetsAt: until + HOUR }), seven_day: paced(44, until - 60_000) }, until, EVEN, card('touch'))).toEqual({ allow: true })
  })

  it('free: the same week is not paced', () => {
    expect(budgetGate({ five_hour: win(5), seven_day: paced(80) }, NOW, FREE, card('touch'))).toEqual({ allow: true })
  })
})

describe('no fresh reading ⇒ allow, and say so', () => {
  it('a reading exactly 30 minutes old is stale; one a millisecond younger still holds', () => {
    const stale = win(95, { at: NOW - USAGE_FRESH_MS })
    const fresh = win(95, { at: NOW - USAGE_FRESH_MS + 1 })
    expect(budgetGate({ five_hour: stale, seven_day: week(5) }, NOW, FREE, card('touch'))).toEqual({ allow: true, note: 'usage-unknown' })
    expect(budgetGate({ five_hour: fresh, seven_day: week(5) }, NOW, FREE, card('touch'))).toMatchObject({ allow: false, kind: 'window-headroom' })
  })

  it('a reading from a window that has already reset is not a reading (dispatch resumes by itself)', () => {
    const before = win(95, { resetsAt: NOW + 1 })
    expect(budgetGate({ five_hour: before, seven_day: week(5) }, NOW, FREE, card('touch'))).toMatchObject({ allow: false })
    expect(budgetGate({ five_hour: before, seven_day: week(5) }, NOW + 1, FREE, card('touch'))).toEqual({ allow: true, note: 'usage-unknown' })
  })

  it('nothing known, or a status without a share, allows with the note', () => {
    expect(budgetGate({}, NOW, FREE, card('ultra'))).toEqual({ allow: true, note: 'usage-unknown' })
    expect(budgetGate({ five_hour: win(null), seven_day: week(null) }, NOW, FREE, card('ultra'))).toEqual({ allow: true, note: 'usage-unknown' })
    // One window known and under its line: still allowed, still noted.
    expect(budgetGate({ five_hour: win(10) }, NOW, FREE, card('ultra'))).toEqual({ allow: true, note: 'usage-unknown' })
  })
})
