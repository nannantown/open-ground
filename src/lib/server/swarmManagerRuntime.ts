// swarmManagerRuntime — "is there a commander desk, and can I speak to it?",
// answered without caring which runtime carries it.
//
// The commander used to be a PTY and only a PTY, so five separate places asked
// the PTY pool directly: the singleton guard (swarmManager.adoptLiveDesk), the
// engine's presence probe and its resuscitation reflex, the notice/nudge
// delivery, and the model-limit watch. An SDK commander lives in a DIFFERENT
// pool (sdkSession.ts) with no screen, no terminalId and no PTY process — so
// every one of those five would read "no desk" and act on it. The most
// expensive of them would spawn a SECOND commander every five minutes, which is
// precisely the twin-desk failure the pool-based guard was built to end.
//
// So the question moves here, and both pools answer it.
//
// WHY A HANDLE AND NOT AN ID. The identity invariant this file exists to keep is
// the same one workerRuntime.ts keeps for workers: pty ⇔ terminalId,
// sdk ⇔ sdkSessionId, NEVER both and never prefix-encoded into one string. A
// caller that has a {@link ManagerDeskHandle} cannot accidentally hand a PTY id
// to the SDK pool, and a `runtime` field it must branch on is a compile-time
// reminder that the two are not interchangeable.
//
// WHAT IS BETTER ON THE SDK SIDE (and why the migration is worth it):
//   • liveness is a fact, not an inference — the stream is open or it is not,
//     where the PTY side must confirm a pool entry against the process table
//     because `finishedAt` lands asynchronously;
//   • delivery is synchronous and unconditional — `pushSdkInput` queues the turn
//     and says so, where the PTY side must first read the SCREEN to decide the
//     desk is not mid-typing, then send an ESC that ERASES whatever the owner
//     had half-written, then the text, then Enter, and still cannot confirm any
//     of it landed.
//
// See docs/SDK_WORKER_MIGRATION_PLAN.md §14 (stage 3).

import { resolve } from 'path'
import {
  listLiveDesksIn,
  isTerminalProcessAlive,
  getTerminalScreen,
  claudeSessionActivity,
  writeInput,
  killTerminal,
} from './terminal'
import {
  listSdkSessionsIn,
  isSdkSessionLive,
  getSdkSession,
  pushSdkInput,
  terminateSdkSession,
} from './sdkSession'
import { MANAGER_DESK_LABEL } from './swarmManagerLabel'

export type ManagerRuntimeKind = 'pty' | 'sdk'

/** A commander desk that EXISTS right now, whatever runtime carries it. */
export interface ManagerDeskHandle {
  runtime: ManagerRuntimeKind
  /** PTY ⇒ the terminal id. SDK ⇒ the sdk session id. Never both. */
  handleId: string
  cwd: string
  /** The CLAUDE conversation id this desk holds — what swarmSessions persists.
   *  Null when the runtime could not report one (a legacy PTY entry). */
  agentSessionId: string | null
  /** Newest evidence of output, epoch ms. Null when it has produced none yet. */
  lastOutputAt: number | null
  startedAt: number
  /** The desk has been ASKED TO STOP and is still unwinding — it exists (so it
   *  must keep blocking a twin spawn) but it must NEVER be adopted by a pane.
   *
   *  ⚠ THE TWO QUESTIONS ARE NOT THE SAME (found 2026-08-03, overnight review).
   *  `terminateSdkSession` flips `status` to 'exited' synchronously while the
   *  pump keeps unwinding, and this list deliberately selects on `reaped` so the
   *  singleton guard still sees the dying desk. But the UI's reconcile adopts
   *  ANY live desk it is shown — so pressing 停止 cleared the pane's record and
   *  the very next poll re-adopted the desk being stopped. On a wedged session
   *  (the case where stopping matters most) that never reaps, 停止 could never
   *  stick. The flag lets the OCCUPANCY answer keep the desk while the ADOPTION
   *  answer drops it. PTY desks are already re-confirmed against the process
   *  table, so their arm reports false. */
  stopping: boolean
}

export interface ManagerDeskDeps {
  /** Injected wholesale in tests — neither pool is reachable there. */
  ptyDesks?: typeof listLiveDesksIn
  ptyAlive?: (id: string) => boolean
  sdkDesks?: typeof listSdkSessionsIn
}

/** Every LIVE commander desk in `projectPath`, newest first, across BOTH pools.
 *
 *  The PTY arm re-confirms each entry against the process table: `finishedAt`
 *  is stamped by an asynchronous onExit, so right after a kill the pool can
 *  still list a desk the OS already reaped (the Restart button's DELETE →
 *  respawn window). The SDK arm needs no equivalent — a session's status IS the
 *  stream's state, updated by the pump itself. */
export const listManagerDesks = (
  projectPath: string,
  deps: ManagerDeskDeps = {},
): ManagerDeskHandle[] => {
  const alive = deps.ptyAlive ?? isTerminalProcessAlive
  const pty = (deps.ptyDesks ?? listLiveDesksIn)(projectPath, MANAGER_DESK_LABEL)
    .filter((d) => alive(d.id))
    .map<ManagerDeskHandle>((d) => ({
      runtime: 'pty',
      handleId: d.id,
      cwd: d.cwd,
      agentSessionId: d.agentSessionId ?? null,
      lastOutputAt: d.lastOutputAt ?? null,
      startedAt: d.startedAtMs,
      // A PTY entry that survived the process-table re-confirmation above is
      // genuinely alive — a killed one is already filtered out, so there is no
      // "asked to stop but still here" window on this arm.
      stopping: false,
    }))
  const sdk = (deps.sdkDesks ?? listSdkSessionsIn)(projectPath, 'manager').map<ManagerDeskHandle>(
    (s) => ({
      runtime: 'sdk',
      handleId: s.id,
      cwd: s.cwd,
      agentSessionId: s.agentSessionId ?? null,
      // The pool stamps lastEventAt at spawn, so a session that has produced
      // nothing yet would look like it "painted" at t=0 of its life. That is
      // exactly what the PTY side reports for a live-but-silent desk too
      // (startedAt with no lastOutputAt → null), so normalise: only count it as
      // output once at least one event has been emitted.
      lastOutputAt: s.seq > 0 ? s.lastEventAt : null,
      startedAt: s.startedAt,
      // Asked to stop (status flipped synchronously by terminateSdkSession)
      // but not yet reaped — see ManagerDeskHandle.stopping.
      stopping: s.status === 'exited' || s.status === 'failed',
    }),
  )
  return [...pty, ...sdk].sort((a, b) => b.startedAt - a.startedAt)
}

/** `isSdkSessionLive` over a pool lookup — an unknown id is NOT live. */
const defaultSdkDeskAlive = (id: string): boolean => {
  const s = getSdkSession(id)
  return !!s && isSdkSessionLive(s)
}

/** Is this specific desk STILL THERE?
 *
 *  ⚠ BOTH ARMS ANSWER FROM REAL EVIDENCE, NOT FROM A TERMINAL MARKER. The PTY arm
 *  asks the process table because the pool's `finishedAt` is stamped by an
 *  asynchronous onExit. The SDK arm asks `isSdkSessionLive` (= `!reaped`, the
 *  pump's iterator having actually returned) for the mirror-image reason:
 *  `terminateSdkSession` flips `status` to 'exited' SYNCHRONOUSLY — it means "we
 *  asked it to stop" — so the status-based `isSdkSessionAlive` this used to call
 *  reported a commander desk DEAD the instant Restart pressed DELETE, while its
 *  claude was still unwinding. The whole point of {@link listManagerDesks} is
 *  that the singleton guard and the presence probe agree; that file already
 *  selects on `reaped` (via `listSdkSessionsIn`), so a desk this predicate called
 *  dead was one the desk LIST still showed — two answers to one question, which
 *  is exactly how a project ends up with two commanders integrating one trunk. */
export const isManagerDeskAlive = (
  h: ManagerDeskHandle,
  deps: { ptyAlive?: (id: string) => boolean; sdkAlive?: (id: string) => boolean } = {},
): boolean =>
  h.runtime === 'pty'
    ? (deps.ptyAlive ?? isTerminalProcessAlive)(h.handleId)
    : (deps.sdkAlive ?? defaultSdkDeskAlive)(h.handleId)

/** The desk holding a given CLAUDE conversation id, or null.
 *
 *  Both pools are asked because the session store records only the id, not the
 *  runtime — a project that switched the dial mid-life has a record that could
 *  belong to either. */
export const managerDeskForSession = (
  agentSessionId: string,
  projectPath: string,
  deps: ManagerDeskDeps & { activity?: typeof claudeSessionActivity } = {},
): ManagerDeskHandle | null => {
  if (!agentSessionId) return null
  const act = (deps.activity ?? claudeSessionActivity)(agentSessionId)
  if (act.live && act.terminalId) {
    return {
      runtime: 'pty',
      handleId: act.terminalId,
      cwd: resolve(projectPath),
      agentSessionId,
      lastOutputAt: act.lastOutputAt,
      startedAt: 0,
      // `act.live` IS the process-table answer, so a desk reported here is not
      // mid-teardown (same reasoning as the PTY arm of listManagerDesks).
      stopping: false,
    }
  }
  return (
    listManagerDesks(projectPath, deps).find(
      (d) => d.runtime === 'sdk' && d.agentSessionId === agentSessionId,
    ) ?? null
  )
}

export interface SayResult {
  ok: boolean
  /** Why a PTY delivery was held back, when it was. SDK deliveries never are. */
  heldBecause?: 'busy-or-half-typed' | 'no-desk'
}

/** Deliver one line to the commander and press Enter.
 *
 *  PTY: keeps the historical contract exactly — the screen is read first and the
 *  send is SKIPPED when the desk looks busy or half-typed, because the ESC that
 *  has to prefix the text (so a half-written draft is not concatenated onto the
 *  notice and sent as one garbled message) would otherwise erase what the owner
 *  was typing. Held notices are re-tried by the caller next pass.
 *
 *  SDK: there is no screen to read and no draft to erase. A turn pushed while
 *  the model is generating is queued by the CLI and handled when the current
 *  turn ends (measured — migration plan appendix B-3), so delivery is
 *  unconditional and its acceptance is known synchronously. `deliverable` is
 *  therefore not consulted, rather than consulted and always true: an SDK desk
 *  has no state in which the notice must be withheld. */
export const sayToManagerDesk = (
  h: ManagerDeskHandle | null,
  text: string,
  deps: {
    screen?: (id: string) => string | null
    deliverable?: (screen: string | null) => boolean
    write?: (id: string, data: string) => boolean
    push?: (id: string, text: string) => boolean
  } = {},
): SayResult => {
  if (!h) return { ok: false, heldBecause: 'no-desk' }
  if (h.runtime === 'sdk') {
    return { ok: (deps.push ?? pushSdkInput)(h.handleId, text) }
  }
  const scr = (deps.screen ?? getTerminalScreen)(h.handleId)
  if (deps.deliverable && !deps.deliverable(scr)) {
    return { ok: false, heldBecause: 'busy-or-half-typed' }
  }
  return { ok: (deps.write ?? writeInput)(h.handleId, `${text}\r`) }
}

/** The desk's SCREEN, for the readers that still need one (the model-limit
 *  watch). Null for an SDK desk — not "empty": there is no screen, and a reader
 *  that treats null as "nothing on it" would conclude a healthy desk is showing
 *  no quota refusal for the wrong reason. Its equivalent evidence is the
 *  `quota_refusal` event in the session's own stream. */
export const managerDeskScreen = (
  h: ManagerDeskHandle,
  deps: { screen?: (id: string) => string | null } = {},
): string | null => (h.runtime === 'pty' ? (deps.screen ?? getTerminalScreen)(h.handleId) : null)

/** Snapshot for the API / UI: which runtime, and what to address it by. */
export const managerDeskSummary = (
  h: ManagerDeskHandle,
): { runtime: ManagerRuntimeKind; terminalId: string | null; sdkSessionId: string | null } => ({
  runtime: h.runtime,
  terminalId: h.runtime === 'pty' ? h.handleId : null,
  sdkSessionId: h.runtime === 'sdk' ? h.handleId : null,
})

/** Status of an SDK desk, for callers that want more than "alive". Null for a
 *  PTY desk (its equivalent is `claudeStatus` over the screen). */
export const sdkManagerDeskStatus = (h: ManagerDeskHandle) =>
  h.runtime === 'sdk' ? (getSdkSession(h.handleId)?.status ?? null) : null

/** Tear down EVERY commander desk in `projectPath`, whichever pool carries it,
 *  and report the handle ids that were asked to stop.
 *
 *  The server-side twin of {@link stopSwarmSupplyDesks}, and it exists for the
 *  same reason that one does: with a boot auto-resume in play
 *  (`EngineIntent.managerDesired`), "stop" has to be a statement of INTENT, not
 *  just a kill. The UI used to close the desk by DELETEing its raw handle —
 *  which stops the desk but can never say the owner MEANT it — so a stop that
 *  did not clear the flag would resurrect the desk on every restart, forever.
 *  The clearing lives in the route; the killing lives here.
 *
 *  Branches on `runtime`, never on "whichever id is non-empty" — the two pools
 *  take different ids and handing one to the other would at best no-op and at
 *  worst kill an unrelated pane (the same identity invariant this whole file
 *  keeps). Best-effort per desk: a handle already reaped is not an error. */
export const stopManagerDesks = (projectPath: string, deps: ManagerDeskDeps = {}): string[] => {
  const stopped: string[] = []
  for (const d of listManagerDesks(projectPath, deps)) {
    if (d.runtime === 'sdk') terminateSdkSession(d.handleId)
    else killTerminal(d.handleId)
    stopped.push(d.handleId)
  }
  return stopped
}
