import { describe, it, expect } from 'vitest'
import { SAID_MARKER, saidDidPairs, splitSaidDid } from './saidDid'
import type { ManualJudgment } from '../types'

// 「言ったこと / やったこと」 — the pair that is the whole point of the daily loop,
// stored as one string and therefore invisible until it is split back apart.
// See the module header for why nothing here compares the two halves.

const j = (over: Partial<ManualJudgment> & { id: string; text: string }): ManualJudgment => ({
  addedAt: '2026-08-01T00:00:00.000Z',
  tags: ['interview', 'card-rework'],
  ...over,
})

const answer = (record: string, said: string) => `Q: ${record}\n${SAID_MARKER}${said}`

describe('splitSaidDid', () => {
  it('splits the record from the answer, dropping both markers', () => {
    const pair = splitSaidDid(
      j({
        id: 'a',
        text: answer(
          'Board で「保留」に置いたまま動いていないカードの話です。66日前に作った…',
          '要らないと決めきれないから',
        ),
      }),
    )
    expect(pair).toEqual({
      id: 'a',
      did: 'Board で「保留」に置いたまま動いていないカードの話です。66日前に作った…',
      said: '要らないと決めきれないから',
      at: '2026-08-01T00:00:00.000Z',
    })
  })

  it('⚠ BOTH HALVES OR NOTHING', () => {
    // Half of a 「言ったこと / やったこと」 is not a lighter version of the same
    // thing — it is a different, and misleading, claim.
    expect(splitSaidDid(j({ id: 'a', text: answer('記録', '   ') }))).toBeNull()
    expect(splitSaidDid(j({ id: 'b', text: `Q: \n${SAID_MARKER}答え` }))).toBeNull()
  })

  it('ignores a line that is not an answer to a question at all', () => {
    expect(splitSaidDid(j({ id: 'a', text: '普通の一文', tags: ['chat'] }))).toBeNull()
    // …including one tagged `interview` that somehow carries no marker.
    expect(splitSaidDid(j({ id: 'b', text: '目印のない行' }))).toBeNull()
  })

  it('does not treat a CHAT line that quotes the marker as an answer', () => {
    // The tag is what says where a line came from; the marker alone is text the
    // owner could have pasted.
    expect(
      splitSaidDid(j({ id: 'a', text: answer('記録', '答え'), tags: ['chat'] })),
    ).toBeNull()
  })

  it('keeps a multi-line answer whole', () => {
    const pair = splitSaidDid(j({ id: 'a', text: answer('記録', '一行目\n二行目') }))
    expect(pair?.said).toBe('一行目\n二行目')
  })
})

describe('saidDidPairs', () => {
  it('returns the pairs NEWEST FIRST and skips everything else', () => {
    const pairs = saidDidPairs([
      j({ id: 'old', text: answer('記録1', '答え1'), addedAt: '2026-08-01T00:00:00.000Z' }),
      j({ id: 'plain', text: 'ただの一文', tags: ['chat'] }),
      j({ id: 'new', text: answer('記録2', '答え2'), addedAt: '2026-08-14T00:00:00.000Z' }),
    ])
    expect(pairs.map((p) => p.id)).toEqual(['new', 'old'])
  })

  it('an empty corpus is an empty list', () => {
    expect(saidDidPairs([])).toEqual([])
  })
})
