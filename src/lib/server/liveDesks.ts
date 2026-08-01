// liveDesks — "what is running right now?", asked ONCE across BOTH desk pools.
//
// WHY THIS MODULE EXISTS, AND WHY IT IS THE ONLY RIGHT ANSWER TO THE QUESTION.
// OPEN GROUND runs desks on two runtimes with two independent pools: PTY
// sessions (terminal.ts) and Agent SDK sessions (sdkSession.ts). A caller that
// asks only one of them does not get a partial answer — it gets a CONFIDENTLY
// WRONG one, and both shapes of that wrongness are harmful:
//
//   • "nothing is live in this directory" AUTHORISES DESTRUCTION.
//     worktreeCleanup's liveness guard read the PTY pool alone, so with the SDK
//     worker dial on, every SDK worker's worktree read as abandoned — clean
//     tree, no PTY — and was `git worktree remove`d while claude was still
//     working in it. Its own comment states the rule it was breaking: "Deleting
//     a running session's cwd out from under it is never acceptable; the pool
//     knows every live cwd." The pool did. The other pool did not.
//
//   • "nothing is happening in this project" IS A LIE TO THE OWNER.
//     The Ground card's beacon is the ONLY signal that a project is busy. Read
//     from the PTY pool alone, a project whose work is entirely on SDK workers
//     shows a quiet card while claude runs — the same "it looks idle but it
//     isn't" class as the dead-worker-shows-running incident, inverted.
//
// This is the lesson swarmManagerRuntime.ts learned for desk PRESENCE ("one seam
// that asks both pools, so the two can never disagree"), generalised. Put every
// new "who is alive / where / doing what" question HERE rather than re-deriving
// it at a call site: a second pool is exactly the kind of thing a call site
// forgets, and this file is where the next reader will look.

import { listActiveTerminalCwds, listActiveTerminals, killTerminalsByCwdAndWait } from './terminal'
import {
  isSdkSessionLive,
  listActiveSdkCwds,
  listSdkSessions,
  terminateSdkSessionsInDir,
  isSdkSessionReaped,
} from './sdkSession'
import type { ActiveTerminalsResponse, ClaudeBeaconStatus } from '../types'

/** Every directory a LIVE desk is working in, from BOTH pools. Deduped, unordered.
 *
 *  Deliberately includes hidden/utility sessions (a background titling run is a
 *  real process whose tree must not vanish under it) and 'starting' SDK sessions
 *  (spawned, first message not yet seen — still a live process). Excludes only
 *  desks that have actually finished.
 *
 *  Raw cwds, in whatever normalization each pool stored: callers that compare
 *  against canonicalized paths must canonicalize these too (worktreeCleanup
 *  does — a symlink-only difference silently turns a live tree into a reapable
 *  one, which is the failure this list exists to prevent). */
export const listAllLiveDeskCwds = (): string[] =>
  Array.from(new Set([...listActiveTerminalCwds(), ...listActiveSdkCwds()]))

/** An SDK session's lifecycle status, as the Ground's two-state beacon.
 *
 *  'starting' counts as WORKING: the session is spawned and its first turn is
 *  already queued, so a card that showed nothing there would be dark during
 *  precisely the seconds the owner is watching for it to come up.
 *
 *  'quota-parked' counts as WAITING: the desk has stopped and needs a human —
 *  the same meaning 'waiting' carries for a PTY (claude sits on its turn), and
 *  the honest one to draw. Silence would read as "finished". */
const beaconStatusOfSdk = (s: {
  status: string
  reaped?: boolean
}): ClaudeBeaconStatus | null => {
  // Liveness first, and by the SAME predicate `listAllLiveDeskCwds` uses two
  // functions above. Deriving it from `status` made this one file contradict
  // itself: the cleaner was told the tree is occupied while the Ground card went
  // dark — one of them is lying, and the dark card is the one that misleads the
  // owner into thinking the project is idle.
  if (!isSdkSessionLive(s)) return null
  if (s.status === 'working' || s.status === 'starting') return 'working'
  if (s.status === 'waiting' || s.status === 'quota-parked') return 'waiting'
  // Still live but in a terminal-looking state: it was asked to stop and has not
  // gone yet. 'waiting' is the honest draw — something is there, needing nothing.
  return 'waiting'
}

/** The Ground beacon's data, from BOTH pools.
 *
 *  SDK sessions join `claude` (they ARE claude — that is the whole point of the
 *  runtime) keyed by their SDK session id, which is the same key the SDK tile
 *  addresses them by, so a per-session consumer can still find its own.
 *  `cwds` gains theirs too, so the plain "something is running here" indicator
 *  lights for an all-SDK project. */
/**
 * Stop EVERY desk working in `dir` — on both runtimes — and wait until each has
 * really gone. Returns false when something is still there after the budget, in
 * which case the caller MUST NOT delete the directory.
 *
 * WHY WAITING IS THE POINT, NOT THE STOPPING. Removing a directory while claude
 * is running in it is how OPEN GROUND manufactured its own un-killable orphans:
 * claude shells out to `git` constantly, and a delete landing mid-run wedges the
 * process in uninterruptible sleep where no signal and no timeout can reach it
 * again (the 2026-07-28 machine-freeze). The PTY side learned this and grew
 * `killTerminalsByCwdAndWait`.
 *
 * That function, however, answers only for the PTY pool — and it answers `true`
 * ("nothing to wait for") when it finds no sessions, which is EXACTLY what an
 * SDK worker's worktree looks like to it. So the safety gate read "clear" for
 * every SDK worker and the tree was removed under a live claude.
 *
 * The SDK arm must also wait on the RIGHT signal: `terminateSdkSession` sets
 * `closed`/`exited` synchronously (it only asks), so a wait built on
 * `isSdkSessionAlive` returns on its first poll and gates nothing. It waits on
 * `reaped` — the pump's iterator having actually returned.
 */
export const stopAllDesksInDirAndWait = async (
  dir: string,
  opts: {
    timeoutMs?: number
    pollMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
    /** Injected for tests. */
    killPtys?: typeof killTerminalsByCwdAndWait
    terminateSdk?: typeof terminateSdkSessionsInDir
    sdkReaped?: typeof isSdkSessionReaped
  } = {},
): Promise<boolean> => {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const pollMs = opts.pollMs ?? 50
  const now = opts.now ?? Date.now
  const nap = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const killPtys = opts.killPtys ?? killTerminalsByCwdAndWait
  const stopSdk = opts.terminateSdk ?? terminateSdkSessionsInDir
  const reaped = opts.sdkReaped ?? isSdkSessionReaped

  // Ask BOTH to stop before waiting on either, so their unwind windows overlap
  // instead of adding up.
  const sdkIds = stopSdk(dir)
  const ptyGone = await killPtys(dir, { timeoutMs, pollMs })
  if (!sdkIds.length) return ptyGone

  const deadline = now() + timeoutMs
  for (;;) {
    if (sdkIds.every((id) => reaped(id))) return ptyGone
    if (now() >= deadline) return false // still occupied — refuse the delete
    await nap(pollMs)
  }
}

export const listAllActiveDesks = (): ActiveTerminalsResponse => {
  const pty = listActiveTerminals()
  const cwds = new Set(pty.cwds)
  const claude = [...pty.claude]
  for (const s of listSdkSessions()) {
    const status = beaconStatusOfSdk(s)
    if (!status) continue
    cwds.add(s.cwd)
    claude.push({ id: s.id, cwd: s.cwd, status })
  }
  return { cwds: Array.from(cwds), claude }
}
