import { describe, it, expect } from 'vitest'
import { computeSwarmKpis, countLandedFromBoard, emptyMetricsCounters } from './swarmOrchestrator'
import type { OrchestratorLogLine, ProjectTask } from '@/lib/types'

// ─── the dashboard must measure the OUTCOME, not who pressed merge ───────────
//
// THE ALWAYS-ZERO KPI (overnight review 2026-08-04). `counters.integrated` only
// counts the engine's OWN auto-land journal line — but since 2026-07-15 the
// engine deliberately does not integrate: it wakes the COMMANDER, who merges by
// hand. In that mode (the default) no integrate line is ever written, so
// workerSuccessRate was structurally 0% and lead time a dash: the panel read
// "12 dispatched, nothing landed" while every one of those cards had in fact
// landed. A metric that cannot ever be non-zero is worse than absent — it reads
// as a failing swarm.

const promoteLine = (title: string): OrchestratorLogLine =>
  ({
    at: '2026-08-04T00:00:00Z',
    level: 'info',
    kind: 'promote',
    message: `promoted to review: ${title} → swarm/x`,
  }) as OrchestratorLogLine

const card = (title: string, column: string): ProjectTask =>
  ({ id: title, title, boardColumn: column }) as unknown as ProjectTask

describe('countLandedFromBoard', () => {
  it('counts a promoted card the Board now shows done', () => {
    expect(countLandedFromBoard([card('fix A', 'done')], [promoteLine('fix A')])).toBe(1)
  })

  it('does NOT count a promoted card still in review (not landed yet)', () => {
    expect(countLandedFromBoard([card('fix A', 'review')], [promoteLine('fix A')])).toBe(0)
  })

  it('does NOT count a done card the engine never promoted (hand-made work is not the swarm\'s)', () => {
    expect(countLandedFromBoard([card('hand fix', 'done')], [promoteLine('fix A')])).toBe(0)
  })
})

describe('computeSwarmKpis — commander-merges mode', () => {
  const base = { ...emptyMetricsCounters(), dispatched: 5 }

  it('reports real success when the COMMANDER merged (no engine integrate line)', () => {
    const tasks = ['a', 'b', 'c', 'd', 'e'].map((t) => card(t, 'done'))
    const log = ['a', 'b', 'c', 'd', 'e'].map(promoteLine)
    const k = computeSwarmKpis({ counters: base, tasks, log })
    expect(k.workerSuccessRate).toBe(1)
    expect(k.counts.integrated).toBe(5)
  })

  it('never exceeds 100% when BOTH sources see the same land (max, not sum)', () => {
    const tasks = [card('a', 'done')]
    const log = [promoteLine('a')]
    const k = computeSwarmKpis({
      counters: { ...base, dispatched: 1, integrated: 1 },
      tasks,
      log,
    })
    expect(k.workerSuccessRate).toBe(1)
  })

  it('still reports null (a dash), never 0%, when nothing has been dispatched', () => {
    const k = computeSwarmKpis({ counters: emptyMetricsCounters(), tasks: [], log: [] })
    expect(k.workerSuccessRate).toBeNull()
  })
})
