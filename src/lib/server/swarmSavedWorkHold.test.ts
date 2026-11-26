// @vitest-environment node
//
// THE ENGINE AND AN OPERATION NOBODY CONFIRMED (2026-11-23).
//
// One unconfirmed tool result in a project makes every SDK launch into it die at
// its first step and denies every running worker's tool calls. The safeguard is
// right; the engine not knowing about it was the bug: it kept dispatching workers
// that were lost in seconds (cards parked after two tries), kept waking a
// commander that could not start, and told nobody — for two weeks, in five
// projects. Worse, the engine made such operations ITSELF: its quota stop cut a
// worker off in the middle of a running test command (JobSearch, 16:29).
//
// Pinned here, each measured red against the pre-fix engine:
//   • a held project dispatches NOTHING, the card stays in todo, the journal says why;
//   • the president is told once, in plain words, where to go and what to press;
//   • the words name the Settings screen's real heading (not 「会話の復旧」);
//   • a worker lost at start carries its session's exit reason into the journal;
//   • a quota stop waits for a running command instead of cutting it off, and a
//     stop that had to cut one off anyway is recorded and named in the notice.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { rm } from 'fs/promises'
import {
  runDispatchPass,
  __resetOrchestratorForTests,
  defaultDeps,
  emptyMetricsCounters,
  TOOL_BOUNDARY_WAIT_MS,
  TOOL_DENIAL_ALERT,
  DISPATCH_FAILURE_TELL,
  MAX_EXEC_MS,
  STALL_SILENCE_MS,
  STALL_NUDGE_COOLDOWN_MS,
  OWNER_REVIEW_HOLD_HINT,
  type ProjectEngine,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
} from './swarmOrchestrator'
import { automationStartNotice, commanderFailureWords, dispatchFailureNotice, savedWorkHoldNotice } from './savedWorkHold'
import { quotaRefusalKindOfText, refusalClosesEveryModel } from './swarmRateLimitText'
import { settings as settingsMessages } from '../../i18n/messages/settings'
import { SUPPLY_NOTICE_MAX, sanitizeSupplyNotice } from './supplyNotice'
import { __resetQuotaForTest, isTierCooling, MODEL_TIER_LADDER } from './swarmQuota'
import { initOverseerRuntime } from './swarmOverseer'
import { swarmNotificationsFile } from './paths'
import type { OrchestratorWorker, ProjectTask, SpawnSwarmWorkerResponse, SwarmFatalNotification } from '../types'

vi.setConfig({ testTimeout: 60_000 })

const T0 = Date.parse('2026-11-23T07:00:00Z')

const card = (id: string, boardColumn = 'todo'): ProjectTask =>
  ({ id, title: `card ${id}`, notes: 'completion conditions', boardColumn, branch: `swarm/${id}` }) as unknown as ProjectTask

const sdkSpawn = (id: string): SpawnSwarmWorkerResponse => ({
  terminalId: '',
  runtime: 'sdk',
  sdkSessionId: `sdk-${id}`,
  agentSessionId: `sess-${id}`,
  worktree: `/central/wt/${id}`,
  branch: `swarm/${id}`,
  model: 'fable',
})

const sdkWorker = (over: Partial<OrchestratorWorker> = {}): OrchestratorWorker => ({
  terminalId: '',
  runtime: 'sdk',
  sdkSessionId: 'sdk-q1',
  branch: 'swarm/q1',
  worktree: '/central/wt/q1',
  taskId: 'q1',
  taskTitle: 'quota me',
  startedAt: new Date(T0 - 10 * 60_000).toISOString(),
  stage: 'running',
  model: 'fable',
  reworkCount: 0,
  ...over,
})

const newEngine = (over: Partial<ProjectEngine> = {}): ProjectEngine =>
  ({
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
    overseer: initOverseerRuntime(),
    notified: new Set(),
    pendingFatal: [],
    metrics: emptyMetricsCounters(),
    ...over,
  }) as ProjectEngine

type Deps = OrchestratorDeps & IntegrationDeps & AnomalyDeps
const stubDeps = (over: Partial<Deps>): Deps => ({
  ...defaultDeps(),
  fetchTasks: async () => [],
  spawnWorker: async () => {
    throw new Error('spawnWorker not stubbed for this test')
  },
  moveToDoing: async () => true,
  moveToReview: async () => true,
  recoverCard: vi.fn(async () => true),
  recoverWorker: vi.fn(async () => ({ removed: true })),
  countCommitsAhead: async () => 0,
  readHeartbeat: async () => null,
  lastOutputAt: () => null,
  isAlive: () => true,
  savedWorkHold: async () => 0,
  sdkWorkerFacts: () => undefined,
  toolDenialStreak: () => 0,
  sessionAgentActivityAt: async () => null,
  sessionBackgroundTaskAt: async () => null,
  ...over,
})

const held = (notify: (n: SwarmFatalNotification) => void) =>
  (notify as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as SwarmFatalNotification).filter((n) => n.event === 'automation-held')

beforeEach(async () => {
  __resetOrchestratorForTests()
  __resetQuotaForTest()
  await rm(swarmNotificationsFile(), { force: true })
})

afterEach(async () => {
  __resetOrchestratorForTests()
  __resetQuotaForTest()
  await rm(swarmNotificationsFile(), { force: true })
})

describe('saved-work hold — no dispatch into a project with an unconfirmed operation', () => {
  it('dispatches nothing, leaves the card in todo, journals the reason and tells the president once', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => sdkSpawn('a'))
    const moveToDoing = vi.fn(async () => true)
    const notify = vi.fn()
    let unconfirmed = 1
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker, moveToDoing, notify, savedWorkHold: async () => unconfirmed })

    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 3000)
    await runDispatchPass(engine, deps, T0 + 6000)

    // No spawn → nothing to be "lost" three seconds later; the card never left todo.
    expect(spawnWorker).not.toHaveBeenCalled()
    expect(moveToDoing).not.toHaveBeenCalled()
    expect(engine.workers).toHaveLength(0)
    // The reason is in the engine's record, with where to go — once, not per pass.
    const lines = engine.log.filter((l) => l.message.includes('saved-work hold —'))
    expect(lines).toHaveLength(1)
    expect(lines[0].message).toContain(OWNER_REVIEW_HOLD_HINT)
    // The president hears it once, in plain words: what is happening, where, what to press.
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].projectPath).toBe('/proj')
    expect(told[0].detail).toContain('新しい作業の開始と司令官の起動を止めています')
    expect(told[0].detail).toContain(settingsMessages.ja['settings.recovery.title'])
    expect(told[0].detail).toContain(settingsMessages.ja['settings.recovery.review'])

    // The owner reviews it → the very next pass dispatches, with no re-arm.
    unconfirmed = 0
    await runDispatchPass(engine, deps, T0 + 9000)
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(engine.savedWorkHold).toBeUndefined()
    expect(engine.log.some((l) => l.message.includes('saved-work hold lifted'))).toBe(true)
    expect(held(notify)).toHaveLength(1)
  })

  it('when the question cannot be answered (owner sign-in gone) it holds too — the launch would die the same way — and says why', async () => {
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => sdkSpawn('a'))
    const notify = vi.fn()
    let signedIn = false
    const deps = stubDeps({
      fetchTasks: async () => [card('a')],
      spawnWorker,
      notify,
      savedWorkHold: async () => {
        if (!signedIn) throw new Error('Owner sign-in is required.')
        return 0
      },
    })
    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(spawnWorker).not.toHaveBeenCalled() // held from the first pass…
    expect(engine.log.filter((l) => l.message.includes('cannot confirm the owner'))).toHaveLength(1)
    expect(held(notify)).toHaveLength(0) // …told only once it lasts
    await runDispatchPass(engine, deps, T0 + 61_000)
    await runDispatchPass(engine, deps, T0 + 64_000)
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].detail).toContain('設定でサインインしているかを確かめてください')
    signedIn = true
    await runDispatchPass(engine, deps, T0 + 67_000)
    expect(spawnWorker).toHaveBeenCalledTimes(1)
  })

  it('a single read error holds one pass and tells nobody; a lasting one is told as a record problem, not a sign-in one', async () => {
    // EMFILE / EBUSY on the record used to ring 「設定でサインインしているかを
    // 確かめてください」 at once (review 2026-11-26).
    const engine = newEngine()
    const spawnWorker = vi.fn(async () => sdkSpawn('a'))
    const notify = vi.fn()
    let failing = true
    const deps = stubDeps({
      fetchTasks: async () => [card('a')],
      spawnWorker,
      notify,
      savedWorkHold: async () => {
        if (failing) throw new Error('EMFILE: too many open files')
        return 0
      },
    })
    await runDispatchPass(engine, deps, T0)
    expect(spawnWorker).not.toHaveBeenCalled()
    failing = false
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(spawnWorker).toHaveBeenCalledTimes(1)
    expect(held(notify)).toHaveLength(0)

    const later = newEngine()
    failing = true
    for (const at of [T0, T0 + 30_000, T0 + 61_000, T0 + 90_000]) await runDispatchPass(later, { ...deps, spawnWorker: vi.fn() }, at)
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].detail).toContain('操作の記録が読み取れない')
    expect(told[0].detail).not.toContain('サインイン')
  })
})

describe('the words point at the Settings screen as it is actually labelled', () => {
  const ja = settingsMessages.ja
  it('names the real heading and the path to it, never 「会話の復旧」', () => {
    expect(OWNER_REVIEW_HOLD_HINT).toContain(ja['settings.recovery.title'])
    expect(OWNER_REVIEW_HOLD_HINT).toContain(ja['settings.advanced'])
    expect(OWNER_REVIEW_HOLD_HINT).toContain('ChatGPT')
    expect(OWNER_REVIEW_HOLD_HINT).not.toContain('会話の復旧')
  })

  it('the notice survives the supply desk line untouched (no redaction, under the cap)', () => {
    const notice = `「長いカード名の作業」の担当を使用量の上限で止めたとき、実行中だった操作が途中で切れました。${savedWorkHoldNotice(3)}`
    expect(Array.from(notice).length).toBeLessThan(SUPPLY_NOTICE_MAX)
    expect(sanitizeSupplyNotice(notice)).toBe(notice)
    expect(notice).toContain(ja['settings.recovery.note'])
  })
})

describe('a worker lost at start says why', () => {
  it('journals the SDK session exit reason instead of a bare "worker lost"', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      isAlive: () => false,
      sdkWorkerFacts: () => ({ exitReason: 'error: A previous tool operation has an unconfirmed result.' }),
    })
    await runDispatchPass(engine, deps, T0)
    const lost = engine.log.find((l) => l.message.includes('worker lost'))
    expect(lost?.message).toContain('exit: error: A previous tool operation has an unconfirmed result.')
  })
})

describe('the quota stop does not cut a worker off in the middle of a command', () => {
  const quotaDeps = (over: Partial<Deps>): Deps =>
    stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      recentOutput: () => '[sdk session quota-parked]',
      quotaBlocked: () => true,
      ...over,
    })

  it('waits while a command is running, then stops cleanly once it has finished', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    let running = 1
    const deps = quotaDeps({ sdkWorkerFacts: () => ({ toolCallsInFlight: running }) })

    await runDispatchPass(engine, deps, T0)
    await runDispatchPass(engine, deps, T0 + 3000)
    // Kept: the command is still running, so nothing was torn down or requeued.
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(deps.recoverCard).not.toHaveBeenCalled()
    expect(engine.workers).toHaveLength(1)
    expect(engine.log.filter((l) => l.message.includes('waiting for them to finish'))).toHaveLength(1)

    running = 0
    await runDispatchPass(engine, deps, T0 + 6000)
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'todo')
    expect(engine.workers).toHaveLength(0)
    // Nothing was cut off, so nothing is recorded as cut off.
    expect(engine.log.some((l) => l.message.includes('stopped in the middle of'))).toBe(false)
    expect(engine.forcedStopNote).toBeUndefined()
  })

  it('a command that never returns is cut off after the bound — recorded, and named in the notice', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    const notify = vi.fn()
    let unconfirmed = 0
    const deps = quotaDeps({ notify, sdkWorkerFacts: () => ({ toolCallsInFlight: 1 }), savedWorkHold: async () => unconfirmed })

    await runDispatchPass(engine, deps, T0)
    expect(deps.recoverWorker).not.toHaveBeenCalled()

    // The stop itself is what leaves the operation unconfirmed.
    ;(deps.recoverWorker as ReturnType<typeof vi.fn>).mockImplementation(async () => { unconfirmed = 1; return { removed: true } })
    await runDispatchPass(engine, deps, T0 + TOOL_BOUNDARY_WAIT_MS)
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
    expect(engine.log.some((l) => l.message.includes('stopped in the middle of 1 running command(s) (rate-limit)'))).toBe(true)

    // The hold is read at the top of the NEXT pass (3 s later) and names the stop.
    await runDispatchPass(engine, deps, T0 + TOOL_BOUNDARY_WAIT_MS + 3000)
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].detail).toContain('使用量の上限で止めたとき、実行中だった操作が途中で切れました')
    expect(told[0].detail).toContain(settingsMessages.ja['settings.recovery.title'])
  })

  // A wait that ended because the worker went back to work used to leave its
  // stamp behind. The next stop, fifteen minutes or more later, read that stamp
  // as "already waited long enough": it cut the running command off at once (the
  // very harm the wait exists to prevent) and skipped the cooling mark with it.
  it('a wait belongs to one stop: a later refusal waits (and cools) afresh instead of inheriting the old stamp', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    let refused = true
    let lastOut: number | null = null
    const deps = quotaDeps({
      quotaBlocked: () => refused,
      recentOutput: () => (refused ? '[sdk session quota-parked]' : '[sdk session working]'),
      lastOutputAt: () => lastOut,
      sdkWorkerFacts: () => ({
        toolCallsInFlight: 1,
        ...(refused ? { refusal: "You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)" } : {}),
      }),
    })
    await runDispatchPass(engine, deps, T0) // refused in the middle of a command: the wait starts
    expect(engine.toolBoundaryWaits?.size).toBe(1)

    // The limit lifts and the worker goes back to work — nobody wants to stop it.
    refused = false
    lastOut = T0 + 3000
    __resetQuotaForTest()
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(engine.toolBoundaryWaits?.size ?? 0).toBe(0)

    // Refused again much later, again in the middle of a command.
    refused = true
    const later = T0 + TOOL_BOUNDARY_WAIT_MS + 5 * 60_000
    await runDispatchPass(engine, deps, later)
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(isTierCooling('fable', later + 1000)).toBe(true)
  })
})

describe('an all-model limit is not walked down tier by tier', () => {
  // Which wordings close EVERY model. All-model needs two agreeing signs: the CLI
  // offered no "/model" way out AND named no model. Anything else keeps the old
  // promise — cool only the tier that met the wall (and nothing by guess).
  it('splits the measured refusal wordings: all-model vs one model vs not known', () => {
    const allModel = [
      "You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)", // 2026-11-23 16:33, commander desk
      "You've hit your session limit · resets 3pm",
      "You've hit your weekly limit · resets Dec 1, 9am",
      'Claude usage limit reached — resets in 30 minutes', // the older CLI's account limit
    ]
    const oneModel = [
      "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.", // offers /model
      'Fable 5 requires usage credits. Add funds to continue.', // names the model, no remedy line
      "You've reached your Opus limit · resets 5pm",
      "You've reached your Fable 5 limit — resets in 30 minutes",
      // The CLI's credit / spend family (2.1.220 bundled, 2.1.332 installed — review
      // 2026-11-26): one model's credits, another model still runs. Read as all-model
      // before (no "switch models with /model" line, no model named).
      "You're out of usage credits. /model to switch models.",
      "You've hit your monthly spend limit. /model to switch models.",
      "You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage, to continue.",
      "You've hit your monthly spend limit. Switch to another model to continue.",
      "You've hit your team's pooled group budget. Switch to another model to continue.",
      "You're out of usage credits. Add funds to continue.", // no window named — never all-model by guess
      'ChatGPT usage limit; retry after 9:00 PM', // another provider's limit
    ]
    for (const said of allModel) expect(refusalClosesEveryModel(quotaRefusalKindOfText(said), said), said).toBe(true)
    for (const said of oneModel) expect(refusalClosesEveryModel(quotaRefusalKindOfText(said), said), said).toBe(false)
    // A refusal whose kind could not be read is not all-model either.
    expect(refusalClosesEveryModel(null, allModel[0])).toBe(false)
  })

  const parked = (refusal: string) =>
    stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      recentOutput: () => '[sdk session quota-parked]',
      quotaBlocked: () => true,
      sdkWorkerFacts: () => ({ refusal }),
    })

  it('the 5-hour window cools EVERY tier on one refusal (measured: 4 cards × 4 tiers = 16 refused launches)', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    await runDispatchPass(engine, parked("You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)"), T0)
    for (const tier of MODEL_TIER_LADDER) expect(isTierCooling(tier, T0 + 1000), tier).toBe(true)
    expect(engine.log.some((l) => l.message.includes('every tier cooling until'))).toBe(true)
  })

  it('a per-model limit (the CLI offers /model) cools only that tier, so the next launch steps down', async () => {
    const engine = newEngine({ workers: [sdkWorker()] })
    await runDispatchPass(engine, parked("You've reached your Fable 5 limit. Resets at 3:00pm. Switch models with /model"), T0)
    expect(isTierCooling('fable', T0 + 1000)).toBe(true)
    for (const tier of MODEL_TIER_LADDER.filter((t) => t !== 'fable')) expect(isTierCooling(tier, T0 + 1000), tier).toBe(false)
  })

  // Cooling the whole ladder parks every dispatch until the stated reset, so "no
  // /model line" alone must not decide it: these wordings carry none, and they
  // are one model's limit. Read as all-model, a spent Opus would have parked the
  // swarm although Sonnet could run.
  it.each([
    ["You've reached your Opus limit · resets 5pm", 'opus'],
    ['Opus 4.8 requires usage credits.', 'opus'],
    ["You've reached your Fable limit for this week.", 'fable'],
  ] as const)('a limit that names a model is that model\'s own, /model line or not: %s', async (refusal, model) => {
    const engine = newEngine({ workers: [sdkWorker({ model })] })
    await runDispatchPass(engine, parked(refusal), T0)
    expect(isTierCooling(model, T0 + 1000)).toBe(true)
    for (const tier of MODEL_TIER_LADDER.filter((t) => t !== model)) expect(isTierCooling(tier, T0 + 1000), tier).toBe(false)
  })

  it.each([
    "You're out of usage credits. /model to switch models.",
    "You've hit your monthly spend limit. Switch to another model to continue.",
    "You've hit your team's pooled group budget. Switch to another model to continue.",
  ])('a credit / spend limit that offers another model cools only the worker\'s tier: %s', async (refusal) => {
    const engine = newEngine({ workers: [sdkWorker()] })
    await runDispatchPass(engine, parked(refusal), T0)
    expect(MODEL_TIER_LADDER.filter((t) => isTierCooling(t, T0 + 1000))).toEqual(['fable'])
  })

  it("a ChatGPT worker's usage limit cools no Claude tier (a ChatGPT limit cools only ChatGPT)", async () => {
    const engine = newEngine({ workers: [sdkWorker({ model: 'gpt-5.5' })] })
    await runDispatchPass(engine, parked("You've hit your 5-hour limit · resets 9pm (Asia/Tokyo)"), T0)
    await runDispatchPass(engine, parked('ChatGPT usage limit; retry after 9:00 PM'), T0 + 1000)
    expect(MODEL_TIER_LADDER.filter((t) => isTierCooling(t, T0 + 2000))).toEqual([])
  })

  it.each(['weekly', 'session', '5-hour'])('the %s limit names no model and closes them all', async (window) => {
    const engine = newEngine({ workers: [sdkWorker({ model: 'sonnet' })] })
    await runDispatchPass(engine, parked(`You've hit your ${window} limit · resets 9pm (Asia/Tokyo)`), T0)
    for (const tier of MODEL_TIER_LADDER) expect(isTierCooling(tier, T0 + 1000), tier).toBe(true)
  })
})

describe('every engine stop waits for a running command', () => {
  it('the execution ceiling keeps a worker until its command finishes', async () => {
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(T0 - MAX_EXEC_MS - 60_000).toISOString() })] })
    let running = 1
    const deps = stubDeps({ fetchTasks: async () => [card('q1', 'doing')], sdkWorkerFacts: () => ({ toolCallsInFlight: running }) })
    await runDispatchPass(engine, deps, T0)
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(engine.log.filter((l) => l.message.includes('over its execution budget with 1 command(s) still running'))).toHaveLength(1)
    running = 0
    await runDispatchPass(engine, deps, T0 + 3000)
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
  })

  it('a silent worker running a long command is not reclaimed as stalled until the command ends', async () => {
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(T0).toISOString() })] })
    let running = 1
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      sdkWorkerFacts: () => ({ toolCallsInFlight: running }),
      nudge: vi.fn(() => true),
      escalate: vi.fn(async () => true),
    })
    const S = STALL_SILENCE_MS
    const C = STALL_NUDGE_COOLDOWN_MS
    for (const at of [T0 + S + 1, T0 + S + C + 2, T0 + S + 2 * C + 3, T0 + S + 3 * C + 4]) await runDispatchPass(engine, deps, at)
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(engine.log.some((l) => l.message.includes('silent past the stall limit with 1 command(s) still running'))).toBe(true)
    running = 0
    await runDispatchPass(engine, deps, T0 + S + 3 * C + 5)
    expect(deps.recoverWorker).toHaveBeenCalledTimes(1)
  })

  // The ceiling's arm runs first in the loop. Judging another stop's wait there
  // turned a quota stop — or a stall — into a runaway once the command ended
  // past the ceiling: card → blocked, never re-dispatched (review 2026-11-26).
  it('a usage stop waiting out a command in the budget\'s last minutes leaves as a quota stop (card → todo), not a runaway', async () => {
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(T0 - (MAX_EXEC_MS - 2 * 60_000)).toISOString() })] })
    let running = 1
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      recentOutput: () => '[sdk session quota-parked]',
      quotaBlocked: () => true,
      sdkWorkerFacts: () => ({ toolCallsInFlight: running }),
    })
    await runDispatchPass(engine, deps, T0) // 88 minutes in: refused mid-command
    await runDispatchPass(engine, deps, T0 + 3 * 60_000) // 91 minutes: past the ceiling, still running
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    running = 0
    await runDispatchPass(engine, deps, T0 + 3 * 60_000 + 3000)
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'todo')
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
  })

  it('a stall reclaim waiting out a command past the ceiling stays a stall (card → todo), not a runaway', async () => {
    const S = STALL_SILENCE_MS
    const C = STALL_NUDGE_COOLDOWN_MS
    const holdAt = T0 + S + 3 * C + 4
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(holdAt - (MAX_EXEC_MS - 5 * 60_000)).toISOString() })] })
    let running = 1
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      sdkWorkerFacts: () => ({ toolCallsInFlight: running }),
      nudge: vi.fn(() => true),
      escalate: vi.fn(async () => true),
    })
    for (const at of [T0 + S + 1, T0 + S + C + 2, T0 + S + 2 * C + 3, holdAt]) await runDispatchPass(engine, deps, at)
    expect(deps.recoverWorker).not.toHaveBeenCalled()
    expect(engine.log.some((l) => l.message.includes('silent past the stall limit with 1 command(s) still running'))).toBe(true)
    running = 0
    await runDispatchPass(engine, deps, holdAt + 10 * 60_000) // 95 minutes in
    expect(deps.recoverCard).toHaveBeenCalledWith('/proj', 'q1', 'todo')
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
  })

  it('a quota stop during a command: the re-dispatched worker comes up instead of dying in seconds (JobSearch 16:29)', async () => {
    // The real teardown interrupts the session; a command cut off mid-run is
    // left unconfirmed, and every launch into the project then dies at once.
    let column = 'doing'
    let running = 1
    let unconfirmed = 0
    const engine = newEngine({ workers: [sdkWorker()] })
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', column)],
      recentOutput: (w) => (w.sdkSessionId === 'sdk-q1' ? '[sdk session quota-parked]' : '[sdk session working]'),
      quotaBlocked: (w) => w.sdkSessionId === 'sdk-q1',
      sdkWorkerFacts: (id) => (id === 'sdk-q1' ? { toolCallsInFlight: running } : {}),
      savedWorkHold: async () => unconfirmed,
      recoverWorker: vi.fn(async () => {
        if (running > 0) unconfirmed = 1
        return { removed: true }
      }),
      recoverCard: vi.fn(async (_p: string, _id: string, to: 'todo' | 'blocked') => {
        column = to
        return true
      }),
      moveToDoing: vi.fn(async () => {
        column = 'doing'
        return true
      }),
      spawnWorker: vi.fn(async () => sdkSpawn('q1-again')),
      isAlive: (w) => w.sdkSessionId !== 'sdk-q1-again' || unconfirmed === 0,
    })
    await runDispatchPass(engine, deps, T0)
    running = 0 // the test run finishes
    for (let i = 1; i <= 4; i++) await runDispatchPass(engine, deps, T0 + i * 3000)
    expect(unconfirmed).toBe(0)
    expect(deps.spawnWorker).toHaveBeenCalledTimes(1)
    expect(engine.workers.map((w) => w.sdkSessionId)).toEqual(['sdk-q1-again'])
    expect(engine.log.some((l) => l.message.includes('worker lost'))).toBe(false)
  })
})

describe('a worker whose every tool call is refused is reported early', () => {
  it('journals and tells the president once, after a few refusals in a row — not at the 90-minute ceiling', async () => {
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(T0).toISOString() })] })
    let streak = TOOL_DENIAL_ALERT
    const notify = vi.fn()
    const deps = stubDeps({ fetchTasks: async () => [card('q1', 'doing')], notify, toolDenialStreak: () => streak, lastOutputAt: () => T0 })
    await runDispatchPass(engine, deps, T0 + 1000)
    await runDispatchPass(engine, deps, T0 + 4000)
    expect(engine.log.filter((l) => l.message.includes('tool calls are all refused'))).toHaveLength(1)
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].detail).toContain('「quota me」の担当が、道具(コマンドやファイルの操作)をすべて断られていて')
    expect(told[0].detail).toContain(settingsMessages.ja['settings.recovery.title'])
    // A call that goes through re-arms it; a new run of refusals is told again.
    streak = 0
    await runDispatchPass(engine, deps, T0 + 7000)
    streak = TOOL_DENIAL_ALERT
    await runDispatchPass(engine, deps, T0 + 10_000)
    expect(held(notify)).toHaveLength(2)
  })

  it('under a saved-work hold the hold notice already says so — no second notice for the same cause', async () => {
    const engine = newEngine({ workers: [sdkWorker({ startedAt: new Date(T0).toISOString() })] })
    const notify = vi.fn()
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', 'doing')],
      notify,
      savedWorkHold: async () => 1,
      toolDenialStreak: () => TOOL_DENIAL_ALERT,
      lastOutputAt: () => T0,
    })
    await runDispatchPass(engine, deps, T0 + 1000)
    await runDispatchPass(engine, deps, T0 + 4000)
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].detail).toContain('新しい作業の開始と司令官の起動を止めています')
    expect(engine.log.some((l) => l.message.includes('tool calls are all refused'))).toBe(true)
  })
})

describe('a dispatch that keeps failing is told, not retried in silence', () => {
  it('a first-time project with no commit: told once after a few failures, with the reason; a working dispatch clears it', async () => {
    const engine = newEngine()
    const notify = vi.fn()
    let fail = true
    const spawnWorker = vi.fn(async () => {
      if (fail) throw new Error('このプロジェクトにはまだ git の記録(コミット)がありません — 最初のコミットができると作業を始められます')
      return sdkSpawn('a')
    })
    const deps = stubDeps({ fetchTasks: async () => [card('a')], spawnWorker, notify })
    for (let i = 0; i < DISPATCH_FAILURE_TELL * 2; i++) await runDispatchPass(engine, deps, T0 + i * 3000)
    const told = held(notify)
    expect(told).toHaveLength(1)
    expect(told[0].detail).toContain('「card a」の作業を始めようとして、失敗が続いています')
    expect(told[0].detail).toContain('git の記録(コミット)がありません')
    fail = false
    await runDispatchPass(engine, deps, T0 + 60_000)
    expect(engine.workers).toHaveLength(1)
    expect(engine.dispatchFailures?.has('a')).toBe(false)
  })
})

describe('a worker refused by the usage limit and gone at once is a quota stop, not a crash', () => {
  // Measured 2026-11-23 17:44 / 22:21: the transcript ends "You've hit your
  // 5-hour limit", the session is gone seconds later, and the engine journalled
  // "worker lost — card → blocked (crash)". Nothing returns a blocked card to
  // todo when the limit lifts, so three cards sat there overnight.
  const REFUSAL = "You've hit your 5-hour limit · resets 2:50am (Asia/Tokyo)"
  const gone = (worker: Partial<OrchestratorWorker>, facts: { exitReason?: string; refusal?: string }) => {
    let column = 'doing'
    const engine = newEngine({ workers: [sdkWorker(worker)] })
    const moveToReview = vi.fn(async () => {
      column = 'review'
      return true
    })
    const deps = stubDeps({
      fetchTasks: async () => [card('q1', column)],
      isAlive: () => false,
      countCommitsAhead: async () => 3, // it had committed — the rule that parks a crash in blocked
      sdkWorkerFacts: () => facts,
      recoverCard: vi.fn(async (_p: string, _id: string, to: 'todo' | 'blocked') => {
        column = to
        return true
      }),
      moveToReview,
    })
    return { engine, deps, moveToReview, column: () => column }
  }
  const reentered = { reenteredAt: new Date(T0 - 5 * 60_000).toISOString() }
  const ended = 'error: A previous tool operation has an unconfirmed result.'

  it('the card returns to todo (not blocked), every tier cools, and the journal says quota stop with the exit reason', async () => {
    const t = gone(reentered, { exitReason: ended, refusal: REFUSAL })
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.column()).toBe('todo')
    expect(MODEL_TIER_LADDER.every((tier) => isTierCooling(tier, T0 + 1000))).toBe(true)
    expect(t.engine.log.some((l) => l.message.includes('worker lost'))).toBe(false)
    const line = t.engine.log.find((l) => l.message.includes('quota-stopped — requeued'))
    expect(line?.message).toContain('card → todo')
    expect(line?.message).toContain(`exit: ${ended}`)
  })

  it('a first-run worker with commits is requeued too — not handed to review as if it had finished', async () => {
    const t = gone({}, { exitReason: ended, refusal: REFUSAL })
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.moveToReview).not.toHaveBeenCalled()
    expect(t.column()).toBe('todo')
  })

  it('a death whose last words were not a refusal is still a crash: commits park the card in blocked, nothing cools', async () => {
    const t = gone(reentered, { exitReason: 'error: boom' })
    await runDispatchPass(t.engine, t.deps, T0)
    expect(t.column()).toBe('blocked')
    expect(MODEL_TIER_LADDER.some((tier) => isTierCooling(tier, T0 + 1000))).toBe(false)
  })
})

describe('why the commander did not come up — said as it is', () => {
  it('an unconfirmed operation names the Settings screen; a quota wall is called a usage limit; anything else is quoted', () => {
    const guard = 'A previous tool operation has an unconfirmed result. Inspect the saved project work before resuming automatic work.'
    // The launch's own words win over a wall in the table: on 2026-11-24 the
    // journal said "no usable tier" for eight hours while this was the cause.
    expect(commanderFailureWords(guard, 'all-cooling')).toContain(OWNER_REVIEW_HOLD_HINT)
    expect(commanderFailureWords(guard, 'all-cooling')).not.toContain('上限')
    expect(commanderFailureWords(undefined, 'all-cooling')).toContain('使用量の上限')
    expect(commanderFailureWords(undefined, 'none-allowed')).toContain('使用可能モデル')
    // A raw English error stays in the journal; the owner gets plain words (review 2026-11-26).
    expect(commanderFailureWords('claude CLI is signed out', null)).not.toContain('claude CLI is signed out')
    expect(commanderFailureWords('claude CLI is signed out', null)).toContain('エンジンの記録')
    expect(commanderFailureWords('オーナーのアカウントが確かめられません', null)).toContain('オーナーのアカウントが確かめられません')
  })

  it("git's own output never reaches the owner's notice; a plain reason does", () => {
    const git = "createSwarmWorktree: fatal: invalid reference: main\nhint: use 'git branch -a'"
    expect(dispatchFailureNotice('card a', git)).not.toContain('fatal')
    expect(dispatchFailureNotice('card a', git)).toContain('エンジンの記録')
    expect(automationStartNotice('EACCES: permission denied')).not.toContain('EACCES')
    expect(dispatchFailureNotice('card a', 'createSwarmWorktree: 作業場所を作れませんでした')).toContain('理由: 作業場所を作れませんでした')
  })
})
