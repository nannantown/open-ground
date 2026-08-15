import { describe, it, expect } from 'vitest'
import {
  COURSE_REGION,
  PERSONA_BODY_REGIONS,
  PERSONA_REGIONS,
  QUESTION_REGION,
  REGION_LABEL_KEY,
  REGION_TAG,
  buildPersonaNodes,
  placeJudgment,
  regionForQuestion,
} from './regions'
import { COURSES } from './instruments'
import { messages } from '@/i18n/messages'
import type { ManualJudgment, PersonaQuestion, PersonaQuestionKind } from '@/lib/types'

// The seating rule, as PROPERTIES rather than examples. Everything here is
// pure, so these run without a canvas, a DOM or a clock — which is the whole
// reason the rule was lifted out of PersonaFigure.tsx (its `buildField` returns
// null under jsdom, so geometry-coupled seating was structurally untestable).
//
// What is pinned here and nowhere else:
//   • the tier-4 SPREAD never reaches the halo, and never claims to be a reading
//   • no interview kind digs in the halo
//   • the label table covers every region in BOTH locales
// The UI-side consequence — that an unplaced note prints 「場所はまだ決めて
// いません」 instead of a region name — is pinned in PersonaModule.test.tsx,
// because it is the rendered line that would lie, not this function.

const judgment = (over: Partial<ManualJudgment> = {}): ManualJudgment => ({
  id: 'j-1',
  text: 'Price on value, never on cost.',
  addedAt: '2026-07-18T04:00:00.000Z',
  ...over,
})

const question = (kind: PersonaQuestionKind): PersonaQuestion => ({
  id: 'q-1',
  date: '2026-08-15',
  kind,
  subjectKey: `${kind}:x`,
  textJa: '…',
  textEn: '…',
  createdAt: '2026-08-15T00:00:00.000Z',
  status: 'open',
})

/** Every question kind the interview can produce. Listed rather than derived,
 *  so ADDING a kind fails here until its region is decided. */
const QUESTION_KINDS: readonly PersonaQuestionKind[] = [
  'decision-speed-contrast',
  'escalation-answer-rule',
  'escalation-dismissed',
  'escalation-long-open',
  'corpus-gap',
  'card-rework',
  'card-approved',
  'card-stale-blocked',
  'todo-passed-over',
]

describe('the five regions', () => {
  it('has a label in BOTH locales for every region, and for the three empties', () => {
    for (const region of PERSONA_REGIONS) {
      const key = REGION_LABEL_KEY[region]
      expect(messages.en[key], `en:${key}`).toBeTruthy()
      expect(messages.ja[key], `ja:${key}`).toBeTruthy()
    }
    // 「まだ場所が決まっていない」「読めなかった」「本当に空」 are three
    // DIFFERENT states and each needs its own words — sharing one string is how
    // a failed read starts reading as an empty region.
    for (const key of ['persona.region.unplaced', 'persona.region.unreadable', 'persona.region.none']) {
      expect(messages.en[key], `en:${key}`).toBeTruthy()
      expect(messages.ja[key], `ja:${key}`).toBeTruthy()
    }
  })

  it('the body pool is the five minus the halo', () => {
    expect([...PERSONA_BODY_REGIONS]).toEqual(['head', 'chest', 'arms', 'legs'])
    expect(PERSONA_BODY_REGIONS).not.toContain('people')
    expect([...PERSONA_REGIONS]).toContain('people')
  })

  it('REGION_TAG is the one spelling every writer stamps', () => {
    expect(REGION_TAG('people')).toBe('region:people')
    // …and the reader accepts exactly what the writer wrote.
    expect(placeJudgment(judgment({ tags: [REGION_TAG('people')] }))).toEqual({
      region: 'people',
      placed: true,
    })
  })
})

describe('placeJudgment — the four tiers', () => {
  it('tier 1: an explicit region tag wins, and counts as evidence', () => {
    for (const region of PERSONA_REGIONS) {
      // Alongside a course tag, deliberately: the explicit seat must beat the
      // inferred one, or a re-seated finding could never be corrected.
      const j = judgment({ id: `j-${region}`, tags: ['persona', 'big5', REGION_TAG(region)] })
      expect(placeJudgment(j)).toEqual({ region, placed: true })
    }
    // Case-insensitive, whitespace-tolerant — the tag is machine-written but
    // the corpus is hand-editable.
    expect(placeJudgment(judgment({ tags: ['  Region:LEGS '] }))).toEqual({
      region: 'legs',
      placed: true,
    })
  })

  it('tier 1 ignores a region that is not one of ours rather than inventing a seat', () => {
    // Falls through to tier 4 — spread, NOT placed. An unknown region name is
    // not a reading, and treating it as one would seat a note by typo.
    expect(placeJudgment(judgment({ tags: ['region:elbow'] })).placed).toBe(false)
    // And a tag that merely CONTAINS the prefix is not a claim.
    expect(placeJudgment(judgment({ tags: ['about-region:head'] })).placed).toBe(false)
  })

  it('tier 2: a course finding lands in the region that course grows', () => {
    for (const c of COURSES) {
      const j = judgment({ id: `j-${c.id}`, tags: ['persona', c.id] })
      expect(placeJudgment(j)).toEqual({ region: COURSE_REGION[c.id], placed: true })
    }
  })

  it('tier 3: an interview answer lands where its question was digging', () => {
    for (const kind of QUESTION_KINDS) {
      // ONE id for all nine kinds, deliberately: were the kind tag ignored,
      // every answer would fall into the same hashed region, and no single
      // region can satisfy nine kinds that span four.
      const j = judgment({ id: 'j-int', tags: ['interview', kind] })
      expect(placeJudgment(j)).toEqual({ region: QUESTION_REGION[kind], placed: true })
    }
  })

  // MUTATION GUARD #1 — the tier-4 pool.
  it('tier 4: a note with no evidence is never seated in the halo', () => {
    const spread = new Set(
      Array.from({ length: 400 }, (_, i) => placeJudgment(judgment({ id: `j-${i}` })).region),
    )
    // EXACTLY the four body regions: not "more than one" (which a five-region
    // spread also satisfies), and not "does not contain people" alone (which a
    // one-region collapse would satisfy). Both halves matter.
    // Array.from, not spread: this repo's tsconfig has no downlevelIteration.
    expect(Array.from(spread).sort()).toEqual(['arms', 'chest', 'head', 'legs'])
    expect(spread.has('people')).toBe(false)
  })

  // MUTATION GUARD #2's pure half — the rendered half lives in
  // PersonaModule.test.tsx, where the wrong label would actually be printed.
  it('tier 4 reports the seat as NOT placed — a spread is not a reading', () => {
    expect(placeJudgment(judgment({ id: 'j-free', tags: ['pricing'] })).placed).toBe(false)
    expect(placeJudgment(judgment({ id: 'j-bare' })).placed).toBe(false)
    // …and it is deterministic: the same note never moves.
    const j = judgment({ id: 'j-free', tags: ['pricing'] })
    expect(placeJudgment(j).region).toBe(placeJudgment({ ...j }).region)
  })
})

describe('the halo is reachable only from evidence about other people', () => {
  // MUTATION GUARD #3.
  it('no interview kind digs in the halo', () => {
    const dug = new Set(Object.values(QUESTION_REGION))
    expect(dug.has('people')).toBe(false)
    // The table is exhaustive over the kinds, so a new kind cannot skip this.
    for (const kind of QUESTION_KINDS) expect(QUESTION_REGION[kind]).toBeTruthy()
    expect(Object.keys(QUESTION_REGION).sort()).toEqual([...QUESTION_KINDS].sort())
  })

  it('no course grows the halo either', () => {
    expect(Object.values(COURSE_REGION)).not.toContain('people')
    expect(Object.keys(COURSE_REGION).sort()).toEqual(COURSES.map((c) => c.id).sort())
  })

  it('regionForQuestion answers null for no question, never a region', () => {
    expect(regionForQuestion(null)).toBeNull()
    for (const kind of QUESTION_KINDS) {
      expect(regionForQuestion(question(kind))).toBe(QUESTION_REGION[kind])
    }
  })
})

describe('buildPersonaNodes', () => {
  it('carries the whole note plus its seat and whether that seat was read', () => {
    const nodes = buildPersonaNodes([
      judgment({ id: 'j-1', text: 'A.', tags: ['region:chest'], context: 'ctx', correctsId: 'j-0' }),
      judgment({ id: 'j-2', text: 'B.' }),
    ])
    expect(nodes.map((n) => n.id)).toEqual(['j-1', 'j-2'])
    expect(nodes[0]).toMatchObject({
      text: 'A.',
      region: 'chest',
      placed: true,
      tags: ['region:chest'],
      context: 'ctx',
      correctsId: 'j-0',
    })
    expect(nodes[1].placed).toBe(false)
    expect(nodes[1].tags).toEqual([])
    expect(nodes[1].context).toBeUndefined()
  })
})
