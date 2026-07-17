import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { listSwarmWorkers, readHeartbeats, parseHeartbeat } from './swarmWorkerRegistry'
import type { SwarmWorkerRegistryDeps } from './swarmWorkerRegistry'
import type { ActiveTerminalsResponse, OrchestratorWorker, SwarmOrchestratorState } from '../types'

// ── Pure merge logic: fully faked deps, no real terminal pool / engine / FS ──
// This is the actual thing worth locking down — the THREE-way union (engine
// roster ∪ live-but-unclaimed PTYs ∪ heartbeat-only dead workers) that closes
// the "curl-direct worker invisible to both registries" gap.

const emptyEngineState: SwarmOrchestratorState = {
  running: false,
  manualStop: false,
  manualStopPersisted: false,
  selfSupply: false,
  overseer: false,
  workers: [],
  reviews: [],
  log: [],
  anomalies: [],
  maxWorkers: 3,
  kpis: {
    leadTime: { medianMs: null, count: 0 },
    conflictRate: null,
    reworkRate: null,
    workerSuccessRate: null,
    counts: { dispatched: 0, integrated: 0, conflicted: 0, reworked: 0, crashed: 0, stalled: 0 },
  },
  consumption: {
    activeWorkers: 0,
    activeRunMs: 0,
    dispatched: 0,
    limit: 0,
    overLimit: false,
  },
  autonomyRemembered: false,
}

const engineWorker = (over: Partial<OrchestratorWorker> = {}): OrchestratorWorker => ({
  terminalId: 'engine-pty',
  branch: 'swarm/engine-x',
  worktree: '/wt/engine-x',
  taskId: 'task-1',
  taskTitle: 'Engine task',
  startedAt: '2026-07-07T00:00:00.000Z',
  stage: 'running',
  ...over,
})

const activeTerminals = (claude: ActiveTerminalsResponse['claude']): ActiveTerminalsResponse => ({
  cwds: claude.map((c) => c.cwd),
  claude,
})

const makeDeps = (over: Partial<SwarmWorkerRegistryDeps> = {}): SwarmWorkerRegistryDeps => ({
  listActiveTerminals: () => activeTerminals([]),
  getOrchestratorState: async () => emptyEngineState,
  readHeartbeats: async () => new Map(),
  branchOfWorktree: async () => null,
  // Every fixture worktree in this file lives under '/wt' — the default scopes
  // "live but unclaimed" PTYs there, same as the real resolver scopes to this
  // project's central worktrees dir.
  resolveCentralWorktreesDir: async () => '/wt',
  ...over,
})

describe('listSwarmWorkers — server-truth union', () => {
  it('surfaces an engine-dispatched worker with its live PTY id attached', async () => {
    const deps = makeDeps({
      getOrchestratorState: async () => ({ ...emptyEngineState, workers: [engineWorker()] }),
      listActiveTerminals: () =>
        activeTerminals([{ id: 'engine-pty', cwd: '/wt/engine-x', status: 'waiting' }]),
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      worktree: '/wt/engine-x',
      branch: 'swarm/engine-x',
      terminalId: 'engine-pty',
      taskId: 'task-1',
      stage: 'running',
    })
  })

  it('prefers the live disk heartbeat updatedAt over the engine roster\'s frozen heartbeatAt', async () => {
    // Regression for the 0710 "half a day dead" misdiagnosis (docs/commander/02-worker-lifecycle.md §4):
    // the engine roster's heartbeatAt is only re-folded when the monitor actively re-probes a
    // 'doing' worker, so it can go stale while the worker keeps beating on disk. The disk read
    // (`hb`) happens fresh on every call to listSwarmWorkers and must win.
    const deps = makeDeps({
      getOrchestratorState: async () => ({
        ...emptyEngineState,
        workers: [engineWorker({ heartbeatAt: '2026-07-09T07:55:26.000Z' })],
      }),
      listActiveTerminals: () =>
        activeTerminals([{ id: 'engine-pty', cwd: '/wt/engine-x', status: 'waiting' }]),
      readHeartbeats: async () =>
        new Map([
          [
            '/wt/engine-x',
            {
              branch: 'swarm/engine-x',
              worktree: '/wt/engine-x',
              updatedAt: '2026-07-10T00:41:49.000Z',
            },
          ],
        ]),
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toHaveLength(1)
    expect(out[0].heartbeatAt).toBe('2026-07-10T00:41:49.000Z')
  })

  it('falls back to the engine roster heartbeatAt when no disk heartbeat exists for that worker', async () => {
    const deps = makeDeps({
      getOrchestratorState: async () => ({
        ...emptyEngineState,
        workers: [engineWorker({ heartbeatAt: '2026-07-09T07:55:26.000Z' })],
      }),
      listActiveTerminals: () =>
        activeTerminals([{ id: 'engine-pty', cwd: '/wt/engine-x', status: 'waiting' }]),
      readHeartbeats: async () => new Map(),
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toHaveLength(1)
    expect(out[0].heartbeatAt).toBe('2026-07-09T07:55:26.000Z')
  })

  it('surfaces a curl-direct worker the engine never tracked, using its heartbeat for identity', async () => {
    const deps = makeDeps({
      listActiveTerminals: () =>
        activeTerminals([{ id: 'curl-pty', cwd: '/wt/curl-x', status: 'working' }]),
      readHeartbeats: async () =>
        new Map([
          [
            '/wt/curl-x',
            { branch: 'swarm/curl-x', worktree: '/wt/curl-x', phase: 'implement', task: 'doing the thing' },
          ],
        ]),
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      worktree: '/wt/curl-x',
      branch: 'swarm/curl-x',
      terminalId: 'curl-pty',
      phase: 'implement',
      note: 'doing the thing',
    })
    // Never claimed by the engine — no taskId/stage.
    expect(out[0].taskId).toBeUndefined()
    expect(out[0].stage).toBeUndefined()
  })

  it('falls back to reading the branch out of the worktree when a curl-direct worker has no heartbeat yet', async () => {
    const deps = makeDeps({
      listActiveTerminals: () =>
        activeTerminals([{ id: 'fresh-pty', cwd: '/wt/fresh-x', status: 'waiting' }]),
      branchOfWorktree: async (cwd) => (cwd === '/wt/fresh-x' ? 'swarm/fresh-x' : null),
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toEqual([{ worktree: '/wt/fresh-x', branch: 'swarm/fresh-x', terminalId: 'fresh-pty' }])
  })

  it('drops a live claude PTY that is not actually a swarm worktree (branch lookup fails)', async () => {
    const deps = makeDeps({
      listActiveTerminals: () =>
        activeTerminals([{ id: 'plain-pty', cwd: '/home/user/some-repo', status: 'waiting' }]),
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toEqual([])
  })

  // Regression: listActiveTerminals() is PROCESS-WIDE (every live claude PTY —
  // including this project's own Supply/Commander conversation in its primary
  // checkout, and every other project's terminals). Without scoping to this
  // project's central worktrees dir, any of those would be folded in as a
  // phantom worker — and a Terminate click on one would kill a real, unrelated
  // session (the bug this test locks down).
  it('drops a live claude PTY outside this project\'s central worktrees dir, even on a swarm/* branch', async () => {
    const deps = makeDeps({
      listActiveTerminals: () =>
        activeTerminals([
          { id: 'supply-pty', cwd: '/home/user/my-repo', status: 'waiting' }, // primary checkout
          { id: 'other-project-pty', cwd: '/other/wt/swarm-y', status: 'waiting' }, // different project
        ]),
      branchOfWorktree: async () => 'swarm/looks-legit',
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toEqual([])
  })

  it('drops a live claude PTY inside the central worktrees dir whose checked-out branch is not swarm/*', async () => {
    const deps = makeDeps({
      listActiveTerminals: () =>
        activeTerminals([{ id: 'stray-pty', cwd: '/wt/not-a-worker', status: 'waiting' }]),
      branchOfWorktree: async () => 'main',
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toEqual([])
  })

  it('never surfaces a live PTY when the central worktrees dir cannot be resolved', async () => {
    const deps = makeDeps({
      resolveCentralWorktreesDir: async () => null,
      listActiveTerminals: () =>
        activeTerminals([{ id: 'curl-pty', cwd: '/wt/curl-x', status: 'waiting' }]),
      branchOfWorktree: async () => 'swarm/curl-x',
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toEqual([])
  })

  it('keeps a DEAD worker (heartbeat on disk, no live PTY, no engine record) for the restart affordance', async () => {
    const deps = makeDeps({
      readHeartbeats: async () =>
        new Map([
          [
            '/wt/dead-x',
            { branch: 'swarm/dead-x', worktree: '/wt/dead-x', phase: 'blocked', blockers: 'stuck' },
          ],
        ]),
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toEqual([
      {
        worktree: '/wt/dead-x',
        branch: 'swarm/dead-x',
        phase: 'blocked',
        blocked: true,
        blockers: 'stuck',
      },
    ])
    expect(out[0].terminalId).toBeUndefined()
  })

  it('an engine worker whose PTY already died keeps its engine fields but no terminalId', async () => {
    const deps = makeDeps({
      getOrchestratorState: async () => ({ ...emptyEngineState, workers: [engineWorker()] }),
      listActiveTerminals: () => activeTerminals([]),
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toHaveLength(1)
    expect(out[0].terminalId).toBeUndefined()
    expect(out[0].taskId).toBe('task-1')
  })

  it('a getOrchestratorState throw degrades to "no engine workers" rather than failing the whole list', async () => {
    const deps = makeDeps({
      getOrchestratorState: async () => {
        throw new Error('boom')
      },
      listActiveTerminals: () =>
        activeTerminals([{ id: 'curl-pty', cwd: '/wt/curl-x', status: 'waiting' }]),
      branchOfWorktree: async () => 'swarm/curl-x',
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toEqual([{ worktree: '/wt/curl-x', branch: 'swarm/curl-x', terminalId: 'curl-pty' }])
  })
})

describe('parseHeartbeat', () => {
  it('reads the fields swarm-beat.sh writes and omits blank/absent ones', () => {
    const hb = parseHeartbeat(
      JSON.stringify({
        branch: 'swarm/x',
        worktree: '/wt/x',
        phase: 'audit',
        task: '  looking around  ',
        readyToMerge: true,
        blockers: '',
        updatedAt: '2026-07-07T00:00:00.000Z',
      }),
    )
    expect(hb).toEqual({
      branch: 'swarm/x',
      worktree: '/wt/x',
      phase: 'audit',
      task: 'looking around',
      readyToMerge: true,
      blockers: undefined,
      updatedAt: '2026-07-07T00:00:00.000Z',
    })
  })

  it('never throws on garbage input', () => {
    expect(parseHeartbeat('not json')).toEqual({})
    expect(parseHeartbeat('null')).toEqual({})
  })
})

// ── readHeartbeats: real filesystem, real OPENGROUND_HOME, real repo (git for
// swarmRepoKey) — same house style as swarmJanitor.test.ts's heartbeat sweep.
describe('readHeartbeats', () => {
  let scratch: string
  let repo: string
  let savedHome: string | undefined

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'og-swarm-worker-registry-'))
    savedHome = process.env.OPENGROUND_HOME
    process.env.OPENGROUND_HOME = join(scratch, 'home')
    repo = join(scratch, 'repo')
    await mkdir(repo, { recursive: true })
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const run = promisify(execFile)
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    await run('git', ['-c', 'user.name=OG Test', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-q', '-m', 'init'], { cwd: repo })
  })

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.OPENGROUND_HOME
    else process.env.OPENGROUND_HOME = savedHome
    await rm(scratch, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reads every heartbeat file keyed by its worktree field, skipping ones without one', async () => {
    const { swarmRepoKey } = await import('./swarmJanitor')
    const key = await swarmRepoKey(repo)
    expect(key).toBeTruthy()
    const dir = join(process.env.OPENGROUND_HOME!, 'swarm', key!)
    await mkdir(dir, { recursive: true })
    await writeFile(
      join(dir, 'swarm-a.json'),
      JSON.stringify({ branch: 'swarm/a', worktree: '/wt/a', phase: 'implement', updatedAt: 'now' }),
    )
    await writeFile(join(dir, 'no-worktree.json'), JSON.stringify({ branch: 'swarm/b' }))
    await writeFile(join(dir, 'corrupt.json'), 'not json')

    const out = await readHeartbeats(repo)
    expect(out.size).toBe(1)
    expect(out.get('/wt/a')).toMatchObject({ branch: 'swarm/a', phase: 'implement' })
  })

  it('returns an empty map when the heartbeat dir does not exist yet', async () => {
    const out = await readHeartbeats(repo)
    expect(out.size).toBe(0)
  })
})
