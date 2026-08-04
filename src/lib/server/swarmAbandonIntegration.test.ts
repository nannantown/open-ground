import { describe, it, expect } from 'vitest'
import { abandonCardIntegration } from './swarmOrchestrator'
import type { ProjectTask } from '@/lib/types'

// 「B: この作業は見送る（できあがった分も取り込みません）」 — the answer that did
// nothing.
//
// MEASURED 2026-08-04. Answering B recorded the owner's words, read them as
// 'hold', and returned. The card stayed in `review`, so the engine kept
// publishing it as ready-to-integrate, kept typing 「統合してください」 into the
// commander's desk, and kept the desk alive because work was waiting — and the
// commander merged the branch the owner had just declined. Onto the trunk.
// Irreversibly. The UI reported the answer delivered the whole time.
//
// So the decision has to survive as STATE the publish path reads, not as prose
// in a journal. This file pins the WRITE; the half that pins what the flag DOES
// (an abandoned card never reaches `engine.reviews`) lives in
// swarmOrchestrator.test.ts, beside the integrate pass it guards.

const card = (over: Partial<ProjectTask> & { id: string }): ProjectTask =>
  ({ title: `card ${over.id}`, done: false, ...over }) as ProjectTask

describe('abandonCardIntegration — the owner’s "do not integrate" becomes state', () => {
  it('parks the card AND stamps it, in ONE board write', async () => {
    const writes: unknown[] = []
    const res = await abandonCardIntegration('/proj', 'a', {
      fetchTasks: async () => [card({ id: 'a', boardColumn: 'review', branch: 'swarm/a' })],
      // resolveOrchestratorReview needs no engine in memory to be a no-op; what
      // this test owns is the stamp.
      markAbandoned: async (p: string, id: string) => {
        writes.push({ p, id })
        return true
      },
    } as never)

    expect(res).toEqual({ ok: true })
    expect(writes).toEqual([{ p: '/proj', id: 'a' }])
  })

  it('is idempotent for a card already parked — a second answer still stamps', async () => {
    // The owner answers twice, or answers after moving the card by hand. The
    // decision is the same; refusing here would leave an unflagged card that the
    // engine could publish again the moment someone moved it back to review.
    let stamped = 0
    const res = await abandonCardIntegration('/proj', 'a', {
      fetchTasks: async () => [card({ id: 'a', boardColumn: 'blocked', branch: 'swarm/a' })],
      markAbandoned: async () => {
        stamped++
        return true
      },
    } as never)
    expect(res).toEqual({ ok: true, alreadyParked: true })
    expect(stamped).toBe(1)
  })

  it('reports a failed write instead of claiming success', async () => {
    const res = await abandonCardIntegration('/proj', 'a', {
      fetchTasks: async () => [card({ id: 'a', boardColumn: 'review', branch: 'swarm/a' })],
      markAbandoned: async () => false,
    } as never)
    expect(res).toEqual({ ok: false, reason: 'write-failed' })
  })

  it('a vanished card is reported, not silently treated as done', async () => {
    const res = await abandonCardIntegration('/proj', 'gone', {
      fetchTasks: async () => [],
      markAbandoned: async () => true,
    } as never)
    expect(res).toEqual({ ok: false, reason: 'card-missing' })
  })
})
