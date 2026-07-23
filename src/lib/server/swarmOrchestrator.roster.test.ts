import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  runDispatchPass,
  stopOrchestratorWorker,
  __seedEngineForTests,
  __resetOrchestratorForTests,
  defaultDeps,
  emptyMetricsCounters,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { initSelfSupplyRuntime } from './swarmSelfSupply'
import { initOverseerRuntime } from './swarmOverseer'
import { readRoster, writeRoster, type RosterEntry } from './swarmWorkerRoster'
import { canonicalize } from './canonicalize'
import type { ProjectTask, OrchestratorWorker, SpawnSwarmWorkerResponse } from '../types'

// card 3 write-through / teardown WIRING — proves the engine actually persists +
// prunes roster.json (the unit test proves the primitives; this proves the call
// sites in runDispatchPass + stopOrchestratorWorker). Needs a real git repo
// (swarmRepoKey → roster path) and an isolated OPENGROUND_HOME. Real fs under load
// can exceed vitest's 5s default (reference_vitest_5s_default_is_the_flake_root).
vi.setConfig({ testTimeout: 60_000 })
const execFile = promisify(execFileCb)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (
    await execFile(
      'git',
      ['-c', 'user.name=OG Test', '-c', 'user.email=og-test@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args],
      { cwd },
    )
  ).stdout

let scratch: string
let project: string
let savedHome: string | undefined

const newEngine = (over: Partial<ProjectEngine> = {}): ProjectEngine => ({
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
})

// defaultDeps() has REAL spawn/teardown (a live claude PTY, an `rm -rf` worktree) —
// override every side-effecting dep the pass/teardown touches so nothing real runs.
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

const worker = (over: Partial<OrchestratorWorker> = {}): OrchestratorWorker => ({
  terminalId: 'pty-1',
  branch: 'swarm/c1',
  worktree: join(scratch, 'wt', 'c1'),
  taskId: 'c1',
  taskTitle: 'Roster me',
  startedAt: new Date(Date.now() - 60_000).toISOString(),
  stage: 'running',
  model: 'fable',
  sessionId: 'sess-abc',
  reworkCount: 0,
  ...over,
})

beforeEach(async () => {
  __resetOrchestratorForTests()
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-roster-int-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = join(scratch, 'home')
  await mkdir(process.env.OPENGROUND_HOME, { recursive: true })
  project = await canonicalize(await (async () => {
    const p = join(scratch, 'proj')
    await mkdir(p, { recursive: true })
    await git(p, ['init'])
    return p
  })())
})

afterEach(async () => {
  __resetOrchestratorForTests()
  // Restore only — never delete OPENGROUND_HOME (src/testHomeEnvGuard.test.ts).
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
  await rm(scratch, { recursive: true, force: true })
})

describe('card 3 wiring — write-through on dispatch (runDispatchPass → syncRoster)', () => {
  it('persists a spawned worker to roster.json with every field', async () => {
    const engine = newEngine({ path: project, running: true })
    const card: ProjectTask = { id: 'c1', title: 'Roster me', boardColumn: 'todo', reworkCount: 2 } as unknown as ProjectTask
    const spawn: SpawnSwarmWorkerResponse = {
      terminalId: 'pty-c1',
      agentSessionId: 'sess-xyz',
      worktree: join(scratch, 'wt', 'c1'),
      branch: 'swarm/c1',
      model: 'fable',
    }
    const deps = stubDeps({
      fetchTasks: async () => [card],
      spawnWorker: async () => spawn,
    })

    const now = Date.now()
    await runDispatchPass(engine, deps, now)

    // In-memory: the worker captured its session id.
    expect(engine.workers).toHaveLength(1)
    expect(engine.workers[0].sessionId).toBe('sess-xyz')

    // On disk: the full roster row.
    const roster = await readRoster(project)
    expect(roster).toHaveLength(1)
    const e = roster[0]
    expect(e).toMatchObject({
      sessionId: 'sess-xyz',
      taskId: 'c1',
      branch: 'swarm/c1',
      worktree: spawn.worktree,
      tier: 'fable',
      reworkCount: 2, // captured from the card
    })
    expect(typeof e.spawnAt).toBe('number')
    expect(e.spawnAt).toBeGreaterThan(0)
    expect(typeof e.workedMs).toBe('number')
    expect(e.workedMs).toBeGreaterThanOrEqual(0)
  })

  it('does NOT rewrite the roster on a no-transition pass (signature guard — plan §3)', async () => {
    // Seed one worker whose card sits in doing (no promote, no reclaim) and pre-write
    // its roster row so the signature is already established.
    const w = worker({ terminalId: 'pty-c1', worktree: join(scratch, 'wt', 'c1') })
    const engine = newEngine({ path: project, running: true, workers: [w] })
    const card: ProjectTask = { id: 'c1', title: 'Roster me', boardColumn: 'doing', branch: 'swarm/c1' } as unknown as ProjectTask
    const deps = stubDeps({
      fetchTasks: async () => [card],
      // no todo cards → no spawn; alive worker in doing → no promote/reclaim
      isAlive: () => true,
      countCommitsAhead: async () => 0,
      readHeartbeat: async () => null,
    })

    // Prime the signature with a first pass (writes once).
    await runDispatchPass(engine, deps, Date.now())
    const sigAfterFirst = engine.rosterSig
    expect(sigAfterFirst).toBeTruthy()

    // A second, identical pass must NOT change the signature (⇒ no second write).
    await runDispatchPass(engine, deps, Date.now() + 5_000)
    expect(engine.rosterSig).toBe(sigAfterFirst)
  })
})

describe('card 3 wiring — teardown removes the roster entry (condition ③)', () => {
  it('stopOrchestratorWorker drops the stopped worker from roster.json', async () => {
    const w = worker({ terminalId: 'pty-c1', worktree: join(scratch, 'wt', 'c1'), branch: 'swarm/c1' })
    const other = worker({ terminalId: 'pty-c2', worktree: join(scratch, 'wt', 'c2'), branch: 'swarm/c2', taskId: 'c2' })
    const engine = newEngine({ path: project, running: true, workers: [w, other] })
    __seedEngineForTests(engine)

    // Both on disk to start.
    const entryOf = (x: OrchestratorWorker): RosterEntry => ({
      sessionId: x.sessionId ?? '',
      taskId: x.taskId,
      branch: x.branch,
      worktree: x.worktree,
      tier: x.model ?? '',
      spawnAt: 1000,
      workedMs: 1000,
      reworkCount: 0,
    })
    await writeRoster(project, [entryOf(w), entryOf(other)])

    const deps = stubDeps({
      fetchTasks: async () => [{ id: 'c1', title: 'Roster me', boardColumn: 'doing' } as unknown as ProjectTask],
      recoverWorker: async () => ({ removed: true }),
    })

    await stopOrchestratorWorker(project, 'pty-c1', deps)

    const roster = await readRoster(project)
    expect(roster.map((e) => e.worktree)).toEqual([other.worktree]) // only c1 removed
  })
})
