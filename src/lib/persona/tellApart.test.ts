import { describe, it, expect } from 'vitest'
import { BARNUM_EN, BARNUM_JA, buildTellApart } from './tellApart'
import type { ManualJudgment } from '../types'

// Three lines, one of which is not his. See the module header: this is the only
// thing in the feature that can tell him whether his record is ABOUT HIM at all,
// rather than a set of sentences that would fit anyone alive.

const j = (id: string, text: string, tags: string[] = ['chat']): ManualJudgment => ({
  id,
  text,
  tags,
  addedAt: '2026-08-01T00:00:00.000Z',
})

const his = (n: number, tags: string[] = ['chat']) =>
  Array.from({ length: n }, (_, i) => j(`m${i}`, `本人の言葉 ${i}`, tags))

describe('buildTellApart', () => {
  it('shows three, of which exactly one is the stranger', () => {
    const check = buildTellApart(his(4), BARNUM_JA, 's')
    expect(check?.options).toHaveLength(3)
    const strangers = check!.options.filter((o) => o.id.startsWith('barnum:'))
    expect(strangers).toHaveLength(1)
    expect(check!.answerId).toBe(strangers[0].id)
    expect(check!.mineIds).toHaveLength(2)
    // The stranger's text comes from the written list, never from his record.
    expect(BARNUM_JA).toContain(strangers[0].text)
  })

  it('⚠ IS STABLE FOR THE SAME SEED — a reload must not reshuffle the question', () => {
    // Three options that change on refresh are not a question, and an answer to
    // one means nothing.
    const a = buildTellApart(his(6), BARNUM_JA, 'check-1')
    const b = buildTellApart(his(6), BARNUM_JA, 'check-1')
    expect(a).toEqual(b)
  })

  it('…and a NEW seed is a new draw', () => {
    const a = buildTellApart(his(8), BARNUM_JA, 'check-1')
    const b = buildTellApart(his(8), BARNUM_JA, 'check-2')
    expect(a).not.toEqual(b)
  })

  it('does not always put the stranger in the same slot', () => {
    // A check whose answer is always the third row is a check anyone passes
    // without reading it.
    const slots = new Set(
      Array.from({ length: 12 }, (_, i) =>
        buildTellApart(his(6), BARNUM_JA, `seed-${i}`)!.options.findIndex((o) =>
          o.id.startsWith('barnum:'),
        ),
      ),
    )
    expect(slots.size).toBeGreaterThan(1)
  })

  it('⚠ NEVER USES A COURSE FINDING AS "HIS WORDS"', () => {
    // 「静かな場所で力が出る」 came out of a scorer, not out of him. Asking him to
    // recognise it as his own sentence is a question with no true answer.
    const check = buildTellApart(
      [...his(2), j('c1', 'コースの結果', ['persona', 'big5'])],
      BARNUM_JA,
      's',
    )
    expect(check!.mineIds).not.toContain('c1')
    expect(check!.options.map((o) => o.text)).not.toContain('コースの結果')
  })

  it('⚠ RETURNS NULL rather than a question with two right answers', () => {
    // With fewer than two of his own lines the third slot would have to be a
    // second stranger — a question that cannot be failed, asked of a record too
    // small to have an opinion about.
    expect(buildTellApart(his(1), BARNUM_JA, 's')).toBeNull()
    expect(buildTellApart([], BARNUM_JA, 's')).toBeNull()
    expect(buildTellApart([j('c', 'x', ['persona', 'big5'])], BARNUM_JA, 's')).toBeNull()
  })

  it('returns null rather than inventing a stranger when there are none written', () => {
    expect(buildTellApart(his(5), [], 's')).toBeNull()
  })

  it('skips a line with no id or no words — it cannot be answered about', () => {
    const broken = [{ text: '  ', addedAt: 'x', id: 'blank' } as ManualJudgment, j('ok', 'ある')]
    expect(buildTellApart(broken, BARNUM_JA, 's')).toBeNull()
  })

  it('the two written lists stay the same length, so neither language is thinner', () => {
    expect(BARNUM_EN).toHaveLength(BARNUM_JA.length)
  })
})
