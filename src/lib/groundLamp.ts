// groundLamp — what the lamp on a Ground card means, decided from the PROJECT'S
// WORK rather than from how many `claude` processes happen to be alive.
//
// THE OWNER'S SPEC — 2026-08-15 verbatim, AMENDED 2026-08-18:
//   作業中なら running
//   何かこちらで入力しないといけないなら waiting
//   全部doneなら何もなし
//
// The 2026-08-15 spec had a fourth line — 「途中でとまっててもwaiting」 — and it
// was RETIRED by the owner on 2026-08-18: 「waitingは僕が何かをしないといけない
// 時にだけ出しましょう」, said over a board whose only open cards were three
// long-parked Needs-decision items lighting the card amber for weeks. Stalled
// or parked work is the MACHINE's problem first: the engine reclaims dead
// workers on its own, and the moment it genuinely needs the owner it raises an
// escalation — which lands in the question inbox and lights WAITING (since
// 2026-09-26: 'question') through the one branch that survives. So amber now
// means exactly one thing: there is a question only you can answer.
//
// WHY IT MOVED OFF PROCESS LIVENESS. The old lamp asked "is a `claude` alive in
// this project?", and every project running a swarm has a commander and a
// supply desk sitting at their prompts. So every such card was stamped amber
// 「あなたの番」 with every task done — reported twice, and an idle timer did not
// fix it, because a commander wakes every few minutes to read the Board and so
// is never quiet for long. A process being alive was simply never the question.
//
// QUESTION vs REVIEW — 2026-09-26, owner: 「ただ終わって僕が確認待ちなのか、質問が
// あって僕が答えないといけないのかっていうのがわかるようにしたい」. The old amber
// 'waiting' became 'question' (drawn as a raised hand, never an emoji):
//   question — an open escalation only the owner can answer (stays until it is
//              answered), OR the president's latest reply TO THE OWNER'S OWN
//              WORDS closed on a question, the owner has not spoken since, and
//              has not opened its seat since. App notices typed into the desk
//              (【エンジンからの知らせ】 / 【司令官からの返事】) and the president's
//              retelling of them neither raise nor clear it: the retelling of a
//              delivery ends 「これで OK ですか?」 (that must be the eye, not the
//              hand), while a re-ask 「…まだお返事を待っています。進めてよいですか？」
//              must not erase the real question. Rule + real-transcript
//              measurements: stepPresidentAsk in src/lib/server/groundMarks.ts.
//   review   — work landed on main (the engine's landed ledger) after the owner
//              last opened the president's seat (drawn as an eye). Just look.
// The president's hand clears when the owner opens the agent-team bar (the
// president's seat — POST /api/ground/seen stamps seenAt); an open escalation
// clears only by answering it. The EYE clears when the owner merely OPENS THE
// PROJECT (2026-09-26, 「プロジェクトの中に入ったら、既読みたいな感じ」 — POST
// /api/ground/opened stamps openedAt; there is no button to press). Opening the
// project never clears a hand. With no stamp on record there is no baseline,
// so the timed mark does not light — a mark only a visit nobody has made yet
// could clear would be furniture again.
// Precedence: question > running > review > unknown > nothing.
//
// RUNNING = THE PROJECT'S WORK IS NOT FINISHED — 2026-09-26, owner: 「ワーカーとか
// が動いてたりマネージャーが動いてるんだったら、そのタスクがまだ終わってなくて、その
// レビュー待ちとか受け渡しの最中なんだったらそれはランニングだよね」. Before this the
// lamp needed a started card AND a live generating claude, so it went dark while
// a card sat in review / was being handed over (a worker finished, the commander
// not yet integrating) — the card read "resting" mid-delivery. Now running is
// lit by any of: an unfinished card in doing / review (inFlightTaskCount); a
// non-draft todo card while the project's autopilot (swarm engine) is on — it
// is about to move; a worker / the owner's pane generating on a started board;
// the commander or the president generating. NOT by blocked cards alone: parked
// work stays dark (the 2026-08-18 retirement below). This supersedes the
// 2026-08-17 "desks do not count" rule FOR THE COMMANDER (the owner named it);
// a desk idle at its prompt still lights nothing.
//
// NOTHING IS ALSO AN ANSWER. The owner, on why a resting project must show no
// lamp at all: 「作業が終わってて何も出さない時にuserは見にいくんですよ」 — silence is
// the signal that it is yours to look at whenever you like. A lamp that is
// always on destroys that, which is exactly what the old one did — and what
// the retired stalled-work branch was quietly doing again through the
// Needs-decision column.

import type { ProjectTask } from '@/lib/types'
import { isDispatchableCard } from '@/lib/dispatchGate'

/** What a Ground card's lamp says.
 *
 *  `null` = no lamp at all, and it is a REAL answer: the project is resting.
 *  `'unknown'` is the one that exists to stop a lie — see `started` below. */
export type GroundLamp = 'working' | 'question' | 'review' | 'unknown' | null

export interface GroundLampInput {
  /** Unfinished work that keeps the lamp RUNNING by itself — see
   *  {@link inFlightTaskCount}. Counted from the same board read as `started`.
   *  ⚠ ABSENT ⇒ THE BOARD COULD NOT BE READ ⇒ `'unknown'` (see `started`). */
  inFlight?: number
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
  /** The PRESIDENT (supply desk, 社長) is generating in this project right now.
   *  Owner, 2026-09-25: 「社長も動いてたら…ランニングって出るようにしてほしいな」.
   *  Only mid-turn counts — a president idle at its prompt is absent/false and
   *  changes nothing (the 2026-08-15 rule: alive is not a lamp). */
  presidentWorking?: boolean
  /** The COMMANDER (司令官) is generating in this project right now — owner,
   *  2026-09-26: 「マネージャーが動いてるんだったら…ランニング」. Mid-turn only. */
  commanderWorking?: boolean
  /** Epoch ms the president ended its last reply with a question (absent ⇒ not
   *  asking). Lights 'question' only when newer than `seenAt`. */
  presidentAskedAt?: number
  /** Epoch ms of the latest landed card. Lights 'review' when newer than `seenAt`. */
  deliveredAt?: number
  /** Epoch ms the owner last opened this project's president seat. */
  seenAt?: number
  /** Epoch ms the owner last had this PROJECT open (any tab). Clears the eye
   *  only — never a hand. */
  openedAt?: number
}

/** An event the owner has not seen yet. No seenAt ⇒ no baseline ⇒ never. */
const unseen = (at: number | undefined, seenAt: number | undefined): boolean =>
  at !== undefined && seenAt !== undefined && at > seenAt

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

/** Work that is NOT FINISHED and keeps the project running (2026-09-26): an
 *  unfinished card in doing (being worked) or review (awaiting the commander's
 *  check / being handed over to main), plus — only while the autopilot is on —
 *  a todo card the engine WILL start — the engine's own per-card gates
 *  (isDispatchableCard: not a draft, has a body, not an unapproved self-supply
 *  proposal) and no unfinished prerequisite. A title-only memo card is never
 *  dispatched, so counting it held a project running forever (rework 1,
 *  2026-09-26). A card waiting on a prerequisite is left to that prerequisite:
 *  if it is moving it lights running itself; if it is parked, nothing will
 *  start this one either. With the autopilot off a todo card is a backlog
 *  nobody is moving. Blocked cards never count: parked work lights nothing
 *  (2026-08-18). */
export const inFlightTaskCount = (
  tasks: readonly ProjectTask[],
  { autopilot }: { autopilot: boolean },
): number => {
  // "done" for a prerequisite = the done COLUMN, exactly as selectDispatch reads it.
  const doneIds = new Set(
    tasks.filter((t) => (t.boardColumn ?? (t.done ? 'done' : 'todo')) === 'done').map((t) => t.id),
  )
  const ids = new Set(tasks.map((t) => t.id))
  // Same prerequisite rule as selectDispatch ⑤: an id absent from the board is satisfied.
  const prereqsMet = (t: ProjectTask) =>
    (Array.isArray(t.dependsOn) ? t.dependsOn : []).every((id) => !ids.has(id) || doneIds.has(id))
  return tasks.reduce((n, t) => {
    if (t.done) return n
    const col = t.boardColumn ?? 'todo'
    const moving =
      col === 'doing' ||
      col === 'review' ||
      (autopilot && col === 'todo' && isDispatchableCard(t) && prereqsMet(t))
    return moving ? n + 1 : n
  }, 0)
}

/** The lamp. Pure — every input is passed in, so all four of the owner's cases
 *  are testable without a browser, a server, or a clock. */
export const groundLamp = ({
  inFlight,
  started,
  openQuestions,
  liveWork,
  presidentWorking,
  commanderWorking,
  presidentAskedAt,
  deliveredAt,
  seenAt,
  openedAt,
}: GroundLampInput): GroundLamp => {
  // 1. A REAL QUESTION FOR YOU outranks everything, including running work:
  //    the swarm carrying on elsewhere does not make your answer less needed.
  //    `undefined` (inbox unreadable) is not zero and not a question — it just
  //    does not reach this branch.
  if ((openQuestions ?? 0) > 0) return 'question'

  // 1a. THE PRESIDENT IS MID-TURN (2026-09-25). The owner asked it something and
  //     it is answering — that is work, whatever the board says: a project with
  //     no started card, or a board we could not read, is still visibly moving.
  //     Below the question branch, so waiting still outranks running.
  if (presidentWorking) return 'working'

  // 1c. THE PRESIDENT IS WAITING ON YOUR ANSWER (2026-09-26): its last reply to
  //     you has a question in its final paragraph and you have not opened its
  //     seat since — opening the PROJECT does not clear it (openedAt is not
  //     read here). Below presidentWorking: a president mid-turn has not
  //     finished asking.
  if (unseen(presidentAskedAt, seenAt)) return 'question'

  // 2. 作業中 — the work is not finished (see the header). Outranks "come and
  //    look": the delivery is not going away. A live process on a board with
  //    nothing started is NOT work (a stray pane cannot light a finished
  //    project), hence `started > 0` beside liveWork.
  if ((inFlight ?? 0) > 0 || commanderWorking || ((started ?? 0) > 0 && liveWork)) return 'working'

  // 1e. DELIVERED WHILE YOU WERE AWAY (2026-09-26): look, nothing to answer.
  //     Either stamp is a look — opening the seat means the project was open,
  //     and an older ground-seen.json predates openedAt. Above 'unknown' — the
  //     landed ledger is its own file and was read.
  const looked =
    seenAt === undefined ? openedAt : openedAt === undefined ? seenAt : Math.max(seenAt, openedAt)
  if (unseen(deliveredAt, looked)) return 'review'

  // 1b. THE BOARD ITSELF IS UNREADABLE. Checked after the branches that did not
  //     need it, because every remaining answer — including the silent one — is
  //     a claim about cards nobody could open. 'nothing' is not available as a
  //     default on this surface: it is what a finished project looks like.
  if (inFlight === undefined) return 'unknown'

  // 3. 全部done / 積んだだけ(自動運転 off) / 保留(blocked)だけ ⇒ 何もなし. Parked
  //    work is not a demand on the owner — this used to be the 「途中でとまってても
  //    waiting」 branch (see the header): parked Needs-decision cards sit in their
  //    own column saying so, a stalled worker is reclaimed by the engine, and
  //    anything that truly needs a human arrives as a question above.
  return null
}

/** Window event fired after stamping POST /api/ground/seen or /opened
 *  (useGroundLook), so App re-polls the lamps at once instead of on its next
 *  5s tick. */
export const GROUND_SEEN_EVENT = 'og:ground-seen'
