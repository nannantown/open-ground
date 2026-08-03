import { describe, it, expect, vi } from 'vitest'
import { recordEscalationAnswerForNextDispatch } from './swarmOrchestrator'
import type { ProjectTask } from '@/lib/types'

// ─── the answered question must not dead-end in 'blocked' ────────────────────
//
// THE DEAD END (found 2026-08-03 overnight review, must-fix). A worker asks a
// free-text question → the owner does not answer within QUESTION_GRACE_MS →
// the engine parks the card ('question' ⇒ recoveryColumn 'blocked') and tears
// the worker down. The owner then answers from the inbox. deliverAnswer finds
// no live worker, so it takes the QUEUED lane: the answer is recorded in
// engine.reworkReasons "for the NEXT dispatch of this card".
//
// But 'blocked' is the HUMAN lane — runDispatchPass only ever picks from
// 'todo'. So the next dispatch never came, and from the owner's seat the card
// they had just answered simply never moved again. Nothing errored; the
// escalation even showed as delivered.
//
// The fix makes recording and unparking ONE act. These pin the exact edges,
// because the wrong-direction versions are each their own incident:
//   • not unparking     → the dead end above (silent stall)
//   • unparking a 'doing' card → yanking work out from under a LIVE worker
//   • unparking on a duplicate re-delivery → resurrecting a card the owner
//     (or the commander) has since moved on purpose

const card = (id: string, column: string, branch?: string): ProjectTask =>
  ({ id, title: `card ${id}`, boardColumn: column, ...(branch ? { branch } : {}) }) as unknown as ProjectTask

describe('recordEscalationAnswerForNextDispatch — unpark', () => {
  it('moves a card parked in blocked back to todo so the answer can be dispatched', async () => {
    const unpark = vi.fn(async () => true)
    await recordEscalationAnswerForNextDispatch('/tmp/og-unpark-a', 't1', 'Q → A', { workerAddressed: true }, {
      fetchTasks: async () => [card('t1', 'blocked')],
      unpark,
    })
    // The engine canonicalizes its path (/tmp → /private/tmp on macOS), so
    // match the id exactly and the path by its distinctive tail.
    expect(unpark).toHaveBeenCalledTimes(1)
    expect(unpark).toHaveBeenCalledWith(expect.stringContaining('og-unpark-a'), 't1')
  })

  it('leaves a card in doing alone — a live worker must never be yanked', async () => {
    const unpark = vi.fn(async () => true)
    await recordEscalationAnswerForNextDispatch('/tmp/og-unpark-b', 't2', 'Q → A', { workerAddressed: true }, {
      fetchTasks: async () => [card('t2', 'doing')],
      unpark,
    })
    expect(unpark).not.toHaveBeenCalled()
  })

  it('leaves todo / review / done alone', async () => {
    for (const col of ['todo', 'review', 'done']) {
      const unpark = vi.fn(async () => true)
      await recordEscalationAnswerForNextDispatch(`/tmp/og-unpark-${col}`, 't3', 'Q → A', { workerAddressed: true }, {
        fetchTasks: async () => [card('t3', col)],
        unpark,
      })
      expect(unpark, `column ${col} must not be unparked`).not.toHaveBeenCalled()
    }
  })

  it('a vanished card is not resurrected', async () => {
    const unpark = vi.fn(async () => true)
    await recordEscalationAnswerForNextDispatch('/tmp/og-unpark-gone', 't4', 'Q → A', { workerAddressed: true }, {
      fetchTasks: async () => [],
      unpark,
    })
    expect(unpark).not.toHaveBeenCalled()
  })

  it('a DUPLICATE re-delivery does not unpark again (the owner may have re-parked it)', async () => {
    const path = '/tmp/og-unpark-dup'
    const first = vi.fn(async () => true)
    await recordEscalationAnswerForNextDispatch(path, 't5', 'same answer', { workerAddressed: true }, {
      fetchTasks: async () => [card('t5', 'blocked')],
      unpark: first,
    })
    expect(first).toHaveBeenCalledTimes(1)
    const second = vi.fn(async () => true)
    await recordEscalationAnswerForNextDispatch(path, 't5', 'same answer', { workerAddressed: true }, {
      fetchTasks: async () => [card('t5', 'blocked')],
      unpark: second,
    })
    expect(second).not.toHaveBeenCalled()
  })

  it('a parked card whose branch ALREADY CARRIES COMMITS stays blocked (twin-dispatch root fix, 2026-07-23)', async () => {
    // The regression this unpark first shipped with, caught the same night by
    // the review fleet: a question-parked worker has had its work WIP-committed
    // onto swarm/*, and a dispatch from 'todo' mints a FRESH branch and stamps
    // it onto the card — orphaning those commits and redoing the work from
    // zero. recoveryColumn refuses this (`commitsAhead > 0 ⇒ blocked`) but
    // returns 'blocked' for 'question' before reaching that line, so the guard
    // must be restated at this second door into the dispatch queue.
    const unpark = vi.fn(async () => true)
    await recordEscalationAnswerForNextDispatch('/tmp/og-unpark-commits', 't7', 'Q → A', { workerAddressed: true }, {
      fetchTasks: async () => [card('t7', 'blocked', 'swarm/t7-abc')],
      countCommitsAhead: async () => 3,
      unpark,
    })
    expect(unpark, 'a branch with saved commits must not be re-dispatched').not.toHaveBeenCalled()
  })

  it('a parked card whose branch has NO commits still unparks (the common early-question case)', async () => {
    const unpark = vi.fn(async () => true)
    await recordEscalationAnswerForNextDispatch('/tmp/og-unpark-nocommits', 't8', 'Q → A', { workerAddressed: true }, {
      fetchTasks: async () => [card('t8', 'blocked', 'swarm/t8-abc')],
      countCommitsAhead: async () => 0,
      unpark,
    })
    expect(unpark).toHaveBeenCalledTimes(1)
  })

  it('an answer to a raise NO WORKER made never moves the card (the owner\'s 「このまま保留」)', async () => {
    // Cycle-3 finding, and the most user-hostile shape of all: an overseer/board
    // raise ("card X has been stuck in blocked for 30 minutes — what should I
    // do?") offers 「B: このまま保留にしておく（勝手に動かすことはありません）」.
    // Answering B took the queued lane (no worker to deliver to), and the unpark
    // then moved the card to todo — the owner's "leave it alone" was itself what
    // moved it, and with the engine running a worker started on it. The record's
    // persisted ADDRESS is the discriminator: no worker asked ⇒ nothing to
    // un-park for.
    const unpark = vi.fn(async () => true)
    await recordEscalationAnswerForNextDispatch('/tmp/og-unpark-noworker', 't9', 'B: このまま保留', { workerAddressed: false }, {
      fetchTasks: async () => [card('t9', 'blocked')],
      unpark,
    })
    expect(unpark).not.toHaveBeenCalled()
  })

  it('a missing opts object is treated as "no worker" — never unpark on a guess', async () => {
    const unpark = vi.fn(async () => true)
    await recordEscalationAnswerForNextDispatch('/tmp/og-unpark-noopts', 't10', 'Q → A', undefined, {
      fetchTasks: async () => [card('t10', 'blocked')],
      unpark,
    })
    expect(unpark).not.toHaveBeenCalled()
  })

  it('a board read fault never loses the answer (fail-open, no throw)', async () => {
    await expect(
      recordEscalationAnswerForNextDispatch('/tmp/og-unpark-err', 't6', 'Q → A', { workerAddressed: true }, {
        fetchTasks: async () => {
          throw new Error('board read HTTP 500')
        },
        unpark: async () => true,
      }),
    ).resolves.toBeUndefined()
  })
})
