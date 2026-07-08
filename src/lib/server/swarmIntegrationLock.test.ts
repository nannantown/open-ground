import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, readFile, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { acquireIntegrationLock, readIntegrationLock, integrationLockPath } from './swarmIntegrationLock'

// Real local git fixture (house style — see swarmJanitor.test.ts) with
// OPENGROUND_HOME pinned to a scratch dir so the lock file never touches the
// real ~/.openground.

const execFile = promisify(execFileCb)

const git = async (cwd: string, args: string[]): Promise<string> =>
  (
    await execFile(
      'git',
      ['-c', 'user.name=OG Test', '-c', 'user.email=og-test@example.com', '-c', 'init.defaultBranch=main', ...args],
      { cwd },
    )
  ).stdout

let scratch: string
let project: string
let savedHome: string | undefined

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-integration-lock-')))
  savedHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = join(scratch, 'home')
  project = join(scratch, 'project')
  await mkdir(project)
  await git(project, ['init', '-b', 'main'])
  await writeFile(join(project, 'README'), 'base\n')
  await git(project, ['add', '.'])
  await git(project, ['commit', '-m', 'C0'])
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.OPENGROUND_HOME
  else process.env.OPENGROUND_HOME = savedHome
  await rm(scratch, { recursive: true, force: true })
})

describe('acquireIntegrationLock', () => {
  it('acquires a free lock and writes pid+timestamp+label to disk', async () => {
    const res = await acquireIntegrationLock(project, { label: 'engine', pid: 123, now: 1_000 })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.holder).toEqual({ pid: 123, acquiredAt: new Date(1_000).toISOString(), label: 'engine' })

    const path = await integrationLockPath(project)
    expect(path).toBeTruthy()
    const raw = JSON.parse(await readFile(path as string, 'utf8'))
    expect(raw.pid).toBe(123)
  })

  it('refuses a second acquire while the first holder is alive and fresh', async () => {
    const first = await acquireIntegrationLock(project, { label: 'engine', pid: process.pid, now: 1_000 })
    expect(first.ok).toBe(true)

    const second = await acquireIntegrationLock(project, { label: 'tmux-cli', pid: 999999, now: 2_000 })
    expect(second.ok).toBe(false)
    if (second.ok || second.reason !== 'held') throw new Error('expected a held result')
    expect(second.holder?.pid).toBe(process.pid)
  })

  it('reclaims a lock whose holder process is provably dead (stale by liveness)', async () => {
    // A pid that (almost certainly) doesn't exist on this machine.
    const deadPid = 999_999
    const first = await acquireIntegrationLock(project, { pid: deadPid, now: 1_000 })
    expect(first.ok).toBe(true)

    const second = await acquireIntegrationLock(project, { pid: process.pid, now: 2_000 })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.holder.pid).toBe(process.pid)
  })

  it('reclaims a lock older than staleMs even if the holder pid is alive', async () => {
    const first = await acquireIntegrationLock(project, { pid: process.pid, now: 0, staleMs: 5_000 })
    expect(first.ok).toBe(true)

    // Still alive, but way past staleMs.
    const stillHeld = await acquireIntegrationLock(project, { pid: process.pid, now: 4_000, staleMs: 5_000 })
    expect(stillHeld.ok).toBe(false)

    const reclaimed = await acquireIntegrationLock(project, { pid: process.pid, now: 10_000, staleMs: 5_000 })
    expect(reclaimed.ok).toBe(true)
  })

  it('release() only removes the lock if it still names our pid', async () => {
    const first = await acquireIntegrationLock(project, { pid: 111, now: 0, staleMs: 5_000 })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // A stale reclaim by someone else replaces the file underneath us.
    const dead = await acquireIntegrationLock(project, { pid: 999_999, now: 0, staleMs: 5_000 })
    // Not stale yet at the same `now` (still fresh) — held.
    expect(dead.ok).toBe(false)

    const reclaimer = await acquireIntegrationLock(project, { pid: 222, now: 999_999, staleMs: 5_000 })
    expect(reclaimer.ok).toBe(true)

    // The original holder's release must NOT delete the reclaimer's lock.
    await first.release()
    const current = await readIntegrationLock(project)
    expect(current?.pid).toBe(222)
  })

  it('release() removes the lock when it still owns it', async () => {
    const first = await acquireIntegrationLock(project, { pid: 333, now: 0 })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await first.release()
    expect(await readIntegrationLock(project)).toBeNull()
  })

  it('readIntegrationLock is a pure read (never mutates a fresh, live lock)', async () => {
    const acquired = await acquireIntegrationLock(project, { pid: process.pid, now: 1_000 })
    expect(acquired.ok).toBe(true)

    await readIntegrationLock(project)
    await readIntegrationLock(project)

    // Still held after repeated reads — a read never reclaims/deletes.
    const second = await acquireIntegrationLock(project, { pid: 999_999, now: 1_500 })
    expect(second.ok).toBe(false)
  })

  it('returns no-repo-key for a non-git directory', async () => {
    const notRepo = join(scratch, 'not-a-repo')
    await mkdir(notRepo)
    const res = await acquireIntegrationLock(notRepo)
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('no-repo-key')
  })

  // 差し戻し(1/3) MUST-FIX regression — a lock held only for a SHORT window (the
  // real git mutation, seconds) must never be double-acquired by a second
  // process while genuinely still held, EVEN IF a huge amount of unrelated wall
  // time (well past staleMs) has passed since the original acquisition's
  // acquiredAt — because that time was spent AFTER release, not while held. This
  // is the structural guarantee swarmOrchestrator.ts now relies on: acquiring
  // per-card immediately before integrate() (not once for a whole multi-minute
  // pass) keeps the ACTUAL hold duration far under staleMs, so staleness can
  // never legitimately fire while a holder is still doing real work.
  it('a short hold-then-release is never double-acquired, even when a huge amount of time has since elapsed', async () => {
    const held = await acquireIntegrationLock(project, { pid: process.pid, now: 0, staleMs: 5_000 })
    expect(held.ok).toBe(true)
    if (!held.ok) return

    // A concurrent second process tries WHILE still held (fresh, well under
    // staleMs) — correctly refused, proving no double-hold window exists.
    const concurrent = await acquireIntegrationLock(project, { pid: 999, now: 50, staleMs: 5_000 })
    expect(concurrent.ok).toBe(false)

    // The holder finishes its short git mutation and releases almost immediately.
    await held.release()

    // Ages past staleMs pass with NOBODY holding the lock (the pass's slow
    // verify/tsc/review stages, in production) — a status check mid-way sees it
    // free, exactly as it should (nothing to steal).
    expect(await readIntegrationLock(project)).toBeNull()

    // A later, fully independent acquisition (e.g. the next card, or a tmux
    // commander) succeeds as a NORMAL fresh acquire — not a stale-reclaim.
    const later = await acquireIntegrationLock(project, { pid: 1234, now: 10_000, staleMs: 5_000 })
    expect(later.ok).toBe(true)
  })
})
