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

import {
  listActiveTerminalCwds,
  listActiveTerminals,
  listPtySafetyViews,
  killTerminalsByCwdAndWait,
} from './terminal'
import {
  isSdkSessionLive,
  listActiveSdkCwds,
  listSdkSessions,
  terminateSdkSessionsInDir,
  isSdkSessionReaped,
} from './sdkSession'
import type { SdkSessionStatus } from './sdkEvents'
import { canonicalize } from './canonicalize'
import { projectsDataRootDir } from './paths'
import { sep } from 'path'
import { execFile } from 'node:child_process'
import type {
  ActiveTerminalsResponse,
  ClaudeBeaconStatus,
  UpdateRestartSafetyResponse,
} from '../types'

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

/** {@link listAllLiveDeskCwds}, canonicalized — the form every path comparison
 *  must use. Symlinks are the reason: `~/.openground` is routinely a symlinked
 *  home, and a symlink-only difference makes an occupied directory read as free.
 *
 *  Injectable so the matching rule can be tested without a pool or a filesystem. */
export const canonicalLiveDeskCwds = async (
  opts: { listCwds?: () => string[]; canon?: (p: string) => Promise<string> } = {},
): Promise<string[]> => {
  const list = opts.listCwds ?? listAllLiveDeskCwds
  const canon = opts.canon ?? canonicalize
  return Promise.all(list().map((cwd) => canon(cwd)))
}

/** Does any of `liveCwds` sit AT `canonDir` or underneath it? Pure, and the ONE
 *  place this comparison is written — a desk that `cd`s deeper into its own
 *  worktree is still occupying it, and a prefix test without the separator would
 *  also match a sibling whose name merely starts the same way. */
export const isDirOccupied = (liveCwds: readonly string[], canonDir: string): boolean =>
  liveCwds.some((cwd) => cwd === canonDir || cwd.startsWith(canonDir + sep))

/** Is a desk — on EITHER runtime — already working in `dir`?
 *
 *  ⚠ THIS IS THE QUESTION A SPAWN MUST ASK BEFORE REUSING A DIRECTORY, and the
 *  reason it lives here rather than at the call site is that 2026-08-03 proved
 *  the call site forgets: spawnSwarmWorker's RESTART path relaunched into an
 *  existing worktree with no occupancy check at all. A card sent back to `doing`
 *  got a second worker while its FIRST one — an SDK session, so invisible to any
 *  PTY-shaped check — was still editing files there. Two claudes, one worktree,
 *  one shared `swarm/*` branch, and no `dispatch:` line in the engine log because
 *  the engine had not dispatched it.
 *
 *  Answers TRUE on a canonicalization failure? No — canonicalize is what throws
 *  there, and the caller treats a throw as "cannot prove it is free", which is
 *  the safe direction for a spawn. */
export const liveDeskOccupies = async (
  dir: string,
  opts: { listCwds?: () => string[]; canon?: (p: string) => Promise<string> } = {},
): Promise<boolean> => {
  const canon = opts.canon ?? canonicalize
  return isDirOccupied(await canonicalLiveDeskCwds(opts), await canon(dir))
}

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

// ─── Auto-update restart safety ─────────────────────────────────────────────
// "May the Electron shell restart the app RIGHT NOW to apply a downloaded
// update?" — a who-is-alive question, so it lives HERE (both pools, one seam).
//
// The policy (2026-08-03, hands-free updates):
//   BLOCKS:  claude mid-generation in either pool (the in-flight turn is
//            unrecoverable), and any visible user PTY pane (a user terminal —
//            claude or plain shell — is user state with no resume machinery).
//   ALLOWS:  resting desks (補給官/司令官 — conversation resume by design),
//            swarm workers at rest in the central worktrees area (roster
//            recovery + conversation resume, and their edits live on disk),
//            hidden utility sessions not generating, and quota-parked SDK
//            sessions (parked BECAUSE nothing can proceed).


/**
 * Does this shell have anything running under it?
 *
 * ⚠ THE HOLE THIS CLOSES, measured 2026-08-04 with a throwaway node-pty:
 *   idle shell                  .process = "zsh"
 *   foreground `sleep 60`       .process = "sleep"
 *   **`sleep 300 &`, prompt back  .process = "zsh"**
 *   `less`                      .process = "less"
 * The third line is the whole problem. A background job — a build, a test run,
 * anything the user launched with `&` — leaves the SHELL in front, so the
 * foreground check alone reads it as an empty pane. Ten minutes of silence later
 * the gate would have called it abandoned and restarted on top of live work.
 *
 * Fails CLOSED in every direction it cannot answer: an unknown pid, a platform
 * without pgrep, a spawn error or a timeout all report "has children", because
 * the cost of a false "empty" is destroying someone's work and the cost of a
 * false "busy" is waiting for the next five-minute tick.
 */
const hasChildProcesses = async (pid: number): Promise<boolean> => {
  if (!pid || process.platform === 'win32') return true
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (v: boolean) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const child = execFile('pgrep', ['-P', String(pid)], { timeout: 2000 }, (err, stdout) => {
        // pgrep exits 1 with no output when there are no matches — that, and
        // only that, is a genuine "no children".
        if (err && (err as NodeJS.ErrnoException).code !== undefined && !stdout) {
          const code = (err as unknown as { code?: number }).code
          done(code !== 1)
          return
        }
        if (err && !stdout) return done(true)
        done(stdout.trim().length > 0)
      })
      child.on('error', () => done(true))
    } catch {
      done(true)
    }
  })
}

/** A pane whose foreground process is the login shell itself has nothing running
 *  in it. Deliberately an exact list rather than a pattern: an unknown value
 *  (including the empty string an unreadable pty yields) counts as WORK. */
const LOGIN_SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'dash', 'ksh', '-zsh', '-bash'])

/** How long a shell must also have been silent before it counts as abandoned. */
export const IDLE_PANE_MS = 10 * 60 * 1000

/** Pure core, unit-tested directly (updateRestartSafety.test.ts). `engine` on a
 *  PTY view means its cwd sits under the central data root — engine-owned.
 *
 *  ⚠ WHAT `userPtys` COUNTS, and why it changed on 2026-08-04.
 *  It used to count every visible user pane, full stop. That reads "a pane is
 *  open" as "work is happening", and those are not the same thing — measured on
 *  the owner's own machine, the two panes blocking every unattended update were
 *  `/bin/zsh -l` with ZERO child processes, sitting untouched for 1h23m. The
 *  gate wanted zero panes from someone who always has a terminal open, so it
 *  answered "unsafe" forever and the feature never once fired.
 *
 *  A safety gate that never opens is not caution, it is a disabled feature with
 *  a reassuring name. So the question is now "would a restart destroy anything?"
 *  — and it takes TWO signals to answer no: the login shell is in front (nothing
 *  is running) AND the pane has been silent for {@link IDLE_PANE_MS}. Either one
 *  alone is a known trap: a foreground `claude` can go minutes without painting,
 *  and a shell can be idle for a second between commands.
 *
 *  Everything else is unchanged and still blocks: claude working in either pool,
 *  any pane running anything at all, and any pane whose state cannot be read. */
export const computeRestartSafety = (
  // ⚠ REQUIRED, not optional — `| undefined` rather than `?`. Review caught the
  // first version shipping with these optional: `updateRestartSafety()` below
  // re-packs each row into a fresh literal, and it simply did not copy the two
  // new fields. `foreground` arrived as undefined, `LOGIN_SHELLS.has('')` was
  // false, and the entire relaxation never fired in production — while all
  // twelve unit tests, which call this function directly with complete rows,
  // stayed green. tsc said nothing, because optional means optional.
  // Requiring the KEY (its value may still be undefined, which reads as "cannot
  // tell" and fails closed) turns that silent omission into a build error. This
  // is the repo's own rule: prefer over-approximation you cannot miss to an
  // existence check that goes quiet.
  ptys: readonly {
    desk: boolean
    hidden: boolean
    engine: boolean
    claudePane: boolean
    claudeWorking: boolean
    foreground: string | undefined
    lastOutputAt: number | undefined
    hasChildren: boolean | undefined
    /** ⚠ REQUIRED for the same reason the others are (see the note above): an
     *  optional key is a relaxation that silently never fires. */
    menuOpen: boolean | undefined
  }[],
  sdkStatuses: readonly SdkSessionStatus[],
  now: number = Date.now(),
): UpdateRestartSafetyResponse => {
  const generating =
    ptys.filter((p) => p.claudeWorking).length +
    sdkStatuses.filter((s) => s === 'working' || s === 'starting').length
  // THREE signals, and every one of them defaults to "busy" when absent.
  //   1. the login shell is in front  → nothing is running IN the pane
  //   2. it has no child processes    → and nothing is running BEHIND it
  //   3. it has been silent 10 min    → and nobody is sitting at it
  // Two would not do. (1) alone misses `npm test &` — measured: a backgrounded
  // job leaves `.process` reporting "zsh". (3) alone misses a foreground claude
  // thinking quietly. Together they describe an empty pane and nothing else.
  const silent = (p: { lastOutputAt?: number }): boolean =>
    now - (p.lastOutputAt ?? 0) >= IDLE_PANE_MS

  const abandonedShell = (p: {
    foreground?: string
    lastOutputAt?: number
    hasChildren?: boolean
  }): boolean =>
    LOGIN_SHELLS.has(p.foreground ?? '') && p.hasChildren === false && silent(p)

  /** A PARKED CLAUDE PANE (2026-08-15). The rule above only ever released a
   *  LOGIN SHELL, and this file's own comment said why claude was excluded:
   *  「Anything else (claude, npm, a build) is real work, however quiet」.
   *
   *  That is true of npm and of a build. It is not true of claude sitting at
   *  its prompt — and claude panes are precisely what this owner leaves open,
   *  so `userPtys` never reached 0, the gate never opened, and hands-free
   *  updates never applied ONCE despite being switched on. The failure was
   *  already recorded here for shells and fixed for shells only; the pane the
   *  owner actually keeps was left blocking.
   *
   *  Three signals, all required, every one defaulting to "busy" when absent:
   *    1. claude is NOT generating (`claudeWorking === false`),
   *    2. no TUI menu is open — a permission prompt is the human's turn, and no
   *       amount of silence makes discarding it acceptable,
   *    3. it has been silent for {@link IDLE_PANE_MS}.
   *  `menuOpen === undefined` (a caller that did not look) fails closed. */
  const parkedClaude = (p: {
    claudePane?: boolean
    claudeWorking?: boolean
    menuOpen?: boolean
    lastOutputAt?: number
  }): boolean =>
    // ⚠ `claudePane === true` FIRST, and it is the whole reason this is not
    // just "not working". Without it the rule released ANY quiet pane —
    // `npm test` sitting mid-run reports claudeWorking false, because it is not
    // claude at all. Caught by five existing guards the moment it was written;
    // they are the ones that say a user pane running something blocks however
    // quiet it has been.
    p.claudePane === true && p.claudeWorking === false && p.menuOpen === false && silent(p)

  const abandoned = (p: {
    foreground?: string
    lastOutputAt?: number
    hasChildren?: boolean
    claudePane?: boolean
    claudeWorking?: boolean
    menuOpen?: boolean
  }): boolean => abandonedShell(p) || parkedClaude(p)
  const userPtys = ptys.filter((p) => !p.desk && !p.hidden && !p.engine && !abandoned(p)).length
  return { safe: generating === 0 && userPtys === 0, generating, userPtys }
}

/** The live answer, from BOTH pools. Engine-owned cwds are recognised by
 *  prefix against the canonicalized central data root (~/.openground/projects/
 *  — user projects never live there; the sep-terminated compare mirrors
 *  isDirOccupied so `…/projects-evil` can't match). */
export const updateRestartSafety = async (): Promise<UpdateRestartSafetyResponse> => {
  const centralRoot = await canonicalize(projectsDataRootDir())
  const ptys = await Promise.all(
    listPtySafetyViews().map(async (v) => ({
      desk: v.desk,
      hidden: v.hidden,
      claudePane: v.claudePane,
      claudeWorking: v.claudeWorking,
      foreground: v.foreground,
      lastOutputAt: v.lastOutputAt,
      // Only asked for panes that could possibly be abandoned — a pgrep per
      // live pane on every probe would be wasteful, and the answer only matters
      // when the other two signals already say "empty".
      hasChildren:
        LOGIN_SHELLS.has(v.foreground) && Date.now() - v.lastOutputAt >= IDLE_PANE_MS
          ? await hasChildProcesses(v.pid)
          : true,
      menuOpen: v.menuOpen,
      engine: (await canonicalize(v.cwd)).startsWith(centralRoot + sep),
    })),
  )
  const sdkStatuses = listSdkSessions()
    .filter((s) => isSdkSessionLive(s))
    .map((s) => s.status)
  return computeRestartSafety(ptys, sdkStatuses)
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
