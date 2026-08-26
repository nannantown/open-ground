// Board card ↔ swarm worker — the DISPLAY-ONLY glue between the orchestrator's
// engine state and a doing-column card's status band. Pure (no React, no fetch)
// so the activity derivation is unit-testable on its own. The engine logic is
// untouched; this only READS its reported worker stage + the live PTY beacon.

import type { ClaudeBeaconStatus, ClaudeEffort } from '@/lib/types'

/** The coarse lifecycle the engine reports for a worker (mirrors
 *  ManagerWorkerStage in useSwarmEngine — kept local so this stays
 *  React-decoupled). Absent on an older engine → folded to 'running'. */
export type WorkerStage = 'starting' | 'running' | 'done' | undefined

/** What a doing card's worker band/stamp shows at a glance:
 *  - working  = the worker's PTY is actively producing output (moss, scanning),
 *  - waiting  = alive but idle / on a prompt, OR no live signal (steady amber),
 *  - starting = dispatched, still booting (steady grey),
 *  - done     = the worker finished (steady moss; transient — the engine moves
 *               the card to review, so it leaves the doing column shortly). */
export type WorkerActivity = 'working' | 'waiting' | 'starting' | 'done'

/** The minimal, render-ready view of the worker dispatched onto ONE doing card.
 *  Built by BoardModule from the orchestrator poll + the live-terminal beacon,
 *  consumed by BoardTab. `branch` is the worker's identity (swarm/* — there is
 *  no separate worker name in this system); phase/note are the worker's own
 *  heartbeat passthrough (display-only). */
export interface BoardCardWorker {
  /** swarm/* branch the worker owns — its handle on the board. */
  branch: string
  /** Derived live activity (drives the band animation + the stamp colour). */
  activity: WorkerActivity
  /** The worker's self-reported phase (audit/implement/verify…) — heartbeat. */
  phase?: string
  /** The worker's self-reported one-line summary — heartbeat. */
  note?: string
  /** HOW OLD the note is, as a verdict — NOT a timestamp. Absent means the
   *  engine gave us no heartbeat time for it, so we cannot date the note and
   *  therefore must not present it as a current statement (see
   *  {@link deriveHeartbeatFreshness}). */
  noteFreshness?: 'fresh' | 'stale'
  /** The `--model` alias this worker is running on, when the engine tracked the
   *  dispatch. The card prints it VERBATIM — never a weight word like 「重い」
   *  (owner, 2026-08-26): the weight bucket is an internal routing detail, and
   *  what the owner is checking is whether THIS card got the tier it deserved. */
  model?: string
  /** The `--effort` beside {@link model}. Same provenance, same absence rule. */
  effort?: ClaudeEffort
}

/** How long a heartbeat stays a statement about NOW. Matches the engine's own
 *  stale-heartbeat window (STALE_HEARTBEAT_MS in swarmOrchestrator) so the board
 *  and the engine do not disagree about when a worker went quiet. */
export const WORKER_NOTE_STALE_MS = 10 * 60_000

/** Is a worker's last note still a statement about the present?
 *
 *  'none'  — we have no beat time at all (older engine, or the engine kept the
 *            worker's prior fields without a fresh probe). We CANNOT date the
 *            note, so the caller must not render it as current — absence of
 *            evidence, not evidence of currency.
 *  'fresh' — beat within {@link WORKER_NOTE_STALE_MS}.
 *  'stale' — older than that: the note describes the past.
 *
 *  A beat timestamped in the FUTURE (clock skew between the engine's clock and
 *  the browser's) reads 'fresh': a negative age is not evidence of staleness. */
export const deriveHeartbeatFreshness = (
  heartbeatAt: string | undefined,
  nowMs: number,
): 'none' | 'fresh' | 'stale' => {
  if (!heartbeatAt) return 'none'
  const beatMs = Date.parse(heartbeatAt)
  if (!Number.isFinite(beatMs)) return 'none'
  const ageMs = nowMs - beatMs
  return ageMs >= WORKER_NOTE_STALE_MS ? 'stale' : 'fresh'
}

/** Derive a doing card's worker activity from the engine's reported stage and
 *  the live PTY beacon (GET /api/terminal/active → working/waiting, or undefined
 *  when the poll hasn't seen the PTY / it's gone).
 *
 *  Order matters (条件④ — the band must stop the instant the worker stops):
 *  1. stage 'done' wins outright — the worker finished, never scan.
 *  2. a live 'working'/'waiting' beacon is the truth while the PTY is alive.
 *  3. NO live signal ⇒ either the worker is still booting (stage 'starting' →
 *     'starting', a steady grey band), or its PTY is gone and the engine will
 *     reclaim it next pass (→ steady 'waiting', NOT a phantom 'working' scan).
 *  So a stopped worker never keeps a scanning band: the moment its PTY drops out
 *  of the active-terminal poll the band falls to steady, then disappears
 *  entirely once the engine drops it from its worker list (BoardModule maps no
 *  worker → no band). */
export const deriveWorkerActivity = (
  stage: WorkerStage,
  liveStatus: ClaudeBeaconStatus | undefined,
): WorkerActivity => {
  if (stage === 'done') return 'done'
  if (liveStatus === 'working') return 'working'
  if (liveStatus === 'waiting') return 'waiting'
  return stage === 'starting' ? 'starting' : 'waiting'
}

// ── Commander (manager) ↔ review card ────────────────────────────────────────
// The review column's counterpart of the glue above: a review card's
// integration is the COMMANDER's job, so the card shows the commander's
// presence plus THIS card's integration readiness — both already carried by the
// same GET /api/swarm/orchestrator poll. Pure and React-decoupled for the same
// reason as the worker half.

/** Commander presence as a review card shows it (mirrors CommanderPresence in
 *  useSwarmEngine — kept local so this stays React-decoupled). 'unknown' means
 *  the server did not say (older server): rendered WITHOUT a presence word,
 *  never as 'missing'. */
export type ManagerPresence = 'working' | 'quiet' | 'missing' | 'unknown'

/** Integration readiness of one review card (mirrors EngineReviewStatus). */
export type ManagerReviewStatus = 'ff' | 'rebase' | 'conflict' | 'unknown'

/** The minimal, render-ready view of the commander linkage for ONE review card.
 *  Built by BoardModule from the orchestrator poll (reviews[] + managerPresence),
 *  consumed by BoardTab. Exists only for cards the engine lists in `reviews` —
 *  a review card outside that queue shows nothing.
 *
 *  Deliberately NO phase/note: the commander is ONE per board, and its
 *  free-form heartbeat text on an individual card would claim "the commander is
 *  on THIS card" — which the data cannot support (差し戻し M1). Board-wide
 *  presence + this card's own readiness are the only honest per-card facts. */
export interface BoardCardManager {
  presence: ManagerPresence
  /** How this card's branch relates to the trunk right now. */
  reviewStatus: ManagerReviewStatus
}

/** The lamp tone of a review card's commander strip. A conflict outranks
 *  presence — the one state that needs the owner's hands wins the lamp;
 *  otherwise the lamp tracks the commander (working=moss, quiet=ochre,
 *  gone/unsaid=grey). */
export type ManagerTone = 'working' | 'waiting' | 'alert' | 'off'

export const deriveManagerTone = (
  presence: ManagerPresence,
  reviewStatus: ManagerReviewStatus,
): ManagerTone => {
  if (reviewStatus === 'conflict') return 'alert'
  if (presence === 'working') return 'working'
  if (presence === 'quiet') return 'waiting'
  return 'off'
}
