import { describe, it, expect } from 'vitest'
import { runDispatchPass, __seedEngineForTests } from './swarmOrchestrator'
import type { ProjectTask, SpawnSwarmWorkerResponse } from '@/lib/types'

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
  ({ title: `card ${over.id}`, done: false, boardColumn: 'todo', ...over }) as ProjectTask

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
})
