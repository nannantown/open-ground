// stuckProcessWatch — notice the ONE machine state OPEN GROUND can create and
// nobody can clean up: ORPHANED processes wedged in uninterruptible sleep.
//
// WHY THIS EXISTS (2026-07-28 machine-freeze post-mortem, docs/commander/
// 07-test-isolation-contract.md §7). A subprocess whose cwd is deleted while it
// runs can block inside a kernel call and never return. Such a process:
//   - ignores SIGKILL (signals are only delivered on the way out of the kernel),
//   - ignores execFile's own `timeout` (Node gives up; the process stays),
//   - is reparented to launchd when its parent exits, so restarting the app
//     (or claude, or the shell) never clears it,
//   - and is invisible: every caller degrades gracefully, so nothing reports an
//     error. It shows up only as "the whole machine feels heavy".
// 41 of them had accumulated (oldest 5h35m) before anyone connected the symptom
// to the cause — five and a half hours of a degraded machine, mass false-red
// test runs, and a wrong first diagnosis. The engineering cause is fixed
// (gitRepoGuard), but the DETECTION gap is worth closing on its own: whatever
// wedges next, the owner should hear it from the cockpit, not infer it.
//
// SCOPE — deliberately ONE condition, not a health dashboard. This module does
// not watch disk, memory, thermals or CPU. It watches a single state that is
// (a) something OPEN GROUND's own subprocesses can cause, (b) silently
// degrading, and (c) has exactly one remedy. That last property is what makes a
// notification useful: there is nothing to configure and nothing to try — a
// restart clears it, and nothing else does.
//
// NO AUTO-REMEDIATION ON PURPOSE. Do not add a "clean up" action here. These
// processes cannot be killed (measured: `kill -9` leaves them running). Code
// that tries to fix this would fail every time while looking like it worked.
//
// PRIVACY: reads `comm` (the executable), never `command` (the full argv). A
// swarm worker's argv carries its whole injected prompt; the executable name is
// all this check needs and all that reaches the notification.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { basename } from 'path'

const execFile = promisify(execFileCb)

/** A process that is orphaned, uninterruptible, and old enough that it is never
 *  coming back. */
export interface StuckProcess {
  pid: number
  /** Executable name only (basename of `comm`) — never the full argv. */
  command: string
  /** Seconds since the process started. */
  ageSeconds: number
  /** Raw `ps` state field (e.g. 'U', 'Us', 'D+'). */
  state: string
}

/** Ignore anything younger than this. A D-state of a few seconds is ORDINARY —
 *  it is just a process waiting on disk. Only a wedge lasts. 10 minutes is far
 *  beyond any legitimate I/O stall while still catching a fresh leak long before
 *  it degrades the machine (the 2026-07-28 leak produced several within minutes). */
export const STUCK_MIN_AGE_SECONDS = 600

/** Say nothing below this count. One wedged process costs the machine nothing
 *  measurable; the owner would get an alarm with no consequence. The failure
 *  worth reporting is ACCUMULATION. Also the honest guard against the one
 *  plausible false positive in the wild — a disconnected network share (SMB/NFS)
 *  can leave a stuck process or two indefinitely on a perfectly fine machine. */
export const STUCK_MIN_COUNT = 3

/** Parse `ps` elapsed-time format into seconds: `MM:SS`, `HH:MM:SS`, or
 *  `DD-HH:MM:SS`. Returns null when unparseable (caller skips the row).
 *  macOS `ps` has NO `etimes` (numeric seconds) keyword — measured — so this
 *  formatted field is the only elapsed time available. Pure. */
export const parseElapsedSeconds = (etime: string): number | null => {
  const t = etime.trim()
  if (!t) return null
  const [dayPart, clockPart] = t.includes('-') ? t.split('-', 2) : ['0', t]
  const days = Number(dayPart)
  const parts = clockPart.split(':').map(Number)
  if (!Number.isFinite(days) || parts.some((n) => !Number.isFinite(n))) return null
  let h = 0
  let m = 0
  let s = 0
  if (parts.length === 3) [h, m, s] = parts
  else if (parts.length === 2) [m, s] = parts
  else return null
  return days * 86400 + h * 3600 + m * 60 + s
}

/** True for a state field meaning "blocked in the kernel, not interruptible".
 *  macOS reports `U` (uninterruptible wait) and `D` (disk wait); the trailing
 *  flags (`s`, `+`, …) are irrelevant, so only the first letter is read. Pure. */
export const isUninterruptible = (state: string): boolean =>
  state.startsWith('U') || state.startsWith('D')

/** Parse the output of `ps -axo pid=,ppid=,stat=,etime=,comm=` into the stuck
 *  set. Kept pure + exported so the whole predicate is unit-tested without
 *  spawning anything or needing a wedged machine to reproduce.
 *
 *  All THREE conditions must hold:
 *    1. PPID === 1 — orphaned. A stuck child with a LIVE parent may still be
 *       something legitimately busy that its parent is waiting on; only an
 *       orphan is guaranteed to have nobody left to reap it.
 *    2. uninterruptible state — the un-killable part.
 *    3. old enough — see {@link STUCK_MIN_AGE_SECONDS}. */
export const parseStuckProcesses = (
  psOutput: string,
  minAgeSeconds: number = STUCK_MIN_AGE_SECONDS,
): StuckProcess[] => {
  const out: StuckProcess[] = []
  for (const line of psOutput.split('\n')) {
    // pid ppid stat etime comm — comm may contain spaces in a path, so it is
    // everything after the 4th field, not split(' ')[4].
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/)
    if (!m) continue
    const [, pidS, ppidS, state, etime, comm] = m
    if (Number(ppidS) !== 1) continue
    if (!isUninterruptible(state)) continue
    const ageSeconds = parseElapsedSeconds(etime)
    if (ageSeconds === null || ageSeconds < minAgeSeconds) continue
    out.push({ pid: Number(pidS), command: basename(comm.trim()), ageSeconds, state })
  }
  return out
}

/** Scan the process table. Returns [] on Windows (no equivalent state: this is a
 *  Unix `ps` + uninterruptible-sleep concept) and [] on ANY failure — a health
 *  check must never be the thing that breaks boot. */
export const findStuckProcesses = async (opts?: {
  minAgeSeconds?: number
}): Promise<StuckProcess[]> => {
  if (process.platform === 'win32') return []
  try {
    const { stdout } = await execFile('ps', ['-axo', 'pid=,ppid=,stat=,etime=,comm='], {
      timeout: 10_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return parseStuckProcesses(stdout, opts?.minAgeSeconds ?? STUCK_MIN_AGE_SECONDS)
  } catch {
    return []
  }
}

/** Group by executable for the owner-facing line: `git×41, node×2`. Pure. */
export const summarizeByCommand = (procs: StuckProcess[]): string => {
  const counts: Record<string, number> = {}
  for (const p of procs) counts[p.command] = (counts[p.command] ?? 0) + 1
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cmd, n]) => `${cmd}×${n}`)
    .join(', ')
}

/** The notification body. Written for the OWNER, who is not required to know
 *  what a process state is: what happened, what it costs, what to do. No PID
 *  list, no jargon, and NO suggestion to "kill" anything — that does not work
 *  (§7.3). The executable summary is included because it is the one detail that
 *  points at the cause when someone does investigate. */
export const describeStuckProcesses = (procs: StuckProcess[]): string => {
  const oldestMin = Math.floor(Math.max(...procs.map((p) => p.ageSeconds)) / 60)
  return (
    `動かなくなった処理が${procs.length}個たまっています(${summarizeByCommand(procs)}、最長${oldestMin}分)。` +
    `放置するとマシン全体が重くなります。これは終了させることができないため、` +
    `パソコンを再起動すると消えます。`
  )
}

/** ONE scan + at most one notification. Returns the stuck set (empty when there
 *  is nothing to say) so callers/tests can assert without reading notifications.
 *  Never throws.
 *
 *  Fires only at/above {@link STUCK_MIN_COUNT}; `notify` is injected so the test
 *  suite never touches the real notification store. */
export const checkStuckProcessesOnce = async (opts?: {
  minAgeSeconds?: number
  minCount?: number
  notify?: (detail: string) => Promise<unknown>
}): Promise<StuckProcess[]> => {
  const procs = await findStuckProcesses({ minAgeSeconds: opts?.minAgeSeconds })
  if (procs.length < (opts?.minCount ?? STUCK_MIN_COUNT)) return []
  if (opts?.notify) await opts.notify(describeStuckProcesses(procs)).catch(() => {})
  return procs
}
