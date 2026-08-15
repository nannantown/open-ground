import { describe, it, expect } from 'vitest'
import { indexEscalationsByTask } from './boardEscalation'
import type { EscalationView } from '@/lib/types'

// The scoping rule for the Board's "needs you" badge. The defect this guards is
// specific and has bitten this repo before in another costume (差し戻し M2): a
// board-wide fact rendered ON a card claims something the record does not say.
// An escalation with no taskId is EXACTLY that — S2 (all workers down) and
// S3/S10 (edge fatals) legitimately name no card.

const esc = (over: Partial<EscalationView>): EscalationView =>
  ({
    id: 'e1',
    receiptKey: 'k1',
    createdAt: '2026-08-15T00:00:00.000Z',
    projectPath: '/tmp/p',
    question: 'raw question',
    context: 'ctx',
    whyEscalated: 'irreversible',
    status: 'open',
    ...over,
  }) as EscalationView

describe('indexEscalationsByTask', () => {
  it('an escalation with no taskId marks NO card and is counted as unattributed', () => {
    const { byTask, unattributed } = indexEscalationsByTask([
      esc({ id: 'a', taskId: 't1' }),
      esc({ id: 'b' }), // S2 / S3 — board-wide, names no card
      esc({ id: 'c', taskId: '   ' }), // whitespace is not an id
    ])
    // Only the card that was actually named is marked…
    expect(Array.from(byTask.keys())).toEqual(['t1'])
    // …and the other two are reported as what they are, not dropped and not
    // silently smeared across every card.
    expect(unattributed).toBe(2)
  })

  it('carries the 平易文 as the hint, falling back to the raw question', () => {
    const { byTask } = indexEscalationsByTask([
      esc({ taskId: 't1', plainQuestion: 'plain words', question: 'raw' }),
      esc({ id: 'e2', taskId: 't2', question: 'raw only' }),
    ])
    expect(byTask.get('t1')?.hint).toBe('plain words')
    expect(byTask.get('t2')?.hint).toBe('raw only')
  })

  it("keeps the raiser's own reason verbatim — it is never re-classified", () => {
    const { byTask } = indexEscalationsByTask([
      esc({ taskId: 't1', whyEscalated: 'policy' }),
      esc({ id: 'e2', taskId: 't2', whyEscalated: 'insufficient-info' }),
    ])
    expect(byTask.get('t1')?.reason).toBe('policy')
    expect(byTask.get('t2')?.reason).toBe('insufficient-info')
  })

  it('two open questions on one card → the NEWEST wins, in either arrival order', () => {
    const older = esc({ id: 'old', taskId: 't1', createdAt: '2026-08-15T00:00:00.000Z', question: 'older' })
    const newer = esc({ id: 'new', taskId: 't1', createdAt: '2026-08-15T09:00:00.000Z', question: 'newer' })
    expect(indexEscalationsByTask([older, newer]).byTask.get('t1')?.hint).toBe('newer')
    // Order-independent: the route serves newest-first, but the rule must not
    // depend on that (a caller reversing the list would flip the answer).
    expect(indexEscalationsByTask([newer, older]).byTask.get('t1')?.hint).toBe('newer')
  })

  it('an undatable record never evicts a datable one', () => {
    const dated = esc({ id: 'd', taskId: 't1', createdAt: '2026-08-15T09:00:00.000Z', question: 'dated' })
    const undated = esc({ id: 'u', taskId: 't1', createdAt: 'not-a-date', question: 'undated' })
    expect(indexEscalationsByTask([dated, undated]).byTask.get('t1')?.hint).toBe('dated')
    expect(indexEscalationsByTask([undated, dated]).byTask.get('t1')?.hint).toBe('dated')
  })

  it('an empty / absent inbox marks nothing and counts nothing', () => {
    for (const input of [[], undefined, null]) {
      const { byTask, unattributed } = indexEscalationsByTask(input)
      expect(byTask.size).toBe(0)
      expect(unattributed).toBe(0)
    }
  })
})
