import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest'
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
  STALL_SILENCE_MS,
  STALL_NUDGE_COOLDOWN_MS,
  STALL_ECHO_GUARD_MS,
  MAX_EXEC_MS,
  RATE_LIMIT_GRACE_MS,
  PERMISSION_WAIT_GRACE_MS,
  QUESTION_GRACE_MS,
  classifyOutput,
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
  runEnginePass,
  stopOrchestrator,
  setOverseer,
  setAutoMerge,
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
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
  type HeartbeatSign,
  type ProjectEngine,
  type WorkerProbe,
  type ReviewResult,
  type ReviewDecision,
  type ReviewerVerdict,
} from './swarmOrchestrator'
import { canonicalize } from './canonicalize'
import {
  rememberSwarmAutonomy,
  forgetSwarmAutonomy,
  isSwarmAutonomyRemembered,
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
  autoMerge: false,
  passInFlight: false,
  generation: 0,
  timer: null,
  workers: [],
  reviews: [],
  conflictedBranches: new Set(),
  verifyFailed: new Map(),
  reviewFailed: new Map(),
  reviewDeferred: new Map(),
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
  commits?: Map<string, number> // taskId → commits ahead of trunk
  heartbeats?: Map<string, HeartbeatSign> // taskId → heartbeat
  recoverFails?: Set<string> // taskIds whose FIRST recover (todo/blocked) move returns false
  recoverTodoFails?: Set<string> // taskIds whose recover-to-'todo' ALWAYS fails (a 'blocked'
  //   recover still succeeds) — models a requeue that won't land so the engine escalates (blocked退避)
  outputs?: Map<string, number> // terminalId → PTY lastOutputAt epoch ms (absent → null)
  screens?: Map<string, string> // terminalId → current screen text (absent → null = 'normal')
  raiseFails?: boolean // make deps.raiseQuestion throw (fs/notify fault)
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
  const recoverFails = new Set(init.recoverFails ?? [])
  const recoverTodoFails = new Set(init.recoverTodoFails ?? [])
  const commits = init.commits ?? new Map<string, number>()
  const heartbeats = init.heartbeats ?? new Map<string, HeartbeatSign>()
  const outputs = init.outputs ?? new Map<string, number>()
  const screens = init.screens ?? new Map<string, string>()
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
  it('stall behaves like crash (budget-driven) when passed explicitly', () => {
    expect(recoveryColumn(p(), 0, 1, 'stall')).toBe('todo')
    expect(recoveryColumn(p(), 1, 1, 'stall')).toBe('blocked')
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
      prepareTarget: async () => 'main',
      classify: async () => 'ff',
      verify: async () => ({ ok: true, tip: null }),
      integrate: async () => ({ status: 'integrated', mode: 'ff' }),
      moveToDone: async () => true,
      markConflict: async () => true,
      cleanup: async () => ({ removed: true }),
      killPty: () => {},
      instructRework: () => {},
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

    it('stopOrchestrator CLEARS overseer.enabled but LEAVES autoMerge/selfSupply (the D1 asymmetry)', async () => {
      const key = await canonicalize('/proj-overseer-stopclear')
      const engine = newEngine({ path: key, running: true })
      engine.autoMerge = true
      engine.selfSupply.enabled = true
      engine.overseer.enabled = true
      __seedEngineForTests(engine)

      await stopOrchestrator('/proj-overseer-stopclear', makeDeps({ cards: [] }))

      // The most-dangerous stage is disarmed by an explicit OFF …
      expect(engine.overseer.enabled).toBe(false)
      // … while the two benign switches survive (they re-act on the next start).
      expect(engine.autoMerge).toBe(true)
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
      ]) {
        await forgetSwarmAutonomy(await canonicalize(p))
      }
    })

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
    // The manual route (POST /api/swarm/worker) claims its card todo→doing after
    // spawning, so a manually-dispatched card has a live worker the engine does NOT
    // count in engine.workers. The claimed COLUMN is the cross-dispatcher signal:
    // the engine must never spawn a SECOND worker for a card already in doing, even
    // though it has no worker of its own for it. (The deterministic manual+engine
    // twin — a still-todo manual card the engine keeps re-grabbing — is closed by
    // the route doing this claim; here we prove the engine honors it.)
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
    const now = T0 + MAX_EXEC_MS + 1
    const deps = makeDeps({
      cards: [card('a', { boardColumn: 'doing' })],
      screens: new Map([['pty-a-1', 'Claude usage limit reached']]),
    })
    await runDispatchPass(engine, deps, now)
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }])
    expect(engine.rateLimited.has('pty-a-1')).toBe(false)
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
    ...(reviewConfigured ? { review: reviewDep } : {}),
    fetchReview: async () => [...reviews],
    prepareTarget: async () => (init.target === undefined ? 'main' : init.target),
    classify: async (_p, branch) => readiness[branch] ?? 'ff',
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
  }
}

const reviewCard = (id: string, branch: string | undefined, over: Partial<ProjectTask> = {}): ProjectTask =>
  card(id, { boardColumn: 'review', branch, ...over })

describe('runIntegratePass — switch positions', () => {
  it('classifies review cards but integrates NOTHING when autoMerge is OFF', async () => {
    const engine = newEngine({ autoMerge: false })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a'), reviewCard('b', 'swarm/b')],
      readiness: { 'swarm/a': 'ff', 'swarm/b': 'rebase' },
    })
    await runIntegratePass(engine, deps)
    // Read-only readiness published, no mutation.
    expect(engine.reviews.map((r) => [r.branch, r.status])).toEqual([
      ['swarm/a', 'ff'],
      ['swarm/b', 'rebase'],
    ])
    expect(deps.integrated).toHaveLength(0)
    expect(deps.moved).toHaveLength(0)
  })

  it('does nothing at all when the engine is stopped (global stop)', async () => {
    const engine = newEngine({ running: false, autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    await runIntegratePass(engine, deps)
    expect(engine.reviews).toHaveLength(0)
    expect(deps.integrated).toHaveLength(0)
  })

  it('ignores non-swarm branches entirely', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'feature/x'), reviewCard('b', undefined)] })
    await runIntegratePass(engine, deps)
    expect(engine.reviews).toHaveLength(0)
    expect(deps.integrated).toHaveLength(0)
  })
})

describe('runIntegratePass — landing (autoMerge ON)', () => {
  it('integrates a clean card, moves it to done, then cleans up its worktree+branch', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toEqual(['swarm/a'])
    expect(deps.moved).toEqual(['a'])
    expect(deps.cleaned).toEqual(['swarm/a'])
    expect(engine.log.find((l) => l.message.startsWith('integrated (ff)'))?.kind).toBe('integrate')
  })

  it('kills the just-landed worker PTY by id and frees its slot (no zombie)', async () => {
    // The lingering-PTY case: the worker was promoted to review but its `claude`
    // TUI never exits, so it sits in engine.workers as 'done'. Landing its branch
    // must kill that PTY by id and drop it — slot freed immediately, no zombie.
    const engine = newEngine({
      autoMerge: true,
      workers: [worker({ terminalId: 'pty-a', branch: 'swarm/a', taskId: 'a', stage: 'done' })],
    })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    await runIntegratePass(engine, deps)
    expect(deps.cleaned).toEqual(['swarm/a']) // worktree+branch torn down
    expect(deps.killed).toEqual(['pty-a']) // PTY killed by id
    expect(engine.workers).toHaveLength(0) // slot freed
  })

  it('only tears down the LANDED worker, leaving a sibling on another branch', async () => {
    const engine = newEngine({
      autoMerge: true,
      workers: [
        worker({ terminalId: 'pty-a', branch: 'swarm/a', taskId: 'a', stage: 'done' }),
        worker({ terminalId: 'pty-b', branch: 'swarm/b', taskId: 'b', stage: 'running' }),
      ],
    })
    // Only 'a' is up for integration (in review); 'b' is still doing.
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    await runIntegratePass(engine, deps)
    expect(deps.killed).toEqual(['pty-a'])
    expect(engine.workers.map((w) => w.terminalId)).toEqual(['pty-b']) // sibling untouched
  })

  it('does NOT kill the worker when the column move is kept (it still owns the branch)', async () => {
    const engine = newEngine({
      autoMerge: true,
      workers: [worker({ terminalId: 'pty-a', branch: 'swarm/a', taskId: 'a', stage: 'done' })],
    })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], moveToDoneFails: new Set(['a']) })
    await runIntegratePass(engine, deps)
    expect(deps.killed).toHaveLength(0) // landed but card stuck in review → keep the worker
    expect(engine.workers).toHaveLength(1) // retry next pass
  })

  it('does NOT clean up when the column move is kept (self-heals next pass)', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], moveToDoneFails: new Set(['a']) })
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toEqual(['swarm/a'])
    expect(deps.cleaned).toHaveLength(0) // branch NOT deleted while card stuck in review
    expect(engine.log.some((l) => l.message.includes('column move kept'))).toBe(true)
  })

  it('skips integration when there is no remote trunk, leaving cards in review', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], target: null })
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0)
    expect(engine.reviews.map((r) => r.status)).toEqual(['unknown'])
    expect(engine.log.some((l) => l.message.includes('no remote trunk'))).toBe(true)
  })
})

describe('runIntegratePass — conflict handling', () => {
  // CONFLICT → worker rebase 委譲 (card 012a2848): a fresh rebase conflict is no longer
  // parked for a human — it is delegated to the branch's worker to rebase its OWN branch
  // + resolve + commit, then the engine retries. Mirrors the verify-rework tests above.
  const doneWorker = (branch: string, taskId: string, over: Partial<OrchestratorWorker> = {}) =>
    worker({ branch, taskId, terminalId: `pty-${taskId}`, worktree: `/wt/${taskId}`, stage: 'done', ...over })

  it('delegates a fresh conflict to the LIVE worker (review→doing) for a rebase — never parks for a human', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      outcomes: { 'swarm/a': { status: 'conflict', files: ['src/x.ts'] } },
    })
    await runIntegratePass(engine, deps)
    // Did NOT land; sent review→doing on the SAME branch (the worker rebases in place).
    expect(deps.integrated).toEqual(['swarm/a']) // the conflict came FROM a real integrate attempt
    expect(deps.moved).toHaveLength(0) // moveToDone never called — nothing landed
    expect(deps.reworkedToDoing).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(deps.recovered).toHaveLength(0) // not todo/blocked — continued in place
    // SEPARATE conflict budget bumped (NOT the verify rework budget).
    expect(engine.conflictReworks.get('a')).toBe(1)
    expect(engine.reworks.size).toBe(0)
    // Worker put back to 'running' and told to rebase its own branch (never force-push).
    expect(engine.workers[0].stage).toBe('running')
    expect(deps.instructed).toHaveLength(1)
    expect(deps.instructed[0].terminalId).toBe('pty-a')
    expect(deps.instructed[0].message).toContain('git rebase origin/main')
    expect(deps.instructed[0].message).toContain('src/x.ts')
    expect(deps.instructed[0].message).toContain('force-push')
    expect(deps.tornDown).toHaveLength(0) // live worker kept (not torn down)
    // The durable /order memo carries the conflict context for a later re-dispatch.
    expect(engine.reworkReasons.get('a')).toContain('git rebase origin/main')
    // Card left review → never double-integrated while the worker resolves (条件3).
    expect(engine.reviews.find((r) => r.taskId === 'a')).toBeUndefined()
  })

  it('re-dispatches a fresh conflict (review→todo) when the worker is gone — /order carries the conflict context', async () => {
    const engine = newEngine({ autoMerge: true }) // no live worker for the branch
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      outcomes: { 'swarm/a': { status: 'conflict', files: ['src/x.ts'] } },
    })
    await runIntegratePass(engine, deps)
    expect(deps.reworkedToDoing).toHaveLength(0) // no live worker to continue in place
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'todo' }]) // re-queued for a fresh worker
    expect(deps.instructed).toHaveLength(0) // nothing alive to instruct
    expect(engine.conflictReworks.get('a')).toBe(1)
    // The fresh worker's /order will be handed the conflict-resolution context.
    expect(engine.reworkReasons.get('a')).toContain('git rebase origin/main')
    expect(engine.reworkReasons.get('a')).toContain('force-push')
  })

  it('PARKS the card in blocked once MAX_CONFLICT_REWORKS is spent — conflict loop guard', async () => {
    const engine = newEngine({
      autoMerge: true,
      workers: [doneWorker('swarm/a', 'a')],
      conflictReworks: new Map([['a', MAX_CONFLICT_REWORKS]]), // at the cap → this pass overflows it
    })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      outcomes: { 'swarm/a': { status: 'conflict' } },
    })
    await runIntegratePass(engine, deps)
    expect(deps.reworkedToDoing).toHaveLength(0) // NOT delegated again
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }]) // parked for a human
    expect(deps.marks).toContainEqual({ taskId: 'a', value: true }) // stamped so the board shows the conflict
    expect(deps.tornDown).toEqual(['pty-a']) // worker torn down (branch kept for the human)
    expect(engine.conflictReworks.get('a')).toBe(MAX_CONFLICT_REWORKS + 1)
    expect(engine.workers).toHaveLength(0)
    expect(engine.log.some((l) => l.kind === 'conflict' && l.level === 'error')).toBe(true)
  })

  it('the conflict budget is INDEPENDENT of the verify rework budget (a maxed verify budget still delegates)', async () => {
    // A card already at the verify-rework cap must STILL get its conflict delegated (a
    // conflict is not the worker's code being wrong) — the two counters never cross.
    const engine = newEngine({
      autoMerge: true,
      workers: [doneWorker('swarm/a', 'a')],
      reworks: new Map([['a', MAX_REWORKS]]), // verify budget already spent
    })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      outcomes: { 'swarm/a': { status: 'conflict' } },
    })
    await runIntegratePass(engine, deps)
    expect(deps.recovered).toHaveLength(0) // NOT parked — the conflict budget is fresh
    expect(deps.reworkedToDoing).toEqual([{ taskId: 'a', branch: 'swarm/a' }]) // delegated
    expect(engine.conflictReworks.get('a')).toBe(1)
    expect(engine.reworks.get('a')).toBe(MAX_REWORKS) // verify budget untouched by a conflict
  })

  it('a delegated conflict LANDS once the worker resolves it, resetting the conflict budget (条件4)', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      outcomes: { 'swarm/a': { status: 'conflict' } },
    })
    // Pass 1 — conflict → delegated to the live worker (card → doing).
    await runIntegratePass(engine, deps)
    expect(engine.conflictReworks.get('a')).toBe(1)
    expect(deps.moved).toHaveLength(0)

    // The worker rebases + resolves + re-reports: the branch is now cleanly landable,
    // and the monitor re-promoted it to review. Model that for pass 2.
    deps.integrate = async (_p, branch) => {
      deps.integrated.push(branch)
      return { status: 'integrated', mode: 'rebase' }
    }
    deps.fetchReview = async () => [reviewCard('a', 'swarm/a')]
    engine.lastIntegrateAt = 0 // clear the throttle
    await runIntegratePass(engine, deps)
    expect(deps.moved).toEqual(['a']) // landed → review→done
    expect(engine.conflictReworks.has('a')).toBe(false) // budget reset on a successful land
  })

  it('retries a previously-conflicting branch once it becomes fast-forwardable', async () => {
    const engine = newEngine({ autoMerge: true, conflictedBranches: new Set(['swarm/a']) })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      readiness: { 'swarm/a': 'ff' }, // a human rebased it → now clean
    })
    await runIntegratePass(engine, deps)
    expect(deps.marks).toContainEqual({ taskId: 'a', value: false }) // stamp cleared
    expect(deps.integrated).toEqual(['swarm/a'])
    expect(deps.moved).toEqual(['a'])
    expect(engine.conflictedBranches.has('swarm/a')).toBe(false)
  })

  it('forgets a conflict memo when the card leaves the review column', async () => {
    const engine = newEngine({ autoMerge: true, conflictedBranches: new Set(['swarm/gone']) })
    const deps = makeIntDeps({ reviews: [] }) // card no longer in review
    await runIntegratePass(engine, deps)
    expect(engine.conflictedBranches.has('swarm/gone')).toBe(false)
  })

  it('re-stamps a still-conflicting card whose Board stamp went missing, without re-rebasing', async () => {
    // Memo'd + still diverged, but the card lost its stamp (a kept write) → re-stamp.
    const engine = newEngine({ autoMerge: true, conflictedBranches: new Set(['swarm/a']) })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a', { integrationConflict: false })],
      readiness: { 'swarm/a': 'rebase' },
    })
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0) // NOT re-rebased
    expect(deps.marks).toEqual([{ taskId: 'a', value: true }]) // stamp self-healed
  })

  it('does not redundantly re-stamp a still-conflicting card that already carries the stamp', async () => {
    const engine = newEngine({ autoMerge: true, conflictedBranches: new Set(['swarm/b']) })
    const deps = makeIntDeps({
      reviews: [reviewCard('b', 'swarm/b', { integrationConflict: true })],
      readiness: { 'swarm/b': 'rebase' },
    })
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0)
    expect(deps.marks).toHaveLength(0) // no redundant write
  })
})

describe('runIntegratePass — throttle', () => {
  it('skips ticks until INTEGRATE_TICK_MS has passed', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toEqual(['swarm/a'])
    // Immediately again → throttled (lastIntegrateAt just set), no second attempt.
    const before = deps.integrated.length
    await runIntegratePass(engine, deps)
    expect(deps.integrated.length).toBe(before)
  })
})

// ── runIntegratePass — verification gate (Card③: no unverified merge) ──────────
// Observable (1): with auto-merge ARMED, the engine VERIFIES (tsc on the
// to-be-landed tree) BEFORE integrating; a RED result keeps the card in review
// (NOT merged) and logs the reason. The gate is memoized by tip so a stuck-red
// branch isn't re-checked every pass, yet a fix (new tip) re-verifies and lands.

describe('runIntegratePass — verification gate', () => {
  it('does NOT integrate a branch that fails verification — sends it back to rework, never the trunk', async () => {
    const engine = newEngine({
      autoMerge: true,
      workers: [worker({ branch: 'swarm/a', taskId: 'a', terminalId: 'pty-a', worktree: '/wt/a', stage: 'done' })],
    })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, tip: 'sha-a', reason: 'src/x.ts(9): error TS2322' } },
    })
    await runIntegratePass(engine, deps)
    // 安全ゲート: the gate ran; integrate / move / cleanup did NOT — nothing reached the trunk.
    expect(deps.verified.map((v) => v.branch)).toEqual(['swarm/a'])
    expect(deps.integrated).toHaveLength(0)
    expect(deps.moved).toHaveLength(0)
    expect(deps.cleaned).toHaveLength(0)
    // Sent back review→doing for the LIVE worker to fix (差し戻し); the red tip is remembered
    // (so an un-fixed re-promote skips re-tsc); the worker is told WHY.
    expect(deps.reworkedToDoing).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(engine.reworks.get('a')).toBe(1)
    expect(engine.verifyFailed.get('swarm/a')).toBe('sha-a')
    expect(deps.instructed[0]?.message).toContain('error TS2322')
  })

  it('integrates normally when verification passes (the green path is unchanged)', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] }) // default verify = green
    await runIntegratePass(engine, deps)
    expect(deps.verified.map((v) => v.branch)).toEqual(['swarm/a'])
    expect(deps.integrated).toEqual(['swarm/a'])
    expect(deps.moved).toEqual(['a'])
    expect(engine.verifyFailed.has('swarm/a')).toBe(false)
  })

  it('classifies but NEVER verifies/integrates when autoMerge is OFF (read-only)', async () => {
    const engine = newEngine({ autoMerge: false })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    await runIntegratePass(engine, deps)
    expect(deps.verified).toHaveLength(0) // verification is part of the ARMED path only
    expect(deps.integrated).toHaveLength(0)
  })

  it('does not re-run the check for an unchanged red tip (memo skip) — re-reworks, no fresh tsc', async () => {
    // A LIVE worker bounces back un-fixed (same tip) each pass: verifyFailed is KEPT across a
    // doing-continuation, so the 2nd verify is called WITH skipIfTip and short-circuits.
    const engine = newEngine({
      autoMerge: true,
      workers: [worker({ branch: 'swarm/a', taskId: 'a', terminalId: 'pty-a', worktree: '/wt/a', stage: 'done' })],
    })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, tip: 'sha-a', reason: 'TS2322' } },
    })
    deps.fetchReview = async () => [reviewCard('a', 'swarm/a')] // un-fixed worker keeps re-appearing in review
    await runIntegratePass(engine, deps)
    expect(engine.verifyFailed.get('swarm/a')).toBe('sha-a')
    expect(engine.reworks.get('a')).toBe(1)

    // Second pass (throttle reset): verify is called WITH skipIfTip; the fake reports
    // `skipped` (no check run) → still not integrated, just re-reworked.
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(deps.verified[1]?.skipIfTip).toBe('sha-a')
    expect(deps.integrated).toHaveLength(0) // never integrates unverified work
    expect(engine.reworks.get('a')).toBe(2) // re-reworked, not merged
  })

  it('re-verifies and LANDS once the branch tip changes (the worker fixed it after a 差し戻し)', async () => {
    const engine = newEngine({
      autoMerge: true,
      workers: [worker({ branch: 'swarm/a', taskId: 'a', terminalId: 'pty-a', worktree: '/wt/a', stage: 'done' })],
    })
    const verifyResults: Record<string, { ok: boolean; tip?: string | null; reason?: string }> = {
      'swarm/a': { ok: false, tip: 'sha-old', reason: 'TS2322' },
    }
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], verifyResults })
    deps.fetchReview = async () => [reviewCard('a', 'swarm/a')] // the worker keeps the card visible in review
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0) // RED → sent back to rework, not landed
    expect(engine.verifyFailed.get('swarm/a')).toBe('sha-old')
    expect(engine.reworks.get('a')).toBe(1)

    // The worker fixes it → the branch tip changes and the check now passes.
    verifyResults['swarm/a'] = { ok: true, tip: 'sha-new' }
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toEqual(['swarm/a']) // verified green at the NEW tip → landed
    expect(deps.moved).toEqual(['a'])
    expect(engine.verifyFailed.has('swarm/a')).toBe(false) // memo cleared on green
    expect(engine.reworks.has('a')).toBe(false) // 差し戻し budget reset on success
  })

  it('forgets a verify-fail memo when the card leaves the review column', async () => {
    const engine = newEngine({ autoMerge: true, verifyFailed: new Map([['swarm/gone', 'sha']]) })
    const deps = makeIntDeps({ reviews: [] }) // card no longer in review
    await runIntegratePass(engine, deps)
    expect(engine.verifyFailed.has('swarm/gone')).toBe(false)
  })

  it('an ERRORED verify DEFERS — never falls through to integrate unverified', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    deps.verify = async () => {
      throw new Error('verify boom')
    }
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0)
    expect(engine.log.some((l) => l.message.startsWith('verification errored'))).toBe(true)
  })

  it('a known-conflict branch is short-circuited BEFORE verify (no redundant check)', async () => {
    // The conflict memo wins: a branch already known to conflict never reaches the
    // verification gate (it can't land anyway until a human rebases it).
    const engine = newEngine({ autoMerge: true, conflictedBranches: new Set(['swarm/a']) })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a', { integrationConflict: true })],
      readiness: { 'swarm/a': 'rebase' }, // still diverged → stays conflicted
    })
    await runIntegratePass(engine, deps)
    expect(deps.verified).toHaveLength(0) // gate not reached
    expect(deps.integrated).toHaveLength(0)
  })
})

// ── runIntegratePass — rework 差し戻し (review→doing, the missing transition) ───
describe('runIntegratePass — rework 差し戻し (review→doing)', () => {
  const doneWorker = (branch: string, taskId: string, over: Partial<OrchestratorWorker> = {}) =>
    worker({ branch, taskId, terminalId: `pty-${taskId}`, worktree: `/wt/${taskId}`, stage: 'done', ...over })

  it('sends a verify-RED card back review→doing, keeps the LIVE worker on the same branch + instructs it', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, reason: 'TS2322 not assignable' } },
    })
    await runIntegratePass(engine, deps)
    // Did NOT integrate; moved review→doing recording the SAME branch (戻して直す).
    expect(deps.integrated).toHaveLength(0)
    expect(deps.moved).toHaveLength(0) // moveToDone never called
    expect(deps.reworkedToDoing).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(deps.recovered).toHaveLength(0) // not todo/blocked — continued in place
    // Counter bumped, readiness dropped, worker put back to 'running' + instructed why.
    expect(engine.reworks.get('a')).toBe(1)
    expect(engine.reviews.find((r) => r.taskId === 'a')).toBeUndefined()
    expect(engine.workers[0].stage).toBe('running')
    expect(deps.instructed).toHaveLength(1)
    expect(deps.instructed[0].terminalId).toBe('pty-a')
    expect(deps.instructed[0].message).toContain('TS2322 not assignable')
    expect(deps.tornDown).toHaveLength(0) // live worker kept (not torn down)
  })

  it('re-dispatches (review→todo) when the worker is DEAD — same-branch continuation impossible', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, reason: 'tsc red' } },
      dead: new Set(['pty-a']),
    })
    await runIntegratePass(engine, deps)
    expect(deps.reworkedToDoing).toHaveLength(0) // not continued in place
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'todo' }]) // re-queued for a fresh worker
    expect(deps.tornDown).toEqual(['pty-a']) // dead worker torn down
    expect(deps.instructed).toHaveLength(0) // nothing alive to instruct
    expect(engine.reworks.get('a')).toBe(1)
    expect(engine.workers).toHaveLength(0) // dropped from the live set
  })

  it('PARKS the card in blocked once the rework budget (MAX_REWORKS) is spent — loop guard', async () => {
    const engine = newEngine({
      autoMerge: true,
      workers: [doneWorker('swarm/a', 'a')],
      reworks: new Map([['a', MAX_REWORKS]]), // already at the cap → this pass overflows it
    })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, reason: 'still red' } },
    })
    await runIntegratePass(engine, deps)
    expect(deps.reworkedToDoing).toHaveLength(0) // NOT sent back to doing again
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'blocked' }]) // parked for a human
    expect(deps.tornDown).toEqual(['pty-a']) // won't keep a worker on a parked card
    expect(engine.reworks.get('a')).toBe(MAX_REWORKS + 1) // over-budget count kept for the anomaly
    expect(engine.workers).toHaveLength(0)
  })

  it('surfaces a parked (over-budget) card as a rework-exhausted anomaly', async () => {
    const engine = newEngine({ reworks: new Map([['a', MAX_REWORKS + 1]]) })
    const tasks = [card('a', { boardColumn: 'blocked', branch: 'swarm/a', title: 'Card A' })]
    const deps = makeDeps({ cards: tasks })
    const anomalies = await detectAnomalies(
      engine,
      tasks,
      { ...deps, worktreeExists: async () => true },
      Date.now(),
    )
    const a = anomalies.find((x) => x.kind === 'rework-exhausted')
    expect(a).toBeTruthy()
    expect(a?.ref).toBe('a')
    expect(a?.branch).toBe('swarm/a')
    expect(a?.attempts).toBe(MAX_REWORKS + 1)
  })

  it('does NOT rework when autoMerge is OFF — read-only classify, the card stays in review', async () => {
    const engine = newEngine({ autoMerge: false, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, reason: 'red' } },
    })
    await runIntegratePass(engine, deps)
    expect(deps.reworkedToDoing).toHaveLength(0)
    expect(deps.recovered).toHaveLength(0)
    expect(engine.reworks.size).toBe(0) // never touched while disarmed
  })

  it('a verify-GREEN card still integrates — the rework path never fires on success (no regression)', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] }) // default green + clean FF
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toEqual(['swarm/a'])
    expect(deps.moved).toEqual(['a']) // review→done
    expect(deps.reworkedToDoing).toHaveLength(0)
    expect(engine.reworks.size).toBe(0)
  })

  it('keeps bumping the SAME counter across passes when the worker returns un-fixed (same tip)', async () => {
    // The anti-bounce guarantee: a worker that bounces back to review WITHOUT fixing
    // (same branch/tip) is escalated, not looped forever. Pass 1 RED → 差し戻し
    // (count 1); the un-fixed card returns to review; pass 2's verify is `skipped`
    // (same tip) but still a rework → count 2; pass 3 overflows MAX_REWORKS=2 → parked
    // in blocked (no 3rd doing bounce). Also proves verifyFailed is KEPT across a
    // doing-continuation (so the same-tip re-check short-circuits, no wasted tsc).
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, reason: 'red' } },
    })
    // Model the worker bouncing back to review un-fixed each pass (same card/branch):
    // the board keeps reporting it in review even after the engine sent it to doing.
    deps.fetchReview = async () => [reviewCard('a', 'swarm/a')]
    await runIntegratePass(engine, deps)
    expect(engine.reworks.get('a')).toBe(1)
    engine.lastIntegrateAt = 0 // clear the 15s integration throttle so the next pass acts
    await runIntegratePass(engine, deps)
    expect(engine.reworks.get('a')).toBe(2)
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(engine.reworks.get('a')).toBe(MAX_REWORKS + 1) // budget spent → parked, not bounced
    expect(deps.recovered.some((r) => r.column === 'blocked')).toBe(true)
  })

  it('escalates a DEAD-worker rework to blocked across passes — the todo re-dispatch budget is NOT reset', async () => {
    // A worker that keeps dying with RED work: each pass reworks review→todo (no live worker), and
    // the taskId-keyed counter survives the todo hop (pruneReworks does NOT wipe todo), so the cap
    // eventually bites → blocked. Without that it would bounce review→todo forever (the MAJOR fix).
    const engine = newEngine({ autoMerge: true }) // no live worker → dead/re-dispatch path each pass
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, reason: 'red' } },
    })
    deps.fetchReview = async () => [reviewCard('a', 'swarm/a')] // card keeps re-appearing in review
    await runIntegratePass(engine, deps)
    expect(engine.reworks.get('a')).toBe(1)
    expect(deps.recovered.at(-1)).toEqual({ taskId: 'a', column: 'todo' }) // dead path → re-dispatch
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(engine.reworks.get('a')).toBe(2)
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(engine.reworks.get('a')).toBe(MAX_REWORKS + 1)
    expect(deps.recovered.at(-1)).toEqual({ taskId: 'a', column: 'blocked' }) // cap → parked, not looping
  })
})

// ── Learning loop — 差し戻し原因を次の再dispatchの /order に注入 (card fdf714ef) ──────
// The whole point: a 差し戻し/rollback shouldn't repeat. The integrate pass RECORDS
// why a card was sent back; the NEXT dispatch of that SAME card HANDS the reason to
// the fresh worker's /order (so it doesn't repeat the RED verify / must-fix) and the
// engine log records that the context was injected. Reproduced end-to-end (HOME-free,
// fully faked) by chaining runIntegratePass → runDispatchPass on one engine.
describe('learning loop — rework reason injected into the re-dispatch /order (card fdf714ef)', () => {
  const doneWorker = (branch: string, taskId: string, over: Partial<OrchestratorWorker> = {}) =>
    worker({ branch, taskId, terminalId: `pty-${taskId}`, worktree: `/wt/${taskId}`, stage: 'done', ...over })

  it('records the rework cause, then injects it into the re-dispatched card /order + logs it', async () => {
    // 1) 差し戻し: verify RED + DEAD worker ⇒ review→todo 再 dispatch 経路。原因を engine state に記録。
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const intDeps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, reason: 'tsc: error TS2345 foo not assignable to bar' } },
      dead: new Set(['pty-a']),
    })
    await runIntegratePass(engine, intDeps)
    // 条件1: 差し戻しの原因が engine state に記録された。
    expect(engine.reworkReasons.get('a')).toContain('TS2345')
    expect(intDeps.recovered).toEqual([{ taskId: 'a', column: 'todo' }]) // 再 dispatch 待ちで todo へ
    expect(engine.workers).toHaveLength(0) // dead worker は撤去

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

// ── runIntegratePass — adversarial review gate (card a14329dc) ─────────────────
// The COMPLEMENT to the verify gate: after verify is GREEN, an INDEPENDENT panel
// fact-checks the diff and a STRICT majority decides. Driven with a FAKE `review`
// dep (the real claude panel is covered by tallyReview / extractReviewVerdict above
// + the REAL-git integration test) to prove the ROUTING the goal specifies:
// majority must-fix → 差し戻し (never merge); all clean → land; no majority → defer.
describe('runIntegratePass — adversarial review gate (a14329dc)', () => {
  const doneWorker = (branch: string, taskId: string, over: Partial<OrchestratorWorker> = {}) =>
    worker({ branch, taskId, terminalId: `pty-${taskId}`, worktree: `/wt/${taskId}`, stage: 'done', ...over })

  const mustFixResult = (note = 'real bug'): ReviewResult => ({
    decision: 'rework',
    verdicts: [],
    mustFix: 2,
    clean: 1,
    reason: `敵対レビュー多数決: 2/${REVIEW_PANEL_SIZE} が must-fix 判定 — ${note}`,
  })
  const cleanResult = (): ReviewResult => ({
    decision: 'integrate',
    verdicts: [],
    mustFix: 0,
    clean: 3,
    reason: '敵対レビュー多数決: 3/3 clean',
  })
  const deferResult = (): ReviewResult => ({
    decision: 'defer',
    verdicts: [],
    mustFix: 1,
    clean: 1,
    reason: '敵対レビュー多数決つかず',
  })

  it('(1)+(2) majority must-fix → 差し戻し review→doing, NEVER integrated, logged', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      reviewResults: { 'swarm/a': mustFixResult('off-by-one in loop') },
    })
    await runIntegratePass(engine, deps)
    // Composition order: verify ran GREEN first, THEN the panel reviewed.
    expect(deps.verified).toHaveLength(1)
    expect(deps.reviewed).toHaveLength(1)
    expect(deps.reviewed[0]).toMatchObject({ branch: 'swarm/a', tip: 'tip-swarm/a' })
    // Majority must-fix → NOT merged; sent back review→doing (戻して直す) with the reason.
    expect(deps.integrated).toHaveLength(0)
    expect(deps.moved).toHaveLength(0)
    expect(deps.reworkedToDoing).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
    expect(engine.reworks.get('a')).toBe(1)
    expect(engine.reviewFailed.get('swarm/a')).toBe('tip-swarm/a') // memoized for the skip path
    expect(deps.instructed[0]?.message).toContain('off-by-one in loop')
    // Observability (condition 4): the verdict + tally is in the engine log.
    expect(engine.log.some((l) => l.message.includes('敵対レビュー多数決 → 差し戻し'))).toBe(true)
    expect(engine.log.some((l) => l.message.includes('must-fix 2 / clean 1'))).toBe(true)
  })

  it('(3) all clean → integrated (lands), logged green', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      reviewResults: { 'swarm/a': cleanResult() },
    })
    await runIntegratePass(engine, deps)
    expect(deps.reviewed).toHaveLength(1)
    expect(deps.integrated).toEqual(['swarm/a']) // majority clean → landed
    expect(deps.moved).toEqual(['a'])
    expect(deps.reworkedToDoing).toHaveLength(0)
    expect(engine.reworks.has('a')).toBe(false)
    expect(engine.reviewFailed.has('swarm/a')).toBe(false)
    expect(engine.log.some((l) => l.message.includes('敵対レビュー多数決 → clean'))).toBe(true)
  })

  it('no majority (defer) → stays in review: NOT integrated, NOT reworked, not memoized', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      reviewResults: { 'swarm/a': deferResult() },
    })
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0) // never merge on thin signal
    expect(deps.reworkedToDoing).toHaveLength(0) // not sent back…
    expect(deps.recovered).toHaveLength(0)
    expect(engine.reworks.has('a')).toBe(false) // …so the 差し戻し budget is untouched
    expect(engine.reviewFailed.has('swarm/a')).toBe(false) // transient — retried fresh next pass
    expect(engine.log.some((l) => l.message.includes('敵対レビュー多数決つかず → 保留'))).toBe(true)
  })

  it('the panel runs ONLY after verify is green — a verify-RED card never reaches it', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, reason: 'tsc red' } },
      reviewDefault: 'integrate', // would PASS if reached — proving it is NOT reached
    })
    await runIntegratePass(engine, deps)
    expect(deps.verified).toHaveLength(1)
    expect(deps.reviewed).toHaveLength(0) // verify RED short-circuits BEFORE the panel
    expect(deps.integrated).toHaveLength(0) // 差し戻し on the verify gate
    expect(deps.reworkedToDoing).toEqual([{ taskId: 'a', branch: 'swarm/a' }])
  })

  it('back-compat: NO review dep wired → integrate runs straight after verify (stage skipped)', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] }) // no reviewResults/reviewDefault
    expect(deps.review).toBeUndefined()
    await runIntegratePass(engine, deps)
    expect(deps.reviewed).toHaveLength(0)
    expect(deps.integrated).toEqual(['swarm/a']) // lands exactly as before a14329dc
    expect(deps.moved).toEqual(['a'])
  })

  it('memo: an unchanged must-fix tip re-reworks WITHOUT a fresh panel (skipIfTip), escalating to blocked', async () => {
    // A LIVE worker keeps bouncing back un-fixed (same tip). Pass 1 reviews must-fix +
    // memoizes; passes 2-3 carry it via skipIfTip (panel SKIPPED — no re-burning claude)
    // and re-rework until MAX_REWORKS overflows → parked in 'blocked'.
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      reviewResults: { 'swarm/a': mustFixResult() },
    })
    deps.fetchReview = async () => [reviewCard('a', 'swarm/a')] // un-fixed worker re-appears in review

    await runIntegratePass(engine, deps)
    expect(engine.reworks.get('a')).toBe(1)
    expect(engine.reviewFailed.get('swarm/a')).toBe('tip-swarm/a')
    expect(deps.reviewed.filter((r) => r.skipIfTip === undefined)).toHaveLength(1) // 1st: real panel

    engine.lastIntegrateAt = 0 // reset throttle
    await runIntegratePass(engine, deps)
    expect(engine.reworks.get('a')).toBe(2)
    // 2nd review call carried skipIfTip = the memoized tip (panel short-circuited).
    expect(deps.reviewed.at(-1)?.skipIfTip).toBe('tip-swarm/a')

    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0) // never merged across the whole bounce
    expect(deps.recovered.at(-1)).toEqual({ taskId: 'a', column: 'blocked' }) // budget spent → parked
    expect(engine.reworks.get('a')).toBe(MAX_REWORKS + 1)
    expect(engine.reviewFailed.has('swarm/a')).toBe(false) // cleared on park
  })

  it('owner DISARM during the (slow) panel: the card is not mutated', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    // A review that flips autoMerge OFF mid-await, then reports must-fix.
    deps.review = async () => {
      engine.autoMerge = false
      return mustFixResult()
    }
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0)
    expect(deps.reworkedToDoing).toHaveLength(0) // disarm landed → no 差し戻し write
    expect(engine.reworks.has('a')).toBe(false)
  })

  it('an ERRORED panel defers (leaves the card in review) — never merges un-reviewed', async () => {
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] })
    deps.review = async () => {
      throw new Error('panel spawn failed')
    }
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0) // not merged
    expect(deps.reworkedToDoing).toHaveLength(0) // not a worker fault → not sent back
    expect(engine.reworks.has('a')).toBe(false)
    expect(engine.log.some((l) => l.message.includes('adversarial review errored'))).toBe(true)
  })

  it('persistent defer is BOUNDED — after MAX_REVIEW_DEFERS the panel stops re-spawning + needs-human; a new tip re-arms', async () => {
    // A genuinely ambiguous diff (or a systemic claude outage where every reviewer
    // abstains) defers every pass. Unbounded, that re-burns N claude sessions forever.
    const engine = newEngine({ autoMerge: true, workers: [doneWorker('swarm/a', 'a')] })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      reviewResults: { 'swarm/a': deferResult() },
    })
    deps.fetchReview = async () => [reviewCard('a', 'swarm/a')] // ambiguous card keeps re-appearing

    for (let i = 0; i < MAX_REVIEW_DEFERS; i++) {
      engine.lastIntegrateAt = 0
      await runIntegratePass(engine, deps)
    }
    expect(deps.reviewed).toHaveLength(MAX_REVIEW_DEFERS) // a REAL panel ran each pass so far
    expect(deps.integrated).toHaveLength(0) // never merged on no-majority
    expect(engine.reviewDeferred.get('swarm/a')?.count).toBe(MAX_REVIEW_DEFERS)
    expect(engine.reviews.find((r) => r.taskId === 'a')?.status).toBe('conflict') // needs-human dot
    expect(engine.log.some((l) => l.message.includes('needs-human 退避'))).toBe(true)

    // Next pass: defer-exhausted on THIS tip → panel is SKIPPED (no fresh claude burn).
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(deps.reviewed).toHaveLength(MAX_REVIEW_DEFERS) // NOT incremented — panel skipped
    expect(deps.integrated).toHaveLength(0)

    // A NEW commit (different verified tip) clears the streak → the panel re-arms.
    deps.verify = async () => ({ ok: true, tip: 'tip-fixed' })
    deps.review = async () => cleanResult()
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toContain('swarm/a') // re-reviewed clean on the new tip → landed
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
      // Integration half — present but inert (autoMerge OFF, no review cards).
      fetchReview: async () => [],
      prepareTarget: async () => 'main',
      classify: async () => 'ff',
      verify: async () => ({ ok: true, tip: null }),
      integrate: async () => ({ status: 'integrated', mode: 'ff' }),
      moveToDone: async () => true,
      markConflict: async () => true,
      cleanup: async () => ({ removed: true }),
      killPty: () => {},
      instructRework: () => {},
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
      // Integration half — present but inert (autoMerge OFF, no review cards).
      fetchReview: async () => [],
      prepareTarget: async () => 'main',
      classify: async () => 'ff',
      verify: async () => ({ ok: true, tip: null }),
      integrate: async () => ({ status: 'integrated', mode: 'ff' }),
      moveToDone: async () => true,
      markConflict: async () => true,
      cleanup: async () => ({ removed: true }),
      killPty: () => {},
      instructRework: () => {},
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

describe('runIntegratePass — reliable conflict-flag clear on land', () => {
  it('clears a stale stamp when a still-stamped card finally lands (no done-but-flagged zombie)', async () => {
    // The branch carries the persistent stamp but the in-memory memo is EMPTY (e.g.
    // a server restart lost the memo while the board stamp survived). It is now
    // fast-forwardable and lands — the stamp must be cleared on the way to done.
    const engine = newEngine({ autoMerge: true }) // conflictedBranches empty
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a', { integrationConflict: true })],
      readiness: { 'swarm/a': 'ff' },
    })
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toEqual(['swarm/a'])
    expect(deps.moved).toEqual(['a'])
    expect(deps.marks).toContainEqual({ taskId: 'a', value: false }) // stamp cleared on land
  })

  it('does NOT write a clear for a normal (never-stamped) card that lands', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] }) // no stamp
    await runIntegratePass(engine, deps)
    expect(deps.moved).toEqual(['a'])
    expect(deps.marks).toHaveLength(0) // no wasted markConflict write on the happy path
  })

  it('names the conflicted files in the delegated rebase instruction so the worker knows where to resolve', async () => {
    // Card 012a2848: the conflict files are now surfaced in the WORKER instruction
    // (the /order memo a re-dispatch carries), not a "manual integration" log line.
    const engine = newEngine({ autoMerge: true }) // no live worker → todo re-dispatch path
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      outcomes: { 'swarm/a': { status: 'conflict', files: ['src/x.ts', 'src/y.ts'] } },
    })
    await runIntegratePass(engine, deps)
    const memo = engine.reworkReasons.get('a')
    expect(memo).toContain('src/x.ts')
    expect(memo).toContain('src/y.ts')
    // It is recorded as a 'conflict'-kind event (so the KPI conflicted counter is bumped).
    expect(engine.log.some((l) => l.kind === 'conflict')).toBe(true)
  })
})

// ── Card 254fe0 ② — anti-zombie: column-move save-failure recovery ─────────────
// A KEPT column move is tracked (engine.stuckMoves) and, past the budget, the
// engine ESCALATES (a lost-worker recovery → blocked) and SURFACES the rest as a
// 'move-stuck' anomaly, instead of an endless silent warn loop that zombies a card.

describe('runIntegratePass — anti-zombie: done-move kept tracking ("done なのに review")', () => {
  it('tracks a landed-but-kept card and bumps it each pass up to the budget', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], moveToDoneFails: new Set(['a']) })
    await runIntegratePass(engine, deps)
    // The branch landed on the trunk but the review→done move was kept → tracked.
    expect(deps.integrated).toEqual(['swarm/a'])
    expect(engine.stuckMoves.get('a')).toMatchObject({ intent: 'done', attempts: 1, branch: 'swarm/a' })
    // Each throttle-reset pass re-integrates (already merged) and re-keeps the move.
    for (let i = 2; i <= MOVE_STUCK_MAX_RETRIES; i++) {
      engine.lastIntegrateAt = 0
      await runIntegratePass(engine, deps)
    }
    expect(engine.stuckMoves.get('a')?.attempts).toBe(MOVE_STUCK_MAX_RETRIES)
  })

  it('clears the tracking once the done move finally lands', async () => {
    const engine = newEngine({ autoMerge: true })
    await runIntegratePass(
      engine,
      makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], moveToDoneFails: new Set(['a']) }),
    )
    expect(engine.stuckMoves.has('a')).toBe(true)
    // The board write recovers (a fresh deps with no failure) → move lands → cleared.
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')] }))
    expect(engine.stuckMoves.has('a')).toBe(false)
  })
})

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

  it('only rework-exhausted is fatal — other anomaly kinds never notify (条件4)', () => {
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
