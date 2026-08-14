// @vitest-environment node
//
// The portrait's three promises, as tests. The composer is where a self-
// knowledge screen either stays honest or becomes a horoscope, so each rule
// gets a case that FAILS if the rule is relaxed:
//   1. nothing without evidence (untaken course ⇒ no line; empty ⇒ no lines);
//   2. a close call never becomes a claim (中くらい / ほぼ半々 are skipped);
//   3. every line names the instrument and number it came from, and carries
//      the age of that evidence.
// Results are produced by the REAL scorer from real answer vectors — never a
// hand-written result object, so a scoring change that would alter the
// portrait shows up here instead of in the field.

import { describe, it, expect } from 'vitest'
import { composePortrait, PORTRAIT_MAX_LINES, portraitAgeLabel } from './portrait'
import { COURSES, scoreCourse, BIG5_ITEMS } from './instruments'
import type { PersonaCourseId, PersonaCourseRecord } from '../types'

const NOW = Date.parse('2026-08-14T00:00:00Z')
const courseOf = (id: PersonaCourseId) => COURSES.find((c) => c.id === id)!

const record = (id: PersonaCourseId, answers: number[], takenAt = '2026-08-13T00:00:00Z'): PersonaCourseRecord => ({
  result: scoreCourse(courseOf(id), answers),
  takenAt,
  answers,
})

/** A big5 vector that leans HARD on every factor: agree with every straight
 *  item, disagree with every reversed one (the scorer flips those back). */
const big5Decisive = BIG5_ITEMS.map(([, reversed]) => (reversed ? 0 : 4))
/** …and one that says 「どちらともいえない」 to everything ⇒ every band 中くらい. */
const big5Neutral = BIG5_ITEMS.map(() => 2)

describe('composePortrait — nothing without evidence', () => {
  it('no records ⇒ no lines at all (the screen shows its own invitation)', () => {
    const p = composePortrait({ records: {}, nodeCount: 0, now: NOW })
    expect(p.lines).toEqual([])
    expect(p.takenCount).toBe(0)
    expect(p.courseCount).toBe(4)
  })

  it('an untaken course contributes nothing — only the taken one speaks', () => {
    const p = composePortrait({ records: { work: record('work', WORK_A) }, nodeCount: 12, now: NOW })
    expect(p.lines.length).toBe(1)
    expect(p.lines.every((l) => l.courseId === 'work')).toBe(true)
    expect(p.takenCount).toBe(1)
  })

  it('counts ride through untouched (they are facts, not composition)', () => {
    const p = composePortrait({ records: {}, nodeCount: 41, recentCount: 6, now: NOW })
    expect(p.nodeCount).toBe(41)
    expect(p.recentCount).toBe(6)
  })
})

describe('composePortrait — a close call never becomes a claim', () => {
  it('an all-中くらい five-factor result yields NO five-factor line', () => {
    const rec = record('big5', big5Neutral)
    // precondition: the scorer really did call every band 中くらい
    expect(rec.result.rows.every((r) => r.note === '中くらい')).toBe(true)
    const p = composePortrait({ records: { big5: rec }, nodeCount: 3, now: NOW })
    expect(p.lines).toEqual([])
  })

  it('a decisive five-factor result speaks, and names its number', () => {
    const p = composePortrait({ records: { big5: record('big5', big5Decisive) }, nodeCount: 3, now: NOW })
    expect(p.lines.length).toBeGreaterThan(0)
    for (const l of p.lines) {
      expect(l.courseId).toBe('big5')
      expect(l.detail).toContain('性格の5因子')
      expect(l.detail).toMatch(/\d+%/) // the number it came from
    }
    // At most two factors reach the glance — the sheet holds the other three.
    expect(p.lines.length).toBeLessThanOrEqual(2)
  })

  it('a type result whose every axis is ほぼ半々 says SO, instead of asserting the letters', () => {
    // 12 of each pole per axis is impossible with 6 items; alternate to land 3/3.
    const answers = COURSES.find((c) => c.id === 'type')!.itemCount
    const alternating = Array.from({ length: answers }, (_, i) => (i % 2 === 0 ? 0 : 1))
    const rec = record('type', alternating)
    expect(rec.result.rows.every((r) => r.note === 'ほぼ半々')).toBe(true)
    const p = composePortrait({ records: { type: rec }, nodeCount: 1, now: NOW })
    expect(p.lines).toHaveLength(1)
    expect(p.lines[0].text).toContain('差は小さい')
  })
})

describe('composePortrait — provenance and age', () => {
  it('every line carries its course, its stamp and the age of the evidence', () => {
    const p = composePortrait({
      records: {
        values: record('values', VALUES_A, '2026-07-15T00:00:00Z'),
        work: record('work', WORK_A, '2026-08-13T00:00:00Z'),
      },
      nodeCount: 20, now: NOW,
    })
    expect(p.lines.length).toBe(2)
    for (const l of p.lines) {
      expect(l.detail.length).toBeGreaterThan(0)
      expect(typeof l.takenAt).toBe('string')
      expect(typeof l.ageDays).toBe('number')
    }
    const valuesLine = p.lines.find((l) => l.courseId === 'values')!
    expect(valuesLine.ageDays).toBe(30) // 7/15 → 8/14
  })

  it('every course taken ⇒ EXACTLY five lines, values first', () => {
    // The exact count is the assertion that has teeth. `PORTRAIT_MAX_LINES` is
    // a rail, not a tested behaviour: today's composer tops out at 1 (values)
    // + 2 (big5) + 1 (type) + 1 (work) = 5, so the slice is unreachable and a
    // `toBeLessThanOrEqual(5)` here would pass with the cap deleted — measured
    // 2026-08-14. Pinning the exact number instead means ADDING a line source
    // (which is when the cap starts mattering) turns this red and forces the
    // author to look at both.
    const p = composePortrait({
      records: {
        big5: record('big5', big5Decisive), type: record('type', TYPE_A),
        values: record('values', VALUES_A), work: record('work', WORK_A),
      },
      nodeCount: 60, now: NOW,
    })
    expect(p.lines.length).toBe(5)
    expect(p.lines.length).toBeLessThanOrEqual(PORTRAIT_MAX_LINES)
    // …and the most identity-bearing course leads.
    expect(p.lines[0].courseId).toBe('values')
  })

  // ── the work line: the only line built from what actually HAPPENED ────────
  it('says nothing about work until the stand-in has actually decided something', () => {
    // Rule 1 applied to the ledger: zero decisions is not "balanced", it is
    // silence. A line here would be the exact horoscope sentence this composer
    // exists to refuse.
    const base = { records: { values: record('values', VALUES_A) }, nodeCount: 3, now: NOW }
    expect(composePortrait(base).lines.some((l) => l.detail.includes('実際の判断'))).toBe(false)
    expect(
      composePortrait({ ...base, work: { answered: 0, asked: 0, abstained: 0 } })
        .lines.some((l) => l.detail.includes('実際の判断')),
    ).toBe(false)
  })

  it('describes the RATIO honestly — a stand-in that mostly asks is told so', () => {
    const base = { records: { values: record('values', VALUES_A) }, nodeCount: 3, now: NOW }
    const lineFor = (work: { answered: number; asked: number; abstained: number }) => {
      const l = composePortrait({ ...base, work }).lines.at(-1)!
      expect(l.detail).toContain('実際の判断')
      return l
    }
    // never answered → says so, and does NOT claim it is carrying anything
    expect(lineFor({ answered: 0, asked: 4, abstained: 1 }).text).toContain('まだ、あなたの代わりに答えられていない')
    // mostly asking → the honest, unflattering reading
    expect(lineFor({ answered: 1, asked: 8, abstained: 1 }).text).toContain('まだ多くをあなたに聞いている')
    // carrying most of it → only then does it say so
    expect(lineFor({ answered: 8, asked: 2, abstained: 0 }).text).toContain('あなたを待たずに引き受けている')
    // the counts themselves are in the provenance, not the sentence
    expect(lineFor({ answered: 3, asked: 2, abstained: 1 }).detail).toContain('代わりに答えた3 / 聞いた2 / 棄権1')
  })

  it('the work line survives the cap — a self-report is dropped before it is', () => {
    // Five decisive self-report lines would fill PORTRAIT_MAX_LINES on their own.
    const p = composePortrait({
      records: {
        values: record('values', VALUES_A),
        big5: record('big5', BIG5_ITEMS.map(() => 4)),
        type: record('type', TYPE_A),
        work: record('work', WORK_A),
      },
      nodeCount: 12,
      work: { answered: 5, asked: 1, abstained: 0 },
      now: NOW,
    })
    expect(p.lines.length).toBeLessThanOrEqual(PORTRAIT_MAX_LINES)
    expect(p.lines.at(-1)!.detail).toContain('実際の判断')
  })

  it('portraitAgeLabel words the age the same everywhere', () => {
    expect(portraitAgeLabel(undefined)).toBeNull()
    expect(portraitAgeLabel(0)).toBe('今日')
    expect(portraitAgeLabel(1)).toBe('今日')
    expect(portraitAgeLabel(5)).toBe('5日前')
    expect(portraitAgeLabel(30)).toBe('4週間前')
    expect(portraitAgeLabel(90)).toBe('3か月前')
  })
})

// Fixtures that just need to be VALID vectors for their instrument.
const VALUES_A = Array.from({ length: courseOf('values').itemCount }, (_, i) => (i < 2 ? 4 : i % 5))
const WORK_A = Array.from({ length: courseOf('work').itemCount }, (_, i) => (i % 2 === 0 ? 0 : 1))
const TYPE_A = Array.from({ length: courseOf('type').itemCount }, (_, i) => (i % 6 === 5 ? 1 : 0))
