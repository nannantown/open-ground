import { describe, it, expect } from 'vitest'
import {
  PRIORITY_RANK,
  basePriorityRank,
  agingBoost,
  effectivePriorityRank,
  sortByPriority,
  AGING_STEP_MS,
  AGING_MAX_BOOST,
  PRIORITY_META,
} from './boardPriority'
import { TASK_PRIORITIES, type ProjectTask } from './types'

// Pure module — no HOME / disk / network touched, so these are inherently
// isolated from ~/.openground.
const card = (over: Partial<ProjectTask> & { id: string }): ProjectTask => ({
  title: `task ${over.id}`,
  done: false,
  createdAt: '2026-06-23T00:00:00Z',
  boardColumn: 'todo',
  ...over,
})

describe('basePriorityRank', () => {
  it('ranks urgent > high > normal > low', () => {
    expect(basePriorityRank({ priority: 'urgent' })).toBe(3)
    expect(basePriorityRank({ priority: 'high' })).toBe(2)
    expect(basePriorityRank({ priority: 'normal' })).toBe(1)
    expect(basePriorityRank({ priority: 'low' })).toBe(0)
  })
  it('treats an absent priority as normal', () => {
    expect(basePriorityRank({})).toBe(PRIORITY_RANK.normal)
  })
})

describe('agingBoost', () => {
  const created = '2026-06-23T00:00:00Z'
  const at = (ms: number) => Date.parse(created) + ms
  it('is 0 for a fresh card (below one step)', () => {
    expect(agingBoost({ createdAt: created }, at(0))).toBe(0)
    expect(agingBoost({ createdAt: created }, at(AGING_STEP_MS - 1))).toBe(0)
  })
  it('adds one rank per AGING_STEP_MS waited', () => {
    expect(agingBoost({ createdAt: created }, at(AGING_STEP_MS))).toBe(1)
    expect(agingBoost({ createdAt: created }, at(2 * AGING_STEP_MS))).toBe(2)
  })
  it('caps the boost at AGING_MAX_BOOST', () => {
    expect(agingBoost({ createdAt: created }, at(999 * AGING_STEP_MS))).toBe(AGING_MAX_BOOST)
  })
  it('is 0 for an unparseable or future createdAt (clock skew)', () => {
    expect(agingBoost({ createdAt: 'not-a-date' }, at(0))).toBe(0)
    expect(agingBoost({ createdAt: created }, at(-60_000))).toBe(0)
  })
})

describe('effectivePriorityRank', () => {
  it('adds the aging boost to the static rank', () => {
    const now = Date.parse('2026-06-23T00:00:00Z') + AGING_STEP_MS
    // low (0) + one step of aging (1) = 1
    expect(
      effectivePriorityRank({ priority: 'low', createdAt: '2026-06-23T00:00:00Z' }, now),
    ).toBe(1)
  })
})

describe('sortByPriority', () => {
  const FRESH = Date.parse('2026-06-23T00:10:00Z') // 10min ⇒ no aging

  it('orders by priority first, then boardOrder within a bucket, then createdAt', () => {
    const cards = [
      card({ id: 'low', priority: 'low', boardOrder: 0 }),
      card({ id: 'u', priority: 'urgent', boardOrder: 9 }),
      card({ id: 'n', boardOrder: 1 }), // absent ⇒ normal
      card({ id: 'h1', priority: 'high', boardOrder: 5 }),
      card({ id: 'h0', priority: 'high', boardOrder: 1 }),
    ]
    expect(sortByPriority(cards, FRESH).map((c) => c.id)).toEqual(['u', 'h0', 'h1', 'n', 'low'])
  })

  it('does not mutate its input', () => {
    const cards = [
      card({ id: 'a', priority: 'low' }),
      card({ id: 'b', priority: 'urgent' }),
    ]
    const before = cards.map((c) => c.id)
    sortByPriority(cards, FRESH)
    expect(cards.map((c) => c.id)).toEqual(before)
  })

  it('promotes a long-waiting low card above a fresh high card (aging)', () => {
    const stale = card({ id: 'stale', priority: 'low', createdAt: '2026-06-23T00:00:00Z' })
    const fresh = card({ id: 'fresh', priority: 'high', createdAt: '2026-06-23T12:00:00Z' })
    const now = Date.parse('2026-06-23T12:00:00Z') // stale waited 12h (+3), fresh 0
    expect(sortByPriority([fresh, stale], now).map((c) => c.id)).toEqual(['stale', 'fresh'])
  })
})

describe('PRIORITY_META', () => {
  it('has a label key + chip/pill classes for every priority', () => {
    for (const p of TASK_PRIORITIES) {
      expect(PRIORITY_META[p]?.labelKey).toBe(`board.detail.priority.${p}`)
      expect(PRIORITY_META[p].chipClass).toBeTruthy()
      expect(PRIORITY_META[p].pillSelectedClass).toBeTruthy()
    }
  })
})
