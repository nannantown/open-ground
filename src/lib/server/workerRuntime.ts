// workerRuntime — the ONE seam between the swarm engine's brain and HOW a
// worker's `claude` is actually running.
//
// WHY THIS EXISTS. The engine's dispatch / roster / integration / quota logic
// does not care whether a worker is a PTY hosting an interactive `claude` or an
// Agent SDK session. It only needs a handful of facts about it: is it alive,
// what is it saying, stop it, talk to it. Today every one of those is a direct
// call into the node-pty pool, which is why adding a second way to run a worker
// would otherwise mean scattering `if (runtime === 'sdk')` through a 10k-line
// orchestrator. Everything runtime-specific goes behind this interface instead.
//
// SCOPE OF THIS FILE TODAY: the interface plus the PTY implementation, which is
// a pure delegation to the functions the orchestrator already called. That is
// deliberate — this step must be BEHAVIOUR-NEUTRAL, and the existing swarm test
// suite passing unchanged is the proof. The SDK implementation lands separately
// (docs/SDK_WORKER_MIGRATION_PLAN.md W5/W6).
//
// ── the identity invariant ────────────────────────────────────────────────
// A worker is addressed by EXACTLY ONE handle:
//     runtime 'pty' ⇔ terminalId present, sdkSessionId absent
//     runtime 'sdk' ⇔ sdkSessionId present, terminalId absent
// `runtime` is optional on the persisted roster and ABSENT MEANS 'pty', so a
// roster.json written before this existed keeps loading and keeps meaning what
// it meant. A magic prefix on a single id field was rejected on purpose: when a
// worker misbehaves the first question is always "which kind is it?", and an
// encoded answer is one that can be misread at exactly the wrong moment.

import { getTerminal, getTerminalScreen, killTerminal, writeInput } from './terminal'
import {
  getSdkSession,
  isSdkSessionAlive,
  pushSdkInput,
  terminateSdkSession,
} from './sdkSession'

export type WorkerRuntimeKind = 'pty' | 'sdk'

/** The minimum a worker record must carry for the runtime layer to act on it.
 *  Both {@link import('../types').OrchestratorWorker} and
 *  {@link import('../types').SwarmWorkerRecord} structurally satisfy this. */
export interface WorkerHandle {
  runtime?: WorkerRuntimeKind
  terminalId?: string
  sdkSessionId?: string
}

/** ABSENT ⇒ 'pty'. Every pre-existing roster entry and every fake-deps test
 *  literal predates the field, and all of them mean the PTY worker. */
export const workerRuntimeKind = (w: WorkerHandle): WorkerRuntimeKind => w.runtime ?? 'pty'

/** Thrown when a worker record violates the identity invariant above. The engine
 *  keys in-memory maps by {@link workerKey}, so a handle-less record would
 *  silently collide with another one — louder is safer than shared state. */
export class WorkerHandleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkerHandleError'
  }
}

/** Stable per-worker key for the engine's in-memory maps (rate-limit sightings,
 *  stall clocks, …). Was `w.terminalId` everywhere; that is still exactly what
 *  it returns for a PTY worker, so those maps keep their existing contents. */
export const workerKey = (w: WorkerHandle): string => {
  const kind = workerRuntimeKind(w)
  const id = kind === 'sdk' ? w.sdkSessionId : w.terminalId
  if (!id) {
    throw new WorkerHandleError(
      `worker has runtime '${kind}' but no ${kind === 'sdk' ? 'sdkSessionId' : 'terminalId'}`,
    )
  }
  return id
}

/** The facts the engine needs about a running worker, independent of HOW it runs.
 *  Kept deliberately small: every method here is one the orchestrator already
 *  performs today. Growth belongs with the SDK implementation, not ahead of it. */
export interface WorkerRuntime {
  readonly kind: WorkerRuntimeKind
  /** Is the underlying process/session still there? (Liveness only — says
   *  nothing about whether it is making progress.) */
  isAlive(w: WorkerHandle): boolean
  /** The worker's recent output, as the text the engine classifies (rate-limit
   *  notice / permission wait / free-text question). null = nothing readable,
   *  which every caller must treat as "no evidence", never as "nothing wrong". */
  recentOutput(w: WorkerHandle): string | null
  /** Stop the worker. Best-effort and idempotent: an already-dead worker is not
   *  an error, because the engine kills defensively on paths where the process
   *  may already be gone. */
  kill(w: WorkerHandle): void
  /** Wall-clock ms of the worker's newest output, or null when unknown.
   *  ⚠ null means NO EVIDENCE, never "silent since forever" — every caller
   *  must keep treating it that way. */
  lastOutputAt(w: WorkerHandle): number | null
  /** Poke a quiet worker. Returns false when there was nothing to poke. */
  nudge(w: WorkerHandle): boolean
  /** Send the worker a one-line instruction (the 差し戻し / escalation conduit).
   *  Returns whether it was accepted. */
  say(w: WorkerHandle, text: string): Promise<boolean>
}

export const ptyWorkerRuntime: WorkerRuntime = {
  kind: 'pty',
  isAlive: (w) => {
    const info = getTerminal(workerKey(w))
    // A session lingers ~30s after exit with finishedAt set so the client can
    // drain its buffer; an exited-but-lingering PTY is NOT a live slot.
    return !!info && !info.finishedAt
  },
  recentOutput: (w) => getTerminalScreen(workerKey(w)),
  kill: (w) => {
    killTerminal(workerKey(w))
  },
  lastOutputAt: (w) => getTerminal(workerKey(w))?.lastOutputAt ?? null,
  nudge: (w) => writeInput(workerKey(w), '\r'),
  say: async (w, text) => writeInput(workerKey(w), text),
}

/** The Agent SDK runtime.
 *
 *  The point of the migration is visible in how short these are: every one of
 *  them is a LOOKUP where the PTY implementation is an INFERENCE. "Is it
 *  alive" stops being "does a pool entry exist and has it not been marked
 *  finished"; it becomes "is the stream still open". "What is it saying" stops
 *  being a rendered frame that has to be told apart from the CLI's own
 *  furniture; it becomes the last distilled event. */
export const sdkWorkerRuntime: WorkerRuntime = {
  kind: 'sdk',
  isAlive: (w) => isSdkSessionAlive(workerKey(w)),
  recentOutput: (w) => {
    const s = getSdkSession(workerKey(w))
    if (!s) return null
    // The engine's classifier reads TEXT. Rather than re-render a fake screen,
    // hand it the status line the session already knows to be true — the
    // classifier's rate-limit / question arms are fed by real events elsewhere
    // (sdkEvents), so this only has to be honest, not detailed.
    return `[sdk session ${s.status}${s.exitReason ? ` — ${s.exitReason}` : ''}]`
  },
  kill: (w) => {
    terminateSdkSession(workerKey(w))
  },
  // Real liveness, not a guess: the timestamp of the newest event on the wire.
  lastOutputAt: (w) => getSdkSession(workerKey(w))?.lastEventAt ?? null,
  // A bare CR means nothing to a stream. The equivalent poke is an actual turn.
  nudge: (w) => pushSdkInput(workerKey(w), 'Continue.'),
  say: async (w, text) => pushSdkInput(workerKey(w), text),
}

/** Resolve the runtime for one worker. The engine calls this instead of reaching
 *  into the PTY pool directly. */
export const runtimeOf = (w: WorkerHandle): WorkerRuntime =>
  workerRuntimeKind(w) === 'sdk' ? sdkWorkerRuntime : ptyWorkerRuntime
