import { describe, it, expect } from 'vitest'
import { groundLamp, inFlightTaskCount, startedTaskCount } from './groundLamp'
import type { ProjectTask } from '@/lib/types'

// The owner's spec — 2026-08-15 verbatim, amended 2026-08-18 — one guard per line:
//   作業中なら running
//   何かこちらで入力しないといけないなら waiting
//   全部doneなら何もなし
// The old fourth line (「途中でとまっててもwaiting」) was retired by the owner:
// 「waitingは僕が何かをしないといけない時にだけ出しましょう」. Amber = a question
// in the inbox, and nothing else.

const task = (over: Partial<ProjectTask> = {}): ProjectTask =>
  ({ id: 't1', title: 'card', done: false, boardColumn: 'todo', ...over }) as ProjectTask

/** The lamp, reached the way production reaches it: the column rule runs in
 *  `startedTaskCount` (server-side in production, where the boards live) and the
 *  lamp sees only the number. Going through it here is deliberate — it keeps
 *  every case below a test of the REAL rule rather than of a count typed by
 *  hand, which is what a split like this usually costs. */
const lamp = (
  tasks: readonly ProjectTask[],
  {
    autopilot = false,
    ...rest
  }: {
    openQuestions?: number
    liveWork: boolean
    presidentWorking?: boolean
    commanderWorking?: boolean
    autopilot?: boolean
  },
) =>
  groundLamp({
    started: startedTaskCount(tasks),
    inFlight: inFlightTaskCount(tasks, { autopilot }),
    ...rest,
  })

describe('groundLamp — the four cases the owner specified', () => {
  it('作業中なら running', () => {
    expect(lamp([task({ boardColumn: 'doing' })], { liveWork: true })).toBe('working')
  })

  it('何かこちらで入力しないといけないなら waiting — even while other work runs', () => {
    // A question for you is not made less urgent by the swarm carrying on.
    expect(lamp([task({ boardColumn: 'doing' })], { openQuestions: 1, liveWork: true })).toBe(
      'question',
    )
  })

  it('parked (blocked-only) work shows NO lamp — waiting is only ever a question (2026-08-18)', () => {
    // The owner's amendment, measured on their own board: three long-parked
    // Needs-decision cards held the card amber for weeks. Parked or stalled
    // work is the machine's problem first (the engine reclaims dead workers);
    // when it truly needs a human it raises an escalation, which lights
    // WAITING through the inbox branch — the only branch allowed to.
    // 2026-09-26 kept this for blocked: 「保留 blocked だけのときは含めない」.
    expect(lamp([task({ boardColumn: 'blocked' })], { liveWork: false })).toBeNull()
    expect(lamp([task({ boardColumn: 'blocked' })], { liveWork: false, autopilot: true })).toBeNull()
  })

  it('…and a question over that same idle board DOES light waiting', () => {
    // The pair that keeps the retirement honest: the same three parked cards
    // plus one unanswered question is amber — the question, not the cards.
    expect(lamp([task({ boardColumn: 'blocked' })], { openQuestions: 1, liveWork: false })).toBe(
      'question',
    )
  })

  it('全部done なら何もなし', () => {
    expect(
      lamp(
        [
          task({ id: 'a', done: true, boardColumn: 'done' }),
          task({ id: 'b', done: true, boardColumn: 'done' }),
        ],
        { liveWork: false },
      ),
    ).toBeNull()
  })

  it('積んだだけ(todo)なら何もなし — silence is the invitation to go look', () => {
    // 「作業が終わってて何も出さない時にuserは見にいくんですよ」 — a card queued and
    // not started has not stalled, and lighting every project with a backlog is
    // how the previous lamp became furniture nobody read.
    expect(lamp([task(), task({ id: 'b' }), task({ id: 'c' })], { liveWork: false })).toBeNull()
    // …and a live process does NOT invent work out of a queue.
    expect(lamp([task()], { liveWork: true })).toBeNull()
  })
})

describe('groundLamp — what it refuses to claim', () => {
  it('a finished project stays dark even with something running (a desk)', () => {
    // THE REPORTED BUG, in one line. Every project running a swarm holds a
    // commander/supply desk; the old lamp counted them and stamped every card
    // amber with every task done.
    expect(lamp([task({ done: true, boardColumn: 'done' })], { liveWork: true })).toBeNull()
  })

  it('an UNREADABLE question inbox is not zero and not a question', () => {
    // `undefined` must not become 「あなたを待っているものはありません」 (the repo's
    // FORBIDDEN SENTENCE rule) nor a phantom question. It contributes nothing:
    // the verdict falls through to the board state alone.
    expect(lamp([task({ boardColumn: 'doing' })], { openQuestions: undefined, liveWork: true })).toBe(
      'working',
    )
    expect(
      lamp([task({ done: true, boardColumn: 'done' })], {
        openQuestions: undefined,
        liveWork: false,
      }),
    ).toBeNull()
  })

  it('a DONE card parked in a started column is still done', () => {
    // `done` wins over the column: a card marked done but never dragged out of
    // review must not hold a project amber forever.
    expect(lamp([task({ done: true, boardColumn: 'review' })], { liveWork: false })).toBeNull()
  })

  it('no cards at all ⇒ no lamp', () => {
    expect(lamp([], { liveWork: true })).toBeNull()
    expect(lamp([], { liveWork: false })).toBeNull()
  })

  it('a missing boardColumn reads as todo, not as started', () => {
    // Old cards predate the column field; treating them as in-flight would
    // light every legacy project.
    expect(lamp([task({ boardColumn: undefined })], { liveWork: false })).toBeNull()
  })
})

describe('startedTaskCount — the one definition of "started"', () => {
  // It now crosses a wire (the server counts, the client lights the lamp), so
  // the count itself is worth pinning: a drift here is a lamp that is wrong on
  // every card at once, with nothing on screen to suggest why.
  it('counts only unfinished cards in doing / review / blocked', () => {
    expect(
      startedTaskCount([
        task({ id: 'a', boardColumn: 'doing' }),
        task({ id: 'b', boardColumn: 'review' }),
        task({ id: 'c', boardColumn: 'blocked' }),
        task({ id: 'd', boardColumn: 'todo' }),
        task({ id: 'e', boardColumn: 'done' }),
        task({ id: 'f', boardColumn: 'doing', done: true }),
        task({ id: 'g', boardColumn: undefined }),
      ]),
    ).toBe(3)
  })

  it('is 0 for an empty board', () => {
    expect(startedTaskCount([])).toBe(0)
  })
})

describe('groundLamp — an unreadable board is its own answer', () => {
  // ⚠ THE ONE THAT LOOKS LIKE IT DOES NOT MATTER. Every other "absent is not
  // zero" case in this app shows a wrong NUMBER when it is got wrong. Here the
  // wrong answer is SILENCE — and silence is what a finished project looks
  // like, so defaulting a missing count to 0 tells the owner their work is done
  // from a file nobody opened. It has to be a distinct state.
  it('says unknown, not nothing, when the board could not be read', () => {
    expect(groundLamp({ liveWork: false })).toBe('unknown')
    expect(groundLamp({ liveWork: true })).toBe('unknown')
    expect(groundLamp({ started: undefined, openQuestions: 0, liveWork: false })).toBe('unknown')
  })

  it('is never confused with a genuinely empty board', () => {
    expect(groundLamp({ started: 0, inFlight: 0, liveWork: false })).toBeNull()
    expect(groundLamp({ started: 0, inFlight: 0, liveWork: true })).toBeNull()
  })

  it('a question we DID read still outranks a board we did not', () => {
    // The inbox and the board are separate reads. Failing to open one does not
    // make the other's answer less true, and an unanswered question is the one
    // thing on this card that is genuinely waiting on the owner.
    expect(groundLamp({ openQuestions: 1, liveWork: false })).toBe('question')
  })
})

// Owner, 2026-09-25: 「社長も動いてたら…ランニングって出るようにしてほしいな」.
describe('groundLamp — the president (supply desk) mid-turn', () => {
  it('a GENERATING president lights running even with nothing started', () => {
    expect(lamp([], { liveWork: false, presidentWorking: true })).toBe('working')
    expect(lamp([task({ done: true, boardColumn: 'done' })], { liveWork: false, presidentWorking: true })).toBe(
      'working',
    )
    expect(lamp([task()], { liveWork: false, presidentWorking: true })).toBe('working')
  })

  it('an IDLE president changes nothing (alive is not a lamp — 2026-08-15)', () => {
    expect(lamp([], { liveWork: false, presidentWorking: false })).toBeNull()
    expect(lamp([task({ boardColumn: 'blocked' })], { liveWork: false, presidentWorking: false })).toBeNull()
    expect(lamp([task({ boardColumn: 'blocked' })], { liveWork: true, presidentWorking: false })).toBe('working')
  })

  it('a question for the owner still outranks the president working', () => {
    expect(lamp([], { openQuestions: 1, liveWork: false, presidentWorking: true })).toBe('question')
  })
})

// The owner's 2026-09-26 split: 「ただ終わって僕が確認待ちなのか、質問があって僕が
// 答えないといけないのか」. question = a raised hand, review = an eye.
describe('groundLamp — question vs review, cleared by a look (2026-09-26)', () => {
  const SEEN = 1_000_000
  const idle = { started: 0, inFlight: 0, liveWork: false }

  it('the president ending on a question you have not seen ⇒ question', () => {
    expect(groundLamp({ ...idle, presidentAskedAt: SEEN + 1, seenAt: SEEN })).toBe('question')
  })

  it('work delivered after your last look ⇒ review', () => {
    expect(groundLamp({ ...idle, deliveredAt: SEEN + 1, seenAt: SEEN })).toBe('review')
  })

  it('opening the seat (seenAt moves past both) clears them', () => {
    expect(groundLamp({ ...idle, presidentAskedAt: SEEN, deliveredAt: SEEN, seenAt: SEEN + 1 })).toBeNull()
  })

  it('both at once ⇒ question wins', () => {
    expect(
      groundLamp({ ...idle, presidentAskedAt: SEEN + 1, deliveredAt: SEEN + 2, seenAt: SEEN }),
    ).toBe('question')
  })

  it('no look ever recorded ⇒ no baseline ⇒ neither timed mark (never furniture)', () => {
    expect(groundLamp({ ...idle, presidentAskedAt: SEEN, deliveredAt: SEEN })).toBeNull()
  })

  it('an open escalation stays a question after a look — it is cleared by answering it', () => {
    expect(groundLamp({ ...idle, openQuestions: 1, seenAt: SEEN + 1 })).toBe('question')
  })

  it('running work outranks review; review outranks an unreadable board', () => {
    expect(groundLamp({ started: 1, liveWork: true, deliveredAt: SEEN + 1, seenAt: SEEN })).toBe('working')
    expect(groundLamp({ liveWork: false, deliveredAt: SEEN + 1, seenAt: SEEN })).toBe('review')
  })

  it('a president mid-turn is working, not yet asking', () => {
    expect(
      groundLamp({ ...idle, presidentWorking: true, presidentAskedAt: SEEN + 1, seenAt: SEEN }),
    ).toBe('working')
  })
})

// Owner, 2026-09-26: 「ワーカーとかが動いてたりマネージャーが動いてるんだったら、そのタスク
// がまだ終わってなくて、そのレビュー待ちとか受け渡しの最中なんだったらそれはランニング
// だよね」 — running means THE WORK IS NOT FINISHED, not "a claude is mid-turn".
describe('groundLamp — running until the work is finished (2026-09-26)', () => {
  it('a card in doing is running even between turns (no one generating)', () => {
    expect(lamp([task({ boardColumn: 'doing' })], { liveWork: false })).toBe('working')
  })

  it('a card only in REVIEW (awaiting the commander) is running', () => {
    expect(lamp([task({ boardColumn: 'review' })], { liveWork: false })).toBe('working')
  })

  it('mid-handover — review card, worker finished, commander integrating — is running', () => {
    const board = [task({ id: 'a', boardColumn: 'review' }), task({ id: 'b', done: true, boardColumn: 'done' })]
    expect(lamp(board, { liveWork: false, commanderWorking: true })).toBe('working')
    // …and stays running while the commander is between passes.
    expect(lamp(board, { liveWork: false, commanderWorking: false })).toBe('working')
  })

  it('the commander alone generating lights running, even with every card done', () => {
    expect(lamp([task({ done: true, boardColumn: 'done' })], { liveWork: false, commanderWorking: true })).toBe(
      'working',
    )
    expect(lamp([], { liveWork: false, commanderWorking: true })).toBe('working')
  })

  it('an IDLE commander (at its prompt) lights nothing — alive is not a lamp', () => {
    expect(lamp([task({ done: true, boardColumn: 'done' })], { liveWork: false, commanderWorking: false })).toBeNull()
  })

  it('todo only + autopilot ON ⇒ running (it is about to move); OFF ⇒ nothing', () => {
    const board = [task({ id: 'a', notes: 'done when …' }), task({ id: 'b', boardColumn: undefined, notes: 'x' })]
    expect(lamp(board, { liveWork: false, autopilot: true })).toBe('working')
    expect(lamp(board, { liveWork: false, autopilot: false })).toBeNull()
  })

  it('a DRAFT todo never counts, autopilot or not (the engine never dispatches it)', () => {
    expect(lamp([task({ draft: true, notes: 'x' })], { liveWork: false, autopilot: true })).toBeNull()
  })

  // Rework 1 (2026-09-26): the lamp counts a todo by the ENGINE's own gates.
  it('a TITLE-ONLY todo (no body) + autopilot ON is not running — the engine never starts it', () => {
    expect(lamp([task({ notes: '' })], { liveWork: false, autopilot: true })).toBeNull()
    expect(lamp([task({ notes: '   \n ' })], { liveWork: false, autopilot: true })).toBeNull()
    expect(lamp([task({ notes: undefined })], { liveWork: false, autopilot: true })).toBeNull()
  })

  it('an UNAPPROVED self-supply proposal + autopilot ON is not running; once approved it is', () => {
    const proposal = { notes: 'x', selfSupplyKey: 'k1' }
    expect(lamp([task(proposal)], { liveWork: false, autopilot: true })).toBeNull()
    expect(lamp([task({ ...proposal, selfSupplyApproved: true })], { liveWork: false, autopilot: true })).toBe(
      'working',
    )
  })

  it('a todo waiting on a PARKED prerequisite is not running (it will never start)', () => {
    const board = [
      task({ id: 'dep', boardColumn: 'blocked' }),
      task({ id: 'next', notes: 'x', dependsOn: ['dep'] }),
    ]
    expect(lamp(board, { liveWork: false, autopilot: true })).toBeNull()
    // …its prerequisite done ⇒ it is next up ⇒ running.
    const ready = [task({ id: 'dep', done: true, boardColumn: 'done' }), task({ id: 'next', notes: 'x', dependsOn: ['dep'] })]
    expect(lamp(ready, { liveWork: false, autopilot: true })).toBe('working')
    // A prerequisite id missing from the board is satisfied (selectDispatch ⑤).
    expect(lamp([task({ notes: 'x', dependsOn: ['gone'] })], { liveWork: false, autopilot: true })).toBe('working')
  })

  it('a question still outranks in-flight work', () => {
    expect(lamp([task({ boardColumn: 'review' })], { openQuestions: 1, liveWork: false })).toBe('question')
  })

  it('in-flight work outranks the eye — delivery is shown once everything is finished', () => {
    const t = { deliveredAt: 2_000, seenAt: 1_000 }
    expect(groundLamp({ started: 1, inFlight: 1, liveWork: false, ...t })).toBe('working')
    expect(groundLamp({ started: 0, inFlight: 0, liveWork: false, ...t })).toBe('review')
  })
})

describe('inFlightTaskCount — the one definition of "not finished"', () => {
  it('counts unfinished doing / review, plus non-draft todo only under autopilot', () => {
    const board = [
      task({ id: 'a', boardColumn: 'doing' }),
      task({ id: 'b', boardColumn: 'review' }),
      task({ id: 'c', boardColumn: 'blocked' }),
      task({ id: 'd', boardColumn: 'todo', notes: 'x' }),
      task({ id: 'e', boardColumn: 'todo', draft: true, notes: 'x' }),
      task({ id: 'h', boardColumn: 'todo' }),
      task({ id: 'f', boardColumn: 'review', done: true }),
      task({ id: 'g', boardColumn: 'done', done: true }),
    ]
    expect(inFlightTaskCount(board, { autopilot: false })).toBe(2)
    expect(inFlightTaskCount(board, { autopilot: true })).toBe(3)
  })
})

// 既読 (2026-09-26): 「確認待ちのところでプロジェクトの中に入ったら、既読みたいな感じ」 —
// opening the project clears the eye; a hand is never cleared by a look alone.
describe('groundLamp — opening the project is the read receipt (2026-09-26)', () => {
  const idle = { started: 0, inFlight: 0, liveWork: false }
  const T = 1_000_000

  it('opening the project (openedAt) clears the eye', () => {
    expect(groundLamp({ ...idle, deliveredAt: T + 1, seenAt: T })).toBe('review')
    expect(groundLamp({ ...idle, deliveredAt: T + 1, seenAt: T, openedAt: T + 2 })).toBeNull()
  })

  it('openedAt alone is a baseline (a project whose seat was never opened)', () => {
    expect(groundLamp({ ...idle, deliveredAt: T + 1, openedAt: T })).toBe('review')
    expect(groundLamp({ ...idle, deliveredAt: T, openedAt: T + 1 })).toBeNull()
  })

  it('opening the project does NOT clear the hand — neither kind', () => {
    // An escalation, open after a visit.
    expect(groundLamp({ ...idle, openQuestions: 1, openedAt: T + 5 })).toBe('question')
    // The president's question, asked after the last seat look, project opened since.
    expect(groundLamp({ ...idle, presidentAskedAt: T + 1, seenAt: T, openedAt: T + 5 })).toBe('question')
  })
})
