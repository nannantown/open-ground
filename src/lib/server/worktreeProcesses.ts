// Stop the processes a worker left running inside its worktree (2026-10-03).
//
// Measured: a worker started `npm run dev:alt` (concurrently → tsx watch + vite)
// detached in its worktree. The quota teardown stopped the desk session and
// removed the worktree, but those 4 processes ran on for 3 h 44 min, and vite kept
// writing `.vite/deps` back into the vanished directory — the debris that later
// made `git worktree add` refuse the re-entry (docs/commander/02 §5.3b).
//
// Selection, both must hold:
//   1. CWD inside the worktree (the worktree itself or under it) — other worktrees
//      and the project root are never touched. Read via `lsof -d cwd -Fpn` (macOS /
//      Linux; `man lsof`: `-d cwd` selects the current-working-directory descriptor,
//      `-F pn` prints `p<pid>` / `n<path>` field lines). lsof keeps reporting the
//      old path after the directory was deleted, so a process that outlived an
//      earlier removal is still found.
//   2. NO TERMINAL IN ITS SUBTREE: neither the process nor any descendant has a
//      controlling terminal (`ps -axo pid=,ppid=,tty=`, `??` / `?` = none). A shell
//      the owner `cd`'d into the worktree from Terminal.app / iTerm / VS Code / an
//      OG terminal pane has a TTY itself. But a program that HOLDS terminals can be
//      TTY-less: a tmux server keeps the directory it was first started in as its
//      cwd while every session under it runs on a pty (reviewer-measured), and an
//      app hosting a claude may do the same. Stopping it would kill every terminal
//      beneath it, so a candidate with a TTY anywhere below is left alone too.
//      What a worker leaves behind has neither: SDK workers run without a TTY, so
//      everything their Bash tool starts (a detached dev server, a watcher) and its
//      children are TTY-less.
// No lsof (Windows) ⇒ no-op. An unreadable or cut-off probe ⇒ nothing is stopped.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { canonicalize } from './canonicalize'

const execFile = promisify(execFileCb)

/** A stuck lsof/ps must never hold a teardown: give up (stop nothing) after this. */
const PROBE_LIMIT_MS = 10_000

/** Parse `lsof -d cwd -Fpn` output into the pids whose cwd is `dir` or under it.
 *  `dir` must be in the same (realpath'd) form lsof prints. Never this process. */
export const pidsWithCwdUnder = (lsofOut: string, dir: string): number[] => {
  const root = dir.replace(/\/+$/, '')
  const pids = new Set<number>()
  let pid = 0
  for (const line of lsofOut.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || 0
    else if (line.startsWith('n') && pid > 0) {
      const p = line.slice(1)
      if (p === root || p.startsWith(root + '/')) pids.add(pid)
    }
  }
  pids.delete(process.pid)
  return Array.from(pids)
}

/** From `ps -axo pid=,ppid=,tty=` output, the `candidates` that may be stopped:
 *  listed, no controlling terminal, and no descendant with one. A candidate ps
 *  does not list is not stopped (it is gone, or the table is incomplete). */
export const stoppablePids = (psOut: string, candidates: number[]): number[] => {
  const children = new Map<number, number[]>()
  const hasTty = new Map<number, boolean>()
  for (const line of psOut.split('\n')) {
    const [pid, ppid, tty] = line.trim().split(/\s+/)
    if (!/^\d+$/.test(pid ?? '') || !/^\d+$/.test(ppid ?? '') || !tty) continue
    hasTty.set(+pid, tty !== '??' && tty !== '?')
    children.set(+ppid, [...(children.get(+ppid) ?? []), +pid])
  }
  const terminalBelow = (pid: number, seen = new Set<number>()): boolean => {
    if (seen.has(pid)) return false
    seen.add(pid)
    return hasTty.get(pid) === true || (children.get(pid) ?? []).some((c) => terminalBelow(c, seen))
  }
  return candidates.filter((pid) => hasTty.has(pid) && !terminalBelow(pid))
}

/** What a failed probe's output is worth. lsof exits 1 when it could not read
 *  some processes (other users') — the readable part on stdout is complete for
 *  the rest. A probe that was KILLED (time limit) or died on a signal left a
 *  cut-off listing: a truncated path line could match a neighbouring directory,
 *  so it is worth nothing. Anything else: nothing. */
export const stdoutOfFailedProbe = (e: { code?: unknown; killed?: unknown; signal?: unknown; stdout?: unknown }): string =>
  !e?.killed && !e?.signal && e?.code === 1 && typeof e.stdout === 'string' ? e.stdout : ''

/** stdout of a probe command, '' on failure or past PROBE_LIMIT_MS. */
const probe = (cmd: string, args: string[]): Promise<string> => {
  const run = execFile(cmd, args, { timeout: PROBE_LIMIT_MS, maxBuffer: 32 * 1024 * 1024 })
    .then((r) => r.stdout)
    .catch(stdoutOfFailedProbe)
  // execFile's own timeout only SIGTERMs; a probe wedged in uninterruptible sleep
  // never exits, and the promise would wait for it. Race it instead.
  const limit = new Promise<string>((r) => setTimeout(() => r(''), PROBE_LIMIT_MS + 1_000).unref())
  return Promise.race([run, limit])
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as { code?: string })?.code === 'EPERM'
  }
}

/** One machine-wide cwd listing (`lsof -d cwd -Fpn`), '' when unavailable. A
 *  caller removing several worktrees reads it once and hands it to each
 *  {@link stopProcessesInDir} — processes only disappear meanwhile, never move in
 *  (a worktree not yet removed is still selected by its own listing line). */
export const readCwdTable = (): Promise<string> =>
  process.platform === 'win32' ? Promise.resolve('') : probe('lsof', ['-d', 'cwd', '-Fpn'])

/** SIGTERM every process whose cwd is inside `dir` and that has no terminal in its
 *  subtree, then SIGKILL whatever is still there after `graceMs`. Best-effort,
 *  never throws. Returns the pids signalled. `cwdTable`: a {@link readCwdTable}
 *  result to reuse (else read here). */
export const stopProcessesInDir = async (
  dir: string,
  opts: { graceMs?: number; cwdTable?: string } = {},
): Promise<number[]> => {
  if (process.platform === 'win32') return []
  const graceMs = opts.graceMs ?? 3_000
  // lsof prints the realpath (macOS: /private/tmp, /private/var); the caller may
  // hold the raw form. Match both.
  const forms = Array.from(new Set([dir, await canonicalize(dir).catch(() => dir)]))
  const out = opts.cwdTable ?? (await readCwdTable())
  const inDir = Array.from(new Set(forms.flatMap((f) => pidsWithCwdUnder(out, f))))
  if (inDir.length === 0) return []
  const pids = stoppablePids(await probe('ps', ['-axo', 'pid=,ppid=,tty=']), inDir)
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + graceMs
  while (Date.now() < deadline && pids.some(alive)) await new Promise((r) => setTimeout(r, 100))
  for (const pid of pids.filter(alive)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  return pids
}
