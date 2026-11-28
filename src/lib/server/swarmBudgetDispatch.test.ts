// @vitest-environment node
//
// THE BUDGET GATE IN THE ENGINE (AUTONOMY-SPEC R-D1 / R-D2). Automatic dispatch
// starts a new worker only while the 5-hour window is under the card's start
// ceiling; a worker already running is never stopped; when every candidate is
// held the engine parks with a stated `until` and resumes by itself; Board Run
// (the owner's own press) is never gated.
//
// The reading comes from the two production sources, both through the window
// store: a successful /usage scrape (recordUsageScrape — what fetchClaudeUsageCli
// writes; the scrape itself is a PTY and is covered by usageScrapeWindows.test.ts)
// and the SDK's structured `rate_limit_event`. Everything else is the production
// engine pass.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// The production wiring's target is observed, never run (a real scrape is a PTY).
vi.mock('./claudeUsageCli', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeUsageCli')>()),
  refreshUsageCacheDetached: vi.fn(),
}))
// Board Run's door (launchClaude) without a real PTY or a write to ~/.claude.json.
vi.mock('./terminal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./terminal')>()),
  createTerminal: vi.fn(() => ({ id: 'board-run', cwd: '/proj-budget' })),
}))
vi.mock('./claudeTrust', () => ({ ensureClaudeFolderTrusted: vi.fn() }))

import { runDispatchPass, runIntegratePass, defaultDeps, standingFactsOf, __seedEngineForTests, type ProjectEngine } from './swarmOrchestrator'
import { standingOf } from './swarmStanding'
import { __resetQuotaForTest } from './swarmQuota'
import { __resetAllowedModelsForTest } from './swarmAllowedModels'
import { recordRateLimitEvent, recordUsageScrape, flushUsageWindowsPersist, __resetUsageWindowsForTest } from './usageWindows'
import { launchClaude } from './claudeTerminal'
import { createTerminal } from './terminal'
import { refreshUsageCacheDetached } from './claudeUsageCli'
import { USAGE_REFRESH_BACKOFF_MS } from './swarmBudget'
import type { OrchestratorWorker, ProjectTask, SpawnSwarmWorkerResponse } from '../types'
import type { CliUsage } from './claudeUsageCli'

vi.setConfig({ testTimeout: 30_000 })

const T0 = Date.parse('2026-11-28T06:00:00Z')
const HOUR = 3_600_000

let scratch = ''
let savedHome: string | undefined
const refreshUsage = vi.fn()

const usageAt = (sessionPct: number, capturedAt = T0 - 60_000): CliUsage => ({
  session: { pct: sessionPct, resetsAt: 'in 2 hours' },
  weekAll: { pct: 20, resetsAt: 'in 3 days' },
  weekModels: [],
  capturedAt: new Date(capturedAt).toISOString(),
  status: 'ok',
})
const scraped = (sessionPct: number, capturedAt?: number) => recordUsageScrape(usageAt(sessionPct, capturedAt))

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-budget-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = join(scratch, 'home')
  await mkdir(join(scratch, 'home'), { recursive: true })
  await writeFile(join(scratch, 'home', 'settings.json'), JSON.stringify({ executionMode: 'optimize' }))
  __resetQuotaForTest()
  __resetAllowedModelsForTest()
  __resetUsageWindowsForTest()
  vi.mocked(refreshUsageCacheDetached).mockClear()
  refreshUsage.mockClear()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(async () => {
  vi.useRealTimers()
  await flushUsageWindowsPersist()
  __resetUsageWindowsForTest()
  __resetQuotaForTest()
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 })
})

const engineLiteral = (workers: OrchestratorWorker[] = []) =>
  ({
    path: '/proj-budget',
    running: true,
    passInFlight: false,
    generation: 0,
    timer: null,
    workers,
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

const harness = (extra: ProjectTask[] = []) => {
  const tasks = [
    { id: 's', title: 'standard card', notes: 'completion conditions', tier: 'standard', boardColumn: 'todo' },
    { id: 't', title: 'touch card', notes: 'completion conditions', tier: 'touch', boardColumn: 'todo' },
    ...extra,
  ] as unknown as ProjectTask[]
  const board = new Map(tasks.map((t) => [t.id, { ...t }]))
  const spawned: string[] = []
  const recovered: string[] = []
  const deps = {
    fetchTasks: async () => Array.from(board.values()),
    resolveReusableWork: async () => null,
    spawnWorker: async (opts: { title: string }): Promise<SpawnSwarmWorkerResponse> => {
      spawned.push(opts.title)
      const id = opts.title.startsWith('standard') ? 's' : 't'
      return { terminalId: '', runtime: 'sdk', sdkSessionId: `sdk-${id}`, agentSessionId: id, worktree: `/wt/${id}`, branch: `swarm/${id}` } as SpawnSwarmWorkerResponse
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
    recoverCard: async (_p: string, id: string) => {
      recovered.push(id)
      return true
    },
    recoverWorker: async () => ({ removed: true }),
    lastOutputAt: () => Date.now(),
    nudge: () => true,
    escalate: async () => true,
    recentOutput: () => null,
    refreshUsage,
  } as never
  return { board, spawned, recovered, deps }
}

describe('budget gate — the 5-hour window at 85%', () => {
  it('only the touch card dispatches; the running worker is untouched; Board Run still spawns', async () => {
    scraped(85)
    const running: OrchestratorWorker = {
      terminalId: '',
      runtime: 'sdk',
      sdkSessionId: 'sdk-r',
      branch: 'swarm/r',
      worktree: '/wt/r',
      taskId: 'r',
      taskTitle: 'already running',
      startedAt: new Date(T0 - 60_000).toISOString(),
      stage: 'running',
      reworkCount: 0,
    } as OrchestratorWorker
    const h = harness([{ id: 'r', title: 'already running', notes: 'x', tier: 'ultra', boardColumn: 'doing', branch: 'swarm/r' } as unknown as ProjectTask])
    const engine = engineLiteral([running])
    __seedEngineForTests(engine)

    await runDispatchPass(engine, h.deps, T0)

    expect(h.spawned).toEqual(['touch card'])
    expect(h.board.get('s')?.boardColumn).toBe('todo')
    expect(engine.workers.map((w) => w.taskId).sort()).toEqual(['r', 't'])
    expect(h.recovered).toEqual([])
    const held = engine.log.filter((l) => l.message.includes('window-headroom'))
    expect(held).toHaveLength(1)
    expect(held[0].message).toContain('standard card')
    // Not every candidate is held ⇒ no park.
    expect(engine.parkUntil).toBeUndefined()

    // The owner presses Run on the held card: Board Run's launch door is not gated.
    vi.mocked(createTerminal).mockClear()
    launchClaude({ cwd: '/proj-budget', agentSessionId: 'board-run-s', appContext: false })
    expect(createTerminal).toHaveBeenCalledOnce()
  })

  it('the same holds when the reading is the SDK\'s own rate_limit_event (no scrape)', async () => {
    recordRateLimitEvent(
      { kind: 'rate_limit', status: 'allowed_warning', utilization: 0.85, resetsAt: Math.round((T0 + 2 * HOUR) / 1000), limitType: 'five_hour' },
      T0 - 60_000,
    )
    const h = harness()
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    await runDispatchPass(engine, h.deps, T0)
    expect(h.spawned).toEqual(['touch card'])
  })
})

describe('budget gate — every candidate held', () => {
  it('parks with the window reset as `until`, then resumes by itself after the reset', async () => {
    scraped(95)
    const h = harness()
    const engine = engineLiteral()
    __seedEngineForTests(engine)

    await runDispatchPass(engine, h.deps, T0)
    await runDispatchPass(engine, h.deps, T0 + 3_000)

    expect(h.spawned).toEqual([])
    const reset = T0 - 60_000 + 2 * HOUR
    // The owner hears the budget's own sentence with its `until` — never "the
    // usage limit", which has not been reached (review 2026-11-28 B-S1 / D-S2).
    // `parkUntil` stays the quota park's (what "the usage limit is back" reads).
    const standing = standingOf(standingFactsOf(engine, '/proj-budget', { now: T0 + 3_000, lang: 'ja', tasks: Array.from(h.board.values()) }))
    expect(standing.reasons.map((r) => [r.kind, r.until])).toEqual([['window-headroom', reset]])
    expect(standing.reasons[0].plain).not.toContain('上限')
    expect(standing.state).toBe('waiting')
    expect(engine.parkUntil).toBeUndefined()
    // Said once per change, not once per pass.
    expect(engine.log.filter((l) => l.message.includes('window-headroom'))).toHaveLength(2)

    // Only the clock moves: the cached reading belongs to a window that has reset.
    vi.setSystemTime(reset + 1_000)
    await runDispatchPass(engine, h.deps, reset + 1_000)
    expect(h.spawned.sort()).toEqual(['standard card', 'touch card'])
    expect(engine.parkUntil).toBeUndefined()
  })

  it('no fresh reading ⇒ today\'s behaviour (both dispatch)', async () => {
    scraped(95, T0 - 31 * 60_000)
    const h = harness()
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    await runDispatchPass(engine, h.deps, T0)
    expect(h.spawned.sort()).toEqual(['standard card', 'touch card'])
  })
})

// The engine asks for a /usage scrape only when it has a card to start and the
// newest reading is older than USAGE_REFRESH_AFTER_MS — detached, at most once
// per backoff period, and the period grows while scrapes produce nothing.
describe('budget gate — asking for a fresh reading', () => {
  const failingSpawn = (h: ReturnType<typeof harness>) =>
    // notify: the repeated-failure notice would otherwise be written fire-and-forget into the
    // home that afterEach is deleting (ENOTEMPTY under load).
    ({ ...(h.deps as object), notify: () => {}, spawnWorker: async () => { throw new Error('test: spawn refused') } }) as never

  it('candidate + stale reading ⇒ exactly one detached refresh per backoff period', async () => {
    const h = harness()
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    const deps = failingSpawn(h) // the cards stay in todo, so every pass has a candidate
    for (const t of [T0, T0 + 3_000, T0 + 6_000, T0 + USAGE_REFRESH_BACKOFF_MS - 1]) await runDispatchPass(engine, deps, t)
    expect(refreshUsage).toHaveBeenCalledTimes(1)
    // No reading arrived: the next one comes one period later, the one after that two periods later.
    await runDispatchPass(engine, deps, T0 + USAGE_REFRESH_BACKOFF_MS)
    expect(refreshUsage).toHaveBeenCalledTimes(2)
    await runDispatchPass(engine, deps, T0 + 3 * USAGE_REFRESH_BACKOFF_MS - 1)
    expect(refreshUsage).toHaveBeenCalledTimes(2)
    await runDispatchPass(engine, deps, T0 + 3 * USAGE_REFRESH_BACKOFF_MS)
    expect(refreshUsage).toHaveBeenCalledTimes(3)
  })

  it('a fresh reading ⇒ no refresh', async () => {
    scraped(40, T0 - 60_000)
    const h = harness()
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    for (const t of [T0, T0 + 3_000]) await runDispatchPass(engine, failingSpawn(h), t)
    expect(refreshUsage).not.toHaveBeenCalled()
  })

  it('the production wiring asks claudeUsageCli for a detached scrape past the display cache — and never under vitest', () => {
    const { refreshUsage: wired } = defaultDeps()
    wired?.()
    expect(refreshUsageCacheDetached).not.toHaveBeenCalled() // VITEST is set: a real scrape would spawn claude
    vi.stubEnv('VITEST', '')
    try {
      wired?.()
    } finally {
      vi.unstubAllEnvs()
    }
    // A cache answer is no newer reading (review 2026-11-28 B-S2; the effect is
    // pinned in usageScrapeWindows.test.ts).
    expect(refreshUsageCacheDetached).toHaveBeenCalledExactlyOnceWith({ bypassCache: true })
  })

  it('no candidate ⇒ no refresh', async () => {
    const h = harness()
    h.board.forEach((c, id) => h.board.set(id, { ...c, boardColumn: 'done' }))
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    for (const t of [T0, T0 + 3_000, T0 + USAGE_REFRESH_BACKOFF_MS]) await runDispatchPass(engine, h.deps, t)
    expect(refreshUsage).not.toHaveBeenCalled()
  })
})

// THE COMMANDER'S WAKE FOR FINISHED WORK (AUTONOMY-SPEC R-D2, review 2026-11-28
// B-S4): held by the owner's weekly reserve and by nothing else in the budget.
// Inside the reserve the engine neither tells, pokes nor starts the commander;
// a 5-hour window near its ceiling does not hold it (it serves work already
// done). The owner's own words to the commander (manager/say) never pass here.
describe("budget — the commander's automatic wake honours only the owner's weekly reserve", () => {
  const weekAt = (weekPct: number, sessionPct = 20, capturedAt = T0 - 60_000) =>
    recordUsageScrape({
      session: { pct: sessionPct, resetsAt: 'in 2 hours' },
      weekAll: { pct: weekPct, resetsAt: 'in 3 days' },
      weekModels: [],
      capturedAt: new Date(capturedAt).toISOString(),
      status: 'ok',
    })
  const reviewCard = { id: 'r', title: 'finished card', notes: 'completion conditions', boardColumn: 'review', branch: 'swarm/r' } as unknown as ProjectTask
  const integrateDeps = () => {
    const calls = { notice: 0, nudge: 0, wake: 0 }
    const deps = {
      ...defaultDeps(),
      fetchTasks: async () => [reviewCard],
      fetchReview: async () => [reviewCard],
      prepareTarget: async () => 'main',
      classify: async () => 'ff',
      managerPresence: async () => 'absent',
      managerDeliveryAt: async () => null,
      notifyManagerReady: async () => (calls.notice++, true),
      nudgeManager: async () => (calls.nudge++, true),
      wakeManager: async () => (calls.wake++, true),
      isOnline: async () => true,
      managerDeskRuntime: async () => 'sdk',
      recycleManagerDesk: async () => true,
      managerDeskOverCap: async () => null,
      notify: () => {},
    } as never
    return { deps, calls }
  }
  const pass = (engine: ProjectEngine, deps: never, at: number) => {
    engine.lastIntegrateAt = 0
    return runIntegratePass(engine, deps, at)
  }

  it('the week inside the reserve: no notice, no poke, no start — and the standing says why', async () => {
    weekAt(95) // reserve 10% ⇒ line 90
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    const { deps, calls } = integrateDeps()
    await pass(engine, deps, T0)
    await pass(engine, deps, T0 + 60_000)
    expect(calls).toEqual({ notice: 0, nudge: 0, wake: 0 })
    expect(engine.log.filter((l) => l.message.includes("owner's weekly reserve"))).toHaveLength(1)
    const standing = standingOf(standingFactsOf(engine, '/proj-budget', { now: T0 + 60_000, lang: 'ja', tasks: [reviewCard] }))
    expect(standing.reasons.map((r) => r.kind)).toEqual(['weekly-reserve'])
    expect(standing.reasons[0].until).toBeGreaterThan(T0)

    // The week falls back outside the reserve: the very next pass tells and starts it.
    weekAt(50)
    await pass(engine, deps, T0 + 120_000)
    expect(calls.notice).toBe(1)
    expect(calls.wake).toBe(1)
  })

  // Review R2-S1: with no todo card nothing asked for a new reading, so the
  // 95% reading went stale at 30 minutes and the commander was started inside
  // the reserve. The pending wake asks for the same free, backed-off refresh.
  it('with no todo card the hold still stands past 30 minutes: the pending wake asks for a fresh reading', async () => {
    weekAt(95)
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    const { deps: base, calls } = integrateDeps()
    let clock = T0
    const refreshed: number[] = []
    // A refresh lands a new reading of the same week (what the free scrape does).
    const deps = { ...(base as object), refreshUsage: () => (refreshed.push(clock), weekAt(95, 20, clock)) } as never
    for (clock of [T0, T0 + 6 * 60_000, T0 + 31 * 60_000]) await pass(engine, deps, clock)
    expect(calls).toEqual({ notice: 0, nudge: 0, wake: 0 })
    // Asked only when the newest reading was 5 minutes old or more — not at T0 (1 minute old).
    expect(refreshed).toEqual([T0 + 6 * 60_000, T0 + 31 * 60_000])
  })

  it('a 5-hour window near its ceiling does not hold the commander', async () => {
    weekAt(20, 95)
    const engine = engineLiteral()
    __seedEngineForTests(engine)
    const { deps, calls } = integrateDeps()
    await pass(engine, deps, T0)
    expect(calls.notice).toBe(1)
    expect(calls.wake).toBe(1)
  })
})
