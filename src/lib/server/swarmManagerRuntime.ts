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
} from './terminal'
import {
  listSdkSessionsIn,
  isSdkSessionAlive,
  getSdkSession,
  pushSdkInput,
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
    }),
  )
  return [...pty, ...sdk].sort((a, b) => b.startedAt - a.startedAt)
}

/** Is this specific desk still able to work? */
export const isManagerDeskAlive = (
  h: ManagerDeskHandle,
  deps: { ptyAlive?: (id: string) => boolean; sdkAlive?: (id: string) => boolean } = {},
): boolean =>
  h.runtime === 'pty'
    ? (deps.ptyAlive ?? isTerminalProcessAlive)(h.handleId)
    : (deps.sdkAlive ?? isSdkSessionAlive)(h.handleId)

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
