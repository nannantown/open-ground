// @vitest-environment node
// SDK manager singleton, restart and legacy in-flight PTY adoption.

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
  onTerminalExit: vi.fn((_id: string, _onExit: () => void) => () => {}),
  getTerminalScreen: vi.fn((_id: string): string | null => null),
  isTerminalProcessAlive: vi.fn((_id: string) => true),
  resolveSwarmSession: vi.fn(),
  recordSwarmSession: vi.fn(async () => {}),
  forgetSwarmSessionIf: vi.fn(async () => false),
  installOgManageSkill: vi.fn(async () => ({ outcome: 'installed' as const, path: '/tmp/skill' })),
  resolveSwarmModelEffortProbed: vi.fn(),
  resolveSwarmRemoteName: vi.fn(async () => 'manager'),
  // Only the binary preflight is faked; the launch plan and SDK pool are real.
  sdkManagerPreflight: vi.fn(),
}))

// Pass-through EXCEPT launchClaude: the real module also exports pure helpers
// (buildAppContextPrompt) that the SDK launch plan legitimately uses. Replacing
// the whole module hid them, and the SDK race could not run at all.
vi.mock('./claudeTerminal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeTerminal')>()),
  launchClaude: mocks.launchClaude,
}))
vi.mock('./terminal', () => ({
  listLiveDesksIn: mocks.listLiveDesksIn,
  onTerminalExit: mocks.onTerminalExit,
  getTerminalScreen: mocks.getTerminalScreen,
  isTerminalProcessAlive: mocks.isTerminalProcessAlive,
}))
vi.mock('./swarmSessions', () => ({
  resolveSwarmSession: mocks.resolveSwarmSession,
  recordSwarmSession: mocks.recordSwarmSession,
  forgetSwarmSessionIf: mocks.forgetSwarmSessionIf,
}))
vi.mock('./ogManageSkill', () => ({ installOgManageSkill: mocks.installOgManageSkill }))
vi.mock('./swarmManagerSdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmManagerSdk')>()),
  sdkManagerPreflight: mocks.sdkManagerPreflight,
}))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: mocks.resolveSwarmModelEffortProbed,
  resolveSwarmRemoteName: mocks.resolveSwarmRemoteName,
}))

import { spawnSwarmManager, MANAGER_DESK_LABEL, DESK_SPAWN_LOCK_WAIT_MS } from './swarmManager'
import type { OwnerDeskTerminal } from './terminal'
import type { SdkPreflightResult } from './swarmWorkerSdk'
import {
  spawnSdkSession,
  listSdkSessions,
  terminateSdkSession,
  getSdkSession,
  __resetSdkSessionsForTests,
  __setDefaultQueryFnForTests,
} from './sdkSession'

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


let pool: OwnerDeskTerminal[] = []

/** A passing preflight, built from the REAL return type so a field added to it
 *  fails compilation here rather than throwing deep inside launchSdkDesk. */
const okPreflight = (): SdkPreflightResult => ({
  ok: true,
  claudeBin: '/bin/claude',
  cliVersion: '2.1.220',
  problems: [],
})

/** A live SDK desk that never produces a message — alive, and nothing else. */
const idle = () => ({
  async *[Symbol.asyncIterator]() {
    await new Promise(() => {})
    yield undefined
  },
})


const deskCount = (cwd = PROJ) =>
  listSdkSessions().filter((s) => s.role === 'manager' && resolve(s.cwd) === resolve(cwd) && !s.reaped).length

beforeEach(() => {
  vi.clearAllMocks()
  pool = []
  mocks.listLiveDesksIn.mockImplementation((cwd: string, label: string) =>
    pool.filter((d) => d.deskLabel === label && resolve(d.cwd) === resolve(cwd)),
  )
  mocks.isTerminalProcessAlive.mockReturnValue(true)
  mocks.launchClaude.mockImplementation(() => { throw new Error('Manager PTY launch is retired') })
  mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'sid-new', resume: false })
  mocks.resolveSwarmModelEffortProbed.mockResolvedValue({ model: 'opus', effort: 'max' })
  mocks.sdkManagerPreflight.mockReturnValue(okPreflight())
  __resetSdkSessionsForTests()
  __setDefaultQueryFnForTests(() => idle())
})

afterEach(() => {
  vi.useRealTimers()
  __setDefaultQueryFnForTests(null)
  __resetSdkSessionsForTests()
})

describe('spawn lock and legacy adoption', () => {
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
    expect(listSdkSessions()).toHaveLength(0)

    gate.resolve({ model: 'opus', effort: 'max' })
    const a = await first
    const b = await second

    expect(listSdkSessions()).toHaveLength(1)
    expect(a.reused).toBeUndefined() // it spawned
    expect(b).toEqual({
      terminalId: '',
      sdkSessionId: a.sdkSessionId,
      // Adoption reports the runtime of the desk it FOUND — the loser must not
      // be told 'pty' just because that is the default dial.
      runtime: 'sdk',
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
    expect(other.sdkSessionId).toBeTruthy()
    expect(other.reused).toBeUndefined()

    gate.resolve({ model: 'opus', effort: 'max' })
    await stuck
    expect(listSdkSessions()).toHaveLength(2) // one desk per project
  })

  it('the lock keys on the RESOLVED path — `/repo/alpha/` and `/repo/alpha` are one project', async () => {
    // listLiveDesksIn compares resolve()d cwds, so the lock must use the same
    // identity: a coarser or finer key would let two spellings of one project race.
    const [a, b] = await Promise.all([
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: `${PROJ}/` }),
    ])
    expect(listSdkSessions()).toHaveLength(1)
    expect(b.sdkSessionId).toBe(a.sdkSessionId)
  })

  it('`fresh:true` does NOT bypass the guard — it picks a conversation, not a second desk', async () => {
    const [a, b] = await Promise.all([
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: PROJ, fresh: true }),
    ])
    expect(listSdkSessions()).toHaveLength(1)
    expect(b.sdkSessionId).toBe(a.sdkSessionId)
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
    expect(listSdkSessions()).toHaveLength(1)
    expect(deskCount()).toBe(1)
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
      runtime: 'pty',
      agentSessionId: 'sid-live',
      resumed: false,
      reused: true,
    })
    // …and the record is repointed at the desk that actually exists (the write that
    // heals the desync presence reads as 'absent').
    expect(mocks.recordSwarmSession).toHaveBeenCalledWith(PROJ, 'manager', 'sid-live')
  })

  it('a pool entry the OS has already reaped is never adopted — a fresh desk spawns instead (MF3)', async () => {
    // The Restart race: killTerminal signals the process but `finishedAt` is
    // stamped by an asynchronous onExit, so for the narrow window before that
    // callback fires the pool can still list a desk the OS has already reaped.
    // isTerminalProcessAlive is the caller's confirmation against the process
    // table — without it, the owner's Restart button (DELETE then immediately
    // POST a respawn) can be answered with the very pane it just killed instead
    // of a working new one.
    pool.push({
      id: 'dead-but-listed',
      cwd: PROJ,
      agentSessionId: 'sid-dying',
      deskLabel: MANAGER_DESK_LABEL,
      startedAtMs: 1,
    })
    mocks.isTerminalProcessAlive.mockImplementation((id: string) => id !== 'dead-but-listed')

    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(deskCount()).toBe(1) // spawned fresh, did not adopt the corpse
    expect(r.terminalId).not.toBe('dead-but-listed')
    expect(r.reused).toBeUndefined()
  })
})


describe('spawnSwarmManager — waiting out a holder that never settles', () => {
  it('ADOPTS the desk when the wedged holder already launched one (never a twin)', async () => {
    // Wedge AFTER the launch: the holder's PTY is already in the pool and only the
    // trailing store write is stuck. The waiter must hand back THAT desk.
    const gate = deferred<void>()
    mocks.recordSwarmSession.mockImplementationOnce(() => gate.promise)

    const wedged = outcomeOf(spawnSwarmManager({ projectPath: PROJ }))
    await until(() => deskCount() === 1, 'the wedged holder to launch its desk')

    // Only NOW switch to fake timers: from here the waiter touches nothing but the
    // lock's own setTimeout and the (mocked) pool, so the 120s wait is instant.
    vi.useFakeTimers()
    const waiter = spawnSwarmManager({ projectPath: PROJ })
    await vi.advanceTimersByTimeAsync(DESK_SPAWN_LOCK_WAIT_MS + 1)

    const r = await waiter
    expect(r.reused).toBe(true)
    expect(r.sdkSessionId).toBe(listSdkSessions()[0].id)
    expect(listSdkSessions()).toHaveLength(1)

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
    expect(listSdkSessions()).toHaveLength(1)
  })
})


describe('one desk per project spans BOTH pools', () => {
  beforeEach(() => {
    __resetSdkSessionsForTests()
  })
  afterEach(() => {
    __resetSdkSessionsForTests()
  })

  /** Put a live SDK commander in the real pool without running any claude. */
  const seatSdkCommander = (cwd: string) =>
    spawnSdkSession({
      cwd,
      role: 'manager',
      agentSessionId: 'sid-sdk-desk',
      options: {},
      // A session that is simply ALIVE: it parks forever without producing a
      // message. The trailing yield is unreachable and only there because a generator
      // with no yield is not one.
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {})
          yield undefined
        },
      }),
    })

  it('an SDK commander is ADOPTED — nothing is launched, and the record is repointed', async () => {
    mocks.listLiveDesksIn.mockReturnValue([]) // no PTY desk anywhere
    const seated = seatSdkCommander(PROJ)

    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(mocks.launchClaude).not.toHaveBeenCalled()
    expect(r).toEqual({
      // The identity invariant, on the adoption path too: an SDK desk reports an
      // EMPTY terminalId and its own session id, never one standing in for the other.
      terminalId: '',
      runtime: 'sdk',
      sdkSessionId: seated.id,
      agentSessionId: 'sid-sdk-desk',
      resumed: false,
      reused: true,
    })
    expect(mocks.recordSwarmSession).toHaveBeenCalledWith(PROJ, 'manager', 'sid-sdk-desk')
  })

  it('an SDK commander in ANOTHER project does not block this one', async () => {
    mocks.listLiveDesksIn.mockReturnValue([])
    seatSdkCommander(resolve('/tmp/some-other-project'))
    await spawnSwarmManager({ projectPath: PROJ })
    expect(deskCount()).toBe(1)
  })

  it('an SDK WORKER in this project is not mistaken for a commander', async () => {
    mocks.listLiveDesksIn.mockReturnValue([])
    spawnSdkSession({
      cwd: PROJ,
      role: 'worker',
      agentSessionId: 'sid-worker',
      options: {},
      // A session that is simply ALIVE: it parks forever without producing a
      // message. The trailing yield is unreachable and only there because a generator
      // with no yield is not one.
      queryFn: () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise(() => {})
          yield undefined
        },
      }),
    })
    await spawnSwarmManager({ projectPath: PROJ })
    expect(deskCount()).toBe(1)
  })
})


describe('the critical section holds on the SDK runtime too', () => {

  it('TWO TRULY SIMULTANEOUS calls open ONE desk', async () => {
    const [a, b] = await Promise.all([
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: PROJ }),
    ])

    // The claim is about the POOL, because that is where a twin would live. A
    // test that only compared the two RESULTS would pass even if both callers
    // had spawned and one happened to report the other's id.
    expect(deskCount()).toBe(1)
    expect(a.runtime).toBe('sdk')
    expect(b.sdkSessionId).toBe(a.sdkSessionId)
    expect([a.reused === true, b.reused === true].filter(Boolean)).toHaveLength(1)
    // And no PTY commander was seated behind our back.
    expect(mocks.launchClaude).not.toHaveBeenCalled()
  })

  it('THREE simultaneous calls still open ONE desk', async () => {
    // The waiters that lose a wake-up must RE-TEST the pool, not fall through
    // and spawn. Three callers is the engine's reflex + the owner's button + a
    // retry, which is how the eleven-desk project actually accumulated.
    const rs = await Promise.all([
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: PROJ }),
    ])
    expect(deskCount()).toBe(1)
    expect(new Set(rs.map((r) => r.sdkSessionId)).size).toBe(1)
    expect(rs.filter((r) => r.reused === true)).toHaveLength(2)
  })

  it('a spawn in one project NEVER blocks another — the lock is per-project', async () => {
    const [a, b] = await Promise.all([
      spawnSwarmManager({ projectPath: PROJ }),
      spawnSwarmManager({ projectPath: OTHER }),
    ])
    expect(deskCount(PROJ)).toBe(1)
    expect(deskCount(OTHER)).toBe(1)
    expect(a.sdkSessionId).not.toBe(b.sdkSessionId)
    expect(a.reused).toBeFalsy()
    expect(b.reused).toBeFalsy()
  })

  it('a FAILED spawn releases the lock and does not poison the caller behind it', async () => {
    // The first call cannot seat a desk (preflight refuses ⇒ the SDK arm
    // THROWS — fail-fast since 2026-08-13, no PTY degrade). The second must
    // still be able to proceed — a lock left held by a failure is a project
    // that can never get a commander again.
    mocks.sdkManagerPreflight.mockReturnValueOnce({ ...okPreflight(), ok: false, problems: ['no claude'] })
    await expect(spawnSwarmManager({ projectPath: PROJ })).rejects.toThrow(/no claude/)
    // No desk of ANY runtime was seated by the failure.
    expect(deskCount()).toBe(0)

    const b = await spawnSwarmManager({ projectPath: PROJ }) // preflight passes again
    expect(b.runtime).toBe('sdk') // the lock was released and the desk seats
    expect(deskCount()).toBe(1)
  })

  it('a desk ASKED TO STOP is not reused — the respawn seats a working one (2026-08-04)', async () => {
    // ⚠ THIS TEST CHANGED SIDES, deliberately. It used to assert that a
    // terminated-but-unwinding desk is REUSED (`reused:true`), to keep a twin
    // from being seated into a conversation that is still running. But
    // `terminateSdkSession` sets `closed` at the same moment it flips the
    // status: the adopted desk refuses every `pushSdkInput`, the engine cannot
    // nudge it and it will never integrate again. So the old expectation was
    // pinning a DEAD END — the owner pressed Restart, got `reused:true`, and
    // nothing happened; on a wedged session (which never reaps, on purpose —
    // sweepClosedSessions refuses to force it) the commander could not be
    // brought back at all without restarting the app.
    //
    // The twin hazard is TWO LIVE commanders integrating one trunk. A closed
    // desk cannot be the second one, so the sharper rule is "a desk asked to
    // stop is not a slot" — and the sibling test below still pins the other
    // half (a genuinely live desk IS the slot, no twin). The PTY path has
    // always worked this way: Restart DELETEs and respawns immediately.
    const first = await spawnSwarmManager({ projectPath: PROJ })
    expect(first.runtime).toBe('sdk')
    terminateSdkSession(first.sdkSessionId as string)
    expect(getSdkSession(first.sdkSessionId as string)?.reaped).toBeUndefined() // asked, not gone

    const second = await spawnSwarmManager({ projectPath: PROJ })
    expect(second.sdkSessionId).not.toBe(first.sdkSessionId)
    expect(second.reused).toBeFalsy()
  })

  it('a LIVE desk is still the slot — the twin guard itself is unchanged', async () => {
    const first = await spawnSwarmManager({ projectPath: PROJ })
    expect(first.runtime).toBe('sdk')
    // No terminate: the desk is working. A second press must adopt it.
    const second = await spawnSwarmManager({ projectPath: PROJ })
    expect(deskCount()).toBe(1)
    expect(second.sdkSessionId).toBe(first.sdkSessionId)
    expect(second.reused).toBe(true)
  })

  it('…and once it has really gone, a fresh desk IS seated', async () => {
    // The other half of the guard: holding the slot past the desk's actual death
    // would mean a project whose commander died can never get another one
    // without restarting the app. `idle()` parks forever on purpose, so this
    // test needs a desk it can END — the pump only unwinds when the iterator
    // returns, which is the whole meaning of `reaped`.
    const control: { end?: () => void } = {}
    __setDefaultQueryFnForTests(() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((r) => {
          control.end = r
        })
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      },
    }))

    const first = await spawnSwarmManager({ projectPath: PROJ })
    const id = first.sdkSessionId as string
    expect(first.runtime).toBe('sdk')

    terminateSdkSession(id)
    control.end?.() // let the iterator return — now it is really gone
    await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true), { timeout: 5_000 })

    const second = await spawnSwarmManager({ projectPath: PROJ })
    expect(second.sdkSessionId).not.toBe(id)
    expect(second.reused).toBeFalsy()
    expect(deskCount()).toBe(1) // the dead one is not counted beside the new one
  })

})


describe('the SDK commander carries its conversation across a restart', () => {
  it('a RESUMED session reaches the launch plan (the desk keeps its memory)', async () => {
    mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'sid-old', resume: true })
    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(r.runtime).toBe('sdk')
    expect(r.agentSessionId).toBe('sid-old')
    // The pool session was built for that conversation, not a fresh one.
    expect(getSdkSession(r.sdkSessionId as string)?.agentSessionId).toBe('sid-old')
  })

  it('a FRESH session is not silently resumed', async () => {
    // The opposite error costs more than it looks: resuming a conversation the
    // caller asked to abandon is how `fresh:true` (the escape hatch for a
    // poisoned commander) stops being an escape hatch.
    mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'sid-new', resume: false })
    const r = await spawnSwarmManager({ projectPath: PROJ })

    expect(r.agentSessionId).toBe('sid-new')
    expect(getSdkSession(r.sdkSessionId as string)?.agentSessionId).toBe('sid-new')
  })

  it('the session id is RECORDED, so the next boot can find this conversation', async () => {
    // Without this write the desk resumes nothing after a restart — the memory
    // is only as good as the pointer that survives the process.
    mocks.resolveSwarmSession.mockResolvedValue({ agentSessionId: 'sid-rec', resume: false })
    await spawnSwarmManager({ projectPath: PROJ })
    expect(mocks.recordSwarmSession).toHaveBeenCalled()
    const args = mocks.recordSwarmSession.mock.calls.at(-1) as unknown[]
    expect(JSON.stringify(args)).toContain('sid-rec')
  })
})
