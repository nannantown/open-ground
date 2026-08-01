import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// liveDesks — the ONE seam that answers "what is running right now?" across BOTH
// desk pools.
//
// Two distinct incidents live behind this file, and they are the two shapes of
// the same mistake (asking one pool):
//
//   • the worktree cleaner read the PTY pool alone, so an SDK worker's clean
//     worktree read as abandoned and was `git worktree remove`d out from under a
//     running claude. "Nothing is live here" AUTHORISES DESTRUCTION.
//   • the Ground beacon read the PTY pool alone, so a project whose work is all
//     on SDK workers showed a quiet card while claude ran. "Nothing is happening
//     here" IS A LIE — and the beacon is the only such signal the Ground has.
//
// The PTY pool is mocked (no node-pty spawn); the SDK pool is REAL with an
// injected queryFn, so the SDK half is exercised through the actual pool rather
// than a second mock that could agree with a wrong assumption.

const ptyMocks = vi.hoisted(() => ({
  listActiveTerminalCwds: vi.fn(() => [] as string[]),
  listActiveTerminals: vi.fn(() => ({ cwds: [] as string[], claude: [] as unknown[] })),
  killTerminalsByCwdAndWait: vi.fn(async () => true),
}))
vi.mock('./terminal', () => ptyMocks)

import { listAllLiveDeskCwds, listAllActiveDesks, stopAllDesksInDirAndWait } from './liveDesks'
import {
  spawnSdkSession,
  terminateSdkSession,
  isSdkSessionReaped,
  __resetSdkSessionsForTests,
  type SdkQueryFn,
} from './sdkSession'

/** A session that never finishes — a worker mid-task. */
const liveQuery: SdkQueryFn = () => ({
  async *[Symbol.asyncIterator]() {
    await new Promise(() => {})
    yield undefined // unreachable; a generator needs a yield
  },
})
/** A session that answers once and then waits for the next turn. */
const oneTurnQuery: SdkQueryFn = ({ prompt }) => ({
  async *[Symbol.asyncIterator]() {
    for await (const _m of prompt) {
      void _m
      yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
    }
  },
})
const settle = () => new Promise((r) => setTimeout(r, 10))

beforeEach(() => {
  __resetSdkSessionsForTests()
  ptyMocks.listActiveTerminalCwds.mockReturnValue([])
  ptyMocks.listActiveTerminals.mockReturnValue({ cwds: [], claude: [] })
})
afterEach(() => {
  __resetSdkSessionsForTests()
})

describe('listAllLiveDeskCwds — the destruction gate', () => {
  it('reports an SDK session’s cwd when the PTY pool is EMPTY (the cleaner’s blind spot)', () => {
    const s = spawnSdkSession({ cwd: '/wt/alpha', options: {}, queryFn: liveQuery })
    expect(listAllLiveDeskCwds()).toEqual(['/wt/alpha'])
    terminateSdkSession(s.id)
  })

  it('unions both pools and dedupes a cwd both are in', () => {
    ptyMocks.listActiveTerminalCwds.mockReturnValue(['/repo/main', '/wt/shared'])
    const a = spawnSdkSession({ cwd: '/wt/shared', options: {}, queryFn: liveQuery })
    const b = spawnSdkSession({ cwd: '/wt/beta', options: {}, queryFn: liveQuery })
    expect(listAllLiveDeskCwds().sort()).toEqual(['/repo/main', '/wt/beta', '/wt/shared'])
    terminateSdkSession(a.id)
    terminateSdkSession(b.id)
  })

  it('a session that is only STARTING still counts as live', () => {
    // The window right after spawn is exactly when the tree is clean and the
    // cleaner is most likely to run — reporting "not live" here is the bug.
    const s = spawnSdkSession({ cwd: '/wt/fresh', options: {}, queryFn: liveQuery })
    expect(listAllLiveDeskCwds()).toContain('/wt/fresh')
    terminateSdkSession(s.id)
  })

  it('drops a FINISHED session — the guard must not pin a dead worker’s tree forever', async () => {
    const s = spawnSdkSession({ cwd: '/wt/done', options: {}, initialPrompt: 'go', queryFn: oneTurnQuery })
    await settle()
    terminateSdkSession(s.id)
    await settle()
    expect(listAllLiveDeskCwds()).not.toContain('/wt/done')
  })
})

describe('listAllActiveDesks — the Ground beacon', () => {
  it('an SDK worker lights the beacon even with NO PTY anywhere', () => {
    const s = spawnSdkSession({ cwd: '/wt/alpha', options: {}, queryFn: liveQuery })
    const r = listAllActiveDesks()
    expect(r.cwds).toContain('/wt/alpha')
    // It joins `claude` because it IS claude — the runtime is an implementation
    // detail of how it is driven, not of what is running.
    expect(r.claude).toEqual([{ id: s.id, cwd: '/wt/alpha', status: 'working' }])
    terminateSdkSession(s.id)
  })

  it('keeps every PTY entry untouched and appends (never replaces)', () => {
    ptyMocks.listActiveTerminals.mockReturnValue({
      cwds: ['/repo/main'],
      claude: [{ id: 'pty-1', cwd: '/repo/main', status: 'waiting' }],
    })
    const s = spawnSdkSession({ cwd: '/wt/alpha', options: {}, queryFn: liveQuery })
    const r = listAllActiveDesks()
    expect(r.claude).toHaveLength(2)
    expect(r.claude[0]).toEqual({ id: 'pty-1', cwd: '/repo/main', status: 'waiting' })
    expect(r.cwds.sort()).toEqual(['/repo/main', '/wt/alpha'])
    terminateSdkSession(s.id)
  })

  it('a finished session shows NO beacon (a quiet card is right once work ends)', async () => {
    const s = spawnSdkSession({ cwd: '/wt/done', options: {}, initialPrompt: 'go', queryFn: oneTurnQuery })
    await settle()
    terminateSdkSession(s.id)
    await settle()
    const r = listAllActiveDesks()
    expect(r.claude).toEqual([])
    expect(r.cwds).toEqual([])
  })

  it('a session waiting for its next turn reads as WAITING, not as gone', async () => {
    const s = spawnSdkSession({ cwd: '/wt/idle', options: {}, initialPrompt: 'go', queryFn: oneTurnQuery })
    await settle()
    expect(listAllActiveDesks().claude).toEqual([
      { id: s.id, cwd: '/wt/idle', status: 'waiting' },
    ])
    terminateSdkSession(s.id)
  })
})

describe('stopAllDesksInDirAndWait — the delete gate', () => {
  // THE CRITICAL (2026-07-31, adversarial review). removeSwarmWorktree's
  // occupancy check was `killTerminalsByCwdAndWait(worktree)` alone — and that
  // function returns TRUE ("nothing to wait for") when it finds no PTY sessions,
  // which is exactly what an SDK worker's worktree looks like to it. So the
  // refusal never fired, and `git worktree remove --force` ran under a live
  // claude: the same accident that manufactures uninterruptible-sleep orphans
  // (the 2026-07-28 machine freeze) that the PTY wait was added to prevent.
  /** A session that only finishes when the test says so. */
  const controllable = (control: { stop?: () => void }): SdkQueryFn =>
    (() => ({
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((resolve) => {
          control.stop = resolve
        })
        yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
      },
    })) as SdkQueryFn

  it('REFUSES while an SDK session in the dir is still unwinding', async () => {
    const control: { stop?: () => void } = {}
    spawnSdkSession({ cwd: '/wt/target', options: {}, initialPrompt: 'go', queryFn: controllable(control) })
    await settle()
    // The PTY pool says "clear" — as it always does for an SDK worker.
    ptyMocks.killTerminalsByCwdAndWait.mockResolvedValue(true)

    const ok = await stopAllDesksInDirAndWait('/wt/target', { timeoutMs: 80, pollMs: 10 })
    expect(ok).toBe(false) // → the caller must NOT delete
    control.stop?.()
  })

  it('allows once the session has actually gone', async () => {
    const control: { stop?: () => void } = {}
    spawnSdkSession({ cwd: '/wt/target', options: {}, initialPrompt: 'go', queryFn: controllable(control) })
    await settle()
    const waiting = stopAllDesksInDirAndWait('/wt/target', { timeoutMs: 2_000, pollMs: 5 })
    await settle()
    control.stop?.() // the iterator returns → the pump unwinds → reaped
    await expect(waiting).resolves.toBe(true)
  })

  it('a session in a SUBDIRECTORY also blocks the delete', async () => {
    const control: { stop?: () => void } = {}
    spawnSdkSession({ cwd: '/wt/target/src/deep', options: {}, initialPrompt: 'go', queryFn: controllable(control) })
    await settle()
    expect(await stopAllDesksInDirAndWait('/wt/target', { timeoutMs: 60, pollMs: 10 })).toBe(false)
    control.stop?.()
  })

  it('a session in a SIBLING dir does not block (the gate still discriminates)', async () => {
    const control: { stop?: () => void } = {}
    spawnSdkSession({ cwd: '/wt/target-evil', options: {}, initialPrompt: 'go', queryFn: controllable(control) })
    await settle()
    // sep-terminated prefix: `target-evil` must not read as inside `target`.
    expect(await stopAllDesksInDirAndWait('/wt/target', { timeoutMs: 200, pollMs: 10 })).toBe(true)
    control.stop?.()
  })

  it('still defers to the PTY answer when no SDK session is involved', async () => {
    ptyMocks.killTerminalsByCwdAndWait.mockResolvedValue(false) // a PTY refused to die
    expect(await stopAllDesksInDirAndWait('/wt/nothing', { timeoutMs: 60, pollMs: 10 })).toBe(false)
    ptyMocks.killTerminalsByCwdAndWait.mockResolvedValue(true)
    expect(await stopAllDesksInDirAndWait('/wt/nothing', { timeoutMs: 60, pollMs: 10 })).toBe(true)
  })

  // ── THE SDK ARM MUST NOT OVERWRITE THE PTY'S REFUSAL ─────────────────────
  // The test above only reaches the `if (!sdkIds.length) return ptyGone` early
  // exit — with no SDK session in the dir, the wait loop below it never runs. So
  // the loop's OWN `return ptyGone` was unguarded: measured 2026-08-01, rewriting
  // it to `return true` kept all 76 tests in these three files green.
  //
  // That mutation is the delete gate answering "clear" for a directory a PTY is
  // still alive in, and the mixed arrangement is a normal one — the engine's
  // teardown runs against a worktree that can hold both a worker's SDK session
  // and, say, a leftover shell. The SDK half finishing says nothing about the PTY
  // half, and this function's whole reason to exist is that a false "clear"
  // authorises `git worktree remove --force` under a running process (the
  // 2026-07-28 uninterruptible-sleep freeze). A gate that can be talked out of a
  // refusal by an UNRELATED success is worse than no gate: it is a refusal the
  // caller believes it heard.

  it('a PTY that refused to die still BLOCKS, even after every SDK session has gone', async () => {
    const control: { stop?: () => void } = {}
    spawnSdkSession({ cwd: '/wt/target', options: {}, initialPrompt: 'go', queryFn: controllable(control) })
    await settle()
    ptyMocks.killTerminalsByCwdAndWait.mockResolvedValue(false) // the PTY is STILL there

    // Long budget on purpose: this must come back `false` because the PTY said
    // so, NOT because the SDK wait timed out. The SDK half is made to succeed.
    const waiting = stopAllDesksInDirAndWait('/wt/target', { timeoutMs: 5_000, pollMs: 5 })
    await settle()
    control.stop?.() // the SDK session really goes…
    expect(await waiting).toBe(false) // …and must not turn the refusal into consent
  })

  it('the same rule with no timing at all — SDK already reaped, PTY still refusing', async () => {
    // The seams `stopAllDesksInDirAndWait` documents as "injected for tests",
    // used to pin the return value alone: PTY false + an SDK id that is reaped on
    // the very first poll is precisely the state the mutation reads as `true`.
    expect(
      await stopAllDesksInDirAndWait('/wt/x', {
        timeoutMs: 1_000,
        pollMs: 1,
        killPtys: async () => false, // a PTY is still there
        terminateSdk: () => ['sdk-1'], // …and an SDK session was asked to stop too
        sdkReaped: () => true, // …and it has already gone
      }),
    ).toBe(false)
    // The positive control — without it the assertion above would also pass on a
    // gate that simply never says yes.
    expect(
      await stopAllDesksInDirAndWait('/wt/x', {
        timeoutMs: 1_000,
        pollMs: 1,
        killPtys: async () => true,
        terminateSdk: () => ['sdk-1'],
        sdkReaped: () => true,
      }),
    ).toBe(true)
  })

  it('REFUSES a session that was ALREADY asked to stop but has not gone', async () => {
    // The version of this test that shipped first only checked
    // `isSdkSessionReaped` after terminate — it never called the gate, so it
    // could not fail even while the gate skipped exactly this session (flagged
    // by an adversarial reviewer). This is the arrangement the engine's MAIN
    // teardown creates: terminate first, remove the worktree after.
    const control: { stop?: () => void } = {}
    const s = spawnSdkSession({ cwd: '/wt/target', options: {}, initialPrompt: 'go', queryFn: controllable(control) })
    await settle()
    terminateSdkSession(s.id)
    expect(isSdkSessionReaped(s.id)).toBe(false) // asked to stop ≠ stopped
    ptyMocks.killTerminalsByCwdAndWait.mockResolvedValue(true) // no PTY here, as always

    // THE assertion: the gate must still see it and refuse the delete.
    expect(await stopAllDesksInDirAndWait('/wt/target', { timeoutMs: 80, pollMs: 10 })).toBe(false)

    control.stop?.()
    await settle()
    // …and once it is really gone, the delete is allowed.
    expect(await stopAllDesksInDirAndWait('/wt/target', { timeoutMs: 200, pollMs: 10 })).toBe(true)
  })
})
