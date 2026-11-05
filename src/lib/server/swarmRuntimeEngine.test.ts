import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { registerTestProject } from '../../test/registerProject'
import { openGroundHome } from './paths'
const gate = vi.hoisted(() => ({ blocked: false }))
vi.mock('./runtimeTransitionStore', async (original) => ({ ...(await original<typeof import('./runtimeTransitionStore')>()), runtimeAdmissionBlocked: () => gate.blocked }))
import { __resetOrchestratorForTests, __seedEngineForTests, drainSwarmEngines, replaceSwarmTransitionWorker, runDispatchPass, runEnginePass, kickIntegratePass, type ProjectEngine, type OrchestratorDeps, type IntegrationDeps, type AnomalyDeps } from './swarmOrchestrator'
import type { OrchestratorWorker } from '../types'
afterEach(() => { __resetOrchestratorForTests(); gate.blocked = false })
const engine = (path: string, workers: OrchestratorWorker[] = []) => ({ path, workers, running: false, manualStop: true,
  generation: 7, passInFlight: false, integrateInFlight: false, integrationWaitMs: new Map(), integrationWaitSince: new Map(),
} as unknown as ProjectEngine)
describe('engine runtime transition boundary', () => {
  it('freezes direct dispatch and the separate integration lane without rewriting owner intent', async () => {
    const e = engine('/synthetic/project')
    e.running = true
    gate.blocked = true
    const fetchTasks = vi.fn(async () => [])
    const deps = { fetchTasks } as unknown as OrchestratorDeps & IntegrationDeps & AnomalyDeps
    await runDispatchPass(e, deps)
    await runEnginePass(e, deps)
    kickIntegratePass(e, deps)
    expect(fetchTasks).not.toHaveBeenCalled()
    expect(e.integrateInFlight).toBe(false)
    expect(e.running).toBe(true)
    expect(e.manualStop).toBe(true)
    expect(e.generation).toBe(7)
  })
  it('waits for an existing integration, then preserves files, Board identity and accumulated rework budget', async () => {
    await mkdir(openGroundHome(), { recursive: true })
    const path = await realpath(await mkdtemp(join(openGroundHome(), 'runtime-engine-project-')))
    await registerTestProject(path)
    const now = Date.now()
    const worker: OrchestratorWorker = { terminalId: '', runtime: 'sdk', sdkSessionId: 'old-sdk', sessionId: 'old-native',
      branch: 'swarm/kept', worktree: join(path, 'worktree'), taskId: 'card-kept', taskTitle: 'Kept goal',
      startedAt: new Date(now - 3600_000).toISOString(), stage: 'running', readyAt: new Date(now - 30_000).toISOString(),
      reworkAt: new Date(now - 20_000).toISOString(), reworkCount: 2 }
    const e = engine(path, [worker]); e.integrateInFlight = true
    __seedEngineForTests(e)
    let captured = false
    const drain = drainSwarmEngines(1000, { fetchTasks: async () => [] }).then((value) => { captured = true; return value })
    await Promise.resolve()
    expect(captured).toBe(false)
    e.integrateInFlight = false
    const checkpoint = (await drain)[0].workers[0]
    expect(checkpoint.budget.workedMs).toBeGreaterThanOrEqual(20_000)
    expect(checkpoint.budget.workedMs).toBeLessThan(3600_000)
    const before = Date.now()
    await replaceSwarmTransitionWorker(path, checkpoint, { terminalId: '', runtime: 'sdk', sdkSessionId: 'new-sdk',
      agentSessionId: 'chatgpt-11111111-1111-4111-8111-111111111111', branch: worker.branch, worktree: worker.worktree })
    const after = Date.now(), restored = e.workers[0]
    expect(restored).toMatchObject({ taskId: 'card-kept', branch: 'swarm/kept', worktree: worker.worktree, reworkCount: 2, sdkSessionId: 'new-sdk' })
    expect(Date.parse(restored.startedAt)).toBeGreaterThanOrEqual(before - checkpoint.budget.workedMs)
    expect(Date.parse(restored.startedAt)).toBeLessThanOrEqual(after - checkpoint.budget.workedMs)
    expect(Date.parse(restored.reenteredAt!)).toBeGreaterThanOrEqual(before)
    expect(e.running).toBe(false)
    expect(e.manualStop).toBe(true)
  })
})
