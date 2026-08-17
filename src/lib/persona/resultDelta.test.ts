import { describe, it, expect } from 'vitest'
import { resultDelta } from './resultDelta'
import type { PersonaResult, PersonaResultRow } from '../types'

// What moved between two takes of the same instrument — the one claim a
// self-report is entitled to make, because it is a difference between two of the
// owner's own answers rather than a verdict about who he is.

const bars = (rows: Partial<PersonaResultRow>[]): PersonaResult => ({
  courseId: 'big5',
  courseName: '性格の5因子',
  source: 'IPIP',
  itemCount: 25,
  kind: 'bars',
  headline: 'h',
  findings: [],
  rows: rows.map((r, i) => ({ key: r.key ?? `k${i}`, name: r.name ?? `n${i}`, desc: 'd', ...r })),
})

const ranked = (rows: Partial<PersonaResultRow>[]): PersonaResult => ({
  ...bars(rows),
  courseId: 'values',
  kind: 'rank',
})

describe('resultDelta — bars', () => {
  it('reports both numbers and the movement between them', () => {
    const d = resultDelta(bars([{ key: 'e', name: '外向性', pct: 45 }]), bars([{ key: 'e', pct: 20 }]))
    expect(d?.rows).toEqual([{ key: 'e', name: '外向性', before: 20, after: 45, moved: 25 }])
  })

  it('a row that did not move says 0 — that IS a measurement', () => {
    const d = resultDelta(bars([{ key: 'a', pct: 60 }]), bars([{ key: 'a', pct: 60 }]))
    expect(d?.rows[0].moved).toBe(0)
  })

  it('⚠ A MISSING NUMBER IS NOT ZERO', () => {
    // A row the scorer could not fill has no percentage. Treating that as 0
    // would print a full-width plunge for a factor nobody measured.
    const d = resultDelta(bars([{ key: 'a', pct: 60 }]), bars([{ key: 'a' }]))
    expect(d?.rows[0]).toEqual({ key: 'a', name: 'n0', before: null, after: 60, moved: null })
  })
})

describe('resultDelta — rank', () => {
  it('⚠ "UP" MEANS NEARER THE TOP, so 3rd → 1st is +2', () => {
    // Without the flip the same +2 would mean opposite things on two sheets of
    // the same app: more of a trait on one, further DOWN a ranking on the other.
    const d = resultDelta(
      ranked([{ key: 'v', name: '正確さ', rank: 1 }]),
      ranked([{ key: 'v', rank: 3 }]),
    )
    expect(d?.rows[0].moved).toBe(2)
    expect(d?.rows[0].before).toBe(3)
    expect(d?.rows[0].after).toBe(1)
  })

  it('…and falling is negative', () => {
    const d = resultDelta(ranked([{ key: 'v', rank: 5 }]), ranked([{ key: 'v', rank: 2 }]))
    expect(d?.rows[0].moved).toBe(-3)
  })
})

describe('resultDelta — what it refuses to compare', () => {
  it('⚠ RETURNS NULL FOR TWO DIFFERENT INSTRUMENTS', () => {
    // An empty 「動いたところ」 heading over two results that were never
    // comparable is worse than no heading.
    expect(resultDelta(bars([{ key: 'a', pct: 1 }]), ranked([{ key: 'a', rank: 1 }]))).toBeNull()
  })

  it('returns null when the same course was rescored into a different shape', () => {
    const nowBars = bars([{ key: 'a', pct: 10 }])
    const thenRank: PersonaResult = { ...nowBars, kind: 'rank' }
    expect(resultDelta(nowBars, thenRank)).toBeNull()
  })

  it('⚠ NAMES the rows the instrument gained or lost — never silently drops them', () => {
    // An instrument that changed between two takes is the one thing that would
    // make a delta table quietly wrong.
    const d = resultDelta(
      bars([
        { key: 'a', name: 'あ', pct: 50 },
        { key: 'new', name: 'あたらしい', pct: 30 },
      ]),
      bars([
        { key: 'a', pct: 40 },
        { key: 'gone', name: 'きえた', pct: 70 },
      ]),
    )
    expect(d?.onlyNow).toEqual(['あたらしい'])
    expect(d?.onlyBefore).toEqual(['きえた'])
    // …and the row that exists in both is still compared.
    expect(d?.rows.find((r) => r.key === 'a')?.moved).toBe(10)
    // The new row is listed with no movement rather than as a jump from zero.
    expect(d?.rows.find((r) => r.key === 'new')?.moved).toBeNull()
  })
})
