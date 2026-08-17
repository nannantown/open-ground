import { describe, it, expect } from 'vitest'
import {
  KNOWN_GROUP_ORDER,
  groupJudgments,
  groupOf,
  matchesFilter,
} from './knownGroups'
import { COURSES } from './instruments'
import type { ManualJudgment } from '../types'

// How the corpus is split so it can be read back. The axis is SOURCE, because
// source is the one grouping that is already RECORDED — see the module header
// for why region and topic were both rejected.

const j = (over: Partial<ManualJudgment> & { id: string }): ManualJudgment => ({
  text: `${over.id} text`,
  addedAt: '2026-08-01T00:00:00.000Z',
  ...over,
})

const ids = (list: { items: ManualJudgment[] }[]) => list.map((g) => g.items.map((x) => x.id))

describe('groupOf — which bucket one line belongs in', () => {
  it('reads the tag each writer actually stamps', () => {
    // These four strings are what personaInterview / personaChat / personaImport
    // and personaCourses write today. Pinned as literals rather than imported
    // constants on purpose: if a writer changes its tag, this test is the thing
    // that notices, and a shared constant would keep them in step silently.
    expect(groupOf(j({ id: 'a', tags: ['interview', 'card-rework'] }))).toBe('interview')
    expect(groupOf(j({ id: 'b', tags: ['chat', 'region:head'] }))).toBe('chat')
    expect(groupOf(j({ id: 'c', tags: ['import', 'region:arms'] }))).toBe('import')
    expect(groupOf(j({ id: 'd', tags: ['persona', 'big5', 'region:head'] }))).toBe('course')
  })

  it('accepts a bare course id as a course, without the persona tag', () => {
    expect(groupOf(j({ id: 'e', tags: [COURSES[1].id] }))).toBe('course')
  })

  it('⚠ a CORRECTION is filed as a correction, whatever it was written from', () => {
    // A correction inherits the tags of the line it replaces, so this one looks
    // exactly like a chat line. The most important fact about it is that it is
    // an act of the owner overruling something — the one group he can use to
    // audit his own edits. Filing it under `chat` would hide that entirely.
    expect(groupOf(j({ id: 'f', tags: ['chat', 'region:head'], correctsId: 'b' }))).toBe(
      'corrected',
    )
  })

  it('says the SOURCE IS NOT RECORDED rather than calling it "other"', () => {
    // ⚠ "Other" quietly claims we looked and found nothing to say. What is true
    // is narrower and worse: the record of where this came from is missing.
    expect(groupOf(j({ id: 'g' }))).toBe('unrecorded')
    expect(groupOf(j({ id: 'h', tags: [] }))).toBe('unrecorded')
    expect(groupOf(j({ id: 'i', tags: ['region:legs'] }))).toBe('unrecorded')
  })
})

describe('groupJudgments — the shape the screen renders', () => {
  it('⚠ EMPTY GROUPS ARE ABSENT, never a zero row', () => {
    // A 0-count row is noise on a screen the owner keeps asking to quieten, and
    // worse, it invites reading an absence as a measurement.
    const groups = groupJudgments([j({ id: 'a', tags: ['chat'] })])
    expect(groups.map((g) => g.id)).toEqual(['chat'])
  })

  it('keeps a FIXED order regardless of size', () => {
    // ⚠ Sorting by count would reshuffle the screen every week and destroy the
    // fastest index there is — the owner's memory of where a thing sat.
    const many = Array.from({ length: 9 }, (_, i) => j({ id: `c${i}`, tags: ['chat'] }))
    const groups = groupJudgments([
      ...many,
      j({ id: 'i1', tags: ['interview'] }),
      j({ id: 'u1' }),
      j({ id: 'x1', tags: ['chat'], correctsId: 'c0' }),
    ])
    expect(groups.map((g) => g.id)).toEqual(['interview', 'chat', 'corrected', 'unrecorded'])
    // …and that order is the declared one, not an accident of insertion.
    const declared = KNOWN_GROUP_ORDER.filter((id) => groups.some((g) => g.id === id))
    expect(groups.map((g) => g.id)).toEqual(declared)
  })

  it('orders NEWEST FIRST inside a group', () => {
    const groups = groupJudgments([
      j({ id: 'old', tags: ['chat'] }),
      j({ id: 'mid', tags: ['chat'] }),
      j({ id: 'new', tags: ['chat'] }),
    ])
    expect(ids(groups)).toEqual([['new', 'mid', 'old']])
  })

  it('loses nothing — every line lands in exactly one group', () => {
    // ⚠ The count the screen prints comes from these arrays, so a line dropped
    // here is a line that silently stops speaking for him on a screen whose
    // entire job is to show everything that does.
    const all = [
      j({ id: 'a', tags: ['interview'] }),
      j({ id: 'b', tags: ['chat'] }),
      j({ id: 'c', tags: ['import'] }),
      j({ id: 'd', tags: ['persona', 'big5'] }),
      j({ id: 'e', correctsId: 'b' }),
      j({ id: 'f' }),
    ]
    const groups = groupJudgments(all)
    const flat = groups.flatMap((g) => g.items.map((x) => x.id)).sort()
    expect(flat).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('an empty corpus is an empty list, not a set of empty groups', () => {
    expect(groupJudgments([])).toEqual([])
  })

  // ── 取り消したもの: a STATE, not a source ────────────────────────────────────
  it('puts the withdrawn lines LAST, in their own group', () => {
    const groups = groupJudgments(
      [j({ id: 'a', tags: ['chat'] }), j({ id: 'b', tags: ['interview'] })],
      [j({ id: 'z' })],
    )
    expect(groups.map((g) => g.id)).toEqual(['interview', 'chat', 'retired'])
    expect(ids(groups)[2]).toEqual(['z'])
  })

  it('⚠ NEVER FILES A WITHDRAWN LINE UNDER THE SOURCE IT CAME FROM', () => {
    // Filed under `chat` it would read as something he still holds, in a list
    // whose entire job is to say what he holds.
    const groups = groupJudgments([], [j({ id: 'z', tags: ['chat'] })])
    expect(groups.map((g) => g.id)).toEqual(['retired'])
  })

  it('is absent when nothing was taken back', () => {
    const groups = groupJudgments([j({ id: 'a', tags: ['chat'] })])
    expect(groups.map((g) => g.id)).toEqual(['chat'])
  })
})

describe('matchesFilter — searching his words, not ours', () => {
  it('matches the text, case-folded', () => {
    const n = j({ id: 'a', text: 'Price on VALUE, never on cost.' })
    expect(matchesFilter(n, 'value')).toBe(true)
    expect(matchesFilter(n, 'COST')).toBe(true)
    expect(matchesFilter(n, 'schedule')).toBe(false)
  })

  it('matches HIS tags but never OURS', () => {
    // ⚠ region:/take:/persona/chat/import/interview and the course ids are our
    // vocabulary. Matching them would surface rows for a word he never typed and
    // cannot see on the row — the search would appear to be broken.
    const n = j({ id: 'a', text: 'plain', tags: ['pricing', 'region:head', 'chat', 'big5'] })
    expect(matchesFilter(n, 'pricing')).toBe(true)
    expect(matchesFilter(n, 'region')).toBe(false)
    expect(matchesFilter(n, 'head')).toBe(false)
    expect(matchesFilter(n, 'chat')).toBe(false)
    expect(matchesFilter(n, 'big5')).toBe(false)
  })

  it('an empty query means EVERYTHING, never nothing', () => {
    const n = j({ id: 'a', text: 'anything' })
    expect(matchesFilter(n, '')).toBe(true)
    expect(matchesFilter(n, '   ')).toBe(true)
  })
})
