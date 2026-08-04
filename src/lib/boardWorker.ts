// Board card ↔ swarm worker — the DISPLAY-ONLY glue between the orchestrator's
// engine state and a doing-column card's status band. Pure (no React, no fetch)
// so the activity derivation is unit-testable on its own. The engine logic is
// untouched; this only READS its reported worker stage + the live PTY beacon.

import type { ClaudeBeaconStatus } from '@/lib/types'

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
