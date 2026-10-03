import { describe, it, expect } from 'vitest'
import { runDispatchPass, __seedEngineForTests } from './swarmOrchestrator'
import type { ProjectTask, SpawnSwarmWorkerResponse, SwarmFatalNotification } from '@/lib/types'

// THE ORPHANED COMMITS (measured 2026-08-04).
//
// A worker that hits a quota wall is reclaimed and its card goes back to 'todo'
// — with `card.branch` still on it, because the recover write only sets the
// column. The next dispatch used to mint a FRESH swarm/* branch, and the
// todo→doing move stamped that new name over `card.branch`. The commits already
// paid for were then reachable only through `git branch --list`: no card points
// at them, no worktree holds them, nothing tells the owner. The work is simply
// done again.
//
// Parking such a card instead would keep the commits but hand every quota wall
// to a human — which is most of them, and it changes what "unattended" means.
// So the card is still requeued; what changed is that dispatch RE-ENTERS the
// branch the card already carries.
//
// These drive `runDispatchPass` through injected deps, so they observe the
// dispatch DECISION (which worktree the spawn was asked for, and what the card's
// branch ends up as) rather than git.

const card = (over: Partial<ProjectTask> & { id: string }): ProjectTask =>
  // A COMPLETE card by default — dispatch gate ⑦ (hasCompletionConditions)
  // holds a card with an empty body, which is not what these tests are about.
  ({ title: `card ${over.id}`, notes: 'completion conditions', done: false, boardColumn: 'todo', ...over }) as ProjectTask

const engineLiteral = (path: string) =>
  ({
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
    notified: new Set(),
    pendingFatal: [],
  }) as never

/** Records what the dispatch asked for, and what the board ended up holding. */
const harness = (tasks: ProjectTask[], reusable: Record<string, string> = {}) => {
  const spawned: { worktree?: string }[] = []
  const branchStamps: { id: string; branch: string }[] = []
  const board = new Map(tasks.map((t) => [t.id, { ...t }]))
  const deps = {
    fetchTasks: async () => Array.from(board.values()),
    resolveReusableWork: async (_p: string, c: ProjectTask) => {
      const wt = typeof c.branch === 'string' ? reusable[c.branch] : undefined
      return wt ? { worktree: wt, branch: c.branch as string } : null
    },
    spawnWorker: async (opts: { worktree?: string }): Promise<SpawnSwarmWorkerResponse> => {
      spawned.push({ worktree: opts.worktree })
      // A real spawn reports the branch of the worktree it used: re-entry keeps
      // the old name, a fresh dispatch mints a new one.
      const branch = opts.worktree ? 'swarm/existing' : 'swarm/fresh-1'
      return {
        terminalId: `pty-${spawned.length}`,
        agentSessionId: 's',
        worktree: opts.worktree ?? '/wt/fresh',
        branch,
      } as SpawnSwarmWorkerResponse
    },
    moveToDoing: async (_p: string, id: string, branch: string) => {
      branchStamps.push({ id, branch })
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
  return { deps, spawned, branchStamps, board }
}

describe('quota re-entry — a requeued card goes back to its own work', () => {
  it('THE FIX: a todo card that already has a branch is CONTINUED, not restarted', async () => {
    const engine = engineLiteral('/proj-reentry')
    __seedEngineForTests(engine)
    const h = harness([card({ id: 'a', branch: 'swarm/existing' })], {
      'swarm/existing': '/wt/existing',
    })

    await runDispatchPass(engine, h.deps)

    // The spawn was pointed at the existing work…
    expect(h.spawned).toEqual([{ worktree: '/wt/existing' }])
    // …so the todo→doing stamp writes back the SAME branch instead of a new one.
    expect(h.branchStamps).toEqual([{ id: 'a', branch: 'swarm/existing' }])
    expect(h.board.get('a')?.branch).toBe('swarm/existing')
  })

  it('a card with NO branch dispatches fresh, exactly as before', async () => {
    const engine = engineLiteral('/proj-fresh')
    __seedEngineForTests(engine)
    const h = harness([card({ id: 'a' })])

    await runDispatchPass(engine, h.deps)

    expect(h.spawned).toEqual([{ worktree: undefined }])
    expect(h.branchStamps).toEqual([{ id: 'a', branch: 'swarm/fresh-1' }])
  })

  it('a branch that cannot be re-entered falls back to a fresh dispatch', async () => {
    // The branch was deleted, or git refused. Never worse than the old
    // behaviour: the card still gets a worker.
    const engine = engineLiteral('/proj-gone')
    __seedEngineForTests(engine)
    const h = harness([card({ id: 'a', branch: 'swarm/gone' })], {}) // nothing resolvable

    await runDispatchPass(engine, h.deps)

    expect(h.spawned).toEqual([{ worktree: undefined }])
    expect(h.board.get('a')?.boardColumn).toBe('doing')
  })

  // 2026-10-03 (card d84bec79): the fresh fallback above is only safe when the
  // branch holds nothing. With commits on it, a fresh dispatch orphans them.
  it('a branch WITH commits that cannot be re-entered is never replaced by a fresh one', async () => {
    const engine = engineLiteral('/proj-unreenterable')
    __seedEngineForTests(engine)
    const parked: string[] = []
    const h = harness([card({ id: 'a', branch: 'swarm/has-work' })], {})
    const deps = {
      ...(h.deps as object),
      countCommitsAhead: async () => 4,
      recoverCard: async (_p: string, id: string, column: 'todo' | 'blocked') => {
        parked.push(`${id}:${column}`)
        h.board.set(id, { ...h.board.get(id)!, boardColumn: column })
        return true
      },
    } as never

    await runDispatchPass(engine, deps)
    await runDispatchPass(engine, deps)
    // Two passes: still todo, still its own branch, nothing spawned — retried, not replaced.
    expect(h.spawned).toEqual([])
    expect(h.branchStamps).toEqual([])
    expect(h.board.get('a')).toMatchObject({ boardColumn: 'todo', branch: 'swarm/has-work' })

    await runDispatchPass(engine, deps)
    // Third: parked for a human, the branch still untouched.
    expect(h.spawned).toEqual([])
    expect(parked).toEqual(['a:blocked'])
    expect(h.board.get('a')).toMatchObject({ boardColumn: 'blocked', branch: 'swarm/has-work' })
  })

  it('the park rings the bell with the branch holding the work and the way out', async () => {
    const engine = engineLiteral('/proj-park-bell')
    __seedEngineForTests(engine)
    const bells: SwarmFatalNotification[] = []
    const h = harness([card({ id: 'a', branch: 'swarm/has-work' })], {})
    const deps = {
      ...(h.deps as object),
      countCommitsAhead: async () => 4,
      notify: (n: SwarmFatalNotification) => bells.push(n),
    } as never

    await runDispatchPass(engine, deps)
    await runDispatchPass(engine, deps)
    expect(bells).toEqual([]) // retries are quiet
    await runDispatchPass(engine, deps)

    expect(bells).toHaveLength(1)
    expect(bells[0]).toMatchObject({ event: 'reentry-failed', taskId: 'a', branch: 'swarm/has-work' })
    expect(bells[0].detail).toContain('保留') // plain words for the owner…
    expect(bells[0].detail).not.toMatch(/branch|ブランチ|\.git|swarm\//)
    expect(bells[0].logHint).toContain('社長に') // the owner talks to the president only
    expect(bells[0].logHint).toContain('swarm/has-work') // …the technical way out after
    expect(bells[0].logHint).toContain('card.branch を外して')
    expect(bells[0].logHint).toContain('フォルダ')
  })

  // `picks` is a snapshot taken before the reservation; re-entry must read the
  // card off the FRESH re-read. Here the snapshot has no branch yet, the board does.
  it('re-entry reads the branch off the fresh board read, not the pick snapshot', async () => {
    const engine = engineLiteral('/proj-fresh-read')
    __seedEngineForTests(engine)
    const h = harness([card({ id: 'a', branch: 'swarm/has-work' })], {})
    let reads = 0
    const deps = {
      ...(h.deps as object),
      countCommitsAhead: async () => 4,
      fetchTasks: async () =>
        ++reads === 1
          ? Array.from(h.board.values()).map((t) => ({ ...t, branch: undefined }))
          : Array.from(h.board.values()),
    } as never

    await runDispatchPass(engine, deps)

    // A read off the snapshot sees no branch and mints a fresh one over 4 commits.
    expect(h.spawned).toEqual([])
    expect(h.board.get('a')).toMatchObject({ boardColumn: 'todo', branch: 'swarm/has-work' })
  })

  it('…and the resolver is handed the fresh card, so it re-enters the worktree', async () => {
    const engine = engineLiteral('/proj-fresh-resolve')
    __seedEngineForTests(engine)
    const h = harness([card({ id: 'a', branch: 'swarm/existing' })], { 'swarm/existing': '/wt/existing' })
    let reads = 0
    const deps = {
      ...(h.deps as object),
      fetchTasks: async () =>
        ++reads === 1
          ? Array.from(h.board.values()).map((t) => ({ ...t, branch: undefined }))
          : Array.from(h.board.values()),
    } as never

    await runDispatchPass(engine, deps)

    expect(h.spawned).toEqual([{ worktree: '/wt/existing' }])
  })

  it('a branch git reports GONE (deleted) still dispatches fresh', async () => {
    const engine = engineLiteral('/proj-deleted')
    __seedEngineForTests(engine)
    const h = harness([card({ id: 'a', branch: 'swarm/deleted' })], {})
    const deps = { ...(h.deps as object), countCommitsAhead: async () => null, branchExists: async () => false } as never

    await runDispatchPass(engine, deps)

    expect(h.spawned).toEqual([{ worktree: undefined }])
  })

  it('an UNREADABLE count (git hiccup) is held, not read as "nothing there"', async () => {
    const engine = engineLiteral('/proj-hiccup')
    __seedEngineForTests(engine)
    const h = harness([card({ id: 'a', branch: 'swarm/has-work' })], {})
    const deps = { ...(h.deps as object), countCommitsAhead: async () => null, branchExists: async () => null } as never

    await runDispatchPass(engine, deps)

    expect(h.spawned).toEqual([])
    expect(h.board.get('a')).toMatchObject({ boardColumn: 'todo', branch: 'swarm/has-work' })
  })

  it('a card that left todo between failures starts its count over', async () => {
    const engine = engineLiteral('/proj-count-reset')
    __seedEngineForTests(engine)
    const parked: string[] = []
    const h = harness([card({ id: 'a', branch: 'swarm/has-work' })], {})
    const deps = {
      ...(h.deps as object),
      countCommitsAhead: async () => 2,
      recoverCard: async (_p: string, id: string, column: string) => (parked.push(`${id}:${column}`), true),
    } as never

    await runDispatchPass(engine, deps)
    await runDispatchPass(engine, deps) // 2 failures
    h.board.set('a', { ...h.board.get('a')!, boardColumn: 'blocked' }) // the owner moves it away…
    await runDispatchPass(engine, deps)
    h.board.set('a', { ...h.board.get('a')!, boardColumn: 'todo' }) // …and back
    await runDispatchPass(engine, deps)

    expect(parked).toEqual([]) // one fresh failure, not the third of the old run
  })
})

// THE STALE READY (measured 2026-10-02, twice). A 保留 card answered 「やり直す」
// goes back to todo with its branch, and re-entry (above) puts the new worker on
// that branch — where the PREVIOUS worker's heartbeat still says ready:true and its
// commits are still ahead. The engine read both as "done" and promoted the card to
// review 3 seconds after dispatch (journal: dispatch 10:40:57 → promoted 10:41:00),
// before the new worker had touched anything.
describe('re-entry — the previous worker’s ready is not this worker’s', () => {
  const OLD = '2026-10-02T09:00:00.000Z' // long before any dispatch in this test

  const monitorHarness = (opts: { alive?: boolean }) => {
    const h = harness([card({ id: 'a', branch: 'swarm/existing' })], { 'swarm/existing': '/wt/existing' })
    const promoted: string[] = []
    let hb: { ready: boolean; blocked: boolean; at?: string } | null = { ready: true, blocked: false, at: OLD }
    const deps = {
      ...(h.deps as object),
      countCommitsAhead: async () => 3, // the previous worker's commits
      readHeartbeat: async () => hb,
      isAlive: () => opts.alive ?? true,
      moveToReview: async (_p: string, id: string) => {
        promoted.push(id)
        const c = h.board.get(id)
        if (c) h.board.set(id, { ...c, boardColumn: 'review' })
        return true
      },
      recoverCard: async (_p: string, id: string, column: 'todo' | 'blocked') => {
        const c = h.board.get(id)
        if (c) h.board.set(id, { ...c, boardColumn: column })
        return true
      },
    } as never
    return { ...h, deps, promoted, setHeartbeat: (v: typeof hb) => (hb = v) }
  }

  it('THE FIX: a re-entered worker is NOT promoted on the stale ready + old commits', async () => {
    const engine = engineLiteral('/proj-stale-ready')
    __seedEngineForTests(engine)
    const h = monitorHarness({})

    await runDispatchPass(engine, h.deps) // dispatch onto swarm/existing
    expect(h.board.get('a')?.boardColumn).toBe('doing')
    await runDispatchPass(engine, h.deps) // monitor: reads the OLD heartbeat

    expect(h.promoted).toEqual([])
    expect(h.board.get('a')?.boardColumn).toBe('doing')
  })

  it('…and IS promoted once the new worker beats ready after its dispatch', async () => {
    const engine = engineLiteral('/proj-fresh-ready')
    __seedEngineForTests(engine)
    const h = monitorHarness({})

    await runDispatchPass(engine, h.deps)
    await runDispatchPass(engine, h.deps)
    expect(h.promoted).toEqual([])

    h.setHeartbeat({ ready: true, blocked: false, at: new Date(Date.now() + 1000).toISOString() })
    await runDispatchPass(engine, h.deps)
    expect(h.promoted).toEqual(['a'])
  })

  it('a re-entered worker that dies before its own ready is not promoted on old commits', async () => {
    const engine = engineLiteral('/proj-dead-reentry')
    __seedEngineForTests(engine)
    const h = monitorHarness({ alive: false })
    h.setHeartbeat(null) // no heartbeat at all: the dead+commits path is the only door

    await runDispatchPass(engine, h.deps)
    await runDispatchPass(engine, h.deps)

    expect(h.promoted).toEqual([])
    // …and it is not left in doing forever: recoverLost parks it with the old work kept.
    expect(h.board.get('a')?.boardColumn).toBe('blocked')
  })

  it('NORMAL PATH UNCHANGED: a first dispatch with ready + commits is promoted', async () => {
    const engine = engineLiteral('/proj-first')
    __seedEngineForTests(engine)
    const h = monitorHarness({})
    h.board.set('a', { ...h.board.get('a')!, branch: undefined }) // no branch ⇒ fresh dispatch

    await runDispatchPass(engine, h.deps)
    await runDispatchPass(engine, h.deps) // OLD-dated heartbeat is fine: nothing to confuse it with

    expect(h.spawned).toEqual([{ worktree: undefined }])
    expect(h.promoted).toEqual(['a'])
  })
})
