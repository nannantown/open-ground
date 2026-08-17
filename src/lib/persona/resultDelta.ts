// resultDelta.ts — what moved between two takes of the same instrument.
//
// WHY THIS EXISTS. A self-report taken once is a snapshot presented as a fact.
// The same instrument taken twice is the only thing on this surface that can
// show CHANGE — and change is the one claim a personality result is actually
// entitled to make about a person, because it is a difference between two of
// their own answers rather than a verdict about who they are. Until now the
// takes strip let the owner walk back through earlier sheets and compare them by
// memory, which is precisely the comparison memory is worst at.
//
// ⚠ IT COMPUTES A DIFFERENCE AND SAYS NOTHING ABOUT IT. No threshold, no
// 「大きく変わりました」, no arrow that means "improved" — this file has no basis
// for any of that. A five-item self-report wobbles by a whole step on a bad
// morning, and a product that calls that wobble a finding is inventing exactly
// the kind of story the rest of this feature refuses to tell. Both numbers are
// printed; the reading is the owner's.
//
// PURE. The sheet renders what it is handed and does no arithmetic of its own
// (see PersonaResultSheet's header) — so the arithmetic lives here, where a test
// can see it.

import type { PersonaResult, PersonaResultRow } from '../types'

export interface DeltaRow {
  key: string
  name: string
  /** bars: 0..100 fill. rank: the position (1 = top). Null ⇒ that take did not
   *  carry a number for this row, which is NOT zero and NOT last place. */
  before: number | null
  after: number | null
  /** Signed movement, or null when either side has no number.
   *
   *  ⚠ THE SIGN MEANS "UP" IN THE ROW'S OWN TERMS: for bars, more of the thing;
   *  for a rank, nearer the top (so a move from 3rd to 1st is +2). Without this
   *  flip the same +2 would mean opposite things on two sheets of the same app. */
  moved: number | null
}

export interface ResultDelta {
  kind: 'bars' | 'rank'
  rows: DeltaRow[]
  /** Rows the instrument has NOW and did not have then, and vice versa. Named
   *  rather than silently dropped: an instrument that changed between two takes
   *  is the one thing that would make a delta table quietly wrong. */
  onlyNow: string[]
  onlyBefore: string[]
}

const numberOf = (row: PersonaResultRow, kind: 'bars' | 'rank'): number | null => {
  const v = kind === 'bars' ? row.pct : row.rank
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** The movement between two takes, or NULL when they cannot honestly be
 *  compared at all — a different instrument, or the same instrument rescored
 *  into a different shape. Returning an empty delta for those would put an
 *  empty 「動いたところ」 heading on screen over two results that were never
 *  comparable. */
export const resultDelta = (now: PersonaResult, before: PersonaResult): ResultDelta | null => {
  if (now.courseId !== before.courseId) return null
  if (now.kind !== before.kind) return null

  const kind = now.kind
  const wasByKey = new Map(before.rows.map((r) => [r.key, r]))
  const nowKeys = new Set(now.rows.map((r) => r.key))

  const rows: DeltaRow[] = now.rows.map((r) => {
    const was = wasByKey.get(r.key)
    const after = numberOf(r, kind)
    const beforeVal = was ? numberOf(was, kind) : null
    const moved =
      beforeVal === null || after === null
        ? null
        : kind === 'rank'
          ? beforeVal - after
          : after - beforeVal
    return { key: r.key, name: r.name, before: beforeVal, after, moved }
  })

  return {
    kind,
    rows,
    onlyNow: now.rows.filter((r) => !wasByKey.has(r.key)).map((r) => r.name),
    onlyBefore: before.rows.filter((r) => !nowKeys.has(r.key)).map((r) => r.name),
  }
}
