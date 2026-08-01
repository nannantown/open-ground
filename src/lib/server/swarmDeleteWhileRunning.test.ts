// NOTHING DELETES A DIRECTORY A CLAUDE IS STILL WORKING IN.
//
// This is the invariant that costs the most when it breaks, and it has broken
// for real. claude shells out to `git` constantly; a delete landing mid-run
// wedges that git in uninterruptible sleep, where no signal and no timeout can
// reach it again — the 2026-07-28 freeze, which only a reboot cleared. So the
// rule is not "kill it first". `killTerminal` is a SIGHUP that returns
// immediately and promises nothing. The rule is stop it and WAIT until it is
// really gone, through `stopAllDesksInDirAndWait`, which asks BOTH pools and
// answers false when something is still there after the budget.
//
// Two paths were found still breaking it on 2026-08-01, both of them by the
// same reasoning error — "we already signalled / the folder is already gone, so
// nothing can be running":
//
//   • the adversarial review panel. `defaultRunReviewer`'s finally is
//     `killTerminal(ref.terminalId)`; `withRebasedWorktree`'s finally then ran
//     `git worktree remove --force` on the same dir. The reviewers ARE claude.
//
//   • POST /api/project/delete. It trashes the repo and then `rm -rf`s
//     `~/.openground/projects/<uuid>/`, whose `worktrees/` is where every swarm
//     worker actually runs. Its own comment claimed "the folder is already gone,
//     so any in-flight run is dead" — false for every worker, because a worker's
//     cwd was never under the repo.
//
// These tests drive the REAL stop-and-wait seam with a desk that refuses to go,
// and assert the destructive step does not happen. Asserting that some function
// was called would not be the same claim.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, realpath, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  spawnSdkSession,
  terminateSdkSession,
  __resetSdkSessionsForTests,
  isSdkSessionReaped,
  type SdkQueryFn,
} from './sdkSession'
import { stopAllDesksInDirAndWait } from './liveDesks'

let root: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  __resetSdkSessionsForTests()
  root = await realpath(await mkdtemp(join(tmpdir(), 'og-delwhile-')))
  process.env.OPENGROUND_HOME = root
})

afterEach(async () => {
  __resetSdkSessionsForTests()
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  if (prevHome !== undefined) process.env.OPENGROUND_HOME = prevHome
})

/** A desk whose pump never unwinds — a claude wedged in D-state git, which is
 *  precisely the case the wait exists for. `control.release` lets it finish. */
const wedged = (control: { release?: () => void }): SdkQueryFn =>
  (() => ({
    async *[Symbol.asyncIterator]() {
      await new Promise<void>((r) => {
        control.release = r
      })
      yield { type: 'result', subtype: 'success', terminal_reason: 'completed' }
    },
  })) as SdkQueryFn

describe('the stop-and-wait gate answers about the DIRECTORY, on both pools', () => {
  it('refuses while an SDK desk in that directory has not been reaped', async () => {
    const dir = join(root, 'worktrees', 'w1')
    await mkdir(dir, { recursive: true })
    const control: { release?: () => void } = {}
    const s = spawnSdkSession({
      cwd: dir,
      role: 'worker',
      options: {},
      initialPrompt: 'go',
      queryFn: wedged(control),
    })
    await new Promise((r) => setTimeout(r, 20))

    // ⚠ THE POINT: terminate ASKS. It flips status synchronously while claude is
    // still unwinding, so a gate built on status would return "clear" here — and
    // that is exactly the gate the two broken paths effectively had.
    terminateSdkSession(s.id)
    expect(isSdkSessionReaped(s.id)).toBe(false)

    expect(await stopAllDesksInDirAndWait(dir, { timeoutMs: 120, pollMs: 20 })).toBe(false)

    control.release?.()
    await new Promise((r) => setTimeout(r, 30))
    expect(await stopAllDesksInDirAndWait(dir, { timeoutMs: 200, pollMs: 20 })).toBe(true)
  })

  it('a desk in a SIBLING directory does not hold this one hostage', async () => {
    // The other direction: an over-broad gate that never lets anything be
    // deleted is its own failure — the review panel and the janitor would leak
    // a worktree per run forever.
    const mine = join(root, 'worktrees', 'mine')
    const other = join(root, 'worktrees', 'other')
    await mkdir(mine, { recursive: true })
    await mkdir(other, { recursive: true })
    const control: { release?: () => void } = {}
    spawnSdkSession({
      cwd: other,
      role: 'worker',
      options: {},
      initialPrompt: 'go',
      queryFn: wedged(control),
    })
    await new Promise((r) => setTimeout(r, 20))

    expect(await stopAllDesksInDirAndWait(mine, { timeoutMs: 120, pollMs: 20 })).toBe(true)
    control.release?.()
  })
})

describe('the two destructive callers are gated on that answer, not on a signal', () => {
  /** The shape both call sites have, reduced to what matters: ask, then destroy
   *  ONLY on a true answer. Driving the real seam keeps the fixture honest —
   *  a hand-rolled `alive` stub is what let both of these ship. */
  const destroyIfClear = async (dir: string): Promise<'destroyed' | 'kept'> => {
    if (!(await stopAllDesksInDirAndWait(dir, { timeoutMs: 120, pollMs: 20 }))) return 'kept'
    await rm(dir, { recursive: true, force: true })
    return 'destroyed'
  }

  it('the directory SURVIVES while a desk is still unwinding in it', async () => {
    const dir = join(root, 'projects', 'uuid-1', 'worktrees', 'swarm-a')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'WIP.txt'), 'a worker was mid-commit here')
    const control: { release?: () => void } = {}
    const s = spawnSdkSession({
      cwd: dir,
      role: 'worker',
      options: {},
      initialPrompt: 'go',
      queryFn: wedged(control),
    })
    await new Promise((r) => setTimeout(r, 20))
    terminateSdkSession(s.id)

    expect(await destroyIfClear(dir)).toBe('kept')
    expect(existsSync(join(dir, 'WIP.txt'))).toBe(true)

    control.release?.()
    await new Promise((r) => setTimeout(r, 30))
    expect(await destroyIfClear(dir)).toBe('destroyed')
    expect(existsSync(dir)).toBe(false)
  })

  it('an EMPTY pool means clear — the gate must not stall an ordinary teardown', async () => {
    const dir = join(root, 'review-1')
    await mkdir(dir, { recursive: true })
    expect(await destroyIfClear(dir)).toBe('destroyed')
  })
})
