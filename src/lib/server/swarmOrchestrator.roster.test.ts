import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  runDispatchPass,
  stopOrchestratorWorker,
  resumeStartedAtMs,
  isRunaway,
  MAX_EXEC_MS,
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

// must-fix #2 (2026-07-24 adversarial review). The ledger a resume adopts must be
// the CURRENT ASSIGNMENT's work, not the worker's lifetime — a resumed worker has no
// `reworkAt` left to move the origin a second time, so a lifetime ledger re-charges a
// 差し戻し中 worker for everything before its 差し戻し and re-runs the 2026-07-20
// accident (§5.5(c)) with the RESTART as the trigger. Both halves are pinned here:
// the ledger the live pass writes, and the boot verdict that reads it.
describe('card 3 ledger — the roster records the CURRENT assignment, not the lifetime (must-fix #2)', () => {
  // The reviewer's measured shape: dispatched 200m ago, delivered 10m ago, 差し戻し 5m
  // ago. 200m > MAX_EXEC_MS (90m default) — the accident needs nothing more exotic.
  const reworkedWorker = (now: number): OrchestratorWorker =>
    worker({
      terminalId: 'pty-c1',
      worktree: join(scratch, 'wt', 'c1'),
      branch: 'swarm/c1',
      startedAt: new Date(now - 200 * 60_000).toISOString(),
      readyAt: new Date(now - 10 * 60_000).toISOString(),
      reworkAt: new Date(now - 5 * 60_000).toISOString(),
    })

  const doingCard = (): ProjectTask =>
    ({ id: 'c1', title: 'Roster me', boardColumn: 'doing', branch: 'swarm/c1' }) as unknown as ProjectTask

  const quietDeps = (card: ProjectTask) =>
    stubDeps({
      fetchTasks: async () => [card],
      isAlive: () => true,
      countCommitsAhead: async () => 1,
      readHeartbeat: async () => null,
    })

  it('a 差し戻し中 worker whose LIFETIME already exceeds the ceiling banks only the re-work span', async () => {
    const now = Date.now()
    const engine = newEngine({ path: project, running: true, workers: [reworkedWorker(now)] })
    await runDispatchPass(engine, quietDeps(doingCard()), now)

    // The live pass keeps it — the re-work budget (§5.5(c)) already worked before
    // this fix. What was wrong was only what it wrote down.
    expect(engine.workers).toHaveLength(1)

    const roster = await readRoster(project)
    expect(roster).toHaveLength(1)
    // ~5m (the re-work span), NOT ~200m (the lifetime). Bounded on both sides so the
    // opposite mistake — banking zero, i.e. a fresh budget every write — fails too.
    expect(roster[0].workedMs).toBeGreaterThanOrEqual(4 * 60_000)
    expect(roster[0].workedMs).toBeLessThanOrEqual(6 * 60_000)
    expect(roster[0].workedMs).toBeLessThan(MAX_EXEC_MS)
    // `spawnAt` still points at the real dispatch — it is resumeStartedAtMs' clamp.
    expect(now - roster[0].spawnAt).toBeGreaterThanOrEqual(199 * 60_000)
  })

  it('…so the first monitor pass AFTER a restart does not judge it 暴走 (no teardown, card stays out of blocked)', async () => {
    const now = Date.now()
    const engine = newEngine({ path: project, running: true, workers: [reworkedWorker(now)] })
    await runDispatchPass(engine, quietDeps(doingCard()), now)
    const [entry] = await readRoster(project)

    // An hour of downtime, then the boot that adopts this row (resumeEngines).
    const boot = now + 60 * 60_000
    expect(isRunaway(resumeStartedAtMs(entry, boot), boot, MAX_EXEC_MS, 0)).toBe(false)
    // And the downtime itself is not billed: the adopted anchor is `boot - workedMs`.
    expect(boot - resumeStartedAtMs(entry, boot)).toBeLessThanOrEqual(6 * 60_000)
  })

  it('the RESTART IS STILL NOT AN AMNESTY: a worker that really burned the ceiling on its CURRENT assignment is judged 暴走 after the restart', async () => {
    const now = Date.now()
    // Same 200m worker, no 差し戻し — nobody gave it a new assignment, so the whole
    // 200m is its current one. This is the direction the fix must NOT loosen.
    const w = worker({
      terminalId: 'pty-c1',
      worktree: join(scratch, 'wt', 'c1'),
      branch: 'swarm/c1',
      startedAt: new Date(now - 200 * 60_000).toISOString(),
    })
    const engine = newEngine({ path: project, running: true, workers: [w] })
    // It is torn down live (that is the ceiling doing its job) — the roster row is
    // written from the same pass, so read what the ledger said about it.
    await runDispatchPass(engine, quietDeps(doingCard()), now)

    const boot = now + 60 * 60_000
    const entry: RosterEntry = {
      sessionId: 'sess-abc',
      taskId: 'c1',
      branch: 'swarm/c1',
      worktree: join(scratch, 'wt', 'c1'),
      tier: 'fable',
      spawnAt: now - 200 * 60_000,
      workedMs: 200 * 60_000, // what rosterEntryOf banks with no 差し戻し in play
      reworkCount: 0,
    }
    expect(isRunaway(resumeStartedAtMs(entry, boot), boot, MAX_EXEC_MS, 0)).toBe(true)
  })

  it('when the origin MOVED, the 統合待ち bank is not deducted a second time (the ledger cannot bank 2× the budget)', async () => {
    const now = Date.now()
    const engine = newEngine({
      path: project,
      running: true,
      workers: [reworkedWorker(now)],
      // 60m banked in review — closed BY the 差し戻し, so it is entirely pre-rework.
      // Subtracting it from a re-work-origin ledger would forgive it twice and bank
      // ~0, handing the resumed worker a fresh full budget every restart.
      integrationWaitMs: new Map([['pty-c1', 60 * 60_000]]),
    })
    await runDispatchPass(engine, quietDeps(doingCard()), now)

    const roster = await readRoster(project)
    expect(roster).toHaveLength(1)
    expect(roster[0].workedMs).toBeGreaterThanOrEqual(4 * 60_000)
    expect(roster[0].workedMs).toBeLessThanOrEqual(6 * 60_000)
  })

  it('a card merely WALKED THROUGH review (no delivery witness) does not reset the ledger — the anti-fail-open gate is the same `readyAt` the ceiling uses', async () => {
    const now = Date.now()
    // reworkAt but NO readyAt: someone dragged the card review→doing without the
    // worker ever delivering. The ceiling refuses to move its origin here, and so
    // must the ledger — otherwise a round trip through review buys a fresh budget.
    const w = worker({
      terminalId: 'pty-c1',
      worktree: join(scratch, 'wt', 'c1'),
      branch: 'swarm/c1',
      startedAt: new Date(now - 200 * 60_000).toISOString(),
      reworkAt: new Date(now - 5 * 60_000).toISOString(),
    })
    const engine = newEngine({ path: project, running: true, workers: [w] })
    await runDispatchPass(engine, quietDeps(doingCard()), now)

    const roster = await readRoster(project)
    // Either the ceiling already tore it down (no row at all), or the row it wrote
    // still says ~200m. What must NEVER happen is a ~5m row granting a fresh budget.
    if (roster.length) expect(roster[0].workedMs).toBeGreaterThan(MAX_EXEC_MS)
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

// ── An engine that never RECONCILED must not erase what it never looked at ────
// syncRoster is a FULL OVERWRITE and `rosterSig` starts undefined, so a fresh
// engine's first transition always writes. That is right for an engine that came
// up through resumeEngines (it reconciled first, so an empty roster genuinely
// means "nobody survived") — but resumeEngines is the ONLY path that reconciles.
// startOrchestrator (the owner pressing 自動運転 ON) and maybeAutoStartDrain kick
// a pass on a fresh, empty engine, and those run exactly when resume was SKIPPED:
// desiredRunning:false at boot, the crash-loop breaker suppressing resume (whose
// own notice tells the owner to switch it on by hand), or a failed preflight.
// The first pass then stamped {"workers":[]} over the rows of workers still alive
// on disk — and with the memory gone nothing could adopt them ever again.
describe('card 3 — an UNRECONCILED engine merges, never erases (2026-07-29)', () => {
  it('carries through roster rows it does not know about', async () => {
    // A worker persisted by a PREVIOUS run of the app, still alive on disk.
    const survivor: RosterEntry = {
      sessionId: 'sess-survivor',
      taskId: 'c-old',
      branch: 'swarm/old',
      worktree: join(scratch, 'wt', 'old'),
      tier: 'sonnet',
      spawnAt: 1,
      workedMs: 60_000,
      reworkCount: 0,
    }
    await writeRoster(project, [survivor])

    // A brand-new engine — the 自動運転 ON / auto-drain shape: never reconciled.
    const engine = newEngine({ path: project, running: true })
    expect(engine.rosterReconciled).toBeFalsy()

    const card: ProjectTask = { id: 'c-new', title: 'New', boardColumn: 'todo' } as unknown as ProjectTask
    await runDispatchPass(
      engine,
      stubDeps({
        fetchTasks: async () => [card],
        spawnWorker: async () => ({
          terminalId: 'pty-new',
          agentSessionId: 'sess-new',
          worktree: join(scratch, 'wt', 'new'),
          branch: 'swarm/new',
          model: 'fable',
        }),
      }),
      Date.now(),
    )

    const roster = await readRoster(project)
    const worktrees = roster.map((r) => r.worktree).sort()
    // The survivor is STILL THERE alongside the newly dispatched worker.
    // Pre-fix this was [wt/new] only — the survivor was erased by an engine that
    // had never once looked at the file.
    expect(worktrees).toEqual([join(scratch, 'wt', 'new'), join(scratch, 'wt', 'old')].sort())
    expect(roster.find((r) => r.worktree === survivor.worktree)?.workedMs).toBe(60_000)
  })

  it('a RECONCILED engine still overwrites wholesale (pruning stays possible)', async () => {
    const stale: RosterEntry = {
      sessionId: 'sess-stale',
      taskId: 'c-stale',
      branch: 'swarm/stale',
      worktree: join(scratch, 'wt', 'stale'),
      tier: 'sonnet',
      spawnAt: 1,
      workedMs: 5,
      reworkCount: 0,
    }
    await writeRoster(project, [stale])

    const engine = newEngine({ path: project, running: true })
    engine.rosterReconciled = true // what resumeEngines sets after reconcileRoster

    const card: ProjectTask = { id: 'c-new', title: 'New', boardColumn: 'todo' } as unknown as ProjectTask
    await runDispatchPass(
      engine,
      stubDeps({
        fetchTasks: async () => [card],
        spawnWorker: async () => ({
          terminalId: 'pty-new2',
          agentSessionId: 'sess-new2',
          worktree: join(scratch, 'wt', 'new2'),
          branch: 'swarm/new2',
          model: 'fable',
        }),
      }),
      Date.now(),
    )

    // Reconcile already decided the stale row is gone — so it stays gone.
    expect((await readRoster(project)).map((r) => r.worktree)).toEqual([join(scratch, 'wt', 'new2')])
  })
})
