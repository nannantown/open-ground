// Full-suite gate — at most FULL_SUITE_LIMIT whole-suite vitest runs at once
// across every checkout/worktree of this repo; the rest wait in line.
//
// WHY (owner decision 2026-09-26, card 「作業係のテストの回し方を変える」). The
// machine-slowness investigations (docs/research/20260926-*.md) measured the
// main cause: eight workers each running the whole ~7,300-test suite with
// vitest's default pool (cores-1 = 10 forks) at the same time — load 360-720 on
// 11 cores, 0.2 GB free memory, swap growing. Workers now run only the related
// tests while working and the full suite once before `ready`; this file is the
// part that does not depend on a worker obeying that: whoever starts a full run
// waits here, in the vitest process itself, until a slot is free.
//
// WHERE. vitest.config.ts calls enterFullSuiteGate() at config-load time — the
// one place every `npm test` / `npx vitest run` in this repo passes through.
// Filtered runs (`vitest run <path>`, `--changed`, `vitest related`) are not
// gated: they are the cheap "while working" runs.
//
// HOW. A tiny state file (`running` / `waiting` lists of {pid, seen}) under
// <git-common-dir>/og-test-gate/, edited only while holding a mkdir mutex.
// The git common dir is shared by the primary checkout and every worktree (all
// swarm workers are worktrees of the same repo) and does not move when HOME /
// OPENGROUND_HOME / TMPDIR are rewritten for a child process.
// An entry is dropped when its pid is dead (crash / SIGKILL: freed on the next
// look) OR its `seen` stamp is older than STALE_MS (pid reuse: the holder
// re-stamps every TOUCH_MS, a waiter on every poll). Nothing can hold a slot
// forever. Waiters are admitted in arrival order.

import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { availableParallelism } from 'os'
import { join, resolve } from 'path'
import { parseCLI } from 'vitest/node'
import { cleanTree, git, writeRunRecord } from './fullSuiteRecord'

export const FULL_SUITE_LIMIT = 2
const STALE_MS = 180_000
/** A full run takes 2-7 min here; a slot held this long is a hung/orphaned run. */
const MAX_RUN_MS = 60 * 60_000
const TOUCH_MS = 10_000
const POLL_MS = 2_000
const MUTEX_STALE_MS = 10_000

type Entry = { pid: number; seen: number; since?: number }
type State = { running: Entry[]; waiting: Entry[] }

export interface GateOptions {
  dir: string
  pid: number
  limit?: number
  now?: () => number
  isAlive?: (pid: number) => boolean
}

export interface GateResult {
  admitted: boolean
  /** Full runs sharing the machine right now: running (incl. me) + still waiting, capped at the limit. */
  sharing: number
  /** My place in line (0 = next), -1 once admitted. */
  position: number
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Run `fn` on the state while holding the directory mutex. Synchronous so it
 *  also works from a process 'exit' handler. */
function withState<T>(dir: string, fn: (s: State) => T): T {
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, 'lock')
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      // The critical section is a few ms of sync fs; a lock this old belongs to
      // a process that died inside it. Real clock on every spin (a frozen `now`
      // would never see the lock age).
      // ponytail: two reapers racing on one dead lock can briefly both enter;
      // needs a crash inside a ms-long window AND a race, so not worth flock.
      try {
        if (Date.now() - statSync(lock).mtimeMs > MUTEX_STALE_MS) rmSync(lock, { recursive: true, force: true })
      } catch {
        /* gone already */
      }
      sleepSync(5)
    }
  }
  try {
    const file = join(dir, 'state.json')
    let state: State = { running: [], waiting: [] }
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<State>
      if (Array.isArray(raw.running) && Array.isArray(raw.waiting)) state = raw as State
    } catch {
      /* missing or torn file = empty line; never a permanent block */
    }
    const out = fn(state)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
    return out
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function prune(s: State, o: GateOptions, now: number): void {
  const alive = o.isAlive ?? pidAlive
  const live = (e: Entry) => e.pid === o.pid || (alive(e.pid) && now - e.seen < STALE_MS)
  s.running = s.running.filter((e) => live(e) && (e.pid === o.pid || now - (e.since ?? e.seen) < MAX_RUN_MS))
  s.waiting = s.waiting.filter(live)
}

/** One look at the line: prune the dead, take a slot if it is my turn,
 *  otherwise (re)register as a waiter. */
export function tryEnter(o: GateOptions): GateResult {
  const limit = o.limit ?? FULL_SUITE_LIMIT
  const now = (o.now ?? Date.now)()
  return withState(o.dir, (s) => {
    prune(s, o, now)
    const sharing = () => Math.min(limit, s.running.length + s.waiting.length)
    const mine = s.running.find((e) => e.pid === o.pid)
    if (mine) {
      mine.seen = now
      return { admitted: true, sharing: sharing(), position: -1 }
    }
    let idx = s.waiting.findIndex((e) => e.pid === o.pid)
    if (idx < 0) idx = s.waiting.push({ pid: o.pid, seen: now }) - 1
    else s.waiting[idx].seen = now
    if (idx < limit - s.running.length) {
      s.waiting.splice(idx, 1)
      s.running.push({ pid: o.pid, seen: now, since: now })
      return { admitted: true, sharing: sharing(), position: -1 }
    }
    return { admitted: false, sharing: sharing(), position: idx - (limit - s.running.length) }
  })
}

/** A running holder's stamp. If its entry was dropped meanwhile (machine slept
 *  past STALE_MS) it goes straight back into `running` — it IS running — never
 *  into the waiting line, which would free its slot for a third run. */
export function touch(o: GateOptions): void {
  const now = (o.now ?? Date.now)()
  withState(o.dir, (s) => {
    prune(s, o, now)
    s.waiting = s.waiting.filter((e) => e.pid !== o.pid)
    const mine = s.running.find((e) => e.pid === o.pid)
    if (mine) mine.seen = now
    else s.running.push({ pid: o.pid, seen: now, since: now })
  })
}

/** Leave the line / give the slot back. Idempotent. */
export function leave(o: GateOptions): void {
  withState(o.dir, (s) => {
    s.running = s.running.filter((e) => e.pid !== o.pid)
    s.waiting = s.waiting.filter((e) => e.pid !== o.pid)
  })
}

/** Is this vitest invocation a whole-suite run? Anything that narrows the file
 *  set (a path filter, `--changed`, `related`) is not; `list`/`bench`/`init`
 *  run no tests. `-t <name>` still loads every file, so it counts as full. */
export function isFullRun(argv: string[]): boolean {
  if (['related', 'list', 'bench', 'init'].includes(argv[0])) return false
  const { filter, options } = parseCLI(['vitest', ...argv])
  return filter.length === 0 && !options.changed
}

/** May this run's result stand for "the whole suite passed"? Stricter than
 *  isFullRun: only a plain `vitest run` (= `npm test`), optionally with
 *  `--reporter=x`. `-t`, `--shard`, `--project`, `--bail`, watch mode… or any
 *  flag not listed here => no record, so the commander runs the suite itself
 *  (unknown = safe). */
export function recordsPass(argv: string[]): boolean {
  return argv[0] === 'run' && argv.slice(1).every((a) => /^--reporter=[\w-]+$/.test(a))
}

/** Fork count for one full run when `sharing` full runs share the machine:
 *  undefined (= vitest's own default, cores-1) when alone, else an even split. */
export function workersFor(sharing: number, cores = availableParallelism()): number | undefined {
  return sharing <= 1 ? undefined : Math.max(1, Math.floor((cores - 1) / sharing))
}

function quietly(fn: () => void): void {
  try {
    fn()
  } catch {
    /* a gate bookkeeping error must never kill a test run; the slot then
       frees itself by pid death / stale stamp */
  }
}

/**
 * Where the line lives: <git-common-dir>/og-test-gate, the same directory for
 * the primary checkout and every `git worktree add` of it. Plain
 * `--git-common-dir` (relative `.git` in the primary, absolute in a worktree),
 * resolved against `cwd` — NOT `--path-format=absolute`: that flag is git 2.31+,
 * and an older git (the owner's PATH has 2.28) echoes the flag back as an extra
 * output line instead of failing, which turned the line into a per-worktree
 * directory named "--path-format=absolute\n…" (2026-09-26 rework). Anything but
 * one line naming an existing directory => null = run ungated.
 */
export function gateDir(cwd = process.cwd(), run: typeof git = git): string | null {
  const out = run(['rev-parse', '--git-common-dir'], cwd)
  if (!out || out.includes('\n')) return null
  try {
    const abs = realpathSync(resolve(cwd, out))
    return statSync(abs).isDirectory() ? join(abs, 'og-test-gate') : null
  } catch {
    return null
  }
}

/** Wait in line until admitted. A bookkeeping failure (mkdir / rename / a
 *  state dir that is not a directory) resolves null = run ungated: the gate
 *  must never be the reason a test run fails. */
export async function waitForSlot(o: GateOptions): Promise<GateResult | null> {
  const look = () => {
    try {
      return tryEnter(o)
    } catch (e) {
      process.stderr.write(`[full-suite gate] bookkeeping failed, running without the queue: ${(e as Error).message}\n`)
      return null
    }
  }
  let r = look()
  let said = 0
  while (r && !r.admitted) {
    if (Date.now() - said > 60_000) {
      said = Date.now()
      process.stderr.write(
        `[full-suite gate] ${FULL_SUITE_LIMIT} full test runs already going on this machine; ` +
          `you are #${r.position + 1} in line. Starts by itself.\n`,
      )
    }
    await new Promise((res) => setTimeout(res, POLL_MS))
    r = look()
  }
  return r
}

/**
 * Called by vitest.config.ts. For a full run: waits for a slot, keeps it
 * stamped, and on process exit frees it and records the exit code for the
 * tested tree. Returns the fork cap, or null for filtered runs, nested runs
 * and outside git.
 */
export async function enterFullSuiteGate(argv = process.argv.slice(2)) {
  // A vitest started from inside a test worker inherits these; it must not
  // queue behind the run that spawned it.
  if (process.env.VITEST_WORKER_ID || process.env.VITEST_POOL_ID) return null
  if (!isFullRun(argv)) return null
  const dir = gateDir()
  const gitDir = git(['rev-parse', '--absolute-git-dir'])
  if (!dir || !gitDir) return null
  const o: GateOptions = { dir, pid: process.pid }

  const r = await waitForSlot(o)
  if (!r) return null

  const timer = setInterval(() => quietly(() => touch(o)), TOUCH_MS)
  timer.unref()
  const startTree = recordsPass(argv) ? cleanTree() : null
  process.on('exit', (code) => {
    clearInterval(timer)
    quietly(() => leave(o))
    quietly(() => writeRunRecord(gitDir, startTree, code))
  })

  const maxWorkers = workersFor(r.sharing)
  if (maxWorkers) process.stderr.write(`[full-suite gate] sharing the machine with another full run: maxWorkers=${maxWorkers}\n`)
  return { maxWorkers }
}
