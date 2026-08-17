// personaTellApart.ts — the store behind 「どれが自分ではないか」.
//
// WHAT IT IS FOR (the rule the rest of this feature cannot check on itself):
// every other surface shows the owner what has been recorded about him; none of
// them can tell him whether that record is ABOUT HIM at all rather than a set of
// sentences that would fit anyone. src/lib/persona/tellApart.ts builds the
// question — two of his own lines and one written to be true of everybody. This
// file decides WHEN it is asked, keeps it stable while it is on screen, and
// records what happened.
//
// ⚠ IT WRITES NOTHING TO THE CORPUS, EVER. A check is not a belief: getting one
// wrong does not make a line false, it makes it INDISTINCT, and the remedy for
// that is 直す / 取り消す — both already one press away on the line itself. A
// detector that edited the record it was auditing would be the last thing this
// feature should ship.

import { readFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { atomicWriteJson } from './atomicWrite'
import { ensureOpenGroundHome, personaTellApartFile } from './paths'
import { readLiveJudgments } from './youCorpus'
import { getPromptLang } from './promptLang'
import { BARNUM_EN, BARNUM_JA, buildTellApart, type TellApartCheck } from '@/lib/persona/tellApart'
import type { PersonaTellApartCheck, PersonaTellApartResult } from '@/lib/types'

const FILE_MODE = 0o600

const isMissingFileError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** How many NEW lines have to arrive before the check is offered again.
 *
 *  ⚠ MEASURED IN MATERIAL, NOT IN DAYS. The question is whether the record can
 *  be told apart from a stranger's; asking it again on an unchanged record asks
 *  the same question of the same material and learns nothing. Ten is the plan's
 *  「10問ごと」 read against the thing that actually changes. */
export const TELL_APART_EVERY = 10

/** How many misses are kept. A cap, because this list is a hint about which
 *  lines to look at, not a record the owner is accountable to. */
const MISS_CAP = 40

interface TellApartState {
  version: 1
  /** The check currently on screen, frozen. Null ⇒ none is open. */
  current: (TellApartCheck & { id: string; askedAt: string }) | null
  /** How large the live corpus was when the last check was RAISED. */
  sizeAtLast: number
  /** Lines he could not tell apart from a stranger. Newest last. */
  misses: { judgmentId: string; at: string }[]
  answered: number
}

const emptyState = (): TellApartState => ({
  version: 1,
  current: null,
  sizeAtLast: 0,
  misses: [],
  answered: 0,
})

const readState = async (): Promise<TellApartState> => {
  let raw: string
  try {
    raw = await readFile(personaTellApartFile(), 'utf8')
  } catch (err) {
    // ⚠ A CHECK IS NOT IRREPLACEABLE. Unlike the corpus, losing this file costs
    // one question and a hint list — so an unreadable one starts fresh (loudly)
    // rather than failing the screen it rides on.
    if (!isMissingFileError(err)) {
      console.error('[openground:persona-tell-apart] state unreadable — starting fresh', err)
    }
    return emptyState()
  }
  try {
    const p = JSON.parse(raw) as Partial<TellApartState>
    return {
      version: 1,
      current: p.current ?? null,
      sizeAtLast: typeof p.sizeAtLast === 'number' ? p.sizeAtLast : 0,
      misses: Array.isArray(p.misses) ? p.misses : [],
      answered: typeof p.answered === 'number' ? p.answered : 0,
    }
  } catch {
    console.error('[openground:persona-tell-apart] state corrupt — starting fresh')
    return emptyState()
  }
}

const writeState = async (state: TellApartState): Promise<void> => {
  await ensureOpenGroundHome()
  await atomicWriteJson(personaTellApartFile(), state, { mode: FILE_MODE })
}

/** The wire shape: the three lines and nothing else.
 *
 *  ⚠ THE ANSWER NEVER LEAVES THE SERVER. Sending `answerId` to the browser would
 *  put the answer to 「どれが自分ではないか」 in the page the question is asked on —
 *  and this is a tool for finding out something true about yourself, so the one
 *  reader who must not be able to peek is the owner. */
const toWire = (c: TellApartCheck & { id: string }): PersonaTellApartCheck => ({
  id: c.id,
  options: c.options.map((o) => ({ id: o.id, text: o.text })),
})

/** The check to show, generating one only when the record has grown enough.
 *
 *  ⚠ A POST, LIKE THE DAILY QUESTION, because it can WRITE. `current` is frozen
 *  on disk the moment it is drawn, so a reload re-reads the same three lines
 *  rather than dealing a new hand — three options that reshuffle on refresh are
 *  not a question, and an answer to one means nothing. */
export const nextTellApart = async (deps: {
  judgments?: typeof readLiveJudgments
  lang?: typeof getPromptLang
} = {}): Promise<PersonaTellApartCheck | null> => {
  const state = await readState()
  if (state.current) return toWire(state.current)

  const live = await (deps.judgments ?? readLiveJudgments)()
  if (live.length < state.sizeAtLast + TELL_APART_EVERY) return null

  const lang = await (deps.lang ?? getPromptLang)()
  const id = randomUUID()
  const built = buildTellApart(live, lang === 'ja' ? BARNUM_JA : BARNUM_EN, id)
  if (!built) {
    // Not enough of HIS OWN lines yet (course findings do not count — see
    // tellApart.ts). ⚠ `sizeAtLast` is NOT moved: the record has not been
    // checked, and pretending it has would silence the next ten lines too.
    return null
  }
  const current = { ...built, id, askedAt: new Date().toISOString() }
  await writeState({ ...state, current })
  return toWire(current)
}

/** Answer it. Returns what was true, never a score.
 *
 *  ⚠ THE MISS IS RECORDED AGAINST THE LINE HE MISTOOK, not against him. What it
 *  means is that this line reads like something anyone would say — which is a
 *  fact about the sentence, and fixable by rewriting or withdrawing it. */
export const answerTellApart = async (
  checkId: string,
  optionId: string,
): Promise<PersonaTellApartResult | null> => {
  const state = await readState()
  const current = state.current
  // A stale tab answering a question that is already gone must not be able to
  // record anything — including against the current check, which it never saw.
  if (!current || current.id !== checkId) return null

  const correct = optionId === current.answerId
  const picked = current.options.find((o) => o.id === optionId) ?? null
  const at = new Date().toISOString()
  // ⚠ ONE GATE, NOT TWO. This used to also branch on `correct`, which made the
  // membership test below unobservable: either check alone kept a right answer
  // out of the miss list, so neither could be broken by a test. Membership is
  // the one that carries real information — picking the stranger is the right
  // answer and its id is in no one's list, and a stale or mistyped payload must
  // not land here as a judgment that does not exist.
  const misses = [
    ...state.misses,
    ...(picked && current.mineIds.includes(picked.id) ? [{ judgmentId: picked.id, at }] : []),
  ].slice(-MISS_CAP)

  const live = await readLiveJudgments()
  await writeState({
    ...state,
    current: null,
    // Measured AFTER answering, so the next check waits for ten lines that
    // arrived since this one — not since the last time the file was written.
    sizeAtLast: live.length,
    misses,
    answered: state.answered + 1,
  })
  return {
    correct,
    // The line he mistook — only when he DID mistake one. On a right answer
    // `picked` is the stranger, and reporting it here would print the owner's
    // own 「これはあなたの言葉でした」 over a sentence that is nobody's.
    ...(picked && !correct ? { mistookText: picked.text } : {}),
    // The stranger's own words, so a wrong answer ends by SHOWING what a
    // sentence-that-fits-anyone looks like beside his own.
    strangerText: current.options.find((o) => o.id === current.answerId)?.text ?? '',
  }
}

/** 「あとで」. Clears the check and pushes the next one out by the same ten lines,
 *  so declining is not punished with the same question on the next screen. */
export const skipTellApart = async (checkId: string): Promise<boolean> => {
  const state = await readState()
  if (!state.current || state.current.id !== checkId) return false
  const live = await readLiveJudgments()
  await writeState({ ...state, current: null, sizeAtLast: live.length })
  return true
}

/** The ids of lines that were mistaken for a stranger's. Read by nothing yet on
 *  the screen — exported so the list can mark them without this file having to
 *  learn what a screen is. */
export const tellApartMisses = async (): Promise<string[]> => {
  const state = await readState()
  return Array.from(new Set(state.misses.map((m) => m.judgmentId)))
}
