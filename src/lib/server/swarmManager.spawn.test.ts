// @vitest-environment node
//
// spawnSwarmManager's SINGLETON GUARD under CONCURRENCY — the check-then-act window.
//
// swarmManager.test.ts pins the pure launch contract and
// swarmSessions.integration.test.ts drives the SEQUENTIAL guard through real PTYs
// (spawn, then spawn again → `reused:true`). Neither can reach the case this file
// exists for: two callers inside the SAME check-then-act window.
//
// The window is real and its two callers are independent BY CONSTRUCTION — the
// engine's resuscitation reflex (swarmOrchestrator, on its own timer) and the
// owner's 司令官 button (POST /api/swarm/manager) — running in ONE Node process.
// Between `listLiveDesksIn` (the check) and `launchClaude` (the act) sit four
// awaits, the tier probe alone spending seconds; both callers read "no desk" and
// both spawn. That is the 2026-07-19 eleven-desk incident's shape (two desks
// integrating one trunk = the 2026-07-15 concurrent-integration hazard), minus the
// five-minute spacing that made the pool read alone sufficient.
//
// Everything with a side effect is mocked, so no PTY is spawned, no `claude` runs,
// and nothing is written outside the suite's tmp home:
//   • launchClaude          — would spawn a real PTY. The mock REGISTERS the desk in
//                             a fake pool, so listLiveDesksIn behaves like the real
//                             one: a desk exists exactly once its launch happened.
//   • listLiveDesksIn       — reads that fake pool, filtering by (cwd, deskLabel)
//                             the way the real one does (resolve()-compared cwd).
//   • installOgManageSkill  — writes into ~/.claude/skills/ (HOME-anchored, which
//                             the suite does NOT isolate). Mocked, never run.
//   • resolveSwarmModelEffortProbed — the slow step: it may spawn headless probe
//                             children. Mocked, and its GATE is what holds the
//                             critical section open long enough to race into.
//   • resolveSwarmSession / recordSwarmSession — store reads/writes.
// `./store` is deliberately NOT mocked: getExecutionMode/getAllowedModelTiers are
// plain reads against the suite's isolated OPENGROUND_HOME, and their values are
// irrelevant here because the resolver that consumes them is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'

// The suite's default 5s per-test timeout is too tight for a file whose tests
// deliberately hold a critical section open while other calls queue behind it
// (measured house-wide 2026-07-20: pure-I/O tests stretch 14–20× under a loaded
// 3-way vitest split). Same guard the sibling swarm tests carry.
vi.setConfig({ testTimeout: 60_000 })

const mocks = vi.hoisted(() => ({
  launchClaude: vi.fn(),
  listLiveDesksIn: vi.fn(),
  onTerminalExit: vi.fn(() => () => {}),
  getTerminalScreen: vi.fn(() => null),
  resolveSwarmSession: vi.fn(),
  recordSwarmSession: vi.fn(async () => {}),
  installOgManageSkill: vi.fn(async () => ({ outcome: 'installed' as const, path: '/tmp/skill' })),
  resolveSwarmModelEffortProbed: vi.fn(),
  resolveSwarmRemoteName: vi.fn(async () => 'manager'),
}))

vi.mock('./claudeTerminal', () => ({ launchClaude: mocks.launchClaude }))
vi.mock('./terminal', () => ({
  listLiveDesksIn: mocks.listLiveDesksIn,
  onTerminalExit: mocks.onTerminalExit,
  getTerminalScreen: mocks.getTerminalScreen,
}))
vi.mock('./swarmSessions', () => ({
  resolveSwarmSession: mocks.resolveSwarmSession,
  recordSwarmSession: mocks.recordSwarmSession,
}))
vi.mock('./ogManageSkill', () => ({ installOgManageSkill: mocks.installOgManageSkill }))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: mocks.resolveSwarmModelEffortProbed,
  resolveSwarmRemoteName: mocks.resolveSwarmRemoteName,
}))

import { spawnSwarmManager, MANAGER_DESK_LABEL, DESK_SPAWN_LOCK_WAIT_MS } from './swarmManager'
import type { OwnerDeskTerminal } from './terminal'

const PROJ = '/repo/alpha'
const OTHER = '/repo/beta'

/** A promise plus its resolver — the gate a test holds the critical section on. */
const deferred = <T>() => {
  let resolveIt!: (v: T) => void
  let rejectIt!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolveIt = res
    rejectIt = rej
  })
  // Mark it handled up front: a gate can be rejected before the code under test has
  // reached its `await`, and vitest reports that momentary gap as a run-level
  // unhandled rejection. Real consumers still see the rejection.
  promise.catch(() => {})
  return { promise, resolve: resolveIt, reject: rejectIt }
}

/** Let the microtask queue drain so every started call has run up to its first
 *  await (i.e. everyone is parked exactly where the race would happen). */
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Wait — on REAL timers — until `pred` holds. The spawn path still awaits genuine
 *  fs reads (`./store` is deliberately unmocked), which resolve on macrotasks, so a
 *  microtask drain alone cannot carry a call all the way to its gate. */
const until = async (pred: () => boolean, what: string) => {
  // 10s of headroom (it exits the instant `pred` holds): the suite's own measured
  // worst case is a 3-way vitest split stretching pure-I/O steps 14–20×, and a cap
  // that only just fits on an idle box is how a load-dependent flake is born.
  for (let i = 0; i < 2000; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** True once some call has reached the gated tier resolver — the last await before
 *  `launchClaude`, so the caller is demonstrably INSIDE the critical section. */
const atTheGate = () => mocks.resolveSwarmModelEffortProbed.mock.calls.length > 0

/** Run a call to completion and hand back its VALUE OR ERROR — attached
 *  synchronously, so a rejection is never momentarily unhandled (vitest reports
 *  those as run-level errors even when the assertion later passes). */
const outcomeOf = <T>(p: Promise<T>): Promise<T | Error> =>
  p.then(
    (v) => v,
    (e) => (e instanceof Error ? e : new Error(String(e))),
  )

/** The fake PTY pool: launchClaude adds to it, listLiveDesksIn reads it. */
let pool: OwnerDeskTerminal[] = []
let launchN = 0

beforeEach(() => {
  vi.clearAllMocks()
  pool = []
  launchN = 0

  mocks.listLiveDesksIn.mockImplementation((cwd: string, label: string) =>
    pool.filter((d) => d.deskLabel === label && resolve(d.cwd) === resolve(cwd)),
  )
  mocks.launchClaude.mockImplementation((o: { cwd: string; agentSessionId: string }) => {
    const id = `term-${++launchN}`
    pool.push({
      id,
      cwd: o.cwd,
      agentSessionId: o.agentSessionId,
      deskLabel: MANAGER_DESK_LABEL,
      startedAtMs: 1,
    })
    return { terminalId: id }
  })
  mocks.resolveSwarmSession.mockImplementation(async (_p: string) => ({
    agentSessionId: `sid-${launchN + 1}`,
    resume: false,
  }))
  mocks.resolveSwarmModelEffortProbed.mockResolvedValue({ model: 'opus', effort: 'max' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('spawnSwarmManager — the check-then-act is a critical section (one desk per project)', () => {
  it('TWO TRULY SIMULTANEOUS calls open ONE desk — the second is handed the first (reused)', async () => {
    // The bare race, with no test-only choreography: both calls are started in the
    // same tick, exactly as the engine's reflex and the owner's button can land.
    // Every mocked await yields the microtask queue, so without a lock the second
    // caller's `listLiveDesksIn` runs BEFORE the first caller's `launchClaude` —
    // both read "no desk" and both spawn (verified by removing the lock: two
    // launches, two terminal ids).
    const [a, b] = await Promise.all([
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: PROJ }),
    ])

    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    expect(pool).toHaveLength(1)
    expect(b.terminalId).toBe(a.terminalId)
    // Exactly one caller spawned; the other adopted the desk that now exists.
    expect([a.reused === true, b.reused === true].filter(Boolean)).toHaveLength(1)
  })

  it('THREE simultaneous calls still open ONE desk (the loser of a wake-up re-tests, never spawns)', async () => {
    // Several waiters wake together when the holder releases; only one can win the
    // compare-and-set, and the others must re-test the POOL rather than fall
    // through. Three callers is the engine reflex + the owner's button + a retry.
    const all = await Promise.all([
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: PROJ }),
    ])

    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    expect(new Set(all.map((r) => r.terminalId)).size).toBe(1)
    expect(all.filter((r) => r.reused === true)).toHaveLength(2)
  })

  it('the SECOND caller answers from the POOL, not from the first caller’s result', async () => {
    // Serialised, not coalesced: the follower re-runs the check and reports what it
    // FINDS (reused:true naming the live desk), which is also why it reconciles the
    // session record onto that desk — the write that stops presence reading 'absent'.
    const gate = deferred<{ model: string; effort: 'max' }>()
    mocks.resolveSwarmModelEffortProbed.mockReturnValueOnce(gate.promise)

    const first = spawnSwarmManager({ projectPath: PROJ })
    await until(() => atTheGate(), 'the first caller to reach its gate')
    const second = spawnSwarmManager({ projectPath: PROJ })
    await settle()

    // The follower is parked on the lock — it has NOT launched anything yet, even
    // though the holder is demonstrably deep inside the critical section.
    expect(mocks.launchClaude).not.toHaveBeenCalled()

    gate.resolve({ model: 'opus', effort: 'max' })
    const a = await first
    const b = await second

    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    expect(a.reused).toBeUndefined() // it spawned
    expect(b).toEqual({
      terminalId: a.terminalId,
      agentSessionId: a.agentSessionId,
      resumed: false,
      reused: true,
    })
    expect(mocks.recordSwarmSession).toHaveBeenCalledWith(PROJ, 'manager', a.agentSessionId)
  })

  it('a spawn in one project NEVER blocks another project (the lock is per-project)', async () => {
    // Keying the lock on the project is what keeps this from becoming a global
    // serialisation point: an owner with a slow tier probe in one repo must still be
    // able to open a commander in another.
    const gate = deferred<{ model: string; effort: 'max' }>()
    mocks.resolveSwarmModelEffortProbed.mockReturnValueOnce(gate.promise)

    const stuck = spawnSwarmManager({ projectPath: PROJ })
    // Wait until PROJ actually holds the gate before starting OTHER — otherwise the
    // one-shot gate could be consumed by whichever call reaches the resolver first.
    await until(() => atTheGate(), 'the PROJ spawn to reach its gate')
    // PROJ is mid-spawn and parked. OTHER must complete on its own.
    const other = await spawnSwarmManager({ projectPath: OTHER })
    expect(other.terminalId).toBeTruthy()
    expect(other.reused).toBeUndefined()

    gate.resolve({ model: 'opus', effort: 'max' })
    await stuck
    expect(mocks.launchClaude).toHaveBeenCalledTimes(2) // one desk per project
  })

  it('the lock keys on the RESOLVED path — `/repo/alpha/` and `/repo/alpha` are one project', async () => {
    // listLiveDesksIn compares resolve()d cwds, so the lock must use the same
    // identity: a coarser or finer key would let two spellings of one project race.
    const [a, b] = await Promise.all([
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: `${PROJ}/` }),
    ])
    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    expect(b.terminalId).toBe(a.terminalId)
  })

  it('`fresh:true` does NOT bypass the guard — it picks a conversation, not a second desk', async () => {
    const [a, b] = await Promise.all([
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: PROJ, fresh: true }),
    ])
    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    expect(b.terminalId).toBe(a.terminalId)
  })

  it('a FAILED spawn releases the lock and does not poison the caller behind it', async () => {
    // The release lives in a `finally`, so a throw (NoAllowedModelTierError, a dead
    // `claude`, a store fault) can never wedge the project's commander button. And
    // because the follower re-runs the check instead of inheriting the leader's
    // promise, the leader's failure is not contagious: the follower spawns.
    const gate = deferred<{ model: string; effort: 'max' }>()
    mocks.resolveSwarmModelEffortProbed.mockReturnValueOnce(gate.promise)

    const failing = outcomeOf(spawnSwarmManager({ projectPath: PROJ }))
    await until(() => atTheGate(), 'the doomed caller to reach its gate')
    const behind = spawnSwarmManager({ projectPath: PROJ })
    await settle()

    gate.reject(new Error('every tier is cooling'))
    expect(await failing).toMatchObject({ message: 'every tier is cooling' })

    const ok = await behind
    expect(ok.reused).toBeUndefined() // it really spawned — not a twin, there was none
    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    expect(pool).toHaveLength(1)
  })

  it('the pre-existing SEQUENTIAL guard is unchanged: a live desk is reused, nothing launches', async () => {
    pool.push({
      id: 'already-here',
      cwd: PROJ,
      agentSessionId: 'sid-live',
      deskLabel: MANAGER_DESK_LABEL,
      startedAtMs: 1,
    })
    const r = await spawnSwarmManager({ projectPath: PROJ })
    expect(mocks.launchClaude).not.toHaveBeenCalled()
    expect(r).toEqual({
      terminalId: 'already-here',
      agentSessionId: 'sid-live',
      resumed: false,
      reused: true,
    })
    // …and the record is repointed at the desk that actually exists (the write that
    // heals the desync presence reads as 'absent').
    expect(mocks.recordSwarmSession).toHaveBeenCalledWith(PROJ, 'manager', 'sid-live')
  })
})

describe('spawnSwarmManager — waiting out a holder that never settles', () => {
  it('ADOPTS the desk when the wedged holder already launched one (never a twin)', async () => {
    // Wedge AFTER the launch: the holder's PTY is already in the pool and only the
    // trailing store write is stuck. The waiter must hand back THAT desk.
    const gate = deferred<void>()
    mocks.recordSwarmSession.mockImplementationOnce(() => gate.promise)

    const wedged = outcomeOf(spawnSwarmManager({ projectPath: PROJ }))
    await until(() => pool.length === 1, 'the wedged holder to launch its desk')

    // Only NOW switch to fake timers: from here the waiter touches nothing but the
    // lock's own setTimeout and the (mocked) pool, so the 120s wait is instant.
    vi.useFakeTimers()
    const waiter = spawnSwarmManager({ projectPath: PROJ })
    await vi.advanceTimersByTimeAsync(DESK_SPAWN_LOCK_WAIT_MS + 1)

    const r = await waiter
    expect(r.reused).toBe(true)
    expect(r.terminalId).toBe('term-1')
    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)

    vi.useRealTimers()
    gate.resolve()
    await wedged
  })

  it('REFUSES rather than opening a second desk when no desk exists yet', async () => {
    const gate = deferred<{ model: string; effort: 'max' }>()
    mocks.resolveSwarmModelEffortProbed.mockReturnValueOnce(gate.promise)

    const wedged = outcomeOf(spawnSwarmManager({ projectPath: PROJ }))
    await until(() => atTheGate(), 'the holder to reach its gate')
    expect(mocks.launchClaude).not.toHaveBeenCalled() // wedged BEFORE the launch

    vi.useFakeTimers()
    const waiter = outcomeOf(spawnSwarmManager({ projectPath: PROJ }))
    await vi.advanceTimersByTimeAsync(DESK_SPAWN_LOCK_WAIT_MS + 1)

    expect(await waiter).toMatchObject({ message: expect.stringMatching(/already in flight/) })
    // The whole point: giving up on the lock must NOT fall through into a spawn.
    // (The engine's wakeManager reads the throw as "retry next pass".)
    expect(mocks.launchClaude).not.toHaveBeenCalled()

    vi.useRealTimers()
    gate.resolve({ model: 'opus', effort: 'max' })
    await wedged
    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
  })
})
