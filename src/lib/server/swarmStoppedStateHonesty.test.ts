import { describe, it, expect, afterEach } from 'vitest'
import {
  getOrchestratorState,
  __seedEngineForTests,
  __resetOrchestratorForTests,
} from './swarmOrchestrator'
import { canonicalize } from './canonicalize'

// ─── a stopped engine reports no live observations ───────────────────────────
//
// THE FROZEN PANEL (overnight review 2026-08-04). `reviews` is computed only
// inside runIntegratePass and `anomalies` only inside runEnginePass — both of
// which begin with `if (!engine.running) return`. Nothing recomputes them while
// the engine is off, and nothing clears them, so the published state kept the
// last snapshot forever: the manager panel showed 「検品待ち: 3件」 for cards the
// commander had since integrated, and the overseer panel kept a worker-stale
// warning for a worker that no longer existed — right beside a correctly-empty
// worker list, which `workers` produces by filtering to what is genuinely
// alive. Same screen, two contradictory instruments.
//
// The lists are still KEPT in memory (a restart re-populates them on the first
// pass, and stopOrchestrator deliberately preserves the journal); what changes
// is what a STOPPED engine claims to be observing right now. Asserted through
// the PUBLIC seam the UI actually polls — exporting stateOf just to test it
// would move the boundary instead of testing the shipped one.

const seed = async (path: string, running: boolean) => {
  const key = await canonicalize(path)
  __seedEngineForTests({
    path: key,
    running,
    manualStop: false,
    selfSupply: { enabled: false },
    overseer: { enabled: false, brainResults: [] },
    workers: [],
    reviews: [{ taskId: 't1', branch: 'swarm/a' }],
    anomalies: [{ kind: 'worker-stale', ref: 'swarm/a', staleMinutes: 14 }],
    log: [{ at: '2026-08-04T00:00:00Z', level: 'info', message: 'x' }],
    maxWorkers: 6,
    metrics: {},
    reworks: new Map(),
    reworkReasons: new Map(),
    conflictReworks: new Map(),
    recoveries: new Map(),
    limitScreen: new Map(),
    rateLimited: new Map(),
    reviewSeenAt: new Map(),
    generation: 1,
  } as never)
  return key
}

describe('published engine state — honesty while stopped', () => {
  afterEach(() => {
    __resetOrchestratorForTests()
  })

  it('a RUNNING engine publishes its live reviews and anomalies', async () => {
    const key = await seed('/proj-honesty-running', true)
    const s = await getOrchestratorState(key)
    expect(s.reviews).toHaveLength(1)
    expect(s.anomalies).toHaveLength(1)
  })

  it('a STOPPED engine publishes neither — nothing is observing them', async () => {
    const key = await seed('/proj-honesty-stopped', false)
    const s = await getOrchestratorState(key)
    expect(s.reviews).toEqual([])
    expect(s.anomalies).toEqual([])
  })

  it('the journal still ships while stopped — the log is history, not an observation', async () => {
    const key = await seed('/proj-honesty-log', false)
    expect((await getOrchestratorState(key)).log.length).toBeGreaterThan(0)
  })
})
