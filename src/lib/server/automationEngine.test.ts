import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrchestratorWorker, ProjectTask } from '../types'
import { initOverseerRuntime } from './swarmOverseer'
import { __resetOrchestratorForTests, __seedEngineForTests, defaultDeps, emptyMetricsCounters, isCardDispatchInFlight, maybeAutoStartDrain, runDispatchPass, runIntegratePass, startOrchestrator, stopOrchestrator, type IntegrationDeps, type OrchestratorDeps, type ProjectEngine } from './swarmOrchestrator'
import { AutomationPolicyError } from './automationPolicy'

const policy = vi.hoisted(() => ({ allowed: false, preflight: vi.fn(async () => ({ ok: true })) }))
vi.mock('./automationPolicy', async (original) => {
  const actual = await original<typeof import('./automationPolicy')>()
  return { ...actual,
    readProjectAutomationPolicy: async () => ({ enabled: true, allowed: policy.allowed, healthy: true, frameId: 'fixture-frame' }),
    automaticOperationAllowed: async () => policy.allowed,
    assertAutomaticOperationAllowed: async () => { if (!policy.allowed) throw new actual.AutomationPolicyError() },
  }
})
vi.mock('./chatgptRuntime', async (original) => ({ ...await original<typeof import('./chatgptRuntime')>(), swarmRunPreflight: () => policy.preflight() }))

beforeEach(() => { policy.allowed = false; policy.preflight.mockReset().mockResolvedValue({ ok: true }) })
afterEach(() => __resetOrchestratorForTests())
const now = Date.parse('2026-11-06T00:00:00Z')
const task = (id: string, column: 'todo' | 'doing' = 'todo'): ProjectTask => ({ id, title: `fixture ${id}`, notes: 'Finish the fixture, verify it, and commit.', done: false, createdAt: new Date(now).toISOString(), boardColumn: column })
const worker: OrchestratorWorker = { runtime: 'sdk', sdkSessionId: 'synthetic-worker', terminalId: '', worktree: '/fixture/worktree', branch: 'swarm/accepted', taskId: 'accepted', taskTitle: 'fixture accepted', startedAt: new Date(now).toISOString(), stage: 'running' }
const engine = (workers: OrchestratorWorker[] = []): ProjectEngine => ({
  path: '/fixture/project', running: true, passInFlight: false, generation: 0, timer: null,
  workers, reviews: [], conflictedBranches: new Set(), verifyFailed: new Map(), reviewFailed: new Map(), reviewDeferred: new Map(), highRiskHolds: new Map(),
  lastIntegrateAt: 0, recoveries: new Map(), reworks: new Map(), reworkReasons: new Map(), conflictReworks: new Map(), stuckMoves: new Map(), nudges: new Map(),
  log: [], anomalies: [], overseer: initOverseerRuntime(), notified: new Set(), pendingFatal: [], metrics: emptyMetricsCounters(),
})
const rig = (cards: ProjectTask[]) => ({
  fetchTasks: vi.fn(async () => cards), moveToDoing: vi.fn(async () => true), moveToReview: vi.fn(async () => true),
  spawnWorker: vi.fn(async () => ({ terminalId: '', sdkSessionId: 'new-fixture', agentSessionId: 'fixture-agent', worktree: '/fixture/new', branch: 'swarm/new' })),
  isAlive: vi.fn(() => true), countCommitsAhead: vi.fn(async () => 1), readHeartbeat: vi.fn(async () => ({ ready: true, blocked: false, at: new Date(now).toISOString() })),
  recoverCard: vi.fn(async () => true), recoverWorker: vi.fn(async () => ({ removed: true })),
  lastOutputAt: vi.fn(() => now), nudge: vi.fn(() => true), escalate: vi.fn(async () => true), recentOutput: vi.fn(() => null), quotaBlocked: vi.fn(() => false),
} satisfies OrchestratorDeps)

describe('automation frame gates new work while retaining accepted-work monitoring', () => {
  it('continues observing and promoting an accepted worker outside, without dispatching the next card or killing its actor', async () => {
    const e = engine([worker]), deps = rig([task('accepted', 'doing'), task('next')])
    await runDispatchPass(e, deps, now)
    expect(deps.readHeartbeat).toHaveBeenCalled()
    expect(deps.moveToReview).toHaveBeenCalledWith(e.path, 'accepted', worker.branch)
    expect(deps.spawnWorker).not.toHaveBeenCalled()
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(e.running).toBe(true) // monitor chain remains alive
    expect(e.automationBlocked).toBe(true)
  })

  it('does not inject a new Continue turn into a quiet outside worker', async () => {
    const e = engine([worker]), deps = rig([task('accepted', 'doing')])
    deps.readHeartbeat.mockResolvedValue({ ready: false, blocked: false, at: new Date(now).toISOString() })
    deps.countCommitsAhead.mockResolvedValue(0)
    await runDispatchPass(e, deps, now + 20 * 60_000)
    expect(deps.nudge).not.toHaveBeenCalled()
    expect(deps.escalate).not.toHaveBeenCalled()
    expect(deps.recoverWorker).not.toHaveBeenCalled()
  })

  it('rechecks membership after an awaited Board read before any new worker admission', async () => {
    policy.allowed = true
    const e = engine(), deps = rig([task('next')])
    deps.fetchTasks.mockImplementation(async () => { policy.allowed = false; return [task('next')] })
    await runDispatchPass(e, deps, now)
    expect(deps.spawnWorker).not.toHaveBeenCalled()
  })

  it('rechecks membership after an awaited auto-start preflight', async () => {
    policy.allowed = true
    const e = engine(), deps = rig([task('next')])
    e.running = false
    const preflight = vi.fn(async () => { policy.allowed = false; return { ok: true } })
    expect(await maybeAutoStartDrain(e, { ...defaultDeps(), ...deps, preflight }, now)).toBe(false)
    expect(preflight).toHaveBeenCalledOnce()
    expect(e.running).toBe(false)
    expect(deps.spawnWorker).not.toHaveBeenCalled()
  })

  it('releases a revoked in-flight pick without spending failure, rework or re-entry budgets', async () => {
    policy.allowed = true
    const e = engine(), deps = rig([task('next')])
    __seedEngineForTests(e)
    e.reentryFailures = new Map([['next', 1]])
    e.reworkReasons.set('next', 'Keep this prior failure for the real next attempt.')
    const metrics = structuredClone(e.metrics)
    deps.spawnWorker.mockImplementation(async () => {
      expect(await isCardDispatchInFlight(e.path, 'next')).toBe(true)
      policy.allowed = false
      throw new AutomationPolicyError()
    })
    await runDispatchPass(e, deps, now)
    expect(await isCardDispatchInFlight(e.path, 'next')).toBe(false)
    expect(e.reentryFailures.get('next')).toBe(1)
    expect(e.reworkReasons.get('next')).toContain('Keep this prior failure')
    expect(e.metrics).toEqual(metrics)
    expect(e.sdkSpawnHold).toBeUndefined()
    expect(e.workers).toEqual([])
    expect(deps.recoverCard).not.toHaveBeenCalled()
    expect(deps.moveToDoing).not.toHaveBeenCalled()
  })

  it('holds a new integration pass outside instead of waking or speaking to a manager', async () => {
    const e = engine(), base = rig([])
    const prepareTarget = vi.fn(async () => 'main'), wakeManager = vi.fn(async () => true), nudgeManager = vi.fn(async () => true)
    const deps: IntegrationDeps = { ...defaultDeps(), ...base, prepareTarget, fetchReview: async () => [],
      managerPresence: async () => 'absent', nudgeManager, wakeManager }
    await runIntegratePass(e, deps, now)
    expect(prepareTarget).not.toHaveBeenCalled()
    expect(wakeManager).not.toHaveBeenCalled()
    expect(nudgeManager).not.toHaveBeenCalled()
  })

  it('refuses stale manual ON after its preflight observes a move outside, and prevents the old OFF toggle from stopping frame-managed monitoring', async () => {
    policy.allowed = true
    policy.preflight.mockImplementation(async () => { policy.allowed = false; return { ok: true } })
    await expect(startOrchestrator('/fixture/project')).rejects.toMatchObject({ code: 'automation-frame-off' })
    await expect(stopOrchestrator('/fixture/project')).rejects.toMatchObject({ code: 'automation-frame-controlled' })
  })
})
