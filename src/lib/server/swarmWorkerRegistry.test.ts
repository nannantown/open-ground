import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  listSwarmWorkers,
  readHeartbeats,
  parseHeartbeat,
  defaultRegistryDeps,
} from './swarmWorkerRegistry'
import type { SwarmWorkerRegistryDeps } from './swarmWorkerRegistry'
import {
  spawnSdkSession,
  terminateSdkSession,
  getSdkSession,
  isSdkSessionReaped,
  __resetSdkSessionsForTests,
  type SdkQueryFn,
} from './sdkSession'
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
  autonomyResumed: false,
  overseerRemembered: false,
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

  // THE HOLE (2026-07-31, review round 5). This record is what the Swarm tab
  // renders from, and it carried no runtime at all. `terminalId` is looked up in
  // the PTY pool BY CWD — which an SDK worker is never in — so an SDK worker
  // arrived with no id and no runtime, the tab fell through to the terminal
  // renderer, and a healthy working worker was drawn as an EXITED one. The SDK
  // tile shipped in W7 was unreachable for engine workers entirely.
  it('carries runtime + sdkSessionId for an SDK worker (no PTY exists for it)', async () => {
    const deps = makeDeps({
      getOrchestratorState: async () => ({
        ...emptyEngineState,
        workers: [
          engineWorker({
            terminalId: '', // EMPTY by the identity invariant
            runtime: 'sdk',
            sdkSessionId: 'sdk-abc',
            worktree: '/wt/sdk-x',
            branch: 'swarm/sdk-x',
          }) as OrchestratorWorker,
        ],
      }),
      listActiveTerminals: () => activeTerminals([]), // the PTY pool is EMPTY
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      worktree: '/wt/sdk-x',
      runtime: 'sdk',
      sdkSessionId: 'sdk-abc',
    })
    // And NOT a stray terminalId, which would send the tile back to the terminal
    // renderer (the identity invariant: sdk ⇔ sdkSessionId, never both).
    expect(out[0].terminalId).toBeUndefined()
  })

  it('an engine SDK worker whose session IS in the pool still gets NO terminalId', async () => {
    // The test above proves the SDK worker keeps `terminalId` undefined — but it
    // leaves the SDK pool EMPTY, so the map that could leak into that field has
    // nothing in it. Measured 2026-08-01: widening the lookup to
    // `liveCwdToTerminalId.get(w.worktree) ?? liveCwdToSdkId.get(w.worktree)`
    // kept every test in this file green, because no fixture ever had an engine
    // SDK worker and a live SDK session at the SAME worktree — which is what
    // EVERY healthy SDK worker actually looks like in production.
    //
    // Why that must fail: `terminalId` is not a label, it is an ADDRESS. The tile
    // dispatches on it (a record carrying one renders as a terminal and its
    // Terminate posts to /api/terminal/:id), and an SDK session id addresses
    // nothing in the PTY pool — so the stop silently hits nothing while the
    // worker keeps running. This is the identity invariant (pty ⇔ terminalId,
    // sdk ⇔ sdkSessionId) at the exact seam the file's own comment says it is
    // keeping two maps apart to protect.
    const deps = makeDeps({
      getOrchestratorState: async () => ({
        ...emptyEngineState,
        workers: [
          engineWorker({
            terminalId: '',
            runtime: 'sdk',
            sdkSessionId: 'sdk-live',
            worktree: '/wt/sdk-live',
            branch: 'swarm/sdk-live',
          }) as OrchestratorWorker,
        ],
      }),
      listActiveTerminals: () => activeTerminals([]),
      // The healthy production shape: the engine knows this worker AND its
      // session is live in the pool at the same worktree.
      listActiveSdkWorkers: () => [{ id: 'sdk-live', cwd: '/wt/sdk-live' }],
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toHaveLength(1) // claimed by the engine — not also folded in as unclaimed
    expect(out[0].terminalId).toBeUndefined()
    expect(out[0]).toMatchObject({ runtime: 'sdk', sdkSessionId: 'sdk-live' })
  })

  it('an UNCLAIMED SDK worker (curl-direct dispatch) is found in the SDK pool', async () => {
    // The other path to the same failure: a worker the engine never tracked. It
    // was found only through its heartbeat, arrived with no id and no runtime,
    // and the tab drew a live worker as an EXITED terminal.
    const deps = makeDeps({
      listActiveTerminals: () => activeTerminals([]), // PTY pool EMPTY
      listActiveSdkWorkers: () => [{ id: 'sdk-manual', cwd: '/wt/manual' }],
      branchOfWorktree: async () => 'swarm/manual',
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      worktree: '/wt/manual',
      branch: 'swarm/manual',
      runtime: 'sdk',
      sdkSessionId: 'sdk-manual',
    })
    expect(out[0].terminalId).toBeUndefined() // identity invariant, both arms
  })

  it('an unclaimed SDK session OUTSIDE the central worktrees dir is not folded in', async () => {
    // The same scoping the PTY arm has: the SDK pool is process-wide, so this
    // project's own commander desk (primary checkout) must not read as a worker.
    const deps = makeDeps({
      listActiveTerminals: () => activeTerminals([]),
      listActiveSdkWorkers: () => [{ id: 'sdk-cmd', cwd: '/elsewhere/primary' }],
      branchOfWorktree: async () => 'swarm/whatever',
    })
    expect(await listSwarmWorkers('/proj', deps)).toEqual([])
  })

  it('a PTY worker gains no runtime field — absent still means pty', async () => {
    const deps = makeDeps({
      getOrchestratorState: async () => ({ ...emptyEngineState, workers: [engineWorker()] }),
      listActiveTerminals: () =>
        activeTerminals([{ id: 'engine-pty', cwd: '/wt/engine-x', status: 'working' }]),
    })
    const out = await listSwarmWorkers('/proj', deps)
    expect(out[0].runtime).toBeUndefined()
    expect(out[0].sdkSessionId).toBeUndefined()
    expect(out[0].terminalId).toBe('engine-pty')
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

// ── The SHIPPED deps, not injected ones ─────────────────────────────────────
// Every test above hands `listSwarmWorkers` a fake dep bag, which is right for
// the merge logic — and left the dep bag GET /api/swarm/workers actually runs
// with no guard whatsoever. Measured 2026-08-01: rewriting the SDK liveness
// filter in `defaultRegistryDeps` to `x.status !== 'exited'`, and separately
// deleting its `role === 'worker'` clause, each kept all 20 tests in this file
// green. A test bag that never touches the real bag is a test of a function
// nobody calls.
describe('defaultRegistryDeps().listActiveSdkWorkers — the filter the route really runs', () => {
  /** A session that only finishes when the test says so — the shape production
   *  is in for the seconds after `terminate` while claude unwinds. */
  const stuck = (control: { stop?: () => void }): SdkQueryFn =>
    (() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((r) => {
          control.stop = r
        })
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      },
    })) as SdkQueryFn
  const settle = () => new Promise((r) => setTimeout(r, 20))

  beforeEach(() => {
    __resetSdkSessionsForTests()
  })
  afterEach(() => {
    __resetSdkSessionsForTests()
  })

  it('keeps a terminated-but-UNWINDING worker — status says gone, the claude is not', async () => {
    // The consequence of getting this wrong is not a cosmetic one. The Swarm tab
    // renders from this list; a worker missing from it is drawn as DEAD and the
    // tile offers a Restart, which puts a SECOND claude into the worktree the
    // first one is still writing to. `terminateSdkSession` flips status to
    // 'exited' SYNCHRONOUSLY, so `status !== 'exited'` drops precisely this
    // worker — the one case that matters — and looks correct in every other.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({
      cwd: '/wt/unwinding',
      role: 'worker',
      options: {},
      initialPrompt: 'go',
      queryFn: stuck(control),
    })
    await settle()
    terminateSdkSession(s.id)
    expect(getSdkSession(s.id)?.status).toBe('exited') // what a status filter believes
    expect(isSdkSessionReaped(s.id)).toBe(false) // what is actually true

    expect(defaultRegistryDeps().listActiveSdkWorkers?.()).toEqual([
      { id: s.id, cwd: '/wt/unwinding' },
    ])

    control.stop?.()
    await settle()
    // …and it does drop out once the pump has really unwound, so the guard above
    // is not just "this list never forgets anything".
    expect(defaultRegistryDeps().listActiveSdkWorkers?.()).toEqual([])
  })

  it('never lists a non-worker desk — a commander is not a worker tile', async () => {
    // The other clause of the same filter. Without it this project's own
    // commander/supply desk arrives in the worker list as a phantom worker, and
    // a Terminate click on that tile stops the commander.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({
      cwd: '/wt/commander',
      role: 'manager',
      options: {},
      initialPrompt: 'go',
      queryFn: stuck(control),
    })
    await settle()
    expect(defaultRegistryDeps().listActiveSdkWorkers?.()).toEqual([])
    control.stop?.()
    terminateSdkSession(s.id)
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
    // Restore, never delete: an unset OPENGROUND_HOME sends later resolution at the
    // REAL home dir (the 2026-07-18 data loss). See src/lib/server/testHomeGuard.ts.
    if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
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
