// tellApart.ts — three lines, one of which is not his.
//
// THE QUESTION IT ASKS, AND WHY NOTHING ELSE HERE ASKS IT. Every other surface
// in this feature shows the owner what has been recorded about him. None of them
// can tell him whether that record is ABOUT HIM AT ALL — whether 「決めるのが遅い
// のは、材料が足りないとき」 is a reading of something he said or a sentence that
// would fit anyone alive. That is the Barnum problem, and it is the failure mode
// every personality product on the market ships with: a profile that feels
// accurate because it cannot fail to.
//
// So: two lines from his own record, one line written to be true of everybody,
// shuffled. If he can pick the stranger out, his record discriminates. If he
// cannot, the line he mistook is not wrong — it is INDISTINCT, which is a
// different fault and has its own remedy (直す / 取り消す, both one press away).
//
// ⚠ THE DISTRACTOR IS OURS AND WE KNOW IT. Nothing here is generated, inferred
// or scored by a model: the generic lines are written down below, so the answer
// is a fact about which array a string came from. A check whose own answer was a
// guess would be worse than no check.
//
// ⚠ COURSE FINDINGS ARE NEVER USED AS "HIS". They are the instrument's wording
// (「静かな場所で力が出る」 came out of a scorer, not out of him), so asking him to
// recognise one as his own words is a question with no true answer.

import type { ManualJudgment } from '../types'
import { groupOf } from './knownGroups'
import { personaHash } from './regions'

/** Lines written to be true of anyone. Not scraped, not generated — WRITTEN, so
 *  the answer key is a fact rather than an inference.
 *
 *  The craft is that each one has to be tempting: a platitude that reads as
 *  obviously empty tests nothing. These are modelled on Forer's 1948 sketch —
 *  a general claim, a hedge, and a flattering interior ("you have a great deal
 *  of unused capacity"), which is exactly the register a distilled belief lands
 *  in when the distillation was lazy. */
export const BARNUM_JA: readonly string[] = [
  '人には見せていないが、自分に厳しいところがある',
  '状況によって、大胆にもなるし慎重にもなる',
  '本当はもっとできるはずだと思っている',
  '人からどう見られているかは、口に出さないだけで気にしている',
  '納得できない決め方をされると、後まで引きずる',
  '一人の時間がないと、うまく回らない',
] as const

export const BARNUM_EN: readonly string[] = [
  'You are harder on yourself than you let anyone see',
  'You can be bold or careful, depending on what is at stake',
  'You suspect you have more in you than you have used',
  'You care how you come across, you just do not say so',
  'A decision made badly stays with you longer than it should',
  'You need time on your own for anything else to work',
] as const

export interface TellApartOption {
  /** The judgment's id, or `barnum:<n>` for the stranger. Never says which is
   *  which — the caller compares against `answerId`. */
  id: string
  text: string
}

export interface TellApartCheck {
  options: TellApartOption[]
  /** The id of the line that is NOT his. */
  answerId: string
  /** The ids of the two that ARE his, for the miss report. */
  mineIds: string[]
}

/** Which of his lines may be shown as his own words. */
const isHisOwn = (j: ManualJudgment): boolean => {
  const g = groupOf(j)
  return g === 'interview' || g === 'chat' || g === 'import' || g === 'corrected'
}

/** Deterministic pick-without-replacement, seeded by a string.
 *
 *  ⚠ DETERMINISTIC ON PURPOSE. The check has to survive a reload unchanged: a
 *  set of three that reshuffles when the page refreshes is not a question, and
 *  an answer to it means nothing. `seed` is the caller's — the store passes the
 *  check's own id, so a NEW check is a new draw and the same check never is. */
const pick = <T,>(items: readonly T[], count: number, seed: string): T[] => {
  const pool = [...items]
  const out: T[] = []
  for (let i = 0; i < count && pool.length > 0; i++) {
    out.push(...pool.splice(personaHash(`${seed}:${i}`) % pool.length, 1))
  }
  return out
}

/** Build one check, or NULL when the record cannot support one.
 *
 *  ⚠ NULL RATHER THAN A THINNER CHECK. With fewer than two of his own lines the
 *  only way to fill three slots is with two strangers, and 「どれが自分ではないか」
 *  then has two right answers — a question that cannot be failed, asked of a
 *  record too small to have an opinion about. */
export const buildTellApart = (
  judgments: readonly ManualJudgment[],
  barnum: readonly string[],
  seed: string,
): TellApartCheck | null => {
  const his = judgments.filter((j) => isHisOwn(j) && j.id && j.text.trim())
  if (his.length < 2 || barnum.length === 0) return null

  const mine = pick(his, 2, `${seed}:mine`)
  if (mine.length < 2) return null
  const strangerIdx = personaHash(`${seed}:barnum`) % barnum.length
  const stranger: TellApartOption = {
    id: `barnum:${strangerIdx}`,
    text: barnum[strangerIdx],
  }
  const options = pick(
    [...mine.map((j) => ({ id: j.id, text: j.text })), stranger],
    3,
    `${seed}:order`,
  )
  return { options, answerId: stranger.id, mineIds: mine.map((j) => j.id) }
}
