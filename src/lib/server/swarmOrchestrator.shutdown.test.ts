// @vitest-environment node
//
// NO DISPATCH WHILE THE SERVER STOPS (review C-S2, 2026-11-28; AUTONOMY-SPEC R-B2).
// After SIGTERM the server stays up for up to SHUTDOWN_TOOL_GRACE_MS waiting for
// running tool calls, and the engine's 3 s chain kept running through it: a pass
// moved a todo card to doing, made its worktree and launched a worker whose first
// turn is billed, only for every call it made to be refused and the process to
// kill it at exit — leaving the card for boot recovery to unwind. The production
// engine pass, with the board and the spawn observed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { runDispatchPass, __seedEngineForTests, type ProjectEngine } from './swarmOrchestrator'
import { beginShutdown, __resetSdkSessionsForTests } from './sdkSession'
import type { ProjectTask, SpawnSwarmWorkerResponse } from '../types'

vi.setConfig({ testTimeout: 30_000 })

const PATH = '/proj-shutdown'

const engineLiteral = () =>
  ({
    path: PATH,
    running: true,
    passInFlight: false,
    generation: 0,
    timer: null,
    workers: [],
    reviews: [],
    conflictedBranches: new Set(),
    verifyFailed: new Map(),
    reviewFailed: new Map(),
    reviewDeferred: new Map(),
    highRiskHolds: new Map(),
    lastIntegrateAt: 0,
    recoveries: new Map(),
    reworks: new Map(),
    reworkReasons: new Map(),
    conflictReworks: new Map(),
    stuckMoves: new Map(),
    nudges: new Map(),
    rateLimited: new Map(),
    permissionWaits: new Map(),
    log: [] as { message: string }[],
    anomalies: [],
    notified: new Set(),
    pendingFatal: [],
  }) as unknown as ProjectEngine

const harness = () => {
  const board = new Map<string, ProjectTask>([
    ['c', { id: 'c', title: 'a card', notes: 'completion conditions', tier: 'touch', boardColumn: 'todo' } as unknown as ProjectTask],
  ])
  const spawned: string[] = []
  const deps = {
    fetchTasks: async () => Array.from(board.values()),
    resolveReusableWork: async () => null,
    spawnWorker: async (opts: { title: string }): Promise<SpawnSwarmWorkerResponse> => {
      spawned.push(opts.title)
      return { terminalId: '', runtime: 'sdk', sdkSessionId: 'sdk-c', agentSessionId: 'c', worktree: '/wt/c', branch: 'swarm/c' } as SpawnSwarmWorkerResponse
    },
    moveToDoing: async (_p: string, id: string, branch: string) => {
      const c = board.get(id)
      if (c) board.set(id, { ...c, boardColumn: 'doing', branch } as ProjectTask)
      return true
    },
    moveToReview: async () => true,
    countCommitsAhead: async () => 0,
    readHeartbeat: async () => null,
    isAlive: () => true,
    recoverCard: async () => true,
    recoverWorker: async () => ({ removed: true }),
    lastOutputAt: () => Date.now(),
    nudge: () => true,
    escalate: async () => true,
    recentOutput: () => null,
    refreshUsage: vi.fn(),
  } as never
  return { board, spawned, deps }
}

beforeEach(() => __resetSdkSessionsForTests())
afterEach(() => __resetSdkSessionsForTests())

describe('the engine pass once a stop has begun', () => {
  it('control: without a stop, the todo card is dispatched', async () => {
    const h = harness()
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    await runDispatchPass(engine, h.deps)
    expect(h.spawned).toEqual(['a card'])
    expect(h.board.get('c')?.boardColumn).toBe('doing')
  })

  it('after beginShutdown: nothing is dispatched and the card stays in todo', async () => {
    void beginShutdown()
    const h = harness()
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    await runDispatchPass(engine, h.deps)
    expect(h.spawned).toEqual([])
    expect(h.board.get('c')?.boardColumn).toBe('todo')
    expect(engine.workers).toEqual([])
  })
})
