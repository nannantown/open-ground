// @vitest-environment node
//
// THE QUOTA-STOP FAIL-FAST CONTRACT (2026-08-13 — replaces the 20-minute HOLD).
//
// The PTY era held a rate-limited worker in place (no nudge, requeue after
// RATE_LIMIT_GRACE_MS) because its evidence was a WORDING GUESS over a rendered
// screen — broad patterns, real false positives, so the hold was the safe
// shape. The SDK pool's own verdict (`quotaBlocked`: 'quota-parked' status / a
// live refusal event) is the CLI's own sentence, so the engine now acts on it
// after one short debounce instead of holding for 20 minutes:
//
//   • quota-blocked + silent past QUOTA_STOP_DEBOUNCE_MS ⇒ in ONE pass: the
//     launch tier COOLS in the quota table (read back through the PRODUCTION
//     reader isTierCooling — dispatch consults the same table), the card
//     REQUEUES to 'todo' (recoveryColumn's rate-limit arm — auto-retry, never
//     the human lane), and the worker is torn down;
//   • inside the debounce window nothing happens — the window is what
//     separates "parked on the wall" from "echoed wall-like text mid-work"
//     (the verdict decays on the worker's next real event);
//   • a worker whose model is not on the tier ladder cools NOTHING (never cool
//     a tier by guess) but its card still requeues.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rm } from 'fs/promises'
import {
  runDispatchPass,
  __resetOrchestratorForTests,
  defaultDeps,
  emptyMetricsCounters,
  QUOTA_STOP_DEBOUNCE_MS,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { isTierCooling, __resetQuotaForTest, __simulateRestartForTest, ensureCoolingTableLoaded, coolingSnapshot } from './swarmQuota'
import { recordRateLimitEvent, flushUsageWindowsPersist, __resetUsageWindowsForTest } from './usageWindows'
import { initOverseerRuntime } from './swarmOverseer'
import { swarmNotificationsFile } from './paths'
import type { OrchestratorWorker, ProjectTask } from '../types'

vi.setConfig({ testTimeout: 60_000 })

const T0 = Date.parse('2026-08-13T00:00:00Z')

const card = (id: string, boardColumn = 'doing'): ProjectTask =>
  ({ id, title: `card ${id}`, boardColumn, branch: `swarm/${id}` }) as unknown as ProjectTask

const sdkWorker = (over: Partial<OrchestratorWorker> = {}): OrchestratorWorker => ({
  terminalId: '',
  runtime: 'sdk',
  sdkSessionId: 'sdk-q1',
  branch: 'swarm/q1',
  worktree: '/central/wt/q1',
  taskId: 'q1',
  taskTitle: 'quota me',
  startedAt: new Date(T0 - 10 * 60_000).toISOString(),
  stage: 'running',
  model: 'fable',
  reworkCount: 0,
  ...over,
})

const newEngine = (over: Partial<ProjectEngine> = {}): ProjectEngine =>
  ({
    path: '/proj',
    running: true,
    passInFlight: false,
    generation: 0,
    timer: null,
    workers: [sdkWorker()],
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
    log: [],
    anomalies: [],
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
  fetchTasks: async () => [card('q1')],
  spawnWorker: async () => {
    throw new Error('spawnWorker must not run in these tests')
  },
  moveToDoing: async () => true,
  moveToReview: async () => true,
  recoverCard: vi.fn(async () => true),
  recoverWorker: vi.fn(async () => ({ removed: true })),
  isAlive: () => true,
  // Silent since dispatch: no heartbeat, no output stamp — the debounce clock
  // then runs from startedAt (10 minutes ago), far past QUOTA_STOP_DEBOUNCE_MS.
  readHeartbeat: async () => null,
  lastOutputAt: () => null,
  recentOutput: () => '[sdk session quota-parked]',
  quotaBlocked: () => true,
  ...over,
})

beforeEach(async () => {
  __resetOrchestratorForTests()
  __resetQuotaForTest()
  __resetUsageWindowsForTest()
  await rm(swarmNotificationsFile(), { force: true })
})

afterEach(async () => {
  await flushUsageWindowsPersist()
  __resetUsageWindowsForTest()
  __resetOrchestratorForTests()
  __resetQuotaForTest()
  await rm(swarmNotificationsFile(), { force: true })
})

describe('quota stop — cool the tier, requeue the card, free the worker (one pass)', () => {
  it('a quota-blocked, silent worker cools its LAUNCH tier and requeues to todo', async () => {
    const engine = newEngine()
    const deps = stubDeps({})
    await runDispatchPass(engine, deps, T0)

    // The tier cooled — read back through the PRODUCTION reader dispatch uses.
    expect(isTierCooling('fable', T0 + 1)).toBe(true)
    // The card went back to 'todo' (auto-retry lane, not the human lane)…
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'todo')
    // …and the worker itself was torn down, leaving the roster.
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
    expect(engine.workers).toHaveLength(0)
    // The journal names the new shape.
    expect(engine.log.some((l) => l.message.includes('worker quota-stopped'))).toBe(true)
  })

  it('inside the debounce window NOTHING happens — the echo case never tears down', async () => {
    // The worker produced output 30s ago (an echoed refusal mid-work): the
    // verdict may read blocked for one window, but the worker is not silent
    // long enough — no cooling, no requeue, worker kept.
    const engine = newEngine()
    const deps = stubDeps({ lastOutputAt: () => T0 - QUOTA_STOP_DEBOUNCE_MS / 2 })
    await runDispatchPass(engine, deps, T0)

    expect(isTierCooling('fable', T0 + 1)).toBe(false)
    expect(deps.recoverCard).not.toHaveBeenCalled()
    expect(engine.workers).toHaveLength(1)

    // …and once the silence crosses the debounce with the verdict still
    // standing, the stop fires.
    const later = T0 + QUOTA_STOP_DEBOUNCE_MS
    await runDispatchPass(engine, deps, later)
    expect(isTierCooling('fable', later + 1)).toBe(true)
    expect(engine.workers).toHaveLength(0)
  })

  it('a worker whose model is off the ladder cools NOTHING but still requeues', async () => {
    const engine = newEngine({ workers: [sdkWorker({ model: 'mystery-model' })] })
    const deps = stubDeps({})
    await runDispatchPass(engine, deps, T0)

    // Never cool a tier by guess…
    expect(isTierCooling('fable', T0 + 1)).toBe(false)
    expect(isTierCooling('sonnet', T0 + 1)).toBe(false)
    // …but the card still leaves the dead worker behind.
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'todo')
    expect(engine.workers).toHaveLength(0)
  })

  it('a healthy silent worker (verdict false) takes the stall ladder, not the quota stop', async () => {
    // Control: silence alone must never cool a tier — only the pool's verdict
    // may. A silent worker with quotaBlocked=false is the stall ladder's
    // business (nudge budget), and the tier stays warm.
    const engine = newEngine()
    const deps = stubDeps({ quotaBlocked: () => false })
    await runDispatchPass(engine, deps, T0)

    expect(isTierCooling('fable', T0 + 1)).toBe(false)
    expect(deps.recoverCard).not.toHaveBeenCalled()
    expect(engine.workers).toHaveLength(1) // nudged, not stopped
  })
})

// R-C1 (1): the reset instant comes from the SDK's structured rate_limit_event
// first — the refusal sentence and the /usage cache only when the session saw
// no event. The sentence here names a reset ("resets 9pm") that disagrees with
// the structured window on purpose: the structured instant must win.
describe('quota stop — the reset time is the structured window\'s, not the sentence\'s', () => {
  it('an all-model refusal with resetsAt three days ahead cools every tier until exactly then, across a restart', async () => {
    const reset = T0 + 3 * 24 * 3_600_000
    recordRateLimitEvent(
      { kind: 'rate_limit', status: 'rejected', utilization: null, resetsAt: reset / 1000, limitType: 'seven_day' },
      T0 - 30_000,
    )
    const engine = newEngine()
    const deps = stubDeps({
      sdkWorkerFacts: () => ({ refusal: "You've hit your weekly limit · resets 9pm (UTC)" }) as never,
    })
    await runDispatchPass(engine, deps, T0)

    expect(coolingSnapshot(T0 + 1).map((r) => r.until)).toEqual([reset, reset, reset, reset])
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'todo')

    // The cooling table is the authority across a restart (swarm-quota.json).
    await __simulateRestartForTest()
    await ensureCoolingTableLoaded(T0 + 60_000)
    expect(coolingSnapshot(T0 + 60_000).map((r) => r.until)).toEqual([reset, reset, reset, reset])
    expect(isTierCooling('haiku', reset - 1)).toBe(true)
    expect(isTierCooling('haiku', reset)).toBe(false)

    // The requeued card: parked while every tier cools, dispatched by the first pass after the reset.
    const spawned: number[] = []
    const after = newEngine({ workers: [] })
    const resumeDeps = stubDeps({
      // No branch on the card: the re-entry path (git) is not what this case is about.
      fetchTasks: async () => [{ ...card('q1', 'todo'), branch: undefined, notes: 'done when it works' } as ProjectTask],
      spawnWorker: async () => {
        spawned.push(Date.now())
        return { terminalId: '', runtime: 'sdk', sdkSessionId: 'sdk-q2', agentSessionId: 'q2', worktree: '/wt/q1', branch: 'swarm/q1' } as never
      },
      resolveReusableWork: async () => null,
    })
    await runDispatchPass(after, resumeDeps, reset - 1)
    expect(spawned).toHaveLength(0)
    await runDispatchPass(after, resumeDeps, reset + 1)
    expect(spawned).toHaveLength(1)
  })

  // A refusal's reset belongs to the window that refused. The table holds every
  // window any session reported; a per-model week (seven_day_opus …) binds only
  // its own model, so it must never lengthen another tier's cool (review
  // 2026-11-28 B-M1: an opus weekly wall made a 5-hour wall cool EVERY tier for 4 days).
  const HOUR = 3_600_000
  const untilByTier = (at: number) => Object.fromEntries(coolingSnapshot(at).map((r) => [r.tier, r.until]))
  const rejected = (limitType: string, reset: number, at: number) =>
    recordRateLimitEvent({ kind: 'rate_limit', status: 'rejected', utilization: null, resetsAt: reset / 1000, limitType }, at)

  it('an opus weekly wall does not stretch a later 5-hour wall: other tiers cool to the 5-hour reset', async () => {
    const opusReset = T0 + 96 * HOUR
    const fiveReset = T0 + 2 * HOUR
    rejected('seven_day_opus', opusReset, T0 - 10 * 60_000)
    rejected('five_hour', fiveReset, T0 - 30_000)
    const engine = newEngine()
    const deps = stubDeps({ sdkWorkerFacts: () => ({ refusal: "You've hit your 5-hour limit · resets in 2 hours" }) as never })
    await runDispatchPass(engine, deps, T0)
    // opus is still behind its own weekly wall; nobody else is.
    expect(untilByTier(T0 + 1)).toEqual({ fable: fiveReset, opus: opusReset, sonnet: fiveReset, haiku: fiveReset })
  })

  it('a sonnet weekly wall does not stretch an opus wall', async () => {
    const sonnetReset = T0 + 48 * HOUR
    const opusReset = T0 + HOUR
    rejected('seven_day_sonnet', sonnetReset, T0 - 5 * 60_000)
    rejected('seven_day_opus', opusReset, T0 - 30_000)
    const engine = newEngine({ workers: [sdkWorker({ model: 'opus' })] })
    const deps = stubDeps({ sdkWorkerFacts: () => ({ refusal: "You've hit your Opus limit · resets in 1 hour" }) as never })
    await runDispatchPass(engine, deps, T0)
    expect(untilByTier(T0 + 1)).toEqual({ fable: null, opus: opusReset, sonnet: null, haiku: null })
  })

  it('no structured event ⇒ today\'s chain (the sentence) decides', async () => {
    const engine = newEngine()
    const deps = stubDeps({ sdkWorkerFacts: () => ({ refusal: "You've hit your 5-hour limit · resets in 45 minutes" }) as never })
    await runDispatchPass(engine, deps, T0)
    expect(coolingSnapshot(T0 + 1).map((r) => r.until)).toEqual([T0 + 45 * 60_000, T0 + 45 * 60_000, T0 + 45 * 60_000, T0 + 45 * 60_000])
  })
})
