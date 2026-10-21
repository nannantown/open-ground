// @vitest-environment node
//
// THE QUOTA RESPAWN SPIN (measured on sns-hub, 2026-10-20 08:44Z–09:13Z).
//
// Two `design` cards (optimize ⇒ desired opus) hit the 5-hour SESSION limit
// ("You've hit your session limit · resets 8:30pm"), which caps every model. The
// engine cooled opus, then sonnet, then haiku — and then re-seated each requeued
// card on the COOLING opus about once a minute for half an hour (54 launches),
// because two gates disagreed:
//
//   • the launch resolver also vetoes the top tier (fable) from the cached
//     /usage scrape (session ≥ 100%) — with every other tier cooling it falls back
//     to the desired tier, cooling or not;
//   • the park gate (spawnBlock) only reads the cooling table + the owner's mask,
//     where fable was NOT cooling — so it never parked.
//
// spawnSwarmWorker now refuses a cooling tier before any worktree or session
// exists (TierCoolingError). These cases rebuild that exact state through the
// PRODUCTION resolver and cooling table; only the outside world is faked.
// Red measured 2026-10-21 by removing the TierCoolingError gate in swarmWorker.ts,
// and (the reset cases) by making isTierCooling ignore `until` — the reset steps
// move ONLY the clock and keep the /usage fable veto, so escaping to fable can't
// pass them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const sdkLaunches: unknown[] = []
const wiringChecks: number[] = []
let usage: unknown = null

vi.mock('./sdkSession', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sdkSession')>()),
  spawnSdkSession: (o: unknown) => {
    sdkLaunches.push(o)
    throw new Error('test: no real SDK session')
  },
}))
vi.mock('./claudeTerminal', () => ({
  launchClaude: () => {
    throw new Error('launchClaude must never be reached')
  },
}))
vi.mock('./hooksInstall', () => ({
  ensureGuardWiring: async () => {
    wiringChecks.push(1)
    return { ok: true, problems: [] }
  },
}))
vi.mock('./experiments', () => ({ isExperimentEnabled: async () => false }))
vi.mock('./swarmTierProbe', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmTierProbe')>()),
  ensureTierProbed: async () => 'ok',
}))
vi.mock('./claudeUsageCli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeUsageCli')>()),
  peekCachedUsage: () => usage,
}))

import { spawnSwarmWorker, TierCoolingError } from './swarmWorker'
import { markCoolingUntil, flushQuotaPersist, __resetQuotaForTest } from './swarmQuota'
import { spawnBlock, __resetAllowedModelsForTest } from './swarmAllowedModels'
import { resolveSwarmModelEffort } from './swarmLaunch'
import { DEFAULT_SWARM_ALLOWED_MODELS } from '../types'
import type { ProjectTask, SpawnSwarmWorkerResponse } from '../types'
import { runDispatchPass, __seedEngineForTests, type ProjectEngine } from './swarmOrchestrator'

vi.setConfig({ testTimeout: 30_000 })

const T0 = Date.parse('2026-10-20T09:00:00Z')
const RESET = Date.parse('2026-10-20T11:30:00Z')

let scratch = ''
let savedHome: string | undefined

beforeEach(async () => {
  sdkLaunches.length = 0
  wiringChecks.length = 0
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-quotaspin-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = join(scratch, 'home')
  await mkdir(join(scratch, 'home'), { recursive: true })
  // sns-hub's settings that day: optimize, every tier switched ON.
  await writeFile(
    join(scratch, 'home', 'settings.json'),
    JSON.stringify({ executionMode: 'optimize', swarmAllowedModels: { ...DEFAULT_SWARM_ALLOWED_MODELS } }),
  )
  __resetQuotaForTest()
  __resetAllowedModelsForTest()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
  // The session wall: opus / sonnet / haiku already cooled by the first three
  // refusals; fable is NOT in the table — only the /usage veto keeps it out.
  for (const t of ['opus', 'sonnet', 'haiku'] as const) markCoolingUntil(t, RESET)
  usage = { session: { pct: 100, resetsAt: '8:30pm (Asia/Tokyo)' }, weekAll: { pct: 40, resetsAt: '' }, weekModels: [] }
})

afterEach(async () => {
  vi.useRealTimers()
  await flushQuotaPersist() // let the marks' disk mirror land in THIS home before it goes
  __resetQuotaForTest()
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
  await rm(scratch, { recursive: true, force: true })
})

const designCard = (worktree?: string) => ({
  projectPath: join(scratch, 'proj'),
  title: 'NUANQA: Instagram 投稿の下書き',
  notes: 'completion conditions',
  tier: 'design' as const,
  ...(worktree ? { worktree } : {}),
})

describe('quota respawn spin — a card is never re-seated on a cooling tier', () => {
  it('the park gate alone does not see this state (the gap the spawn gate closes)', () => {
    expect(spawnBlock(T0)).toBeNull()
  })

  it('re-entry into the previous worktree is refused while the only usable tier is cooling', async () => {
    const err = await spawnSwarmWorker(designCard(join(scratch, 'home', 'projects', 'x', 'worktrees', 'old'))).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(TierCoolingError)
    expect((err as TierCoolingError).tier).toBe('opus')
    expect((err as TierCoolingError).until).toBe(RESET)
    // Refused BEFORE anything was launched or even wired.
    expect(sdkLaunches).toHaveLength(0)
    expect(wiringChecks).toHaveLength(0)
  })

  it('a fresh dispatch is refused the same way', async () => {
    await expect(spawnSwarmWorker(designCard())).rejects.toBeInstanceOf(TierCoolingError)
    expect(sdkLaunches).toHaveLength(0)
  })

  it('once the wall resets, the same spawn goes through the gate (not parked forever)', async () => {
    // ONLY the clock moves. The cached /usage still says session 100%, so fable
    // stays vetoed — passing here proves opus's cooling expired, not that the
    // resolver escaped to fable.
    vi.setSystemTime(RESET + 1_000)
    const card = designCard()
    expect(
      resolveSwarmModelEffort('optimize', 'worker', card, Date.now(), { ...DEFAULT_SWARM_ALLOWED_MODELS }, usage as never)
        ?.model,
    ).toBe('opus')
    const err = await spawnSwarmWorker(card).catch((e: unknown) => e)
    // It got past the model gate to the next stage (guard wiring); what fails
    // after that is this test's fake project, not the quota.
    expect(err).not.toBeInstanceOf(TierCoolingError)
    expect(wiringChecks).toHaveLength(1)
  })

  it('another usable tier still takes the card (one try there, not a wait)', async () => {
    usage = null // fable not vetoed and not cooling ⇒ launch on fable
    const err = await spawnSwarmWorker(designCard()).catch((e: unknown) => e)
    expect(err).not.toBeInstanceOf(TierCoolingError)
    expect(wiringChecks).toHaveLength(1)
  })
})

// The engine's half, against the same real resolver state: the fill stage checks
// each card BEFORE any git work (re-entry resolution) and never calls the spawner,
// says each card's wait once — two cards waiting on DIFFERENT tiers used to flip
// one shared signature and log every pass — and dispatches both after the reset.
describe('quota respawn spin — the engine waits per card and resumes after the reset', () => {
  const engineLiteral = () =>
    ({
      path: '/proj-quota-spin',
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
      log: [] as { message: string }[],
      anomalies: [],
      notified: new Set(),
      pendingFatal: [],
    }) as unknown as ProjectEngine

  it('no spawn and no re-entry git while cooling; one line per card; both start after the reset', async () => {
    const tasks = [
      { id: 'd', title: 'design card', notes: 'completion conditions', tier: 'design', boardColumn: 'todo', branch: 'swarm/d' },
      { id: 't', title: 'touch card', notes: 'completion conditions', tier: 'touch', boardColumn: 'todo', branch: 'swarm/t' },
    ] as unknown as ProjectTask[]
    const board = new Map(tasks.map((t) => [t.id, { ...t }]))
    const spawned: string[] = []
    const reuseLookups: string[] = []
    const deps = {
      fetchTasks: async () => Array.from(board.values()),
      resolveReusableWork: async (_p: string, c: ProjectTask) => {
        reuseLookups.push(c.id)
        return { worktree: `/wt/${c.id}`, branch: c.branch as string }
      },
      spawnWorker: async (opts: { worktree?: string; title: string }): Promise<SpawnSwarmWorkerResponse> => {
        spawned.push(opts.title)
        const id = opts.title.startsWith('design') ? 'd' : 't'
        return { terminalId: `pty-${id}`, agentSessionId: 's', worktree: `/wt/${id}`, branch: `swarm/${id}` } as SpawnSwarmWorkerResponse
      },
      moveToDoing: async (_p: string, id: string, branch: string) => {
        const c = board.get(id)
        if (c) board.set(id, { ...c, boardColumn: 'doing', branch })
        return true
      },
      moveToReview: async () => true,
      countCommitsAhead: async () => 0,
      readHeartbeat: async () => null,
      isAlive: () => true,
      recoverCard: async () => true,
      recoverWorker: async () => ({ removed: true }),
      lastOutputAt: () => null,
      nudge: () => true,
      escalate: async () => true,
      recentOutput: () => null,
    } as never
    const engine = engineLiteral()
    __seedEngineForTests(engine)

    for (let i = 0; i < 3; i++) {
      vi.setSystemTime(T0 + i * 3_000)
      await runDispatchPass(engine, deps)
    }

    expect(spawned).toEqual([])
    expect(reuseLookups).toEqual([]) // no git work for a card that cannot launch
    expect(Array.from(board.values()).map((c) => c.boardColumn)).toEqual(['todo', 'todo'])
    const deferred = engine.log.filter((l) => l.message.startsWith('dispatch deferred'))
    expect(deferred).toHaveLength(2) // once per card, not once per pass
    expect(deferred.some((l) => l.message.includes('tier opus'))).toBe(true)
    expect(deferred.some((l) => l.message.includes('tier sonnet'))).toBe(true)
    expect(engine.metrics?.dispatched ?? 0).toBe(0)
    // The dashboard / president read this as "paused until" — spawnBlock alone left it unset.
    expect(engine.parkUntil).toBe(RESET)

    // Only the clock moves — /usage still vetoes fable, so both cards must launch
    // on their own (now expired) tiers, not escape to fable.
    vi.setSystemTime(RESET + 1_000)
    await runDispatchPass(engine, deps)

    expect(spawned.sort()).toEqual(['design card', 'touch card'])
    expect(engine.metrics?.dispatched).toBe(2)
    expect(engine.parkUntil).toBeUndefined()
  })
})
