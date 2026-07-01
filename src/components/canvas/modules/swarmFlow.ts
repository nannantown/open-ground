// swarmFlow.ts — PURE, React-free derivations for the Swarm loop visualization
// (SwarmFlowPane). The flow pane is the dynamic, real-data version of the kitchen
// diagram (card 743ffdef): the drain → dispatch → monitor → integrate loop, each
// worker's fine stage, heartbeat liveness, the integration queue, and the loop's
// fatal events — all read live off the engine's poll.
//
// WHY a separate module (not inlined in the pane): keeping the stage / liveness /
// fatal mappings React-free makes them unit-testable without a DOM — the same
// split useSwarmEngine already uses for its pure mergeSwarmWorkers / planSwarmPower.
// The pane is then a thin render over these.
//
// FATAL EVENTS (条件3): the escalation safety valve (card 6fe48c1f, NOW merged)
// persists EVERY fatal event of the unmanned loop as a notification. We surface
// those (the authoritative `SwarmFatalView`s useSwarmEngine polls from
// GET /api/swarm/notifications) so ALL FIVE kinds show — the three engine-side
// ones (rework-exhausted / all-workers-down / exec-timeout) AND the two from the
// Electron self-update cycle (rollback / canary-failed), which never touch the
// engine state. Engine `anomalies` (state drift the loop couldn't self-heal) are
// folded in alongside as lower-severity alerts, deduped against the matching
// rework-exhausted notification so it isn't shown twice.

import type {
  EngineAnomaly,
  EngineLogLine,
  EngineWorker,
  SwarmEngineState,
  SwarmFatalView,
} from './useSwarmEngine'

// ── Worker fine stage (条件1: audit / 実装 / 検証 / 統合待ち) ────────────────────
// The coarse engine stage is only starting / running / done. The FINE stage comes
// from the worker's self-reported heartbeat phase (swarm-beat.sh <phase>): the
// /order skill emits audit · implement · testing · done · blocked (+ free text).
export type FlowStage = 'starting' | 'audit' | 'implement' | 'verify' | 'awaiting' | 'blocked'

// Left→right order — the natural progression a worker walks (the legend + the
// monitor station read in this order; 'blocked' sits last as the off-path state).
export const FLOW_STAGE_ORDER: readonly FlowStage[] = [
  'starting', 'audit', 'implement', 'verify', 'awaiting', 'blocked',
]

// Map a heartbeat phase (free text) to a FlowStage. Matched on substrings so the
// canonical one-word phases AND bilingual / synonym phrases ("検証中", "testing")
// both resolve. Order matters: the more-specific buckets are tested first, with
// an implement fallback for an unknown-but-present phase (a worker that beat IS
// doing something). Empty / null → undefined (caller falls back to coarse stage).
export const stageFromPhase = (phase: string | undefined | null): FlowStage | undefined => {
  if (!phase) return undefined
  const p = phase.toLowerCase()
  if (/block|stuck|詰ま|halt/.test(p)) return 'blocked'
  if (/done|ready|merge|await|完了|統合待|統合可|レビュー待/.test(p)) return 'awaiting'
  if (/test|verif|検証|検品|lint|tsc|typecheck|qa|e2e|build/.test(p)) return 'verify'
  if (/audit|監査|下ごしら|recon|investig|survey|設計|調査|plan/.test(p)) return 'audit'
  if (/init|start|spawn|boot|起動|待機/.test(p)) return 'starting'
  return 'implement'
}

// Resolve a worker's DISPLAY stage: prefer the self-reported heartbeat phase
// (fine), fall back to the engine's coarse lifecycle stage when it hasn't beat.
export const workerStage = (w: Pick<EngineWorker, 'phase' | 'stage'>): FlowStage => {
  const fine = stageFromPhase(w.phase)
  if (fine) return fine
  if (w.stage === 'starting') return 'starting'
  if (w.stage === 'done') return 'awaiting'
  return 'implement' // 'running' or an older engine that omits stage → working
}

// ── Heartbeat liveness (条件2: 心拍の生死) ────────────────────────────────────
export type Liveness = 'fresh' | 'aging' | 'stale' | 'none'

// Thresholds mirror the janitor's 10-min stall mark (reference_swarm_janitor_tmux):
// < 3 min fresh, 3–10 min aging, > 10 min stale → likely stuck. No heartbeat at
// all (older engine / a worker that never beat) → 'none'.
export const FRESH_MS = 3 * 60_000
export const STALE_MS = 10 * 60_000

export const heartbeatLiveness = (
  heartbeatAt: string | undefined | null,
  nowMs: number,
): Liveness => {
  if (!heartbeatAt) return 'none'
  const t = Date.parse(heartbeatAt)
  if (!Number.isFinite(t)) return 'none'
  const age = nowMs - t
  if (age < FRESH_MS) return 'fresh' // also covers a small negative clock skew
  if (age < STALE_MS) return 'aging'
  return 'stale'
}

// ── Fatal / alert events (条件3) ──────────────────────────────────────────────
// One "needs attention" alert in the banner. Either a persisted FATAL notification
// (a wake-a-human escalation — the 5 SwarmFatalEvents) or an engine ANOMALY (state
// drift the loop detected but couldn't self-heal). The pane localizes each.
export interface FlowFatal {
  /** Stable React key. */
  id: string
  /** Origin — drives how the pane labels the row. */
  source: 'fatal' | 'anomaly'
  /** fatal source — the persisted fatal notification (event + server detail). */
  fatal?: SwarmFatalView
  /** anomaly source — the full anomaly (the pane maps `kind` to a localized label). */
  anomaly?: EngineAnomaly
}

// Derive the "needs attention" set (条件3): the persisted FATAL notifications first
// (the authoritative escalation source — all five kinds, including the Electron
// self-update ones the engine state can't carry), newest-first, then the engine
// ANOMALIES (drift). A rework-exhausted that is BOTH a fatal notification and an
// anomaly is shown once (the richer notification wins) — keyed on the card id
// (notification.taskId === anomaly.ref).
export const deriveFatalEvents = (
  engine: SwarmEngineState,
  fatalNotifications: readonly SwarmFatalView[] = [],
): FlowFatal[] => {
  const out: FlowFatal[] = []
  const reworkRefs = new Set<string>()
  for (const f of fatalNotifications) {
    if (f.event === 'rework-exhausted' && f.taskId) reworkRefs.add(f.taskId)
    out.push({ id: `fatal:${f.id}`, source: 'fatal', fatal: f })
  }
  for (const a of engine.anomalies) {
    // Skip a rework-exhausted anomaly already covered by its fatal notification.
    if (a.kind === 'rework-exhausted' && reworkRefs.has(a.ref)) continue
    out.push({ id: `anomaly:${a.kind}:${a.ref}`, source: 'anomaly', anomaly: a })
  }
  return out
}

// ── Pipeline summary (the drain → dispatch → monitor → integrate stations) ────
export interface FlowSummary {
  engineRunning: boolean
  available: boolean
  workerCount: number
  /** Workers bucketed by fine stage — the monitor station + the legend. */
  byStage: Record<FlowStage, number>
  reviewCount: number
  /** Review cards bucketed by readiness — the integrate station. */
  reviewReady: number // 'ff'
  reviewBlocked: number // 'conflict'
  /** Integrate events currently in the log buffer (recent landings, not a total). */
  recentIntegrations: number
}

const emptyByStage = (): Record<FlowStage, number> => ({
  starting: 0, audit: 0, implement: 0, verify: 0, awaiting: 0, blocked: 0,
})

export const summarizeFlow = (engine: SwarmEngineState, available: boolean): FlowSummary => {
  const byStage = emptyByStage()
  for (const w of engine.workers) byStage[workerStage(w)] += 1
  return {
    engineRunning: engine.running,
    available,
    workerCount: engine.workers.length,
    byStage,
    reviewCount: engine.reviews.length,
    reviewReady: engine.reviews.filter((r) => r.status === 'ff').length,
    reviewBlocked: engine.reviews.filter((r) => r.status === 'conflict').length,
    recentIntegrations: engine.log.filter((l) => l.kind === 'integrate').length,
  }
}

// ── Event feed (条件2: 列移動 / 統合フローのリアルタイム) ─────────────────────────
// The meaningful loop events, newest first, capped. 'routine' bookkeeping is
// dropped — the SAME noise filter the manager log's Key view uses (an absent kind
// is an uncategorized meaningful event and is kept). These are the dispatch
// (todo→doing) / promote (doing→review) / integrate (review→done) / conflict /
// cleanup / crash moves that make the loop legible as it turns.
export const meaningfulEvents = (engine: SwarmEngineState, max = 14): EngineLogLine[] =>
  engine.log.filter((l) => l.kind !== 'routine').slice(-max).reverse()

// ── Whole-loop idleness ──────────────────────────────────────────────────────
// The loop is idle when the engine is stopped AND nothing is in flight — no
// workers, no review cards, no anomalies, AND no fatal notifications. The pane
// shows a calm idle hint in that state instead of an empty pipeline (a lingering
// fatal must keep the banner visible rather than dropping to the idle screen).
export const isFlowIdle = (
  engine: SwarmEngineState,
  fatalNotifications: readonly SwarmFatalView[] = [],
): boolean =>
  !engine.running &&
  engine.workers.length === 0 &&
  engine.reviews.length === 0 &&
  deriveFatalEvents(engine, fatalNotifications).length === 0

// ── Relative-time token ───────────────────────────────────────────────────────
// Compact, language-neutral age token ("32s" / "4m" / "2h" / "3d") for a heartbeat
// or event timestamp. The pane wraps it in a localized "{age} ago" template, so
// the digits + unit letter stay identical across locales. null on a missing /
// unparseable input.
export const compactAge = (iso: string | undefined | null, nowMs: number): string | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  const sec = Math.max(0, Math.round((nowMs - t) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.round(hr / 24)}d`
}
