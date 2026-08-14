// @vitest-environment node
//
// The instruments' HONESTY properties — the ones a self-report screen lives or
// dies by. Each test here is a claim the result sheet makes to the owner:
//   1. agreeing with everything must NOT max every scale (reverse-keying works);
//   2. an even split on a bipolar axis must READ as even, not be rounded into a
//      confident letter;
//   3. a half-answered or out-of-range course produces NO result at all;
//   4. every course states its provenance, and the two trademarked instruments
//      we deliberately do NOT ship are named as such.

import { describe, it, expect } from 'vitest'
import {
  BIG5_ITEMS,
  COURSES,
  PERSONA_RESULT_CAVEAT,
  PersonaScoringError,
  TYPE_ITEMS,
  VALUE_ITEMS,
  WORK_ITEMS,
  axisConfidence,
  courseById,
  itemAt,
  scoreCourse,
} from './instruments'

const course = (id: string) => {
  const c = courseById(id)
  expect(c, `course ${id} missing`).not.toBeNull()
  return c!
}

describe('acquiescence guard — reverse-keyed items really reverse', () => {
  it('agreeing with EVERY statement does not max all five factors', () => {
    const res = scoreCourse(course('big5'), BIG5_ITEMS.map(() => 4))
    // Factors carrying reversed items must land at the midpoint, not 100.
    const byName = Object.fromEntries(res.rows.map((r) => [r.name, r.pct]))
    expect(byName['開放性']).toBeLessThan(100)
    expect(byName['誠実性']).toBeLessThan(100)
    expect(byName['外向性']).toBeLessThan(100)
    expect(byName['協調性']).toBeLessThan(100)
    expect(byName['情動性']).toBeLessThan(100)
    // …and the same set of answers must not be a floor either.
    for (const r of res.rows) expect(r.pct).toBeGreaterThan(0)
  })

  it('the neutral response set lands every factor at the midpoint', () => {
    const res = scoreCourse(course('big5'), BIG5_ITEMS.map(() => 2))
    for (const r of res.rows) expect(r.pct).toBe(50)
  })

  it('answering in each factor’s keyed direction does max it', () => {
    // Direction-aware: 4 for a straight item, 0 for a reversed one.
    const res = scoreCourse(course('big5'), BIG5_ITEMS.map(([, rev]) => (rev ? 0 : 4)))
    for (const r of res.rows) expect(r.pct).toBe(100)
  })

  it('mints one finding per factor, each carrying the number it came from', () => {
    const res = scoreCourse(course('big5'), BIG5_ITEMS.map(() => 2))
    expect(res.findings).toHaveLength(5)
    for (const f of res.findings) expect(f.detail).toMatch(/\d+%/)
  })
})

describe('bipolar axes report their margin honestly', () => {
  it('an even split reads ほぼ半々 — never a confident letter', () => {
    // Alternate answers so every axis splits 3/3.
    const answers = TYPE_ITEMS.map((_, i) => (i % 2 === 0 ? 0 : 1))
    const res = scoreCourse(course('type'), answers)
    for (const r of res.rows) {
      expect(r.note).toBe('ほぼ半々')
      expect(r.desc).toContain('日によって変わります')
    }
    expect(res.badge).toHaveLength(4)
  })

  it('a clean sweep reads はっきり and yields the pole letters', () => {
    const res = scoreCourse(course('type'), TYPE_ITEMS.map(() => 0))
    for (const r of res.rows) expect(r.note).toBe('はっきり')
    expect(res.badge).toBe('ESTJ')
  })

  it('axisConfidence bands are monotonic and only ≥62% earns confidence', () => {
    expect(axisConfidence(50)).toBe('ほぼ半々')
    expect(axisConfidence(61)).toBe('ほぼ半々')
    expect(axisConfidence(62)).toBe('ややはっきり')
    expect(axisConfidence(80)).toBe('はっきり')
  })
})

describe('an unfinished or malformed course produces NO result', () => {
  it('a short answer vector throws', () => {
    expect(() => scoreCourse(course('big5'), [4, 4, 4])).toThrow(PersonaScoringError)
  })
  it('an out-of-range Likert answer throws', () => {
    expect(() => scoreCourse(course('big5'), BIG5_ITEMS.map(() => 7))).toThrow(PersonaScoringError)
  })
  it('a two-choice course refuses a Likert-sized answer', () => {
    expect(() => scoreCourse(course('work'), WORK_ITEMS.map(() => 3))).toThrow(PersonaScoringError)
  })
})

describe('rank courses', () => {
  it('values ranks all ten types and mints the top three', () => {
    // Rate the two 自分で決める items highest, everything else low.
    const answers = VALUE_ITEMS.map(([k]) => (k === 'self' ? 4 : 1))
    const res = scoreCourse(course('values'), answers)
    expect(res.rows).toHaveLength(10)
    expect(res.rows[0].name).toBe('自分で決める')
    expect(res.rows[0].rank).toBe(1)
    expect(res.findings).toHaveLength(3)
    expect(res.headline).toContain('自分で決める')
  })

  it('work ranks all eight themes; the pair list is balanced', () => {
    const res = scoreCourse(course('work'), WORK_ITEMS.map(() => 0))
    expect(res.rows).toHaveLength(8)
    const counts: Record<string, number> = {}
    WORK_ITEMS.forEach(([a, b]) => {
      counts[a] = (counts[a] ?? 0) + 1
      counts[b] = (counts[b] ?? 0) + 1
    })
    // Every theme must be offered the same number of times, or the "winner" is
    // an artefact of the pairing rather than of the answers.
    expect(new Set(Object.values(counts)).size).toBe(1)
  })
})

describe('provenance + naming (the licensing promise)', () => {
  it('every course states its source, and item counts match the catalogue', () => {
    for (const c of COURSES) {
      expect(c.source.length).toBeGreaterThan(10)
      expect(scoreCourse(c, new Array(c.itemCount).fill(0)).source).toBe(c.source)
      expect(itemAt(c, 0)).not.toBeNull()
      expect(itemAt(c, c.itemCount)).toBeNull() // one past the end
    }
  })

  it('the two trademarked instruments are named as NOT shipped', () => {
    expect(course('type').source).toContain('MBTI®')
    expect(course('type').source).toContain('別の指標')
    expect(course('work').source).toContain('CliftonStrengths®')
    expect(course('work').source).toContain('別の指標')
    // …and no course claims to BE one of them.
    for (const c of COURSES) {
      expect(c.name).not.toContain('MBTI')
      expect(c.name).not.toContain('ストレングスファインダー')
    }
  })

  it('the caveat exists and refuses to be a personality verdict', () => {
    expect(PERSONA_RESULT_CAVEAT).toContain('決めつけるものではありません')
    expect(PERSONA_RESULT_CAVEAT).toContain('ズレのほうが情報')
  })
})
