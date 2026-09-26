import { execFileSync, spawn } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gateDir, isFullRun, leave, recordsPass, touch, tryEnter, waitForSlot, workersFor, type GateOptions } from './fullSuiteGate'
import { cleanTree, fullSuiteVerdict, writeRunRecord } from './fullSuiteRecord'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-gate-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const alive = new Set<number>()
const as = (pid: number, extra: Partial<GateOptions> = {}): GateOptions => ({
  dir,
  pid,
  isAlive: (p) => alive.has(p),
  ...extra,
})
beforeEach(() => {
  alive.clear()
  for (const p of [101, 102, 103, 104]) alive.add(p)
})

describe('full-suite gate: at most 2 at once', () => {
  it('admits two, makes the third wait, lets it in when one finishes', () => {
    expect(tryEnter(as(101)).admitted).toBe(true)
    expect(tryEnter(as(102)).admitted).toBe(true)
    const third = tryEnter(as(103))
    expect(third.admitted).toBe(false)
    expect(third.position).toBe(0)
    // Polling again does not sneak it in.
    expect(tryEnter(as(103)).admitted).toBe(false)
    leave(as(101))
    expect(tryEnter(as(103)).admitted).toBe(true)
  })

  it('a holder that died without leaving frees its slot (pid gone)', () => {
    tryEnter(as(101))
    tryEnter(as(102))
    expect(tryEnter(as(103)).admitted).toBe(false)
    alive.delete(102) // crashed / SIGKILLed: no leave()
    expect(tryEnter(as(103)).admitted).toBe(true)
  })

  it('a holder whose pid was reused but stopped stamping is dropped after the stale window', () => {
    tryEnter(as(101, { now: () => 0 }))
    tryEnter(as(102, { now: () => 0 }))
    expect(tryEnter(as(103, { now: () => 60_000 })).admitted).toBe(false)
    // 101 keeps stamping, 102 went silent (its pid now belongs to someone else).
    tryEnter(as(101, { now: () => 170_000 }))
    expect(tryEnter(as(103, { now: () => 200_000 })).admitted).toBe(true)
  })

  it('waiters go in arrival order', () => {
    tryEnter(as(101))
    tryEnter(as(102))
    tryEnter(as(103))
    tryEnter(as(104))
    leave(as(101))
    expect(tryEnter(as(104)).admitted).toBe(false) // 103 was first
    expect(tryEnter(as(103)).admitted).toBe(true)
  })

  it('a torn state file never blocks forever', () => {
    writeFileSync(join(dir, 'state.json'), '{"running": [{"pid"')
    expect(tryEnter(as(101)).admitted).toBe(true)
  })

  it('a real process killed with SIGKILL while holding a slot does not keep it', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 100000)'], { stdio: 'ignore' })
    const pid = child.pid!
    const exited = new Promise((r) => child.once('exit', r))
    try {
      expect(tryEnter({ dir, pid, limit: 1 }).admitted).toBe(true)
      expect(tryEnter({ dir, pid: process.pid, limit: 1 }).admitted).toBe(false)
      child.kill('SIGKILL')
      await exited
      expect(tryEnter({ dir, pid: process.pid, limit: 1 }).admitted).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('reports how many full runs share the machine, and splits the cores', () => {
    expect(tryEnter(as(101)).sharing).toBe(1)
    expect(workersFor(1, 11)).toBeUndefined() // alone: vitest default (cores-1)
    expect(tryEnter(as(102)).sharing).toBe(2)
    expect(workersFor(2, 11)).toBe(5)
    expect(workersFor(2, 2)).toBe(1)
  })
  it('a running holder that was dropped (machine slept) re-stamps back into running, not the line', () => {
    tryEnter(as(101, { now: () => 0 }))
    tryEnter(as(102, { now: () => 0 }))
    touch(as(102, { now: () => 200_000 })) // 101 slept past the stale window: dropped
    expect(tryEnter(as(103, { now: () => 200_500 })).admitted).toBe(true) // 101 looked dead
    expect(tryEnter(as(104, { now: () => 200_600 })).admitted).toBe(false)
    touch(as(101, { now: () => 201_000 })) // 101 wakes up — it IS still running
    leave(as(102, { now: () => 202_000 }))
    // Real runs: 101 + 103. 104 must keep waiting; had 101 re-queued behind 104
    // as a waiter, 104 would get 102's slot and three suites would run.
    expect(tryEnter(as(104, { now: () => 202_000 })).admitted).toBe(false)
  })

  it('a live holder older than the run cap (hung / orphaned) stops blocking the line', () => {
    tryEnter(as(101, { now: () => 0 }))
    tryEnter(as(102, { now: () => 0 }))
    const late = 61 * 60_000
    touch(as(101, { now: () => late })) // still stamping, alive, but running for 61 min
    touch(as(102, { now: () => late }))
    expect(tryEnter(as(103, { now: () => late })).admitted).toBe(true)
  })

  it('a mutex left by a process that died inside it is reaped by age', () => {
    const lock = join(dir, 'lock')
    mkdirSync(lock)
    const t = (Date.now() - 9_700) / 1000 // just under the 10 s limit: must age while we spin
    utimesSync(lock, t, t)
    const started = Date.now()
    expect(tryEnter(as(101)).admitted).toBe(true)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

describe('gateDir: one line for the primary checkout and every worktree', () => {
  const g = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8' }).trim()

  it('real git: the primary checkout, a subdirectory and a `git worktree add` all resolve to the same directory', () => {
    const main = join(dir, 'main')
    mkdirSync(join(main, 'sub'), { recursive: true })
    g(main, 'init', '-q', '-b', 'main')
    writeFileSync(join(main, 'a'), 'a')
    g(main, 'add', 'a')
    g(main, 'commit', '-qm', 'a')
    g(main, 'worktree', 'add', '-q', join(dir, 'wt'), '-b', 'wt')
    const want = join(realpathSync(join(main, '.git')), 'og-test-gate')
    expect(gateDir(main)).toBe(want)
    expect(gateDir(join(main, 'sub'))).toBe(want)
    expect(gateDir(join(dir, 'wt'))).toBe(want)
  })

  it('an old git echoing an unknown flag back (2 lines), or a path that is not there: run ungated', () => {
    // git 2.28 answers `rev-parse --path-format=absolute --git-common-dir` with
    // the flag itself as a first line — measured on the owner's machine.
    expect(gateDir(dir, () => `--path-format=absolute\n${dir}`)).toBeNull()
    // …even once the buggy build has CREATED that oddly named directory (it did,
    // in a worktree root on 2026-09-26), so "does it exist" alone is not enough.
    mkdirSync(join(dir, `--path-format=absolute\n${dir}`), { recursive: true })
    expect(gateDir(dir, () => `--path-format=absolute\n${dir}`)).toBeNull()
    expect(gateDir(dir, () => join(dir, 'missing', '.git'))).toBeNull()
    expect(gateDir(dir, () => null)).toBeNull()
  })

  it('a bookkeeping failure lets the run go ungated instead of failing it', async () => {
    const notADir = join(dir, 'file')
    writeFileSync(notADir, 'x') // mkdir under a file => ENOTDIR
    // Keep the intended warning out of `npm test` output, where it would read
    // as the real gate failing.
    const quiet = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      await expect(waitForSlot({ dir: join(notADir, 'og-test-gate'), pid: 101 })).resolves.toBeNull()
      expect(String(quiet.mock.calls[0]?.[0])).toMatch(/bookkeeping failed/)
    } finally {
      quiet.mockRestore()
    }
  })
})

describe('run record + fullSuiteVerdict: the commander skips the suite only for a passed run on the exact, up-to-date contents', () => {
  const g = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, encoding: 'utf8' }).trim()
  const commit = (name: string) => {
    writeFileSync(join(dir, name), name)
    g('add', name)
    g('commit', '-qm', name)
  }
  const gitDir = () => g('rev-parse', '--absolute-git-dir')
  const run = (exitCode: number, during?: () => void) => {
    const start = cleanTree(dir)
    during?.()
    writeRunRecord(gitDir(), start, exitCode)
  }

  beforeEach(() => {
    g('init', '-q', '-b', 'main')
    commit('a')
    g('checkout', '-qb', 'feature')
    commit('b')
  })

  it('no record, or the last run failed (e.g. unhandled errors => exit 1): run it', () => {
    expect(fullSuiteVerdict(dir, 'main').ok).toBe(false)
    run(0)
    run(1)
    expect(fullSuiteVerdict(dir, 'main').ok).toBe(false)
  })

  it('a clean run that exited 0 on HEAD, which contains main: skip', () => {
    run(0)
    expect(fullSuiteVerdict(dir, 'main')).toMatchObject({ ok: true })
    g('commit', '--amend', '-qm', 'reworded') // same contents, new commit id
    expect(fullSuiteVerdict(dir, 'main')).toMatchObject({ ok: true })
  })

  it('dirty at the start, or changed during the run: the commander still runs it', () => {
    writeFileSync(join(dir, 'scratch'), 'x') // untracked counts as dirty
    run(0)
    rmSync(join(dir, 'scratch'))
    expect(fullSuiteVerdict(dir, 'main').ok).toBe(false)
    run(0, () => commit('mid-run'))
    expect(fullSuiteVerdict(dir, 'main').ok).toBe(false)
  })

  it('dirty now, or HEAD moved after the run: run it', () => {
    run(0)
    writeFileSync(join(dir, 'scratch'), 'x')
    expect(fullSuiteVerdict(dir, 'main').ok).toBe(false)
    rmSync(join(dir, 'scratch'))
    commit('c')
    expect(fullSuiteVerdict(dir, 'main').ok).toBe(false)
  })

  it('main moved on after the run: not up to date, run it again after rebase', () => {
    run(0)
    g('checkout', '-q', 'main')
    commit('m')
    g('checkout', '-q', 'feature')
    expect(fullSuiteVerdict(dir, 'main')).toMatchObject({ ok: false })
  })
})

describe('recordsPass: only a plain whole-suite run may write the pass record', () => {
  it.each([
    [['run'], true],
    [[], false],
    [['run', '--reporter=dot'], true],
    [['run', '-t', 'x'], false],
    [['run', '--shard=1/2'], false],
    [['run', '--bail=1'], false],
    [['run', '--changed'], false],
    [['run', 'src/x.test.ts'], false],
  ] as const)('%j -> %s', (argv, ok) => {
    expect(recordsPass([...argv])).toBe(ok)
  })
})

describe('isFullRun', () => {
  it.each([
    [[], true],
    [['run'], true],
    [['run', '--reporter=dot'], true],
    [['run', '-t', 'some name'], true],
    [['run', '--maxWorkers', '3'], true],
    [['run', 'src/lib/server/x.test.ts'], false],
    [['src/test'], false],
    [['run', '--changed'], false],
    [['run', '--changed', 'origin/main'], false],
    [['related', 'src/lib/types.ts', '--run'], false],
    [['list'], false],
  ] as const)('%j -> %s', (argv, full) => {
    expect(isFullRun([...argv])).toBe(full)
  })
})
