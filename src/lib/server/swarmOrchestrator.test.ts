import { describe, it, expect, beforeEach } from 'vitest'
import {
  ORCHESTRATOR_MAX_WORKERS,
  STALE_HEARTBEAT_MS,
  RECOVER_MAX_REQUEUE,
  isTodoCard,
  isReviewCard,
  sortTodos,
  selectDispatch,
  declaredFiles,
  contentKey,
  classifyWorker,
  detectAnomalies,
  recoveryColumn,
  runDispatchPass,
  runIntegratePass,
  runEnginePass,
  stopOrchestratorWorker,
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
}): OrchestratorDeps & {
  spawned: { taskId: string }[]
  moves: { taskId: string; branch: string }[]
  reviews: { taskId: string; branch: string }[]
  recovered: { taskId: string; column: 'todo' | 'blocked' }[]
  tornDown: { terminalId: string; worktree: string }[]
  board: Map<string, ProjectTask>
} => {
  const board = new Map<string, ProjectTask>(init.cards.map((c) => [c.id, { ...c }]))
  const dead = init.dead ?? new Set<string>()
  const spawnFails = init.spawnFails ?? new Set<string>()
  const moveFails = new Set(init.moveFails ?? [])
  const reviewFails = new Set(init.reviewFails ?? [])
  const recoverFails = new Set(init.recoverFails ?? [])
  const commits = init.commits ?? new Map<string, number>()
  const heartbeats = init.heartbeats ?? new Map<string, HeartbeatSign>()
  const spawned: { taskId: string }[] = []
  const moves: { taskId: string; branch: string }[] = []
  const reviews: { taskId: string; branch: string }[] = []
  const recovered: { taskId: string; column: 'todo' | 'blocked' }[] = []
  const tornDown: { terminalId: string; worktree: string }[] = []
  const idOf = (branch: string) => branch.replace(/^swarm\//, '')
  let n = 0
  return {
    spawned,
    moves,
    reviews,
    recovered,
    tornDown,
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
