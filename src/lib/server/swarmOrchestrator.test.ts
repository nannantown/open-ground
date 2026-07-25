import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { initSelfSupplyRuntime } from './swarmSelfSupply'
import { initOverseerRuntime } from './swarmOverseer'
import {
  ORCHESTRATOR_MAX_WORKERS,
  ORCHESTRATOR_MIN_WORKERS,
  STALE_HEARTBEAT_MS,
  RECOVER_MAX_REQUEUE,
  MOVE_STUCK_MAX_RETRIES,
  MAX_REWORKS,
  MAX_CONFLICT_REWORKS,
  MAX_REVIEW_DEFERS,
  highRiskChangedPaths,
  STALL_SILENCE_MS,
  STALL_NUDGE_COOLDOWN_MS,
  STALL_ECHO_GUARD_MS,
  MAX_EXEC_MS,
  RATE_LIMIT_GRACE_MS,
  RATE_LIMIT_SCRAPE_QUIET_MS,
  RATE_LIMIT_EARLY_ONSET_MS,
  RATE_LIMIT_EARLY_CONFIRM_MS,
  PERMISSION_WAIT_GRACE_MS,
  QUESTION_GRACE_MS,
  classifyOutput,
  endsInRateLimit,
  RATE_LIMIT_TAIL_MAX,
  isRunaway,
  isTodoCard,
  isReviewCard,
  sortTodos,
  selectDispatch,
  computeTargetWorkers,
  declaredFiles,
  contentKey,
  classifyWorker,
  classifyStall,
  defaultEscalate,
  lastActivityMs,
  detectAnomalies,
  fireFatalNotifications,
  pruneStuckMoves,
  pruneReworks,
  recoveryColumn,
  runDispatchPass,
  runIntegratePass,
  kickIntegratePass,
  MANAGER_RESUME_GRACE_MS,
  INTEGRATE_TICK_MS,
  MAX_MANAGER_RESUME_ATTEMPTS,
  MANAGER_UNREVIVABLE_RETRY_MS,
  MAX_MANAGER_NUDGES,
  MANAGER_NUDGE_INTERVAL_MS,
  MANAGER_INTEGRATION_STALL_MS,
  MANAGER_NUDGE_REARM_MS,
  managerIntegrationStalled,
  type ManagerPresence,
  runEnginePass,
  stopOrchestrator,
  setOverseer,
  setSelfSupply,
  stopOrchestratorWorker,
  resolveOrchestratorReview,
  tallyReview,
  extractReviewVerdict,
  buildReviewPrompt,
  REVIEW_PANEL_SIZE,
  classifyMetricEvent,
  computeLeadTimeStats,
  computeSwarmKpis,
  computeSwarmConsumption,
  DISPATCH_BUDGET,
  medianOf,
  emptyMetricsCounters,
  getOrchestratorState,
  drainTickOrchestrator,
  maybeAutoStartDrain,
  runAutoDrainScan,
  startAutoDrainLoop,
  stopAutoDrainLoop,
  startOrchestrator,
  bootAutoDrainEnabled,
  REWORK_LOG_MARKER,
  __resetOrchestratorForTests,
  __seedEngineForTests,
  isCardDispatchInFlight,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
  type SelfSupplyPassDeps,
  type HeartbeatSign,
  type ProjectEngine,
  type WorkerProbe,
  type ReviewResult,
  type ReviewDecision,
  type ReviewerVerdict,
} from './swarmOrchestrator'
import { canonicalize } from './canonicalize'
import { markCoolingUntil, isTierCooling, __resetQuotaForTest, MODEL_TIER_LADDER } from './swarmQuota'
import { __resetAllowedModelsForTest } from './swarmAllowedModels'
import { resolveSwarmModelEffort } from './swarmLaunch'
import {
  rememberSwarmAutonomy,
  forgetSwarmAutonomy,
  isSwarmAutonomyRemembered,
  rememberSwarmManualStop,
  forgetSwarmManualStop,
  isSwarmManualStopPersisted,
  setSettings,
} from './store'
import type {
  OrchestratorLogLine,
  OrchestratorWorker,
  ProjectTask,
  SpawnSwarmWorkerResponse,
  SwarmFatalNotification,
} from '../types'
import type { IntegrateOutcome, ReviewReadiness } from './swarmIntegrate'
import type { OpenEscalationInput } from './swarmEscalations'

// startOrchestrator gates on the REAL claudeRunPreflight (not an injected dep), which
// refuses to arm without a logged-in claude CLI — non-hermetic. Stub it OK so the
// autonomy-persistence tests can exercise the ON path. Inert elsewhere: the drain /
// auto-start tests inject their own preflight via fullDeps, and startOrchestrator is
// the only caller of the real one in this suite.
vi.mock('./claudePreflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claudePreflight')>()
  return { ...actual, claudeRunPreflight: async () => ({ ok: true }) }
})

// The A5 usage sensor's SYNC cache peek, made injectable for the quota-sensor
// tests (the pct>=100 gate on its resetsAt). Default null = nothing cached —
// exactly what the real peek returns in this test process — so every other test
// is untouched. vi.hoisted because vi.mock factories are hoisted above module
// lets.
const a5Mock = vi.hoisted(() => ({ current: null as import('./claudeUsageCli').CliUsage | null }))
vi.mock('./claudeUsageCli', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claudeUsageCli')>()
  return { ...actual, peekCachedUsage: () => a5Mock.current }
})

// These engine tests exercise dispatch at FULL capacity (cap = ORCHESTRATOR_MAX_WORKERS).
// The default execution mode is now 'optimize' (a middling parallel cap), so pin 'max'
// file-wide to test the historical full-band behaviour; the per-mode caps are covered
// in swarmLaunch.test.ts (execModeMaxWorkers). Written to the isolated tmp HOME.
beforeAll(async () => {
  await setSettings({ executionMode: 'max' })
})

// The commander engine's drain+dispatch+monitor logic, exercised with FAKE deps
// (no timers, no globalThis, no PTYs, no git). The pure helpers (isTodoCard /
// sortTodos / selectDispatch / classifyWorker) are tested directly; runDispatchPass
// is driven through a recording fake so we assert the observable contract:
//  ① ON dispatches oldest-first up to the cap and moves cards todo→doing; OFF
//     dispatches nothing; a freed slot refills; spawn/move failures degrade
//     without losing or duplicating a worker.
//  ② each pass monitors dispatched workers and, ONLY when a worker is
//     conservatively judged DONE (integrable commits AND a completion sign),
//     moves its card doing→review recording the branch; ambiguous/broken workers
//     stay in 'doing'; stages advance starting→running→done.
// The real self-fetch board client + real spawn + real git/heartbeat probes are
// exercised live.

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Always-succeeds fake for IntegrationDeps.acquireLock — the cross-process
 *  integration lock (swarmIntegrationLock.ts) is exercised against a REAL git
 *  repo in swarmOrchestrator.integration.test.ts; the unit tests here run
 *  against a fake `/proj` path (no real git repo), so they inject this stub to
 *  keep the pre-existing integrate-loop behavior unchanged. The lock's own
 *  skip-on-contention behavior is covered separately below (see "integration
 *  lock (cross-process)"). */
const alwaysAcquireLock: IntegrationDeps['acquireLock'] = async () => ({
  ok: true,
  holder: { pid: 1, acquiredAt: '1970-01-01T00:00:00.000Z', label: 'test' },
  release: async () => {},
})

const card = (id: string, over: Partial<ProjectTask> = {}): ProjectTask => ({
  id,
  title: `task ${id}`,
  done: false,
  createdAt: `2026-06-23T00:00:0${id.length}Z`,
  boardColumn: 'todo',
  ...over,
})

const worker = (over: Partial<OrchestratorWorker> = {}): OrchestratorWorker => ({
  terminalId: 'pty-x-1',
  branch: 'swarm/x',
  worktree: '/wt/x',
  taskId: 'x',
  taskTitle: 'x',
  startedAt: '',
  stage: 'running',
  ...over,
})

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

/** A recording fake dep set modelling a FULL board (cards keep their column, so a
 *  dispatched card sits in 'doing' for the monitor to find). `dead` marks PTYs the
 *  liveness probe reports exited; `commits` / `heartbeats` are the monitor's
 *  per-task signals; `moveFails` / `reviewFails` make the FIRST matching write
 *  fail. */
const makeDeps = (init: {
  cards: ProjectTask[]
  dead?: Set<string>
  spawnFails?: Set<string> // taskIds whose spawn throws
  moveFails?: Set<string> // taskIds whose FIRST todo→doing move returns false
  reviewFails?: Set<string> // taskIds whose FIRST doing→review move returns false
  reviewAlwaysFails?: Set<string> // taskIds whose doing→review move ALWAYS returns false —
  //   models a PERMANENTLY rejected Board write, the only way to walk a kept move past
  //   MOVE_STUCK_MAX_RETRIES (reviewFails above fails once, so it can never reach it)
  commits?: Map<string, number> // taskId → commits ahead of trunk
  heartbeats?: Map<string, HeartbeatSign> // taskId → heartbeat
  recoverFails?: Set<string> // taskIds whose FIRST recover (todo/blocked) move returns false
  recoverTodoFails?: Set<string> // taskIds whose recover-to-'todo' ALWAYS fails (a 'blocked'
  //   recover still succeeds) — models a requeue that won't land so the engine escalates (blocked退避)
  outputs?: Map<string, number> // terminalId → PTY lastOutputAt epoch ms (absent → null)
  screens?: Map<string, string> // terminalId → current screen text (absent → null = 'normal')
  agentActivity?: Map<string, number> // worktree cwd → newest transcript/sub-agent mtime (absent → null)
  raiseFails?: boolean // make deps.raiseQuestion throw (fs/notify fault)
  spawnModel?: string // model alias the fake spawn reports launching with (quota attribution)
}): OrchestratorDeps & {
  spawned: { taskId: string; priorFailure?: string }[]
  moves: { taskId: string; branch: string }[]
  reviews: { taskId: string; branch: string }[]
  recovered: { taskId: string; column: 'todo' | 'blocked' }[]
  tornDown: { terminalId: string; worktree: string }[]
  nudged: string[] // terminalIds nudged (Enter), in order
  escalated: { terminalId: string; taskTitle: string }[] // ESC+continue escalations, in order
  raised: OpenEscalationInput[] // questions raised to the T3 inbox, in order
  board: Map<string, ProjectTask>
} => {
  const board = new Map<string, ProjectTask>(init.cards.map((c) => [c.id, { ...c }]))
  const dead = init.dead ?? new Set<string>()
  const spawnFails = init.spawnFails ?? new Set<string>()
  const moveFails = new Set(init.moveFails ?? [])
  const reviewFails = new Set(init.reviewFails ?? [])
  const reviewAlwaysFails = new Set(init.reviewAlwaysFails ?? [])
  const recoverFails = new Set(init.recoverFails ?? [])
  const recoverTodoFails = new Set(init.recoverTodoFails ?? [])
  const commits = init.commits ?? new Map<string, number>()
  const heartbeats = init.heartbeats ?? new Map<string, HeartbeatSign>()
  const outputs = init.outputs ?? new Map<string, number>()
  const screens = init.screens ?? new Map<string, string>()
  const agentActivity = init.agentActivity ?? new Map<string, number>()
  const spawned: { taskId: string; priorFailure?: string }[] = []
  const moves: { taskId: string; branch: string }[] = []
  const reviews: { taskId: string; branch: string }[] = []
  const recovered: { taskId: string; column: 'todo' | 'blocked' }[] = []
  const tornDown: { terminalId: string; worktree: string }[] = []
  const nudged: string[] = []
  const escalated: { terminalId: string; taskTitle: string }[] = []
  const raised: OpenEscalationInput[] = []
  const idOf = (branch: string) => branch.replace(/^swarm\//, '')
  let n = 0
  return {
    spawned,
    moves,
    reviews,
    recovered,
    tornDown,
    nudged,
    escalated,
    raised,
    board,
    fetchTasks: async () => Array.from(board.values()).map((c) => ({ ...c })),
    spawnWorker: async (opts) => {
      // The fake keys "which card" off the title (the engine passes the card's
      // title); map back to its id via the live board.
      const t = Array.from(board.values()).find((x) => (x.title ?? '') === opts.title)
      const taskId = t?.id ?? `?${opts.title}`
      if (spawnFails.has(taskId)) throw new Error('spawn boom')
      n += 1
      spawned.push({ taskId, priorFailure: opts.priorFailure })
      const res: SpawnSwarmWorkerResponse = {
        terminalId: `pty-${taskId}-${n}`,
        agentSessionId: `sess-${n}`,
        worktree: `/wt/${taskId}`,
        branch: `swarm/${taskId}`,
        ...(init.spawnModel ? { model: init.spawnModel } : {}),
      }
      return res
    },
    moveToDoing: async (_path, taskId, branch) => {
      if (moveFails.has(taskId)) {
        moveFails.delete(taskId) // only the FIRST move fails
        return false
      }
      moves.push({ taskId, branch })
      const c = board.get(taskId)
      if (c) c.boardColumn = 'doing'
      return true
    },
    moveToReview: async (_path, taskId, branch) => {
      if (reviewAlwaysFails.has(taskId)) return false // never lands
      if (reviewFails.has(taskId)) {
        reviewFails.delete(taskId) // only the FIRST move fails
        return false
      }
      reviews.push({ taskId, branch })
      const c = board.get(taskId)
      if (c) {
        c.boardColumn = 'review'
        if (branch) c.branch = branch
      }
      return true
    },
    countCommitsAhead: async (_path, branch) => commits.get(idOf(branch)) ?? 0,
    readHeartbeat: async (_path, branch) => heartbeats.get(idOf(branch)) ?? null,
    isAlive: (terminalId) => !Array.from(dead).some((id) => terminalId.includes(`pty-${id}-`)),
    recoverCard: async (_path, taskId, column) => {
      if (recoverFails.has(taskId)) {
        recoverFails.delete(taskId) // only the FIRST recover move fails
        return false
      }
      // A 'todo' requeue that NEVER lands (a 'blocked' park still succeeds) — drives
      // the engine's blocked退避 escalation past the retry budget.
      if (column === 'todo' && recoverTodoFails.has(taskId)) return false
      recovered.push({ taskId, column })
      const c = board.get(taskId)
      if (c) {
        c.boardColumn = column
        c.done = false
      }
      return true
    },
    recoverWorker: async ({ terminalId, worktree }) => {
      tornDown.push({ terminalId, worktree })
      return { removed: true }
    },
    // PTY output epoch, keyed by terminalId (absent → null = no output signal, so
    // the stall monitor falls back to heartbeat/startedAt). Default: none.
    lastOutputAt: (terminalId) => outputs.get(terminalId) ?? null,
    // Record the Enter-nudge; the fake worker stays as silent as the test set it
    // (outputs/heartbeats unchanged) unless the test mutates those between passes.
    nudge: (terminalId) => {
      nudged.push(terminalId)
      return true
    },
    // Record the ESC+continue escalation; like `nudge` above the fake worker stays
    // silent unless the test mutates outputs/heartbeats between passes.
    escalate: async (terminalId, taskTitle) => {
      escalated.push({ terminalId, taskTitle })
      return true
    },
    // Current screen text, keyed by terminalId (absent → null, which classifyOutput
    // reads as 'normal' = ordinary work). Drives the rate-limit / permission-wait /
    // question classification.
    recentOutput: (terminalId) => screens.get(terminalId) ?? null,
    // The THIRD liveness channel: newest transcript/sub-agent mtime for a worker's
    // worktree cwd (absent → null = no file signal, so the cheap verdict stands).
    // Drives the stall backstop that spares a worker running a Task() sub-agent.
    sessionAgentActivityAt: async (cwd) => agentActivity.get(cwd) ?? null,
    // Record a raised free-text question (C3 THROTTLED path). Throws when
    // raiseFails is set, so the "forget key + retry next pass" path is tested.
    raiseQuestion: async (inputIn: OpenEscalationInput) => {
      if (init.raiseFails) throw new Error('raise boom')
      raised.push(inputIn)
      return { escalation: { id: `esc-${raised.length}` }, deduped: false }
    },
  }
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('isTodoCard', () => {
  it('treats explicit todo, and undefined-column non-done, as todo', () => {
    expect(isTodoCard(card('a'))).toBe(true)
    expect(isTodoCard(card('b', { boardColumn: undefined }))).toBe(true)
  })
  it('excludes other columns and the legacy done flag', () => {
    expect(isTodoCard(card('a', { boardColumn: 'doing' }))).toBe(false)
    expect(isTodoCard(card('a', { boardColumn: 'review' }))).toBe(false)
    expect(isTodoCard(card('a', { boardColumn: 'done' }))).toBe(false)
    expect(isTodoCard(card('a', { boardColumn: undefined, done: true }))).toBe(false)
  })
})

describe('sortTodos', () => {
  // A time only minutes after the fixtures' createdAt, so aging is 0 and these
  // cases test the priority/boardOrder/createdAt ordering in isolation.
  const FRESH = Date.parse('2026-06-23T00:10:00Z')
  it('orders by boardOrder ascending, then ordered-before-unordered, then createdAt', () => {
    const cards = [
      card('u2', { boardOrder: undefined, createdAt: '2026-06-23T00:00:02Z' }),
      card('o5', { boardOrder: 5 }),
      card('u1', { boardOrder: undefined, createdAt: '2026-06-23T00:00:01Z' }),
      card('o1', { boardOrder: 1 }),
    ]
    // No priorities set ⇒ all 'normal' ⇒ the boardOrder/createdAt tail decides.
    expect(sortTodos(cards, FRESH).map((c) => c.id)).toEqual(['o1', 'o5', 'u1', 'u2'])
  })
  it('does not mutate its input', () => {
    const cards = [card('o5', { boardOrder: 5 }), card('o1', { boardOrder: 1 })]
    const before = cards.map((c) => c.id)
    sortTodos(cards, FRESH)
    expect(cards.map((c) => c.id)).toEqual(before)
  })
  it('dispatches higher priority FIRST, overriding boardOrder (急ぎを先に)', () => {
    const cards = [
      card('low', { priority: 'low', boardOrder: 0 }),
      card('urgent', { priority: 'urgent', boardOrder: 9 }),
      card('normal', { boardOrder: 1 }), // absent priority ⇒ normal
      card('high', { priority: 'high', boardOrder: 2 }),
    ]
    expect(sortTodos(cards, FRESH).map((c) => c.id)).toEqual([
      'urgent',
      'high',
      'normal',
      'low',
    ])
  })
  it('uses boardOrder as the tiebreak WITHIN one priority bucket', () => {
    const cards = [
      card('b', { priority: 'high', boardOrder: 5 }),
      card('a', { priority: 'high', boardOrder: 1 }),
    ]
    expect(sortTodos(cards, FRESH).map((c) => c.id)).toEqual(['a', 'b'])
  })
  it('keeps the higher-priority card ahead BEFORE the stale one ages (control)', () => {
    const stale = card('stale', { priority: 'low', createdAt: '2026-06-23T00:00:00Z' })
    const fresh = card('fresh', { priority: 'high', createdAt: '2026-06-23T00:00:00Z' })
    const now = Date.parse('2026-06-23T01:00:00Z') // 1h < aging step ⇒ no boost yet
    expect(sortTodos([stale, fresh], now).map((c) => c.id)).toEqual(['fresh', 'stale'])
  })
  it('AGES a long-waiting low card above a fresh high card (放置を防ぐ)', () => {
    const stale = card('stale', { priority: 'low', createdAt: '2026-06-23T00:00:00Z' })
    const fresh = card('fresh', { priority: 'high', createdAt: '2026-06-23T12:00:00Z' })
    // At 12:00 the low card has waited 12h (+3 aging ⇒ rank 0+3=3) while the high
    // card is brand new (rank 2+0=2) — so the aged card is dispatched first.
    const now = Date.parse('2026-06-23T12:00:00Z')
    expect(sortTodos([fresh, stale], now).map((c) => c.id)).toEqual(['stale', 'fresh'])
  })
})

describe('declaredFiles', () => {
  it('reads files from a `files:` directive line in the notes', () => {
    const t = card('a', { notes: 'do the thing\nfiles: src/x.ts, src/y.ts' })
    expect(Array.from(declaredFiles(t)).sort()).toEqual(['src/x.ts', 'src/y.ts'])
  })
  it('reads the bilingual `ファイル:` directive and a bullet prefix', () => {
    const t = card('a', { notes: '- ファイル：src/a.ts　src/b.ts' })
    expect(Array.from(declaredFiles(t)).sort()).toEqual(['src/a.ts', 'src/b.ts'])
  })
  it('normalizes quotes/backticks, backslashes, leading ./ and case', () => {
    const t = card('a', { notes: 'files: `./Src/Foo.ts`, "lib\\bar.ts".' })
    expect(Array.from(declaredFiles(t)).sort()).toEqual(['lib/bar.ts', 'src/foo.ts'])
  })
  it('collides drifted spellings of the same path onto ONE token', () => {
    // Every form below must normalize to the same token so two cards declaring
    // the "same file" different ways still serialize.
    const forms = [
      'files: src/x.ts',
      'files: ./src/x.ts',
      'files: src\\x.ts',
      'files: "src/x.ts"',
      'files: src/x.ts/',
      'files: <src/x.ts>',
      'files: src/x.ts#L42',
    ]
    for (const notes of forms) {
      expect(Array.from(declaredFiles(card('a', { notes })))).toEqual(['src/x.ts'])
    }
  })
  it('accepts +, ordered-list and blockquote/heading directive prefixes', () => {
    expect(Array.from(declaredFiles(card('a', { notes: '+ files: src/x.ts' })))).toEqual(['src/x.ts'])
    expect(Array.from(declaredFiles(card('a', { notes: '1. files: src/x.ts' })))).toEqual(['src/x.ts'])
    expect(Array.from(declaredFiles(card('a', { notes: '> files: src/x.ts' })))).toEqual(['src/x.ts'])
    expect(Array.from(declaredFiles(card('a', { notes: '#### files: src/x.ts' })))).toEqual(['src/x.ts'])
  })
  it('folds full-width path characters via NFKC', () => {
    // Full-width "ｓｒｃ／ｘ．ｔｓ" must collide with half-width "src/x.ts".
    expect(Array.from(declaredFiles(card('a', { notes: 'files: ｓｒｃ／ｘ．ｔｓ' })))).toEqual([
      'src/x.ts',
    ])
  })
  it('is opt-in: a card with no directive declares nothing', () => {
    expect(declaredFiles(card('a', { notes: 'touch some files maybe' })).size).toBe(0)
    // A path named only in prose (no `files:` lead) is NOT a declaration.
    expect(declaredFiles(card('a', { notes: 'please edit src/x.ts now' })).size).toBe(0)
  })
  it('does not match a `files:` substring mid-word (e.g. profiles:)', () => {
    expect(declaredFiles(card('a', { notes: 'profiles: should not count' })).size).toBe(0)
    expect(declaredFiles(card('a', { notes: 'makefiles: nope' })).size).toBe(0)
  })
})

describe('contentKey', () => {
  it('folds two cards with the same visible content to the same key', () => {
    const a = card('a', { title: 'Fix  bug', notes: 'In the parser' })
    const b = card('b', { title: 'fix bug', notes: 'in the   parser' })
    expect(contentKey(a)).toBe(contentKey(b))
  })
  it('distinguishes cards with different content', () => {
    expect(contentKey(card('a', { title: 'X' }))).not.toBe(contentKey(card('b', { title: 'Y' })))
  })
  it('does NOT collide across the title/notes boundary (NUL separator)', () => {
    // "a b" + "c" must differ from "a" + "b c" — a space separator would collide.
    expect(contentKey(card('a', { title: 'a b', notes: 'c' }))).not.toBe(
      contentKey(card('b', { title: 'a', notes: 'b c' })),
    )
  })
  it('folds full-width content via NFKC', () => {
    expect(contentKey(card('a', { title: 'ｆｉｘ' }))).toBe(contentKey(card('b', { title: 'fix' })))
  })
  it('returns null for a blank card (so blanks are not all collapsed)', () => {
    expect(contentKey(card('a', { title: '', notes: '  ' }))).toBeNull()
  })
})

describe('selectDispatch', () => {
  const cards = [card('o0', { boardOrder: 0 }), card('o1', { boardOrder: 1 }), card('o2', { boardOrder: 2 })]
  it('returns the first `slots` in queue order', () => {
    expect(selectDispatch(cards, new Set(), 2).map((c) => c.id)).toEqual(['o0', 'o1'])
  })
  it('excludes already-dispatched ids', () => {
    expect(selectDispatch(cards, new Set(['o0']), 2).map((c) => c.id)).toEqual(['o1', 'o2'])
  })
  it('dispatch order reflects priority (an urgent card jumps a lower boardOrder)', () => {
    // Goes through selectDispatch → sortTodos (real wall-clock now): the fixtures
    // share the same age so aging is uniform and priority is the deciding factor.
    const prioritized = [
      card('plain', { boardOrder: 0 }), // normal
      card('rush', { priority: 'urgent', boardOrder: 9 }),
    ]
    expect(selectDispatch(prioritized, new Set(), 1).map((c) => c.id)).toEqual(['rush'])
  })
  it('returns nothing when there are no slots', () => {
    expect(selectDispatch(cards, new Set(), 0)).toEqual([])
    expect(selectDispatch(cards, new Set(), -1)).toEqual([])
  })

  it('① only dispatches todo cards — never blocked/doing/review/done', () => {
    const mixed = [
      card('todo', { boardOrder: 0 }),
      card('blocked', { boardColumn: 'blocked', boardOrder: 1 }),
      card('doing', { boardColumn: 'doing', boardOrder: 2 }),
      card('review', { boardColumn: 'review', boardOrder: 3 }),
      card('done', { boardColumn: 'done', boardOrder: 4 }),
    ]
    expect(selectDispatch(mixed, new Set(), 10).map((c) => c.id)).toEqual(['todo'])
  })

  it('③ does not dispatch two content-duplicate todos in one pass', () => {
    const dup = [
      card('a', { title: 'same work', notes: 'identical', boardOrder: 0 }),
      card('b', { title: 'same work', notes: 'identical', boardOrder: 1 }),
    ]
    expect(selectDispatch(dup, new Set(), 10).map((c) => c.id)).toEqual(['a'])
  })

  it('③ does not dispatch a todo duplicating a doing card', () => {
    const tasks = [
      card('busy', { title: 'same work', notes: 'x', boardColumn: 'doing', boardOrder: 0 }),
      card('dup', { title: 'same work', notes: 'x', boardOrder: 1 }),
    ]
    expect(selectDispatch(tasks, new Set(['busy']), 10)).toEqual([])
  })

  it('④ serializes two todos that declare the same file (one per pass)', () => {
    const both = [
      card('a', { notes: 'files: src/shared.ts', boardOrder: 0 }),
      card('b', { notes: 'files: src/shared.ts', boardOrder: 1 }),
    ]
    // Plenty of slots, yet only the first is picked — the second is held.
    expect(selectDispatch(both, new Set(), 10).map((c) => c.id)).toEqual(['a'])
  })

  it('④ holds a todo whose file is claimed by a doing card', () => {
    const tasks = [
      card('busy', { notes: 'files: src/shared.ts', boardColumn: 'doing', boardOrder: 0 }),
      card('held', { notes: 'files: src/shared.ts', boardOrder: 1 }),
      card('free', { notes: 'files: src/other.ts', boardOrder: 2 }),
    ]
    // 'held' conflicts with the doing card and is held; 'free' touches a
    // different file and dispatches.
    expect(selectDispatch(tasks, new Set(['busy']), 10).map((c) => c.id)).toEqual(['free'])
  })

  it('④ holds a todo whose file is claimed by a REVIEW card (still-unmerged branch)', () => {
    // A promoted worker sits in review with its branch UNMERGED — a same-file todo
    // must keep being held, not dispatched against the pending branch.
    const tasks = [
      card('inreview', { notes: 'files: src/shared.ts', boardColumn: 'review', boardOrder: 0 }),
      card('held', { notes: 'files: src/shared.ts', boardOrder: 1 }),
    ]
    expect(selectDispatch(tasks, new Set(), 10)).toEqual([])
  })

  it('③ does not dispatch a todo duplicating a REVIEW card', () => {
    const tasks = [
      card('inreview', { title: 'same work', notes: 'x', boardColumn: 'review', boardOrder: 0 }),
      card('dup', { title: 'same work', notes: 'x', boardOrder: 1 }),
    ]
    expect(selectDispatch(tasks, new Set(), 10)).toEqual([])
  })

  it('④ lets two todos with DISJOINT files dispatch together', () => {
    const both = [
      card('a', { notes: 'files: src/a.ts', boardOrder: 0 }),
      card('b', { notes: 'files: src/b.ts', boardOrder: 1 }),
    ]
    expect(selectDispatch(both, new Set(), 10).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('⑤ holds a todo whose dependsOn prerequisite is not yet done', () => {
    const tasks = [
      card('prereq', { boardColumn: 'doing', boardOrder: 0 }), // still in flight, not done
      card('dependent', { dependsOn: ['prereq'], boardOrder: 1 }),
      card('free', { boardOrder: 2 }),
    ]
    // 'dependent' waits for 'prereq'; the independent 'free' card still dispatches.
    expect(selectDispatch(tasks, new Set(), 10).map((c) => c.id)).toEqual(['free'])
  })

  it('⑤ dispatches a dependent card once its prerequisite is done', () => {
    const tasks = [
      card('prereq', { boardColumn: 'done', done: true, boardOrder: 0 }),
      card('dependent', { dependsOn: ['prereq'], boardOrder: 1 }),
    ]
    expect(selectDispatch(tasks, new Set(), 10).map((c) => c.id)).toEqual(['dependent'])
  })

  it('⑤ never strands a card on an ABSENT (deleted) prerequisite id', () => {
    const tasks = [card('dependent', { dependsOn: ['ghost-deleted-id'], boardOrder: 0 })]
    // The prereq id isn't on the board at all → treated as satisfied, not a forever-hold.
    expect(selectDispatch(tasks, new Set(), 10).map((c) => c.id)).toEqual(['dependent'])
  })
})

describe('computeTargetWorkers — dynamic worker scaling (card ea369937)', () => {
  it('多: many independent todos drive the target up to MAX (枠を使い切る)', () => {
    // A backlog as deep as the ceiling ⇒ ride all the way up to it.
    expect(
      computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: ORCHESTRATOR_MAX_WORKERS }),
    ).toBe(ORCHESTRATOR_MAX_WORKERS)
  })

  it('少: a single independent todo keeps the target at MIN, never the cap (並列度を絞る)', () => {
    expect(computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: 1 })).toBe(ORCHESTRATOR_MIN_WORKERS)
    // The band must be real (min strictly below max) or "scaling" is a no-op.
    expect(ORCHESTRATOR_MIN_WORKERS).toBeLessThan(ORCHESTRATOR_MAX_WORKERS)
  })

  it('上限頭打ち: a flood of todos never targets past MAX (暴走防止)', () => {
    // 100 independent todos must still pin to MAX, not 100.
    expect(computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: 100 })).toBe(
      ORCHESTRATOR_MAX_WORKERS,
    )
    // Already-at-cap workers + more backlog ⇒ still capped (the total never exceeds MAX).
    expect(
      computeTargetWorkers({ liveWorkers: ORCHESTRATOR_MAX_WORKERS, dispatchableTodos: 50 }),
    ).toBe(ORCHESTRATOR_MAX_WORKERS)
  })

  it('ramps monotonically across the band as the backlog grows, then pins at max', () => {
    const seq = [0, 1, 2, 3, 4, 5, 6].map((d) =>
      computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: d, min: 1, max: 4 }),
    )
    // idle(0) → track demand 1..4 → pinned at max(4) for any deeper backlog.
    expect(seq).toEqual([0, 1, 2, 3, 4, 4, 4])
  })

  it('idle: an empty queue with no live worker targets 0 — the floor never spins up an empty board', () => {
    expect(computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: 0 })).toBe(0)
    // Even a high custom floor does NOT fabricate work on an empty board.
    expect(computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: 0, min: 3, max: 6 })).toBe(0)
  })

  it('live workers count toward demand — a drained queue holds at the running count, not 0/MAX', () => {
    // 2 mid-flight workers, queue now empty ⇒ target tracks the 2 live (passive shrink target).
    expect(computeTargetWorkers({ liveWorkers: 2, dispatchableTodos: 0 })).toBe(2)
    // demand = live + dispatchable, clamped.
    expect(computeTargetWorkers({ liveWorkers: 2, dispatchableTodos: 1 })).toBe(3)
  })

  it('honors a custom MIN floor — the clamp-UP genuinely bites once work exists', () => {
    // With min=3, even one independent todo targets the floor of 3.
    expect(computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: 1, min: 3, max: 6 })).toBe(3)
  })

  it('an INVERTED band (min > max) still never breaches the hard ceiling', () => {
    // Operator footgun min=10/max=2: the target must stay ≤ max(2), never 10.
    expect(computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: 100, min: 10, max: 2 })).toBe(2)
    expect(computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: 1, min: 10, max: 2 })).toBe(2)
  })

  it('clamps malformed (negative / fractional) signals to a sane integer target', () => {
    expect(computeTargetWorkers({ liveWorkers: -5, dispatchableTodos: -3 })).toBe(0) // negatives → 0 demand
    expect(computeTargetWorkers({ liveWorkers: 0, dispatchableTodos: 2.9 })).toBe(2) // floored
    expect(computeTargetWorkers({ liveWorkers: 1.6, dispatchableTodos: 1.6 })).toBe(2) // floor(1.6)+floor(1.6)
  })
})

describe('classifyWorker — the conservative DONE judgement', () => {
  const probe = (over: Partial<Parameters<typeof classifyWorker>[0]> = {}) => ({
    alive: true,
    commitsAhead: 0,
    heartbeat: null,
    ...over,
  })

  it('promotes when the branch has commits AND the heartbeat says ready', () => {
    const v = classifyWorker(probe({ commitsAhead: 2, heartbeat: { ready: true, blocked: false } }), false)
    expect(v).toEqual({ promote: true, stage: 'done' })
  })

  it('promotes when the PTY exited with commits and no blocker', () => {
    const v = classifyWorker(probe({ alive: false, commitsAhead: 1, heartbeat: null }), true)
    expect(v).toEqual({ promote: true, stage: 'done' })
  })

  it('does NOT promote when ready but there are no commits (the floor)', () => {
    const v = classifyWorker(probe({ commitsAhead: 0, heartbeat: { ready: true, blocked: false } }), true)
    expect(v.promote).toBe(false)
  })

  it('does NOT promote a live worker that has commits but no ready-sign (still working)', () => {
    const v = classifyWorker(probe({ alive: true, commitsAhead: 3, heartbeat: null }), true)
    expect(v).toEqual({ promote: false, stage: 'running' })
  })

  it('does NOT promote a dead worker that reported a blocker (broken, not done)', () => {
    const v = classifyWorker(probe({ alive: false, commitsAhead: 2, heartbeat: { ready: false, blocked: true } }), true)
    expect(v.promote).toBe(false)
  })

  it('shows starting before the boot window, running after / once work appears', () => {
    expect(classifyWorker(probe({ alive: true, commitsAhead: 0, heartbeat: null }), false).stage).toBe('starting')
    expect(classifyWorker(probe({ alive: true, commitsAhead: 0, heartbeat: null }), true).stage).toBe('running')
    expect(classifyWorker(probe({ alive: true, commitsAhead: 1, heartbeat: null }), false).stage).toBe('running')
    expect(
      classifyWorker(probe({ alive: true, commitsAhead: 0, heartbeat: { ready: false, blocked: false } }), false).stage,
    ).toBe('running')
  })
})

describe('recoveryColumn — where a LOST worker’s card goes', () => {
  const p = (over: Partial<WorkerProbe> = {}): WorkerProbe => ({
    alive: false,
    commitsAhead: 0,
    heartbeat: null,
    ...over,
  })

  it('requeues a bare crash to todo while the retry budget remains', () => {
    expect(recoveryColumn(p(), 0, 1)).toBe('todo')
  })

  it('parks in blocked once the retry budget is spent', () => {
    expect(recoveryColumn(p(), 1, 1)).toBe('blocked')
    expect(recoveryColumn(p(), 2, 1)).toBe('blocked')
  })

  it('parks a self-reported blocker in blocked even with budget left (never auto-retried)', () => {
    expect(recoveryColumn(p({ heartbeat: { ready: false, blocked: true } }), 0, 1)).toBe('blocked')
  })

  it('parks a ready-but-empty finish in blocked (declared done, nothing to merge — not retried)', () => {
    expect(recoveryColumn(p({ heartbeat: { ready: true, blocked: false } }), 0, 1)).toBe('blocked')
  })

  it('a zero budget parks on the very first crash', () => {
    expect(recoveryColumn(p(), 0, 0)).toBe('blocked')
  })

  // Card 4880e9c6 — the reason overrides the heartbeat/budget logic for the new
  // non-progress shapes:
  it('requeues a rate-limit wait to TODO regardless of budget (transient — retry when it lifts)', () => {
    expect(recoveryColumn(p(), 0, 1, 'rate-limit')).toBe('todo')
    // even with the budget spent, a rate-limit is never PARKED — it self-heals.
    expect(recoveryColumn(p(), 5, 1, 'rate-limit')).toBe('todo')
  })
  it('parks a RUNAWAY in blocked (a re-run would just overrun again — needs a human)', () => {
    expect(recoveryColumn(p(), 0, 1, 'runaway')).toBe('blocked')
  })
  it('parks a PERMISSION wait in blocked (bypass is broken — needs a human)', () => {
    expect(recoveryColumn(p(), 0, 1, 'permission')).toBe('blocked')
  })
  it('sends an INTEGRATION-WAIT stop to review, never blocked (2026-07-18)', () => {
    // A worker stopped after it already reached ready has committed, integrable
    // work: that is the commander's queue, not an owner decision.
    expect(recoveryColumn(p(), 0, 1, 'integration-wait')).toBe('review')
    // …and it must beat every rule that would otherwise say 'blocked': the stale
    // `ready` heartbeat (the exact shape of the incident) and a spent budget.
    expect(recoveryColumn(p({ heartbeat: { ready: true, blocked: false } }), 0, 1, 'integration-wait')).toBe('review')
    expect(recoveryColumn(p(), 9, 1, 'integration-wait')).toBe('review')
  })
  it('but a worker’s OWN blocked declaration still wins over integration-wait (2026-07-19)', () => {
    // The exemption above is scoped to ONE rule — the stale `ready` heartbeat.
    // `blocked` is different in kind: `ready` is an artefact of an earlier state,
    // `blocked` is the worker's LIVE report that it hit a wall a human must clear.
    // Routing that to 'review' discarded the only signal it managed to raise, and
    // the commander would just 差し戻し it into the same wall.
    expect(
      recoveryColumn(p({ commitsAhead: 3, heartbeat: { ready: false, blocked: true } }), 0, 1, 'integration-wait'),
    ).toBe('blocked')
    // …including when the retry budget is long gone.
    expect(
      recoveryColumn(p({ commitsAhead: 3, heartbeat: { ready: false, blocked: true } }), 5, 1, 'integration-wait'),
    ).toBe('blocked')
    // A worker that says BOTH (ready from before the 差し戻し, blocked now) is
    // blocked: the live report beats the stale one.
    expect(
      recoveryColumn(p({ heartbeat: { ready: true, blocked: true } }), 0, 1, 'integration-wait'),
    ).toBe('blocked')
  })
  it('stall behaves like crash (budget-driven) when passed explicitly', () => {
    expect(recoveryColumn(p(), 0, 1, 'stall')).toBe('todo')
    expect(recoveryColumn(p(), 1, 1, 'stall')).toBe('blocked')
  })

  // 2026-07-23 twin-dispatch root cause: a crash/stall whose branch ALREADY carries
  // committed work must PARK (blocked), not auto-retry (todo). Requeuing to todo lets
  // the next dispatch mint a FRESH swarm/* branch and stamp it onto the card,
  // orphaning the committed branch and re-implementing it as a twin (observed:
  // d44b5ff0 / 5c286c48 each grew two near-identical branches for ONE card).
  it('parks a CRASH with committed work in blocked — never an orphan-branch twin', () => {
    expect(recoveryColumn(p({ commitsAhead: 3 }), 0, 1, 'crash')).toBe('blocked')
    // Budget-left is irrelevant once there is committed work to orphan (default reason
    // is 'crash', so the un-reasoned call must park it too).
    expect(recoveryColumn(p({ commitsAhead: 1 }), 0, 1)).toBe('blocked')
  })
  it('parks a STALL with committed work in blocked too', () => {
    expect(recoveryColumn(p({ commitsAhead: 2 }), 0, 1, 'stall')).toBe('blocked')
  })
  it('a BARE crash/stall (0 commits) still auto-retries to todo — nothing committed to orphan', () => {
    expect(recoveryColumn(p({ commitsAhead: 0 }), 0, 1, 'crash')).toBe('todo')
    expect(recoveryColumn(p({ commitsAhead: 0 }), 0, 1, 'stall')).toBe('todo')
  })
  it('a RATE-LIMIT with committed work stays on todo (transient — self-heals, exempt from the park rule)', () => {
    expect(recoveryColumn(p({ commitsAhead: 5 }), 0, 1, 'rate-limit')).toBe('todo')
    expect(recoveryColumn(p({ commitsAhead: 5 }), 5, 1, 'rate-limit')).toBe('todo')
  })
})

describe('lastActivityMs — newest sign of life across both liveness channels', () => {
  const T = Date.parse('2026-06-25T00:00:00Z')
  const iso = (ms: number) => new Date(ms).toISOString()

  it('takes the max of heartbeat, PTY output, and dispatch time', () => {
    expect(lastActivityMs({ heartbeatAt: iso(T), lastOutputAt: T + 5000, startedAt: iso(T - 9999) })).toBe(T + 5000)
  })
  it('lets fresh PTY output outweigh an old heartbeat (streaming but not beating = alive)', () => {
    expect(lastActivityMs({ heartbeatAt: iso(T - 600_000), lastOutputAt: T, startedAt: iso(T - 600_000) })).toBe(T)
  })
  it('falls back to dispatch time when heartbeat/output are missing', () => {
    expect(lastActivityMs({ startedAt: iso(T) })).toBe(T)
    expect(lastActivityMs({ lastOutputAt: null, startedAt: iso(T) })).toBe(T)
  })
  it('ignores garbage stamps', () => {
    expect(lastActivityMs({ heartbeatAt: 'not-a-date', lastOutputAt: Number.NaN, startedAt: iso(T) })).toBe(T)
  })
  it('returns 0 when nothing resolves (so a no-timestamp worker reads as silent)', () => {
    expect(lastActivityMs({ heartbeatAt: '', lastOutputAt: null, startedAt: '' })).toBe(0)
  })
  it('lets a fresh sub-agent/transcript mtime outweigh an old heartbeat+output (deep in a Task() sub-agent = alive)', () => {
    expect(
      lastActivityMs({ heartbeatAt: iso(T - 600_000), lastOutputAt: T - 600_000, startedAt: iso(T - 700_000), agentActivityAtMs: T }),
    ).toBe(T)
  })
  it('ignores a null/garbage agent-activity stamp (no false life)', () => {
    expect(lastActivityMs({ startedAt: iso(T), agentActivityAtMs: null })).toBe(T)
    expect(lastActivityMs({ startedAt: iso(T), agentActivityAtMs: Number.NaN })).toBe(T)
  })
})

describe('classifyStall — nudge-then-reclaim escalation (echo-proof)', () => {
  const P = { stallMs: 10 * 60_000, cooldownMs: 3 * 60_000, echoGuardMs: 30_000, maxNudges: 2 }
  const NOW = Date.parse('2026-06-25T12:00:00Z')
  const oldStart = NOW - 60 * 60_000 // dispatched an hour ago (a real, finite floor)
  // A worker silent on both channels: no heartbeat, no output, only an old startedAt.
  const silentInput = (nudge?: { count: number; lastNudgeAt: number; escalated?: boolean }) => ({
    heartbeatAtMs: null,
    lastOutputAtMs: null,
    startedAtMs: oldStart,
    nudge,
  })

  it('leaves an ACTIVE worker alone (real life within stallMs)', () => {
    expect(
      classifyStall({ heartbeatAtMs: NOW - 60_000, lastOutputAtMs: null, startedAtMs: oldStart, nudge: undefined }, NOW, P).action,
    ).toBe('none')
  })
  it('NUDGES a silent worker that was never nudged', () => {
    expect(classifyStall(silentInput(), NOW, P).action).toBe('nudge')
  })
  it('WAITS out the cooldown after a nudge before acting again', () => {
    expect(classifyStall(silentInput({ count: 1, lastNudgeAt: NOW - 60_000 }), NOW, P).action).toBe('none')
  })
  it('NUDGES again once the cooldown elapsed and budget remains', () => {
    expect(classifyStall(silentInput({ count: 1, lastNudgeAt: NOW - P.cooldownMs - 1 }), NOW, P).action).toBe('nudge')
  })
  it('ESCALATES (ESC+continue) a worker still silent after the nudge budget is spent, exactly once', () => {
    expect(classifyStall(silentInput({ count: 2, lastNudgeAt: NOW - P.cooldownMs - 1 }), NOW, P).action).toBe('escalate')
  })
  it('WAITS out the cooldown after an escalation before reclaiming', () => {
    expect(
      classifyStall(silentInput({ count: 2, lastNudgeAt: NOW - 60_000, escalated: true }), NOW, P).action,
    ).toBe('none')
  })
  it('RECLAIMS a worker still silent after the ESC+continue escalation ALSO failed', () => {
    expect(
      classifyStall(silentInput({ count: 2, lastNudgeAt: NOW - P.cooldownMs - 1, escalated: true }), NOW, P).action,
    ).toBe('reclaim')
  })
  it('treats a post-escalation HEARTBEAT as recovery — no reclaim, progressed=true', () => {
    const lastNudgeAt = NOW - P.cooldownMs - 1
    const r = classifyStall(
      {
        heartbeatAtMs: lastNudgeAt + 1000,
        lastOutputAtMs: null,
        startedAtMs: oldStart,
        nudge: { count: 2, lastNudgeAt, escalated: true },
      },
      NOW,
      P,
    )
    expect(r.action).toBe('none')
    expect(r.progressed).toBe(true)
  })
  it('treats a post-nudge HEARTBEAT as recovery — no reclaim, progressed=true', () => {
    const lastNudgeAt = NOW - P.cooldownMs - 1
    const r = classifyStall(
      { heartbeatAtMs: lastNudgeAt + 1000, lastOutputAtMs: null, startedAtMs: oldStart, nudge: { count: 2, lastNudgeAt } },
      NOW,
      P,
    )
    expect(r.action).toBe('none')
    expect(r.progressed).toBe(true)
  })
  it('treats SUSTAINED output past the echo guard as recovery too (heartbeats are sparse)', () => {
    // The nudge worked: the worker streams output well after the echo window, but
    // has not beat yet. That real progress MUST count — else its next stall would
    // reclaim with zero nudges.
    const lastNudgeAt = NOW - 5 * 60_000
    const r = classifyStall(
      { heartbeatAtMs: null, lastOutputAtMs: lastNudgeAt + P.echoGuardMs + 1000, startedAtMs: oldStart, nudge: { count: 2, lastNudgeAt } },
      NOW,
      P,
    )
    expect(r.action).toBe('none')
    expect(r.progressed).toBe(true)
  })
  it('DISCOUNTS the Enter echo: output within echoGuardMs of the nudge is neither life nor progress', () => {
    // The only "output" is a repaint 1s after the nudge → discounted. The worker is
    // still silent and the nudge budget is spent → it ESCALATES (the echo cannot
    // save it, but reclaim is not yet due — the ESC+continue step comes first).
    const lastNudgeAt = NOW - P.cooldownMs - 1
    const r = classifyStall(
      { heartbeatAtMs: null, lastOutputAtMs: lastNudgeAt + 1000, startedAtMs: oldStart, nudge: { count: 2, lastNudgeAt } },
      NOW,
      P,
    )
    expect(r.action).toBe('escalate')
    expect(r.progressed).toBe(false)
  })
  it('DISCOUNTS the escalation echo too: still silent + already-escalated ⇒ RECLAIMS', () => {
    const lastNudgeAt = NOW - P.cooldownMs - 1
    const r = classifyStall(
      {
        heartbeatAtMs: null,
        lastOutputAtMs: lastNudgeAt + 1000,
        startedAtMs: oldStart,
        nudge: { count: 2, lastNudgeAt, escalated: true },
      },
      NOW,
      P,
    )
    expect(r.action).toBe('reclaim')
    expect(r.progressed).toBe(false)
  })

  // ── THIRD CHANNEL (transcript/sub-agent mtime) — the worker analog of 7517e4b1 ──
  // A worker silent on heartbeat AND PTY but running a Task() sub-agent (its own
  // adversarial review) is ALIVE: its transcript/sub-agent file grows while both cheap
  // channels freeze. These are the TEETH — dropping agentActivityAtMs (the mutation)
  // flips the verdict back to the nudge→reclaim ladder that lost the worktree.
  it('SPARES a worker silent on both cheap channels when its sub-agent file is fresh (no nudge)', () => {
    const withAgent = classifyStall({ ...silentInput(), agentActivityAtMs: NOW - 1000 }, NOW, P)
    expect(withAgent.action).toBe('none')
    expect(withAgent.silentMs).toBeLessThan(P.stallMs)
    // MUTATION: same worker, signal removed ⇒ the reclaim ladder starts (nudge #1).
    expect(classifyStall(silentInput(), NOW, P).action).toBe('nudge')
  })
  it('does NOT let a STALE sub-agent file rescue a genuinely-dead worker (still RECLAIMS)', () => {
    // File mtime is as old as the other channels (nothing grows — the worker died) ⇒
    // still silent ⇒ the escalation proceeds exactly as if the channel were absent.
    const dead = {
      ...silentInput({ count: 2, lastNudgeAt: NOW - P.cooldownMs - 1, escalated: true }),
      agentActivityAtMs: oldStart,
    }
    expect(classifyStall(dead, NOW, P).action).toBe('reclaim')
  })
  it('is NOT echo-guarded: sub-agent growth right after a nudge counts as life (a repaint cannot write it)', () => {
    // Unlike PTY output, a transcript/sub-agent file cannot be stamped by the Enter
    // echo — so freshness within echoGuardMs of the nudge is REAL work, not the echo.
    const lastNudgeAt = NOW - 60_000
    const r = classifyStall(
      { heartbeatAtMs: null, lastOutputAtMs: null, startedAtMs: oldStart, agentActivityAtMs: lastNudgeAt + 1000, nudge: { count: 1, lastNudgeAt } },
      NOW,
      P,
    )
    expect(r.action).toBe('none')
    expect(r.progressed).toBe(true) // growth past the nudge ⇒ recovery ⇒ budget cleared
  })
})

describe('defaultEscalate — ESC + continue-instruction (stall escalation)', () => {
  it('writes ESC, waits STALL_ESCALATE_DELAY_MS, then a one-line continue instruction + CR', async () => {
    const writes: string[] = []
    const waits: number[] = []
    const ok = await defaultEscalate('pty-a-1', 'my task', {
      write: (id, data) => {
        writes.push(`${id}:${data}`)
        return true
      },
      sleep: async (ms) => {
        waits.push(ms)
      },
    })
    expect(ok).toBe(true)
    expect(writes).toHaveLength(2)
    expect(writes[0]).toBe('pty-a-1:\x1b') // the interrupt
    expect(writes[1]).toMatch(/^pty-a-1:.*my task.*\r$/) // continue instruction, CR-terminated
    expect(writes[1]).toContain('my task のゴールを続行')
    expect(waits).toEqual([3_000])
  })
  it('returns false without waiting/writing the follow-up when the ESC write fails (PTY gone)', async () => {
    const writes: string[] = []
    let slept = false
    const ok = await defaultEscalate('pty-gone', 'x', {
      write: () => false,
      sleep: async () => {
        slept = true
      },
    })
    expect(ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(slept).toBe(false)
  })
  it('returns false when only the follow-up write fails (ESC landed, worker died mid-escalation)', async () => {
    let calls = 0
    const ok = await defaultEscalate('pty-a-1', 'x', {
      write: () => {
        calls += 1
        return calls === 1 // ESC succeeds, the follow-up fails
      },
      sleep: async () => {},
    })
    expect(ok).toBe(false)
  })
  it('STRIPS embedded ESC/control bytes from an attacker-reachable taskTitle before it reaches the raw PTY write', async () => {
    // taskTitle is card-derived (attacker-reachable in git-shared mode). Unlike
    // pastePrompt's bracketed-paste conduit, this write auto-submits with a
    // trailing CR — an embedded ESC/CSI sequence here would be MORE dangerous,
    // not less, so it must never survive into the write.
    const writes: string[] = []
    const malicious = 'evil\x1b[201~\x9bmore'
    await defaultEscalate('pty-a-1', malicious, {
      write: (id, data) => {
        writes.push(data)
        return true
      },
      sleep: async () => {},
    })
    const followUp = writes[1]
    expect(followUp).not.toContain('\x1b')
    expect(followUp).not.toContain('\x9b')
    // Only the control BYTES are dropped — the printable text around them (the
    // ESC sequence's visible payload) survives untouched, just inert as text now.
    expect(followUp).toContain('evil[201~more')
  })
  it('collapses an embedded newline in taskTitle to a space (never a bare submit mid-line)', async () => {
    const writes: string[] = []
    await defaultEscalate('pty-a-1', 'line one\nline two', {
      write: (id, data) => {
        writes.push(data)
        return true
      },
      sleep: async () => {},
    })
    const followUp = writes[1]
    expect(followUp?.split('\n')).toHaveLength(1) // the whole message is one line
    expect(followUp).toContain('line one line two')
  })
})

describe('classifyOutput — why a worker is (not) progressing, from its screen', () => {
  const ESC = '\x1b'

  it('returns "normal" for null / empty / ordinary work', () => {
    expect(classifyOutput(null)).toBe('normal')
    expect(classifyOutput('')).toBe('normal')
    expect(classifyOutput('Editing src/app.tsx — running tests… 12 passed')).toBe('normal')
  })

  it('detects a usage / quota limit (the #1 false-kill to avoid)', () => {
    expect(classifyOutput('Claude usage limit reached')).toBe('rate-limited')
    expect(classifyOutput('You are approaching your usage limit')).toBe('rate-limited')
    expect(classifyOutput('Your limit will reset at 3pm')).toBe('rate-limited')
  })

  it('detects an API overload / 429 / 529 / backoff retry', () => {
    expect(classifyOutput('API Error: 529 Overloaded')).toBe('rate-limited')
    expect(classifyOutput('{"type":"overloaded_error"}')).toBe('rate-limited')
    expect(classifyOutput('rate_limit_error')).toBe('rate-limited')
    expect(classifyOutput('Too Many Requests')).toBe('rate-limited')
    expect(classifyOutput('Retrying in 30s (attempt 2/5)')).toBe('rate-limited')
  })

  it('sees through ANSI/cursor escapes (the headless frame or raw-buffer fallback)', () => {
    expect(classifyOutput(`${ESC}[31mClaude usage limit reached${ESC}[0m`)).toBe('rate-limited')
  })

  // REGRESSION FIXTURE — the CLI's ACTUAL exhaustion wording, kept verbatim.
  // On 2026-07-09 the top line below was the last thing a worker printed before
  // going silent for 22 minutes: none of the then-current patterns matched it
  // ("Fable 5 limit" ≠ "usage limit"), so fable never cooled and the engine kept
  // dispatching workers and reviewers into the dry tier. The CLI's wording is
  // ours to track, not to guess — when it changes again, THIS list is the thing
  // to update, and a failure here is the early warning.
  it.each([
    // 1. verbatim from a worker's claude session JSONL (2026-07-09)
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.",
    // 2. the same notice for another tier — the pattern must not be fable-specific
    "You've reached your Opus 4.8 limit. Run /usage-credits to continue or switch models with /model.",
    // 3. the status-line form
    'Claude usage limit reached · resets 3pm (Asia/Tokyo)',
    // 4. the session-window form (no "usage", no "your")
    '5-hour limit reached ∙ resets 3pm',
    // 5. the notice as a TUI wraps it — the first sentence has scrolled off the
    //    box and only the remedy lines are still on screen
    ['│ Run /usage-credits to continue or  │', '│ switch models with /model.         │'].join('\n'),
  ])('REGRESSION: the real CLI limit notice is rate-limited — %s', (screen) => {
    expect(classifyOutput(screen)).toBe('rate-limited')
  })

  // A limit ANNOUNCEMENT is qualified by what ran out. A bare /limit reached/
  // also fires on these — ordinary text a worker prints, and this very file's
  // source — and a false sighting cools a HEALTHY tier for 20 minutes. Caught in
  // pre-release review (0709), before the dogfooding swarm could trip on it.
  it.each([
    'connection limit reached',
    'buffer limit reached',
    "throw new Error('limit reached')",
    String.raw`swarmOrchestrator.ts:1129:  /\blimit reached\b/,`, // a grep hit / test log
  ])('an UNQUALIFIED "limit reached" is ordinary output, not a limit — %s', (screen) => {
    expect(classifyOutput(screen)).toBe('normal')
  })

  it.each([
    '5-hour limit reached ∙ resets 3pm', // numbered session window
    'Fable 5 limit reached', // numbered model
    'Opus 4.8 limit reached', // …with a dotted version
    'Weekly limit reached',
    'Session limit reached',
  ])('…while a QUALIFIED one is a real limit — %s', (screen) => {
    expect(classifyOutput(screen)).toBe('rate-limited')
  })

  it('the /usage-credits remedy line is live — capital "Run" and all', () => {
    // No other RATE_LIMIT_PATTERN can match this string, so it drives
    // /\brun \/usage-credits\b/ ALONE. normalizeScreen strips ESC-PREFIXED escape
    // sequences and only then lowercases, so the CLI's capital "Run" survives to
    // reach the pattern (a review read the strip as unconditional and called this
    // pattern dead; `od -c` on the source and this test both say otherwise).
    expect(classifyOutput('Run /usage-credits to continue')).toBe('rate-limited')
    // The `run ` prefix is why the pattern can't be loosened to the bare slug: a
    // mention in prose / docs / this file must stay ordinary output.
    expect(classifyOutput('see /usage-credits for details')).toBe('normal')
  })

  it('detects the literal trust / permission dialog (narrow on purpose)', () => {
    expect(classifyOutput('Do you trust the files in this folder?')).toBe('permission-wait')
    expect(classifyOutput('Do you trust the files in this directory?')).toBe('permission-wait')
    expect(classifyOutput('Do you want to proceed with this edit?')).toBe('permission-wait')
  })

  it('does NOT match generic claude output as permission (the false-kill the loose patterns caused)', () => {
    // A planning list / an aside — claude's NORMAL output. The earlier loose
    // "1. Yes, proceed" / "press enter" patterns matched these and were dropped.
    expect(classifyOutput('Here is my plan:\n1. Yes, proceed with the refactor\n2. Add tests')).toBe('normal')
    expect(classifyOutput('Remember to press Enter to confirm before moving on')).toBe('normal')
  })

  it('prefers permission-wait when both could match', () => {
    expect(classifyOutput('Do you trust the files in this folder? (usage limit shown below)')).toBe('permission-wait')
  })

  it('does NOT misread a worker editing rate-limit CODE as rate-limited', () => {
    // Identifiers / comments a worker writing THIS feature would show — none match
    // the runtime-message patterns, so the worker keeps the normal stall semantics.
    expect(classifyOutput('export const RATE_LIMIT_GRACE_MS = 20 * 60_000')).toBe('normal')
    expect(classifyOutput('// handle the rateLimit / quota wait branch')).toBe('normal')
    expect(classifyOutput('if (output === "rate-limited") hold(worker)')).toBe('normal')
  })

  it('detects a free-text QUESTION at an idle input box (C3)', () => {
    const RULE = '─'.repeat(80)
    const screen = [
      '⏺ どの方針で進めますか？',
      RULE,
      '❯ ',
      RULE,
      '  ? for shortcuts · ← for agents',
    ].join('\n')
    expect(classifyOutput(screen)).toBe('question')
  })

  it('rate-limit / permission win over question when both could match (precedence)', () => {
    const RULE = '─'.repeat(80)
    const withBox = (top: string) => [top, RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n')
    // A rate-limit runtime line present alongside an idle box → rate-limited, not question.
    expect(classifyOutput(withBox('Claude usage limit reached — どうしますか？'))).toBe('rate-limited')
    // The trust dialog → permission-wait, not question.
    expect(classifyOutput(withBox('Do you trust the files in this folder?'))).toBe('permission-wait')
  })

  it('does NOT classify a WORKING screen (esc to interrupt) as a question', () => {
    const RULE = '─'.repeat(80)
    const screen = ['⏺ 進めますか？', RULE, '❯ ', RULE, '  esc to interrupt'].join('\n')
    expect(classifyOutput(screen)).toBe('normal')
  })
})

// The reviewer arm's quota sensor reads a 64KB TRANSCRIPT, not a live screen: a
// reviewer of the rate-limit code (swarmQuota.ts, this file) necessarily prints the
// notice's verbatim wording while reading the diff. Containment therefore proves
// nothing — position does. endsInRateLimit asks whether the limit was the session's
// LAST utterance (it died there) rather than something it read and worked past.
describe('endsInRateLimit — quoting the limit notice vs dying at it', () => {
  const ESC = '\x1b'
  const NOTICE =
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."

  it('is true for the bare notice — nothing follows it', () => {
    expect(endsInRateLimit(NOTICE)).toBe(true)
  })

  it('is true when only the CLI chrome trails it (the box claude repaints under its last line)', () => {
    const RULE = '─'.repeat(80)
    expect(endsInRateLimit([NOTICE, RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n'))).toBe(true)
  })

  it('is true through ANSI escapes — the transcript is raw PTY, not clean text', () => {
    expect(endsInRateLimit(`${ESC}[31m${NOTICE}${ESC}[0m`)).toBe(true)
  })

  it('is FALSE when a reviewer quoted the notice and kept working past it', () => {
    // Exactly what a reviewer of THIS patch prints: the fixture, then its analysis.
    const transcript = [
      `+  // the CLI's exhaustion notice, verbatim: "${NOTICE}"`,
      String.raw`+  /reached your .{0,40}\blimit\b/,`,
      ...Array.from(
        { length: 12 },
        (_, i) => `Hunk ${i + 1}: the guard holds and the pattern list stays anchored; nothing regresses.`,
      ),
    ].join('\n')
    // Containment (what the worker arm rightly uses on a LIVE screen) fires here…
    expect(classifyOutput(transcript)).toBe('rate-limited')
    // …and is exactly why the reviewer arm may not use it: position says "quoted".
    expect(endsInRateLimit(transcript)).toBe(false)
  })

  it('is FALSE once more than the tail budget trails the wording', () => {
    expect(endsInRateLimit(`${NOTICE} ${'x'.repeat(RATE_LIMIT_TAIL_MAX)}`)).toBe(false)
    expect(endsInRateLimit(`${NOTICE} ${'x'.repeat(RATE_LIMIT_TAIL_MAX - 2)}`)).toBe(true)
  })

  it('is FALSE with no limit wording at all, and on empty input', () => {
    expect(endsInRateLimit('reviewed the diff; no findings')).toBe(false)
    expect(endsInRateLimit('')).toBe(false)
    expect(endsInRateLimit(null)).toBe(false)
  })
})

describe('isRunaway — the hard execution-time ceiling', () => {
  const NOW = Date.parse('2026-06-25T12:00:00Z')
  it('is true once maxExecMs has elapsed since dispatch', () => {
    expect(isRunaway(NOW - 91 * 60_000, NOW, 90 * 60_000)).toBe(true)
    expect(isRunaway(NOW - 90 * 60_000, NOW, 90 * 60_000)).toBe(true) // exactly at the cap
  })
  it('is false before the ceiling', () => {
    expect(isRunaway(NOW - 89 * 60_000, NOW, 90 * 60_000)).toBe(false)
  })
  it('NEVER fires on an unparseable / missing / future dispatch time (no false kill)', () => {
    expect(isRunaway(Number.NaN, NOW, 90 * 60_000)).toBe(false)
    expect(isRunaway(0, NOW, 90 * 60_000)).toBe(false)
    expect(isRunaway(NOW + 1000, NOW, 90 * 60_000)).toBe(false)
  })
  it('SUBTRACTS the rate-limit hold — the ceiling bounds WORKING time (2026-07-12 全損)', () => {
    // The measured shape: 20m of quota wait + 84m of work = 104m alive. Charged as
    // wall-clock it is a runaway at 90m (and the worker was torn down with 15
    // uncommitted files); charged as WORK it is 84m — nowhere near the ceiling.
    expect(isRunaway(NOW - 104 * 60_000, NOW, 90 * 60_000)).toBe(true) // the OLD verdict
    expect(isRunaway(NOW - 104 * 60_000, NOW, 90 * 60_000, 20 * 60_000)).toBe(false) // the fix
    // Still fires once the WORKED time crosses the ceiling, however long it waited.
    expect(isRunaway(NOW - 200 * 60_000, NOW, 90 * 60_000, 100 * 60_000)).toBe(true) // 100m worked
    expect(isRunaway(NOW - 110 * 60_000, NOW, 90 * 60_000, 20 * 60_000)).toBe(true) // exactly 90m
  })
  it('floors a nonsense credit at 0 — a corrupt ledger can only make the check STRICTER', () => {
    // A negative / NaN credit must never be ADDED to the worker's lifetime (that
    // would kill a healthy worker early) and must never grant amnesty.
    expect(isRunaway(NOW - 91 * 60_000, NOW, 90 * 60_000, -60 * 60_000)).toBe(true)
    expect(isRunaway(NOW - 91 * 60_000, NOW, 90 * 60_000, Number.NaN)).toBe(true)
    expect(isRunaway(NOW - 89 * 60_000, NOW, 90 * 60_000, -60 * 60_000)).toBe(false)
  })

  it('repays 統合待ち too — the 2026-07-18 loss (ready 63m + idle 28m = 91m alive)', () => {
    // Ready at 63m, then 28m idle in the integration queue, then 差し戻し. On raw
    // wall-clock that is a runaway at the 90m ceiling — and the worker was torn
    // down and its card parked in 'blocked'. The credit is the whole fix.
    expect(isRunaway(NOW - 91 * 60_000, NOW, 90 * 60_000)).toBe(true) // the OLD verdict
    expect(isRunaway(NOW - 91 * 60_000, NOW, 90 * 60_000, 28 * 60_000)).toBe(false) // the fix
    // The credit is the SUM of both non-working spans (executionCredit): 20m held
    // on a quota wall + 30m waiting for the commander = 90m worked out of 140m.
    expect(isRunaway(NOW - 140 * 60_000, NOW, 90 * 60_000, 50 * 60_000)).toBe(true) // exactly 90m
    expect(isRunaway(NOW - 139 * 60_000, NOW, 90 * 60_000, 50 * 60_000)).toBe(false)
  })
})

// ── maybeAutoStartDrain / drainTickOrchestrator — auto-start without a manual ON ──
// Card cf545637: a STOPPED engine ticks nothing, so a todo added with Autonomy OFF
// would sit forever beside idle workers. The auto-start engages the engine exactly
// when (and only when) there is dispatchable work AND a free slot — never past the cap,
// never while already running, never for a non-todo (blocked/review) card.

describe('auto-start the autonomous drain (card cf545637)', () => {
  // Full deps = the dispatch-recording makeDeps + an inert integration/anomaly half.
  // The kicked chain's later passes never fire in a unit test (the TICK_MS timer is
  // cleared before it elapses), so the integration half only needs to satisfy the type.
  // IntegrationDeps re-declares some OrchestratorDeps members, so the whole thing is one
  // annotated literal (contextual typing narrows classify/verify/integrate — mirrors the
  // runEnginePass test's full-deps shape); the makeDeps recording handles (which the
  // annotation drops) are re-attached so tests can assert deps.spawned / deps.board.
  const fullDeps = (init: Parameters<typeof makeDeps>[0]) => {
    const base = makeDeps(init)
    const deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = {
      ...base,
      fetchReview: async () => [],
      changedPaths: async () => ({ tip: 'tip-x', files: [] }),
      prepareTarget: async () => 'main',
      classify: async () => 'ff',
      verify: async () => ({ ok: true, tip: null }),
      integrate: async () => ({ status: 'integrated', mode: 'ff' }),
      acquireLock: alwaysAcquireLock,
      moveToDone: async () => true,
      markConflict: async () => true,
      cleanup: async () => ({ removed: true }),
      killPty: () => {},
      instructRework: () => {},
      // Manager-only integration (2026-07-15): inert wake half — no desk, no spawn.
      // The integrate pass never fires in these dispatch/runEnginePass unit tests
      // (the TICK_MS timer is cleared first), so these only satisfy the type.
      managerPresence: async () => 'absent',
      nudgeManager: async () => true,
      wakeManager: async () => true,
      worktreeExists: async () => true,
      preflight: async () => ({ ok: true }), // claude ready by default; a test overrides to ok:false
    }
    return Object.assign(deps, {
      spawned: base.spawned,
      moves: base.moves,
      reviews: base.reviews,
      recovered: base.recovered,
      tornDown: base.tornDown,
      nudged: base.nudged,
      escalated: base.escalated,
      board: base.board,
    })
  }
  // Disarm the chain the auto-start arms (a real TICK_MS setTimeout) so it never fires
  // after the test — bare newEngine() engines aren't in the store, so __reset can't
  // reach their timers.
  const disarm = (e: ProjectEngine) => {
    e.running = false
    if (e.timer) {
      clearTimeout(e.timer)
      e.timer = null
    }
  }

  describe('maybeAutoStartDrain', () => {
    it('auto-starts + dispatches a queued todo while Autonomy is OFF (条件1)', async () => {
      const engine = newEngine({ running: false })
      const deps = fullDeps({ cards: [card('a')] })
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(true)
      expect(engine.running).toBe(true) // engaged itself — no manual ON press
      expect(deps.spawned.map((s) => s.taskId)).toEqual(['a'])
      expect(deps.moves.map((m) => m.taskId)).toEqual(['a']) // card todo→doing
      expect(deps.board.get('a')?.boardColumn).toBe('doing')
      expect(engine.workers).toHaveLength(1)
      disarm(engine)
    })

    it('is a no-op while already running — never double-drives the loop (条件2)', async () => {
      const engine = newEngine({ running: true })
      const deps = fullDeps({ cards: [card('a')] })
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(false)
      expect(deps.spawned).toHaveLength(0) // the running tick owns dispatch, not this
    })

    it('is a no-op when the queue has nothing dispatchable — OFF stays OFF', async () => {
      const engine = newEngine({ running: false })
      const deps = fullDeps({ cards: [] }) // empty board
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(false)
      expect(engine.running).toBe(false)
      expect(deps.spawned).toHaveLength(0)
    })

    it('does NOT auto-start when every worker slot is full — respects the cap (条件3)', async () => {
      // MAX live workers already + more todos waiting ⇒ zero free slots ⇒ no auto-start.
      const liveWorkers = Array.from({ length: ORCHESTRATOR_MAX_WORKERS }, (_, i) =>
        worker({ terminalId: `pty-w${i}-1`, branch: `swarm/w${i}`, taskId: `w${i}` }),
      )
      const engine = newEngine({ running: false, workers: liveWorkers })
      const deps = fullDeps({ cards: [card('a'), card('b')] }) // todos waiting
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(false)
      expect(engine.running).toBe(false)
      expect(deps.spawned).toHaveLength(0) // never spawns past the ceiling
    })

    it('caps the auto-start dispatch at ORCHESTRATOR_MAX_WORKERS (条件3)', async () => {
      const cards = Array.from({ length: ORCHESTRATOR_MAX_WORKERS + 3 }, (_, i) =>
        card(`c${i}`, { boardOrder: i }),
      )
      const engine = newEngine({ running: false })
      const deps = fullDeps({ cards })
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(true)
      expect(deps.spawned).toHaveLength(ORCHESTRATOR_MAX_WORKERS) // not MAX+3
      expect(engine.workers).toHaveLength(ORCHESTRATOR_MAX_WORKERS)
      disarm(engine)
    })

    it('arms the tick chain so the lifecycle continues after auto-start', async () => {
      const engine = newEngine({ running: false })
      const deps = fullDeps({ cards: [card('a')] })
      await maybeAutoStartDrain(engine, deps)
      expect(engine.timer).not.toBeNull() // scheduleNext armed the next pass
      disarm(engine)
    })

    it('does not re-grab a card parked in blocked — stop/resolve flow intact (条件2)', async () => {
      const engine = newEngine({ running: false })
      const deps = fullDeps({ cards: [card('a', { boardColumn: 'blocked' })] })
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(false) // blocked isn't a todo ⇒ nothing to drain
      expect(engine.running).toBe(false)
      expect(deps.spawned).toHaveLength(0)
    })

    it('still refills only the FREE slots when some workers are already live (条件3)', async () => {
      // 2 live workers, MAX free-slot headroom ⇒ auto-start tops up to the cap, no more.
      const liveWorkers = [
        worker({ terminalId: 'pty-w0-1', branch: 'swarm/w0', taskId: 'w0' }),
        worker({ terminalId: 'pty-w1-1', branch: 'swarm/w1', taskId: 'w1' }),
      ]
      const cards = Array.from({ length: ORCHESTRATOR_MAX_WORKERS }, (_, i) =>
        card(`c${i}`, { boardOrder: i }),
      )
      const engine = newEngine({ running: false, workers: liveWorkers })
      const deps = fullDeps({ cards })
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(true)
      // target = clamp(2 live + MAX todos, min, MAX) = MAX ⇒ free slots = MAX - 2.
      expect(deps.spawned).toHaveLength(ORCHESTRATOR_MAX_WORKERS - 2)
      disarm(engine)
    })
  })

  describe('maybeAutoStartDrain — explicit pause + twin-dispatch guard', () => {
    beforeEach(() => __resetOrchestratorForTests())
    afterEach(() => __resetOrchestratorForTests())

    it('skips auto-start when claude preflight is NOT ready — no retry storm (design note 4)', async () => {
      const engine = newEngine({ running: false })
      const deps = fullDeps({ cards: [card('a')] })
      deps.preflight = async () => ({ ok: false }) // claude missing / logged out
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(false)
      expect(engine.running).toBe(false) // never flips running into a known-failing spawn
      expect(deps.spawned).toHaveLength(0)
    })

    it('final re-check AFTER the preflight await catches a concurrent engage (twin-dispatch)', async () => {
      // The preflight is the LAST await before the synchronous running=true commit, so a
      // rival caller (another drain-tick / sweep) that engaged the engine DURING our preflight
      // await must be caught by the re-check that follows it — else we double-dispatch.
      const engine = newEngine({ running: false })
      const deps = fullDeps({ cards: [card('a')] })
      deps.preflight = async () => {
        engine.running = true // a rival committed running=true while we awaited preflight
        return { ok: true }
      }
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(false) // the post-preflight re-check bails — drop it and this fails
      expect(deps.spawned).toHaveLength(0) // no second dispatch over the rival's engage
    })

    it('does NOT auto-start when the owner explicitly paused (manualStop) — 条件2', async () => {
      const engine = newEngine({ running: false, manualStop: true })
      const deps = fullDeps({ cards: [card('a')] }) // dispatchable + idle slot, but paused
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(false)
      expect(engine.running).toBe(false) // OFF stays OFF until a manual ON
      expect(deps.spawned).toHaveLength(0)
    })

    it('bails while a pass is already in flight (passInFlight) — mid-pass guard', async () => {
      const engine = newEngine({ running: false, passInFlight: true })
      const deps = fullDeps({ cards: [card('a')] })
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(false)
      expect(deps.spawned).toHaveLength(0)
    })

    it('HOLDS passInFlight across the inline dispatch so a concurrent kick bails (finding A)', async () => {
      // runDispatchPass does NOT set passInFlight, so maybeAutoStartDrain must — assert it
      // is set WHILE spawnWorker runs (the slow window a manual stop→start could otherwise
      // slip a SECOND dispatch into, double-spawning the same card).
      const engine = newEngine({ running: false })
      const deps = fullDeps({ cards: [card('a')] })
      const realSpawn = deps.spawnWorker
      let inFlightDuringSpawn = false
      deps.spawnWorker = async (opts) => {
        inFlightDuringSpawn = engine.passInFlight === true
        return realSpawn(opts)
      }
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(true)
      expect(inFlightDuringSpawn).toBe(true) // guarded during the slow spawn window
      expect(engine.passInFlight).toBe(false) // cleared after the pass settles
      disarm(engine)
    })

    it('stopOrchestrator sets manualStop so a later poll will not auto-restart', async () => {
      const key = await canonicalize('/proj-manualstop-wire')
      const engine = newEngine({ path: key, running: true })
      __seedEngineForTests(engine)
      await stopOrchestrator('/proj-manualstop-wire', makeDeps({ cards: [] }))
      expect(engine.manualStop).toBe(true)
      expect(engine.running).toBe(false)
      // The pause now suppresses auto-start even with a todo + a free slot present.
      const deps = fullDeps({ cards: [card('a')] })
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(false)
      expect(deps.spawned).toHaveLength(0)
    })
  })

  // OVERSEER (EPIC C / C-core) — the THIRD toggle's D1 semantics: default OFF,
  // asymmetric clear on an explicit autonomy OFF, and NEVER ignited by an auto-drain.
  // (Restart-OFF is the in-memory globalThis store itself — a fresh engine is OFF, the
  // "default OFF" test below; a real relaunch just re-mints the store.)
  describe('overseer toggle — D1 semantics (default OFF / stop clears / auto-drain never ignites)', () => {
    it('is OFF by default and toggles idempotently (owner POST only)', async () => {
      const key = await canonicalize('/proj-overseer-toggle')
      const engine = newEngine({ path: key, running: true })
      __seedEngineForTests(engine)
      expect(engine.overseer.enabled).toBe(false) // default OFF (D1)

      const on = await setOverseer('/proj-overseer-toggle', true, fullDeps({ cards: [] }))
      expect(engine.overseer.enabled).toBe(true)
      expect(on.overseer).toBe(true) // surfaced in the public state

      const off = await setOverseer('/proj-overseer-toggle', false, fullDeps({ cards: [] }))
      expect(engine.overseer.enabled).toBe(false)
      expect(off.overseer).toBe(false)
      disarm(engine)
    })

    it('REFUSES to arm the overseer on a STOPPED engine (autonomy must be ON — §5:243)', async () => {
      // Closes the D1/K1 gap the adversarial review surfaced: if arming a fresh stopped
      // engine were allowed, a later auto-drain re-ignition would activate a pre-armed
      // overseer (riding a machine-driven restart). Arming requires running.
      const key = await canonicalize('/proj-overseer-armstopped')
      const engine = newEngine({ path: key, running: false })
      __seedEngineForTests(engine)
      const state = await setOverseer('/proj-overseer-armstopped', true, fullDeps({ cards: [] }))
      expect(engine.overseer.enabled).toBe(false) // arm ignored — engine not running
      expect(state.overseer).toBe(false)
      // And now a subsequent auto-drain (which engages the stopped engine) still finds
      // it DISARMED — the pre-armed-then-auto-ignited path is unreachable.
      const deps = fullDeps({ cards: [card('a')] })
      await maybeAutoStartDrain(engine, deps)
      expect(engine.running).toBe(true)
      expect(engine.overseer.enabled).toBe(false)
      disarm(engine)
    })

    it('stopOrchestrator CLEARS overseer.enabled but LEAVES selfSupply (the D1 asymmetry)', async () => {
      const key = await canonicalize('/proj-overseer-stopclear')
      const engine = newEngine({ path: key, running: true })
      engine.selfSupply.enabled = true
      engine.overseer.enabled = true
      __seedEngineForTests(engine)

      await stopOrchestrator('/proj-overseer-stopclear', makeDeps({ cards: [] }))

      // The most-dangerous stage is disarmed by an explicit OFF …
      expect(engine.overseer.enabled).toBe(false)
      // … while the benign switch survives (it re-acts on the next start).
      expect(engine.selfSupply.enabled).toBe(true)
    })

    it('maybeAutoStartDrain (auto-drain re-ignition) NEVER sets overseer.enabled', async () => {
      // The 0.11.12 auto-drain-default-ON class of bug must never reach the overseer:
      // an auto-drain engages the engine (running:true) but the overseer stays OFF —
      // `enabled` only ever becomes true through the owner POST (setOverseer above).
      const engine = newEngine({ running: false })
      expect(engine.overseer.enabled).toBe(false)
      const deps = fullDeps({ cards: [card('a')] })
      const started = await maybeAutoStartDrain(engine, deps)
      expect(started).toBe(true) // the drain engaged …
      expect(engine.running).toBe(true)
      expect(engine.overseer.enabled).toBe(false) // … but the overseer did NOT wake
      disarm(engine)
    })
  })

  describe('drainTickOrchestrator vs getOrchestratorState — tick is opt-in (no auto-start), GET is read-only', () => {
    beforeEach(() => __resetOrchestratorForTests())
    afterEach(() => __resetOrchestratorForTests()) // clear the armed chain timer

    it('drainTickOrchestrator does NOT auto-start a stopped engine — autonomy is opt-in (eadb25e6)', async () => {
      // Merely mounting the Swarm pane (incl. a pane RESTORED on app launch) must NOT spin
      // up workers. A dispatchable todo + free slot is no longer enough — the owner must
      // press Autonomy ON (startOrchestrator). The drain-tick is now a pure state read.
      const deps = fullDeps({ cards: [card('a')] })
      const state = await drainTickOrchestrator('/proj-autostart-tick', deps)
      expect(state.running).toBe(false) // the tick left the fresh engine stopped
      expect(deps.spawned).toHaveLength(0) // nothing auto-spawned
      expect(deps.board.get('a')?.boardColumn).toBe('todo') // the card stays queued
    })

    it('drainTickOrchestrator leaves a stopped engine stopped when the queue is empty', async () => {
      const deps = fullDeps({ cards: [] })
      const state = await drainTickOrchestrator('/proj-autostart-empty', deps)
      expect(state.running).toBe(false)
      expect(deps.spawned).toHaveLength(0)
    })

    it('getOrchestratorState is PURE READ-ONLY — a dispatchable todo NEVER spawns (Board GET contract)', async () => {
      // The display-only Board worker-map (BoardModule) polls this SAME GET, so it must
      // never mutate/spawn — the MUST_FIX this split addresses. Seed a stopped engine with
      // a dispatchable todo + an idle slot (the exact setup that auto-starts via the tick
      // above) and assert the GET path leaves it untouched.
      const key = await canonicalize('/proj-readonly-get')
      const engine = newEngine({ path: key, running: false })
      __seedEngineForTests(engine)
      const deps = fullDeps({ cards: [card('a')] })
      const state = await getOrchestratorState('/proj-readonly-get', deps)
      expect(state.running).toBe(false) // NOT auto-started by a read
      expect(engine.running).toBe(false)
      expect(deps.spawned).toHaveLength(0) // NO worker spawned
      expect(deps.board.get('a')?.boardColumn).toBe('todo') // card untouched
    })
  })

  describe('autonomy restart reminder — relaunch OFF + a persisted "resume?" marker (itemA)', () => {
    beforeEach(() => __resetOrchestratorForTests())
    afterEach(async () => {
      __resetOrchestratorForTests() // clear any armed chain timer (startOrchestrator arms one)
      // settings.json is shared across this file's tests (one isolated tmp HOME), so
      // forget every key we touched — a leaked marker would flip a later test's baseline.
      for (const p of [
        '/proj-remember-start',
        '/proj-dismiss-after-restart',
        '/proj-seeded-remember',
        '/proj-store-helpers',
        '/proj-restart-drops-dwell',
      ]) {
        await forgetSwarmAutonomy(await canonicalize(p))
      }
    })

    it('startOrchestrator DROPS the review dwell clock — engine-OFF time is not 「統合待ち」 (2026-07-22)', async () => {
      // The clock feeds the manager stall check, and the first pass after a start runs
      // immediately (lastIntegrateAt is zeroed here too). A stamp carried across the stop
      // would therefore arrive ALREADY past the 40-minute window and fire an ESC at the
      // desk the owner stopped the engine to use by hand. Nothing beats while they work
      // there, so delivery is stale as well — both halves of the rule would be satisfied.
      const engine = newEngine({ running: false })
      engine.path = await canonicalize('/proj-restart-drops-dwell')
      engine.reviewSeenAt = new Map([['swarm/a', 1_000]]) // stamped before the stop
      __seedEngineForTests(engine)
      await startOrchestrator(engine.path, fullDeps({ cards: [] }))
      expect(engine.running).toBe(true)
      expect(engine.reviewSeenAt.size).toBe(0) // ← the wait restarts from the restart
      expect(engine.lastIntegrateAt).toBe(0) // (the sibling reset this one rides beside)
      // 60s, not vitest's 5s default: startOrchestrator writes settings and kicks a real
      // pass, so this test is IO-bound like its siblings here — measured 9s alone and
      // >19s while another worker's suite held the machine at load ~9. A 5s budget makes
      // it a load thermometer rather than an assertion (the flake class recorded in
      // vitest.config's sibling files).
    }, 60_000)

    it('startOrchestrator (Autonomy ON) PERSISTS the marker so a restart can remind', async () => {
      const key = await canonicalize('/proj-remember-start')
      expect(await isSwarmAutonomyRemembered(key)).toBe(false) // clean baseline
      await startOrchestrator('/proj-remember-start', fullDeps({ cards: [] }))
      expect(await isSwarmAutonomyRemembered(key)).toBe(true) // the owner's intent is now durable
    })

    it('after a RESTART (engine gone) getOrchestratorState surfaces the marker but running stays OFF (fail-safe, no auto-resume)', async () => {
      const key = await canonicalize('/proj-seeded-remember')
      // A prior session persisted the intent; the in-memory engine died on relaunch,
      // so store.engines has NO entry — the exact moment the reminder must surface.
      await rememberSwarmAutonomy(key)
      const state = await getOrchestratorState('/proj-seeded-remember', fullDeps({ cards: [card('a')] }))
      expect(state.running).toBe(false) // NEVER auto-resumed — the whole point
      expect(state.autonomyRemembered).toBe(true) // ...but the UI gets its "resume?" signal
    })

    it('stopOrchestrator (explicit OFF / dismiss) CLEARS the marker even when no engine exists this session', async () => {
      const key = await canonicalize('/proj-dismiss-after-restart')
      await rememberSwarmAutonomy(key) // pretend a prior session left it on
      expect(await isSwarmAutonomyRemembered(key)).toBe(true)
      // Post-restart there is no engine in the store; the clear must happen anyway,
      // BEFORE the `if (!engine)` early-return — otherwise "dismiss" would be a no-op.
      const state = await stopOrchestrator('/proj-dismiss-after-restart', makeDeps({ cards: [] }))
      expect(await isSwarmAutonomyRemembered(key)).toBe(false)
      expect(state.autonomyRemembered).toBe(false)
      expect(state.running).toBe(false)
    })

    it('store helpers: remember is idempotent, forget removes, empty/unknown key is never remembered', async () => {
      const key = await canonicalize('/proj-store-helpers')
      expect(await isSwarmAutonomyRemembered(key)).toBe(false)
      await rememberSwarmAutonomy(key)
      await rememberSwarmAutonomy(key) // idempotent — no duplicate entry
      expect(await isSwarmAutonomyRemembered(key)).toBe(true)
      await forgetSwarmAutonomy(key)
      expect(await isSwarmAutonomyRemembered(key)).toBe(false)
      expect(await isSwarmAutonomyRemembered('')).toBe(false) // guards the empty key
    })
  })

  // manualStop VISIBILITY + PERSISTENCE (0707 twin-dispatch root cause): "the owner
  // stopped this by hand" must be machine-readable from OUTSIDE (a commander /
  // another session polling the state API), and must survive a server restart —
  // as a RECORD + an auto-start suppressor only, never an auto-resume.
  describe('manualStop — externally observable + persisted across a restart (never auto-resumes)', () => {
    beforeEach(() => __resetOrchestratorForTests())
    afterEach(async () => {
      __resetOrchestratorForTests() // clear any armed chain timer (startOrchestrator arms one)
      // settings.json is shared across this file's tests (one isolated tmp HOME) —
      // forget every persisted key we touched so nothing leaks into later baselines.
      for (const p of [
        '/proj-mstop-visible',
        '/proj-mstop-restart',
        '/proj-mstop-sweep',
        '/proj-mstop-restart-on',
        '/proj-mstop-tick',
        '/proj-mstop-helpers',
      ]) {
        const k = await canonicalize(p)
        await forgetSwarmManualStop(k)
        await forgetSwarmAutonomy(k)
      }
    })

    it('stopOrchestrator makes manualStop machine-readable on the state API — flag AND persisted record (①)', async () => {
      const key = await canonicalize('/proj-mstop-visible')
      const engine = newEngine({ path: key, running: true })
      __seedEngineForTests(engine)

      const stopped = await stopOrchestrator('/proj-mstop-visible', makeDeps({ cards: [] }))
      // The stop's own response already carries the machine-readable pause…
      expect(stopped.manualStop).toBe(true)
      expect(stopped.manualStopPersisted).toBe(true)
      // …and so does the poll GET (what an outside observer actually reads).
      const state = await getOrchestratorState('/proj-mstop-visible', fullDeps({ cards: [] }))
      expect(state.running).toBe(false)
      expect(state.manualStop).toBe(true)
      expect(state.manualStopPersisted).toBe(true)
      expect(await isSwarmManualStopPersisted(key)).toBe(true) // the durable half on disk
    })

    it('survives a RESTART (engine gone): the persisted record still reads back, and running stays OFF (②③)', async () => {
      const key = await canonicalize('/proj-mstop-restart')
      __seedEngineForTests(newEngine({ path: key, running: true }))
      await stopOrchestrator('/proj-mstop-restart', makeDeps({ cards: [] }))

      // Process-restart equivalent: the in-memory engine store is wiped (a fresh
      // process re-mints it empty); settings.json survives on the isolated HOME.
      __resetOrchestratorForTests()

      const state = await getOrchestratorState('/proj-mstop-restart', fullDeps({ cards: [card('a')] }))
      expect(state.running).toBe(false) // NEVER auto-resumed (and never auto-anything)
      expect(state.manualStop).toBe(true) // the deliberate stop is still visible…
      expect(state.manualStopPersisted).toBe(true) // …and attributed to the durable record
      // The read was PURE (K8): no engine was revived into a running state, no spawn.
      const again = await getOrchestratorState('/proj-mstop-restart', fullDeps({ cards: [card('a')] }))
      expect(again.running).toBe(false)
    })

    it('after a restart the AUTODRAIN sweep still respects the persisted pause — fresh engine, in-memory flag gone (③)', async () => {
      const key = await canonicalize('/proj-mstop-sweep')
      __seedEngineForTests(newEngine({ path: key, running: true }))
      await stopOrchestrator('/proj-mstop-sweep', makeDeps({ cards: [] }))
      __resetOrchestratorForTests() // restart: the manualStop FLAG dies with the engine

      // The opt-in background sweep re-mints a fresh engine (manualStop:false in
      // memory) over a dispatchable todo + a free slot — exactly the state that
      // auto-starts a never-paused project. The persisted record must hold it OFF.
      const deps = fullDeps({ cards: [card('a')] })
      const started = await runAutoDrainScan(deps, async () => ['/proj-mstop-sweep'])
      expect(started).toBe(0)
      expect(deps.spawned).toHaveLength(0) // no worker ignited off the wiped flag
      const state = await getOrchestratorState('/proj-mstop-sweep', deps)
      expect(state.running).toBe(false)
    })

    it('an explicit Autonomy ON clears the persisted record — consent always re-opens (even after a restart)', async () => {
      const key = await canonicalize('/proj-mstop-restart-on')
      __seedEngineForTests(newEngine({ path: key, running: true }))
      await stopOrchestrator('/proj-mstop-restart-on', makeDeps({ cards: [] }))
      __resetOrchestratorForTests() // restart — only the record survives
      expect(await isSwarmManualStopPersisted(key)).toBe(true)

      const state = await startOrchestrator('/proj-mstop-restart-on', fullDeps({ cards: [] }))
      expect(state.running).toBe(true) // the owner's explicit ON outranks the record
      expect(state.manualStop).toBe(false)
      expect(state.manualStopPersisted).toBe(false)
      expect(await isSwarmManualStopPersisted(key)).toBe(false) // cleared on disk too
      __resetOrchestratorForTests() // disarm the chain startOrchestrator armed
    })

    it('drainTickOrchestrator (the Swarm poll) surfaces the persisted pause like the GET — and still never starts', async () => {
      const key = await canonicalize('/proj-mstop-tick')
      __seedEngineForTests(newEngine({ path: key, running: true }))
      await stopOrchestrator('/proj-mstop-tick', makeDeps({ cards: [] }))
      __resetOrchestratorForTests() // restart

      const deps = fullDeps({ cards: [card('a')] })
      const state = await drainTickOrchestrator('/proj-mstop-tick', deps)
      expect(state.running).toBe(false) // the tick is a pure read (eadb25e6)
      expect(state.manualStop).toBe(true) // …that agrees with the GET on the pause
      expect(state.manualStopPersisted).toBe(true)
      expect(deps.spawned).toHaveLength(0)
    })

    it('store helpers: remember is idempotent, forget removes, empty key never persists (②)', async () => {
      const key = await canonicalize('/proj-mstop-helpers')
      expect(await isSwarmManualStopPersisted(key)).toBe(false)
      await rememberSwarmManualStop(key)
      await rememberSwarmManualStop(key) // idempotent — no duplicate entry
      expect(await isSwarmManualStopPersisted(key)).toBe(true)
      await forgetSwarmManualStop(key)
      expect(await isSwarmManualStopPersisted(key)).toBe(false)
      expect(await isSwarmManualStopPersisted('')).toBe(false) // guards the empty key
    })
  })

  describe('bootAutoDrainEnabled — boot auto-drain is STRICT OPT-IN, default OFF (item1 / eadb25e6)', () => {
    it('is OFF when OPENGROUND_SWARM_AUTODRAIN is unset — the default that keeps a plain launch idle', () => {
      expect(bootAutoDrainEnabled({})).toBe(false)
    })
    it('is ON only for the exact string "1"', () => {
      expect(bootAutoDrainEnabled({ OPENGROUND_SWARM_AUTODRAIN: '1' })).toBe(true)
    })
    it('stays OFF for any other value (0 / true / yes / empty / on / 2)', () => {
      for (const v of ['0', 'true', 'yes', '', 'on', '2']) {
        expect(bootAutoDrainEnabled({ OPENGROUND_SWARM_AUTODRAIN: v })).toBe(false)
      }
    })
  })

  describe('runAutoDrainScan — server-side UI-independent sweep (条件1/2/3/5)', () => {
    beforeEach(() => __resetOrchestratorForTests())
    afterEach(() => {
      __resetOrchestratorForTests() // clear any armed chain timers
      stopAutoDrainLoop() // and the background loop, if a test started it (defensive)
    })

    it('auto-starts a stopped project with a todo — NO UI open (条件1/5)', async () => {
      const key = await canonicalize('/proj-scan-a')
      const engine = newEngine({ path: key, running: false })
      __seedEngineForTests(engine)
      const deps = fullDeps({ cards: [card('a')] })
      const started = await runAutoDrainScan(deps, async () => ['/proj-scan-a'])
      expect(started).toBe(1)
      expect(engine.running).toBe(true) // engaged with no UI / no manual ON
      expect(deps.spawned.map((s) => s.taskId)).toEqual(['a'])
      expect(deps.board.get('a')?.boardColumn).toBe('doing')
    })

    it('respects manualStop — a paused project is NOT auto-started by the sweep (条件3/5)', async () => {
      const key = await canonicalize('/proj-scan-paused')
      const engine = newEngine({ path: key, running: false, manualStop: true })
      __seedEngineForTests(engine)
      const deps = fullDeps({ cards: [card('a')] })
      const started = await runAutoDrainScan(deps, async () => ['/proj-scan-paused'])
      expect(started).toBe(0)
      expect(engine.running).toBe(false) // explicit OFF honored by the background sweep too
      expect(deps.spawned).toHaveLength(0)
    })

    it('no-ops a running project — no double-start over its own chain (条件2)', async () => {
      const key = await canonicalize('/proj-scan-running')
      const engine = newEngine({ path: key, running: true })
      __seedEngineForTests(engine)
      const deps = fullDeps({ cards: [card('a')] })
      const started = await runAutoDrainScan(deps, async () => ['/proj-scan-running'])
      expect(started).toBe(0)
      expect(deps.spawned).toHaveLength(0) // the running engine's chain owns dispatch
    })

    it('sweeps multiple projects, auto-starting only the eligible ones', async () => {
      const kPaused = await canonicalize('/proj-multi-paused')
      const kReady = await canonicalize('/proj-multi-ready')
      __seedEngineForTests(newEngine({ path: kPaused, running: false, manualStop: true }))
      __seedEngineForTests(newEngine({ path: kReady, running: false }))
      const deps = fullDeps({ cards: [card('a')] })
      const started = await runAutoDrainScan(deps, async () => [
        '/proj-multi-paused',
        '/proj-multi-ready',
      ])
      expect(started).toBe(1) // only the non-paused project engages
    })

    it('a registry read fault yields an empty sweep (best-effort, never throws)', async () => {
      const deps = fullDeps({ cards: [card('a')] })
      const started = await runAutoDrainScan(deps, async () => {
        throw new Error('registry blip')
      })
      expect(started).toBe(0)
      expect(deps.spawned).toHaveLength(0)
    })

    it('startAutoDrainLoop is idempotent + stopAutoDrainLoop clears (no stacked loops)', () => {
      stopAutoDrainLoop() // clean slate
      const clearSpy = vi.spyOn(globalThis, 'clearInterval')
      startAutoDrainLoop(fullDeps({ cards: [] }), 600_000) // long interval — never fires here
      const first = globalThis.__openground_swarm_autodrain_timer
      expect(first).toBeTruthy()
      startAutoDrainLoop(fullDeps({ cards: [] }), 600_000) // re-arm: CLEARS the old, doesn't stack
      const second = globalThis.__openground_swarm_autodrain_timer
      expect(second).toBeTruthy()
      expect(second).not.toBe(first)
      // Teeth: the prior timer was ACTUALLY cleared on re-arm (not merely overwritten +
      // leaked) — drop the clearInterval in startAutoDrainLoop and this assertion fails.
      expect(clearSpy).toHaveBeenCalledWith(first)
      stopAutoDrainLoop()
      expect(globalThis.__openground_swarm_autodrain_timer ?? null).toBeNull()
      expect(clearSpy).toHaveBeenCalledWith(second) // stop cleared the live one too
      clearSpy.mockRestore()
    })
  })
})

// ── runDispatchPass — drain + dispatch (Card①) ─────────────────────────────────

describe('runDispatchPass — switch OFF', () => {
  it('dispatches nothing and touches no worker when running is false', async () => {
    const engine = newEngine({ running: false })
    const deps = makeDeps({ cards: [card('a'), card('b')] })
    await runDispatchPass(engine, deps)
    expect(deps.spawned).toHaveLength(0)
    expect(deps.moves).toHaveLength(0)
    expect(engine.workers).toHaveLength(0)
  })
})

describe('runDispatchPass — drain + dispatch', () => {
  it('dispatches todos in queue order up to the cap, moving each to doing', async () => {
    const cards = Array.from({ length: ORCHESTRATOR_MAX_WORKERS + 2 }, (_, i) =>
      card(`c${i}`, { boardOrder: i }),
    )
    const engine = newEngine()
    const deps = makeDeps({ cards })
    await runDispatchPass(engine, deps)

    // Exactly MAX dispatched (the cap), oldest-first, the overflow left in todo.
    expect(deps.spawned.map((s) => s.taskId)).toEqual(
      Array.from({ length: ORCHESTRATOR_MAX_WORKERS }, (_, i) => `c${i}`),
    )
    expect(engine.workers).toHaveLength(ORCHESTRATOR_MAX_WORKERS)
    // A freshly dispatched worker enters at 'starting'.
    expect(engine.workers.every((w) => w.stage === 'starting')).toBe(true)
    // Every dispatched card moved todo→doing, with its branch recorded.
    expect(deps.moves.map((m) => m.taskId)).toEqual(
      Array.from({ length: ORCHESTRATOR_MAX_WORKERS }, (_, i) => `c${i}`),
    )
    expect(deps.moves.every((m) => m.branch === `swarm/${m.taskId}`)).toBe(true)
    // A dispatch line per worker.
    expect(engine.log.filter((l) => l.message.startsWith('dispatch:'))).toHaveLength(
      ORCHESTRATOR_MAX_WORKERS,
    )
  })

  it('respects the cap when workers already exist, dispatching only the free slots', async () => {
    // Pre-existing workers WITH their cards already in 'doing' (the realistic
    // shape) so the monitor keeps them instead of treating them as orphans.
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-x-1', branch: 'swarm/x', worktree: '/wt/x', taskId: 'x', taskTitle: 'x' }),
        worker({ terminalId: 'pty-y-1', branch: 'swarm/y', worktree: '/wt/y', taskId: 'y', taskTitle: 'y' }),
      ],
    })
    const cards = [
      card('x', { boardColumn: 'doing' }),
      card('y', { boardColumn: 'doing' }),
      ...Array.from({ length: 10 }, (_, i) => card(`c${i}`, { boardOrder: i })),
    ]
    const deps = makeDeps({ cards })
    await runDispatchPass(engine, deps)
    // 2 already live → only (MAX-2) new spawns.
    expect(deps.spawned).toHaveLength(ORCHESTRATOR_MAX_WORKERS - 2)
    expect(engine.workers).toHaveLength(ORCHESTRATOR_MAX_WORKERS)
  })

  it('refills a slot freed by an exited worker on the next pass', async () => {
    const cards = Array.from({ length: ORCHESTRATOR_MAX_WORKERS + 1 }, (_, i) =>
      card(`c${i}`, { boardOrder: i }),
    )
    const dead = new Set<string>()
    const deps = makeDeps({ cards, dead })
    const engine = newEngine()

    await runDispatchPass(engine, deps) // fills the cap, c{0..MAX-1}
    expect(engine.workers).toHaveLength(ORCHESTRATOR_MAX_WORKERS)
    const overflowId = `c${ORCHESTRATOR_MAX_WORKERS}`
    expect(deps.spawned.map((s) => s.taskId)).not.toContain(overflowId)

    // Kill c0's PTY → a bare crash (no commits / heartbeat): the next pass
    // RECOVERS it — tears its worktree down and requeues its card to 'todo' — and
    // still pulls the overflow into the freed slot (dispatch reads the board
    // snapshot taken BEFORE the recover move, so c0 itself only refills a LATER pass).
    dead.add('c0')
    await runDispatchPass(engine, deps)
    expect(engine.log.some((l) => l.message.startsWith('worker lost — card → todo'))).toBe(true)
    expect(deps.tornDown.some((x) => x.terminalId === 'pty-c0-1')).toBe(true)
    expect(deps.board.get('c0')?.boardColumn).toBe('todo') // requeued, NOT stranded in doing
    expect(deps.spawned.map((s) => s.taskId)).toContain(overflowId)
    expect(engine.workers).toHaveLength(ORCHESTRATOR_MAX_WORKERS)
    expect(engine.workers.some((w) => w.taskId === 'c0')).toBe(false)
  })

  it('tags log lines by structured kind: dispatch + crash are categorized, not bare', async () => {
    // One card → one dispatch: a meaningful 'dispatch' event (always shown, chip-
    // labelled). Then kill its PTY with no commits so the next pass RECOVERS it
    // (worktree torn down, card requeued) — that is a 'crash' (it died without
    // landing anything), surfaced as a warn-level meaningful event NOT buried as
    // routine. The kind tag drives the dashboard filter + per-event chip, so a
    // refactor dropping it would silently de-categorize / re-flood the view.
    const dead = new Set<string>()
    const deps = makeDeps({ cards: [card('a', { boardOrder: 0 })], dead })
    const engine = newEngine()

    await runDispatchPass(engine, deps)
    expect(engine.log.find((l) => l.message.startsWith('dispatch:'))?.kind).toBe('dispatch')

    dead.add('a') // its PTY exits with no commits = a crash → recovered (card → todo)
    await runDispatchPass(engine, deps)
    const crash = engine.log.find((l) => l.message.startsWith('worker lost — card →'))
    expect(crash?.kind).toBe('crash')
    expect(crash?.level).toBe('warn')
  })

  it('tags the card-gone slot-free as routine bookkeeping (no actionable crash to surface)', async () => {
    // A worker whose card was DELETED and whose PTY then exits: there's nothing to
    // re-home, so the worktree is cleaned and the slot freed as ROUTINE bookkeeping
    // (hidden by the "Key" filter) — the abnormal 'crash' kind is reserved for a
    // worker that died on a card STILL in doing (a recovery the owner should see).
    const dead = new Set<string>()
    const deps = makeDeps({ cards: [card('a', { boardOrder: 0 })], dead })
    const engine = newEngine()

    await runDispatchPass(engine, deps)
    deps.board.delete('a') // the human deleted the card
    dead.add('a') // and its PTY exited
    await runDispatchPass(engine, deps)
    expect(engine.log.find((l) => l.message.startsWith('worker lost — slot freed'))?.kind).toBe(
      'routine',
    )
  })

  it('never double-dispatches a counted card even if the board still lists it', async () => {
    // moveToDoing here does NOT change the board (simulate board lag): card 'a'
    // stays in todo, but the worker is counted, so it must not be re-pulled.
    const engine = newEngine()
    const aCard = card('a', { boardOrder: 0 })
    const deps: OrchestratorDeps & { spawned: { taskId: string }[] } = {
      spawned: [],
      fetchTasks: async () => [aCard],
      spawnWorker: async () => {
        deps.spawned.push({ taskId: 'a' })
        return { terminalId: 'pty-a-1', agentSessionId: 's', worktree: '/wt/a', branch: 'swarm/a' }
      },
      moveToDoing: async () => true, // succeeds but leaves the card in todo
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
    }
    await runDispatchPass(engine, deps)
    await runDispatchPass(engine, deps)
    expect(deps.spawned).toHaveLength(1) // counted via engine.workers, not re-pulled
    expect(engine.workers).toHaveLength(1)
  })

  it('does not re-dispatch a card an EXTERNAL dispatcher already claimed to doing (manual+engine twin)', async () => {
    // The manual route (POST /api/swarm/worker) claims its card todo→doing BEFORE
    // spawning, so a manually-dispatched card has a live worker the engine does NOT
    // count in engine.workers. The claimed COLUMN is the cross-dispatcher signal:
    // the engine must never spawn a SECOND worker for a card already in doing, even
    // though it has no worker of its own for it. (The deterministic manual+engine
    // twin — a still-todo manual card the engine keeps re-grabbing — is closed by
    // the route claiming first; here we prove the engine honors that claim.)
    const engine = newEngine()
    const deps = makeDeps({
      cards: [
        card('claimed', { boardColumn: 'doing', boardOrder: 0 }), // a manual worker owns this
        card('free', { boardOrder: 1 }),
      ],
    })
    await runDispatchPass(engine, deps)
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['free']) // only the unclaimed todo
    expect(engine.workers.map((w) => w.taskId)).toEqual(['free'])
    expect(deps.board.get('claimed')?.boardColumn).toBe('doing') // untouched
  })

  // The mirror image of the test above: while the ENGINE is mid-spawn its card is
  // still `todo` on the board AND still absent from engine.workers, so nothing the
  // manual route can read would stop it — except the reservation the pass takes
  // before it spawns. isCardDispatchInFlight is what the route asks (audit 856daefb).
  describe('reserves the card across its own spawn window (pendingDispatch)', () => {
    beforeEach(() => __resetOrchestratorForTests())
    afterEach(() => __resetOrchestratorForTests())

    it('answers in-flight for the WHOLE spawn, then keeps holding via the roster', async () => {
      const engine = newEngine({ path: '/proj' })
      __seedEngineForTests(engine)
      const deps = makeDeps({ cards: [card('a')] })
      const realSpawn = deps.spawnWorker
      const midSpawn: boolean[] = []
      deps.spawnWorker = async (opts) => {
        midSpawn.push(await isCardDispatchInFlight('/proj', 'a'))
        return realSpawn(opts)
      }

      expect(await isCardDispatchInFlight('/proj', 'a')).toBe(false) // nothing yet
      await runDispatchPass(engine, deps)

      expect(midSpawn).toEqual([true]) // a concurrent manual POST would get 409
      expect(engine.pendingDispatch?.size).toBe(0) // reservation released…
      expect(await isCardDispatchInFlight('/proj', 'a')).toBe(true) // …the roster holds it
    })

    it('releases the reservation when the spawn THROWS — no card left permanently taken', async () => {
      const engine = newEngine({ path: '/proj' })
      __seedEngineForTests(engine)
      const deps = makeDeps({ cards: [card('a')], spawnFails: new Set(['a']) })
      await runDispatchPass(engine, deps)

      expect(engine.workers).toHaveLength(0)
      expect(engine.pendingDispatch?.size).toBe(0)
      expect(await isCardDispatchInFlight('/proj', 'a')).toBe(false) // re-dispatchable
    })

    it('still answers in-flight when the todo→doing move was KEPT (board lags the roster)', async () => {
      const engine = newEngine({ path: '/proj' })
      __seedEngineForTests(engine)
      const deps = makeDeps({ cards: [card('a')], moveFails: new Set(['a']) })
      await runDispatchPass(engine, deps)

      expect(deps.board.get('a')?.boardColumn).toBe('todo') // the board never flipped
      expect(await isCardDispatchInFlight('/proj', 'a')).toBe(true) // …but the worker is live
    })

    it('answers false for a project whose engine was never started (creates none)', async () => {
      expect(await isCardDispatchInFlight('/never-started', 'a')).toBe(false)
    })
  })

  it('keeps the worker but logs when the column move fails, then reconciles next pass', async () => {
    const engine = newEngine()
    // The fake's moveFails makes the FIRST todo→doing move for `a` return false;
    // the card therefore stays in todo. Second pass should reconcile (retry) it.
    const deps = makeDeps({ cards: [card('a', { boardOrder: 0 })], moveFails: new Set(['a']) })
    await runDispatchPass(engine, deps)
    expect(engine.workers).toHaveLength(1)
    expect(deps.moves).toHaveLength(0) // first move failed
    expect(engine.log.some((l) => l.message.startsWith('column move kept'))).toBe(true)

    await runDispatchPass(engine, deps)
    expect(deps.spawned).toHaveLength(1) // NOT re-dispatched (still counted)
    expect(deps.moves.map((m) => m.taskId)).toEqual(['a']) // reconciled
    expect(engine.log.some((l) => l.message.startsWith('column move reconciled'))).toBe(true)
  })

  it('logs a dispatch failure and does not count a worker for it', async () => {
    const engine = newEngine()
    const deps = makeDeps({
      cards: [card('a', { boardOrder: 0 }), card('b', { boardOrder: 1 })],
      spawnFails: new Set(['a']),
    })
    await runDispatchPass(engine, deps)
    // 'a' failed → logged error, not counted; 'b' dispatched fine.
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['b'])
    expect(engine.workers.map((w) => w.taskId)).toEqual(['b'])
    expect(engine.log.some((l) => l.level === 'error' && l.message.startsWith('dispatch failed'))).toBe(
      true,
    )
  })

  it('REGRESSION ①: never dispatches a blocked card', async () => {
    const engine = newEngine()
    const deps = makeDeps({
      cards: [
        card('blk', { boardColumn: 'blocked', boardOrder: 0 }),
        card('ok', { boardOrder: 1 }),
      ],
    })
    await runDispatchPass(engine, deps)
    // Only the todo card is dispatched; the blocked card is never spawned.
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['ok'])
    expect(engine.workers.map((w) => w.taskId)).toEqual(['ok'])
    expect(deps.board.get('blk')?.boardColumn).toBe('blocked') // untouched
  })

  it('REGRESSION ④: two todos declaring the same file do not run on two workers at once', async () => {
    const engine = newEngine()
    const deps = makeDeps({
      cards: [
        card('a', { notes: 'files: src/shared.ts', boardOrder: 0 }),
        card('b', { notes: 'files: src/shared.ts', boardOrder: 1 }),
      ],
    })
    // Pass 1: only 'a' dispatches (→ doing). 'b' is held despite open slots.
    await runDispatchPass(engine, deps)
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['a'])
    expect(engine.workers.map((w) => w.taskId)).toEqual(['a'])
    expect(deps.board.get('a')?.boardColumn).toBe('doing')
    expect(deps.board.get('b')?.boardColumn).toBe('todo') // held, still queued

    // Pass 2: 'a' still in flight (doing), so 'b' stays held — no second worker.
    await runDispatchPass(engine, deps)
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['a'])
    expect(engine.workers).toHaveLength(1)

    // 'a' finishes and leaves doing (e.g. promoted/integrated): the shared file is
    // free, so the next pass finally dispatches 'b'. Serialized, never concurrent.
    deps.board.get('a')!.boardColumn = 'done'
    engine.workers = []
    await runDispatchPass(engine, deps)
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['a', 'b'])
    expect(deps.board.get('b')?.boardColumn).toBe('doing')
  })

  it('logs and bails when the board read fails (no spawns)', async () => {
    const engine = newEngine()
    const deps: OrchestratorDeps = {
      fetchTasks: async () => {
        throw new Error('offline')
      },
      moveToDoing: async () => true,
      moveToReview: async () => true,
      countCommitsAhead: async () => 0,
      readHeartbeat: async () => null,
      spawnWorker: async () => {
        throw new Error('should not be called')
      },
      isAlive: () => true,
      recoverCard: async () => true,
      recoverWorker: async () => ({ removed: true }),
      lastOutputAt: () => null,
      nudge: () => true,
      escalate: async () => true,
      recentOutput: () => null,
    }
    await runDispatchPass(engine, deps)
    expect(engine.log.some((l) => l.level === 'warn' && l.message.startsWith('board read failed'))).toBe(
      true,
    )
  })
})

// ── runDispatchPass — quota park (card 0add9d30, churn stop) ──────────────────
// swarmQuota's cooling table is a globalThis singleton (shared across this whole
// test file), so every case resets it — mirroring swarmQuota.test.ts's own
// discipline — to stay order-independent.

/** Persist the owner's model hard mask the way the Settings UI does. The engine
 *  re-reads it from settings.json every pass (isolated test HOME), so the mirror
 *  cannot be short-circuited — which is the point: the mask must survive a
 *  restart, and a test that pokes globalThis would prove nothing about that. */
const setMask = (mask: Partial<Record<'fable' | 'opus' | 'sonnet' | 'haiku', boolean>>) =>
  setSettings({ swarmAllowedModels: mask })
/** Back to "no switch set" — an absent key serializes away, so the next read sees
 *  the every-tier-usable default (leaks between cases would be order-dependent). */
const clearMask = () => setSettings({ swarmAllowedModels: undefined })

describe('runDispatchPass — quota park (card 0add9d30)', () => {
  beforeEach(() => __resetQuotaForTest())
  afterEach(() => __resetQuotaForTest())

  it('① holds ALL new dispatch (zero spawns) while every tier is cooling', async () => {
    const now = 1_000_000
    // Every ladder tier cooling until well past `now`.
    for (const tier of MODEL_TIER_LADDER) markCoolingUntil(tier, now + 5 * 60_000)

    const cards = Array.from({ length: 3 }, (_, i) => card(`c${i}`, { boardOrder: i }))
    const engine = newEngine()
    const deps = makeDeps({ cards })
    await runDispatchPass(engine, deps, now)

    expect(deps.spawned).toHaveLength(0)
    expect(engine.workers).toHaveLength(0)
    // Cards are left untouched in 'todo' — no card mutation on park entry.
    expect(deps.board.get('c0')?.boardColumn).toBe('todo')
    expect(engine.log.some((l) => l.message.startsWith('quota park:') && l.level === 'warn')).toBe(
      true,
    )
    // parkUntil mirrors the earliest reset (all tiers marked with the same until here).
    expect(engine.parkUntil).toBe(now + 5 * 60_000)
  })

  it('② the FIRST tick past the earliest reset auto-re-dispatches (no human action)', async () => {
    const now = 1_000_000
    const until = now + 5 * 60_000
    for (const tier of MODEL_TIER_LADDER) markCoolingUntil(tier, until)

    const cards = Array.from({ length: 2 }, (_, i) => card(`c${i}`, { boardOrder: i }))
    const engine = newEngine()
    const deps = makeDeps({ cards })

    await runDispatchPass(engine, deps, now) // parked, 0 spawns
    expect(deps.spawned).toHaveLength(0)

    await runDispatchPass(engine, deps, until - 1) // still cooling (strictly before until)
    expect(deps.spawned).toHaveLength(0)

    await runDispatchPass(engine, deps, until + 1) // reset has passed — resumes
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['c0', 'c1'])
    expect(engine.parkUntil).toBeUndefined()
    expect(engine.log.some((l) => l.message.startsWith('quota park lifted'))).toBe(true)
  })

  it('③ ANY single tier with headroom skips park entirely (fallback launches instead)', async () => {
    const now = 1_000_000
    // Top tier cooling, but sonnet/haiku still open — allCoolingUntil() is null.
    markCoolingUntil('fable', now + 5 * 60_000)
    markCoolingUntil('opus', now + 5 * 60_000)

    const cards = [card('c0', { boardOrder: 0 })]
    const engine = newEngine()
    const deps = makeDeps({ cards })
    await runDispatchPass(engine, deps, now)

    expect(deps.spawned).toHaveLength(1)
    expect(engine.workers).toHaveLength(1)
    expect(engine.parkUntil).toBeUndefined()
    expect(engine.log.some((l) => l.message.startsWith('quota park:'))).toBe(false)
  })

  it('④ Autonomy OFF (running:false) never parks or dispatches — the top-of-function gate wins', async () => {
    const now = 1_000_000
    for (const tier of MODEL_TIER_LADDER) markCoolingUntil(tier, now + 5 * 60_000)

    const cards = [card('c0', { boardOrder: 0 })]
    const engine = newEngine({ running: false })
    const deps = makeDeps({ cards })
    await runDispatchPass(engine, deps, now)

    expect(deps.spawned).toHaveLength(0)
    expect(engine.parkUntil).toBeUndefined() // never even evaluated — running gate returns first
    expect(engine.log).toHaveLength(0)
  })

  it('⑤ a DISABLED tier is not headroom: fable OFF + the other three cooling ⇒ park', async () => {
    const now = 1_000_000
    for (const tier of ['opus', 'sonnet', 'haiku'] as const) markCoolingUntil(tier, now + 5 * 60_000)
    // Cooling alone would say "fable is free" and dispatch straight into the tier
    // the owner retired. The mask removes it from the ladder entirely.
    await setMask({ fable: false })
    try {
      const engine = newEngine()
      const deps = makeDeps({ cards: [card('c0', { boardOrder: 0 })] })
      await runDispatchPass(engine, deps, now)

      expect(deps.spawned).toHaveLength(0)
      expect(engine.parkUntil).toBe(now + 5 * 60_000) // the earliest ENABLED tier's reset
      expect(engine.log.some((l) => l.message.startsWith('quota park:'))).toBe(true)
    } finally {
      await clearMask()
    }
  })
})

// ── runDispatchPass — the model HARD MASK (Settings.swarmAllowedModels) ───────
// Driven through the REAL persistence path (setSettings → settings.json in the
// isolated test HOME → the globalThis mirror store.getSettings refreshes), so
// these cases also pin the "survives a restart" half of the contract: the engine
// reads the mask fresh every pass rather than trusting a process-lifetime flag.

describe('runDispatchPass — every tier switched OFF (none-allowed hold)', () => {
  beforeEach(() => {
    __resetQuotaForTest()
    __resetAllowedModelsForTest()
  })
  afterEach(async () => {
    __resetQuotaForTest()
    __resetAllowedModelsForTest()
    await clearMask()
  })

  const allOff = () => setMask({ fable: false, opus: false, sonnet: false, haiku: false })

  it('spawns nothing, leaves the cards in todo, and says so WITHOUT promising a reset', async () => {
    const now = 1_000_000
    await allOff()
    const engine = newEngine()
    const deps = makeDeps({ cards: [card('c0', { boardOrder: 0 }), card('c1', { boardOrder: 1 })] })
    await runDispatchPass(engine, deps, now)

    expect(deps.spawned).toHaveLength(0)
    expect(deps.board.get('c0')?.boardColumn).toBe('todo')
    // No deadline: a none-allowed hold has nothing to wait for.
    expect(engine.parkUntil).toBeUndefined()
    const warn = engine.log.find((l) => l.level === 'warn')
    expect(warn?.message).toContain('no model tier is enabled')
    expect(warn?.message).not.toContain('cooling')
  })

  it('ESCALATES to a human — once, on the enter edge, not every tick', async () => {
    const now = 1_000_000
    await allOff()
    const engine = newEngine()
    const deps = makeDeps({ cards: [card('c0', { boardOrder: 0 })] })

    await runDispatchPass(engine, deps, now)
    await runDispatchPass(engine, deps, now + 3_000)
    await runDispatchPass(engine, deps, now + 6_000)

    expect(deps.raised).toHaveLength(1)
    expect(deps.raised[0].projectPath).toBe(engine.path)
    expect(deps.raised[0].whyEscalated).toBe('policy')
    expect(deps.raised[0].question).toContain('switched OFF')
    // 平易文 rides the template raise (non-programmer owner surface): A/B + 影響.
    expect(deps.raised[0].plainQuestion).toContain('すべてオフになっています')
    expect(deps.raised[0].plainQuestion).toContain('A: ')
    expect(deps.raised[0].plainQuestion).toContain('B: ')
    // …and only one warn line, not one per tick.
    expect(engine.log.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  it('a FAILED raise is retried on the next pass (the hold itself is unaffected)', async () => {
    const now = 1_000_000
    await allOff()
    const engine = newEngine()
    const deps = makeDeps({ cards: [card('c0', { boardOrder: 0 })], raiseFails: true })

    await runDispatchPass(engine, deps, now)
    expect(deps.raised).toHaveLength(0)
    expect(engine.spawnBlockSig).toBeUndefined() // forgotten ⇒ next pass re-raises
    expect(deps.spawned).toHaveLength(0)
  })

  it('does NOT lift with time — only re-enabling a tier resumes dispatch', async () => {
    const now = 1_000_000
    await allOff()
    const engine = newEngine()
    const deps = makeDeps({ cards: [card('c0', { boardOrder: 0 })] })

    await runDispatchPass(engine, deps, now)
    await runDispatchPass(engine, deps, now + 365 * 24 * 3_600_000)
    expect(deps.spawned).toHaveLength(0)

    await setMask({ fable: false, opus: true }) // the owner turns opus back on
    await runDispatchPass(engine, deps, now + 365 * 24 * 3_600_000 + 1)
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['c0'])
    expect(engine.log.some((l) => l.message.startsWith('quota park lifted'))).toBe(true)
  })
})

// ── runDispatchPass — quota SENSOR wiring (markRateLimited 本番配線) ────────────
// The park tests above seed the cooling table BY HAND; these prove the table is
// fed by the engine itself: the monitor's rate-limit sighting (mock PTY screens)
// is the production markRateLimited call, attributing the sighting to the tier
// the worker launched on (OrchestratorWorker.model, recorded at dispatch). The
// E2E case walks the whole loop this card set exists for — sighting → cooling →
// park → lazy-expiry auto-resume — with no hand-seeded cooling anywhere.

describe('runDispatchPass — quota sensor wiring (sighting → cooling → park → resume)', () => {
  const T0 = Date.parse('2026-07-08T00:00:00Z')
  const startedAt = new Date(T0).toISOString()
  beforeEach(() => {
    __resetQuotaForTest()
    a5Mock.current = null
  })
  afterEach(() => {
    __resetQuotaForTest()
    a5Mock.current = null
  })

  it('dispatch records the spawn-resolved model on the worker (the attribution the sensor reads)', async () => {
    const engine = newEngine()
    const deps = makeDeps({ cards: [card('a')], spawnModel: 'sonnet' })
    await runDispatchPass(engine, deps, T0)
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['a'])
    expect(engine.workers[0]?.model).toBe('sonnet')
  })

  it('a sighting on a tier-recorded worker marks THAT tier cooling until the PTY-worded reset', async () => {
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, model: 'fable' }),
      ],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached — resets in 30 minutes']]),
    })
    const t1 = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, t1)
    // The production write landed: fable cools until the PTY-worded reset (t1+30min),
    // not the flat grace — extractPtyResetUntil got the actual screen text.
    expect(isTierCooling('fable', t1 + 29 * 60_000)).toBe(true)
    expect(isTierCooling('fable', t1 + 30 * 60_000 + 1)).toBe(false)
    // Only the sighted worker's launch tier — nothing else is guessed at.
    expect(isTierCooling('opus', t1 + 1)).toBe(false)
    expect(isTierCooling('sonnet', t1 + 1)).toBe(false)
    // The hold log names the attribution so the journal shows WHY dispatch will shift.
    expect(engine.log.some((l) => l.message.includes('tier fable cooling until'))).toBe(true)
  })

  // The 2026-07-09 incident, end to end on the production seam. The screen is the
  // CLI's verbatim per-model notice; the assertion chain is exactly the causal
  // chain that was broken: classify → markRateLimited(fable) → the tier dispatch
  // ACTUALLY launches on (resolveSwarmModelEffort — what spawnSwarmWorker calls)
  // steps down to opus. Before the fix the notice classified 'normal', the worker
  // was Enter-nudged into silence, and every later launch stayed on fable.
  it('REGRESSION (2026-07-09): the real Fable-limit notice cools fable and the next launch resolves to opus', async () => {
    const FABLE_LIMIT_NOTICE =
      "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, model: 'fable' }),
      ],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', FABLE_LIMIT_NOTICE]]),
    })
    const t1 = T0 + STALL_SILENCE_MS + 1

    // Baseline: nothing cooling ⇒ a top-tier slot launches on fable.
    expect(resolveSwarmModelEffort('max', 'worker', undefined, t1)!.model).toBe('fable')

    await runDispatchPass(engine, deps, t1)

    // The notice was seen, attributed to the worker's launch tier, and cooled it.
    expect(isTierCooling('fable', t1 + 1)).toBe(true)
    // No reset wording in the notice ⇒ the flat grace window.
    expect(isTierCooling('fable', t1 + RATE_LIMIT_GRACE_MS - 1)).toBe(true)
    expect(isTierCooling('fable', t1 + RATE_LIMIT_GRACE_MS + 1)).toBe(false)
    // Done ①: the NEXT dispatch (worker or adversarial reviewer) launches on opus.
    expect(resolveSwarmModelEffort('max', 'worker', undefined, t1 + 1)!.model).toBe('opus')
    // …while the limited worker is HELD, not Enter-nudged (Enter can't lift a limit,
    // which is why the real one sat silent for 22 minutes) and not reclaimed.
    expect(deps.nudged).toEqual([])
    expect(deps.recovered).toEqual([])
    expect(engine.workers.map((w) => w.terminalId)).toEqual(['pty-a-1'])
  })

  it('a sighting with NO reset wording on screen falls back to RATE_LIMIT_GRACE_MS cooling', async () => {
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, model: 'opus' }),
      ],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached']]), // bare — no "resets…" phrase
    })
    const t1 = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, t1)
    // No PTY wording and no A5 cache in this process ⇒ resolveCoolingUntil's grace floor.
    expect(isTierCooling('opus', t1 + RATE_LIMIT_GRACE_MS - 1)).toBe(true)
    expect(isTierCooling('opus', t1 + RATE_LIMIT_GRACE_MS + 1)).toBe(false)
  })

  it('MF-2: a transient blip with a NOT-exhausted A5 cache cools only the grace window (pct gate)', async () => {
    // A5 is a standing display — resetsAt exists even at 42% usage. A transient
    // 529 blip must NOT inherit the session window's reset (up to ~5h away).
    a5Mock.current = {
      session: { pct: 42, resetsAt: 'in 4 hours' },
      weekAll: { pct: 10, resetsAt: 'in 6 days' },
      capturedAt: new Date(T0).toISOString(),
      status: 'ok',
    }
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, model: 'opus' }),
      ],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'API Error: 529 Overloaded']]), // transient — no reset wording
    })
    const t1 = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, t1)
    // Neither slot is spent (pct<100) ⇒ the A5 resetsAt is IGNORED — grace floor only.
    expect(isTierCooling('opus', t1 + RATE_LIMIT_GRACE_MS - 1)).toBe(true)
    expect(isTierCooling('opus', t1 + RATE_LIMIT_GRACE_MS + 1)).toBe(false)
  })

  it('MF-2: a SPENT session slot (pct>=100) IS trusted as the cooling horizon', async () => {
    a5Mock.current = {
      session: { pct: 100, resetsAt: 'in 45 minutes' },
      weekAll: { pct: 30, resetsAt: 'in 6 days' },
      capturedAt: new Date(T0).toISOString(),
      status: 'ok',
    }
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, model: 'opus' }),
      ],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached']]), // no PTY reset wording → A5 is next
    })
    const t1 = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, t1)
    // Session genuinely spent ⇒ its reset (45min, past the 20min grace) is the horizon.
    expect(isTierCooling('opus', t1 + 44 * 60_000)).toBe(true)
    expect(isTierCooling('opus', t1 + 45 * 60_000 + 1)).toBe(false)
  })

  it('MF-2: weekly slot spent while the session is healthy → the WEEKLY reset is the horizon', async () => {
    a5Mock.current = {
      session: { pct: 42, resetsAt: 'in 3 hours' }, // healthy — its reset must NOT be used
      weekAll: { pct: 100, resetsAt: 'in 40 hours' },
      capturedAt: new Date(T0).toISOString(),
      status: 'ok',
    }
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, model: 'fable' }),
      ],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached']]),
    })
    const t1 = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, t1)
    expect(isTierCooling('fable', t1 + 39 * 3_600_000)).toBe(true)
    expect(isTierCooling('fable', t1 + 40 * 3_600_000 + 1)).toBe(false)
  })

  it('a sighting on a worker with NO recorded model holds it but marks NOTHING (never cool by guess)', async () => {
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt }),
      ],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached']]),
    })
    const t1 = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, t1)
    expect(engine.rateLimited.has('pty-a-1')).toBe(true) // held exactly as before
    for (const tier of MODEL_TIER_LADDER) expect(isTierCooling(tier, t1 + 1)).toBe(false)
    expect(engine.log.some((l) => l.message.includes('cooling until'))).toBe(false)
  })

  it('E2E: sightings across every tier → park (zero spawns) → auto-resume once the reset passes', async () => {
    const ids = ['a', 'b', 'c', 'd']
    const engine = newEngine({
      workers: MODEL_TIER_LADDER.map((tier, i) =>
        worker({
          terminalId: `pty-${tier}-1`,
          branch: `swarm/${ids[i]}`,
          worktree: `/wt/${ids[i]}`,
          taskId: ids[i],
          taskTitle: `task ${ids[i]}`,
          startedAt,
          model: tier,
        }),
      ),
    })
    const deps = makeDeps({
      cards: [
        ...ids.map((id) => card(id, { boardColumn: 'doing' })),
        card('e', { boardOrder: 99 }), // a waiting todo — the park's observable subject
      ],
      screens: new Map(
        MODEL_TIER_LADDER.map((tier) => [`pty-${tier}-1`, 'Claude usage limit reached · resets in 30 minutes']),
      ),
    })

    // Pass 1: four sightings land (each marks its own launch tier — nothing seeded
    // by hand), and the SAME pass's dispatch step parks: todo 'e' is not spawned.
    const t1 = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, t1)
    for (const tier of MODEL_TIER_LADDER) expect(isTierCooling(tier, t1 + 1)).toBe(true)
    expect(deps.spawned).toHaveLength(0)
    expect(engine.parkUntil).toBe(t1 + 30 * 60_000) // earliest reset = the shared PTY-worded one
    expect(engine.log.some((l) => l.message.startsWith('quota park:') && l.level === 'warn')).toBe(true)

    // Pass 2, first tick past the PTY-worded reset: lazy expiry frees every tier —
    // the park lifts and dispatch resumes on its own (no human action, no cleanup
    // step). The four held workers are also past RATE_LIMIT_GRACE_MS by now, so
    // the same pass requeues them (slot recovery) — but 'e' was the snapshot's only
    // todo, so the resumed dispatch spawns exactly it.
    const t2 = t1 + 30 * 60_000 + 1000
    await runDispatchPass(engine, deps, t2)
    expect(engine.parkUntil).toBeUndefined()
    expect(engine.log.some((l) => l.message.startsWith('quota park lifted'))).toBe(true)
    expect(deps.spawned.map((s) => s.taskId)).toEqual(['e'])
  })
})

// ── runDispatchPass — dynamic worker scaling (card ea369937) ──────────────────

describe('runDispatchPass — dynamic worker scaling (card ea369937)', () => {
  const scaleLines = (engine: ProjectEngine) =>
    engine.log.filter((l) => l.message.startsWith('scale:'))

  it('少: a shallow independent backlog scales to its size (near MIN), well below MAX, and logs it', async () => {
    const engine = newEngine()
    const deps = makeDeps({ cards: [card('a', { boardOrder: 0 }), card('b', { boardOrder: 1 })] })
    await runDispatchPass(engine, deps)
    // Two independent todos ⇒ exactly two workers, not the MAX(6) cap.
    expect(deps.spawned).toHaveLength(2)
    expect(deps.spawned.length).toBeLessThan(ORCHESTRATOR_MAX_WORKERS)
    // The scale DECISION is in the journal (条件4), naming the computed target.
    expect(scaleLines(engine)).toHaveLength(1)
    expect(scaleLines(engine)[0].message).toContain('target 2 worker')
  })

  it('多 + 上限頭打ち: a deep backlog scales to — and never past — MAX, logging the decision', async () => {
    const cards = Array.from({ length: ORCHESTRATOR_MAX_WORKERS + 3 }, (_, i) =>
      card(`c${i}`, { boardOrder: i }),
    )
    const engine = newEngine()
    const deps = makeDeps({ cards })
    await runDispatchPass(engine, deps)
    // MAX+3 independent todos, yet the engine pins at MAX (暴走防止 — never exceeds).
    expect(deps.spawned).toHaveLength(ORCHESTRATOR_MAX_WORKERS)
    expect(engine.workers.filter((w) => deps.isAlive(w.terminalId))).toHaveLength(
      ORCHESTRATOR_MAX_WORKERS,
    )
    expect(scaleLines(engine)).toHaveLength(1)
    expect(scaleLines(engine)[0].message).toContain(`target ${ORCHESTRATOR_MAX_WORKERS} worker`)
  })

  it('logs the scale decision once per CHANGE (not every tick) and holds steady — no extra spawn — when unchanged', async () => {
    const engine = newEngine()
    const deps = makeDeps({ cards: [card('a', { boardOrder: 0 }), card('b', { boardOrder: 1 })] })
    await runDispatchPass(engine, deps) // target 2 → spawn 2, cards → doing
    await runDispatchPass(engine, deps) // live 2 + 0 dispatchable ⇒ target still 2 ⇒ no new line, no spawn
    expect(deps.spawned).toHaveLength(2)
    expect(scaleLines(engine)).toHaveLength(1) // de-duped: only the transition was logged
  })

  it('scales UP and logs a FRESH decision when the independent backlog grows', async () => {
    const engine = newEngine()
    const deps = makeDeps({ cards: [card('a', { boardOrder: 0 })] })
    await runDispatchPass(engine, deps) // 1 todo → target 1, spawn 1
    expect(deps.spawned).toHaveLength(1)
    // The queue deepens: MAX more independent todos arrive.
    for (let i = 0; i < ORCHESTRATOR_MAX_WORKERS; i++) {
      deps.board.set(`n${i}`, card(`n${i}`, { boardOrder: 10 + i }))
    }
    await runDispatchPass(engine, deps)
    // Now riding the cap, with a SECOND, distinct scale line recording the climb.
    expect(engine.workers.filter((w) => deps.isAlive(w.terminalId))).toHaveLength(
      ORCHESTRATOR_MAX_WORKERS,
    )
    const lines = scaleLines(engine)
    expect(lines).toHaveLength(2)
    expect(lines[0].message).toContain('target 1 worker')
    expect(lines[1].message).toContain(`target ${ORCHESTRATOR_MAX_WORKERS} worker`)
  })
})

// ── runDispatchPass — monitor + promote doing→review (Card②) ───────────────────

describe('runDispatchPass — monitor: promote doing→review', () => {
  it('promotes a worker whose branch has commits and heartbeat is ready, recording the branch', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 2]]),
      heartbeats: new Map([['a', { ready: true, blocked: false }]]),
    })
    await runDispatchPass(engine, deps)

    // Card moved doing→review with its branch recorded (the integration handle).
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(deps.board.get('a')?.boardColumn).toBe('review')
    expect(deps.board.get('a')?.branch).toBe('swarm/a')
    expect(engine.log.some((l) => l.message.startsWith('promoted to review'))).toBe(true)
    // The PTY lingers → the worker stays counted as 'done' until it exits.
    expect(engine.workers).toHaveLength(1)
    expect(engine.workers[0].stage).toBe('done')
  })

  it('does NOT promote a still-working worker (commits but no completion sign)', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a', startedAt: new Date().toISOString() })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 3]]), // WIP commits, but no ready heartbeat
    })
    await runDispatchPass(engine, deps)
    expect(deps.reviews).toHaveLength(0)
    expect(deps.board.get('a')?.boardColumn).toBe('doing')
    expect(engine.workers[0].stage).toBe('running')
  })

  it('does NOT promote a ready heartbeat with no commits (nothing integrable)', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 0]]),
      heartbeats: new Map([['a', { ready: true, blocked: false }]]),
    })
    await runDispatchPass(engine, deps)
    expect(deps.reviews).toHaveLength(0)
    expect(deps.board.get('a')?.boardColumn).toBe('doing')
  })

  it('promotes a worker whose PTY exited with commits (no blocker), then drops it', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      dead: new Set(['a']),
      commits: new Map([['a', 1]]),
    })
    await runDispatchPass(engine, deps)
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(deps.board.get('a')?.boardColumn).toBe('review')
    // Dead + promoted → nothing left to count (slot already free).
    expect(engine.workers).toHaveLength(0)
    expect(engine.log.some((l) => l.message.startsWith('promoted to review'))).toBe(true)
  })

  it('does NOT promote a dead worker that reported a blocker — recovers it to blocked', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      dead: new Set(['a']),
      commits: new Map([['a', 1]]),
      heartbeats: new Map([['a', { ready: false, blocked: true }]]),
    })
    await runDispatchPass(engine, deps)
    expect(deps.reviews).toHaveLength(0) // a blocker blocks promotion even with commits
    // Recovered, not stranded: the worktree is torn down and the card parks in
    // 'blocked' (a reported blocker needs a human — never auto-retried).
    expect(deps.board.get('a')?.boardColumn).toBe('blocked')
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    expect(deps.tornDown.some((x) => x.terminalId === 'pty-a-1')).toBe(true)
    expect(engine.workers).toHaveLength(0) // dead → slot freed
    // The recovery is surfaced as a 'crash' kind (warn) so the owner sees the
    // fallen-over worker + where its card went — not buried as routine.
    const crash = engine.log.find((l) => l.message.startsWith('worker lost — card → blocked'))
    expect(crash?.kind).toBe('crash')
    expect(crash?.level).toBe('warn')
  })

  it('retries the review move on a board-write hiccup, keeping the worker', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 1]]),
      heartbeats: new Map([['a', { ready: true, blocked: false }]]),
      reviewFails: new Set(['a']), // the FIRST review move fails
    })
    await runDispatchPass(engine, deps)
    expect(deps.reviews).toHaveLength(0) // first attempt failed
    expect(deps.board.get('a')?.boardColumn).toBe('doing')
    expect(engine.workers[0].stage).toBe('running') // not claimed done yet
    expect(engine.log.some((l) => l.message.startsWith('review move kept'))).toBe(true)

    await runDispatchPass(engine, deps)
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }]) // reconciled
    expect(deps.board.get('a')?.boardColumn).toBe('review')
  })

  it('keeps a done worker occupying its slot until its PTY exits, then frees it', async () => {
    const dead = new Set<string>()
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      dead,
      commits: new Map([['a', 1]]),
      heartbeats: new Map([['a', { ready: true, blocked: false }]]),
    })
    await runDispatchPass(engine, deps)
    expect(engine.workers).toHaveLength(1)
    expect(engine.workers[0].stage).toBe('done') // promoted, PTY lingers

    // A second pass with the PTY still alive keeps it 'done' (idempotent — the
    // card is already in review, so no second review move).
    await runDispatchPass(engine, deps)
    expect(deps.reviews).toHaveLength(1)
    expect(engine.workers).toHaveLength(1)

    // Closing the PTY frees the slot.
    dead.add('a')
    await runDispatchPass(engine, deps)
    expect(engine.workers).toHaveLength(0)
    expect(engine.log.some((l) => l.message.startsWith('done worker closed — slot freed'))).toBe(true)
  })

  it('does not fight a human who pulled the card back to todo (no promote)', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a' })],
    })
    // The card is back in 'todo' though commits + a ready heartbeat exist.
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'todo' })],
      commits: new Map([['a', 2]]),
      heartbeats: new Map([['a', { ready: true, blocked: false }]]),
    })
    await runDispatchPass(engine, deps)
    expect(deps.reviews).toHaveLength(0) // not in 'doing' → not promoted
    // Reconcile re-homes the still-counted todo card to doing instead.
    expect(deps.moves.map((m) => m.taskId)).toEqual(['a'])
  })

  it('promotes one worker while leaving a still-working sibling in doing', async () => {
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a' }),
        worker({ terminalId: 'pty-b-1', branch: 'swarm/b', taskId: 'b', taskTitle: 'task b', startedAt: new Date().toISOString() }),
      ],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' }), card('b', { boardColumn: 'doing' })],
      commits: new Map([['a', 1], ['b', 1]]),
      heartbeats: new Map([['a', { ready: true, blocked: false }]]), // only a is ready
    })
    await runDispatchPass(engine, deps)
    expect(deps.reviews.map((r) => r.taskId)).toEqual(['a'])
    expect(deps.board.get('a')?.boardColumn).toBe('review')
    expect(deps.board.get('b')?.boardColumn).toBe('doing')
    expect(engine.workers.find((w) => w.taskId === 'b')?.stage).toBe('running')
  })
})

// ── runDispatchPass — monitor: crash recovery (Card① — no zombies) ─────────────

describe('runDispatchPass — monitor: crash recovery', () => {
  it('a bare crash (dead, no commits/heartbeat) requeues its card to todo + tears the worktree down', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      dead: new Set(['a']), // its PTY died with nothing committed
    })
    await runDispatchPass(engine, deps)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'todo' }])
    expect(deps.board.get('a')?.boardColumn).toBe('todo') // back in the queue, not stranded in doing
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }]) // worktree + PTY cleaned
    expect(engine.workers).toHaveLength(0) // slot freed
    expect(engine.recoveries.get('a')).toBe(1) // one re-queue spent
    expect(engine.log.some((l) => l.message.startsWith('worker lost — card → todo'))).toBe(true)
  })

  it('escalates to blocked once the retry budget is spent (a card that reliably kills its worker)', async () => {
    const engine = newEngine({
      recoveries: new Map([['a', RECOVER_MAX_REQUEUE]]), // budget already exhausted
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], dead: new Set(['a']) })
    await runDispatchPass(engine, deps)
    expect(deps.board.get('a')?.boardColumn).toBe('blocked')
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    expect(engine.recoveries.has('a')).toBe(false) // reset on park — a human requeue starts fresh
  })

  it('cleans an orphaned worktree when the card was deleted, without a column move', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({ cards: [], dead: new Set(['a']) }) // no card 'a' on the board
    await runDispatchPass(engine, deps)
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    expect(deps.recovered).toHaveLength(0) // nothing to re-home
    expect(engine.workers).toHaveLength(0)
  })

  it('cleans the worktree but leaves the column when a human already pulled the card out of doing', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    // The human moved it to blocked themselves; then the worker died.
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'blocked' })], dead: new Set(['a']) })
    await runDispatchPass(engine, deps)
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    expect(deps.recovered).toHaveLength(0) // don't fight the human's column
    expect(deps.board.get('a')?.boardColumn).toBe('blocked')
    expect(engine.workers).toHaveLength(0)
  })

  it('keeps the dead worker and retries when the recover board-write is kept', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      dead: new Set(['a']),
      recoverFails: new Set(['a']), // the FIRST recover move fails
    })
    await runDispatchPass(engine, deps)
    expect(deps.board.get('a')?.boardColumn).toBe('doing') // move kept → still in doing
    expect(engine.workers).toHaveLength(1) // dead worker KEPT to retry (holds no live slot)
    expect(engine.log.some((l) => l.message.startsWith('worker lost but card move kept'))).toBe(true)

    // Next pass: the move lands → card requeued, worker dropped (no stuck card).
    await runDispatchPass(engine, deps)
    expect(deps.board.get('a')?.boardColumn).toBe('todo')
    expect(engine.workers).toHaveLength(0)
  })

  it('a worker that DECLARED done but committed nothing parks in blocked, not retried', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      dead: new Set(['a']),
      commits: new Map([['a', 0]]),
      heartbeats: new Map([['a', { ready: true, blocked: false }]]), // ready, but nothing to merge
    })
    await runDispatchPass(engine, deps)
    expect(deps.reviews).toHaveLength(0) // 0 commits → never promoted
    expect(deps.board.get('a')?.boardColumn).toBe('blocked')
  })
})

// ── runDispatchPass — monitor: stall self-healing (alive but unresponsive) ──────
// Card e8022e: a worker whose PTY is ALIVE but has gone SILENT (no heartbeat AND no
// PTY output) is hung, not working — the crash path never trips. The monitor nudges
// it (Enter) and, if it stays silent past the budget, reclaims it like a crash
// (teardown + re-home). `now` is injected so the time-gated escalation is
// deterministic; the fake reports silence by leaving outputs+heartbeats empty.
describe('runDispatchPass — monitor: stall self-healing', () => {
  const T0 = Date.parse('2026-06-25T00:00:00Z')
  const startedAt = new Date(T0).toISOString()

  it('NUDGES a silent-but-alive worker (Enter), keeping it counted + its card in doing', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt })],
    })
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })] }) // no output, no heartbeat → silent
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(deps.nudged).toEqual(['pty-a-1']) // Enter sent to un-stick it
    expect(deps.tornDown).toHaveLength(0) // NOT reclaimed yet — give the nudge a chance
    expect(deps.board.get('a')?.boardColumn).toBe('doing') // still draining
    expect(engine.workers).toHaveLength(1)
    expect(engine.nudges.get('pty-a-1')?.count).toBe(1)
    const stall = engine.log.find((l) => l.message.startsWith('worker stalled'))
    expect(stall?.kind).toBe('stall')
    expect(stall?.level).toBe('warn')
  })

  it('escalates nudge→nudge→ESC+continue→RECLAIM, tearing down the worktree + re-homing the card (no zombie)', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt })],
    })
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })] })

    // Pass 1 — first detection → nudge #1.
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(deps.nudged).toHaveLength(1)
    // Pass 2 — cooldown elapsed, still silent → nudge #2.
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + STALL_NUDGE_COOLDOWN_MS + 2)
    expect(deps.nudged).toHaveLength(2)
    expect(deps.tornDown).toHaveLength(0) // still only nudging
    // Pass 3 — nudge budget spent, cooldown elapsed, still silent → ESCALATE (ESC+continue),
    // tried exactly once — NOT a reclaim yet.
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 2 * STALL_NUDGE_COOLDOWN_MS + 3)
    expect(deps.escalated).toEqual([{ terminalId: 'pty-a-1', taskTitle: 'task a' }])
    expect(deps.tornDown).toHaveLength(0) // the ESC+continue escalation gets its own chance first
    expect(engine.nudges.get('pty-a-1')?.escalated).toBe(true)
    const escalate = engine.log.find((l) => l.message.includes('escalating (ESC+continue)'))
    expect(escalate?.kind).toBe('stall')
    expect(escalate?.level).toBe('warn')
    // Pass 4 — cooldown elapsed since the escalation, STILL silent → RECLAIM.
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 3 * STALL_NUDGE_COOLDOWN_MS + 4)
    expect(deps.escalated).toHaveLength(1) // escalation is one-shot — never retried

    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }]) // worktree + PTY torn down
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'todo' }]) // card back on the board (one retry)
    expect(deps.board.get('a')?.boardColumn).toBe('todo')
    expect(engine.workers).toHaveLength(0) // slot freed (re-dispatch waits for the next fetch)
    expect(engine.nudges.has('pty-a-1')).toBe(false) // bookkeeping cleared
    const reclaim = engine.log.find((l) => l.message.startsWith('worker stalled — reclaimed — card → todo'))
    expect(reclaim?.kind).toBe('stall')
    expect(reclaim?.level).toBe('warn')
  })

  it('clears the nudge/escalate budget when the ESC+continue escalation revives the worker', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a', startedAt })],
    })
    const heartbeats = new Map<string, HeartbeatSign>()
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], heartbeats })

    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1) // nudge #1
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + STALL_NUDGE_COOLDOWN_MS + 2) // nudge #2
    const escalateAt = T0 + STALL_SILENCE_MS + 2 * STALL_NUDGE_COOLDOWN_MS + 3
    await runDispatchPass(engine, deps, escalateAt) // budget spent → ESCALATE
    expect(deps.escalated).toHaveLength(1)
    expect(engine.nudges.get('pty-a-1')?.escalated).toBe(true)

    // The worker wakes: a heartbeat lands AFTER the escalation (an echo never could).
    heartbeats.set('a', { ready: false, blocked: false, at: new Date(escalateAt + 5000).toISOString() })
    await runDispatchPass(engine, deps, escalateAt + STALL_NUDGE_COOLDOWN_MS + 1)

    expect(engine.nudges.has('pty-a-1')).toBe(false) // budget (nudge + escalate) cleared — it recovered
    expect(deps.tornDown).toHaveLength(0) // never reclaimed
    expect(deps.escalated).toHaveLength(1) // escalation was not retried
    expect(engine.workers).toHaveLength(1)
    expect(engine.log.some((l) => l.message.startsWith('worker recovered after nudge'))).toBe(true)
  })

  it('does NOT touch a worker still streaming PTY output (alive between heartbeats)', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a', startedAt })],
    })
    const now = T0 + STALL_SILENCE_MS + 1
    // Heartbeat ancient, but the PTY emitted output 1s before `now` → working.
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], outputs: new Map([['pty-a-1', now - 1000]]) })
    await runDispatchPass(engine, deps, now)
    expect(deps.nudged).toHaveLength(0)
    expect(deps.tornDown).toHaveLength(0)
    expect(engine.workers[0].stage).toBe('running')
  })

  // ── THIRD LIVENESS CHANNEL at the monitor — the worker analog of 7517e4b1 ────────
  // The confirmed root cause (2026-07-23): a worker deep in a Task() sub-agent (its own
  // adversarial self-review) freezes BOTH cheap channels — heartbeat beats only at phase
  // boundaries, and the PTY frame is frozen on the sub-agent — while its sub-agent
  // transcript grows in real time. The pre-fix engine read only those two channels, so it
  // NUDGED (ESC = interrupt the running review) then RECLAIMED (worktree teardown +
  // re-home to blocked → the observed twin dispatch). These two tests are the behavioral
  // TEETH: fresh file ⇒ spared; mutate the file to stale ⇒ the old nudge fires again.
  it('SPARES a silent-but-alive worker running a Task() sub-agent (fresh transcript/sub-agent mtime)', async () => {
    const now = T0 + STALL_SILENCE_MS + 1
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, sessionId: 'sess-a' })],
    })
    // No heartbeat, no PTY output → cheap-silent — but its sub-agent file grew 1s ago.
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], agentActivity: new Map([['/wt/a', now - 1000]]) })
    await runDispatchPass(engine, deps, now)
    expect(deps.nudged).toHaveLength(0) // NOT nudged — ESC would interrupt the live review
    expect(deps.tornDown).toHaveLength(0) // NOT reclaimed — no worktree loss, no twin
    expect(deps.board.get('a')?.boardColumn).toBe('doing') // card still draining
    expect(engine.workers).toHaveLength(1)
    expect(engine.nudges.has('pty-a-1')).toBe(false) // no stall bookkeeping opened
  })
  it('MUTATION control: the same silent worker with a STALE sub-agent mtime IS nudged (the signal is load-bearing)', async () => {
    const now = T0 + STALL_SILENCE_MS + 1
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, sessionId: 'sess-a' })],
    })
    // File mtime is as old as dispatch (no sub-agent running / worker died) → no rescue.
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], agentActivity: new Map([['/wt/a', T0]]) })
    await runDispatchPass(engine, deps, now)
    expect(deps.nudged).toEqual(['pty-a-1']) // stale file ⇒ ordinary stall ⇒ nudged
    expect(engine.nudges.get('pty-a-1')?.count).toBe(1)
  })

  it('clears the nudge budget when a nudge revives the worker (a post-nudge heartbeat)', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a', startedAt })],
    })
    const heartbeats = new Map<string, HeartbeatSign>()
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], heartbeats })

    const nudgeAt = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, nudgeAt) // silent → nudge #1
    expect(engine.nudges.get('pty-a-1')?.count).toBe(1)

    // The worker wakes: it writes a heartbeat AFTER the nudge (an echo never could).
    heartbeats.set('a', { ready: false, blocked: false, at: new Date(nudgeAt + 5000).toISOString() })
    await runDispatchPass(engine, deps, nudgeAt + STALL_NUDGE_COOLDOWN_MS + 1)

    expect(engine.nudges.has('pty-a-1')).toBe(false) // budget cleared — it recovered
    expect(deps.tornDown).toHaveLength(0) // never reclaimed
    expect(engine.workers).toHaveLength(1)
    expect(engine.log.some((l) => l.message.startsWith('worker recovered after nudge'))).toBe(true)
  })

  it('clears the budget when a nudge revives the worker via OUTPUT (no heartbeat) — next stall nudges afresh', async () => {
    // The bug this guards: heartbeats are SPARSE, so a nudge that genuinely revives
    // a worker often shows up as streaming OUTPUT with no beat for many minutes. If
    // output-recovery did not clear the budget, the worker's NEXT independent stall
    // would reclaim with ZERO nudges (skipping the cheap Enter the design promises).
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt })],
    })
    const outputs = new Map<string, number>()
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], outputs })

    // Pass 1 & 2 — silent → nudge #1, #2 (budget now spent).
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    const n2 = T0 + STALL_SILENCE_MS + STALL_NUDGE_COOLDOWN_MS + 2
    await runDispatchPass(engine, deps, n2)
    expect(deps.nudged).toHaveLength(2)

    // The nudge WORKED: the worker streams output past the echo guard (no heartbeat).
    outputs.set('pty-a-1', n2 + STALL_ECHO_GUARD_MS + 1000)
    await runDispatchPass(engine, deps, n2 + STALL_ECHO_GUARD_MS + 2000)
    expect(engine.nudges.has('pty-a-1')).toBe(false) // real output recovery → budget cleared
    expect(deps.tornDown).toHaveLength(0)

    // It goes silent AGAIN (output frozen). The fresh stall must NUDGE, not reclaim.
    const frozen = n2 + STALL_ECHO_GUARD_MS + 1000
    await runDispatchPass(engine, deps, frozen + STALL_SILENCE_MS + 1)
    expect(deps.nudged).toHaveLength(3) // cheap nudge first — NOT a zero-nudge reclaim
    expect(deps.tornDown).toHaveLength(0)
  })

  it('parks a stalled worker in blocked once the retry budget is spent (no endless re-stall loop)', async () => {
    const engine = newEngine({
      recoveries: new Map([['a', RECOVER_MAX_REQUEUE]]), // budget already exhausted by a prior crash/stall
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt })],
    })
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })] })
    // Drive straight to reclaim (two nudges + the one-shot ESC+continue escalation
    // + cooldown, then spent).
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + STALL_NUDGE_COOLDOWN_MS + 2)
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 2 * STALL_NUDGE_COOLDOWN_MS + 3)
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 3 * STALL_NUDGE_COOLDOWN_MS + 4)
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }]) // escalated to a human, not requeued
    expect(deps.board.get('a')?.boardColumn).toBe('blocked')
  })
})

// ── runDispatchPass — monitor: 進まない classification (Card 4880e9c6) ───────────
// Distinguish a rate-limit WAIT and a startup permission prompt from a real stall
// (so neither is falsely killed), and stop a RUNAWAY that overruns the execution
// ceiling. The overriding requirement is 誤killを避ける — a waiting worker is HELD.

describe('runDispatchPass — monitor: rate-limit wait (no false kill)', () => {
  const T0 = Date.parse('2026-06-25T00:00:00Z')
  const startedAt = new Date(T0).toISOString()
  const w1 = () =>
    worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt })

  it('HOLDS a rate-limited worker — never nudged, never reclaimed — even PAST the stall clock', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached · resets 3pm']]),
      // No output, no heartbeat → a NORMAL worker would be nudged at this time.
    })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(deps.nudged).toHaveLength(0) // Enter can't lift a limit — never sent
    expect(deps.tornDown).toHaveLength(0) // the work is preserved; never reclaimed
    expect(deps.recovered).toHaveLength(0)
    expect(engine.workers).toHaveLength(1) // still counted (holding)
    expect(engine.nudges.has('pty-a-1')).toBe(false) // no stall budget accrues
    expect(engine.rateLimited.has('pty-a-1')).toBe(true)
    const hold = engine.log.find((l) => l.message.startsWith('worker rate/usage-limited — holding'))
    expect(hold?.level).toBe('warn')
  })

  it('requeues to TODO only after RATE_LIMIT_GRACE_MS still limited (slot recovery; work kept)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'API Error: 529 Overloaded — retrying in 30s']]),
    })
    const since = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, since) // first sight — stamp + hold
    expect(deps.recovered).toHaveLength(0)
    expect(engine.rateLimited.get('pty-a-1')?.since).toBe(since)

    await runDispatchPass(engine, deps, since + RATE_LIMIT_GRACE_MS + 1) // grace spent
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'todo' }]) // retried later, NOT blocked
    expect(deps.board.get('a')?.boardColumn).toBe('todo')
    expect(engine.workers).toHaveLength(0)
    expect(engine.rateLimited.has('pty-a-1')).toBe(false)
    expect(deps.nudged).toHaveLength(0) // still never nudged
  })

  it('does NOT burn the crash/stall retry budget on a rate-limit requeue (orthogonal)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached']]),
    })
    const since = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, since)
    await runDispatchPass(engine, deps, since + RATE_LIMIT_GRACE_MS + 1)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'todo' }])
    // The recovery counter is untouched — a later REAL crash still gets its retries.
    expect(engine.recoveries.has('a')).toBe(false)
  })

  it('clears the rate-limit hold the moment the worker RESUMES (screen normal again)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const screens = new Map([['pty-a-1', 'Claude usage limit reached']])
    const outputs = new Map<string, number>()
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], screens, outputs })
    const t1 = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, t1)
    expect(engine.rateLimited.has('pty-a-1')).toBe(true)

    // The limit lifts: ordinary work resumes and the PTY streams output again.
    screens.set('pty-a-1', 'Resumed — editing src/app.tsx, running tests')
    outputs.set('pty-a-1', t1 + 30_000)
    await runDispatchPass(engine, deps, t1 + 60_000)
    expect(engine.rateLimited.has('pty-a-1')).toBe(false) // tracking cleared
    expect(deps.tornDown).toHaveLength(0) // never reclaimed
    expect(deps.nudged).toHaveLength(0)
    expect(engine.workers).toHaveLength(1)
  })
})

// ── Quota-detection fast path (the measured 21-minute lag, 2026-07-09) ─────────
// Three workers printed "You've reached your Fable 5 limit." FOUR SECONDS after
// spawn; the tier only cooled 21m30s later. The three legs, each pinned here:
//  ① the 10-min silence gate never looked at an instantly-rejected worker;
//  ② a decorative TUI repaint (a "Plugin updated" toast at 15:14:43) reset the
//    silence clock and pushed the gate back 6m40s — repeatable indefinitely;
//  ③ the integrate pass's inline verify starved the monitor (covered in the
//    runEnginePass suite below).
// Contract under test: an at-spawn rejection is confirmed (and its tier cooled)
// in UNDER TWO MINUTES; chrome repaints cannot defer detection; the false-kill
// guards (streaming worker untouched, limit wording in source ≠ limited) hold.

describe('runDispatchPass — monitor: at-spawn rejection confirmed early (leg ①)', () => {
  const T0 = Date.parse('2026-07-09T15:08:00Z') // the incident's clock
  const startedAt = new Date(T0).toISOString()
  const FABLE_LIMIT_NOTICE =
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
  const w1 = () =>
    worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, model: 'fable' })
  beforeEach(() => {
    __resetQuotaForTest()
    a5Mock.current = null
  })
  afterEach(() => {
    __resetQuotaForTest()
    a5Mock.current = null
  })

  it('confirms an instantly-rejected worker UNDER TWO MINUTES and cools its tier (完了条件1)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', T0 + 4_000]]), // the notice's own paint — then nothing
      screens: new Map([['pty-a-1', FABLE_LIMIT_NOTICE]]),
    })
    // First pass after the output lulls past the scrape gate: the sighting is
    // STAMPED (limit-screen clock starts) but one frame alone never confirms.
    const tStamp = T0 + 4_000 + RATE_LIMIT_SCRAPE_QUIET_MS + 3_000
    await runDispatchPass(engine, deps, tStamp)
    expect(engine.limitScreen?.get('pty-a-1')).toBe(tStamp)
    expect(engine.rateLimited.has('pty-a-1')).toBe(false)
    for (const tier of MODEL_TIER_LADDER) expect(isTierCooling(tier, tStamp + 1)).toBe(false)

    // The notice holds the screen through the confirm window → confirmed + cooled,
    // with the whole sighting→cooling chain landing well under two minutes.
    const tConfirm = tStamp + RATE_LIMIT_EARLY_CONFIRM_MS + 3_000
    expect(tConfirm - T0).toBeLessThan(2 * 60_000) // the card's observable contract
    await runDispatchPass(engine, deps, tConfirm)
    expect(engine.rateLimited.get('pty-a-1')?.since).toBe(tConfirm)
    expect(isTierCooling('fable', tConfirm + 1)).toBe(true)
    expect(engine.log.some((l) => l.message.startsWith('worker rate/usage-limited — holding'))).toBe(true)
    // …and it is HELD: never nudged, never reclaimed, slot still counted.
    expect(deps.nudged).toHaveLength(0)
    expect(deps.tornDown).toHaveLength(0)
    expect(engine.workers).toHaveLength(1)
  })

  it('does NOT early-confirm a worker with commits (it plainly worked — ordinary gate applies)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 1]]), // integrable work exists
      outputs: new Map([['pty-a-1', T0 + 4_000]]),
      screens: new Map([['pty-a-1', FABLE_LIMIT_NOTICE]]),
    })
    const tStamp = T0 + 4_000 + RATE_LIMIT_SCRAPE_QUIET_MS + 3_000
    await runDispatchPass(engine, deps, tStamp)
    await runDispatchPass(engine, deps, tStamp + RATE_LIMIT_EARLY_CONFIRM_MS + 3_000)
    expect(engine.rateLimited.has('pty-a-1')).toBe(false) // early path refused
    // The clamped stall gate still catches a REAL wait eventually (10min real time).
    await runDispatchPass(engine, deps, tStamp + STALL_SILENCE_MS + 1_000)
    expect(engine.rateLimited.has('pty-a-1')).toBe(true)
  })

  it('does NOT early-confirm when a heartbeat postdates the notice (alive by the other channel)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const heartbeats = new Map<string, HeartbeatSign>()
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      heartbeats,
      outputs: new Map([['pty-a-1', T0 + 4_000]]),
      screens: new Map([['pty-a-1', FABLE_LIMIT_NOTICE]]),
    })
    const tStamp = T0 + 4_000 + RATE_LIMIT_SCRAPE_QUIET_MS + 3_000
    await runDispatchPass(engine, deps, tStamp)
    // A heartbeat lands AFTER the sighting — the worker is demonstrably working
    // (the notice is scrollback / quoted text, not its terminal state).
    heartbeats.set('a', { ready: false, blocked: false, at: new Date(tStamp + 10_000).toISOString() })
    await runDispatchPass(engine, deps, tStamp + RATE_LIMIT_EARLY_CONFIRM_MS + 15_000)
    expect(engine.rateLimited.has('pty-a-1')).toBe(false)
    expect(deps.tornDown).toHaveLength(0)
  })

  // ── REGRESSION (0d1f7f0 review residue) — the early path's FALSE-POSITIVE
  // boundary, pinned fence by fence. Inside the spawn onset window a worker that
  // is genuinely healthy but (a) keeps limit wording on screen, (b) lulls output
  // past the scrape gate, (c) has zero commits and (d) no heartbeat after the
  // sighting is INDISTINGUISHABLE from an at-spawn rejection, and the engine
  // accepts the misfire BY DESIGN because it is non-destructive: the worker is
  // only HELD (never nudged / torn down / requeued) and the cooling self-expires
  // on the grace clock — the fail-closed contract this suite exists to keep.
  // Each case crosses exactly ONE fence, so an edit that widens (or silently
  // disables) any of them fails one row here; the fourth fence — onset itself
  // (limitSince - startedMs) — is pinned by the editing-wording test in the
  // false-kill suite below. Behaviour photographed as-is; a REAL fence bug found
  // while writing this would be carded, not fixed here (worker discipline).
  it.each([
    {
      label: 'inside every fence → falsely confirmed, but HELD only (the accepted residue)',
      hbAt: 'spawn' as const, // only the spawn-time init beat — predates the sighting
      commits: 0,
      spinner: false,
      confirmed: true,
    },
    {
      label: 'heartbeat exactly AT the sighting (hbMs == limitSince) → still confirmed (≤ is the fence)',
      hbAt: 'at-sighting' as const,
      commits: 0,
      spinner: false,
      confirmed: true,
    },
    {
      label: 'heartbeat 1ms AFTER the sighting → refused (alive by the other channel)',
      hbAt: 'after-sighting' as const,
      commits: 0,
      spinner: false,
      confirmed: false,
    },
    {
      label: 'ONE commit ahead → refused (it plainly worked; ordinary gate applies)',
      hbAt: 'spawn' as const,
      commits: 1,
      spinner: false,
      confirmed: false,
    },
    {
      label: 'spinner repaints hold the lull under the scrape gate → never sampled, never confirmed',
      hbAt: 'spawn' as const,
      commits: 0,
      spinner: true,
      confirmed: false,
    },
  ])('early-confirm false-positive boundary: $label', async ({ hbAt, commits, spinner, confirmed }) => {
    const engine = newEngine({ workers: [w1()] })
    const heartbeats = new Map<string, HeartbeatSign>()
    const outputs = new Map([['pty-a-1', T0 + 4_000]]) // one early paint, then the lull
    const screens = new Map([['pty-a-1', FABLE_LIMIT_NOTICE]])
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', commits]]),
      heartbeats,
      outputs,
      screens,
    })
    // Same two-pass clock as the confirm test above (stamp, then confirm); fixture
    // sanity: both passes land INSIDE the onset window, isolating the three fences.
    const tStamp = T0 + 4_000 + RATE_LIMIT_SCRAPE_QUIET_MS + 3_000
    const tConfirm = tStamp + RATE_LIMIT_EARLY_CONFIRM_MS + 3_000
    expect(tStamp - T0).toBeLessThanOrEqual(RATE_LIMIT_EARLY_ONSET_MS)
    expect(tConfirm - T0).toBeLessThan(2 * 60_000)
    const hbMs = { spawn: T0, 'at-sighting': tStamp, 'after-sighting': tStamp + 1 }[hbAt]
    heartbeats.set('a', { ready: false, blocked: false, at: new Date(hbMs).toISOString() })

    // A busy-but-quiet worker mid-thought; the spinner variant repaints chrome
    // just inside the scrape-quiet gate before EACH pass, so the screen is never
    // even sampled and no limit-screen clock can start.
    if (spinner) outputs.set('pty-a-1', tStamp - RATE_LIMIT_SCRAPE_QUIET_MS + 1_000)
    await runDispatchPass(engine, deps, tStamp)
    if (spinner) {
      expect(engine.limitScreen?.has('pty-a-1')).toBe(false) // no sample → no clock
      outputs.set('pty-a-1', tConfirm - RATE_LIMIT_SCRAPE_QUIET_MS + 1_000)
    } else {
      expect(engine.limitScreen?.get('pty-a-1')).toBe(tStamp) // sighting stamped
    }
    await runDispatchPass(engine, deps, tConfirm)

    // Whichever way the verdict goes, the worker itself is NEVER touched — a
    // misfire is a hold, not a kill: no nudge, no teardown, no requeue, and the
    // slot stays counted.
    expect(deps.nudged).toHaveLength(0)
    expect(deps.tornDown).toHaveLength(0)
    expect(deps.recovered).toHaveLength(0)
    expect(engine.workers).toHaveLength(1)

    if (confirmed) {
      expect(engine.rateLimited.get('pty-a-1')?.since).toBe(tConfirm)
      expect(isTierCooling('fable', tConfirm + 1)).toBe(true) // the accepted cost: a tier cools early

      // …and the misfire SELF-HEALS well inside the 20-min grace: work resumes
      // (fresh output, the wording scrolls off) → the hold and the limit-screen
      // clock dissolve on the next sampled pass, with the worker still intact.
      screens.set('pty-a-1', 'editing src/lib/server/foo.ts — vitest running')
      outputs.set('pty-a-1', tConfirm + 30_000)
      await runDispatchPass(engine, deps, tConfirm + 60_000)
      expect(engine.rateLimited.has('pty-a-1')).toBe(false)
      expect(engine.limitScreen?.has('pty-a-1')).toBe(false)
      expect(deps.tornDown).toHaveLength(0)
      expect(engine.workers).toHaveLength(1)
    } else {
      expect(engine.rateLimited.has('pty-a-1')).toBe(false) // the crossed fence refused
      for (const tier of MODEL_TIER_LADDER) expect(isTierCooling(tier, tConfirm + 1)).toBe(false)
    }
  })
})

describe('runDispatchPass — monitor: decorative repaints cannot defer detection (leg ②)', () => {
  const T0 = Date.parse('2026-07-09T15:08:00Z')
  const startedAt = new Date(T0).toISOString()
  const FABLE_LIMIT_NOTICE =
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
  const w1 = () =>
    worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, model: 'fable' })
  beforeEach(() => {
    __resetQuotaForTest()
    a5Mock.current = null
  })
  afterEach(() => {
    __resetQuotaForTest()
    a5Mock.current = null
  })

  it('a limit screen + PERIODIC meaningless repaints still confirms on the real clock (完了条件2)', async () => {
    // The worker did real work for 5 minutes (past the early onset window — this
    // pins the ORDINARY gate, not the early path), then hit the wall; from then
    // on the TUI repaints chrome every minute while the notice holds the screen.
    const engine = newEngine({ workers: [w1()] })
    const outputs = new Map([['pty-a-1', T0 + 5 * 60_000]])
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs,
      screens: new Map([['pty-a-1', FABLE_LIMIT_NOTICE]]),
    })
    const tStamp = T0 + 5 * 60_000 + RATE_LIMIT_SCRAPE_QUIET_MS + 3_000
    await runDispatchPass(engine, deps, tStamp)
    expect(engine.limitScreen?.get('pty-a-1')).toBe(tStamp)
    expect(engine.rateLimited.has('pty-a-1')).toBe(false) // onset past the early window

    // Ten minutes of repaints: lastOutputAt is never older than ~65s at any pass —
    // the unfixed clock would sit permanently below the gate ("原理上、TUI が何か
    // 描くたびに検知は先送りできてしまう"). The limit-screen clock is immune.
    let confirmedAt: number | null = null
    for (let k = 1; k <= 11; k++) {
      const t = tStamp + k * 60_000
      outputs.set('pty-a-1', t - 5_000) // fresh chrome 5s before each pass
      await runDispatchPass(engine, deps, t)
      if (confirmedAt === null && engine.rateLimited.has('pty-a-1')) confirmedAt = t
    }
    expect(confirmedAt).not.toBeNull() // detection FIRED through the repaints
    expect(confirmedAt! - tStamp).toBeLessThanOrEqual(STALL_SILENCE_MS + 60_000) // …on the real clock
    expect(isTierCooling('fable', confirmedAt! + 1)).toBe(true)
    expect(deps.nudged).toHaveLength(0)
    expect(deps.tornDown).toHaveLength(0)
  })

  it('REGRESSION (実測 15:14:43): ONE toast repaint does not push the gate back 6m40s', async () => {
    // Same shape as the incident, with the early path fenced off (commits exist)
    // so this isolates the clamp: notice at spawn+4s, one decorative repaint at
    // +6m43s. The gate must fire ~10min after the NOTICE, not 10min after the toast.
    const engine = newEngine({ workers: [w1()] })
    const outputs = new Map([['pty-a-1', T0 + 4_000]])
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 1]]),
      outputs,
      screens: new Map([['pty-a-1', FABLE_LIMIT_NOTICE]]),
    })
    const tStamp = T0 + 4_000 + RATE_LIMIT_SCRAPE_QUIET_MS + 3_000
    await runDispatchPass(engine, deps, tStamp) // sighting stamped
    outputs.set('pty-a-1', T0 + 6 * 60_000 + 43_000) // the 15:14:43 toast

    // Without the clamp, silence at this instant reads ~3m18s (< the gate) and
    // detection recedes; with it, the notice's tenure IS the clock → confirmed.
    const tGate = tStamp + STALL_SILENCE_MS + 1_000
    await runDispatchPass(engine, deps, tGate)
    expect(engine.rateLimited.has('pty-a-1')).toBe(true)
    expect(isTierCooling('fable', tGate + 1)).toBe(true)
  })

  it('requeue after grace ALSO demands the raw channel quiet — a re-streaming worker is never reclaimed', async () => {
    // A confirmed-limited worker whose limit later lifts: output streams again but
    // the (reconstructed) frame still shows the scrolled-back notice for a while.
    // The grace requeue must NOT fire while output is actively flowing.
    const engine = newEngine({ workers: [w1()] })
    const outputs = new Map<string, number>()
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs,
      screens: new Map([['pty-a-1', FABLE_LIMIT_NOTICE]]),
    })
    const t1 = T0 + STALL_SILENCE_MS + 1_000
    await runDispatchPass(engine, deps, t1) // confirmed via the ordinary gate
    expect(engine.rateLimited.get('pty-a-1')?.since).toBe(t1)

    const t2 = t1 + RATE_LIMIT_GRACE_MS + 1_000
    outputs.set('pty-a-1', t2 - 10_000) // ACTIVELY streaming again (10s ago)
    await runDispatchPass(engine, deps, t2)
    expect(deps.tornDown).toHaveLength(0) // grace elapsed, but the worker is WORKING
    expect(deps.recovered).toHaveLength(0)
    expect(engine.workers).toHaveLength(1)

    // Output goes quiet again with the notice still up → NOW the slot is recovered.
    const t3 = t2 + RATE_LIMIT_SCRAPE_QUIET_MS + 60_000
    await runDispatchPass(engine, deps, t3)
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'todo' }])
  })
})

describe('runDispatchPass — monitor: false-kill guards preserved (完了条件4)', () => {
  const T0 = Date.parse('2026-07-09T15:08:00Z')
  const startedAt = new Date(T0).toISOString()
  const FABLE_LIMIT_NOTICE =
    "You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model."
  const w1 = () =>
    worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt, model: 'fable' })
  beforeEach(() => {
    __resetQuotaForTest()
    a5Mock.current = null
  })
  afterEach(() => {
    __resetQuotaForTest()
    a5Mock.current = null
  })

  it('a STREAMING worker is never even sampled, whatever its screen shows', async () => {
    const engine = newEngine({ workers: [w1()] })
    const now = T0 + 20 * 60_000 // long-lived worker…
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1_000]]), // …actively emitting
      screens: new Map([['pty-a-1', FABLE_LIMIT_NOTICE]]),
    })
    await runDispatchPass(engine, deps, now)
    expect(engine.limitScreen?.has('pty-a-1')).toBe(false) // no scrape, no clock
    expect(engine.rateLimited.has('pty-a-1')).toBe(false)
    expect(deps.nudged).toHaveLength(0)
    expect(deps.tornDown).toHaveLength(0)
    for (const tier of MODEL_TIER_LADDER) expect(isTierCooling(tier, now + 1)).toBe(false)
  })

  it('a worker EDITING limit wording minutes into its session is not early-confirmed (onset window)', async () => {
    // The fixture-text hazard: this repo's own tests quote the CLI notice
    // verbatim; a worker Reads that file, the wording sits on screen, and the
    // worker thinks for a while. Past the onset window the early path must
    // refuse — only the (clamped) 10-min gate may ever classify it, exactly the
    // pre-existing exposure, no wider.
    const engine = newEngine({ workers: [w1()] })
    const outputs = new Map([['pty-a-1', T0 + 3 * 60_000]]) // worked for 3 minutes…
    const screens = new Map([['pty-a-1', FABLE_LIMIT_NOTICE]]) // …then the quoted wording idles on screen
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], outputs, screens })
    expect(3 * 60_000).toBeGreaterThan(RATE_LIMIT_EARLY_ONSET_MS) // fixture sanity
    const tStamp = T0 + 3 * 60_000 + RATE_LIMIT_SCRAPE_QUIET_MS + 3_000
    await runDispatchPass(engine, deps, tStamp)
    await runDispatchPass(engine, deps, tStamp + RATE_LIMIT_EARLY_CONFIRM_MS + 30_000)
    expect(engine.rateLimited.has('pty-a-1')).toBe(false) // early path refused (onset too late)
    expect(deps.nudged).toHaveLength(0)
    expect(deps.tornDown).toHaveLength(0)

    // It resumes typing (output flows, the wording scrolls off) → clock cleared.
    outputs.set('pty-a-1', tStamp + 6 * 60_000)
    screens.set('pty-a-1', 'diff --git a/src/lib/server/swarmOrchestrator.ts …')
    await runDispatchPass(engine, deps, tStamp + 6 * 60_000 + RATE_LIMIT_SCRAPE_QUIET_MS + 3_000)
    expect(engine.limitScreen?.has('pty-a-1')).toBe(false)
    expect(engine.rateLimited.has('pty-a-1')).toBe(false)
  })
})

describe('runDispatchPass — monitor: runaway (execution-time ceiling)', () => {
  const T0 = Date.parse('2026-06-25T00:00:00Z')
  const startedAt = new Date(T0).toISOString()
  const w1 = () =>
    worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt })

  it('STOPS a worker past MAX_EXEC_MS even while it is BUSY (independent of liveness) → blocked', async () => {
    const engine = newEngine({ workers: [w1()] })
    const now = T0 + MAX_EXEC_MS + 1
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1000]]), // fresh output — a normal worker would be left alone
      heartbeats: new Map([['a', { ready: false, blocked: false, at: new Date(now - 1000).toISOString() }]]),
    })
    await runDispatchPass(engine, deps, now)
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }]) // a re-run would overrun again
    expect(engine.workers).toHaveLength(0)
    expect(deps.nudged).toHaveLength(0)
    const log = engine.log.find((l) => l.message.startsWith('worker runaway'))
    expect(log?.level).toBe('warn')
  })

  it('does NOT stop a long-but-under-ceiling worker', async () => {
    const engine = newEngine({ workers: [w1()] })
    const now = T0 + MAX_EXEC_MS - 60_000 // a minute under the cap
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1000]]), // still working
    })
    await runDispatchPass(engine, deps, now)
    expect(deps.tornDown).toHaveLength(0)
    expect(engine.workers).toHaveLength(1)
  })

  it('runaway takes PRIORITY over a rate-limit wait (→ blocked, not todo)', async () => {
    const engine = newEngine({ workers: [w1()] })
    // Alive past the ceiling on WORKING time (no hold has ever been banked, and the
    // screen only reads limited on THIS pass — the credit is 0), so runaway still
    // wins the race against the rate-limit arm.
    const now = T0 + MAX_EXEC_MS + 1
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached']]),
    })
    await runDispatchPass(engine, deps, now)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    expect(engine.rateLimited.has('pty-a-1')).toBe(false)
  })

  // ── The 2026-07-12 全損: a quota wait must not spend the execution budget ─────
  // Measured: 20m held on a Fable limit + 84m of real work = 104m wall-clock ⇒
  // judged runaway at the 90m ceiling and torn down with 15 uncommitted files. The
  // ceiling bounds WORKING time; a hold is repaid.

  it('does NOT count a BANKED rate-limit hold against the execution ceiling', async () => {
    const engine = newEngine({ workers: [w1()] })
    const heldMs = 20 * 60_000 // the worker sat 20m on a limit earlier, then resumed
    engine.rateLimitHeldMs = new Map([['pty-a-1', heldMs]])
    const now = T0 + MAX_EXEC_MS + 10 * 60_000 // ALIVE 100m at the 90m default …
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1000]]), // busy: back at work, screen normal
    })
    await runDispatchPass(engine, deps, now)
    // … but only 80m WORKED (100 − 20) ⇒ under the ceiling ⇒ left alone.
    expect(deps.tornDown).toHaveLength(0)
    expect(deps.recovered).toHaveLength(0)
    expect(engine.workers).toHaveLength(1)
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(false)
  })

  it('credits a hold that is STILL IN FLIGHT (a worker frozen at the ceiling is not 暴走)', async () => {
    // A worker held on a limit RIGHT NOW must not cross the ceiling while it sits
    // there waiting — the credit is paid in real time, not only once the hold ends.
    // (Without this, a worker 75m in that hits a limit is reclaimed 15m later for
    // "running too long" while it has done nothing at all.)
    const engine = newEngine({ workers: [w1()] })
    const now = T0 + MAX_EXEC_MS + 10 * 60_000 // alive 100m
    const holdSince = now - 20 * 60_000 // ... 20m of which it has been frozen
    engine.rateLimited = new Map([['pty-a-1', { since: holdSince, holdSince }]])
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached']]),
    })
    await runDispatchPass(engine, deps, now)
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(false)
    expect(deps.recovered).not.toContainEqual({ taskId: 'a', column: 'blocked' }) // not parked as 暴走
    expect(deps.nudged).toHaveLength(0) // still held, never nudged
  })

  it('STILL stops a worker that never waited on a limit (regression guard on the credit)', async () => {
    // The credit must not become a blanket amnesty: with no hold banked and none in
    // flight, 91m alive at the 90m default is 91m WORKED ⇒ runaway, exactly as before.
    const engine = newEngine({ workers: [w1()] })
    const now = T0 + MAX_EXEC_MS + 60_000
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1000]]), // busy — only the ceiling can stop it
    })
    await runDispatchPass(engine, deps, now)
    expect(engine.rateLimitHeldMs?.get('pty-a-1')).toBeUndefined() // no hold ever existed
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    expect(engine.workers).toHaveLength(0)
    const log = engine.log.find((l) => l.message.startsWith('worker runaway'))
    expect(log?.level).toBe('warn')
    expect(log?.message).toContain('0m rate-limit hold + 0m 統合待ち credited back')
  })

  it('BANKS a hold when the limit lifts — the ledger is what the ceiling reads', async () => {
    // The wiring under the two tests above: the engine must actually RECORD the
    // hold's span when the worker resumes. Pass 1 holds it (screen limited, silent);
    // pass 2 sees a normal screen ⇒ the hold ENDS and its span is banked.
    const engine = newEngine({ workers: [w1()] })
    const holdStart = T0 + 10 * 60_000
    const deps1 = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached']]),
      outputs: new Map([['pty-a-1', T0]]), // silent since dispatch ⇒ the hold gate opens
    })
    await runDispatchPass(engine, deps1, holdStart)
    expect(engine.rateLimited.has('pty-a-1')).toBe(true) // held, not reclaimed
    expect(deps1.tornDown).toHaveLength(0)

    // 15 minutes later the limit lifts: the screen reads normal and output flows.
    const resumed = holdStart + 15 * 60_000
    const deps2 = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'thinking…']]),
      outputs: new Map([['pty-a-1', resumed - 1000]]),
    })
    await runDispatchPass(engine, deps2, resumed)
    expect(engine.rateLimited.has('pty-a-1')).toBe(false) // hold released …
    expect(engine.rateLimitHeldMs?.get('pty-a-1')).toBe(15 * 60_000) // … and BANKED
    expect(engine.workers).toHaveLength(1) // still working, untouched
  })
})

// ── The 2026-07-18 事故: 統合待ちの idle が実行時間上限に算入されていた ──────────
// A worker reached ready at 04:18; its card sat in 'review' waiting for the
// commander; at 04:46 the commander 差し戻し'd it (review→doing). The very next
// pass judged it "worker runaway — worked 91m ≥ 90m execution limit" and tore the
// worktree down, parking the card in 'blocked'. It had actually WORKED 63m — the
// 28 minutes it spent idle in the integration queue were charged to it as work.
// The ceiling bounds WORKING time; 統合待ち is repaid, exactly like a quota hold.
describe('runDispatchPass — monitor: 統合待ち is not working time (2026-07-18)', () => {
  const T0 = Date.parse('2026-07-18T03:15:00Z')
  const startedAt = new Date(T0).toISOString()
  const w1 = (over: Partial<OrchestratorWorker> = {}) =>
    worker({
      terminalId: 'pty-a-1',
      branch: 'swarm/a',
      worktree: '/wt/a',
      taskId: 'a',
      taskTitle: 'task a',
      startedAt,
      ...over,
    })
  /** A worker READY to merge: its branch has commits and its heartbeat says so. */
  const readyDeps = (boardColumn: 'doing' | 'review', at: number) =>
    makeDeps({
      cards: [card('a', { boardColumn })],
      commits: new Map([['a', 3]]),
      heartbeats: new Map([['a', { ready: true, blocked: false, at: new Date(at - 1000).toISOString() }]]),
      outputs: new Map([['pty-a-1', at - 1000]]),
    })
  /** The post-差し戻し shape: card back in 'doing', busy, but its heartbeat file
   *  still holds the PRE-rework readyToMerge:true (the engine can't clear it). The
   *  re-promote suppression drops the promote on that stale sign, so the worker
   *  falls THROUGH to the execution-ceiling check — the exact incident path. */
  const staleReadyDeps = (heartbeatAt: number, at: number) =>
    makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 3]]),
      heartbeats: new Map([
        ['a', { ready: true, blocked: false, at: new Date(heartbeatAt - 1000).toISOString() }],
      ]),
      outputs: new Map([['pty-a-1', at - 1000]]), // busy — only the ceiling can stop it
    })

  it('REPLAYS the incident: ready → 28m 統合待ち → 差し戻し ⇒ NOT stopped', async () => {
    const engine = newEngine({ workers: [w1()] })
    // 04:18 — 63m in, the worker reports ready and the card is promoted to review.
    const readyAtMs = T0 + 63 * 60_000
    const deps1 = readyDeps('doing', readyAtMs)
    await runDispatchPass(engine, deps1, readyAtMs)
    expect(deps1.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(engine.workers[0].stage).toBe('done')
    expect(engine.workers[0].readyAt).toBe(new Date(readyAtMs).toISOString())
    expect(engine.integrationWaitSince?.get('pty-a-1')).toBe(readyAtMs) // 統合待ち clock started

    // 04:46 — the commander 差し戻し's it (review→doing) after 28m of queue latency.
    // 91m ALIVE at the 90m default: the OLD code called this "runaway 91m".
    const reworkMs = T0 + 91 * 60_000
    const deps2 = readyDeps('doing', reworkMs)
    await runDispatchPass(engine, deps2, reworkMs)

    // The wait is banked and repaid ⇒ 63m WORKED ⇒ nowhere near the ceiling.
    expect(engine.integrationWaitMs?.get('pty-a-1')).toBe(28 * 60_000)
    expect(engine.integrationWaitSince?.has('pty-a-1')).toBe(false) // ended, not double-counted
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
    expect(deps2.tornDown).toHaveLength(0) // worktree SURVIVES — the commander's recovery plan holds
    expect(deps2.recovered).toHaveLength(0) // and the card never reaches 'blocked'
    expect(engine.workers).toHaveLength(1)
    expect(engine.workers[0].stage).toBe('running') // back at work on the 差し戻し
  })

  it('a COMMANDER hand-move (doing→review) starts the same ledger as a promote', async () => {
    // The route the first fix missed. og-manage tells the commander to
    // `move <id> review` the moment a worker reports READY (SKILL.md 「READY を見たら
    // まず move review」), so the hand-move routinely BEATS the engine's promote
    // tick — it is the MOST COMMON way a card reaches review, not an edge.
    // Binding readyAt / 統合待ち to the promote WRITE instead of the card's COLUMN
    // left that route off the ledger: stage went 'done' with no readyAt, the wait
    // never banked, and the next 差し戻し replayed 0718 verbatim — "runaway 91m",
    // worktree torn down, card → blocked.
    const engine = newEngine({ workers: [w1()] })
    // 63m — the worker IS ready (3 commits + ready heartbeat), but the commander
    // already moved the card to review, so the engine never runs its own promote.
    const readyAtMs = T0 + 63 * 60_000
    const deps1 = readyDeps('review', readyAtMs)
    await runDispatchPass(engine, deps1, readyAtMs)
    expect(deps1.reviews).toHaveLength(0) // the ENGINE did not promote — the human did
    expect(engine.workers[0].stage).toBe('done')
    expect(engine.workers[0].readyAt).toBe(new Date(readyAtMs).toISOString()) // …ledger ON anyway
    expect(engine.integrationWaitSince?.get('pty-a-1')).toBe(readyAtMs)

    // 91m — 差し戻し (review→doing). 91m alive at the 90m default: the exact input
    // that produced the incident's log line on the hand-move path.
    const reworkMs = T0 + 91 * 60_000
    const deps2 = readyDeps('doing', reworkMs)
    await runDispatchPass(engine, deps2, reworkMs)

    expect(engine.integrationWaitMs?.get('pty-a-1')).toBe(28 * 60_000) // banked, then repaid
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
    expect(deps2.tornDown).toHaveLength(0) // worktree SURVIVES
    expect(deps2.recovered).toHaveLength(0) // card never reaches 'blocked'
    expect(engine.workers[0].stage).toBe('running') // back at work on the 差し戻し
  })

  it('a BARE card parked in review does NOT earn readyAt — the 暴走 guard must not fail open', async () => {
    // `readyAt` is the only thing standing between a worker and the 暴走 label, and
    // the column is a CLAIM, not a receipt: anyone can drag a card to 'review'.
    // Stamping on the claim alone meant that parking an untouched card in review
    // once, then dragging it back, permanently immunised that worker — it could
    // then run for hours with zero commits, escape the 'blocked' park, and tell the
    // owner 「統合可能な成果を一度出しています」 about an empty branch.
    const engine = newEngine({ workers: [w1()] })
    const at = T0 + 20 * 60_000
    const bare = makeDeps({
      cards: [card('a', { boardColumn: 'review' })], // hand-moved…
      // …but NOTHING delivered: no commits, no ready heartbeat.
      outputs: new Map([['pty-a-1', at - 1000]]),
    })
    await runDispatchPass(engine, bare, at)
    expect(engine.workers[0].readyAt).toBeUndefined() // the claim is not corroborated
    expect(engine.integrationWaitSince?.get('pty-a-1')).toBeUndefined()

    // …so when it later blows the ceiling with nothing to show, it is still a 暴走.
    const now = T0 + 200 * 60_000
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })], // dragged back
      outputs: new Map([['pty-a-1', now - 1000]]),
    })
    await runDispatchPass(engine, deps, now)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }]) // parked for a human
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(true)
    const fatal = engine.pendingFatal.find((f) => f.event === 'exec-timeout')
    expect(fatal?.execTimeoutKind).toBe('runaway')
    expect(fatal?.detail).not.toContain('統合可能な成果を一度出しています')
  })

  it('…but a corroborated review card DOES earn it (commits alone are enough)', async () => {
    // The corroboration is a NECESSARY condition, not a new witness: a hand-moved
    // card whose branch actually has commits still lands on the ledger exactly as
    // before, so the 0718 fix is untouched.
    const engine = newEngine({ workers: [w1()] })
    const at = T0 + 20 * 60_000
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'review' })],
      commits: new Map([['a', 3]]),
      outputs: new Map([['pty-a-1', at - 1000]]),
    })
    await runDispatchPass(engine, deps, at)
    expect(engine.workers[0].readyAt).toBe(new Date(at).toISOString())
    expect(engine.integrationWaitSince?.get('pty-a-1')).toBe(at)
  })

  it('…and a ready heartbeat alone is enough too (commits not yet visible)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const at = T0 + 20 * 60_000
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'review' })],
      heartbeats: new Map([['a', { ready: true, blocked: false, at: new Date(at - 1000).toISOString() }]]),
      outputs: new Map([['pty-a-1', at - 1000]]),
    })
    await runDispatchPass(engine, deps, at)
    expect(engine.workers[0].readyAt).toBe(new Date(at).toISOString())
  })

  it('SURVIVES the ticks in between — the wait clock is stamped once, not every pass', async () => {
    // THE GAP EVERY OTHER TEST HERE LEAVES OPEN. The rest drive two passes (promote,
    // then 差し戻し) and never a pass in BETWEEN — but the real tick is 3 seconds, so
    // a 28-minute integration wait contains ~560 of them, and the early-continue
    // calls beginIntegrationWait on every single one. Only the `has()` guard keeps
    // the ORIGINAL stamp; drop it and each pass re-stamps `now`, so the banked wait
    // collapses from 28m to one tick and 0718 returns intact.
    //
    // Mutation-checked: removing the guard turns this red (1665000 vs 1680000) and
    // leaves the other 495 tests green — it is the only thing holding that line.
    const engine = newEngine({ workers: [w1()] })
    const readyAtMs = T0 + 63 * 60_000
    await runDispatchPass(engine, readyDeps('doing', readyAtMs), readyAtMs) // promote
    expect(engine.integrationWaitSince?.get('pty-a-1')).toBe(readyAtMs)

    // …now the ordinary ticks while the card simply sits in review.
    for (let i = 1; i <= 5; i++) {
      const t = readyAtMs + i * 3_000
      await runDispatchPass(engine, readyDeps('review', t), t)
      expect(engine.integrationWaitSince?.get('pty-a-1')).toBe(readyAtMs) // never re-stamped
    }

    const reworkMs = T0 + 91 * 60_000
    await runDispatchPass(engine, readyDeps('doing', reworkMs), reworkMs) // 差し戻し
    // The FULL 28 minutes is banked — not the 3 seconds since the last tick.
    expect(engine.integrationWaitMs?.get('pty-a-1')).toBe(28 * 60_000)
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
  })

  it('the hand-move path reaches the ceiling as integration-wait too — never runaway/blocked', async () => {
    // Composition of the two halves, walked end to end on the COMMANDER's route:
    // hand-move → 差し戻し → genuinely works past the ceiling. The other ceiling
    // test injects `readyAt` through the fixture, so only this one proves the
    // stamp SURVIVES the round trip and lands the card in review. 完了条件 1 + 2.
    const engine = newEngine({ workers: [w1()] })
    const readyAtMs = T0 + 63 * 60_000
    const handMove = readyDeps('review', readyAtMs) // 司令官が先に review へ動かした後の姿
    await runDispatchPass(engine, handMove, readyAtMs)
    // PIN THE ROUTE, not just the outcome. The card starts in 'review', so the
    // early-continue must fire and the engine's own promote must never run — that
    // is the whole point of this test, and without these two lines a refactor that
    // reordered promote ahead of the early-continue would keep it green while it
    // silently stopped covering the hand-move path (the regression that got this
    // very change 差し戻し'd once).
    expect(handMove.reviews).toEqual([]) // engine did NOT promote — the commander had
    expect(engine.workers[0].readyAt).toBe(new Date(readyAtMs).toISOString()) // stamped anyway

    const reworkMs = T0 + 88 * 60_000
    await runDispatchPass(engine, readyDeps('doing', reworkMs), reworkMs) // 差し戻し
    expect(engine.integrationWaitMs?.get('pty-a-1')).toBe(25 * 60_000) // banked by the round trip

    // The RE-WORK itself runs 95m past the 差し戻し ⇒ over the 90m ceiling on its
    // OWN budget, so it IS stopped — but as a worker that delivered, not as a 暴走.
    // (Before 2026-07-20 this fired at 120m, i.e. by charging the re-work for the
    // 63m of work that preceded it; the ceiling now measures the current assignment,
    // so the overrun has to be a real overrun.)
    const now = reworkMs + 95 * 60_000
    const deps = staleReadyDeps(readyAtMs, now)
    await runDispatchPass(engine, deps, now)

    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }]) // stopped for real
    expect(deps.recovered).toHaveLength(0) // never recoverCard'd ⇒ never 'blocked'
    expect(deps.board.get('a')?.boardColumn).toBe('review')
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(false)
    expect(engine.log.filter((l) => l.message.includes('統合待ちのまま'))).toEqual([])
    const fatal = engine.pendingFatal.find((f) => f.event === 'exec-timeout')
    expect(fatal?.detail).toContain('差し戻し後の再作業')
    // The flavor must travel WITH the event: the overseer raises ONE S3 signal for
    // both kinds and needs this to avoid asking the owner to "split it up and
    // retry" a card whose branch already holds delivered work (that answer rides
    // into the card's next dispatch). Covered end-to-end in swarmOverseer.test.ts.
    expect(fatal?.execTimeoutKind).toBe('integration-wait')
  })

  it('a promote WINS the race against the ceiling (unchanged — characterisation)', async () => {
    // A worker that finishes at 95m is promoted, not reclaimed: the ceiling must
    // never steal a card whose work is already integrable. This held BEFORE this
    // fix too (the promote block runs earlier in the pass) — pinned here because
    // it is the invariant that makes `readyAt` only ever reachable via 差し戻し.
    const engine = newEngine({ workers: [w1()] })
    const now = T0 + MAX_EXEC_MS + 5 * 60_000
    const deps = readyDeps('doing', now)
    await runDispatchPass(engine, deps, now)
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(deps.tornDown).toHaveLength(0)
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
  })

  it('a ready worker OVER the ceiling on WORKED time → review, never blocked/runaway', async () => {
    // Even when the credit is not enough — it genuinely worked past the ceiling
    // after the 差し戻し — a worker that has DELIVERED is not a 暴走. It is stopped
    // (the slot is real), but under its own reason: card → review (the commander's
    // queue), never → blocked (the owner's). 完了条件 1 + 2.
    //
    // The post-差し戻し shape: ready at 80m, 差し戻し'd at 105m (25m banked), now
    // re-working with its PRE-rework heartbeat still on disk — so the re-promote
    // suppression drops the promote and it falls through to the ceiling check.
    const readyAtMs = T0 + 80 * 60_000
    const reworkAtMs = T0 + 105 * 60_000
    const engine = newEngine({
      workers: [
        w1({ readyAt: new Date(readyAtMs).toISOString(), reworkAt: new Date(reworkAtMs).toISOString() }),
      ],
    })
    engine.integrationWaitMs = new Map([['pty-a-1', 25 * 60_000]]) // banked by the 差し戻し
    // The re-work runs 95m past the 差し戻し ⇒ over the 90m ceiling on its own
    // budget. The 25m of banked 統合待ち is no longer SUBTRACTED (the clock simply
    // starts after it), so the line reports it as 計上対象外 rather than credited.
    const now = reworkAtMs + 95 * 60_000
    const deps = staleReadyDeps(readyAtMs, now)
    await runDispatchPass(engine, deps, now)

    // It WAS stopped (the slot is real) — so this is the recovery path, not a promote.
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    expect(engine.workers).toHaveLength(0)
    expect(deps.recovered).toHaveLength(0) // never recoverCard'd → never 'blocked'
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }]) // left in review instead
    expect(deps.board.get('a')?.boardColumn).toBe('review')
    const log = engine.log.find((l) => l.message.startsWith('worker over execution budget while RE-WORKING'))
    expect(log?.level).toBe('warn')
    expect(log?.message).toContain('暴走ではない')
    expect(log?.message).toContain('統合待ち 25m は計上対象外')
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(false) // NOT that label
    // The owner's escalation must describe THIS situation truthfully: a 差し戻し
    // re-work that was cut off — not "idle in 統合待ち", and not a tip that is
    // safe to land. (A message that over-claims is how the 0718 diagnosis went
    // wrong; the fix must not reproduce that in a new shape.)
    const fatal = engine.pendingFatal.find((f) => f.event === 'exec-timeout')
    expect(fatal?.detail).toContain('差し戻し後の再作業')
    expect(fatal?.detail).toContain('暴走ではありません')
    expect(fatal?.detail).toContain('未検証') // the WIP-salvage caveat rides on BOTH reasons
    expect(fatal?.detail).not.toContain('統合待ちのまま') // it is NOT waiting — it was re-working
    // …and the SAME truth on every journal line, not just the ceiling's. This stop
    // emits TWO lines (the ceiling's, then recoverLost's `worker <verb> — card →`),
    // and the second one used to carry 「統合待ちのまま」 — the wording this branch's
    // docs and the assertion above explicitly forbid. Sweep the whole journal so a
    // banned phrase can't sneak back through a line nobody is asserting on.
    expect(engine.log.filter((l) => l.message.includes('統合待ちのまま'))).toEqual([])
    const recovery = engine.log.find((l) => l.message.startsWith('worker 差し戻し後の再作業'))
    expect(recovery?.message).toContain('暴走ではない')
    expect(recovery?.message).toContain('card → review') // the destination, on the line that moves it
  })

  it('STILL runs away a worker that never reached ready (the ceiling keeps its teeth)', async () => {
    // The mirror of the test above with the ONE difference that matters: NEITHER
    // witness of delivery — no readyAt AND no commits (makeDeps defaults commits to
    // 0). A worker that has produced nothing and blew the ceiling is a 暴走 —
    // labelled 'runaway', parked in 'blocked', exactly as before. 完了条件 4(後半).
    const engine = newEngine({ workers: [w1()] })
    const now = T0 + 120 * 60_000
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1000]]), // busy — only the ceiling can stop it
    })
    await runDispatchPass(engine, deps, now)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    const log = engine.log.find((l) => l.message.startsWith('worker runaway'))
    expect(log?.level).toBe('warn')
    expect(engine.workers).toHaveLength(0)
    // …and the owner still gets the "split it up and retry, or drop it" question,
    // which IS the right ask for a worker that never produced anything.
    expect(engine.pendingFatal.find((f) => f.event === 'exec-timeout')?.execTimeoutKind).toBe(
      'runaway',
    )
  })

  it('COMMITS ARE NOT DELIVERY — a committing worker that never reached ready still runs away', async () => {
    // The teeth test that matters most, because the obvious "durable witness" is a
    // trap. `commitsAhead > 0` was briefly used as a second witness of delivery and
    // REVERTED on 2026-07-19: workers are INSTRUCTED to commit before declaring
    // ready (「完了ゲートに入る前に必ず WIP コミット」 ships in every /order
    // dispatch), so commits-ahead is the normal state of a working worker, not a
    // mark of completion. Keying on it meant only a worker that had committed
    // literally nothing could ever be called a 暴走.
    //
    // THE SHAPE THAT MUST STAY BLOCKED: a card too big — the worker commits its
    // scaffolding early, then spins in an /order loop until the ceiling. It never
    // reached ready and was never 差し戻し'd, so there is nothing for a commander
    // to integrate; a human has to split the card. Sending it to 'review' instead
    // would also print 「一度 ready に到達したワーカーが、差し戻し後の再作業で…」
    // to the owner about a 差し戻し that never happened.
    const engine = newEngine({ workers: [w1()] })
    expect(engine.workers[0].readyAt).toBeUndefined() // never delivered
    const now = T0 + 120 * 60_000
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 1]]), // …but it DID commit — the normal case, not evidence
      outputs: new Map([['pty-a-1', now - 1000]]), // busy — only the ceiling can stop it
    })

    await runDispatchPass(engine, deps, now)

    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }]) // parked for a human
    expect(deps.tornDown).toHaveLength(1)
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(true)
    expect(engine.pendingFatal.find((f) => f.event === 'exec-timeout')?.execTimeoutKind).toBe(
      'runaway',
    )
    // …and the owner is never told about a delivery or a 差し戻し that never happened.
    const detail = engine.pendingFatal.find((f) => f.event === 'exec-timeout')?.detail ?? ''
    expect(detail).not.toContain('差し戻し後の再作業')
    expect(detail).not.toContain('暴走ではありません')
  })

  it('a KEPT review move still records the delivery (promote decided; only the write failed)', async () => {
    // Route A of the same hole. We reach the kept-move branch only with
    // promote === true — the engine's own strongest delivery statement — but the
    // pre-fix code withheld readyAt until the Board write landed. countCommitsAhead
    // and readHeartbeat are swallowed to 0/null on failure, so one transient read
    // flips promote false on a later pass and the worker meets the ceiling bare.
    const engine = newEngine({ workers: [w1()] })
    const readyAtMs = T0 + 60 * 60_000
    const deps = readyDeps('doing', readyAtMs)
    deps.moveToReview = async () => false // Board write fails → move KEPT

    await runDispatchPass(engine, deps, readyAtMs)

    expect(engine.log.some((l) => l.message.startsWith('review move kept'))).toBe(true)
    expect(engine.workers[0].stage).toBe('running') // not 'done' — the card IS still in doing
    expect(engine.workers[0].readyAt).toBe(new Date(readyAtMs).toISOString()) // …but delivery recorded
    // The wait clock stays SHUT: the card never reached review, so this worker is
    // not idle in 統合待ち and must keep being charged for the time. (The map is
    // created lazily, so "never stamped" reads as undefined, not false.)
    expect(engine.integrationWaitSince?.get('pty-a-1')).toBeUndefined()
  })

  it('BANKS an un-ended wait defensively (an unobserved 差し戻し cannot resurrect the bug)', async () => {
    // The 差し戻し observation is the semantic seam that banks the wait. If any
    // transition were ever missed, the ceiling check's own idempotent
    // endIntegrationWait must bank the still-open stamp before reading the credit
    // — a stale stamp may never push a ready worker over the ceiling. (The credit
    // reader itself is bank-only; this defensive end is what makes that safe.)
    const readyAtMs = T0 + 40 * 60_000
    const engine = newEngine({
      workers: [
        w1({
          stage: 'running',
          readyAt: new Date(readyAtMs).toISOString(),
          reworkAt: new Date(readyAtMs + 5 * 60_000).toISOString(),
        }),
      ],
    })
    engine.integrationWaitSince = new Map([['pty-a-1', readyAtMs]]) // stamped, never ended
    const now = T0 + 120 * 60_000 // alive 120m, 80m of it idle ⇒ 40m worked
    const deps = staleReadyDeps(readyAtMs, now)
    await runDispatchPass(engine, deps, now)
    expect(deps.tornDown).toHaveLength(0)
    expect(engine.integrationWaitMs?.get('pty-a-1')).toBe(80 * 60_000) // banked defensively
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
  })

  it('a 20h queue buys ONE fresh budget, not unlimited runway', async () => {
    // A review card early-continues the monitor, so its worker faces no ceiling, no
    // stall check and no heartbeat check for as long as it sits there. The engine
    // cannot tell an idle waiter from an /order loop still burning tokens, so the
    // question this test has always asked is: what stops the burning one?
    //
    // The answer CHANGED on 2026-07-20 and this test changed with it. It used to be
    // WAIT_CREDIT_CAP_MS: the 差し戻し banked all 20h, only 8h was spendable, and the
    // remaining ~12h of charged time tore the worker down IN THAT PASS. That is the
    // 0720 harm — a worker killed on the pass that asked it to re-work, its worktree
    // removed, having re-worked for zero minutes. The bound is now the re-work budget
    // itself: the queue is excluded rather than charged, and the worker gets exactly
    // ONE MAX_EXEC_MS to do what it was 差し戻し'd for. Bounded, and useful.
    const engine = newEngine({ workers: [w1()] })
    const readyAtMs = T0 + 10 * 60_000
    await runDispatchPass(engine, readyDeps('review', readyAtMs), readyAtMs)

    const reworkMs = readyAtMs + 20 * 60 * 60_000 // sits in review for 20 HOURS…
    const deps = readyDeps('doing', reworkMs)
    await runDispatchPass(engine, deps, reworkMs)

    expect(engine.integrationWaitMs?.get('pty-a-1')).toBe(20 * 60 * 60_000) // banked…
    expect(deps.tornDown).toHaveLength(0) // …but NOT spent as a reason to kill it
    expect(engine.workers[0].stage).toBe('running') // it is re-working

    // …and the runway really is bounded: 91m into the RE-WORK it is stopped.
    const late = reworkMs + 91 * 60_000
    const deps2 = staleReadyDeps(readyAtMs, late)
    await runDispatchPass(engine, deps2, late)
    expect(deps2.tornDown).toHaveLength(1) // ONE budget, not unlimited
    // …and because it HAD delivered, it is still not a 暴走 and still not blocked.
    expect(deps2.recovered).toHaveLength(0)
    expect(deps2.board.get('a')?.boardColumn).toBe('review')
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(false)
  })

  it('a LONG queue never narrates a 差し戻し that did not happen (63h weekend review)', async () => {
    // The cap has a wording consequence the first version got wrong. A ready worker
    // reaches the ceiling two ways, and `readyAt` cannot tell them apart: 差し戻し'd
    // then burned the budget re-working, or simply queued past the cap having
    // re-worked NOTHING. A careful Friday-night→Monday-morning review is enough to
    // hit the second. Keying the words on `readyAt` billed 55 hours of weekend queue
    // as 実作業 and told the owner about a 手直し that never occurred.
    // 2026-07-20 made the fiction IMPOSSIBLE rather than merely well-worded. The
    // old shape was: 差し戻し observed → torn down in the same pass → now describe a
    // stop whose re-work lasted zero minutes without implying a 手直し. There is no
    // such stop any more, because the queue is excluded from the clock instead of
    // charged to it. So this test now pins the stronger property: after a 63-hour
    // weekend review the 差し戻し produces NO exec-timeout narration at all, and the
    // stop that eventually comes is a real, honestly-named re-work overrun.
    const engine = newEngine({ workers: [w1()] })
    const readyAtMs = T0 + 10 * 60_000
    await runDispatchPass(engine, readyDeps('review', readyAtMs), readyAtMs)

    const reworkMs = readyAtMs + 63 * 60 * 60_000 // queued for 63 hours, then 差し戻し
    const deps = readyDeps('doing', reworkMs)
    await runDispatchPass(engine, deps, reworkMs)

    // Nothing to narrate: no stop, so no story about one. 55 hours of weekend queue
    // can no longer be billed as 実作業 because they never reach the clock.
    expect(deps.tornDown).toHaveLength(0)
    expect(engine.pendingFatal.filter((f) => f.event === 'exec-timeout')).toEqual([])
    expect(engine.log.some((l) => l.message.includes('LONG integration queue'))).toBe(false)
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(false)

    // When it IS eventually stopped, the words match what happened: a re-work that
    // really did run 95m, not a queue and not a 暴走.
    const late = reworkMs + 95 * 60_000
    const deps2 = staleReadyDeps(readyAtMs, late)
    await runDispatchPass(engine, deps2, late)
    expect(deps2.recovered).toHaveLength(0) // never blocked
    expect(deps2.board.get('a')?.boardColumn).toBe('review')
    const fatal = engine.pendingFatal.find((f) => f.event === 'exec-timeout')
    expect(fatal?.execTimeoutKind).toBe('integration-wait')
    expect(fatal?.execTimeoutShape).toBe('rework') // it really did re-work
    expect(fatal?.detail).toContain('差し戻し後の再作業')
    // …and the 63h queue is named as EXCLUDED, never as a credit that was spent —
    // a subtraction the judgement did not perform must not appear as one.
    expect(fatal?.detail).not.toContain('原因は待ち時間であって作業ではありません')
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(false)
  })

  it('a KEPT promote that later overruns does not claim a 差し戻し either', async () => {
    // The other route to a readyAt with no 差し戻し: promote was decided but the
    // Board write was kept, so readyAt is stamped while the worker stays 'running'
    // and its card never leaves 'doing'. A later transient countCommitsAhead
    // failure drops the promote and it meets the ceiling — having never been in
    // review, let alone 差し戻し'd. (This also falsifies the old invariant comment
    // that readyAt is only ever stamped on the way to stage:'done'.)
    const engine = newEngine({ workers: [w1()] })
    const keptMs = T0 + 20 * 60_000
    const kept = readyDeps('doing', keptMs)
    kept.moveToReview = async () => false
    await runDispatchPass(engine, kept, keptMs)
    expect(engine.workers[0].readyAt).toBeDefined()
    expect(engine.workers[0].reworkAt).toBeUndefined()

    // Later: no commits visible (transient read failure) ⇒ no promote ⇒ ceiling.
    const now = T0 + 120 * 60_000
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1000]]),
    })
    await runDispatchPass(engine, deps, now)

    const fatal = engine.pendingFatal.find((f) => f.event === 'exec-timeout')
    expect(fatal?.execTimeoutShape).toBe('work')
    expect(fatal?.detail).not.toContain('差し戻し後の再作業')
    // …and it must not swing to the OTHER fiction either: this worker waited zero
    // minutes (its card never left 'doing'), so blaming the ceiling on queue time
    // would be just as false. It really did work the whole 120m.
    expect(fatal?.detail).not.toContain('原因は待ち時間であって作業ではありません')
    expect(fatal?.detail).toContain('待ち時間が原因ではありません')
    expect(fatal?.detail).toContain('未検証') // tip was cut off mid-work
  })

  it('the TWO journal lines of one stop never contradict each other', async () => {
    // 02章 §5.6 requires that the ceiling line and recoverLost's recovery line say
    // the SAME thing. The recovery verb was derived from `reason` alone, so the
    // 63-hour case printed 「上限の原因は待ち時間であって作業ではない」 on one line
    // and 「差し戻し後の再作業で作業上限に到達」 on the next.
    // Driven through the KEPT-promote route, which is where a non-'rework' shape
    // still reaches the ceiling: promote was decided but the Board write was kept,
    // so `readyAt` is stamped while the card never leaves 'doing' and no 差し戻し
    // ever happens. The stop is therefore shape 'work', and BOTH lines must say so.
    const engine = newEngine({ workers: [w1()] })
    const keptMs = T0 + 20 * 60_000
    const kept = readyDeps('doing', keptMs)
    kept.moveToReview = async () => false
    await runDispatchPass(engine, kept, keptMs)
    expect(engine.workers[0].readyAt).toBeDefined()
    expect(engine.workers[0].reworkAt).toBeUndefined() // no 差し戻し in this story

    const now = T0 + 120 * 60_000
    await runDispatchPass(
      engine,
      makeDeps({ cards: [card('a', { boardColumn: 'doing' })], outputs: new Map([['pty-a-1', now - 1000]]) }),
      now,
    )

    const lines = engine.log.map((l) => l.message)
    expect(lines.some((m) => m.includes('REAL WORK'))).toBe(true) // the ceiling line
    // Matched on the VERB, not on '— card → review': the ceiling line carries that
    // phrase too, so a looser predicate silently asserts the same line twice.
    const recovery = lines.find((m) => m.startsWith('worker 実作業が作業上限に到達'))
    expect(recovery).toBeDefined() // …and the recovery line agrees
    expect(recovery).toContain('card → review')
    // neither line may narrate a 差し戻し that never happened
    expect(lines.filter((m) => m.includes('差し戻し後の再作業で作業上限に到達'))).toEqual([])
    expect(lines.filter((m) => m.includes('LONG integration queue'))).toEqual([])
  })

  it('a SHORT wait under the cap is not blamed for the ceiling (MF2 — the common case)', async () => {
    // The predicate 「上限の原因は待ち時間」 was keyed on rawWaited > 0, which does
    // not mean the cap truncated anything. This shape is STRUCTURALLY common, not
    // rare: the tick is 3s, so a worker 差し戻し'd while already near the ceiling
    // crosses it inside the first minute and lands in reworkedMs < 60_000. It then
    // announced 「waited 20m, only 480m creditable … 上限の原因は待ち時間であって
    // 作業ではない」 — 20 < 480, nothing was truncated, and the 90 minutes were real
    // work. The honest predicate is rawWaited > WAIT_CREDIT_CAP_MS.
    // Driven through the KEPT-promote route (readyAt stamped, card never left
    // 'doing', no 差し戻し). Since 2026-07-20 that is the shape a sub-cap wait can
    // still reach the ceiling in: a worker judged from its 差し戻し never carries
    // the queue on its clock at all, so the mis-blame this test guards against
    // cannot arise there by construction.
    const now = T0 + 110 * 60_000 // alive 110m
    const readyAtMs = T0 + 89 * 60_000 + 59_000
    const engine = newEngine({
      workers: [w1({ stage: 'running', readyAt: new Date(readyAtMs).toISOString() })],
    })
    engine.integrationWaitMs = new Map([['pty-a-1', 20 * 60_000]]) // 20m banked, cap is 480m
    // 110m alive − 20m credited = 90m worked ⇒ the ceiling fires on real work.
    // No commits / no heartbeat visible (a transient read failure) so the promote
    // is dropped and the pass reaches the ceiling instead of re-promoting.
    const deps2 = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1000]]),
    })
    await runDispatchPass(engine, deps2, now)

    const fatal = engine.pendingFatal.find((f) => f.event === 'exec-timeout')
    expect(fatal?.execTimeoutShape).toBe('work') // NOT 'capped-wait' — nothing was cut
    expect(fatal?.detail).toContain('待ち時間が原因ではありません')
    expect(fatal?.detail).not.toContain('控除できるのは上限')
    // the journal must not blame the queue either
    expect(engine.log.some((l) => l.message.includes('LONG integration queue'))).toBe(false)
    expect(engine.log.some((l) => l.message.includes('REAL WORK'))).toBe(true)
  })

  it('a PERMANENTLY rejected review write never escalates the card to blocked', async () => {
    // The central promise of this card, and it had no teeth: deleting
    // `&& reason !== 'integration-wait'` from the move-stuck escalation left all
    // 581 tests green. Without it, a Board write that keeps failing walks the retry
    // counter past MOVE_STUCK_MAX_RETRIES and then calls recoverCard('blocked') —
    // putting a READY worker's card in the owner's column, which is the 0718 harm
    // arriving through the back door. The existing harness could not reach this:
    // `reviewFails` fails only the FIRST write, so the counter never got past 1.
    const readyAtMs = T0 + 80 * 60_000
    const engine = newEngine({
      workers: [
        w1({ readyAt: new Date(readyAtMs).toISOString(), reworkAt: new Date(T0 + 105 * 60_000).toISOString() }),
      ],
    })
    engine.integrationWaitMs = new Map([['pty-a-1', 25 * 60_000]])

    // Walk well past MOVE_STUCK_MAX_RETRIES (5) with the write rejected every time.
    // 200m puts the RE-WORK itself (差し戻し at 105m) 95m past its own budget — the
    // overrun has to be a real overrun since 2026-07-20.
    let now = T0 + 200 * 60_000
    for (let i = 0; i < 9; i++) {
      const deps = makeDeps({
        cards: [card('a', { boardColumn: 'doing' })],
        commits: new Map([['a', 3]]),
        heartbeats: new Map([['a', { ready: true, blocked: false, at: new Date(readyAtMs).toISOString() }]]),
        outputs: new Map([['pty-a-1', now - 1000]]),
        reviewAlwaysFails: new Set(['a']),
      })
      await runDispatchPass(engine, deps, now)
      // NEVER parked in the owner's column, however many times the write is kept.
      expect(deps.recovered).toEqual([])
      expect(deps.board.get('a')?.boardColumn).toBe('doing')
      now += 60_000
    }
    // The retry budget really was exceeded — this test would pass vacuously if the
    // counter had never advanced past the escalation threshold.
    expect(engine.stuckMoves.get('a')?.attempts).toBeGreaterThan(MOVE_STUCK_MAX_RETRIES)
    expect(engine.stuckMoves.get('a')?.intent).toBe('recover-review')
  })

  it('a KEPT recovery RETRY keeps its shape — the retry must not invent a 再作業', async () => {
    // The retry rebuilds the recovery from scratch on a later pass. It restored the
    // intent (so the card still avoids 'blocked') but NOT the shape, so a
    // 'capped-wait' / 'work' stop fell back to the default verb and logged
    // 「差し戻し後の再作業で作業上限に到達」 right after a line saying 「再作業 0m」.
    // 20h banked against the 8h cap ⇒ 'capped-wait'; no 差し戻し ⇒ not 'rework'.
    // (Since 2026-07-20 a 差し戻し'd worker is judged from the 差し戻し, so the
    // ledger cannot be what stops it — this shape now belongs to a roster entry
    // whose card never left 'doing'. The point under test is unchanged: whatever
    // the shape is, the RETRY must carry it rather than fall back to the default.)
    const now = T0 + 600 * 60_000 // alive 600m − 480m credited = 120m worked ⇒ ceiling
    const readyAtMs = T0 + 10 * 60_000
    const engine = newEngine({ workers: [w1({ readyAt: new Date(readyAtMs).toISOString() })] })
    engine.integrationWaitMs = new Map([['pty-a-1', 20 * 60 * 60_000]])

    // Pass 1: over the ceiling, but the doing→review write is REJECTED. No commits
    // / heartbeat visible, so the promote is dropped and the ceiling is reached.
    const kept = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1000]]),
      reviewFails: new Set(['a']),
    })
    await runDispatchPass(engine, kept, now)
    expect(engine.stuckMoves.get('a')?.intent).toBe('recover-review')
    expect(engine.stuckMoves.get('a')?.shape).toBe('capped-wait') // carried, not just the intent

    // Pass 2: PTY gone (torn down in pass 1) ⇒ the !alive retry rebuilds it.
    const before = engine.log.length // only the RETRY pass's lines are under test
    // No commits visible (the same transient read failure as pass 1) so the dead
    // worker takes the RETRY path rather than being promoted outright — while its
    // heartbeat still says ready, which is exactly the stale sign that must not
    // send the card to 'blocked'.
    const retry = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      heartbeats: new Map([['a', { ready: true, blocked: false, at: new Date(readyAtMs).toISOString() }]]),
      dead: new Set(['a']),
    })
    await runDispatchPass(engine, retry, now + 60_000)

    const emitted = engine.log.slice(before).map((l) => l.message)
    const recovery = emitted.find((m) => m.includes('— card → '))
    expect(recovery).toBeDefined()
    expect(recovery).toContain('統合待ちが控除上限を超過')
    expect(emitted.filter((m) => m.includes('差し戻し後の再作業'))).toEqual([]) // the invented one
  })

  it('DELIVERED counts the done column too, not just review', async () => {
    // The early-continue treats a card the commander pushed straight past review to
    // 'done' as delivered. Untested until now: narrowing it to 'review' alone left
    // every other test green, while a later 差し戻し of such a card would arrive with
    // no readyAt and be labelled a 暴走.
    const engine = newEngine({ workers: [w1()] })
    const at = T0 + 30 * 60_000
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'done' })],
      commits: new Map([['a', 3]]),
      heartbeats: new Map([['a', { ready: true, blocked: false, at: new Date(at - 1000).toISOString() }]]),
      outputs: new Map([['pty-a-1', at - 1000]]),
    })
    await runDispatchPass(engine, deps, at)

    expect(deps.reviews).toEqual([]) // already past review — no promote
    expect(engine.workers[0].stage).toBe('done')
    expect(engine.workers[0].readyAt).toBe(new Date(at).toISOString()) // delivered
    expect(engine.integrationWaitSince?.get('pty-a-1')).toBe(at) // and the clock runs
  })

  it('a REAL 差し戻し still says so (the wording split must not silence the true case)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const readyAtMs = T0 + 30 * 60_000
    await runDispatchPass(engine, readyDeps('review', readyAtMs), readyAtMs)
    const reworkMs = readyAtMs + 20 * 60_000
    await runDispatchPass(engine, readyDeps('doing', reworkMs), reworkMs) // 差し戻し観測
    expect(engine.workers[0].reworkAt).toBeDefined()

    const now = reworkMs + 100 * 60_000 // genuinely re-works past the ceiling
    const deps = staleReadyDeps(readyAtMs, now)
    await runDispatchPass(engine, deps, now)

    const fatal = engine.pendingFatal.find((f) => f.event === 'exec-timeout')
    expect(fatal?.execTimeoutShape).toBe('rework')
    expect(fatal?.detail).toContain('差し戻し後の再作業')
    expect(fatal?.detail).toContain('未検証') // its tip really was cut off mid-flight
  })

  it('a wait UNDER the cap is still forgiven whole (an ordinary overnight review)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const readyAtMs = T0 + 30 * 60_000
    await runDispatchPass(engine, readyDeps('review', readyAtMs), readyAtMs)
    const reworkMs = readyAtMs + 6 * 60 * 60_000 // 6h — under the 8h default cap
    await runDispatchPass(engine, readyDeps('doing', reworkMs), reworkMs)

    // 6h30m alive, 6h credited ⇒ 30m worked ⇒ nowhere near the ceiling.
    const now = reworkMs + 60_000
    const deps = staleReadyDeps(readyAtMs, now)
    await runDispatchPass(engine, deps, now)
    expect(deps.tornDown).toHaveLength(0)
    expect(engine.workers[0].stage).toBe('running')
  })

  it('ACCUMULATES across repeated ready↔差し戻し rounds (each wait is banked once)', async () => {
    const engine = newEngine({ workers: [w1()] })
    // Round 1: ready at 20m, reworked at 50m ⇒ 30m banked.
    await runDispatchPass(engine, readyDeps('doing', T0 + 20 * 60_000), T0 + 20 * 60_000)
    await runDispatchPass(engine, readyDeps('doing', T0 + 50 * 60_000), T0 + 50 * 60_000)
    expect(engine.integrationWaitMs?.get('pty-a-1')).toBe(30 * 60_000)
    const firstReadyAt = engine.workers[0].readyAt
    // Round 2: ready again at 60m (a FRESH heartbeat clears the rework suppression),
    // reworked again at 75m ⇒ +15m.
    await runDispatchPass(engine, readyDeps('doing', T0 + 60 * 60_000), T0 + 60 * 60_000)
    await runDispatchPass(engine, readyDeps('doing', T0 + 75 * 60_000), T0 + 75 * 60_000)
    expect(engine.integrationWaitMs?.get('pty-a-1')).toBe(45 * 60_000)
    expect(engine.workers[0].readyAt).toBe(firstReadyAt) // stamped ONCE — "has ever delivered"
  })

  it('keeps the card OUT of blocked even when the review move is KEPT and retried', async () => {
    // The Board write can fail. When it does, recoverLost keeps the worker so the
    // next pass retries — and that retry must NOT silently become a 'crash'
    // recovery, whose stale `ready` heartbeat would send the card to 'blocked'
    // (the very harm this reason exists to prevent), nor escalate there past the
    // move-stuck budget.
    const readyAtMs = T0 + 80 * 60_000
    const engine = newEngine({
      workers: [
        w1({
          readyAt: new Date(readyAtMs).toISOString(),
          reworkAt: new Date(T0 + 105 * 60_000).toISOString(),
        }),
      ],
    })
    engine.integrationWaitMs = new Map([['pty-a-1', 25 * 60_000]])
    const now = T0 + 200 * 60_000 // the RE-WORK (差し戻し at 105m) is 95m over its own budget

    // Pass 1: over the ceiling, but the doing→review write is REJECTED.
    const deps1 = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 3]]),
      heartbeats: new Map([['a', { ready: true, blocked: false, at: new Date(readyAtMs).toISOString() }]]),
      outputs: new Map([['pty-a-1', now - 1000]]),
      reviewFails: new Set(['a']), // the FIRST review move is kept
    })
    await runDispatchPass(engine, deps1, now)
    expect(deps1.recovered).toHaveLength(0) // kept ≠ parked
    expect(deps1.board.get('a')?.boardColumn).toBe('doing') // still stuck in doing
    expect(engine.workers).toHaveLength(1) // worker KEPT so the move retries
    expect(engine.stuckMoves.get('a')?.attempts).toBe(1)

    // Pass 2: the PTY is gone (torn down in pass 1) and the heartbeat file still
    // says ready. The retry must land the card in REVIEW, not blocked.
    const deps2 = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 3]]),
      heartbeats: new Map([['a', { ready: true, blocked: false, at: new Date(readyAtMs).toISOString() }]]),
      dead: new Set(['a']),
    })
    await runDispatchPass(engine, deps2, now + 60_000)
    expect(deps2.recovered).toHaveLength(0) // never 'blocked'
    expect(deps2.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(deps2.board.get('a')?.boardColumn).toBe('review')
  })

  it('drops the ledger when the worker leaves the live set (no map leak)', async () => {
    const engine = newEngine({ workers: [w1()] })
    engine.integrationWaitSince = new Map([['pty-gone', 1], ['pty-a-1', T0]])
    engine.integrationWaitMs = new Map([['pty-gone', 99], ['pty-a-1', 5]])
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], outputs: new Map([['pty-a-1', T0]]) })
    await runDispatchPass(engine, deps, T0 + 60_000)
    expect(engine.integrationWaitSince?.has('pty-gone')).toBe(false)
    expect(engine.integrationWaitMs?.has('pty-gone')).toBe(false)
    expect(engine.integrationWaitMs?.has('pty-a-1')).toBe(true) // the live one keeps its ledger
  })
})

describe('runDispatchPass — monitor: 差し戻し gives the RE-WORK its own budget (2026-07-20)', () => {
  // 2026-07-20, TWO workers destroyed 150–250ms apart. Both were ready and
  // queued overnight; the commander 差し戻し'd them and the very next lines were
  // 「worker runaway — worked 478m >= 90m execution limit」 → stopped → worktree
  // physically removed → card parked in 'blocked'. Zero minutes of re-work.
  //
  // The emitting binary was ~2 days stale (its 「0m of rate-limit hold credited
  // back」 phrasing existed only 2026-07-12→07-18, before the 統合待ち ledger),
  // so the 07-18 credit fix was never loaded in that process. But the SOURCE was
  // not innocent: crediting the wait only changes the LABEL and the card's
  // destination. The worker is stopped and its worktree torn down either way —
  // the ceiling ran from `startedAt`, so a worker 差し戻し'd near its ceiling
  // crossed it on the SAME pass that observed the 差し戻し. These tests pin the
  // thing the credit never covered: a 差し戻し is a NEW assignment and must come
  // with a budget to actually do it.
  const T0 = Date.parse('2026-07-20T18:00:00Z')
  const startedAt = new Date(T0).toISOString()
  const readyAtMs = T0 + 60 * 60_000 // delivered 60m in…
  const now = T0 + 478 * 60_000 // …then queued overnight — the incident's 478m
  const w1 = (over: Partial<OrchestratorWorker> = {}) =>
    worker({
      terminalId: 'pty-a-1',
      branch: 'swarm/a',
      worktree: '/wt/a',
      taskId: 'a',
      taskTitle: 'task a',
      startedAt,
      stage: 'done', // ready, sitting in the commander's queue
      ...over,
    })
  /** The 差し戻し probe shape: card back in 'doing', PTY busy, and the heartbeat
   *  file still holding the PRE-rework ready:true (the engine cannot clear it, so
   *  the re-promote suppression drops the promote and the worker falls THROUGH to
   *  the execution-ceiling check — the incident path). */
  const reworkDeps = (at: number, over: Partial<Parameters<typeof makeDeps>[0]> = {}) =>
    makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 3]]),
      heartbeats: new Map([['a', { ready: true, blocked: false, at: new Date(readyAtMs).toISOString() }]]),
      outputs: new Map([['pty-a-1', at - 1000]]),
      ...over,
    })

  it('REPLAYS the incident: 差し戻し at 478m alive ⇒ NOT stopped, worktree SURVIVES', async () => {
    // The engine's own ledger is EMPTY — which is the realistic state, not a
    // contrived one: it is in-memory and poll-observed, so a restart, a blind
    // spot, or (as here) an engine running older code leaves nothing banked.
    // The fix must not depend on it.
    const engine = newEngine({ workers: [w1({ readyAt: new Date(readyAtMs).toISOString() })] })
    expect(engine.integrationWaitMs?.get('pty-a-1')).toBeUndefined() // 「0m credited back」

    const deps = reworkDeps(now)
    await runDispatchPass(engine, deps, now)

    // The 差し戻し IS observed — this test must not pass by missing that path.
    expect(engine.log.some((l) => l.message.includes('差し戻し(review→doing)を観測'))).toBe(true)
    // …and the worker is left alone to actually do the re-work.
    expect(deps.tornDown).toHaveLength(0) // THE HARM: the worktree survives
    expect(deps.recovered).toHaveLength(0) // card never parked in 'blocked'
    expect(deps.board.get('a')?.boardColumn).toBe('doing')
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
    expect(engine.pendingFatal.some((f) => f.event === 'exec-timeout')).toBe(false)
    expect(engine.workers).toHaveLength(1)
    expect(engine.workers[0].stage).toBe('running') // back at work on the 差し戻し
  })

  it('survives even with NO readyAt — the durable witness is the worker’s own ready heartbeat', async () => {
    // `readyAt` is a POLL OBSERVATION: it exists only if the engine happened to be
    // watching when the card passed through review, and it does not survive a
    // restart. A worker that delivered while the engine was blind arrives here
    // BARE and was labelled 暴走 → card to the owner's 'blocked' column → worktree
    // destroyed. Its own heartbeat file is the durable record of the delivery, and
    // it outlives the engine. (NOT commitsAhead — workers are told to commit
    // before declaring ready, so commits are the normal state of a WORKING worker;
    // that witness was tried and reverted 2026-07-19.)
    const engine = newEngine({ workers: [w1()] }) // no readyAt at all
    expect(engine.workers[0].readyAt).toBeUndefined()

    const deps = reworkDeps(now)
    await runDispatchPass(engine, deps, now)

    expect(engine.log.some((l) => l.message.includes('差し戻し(review→doing)を観測'))).toBe(true)
    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(false)
    expect(deps.tornDown).toHaveLength(0)
    expect(deps.recovered).toHaveLength(0)
    expect(engine.workers[0].stage).toBe('running')
  })

  it('KEEPS ITS TEETH: a re-work that blows its OWN budget is still stopped', async () => {
    // The fresh budget is a budget, not an exemption. A worker that has been
    // re-working past MAX_EXEC_MS SINCE the 差し戻し is stopped — under
    // 'integration-wait' (it did deliver once) with shape 'rework', so its card
    // goes to the commander's 'review', not the owner's 'blocked'.
    const engine = newEngine({
      workers: [
        w1({
          stage: 'running', // already re-working (差し戻し observed on an earlier pass)
          readyAt: new Date(readyAtMs).toISOString(),
          reworkAt: new Date(now - 95 * 60_000).toISOString(), // 95m of re-work
        }),
      ],
    })
    const deps = reworkDeps(now)
    await runDispatchPass(engine, deps, now)

    expect(deps.tornDown).toHaveLength(1) // the ceiling still bites
    const fatal = engine.pendingFatal.find((f) => f.event === 'exec-timeout')
    expect(fatal?.execTimeoutKind).toBe('integration-wait') // not 暴走 — it delivered
    expect(fatal?.execTimeoutShape).toBe('rework')
    expect(deps.recovered).toHaveLength(0) // never the owner's 'blocked' column
    expect(deps.board.get('a')?.boardColumn).toBe('review')
  })

  it('does NOT fail open: a BARE worker dragged review→doing gets no fresh budget', async () => {
    // The guard that keeps the fresh budget from becoming immortality. Anyone can
    // drag a card through 'review'; that is a CLAIM, not a delivery. A worker with
    // nothing on its branch and no ready heartbeat must still be a 暴走 — otherwise
    // one drag buys a fresh 90m, every time, for a worker that has produced nothing.
    const engine = newEngine({ workers: [w1()] }) // stage 'done' via the bare claim
    const deps = reworkDeps(now, {
      commits: new Map([['a', 0]]), // nothing on the branch…
      heartbeats: new Map(), // …and no ready heartbeat
    })
    await runDispatchPass(engine, deps, now)

    expect(engine.log.some((l) => l.message.includes('runaway'))).toBe(true)
    expect(deps.tornDown).toHaveLength(1)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
  })

  it('does NOT fail open on a ready HEARTBEAT alone — a 0-commit worker never 差し戻し’d is still a 暴走', async () => {
    // The MIRROR of 'survives even with NO readyAt', with the single difference
    // that decides fail-open: this worker was NEVER 差し戻し'd (no reworkAt). Its
    // ready heartbeat is a bare premature claim — 0 commits, nothing delivered — so
    // the ceiling's heartbeat witness is REFUSED. That witness is GATED on reworkAt
    // for exactly this reason: a delivery the engine can trust is one a human
    // corroborated by sending the card back for more, not one the worker asserted
    // about an empty branch. Ungated (stamp on any ready heartbeat), the loose
    // stamp would label THIS 'integration-wait' → review; the commander reverts
    // (finds nothing), and now readyAt + a fresh reworkAt hand it an unlimited
    // re-work budget every round — a worker that produced NOTHING running forever
    // and telling the owner 「統合可能な成果を一度出しています」 about an empty branch.
    //
    // Mutation-checked (2026-07-21): dropping the `w.reworkAt &&` guard flips this
    // to 'integration-wait' → 'review' and turns all four ceiling assertions red,
    // while the rest of the file stays green — it is the only thing holding it.
    const engine = newEngine({ workers: [w1({ stage: 'running' })] }) // still working, never delivered
    expect(engine.workers[0].readyAt).toBeUndefined()
    expect(engine.workers[0].reworkAt).toBeUndefined()
    const deps = reworkDeps(now, {
      cards: [card('a', { boardColumn: 'doing' })], // never routed through review → no 差し戻し observed
      commits: new Map([['a', 0]]), // …nothing on the branch, only a premature ready claim
    })
    await runDispatchPass(engine, deps, now)

    // No 差し戻し was observed (the card never left 'doing' for review), and the
    // bare ready is refused, so the worker stays a 暴走 → the owner's 'blocked'.
    expect(engine.log.some((l) => l.message.includes('差し戻し(review→doing)を観測'))).toBe(false)
    expect(engine.log.some((l) => l.message.startsWith('worker runaway'))).toBe(true)
    expect(deps.tornDown).toHaveLength(1)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    const fatal = engine.pendingFatal.find((f) => f.event === 'exec-timeout')
    expect(fatal?.execTimeoutKind).toBe('runaway')
    expect(fatal?.detail).not.toContain('統合可能な成果を一度出しています')
  })
})

describe('runDispatchPass — monitor: permission/trust prompt (silence-gated)', () => {
  const T0 = Date.parse('2026-06-25T00:00:00Z')
  const startedAt = new Date(T0).toISOString()
  const w1 = () =>
    worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt })

  it('AUTO-ACCEPTS a trust prompt (Enter) once the worker is silent — and holds, does not reclaim', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Do you trust the files in this folder? 1. Yes, proceed']]),
      // no output/heartbeat → silent past STALL_SILENCE_MS
    })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1) // silent + 0 commits
    expect(deps.nudged).toEqual(['pty-a-1']) // Enter takes the default 'Yes'
    expect(deps.tornDown).toHaveLength(0) // give the accept a chance
    expect(engine.permissionWaits.get('pty-a-1')?.accepted).toBe(true)
    expect(engine.workers).toHaveLength(1)
    const log = engine.log.find((l) => l.message.startsWith('worker permission/trust prompt'))
    expect(log?.level).toBe('warn')
  })

  it('PARKS in blocked if still prompting past PERMISSION_WAIT_GRACE_MS (bypass is broken)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Do you trust the files in this folder?']]),
    })
    const t1 = T0 + STALL_SILENCE_MS + 1
    await runDispatchPass(engine, deps, t1) // silent → auto-accept, stamp since=t1
    expect(deps.nudged).toHaveLength(1)
    await runDispatchPass(engine, deps, t1 + PERMISSION_WAIT_GRACE_MS + 1) // still stuck
    expect(deps.nudged).toHaveLength(1) // not auto-accepted twice
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }]) // park, don't loop to todo
    expect(engine.permissionWaits.has('pty-a-1')).toBe(false)
    expect(engine.workers).toHaveLength(0)
  })

  it('does NOT act on a STREAMING worker whose screen merely mentions a prompt (silence gate)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const now = T0 + STALL_SILENCE_MS + 1 // old by wall-clock, but…
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 1000]]), // …actively emitting → NOT silent
      screens: new Map([['pty-a-1', 'Do you trust the files in this folder? — (the string I am editing)']]),
    })
    await runDispatchPass(engine, deps, now)
    expect(deps.nudged).toHaveLength(0) // NOT auto-accepted (still working)
    expect(deps.tornDown).toHaveLength(0) // NOT reclaimed
    expect(engine.permissionWaits.has('pty-a-1')).toBe(false)
    expect(engine.workers[0].stage).toBe('running')
  })

  it('does NOT treat a trust prompt as permission-wait when the worker has committed work (→ stall path)', async () => {
    // commitsAhead>0 means it already did real work — not stuck at a boot dialog.
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 2]]),
      screens: new Map([['pty-a-1', 'Do you trust the files in this folder?']]),
    })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1) // silent
    // Falls through to the ordinary stall path → NUDGED (not the permission branch).
    expect(engine.permissionWaits.has('pty-a-1')).toBe(false)
    expect(deps.nudged).toEqual(['pty-a-1']) // stall nudge, not permission auto-accept
    expect(engine.nudges.get('pty-a-1')?.count).toBe(1)
    const log = engine.log.find((l) => l.message.startsWith('worker stalled'))
    expect(log?.kind).toBe('stall')
  })
})

// ── runDispatchPass — monitor: free-text QUESTION (C3) ──────────────────────────
// A worker whose `claude` asked the owner a free-text question and now idles at an
// empty input box is HELD (never nudged/reclaimed — a bare Enter is pointless and a
// respawn re-asks) and its question is raised ONCE to the T3 inbox (the S4 THROTTLED
// degradation until C-core's brain pass). The dangerous direction is a false POSITIVE
// (injecting into a live PTY), so the negative controls here are load-bearing.

describe('runDispatchPass — monitor: free-text question (C3)', () => {
  const T0 = Date.parse('2026-06-25T00:00:00Z')
  const startedAt = new Date(T0).toISOString()
  const RULE = '─'.repeat(100)
  const w1 = () =>
    worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt })
  // A live-faithful idle question frame (see swarmQuestions.test.ts for provenance).
  const questionScreen = [
    '⏺ 質問がひとつあります。',
    '  どのデータベースを使いますか？',
    '✻ Brewed for 7s',
    RULE,
    '❯ ',
    RULE,
    '  ? for shortcuts · ← for agents',
  ].join('\n')

  it('HOLDS a questioning worker — never nudged, never reclaimed — and raises it ONCE', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', questionScreen]]),
    })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(deps.nudged).toHaveLength(0) // Enter is pointless at an empty box
    expect(deps.tornDown).toHaveLength(0) // work preserved; never reclaimed
    expect(deps.recovered).toHaveLength(0)
    expect(engine.workers).toHaveLength(1) // still held
    expect(deps.raised).toHaveLength(1)
    expect(deps.raised[0].question).toContain('どのデータベースを使いますか？')
    expect(deps.raised[0].terminalId).toBe('pty-a-1')
    expect(deps.raised[0].branch).toBe('swarm/a')
    expect(deps.raised[0].taskId).toBe('a')
    expect(engine.questionRaised?.has('pty-a-1')).toBe(true)
    const log = engine.log.find((l) => l.message.startsWith('worker asked a free-text question'))
    expect(log?.level).toBe('warn')

    // A second pass on the SAME question does not re-raise (idempotent).
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 2)
    expect(deps.raised).toHaveLength(1)
  })

  it('raises anew when the worker asks a DIFFERENT question (fresh receiptKey)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const screens = new Map([['pty-a-1', questionScreen]])
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], screens })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(deps.raised).toHaveLength(1)
    // The worker now asks something else.
    screens.set(
      'pty-a-1',
      ['⏺ 別の確認です。', '  この API は公開して良いですか？', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n'),
    )
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 2)
    expect(deps.raised).toHaveLength(2)
    expect(deps.raised[1].question).toContain('公開して良いですか？')
  })

  it('MF1 (overseer OFF): raises a blocked worker\'s question HERE — with no armed overseer S4 nothing else raises it, so the old unconditional suppression DROPPED it', async () => {
    const engine = newEngine({ workers: [w1()] })
    // engine.overseer.enabled defaults false (initOverseerRuntime) → no S4 to defer to
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', questionScreen]]),
      heartbeats: new Map([['a', { ready: false, blocked: true, phase: 'blocked' }]]),
    })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(deps.raised).toHaveLength(1) // overseer off → raise here or the question is lost
    expect(deps.nudged).toHaveLength(0) // still held, not nudged
    expect(engine.workers).toHaveLength(1)
  })

  it('MF1 (overseer ON): the engine arm does NOT raise a blocked worker\'s question — the armed overseer S4 owns that raise (its receiptKey is the heartbeat text vs this arm\'s scraped question, so raising in BOTH would double-open the inbox)', async () => {
    const engine = newEngine({ workers: [w1()] })
    engine.overseer.enabled = true // arm the overseer → S4 (tick loop) owns blocked-worker raises
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', questionScreen]]),
      heartbeats: new Map([['a', { ready: false, blocked: true, phase: 'blocked' }]]),
    })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(deps.raised).toHaveLength(0) // engine arm defers to S4 (run by the tick loop, not this pass)
    expect(engine.questionRaised?.has('pty-a-1')).toBe(false) // the arm suppressed its own raise
    expect(engine.workers).toHaveLength(1) // still held
  })

  it('MF2: PARKS a held question in blocked once it exceeds QUESTION_GRACE_MS (no 90-min slot squat on an unanswered / courtesy question)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', questionScreen]]),
    })
    // first sight: raise + HOLD (stamp the question grace clock) — NOT parked yet
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(deps.raised).toHaveLength(1)
    expect(deps.recovered).toHaveLength(0)
    expect(engine.workers).toHaveLength(1)
    // still idling at the question past the grace window ⇒ PARK in 'blocked'
    // (the raised question persists in the inbox; the slot is freed).
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1 + QUESTION_GRACE_MS + 1)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
  })

  it('re-raises next pass when the raise itself fails (key forgotten, not stuck)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', questionScreen]]),
      raiseFails: true,
    })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(engine.questionRaised?.has('pty-a-1')).toBe(false) // forgotten for retry
    expect(engine.workers).toHaveLength(1) // the hold is unaffected by the raise fault
    const log = engine.log.find((l) => l.message.startsWith('question raise failed'))
    expect(log?.level).toBe('warn')
  })

  it('a STREAMING worker whose output merely ends in "?" is NOT classified (silence gate)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const now = T0 + STALL_SILENCE_MS + 1
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      outputs: new Map([['pty-a-1', now - 500]]), // actively emitting → NOT silent
      screens: new Map([['pty-a-1', questionScreen]]),
    })
    await runDispatchPass(engine, deps, now)
    expect(deps.raised).toHaveLength(0) // never classified while working
    expect(deps.nudged).toHaveLength(0)
    expect(engine.workers[0].stage).toBe('running')
  })

  it('clears the questionRaised key once the worker resumes (screen reads normal)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const screens = new Map([['pty-a-1', questionScreen]])
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], screens })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(engine.questionRaised?.has('pty-a-1')).toBe(true)
    // Worker resumed: ordinary work on screen, still silent → normal stall path.
    screens.set('pty-a-1', 'Editing src/app.tsx — running tests…')
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 2)
    expect(engine.questionRaised?.has('pty-a-1')).toBe(false)
  })

  it('prunes the questionRaised entry when the worker LEAVES the live set (no lifetime leak)', async () => {
    // The departed-worker sweep must forget questionRaised exactly like the
    // sibling maps — terminalIds are unique per spawn, so an un-pruned entry
    // would accumulate for the engine's lifetime (the perf must-fix).
    const dead = new Set<string>()
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], screens: new Map([['pty-a-1', questionScreen]]), dead })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(engine.questionRaised?.has('pty-a-1')).toBe(true)
    // The PTY dies (crash) → the worker is recovered out of the live set next pass.
    dead.add('a')
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 2)
    expect(engine.workers.some((w) => w.terminalId === 'pty-a-1')).toBe(false) // departed
    expect(engine.questionRaised?.has('pty-a-1')).toBe(false) // and its entry is gone
  })

  it('prunes the questionRaised entry when a questioning worker overruns MAX_EXEC_MS (runaway)', async () => {
    const engine = newEngine({ workers: [w1()] })
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })], screens: new Map([['pty-a-1', questionScreen]]) })
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    expect(engine.questionRaised?.has('pty-a-1')).toBe(true)
    // Runaway: wall-clock past MAX_EXEC_MS → torn down and removed from the live set.
    await runDispatchPass(engine, deps, T0 + MAX_EXEC_MS + 1)
    expect(engine.workers.some((w) => w.terminalId === 'pty-a-1')).toBe(false)
    expect(engine.questionRaised?.has('pty-a-1')).toBe(false)
  })
})

// ── stopOrchestratorWorker (Card① — owner stops one engine worker) ─────────────

describe('stopOrchestratorWorker', () => {
  beforeEach(() => __resetOrchestratorForTests())

  it('tears down the worktree + PTY, parks the card in blocked, frees the slot', async () => {
    const key = await canonicalize('/proj-stop-1')
    const engine = newEngine({
      path: key,
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' }),
        worker({ terminalId: 'pty-b-1', branch: 'swarm/b', worktree: '/wt/b', taskId: 'b', taskTitle: 'task b' }),
      ],
    })
    __seedEngineForTests(engine)
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' }), card('b', { boardColumn: 'doing' })] })

    const state = await stopOrchestratorWorker('/proj-stop-1', 'pty-a-1', deps)

    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }])
    // Parked in 'blocked' (NOT 'todo') — a deliberate halt must not be re-dispatched.
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    expect(deps.board.get('a')?.boardColumn).toBe('blocked')
    expect(engine.workers.map((w) => w.terminalId)).toEqual(['pty-b-1']) // only a removed
    expect(state.workers.map((w) => w.terminalId)).toEqual(['pty-b-1'])
  })

  it('is idempotent for an unknown / already-gone terminal id', async () => {
    const key = await canonicalize('/proj-stop-2')
    const engine = newEngine({
      path: key,
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    __seedEngineForTests(engine)
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'doing' })] })

    const state = await stopOrchestratorWorker('/proj-stop-2', 'pty-nope', deps)
    expect(deps.tornDown).toHaveLength(0)
    expect(deps.recovered).toHaveLength(0)
    expect(engine.workers).toHaveLength(1) // untouched
    expect(state.workers).toHaveLength(1)
  })

  it('still cleans the worktree but leaves the column when the card already left doing', async () => {
    const key = await canonicalize('/proj-stop-3')
    const engine = newEngine({
      path: key,
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    __seedEngineForTests(engine)
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'review' })] }) // already promoted

    await stopOrchestratorWorker('/proj-stop-3', 'pty-a-1', deps)
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }]) // worktree still cleaned
    expect(deps.recovered).toHaveLength(0) // not ours to move
    expect(deps.board.get('a')?.boardColumn).toBe('review')
    expect(engine.workers).toHaveLength(0)
  })

  it('returns an empty stopped state for a project with no engine', async () => {
    const deps = makeDeps({ cards: [] })
    const state = await stopOrchestratorWorker('/proj-never-started', 'pty-a-1', deps)
    expect(state.running).toBe(false)
    expect(state.workers).toHaveLength(0)
  })
})

// ── runIntegratePass (Card③) ────────────────────────────────────────────────

describe('isReviewCard', () => {
  it('matches only the explicit review column', () => {
    expect(isReviewCard(card('a', { boardColumn: 'review' }))).toBe(true)
    expect(isReviewCard(card('a', { boardColumn: 'doing' }))).toBe(false)
    expect(isReviewCard(card('a', { boardColumn: undefined }))).toBe(false)
  })
})

/** A recording fake IntegrationDeps set. `reviews` is the live review column;
 *  `outcomes` maps a branch → the IntegrateOutcome its integrate() returns
 *  (default: clean FF). `readiness` maps branch → classify() verdict (default
 *  'ff'). moveToDone flips the card out of review; cleanup records the branch. */
const makeIntDeps = (init: {
  reviews: ProjectTask[]
  target?: string | null
  outcomes?: Record<string, IntegrateOutcome>
  readiness?: Record<string, ReviewReadiness>
  moveToDoneFails?: Set<string>
  // Per-branch verification verdict (default: green). `tip` is the sha the fake
  // reports for the memo key (default `tip-<branch>`, stable so skipIfTip matches);
  // mutate an entry between passes to model a fix (tip changes ⇒ re-verify).
  verifyResults?: Record<string, { ok: boolean; tip?: string | null; reason?: string }>
  // 敵対レビュー(card a14329dc)テスト用: per-branch の ReviewResult。EITHER reviewResults
  // OR reviewDefault が与えられたときだけ fake `review` dep を配線する(無指定なら review は
  // undefined のまま = レビュー段スキップ = 既存テストは不変)。reviewDefault は reviewResults
  // に無い branch の既定 decision。skipIfTip が tip に一致したら {decision:'rework',skipped:true}
  // を返し、makeAdversarialReview の memo 短絡を再現する。
  reviewResults?: Record<string, ReviewResult>
  reviewDefault?: ReviewDecision
  // 差し戻し(rework)テスト用: dead = isAlive=false を返す terminalId(→ 'todo' 再 dispatch
  // 経路を駆動); moveToDoingFails / recoverFails は最初の review→doing / recover 書込を false に。
  dead?: Set<string>
  moveToDoingFails?: Set<string>
  recoverFails?: Set<string>
  // Cross-process integration lock (0706 二重司令塔事故フォロー) fake: defaults to
  // always-succeeds (pre-existing tests are unaffected); a test overrides with a
  // fake that returns ok:false to exercise the skip-this-pass path.
  acquireLock?: IntegrationDeps['acquireLock']
  // 高リスク force-hold (2026-07-15) テスト用: per-branch の changed-file リスト。
  // default は安全な1ファイル(既存テストは不変 — 完了条件『通常カードは1bitも
  // 変わらない』をスイート全体がそのまま固定する)。Error を与えると changedPaths が
  // throw して fail-closed の defer 経路を駆動。tip は verify の fake と同じ
  // `tip-<branch>` 既定で、changedTips で差し替え(新コミットで hold が解ける経路)。
  changedFiles?: Record<string, string[] | Error>
  changedTips?: Record<string, string>
  // MANAGER-ONLY INTEGRATION + RESURRECTION (2026-07-15 card B) wake seam, re-cut for
  // the 2026-07-18 presence model. managerPresence ⇒ the desk's static state
  // ('absent' = no PTY: spawn; 'idle' = up but quiet: nudge only; 'active' = working:
  // leave alone). managerPresenceFn ⇒ a per-call verdict keyed off the pass `now`
  // (models a desk that dies / recovers over time). Default 'absent' keeps every
  // pre-existing wake assertion meaning what it always meant. wakeFails ⇒ wakeManager
  // returns false (no usable tier / spawn fault: a FAILED resurrection attempt).
  managerPresence?: ManagerPresence
  // `echoUntil` is the cutoff the pass hands down so a probe can discount the echo of our
  // OWN nudge (PTY paint at/before it is a TUI repaint, not life). A fake that models a
  // real desk must honour it — that is what makes the poke budget actually empty.
  managerPresenceFn?: (now: number, echoUntil: number) => ManagerPresence
  wakeFails?: boolean
  /** nudgeManager returns false — the live desk's PTY vanished mid-poke. */
  nudgeFails?: boolean
  // The DELIVERY evidence (2026-07-22): when the commander last demonstrably PRODUCED
  // work — the newest of heartbeat / session transcript / sub-agent transcripts (see
  // defaultManagerDeliveryAt). A number, or a function of the pass clock for a desk that
  // keeps working while it integrates. Default null = "no channel says anything", which
  // {@link managerIntegrationStalled} treats as NOT stalled — so every pre-existing
  // assertion in this file keeps meaning exactly what it meant.
  managerDeliveryAt?: number | ((now: number) => number | null) | null
}): IntegrationDeps & {
  integrated: string[]
  moved: string[]
  cleaned: string[]
  killed: string[]
  marks: { taskId: string; value: boolean }[]
  verified: { branch: string; skipIfTip?: string }[]
  reviewed: { branch: string; tip: string; skipIfTip?: string }[]
  reworkedToDoing: { taskId: string; branch: string }[]
  recovered: { taskId: string; column: 'todo' | 'blocked' }[]
  tornDown: string[]
  instructed: { terminalId: string; message: string }[]
  pathsChecked: string[]
  // Wake recording: how many times the commander was woken, and every branch batch
  // handed to it (one inner array per wake call) — the 完了条件2 assertions.
  wakeCalls: { branch: string; title: string }[][]
  woke: string[]
  managerChecks: number
  /** Every nudge sent to a LIVE desk (2026-07-18) — the counterpart of wakeCalls: a
   *  nudge must never coincide with a spawn for the same episode. */
  nudged: string[]
  /** Heartbeat reads (2026-07-22) — 0 unless the dwell clock opened the stall window. */
  readonly deliveryReads: number
  echoUntils: number[]
  // Fatal escalations the RESUSCITATION reflex fired (完了条件5, event
  // 'manager-unrevivable') — captured via the `notify` seam.
  notifications: SwarmFatalNotification[]
} => {
  const reviews = [...init.reviews]
  const outcomes = init.outcomes ?? {}
  const readiness = init.readiness ?? {}
  const moveToDoneFails = new Set(init.moveToDoneFails ?? [])
  const verifyResults = init.verifyResults ?? {}
  const integrated: string[] = []
  const moved: string[] = []
  const cleaned: string[] = []
  const killed: string[] = []
  const marks: { taskId: string; value: boolean }[] = []
  const verified: { branch: string; skipIfTip?: string }[] = []
  const reviewed: { branch: string; tip: string; skipIfTip?: string }[] = []
  const reworkedToDoing: { taskId: string; branch: string }[] = []
  const recovered: { taskId: string; column: 'todo' | 'blocked' }[] = []
  const tornDown: string[] = []
  const instructed: { terminalId: string; message: string }[] = []
  const dead = init.dead ?? new Set<string>()
  const moveToDoingFails = new Set(init.moveToDoingFails ?? [])
  const recoverFails = new Set(init.recoverFails ?? [])
  const pathsChecked: string[] = []
  const wakeCalls: { branch: string; title: string }[][] = []
  const woke: string[] = []
  const nudged: string[] = []
  /** The echo cutoff the pass handed each presence probe (0 = nothing to discount). */
  const echoUntils: number[] = []
  const notifications: SwarmFatalNotification[] = []
  let managerChecks = 0
  /** How many times the pass consulted the heartbeat (the DELIVERY channel). It must stay
   *  0 on an ordinary tick — the dwell clock is in-memory and gates this read. */
  let deliveryReads = 0
  /** The pass clock of the LAST presence probe, so the heartbeat fake can answer relative
   *  to it (presence is always consulted immediately before the beat read). */
  let lastNow = 0
  const dropReview = (taskId: string) => {
    const i = reviews.findIndex((c) => c.id === taskId)
    if (i >= 0) reviews.splice(i, 1)
  }
  // Fake adversarial-review dep — attached ONLY when reviewResults/reviewDefault is
  // configured (else `review` stays undefined ⇒ runIntegratePass skips the stage,
  // so every pre-existing integrate test is byte-for-byte unaffected). Records each
  // call (branch/tip/skipIfTip) and honors the skipIfTip memo short-circuit.
  const reviewConfigured = init.reviewResults !== undefined || init.reviewDefault !== undefined
  const reviewResults = init.reviewResults ?? {}
  const reviewDefault: ReviewDecision = init.reviewDefault ?? 'integrate'
  const reviewDep: NonNullable<IntegrationDeps['review']> = async (_p, branch, _t, opts) => {
    reviewed.push({ branch, tip: opts.tip, skipIfTip: opts.skipIfTip })
    if (opts.skipIfTip && opts.skipIfTip === opts.tip) {
      return { decision: 'rework', verdicts: [], mustFix: 0, clean: 0, skipped: true, reason: 'unchanged review' }
    }
    const r = reviewResults[branch]
    if (r) return r
    return { decision: reviewDefault, verdicts: [], mustFix: 0, clean: reviewDefault === 'integrate' ? 3 : 0, reason: `fake review ${reviewDefault}` }
  }
  return {
    reworkedToDoing,
    recovered,
    tornDown,
    instructed,
    integrated,
    moved,
    cleaned,
    killed,
    marks,
    verified,
    reviewed,
    wakeCalls,
    woke,
    nudged,
    echoUntils,
    notifications,
    get managerChecks() {
      return managerChecks
    },
    get deliveryReads() {
      return deliveryReads
    },
    ...(reviewConfigured ? { review: reviewDep } : {}),
    pathsChecked,
    fetchReview: async () => [...reviews],
    prepareTarget: async () => (init.target === undefined ? 'main' : init.target),
    classify: async (_p, branch) => readiness[branch] ?? 'ff',
    changedPaths: async (_p, branch) => {
      pathsChecked.push(branch)
      const cf = (init.changedFiles ?? {})[branch]
      if (cf instanceof Error) throw cf
      return { tip: (init.changedTips ?? {})[branch] ?? `tip-${branch}`, files: cf ?? ['src/lib/safe-change.ts'] }
    },
    verify: async (_p, branch, _t, opts) => {
      verified.push({ branch, skipIfTip: opts?.skipIfTip })
      const v = verifyResults[branch]
      const tip = v?.tip === undefined ? `tip-${branch}` : v.tip
      // Unchanged-since-failed → short-circuit (no check run), mirroring makeVerify.
      if (opts?.skipIfTip && tip !== null && opts.skipIfTip === tip) {
        return { ok: false, tip, reason: 'unchanged since last failed verification', skipped: true }
      }
      return v && v.ok === false ? { ok: false, tip, reason: v.reason ?? 'tsc red' } : { ok: true, tip }
    },
    integrate: async (_p, branch) => {
      integrated.push(branch)
      return outcomes[branch] ?? { status: 'integrated', mode: 'ff' }
    },
    acquireLock: init.acquireLock ?? alwaysAcquireLock,
    moveToDone: async (_p, taskId) => {
      if (moveToDoneFails.has(taskId)) return false
      moved.push(taskId)
      const i = reviews.findIndex((c) => c.id === taskId)
      if (i >= 0) reviews.splice(i, 1)
      return true
    },
    markConflict: async (_p, taskId, value) => {
      marks.push({ taskId, value })
      return true
    },
    cleanup: async (_p, branch) => {
      cleaned.push(branch)
      return { removed: true }
    },
    killPty: (terminalId) => {
      killed.push(terminalId)
    },
    // 差し戻し(rework)seam — review→doing 移動 / recovery 移動 / worker liveness /
    // teardown / 修正指示。runIntegratePass の reworkOrPark が使う。
    moveToDoing: async (_p, taskId, branch) => {
      if (moveToDoingFails.has(taskId)) {
        moveToDoingFails.delete(taskId) // only the FIRST move fails
        return false
      }
      reworkedToDoing.push({ taskId, branch })
      dropReview(taskId)
      return true
    },
    recoverCard: async (_p, taskId, column) => {
      if (recoverFails.has(taskId)) {
        recoverFails.delete(taskId) // only the FIRST recover move fails
        return false
      }
      recovered.push({ taskId, column })
      dropReview(taskId)
      return true
    },
    isAlive: (terminalId) => !dead.has(terminalId),
    recoverWorker: async ({ terminalId }) => {
      tornDown.push(terminalId)
      return { removed: true }
    },
    instructRework: (terminalId, message) => {
      instructed.push({ terminalId, message })
    },
    // MANAGER-ONLY INTEGRATION + RESURRECTION (2026-07-15 card B) wake seam.
    // managerPresence honours the `now` the pass injects: managerPresenceFn models a
    // desk whose state CHANGES over time (up → gone → back); the static
    // managerPresence is the timeless default.
    managerPresence: async (_p, now, echoUntil) => {
      managerChecks += 1
      lastNow = now
      echoUntils.push(echoUntil ?? 0)
      if (init.managerPresenceFn) return init.managerPresenceFn(now, echoUntil ?? 0)
      return init.managerPresence ?? 'absent'
    },
    // The live-desk poke (2026-07-18). Recorded, never spawning: reaching this seam at
    // all is the assertion that the engine chose "talk to the desk that exists" over
    // "open another one".
    nudgeManager: async (p) => {
      nudged.push(p)
      return !init.nudgeFails
    },
    // Evidence the commander actually PRODUCED something (heartbeat / session transcript /
    // sub-agent transcripts) — paint proves only that a TUI repainted. Stubbed so no real
    // file is read.
    managerDeliveryAt: async (_p: string) => {
      deliveryReads += 1
      const b = init.managerDeliveryAt
      return typeof b === 'function' ? b(lastNow) : (b ?? null)
    },
    // The spawnSwarmManager boundary (defaultWakeManager wraps spawnSwarmManager +
    // the info notification). wakeFails ⇒ false = a FAILED resurrection (no usable
    // tier / spawn fault): the state machine still counts it as an attempt.
    wakeManager: async (_p, cards) => {
      wakeCalls.push(cards.map((c) => ({ ...c })))
      if (init.wakeFails) return false
      for (const c of cards) woke.push(c.branch)
      return true
    },
    // Fatal-escalation seam (完了条件5) — capture 'manager-unrevivable' so the
    // give-up path is assertable without touching the real notification store.
    notify: (n) => {
      notifications.push(n)
    },
  }
}

const reviewCard = (id: string, branch: string | undefined, over: Partial<ProjectTask> = {}): ProjectTask =>
  card(id, { boardColumn: 'review', branch, ...over })

describe('runIntegratePass — switch positions', () => {
  it('classifies review cards AND wakes the commander with NO separate arm — the auto-wake toggle is gone (2026-07-16)', async () => {
    // No `autoMerge` field exists anymore: `running` is the ONLY gate. A resurrected
    // toggle (any gate between running and the wake reflex) would fail this.
    const engine = newEngine()
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a'), reviewCard('b', 'swarm/b')],
      readiness: { 'swarm/a': 'ff', 'swarm/b': 'rebase' },
    })
    await runIntegratePass(engine, deps)
    // Read-only readiness published, no board/trunk mutation…
    expect(engine.reviews.map((r) => [r.branch, r.status])).toEqual([
      ['swarm/a', 'ff'],
      ['swarm/b', 'rebase'],
    ])
    expect(deps.integrated).toHaveLength(0)
    expect(deps.moved).toHaveLength(0)
    // …and the wake reflex fired unarmed: engine ON = auto-wake always on.
    expect(deps.wakeCalls).toHaveLength(1)
    expect(deps.woke).toEqual(['swarm/a', 'swarm/b'])
  })

  it('does nothing at all when the engine is stopped (global stop)', async () => {
    const engine = newEngine({ running: false })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    await runIntegratePass(engine, deps)
    expect(engine.reviews).toHaveLength(0)
    expect(deps.integrated).toHaveLength(0)
    expect(deps.wakeCalls).toHaveLength(0) // stopped engine never wakes a desk either
  })

  it('ignores non-swarm branches entirely', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'feature/x'), reviewCard('b', undefined)] })
    await runIntegratePass(engine, deps)
    expect(engine.reviews).toHaveLength(0)
    expect(deps.integrated).toHaveLength(0)
  })
})

describe('runIntegratePass — throttle', () => {
  it('skips ticks until INTEGRATE_TICK_MS has passed (the wake is throttled too)', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    await runIntegratePass(engine, deps)
    expect(deps.wakeCalls).toHaveLength(1) // first pass woke the commander
    // Fire immediately (no clock advance): throttled (lastIntegrateAt was just set to
    // ~now), so the pass returns at the very top — it never re-checks the desk or the
    // resurrection state, let alone re-wakes.
    await runIntegratePass(engine, deps)
    expect(deps.wakeCalls).toHaveLength(1) // still 1 — the throttle short-circuited the whole pass
    expect(deps.managerChecks).toBe(1) // managerPresence not even reached on the throttled tick
  })
})

// ── runIntegratePass — MANAGER-ONLY INTEGRATION wake + RESURRECTION (2026-07-15) ──
// The redesign's core: with auto-wake ARMED and a worker READY (review-column
// swarm card), the engine WAKES the commander instead of merging. It never
// verifies, never runs the lens panel, never acquires the integration lock, never
// FF-pushes, never moves a card to done. Integration is the commander's alone.
//
// 受け入れの肝 (完了条件1+3): there is NO path where the engine's lens result — or
// anything else — moves main. The first test fixes exactly that: a clean,
// fast-forwardable review card produces ZERO integrate/verify/review/lock calls.
//
// Card B adds the RESUSCITATION reflex on top (完了条件2-6): a stopped desk (dead PTY
// or hung — stale heartbeat) is re-woken across a boot-grace window, and a desk that
// keeps dying escalates ONCE instead of looping forever. The time-based state machine
// is driven here with an injected `now`; the REAL heartbeat detection (write → stop →
// stale) is fixed end-to-end, HOME-isolated, in swarmOrchestrator.integration.test.ts.
// The bug-B presence fix (a LIVE labelled desk must never read 'absent') is pinned
// end-to-end with a REAL desk + REAL listLiveDesksIn in swarmSessions.integration.test.ts.
describe('runIntegratePass — manager-only integration wake + resurrection (2026-07-15)', () => {
  it('受け入れの肝: a clean ff-ready review card is NEVER FF-pushed — engine calls no integrate/verify/review/lock', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      readiness: { 'swarm/a': 'ff' }, // maximally mergeable — the old engine WOULD have landed it
      reviewDefault: 'integrate', // even with a lens panel wired + voting clean…
    })
    await runIntegratePass(engine, deps)
    // …the engine moves main by NO route:
    expect(deps.integrated).toEqual([]) // never FF-pushed (完了条件1 — engine never touches the trunk)
    expect(deps.moved).toEqual([]) // never moved review→done
    expect(deps.cleaned).toEqual([]) // never tore a worktree down after a (non-)land
    expect(deps.verified).toEqual([]) // never ran the verify gate
    expect(deps.reviewed).toEqual([]) // never ran the lens panel (its result can't gate main — 完了条件3)
    expect(deps.pathsChecked).toEqual([]) // never ran the high-risk diff scan
    // Instead it woke the commander to decide the integration.
    expect(deps.woke).toEqual(['swarm/a'])
  })

  it('wakes the commander for review cards when the desk is INACTIVE — dead PTY OR hung (完了条件2)', async () => {
    const engine = newEngine()
    // 'absent' = no live PTY holds the manager session: the desk is GONE, which since
    // 2026-07-18 is the ONLY state that spawns one (a live-but-quiet desk is 'idle' and
    // gets nudged instead — see the sibling tests). The real file-driven detection is
    // fixed end-to-end in the integration suite's RESURRECTION test.
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'absent' })
    await runIntegratePass(engine, deps)
    expect(deps.managerChecks).toBe(1) // it checked whether a desk was up AND responding…
    expect(deps.wakeCalls).toHaveLength(1) // …found none, and woke one
    expect(deps.woke).toEqual(['swarm/a'])
    expect(engine.managerResume?.attempts).toBe(1) // resurrection attempt counted
    expect(engine.log.some((l) => l.message.includes('マネージャーを起こしました'))).toBe(true)
  })

  it('BATCHES every waiting review branch into ONE wake call (token-thrifty, 完了条件2)', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a'), reviewCard('b', 'swarm/b'), reviewCard('c', 'swarm/c')],
    })
    await runIntegratePass(engine, deps)
    expect(deps.wakeCalls).toHaveLength(1) // ONE spawn, not three
    expect(deps.wakeCalls[0].map((x) => x.branch)).toEqual(['swarm/a', 'swarm/b', 'swarm/c'])
  })

  it('does NOT wake a SECOND desk when the commander is up AND responding (二重起動防止, 完了条件2)', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'active' })
    await runIntegratePass(engine, deps)
    expect(deps.managerChecks).toBe(1) // it checked…
    expect(deps.wakeCalls).toHaveLength(0) // …and did NOT spawn a duplicate
    expect(engine.managerResume?.attempts).toBe(0) // a healthy desk keeps the reflex disarmed
  })

  // ── RESURRECTION reflex state machine (card B, 完了条件2-5). Drive one integrate
  //    pass at an injected wall-clock `now`, bypassing the 15s TICK throttle (its own
  //    test above) so ONLY the resurrection grace window governs re-wakes. ──
  const passAt = (engine: ProjectEngine, deps: IntegrationDeps, now: number): Promise<void> => {
    engine.lastIntegrateAt = 0
    return runIntegratePass(engine, deps, now)
  }
  const GRACE = MANAGER_RESUME_GRACE_MS
  const T0 = 10_000_000 // arbitrary fixed base (Date.now injected, never read)

  it('does NOT re-wake a stopped desk WITHIN the boot grace, re-wakes once it ELAPSES (完了条件3)', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresenceFn: () => 'absent' })
    await passAt(engine, deps, T0)
    expect(deps.wakeCalls).toHaveLength(1) // wake #1 — a freshly-resumed desk needs time to boot + beat
    await passAt(engine, deps, T0 + GRACE - 1) // still inside the grace window…
    expect(deps.wakeCalls).toHaveLength(1) // …so NO double-spawn (the boot gap isn't a hang)
    await passAt(engine, deps, T0 + GRACE) // grace elapsed and STILL silent → the wake didn't take
    expect(deps.wakeCalls).toHaveLength(2) // re-woken
  })

  it('GIVES UP after MAX consecutive failed resurrections and escalates ONCE (完了条件5)', async () => {
    const engine = newEngine()
    // A desk that dies immediately every time (permanent quota wall / boot-crash): the
    // wake "succeeds" but the desk never responds, so every grace-spaced pass re-wakes.
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresenceFn: () => 'absent' })
    for (let i = 0; i < MAX_MANAGER_RESUME_ATTEMPTS; i++) await passAt(engine, deps, T0 + i * GRACE)
    expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS) // 3 spawns…
    expect(deps.notifications).toEqual([]) // …not given up YET
    // Next grace-spaced pass: attempts hit the ceiling → STOP reviving, escalate.
    await passAt(engine, deps, T0 + MAX_MANAGER_RESUME_ATTEMPTS * GRACE)
    expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS) // NO 4th spawn — the token-burn loop is broken
    expect(deps.notifications).toHaveLength(1)
    expect(deps.notifications[0].event).toBe('manager-unrevivable')
    // One-shot per episode: a further pass does NOT re-fire the fatal.
    await passAt(engine, deps, T0 + (MAX_MANAGER_RESUME_ATTEMPTS + 1) * GRACE)
    expect(deps.notifications).toHaveLength(1)
  })

  it('RE-ARMS after a backoff when the give-up was a QUOTA WALL (no usable tier) — a transient wall never stalls integration forever (完了条件2, 2026-07-20)', async () => {
    const engine = newEngine()
    // wakeFails ⇒ every wake finds NO usable tier (every allowed tier cooling/masked): a
    // quota wall, which LIFTS on its own. No desk is ever seated, so re-arming this costs
    // ZERO tokens — it just keeps checking until a tier frees up. Giving up must stop the
    // TIGHT loop without also freezing this recovery (one missed toast else strands
    // integration permanently). Contrast the FLAPPING desk below, which DOES spawn a desk
    // each time and is deliberately NOT re-armed.
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresenceFn: () => 'absent',
      wakeFails: true,
    })
    // Climb to the ceiling and fire the fatal (the 4th grace-spaced pass).
    for (let i = 0; i <= MAX_MANAGER_RESUME_ATTEMPTS; i++) await passAt(engine, deps, T0 + i * GRACE)
    expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS) // 3 attempts, then stopped
    expect(deps.notifications).toHaveLength(1) // fatal fired ONCE
    // The 3rd wake's clock is the backoff anchor. INSIDE the backoff → still paused
    // (integration is not looping — the give-up guard is doing its job).
    const lastWake = T0 + (MAX_MANAGER_RESUME_ATTEMPTS - 1) * GRACE
    await passAt(engine, deps, lastWake + MANAGER_UNREVIVABLE_RETRY_MS - 1)
    expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS) // no 4th attempt yet
    // Backoff elapsed → exactly ONE more resuscitation is let through (recovery path)…
    await passAt(engine, deps, lastWake + MANAGER_UNREVIVABLE_RETRY_MS)
    expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS + 1) // re-armed: a 4th attempt
    // …WITHOUT re-firing the fatal toast — the owner is alerted once per episode, not per
    // cycle. (Only a desk that actually COMES UP clears fatalFired; that path is the
    // 'a RECOVERED desk RESETS the attempt budget' case above.)
    expect(deps.notifications).toHaveLength(1)
  })

  it('does NOT re-arm a FLAPPING desk that keeps SPAWNING and dying — that burn is what give-up exists to stop (完了条件2)', async () => {
    // Belt-and-suspenders (2026-07-22, adversarial review of card add3af4c): the give-up
    // check now ALSO reads the global quota cooling table via spawnBlock (see the
    // quota-DOA re-arm test below), so this test's "stays latched" assertion is only
    // true while every ladder tier reads not-cooling. That table is a globalThis
    // singleton shared across this whole file (same discipline as the quota-park
    // describe block above) — reset it here explicitly instead of relying on suite
    // order, so a later-added test that leaves tiers cooling can never turn this into an
    // order-dependent false red.
    __resetQuotaForTest()
    try {
      const engine = newEngine()
      // Default wake ⇒ woke=true: a desk IS seated each time, then dies on arrival (a
      // boot-crash bug / context overflow). Re-arming this would burn a fresh desk every
      // cycle — permanent, not transient. The give-up must HOLD past the backoff.
      const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresenceFn: () => 'absent' })
      for (let i = 0; i <= MAX_MANAGER_RESUME_ATTEMPTS; i++) await passAt(engine, deps, T0 + i * GRACE)
      expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS)
      // Well past the backoff — a transient give-up would have re-armed here; this one must not.
      const lastWake = T0 + (MAX_MANAGER_RESUME_ATTEMPTS - 1) * GRACE
      await passAt(engine, deps, lastWake + MANAGER_UNREVIVABLE_RETRY_MS + GRACE)
      expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS) // still 3 — no re-arm for a spawning desk
      expect(deps.notifications).toHaveLength(1)
    } finally {
      __resetQuotaForTest()
    }
  })

  it('RE-ARMS after a backoff when the give-up desk was a SPAWN+DOA on the last usable tier — quota, not a boot-crash (card add3af4c, 2026-07-22)', async () => {
    // The gap this fix closes: with 3+ allowed tiers all exhausted-but-spawnable, the
    // LAST wake's headless probe can still pass (a tier reads not-cooling at probe time),
    // so spawnSwarmManager does not throw and wakeManager returns true — `lastWakeSpawned`
    // latches PERMANENT even though the seated desk died on arrival for quota (the SAME
    // root cause a `false` would already re-arm for). By the time the give-up ceiling
    // fires, watchDeskForDeathOnArrival has cooled the tier it died on — simulate that by
    // marking EVERY ladder tier cooling before the give-up pass runs.
    __resetQuotaForTest()
    try {
      const engine = newEngine()
      // Default wake ⇒ woke=true: a desk IS seated each time (mirrors the FLAPPING-desk
      // test above byte-for-byte) — the only difference is what spawnBlock reads.
      const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresenceFn: () => 'absent' })
      for (let i = 0; i <= MAX_MANAGER_RESUME_ATTEMPTS; i++) await passAt(engine, deps, T0 + i * GRACE)
      expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS) // ceiling hit, fatal fired
      expect(engine.managerResume?.lastWakeSpawned).toBe(true) // the woke bit alone says "permanent"…
      expect(deps.notifications).toHaveLength(1)
      // …but every allowed tier is quota-exhausted RIGHT NOW (the DOA death-watch's
      // outcome, arriving after the woke bit was already latched true).
      const now = T0 + MAX_MANAGER_RESUME_ATTEMPTS * GRACE
      // Well past MANAGER_UNREVIVABLE_RETRY_MS (30m) so the cooling window still covers
      // the re-arm pass below, whenever it lands relative to `now`.
      for (const tier of MODEL_TIER_LADDER) markCoolingUntil(tier, now + 60 * 60_000)
      const lastWake = T0 + (MAX_MANAGER_RESUME_ATTEMPTS - 1) * GRACE
      // Backoff elapsed → the quota signal must re-arm exactly ONE more attempt, same as
      // the `lastWakeSpawned === false` transient path does.
      await passAt(engine, deps, lastWake + MANAGER_UNREVIVABLE_RETRY_MS)
      expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS + 1) // re-armed, not stuck forever
      expect(deps.notifications).toHaveLength(1) // still one fatal per episode, not re-fired
    } finally {
      __resetQuotaForTest()
    }
  })

  it('a FAILED wake (no usable tier) still counts as an attempt — drives escalation too (完了条件4+5)', async () => {
    const engine = newEngine()
    // wakeFails ⇒ every spawn returns false (every model tier OFF/cooling). The desk
    // is never actually raised, but the engine must not loop forever probing it.
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresenceFn: () => 'absent', wakeFails: true })
    for (let i = 0; i <= MAX_MANAGER_RESUME_ATTEMPTS; i++) await passAt(engine, deps, T0 + i * GRACE)
    expect(deps.woke).toEqual([]) // no spawn ever succeeded…
    expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS) // …but attempts were capped at MAX
    expect(deps.notifications.map((n) => n.event)).toEqual(['manager-unrevivable']) // and it escalated
  })

  it('a RECOVERED desk RESETS the attempt budget (a later hang gets the full MAX again, 完了条件2)', async () => {
    const engine = newEngine()
    // Healthy ONLY in [T0+2·GRACE, T0+3·GRACE): hung, hung, RECOVERED, hung-again.
    const healthyFrom = T0 + 2 * GRACE
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresenceFn: (now) => (now >= healthyFrom && now < healthyFrom + GRACE ? 'active' : 'absent'),
    })
    await passAt(engine, deps, T0) // hung → wake #1 (attempts 1)
    await passAt(engine, deps, T0 + GRACE) // hung → wake #2 (attempts 2)
    await passAt(engine, deps, healthyFrom) // RECOVERED → reflex disarms
    expect(engine.managerResume?.attempts).toBe(0) // budget reset by the sighting of health
    await passAt(engine, deps, T0 + 3 * GRACE) // hung AGAIN → wake #3, but from a FRESH budget
    expect(deps.wakeCalls).toHaveLength(3)
    expect(engine.managerResume?.attempts).toBe(1) // NOT 3 → the recovery prevented a premature give-up
    expect(deps.notifications).toEqual([]) // so no fatal fired
  })

  it('DISARMS fully when the review work DRAINS — no work, no resurrection (完了条件6)', async () => {
    const engine = newEngine()
    const present = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresenceFn: () => 'absent' })
    await passAt(engine, present, T0)
    expect(present.woke).toEqual(['swarm/a'])
    expect(engine.managerResume?.attempts).toBe(1)
    expect(engine.managerResume?.lastWakeSpawned).toBe(true) // this episode's wake DID seat a desk
    // The commander merged it → review empties. With nothing waiting, the desk isn't
    // needed: the reflex disarms (counter cleared) and probes NOTHING.
    const gone = makeIntDeps({ reviews: [], managerPresenceFn: () => 'absent' })
    await passAt(engine, gone, T0 + GRACE)
    expect(gone.managerChecks).toBe(0) // never even probed the desk (no work)
    expect(engine.managerResume?.attempts).toBe(0) // cleared
    // card add3af4c (2026-07-22): `lastWakeSpawned` is the give-up ratchet's
    // transient-vs-permanent bit, and a full disarm has to clear it too — else a NEXT
    // episode's very first give-up would be judged on THIS episode's (unrelated) outcome.
    expect(engine.managerResume?.lastWakeSpawned).toBeUndefined()
    // A NEW card arriving later starts a clean episode (full budget, immediate wake).
    const back = makeIntDeps({ reviews: [reviewCard('b', 'swarm/b')], managerPresenceFn: () => 'absent' })
    await passAt(engine, back, T0 + 2 * GRACE)
    expect(back.woke).toEqual(['swarm/b'])
    expect(engine.managerResume?.attempts).toBe(1)
  })

  // (The 'does NOT wake when auto-wake is OFF' case is GONE with the toggle
  // (2026-07-16): there is no OFF short of stopping the engine, which the
  // global-stop test in the switch-positions block pins.)

  // ── The 2026-07-18 false-death fix (完了条件1-3+6). A desk that is UP but quiet is
  //    'idle', NOT dead: the engine talks to the desk it has instead of stacking a new
  //    one, and can never escalate "the commander cannot be started" while one is
  //    demonstrably running. Every assertion here is a bug the old single-bit probe had:
  //    it read this exact state as HUNG, spawned three amnesiac twins over 15 minutes,
  //    orphaned the working desk, and fired a FALSE fatal at the owner. ──

  it('(a) a LIVE but SILENT desk is NEVER resuscitated — it gets nudged instead (完了条件1+2)', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    await passAt(engine, deps, T0)
    expect(deps.wakeCalls).toEqual([]) // ← THE fix: no spawn while a desk is alive
    expect(deps.nudged).toEqual([engine.path]) // the existing desk was addressed instead
    expect(engine.managerResume?.attempts).toBe(0) // a live desk is NOT a failed resurrection
    expect(deps.notifications).toEqual([]) // and nothing was escalated to the owner
    expect(engine.log.some((l) => l.message.includes('蘇生せず声をかけました'))).toBe(true)
  })

  it('(b) a desk that is genuinely GONE is still resuscitated — the reflex keeps its value (完了条件4)', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'absent' })
    await passAt(engine, deps, T0)
    expect(deps.wakeCalls).toHaveLength(1) // spawned — a dead commander must be replaced
    expect(deps.woke).toEqual(['swarm/a'])
    expect(deps.nudged).toEqual([]) // nothing to nudge: there is no desk
    expect(engine.managerResume?.attempts).toBe(1)
  })

  it('(c) nudges are THROTTLED and BUDGETED — a quiet desk is never poked in a loop (完了条件2+5)', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    await passAt(engine, deps, T0)
    expect(deps.nudged).toHaveLength(1)
    // Inside the interval → silent (the desk gets a full window to answer).
    await passAt(engine, deps, T0 + MANAGER_NUDGE_INTERVAL_MS - 1)
    expect(deps.nudged).toHaveLength(1)
    // Interval elapsed → nudge again, up to the budget…
    for (let i = 1; i < MAX_MANAGER_NUDGES; i++) {
      await passAt(engine, deps, T0 + i * MANAGER_NUDGE_INTERVAL_MS)
    }
    expect(deps.nudged).toHaveLength(MAX_MANAGER_NUDGES)
    // …then STOP. A desk that ignores us is a human matter, not a loop to run forever.
    await passAt(engine, deps, T0 + 10 * MANAGER_NUDGE_INTERVAL_MS)
    expect(deps.nudged).toHaveLength(MAX_MANAGER_NUDGES)
    expect(deps.wakeCalls).toEqual([]) // and at no point did the budget spill into a spawn
    expect(deps.notifications).toEqual([]) // nor into a fatal
  })

  it('a desk that ignores EVERY nudge is reported ONCE in the log — a wedge is not silence (完了条件4)', async () => {
    const engine = newEngine()
    // The nudges are PROBES, not just reminders: a healthy claude answers a submitted
    // prompt with output, which would have read 'active'. Ignoring all of them across
    // the full interval is real evidence of a wedged desk — so it must not vanish.
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    for (let i = 0; i < MAX_MANAGER_NUDGES; i++) await passAt(engine, deps, T0 + i * MANAGER_NUDGE_INTERVAL_MS)
    const unresponsive = (): number =>
      engine.log.filter((l) => l.message.includes('声かけに応答しません')).length
    // Immediately after the last nudge: NOT yet — nudge #3 gets its full window to answer.
    await passAt(engine, deps, T0 + (MAX_MANAGER_NUDGES - 1) * MANAGER_NUDGE_INTERVAL_MS + 1)
    expect(unresponsive()).toBe(0)
    // A full interval later with still nothing → say it once…
    await passAt(engine, deps, T0 + MAX_MANAGER_NUDGES * MANAGER_NUDGE_INTERVAL_MS)
    expect(unresponsive()).toBe(1)
    // …and only once, however long the wedge lasts.
    for (let i = 4; i < 12; i++) await passAt(engine, deps, T0 + i * MANAGER_NUDGE_INTERVAL_MS)
    expect(unresponsive()).toBe(1)
    expect(deps.notifications).toEqual([]) // still NOT a fatal — the desk is up (完了条件3)
    expect(deps.wakeCalls).toEqual([]) // and still never a duplicate desk
  })

  it('(d) fatal is reserved for a desk that will not START — an idle desk never reaches it (完了条件3)', async () => {
    const engine = newEngine()
    // The exact 2026-07-18 shape: the desk is up the whole time, just quiet. Drive far
    // MORE passes than the give-up threshold — the old code fired 'manager-unrevivable'
    // after three; this must never escalate, because "unrevivable" would be a lie.
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    for (let i = 0; i <= MAX_MANAGER_RESUME_ATTEMPTS * 3; i++) {
      await passAt(engine, deps, T0 + i * MANAGER_NUDGE_INTERVAL_MS)
    }
    expect(deps.notifications).toEqual([]) // ← the false fatal the owner actually received
    expect(deps.wakeCalls).toEqual([])
    expect(engine.managerResume?.fatalFired).toBe(false)

    // Contrast: the SAME engine, once the desk truly disappears, escalates as before.
    const dead = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'absent' })
    let now = T0 + 100 * MANAGER_NUDGE_INTERVAL_MS
    for (let i = 0; i <= MAX_MANAGER_RESUME_ATTEMPTS; i++, now += GRACE + 1) await passAt(engine, dead, now)
    expect(dead.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS)
    expect(dead.notifications.map((n) => n.event)).toEqual(['manager-unrevivable'])
  })

  it('a desk that comes BACK to life clears the nudge budget (a later silence is nudged afresh)', async () => {
    const engine = newEngine()
    const quiet = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    for (let i = 0; i < MAX_MANAGER_NUDGES; i++) await passAt(engine, quiet, T0 + i * MANAGER_NUDGE_INTERVAL_MS)
    expect(quiet.nudged).toHaveLength(MAX_MANAGER_NUDGES) // budget spent
    // The commander answers (starts working) → the episode is over.
    const working = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'active' })
    await passAt(engine, working, T0 + 20 * MANAGER_NUDGE_INTERVAL_MS)
    expect(engine.managerResume?.nudges).toBe(0)
    // A LATER quiet spell gets a fresh budget rather than being silently ignored forever.
    const quietAgain = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    await passAt(engine, quietAgain, T0 + 40 * MANAGER_NUDGE_INTERVAL_MS)
    expect(quietAgain.nudged).toHaveLength(1)
  })

  it('a RESPAWNED desk gets a FRESH nudge budget — one desk\'s silence is not charged to its successor', async () => {
    const engine = newEngine()
    // A desk ignores every nudge, spending the budget (and arming the one-shot log).
    const quiet = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    for (let i = 0; i < MAX_MANAGER_NUDGES; i++) await passAt(engine, quiet, T0 + i * MANAGER_NUDGE_INTERVAL_MS)
    expect(quiet.nudged).toHaveLength(MAX_MANAGER_NUDGES)

    // …then it DIES, and the reflex replaces it with a brand-new desk.
    const dead = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'absent' })
    const spawnAt = T0 + 20 * MANAGER_NUDGE_INTERVAL_MS
    await passAt(engine, dead, spawnAt)
    expect(dead.wakeCalls).toHaveLength(1)
    expect(engine.managerResume?.nudges).toBe(0) // the counters belong to the DEAD desk

    // The successor never ignored anything, so a quiet spell must still be poked. Note no
    // 'active' probe intervenes here: a spawned desk normally paints while booting (which
    // would clear the counters as a side effect), but an integrate pass can hold the lane
    // ~20m for verify + the adversarial panel, and past MANAGER_HEARTBEAT_STALE_MS that
    // paint has aged out — so the first sighting of a healthy successor really can be
    // 'idle'. With the dead desk's budget inherited this nudge went missing and, because
    // `unresponsiveLogged` came along too, integration stalled without even a log line.
    const successorQuiet = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    await passAt(engine, successorQuiet, spawnAt + GRACE + 1)
    expect(successorQuiet.nudged).toHaveLength(1)
    expect(successorQuiet.notifications).toEqual([]) // and still never a fatal (完了条件3)
  })

  it('the ECHO of our own nudge must not refund the budget — else a wedged desk is poked forever', async () => {
    // Writing into a desk makes claude's TUI repaint, which stamps `lastOutputAt` whether
    // or not anything PROCESSED the prompt. So a desk wedged with a responsive TUI (the
    // classic shape: stuck on a hung request, input box still echoing) looks 'active' for
    // a full staleness window after every poke. Left uncorrected the reflex refunds its
    // own budget — nudge → echo → 'active' → nudges=0 → nudge → … — so the budget never
    // empties, the 「N 回の声かけに応答しません」 line never fires, and the desk is poked
    // forever. The worker stall path has guarded this since STALL_ECHO_GUARD_MS ("output
    // within echoGuardMs after our nudge is the TUI repaint, not life"); this is the same
    // trap on the manager path.
    const engine = newEngine()
    // A desk whose ONLY output is our own poke bouncing back. The fake models a real probe
    // faithfully: paint at/before the `echoUntil` the pass hands down does not count, so
    // this desk reads 'active' only where the engine failed to discount its own echo.
    let paintedAt = -Infinity
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresenceFn: (now, echoUntil) => {
        const real = echoUntil > 0 && paintedAt <= echoUntil ? -Infinity : paintedAt
        return now - real < MANAGER_NUDGE_INTERVAL_MS ? 'active' : 'idle'
      },
    })
    // Probe on the real cadence (passes are frequent — INTEGRATE_TICK_MS is seconds), not
    // only at nudge boundaries: it is the passes BETWEEN nudges that see the echo as life.
    let seen = 0
    for (let i = 0; i < 300; i++) {
      const at = T0 + i * 60_000
      await passAt(engine, deps, at)
      if (deps.nudged.length > seen) {
        seen = deps.nudged.length
        paintedAt = at // the TUI repaints what we just typed — instantly
      }
    }
    // The contract the docs promise (03章 §7-10): at most MAX_MANAGER_NUDGES pokes, ever.
    expect(deps.nudged.length).toBeLessThanOrEqual(MAX_MANAGER_NUDGES)
    expect(deps.wakeCalls).toEqual([]) // and never a spawn — the desk was up throughout
    expect(deps.notifications).toEqual([]) // nor a fatal (完了条件3)
    // The wedge must still be SAID once, rather than vanishing into an endless poke loop.
    expect(engine.log.filter((l) => l.message.includes('声かけに応答しません'))).toHaveLength(1)
  })

  it('a JUST-RESURRECTED desk is left alone through the boot grace — no ESC through its opening prompt', async () => {
    // The regression this pins is one the 2026-07-18 work created by composition, and it
    // fired on EVERY resurrection: (1) the spawn's launch echo is discounted for
    // STALL_ECHO_GUARD_MS so a booting desk reads 'idle'; (2) the spawn clears
    // lastNudgeAt so the nudge throttle is disarmed; (3) the poke leads with ESC. At the
    // first tick after a wake (INTEGRATE_TICK_MS = 15s) the fresh commander therefore took
    // an ESC through the middle of the /og-manage prompt it was launched with.
    const engine = newEngine()
    let up = false // the desk exists only after we spawn it
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      // Exactly the shape the real probe produces while booting: a live PTY whose only
      // paint so far is the launch line we ourselves wrote, hence discounted ⇒ 'idle'.
      managerPresenceFn: () => (up ? 'idle' : 'absent'),
    })
    await passAt(engine, deps, T0)
    expect(deps.wakeCalls).toHaveLength(1) // spawned
    up = true
    // The next integrate tick lands 15s later — mid-boot.
    await passAt(engine, deps, T0 + INTEGRATE_TICK_MS)
    expect(deps.nudged).toEqual([]) // ← THE fix: a booting desk is not interrupted
    // …and it stays untouched for the whole grace.
    await passAt(engine, deps, T0 + MANAGER_RESUME_GRACE_MS - 1)
    expect(deps.nudged).toEqual([])
    expect(deps.wakeCalls).toHaveLength(1) // nor is a second desk opened
    // Once the grace is over and it is STILL quiet, the poke is due as before.
    await passAt(engine, deps, T0 + MANAGER_RESUME_GRACE_MS + 1)
    expect(deps.nudged).toHaveLength(1)
  })

  // ── THE 「喋った直後に停止する」 BLIND SPOT (2026-07-22, 実測80分). presence answers
  //    "is a desk alive?" and its everyday channel is PTY PAINT — which the commander
  //    produces by SPEAKING ONE TURN and then stopping. Measured: beat 統合完了 10:31,
  //    workers promoted 10:37/10:40, engine silent until the owner woke it at 11:51 with
  //    four branches stacked in review. The fix adds a SECOND question — is anything
  //    coming OUT of the desk? — judged on the one channel only real integration work
  //    writes: the commander's own heartbeat. Both directions are pinned here. ──

  it('(1) a desk that PAINTS but stops DELIVERING is poked once the queue stalls — the 80-minute blind spot', async () => {
    const engine = newEngine()
    // The incident's exact shape: the last beat is minutes OLD when the cards land, and
    // the desk reads 'active' forever after because a TUI that repainted is still "alive".
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a'), reviewCard('b', 'swarm/b')],
      managerPresence: 'active',
      managerDeliveryAt:T0 - 6 * 60_000, // 統合完了 six minutes before the promotions
    })
    await passAt(engine, deps, T0)
    expect(deps.nudged).toEqual([]) // nothing has waited yet — a working desk is left alone
    expect(deps.deliveryReads).toBe(0) // and an ordinary tick never even reads the evidence files
    // Just under the window: still silent. A commander mid-branch may pause this long.
    await passAt(engine, deps, T0 + MANAGER_INTEGRATION_STALL_MS - 1)
    expect(deps.nudged).toEqual([])
    // Past it — work has sat the full window and the desk has not beaten once. SPEAK.
    await passAt(engine, deps, T0 + MANAGER_INTEGRATION_STALL_MS)
    expect(deps.nudged).toEqual([engine.path]) // ← THE fix: paint no longer buys silence
    expect(deps.wakeCalls).toEqual([]) // still never a second desk (the desk IS up)
    expect(deps.notifications).toEqual([]) // and still never a fatal (完了条件3)
    // The log has to explain itself — 「無音」 would read as a contradiction here.
    expect(engine.log.some((l) => l.message.includes('描画しているが統合が進んでいません'))).toBe(true)
  })

  it('(2) a commander that is ACTUALLY integrating is never interrupted — delivery is the discriminator', async () => {
    const engine = newEngine()
    // A real round holds cards in review for HOURS, and the desk's work looks like this:
    // ONE beat at the head of a branch, then tsc + `npm test` (3–12 min) + adversarial
    // reviewers via the Agent tool (5–20 min) INSIDE a single turn — during which it
    // cannot curl a beat at all. What keeps moving is the transcript and the sub-agent
    // files, so delivery stays fresh even though the BEAT is long stale. Judging this desk
    // on the beat alone (the first cut of this fix, 差し戻し 2026-07-22) would ESC the
    // reviewers it is running. The fake models the worst realistic gap: a full `npm test`
    // with no sub-agent alive, 12 minutes of silence on every file.
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a'), reviewCard('b', 'swarm/b')],
      managerPresence: 'active',
      managerDeliveryAt: (now) => now - 12 * 60_000,
    })
    for (let i = 0; i <= 12; i++) await passAt(engine, deps, T0 + i * 30 * 60_000) // six hours
    expect(deps.nudged).toEqual([]) // ← 完了条件2: no false poke, however long the queue is
    expect(deps.wakeCalls).toEqual([])
    expect(engine.managerResume?.nudges ?? 0).toBe(0)
    expect(engine.log.some((l) => l.message.includes('統合が進んでいません'))).toBe(false)
    // The desk being demonstrably up must ALSO keep refunding the give-up budget, or a
    // long integration would drift toward a false 'manager-unrevivable' (2026-07-22 nit).
    expect(engine.managerResume?.provenSinceWake).toBe(true)
  })

  it('(2b) even a desk whose BEAT is hours old is left alone while its sub-agents move', async () => {
    // The same failure the 差し戻し caught, stated as the boundary: delivery just inside
    // the window is silence, just outside it is a poke. Nothing else differs — so this
    // pins that the rule reads DELIVERY and not the beat.
    const quiet = newEngine()
    const working = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresence: 'active',
      managerDeliveryAt: (now) => now - (MANAGER_INTEGRATION_STALL_MS - 1),
    })
    await passAt(quiet, working, T0)
    await passAt(quiet, working, T0 + MANAGER_INTEGRATION_STALL_MS)
    expect(working.nudged).toEqual([])
    const stopped = newEngine()
    const dead = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresence: 'active',
      managerDeliveryAt: (now) => now - MANAGER_INTEGRATION_STALL_MS,
    })
    await passAt(stopped, dead, T0)
    await passAt(stopped, dead, T0 + MANAGER_INTEGRATION_STALL_MS)
    expect(dead.nudged).toEqual([stopped.path])
  })

  it('(3) a card that JUST landed never triggers a poke, however old the last beat is', async () => {
    // The dwell half of the rule. Without it, a desk the owner is talking to would take an
    // ESC the instant a worker promotes, purely because the previous round ended long ago.
    const engine = newEngine()
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresence: 'active',
      managerDeliveryAt:T0 - 24 * 60 * 60_000, // yesterday
    })
    await passAt(engine, deps, T0)
    expect(deps.nudged).toEqual([])
    expect(deps.deliveryReads).toBe(0) // the in-memory dwell clock gates the read — no IO at all
  })

  it('(4) integration PROGRESS restarts the clock — it measures the OLDEST card, not the queue', async () => {
    // A queue that is never EMPTY but is MOVING is a commander doing its job. The clock is
    // per-branch and pruned on the same sweep that forgets the conflict/verify memos, so a
    // card leaving review carries its entry out with it.
    const engine = newEngine()
    const beat = T0 - 60_000
    const first = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresence: 'active',
      managerDeliveryAt:beat,
    })
    await passAt(engine, first, T0)
    expect(engine.reviewSeenAt?.get('swarm/a')).toBe(T0)
    // 30 minutes on: 'a' has been integrated and 'b' has arrived in its place.
    const later = T0 + 30 * 60_000
    const second = makeIntDeps({
      reviews: [reviewCard('b', 'swarm/b')],
      managerPresence: 'active',
      managerDeliveryAt:beat,
    })
    await passAt(engine, second, later)
    expect(engine.reviewSeenAt?.has('swarm/a')).toBe(false) // pruned with the card
    expect(engine.reviewSeenAt?.get('swarm/b')).toBe(later)
    // 20 minutes later 'a' would have been 50 minutes old (past the window); 'b' is 20.
    await passAt(engine, second, later + 20 * 60_000)
    expect(second.nudged).toEqual([])
    // 'b' still gets there on its OWN clock — the reset delays the poke, never cancels it.
    await passAt(engine, second, later + MANAGER_INTEGRATION_STALL_MS)
    expect(second.nudged).toEqual([engine.path])
  })

  it('(5) the spent nudge budget is RE-ARMED once while the queue is still stuck — never mute forever', async () => {
    const engine = newEngine()
    // "Budget spent" is a verdict about the DESK, but the episode only ends when review
    // DRAINS — so on a batch that never drains the engine used to go mute for the rest of
    // that batch's life, which is the same observable silence as the bug itself.
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresence: 'idle',
      managerDeliveryAt:T0 - MANAGER_INTEGRATION_STALL_MS, // stopped before the card even landed
    })
    for (let i = 0; i < MAX_MANAGER_NUDGES; i++) await passAt(engine, deps, T0 + i * MANAGER_NUDGE_INTERVAL_MS)
    expect(deps.nudged).toHaveLength(MAX_MANAGER_NUDGES) // budget spent the ordinary way
    const lastNudge = T0 + (MAX_MANAGER_NUDGES - 1) * MANAGER_NUDGE_INTERVAL_MS
    // Inside the backoff: silent. The budget still means something.
    await passAt(engine, deps, lastNudge + MANAGER_NUDGE_REARM_MS - 1)
    expect(deps.nudged).toHaveLength(MAX_MANAGER_NUDGES)
    // A full hour of PROVABLE stall later (nothing moved, no beat) → one round given back.
    await passAt(engine, deps, lastNudge + MANAGER_NUDGE_REARM_MS)
    expect(deps.nudged).toHaveLength(MAX_MANAGER_NUDGES + 1)
    // …and exactly one, however long the batch is parked: ≤6 pokes, then a human matter.
    for (let i = 1; i <= 60; i++) {
      await passAt(engine, deps, lastNudge + MANAGER_NUDGE_REARM_MS + i * MANAGER_NUDGE_INTERVAL_MS)
    }
    expect(deps.nudged).toHaveLength(2 * MAX_MANAGER_NUDGES)
    expect(deps.wakeCalls).toEqual([]) // and the re-arm never spilled into a spawn…
    expect(deps.notifications).toEqual([]) // …nor into a fatal (the desk is up — 完了条件3)
  })

  it('(6) a desk seen WORKING ends the stall episode — the next silence gets the full voice back', async () => {
    const engine = newEngine()
    const stuck = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresence: 'active',
      managerDeliveryAt:T0 - 60_000,
    })
    await passAt(engine, stuck, T0) // the card lands — the dwell clock starts here
    await passAt(engine, stuck, T0 + MANAGER_INTEGRATION_STALL_MS)
    expect(stuck.nudged).toHaveLength(1)
    expect(engine.managerResume?.stallLogged).toBe(true)
    // The commander picks the work up and beats again → the episode is over.
    const working = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresence: 'active',
      managerDeliveryAt:(now) => now,
    })
    await passAt(engine, working, T0 + MANAGER_INTEGRATION_STALL_MS + 60_000)
    expect(working.nudged).toEqual([])
    expect(engine.managerResume?.nudges).toBe(0)
    expect(engine.managerResume?.stallLogged).toBe(false)
    expect(engine.managerResume?.nudgeRearmed).toBe(false)
  })

  it('(7) a stall NEVER diverts the resurrection path — an ABSENT desk is still spawned', async () => {
    // A stall is a statement about the WORK, and it is true of a desk that is GONE too
    // (nothing is integrating because there is nothing to integrate with). If the stall
    // gate captured 'absent' as well as 'active', the pass would nudge a PTY that does not
    // exist — no spawn, no 'manager-unrevivable' — disabling recovery in exactly the
    // situation this card exists to fix. The card's scope is the NUDGE condition only.
    const engine = newEngine()
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresence: 'absent',
      managerDeliveryAt:T0 - MANAGER_INTEGRATION_STALL_MS, // long stopped: the stall IS satisfied
    })
    await passAt(engine, deps, T0) // the card lands; the desk is already gone
    expect(deps.wakeCalls).toHaveLength(1)
    // Far past the stall window, with the desk still absent: the reflex must keep spawning
    // on its own schedule and still escalate when it gives up.
    for (let i = 1; i <= MAX_MANAGER_RESUME_ATTEMPTS; i++) {
      await passAt(engine, deps, T0 + MANAGER_INTEGRATION_STALL_MS + i * MANAGER_RESUME_GRACE_MS)
    }
    expect(deps.wakeCalls).toHaveLength(MAX_MANAGER_RESUME_ATTEMPTS)
    expect(deps.nudged).toEqual([]) // never poked at a desk that is not there
    expect(deps.notifications.map((n) => n.event)).toEqual(['manager-unrevivable'])
  })

  it('(8) time the engine was OFF is not 「統合待ち」 — a restart never ESCs a live desk', async () => {
    // The owner stops the engine precisely in order to work at the commander desk by hand
    // (observed 2026-07-22: several OFF/ON cycles during an incident). Nothing beats while
    // they do. If the dwell clock kept running across the stop, the FIRST pass after the
    // restart — which is immediate, because startOrchestrator zeroes lastIntegrateAt —
    // would already be past the window and fire an ESC into the session they are using.
    const engine = newEngine()
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresence: 'active',
      managerDeliveryAt: T0 - 60_000,
    })
    await passAt(engine, deps, T0) // the card is seen while the engine is ON
    expect(engine.reviewSeenAt?.get('swarm/a')).toBe(T0)
    // Engine OFF for well over the stall window, then ON again. The ON transition drops
    // the clock — that half is pinned on the REAL startOrchestrator in the auto-start
    // describe ('startOrchestrator DROPS the review dwell clock…'); here we pin what the
    // PASS does with a dropped clock, which is the half that decides the poke.
    const backAt = T0 + 3 * MANAGER_INTEGRATION_STALL_MS
    engine.running = false
    engine.reviewSeenAt?.clear()
    engine.running = true
    await passAt(engine, deps, backAt)
    expect(deps.nudged).toEqual([]) // ← the fix: the wait restarts from the restart
    expect(engine.reviewSeenAt?.get('swarm/a')).toBe(backAt)
    // …and the card is not forgiven either — it simply waits its full window from here.
    await passAt(engine, deps, backAt + MANAGER_INTEGRATION_STALL_MS)
    expect(deps.nudged).toEqual([engine.path])
  })

  it('managerIntegrationStalled — the rule itself (pure)', () => {
    const now = T0
    const S = MANAGER_INTEGRATION_STALL_MS
    // Both clocks past the window ⇒ stalled.
    expect(managerIntegrationStalled({ waitingSinceMs: now - S, deliveryAtMs: now - S, now })).toBe(true)
    // Work waiting but the desk IS producing (beat / transcript / sub-agent append) ⇒
    // integrating, not stalled (完了条件2 — and the 2026-07-22 差し戻し in one line).
    expect(managerIntegrationStalled({ waitingSinceMs: now - 10 * S, deliveryAtMs: now - S + 1, now })).toBe(false)
    // Nothing produced for ages but the work only just arrived ⇒ nothing to say yet.
    expect(managerIntegrationStalled({ waitingSinceMs: now - S + 1, deliveryAtMs: now - 10 * S, now })).toBe(false)
    // Nothing waiting at all ⇒ never stalled.
    expect(managerIntegrationStalled({ waitingSinceMs: null, deliveryAtMs: now - 10 * S, now })).toBe(false)
    // NO channel has anything to say ⇒ fail-open, same as isManagerHeartbeatFresh: we know
    // nothing about this desk, so we do not poke it. It is still covered by the ordinary
    // paint-goes-quiet 'idle' path.
    expect(managerIntegrationStalled({ waitingSinceMs: now - 10 * S, deliveryAtMs: null, now })).toBe(false)
  })

  it('a desk that only ever leaves a SHELL behind still reaches manager-unrevivable (provenSinceWake)', async () => {
    // The other half of the flapping story, and the one that actually exercises the idle
    // refund gate. `launchClaude` runs claude inside a login shell, so a boot that dies on
    // arrival can leave the SHELL alive: the PTY is live, nothing ever paints again, and
    // presence reads 'idle' — not 'absent' — for as long as that shell lingers. Past the
    // boot grace the idle branch would normally refund `attempts` ("a live desk falsifies
    // 'unrevivable'"), which would retire the give-up guard for precisely the boot-crash
    // case it exists for. `provenSinceWake` is what stops that: a desk that has never once
    // been SEEN working has proved nothing, so the budget keeps accruing.
    //
    // NB this deliberately outlives the grace — the sibling FLAPPING test never gets here
    // because its desk dies inside the grace window, so it cannot pin this gate.
    const engine = newEngine()
    let shellUp = false
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresenceFn: () => (shellUp ? 'idle' : 'absent'),
    })
    let spawns = 0
    let at = T0
    for (let i = 0; i < 60; i++) {
      at = T0 + i * 60_000 // a minute apart, so grace windows really elapse
      await passAt(engine, deps, at)
      if (deps.wakeCalls.length > spawns) {
        spawns = deps.wakeCalls.length
        shellUp = true // claude died instantly; only the login shell is left
      } else if (shellUp && at - (engine.managerResume?.lastWakeAt ?? 0) > MANAGER_RESUME_GRACE_MS * 2) {
        shellUp = false // the orphaned shell finally exits → 'absent' → next resurrection
      }
    }
    // It must give up and TELL the owner rather than resurrect a dead boot forever.
    expect(deps.notifications.map((n) => n.event)).toEqual(['manager-unrevivable'])
    expect(deps.wakeCalls.length).toBeLessThanOrEqual(MAX_MANAGER_RESUME_ATTEMPTS)
  })

  it('a NEW batch never inherits the previous desk\'s unproven verdict (no false fatal on a live desk)', async () => {
    // provenSinceWake describes THE DESK WE LAST SPAWNED. If a drain (no integrable work)
    // does not clear it, the next batch judges a live, answering desk on a previous
    // episode's verdict: `lastWakeAt` is cleared so the boot grace cannot apply, and
    // `provenSinceWake===false` blocks the idle refund, so `attempts` climbs to a
    // manager-unrevivable fatal against a desk that is demonstrably up. That is the exact
    // harm this card exists to remove, re-entering by the back door.
    const engine = newEngine()
    let present = false
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresenceFn: () => (present ? 'idle' : 'absent'),
    })
    // Episode 1: work waiting, no desk → spawn. The desk comes up and does the whole
    // integration WITHOUT the engine ever sampling it as 'active' (the probe is a 15s
    // tick; a batch can drain between two of them).
    await passAt(engine, deps, T0)
    expect(deps.wakeCalls).toHaveLength(1)
    expect(engine.managerResume?.provenSinceWake).toBe(false)
    present = true

    // The batch drains — no integrable work left. The reflex must disarm FULLY.
    const drained = makeIntDeps({ reviews: [], managerPresence: 'idle' })
    await passAt(engine, drained, T0 + 60_000)
    expect(engine.managerResume?.provenSinceWake).not.toBe(false) // ← the leak

    // Episode 2: a new batch arrives and the SAME desk is live but quiet. The verdict it
    // is judged by must be the DEFAULT (proven), not the corpse of episode 1.
    const next = makeIntDeps({ reviews: [reviewCard('b', 'swarm/b')], managerPresence: 'idle' })
    await passAt(engine, next, T0 + 120_000)
    expect(next.wakeCalls).toEqual([]) // a live desk is never duplicated
    expect(next.notifications).toEqual([]) // …nor escalated about
    expect(engine.managerResume?.attempts).toBe(0) // and the give-up budget stays refunded
  })

  it('a FLAPPING desk (boots, echoes the launch line, dies) still reaches manager-unrevivable', async () => {
    // launchClaude writes the launch command INTO the fresh PTY, and the login shell
    // echoes it back within milliseconds (claudeTerminal.ts). That echo alone satisfies
    // "painted recently", so a desk that boots and dies without ever doing work used to
    // read 'active' on the very next tick and zero `attempts` — meaning a desk that flaps
    // could never reach MAX_MANAGER_RESUME_ATTEMPTS, and the infinite-resurrection guard
    // silently retired for the exact cases it exists for (context overflow / API error /
    // boot-crash). Measured before the fix: 72 spawns in 6h, zero escalation. The echo
    // discount must therefore cover the SPAWN write, not only the nudge.
    const engine = newEngine()
    let bootEchoAt = -Infinity // the launch line bouncing off the shell
    let deskUp = false
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      managerPresenceFn: (now, echoUntil) => {
        if (!deskUp) return 'absent'
        const real = echoUntil > 0 && bootEchoAt <= echoUntil ? -Infinity : bootEchoAt
        return now - real < MANAGER_NUDGE_INTERVAL_MS ? 'active' : 'idle'
      },
    })
    let at = T0
    let spawns = 0
    for (let i = 0; i < 200; i++) {
      at = T0 + i * 30_000 // probe every 30s, well inside the boot grace
      await passAt(engine, deps, at)
      if (deps.wakeCalls.length > spawns) {
        // It booted: the launch line echoes at once, and the desk lives ~60s then dies.
        spawns = deps.wakeCalls.length
        bootEchoAt = at
        deskUp = true
      } else if (deskUp && at - bootEchoAt >= 60_000) {
        deskUp = false // dead again — nothing but the boot echo was ever produced
      }
    }
    // The guard must fire: a desk that only ever echoed its own launch line has NOT been
    // raised, so the budget must keep accruing until it gives up and tells the owner.
    // (Before: 20 spawns, 0 fatals, 0 warnings — a silent token-burn loop.)
    expect(deps.notifications.map((n) => n.event)).toEqual(['manager-unrevivable'])
    expect(deps.wakeCalls.length).toBeLessThanOrEqual(MAX_MANAGER_RESUME_ATTEMPTS)
  })

  it('hands the probe an echo cutoff of lastNudgeAt + STALL_ECHO_GUARD_MS (0 before any poke)', async () => {
    // The wiring the two tests around this one depend on: without the cutoff reaching the
    // probe, the discount cannot happen at all and the fix is inert.
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    await passAt(engine, deps, T0)
    expect(deps.echoUntils).toEqual([0]) // nothing poked yet ⇒ nothing to discount
    await passAt(engine, deps, T0 + MANAGER_NUDGE_INTERVAL_MS)
    expect(deps.echoUntils[1]).toBe(T0 + STALL_ECHO_GUARD_MS)
  })

  it('a desk that REALLY answers the nudge still refunds its budget — the guard is not a gag', async () => {
    // The mirror of the test above: the discount must be narrow enough that genuine
    // recovery still counts. A desk that actually processes the poke keeps painting long
    // past the guard (streaming output), so it reads 'active' and the budget resets —
    // otherwise the fix would silence a healthy desk after three lifetime pokes.
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle' })
    await passAt(engine, deps, T0)
    expect(deps.nudged).toHaveLength(1)
    expect(engine.managerResume?.nudges).toBe(1)
    // It wakes up and works (sustained activity, far past STALL_ECHO_GUARD_MS).
    const working = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'active' })
    await passAt(engine, working, T0 + 5 * 60_000)
    expect(engine.managerResume?.nudges).toBe(0) // refunded — real work is not an echo
  })

  it('a nudge whose PTY write FAILS still counts (no tight retry loop) and stays non-fatal', async () => {
    const engine = newEngine()
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], managerPresence: 'idle', nudgeFails: true })
    await passAt(engine, deps, T0)
    await passAt(engine, deps, T0 + 1000) // immediately again — throttled regardless of outcome
    expect(deps.nudged).toHaveLength(1)
    expect(engine.log.some((l) => l.message.includes('PTY への書き込みに失敗'))).toBe(true)
    expect(deps.notifications).toEqual([])
    expect(deps.wakeCalls).toEqual([]) // a failed nudge must not fall back to spawning a twin
  })
})

// ── Learning loop — 差し戻し原因を次の再dispatchの /order に注入 (card fdf714ef) ──────
// The whole point: a 差し戻し/rollback shouldn't repeat. A rework cause RECORDED on
// engine.reworkReasons (post 2026-07-15 the engine no longer reworks during integrate
// — the commander does — so the durable memo is now written by the C1 owner-answer /
// escalation path, modelled here by seeding it directly); the NEXT dispatch of that
// SAME card HANDS the reason to the fresh worker's /order (so it doesn't repeat the
// failure) and the engine log records that the context was injected. Reproduced
// end-to-end (HOME-free, fully faked) on one engine via runDispatchPass.
describe('learning loop — rework reason injected into the re-dispatch /order (card fdf714ef)', () => {
  it('injects a recorded rework cause into the re-dispatched card /order + logs it', async () => {
    // 1) 差し戻し原因が engine state に記録済み(C1 owner-answer 経路が書く durable memo を直接 seed)。
    const engine = newEngine({ reworkReasons: new Map([['a', 'tsc: error TS2345 foo not assignable to bar']]) })
    // 条件1: 差し戻しの原因が engine state に記録されている。
    expect(engine.reworkReasons.get('a')).toContain('TS2345')

    // 2) 再 dispatch: カードは todo に戻っている。runDispatchPass が前回原因を /order に注入。
    const dispDeps = makeDeps({ cards: [card('a', { boardColumn: 'todo' })] })
    await runDispatchPass(engine, dispDeps)
    // 条件2: 同カードの再 dispatch で spawnWorker(=/order) に前回失敗原因が渡る。
    expect(dispDeps.spawned).toHaveLength(1)
    expect(dispDeps.spawned[0].taskId).toBe('a')
    expect(dispDeps.spawned[0].priorFailure).toContain('TS2345')
    // 条件3: 文脈注入の有無が engine log に残る。
    expect(engine.log.some((l) => l.message.includes('前回差し戻しの原因を /order に注入'))).toBe(true)
    // 消費される: 次の(無関係な)再 dispatch が古い原因を再注入しないよう memo は消える。
    expect(engine.reworkReasons.has('a')).toBe(false)
  })

  it('a FIRST dispatch (no prior 差し戻し) injects nothing — no priorFailure, no inject log', async () => {
    const engine = newEngine()
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'todo' })] })
    await runDispatchPass(engine, deps)
    expect(deps.spawned).toHaveLength(1)
    expect(deps.spawned[0].priorFailure).toBeUndefined()
    expect(engine.log.some((l) => l.message.includes('前回差し戻しの原因'))).toBe(false)
  })

  it('keeps the memo when the re-dispatch spawn THROWS — retried (not consumed) next pass', async () => {
    const engine = newEngine({ reworkReasons: new Map([['a', 'tsc: error TS9999 boom']]) })
    const deps = makeDeps({ cards: [card('a', { boardColumn: 'todo' })], spawnFails: new Set(['a']) })
    await runDispatchPass(engine, deps)
    expect(deps.spawned).toHaveLength(0) // spawn threw
    expect(engine.reworkReasons.get('a')).toContain('TS9999') // NOT consumed — survives for the retry
  })
})

describe('pruneReworks', () => {
  it('clears only at done|deleted; KEEPS todo (engine re-dispatch), doing/review (mid-cycle), blocked (parked)', () => {
    const engine = newEngine({
      reworks: new Map([
        ['t', 1], // → todo: KEPT — the engine's dead-worker re-dispatch must carry the budget across
        ['d', 1], // → done: cleared (success)
        ['g', 2], // → doing: kept (mid-cycle)
        ['v', 1], // → review: kept (mid-cycle)
        ['b', MAX_REWORKS + 1], // → blocked: kept (feeds the anomaly)
        ['gone', 1], // deleted card: cleared
      ]),
    })
    const tasks = [
      card('t', { boardColumn: 'todo' }),
      card('d', { boardColumn: 'done', done: true }),
      card('g', { boardColumn: 'doing' }),
      card('v', { boardColumn: 'review' }),
      card('b', { boardColumn: 'blocked' }),
    ]
    pruneReworks(engine, tasks)
    expect(engine.reworks.get('t')).toBe(1) // KEPT — re-dispatch must not reset the cap (MAJOR fix)
    expect(engine.reworks.has('d')).toBe(false)
    expect(engine.reworks.get('g')).toBe(2)
    expect(engine.reworks.get('v')).toBe(1)
    expect(engine.reworks.get('b')).toBe(MAX_REWORKS + 1)
    expect(engine.reworks.has('gone')).toBe(false)
  })

  it('prunes the LEARNING-LOOP reasons (card fdf714ef) on the SAME rule as the counter', () => {
    const engine = newEngine({
      reworkReasons: new Map([
        ['t', 'tsc red'], // → todo: KEPT — a pending re-dispatch must still inject it
        ['d', 'tsc red'], // → done: cleared (success)
        ['g', 'tsc red'], // → doing: kept (crash→requeue still carries it)
        ['v', 'tsc red'], // → review: kept (mid-cycle)
        ['gone', 'tsc red'], // deleted card: cleared
      ]),
    })
    const tasks = [
      card('t', { boardColumn: 'todo' }),
      card('d', { boardColumn: 'done', done: true }),
      card('g', { boardColumn: 'doing' }),
      card('v', { boardColumn: 'review' }),
    ]
    pruneReworks(engine, tasks)
    expect(engine.reworkReasons.get('t')).toBe('tsc red') // KEPT for the pending re-dispatch
    expect(engine.reworkReasons.has('d')).toBe(false)
    expect(engine.reworkReasons.get('g')).toBe('tsc red')
    expect(engine.reworkReasons.get('v')).toBe('tsc red')
    expect(engine.reworkReasons.has('gone')).toBe(false)
  })
})

// ── Adversarial review — majority vote (card a14329dc) ─────────────────────────
// The PURE tally that decides the panel's verdict. STRICT majority of the FULL
// panel; ties / non-votes DEFER (never a silent merge, never a 差し戻し bump).
describe('tallyReview — adversarial-review majority vote', () => {
  const v = (vote: ReviewerVerdict['vote'], note = ''): ReviewerVerdict => ({ reviewer: 0, vote, note })

  it('majority must-fix → rework (condition 2), carrying the first must-fix note', () => {
    const r = tallyReview([v('must-fix', 'off-by-one'), v('must-fix'), v('clean')], 3)
    expect(r.decision).toBe('rework')
    expect(r.mustFix).toBe(2)
    expect(r.clean).toBe(1)
    expect(r.reason).toContain('off-by-one')
  })

  it('unanimous must-fix → rework', () => {
    expect(tallyReview([v('must-fix'), v('must-fix'), v('must-fix')], 3).decision).toBe('rework')
  })

  it('all clean → integrate (condition 3)', () => {
    const r = tallyReview([v('clean'), v('clean'), v('clean')], 3)
    expect(r.decision).toBe('integrate')
    expect(r.clean).toBe(3)
  })

  it('minority must-fix (1 of 3) is OUTVOTED → integrate', () => {
    expect(tallyReview([v('must-fix', 'nit'), v('clean'), v('clean')], 3).decision).toBe('integrate')
  })

  it('a tie among decisive votes (1-1, one abstention) → defer — thin signal, never merge', () => {
    const r = tallyReview([v('must-fix'), v('clean'), v(null)], 3)
    expect(r.decision).toBe('defer')
    expect(r.mustFix).toBe(1)
    expect(r.clean).toBe(1)
  })

  it('all reviewers abstained (no parseable verdict) → defer, not a merge', () => {
    expect(tallyReview([v(null), v(null), v(null)], 3).decision).toBe('defer')
  })

  it('a lone clean vote (2 abstentions) does NOT reach majority → defer (a non-vote cannot lower the bar)', () => {
    // panelSize 3 ⇒ majority 2; only ONE decisive (clean) vote ⇒ no majority ⇒ defer.
    expect(tallyReview([v('clean'), v(null), v(null)], 3).decision).toBe('defer')
  })

  it('majority is computed over the FULL panel size, not the votes cast', () => {
    // Two must-fix out of a panel of 3 ⇒ majority (2) reached even with a missing vote.
    expect(tallyReview([v('must-fix'), v('must-fix'), v(null)], 3).decision).toBe('rework')
  })
})

describe('extractReviewVerdict — verdict marker scrape', () => {
  it('parses a CLEAN marker', () => {
    expect(extractReviewVerdict(`blah\n${'OPENGROUND_REVIEW:'} CLEAN ::OG_REVIEW_END::`)).toEqual({
      vote: 'clean',
      note: '',
    })
  })

  it('parses a MUST_FIX marker + its note', () => {
    const raw = 'reading files…\nOPENGROUND_REVIEW: MUST_FIX deletes the safety net ::OG_REVIEW_END::'
    expect(extractReviewVerdict(raw)).toEqual({ vote: 'must-fix', note: 'deletes the safety net' })
  })

  it('survives ANSI / cursor-position noise the TUI emits (no word fusing)', () => {
    // CSI cursor-forward between words must become a space, not vanish.
    const raw = '\x1b[2J\x1b[32mOPENGROUND_REVIEW:\x1b[0m MUST_FIX race\x1b[5C condition ::OG_REVIEW_END::'
    const r = extractReviewVerdict(raw)
    expect(r.vote).toBe('must-fix')
    expect(r.note).toContain('race')
    expect(r.note).toContain('condition')
  })

  it('takes the LAST verdict when the stream has several (the final answer)', () => {
    const raw =
      'OPENGROUND_REVIEW: MUST_FIX first ::OG_REVIEW_END:: … rethought …\nOPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::'
    expect(extractReviewVerdict(raw).vote).toBe('clean')
  })

  it('REGRESSION: a real MUST_FIX note containing "<" is parsed (not flipped to clean/null)', () => {
    // The old `!body.includes('<')` guard silently dropped exactly the must-fix notes an
    // adversarial reviewer is MOST likely to write — comparisons / generics / JSX.
    for (const note of ['the loop uses i < n but must be i <= n', 'returns List<T> unsorted', 'unclosed <div> in the mock']) {
      const r = extractReviewVerdict(`reasoning…\nOPENGROUND_REVIEW: MUST_FIX ${note} ::OG_REVIEW_END::`)
      expect(r.vote).toBe('must-fix')
      expect(r.note).toBe(note)
    }
  })

  it('SKIPS the prompt’s echoed `<VERDICT>` placeholder (its body is not a vote token)', () => {
    // The echoed example line has body "<VERDICT>" → starts with neither MUST_FIX nor
    // CLEAN → skipped → a non-vote (NOT a false clean).
    expect(extractReviewVerdict('OPENGROUND_REVIEW: <VERDICT> ::OG_REVIEW_END::')).toEqual({ vote: null, note: '' })
  })

  it('SAFETY: a buffer with ONLY the echoed prompt (reviewer abstained) is a non-vote, never clean', () => {
    // A reviewer that hangs / times out emits no verdict of its own — its buffer is just
    // the echoed prompt. That MUST scrape to null (→ defer), never to a clean vote.
    expect(extractReviewVerdict(buildReviewPrompt('origin/main')).vote).toBeNull()
  })

  it('the vote token must be a WHOLE WORD — a CLEAN/MUST_FIX *prefix* never fails open to a vote', () => {
    // A contract-violating body that merely begins with a vote-token prefix is NOT a
    // vote (the dangerous direction — "CLEANUP" → clean — is the one we must never take).
    expect(extractReviewVerdict('OPENGROUND_REVIEW: CLEANUP the dead code ::OG_REVIEW_END::').vote).toBeNull()
    expect(extractReviewVerdict('OPENGROUND_REVIEW: CLEANED already ::OG_REVIEW_END::').vote).toBeNull()
    expect(extractReviewVerdict('OPENGROUND_REVIEW: MUST_FIXED earlier ::OG_REVIEW_END::').vote).toBeNull()
    // But the real tokens — alone, or followed by a space/punctuation — still parse.
    expect(extractReviewVerdict('OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::').vote).toBe('clean')
    expect(extractReviewVerdict('OPENGROUND_REVIEW: CLEAN. ::OG_REVIEW_END::').vote).toBe('clean')
    expect(extractReviewVerdict('OPENGROUND_REVIEW: MUST_FIX bug ::OG_REVIEW_END::').vote).toBe('must-fix')
  })

  it('no marker at all → a non-vote (vote:null)', () => {
    expect(extractReviewVerdict('the model rambled but never emitted a verdict')).toEqual({ vote: null, note: '' })
  })
})

describe('buildReviewPrompt — the reviewer contract', () => {
  it('embeds the trunk ref + the verdict marker template and the two vote words (read-only)', () => {
    const p = buildReviewPrompt('origin/main')
    expect(p).toContain('git diff origin/main...HEAD')
    expect(p).toContain('OPENGROUND_REVIEW: <VERDICT> ::OG_REVIEW_END::') // the template line
    expect(p).toContain('MUST_FIX')
    expect(p).toContain('CLEAN')
    expect(p).toContain('::OG_REVIEW_END::')
    expect(p).toMatch(/independent adversarial code reviewer/i)
    expect(p).toMatch(/READ-ONLY/i)
  })

  it('ECHO-SAFE: the prompt has NO line that scrapes to a real vote (the abstention safeguard)', () => {
    // The whole point of the <VERDICT> template: the prompt's only verdict-shaped span
    // is the placeholder, which is NOT a vote token. So a reviewer that emits nothing
    // (its buffer = just the echoed prompt) scrapes to a non-vote, never a false clean.
    expect(extractReviewVerdict(buildReviewPrompt('origin/main')).vote).toBeNull()
    // Belt-and-suspenders: no bare echoed vote line.
    expect(buildReviewPrompt('origin/main')).not.toContain('OPENGROUND_REVIEW: CLEAN ::OG_REVIEW_END::')
    expect(buildReviewPrompt('origin/main')).not.toContain('OPENGROUND_REVIEW: MUST_FIX ')
  })
})

// ── HIGH-RISK PATH SET (2026-07-15) — 高リスクパスの単一定義 ─────────────────────
// HIGH_RISK_PATHS は「人間の手動統合以外で main に入れてはいけない」高リスク集合の単一
// 定義。2026-07-15 のマネージャ専任化でエンジンは統合自体をやめた(force-hold は engine
// 側では dormant)ので、この集合が裏付けるのは司令官の手動統合規約 skills/og-manage
// §「マージ」手順 0 のみ。集合は規約と同一で、下の同期テストが文言ごと固定する。

describe('highRiskChangedPaths — the HIGH_RISK_PATHS set', () => {
  it.each([
    '.github/workflows/release.yml',
    '.github/workflows/new-pipeline.yml',
    'release.yml',
    'sub/dir/ci.yml',
    'package.json',
    'worker/package.json',
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb',
    'scripts/sign-and-notarize.sh',
    'scripts/codesign-app.sh',
    'electron/main.js',
    'src/lib/secretStore.ts',
    'config/secrets.json',
    '.env',
    '.env.local',
    'server/routes/auth.ts',
    'src/lib/auth/AuthContext.tsx',
    'src/lib/oauth.ts',
    'src/lib/token-store.ts',
    'api/tokens/refresh.ts',
    // camelCase 結合(2026-07-15 の穴 — セグメント境界 regex が素通りさせた実ファイル):
    'src/lib/server/supabaseAuth.ts', // OAuth/PKCE 本体(小文字+大文字 Auth)
    'src/lib/server/authStore.ts', // 認証セッションストア(セグメント頭 auth+大文字継続)
    'src/AuthGate.tsx', // セグメント頭 PascalCase
    'src/hooks/useAuth.tsx',
    'src/lib/supabaseOAuth.ts',
    'src/oauth2Client.ts', // 小文字 oauth+数字継続
    'src/lib/refreshTokens.ts',
    'src/tokenStore.ts',
    'src/lib/apiSecretKey.ts',
    // 認可の本体(パス名に auth を含まない決定層 — 明示列挙、2026-07-15):
    'src/lib/server/roles.ts', // owner 判定
    'src/lib/server/swarmGate.ts', // ローカル owner 解錠
    'src/lib/server/swarmAllowedModels.ts', // モデル allowlist
  ])('holds %s', (f) => {
    expect(highRiskChangedPaths([f])).toEqual([f])
  })

  // 誤爆最小化(完了条件3)— sign/auth/token はセグメント境界+camel 境界で判定するので、
  // design/assign/author/tokenizer 等の substring 一致は素通りする。camelCase companion は
  // case-sensitive: Author/Tokenizer(大文字語の右が小文字)も構造的にマッチしない。
  it.each([
    'src/App.tsx',
    'src/lib/server/swarmOrchestrator.ts', // swarm エンジン本体 — 認可の決定層ではない(広げない線引き)
    'src/lib/server/swarmOrchestrator.test.ts',
    'src/lib/server/swarmLaunch.ts', // 同上 — ここまで hold すると swarm 改修が全部止まり形骸化する
    'docs/commander/03-integration-review.md',
    'src/components/canvas/modules/SwarmOverseerPane.tsx',
    'src/design-system.ts',
    'src/lib/assignments.ts',
    'src/author-tools.ts',
    'docs/authoring.md',
    'src/AuthorList.tsx', // Auth の右が小文字 o — camel companion は掴まない
    'src/tokenizer.ts',
    'src/lib/tokenizer.ts',
    'src/Tokenizer.ts', // Token の右が小文字 i
    'src/detokenize.ts', // token がセグメント頭でない
    'electron/preload.js',
    'packages/core/index.ts',
    'src/environment.ts',
    'cicd.yml',
  ])('does NOT hold %s', (f) => {
    expect(highRiskChangedPaths([f])).toEqual([])
  })

  it('filters a mixed diff down to just the risky paths', () => {
    expect(
      highRiskChangedPaths(['src/App.tsx', '.github/workflows/release.yml', 'docs/x.md', 'electron/main.js']),
    ).toEqual(['.github/workflows/release.yml', 'electron/main.js'])
  })

  it('司令官規約(skills/og-manage/SKILL.md §マージ 手順0)と同一集合 — 規約の文言ごと固定', async () => {
    const md = await readFile(resolve(process.cwd(), 'skills/og-manage/SKILL.md'), 'utf8')
    // 規約の正典行。ここが変わったら集合がドリフトしている — HIGH_RISK_PATHS と
    // このテストの代表パスを同じコミットで直す(二重管理をテストで単一化する仕掛け)。
    // ⚠ この toContain 群は verbatim pin(文言の一致)であって意味の同期ではない —
    // pin が緑でも「regex が文言どおりのカバレッジを持つ」ことは保証しない
    // (2026-07-15: 文言に auth/token とありながら camelCase 実ファイルが素通りした)。
    // 実挙動の保証は下の rep ループと上の it.each(実ファイル HOLD/PASS)が担う。
    expect(md).toContain(
      '`.github/workflows/**`・`release.yml`/`ci.yml`・`package.json`/lockfile・署名/notary スクリプト・',
    )
    expect(md).toContain(
      '`electron/main.js`・`*secret*`/`.env*`/auth/token(camelCase 結合 `supabaseAuth.ts`/`authStore.ts` 型も掴む)・',
    )
    expect(md).toContain(
      '認可の本体(`roles.ts`/`swarmGate.ts`/`swarmAllowedModels.ts`)に触れていたら自動では入れず',
    )
    // 規約に列挙された各カテゴリの代表が実際に hold されることを機械で固定する。
    for (const rep of [
      '.github/workflows/anything.yml', // .github/workflows/**
      'release.yml', // release.yml
      'ci.yml', // ci.yml
      'package.json', // package.json
      'package-lock.json', // lockfile
      'scripts/sign-and-notarize.sh', // 署名/notary スクリプト
      'electron/main.js', // electron/main.js
      'lib/apiSecret.ts', // *secret*
      '.env.production', // .env*
      'server/routes/auth.ts', // auth
      'src/token.ts', // token
      // camelCase 結合(2026-07-15 追記) — 規約の括弧書きが指す実ファイル:
      'src/lib/server/supabaseAuth.ts',
      'src/lib/server/authStore.ts',
      // 認可の本体(2026-07-15 追記) — 規約の明示列挙と同一:
      'src/lib/server/roles.ts',
      'src/lib/server/swarmGate.ts',
      'src/lib/server/swarmAllowedModels.ts',
    ]) {
      expect(highRiskChangedPaths([rep]), rep).toEqual([rep])
    }
  })
})

describe('monitorWorkers — re-promote suppression after a 差し戻し (reworkAt)', () => {
  it('does NOT re-promote a just-reworked worker whose heartbeat is older than the 差し戻し', async () => {
    const NOW = Date.parse('2026-06-24T12:00:00Z')
    const reworkAt = new Date(NOW - 1000).toISOString() // 差し戻し 1s ago
    const staleBeatAt = new Date(NOW - 5000).toISOString() // done report 5s ago — BEFORE the 差し戻し
    const engine = newEngine({
      workers: [worker({ branch: 'swarm/a', taskId: 'a', terminalId: 'pty-a-1', stage: 'running', reworkAt })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 1]]), // has integrable work
      heartbeats: new Map([['a', { ready: true, blocked: false, at: staleBeatAt }]]), // STALE ready sign
    })
    await runDispatchPass(engine, deps, NOW)
    expect(deps.reviews).toHaveLength(0) // suppressed — NOT promoted on the stale pre-rework sign
    expect(engine.workers[0]?.stage).toBe('running')
    expect(engine.workers[0]?.reworkAt).toBe(reworkAt) // still awaiting a fresh sign
  })

  it('re-promotes once the worker posts a FRESH completion sign (heartbeat newer than the 差し戻し)', async () => {
    const NOW = Date.parse('2026-06-24T12:00:00Z')
    const reworkAt = new Date(NOW - 5000).toISOString() // 差し戻し 5s ago
    const freshBeatAt = new Date(NOW - 1000).toISOString() // re-reported done 1s ago — AFTER the 差し戻し
    const engine = newEngine({
      workers: [worker({ branch: 'swarm/a', taskId: 'a', terminalId: 'pty-a-1', stage: 'running', reworkAt })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 2]]), // fixed + committed
      heartbeats: new Map([['a', { ready: true, blocked: false, at: freshBeatAt }]]),
    })
    await runDispatchPass(engine, deps, NOW)
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }]) // promoted on the fresh sign
    expect(engine.workers[0]?.reworkAt).toBeUndefined() // suppression cleared on promote
  })

  // 外部差し戻し(Board API / UI ドラッグ)はエンジンの in-memory roster に届かない — roster が
  // stage:'done' のままだと従来は監視ループが永久スキップし、worker が直して ready を打ち
  // 直してもカードが doing に沈み続けた(2026-07-13 実運用で実測: 55分放置しても昇格せず)。
  // 監視ループが「stage:'done' なのにカードが doing」を外部差し戻しとして観測して再武装し、
  // 差し戻し前の古い心拍では再昇格せず、reworkAt より新しい心拍で初めて再昇格する — を
  // ①昇格 → ②Board 直接差し戻し → ③古い心拍で抑制 → ④新しい心拍で再昇格、の通しで固定。
  it('外部差し戻し(Board API 経由 review→doing)を観測して再武装 — 古い心拍では再昇格せず、新しい心拍で再昇格する', async () => {
    const NOW = Date.parse('2026-07-13T12:00:00Z')
    const firstBeatAt = new Date(NOW - 60_000).toISOString() // 初回の完了報告
    const heartbeats = new Map([['a', { ready: true, blocked: false, at: firstBeatAt }]])
    const engine = newEngine({
      workers: [worker({ branch: 'swarm/a', taskId: 'a', terminalId: 'pty-a-1', stage: 'running' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 1]]),
      heartbeats,
    })
    const observedLogs = () => engine.log.filter((l) => l.message.includes('Board 側の差し戻し')).length

    // ① エンジンがカードを review へ昇格(通常の完了経路)
    await runDispatchPass(engine, deps, NOW)
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(engine.workers[0]?.stage).toBe('done')
    expect(deps.board.get('a')?.boardColumn).toBe('review')

    // ② Board API 経由の差し戻し(エンジンを経由しない): POST /api/project/tasks {rework} と
    //    同じ書き込みをカードへ直接施す — roster は 'done' のまま、reworkAt も立っていない。
    const c = deps.board.get('a')
    if (!c) throw new Error('card lost')
    c.boardColumn = 'doing'
    c.done = false
    c.reworkCount = 1

    // ③ 次 tick: 外部差し戻しを観測 → stage='running' + reworkAt=now(観測 tick の時刻)で
    //    再武装。心拍ファイルはまだ差し戻し前の readyToMerge:true — これでは再昇格しない。
    const T1 = NOW + 30_000
    await runDispatchPass(engine, deps, T1)
    expect(deps.reviews).toHaveLength(1) // 古い心拍では再昇格しない
    expect(deps.board.get('a')?.boardColumn).toBe('doing')
    expect(engine.workers[0]?.stage).toBe('running')
    expect(engine.workers[0]?.reworkAt).toBe(new Date(T1).toISOString())
    expect(observedLogs()).toBe(1)

    // 古い心拍のまま更に tick が回っても沈黙のまま(再昇格も、観測ログ・reworkAt の連打もない)
    await runDispatchPass(engine, deps, T1 + 30_000)
    expect(deps.reviews).toHaveLength(1)
    expect(engine.workers[0]?.reworkAt).toBe(new Date(T1).toISOString()) // 基準時刻は据え置き
    expect(observedLogs()).toBe(1)

    // ④ worker が差し戻し後の新しい完了報告(reworkAt より新しい心拍)を打つ → 次 tick で再昇格
    heartbeats.set('a', { ready: true, blocked: false, at: new Date(T1 + 40_000).toISOString() })
    await runDispatchPass(engine, deps, T1 + 60_000)
    expect(deps.reviews).toHaveLength(2) // review へ再昇格した
    expect(deps.board.get('a')?.boardColumn).toBe('review')
    expect(engine.workers[0]?.stage).toBe('done')
    expect(engine.workers[0]?.reworkAt).toBeUndefined() // 抑制は昇格で解除
  })
})

// ── runEnginePass — re-entrancy guard (twin-dispatch defense) ──────────────────
// Observable (2): two passes never overlap, so the same card is never dispatched
// to two workers — even if a stale pass is still mid-spawn when another fires
// (the start→stop→start-during-spawn shape, or any future second driver).

describe('runEnginePass — never overlaps itself', () => {
  it('a second concurrent pass bails — a card is dispatched only ONCE', async () => {
    const engine = newEngine()
    let reachSpawn: () => void = () => {}
    const reachedSpawn = new Promise<void>((r) => (reachSpawn = r))
    const spawned: string[] = []
    const board = [card('a', { boardOrder: 0 })]
    const deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = {
      fetchTasks: async () => board.map((c) => ({ ...c })),
      spawnWorker: async (opts) => {
        reachSpawn() // signal: pass 1 is now mid-spawn (passInFlight already true)
        spawned.push(opts.title)
        await new Promise((r) => setTimeout(r, 20)) // hold the pass open
        return {
          terminalId: `pty-${spawned.length}`,
          agentSessionId: 's',
          worktree: '/wt',
          branch: 'swarm/a',
        }
      },
      moveToDoing: async () => true,
      moveToReview: async () => true,
      countCommitsAhead: async () => 0,
      readHeartbeat: async () => null,
      recoverCard: async () => true,
      recoverWorker: async () => ({ removed: true }),
      isAlive: () => true,
      lastOutputAt: () => null,
      nudge: () => true,
      escalate: async () => true,
      recentOutput: () => null,
      // Integration half — present but inert (no review cards).
      fetchReview: async () => [],
      changedPaths: async () => ({ tip: 'tip-x', files: [] }),
      prepareTarget: async () => 'main',
      classify: async () => 'ff',
      verify: async () => ({ ok: true, tip: null }),
      integrate: async () => ({ status: 'integrated', mode: 'ff' }),
      acquireLock: alwaysAcquireLock,
      moveToDone: async () => true,
      markConflict: async () => true,
      cleanup: async () => ({ removed: true }),
      killPty: () => {},
      instructRework: () => {},
      managerPresence: async () => 'absent',
      nudgeManager: async () => true,
      wakeManager: async () => true,
      worktreeExists: async () => true,
    }
    const p1 = runEnginePass(engine, deps)
    await reachedSpawn // pass 1 is inside spawn → passInFlight is set
    const p2 = runEnginePass(engine, deps) // must see passInFlight and bail
    await Promise.all([p1, p2])
    expect(spawned).toEqual(['task a']) // dispatched exactly once, not twice
    expect(engine.workers).toHaveLength(1)
    expect(engine.passInFlight).toBe(false) // cleared after the pass settled
  })
})

// ── runEnginePass ⇄ self-supply — the scan runs OFF the tick (audit 856daefb) ──
// The self-supply scan spawns tsc(120s) + eslint(120s) + vitest(240s) SEQUENTIALLY.
// It used to be awaited here, inside the passInFlight window — so for up to ~8 minutes
// the engine did no dispatch, no integrate, and (the dangerous part) no monitor: the
// stall / runaway / crash detection that recovers a wedged worker was simply not
// running. The pass is now fired and left to run beside the tick.

describe('runEnginePass — never blocks on the self-supply scan', () => {
  /** Poll `pred` until true (or the cap elapses) — returns the instant the state lands. */
  const waitUntil = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (pred()) return true
      await new Promise((r) => setTimeout(r, 5))
    }
    return pred()
  }

  it('returns while a scan is still spawning tools, and the NEXT tick still monitors', async () => {
    const engine = newEngine({ selfSupply: { ...initSelfSupplyRuntime(), enabled: true } })
    let fetches = 0
    let scanEntered = false
    let releaseScan: () => void = () => {}
    const scanGate = new Promise<void>((r) => (releaseScan = r))
    const deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps & SelfSupplyPassDeps = {
      fetchTasks: async () => {
        fetches++
        return []
      },
      spawnWorker: async () => ({
        terminalId: 'pty',
        agentSessionId: 's',
        worktree: '/wt',
        branch: 'swarm/a',
      }),
      moveToDoing: async () => true,
      moveToReview: async () => true,
      countCommitsAhead: async () => 0,
      readHeartbeat: async () => null,
      recoverCard: async () => true,
      recoverWorker: async () => ({ removed: true }),
      isAlive: () => true,
      lastOutputAt: () => null,
      nudge: () => true,
      escalate: async () => true,
      recentOutput: () => null,
      fetchReview: async () => [],
      changedPaths: async () => ({ tip: 'tip-x', files: [] }),
      prepareTarget: async () => 'main',
      classify: async () => 'ff',
      verify: async () => ({ ok: true, tip: null }),
      integrate: async () => ({ status: 'integrated', mode: 'ff' }),
      acquireLock: alwaysAcquireLock,
      moveToDone: async () => true,
      markConflict: async () => true,
      cleanup: async () => ({ removed: true }),
      killPty: () => {},
      instructRework: () => {},
      managerPresence: async () => 'absent',
      nudgeManager: async () => true,
      wakeManager: async () => true,
      worktreeExists: async () => true,
      // The scan stand-in: parked in its first scanner until the test releases it. The
      // REAL scanners spawn tsc/eslint/vitest — a test must never do that.
      selfSupplyDeps: {
        now: () => Date.now(),
        board: {
          read: async () => ({ description: '', tasks: [], notes: '', updatedAt: 't0' }),
          write: async (_p, d) => d,
        },
        scanTypeErrors: async () => {
          scanEntered = true
          await scanGate
          return []
        },
        scanLintErrors: async () => [],
        scanTestFailures: async () => [],
        scanTodoComments: async () => [],
      },
    }

    try {
      // Would hang here (until the test's own timeout) if the tick awaited the scan.
      await runEnginePass(engine, deps)
      expect(engine.passInFlight).toBe(false) // the tick let go…
      await waitUntil(() => scanEntered)
      expect(engine.selfSupply.scanInFlight).toBe(true) // …while the scan runs beside it

      // The next tick monitors normally instead of being frozen behind the scan — the
      // observable that matters: stall/runaway/crash detection keeps running.
      const before = fetches
      await runEnginePass(engine, deps)
      expect(fetches).toBeGreaterThan(before)
      expect(engine.selfSupply.scanInFlight).toBe(true) // still the SAME scan, not a second
    } finally {
      releaseScan()
    }
    expect(await waitUntil(() => !engine.selfSupply.scanInFlight)).toBe(true)
  })
})

// ── runEnginePass ⇄ integrate — the pass runs OFF the tick (21-min lag, leg ③) ──
// The integrate pass verifies each candidate branch with an inline tsc+vitest run
// (minutes) and can await a diff-scaled adversarial panel (~20m). It used to be
// awaited here, inside the passInFlight window — so every 3s tick bailed for the
// whole verify and the MONITOR was starved: the 実測 sequence armed auto-integrate
// at 15:23:09 and a due rate-limit sighting could not fire until the vitest run
// finished at 15:29:39. Same starvation shape (and same cure) as the self-supply
// scan above: the pass is kicked and left to run beside the tick.

describe('runEnginePass — never blocks on the integrate pass', () => {
  const waitUntil = async (pred: () => boolean, ms = 5000): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (pred()) return true
      await new Promise((r) => setTimeout(r, 5))
    }
    return pred()
  }

  const fullDeps = (over: {
    board: Map<string, ProjectTask>
    fetchReview: () => Promise<ProjectTask[]>
    // The integrate pass's SLOW await is now managerPresence (2026-07-15 — it no
    // longer verifies/reviews). Parked in test 1 to prove the tick doesn't block on it.
    managerPresence?: IntegrationDeps['managerPresence']
    recovered: { taskId: string; column: string }[]
    deadIds: Set<string>
  }): OrchestratorDeps & IntegrationDeps & AnomalyDeps & SelfSupplyPassDeps => ({
    fetchTasks: async () => Array.from(over.board.values()).map((c) => ({ ...c })),
    spawnWorker: async () => ({ terminalId: 'pty-x', agentSessionId: 's', worktree: '/wt/x', branch: 'swarm/x' }),
    moveToDoing: async () => true,
    moveToReview: async () => true,
    countCommitsAhead: async () => 0,
    readHeartbeat: async () => null,
    recoverCard: async (_p, taskId, column) => {
      over.recovered.push({ taskId, column })
      const c = over.board.get(taskId)
      if (c) c.boardColumn = column
      return true
    },
    recoverWorker: async () => ({ removed: true }),
    isAlive: (id) => !over.deadIds.has(id),
    lastOutputAt: () => null,
    nudge: () => true,
    escalate: async () => true,
    recentOutput: () => null,
    fetchReview: over.fetchReview,
    prepareTarget: async () => 'main',
    classify: async () => 'ff',
    changedPaths: async () => ({ tip: 'tip-x', files: [] }),
    verify: async () => ({ ok: true, tip: null }), // dead post-2026-07-15 (engine doesn't verify)
    integrate: async () => ({ status: 'integrated', mode: 'ff' }), // dead — engine never merges
    acquireLock: alwaysAcquireLock,
    moveToDone: async () => true,
    markConflict: async () => true,
    cleanup: async () => ({ removed: true }),
    killPty: () => {},
    instructRework: () => {},
    managerPresence: over.managerPresence ?? (async () => 'absent'),
    nudgeManager: async () => true,
    wakeManager: async () => true,
    worktreeExists: async () => true,
  })

  it('returns while a slow manager-wake probe is mid-flight, and the NEXT tick still MONITORS (完了条件3)', async () => {
    const engine = newEngine()
    let probeEntered = false
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>((r) => (releaseProbe = r))
    const board = new Map<string, ProjectTask>([
      ['r', { ...card('r', { boardColumn: 'review', branch: 'swarm/r' }) }],
    ])
    const recovered: { taskId: string; column: string }[] = []
    const deadIds = new Set<string>()
    const deps = fullDeps({
      board,
      fetchReview: async () => [{ ...board.get('r')! }],
      // The integrate pass's slow await is now the commander-presence probe — parked
      // until the test releases it. (The REAL one reads swarm-sessions + checks a live
      // PTY; even the wake it precedes spawns a claude — a unit test must never do that.)
      managerPresence: async () => {
        probeEntered = true
        await probeGate
        return 'active' // "desk already up AND working" — so nothing spawns or pokes here
      },
      recovered,
      deadIds,
    })

    try {
      // Would hang until the test timeout if the tick awaited the integrate pass.
      await runEnginePass(engine, deps)
      expect(engine.passInFlight).toBe(false) // the tick let go…
      await waitUntil(() => probeEntered)
      expect(engine.integrateInFlight).toBe(true) // …while the wake probe runs beside it

      // A worker dies while the probe is STILL mid-flight. The next tick must monitor
      // (detect + recover it) without waiting for the probe — this is the exact
      // starvation that delayed the 実測 rate-limit sighting to 15:29:39.
      board.set('gone', { ...card('gone', { boardColumn: 'doing', branch: 'swarm/gone' }) })
      engine.workers.push(
        worker({
          terminalId: 'pty-gone-1',
          branch: 'swarm/gone',
          worktree: '/wt/gone',
          taskId: 'gone',
          taskTitle: 'task gone',
          startedAt: new Date().toISOString(),
        }),
      )
      deadIds.add('pty-gone-1')
      await runEnginePass(engine, deps)
      expect(recovered).toEqual([{ taskId: 'gone', column: 'todo' }]) // the monitor RAN
      expect(engine.workers.some((w) => w.terminalId === 'pty-gone-1')).toBe(false)
      expect(engine.integrateInFlight).toBe(true) // the SAME probe still in flight — no second pass
    } finally {
      releaseProbe()
    }
    expect(await waitUntil(() => !engine.integrateInFlight)).toBe(true)
  })

  it('kickIntegratePass never overlaps two integrate passes (integrateInFlight guard)', async () => {
    const engine = newEngine()
    let reviewReads = 0
    let releaseReview: () => void = () => {}
    const reviewGate = new Promise<void>((r) => (releaseReview = r))
    const deps = fullDeps({
      board: new Map(),
      fetchReview: async () => {
        reviewReads++
        await reviewGate
        return []
      },
      recovered: [],
      deadIds: new Set(),
    })

    kickIntegratePass(engine, deps)
    expect(engine.integrateInFlight).toBe(true)
    kickIntegratePass(engine, deps) // both extra kicks must bail on the guard…
    kickIntegratePass(engine, deps)
    releaseReview()
    expect(await waitUntil(() => engine.integrateInFlight === false)).toBe(true)
    expect(reviewReads).toBe(1) // …so the pass ran exactly once
  })
})

// ── runEnginePass ⇄ control plane (stop) — mutual exclusion (runExclusive) ──────
// Audit MAJOR fix: a dispatch pass's monitor reads the board + workers ONCE at pass
// start; a stop landing in the monitor's await window (countCommitsAhead/readHeartbeat)
// used to park its card in 'blocked' only for the still-looping monitor to overwrite it
// from the STALE snapshot (recoverLost → 'todo', or promote → 'review' when commitsAhead>0).
// The per-engine critical section serializes the two, so the owner's explicit halt holds.

describe('runEnginePass ⇄ stopOrchestratorWorker — the blocked park survives the monitor race', () => {
  beforeEach(() => __resetOrchestratorForTests())

  it('serializes a stop fired during the monitor probe window, keeping its card BLOCKED (not re-homed)', async () => {
    const key = await canonicalize('/proj-stop-vs-monitor')
    // Two DOING workers. The monitor probes A FIRST; we suspend it inside A's
    // countCommitsAhead await (the documented race window) and fire stop(B) there. B
    // carries commitsAhead>0 — the exact bait that, on a stale pass-start snapshot with
    // a dead-judged B, would promote→review (or recoverLost→todo) over the owner's park.
    const fresh = new Date().toISOString()
    const engine = newEngine({
      path: key,
      running: true,
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a', startedAt: fresh }),
        worker({ terminalId: 'pty-b-1', branch: 'swarm/b', worktree: '/wt/b', taskId: 'b', taskTitle: 'task b', startedAt: fresh }),
      ],
    })
    __seedEngineForTests(engine)

    const board = new Map<string, ProjectTask>(
      [card('a', { boardColumn: 'doing', branch: 'swarm/a' }), card('b', { boardColumn: 'doing', branch: 'swarm/b' })].map(
        (c) => [c.id, { ...c }] as const,
      ),
    )
    const recovered: { taskId: string; column: string }[] = []
    const promoted: string[] = []
    const tornDown: string[] = []
    let reachProbe: () => void = () => {}
    const reachedProbe = new Promise<void>((r) => (reachProbe = r))
    let releaseProbe: () => void = () => {}
    const probeGate = new Promise<void>((r) => (releaseProbe = r))
    let firstProbe = true
    const deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = {
      fetchTasks: async () => Array.from(board.values()).map((c) => ({ ...c })),
      spawnWorker: async () => ({ terminalId: 'pty-x', agentSessionId: 's', worktree: '/wt/x', branch: 'swarm/x' }),
      moveToDoing: async () => true,
      moveToReview: async (_p, taskId, branch) => {
        promoted.push(taskId)
        const c = board.get(taskId)
        if (c) {
          c.boardColumn = 'review'
          if (branch) c.branch = branch
        }
        return true
      },
      countCommitsAhead: async (_p, branch) => {
        if (firstProbe) {
          firstProbe = false
          reachProbe() // signal: the monitor is now parked in A's probe window (holds the lock)
          await probeGate // SUSPEND mid-pass — the await window the bug needs
        }
        return branch === 'swarm/b' ? 3 : 0 // B has integrable commits (the promote bait)
      },
      readHeartbeat: async () => null, // no readyToMerge sign ⇒ an ALIVE worker never promotes
      recoverCard: async (_p, taskId, column) => {
        recovered.push({ taskId, column })
        const c = board.get(taskId)
        if (c) {
          c.boardColumn = column
          c.done = false
        }
        return true
      },
      recoverWorker: async ({ terminalId }) => {
        tornDown.push(terminalId)
        return { removed: true }
      },
      isAlive: (id) => !tornDown.includes(id), // a torn-down PTY reads dead
      lastOutputAt: () => Date.now(), // both workers streaming ⇒ never stall-reclaimed
      nudge: () => true,
      escalate: async () => true,
      recentOutput: () => null,
      // Integration half — present but inert (no review cards).
      fetchReview: async () => [],
      changedPaths: async () => ({ tip: 'tip-x', files: [] }),
      prepareTarget: async () => 'main',
      classify: async () => 'ff',
      verify: async () => ({ ok: true, tip: null }),
      integrate: async () => ({ status: 'integrated', mode: 'ff' }),
      acquireLock: alwaysAcquireLock,
      moveToDone: async () => true,
      markConflict: async () => true,
      cleanup: async () => ({ removed: true }),
      killPty: () => {},
      instructRework: () => {},
      managerPresence: async () => 'absent',
      nudgeManager: async () => true,
      wakeManager: async () => true,
      worktreeExists: async () => true,
    }

    // Kick the pass — it takes the critical section synchronously (engine.lock is set
    // before its first await), then suspends inside A's gated probe.
    const passP = runEnginePass(engine, deps)
    await reachedProbe // the pass now OWNS the section, parked in the probe window
    // Fire the owner's stop for B WHILE the pass holds the section — it must QUEUE.
    const stopP = stopOrchestratorWorker('/proj-stop-vs-monitor', 'pty-b-1', deps)
    // Macrotasks >> the in-memory canonicalize+lookup, so stop has reached runExclusive
    // and is BLOCKED on the lock. PROOF of serialization: its recoverCard/teardown have
    // NOT run — B is untouched while the pass owns the section. (Without the fix, stop
    // would already have parked + torn down B here, and the resumed monitor would then
    // promote the dead-judged B to review over that park.)
    await new Promise((r) => setTimeout(r, 15))
    expect(board.get('b')?.boardColumn).toBe('doing')
    expect(tornDown).not.toContain('pty-b-1')

    // Release the probe → the pass finishes the monitor (B still ALIVE ⇒ never promoted),
    // then the queued stop runs and parks B in blocked.
    releaseProbe()
    await Promise.all([passP, stopP])

    // (1) The owner's blocked park SURVIVED — the monitor never overwrote it.
    expect(board.get('b')?.boardColumn).toBe('blocked')
    expect(promoted).not.toContain('b') // never dead-judged ⇒ never promoted to review
    expect(recovered).toEqual([{ taskId: 'b', column: 'blocked' }]) // ONLY stop's park, no todo requeue
    expect(tornDown).toContain('pty-b-1') // B's PTY torn down by stop
    expect(engine.workers.map((w) => w.terminalId)).toEqual(['pty-a-1']) // B dropped, A still counted
    expect(board.get('a')?.boardColumn).toBe('doing') // A keeps draining, untouched
    expect(engine.passInFlight).toBe(false)
  })
})

// ── detectAnomalies (条件2 — state inconsistency detection) ────────────────────

describe('detectAnomalies — state inconsistency detection', () => {
  // detectAnomalies only ever calls deps.isAlive + deps.worktreeExists; build the
  // minimal surface off makeDeps (which supplies the full OrchestratorDeps) and
  // override just those two. `treesPresent` = branches whose worktree exists;
  // `alive` = live PTY ids (default: everything alive).
  const depsWith = (
    treesPresent: Set<string>,
    alive?: Set<string>,
  ): OrchestratorDeps & AnomalyDeps => ({
    ...makeDeps({ cards: [] }),
    isAlive: (id) => (alive ? alive.has(id) : true),
    worktreeExists: async (_p, branch) => treesPresent.has(branch),
  })

  const NOW = Date.parse('2026-06-24T12:00:00Z')
  const at = (ms: number) => new Date(ms).toISOString()

  it('flags a counted, alive worker whose worktree is gone (worktree-missing)', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a', startedAt: at(NOW) })],
    })
    const out = await detectAnomalies(engine, [], depsWith(new Set()), NOW)
    expect(out).toEqual([
      { kind: 'worktree-missing', ref: 'swarm/a', branch: 'swarm/a', taskTitle: 'task a' },
    ])
  })

  it('flags a doing swarm card with no counted worker AND no worktree (orphan-doing)', async () => {
    const engine = newEngine({ workers: [] })
    const tasks = [card('orph', { boardColumn: 'doing', branch: 'swarm/orph' })]
    const out = await detectAnomalies(engine, tasks, depsWith(new Set()), NOW)
    expect(out).toEqual([
      { kind: 'orphan-doing', ref: 'orph', branch: 'swarm/orph', taskTitle: 'task orph' },
    ])
  })

  it('worktree loss NEVER un-claims a doing card: orphan-doing is READ-ONLY + the card stays undispatchable (2026-07-23 twin-dispatch)', async () => {
    // The commander's hypothesis was that a lost worktree lets the card slip the claim
    // guard and get re-dispatched (a twin). It cannot: the claim authority is the doing
    // COLUMN, not worktree existence. detectAnomalies SURFACES the loss for the
    // commander…
    const engine = newEngine({ workers: [] })
    const doing = card('t', { boardColumn: 'doing', branch: 'swarm/t' })
    const tasks = [doing]
    const out = await detectAnomalies(engine, tasks, depsWith(new Set()), NOW)
    expect(out).toEqual([{ kind: 'orphan-doing', ref: 't', branch: 'swarm/t', taskTitle: 'task t' }])
    // …but it is READ-ONLY (no recoverCard dep exists on it): the card is untouched,
    // still 'doing', never quietly moved to todo behind the guard's back.
    expect(doing.boardColumn).toBe('doing')
    // …and the dispatch guard keys on the COLUMN, not the (now-missing) worktree, so a
    // doing card is never a candidate — worktree loss ALONE can never leak a re-dispatch.
    expect(selectDispatch(tasks, new Set(), 10)).toEqual([])
  })

  it('does NOT flag a doing card whose worktree still exists (an uncounted manual worker owns it)', async () => {
    const engine = newEngine({ workers: [] })
    const tasks = [card('m', { boardColumn: 'doing', branch: 'swarm/m' })]
    // worktree present → a manual worker (the engine never counts) still owns it:
    // never a false orphan. This is the key guard against flagging manual workers.
    expect(await detectAnomalies(engine, tasks, depsWith(new Set(['swarm/m'])), NOW)).toEqual([])
  })

  it('does NOT flag a doing card a counted worker drains', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-d-1', branch: 'swarm/d', taskId: 'd', taskTitle: 'task d', startedAt: at(NOW) })],
    })
    const tasks = [card('d', { boardColumn: 'doing', branch: 'swarm/d' })]
    expect(await detectAnomalies(engine, tasks, depsWith(new Set(['swarm/d'])), NOW)).toEqual([])
  })

  it('does NOT flag a non-swarm-branch doing card', async () => {
    const engine = newEngine({ workers: [] })
    const tasks = [card('x', { boardColumn: 'doing', branch: 'feature/x' })]
    expect(await detectAnomalies(engine, tasks, depsWith(new Set()), NOW)).toEqual([])
  })

  it('does NOT flag a doing card with no branch recorded', async () => {
    const engine = newEngine({ workers: [] })
    const tasks = [card('nob', { boardColumn: 'doing' })] // no branch
    expect(await detectAnomalies(engine, tasks, depsWith(new Set()), NOW)).toEqual([])
  })

  it('flags a counted, alive, non-done worker silent past the stale threshold (worker-stale)', async () => {
    const stale = at(NOW - STALE_HEARTBEAT_MS - 60_000)
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-s-1', branch: 'swarm/s', taskId: 's', taskTitle: 'task s', startedAt: stale, heartbeatAt: stale, stage: 'running' })],
    })
    // tree present, else worktree-missing would win and pre-empt the stale check.
    const out = await detectAnomalies(engine, [], depsWith(new Set(['swarm/s'])), NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'worker-stale', ref: 'swarm/s', branch: 'swarm/s' })
    expect(out[0].staleMinutes).toBeGreaterThanOrEqual(31)
  })

  it('falls back to dispatch age when a worker never beat (stale)', async () => {
    const old = at(NOW - STALE_HEARTBEAT_MS - 60_000)
    const engine = newEngine({
      // no heartbeatAt — startedAt long ago → counts as stale off dispatch age.
      workers: [worker({ terminalId: 'pty-n-1', branch: 'swarm/n', taskId: 'n', taskTitle: 'task n', startedAt: old, stage: 'running' })],
    })
    const out = await detectAnomalies(engine, [], depsWith(new Set(['swarm/n'])), NOW)
    expect(out.map((a) => a.kind)).toEqual(['worker-stale'])
  })

  it('does NOT flag a fresh worker as stale', async () => {
    const fresh = at(NOW - 60_000)
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-f-1', branch: 'swarm/f', taskId: 'f', taskTitle: 'task f', startedAt: fresh, heartbeatAt: fresh, stage: 'running' })],
    })
    expect(await detectAnomalies(engine, [], depsWith(new Set(['swarm/f'])), NOW)).toEqual([])
  })

  it('does NOT flag a rate-limited / permission-waiting worker as stale (WAIT, not HANG — Card 4880e9c6)', async () => {
    // A worker the monitor is HOLDING (rate-limited) or auto-accepting a startup
    // prompt for is silent BY DESIGN, not hung — flagging it 'worker-stale' would
    // be misleading noise. Both would otherwise trip the stale check (old beat).
    const stale = at(NOW - STALE_HEARTBEAT_MS - 60_000)
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-r-1', branch: 'swarm/r', taskId: 'r', taskTitle: 'task r', startedAt: stale, heartbeatAt: stale, stage: 'running' }),
        worker({ terminalId: 'pty-p-1', branch: 'swarm/p', taskId: 'p', taskTitle: 'task p', startedAt: stale, heartbeatAt: stale, stage: 'running' }),
      ],
      rateLimited: new Map([['pty-r-1', { since: NOW - 5 * 60_000 }]]),
      permissionWaits: new Map([['pty-p-1', { since: NOW - 60_000, accepted: true }]]),
    })
    expect(await detectAnomalies(engine, [], depsWith(new Set(['swarm/r', 'swarm/p'])), NOW)).toEqual([])
  })

  it('does NOT flag a worker with FRESH PTY output as stale even when its heartbeat is old', async () => {
    // The two channels AGREE with the stall monitor: a worker streaming output is
    // alive, so the read-only backstop never contradicts the engine by flagging it.
    const old = at(NOW - STALE_HEARTBEAT_MS - 60_000)
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-o-1', branch: 'swarm/o', taskId: 'o', taskTitle: 'task o', startedAt: old, heartbeatAt: old, stage: 'running' })],
    })
    const deps: OrchestratorDeps & AnomalyDeps = {
      ...makeDeps({ cards: [], outputs: new Map([['pty-o-1', NOW - 1000]]) }), // emitted output 1s ago
      isAlive: () => true,
      worktreeExists: async () => true,
    }
    expect(await detectAnomalies(engine, [], deps, NOW)).toEqual([])
  })

  it('does NOT flag a done worker as stale (it finished, not stuck)', async () => {
    const old = at(NOW - STALE_HEARTBEAT_MS - 60_000)
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-dn-1', branch: 'swarm/dn', taskId: 'dn', taskTitle: 'task dn', startedAt: old, heartbeatAt: old, stage: 'done' })],
    })
    expect(await detectAnomalies(engine, [], depsWith(new Set(['swarm/dn'])), NOW)).toEqual([])
  })

  it('flags a dark-but-ACTIVE worker — streaming output, zero beats since dispatch (no-heartbeat, the 2e7beb2 shape)', async () => {
    // Fresh PTY output keeps it off worker-stale (streaming = alive to the
    // engine) — yet it has NEVER beaten. This is exactly how the 2e7beb2 worker
    // ran: full speed, invisible to the commander's heartbeat view, straight to
    // an (then-unguarded) self-integration. The flag surfaces it within 30 min.
    const old = at(NOW - STALE_HEARTBEAT_MS - 5 * 60_000) // dispatched 35 min ago, never beat
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-nb-1', branch: 'swarm/nb', taskId: 'nb', taskTitle: 'task nb', startedAt: old, stage: 'running' })],
    })
    const deps: OrchestratorDeps & AnomalyDeps = {
      ...makeDeps({ cards: [], outputs: new Map([['pty-nb-1', NOW - 1000]]) }), // output 1s ago
      isAlive: () => true,
      worktreeExists: async () => true,
    }
    const out = await detectAnomalies(engine, [], deps, NOW)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'no-heartbeat', ref: 'swarm/nb', branch: 'swarm/nb', taskTitle: 'task nb' })
    expect(out[0].staleMinutes).toBeGreaterThanOrEqual(35)
  })

  it('reports worker-stale OR no-heartbeat per worker, never both (total silence subsumes never-beat)', async () => {
    // Zero beats AND zero output AND old dispatch: both conditions hold, but
    // one anomaly per worker is enough to act on — the stale flag (likely hung)
    // wins; no-heartbeat is for the dark-but-ACTIVE case only.
    const old = at(NOW - STALE_HEARTBEAT_MS - 60_000)
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-nb2-1', branch: 'swarm/nb2', taskId: 'nb2', taskTitle: 'task nb2', startedAt: old, stage: 'running' })],
    })
    expect((await detectAnomalies(engine, [], depsWith(new Set(['swarm/nb2'])), NOW)).map((a) => a.kind)).toEqual([
      'worker-stale',
    ])
  })

  it('does NOT flag a beat-less worker inside the 30-min grace window (no-heartbeat)', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-nb3-1', branch: 'swarm/nb3', taskId: 'nb3', taskTitle: 'task nb3', startedAt: at(NOW - STALE_HEARTBEAT_MS + 60_000), stage: 'running' })],
    })
    const deps: OrchestratorDeps & AnomalyDeps = {
      ...makeDeps({ cards: [], outputs: new Map([['pty-nb3-1', NOW - 1000]]) }),
      isAlive: () => true,
      worktreeExists: async () => true,
    }
    expect(await detectAnomalies(engine, [], deps, NOW)).toEqual([])
  })

  it('does NOT flag no-heartbeat once a SINGLE beat was recorded (however old — that is worker-stale territory)', async () => {
    // One recorded beat means the protocol was followed; an old beat with fresh
    // output is the stall monitor's / worker-stale's concern, not this flag's.
    // (Same scenario as the fresh-output stale test above, pinned for the NEW kind.)
    const old = at(NOW - STALE_HEARTBEAT_MS - 60_000)
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-nb4-1', branch: 'swarm/nb4', taskId: 'nb4', taskTitle: 'task nb4', startedAt: old, heartbeatAt: old, stage: 'running' })],
    })
    const deps: OrchestratorDeps & AnomalyDeps = {
      ...makeDeps({ cards: [], outputs: new Map([['pty-nb4-1', NOW - 1000]]) }),
      isAlive: () => true,
      worktreeExists: async () => true,
    }
    expect(await detectAnomalies(engine, [], deps, NOW)).toEqual([])
  })

  it('does NOT flag a rate-limited / permission-waiting / done worker as no-heartbeat (WAIT is not a violation)', async () => {
    const old = at(NOW - STALE_HEARTBEAT_MS - 60_000)
    const engine = newEngine({
      workers: [
        worker({ terminalId: 'pty-nb5-1', branch: 'swarm/nb5', taskId: 'nb5', taskTitle: 'task nb5', startedAt: old, stage: 'running' }),
        worker({ terminalId: 'pty-nb6-1', branch: 'swarm/nb6', taskId: 'nb6', taskTitle: 'task nb6', startedAt: old, stage: 'done' }),
      ],
      rateLimited: new Map([['pty-nb5-1', { since: NOW - 5 * 60_000 }]]),
    })
    const deps: OrchestratorDeps & AnomalyDeps = {
      ...makeDeps({ cards: [], outputs: new Map([['pty-nb5-1', NOW - 1000], ['pty-nb6-1', NOW - 1000]]) }),
      isAlive: () => true,
      worktreeExists: async () => true,
    }
    expect(await detectAnomalies(engine, [], deps, NOW)).toEqual([])
  })

  it('ignores a dead worker (the monitor prunes it — not an anomaly here)', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-x-1', branch: 'swarm/x', taskId: 'x', taskTitle: 'task x', startedAt: at(NOW) })],
    })
    // alive set empty → the worker's PTY is dead; detect skips it (no double-report
    // with the monitor's own crash/slot-free handling).
    expect(await detectAnomalies(engine, [], depsWith(new Set(), new Set()), NOW)).toEqual([])
  })

  it('reports worktree-missing OR stale per worker, never both', async () => {
    const stale = at(NOW - STALE_HEARTBEAT_MS - 60_000)
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-w-1', branch: 'swarm/w', taskId: 'w', taskTitle: 'task w', startedAt: stale, heartbeatAt: stale, stage: 'running' })],
    })
    // tree gone AND stale → only the (bigger) worktree-missing is reported.
    expect((await detectAnomalies(engine, [], depsWith(new Set()), NOW)).map((a) => a.kind)).toEqual([
      'worktree-missing',
    ])
  })

  // ── review-panel-failed (fail-closed review, 2026-07-14) ──────────────────────
  // The adversarial panel exhausted its retry budget without one decisive vote —
  // the card is frozen in 'review' un-merged and further panels are skipped; a
  // human must be surfaced (the "レビュー不能 → anomaly" hand-off, never a merge).

  it('flags a review card whose panel exhausted the defer budget (review-panel-failed)', async () => {
    const engine = newEngine({
      reviewDeferred: new Map([
        ['swarm/rp', { tip: 't1', count: MAX_REVIEW_DEFERS, abstains: { 'correctness(timeout)': MAX_REVIEW_DEFERS } }],
      ]),
    })
    const tasks = [card('rp', { boardColumn: 'review', branch: 'swarm/rp' })]
    const out = await detectAnomalies(engine, tasks, depsWith(new Set()), NOW)
    expect(out).toEqual([
      {
        kind: 'review-panel-failed',
        ref: 'rp',
        branch: 'swarm/rp',
        taskTitle: 'task rp',
        attempts: MAX_REVIEW_DEFERS,
      },
    ])
  })

  it('does NOT flag an under-budget defer streak (the panel still gets its retry)', async () => {
    const engine = newEngine({
      reviewDeferred: new Map([['swarm/rp', { tip: 't1', count: MAX_REVIEW_DEFERS - 1, abstains: {} }]]),
    })
    const tasks = [card('rp', { boardColumn: 'review', branch: 'swarm/rp' })]
    expect(await detectAnomalies(engine, tasks, depsWith(new Set()), NOW)).toEqual([])
  })

  it('does NOT flag review-panel-failed once the card left review (resolved by a human / a fresh cycle)', async () => {
    const engine = newEngine({
      reviewDeferred: new Map([['swarm/rp', { tip: 't1', count: MAX_REVIEW_DEFERS, abstains: {} }]]),
    })
    // worktree present so the doing card doesn't trip the (unrelated) orphan check.
    const tasks = [card('rp', { boardColumn: 'doing', branch: 'swarm/rp' })]
    expect(await detectAnomalies(engine, tasks, depsWith(new Set(['swarm/rp'])), NOW)).toEqual([])
  })

  // ── high-risk-hold (force-hold, 2026-07-15) ────────────────────────────────────

  it('flags a review card under a standing high-risk force-hold (high-risk-hold)', async () => {
    const engine = newEngine({
      highRiskHolds: new Map([
        ['swarm/hr', { tip: 't1', files: ['.github/workflows/release.yml'] }],
      ]),
    })
    const tasks = [card('hr', { boardColumn: 'review', branch: 'swarm/hr' })]
    const out = await detectAnomalies(engine, tasks, depsWith(new Set()), NOW)
    expect(out).toEqual([
      {
        kind: 'high-risk-hold',
        ref: 'hr',
        branch: 'swarm/hr',
        taskTitle: 'task hr',
        files: ['.github/workflows/release.yml'],
      },
    ])
  })

  it('does NOT flag a high-risk hold once the card left review (merged by hand / sent back)', async () => {
    const engine = newEngine({
      highRiskHolds: new Map([['swarm/hr', { tip: 't1', files: ['release.yml'] }]]),
    })
    const tasks = [card('hr', { boardColumn: 'done', branch: 'swarm/hr' })]
    expect(await detectAnomalies(engine, tasks, depsWith(new Set()), NOW)).toEqual([])
  })

  it('returns empty when everything is coherent', async () => {
    const fresh = at(NOW - 60_000)
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-ok-1', branch: 'swarm/ok', taskId: 'ok', taskTitle: 'task ok', startedAt: fresh, heartbeatAt: fresh, stage: 'running' })],
    })
    const tasks = [card('ok', { boardColumn: 'doing', branch: 'swarm/ok' })]
    expect(await detectAnomalies(engine, tasks, depsWith(new Set(['swarm/ok'])), NOW)).toEqual([])
  })
})

// ── monitor surfaces heartbeat phase/note (条件3) ──────────────────────────────

describe('runDispatchPass — monitor surfaces heartbeat phase/note', () => {
  it('records phase + note + heartbeatAt from a worker heartbeat', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a', startedAt: new Date().toISOString() })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 1]]),
      heartbeats: new Map([
        ['a', { ready: false, blocked: false, phase: 'implement', note: 'wiring the API', at: '2026-06-24T10:00:00Z' }],
      ]),
    })
    await runDispatchPass(engine, deps)
    const w = engine.workers.find((x) => x.taskId === 'a')
    expect(w?.phase).toBe('implement')
    expect(w?.note).toBe('wiring the API')
    expect(w?.heartbeatAt).toBe('2026-06-24T10:00:00Z')
  })

  it('clears a stale phase when the heartbeat goes away', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a', startedAt: new Date().toISOString(), phase: 'audit', note: 'old' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 1]]), // commits but no heartbeat → still running, phase cleared
    })
    await runDispatchPass(engine, deps)
    const w = engine.workers.find((x) => x.taskId === 'a')
    expect(w?.phase).toBeUndefined()
    expect(w?.note).toBeUndefined()
  })

  it('carries phase onto a promoted (done) worker too', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 2]]),
      heartbeats: new Map([['a', { ready: true, blocked: false, phase: 'verify', note: 'tests green' }]]),
    })
    await runDispatchPass(engine, deps)
    const w = engine.workers.find((x) => x.taskId === 'a')
    expect(w?.stage).toBe('done')
    expect(w?.phase).toBe('verify')
  })
})

// ── Card 254fe0 ① — reliable conflict-flag CLEAR + conflict-file surfacing ──────
// A card that EVER carried the conflict stamp must never land in 'done' still
// flagged (the "done but flagged conflict" zombie), and a real conflict names its
// files so the human can resolve it.

// ── Card 254fe0 ② — anti-zombie: column-move save-failure recovery ─────────────
// A KEPT column move is tracked (engine.stuckMoves) and, past the budget, the
// engine ESCALATES (a lost-worker recovery → blocked) and SURFACES the rest as a
// 'move-stuck' anomaly, instead of an endless silent warn loop that zombies a card.

describe('runDispatchPass — anti-zombie: lost-worker recovery escalates to blocked (blocked退避)', () => {
  it('parks a lost worker in blocked once its todo-requeue keeps failing ("dead なのに doing")', async () => {
    // A bare crash (no heartbeat, budget left) recovers to 'todo' — but that write
    // keeps failing. Past the budget the engine escalates to a 'blocked' park so the
    // card never zombies in 'doing'.
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      dead: new Set(['a']),
      recoverTodoFails: new Set(['a']), // the gentle requeue never lands; blocked still works
    })
    for (let i = 0; i < MOVE_STUCK_MAX_RETRIES; i++) await runDispatchPass(engine, deps)
    // Escalated: the failing 'todo' writes gave way to a 'blocked' park.
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    expect(deps.board.get('a')?.boardColumn).toBe('blocked')
    expect(engine.stuckMoves.has('a')).toBe(false) // cleared once parked
    expect(engine.workers).toHaveLength(0) // dead worker finally dropped
  })

  it('keeps retrying (does not escalate) while still within the budget', async () => {
    const engine = newEngine({
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      dead: new Set(['a']),
      recoverTodoFails: new Set(['a']),
    })
    await runDispatchPass(engine, deps) // 1 attempt < budget
    expect(deps.recovered).toHaveLength(0) // not yet parked
    expect(deps.board.get('a')?.boardColumn).toBe('doing') // still stuck (will retry)
    expect(engine.stuckMoves.get('a')).toMatchObject({ intent: 'recover', attempts: 1 })
  })
})

describe('detectAnomalies — move-stuck surfacing (条件2)', () => {
  const depsOk = (): OrchestratorDeps & AnomalyDeps => ({
    ...makeDeps({ cards: [] }),
    worktreeExists: async () => true,
  })

  it('surfaces a move-stuck anomaly once a stuck move passes the budget', async () => {
    const engine = newEngine()
    engine.stuckMoves.set('a', {
      intent: 'done',
      attempts: MOVE_STUCK_MAX_RETRIES,
      branch: 'swarm/a',
      taskTitle: 'task a',
    })
    const out = await detectAnomalies(
      engine,
      [card('a', { boardColumn: 'review', branch: 'swarm/a' })],
      depsOk(),
      Date.parse('2026-06-24T12:00:00Z'),
    )
    expect(out).toContainEqual({
      kind: 'move-stuck',
      ref: 'a',
      branch: 'swarm/a',
      taskTitle: 'task a',
      intent: 'done',
      attempts: MOVE_STUCK_MAX_RETRIES,
    })
  })

  it('does NOT surface a stuck move still within the budget', async () => {
    const engine = newEngine()
    engine.stuckMoves.set('a', {
      intent: 'recover',
      attempts: MOVE_STUCK_MAX_RETRIES - 1,
      branch: 'swarm/a',
      taskTitle: 't',
    })
    const out = await detectAnomalies(engine, [], depsOk(), Date.parse('2026-06-24T12:00:00Z'))
    expect(out.some((a) => a.kind === 'move-stuck')).toBe(false)
  })
})

describe('pruneStuckMoves — never leaks a resolved zombie', () => {
  it('drops a done-intent entry once its card leaves review, keeps it while still there', () => {
    const engine = newEngine()
    engine.stuckMoves.set('a', { intent: 'done', attempts: 3, branch: 'swarm/a', taskTitle: 't' })
    pruneStuckMoves(engine, [card('a', { boardColumn: 'review' })])
    expect(engine.stuckMoves.has('a')).toBe(true) // still in review → kept
    pruneStuckMoves(engine, [card('a', { boardColumn: 'done', done: true })])
    expect(engine.stuckMoves.has('a')).toBe(false) // landed elsewhere → pruned
  })

  it('drops a recover/review entry once its card leaves doing, and a vanished card', () => {
    const engine = newEngine()
    engine.stuckMoves.set('a', { intent: 'recover', attempts: 3, branch: 'swarm/a', taskTitle: 't' })
    engine.stuckMoves.set('gone', { intent: 'review', attempts: 3, branch: 'swarm/g', taskTitle: 't' })
    pruneStuckMoves(engine, [card('a', { boardColumn: 'blocked' })]) // 'a' parked, 'gone' deleted
    expect(engine.stuckMoves.has('a')).toBe(false)
    expect(engine.stuckMoves.has('gone')).toBe(false)
  })

  it('is immune to the integrate throttle — a done entry survives a tick the integrate pass skips', () => {
    // The card is STILL in review (the integrate pass just didn't run this tick);
    // a column-rule prune keeps it (a per-pass touched-set would have wrongly dropped it).
    const engine = newEngine()
    engine.stuckMoves.set('a', { intent: 'done', attempts: 3, branch: 'swarm/a', taskTitle: 't' })
    pruneStuckMoves(engine, [card('a', { boardColumn: 'review' })])
    expect(engine.stuckMoves.has('a')).toBe(true)
  })
})

// ── Card 254fe0 ① — the human resolution path (resolveOrchestratorReview) ───────
// A conflicted / failing-verify review card the engine can't auto-land gets taken
// OUT of review by the owner so it never sits there forever, with its conflict flag
// + memos cleared and any stale worker torn down.

describe('resolveOrchestratorReview', () => {
  beforeEach(() => __resetOrchestratorForTests())

  // resolve uses fetchTasks/recoverCard/recoverWorker/isAlive (OrchestratorDeps) +
  // markConflict (IntegrationDeps) — the union of the two recording fakes. makeIntDeps
  // FIRST so its IntegrationDeps-only fakes (markConflict/verify/…) apply, then makeDeps
  // LAST so the OrchestratorDeps seams shared with IntegrationDeps's rework path
  // (recoverCard/recoverWorker/isAlive/moveToDoing) resolve to makeDeps's board-updating
  // versions — resolve exercises THOSE, and makeDeps owns the live board + the
  // tornDown/recovered records the assertions read.
  const resolveDeps = (cards: ProjectTask[], over: Partial<Parameters<typeof makeDeps>[0]> = {}) => ({
    ...makeIntDeps({ reviews: [] }),
    ...makeDeps({ cards, ...over }),
  })

  it('parks a conflicted card in blocked, clears the flag + memos, tears the worker down', async () => {
    const key = await canonicalize('/proj-resolve-1')
    const engine = newEngine({
      path: key,
      conflictedBranches: new Set(['swarm/a']),
      verifyFailed: new Map([['swarm/a', 'sha-a']]),
      reviews: [{ taskId: 'a', branch: 'swarm/a', taskTitle: 'task a', status: 'conflict' }],
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    __seedEngineForTests(engine)
    const deps = resolveDeps([card('a', { boardColumn: 'review', branch: 'swarm/a', integrationConflict: true })])

    const state = await resolveOrchestratorReview('/proj-resolve-1', 'a', 'blocked', deps)

    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    expect(deps.board.get('a')?.boardColumn).toBe('blocked')
    expect(deps.marks).toContainEqual({ taskId: 'a', value: false }) // conflict flag cleared
    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }]) // stale worker gone
    expect(engine.conflictedBranches.has('swarm/a')).toBe(false)
    expect(engine.verifyFailed.has('swarm/a')).toBe(false)
    expect(engine.reviews).toHaveLength(0)
    expect(engine.workers).toHaveLength(0)
    expect(state.reviews).toHaveLength(0)
  })

  it('requeues a conflicted card to todo and drops the stale worker (re-dispatchable)', async () => {
    const key = await canonicalize('/proj-resolve-2')
    const engine = newEngine({
      path: key,
      conflictedBranches: new Set(['swarm/a']),
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a' })],
    })
    __seedEngineForTests(engine)
    const deps = resolveDeps([card('a', { boardColumn: 'review', branch: 'swarm/a', integrationConflict: true })])

    await resolveOrchestratorReview('/proj-resolve-2', 'a', 'todo', deps)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'todo' }])
    expect(deps.board.get('a')?.boardColumn).toBe('todo')
    expect(engine.workers).toHaveLength(0) // stale worker dropped → selectDispatch can re-pick it
    expect(engine.conflictedBranches.has('swarm/a')).toBe(false)
  })

  it('is idempotent for a card not currently in review (no-op)', async () => {
    const key = await canonicalize('/proj-resolve-3')
    const engine = newEngine({ path: key })
    __seedEngineForTests(engine)
    const deps = resolveDeps([card('a', { boardColumn: 'doing', branch: 'swarm/a' })])
    await resolveOrchestratorReview('/proj-resolve-3', 'a', 'blocked', deps)
    expect(deps.recovered).toHaveLength(0)
    expect(deps.board.get('a')?.boardColumn).toBe('doing') // untouched
  })

  it('leaves the card + memos intact when the move is KEPT (save failure → retry, not half-resolved)', async () => {
    const key = await canonicalize('/proj-resolve-4')
    const engine = newEngine({ path: key, conflictedBranches: new Set(['swarm/a']) })
    __seedEngineForTests(engine)
    // recoverFails makes the single recoverCard call return false (the kept write).
    const deps = resolveDeps([card('a', { boardColumn: 'review', branch: 'swarm/a', integrationConflict: true })], {
      recoverFails: new Set(['a']),
    })
    await resolveOrchestratorReview('/proj-resolve-4', 'a', 'blocked', deps)
    expect(deps.board.get('a')?.boardColumn).toBe('review') // still in review (move kept)
    expect(deps.marks).toHaveLength(0) // flag NOT cleared on a kept move (no half-resolve)
    expect(engine.conflictedBranches.has('swarm/a')).toBe(true) // memo intact → owner retries
    expect(engine.log.some((l) => l.message.includes('resolve kept'))).toBe(true)
  })

  it('returns an empty stopped state for a project with no engine', async () => {
    const deps = resolveDeps([])
    const state = await resolveOrchestratorReview('/proj-never', 'a', 'blocked', deps)
    expect(state.running).toBe(false)
    expect(state.reviews).toHaveLength(0)
  })

  // ── KPI guard (card a2ea85b9 review-A MUST-FIX) ─────────────────────────────
  // resolveOrchestratorReview logs a kind:'integrate' line — but it's a PARK/REQUEUE,
  // not a land. The analytics counter must NOT treat it as an integration, or the
  // worker-success / conflict / rework rates corrupt. Asserted end-to-end: the real
  // logLine fires (a kind:integrate line lands in the journal) yet integrated stays 0.
  it('does NOT bump metrics.integrated when the owner PARKS a card to blocked', async () => {
    const key = await canonicalize('/proj-resolve-metrics-blocked')
    const engine = newEngine({
      path: key,
      conflictedBranches: new Set(['swarm/a']),
      reviews: [{ taskId: 'a', branch: 'swarm/a', taskTitle: 'task a', status: 'conflict' }],
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' })],
    })
    __seedEngineForTests(engine)
    const deps = resolveDeps([card('a', { boardColumn: 'review', branch: 'swarm/a', integrationConflict: true })])

    await resolveOrchestratorReview('/proj-resolve-metrics-blocked', 'a', 'blocked', deps)

    expect(deps.board.get('a')?.boardColumn).toBe('blocked') // the resolve DID land…
    // …and it DID log a kind:'integrate' journal line (the owner-resolve entry)…
    expect(engine.log.some((l) => l.kind === 'integrate' && l.message.includes('resolved by owner'))).toBe(true)
    // …yet that NON-land line must NOT count as a worker integration (the MUST-FIX).
    expect(engine.metrics.integrated).toBe(0)
  })

  it('does NOT bump metrics.integrated when the owner REQUEUES a card to todo', async () => {
    const key = await canonicalize('/proj-resolve-metrics-todo')
    const engine = newEngine({
      path: key,
      conflictedBranches: new Set(['swarm/a']),
      workers: [worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a' })],
    })
    __seedEngineForTests(engine)
    const deps = resolveDeps([card('a', { boardColumn: 'review', branch: 'swarm/a', integrationConflict: true })])

    await resolveOrchestratorReview('/proj-resolve-metrics-todo', 'a', 'todo', deps)

    expect(deps.board.get('a')?.boardColumn).toBe('todo')
    expect(engine.metrics.integrated).toBe(0)
  })
})

// ── fireFatalNotifications (条件1,4,5 — escalation safety valve) ──────────────────
// The choke point that turns a FATAL unmanned-loop event into a human push. Driven
// with a FAKE notify (no real notification IO), so it asserts the observable
// contract: WHICH events fire, that a normal pass is silent (no noise), and that a
// persisting condition notifies once (rising-edge dedup) while a recurrence re-fires.
describe('fireFatalNotifications — fatal events push, normal passes are silent', () => {
  const run = (
    engine: ProjectEngine,
    tasks: ProjectTask[] | null,
    opts: { alive?: Set<string>; withNotify?: boolean } = {},
  ): SwarmFatalNotification[] => {
    const alive = opts.alive ?? new Set<string>()
    const fired: SwarmFatalNotification[] = []
    const deps = {
      isAlive: (id: string) => alive.has(id),
      notify: opts.withNotify === false ? undefined : (n: SwarmFatalNotification) => fired.push(n),
    }
    fireFatalNotifications(engine, tasks, deps, 0)
    return fired
  }

  it('does NOT notify on a normal pass (no fatal condition) — 条件4 no noise', () => {
    const engine = newEngine({ running: true, workers: [worker({ terminalId: 'p1', taskId: 'a' })] })
    const tasks = [card('a', { boardColumn: 'doing', branch: 'swarm/a' })]
    expect(run(engine, tasks, { alive: new Set(['p1']) })).toEqual([])
  })

  it('notifies on a rework-exhausted anomaly (card parked in blocked)', () => {
    const engine = newEngine({
      running: true,
      anomalies: [
        { kind: 'rework-exhausted', ref: 'a', branch: 'swarm/a', taskTitle: 'fix', attempts: 3 },
      ],
    })
    const fired = run(engine, [card('a', { boardColumn: 'blocked' })])
    expect(fired).toHaveLength(1)
    expect(fired[0].event).toBe('rework-exhausted')
    expect(fired[0].taskId).toBe('a')
    expect(fired[0].branch).toBe('swarm/a')
    expect(fired[0].detail).toContain('差し戻し')
    expect(fired[0].logHint).toBeTruthy() // 導線 present (条件3)
  })

  it('notifies on a review-panel-failed anomaly (panel indecisive → merge withheld) — once, rising-edge', () => {
    const anomalies = [
      {
        kind: 'review-panel-failed' as const,
        ref: 'rp',
        branch: 'swarm/rp',
        taskTitle: 'risky change',
        attempts: MAX_REVIEW_DEFERS,
      },
    ]
    const engine = newEngine({ running: true, anomalies })
    const tasks = [card('rp', { boardColumn: 'review', branch: 'swarm/rp' })]
    const fired = run(engine, tasks)
    expect(fired).toHaveLength(1)
    expect(fired[0].event).toBe('review-panel-failed')
    expect(fired[0].taskId).toBe('rp')
    expect(fired[0].branch).toBe('swarm/rp')
    expect(fired[0].detail).toContain('決着せず')
    expect(fired[0].logHint).toBeTruthy() // 導線 present
    expect(run(engine, tasks)).toEqual([]) // persisting condition → silent (dedup)
    engine.anomalies = [] // resolved (human moved it / a new commit re-armed)
    expect(run(engine, tasks)).toEqual([])
    engine.anomalies = anomalies // recurs → re-fires
    expect(run(engine, tasks)).toHaveLength(1)
  })

  it('notifies on a high-risk-hold anomaly (auto-merge withheld → manual merge required) — once, rising-edge', () => {
    const anomalies = [
      {
        kind: 'high-risk-hold' as const,
        ref: 'hr',
        branch: 'swarm/hr',
        taskTitle: 'release pipeline change',
        files: ['.github/workflows/release.yml', 'electron/main.js'],
      },
    ]
    const engine = newEngine({ running: true, anomalies })
    const tasks = [card('hr', { boardColumn: 'review', branch: 'swarm/hr' })]
    const fired = run(engine, tasks)
    expect(fired).toHaveLength(1)
    expect(fired[0].event).toBe('high-risk-hold')
    expect(fired[0].taskId).toBe('hr')
    expect(fired[0].branch).toBe('swarm/hr')
    expect(fired[0].detail).toContain('高リスクパス')
    expect(fired[0].detail).toContain('.github/workflows/release.yml') // WHAT made it risky
    expect(fired[0].logHint).toContain('手動統合') // 出口の導線 — 人間のマージだけが出す
    expect(run(engine, tasks)).toEqual([]) // standing hold → silent (dedup)
    engine.anomalies = [] // resolved (merged by hand / a new commit dropped the risky paths)
    expect(run(engine, tasks)).toEqual([])
    engine.anomalies = anomalies // recurs → re-fires
    expect(run(engine, tasks)).toHaveLength(1)
  })

  it('notifies all-workers-down: running, zero live workers, doing work remains', () => {
    const engine = newEngine({
      running: true,
      workers: [worker({ terminalId: 'dead', taskId: 'a', branch: 'swarm/a' })],
    })
    const tasks = [card('a', { boardColumn: 'doing', branch: 'swarm/a' })]
    const fired = run(engine, tasks, { alive: new Set() }) // 'dead' is not alive
    expect(fired.map((f) => f.event)).toEqual(['all-workers-down'])
    expect(fired[0].logHint).toBeTruthy()
  })

  it('does NOT fire all-workers-down while a worker is still alive', () => {
    const engine = newEngine({
      running: true,
      workers: [worker({ terminalId: 'p1', taskId: 'a', branch: 'swarm/a' })],
    })
    const tasks = [card('a', { boardColumn: 'doing', branch: 'swarm/a' })]
    expect(run(engine, tasks, { alive: new Set(['p1']) })).toEqual([])
  })

  it('does NOT fire all-workers-down with no doing work in flight', () => {
    const engine = newEngine({ running: true, workers: [] })
    const tasks = [card('a', { boardColumn: 'todo', branch: 'swarm/a' })]
    expect(run(engine, tasks, { alive: new Set() })).toEqual([])
  })

  it('does NOT fire all-workers-down when the engine is stopped', () => {
    const engine = newEngine({ running: false, workers: [] })
    const tasks = [card('a', { boardColumn: 'doing', branch: 'swarm/a' })]
    expect(run(engine, tasks, { alive: new Set() })).toEqual([])
  })

  it('drains a queued EDGE event (exec-timeout) exactly once', () => {
    const engine = newEngine({
      running: true,
      pendingFatal: [
        {
          event: 'exec-timeout',
          detail: 'overran',
          branch: 'swarm/a',
          taskId: 'a',
          taskTitle: 'big',
          logHint: 'log',
        },
      ],
    })
    const fired1 = run(engine, [], { alive: new Set() })
    expect(fired1.map((f) => f.event)).toEqual(['exec-timeout'])
    expect(engine.pendingFatal).toHaveLength(0) // drained
    expect(run(engine, [], { alive: new Set() })).toEqual([]) // nothing left
  })

  it('rising-edge dedup: a persisting condition notifies ONCE, not every pass', () => {
    const anomalies = [
      { kind: 'rework-exhausted' as const, ref: 'a', branch: 'swarm/a', taskTitle: 'fix', attempts: 3 },
    ]
    const engine = newEngine({ running: true, anomalies })
    const tasks = [card('a', { boardColumn: 'blocked' })]
    expect(run(engine, tasks)).toHaveLength(1) // first appearance fires
    expect(run(engine, tasks)).toEqual([]) // still present → silent
    expect(run(engine, tasks)).toEqual([])
  })

  it('re-notifies after the condition clears and recurs (edge reset)', () => {
    const anomalies = [
      { kind: 'rework-exhausted' as const, ref: 'a', branch: 'swarm/a', taskTitle: 'fix', attempts: 3 },
    ]
    const engine = newEngine({ running: true, anomalies })
    const tasks = [card('a', { boardColumn: 'blocked' })]
    expect(run(engine, tasks)).toHaveLength(1) // fires
    engine.anomalies = [] // human resolved it → condition cleared
    expect(run(engine, tasks)).toEqual([]) // and the dedup key is forgotten
    engine.anomalies = anomalies // it recurs
    expect(run(engine, tasks)).toHaveLength(1) // fires again
  })

  it('only rework-exhausted / review-panel-failed / high-risk-hold are fatal — other anomaly kinds never notify (条件4)', () => {
    const engine = newEngine({
      running: true,
      anomalies: [
        { kind: 'worker-stale', ref: 'swarm/a', branch: 'swarm/a', staleMinutes: 99 },
        { kind: 'move-stuck', ref: 'b', branch: 'swarm/b', intent: 'review', attempts: 9 },
        { kind: 'orphan-doing', ref: 'c', branch: 'swarm/c' },
        { kind: 'worktree-missing', ref: 'swarm/d', branch: 'swarm/d' },
      ],
    })
    expect(run(engine, [])).toEqual([])
  })

  it('skips state-derived events when the board read failed (tasks null), still drains edges', () => {
    const engine = newEngine({
      running: true,
      anomalies: [{ kind: 'rework-exhausted', ref: 'a', attempts: 3 }],
      pendingFatal: [{ event: 'exec-timeout', detail: 'overran' }],
    })
    const fired = run(engine, null, { alive: new Set() })
    expect(fired.map((f) => f.event)).toEqual(['exec-timeout']) // edge only; state-derived skipped
  })

  it('never throws when notify is unset (best-effort) and still drains + advances dedup', () => {
    const engine = newEngine({
      running: true,
      anomalies: [{ kind: 'rework-exhausted', ref: 'a', attempts: 3 }],
      pendingFatal: [{ event: 'exec-timeout', detail: 'x' }],
    })
    expect(() =>
      run(engine, [card('a', { boardColumn: 'blocked' })], { withNotify: false }),
    ).not.toThrow()
    expect(engine.pendingFatal).toHaveLength(0) // drained even without a sink
    expect(engine.notified.has('rework-exhausted:a')).toBe(true) // rising-edge bookkeeping advanced
  })
})

// ── KPI aggregation (the analytics layer — card a2ea85b9) ─────────────────────
// The data foundation for "is the swarm getting better?". All PURE (no IO, no
// clock — timestamps are passed in), so HOME isolation is moot, but the suite
// runs under the same HOME-isolated harness as the rest of the file.
//   • classifyMetricEvent — journal line → which non-lossy counter it bumps.
//   • computeLeadTimeStats — done cards × integrate journal lines → todo→done.
//   • computeSwarmKpis     — counters + cards + journal → the dashboard rates.
describe('KPI: classifyMetricEvent (line → counter)', () => {
  it('maps each structured kind to its counter', () => {
    expect(classifyMetricEvent({ kind: 'dispatch', level: 'info', message: 'x' })).toBe('dispatched')
    expect(classifyMetricEvent({ kind: 'promote', level: 'info', message: 'x' })).toBe('promoted')
    // integrate is guarded by the land-shaped message (see the dedicated test below).
    expect(
      classifyMetricEvent({ kind: 'integrate', level: 'info', message: 'integrated (ff): task → origin/main' }),
    ).toBe('integrated')
    expect(classifyMetricEvent({ kind: 'conflict', level: 'error', message: 'x' })).toBe('conflicted')
    expect(classifyMetricEvent({ kind: 'crash', level: 'warn', message: 'x' })).toBe('crashed')
    expect(classifyMetricEvent({ kind: 'stall', level: 'warn', message: 'x' })).toBe('stalled')
  })

  it('counts kind:integrate ONLY for a real land, NOT an owner-resolve park/requeue (MUST-FIX)', () => {
    // The auto-land line (defaultMoveToDone) is the ONLY true integration → counted.
    expect(
      classifyMetricEvent({ kind: 'integrate', level: 'info', message: 'integrated (rebase): my task → origin/main' }),
    ).toBe('integrated')
    // resolveOrchestratorReview ALSO logs kind:'integrate', but it is a PARK (→blocked)
    // or REQUEUE (→todo), NOT a land — its message is not land-shaped, so it must NOT
    // count as integrated. Counting it corrupts every rate (worker-success can exceed
    // 100%, a conflict→resolve double-counts both conflictRate terms, reworkRate's
    // denominator inflates). These are the verbatim owner-resolve messages.
    expect(
      classifyMetricEvent({
        kind: 'integrate',
        level: 'info',
        message: 'review resolved by owner — card → blocked: swarm/x (my task)',
      }),
    ).toBeNull()
    expect(
      classifyMetricEvent({
        kind: 'integrate',
        level: 'info',
        message: 'review resolved by owner — card → todo: swarm/x (my task)',
      }),
    ).toBeNull()
    // A kind:integrate with a blank/garbage message also doesn't count (fail-closed).
    expect(classifyMetricEvent({ kind: 'integrate', level: 'info', message: 'x' })).toBeNull()
  })

  it('splits dispatch by level — error ⇒ dispatchFailed, else dispatched', () => {
    expect(
      classifyMetricEvent({ kind: 'dispatch', level: 'error', message: 'dispatch failed: task — boom' }),
    ).toBe('dispatchFailed')
    expect(
      classifyMetricEvent({ kind: 'dispatch', level: 'info', message: 'dispatch: task → swarm/x' }),
    ).toBe('dispatched')
  })

  it('recognises BOTH rework SUCCESS lines by the marker (rework carries no kind)', () => {
    // The verbatim lines the integrate stage emits (live-continue + re-dispatch).
    expect(
      classifyMetricEvent({
        level: 'warn',
        message: '差し戻し review→doing (1/2) 同一ブランチ継続: swarm/x (task) — verify RED',
      }),
    ).toBe('reworked')
    expect(
      classifyMetricEvent({
        level: 'warn',
        message: '差し戻し review→todo (2/2) 再 dispatch(worker 不在): swarm/x (task) — …',
      }),
    ).toBe('reworked')
    expect(REWORK_LOG_MARKER).toBe('差し戻し review→')
  })

  it('does NOT count the rework-exhausted PARK line as a rework round', () => {
    expect(
      classifyMetricEvent({
        level: 'error',
        message: "差し戻し上限(2)超過 — 'blocked' 退避(要人手): swarm/x (task) — verify RED",
      }),
    ).toBeNull()
  })

  it('maps routine / cleanup / uncategorised lines to null (counted toward nothing)', () => {
    expect(classifyMetricEvent({ kind: 'routine', level: 'info', message: 'slot freed' })).toBeNull()
    expect(classifyMetricEvent({ kind: 'cleanup', level: 'warn', message: 'worktree kept' })).toBeNull()
    expect(classifyMetricEvent({ level: 'info', message: 'auto-integrate ON' })).toBeNull()
  })
})

describe('KPI: medianOf', () => {
  it('is null for an empty list', () => {
    expect(medianOf([])).toBeNull()
  })
  it('is the middle value for an odd count', () => {
    expect(medianOf([30, 10, 20])).toBe(20)
  })
  it('is the rounded mean of the two middle values for an even count', () => {
    expect(medianOf([10, 20, 30, 40])).toBe(25)
    expect(medianOf([10, 21, 30, 41])).toBe(26) // (21+30)/2 = 25.5 → 26
  })
})

describe('KPI: computeLeadTimeStats (todo→done pairing)', () => {
  const done = (title: string, createdAt: string): ProjectTask => ({
    id: title,
    title,
    done: true,
    createdAt,
    boardColumn: 'done',
  })
  const integrated = (title: string, at: string): OrchestratorLogLine => ({
    at,
    level: 'info',
    kind: 'integrate',
    message: `integrated (ff): ${title} → origin/main`,
  })

  it('pairs a done card with its integrate line by (deterministic) shortened title', () => {
    const r = computeLeadTimeStats(
      [done('alpha', '2026-06-23T00:00:00Z')],
      [integrated('alpha', '2026-06-23T00:10:00Z')],
    )
    expect(r.count).toBe(1)
    expect(r.medianMs).toBe(10 * 60_000)
  })

  it('takes the median across several completions', () => {
    const tasks = [
      done('a', '2026-06-23T00:00:00Z'),
      done('b', '2026-06-23T00:00:00Z'),
      done('c', '2026-06-23T00:00:00Z'),
    ]
    const log = [
      integrated('a', '2026-06-23T00:01:00Z'), // 1m
      integrated('b', '2026-06-23T00:05:00Z'), // 5m
      integrated('c', '2026-06-23T00:09:00Z'), // 9m
    ]
    expect(computeLeadTimeStats(tasks, log).medianMs).toBe(5 * 60_000)
  })

  it('skips a done card with no matching integrate line', () => {
    const r = computeLeadTimeStats([done('x', '2026-06-23T00:00:00Z')], [])
    expect(r).toEqual({ medianMs: null, count: 0 })
  })

  it('ignores non-done cards even if an integrate line exists', () => {
    const review: ProjectTask = {
      id: 'r',
      title: 'rev',
      done: false,
      createdAt: '2026-06-23T00:00:00Z',
      boardColumn: 'review',
    }
    expect(computeLeadTimeStats([review], [integrated('rev', '2026-06-23T00:10:00Z')]).count).toBe(0)
  })

  it('ignores non-integrate journal lines (a promote with the same title)', () => {
    const log: OrchestratorLogLine[] = [
      { at: '2026-06-23T00:10:00Z', level: 'info', kind: 'promote', message: 'promoted to review: a → swarm/a' },
    ]
    expect(computeLeadTimeStats([done('a', '2026-06-23T00:00:00Z')], log).count).toBe(0)
  })

  it('skips a negative span (clock skew — integrate logged before createdAt)', () => {
    expect(
      computeLeadTimeStats(
        [done('a', '2026-06-23T01:00:00Z')],
        [integrated('a', '2026-06-23T00:00:00Z')],
      ).count,
    ).toBe(0)
  })

  it('skips a card with an unparseable createdAt', () => {
    expect(
      computeLeadTimeStats([done('a', 'not-a-date')], [integrated('a', '2026-06-23T00:10:00Z')]).count,
    ).toBe(0)
  })

  it('uses the LATEST integrate line on a title collision (a re-landed title)', () => {
    const log = [
      integrated('a', '2026-06-23T00:02:00Z'),
      integrated('a', '2026-06-23T00:08:00Z'), // later wins
    ]
    expect(computeLeadTimeStats([done('a', '2026-06-23T00:00:00Z')], log).medianMs).toBe(8 * 60_000)
  })

  it('treats undefined boardColumn + done:true as done (back-compat)', () => {
    const t: ProjectTask = { id: 'a', title: 'a', done: true, createdAt: '2026-06-23T00:00:00Z' }
    expect(computeLeadTimeStats([t], [integrated('a', '2026-06-23T00:03:00Z')]).medianMs).toBe(3 * 60_000)
  })
})

describe('KPI: computeSwarmKpis (counters + cards + journal → rates)', () => {
  const counters = (over: Partial<ReturnType<typeof emptyMetricsCounters>> = {}) => ({
    ...emptyMetricsCounters(),
    ...over,
  })

  it('worker success = integrated / dispatched', () => {
    const k = computeSwarmKpis({ counters: counters({ dispatched: 4, integrated: 3 }), tasks: [], log: [] })
    expect(k.workerSuccessRate).toBeCloseTo(0.75)
  })

  it('conflict rate = conflicted / (integrated + conflicted)', () => {
    const k = computeSwarmKpis({ counters: counters({ integrated: 3, conflicted: 1 }), tasks: [], log: [] })
    expect(k.conflictRate).toBeCloseTo(0.25)
  })

  it('rework rate = reworked / (reworked + integrated)', () => {
    const k = computeSwarmKpis({ counters: counters({ integrated: 4, reworked: 1 }), tasks: [], log: [] })
    expect(k.reworkRate).toBeCloseTo(0.2)
  })

  it('a rate is null when its denominator is 0 — "no data yet", never a fake 0%', () => {
    const k = computeSwarmKpis({ counters: emptyMetricsCounters(), tasks: [], log: [] })
    expect(k.workerSuccessRate).toBeNull()
    expect(k.conflictRate).toBeNull()
    expect(k.reworkRate).toBeNull()
    expect(k.leadTime).toEqual({ medianMs: null, count: 0 })
  })

  it('folds the lead-time stats from the cards + journal', () => {
    const tasks: ProjectTask[] = [
      { id: 'a', title: 'a', done: true, createdAt: '2026-06-23T00:00:00Z', boardColumn: 'done' },
    ]
    const log: OrchestratorLogLine[] = [
      { at: '2026-06-23T00:06:00Z', level: 'info', kind: 'integrate', message: 'integrated (rebase): a → origin/main' },
    ]
    const k = computeSwarmKpis({ counters: counters({ dispatched: 1, integrated: 1 }), tasks, log })
    expect(k.leadTime).toEqual({ medianMs: 6 * 60_000, count: 1 })
    expect(k.workerSuccessRate).toBe(1)
  })

  it('passes the raw counters through verbatim (the rate denominators)', () => {
    const k = computeSwarmKpis({
      counters: counters({ dispatched: 5, integrated: 3, conflicted: 1, reworked: 2, crashed: 1, stalled: 1 }),
      tasks: [],
      log: [],
    })
    expect(k.counts).toEqual({ dispatched: 5, integrated: 3, conflicted: 1, reworked: 2, crashed: 1, stalled: 1 })
  })
})

describe('KPI: logLine instrumentation wires the counters end-to-end', () => {
  it('a real dispatch pass bumps engine.metrics.dispatched through the logLine chokepoint', async () => {
    const engine = newEngine({ running: true })
    const deps = makeDeps({ cards: [card('a')] })
    expect(engine.metrics.dispatched).toBe(0)
    await runDispatchPass(engine, deps)
    // The dispatch logged a 'dispatch' journal line, which logLine taps into the
    // counter — proving the analytics layer rides the existing event stream with
    // no event-site hook (the same engine the dispatch tests above exercise).
    expect(engine.metrics.dispatched).toBe(1)
  })
})

// ── Consumption metering (the BUDGET layer, card 3f0fd4fa) ────────────────────
// computeSwarmConsumption is PURE (live workers + lifetime counter + injected
// clock → the snapshot the UI shows + the over-budget warning), so HOME isolation
// is moot for the unit tests, but the suite runs under the same HOME-isolated
// harness as the rest of the file. The end-to-end block drives the real
// getOrchestratorState read path (HOME redirected by setup-home.ts).
describe('Consumption: computeSwarmConsumption (pure)', () => {
  const counters = (over: Partial<ReturnType<typeof emptyMetricsCounters>> = {}) => ({
    ...emptyMetricsCounters(),
    ...over,
  })
  const NOW = Date.parse('2026-06-29T12:00:00Z')

  it('counts live workers and sums their in-flight run time (Σ now − startedAt)', () => {
    const c = computeSwarmConsumption({
      liveWorkers: [
        { startedAt: '2026-06-29T11:59:00Z' }, // 1m
        { startedAt: '2026-06-29T11:55:00Z' }, // 5m
      ],
      counters: counters({ dispatched: 2 }),
      limit: 50,
      now: NOW,
    })
    expect(c.activeWorkers).toBe(2)
    expect(c.activeRunMs).toBe(6 * 60_000) // 1m + 5m combined
  })

  it('reads the session dispatch total off the non-lossy counter (the spend proxy)', () => {
    const c = computeSwarmConsumption({
      liveWorkers: [],
      counters: counters({ dispatched: 12 }),
      limit: 50,
      now: NOW,
    })
    expect(c.dispatched).toBe(12)
    expect(c.activeWorkers).toBe(0)
    expect(c.activeRunMs).toBe(0)
  })

  it('flags overLimit once dispatched reaches the budget (>=), never below', () => {
    const at = (d: number) =>
      computeSwarmConsumption({ liveWorkers: [], counters: counters({ dispatched: d }), limit: 5, now: NOW })
    expect(at(4).overLimit).toBe(false)
    expect(at(5).overLimit).toBe(true) // exactly at the ceiling warns
    expect(at(6).overLimit).toBe(true)
  })

  it('never flags overLimit when the limit is 0 (disabled — no false alarm)', () => {
    const c = computeSwarmConsumption({
      liveWorkers: [],
      counters: counters({ dispatched: 99 }),
      limit: 0,
      now: NOW,
    })
    expect(c.overLimit).toBe(false)
  })

  it('skips an unparseable startedAt and clamps clock skew to 0 (never negative)', () => {
    const c = computeSwarmConsumption({
      liveWorkers: [
        { startedAt: 'not-a-date' }, // unparseable → ignored for run time
        { startedAt: '2026-06-29T13:00:00Z' }, // 1h in the FUTURE → clamped to 0
        { startedAt: '2026-06-29T11:30:00Z' }, // 30m in the past
      ],
      counters: counters(),
      limit: 50,
      now: NOW,
    })
    expect(c.activeWorkers).toBe(3) // all three still COUNT as live workers
    expect(c.activeRunMs).toBe(30 * 60_000) // only the valid past one contributes; no negative
  })

  it('defaults `now` to wall-clock when omitted (the live caller path)', () => {
    const c = computeSwarmConsumption({
      liveWorkers: [{ startedAt: new Date(Date.now() - 60_000).toISOString() }],
      counters: counters(),
      limit: 50,
    })
    // ~1 minute of in-flight time, with a generous upper bound for test jitter.
    expect(c.activeRunMs).toBeGreaterThanOrEqual(60_000)
    expect(c.activeRunMs).toBeLessThan(120_000)
  })

  it('passes the limit through verbatim (the displayed ceiling)', () => {
    expect(
      computeSwarmConsumption({ liveWorkers: [], counters: counters(), limit: 42, now: NOW }).limit,
    ).toBe(42)
  })
})

describe('Consumption: getOrchestratorState surfaces the snapshot end-to-end', () => {
  beforeEach(() => __resetOrchestratorForTests())

  it('counts only LIVE workers and carries the session dispatch total + budget', async () => {
    const key = await canonicalize('/proj-consumption-e2e')
    const engine = newEngine({
      path: key,
      workers: [
        worker({ terminalId: 'pty-w1-1', taskId: 'w1', startedAt: '2020-01-01T00:00:00Z' }),
        worker({ terminalId: 'pty-w2-1', taskId: 'w2', startedAt: '2020-01-01T00:00:00Z' }), // dead → filtered
      ],
      metrics: { ...emptyMetricsCounters(), dispatched: 7 },
    })
    __seedEngineForTests(engine)
    const deps = makeDeps({ cards: [], dead: new Set(['w2']) })

    const state = await getOrchestratorState('/proj-consumption-e2e', deps)

    // Only the live worker counts — the dead one is filtered, exactly like `workers`.
    expect(state.consumption.activeWorkers).toBe(1)
    expect(state.workers.map((w) => w.terminalId)).toEqual(['pty-w1-1'])
    // In-flight run time is a finite, positive number (real wall clock here).
    expect(Number.isFinite(state.consumption.activeRunMs)).toBe(true)
    expect(state.consumption.activeRunMs).toBeGreaterThan(0)
    // Session dispatch total rides the non-lossy counter; the budget is the env ceiling.
    expect(state.consumption.dispatched).toBe(7)
    expect(state.consumption.limit).toBe(DISPATCH_BUDGET)
    expect(state.consumption.overLimit).toBe(false) // 7 < default budget
  })

  it('a never-started engine reports an empty consumption snapshot carrying the budget', async () => {
    const state = await getOrchestratorState('/proj-consumption-never', makeDeps({ cards: [] }))
    expect(state.consumption).toEqual({
      activeWorkers: 0,
      activeRunMs: 0,
      dispatched: 0,
      limit: DISPATCH_BUDGET,
      overLimit: false,
    })
  })
})

// ── Token-consumption journal line on promote (card swarm-token) ──────────────
//
// The done moment (promote doing→review) is the one point a card's cost is
// complete, so the engine records ONE `consumption:` info line there via the
// OPTIONAL deps.readConsumption. The contract under test: the line appears
// with the meter's summary + the card title, and EVERY failure shape (null,
// throw, dep absent) silently skips the line without disturbing the promote.

describe('runDispatchPass — consumption journal line on promote', () => {
  const promotable = () => ({
    engine: newEngine({
      workers: [
        worker({ terminalId: 'pty-a-1', branch: 'swarm/a', worktree: '/wt/a', taskId: 'a', taskTitle: 'task a' }),
      ],
    }),
    init: {
      cards: [card('a', { boardColumn: 'doing' })],
      commits: new Map([['a', 2]]),
      heartbeats: new Map([['a', { ready: true, blocked: false }]]),
    },
  })
  const consumptionLines = (engine: ProjectEngine) =>
    engine.log.filter((l) => l.message.startsWith('consumption:'))

  it('records one info line (meter summary + card title) right after the promote', async () => {
    const { engine, init } = promotable()
    const asked: { worktree: string; terminalId: string }[] = []
    const deps = {
      ...makeDeps(init),
      readConsumption: async (opts: { worktree: string; terminalId: string }) => {
        asked.push(opts)
        return '手数191 束ね1.00 文脈max336k 出力347k'
      },
    }
    await runDispatchPass(engine, deps)
    expect(asked).toEqual([{ worktree: '/wt/a', terminalId: 'pty-a-1' }])
    const lines = consumptionLines(engine)
    expect(lines).toHaveLength(1)
    expect(lines[0].level).toBe('info')
    expect(lines[0].message).toBe('consumption: 手数191 束ね1.00 文脈max336k 出力347k — task a')
    expect(lines[0].kind).toBeUndefined() // no metrics counter — classifyMetricEvent maps it to null
    // The journal ORDER matches the flow: promote line first, its cost line after.
    const promoteIdx = engine.log.findIndex((l) => l.message.startsWith('promoted to review'))
    const consumptionIdx = engine.log.findIndex((l) => l.message.startsWith('consumption:'))
    expect(promoteIdx).toBeGreaterThanOrEqual(0)
    expect(consumptionIdx).toBe(promoteIdx + 1)
  })

  it('skips the line silently when the meter resolves null (JSONL unreadable) — promote unharmed', async () => {
    const { engine, init } = promotable()
    const deps = { ...makeDeps(init), readConsumption: async () => null }
    await runDispatchPass(engine, deps)
    expect(consumptionLines(engine)).toHaveLength(0)
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }]) // the promote still landed
  })

  it('swallows a throwing meter — promote unharmed (fail-safe)', async () => {
    const { engine, init } = promotable()
    const deps = {
      ...makeDeps(init),
      readConsumption: async () => {
        throw new Error('disk boom')
      },
    }
    await runDispatchPass(engine, deps)
    expect(consumptionLines(engine)).toHaveLength(0)
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
  })

  it('an absent dep (existing fake-deps shape) never records the line', async () => {
    const { engine, init } = promotable()
    const deps = makeDeps(init) // no readConsumption at all
    await runDispatchPass(engine, deps)
    expect(consumptionLines(engine)).toHaveLength(0)
    expect(deps.reviews).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
  })
})
