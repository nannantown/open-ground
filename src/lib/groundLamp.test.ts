import { describe, it, expect } from 'vitest'
import { groundLamp, startedTaskCount } from './groundLamp'
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
  rest: { openQuestions?: number; liveWork: boolean },
) => groundLamp({ started: startedTaskCount(tasks), ...rest })

describe('groundLamp — the four cases the owner specified', () => {
  it('作業中なら running', () => {
    expect(lamp([task({ boardColumn: 'doing' })], { liveWork: true })).toBe('working')
  })

  it('何かこちらで入力しないといけないなら waiting — even while other work runs', () => {
    // A question for you is not made less urgent by the swarm carrying on.
    expect(lamp([task({ boardColumn: 'doing' })], { openQuestions: 1, liveWork: true })).toBe(
      'waiting',
    )
  })

  it('started-but-idle work shows NO lamp — waiting is only ever a question (2026-08-18)', () => {
    // The owner's amendment, measured on their own board: three long-parked
    // Needs-decision cards held the card amber for weeks. Parked or stalled
    // work is the machine's problem first (the engine reclaims dead workers);
    // when it truly needs a human it raises an escalation, which lights
    // WAITING through the inbox branch — the only branch allowed to.
    for (const col of ['doing', 'review', 'blocked'] as const) {
      expect(lamp([task({ boardColumn: col })], { liveWork: false }), col).toBeNull()
    }
  })

  it('…and a question over that same idle board DOES light waiting', () => {
    // The pair that keeps the retirement honest: the same three parked cards
    // plus one unanswered question is amber — the question, not the cards.
    expect(lamp([task({ boardColumn: 'blocked' })], { openQuestions: 1, liveWork: false })).toBe(
      'waiting',
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
    expect(groundLamp({ started: 0, liveWork: false })).toBeNull()
    expect(groundLamp({ started: 0, liveWork: true })).toBeNull()
  })

  it('a question we DID read still outranks a board we did not', () => {
    // The inbox and the board are separate reads. Failing to open one does not
    // make the other's answer less true, and an unanswered question is the one
    // thing on this card that is genuinely waiting on the owner.
    expect(groundLamp({ openQuestions: 1, liveWork: false })).toBe('waiting')
  })
})
