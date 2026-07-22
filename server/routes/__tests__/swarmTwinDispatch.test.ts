// The TWIN-DISPATCH regression suite for POST /api/swarm/worker.
//
// The bug (audit 856daefb): the route spawned the worker FIRST and claimed the
// Board card (todo→doing) afterwards. `spawnSwarmWorker` creates a git worktree —
// hundreds of ms, sometimes seconds — and for that whole window the card still
// read `todo` while being invisible to the autonomous engine's countedIds (a
// manual worker is not in engine.workers). Any runDispatchPass landing in that
// window re-selected the SAME card and spawned a SECOND worker: two `swarm/*`
// branches on one card, one guaranteed to conflict at integration.
//
// The proof below is the reproduction, not a proxy: the fake spawn reads the LIVE
// board mid-spawn and runs the engine's own `selectDispatch` against it. Before
// the fix that call returns the card (the engine would have grabbed it); now the
// card already reads `doing`, so it returns nothing.
//
// The engine's own mid-spawn window (its card is `todo` and not yet in its
// roster) is covered from the other side — see the `pendingDispatch` block in
// src/lib/server/swarmOrchestrator.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { __resetMigrationCacheForTests } from '@/lib/server/registry'
import {
  __resetOrchestratorForTests,
  __seedEngineForTests,
  emptyMetricsCounters,
  runDispatchPass,
  selectDispatch,
} from '@/lib/server/swarmOrchestrator'
import type { OrchestratorDeps, ProjectEngine } from '@/lib/server/swarmOrchestrator'
import { initSelfSupplyRuntime } from '@/lib/server/swarmSelfSupply'
import { initOverseerRuntime } from '@/lib/server/swarmOverseer'
import { readProjectData, mutateProjectData } from '@/lib/server/projectData'
import type { ProjectTask, SpawnSwarmWorkerResponse } from '@/lib/types'

/** The fake spawn body, swapped per test. Hoisted so the vi.mock factory (which
 *  runs before the module body) can close over it. `onBoardRead` fires after every
 *  board read, so a test can force an interleaving that only a real concurrent
 *  engine could otherwise produce. */
const hooks = vi.hoisted(() => ({
  spawn: (async () => {
    throw new Error('spawn hook not set')
  }) as (opts: any) => Promise<any>,
  onBoardRead: null as null | (() => void),
}))

// The board reads stay REAL; the wrapper only gives tests a hook to run code at
// the exact moment the route has finished a read — the seam that lets us drop the
// engine's reservation into the gap between the route's in-flight probe and its CAS.
vi.mock('@/lib/server/projectData', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/projectData')>()
  return {
    ...actual,
    readProjectData: async (path: string) => {
      const data = await actual.readProjectData(path)
      hooks.onBoardRead?.()
      return data
    },
  }
})

// The claude CLI never runs here: the preflight is the last gate before the spawn,
// so a stub keeps the route reachable without a signed-in CLI.
vi.mock('@/lib/server/claudePreflight', () => ({
  claudeRunPreflight: async () => ({ ok: true }),
}))

// Only the spawn is faked (no worktree, no PTY); the rest of swarmWorker — and
// every other module that imports it — keeps its real implementation.
vi.mock('@/lib/server/swarmWorker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/swarmWorker')>()
  return { ...actual, spawnSwarmWorker: (opts: unknown) => hooks.spawn(opts) }
})

const OWNER = 'owner@example.com'
process.env.OPENGROUND_OWNER_EMAILS = OWNER

const SPAWNED: SpawnSwarmWorkerResponse = {
  terminalId: 'term-1',
  agentSessionId: 'sess-1',
  worktree: '/tmp/fake-worktree',
  branch: 'swarm/fake-branch',
}

/** Every spawn call the route made, in order. */
let spawnCalls: any[]

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

let home: string
let proj: string
let fakeHome: string
let savedRealHome: string | undefined

const register = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  const res = await app.request('/api/projects/import', json({ path: dir }))
  expect(res.status).toBe(200)
}

const seedCard = async (task: Partial<ProjectTask> & { id: string }): Promise<void> => {
  await mutateProjectData(proj, (data) => {
    data.tasks.push({
      title: 'fix the thing',
      done: false,
      createdAt: new Date(0).toISOString(),
      boardColumn: 'todo',
      ...task,
    })
  })
}

const cardNow = async (id: string): Promise<ProjectTask | undefined> =>
  (await readProjectData(proj)).tasks.find((t) => t.id === id)

beforeEach(async () => {
  home = await realpath(await mkdtemp(join(tmpdir(), 'og-twin-home-')))
  proj = await realpath(await mkdtemp(join(tmpdir(), 'og-twin-proj-')))
  process.env.OPENGROUND_HOME = home
  // Pin $HOME too, not just OPENGROUND_HOME. The dispatch route reaches the
  // worker spawn path, and that path calls ensureGuardWiring → hooksInstall,
  // whose install dirs are anchored at homedir() ON PURPOSE (hooksInstall.ts:190)
  // — OPENGROUND_HOME cannot move them. Measured 2026-07-19 under
  // `vitest run --no-isolate`, where the spawn hook below no longer intercepts
  // (shared module registry): the route reached the REAL ~/.claude and the
  // production-home fence refused it 10 times (500s). Under isolate:true the
  // hook holds and it never gets there — i.e. this was a silent latent hole.
  savedRealHome = process.env.HOME
  fakeHome = await realpath(await mkdtemp(join(tmpdir(), 'og-twin-userhome-')))
  process.env.HOME = fakeHome
  __resetMigrationCacheForTests()
  await writeSession({
    user: { id: 'test-user', email: OWNER, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'a',
    refreshToken: 'r',
  })
  await register(proj)
  spawnCalls = []
  hooks.onBoardRead = null
  hooks.spawn = async (opts) => {
    spawnCalls.push(opts)
    return SPAWNED
  }
})

afterEach(async () => {
  __resetOrchestratorForTests()
  await clearSession()
  // Restore, never delete: an unset HOME sends os.homedir() back to the passwd
  // entry — i.e. the real home this block exists to keep out of reach.
  if (savedRealHome !== undefined) process.env.HOME = savedRealHome
  await rm(home, { recursive: true, force: true })
  await rm(fakeHome, { recursive: true, force: true })
  await rm(proj, { recursive: true, force: true })
})

describe('POST /api/swarm/worker — the card is claimed BEFORE the worker spawns', () => {
  it('a dispatch pass landing mid-spawn can no longer select the same card (the twin)', async () => {
    await seedCard({ id: 'c1' })

    // What the autonomous engine would see if its runDispatchPass fired at the
    // WORST possible moment: while the worktree is being created.
    let columnMidSpawn: string | undefined
    let enginePicksMidSpawn: string[] = []
    hooks.spawn = async (opts) => {
      spawnCalls.push(opts)
      const data = await readProjectData(proj)
      const card = data.tasks.find((t) => t.id === 'c1')
      columnMidSpawn = card?.boardColumn
      // `dispatchedIds` is empty on purpose: a MANUAL worker never appears in the
      // engine's roster, so the board column is the only thing that can stop it.
      enginePicksMidSpawn = selectDispatch(data.tasks, new Set(), 1).map((t) => t.id)
      return SPAWNED
    }

    const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c1' }))
    expect(res.status).toBe(200)

    // THE bug, stated directly: before the fix the card still read `todo`
    // mid-spawn, so the engine's own selector handed it back for a second worker.
    expect(enginePicksMidSpawn).toEqual([])
    expect(columnMidSpawn).toBe('doing') // claimed before the spawn started

    // …and the live worker's branch still lands on the card afterwards.
    const after = await cardNow('c1')
    expect(after?.boardColumn).toBe('doing')
    expect(after?.branch).toBe(SPAWNED.branch)
    expect(after?.done).toBe(false)
  })

  it('hands the claim back to todo when the spawn fails — no worker-less doing card', async () => {
    await seedCard({ id: 'c1' })
    hooks.spawn = async () => {
      throw new Error('git worktree add failed')
    }

    const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c1' }))
    expect(res.status).toBe(500)

    const after = await cardNow('c1')
    expect(after?.boardColumn).toBe('todo') // re-dispatchable, not stranded
    expect(after?.branch).toBeUndefined()
  })

  it('refuses (409) a card another dispatch already owns, and spawns nothing', async () => {
    await seedCard({ id: 'c1', boardColumn: 'doing', branch: 'swarm/first-worker' })

    const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c1' }))
    expect(res.status).toBe(409)
    expect(spawnCalls).toHaveLength(0)

    // The first worker's card is untouched — no branch stomped.
    const after = await cardNow('c1')
    expect(after?.boardColumn).toBe('doing')
    expect(after?.branch).toBe('swarm/first-worker')
  })

  it('refuses (409) a review card too — its branch is promoted but unmerged', async () => {
    await seedCard({ id: 'c1', boardColumn: 'review', branch: 'swarm/ready' })
    const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c1' }))
    expect(res.status).toBe(409)
    expect(spawnCalls).toHaveLength(0)
  })

  it('a RESTART re-enters the existing worktree of a doing card (it mints no rival branch)', async () => {
    await seedCard({ id: 'c1', boardColumn: 'doing', branch: 'swarm/first-worker' })

    const res = await app.request(
      '/api/swarm/worker',
      json({ path: proj, taskId: 'c1', worktree: '/tmp/fake-worktree' }),
    )
    expect(res.status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].worktree).toBe('/tmp/fake-worktree')

    // A restart claims nothing, so the card keeps the branch it was working on.
    const after = await cardNow('c1')
    expect(after?.boardColumn).toBe('doing')
    expect(after?.branch).toBe('swarm/first-worker')
  })

  it('a blocked card is dispatched without a claim — the engine never contends for it', async () => {
    await seedCard({ id: 'c1', boardColumn: 'blocked' })
    const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c1' }))
    expect(res.status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    expect((await cardNow('c1'))?.boardColumn).toBe('blocked')
  })

  it('a title-only spawn (no card) never touches the board', async () => {
    const res = await app.request('/api/swarm/worker', json({ path: proj, title: 'no card' }))
    expect(res.status).toBe(200)
    expect((await readProjectData(proj)).tasks).toHaveLength(0)
  })
})

// ── The OTHER direction: the ENGINE spawns first, the manual route arrives mid-pass ──
//
// The suite above proves a manual dispatch can no longer be twinned by the engine.
// The reverse is a separate hazard with its own two windows, and the engine owns
// both:
//
//   1. RESERVATION SCOPE — one dispatch pass can pick SEVERAL cards. Reserving them
//      one at a time (inside the loop) leaves picks[1..] unreserved for the whole of
//      picks[0]'s spawn, so `isCardDispatchInFlight` answers false for a card this
//      pass is about to spawn on. The manual route claims it, spawns, and the pass
//      then spawns a TWIN on the very same card.
//   2. STALE PICKS — `picks` is a snapshot. A claim that landed BEFORE the
//      reservation (or any other column move) is invisible to it, so the pass must
//      re-read each card immediately before spawning it rather than trusting the
//      snapshot.
//
// Both are reproduced below against the REAL board and the REAL route.

/** A ProjectEngine literal (mirrors swarmOrchestrator.test.ts's `newEngine`), seeded
 *  into the store so the route's `isCardDispatchInFlight` can find it by path. */
const newEngine = (path: string): ProjectEngine => ({
  path,
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
  pendingDispatch: new Set(),
})

/** Only the deps a dispatch pass with an EMPTY worker roster actually reaches. The
 *  board is the real one on disk, so the route and the engine contend for the same
 *  cards exactly as they do in production. */
const engineDeps = (spawnWorker: OrchestratorDeps['spawnWorker']): OrchestratorDeps =>
  ({
    fetchTasks: async (p: string) => (await readProjectData(p)).tasks,
    moveToDoing: async (p: string, taskId: string, branch: string) => {
      await mutateProjectData(p, (data) => {
        const card = data.tasks.find((t) => t.id === taskId)
        if (card) {
          card.boardColumn = 'doing'
          card.branch = branch
          card.done = false
        }
      })
      return true
    },
    spawnWorker,
    isAlive: () => true,
  }) as unknown as OrchestratorDeps

describe('runDispatchPass — the engine cannot twin a card the manual route takes', () => {
  const twoTodos = async (): Promise<void> => {
    await seedCard({ id: 'c1', title: 'first card', boardOrder: 0 })
    await seedCard({ id: 'c2', title: 'second card', boardOrder: 1 })
  }

  it('reserves EVERY pick before the first spawn — a manual dispatch mid-spawn is refused', async () => {
    await twoTodos()
    const engine = newEngine(proj)
    __seedEngineForTests(engine)

    const engineSpawned: string[] = []
    let manualStatus = 0
    const deps = engineDeps(async (opts) => {
      engineSpawned.push(opts.title)
      if (opts.title === 'first card') {
        // The worst moment: pick #1's worktree is being created and pick #2 has not
        // been spawned yet. Before the fix `pendingDispatch` held only `c1` here, so
        // the route saw `c2` free, claimed it and spawned a rival worker on it.
        const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c2' }))
        manualStatus = res.status
      }
      return SPAWNED
    })

    await runDispatchPass(engine, deps)

    expect(manualStatus).toBe(409) // c2 was reserved before ANY spawn started
    expect(spawnCalls).toHaveLength(0) // …so the route spawned nothing
    expect(engineSpawned).toEqual(['first card', 'second card'])
    // One worker per card — the twin never existed.
    expect(engine.workers.map((w) => w.taskId).sort()).toEqual(['c1', 'c2'])
    expect(engine.pendingDispatch?.size).toBe(0) // every reservation released
  })

  it('re-verifies each pick right before spawning it — a card claimed meanwhile is skipped', async () => {
    await twoTodos()
    const engine = newEngine(proj)
    __seedEngineForTests(engine)

    const engineSpawned: string[] = []
    const deps = engineDeps(async (opts) => {
      engineSpawned.push(opts.title)
      if (opts.title === 'first card') {
        // A claim that beat the reservation: the card is `doing` with someone else's
        // branch on it. `picks` is a pre-spawn snapshot and cannot see this, so only
        // a fresh read taken before the spawn can stop the twin.
        await mutateProjectData(proj, (data) => {
          const card = data.tasks.find((t) => t.id === 'c2')
          if (card) {
            card.boardColumn = 'doing'
            card.branch = 'swarm/manual-worker'
          }
        })
      }
      return SPAWNED
    })

    await runDispatchPass(engine, deps)

    expect(engineSpawned).toEqual(['first card']) // c2 skipped, not spawned on
    expect(engine.workers.map((w) => w.taskId)).toEqual(['c1'])
    expect(engine.log.some((l) => l.message.startsWith('dispatch skipped'))).toBe(true)

    // The other dispatcher's card is untouched — its branch was never stomped.
    const c2 = await cardNow('c2')
    expect(c2?.boardColumn).toBe('doing')
    expect(c2?.branch).toBe('swarm/manual-worker')
  })

  it('releases every reservation when a spawn THROWS — the cards stay dispatchable', async () => {
    await twoTodos()
    const engine = newEngine(proj)
    __seedEngineForTests(engine)

    const deps = engineDeps(async () => {
      throw new Error('git worktree add failed')
    })
    await runDispatchPass(engine, deps)

    expect(engine.workers).toHaveLength(0)
    expect(engine.pendingDispatch?.size).toBe(0)
    // Nothing was claimed, so a later pass (or the owner) can pick them up again.
    expect((await cardNow('c1'))?.boardColumn).toBe('todo')
    expect((await cardNow('c2'))?.boardColumn).toBe('todo')
  })

  it('releases the reservations when the engine STOPS mid-pass', async () => {
    await twoTodos()
    const engine = newEngine(proj)
    __seedEngineForTests(engine)

    const engineSpawned: string[] = []
    const deps = engineDeps(async (opts) => {
      engineSpawned.push(opts.title)
      engine.running = false // an owner hits "autonomy OFF" mid-spawn
      return SPAWNED
    })
    await runDispatchPass(engine, deps)

    expect(engineSpawned).toEqual(['first card']) // the pass halted promptly
    expect(engine.pendingDispatch?.size).toBe(0) // the early `return` still released c2
  })

  it('the route hands the card back when the engine reserved it between the probe and the claim', async () => {
    await seedCard({ id: 'c1' })
    const engine = newEngine(proj)
    __seedEngineForTests(engine)

    // The route probes isCardDispatchInFlight, THEN claims. Reserve `c1` in that gap
    // (after the claim's pre-read, before its CAS) — precisely what a dispatch pass
    // starting a hair later does. The probe already answered "free", so only the
    // re-check taken UNDER the claim can catch it.
    let reads = 0
    hooks.onBoardRead = () => {
      if (++reads === 2) engine.pendingDispatch?.add('c1')
    }

    const res = await app.request('/api/swarm/worker', json({ path: proj, taskId: 'c1' }))

    expect(res.status).toBe(409)
    expect(spawnCalls).toHaveLength(0) // no rival worker on the engine's card
    const after = await cardNow('c1')
    expect(after?.boardColumn).toBe('todo') // claim handed back, not stranded in doing
    expect(after?.branch).toBeUndefined()
  })
})
