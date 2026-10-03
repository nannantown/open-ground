import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFile as execFileCb, spawn, type ChildProcess } from 'child_process'
import { pidsWithCwdUnder, stoppablePids, stdoutOfFailedProbe, stopProcessesInDir } from './worktreeProcesses'
import { promisify } from 'util'
import { mkdtemp, mkdir, rm, realpath, writeFile, stat, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createSwarmWorktree, removeSwarmWorktree, ensureSwarmWorktreeForBranch } from './swarmWorker'
import { runDispatchPass, __seedEngineForTests } from './swarmOrchestrator'
import { addProjectEntry, __resetMigrationCacheForTests } from './registry'
import type { ProjectTask, SpawnSwarmWorkerResponse } from '@/lib/types'

// THE FIRST REQUEUE THAT STARTED OVER (measured 2026-10-03, card d84bec79).
//
// 06:17:57 quota-stopped — requeued — card → todo (branch …145418, 4 commits)
// 06:18:08 dispatch → …151808   ← no 「前回の作業場に戻ります」, card.branch overwritten
//
// The worker had started a dev server (concurrently + tsx watch + vite) in its
// worktree. The quota teardown removed the worktree, not that process, and vite
// wrote `.vite/` straight back into the path. `git worktree add <dir> <branch>`
// refuses a non-empty directory, so ensureSwarmWorktreeForBranch returned null and
// dispatch minted a fresh branch over the committed work. Later requeues of the
// new branch re-entered fine — their 1-minute workers never started a server.
//
// REAL git here (the debris only matters to git), HOME isolated per test.

vi.setConfig({ testTimeout: 60_000 })

const execFile = promisify(execFileCb)
const git = async (cwd: string, args: string[]): Promise<string> =>
  (
    await execFile(
      'git',
      [
        '-c', 'user.name=OG Test',
        '-c', 'user.email=og-test@example.com',
        '-c', 'commit.gpgsign=false',
        '-c', 'init.defaultBranch=main',
        ...args,
      ],
      { cwd },
    )
  ).stdout

let scratch: string
let savedHome: string | undefined
let savedCfg: string | undefined

beforeEach(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'og-reentry-debris-')))
  savedHome = process.env.OPENGROUND_HOME
  const home = join(scratch, 'home')
  await mkdir(home, { recursive: true })
  process.env.OPENGROUND_HOME = home
  // removeSwarmWorktree prunes claude's folder-trust entry — keep that file in tmp too.
  savedCfg = process.env.CLAUDE_CONFIG_PATH
  process.env.CLAUDE_CONFIG_PATH = join(home, '.claude.json')
  __resetMigrationCacheForTests()
})
afterEach(async () => {
  // Restore, never delete (see src/lib/server/testHomeGuard.ts).
  if (savedHome !== undefined) process.env.OPENGROUND_HOME = savedHome
  if (savedCfg === undefined) delete process.env.CLAUDE_CONFIG_PATH
  else process.env.CLAUDE_CONFIG_PATH = savedCfg
  __resetMigrationCacheForTests()
  await rm(scratch, { recursive: true, force: true })
})

/** A registered repo + a worker branch with committed work whose worktree was
 *  then torn down (what the quota stop does), and the stray dev server's refill. */
async function quotaStoppedCard(): Promise<{ proj: string; branch: string; dir: string }> {
  const origin = join(scratch, 'origin.git')
  await mkdir(origin)
  await git(origin, ['init', '--bare', '-b', 'main'])
  const proj = join(scratch, 'proj')
  await mkdir(proj)
  await git(proj, ['init', '-b', 'main'])
  await git(proj, ['remote', 'add', 'origin', origin])
  await writeFile(join(proj, 'README.md'), '# base\n')
  await git(proj, ['add', '-A'])
  await git(proj, ['commit', '-m', 'base'])
  await git(proj, ['push', '-u', 'origin', 'main'])
  await addProjectEntry(proj)

  const wt = await createSwarmWorktree(proj)
  await writeFile(join(wt.worktree, 'work.txt'), 'paid for\n')
  await git(wt.worktree, ['add', 'work.txt'])
  await git(wt.worktree, ['commit', '-m', 'worker progress'])
  expect(await removeSwarmWorktree(proj, wt.worktree, { force: true })).toEqual({ removed: true })
  // The orphaned vite recreates its cache dir at the old address.
  await mkdir(join(wt.worktree, '.vite', 'deps'), { recursive: true })
  await writeFile(join(wt.worktree, '.vite', 'deps', '_metadata.json'), '{}')
  return { proj, branch: wt.branch, dir: wt.worktree }
}

describe('quota re-entry — a stray process refilled the old worktree path', () => {
  it('ensureSwarmWorktreeForBranch re-creates the worktree over the debris', async () => {
    const { proj, branch, dir } = await quotaStoppedCard()

    const reuse = await ensureSwarmWorktreeForBranch(proj, branch)

    expect(reuse).toEqual({ worktree: dir, branch })
    expect((await stat(join(dir, 'work.txt'))).isFile()).toBe(true) // the commits are back
  })

  it('leaves a directory holding a .git alone (unknown state, not debris)', async () => {
    const { proj, branch, dir } = await quotaStoppedCard()
    await writeFile(join(dir, '.git'), 'gitdir: /somewhere/else\n')

    expect(await ensureSwarmWorktreeForBranch(proj, branch)).toBeNull()
    expect((await stat(join(dir, '.git'))).isFile()).toBe(true)
  })

  it('THE REPRO: the next dispatch re-enters the committed branch and keeps card.branch', async () => {
    const { proj, branch, dir } = await quotaStoppedCard()
    const board = new Map<string, ProjectTask>([
      ['a', { id: 'a', title: 'card a', notes: 'completion conditions', done: false, boardColumn: 'todo', branch } as ProjectTask],
    ])
    const spawned: { worktree?: string }[] = []
    const deps = {
      fetchTasks: async () => Array.from(board.values()),
      // resolveReusableWork NOT injected — the production resolver runs against real git.
      spawnWorker: async (opts: { worktree?: string }): Promise<SpawnSwarmWorkerResponse> => {
        spawned.push({ worktree: opts.worktree })
        return {
          terminalId: 't1',
          agentSessionId: 's',
          worktree: opts.worktree ?? '/wt/fresh',
          branch: opts.worktree ? branch : 'swarm/fresh-1',
        } as SpawnSwarmWorkerResponse
      },
      moveToDoing: async (_p: string, id: string, b: string) => {
        board.set(id, { ...board.get(id)!, boardColumn: 'doing', branch: b })
        return true
      },
      moveToReview: async () => true,
      countCommitsAhead: async () => 1,
      readHeartbeat: async () => null,
      isAlive: () => true,
      recoverCard: async () => true,
      recoverWorker: async () => ({ removed: true }),
      lastOutputAt: () => null,
      nudge: () => true,
      escalate: async () => true,
      recentOutput: () => null,
    } as never
    const engine = engineLiteral(proj)
    __seedEngineForTests(engine)

    await runDispatchPass(engine, deps)

    expect(spawned).toEqual([{ worktree: dir }])
    expect(board.get('a')?.branch).toBe(branch)
  })
})

// THE SOURCE OF THE DEBRIS: the teardown now stops what the worker left running.
describe('removeSwarmWorktree — stops processes left running inside the worktree', () => {
  const exited = (c: ChildProcess, ms: number) =>
    new Promise<boolean>((res) => {
      if (c.exitCode !== null || c.signalCode !== null) return res(true)
      const t = setTimeout(() => res(false), ms)
      c.once('exit', () => {
        clearTimeout(t)
        res(true)
      })
    })

  it.skipIf(process.platform === 'win32')('a detached dev-server stand-in (cwd in a subdir) dies; a process outside is untouched', async () => {
    const { proj, branch } = await quotaStoppedCard()
    const reuse = await ensureSwarmWorktreeForBranch(proj, branch)
    const wt = reuse!.worktree
    await mkdir(join(wt, 'web'), { recursive: true })
    const inside = spawn('sleep', ['300'], { cwd: join(wt, 'web'), detached: true, stdio: 'ignore' })
    const outside = spawn('sleep', ['300'], { cwd: proj, detached: true, stdio: 'ignore' })
    try {
      expect(await removeSwarmWorktree(proj, wt, { force: true })).toEqual({ removed: true })
      expect(await exited(inside, 5_000)).toBe(true)
      expect(outside.exitCode === null && outside.signalCode === null).toBe(true)
    } finally {
      inside.kill('SIGKILL')
      outside.kill('SIGKILL')
    }
  })

  it.skipIf(process.platform === 'win32')('a process still sitting in an already-removed worktree path is stopped too', async () => {
    const { proj, dir } = await quotaStoppedCard()
    const orphan = spawn('sleep', ['300'], { cwd: join(dir, '.vite'), detached: true, stdio: 'ignore' })
    try {
      await rm(dir, { recursive: true, force: true })
      expect(await removeSwarmWorktree(proj, dir, { force: true })).toEqual({ removed: true })
      expect(await exited(orphan, 5_000)).toBe(true)
    } finally {
      orphan.kill('SIGKILL')
    }
  })
})

describe('stopProcessesInDir — what it must NOT stop, and the path forms', () => {
  const cwdPidsUnder = async (dir: string): Promise<number[]> => {
    const out = await execFile('lsof', ['-d', 'cwd', '-Fpn']).then((r) => r.stdout, (e) => String(e.stdout ?? ''))
    return pidsWithCwdUnder(out, dir)
  }

  // The owner `cd`'d into the worktree from a terminal: that shell (and a claude in
  // it) has a controlling TTY. `script` gives the sleep one; `script` itself sits
  // OUTSIDE the worktree, exactly like Terminal.app does.
  it.skipIf(process.platform !== 'darwin')('a process WITH a terminal (the owner’s shell) is left alone; a detached one is stopped', async () => {
    const dir = await realpath(await mkdtemp(join(scratch, 'wt-')))
    const term = spawn('script', ['-q', '/dev/null', 'sh', '-c', `cd '${dir}' && exec sleep 300`], { cwd: scratch, stdio: 'ignore' })
    const detached = spawn('sleep', ['300'], { cwd: dir, detached: true, stdio: 'ignore' })
    let ttyPid = 0
    try {
      for (let i = 0; i < 50 && !ttyPid; i++) {
        ttyPid = (await cwdPidsUnder(dir)).find((p) => p !== detached.pid) ?? 0
        if (!ttyPid) await new Promise((r) => setTimeout(r, 100))
      }
      expect(ttyPid).toBeGreaterThan(0)

      const stopped = await stopProcessesInDir(dir)

      expect(stopped).toEqual([detached.pid])
      expect(() => process.kill(ttyPid, 0)).not.toThrow() // the terminal's process lives
    } finally {
      if (ttyPid) process.kill(ttyPid, 'SIGKILL')
      term.kill('SIGKILL')
      detached.kill('SIGKILL')
    }
  })

  // A program that HOLDS terminals (a tmux server) is TTY-less itself, keeps its
  // start directory as cwd, and runs its sessions on ptys. Detached `script` is the
  // same shape: no TTY, cwd in the worktree, a child on a pty.
  it.skipIf(process.platform !== 'darwin')('a TTY-less parent holding a terminal child is left alone', async () => {
    const dir = await realpath(await mkdtemp(join(scratch, 'wt-')))
    const holder = spawn('script', ['-q', '/dev/null', 'sleep', '300'], { cwd: dir, detached: true, stdio: 'ignore' })
    const detached = spawn('sleep', ['300'], { cwd: dir, detached: true, stdio: 'ignore' })
    let inDir: number[] = []
    try {
      for (let i = 0; i < 50 && inDir.length < 3; i++) {
        inDir = await cwdPidsUnder(dir)
        if (inDir.length < 3) await new Promise((r) => setTimeout(r, 100))
      }
      expect(inDir).toContain(holder.pid) // holder + its pty child + the detached sleep

      expect(await stopProcessesInDir(dir)).toEqual([detached.pid])
      expect(() => process.kill(holder.pid!, 0)).not.toThrow()
    } finally {
      for (const p of inDir) {
        try {
          process.kill(p, 'SIGKILL')
        } catch {
          // gone
        }
      }
      holder.kill('SIGKILL')
      detached.kill('SIGKILL')
    }
  })

  // lsof prints the realpath; a caller holding another form (a symlinked home,
  // macOS /tmp vs /private/tmp) must still find the process.
  it.skipIf(process.platform === 'win32')('finds the process through a symlinked form of the path', async () => {
    const dir = await realpath(await mkdtemp(join(scratch, 'wt-')))
    const alias = join(scratch, 'alias')
    await symlink(dir, alias)
    const c = spawn('sleep', ['300'], { cwd: dir, detached: true, stdio: 'ignore' })
    try {
      expect(await stopProcessesInDir(alias)).toEqual([c.pid])
    } finally {
      c.kill('SIGKILL')
    }
  })
})

describe('pidsWithCwdUnder / stoppablePids / stdoutOfFailedProbe', () => {
  it('matches the dir and its subdirs only, never a sibling with the same prefix', () => {
    const out = 'p10\nfcwd\nn/w/a\np11\nfcwd\nn/w/a/web\np12\nfcwd\nn/w/ab\np13\nfcwd\nn/home\n'
    expect(pidsWithCwdUnder(out, '/w/a').sort()).toEqual([10, 11])
  })

  it('never selects this process (the OG server) even when its cwd matches', () => {
    expect(pidsWithCwdUnder(`p${process.pid}\nfcwd\nn/w/a\np10\nfcwd\nn/w/a\n`, '/w/a')).toEqual([10])
  })

  it('stops only TTY-less candidates with no terminal anywhere below them', () => {
    const ps = [
      '  10     1 ??', //       detached dev server…
      '  11    10 ??', //       …and its TTY-less child
      '  12     1 ttys003', //  the owner's shell
      '  20     1 ?', //        tmux server (Linux tty column)…
      '  21    20 ?', //        …a session shell's parent…
      '  22    21 pts/1', //    …on a pty two levels down
      '  30     1 ??', //       not a candidate
    ].join('\n')
    expect(stoppablePids(ps, [10, 11, 12, 20, 99])).toEqual([10, 11])
  })

  it('a probe killed at the time limit (or by a signal) yields nothing — only exit 1 keeps stdout', () => {
    expect(stdoutOfFailedProbe({ killed: true, signal: 'SIGTERM', stdout: 'p1\nn/w/a' })).toBe('')
    expect(stdoutOfFailedProbe({ signal: 'SIGKILL', stdout: 'p1\nn/w/a' })).toBe('')
    expect(stdoutOfFailedProbe({ code: 'ENOBUFS', stdout: 'p1\nn/w/a' })).toBe('')
    expect(stdoutOfFailedProbe({ code: 1, stdout: 'p1\nn/w/a' })).toBe('p1\nn/w/a')
  })
})

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
