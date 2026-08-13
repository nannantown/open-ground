// @vitest-environment node
//
// THE ENGINE HALF OF THE SDK-ONLY FAIL-FAST CONTRACT (2026-08-13).
//
// swarmWorkerFailFast.test.ts pins the spawn side (throw + rollback, no PTY).
// This file pins what the ENGINE does with that throw — the part that replaces
// the deleted fallback's "keep the fleet moving" role:
//   • the card STAYS in todo (never stranded in doing),
//   • dispatch is HELD on a ladder (1m → 5m → 15m) instead of burning a
//     worktree-rollback every 3s tick,
//   • the owner is belled ONCE (worker-spawn-failed), re-notified at most
//     hourly — read back through the PRODUCTION store reader,
//   • the first successful spawn CLEARS the hold with no human re-arm,
//   • a NON-SDK failure (a git hiccup) keeps the old fast retry — no hold.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rm } from 'fs/promises'
import {
  runDispatchPass,
  __resetOrchestratorForTests,
  defaultDeps,
  emptyMetricsCounters,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { SdkWorkerUnavailableError } from './swarmWorkerSdk'
import { initSelfSupplyRuntime } from './swarmSelfSupply'
import { initOverseerRuntime } from './swarmOverseer'
import { listSwarmNotifications } from './swarmNotifications'
import { swarmNotificationsFile } from './paths'
import type { ProjectTask, SpawnSwarmWorkerResponse } from '../types'

vi.setConfig({ testTimeout: 60_000 })

const T0 = Date.parse('2026-08-13T00:00:00Z')
const MIN = 60_000

const card = (id: string): ProjectTask =>
  ({ id, title: `card ${id}`, boardColumn: 'todo' }) as unknown as ProjectTask

const sdkSpawn = (id: string): SpawnSwarmWorkerResponse => ({
  terminalId: '',
  runtime: 'sdk',
  sdkSessionId: `sdk-${id}`,
  agentSessionId: `sess-${id}`,
  worktree: `/central/wt/${id}`,
  branch: `swarm/${id}`,
  model: 'fable',
})

const newEngine = (over: Partial<ProjectEngine> = {}): ProjectEngine =>
  ({
    path: '/proj',
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
    log: [],
    anomalies: [],
    selfSupply: initSelfSupplyRuntime(),
    overseer: initOverseerRuntime(),
    notified: new Set(),
    pendingFatal: [],
    metrics: emptyMetricsCounters(),
    ...over,
  }) as ProjectEngine

const stubDeps = (
  over: Partial<OrchestratorDeps>,
): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({
  ...defaultDeps(),
  fetchTasks: async () => [],
  spawnWorker: async () => {
    throw new Error('spawnWorker not stubbed for this test')
  },
  moveToDoing: async () => true,
  moveToReview: async () => true,
  recoverCard: async () => true,
  recoverWorker: async () => ({ removed: true }),
  isAlive: () => true,
  ...over,
})

beforeEach(async () => {
  __resetOrchestratorForTests()
  await rm(swarmNotificationsFile(), { force: true })
})

afterEach(async () => {
  __resetOrchestratorForTests()
  await rm(swarmNotificationsFile(), { force: true })
})

describe('SDK spawn failure — hold, bell, self-recovery', () => {
  it('an SdkWorkerUnavailableError sets the hold, keeps the card in todo, journals, and bells the owner', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => {
      throw new SdkWorkerUnavailableError(['the user\'s claude CLI could not be located'])
    })
    const moveToDoing = vi.fn(async () => true)
    await runDispatchPass(engine, stubDeps({ fetchTasks: async () => [card('a')], spawnWorker, moveToDoing }), T0)

    expect(spawnWorker).toHaveBeenCalledTimes(1)
    // The card never left todo: the failed spawn must not strand it in doing.
    expect(moveToDoing).not.toHaveBeenCalled()
    expect(engine.workers).toHaveLength(0)
    // The hold: first rung of the ladder.
    expect(engine.sdkSpawnHold).toBeTruthy()
    expect(engine.sdkSpawnHold?.failures).toBe(1)
    expect(engine.sdkSpawnHold?.until).toBe(T0 + 1 * MIN)
    // The journal names it.
    expect(engine.log.some((l) => l.message.includes('worker spawn failed (SDK)'))).toBe(true)
    // The bell — read back through the production store reader.
    const bells = await listSwarmNotifications()
    const mine = bells.filter((b) => b.swarmFatal?.event === 'worker-spawn-failed')
    expect(mine).toHaveLength(1)
    expect(mine[0].swarmFatal?.detail).toContain('claude CLI could not be located')
  })

  it('while held the fill attempts NO spawn; past `until` it retries', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => {
      throw new SdkWorkerUnavailableError(['CLI signed out'])
    })
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker })

    await runDispatchPass(engine, deps, T0) // fails → hold until T0+1m
    await runDispatchPass(engine, deps, T0 + 3_000) // held → no attempt
    await runDispatchPass(engine, deps, T0 + 30_000) // still held
    expect(spawnWorker).toHaveBeenCalledTimes(1)

    await runDispatchPass(engine, deps, T0 + 1 * MIN + 1) // past the rung → retry
    expect(spawnWorker).toHaveBeenCalledTimes(2)
  })

  it('repeated failures walk the ladder 1m → 5m → 15m and stay capped at 15m', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => {
      throw new SdkWorkerUnavailableError(['CLI signed out'])
    })
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker })

    let now = T0
    await runDispatchPass(engine, deps, now)
    expect(engine.sdkSpawnHold?.until).toBe(now + 1 * MIN)

    now = engine.sdkSpawnHold!.until + 1
    await runDispatchPass(engine, deps, now)
    expect(engine.sdkSpawnHold?.failures).toBe(2)
    expect(engine.sdkSpawnHold?.until).toBe(now + 5 * MIN)

    now = engine.sdkSpawnHold!.until + 1
    await runDispatchPass(engine, deps, now)
    expect(engine.sdkSpawnHold?.failures).toBe(3)
    expect(engine.sdkSpawnHold?.until).toBe(now + 15 * MIN)

    now = engine.sdkSpawnHold!.until + 1
    await runDispatchPass(engine, deps, now)
    expect(engine.sdkSpawnHold?.failures).toBe(4)
    expect(engine.sdkSpawnHold?.until).toBe(now + 15 * MIN) // capped, not growing
  })

  it('the bell is throttled: an unchanged reason re-notifies hourly, not per failure', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => {
      throw new SdkWorkerUnavailableError(['CLI signed out'])
    })
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker })

    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 2 * MIN) // 2nd failure, same reason, <1h
    let mine = (await listSwarmNotifications()).filter(
      (b) => b.swarmFatal?.event === 'worker-spawn-failed',
    )
    expect(mine).toHaveLength(1)

    // Past the hourly throttle the still-broken machine is worth one more bell.
    await runDispatchPass(engine, deps, T0 + 61 * MIN)
    mine = (await listSwarmNotifications()).filter(
      (b) => b.swarmFatal?.event === 'worker-spawn-failed',
    )
    expect(mine).toHaveLength(2)
  })

  it('the first successful spawn clears the hold by itself and journals the recovery', async () => {
    const engine = newEngine()
    let broken = true
    const spawnWorker = vi.fn(async () => {
      if (broken) throw new SdkWorkerUnavailableError(['CLI signed out'])
      return sdkSpawn('a')
    })
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker })

    await runDispatchPass(engine, deps, T0)
    expect(engine.sdkSpawnHold).toBeTruthy()

    broken = false // the owner signed back in — nothing else happens
    await runDispatchPass(engine, deps, T0 + 1 * MIN + 1)
    expect(engine.sdkSpawnHold).toBeUndefined()
    expect(engine.workers).toHaveLength(1)
    expect(engine.log.some((l) => l.message.includes('SDK spawn recovered'))).toBe(true)
  })

  it('a NON-SDK spawn failure keeps the fast retry — no hold, no worker-spawn-failed bell', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => {
      throw new Error('git worktree add: transient lock')
    })
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker })

    await runDispatchPass(engine, deps, T0)
    expect(engine.sdkSpawnHold).toBeUndefined()
    await runDispatchPass(engine, deps, T0 + 3_000)
    expect(spawnWorker).toHaveBeenCalledTimes(2) // retried on the very next tick
    const mine = (await listSwarmNotifications()).filter(
      (b) => b.swarmFatal?.event === 'worker-spawn-failed',
    )
    expect(mine).toHaveLength(0)
  })
})
