// @vitest-environment node
//
// RE-ENTRY STARTS WITH NO HEARTBEAT (2026-10-02, docs/commander/02 §5.3a).
//
// A NEW worker spawned into an existing worktree inherits the branch's heartbeat
// file — the previous worker's sticky ready:true. spawnSwarmWorker, where the
// engine dispatch and the manual POST /api/swarm/worker door meet, deletes it —
// after the occupancy check, and never on --resume. These drive the REAL
// spawnSwarmWorker (real git repo + worktree; the SDK/claude edges mocked, the
// swarmWorkerFailFast.test.ts harness) and read the file back through the
// engine's own heartbeat reader, so the writer/reader keys must agree too.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdir, mkdtemp, rm, realpath, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const execFile = promisify(execFileCb)
const git = (cwd: string, args: string[]) =>
  execFile('git', args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })

const mocks = vi.hoisted(() => ({ occupied: false }))

vi.mock('./claudeTerminal', () => ({
  launchClaude: () => {
    throw new Error('launchClaude must never be reached by a worker spawn')
  },
}))
vi.mock('./hooksInstall', () => ({ ensureGuardWiring: async () => ({ ok: true, problems: [] }) }))
vi.mock('./experiments', () => ({ isExperimentEnabled: async () => false }))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: async () => ({ model: 'sonnet', effort: 'medium' }),
}))
vi.mock('./swarmWorkerSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmWorkerSdk')>()),
  sdkWorkerPreflight: () => ({ ok: true, problems: [], claudeBin: '/usr/local/bin/claude', cliVersion: '2.1.220' }),
  sdkWorkerLaunchPlan: () => ({ options: {}, initialPrompt: '/order go', warnings: [] }),
}))
vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: (o: { cwd: string }) => ({
    id: 'sdk-live',
    cwd: o.cwd,
    status: 'working',
    exitReason: undefined,
    startedAt: 0,
    lastEventAt: 0,
    seq: 0,
  }),
}))
vi.mock('./liveDesks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./liveDesks')>()
  return {
    ...actual,
    liveDeskOccupies: async (dir: string) => (mocks.occupied ? true : actual.liveDeskOccupies(dir)),
  }
})

import { spawnSwarmWorker, WorktreeOccupiedError } from './swarmWorker'
import { swarmRepoKey } from './swarmJanitor'
import { defaultDeps, runDispatchPass, __seedEngineForTests, __resetOrchestratorForTests } from './swarmOrchestrator'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import { setSettings } from './store'
import { __resetSdkSessionsForTests } from './sdkSession'

describe('spawnSwarmWorker — a re-entering worker starts with no inherited heartbeat', () => {
  let scratch: string
  let project: string
  let branch: string
  let worktree: string
  let hbFile: string

  const writeStaleReady = async () => {
    await writeFile(
      hbFile,
      JSON.stringify({ branch, worktree, phase: 'done', readyToMerge: true, task: 'previous worker done', updatedAt: '2026-10-02T09:00:00Z' }),
    )
  }
  const exists = (p: string) => stat(p).then(
    () => true,
    () => false,
  )

  beforeEach(async () => {
    mocks.occupied = false
    __resetSdkSessionsForTests()
    __resetMigrationCacheForTests?.()
    __resetOrchestratorForTests()
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-reentry-hb-')))
    project = join(scratch, 'proj')
    await git(scratch, ['init', '-q', '-b', 'main', 'proj'])
    await git(project, ['config', 'user.email', 'dev@test'])
    await git(project, ['config', 'user.name', 'Dev'])
    await writeFile(join(project, 'README.md'), '# x\n')
    await git(project, ['add', '-A'])
    await git(project, ['commit', '-q', '-m', 'base'])
    await addProjectEntry(project)
    // The previous worker: a real worktree + branch, and its ready heartbeat.
    const first = await spawnSwarmWorker({ projectPath: project, title: 'a card' })
    branch = first.branch
    worktree = first.worktree
    __resetSdkSessionsForTests()
    const dir = join(process.env.OPENGROUND_HOME!, 'swarm', (await swarmRepoKey(project))!)
    await mkdir(dir, { recursive: true })
    hbFile = join(dir, `${branch.replace(/\//g, '-')}.json`)
    await writeStaleReady()
    // Sanity: the engine's own reader sees the stale ready before the re-entry.
    expect((await defaultDeps().readHeartbeat(project, branch))?.ready).toBe(true)
  })

  afterEach(async () => {
    __resetOrchestratorForTests()
    __resetSdkSessionsForTests()
    await setSettings({})
    await rm(scratch, { recursive: true, force: true })
  })

  // ① TEETH: RED with the delete in spawnSwarmWorker removed (measured 2026-10-02).
  it('MANUAL door (「やり直す」 then 実行): the unowned card is NOT promoted on the previous ready', async () => {
    // What POST /api/swarm/worker does for a card that already has a branch.
    await spawnSwarmWorker({ projectPath: project, title: 'a card', worktree })
    expect(await defaultDeps().readHeartbeat(project, branch)).toBeNull()

    // The next engine pass: the manual worker is in no engine.workers, the card
    // sits in doing with the previous worker's commits and no reworkCount.
    const engine = {
      path: project,
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
      notified: new Set(),
      pendingFatal: [],
    } as never
    __seedEngineForTests(engine)
    const promoted: string[] = []
    const deps = {
      fetchTasks: async () => [{ id: 'card-1', title: 'redo me', notes: 'x', done: false, boardColumn: 'doing', branch }],
      readHeartbeat: defaultDeps().readHeartbeat, // the REAL file reader
      countCommitsAhead: async () => 3, // the previous worker's commits
      moveToReview: async (_p: string, id: string) => {
        promoted.push(id)
        return true
      },
      moveToDoing: async () => true,
      spawnWorker: async () => {
        throw new Error('no dispatch expected')
      },
      isAlive: () => true,
      recoverCard: async () => true,
      recoverWorker: async () => ({ removed: true }),
      lastOutputAt: () => null,
      nudge: () => true,
      escalate: async () => true,
      recentOutput: () => null,
      unownedDeskState: async () => ({ kind: 'live' }),
    } as never
    await runDispatchPass(engine, deps)
    expect(promoted).toEqual([])
  })

  // ② TEETH: RED with the delete moved above the occupancy check (measured 2026-10-02).
  it('a REFUSED spawn (live desk in the worktree) leaves that desk’s heartbeat alone', async () => {
    mocks.occupied = true
    await expect(spawnSwarmWorker({ projectPath: project, title: 'a card', worktree })).rejects.toThrow(
      WorktreeOccupiedError,
    )
    expect(await exists(hbFile)).toBe(true)
    expect((await defaultDeps().readHeartbeat(project, branch))?.ready).toBe(true)
  })

  it('a --resume keeps the file: it is the resumed worker’s own sign', async () => {
    await spawnSwarmWorker({ projectPath: project, title: 'a card', worktree, resumeSessionId: 'sess-keep' })
    expect(await exists(hbFile)).toBe(true)
  })

  // ③ A delete that faults (here: the path is a directory) never fails the spawn.
  it('a FAILING delete does not fail the spawn', async () => {
    await rm(hbFile)
    await mkdir(hbFile) // unlink on a directory throws EPERM/EISDIR, not ENOENT
    const res = await spawnSwarmWorker({ projectPath: project, title: 'a card', worktree })
    expect(res.worktree).toBe(worktree)
  })

  it('only the re-entered branch’s file is deleted', async () => {
    const other = join(hbFile, '..', 'swarm-someone-else.json')
    await writeFile(other, JSON.stringify({ branch: 'swarm/someone-else', readyToMerge: true }))
    await spawnSwarmWorker({ projectPath: project, title: 'a card', worktree })
    expect(await exists(hbFile)).toBe(false)
    expect(await exists(other)).toBe(true)
  })
})
