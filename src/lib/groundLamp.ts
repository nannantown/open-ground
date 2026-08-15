// groundLamp — what the lamp on a Ground card means, decided from the PROJECT'S
// WORK rather than from how many `claude` processes happen to be alive.
//
// THE OWNER'S SPEC, verbatim (2026-08-15), and the whole contract:
//   作業中なら running
//   何かこちらで入力しないといけないなら waiting
//   途中でとまっててもwaiting
//   全部doneなら何もなし
//
// WHY IT MOVED OFF PROCESS LIVENESS. The old lamp asked "is a `claude` alive in
// this project?", and every project running a swarm has a commander and a
// supply desk sitting at their prompts. So every such card was stamped amber
// 「あなたの番」 with every task done — reported twice, and an idle timer did not
// fix it, because a commander wakes every few minutes to read the Board and so
// is never quiet for long. A process being alive was simply never the question.
//
// NOTHING IS ALSO AN ANSWER. The owner, on why a resting project must show no
// lamp at all: 「作業が終わってて何も出さない時にuserは見にいくんですよ」 — silence is
// the signal that it is yours to look at whenever you like. A lamp that is
// always on destroys that, which is exactly what the old one did.

import type { ProjectTask } from '@/lib/types'

/** What a Ground card's lamp says.
 *
 *  `null` = no lamp at all, and it is a REAL answer: the project is resting.
 *  `'unknown'` is the one that exists to stop a lie — see `started` below. */
export type GroundLamp = 'working' | 'waiting' | 'unknown' | null

export interface GroundLampInput {
  /** How many of the project's cards were STARTED — see {@link startedTaskCount},
   *  which is the only place that decides what "started" means. Counted on the
   *  SERVER, because the client has no reason to hold every project's board.
   *
   *  ⚠ ABSENT ⇒ THE BOARD COULD NOT BE READ, which is why this is optional and
   *  why `'unknown'` exists at all. The first version treated a missing count as
   *  0 and drew nothing — and drawing nothing MEANS SOMETHING here: it is how a
   *  finished project looks. So a corrupt tasks.json would have quietly told the
   *  owner their project was done. Absent is not zero on this input either. */
  started?: number
  /** Open questions raised for THIS project that the owner has not answered.
   *  `undefined` = we could not read the inbox — which is NOT zero, and must
   *  not be turned into "nothing is waiting for you" (this repo's own
   *  FORBIDDEN SENTENCE rule). It simply contributes nothing either way. */
  openQuestions?: number
  /** Is anything ACTUALLY running for this project right now — a worker on a
   *  card, or claude mid-generation? This is the only place process state is
   *  consulted, and only to tell 作業中 apart from 途中で止まっている. */
  liveWork: boolean
}

/** Cards that mean work was STARTED. `todo` is deliberately absent: a queued
 *  card has not begun, so it is not 「途中でとまって」 anything — and lighting every
 *  project that holds a backlog is how the old lamp became furniture. */
const STARTED_COLUMNS = new Set(['doing', 'review', 'blocked'])

const isStarted = (t: ProjectTask): boolean =>
  !t.done && STARTED_COLUMNS.has(t.boardColumn ?? 'todo')

/** How many cards count as started. THE ONE DEFINITION — the server counts with
 *  it before putting a number on the wire, and the tests below exercise the lamp
 *  through it, so the column rule cannot have a second, divergent copy. */
export const startedTaskCount = (tasks: readonly ProjectTask[]): number =>
  tasks.reduce((n, t) => (isStarted(t) ? n + 1 : n), 0)

/** The lamp. Pure — every input is passed in, so all four of the owner's cases
 *  are testable without a browser, a server, or a clock. */
export const groundLamp = ({ started, openQuestions, liveWork }: GroundLampInput): GroundLamp => {
  // 1. A REAL QUESTION FOR YOU outranks everything, including running work:
  //    the swarm carrying on elsewhere does not make your answer less needed.
  //    `undefined` (inbox unreadable) is not zero and not a question — it just
  //    does not reach this branch.
  if ((openQuestions ?? 0) > 0) return 'waiting'

  // 1b. THE BOARD ITSELF IS UNREADABLE. Checked after the question branch (a
  //     question we DID read is still a question) and before everything else,
  //     because every remaining answer — including the silent one — is a claim
  //     about cards nobody could open. 'nothing' is not available as a default
  //     on this surface: it is what a finished project looks like.
  if (started === undefined) return 'unknown'

  // 4. 全部done(または積んだだけ)⇒ 何もなし。 Checked before the activity split so
  //    a stray desk process can never light a finished project.
  if (started === 0) return null

  // 2. 作業中 — something was started AND something is actually running.
  // 3. 途中でとまってても waiting — started, but nothing is moving it.
  return liveWork ? 'working' : 'waiting'
}
