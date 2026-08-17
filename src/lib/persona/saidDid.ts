// saidDid.ts — 「言ったこと / やったこと」, split back into two columns.
//
// WHAT THIS IS. Every answer to the day's question is stored as ONE line:
//
//   Q: <the record, in its own words> \n → オーナーの回答: <what he said>
//
// Both halves are already there — the question quotes his own board (which card,
// how many days, how many times it came back), and the answer is his. But stored
// as one string it renders as one long clamped row, so the pair that is the whole
// point of the loop is invisible: what the record shows, and what he says about
// it, side by side.
//
// ⚠ NOTHING IS COMPARED, AND NOTHING IS CONCLUDED. No 「一致しています」, no
// 「食い違っています」, no score. This file splits a string in two and dates each
// half; a verdict about whether a person lives up to their own account of
// themselves is exactly the sentence this product must never generate. The two
// columns sit there and the owner reads them.
//
// ⚠ THE TWO MARKERS ARE CODE-MATCHED CONSTANTS. `personaInterview.ts` and
// `swarmEscalations.ts` write this framing byte-for-byte (deliberately: the
// corpus reads as one voice and the overseer needs no second parser). They are
// NOT translatable and not editable — a changed marker silently stops matching
// everything already on disk. The cross-check that keeps this file honest is a
// test that runs the REAL writer and parses its output.

import type { ManualJudgment } from '../types'

/** The record's half — what the observation said, frozen when it was asked. */
export const ASK_MARKER = 'Q: '
/** The owner's half. */
export const SAID_MARKER = '→ オーナーの回答: '

export interface SaidDidPair {
  id: string
  /** What the RECORD said — the observation, in the words it was asked in. */
  did: string
  /** What HE said about it. */
  said: string
  /** When he said it (the judgment's own stamp). The record's own date rides
   *  inside `did`, in the sentence the question was written with. */
  at: string
}

/** Split one stored answer into its two halves, or null when it is not one.
 *
 *  ⚠ BOTH HALVES OR NOTHING. A line with the marker but nothing after it is not
 *  a pair with an empty column — it is a line this screen has no business
 *  showing, because half of a 「言ったこと / やったこと」 is not a lighter version of
 *  the same thing, it is a different (and misleading) claim. */
export const splitSaidDid = (j: ManualJudgment): SaidDidPair | null => {
  if (!(j.tags ?? []).includes('interview')) return null
  const at = j.text.indexOf(SAID_MARKER)
  if (at < 0) return null
  const said = j.text.slice(at + SAID_MARKER.length).trim()
  // ⚠ STRIP THE MARKER BEFORE TRIMMING. Trimming first turns 「Q: 」 into 「Q:」,
  // which no longer starts with the marker — and an empty record would then be
  // shown as a pair whose left column reads 「Q:」.
  const rawDid = j.text.slice(0, at)
  const did = (rawDid.startsWith(ASK_MARKER) ? rawDid.slice(ASK_MARKER.length) : rawDid).trim()
  if (!said || !did) return null
  return { id: j.id, did, said, at: j.addedAt }
}

/** Every pair in the corpus, NEWEST FIRST — the same direction as everything
 *  else in this feature, so "recent" means one thing everywhere. */
export const saidDidPairs = (judgments: readonly ManualJudgment[]): SaidDidPair[] => {
  const out: SaidDidPair[] = []
  for (const j of judgments) {
    const pair = splitSaidDid(j)
    if (pair) out.push(pair)
  }
  return out.sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : a.at < b.at ? 1 : -1))
}
