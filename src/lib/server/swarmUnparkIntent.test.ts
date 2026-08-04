import { describe, it, expect, vi } from 'vitest'
import { readUnparkIntent, recordEscalationAnswerForNextDispatch } from './swarmOrchestrator'
import type { ProjectTask } from '@/lib/types'

// ─── the owner's choice, read from the owner's words ─────────────────────────
//
// THE FIXTURE THAT LIED (measured 2026-08-04, cycle 5). The first version of
// this file handed the intent reader a BARE answer — 'B: このまま保留' — and was
// green. Production hands it the QUEUED LINE, which is question+answer
// concatenated, and the question carries the menu:
//
//   オーナーに表示された質問…: … A: 順番待ちの列に戻して… B: このまま保留…
//   / あなたが出した元の質問: … → オーナーの回答: B: このまま保留…
//
// A scan over that finds the QUESTION's 「A:」 first, so every answer —
// including B, including plain English — resolved as resume and the card moved
// anyway. The cycle-3 must-fix was silently re-opened, and the guard could not
// see it because it never used the shape the caller actually sends.
//
// So the first block below is the LINE-SHAPED test (the one that was missing),
// and the reader is now fed the answer explicitly.

const card = (id: string, column: string): ProjectTask =>
  ({ id, title: `card ${id}`, boardColumn: column }) as unknown as ProjectTask

/** The exact concatenation swarmEscalations.deliverAnswer queues. */
const queuedLine = (plainQuestion: string, question: string, answer: string) =>
  `オーナーに表示された質問(回答はこれに対するもの): ${plainQuestion} / あなたが出した元の質問: ${question} → オーナーの回答: ${answer} — この回答を前提に再開すること`

/** The shipped S5 menu (swarmOverseer's plainQuestion template). */
const S5_MENU =
  '「決済まわりの整理」の作業が「保留」の置き場に入ったまま、30分以上動いていません。どうしますか？ ' +
  'A: 順番待ちの列に戻して、作業を再開させる B: このまま保留にしておく（勝手に動かすことはありません）'

describe('recordEscalationAnswerForNextDispatch — the PRODUCTION line shape', () => {
  const run = (answer: string, workerAddressed: boolean, unpark: () => Promise<boolean>) =>
    recordEscalationAnswerForNextDispatch(
      `/tmp/og-line-${Math.random().toString(36).slice(2)}`,
      't1',
      queuedLine(S5_MENU, 'カードが blocked のまま滞留しています', answer),
      { workerAddressed, answer },
      { fetchTasks: async () => [card('t1', 'blocked')], unpark },
    )

  it('B does NOT move the card, even though the LINE opens with the menu\'s A:', async () => {
    const unpark = vi.fn(async () => true)
    await run('B: このまま保留にしておく（勝手に動かすことはありません）', false, unpark)
    expect(unpark, 'the question\'s own menu must not be read as the owner\'s choice').not.toHaveBeenCalled()
  })

  it('A does move it (the same line shape, the other choice)', async () => {
    const unpark = vi.fn(async () => true)
    await run('A: 順番待ちの列に戻して、作業を再開させる', false, unpark)
    expect(unpark).toHaveBeenCalledTimes(1)
  })

  it('a bare B, and an English hold, are both obeyed', async () => {
    for (const answer of ['B', 'Leave it on hold, do not resume.']) {
      const unpark = vi.fn(async () => true)
      await run(answer, true, unpark)
      expect(unpark, `answer ${answer}`).not.toHaveBeenCalled()
    }
  })

  it('「そのままで大丈夫です、進めてください」 is a RESUME — it strands the worker otherwise', async () => {
    // The phrase list used to carry 'そのままで', which made this hold and left
    // the answered card in blocked forever — the exact dead end the unpark
    // exists to close.
    const unpark = vi.fn(async () => true)
    await run('そのままで大丈夫です、進めてください', true, unpark)
    expect(unpark).toHaveBeenCalledTimes(1)
  })
})

describe('readUnparkIntent — the wordings owners actually type', () => {
  it('reads the shipped menu labels', () => {
    expect(readUnparkIntent('A: 順番待ちの列に戻して、作業を再開させる')).toBe('resume')
    expect(readUnparkIntent('B: このまま保留にしておく（勝手に動かすことはありません）')).toBe('hold')
  })

  it('reads the LEADING letter in every form an owner writes it', () => {
    // MEASURED 2026-08-04 (twice). The particle list after the letter decides
    // whether the answer counts as a choice at all, and a missing particle is a
    // SILENT no-op: on an overseer-raised question 'unstated' leaves the card
    // parked, so 「Aをお願いします」 read as "no answer" and the card the owner
    // just released never moved — while the UI reported the answer delivered.
    // Every string below was checked against the real function.
    for (const a of [
      'A', 'a', 'Ａ', 'A: 戻して', 'A。', 'A、',
      'Aで', 'Aでお願いします', 'Aにします', 'A案で',
      'Aをお願いします', 'Ａをお願いします', 'A をお願いします', 'Aを選びます',
      'Aがいいです', 'Aの方針で', 'Aだね', 'Aと思います', 'A please',
    ]) {
      expect(readUnparkIntent(a), `resume form ${a}`).toBe('resume')
    }
    for (const b of [
      'B', 'b', 'Ｂ', 'B: このまま', 'B。',
      'Bで', 'Bでお願いします', 'Bにします', 'B案で',
      'Bをお願いします', 'Bがいいです', 'Bの方針で', 'Bを選びます', 'B please',
    ]) {
      expect(readUnparkIntent(b), `hold form ${b}`).toBe('hold')
    }
  })

  it('a letter buried mid-sentence is prose, not a choice', () => {
    // 'A' inside a word must not decide anything.
    expect(readUnparkIntent('Anthropic のドキュメントを見てから決めます')).toBe('unstated')
  })

  it('a leading letter that OPENS PROSE is not a choice either', () => {
    // MEASURED 2026-08-04. The old rule accepted any leading a/b followed by a
    // non-alphanumeric — so whitespace and every Japanese character passed, and
    // 「Aさんに聞いてから決めます」 resolved to RESUME (unpark). The inbox is a
    // free-text box, and a Japanese answer opening with a person's initial, or
    // an English one opening with the article "a ", is not exotic.
    expect(readUnparkIntent('Aさんに聞いてから決めます')).toBe('unstated')
    expect(readUnparkIntent('Aチームの判断を待ちます')).toBe('hold') // 待ち = a stated hold
    // "a human should look at this — leave it parked" must read as the HOLD it
    // spells out, not as option A.
    expect(readUnparkIntent('a human should look at this — leave it parked')).toBe('hold')
  })

  it('a NEGATED hold is not a hold — the resume behind it stands', () => {
    expect(readUnparkIntent('見送らずに再開してください')).toBe('resume')
    expect(readUnparkIntent('保留にせず進めてください')).toBe('resume')
  })

  it('an explicit refusal to resume IS a hold, in Japanese too', () => {
    // MEASURED 2026-08-04 (adversarial pass over my own fix). The first version
    // scrubbed negated resume words to NOTHING, which left 「再開しないで」 with
    // no decision token at all ⇒ 'unstated' ⇒ and on a worker-asked question
    // 'unstated' UNPARKS. The owner's explicit "do not" produced exactly the act
    // they refused. The English arm only ever passed because "leave it on hold,
    // do not resume" happens to carry a second hold phrase.
    for (const a of [
      '再開しないでください、こちらで対応します',
      '再開はしないでください',
      '続行しないで',
      '進めないでください',
      'do not resume',
      "don't continue for now",
    ]) {
      expect(readUnparkIntent(a), `refusal: ${a}`).toBe('hold')
    }
    expect(readUnparkIntent('再開はせず、このまま保留にして')).toBe('hold')
  })

  it('the SHORT natural holds an owner actually types are holds, not "unstated"', () => {
    // MEASURED 2026-08-04: every one of these resolved to 'unstated', and on the
    // worker-asked lane 'unstated' unparks — so an unrecognised HOLD silently
    // became a resume while an unrecognised resume was harmless. The asymmetry
    // ran the expensive way (the engine re-dispatches immediately on unpark).
    for (const a of [
      '保留で',
      'いったん止めて',
      'やらなくていい',
      '中止して',
      'キャンセルで',
      '待ってください',
      'hold off for now',
    ]) {
      expect(readUnparkIntent(a), `short hold: ${a}`).toBe('hold')
    }
  })

  it('a hold WORD inside ordinary sentence about the work is not a hold', () => {
    // MEASURED 2026-08-04, hours after the list above was widened. Adding the
    // BARE words 保留 / 中止 / キャンセル / 待って / stop / cancel made every answer
    // that merely MENTIONS the feature read as a hold — and a hold strands the
    // card. These all mean resume:
    for (const a of [
      '保留の理由は解決したので戻してください',
      '保留していた件、進めてOKです',
      '待っている間に確認しました。進めてください',
      '待っててありがとう、続きをお願いします',
      'キャンセル機能の実装はそのままで、進めてください',
      '中止条件のテストだけ直して、再開してください',
      'この作業は止めていた原因が解けたので再開して',
      'Continue — do not stop until tests pass',
      'Go ahead, the cancel button is fine',
      'Resume. The stopwatch widget is unrelated.',
      'Please continue; this is a non-stop job',
    ]) {
      expect(readUnparkIntent(a), `domain word, means resume: ${a}`).toBe('resume')
    }
  })

  it('HOLD wins when both signals survive — position is not scope', () => {
    // MEASURED 2026-08-04: under "the last decision word wins",
    // 「いまは保留にしておいて、来週になったら再開しよう」 read as RESUME and moved
    // the card NOW. A deferred resume is not a resume. Preferring hold can only
    // leave a card where the owner already put it; preferring resume overrides
    // what they said.
    expect(readUnparkIntent('いまは保留にしておいて、来週になったら再開しよう')).toBe('hold')
    expect(readUnparkIntent('保留。落ち着いたら再開します')).toBe('hold')
  })

  it('free text with no decision is "unstated" — never a guess', () => {
    expect(readUnparkIntent('')).toBe('unstated')
    expect(readUnparkIntent('ありがとう')).toBe('unstated')
  })

  it('English answers are read too (the inbox takes free text)', () => {
    expect(readUnparkIntent('please resume it')).toBe('resume')
    expect(readUnparkIntent('leave it parked for now')).toBe('hold')
  })
})
