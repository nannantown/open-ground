import { describe, it, expect, beforeEach } from 'vitest'
import {
  ORCHESTRATOR_MAX_WORKERS,
  STALE_HEARTBEAT_MS,
  RECOVER_MAX_REQUEUE,
  MOVE_STUCK_MAX_RETRIES,
  STALL_SILENCE_MS,
  STALL_NUDGE_COOLDOWN_MS,
  STALL_ECHO_GUARD_MS,
  MAX_EXEC_MS,
  RATE_LIMIT_GRACE_MS,
  PERMISSION_WAIT_GRACE_MS,
  classifyOutput,
  isRunaway,
  isTodoCard,
  isReviewCard,
  sortTodos,
  selectDispatch,
  declaredFiles,
  contentKey,
  classifyWorker,
  classifyStall,
  lastActivityMs,
  detectAnomalies,
  pruneStuckMoves,
  recoveryColumn,
  runDispatchPass,
  runIntegratePass,
  runEnginePass,
  stopOrchestratorWorker,
  resolveOrchestratorReview,
  __resetOrchestratorForTests,
  __seedEngineForTests,
  type OrchestratorDeps,
  type IntegrationDeps,
  type AnomalyDeps,
  type HeartbeatSign,
  type ProjectEngine,
  type WorkerProbe,
} from './swarmOrchestrator'
import { canonicalize } from './canonicalize'
import type { OrchestratorWorker, ProjectTask, SpawnSwarmWorkerResponse } from '../types'
import type { IntegrateOutcome, ReviewReadiness } from './swarmIntegrate'

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
  lastIntegrateAt: 0,
  recoveries: new Map(),
  stuckMoves: new Map(),
  nudges: new Map(),
  rateLimited: new Map(),
  permissionWaits: new Map(),
  log: [],
  anomalies: [],
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
}): OrchestratorDeps & {
  spawned: { taskId: string }[]
  moves: { taskId: string; branch: string }[]
  reviews: { taskId: string; branch: string }[]
  recovered: { taskId: string; column: 'todo' | 'blocked' }[]
  tornDown: { terminalId: string; worktree: string }[]
  nudged: string[] // terminalIds nudged (Enter), in order
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
  const spawned: { taskId: string }[] = []
  const moves: { taskId: string; branch: string }[] = []
  const reviews: { taskId: string; branch: string }[] = []
  const recovered: { taskId: string; column: 'todo' | 'blocked' }[] = []
  const tornDown: { terminalId: string; worktree: string }[] = []
  const nudged: string[] = []
  const idOf = (branch: string) => branch.replace(/^swarm\//, '')
  let n = 0
  return {
    spawned,
    moves,
    reviews,
    recovered,
    tornDown,
    nudged,
    board,
    fetchTasks: async () => Array.from(board.values()).map((c) => ({ ...c })),
    spawnWorker: async (opts) => {
      // The fake keys "which card" off the title (the engine passes the card's
      // title); map back to its id via the live board.
      const t = Array.from(board.values()).find((x) => (x.title ?? '') === opts.title)
      const taskId = t?.id ?? `?${opts.title}`
      if (spawnFails.has(taskId)) throw new Error('spawn boom')
      n += 1
      spawned.push({ taskId })
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
    // Current screen text, keyed by terminalId (absent → null, which classifyOutput
    // reads as 'normal' = ordinary work). Drives the rate-limit / permission-wait
    // classification.
    recentOutput: (terminalId) => screens.get(terminalId) ?? null,
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
  it('orders by boardOrder ascending, then ordered-before-unordered, then createdAt', () => {
    const cards = [
      card('u2', { boardOrder: undefined, createdAt: '2026-06-23T00:00:02Z' }),
      card('o5', { boardOrder: 5 }),
      card('u1', { boardOrder: undefined, createdAt: '2026-06-23T00:00:01Z' }),
      card('o1', { boardOrder: 1 }),
    ]
    expect(sortTodos(cards).map((c) => c.id)).toEqual(['o1', 'o5', 'u1', 'u2'])
  })
  it('does not mutate its input', () => {
    const cards = [card('o5', { boardOrder: 5 }), card('o1', { boardOrder: 1 })]
    const before = cards.map((c) => c.id)
    sortTodos(cards)
    expect(cards.map((c) => c.id)).toEqual(before)
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
  const silentInput = (nudge?: { count: number; lastNudgeAt: number }) => ({
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
  it('RECLAIMS a worker still silent after the nudge budget is spent', () => {
    expect(classifyStall(silentInput({ count: 2, lastNudgeAt: NOW - P.cooldownMs - 1 }), NOW, P).action).toBe('reclaim')
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
    // still silent and the budget is spent → it RECLAIMS (the echo cannot save it).
    const lastNudgeAt = NOW - P.cooldownMs - 1
    const r = classifyStall(
      { heartbeatAtMs: null, lastOutputAtMs: lastNudgeAt + 1000, startedAtMs: oldStart, nudge: { count: 2, lastNudgeAt } },
      NOW,
      P,
    )
    expect(r.action).toBe('reclaim')
    expect(r.progressed).toBe(false)
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
      recentOutput: () => null,
    }
    await runDispatchPass(engine, deps)
    expect(engine.log.some((l) => l.level === 'warn' && l.message.startsWith('board read failed'))).toBe(
      true,
    )
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

  it('escalates nudge→nudge→RECLAIM, tearing down the worktree + re-homing the card (no zombie)', async () => {
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
    // Pass 3 — budget spent, still silent → RECLAIM.
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 2 * STALL_NUDGE_COOLDOWN_MS + 3)

    expect(deps.tornDown).toEqual([{ terminalId: 'pty-a-1', worktree: '/wt/a' }]) // worktree + PTY torn down
    expect(deps.recovered).toEqual([{ taskId: 'a', column: 'todo' }]) // card back on the board (one retry)
    expect(deps.board.get('a')?.boardColumn).toBe('todo')
    expect(engine.workers).toHaveLength(0) // slot freed (re-dispatch waits for the next fetch)
    expect(engine.nudges.has('pty-a-1')).toBe(false) // bookkeeping cleared
    const reclaim = engine.log.find((l) => l.message.startsWith('worker stalled — reclaimed — card → todo'))
    expect(reclaim?.kind).toBe('stall')
    expect(reclaim?.level).toBe('warn')
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
    // Drive straight to reclaim (two nudges + cooldown, then spent).
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 1)
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + STALL_NUDGE_COOLDOWN_MS + 2)
    await runDispatchPass(engine, deps, T0 + STALL_SILENCE_MS + 2 * STALL_NUDGE_COOLDOWN_MS + 3)
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
}): IntegrationDeps & {
  integrated: string[]
  moved: string[]
  cleaned: string[]
  killed: string[]
  marks: { taskId: string; value: boolean }[]
  verified: { branch: string; skipIfTip?: string }[]
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
  return {
    integrated,
    moved,
    cleaned,
    killed,
    marks,
    verified,
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
  it('marks a conflicting card, leaves it in review, and does not re-rebase it next pass', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      outcomes: { 'swarm/a': { status: 'conflict' } },
      readiness: { 'swarm/a': 'rebase' }, // still diverged on the retry probe
    })
    await runIntegratePass(engine, deps)
    expect(deps.marks).toEqual([{ taskId: 'a', value: true }])
    expect(deps.moved).toHaveLength(0)
    expect(engine.conflictedBranches.has('swarm/a')).toBe(true)
    expect(engine.reviews.map((r) => r.status)).toEqual(['conflict'])
    expect(engine.log.find((l) => l.message.startsWith('conflict'))?.kind).toBe('conflict')
    expect(engine.log.some((l) => l.level === 'error' && l.message.startsWith('conflict'))).toBe(true)

    // Next pass (throttle reset): the known-conflict branch is NOT re-integrated.
    engine.lastIntegrateAt = 0
    const before = deps.integrated.length
    await runIntegratePass(engine, deps)
    expect(deps.integrated.length).toBe(before)
    expect(engine.reviews.map((r) => r.status)).toEqual(['conflict'])
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
  it('does NOT integrate a branch that fails verification — leaves it in review, logs the reason', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, tip: 'sha-a', reason: 'src/x.ts(9): error TS2322' } },
    })
    await runIntegratePass(engine, deps)
    // The gate ran; integrate / move / cleanup did NOT — nothing reached the trunk.
    expect(deps.verified.map((v) => v.branch)).toEqual(['swarm/a'])
    expect(deps.integrated).toHaveLength(0)
    expect(deps.moved).toHaveLength(0)
    expect(deps.cleaned).toHaveLength(0)
    // The red tip is remembered; the dashboard shows it needs a human; the reason logs.
    expect(engine.verifyFailed.get('swarm/a')).toBe('sha-a')
    expect(engine.reviews.map((r) => r.status)).toEqual(['conflict'])
    expect(
      engine.log.some(
        (l) => l.level === 'error' && l.message.startsWith('verification failed — not merging'),
      ),
    ).toBe(true)
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

  it('does not re-run the check for an unchanged red tip (no tsc thrash) but still blocks', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      verifyResults: { 'swarm/a': { ok: false, tip: 'sha-a', reason: 'TS2322' } },
    })
    await runIntegratePass(engine, deps)
    expect(engine.verifyFailed.get('swarm/a')).toBe('sha-a')
    const errLogs = engine.log.filter((l) => l.message.startsWith('verification failed')).length

    // Second pass (throttle reset): verify is called WITH skipIfTip; the fake
    // reports `skipped` (no check run) → still not integrated, and no new loud log.
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(deps.verified[1]?.skipIfTip).toBe('sha-a')
    expect(deps.integrated).toHaveLength(0)
    expect(engine.log.filter((l) => l.message.startsWith('verification failed')).length).toBe(errLogs)
  })

  it('re-verifies and LANDS once the branch tip changes (a fix was pushed)', async () => {
    const engine = newEngine({ autoMerge: true })
    const verifyResults: Record<string, { ok: boolean; tip?: string | null; reason?: string }> = {
      'swarm/a': { ok: false, tip: 'sha-old', reason: 'TS2322' },
    }
    const deps = makeIntDeps({ reviews: [reviewCard('a', 'swarm/a')], verifyResults })
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toHaveLength(0)
    expect(engine.verifyFailed.get('swarm/a')).toBe('sha-old')

    // A fix lands → the branch tip changes and the check now passes.
    verifyResults['swarm/a'] = { ok: true, tip: 'sha-new' }
    engine.lastIntegrateAt = 0
    await runIntegratePass(engine, deps)
    expect(deps.integrated).toEqual(['swarm/a']) // verified green at the NEW tip → landed
    expect(deps.moved).toEqual(['a'])
    expect(engine.verifyFailed.has('swarm/a')).toBe(false) // memo cleared
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

  it('names the conflicted files in the log so a human knows where to resolve', async () => {
    const engine = newEngine({ autoMerge: true })
    const deps = makeIntDeps({
      reviews: [reviewCard('a', 'swarm/a')],
      outcomes: { 'swarm/a': { status: 'conflict', files: ['src/x.ts', 'src/y.ts'] } },
      readiness: { 'swarm/a': 'rebase' },
    })
    await runIntegratePass(engine, deps)
    const line = engine.log.find((l) => l.kind === 'conflict')
    expect(line?.message).toContain('conflicts in: src/x.ts, src/y.ts')
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
  // markConflict (IntegrationDeps) — the union of the two recording fakes.
  const resolveDeps = (cards: ProjectTask[], over: Partial<Parameters<typeof makeDeps>[0]> = {}) => ({
    ...makeDeps({ cards, ...over }),
    ...makeIntDeps({ reviews: [] }),
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
})
