// @vitest-environment node
//
// spawnSwarmSupply's SINGLETON GUARD — the one this desk went without.
//
// UNTIL 2026-08-15 THERE WAS NO GUARD AT ALL. The only thing between the owner
// and two 補給官 PTYs was a client-side `if (supply || supplyBusy) return` in the
// Swarm tab, which is one window's opinion, not an invariant. The Board's
// front-desk seat is a SECOND door onto the same desk, so this file exists
// before that seat does.
//
// WHY A SECOND DESK IS NOT MERELY WASTEFUL. `resolveSwarmSession` refuses to
// resume a conversation it can see is still open, so the second spawn mints a
// FRESH session id and `recordSwarmSession` OVERWRITES the project's single
// stored slot with it. The first desk's days-long conversation is not skipped —
// it is FORGOTTEN, while its PTY keeps running, keeps holding the identifiable
// Remote Control name, and keeps filing Board cards its twin cannot see it
// filing (the /supply dedupe rule is "re-read the Board before filing", which
// cannot see a sibling's UN-filed intent).
//
// Everything with a side effect is mocked, so no PTY is spawned and no `claude`
// runs. The mock of `launchClaude` REGISTERS the desk in a fake pool that
// `listLiveDesksIn` then reads, so the pool behaves like the real one: a desk
// exists exactly once its launch happened. `resolveSwarmModelEffortProbed` is
// the GATE — in production it is the slow step (a tier-ladder walk, seconds per
// rung) and here it is what holds the critical section open long enough to race
// into. `./store` is deliberately NOT mocked (plain reads against the suite's
// isolated OPENGROUND_HOME).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolve } from 'path'

// Same reason as swarmManager.spawn.test.ts: this file deliberately holds a
// critical section open while other calls queue behind it, and pure-I/O steps
// measured 14–20× slower under a loaded 3-way vitest split.
vi.setConfig({ testTimeout: 60_000 })

const mocks = vi.hoisted(() => ({
  launchClaude: vi.fn(),
  listLiveDesksIn: vi.fn(),
  killTerminal: vi.fn(),
  isTerminalProcessAlive: vi.fn((_id: string) => true),
  resolveSwarmSession: vi.fn(),
  recordSwarmSession: vi.fn(async () => {}),
  resolveSwarmModelEffortProbed: vi.fn(),
  resolveSwarmRemoteName: vi.fn(async () => 'supply'),
}))

// Pass-through EXCEPT launchClaude: the real module also exports pure helpers
// the launch options legitimately use.
vi.mock('./claudeTerminal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeTerminal')>()),
  launchClaude: mocks.launchClaude,
}))
vi.mock('./terminal', () => ({
  listLiveDesksIn: mocks.listLiveDesksIn,
  killTerminal: mocks.killTerminal,
  isTerminalProcessAlive: mocks.isTerminalProcessAlive,
}))
vi.mock('./swarmSessions', () => ({
  resolveSwarmSession: mocks.resolveSwarmSession,
  recordSwarmSession: mocks.recordSwarmSession,
}))
vi.mock('./swarmLaunch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./swarmLaunch')>()),
  resolveSwarmModelEffortProbed: mocks.resolveSwarmModelEffortProbed,
  resolveSwarmRemoteName: mocks.resolveSwarmRemoteName,
}))

import { spawnSwarmSupply, SUPPLY_DESK_LABEL } from './swarmSupply'
import { DESK_SPAWN_LOCK_WAIT_MS } from './deskSpawnLock'
import type { OwnerDeskTerminal } from './terminal'

const PROJ = '/repo/alpha'
const OTHER = '/repo/beta'

/** A promise plus its resolver — the gate a test holds the critical section on. */
const deferred = <T>() => {
  let resolveIt!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolveIt = res
  })
  return { promise, resolve: resolveIt }
}

/** Wait — on REAL timers — until `pred` holds. The spawn path still awaits genuine
 *  fs reads (`./store` is deliberately unmocked), which resolve on macrotasks, so a
 *  microtask drain alone cannot carry a call all the way to its gate. */
const until = async (pred: () => boolean, what: string) => {
  for (let i = 0; i < 2000; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** Let the microtask queue drain so every started call has run up to its first
 *  await (i.e. everyone is parked exactly where the race would happen). */
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

/** The fake PTY pool: launchClaude adds to it, listLiveDesksIn reads it. */
let pool: OwnerDeskTerminal[] = []
let launchN = 0
/** Ids the fake process table says are GONE (a killed PTY whose async onExit
 *  has not fired yet — the window the re-confirmation exists for). */
let deadIds = new Set<string>()

beforeEach(() => {
  vi.clearAllMocks()
  pool = []
  launchN = 0
  deadIds = new Set()

  mocks.listLiveDesksIn.mockImplementation((cwd: string, label: string) =>
    pool.filter((d) => d.deskLabel === label && resolve(d.cwd) === resolve(cwd)),
  )
  mocks.isTerminalProcessAlive.mockImplementation((id: string) => !deadIds.has(id))
  mocks.launchClaude.mockImplementation((o: { cwd: string; agentSessionId: string }) => {
    const id = `term-${++launchN}`
    pool.push({
      id,
      cwd: o.cwd,
      agentSessionId: o.agentSessionId,
      deskLabel: SUPPLY_DESK_LABEL,
      startedAtMs: launchN,
    })
    return { terminalId: id }
  })
  mocks.resolveSwarmSession.mockImplementation(async () => ({
    agentSessionId: `sid-${launchN + 1}`,
    resume: false,
  }))
  mocks.resolveSwarmModelEffortProbed.mockResolvedValue({ model: 'opus', effort: 'max' })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('spawnSwarmSupply — one supply desk per project', () => {
  it('TWO CONCURRENT spawns produce ONE desk, and both callers get THAT desk', async () => {
    // Hold the critical section open at its slowest step, so the second caller
    // lands inside the window the guard exists for.
    const gate = deferred<{ model: string; effort: 'max' }>()
    mocks.resolveSwarmModelEffortProbed.mockReturnValue(gate.promise)

    const a = spawnSwarmSupply({ projectPath: PROJ })
    const b = spawnSwarmSupply({ projectPath: PROJ })
    await until(
      () => mocks.resolveSwarmModelEffortProbed.mock.calls.length > 0,
      'a caller to reach the tier gate',
    )
    // Give the SECOND caller every chance to slip past the lock too. Without
    // the compare-and-set it does, and it is parked at the same gate right now.
    await settle()

    gate.resolve({ model: 'opus', effort: 'max' })
    const [ra, rb] = await Promise.all([a, b])

    // The observable, in the order that matters: the world holds ONE desk.
    expect(pool.length).toBe(1)
    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    // Both callers are pointed at it — a caller handed a second id would go on
    // to render a pane for a desk nobody else knows about.
    expect(ra.terminalId).toBe('term-1')
    expect(rb.terminalId).toBe('term-1')
    // Exactly one of them was told nothing was launched.
    expect([ra.reused === true, rb.reused === true].filter(Boolean).length).toBe(1)
  })

  it('a spawn while a desk is already up ADOPTS it — nothing is launched', async () => {
    pool.push({
      id: 'term-live',
      cwd: PROJ,
      agentSessionId: 'sid-live',
      deskLabel: SUPPLY_DESK_LABEL,
      startedAtMs: 1,
    })

    const r = await spawnSwarmSupply({ projectPath: PROJ })

    expect(mocks.launchClaude).not.toHaveBeenCalled()
    expect(pool.length).toBe(1)
    expect(r).toMatchObject({ terminalId: 'term-live', reused: true, resumed: false })
    // The store is re-pointed at the desk that ACTUALLY exists — otherwise it
    // can keep naming a conversation nobody is sitting at, and the desk's
    // memory is orphaned rather than resumed on the next boot.
    expect(mocks.recordSwarmSession).toHaveBeenCalledWith(PROJ, 'supply', 'sid-live')
  })

  it('a desk the PROCESS TABLE says is gone is NOT adopted — a fresh one launches', async () => {
    // The window this closes: `finishedAt` is stamped by an ASYNCHRONOUS onExit,
    // so right after a kill (Restart = DELETE then POST) the pool still lists a
    // PTY the OS already reaped. Adopting it returns reused:true for a desk that
    // is gone, and the owner gets a dead pane instead of a new desk.
    pool.push({
      id: 'term-zombie',
      cwd: PROJ,
      agentSessionId: 'sid-zombie',
      deskLabel: SUPPLY_DESK_LABEL,
      startedAtMs: 1,
    })
    deadIds.add('term-zombie')

    const r = await spawnSwarmSupply({ projectPath: PROJ })

    // Polarity: here the CORRECT behaviour is to launch.
    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    expect(r.terminalId).toBe('term-1')
    expect(r.reused).toBeFalsy()
    // And the corpse was never handed back as the session to resume.
    expect(mocks.recordSwarmSession).not.toHaveBeenCalledWith(PROJ, 'supply', 'sid-zombie')
  })

  it('a desk in ANOTHER project is not adopted — the lock is per project', async () => {
    pool.push({
      id: 'term-beta',
      cwd: OTHER,
      agentSessionId: 'sid-beta',
      deskLabel: SUPPLY_DESK_LABEL,
      startedAtMs: 1,
    })

    const r = await spawnSwarmSupply({ projectPath: PROJ })

    expect(mocks.launchClaude).toHaveBeenCalledTimes(1)
    expect(r.terminalId).toBe('term-1')
    expect(pool.map((d) => d.id).sort()).toEqual(['term-1', 'term-beta'])
  })

  it('two projects spawn CONCURRENTLY without waiting on each other', async () => {
    const gate = deferred<{ model: string; effort: 'max' }>()
    mocks.resolveSwarmModelEffortProbed.mockReturnValue(gate.promise)

    const a = spawnSwarmSupply({ projectPath: PROJ })
    const b = spawnSwarmSupply({ projectPath: OTHER })
    await until(
      () => mocks.resolveSwarmModelEffortProbed.mock.calls.length >= 2,
      'BOTH projects to reach the tier gate at once',
    )
    gate.resolve({ model: 'opus', effort: 'max' })
    const [ra, rb] = await Promise.all([a, b])

    expect(pool.length).toBe(2)
    expect(ra.terminalId).not.toBe(rb.terminalId)
    expect(ra.reused).toBeFalsy()
    expect(rb.reused).toBeFalsy()
  })

  it('a wedged holder that never settles is waited out, then REFUSED — never doubled', async () => {
    // The one thing the timeout path must not do is fall through and spawn
    // anyway: that is the twin the guard exists to prevent. With no desk to
    // adopt, refusing is the only honest answer.
    const stuck = deferred<{ model: string; effort: 'max' }>()
    mocks.resolveSwarmModelEffortProbed.mockReturnValue(stuck.promise)

    const held = spawnSwarmSupply({ projectPath: PROJ })
    await until(
      () => mocks.resolveSwarmModelEffortProbed.mock.calls.length > 0,
      'the first caller to hold the lock',
    )

    vi.useFakeTimers()
    const second = spawnSwarmSupply({ projectPath: PROJ }).then(
      (v) => v,
      (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
    )
    await vi.advanceTimersByTimeAsync(DESK_SPAWN_LOCK_WAIT_MS + 1)
    const outcome = await second

    expect(outcome).toBeInstanceOf(Error)
    expect((outcome as Error).message).toContain('refusing to open a second')
    // The refusal cost nothing: the wedged holder is still the only spawn.
    expect(mocks.launchClaude).not.toHaveBeenCalled()
    expect(pool.length).toBe(0)

    vi.useRealTimers()
    stuck.resolve({ model: 'opus', effort: 'max' })
    await held
  })

  it('a wedged holder that DID get its PTY up is ADOPTED on timeout, not refused', async () => {
    // A pool read + a record write can never build a desk, so adopting here is
    // safe even without the lock — and it is the difference between the owner
    // getting the desk that exists and getting an error about a desk they can see.
    const stuck = deferred<{ model: string; effort: 'max' }>()
    mocks.resolveSwarmModelEffortProbed.mockReturnValue(stuck.promise)
    const held = spawnSwarmSupply({ projectPath: PROJ })
    await until(
      () => mocks.resolveSwarmModelEffortProbed.mock.calls.length > 0,
      'the first caller to hold the lock',
    )
    // The holder's PTY landed even though the holder itself never returned.
    pool.push({
      id: 'term-wedged',
      cwd: PROJ,
      agentSessionId: 'sid-wedged',
      deskLabel: SUPPLY_DESK_LABEL,
      startedAtMs: 1,
    })

    vi.useFakeTimers()
    const second = spawnSwarmSupply({ projectPath: PROJ })
    await vi.advanceTimersByTimeAsync(DESK_SPAWN_LOCK_WAIT_MS + 1)
    const r = await second

    expect(r).toMatchObject({ terminalId: 'term-wedged', reused: true })
    expect(mocks.launchClaude).not.toHaveBeenCalled()

    vi.useRealTimers()
    stuck.resolve({ model: 'opus', effort: 'max' })
    await held
  })
})
