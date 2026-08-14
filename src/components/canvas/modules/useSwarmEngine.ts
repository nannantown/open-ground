// useSwarmEngine — the SINGLE source of the commander engine's state for the
// Swarm surface. It owns the one orchestrator poll + the start/stop
// actions, and polls the SERVER-TRUTH worker list (`realWorkers`, from
// GET /api/swarm/workers) that both Swarm sub-views render.
//
// WHY this lives here, not inside SwarmManagerPane: both Swarm sub-views need the
// workers — the manager dashboard (its monitor) AND the worker tab (its tiles).
// Polling in the manager pane left the worker tab blind to engine-spawned
// workers, so the poll is hoisted to SwarmModule (which calls this hook ONCE) and
// the list passed down to BOTH views — a single source of truth, no second poll.
// The list is unified SERVER-side (src/lib/server/swarmWorkerRegistry.ts: live
// PTYs + the engine roster + heartbeat files), so a worker started ANY way shows
// up — the client-side manual-registry merge this hook used to own is gone.
//
// The hook DEGRADES GRACEFULLY when the orchestrator route isn't there (a 404 →
// available:false + DEFAULT_ENGINE, never a scary error) — the same contract the
// manager pane had before, just relocated.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import type { WorkerStatus } from './SwarmWorkerPane'
import type { SwarmManagerPresence, SwarmWorkerRecord } from '@/lib/types'

// ── Engine contract (mirrors the server's SwarmOrchestratorState) ─────────────
// Kept as a LOCAL mirror (not imported from src/lib/types.ts) on purpose: the
// server half lives behind the orchestrator route and a local mirror keeps this
// front-end decoupled. The shape stays in lockstep with the server's
// `SwarmOrchestratorState` (incl. the read-only `reviews`).
export type EngineLogLevel = 'info' | 'warn' | 'error'

/** Structured event class — mirrors the server's OrchestratorLogLine.kind.
 *  'routine' is hidden by the dashboard's Key filter; the other kinds are shown,
 *  categorized events (dispatch / promote / integrate / conflict / cleanup /
 *  crash). Absent ⇒ an uncategorized meaningful event (also always shown). */
export type EngineLogKind =
  | 'routine'
  | 'dispatch'
  | 'promote'
  | 'integrate'
  | 'conflict'
  | 'cleanup'
  | 'crash'

export interface EngineLogLine {
  /** Stable React key (synthesised from at+index — the server line has none). */
  id: string
  at: string
  level: EngineLogLevel
  message: string
  /** Structured event class — see {@link EngineLogKind}. Drives the dashboard's
   *  noise filter (only 'routine' is hidden) and per-event styling. Absent ⇒ an
   *  uncategorized meaningful event. */
  kind?: EngineLogKind
}

/** The coarse lifecycle stage the manager monitor shows for a worker. */
export type ManagerWorkerStage = 'starting' | 'running' | 'done'

/** This worker's RUNTIME-AGNOSTIC identity — the client mirror of the server's
 *  `workerKey`. The sdkSessionId of an SDK worker, the terminalId of a PTY one.
 *  Use it for React keys, for map lookups, and as the id "stop" sends: an SDK
 *  worker's terminalId is EMPTY, so keying on it makes every SDK worker the same
 *  worker. Returns '' only for a malformed record (unaddressable by design). */
export const engineWorkerKey = (w: {
  runtime?: 'pty' | 'sdk'
  terminalId?: string
  sdkSessionId?: string
}): string => ((w.runtime ?? 'pty') === 'sdk' ? (w.sdkSessionId ?? '') : (w.terminalId ?? ''))

export interface EngineWorker {
  /** EMPTY for an SDK worker — the identity invariant is pty ⇔ terminalId,
   *  sdk ⇔ sdkSessionId (workerRuntime.ts). Never use it as this worker's
   *  identity; use {@link engineWorkerKey}. */
  terminalId: string
  /** Absent ⇒ 'pty' (every engine predating the Agent SDK runtime). */
  runtime?: 'pty' | 'sdk'
  /** Present only for an SDK worker: the handle its tile and its stop are
   *  addressed by.
   *
   *  ⚠ These two fields were DROPPED here until 2026-07-31, and dropping them
   *  broke three things at once: every SDK worker collapsed to the same empty
   *  key (React keys collided), its tile fell through to the terminal renderer
   *  and showed a healthy worker as an EXITED one, and "stop" sent `''` — which
   *  the engine matched against the first SDK worker and then used to drop ALL
   *  of them from its roster while their claude processes kept running. */
  sdkSessionId?: string
  branch: string
  taskId: string
  taskTitle: string
  startedAt: string
  /** Coarse lifecycle stage the engine reports (Card②). Absent on an older
   *  engine → folds to 'running' at the merge below. */
  stage?: ManagerWorkerStage
  /** Heartbeat passthrough (engine source only, display-only, 条件3): the
   *  worker's self-reported phase, one-line summary, and last-beat timestamp.
   *  Absent until the worker beats (or on an older engine). */
  phase?: string
  note?: string
  heartbeatAt?: string
}

/** Read-only integration readiness of one review card (Card③ "統合可" display). */
export type EngineReviewStatus = 'ff' | 'rebase' | 'conflict' | 'unknown'

export interface EngineReview {
  taskId: string
  branch: string
  taskTitle: string
  status: EngineReviewStatus
}

/** The commander desk's own heartbeat — mirrors the server's SwarmManagerHeartbeat
 *  (the `manager` field of GET /api/swarm/orchestrator). Display-only: it renders
 *  the "inspection" presence line that explains the quiet minutes after a worker
 *  finishes (the commander inspecting/landing work). `fresh` and `ageMs` are
 *  SERVER-computed (server clock), so the client never mixes its own clock in. */
export interface EngineManagerHeartbeat {
  /** Self-reported phase (`status` / `merge` / …) — free-form, display-only. */
  phase?: string
  /** One-line "what I'm doing now" note — free-form, display-only. */
  note?: string
  /** When it last beat (ISO 8601). */
  updatedAt: string
  /** How long ago, on the server clock (≥ 0). */
  ageMs: number
  /** Beat within the 10-min freshness window ⇒ the commander is active now. */
  fresh: boolean
}

/** Commander presence (the inspection line) — explains the quiet minutes after a
 *  worker finishes: while the commander desk inspects/lands the work its heartbeat
 *  stays fresh, so the tab can SAY "the commander is working" instead of looking
 *  dead (the 2026-07-17 misread). PURE so the two-state rule is unit-tested: ONLY
 *  a server-confirmed fresh heartbeat reads as active; a stale, absent, or
 *  unreadable one degrades to standby — never an error (fail-safe). Which desk
 *  (human-opened vs engine-woken) is not distinguished — the heartbeat file is
 *  shared, so this is "the last active commander desk" by design. */
export type CommanderPresence = 'working' | 'quiet' | 'missing' | 'unknown'

/** ⚠ THE HEARTBEAT ALONE IS NOT LIFE (2026-08-04). This used to be
 *  `manager?.fresh ? 'active' : 'standby'` — and `fresh` only means the
 *  heartbeat FILE was written inside its ten-minute window. A commander that
 *  beat once and then died (context overflow, an owner stop, a crash) kept the
 *  pane saying 「マネージャーが動いています / 1件あたり数分かかるのが普通です」
 *  for the rest of that window. On an unattended run that sentence is an
 *  instruction not to look.
 *
 *  The server now decides, from a fact the client cannot see — whether a live
 *  desk exists in either pool — and sends it as `managerPresence`. This reads
 *  that, and falls back to the heartbeat ONLY to tell 'quiet' from 'unknown'.
 *
 *  'unknown' is a real state, not a default: an older server (or a route that
 *  did not answer) says nothing, and "we do not know" must never be rendered as
 *  「卓がありません」. */
export const commanderPresence = (
  manager: EngineManagerHeartbeat | null,
  serverPresence?: SwarmManagerPresence,
): CommanderPresence => {
  if (serverPresence === 'working' || serverPresence === 'quiet' || serverPresence === 'missing')
    return serverPresence
  return 'unknown'
}

/** A state inconsistency the engine detected (mirrors the server's
 *  OrchestratorAnomaly) — surfaced as a warning so a drift the autonomy loop
 *  can't self-heal is noticed (条件2). */
export type EngineAnomalyKind =
  | 'orphan-doing'
  | 'worktree-missing'
  | 'worker-stale'
  | 'no-heartbeat'
  | 'move-stuck'
  | 'rework-exhausted'
  | 'review-panel-failed'
  | 'high-risk-hold'
  // Mirrors of the two LEVEL-TRIGGERED fatals (2026-08-04) — see the server's
  // OrchestratorAnomalyKind for why they exist as anomalies at all.
  | 'all-workers-down'
  | 'manager-unrevivable'

export interface EngineAnomaly {
  kind: EngineAnomalyKind
  /** Stable identity for the React key + dedup (taskId or branch). */
  ref: string
  branch?: string
  taskTitle?: string
  /** 'worker-stale' — minutes since the last heartbeat; 'no-heartbeat' —
   *  minutes since dispatch with zero beats (display-only). */
  staleMinutes?: number
  /** 'move-stuck' only — WHICH column move is stuck ('review' = a finished worker
   *  stuck in doing, 'done' = a landed branch stuck in review, 'recover' = a lost
   *  worker stuck in doing, 'recover-review' = a ready worker stopped at the
   *  execution ceiling whose card could not be returned to review), so the pane
   *  can name the exact zombie. */
  intent?: 'review' | 'done' | 'recover' | 'recover-review'
  /** 'move-stuck' — consecutive kept writes; 'rework-exhausted' — review→doing
   *  bounces before parking; 'review-panel-failed' — consecutive indecisive
   *  panels before re-spawning stopped (display-only). */
  attempts?: number
  /** 'high-risk-hold' — the changed paths that matched the high-risk set
   *  (release/CI/signing/dependency/secrets), i.e. WHY the merge is held for a
   *  human (display-only). */
  files?: string[]
}

/** KPI roll-up (the analytics layer) — mirrors the server's SwarmKpis. A `null`
 *  rate / median = "no data yet" (rendered as a dash, never 0%/0). */
export interface EngineKpis {
  /** Completed-card lead time todo→done: median (ms) + paired count. */
  leadTime: { medianMs: number | null; count: number }
  /** Of resolved integration attempts, the fraction that hit a conflict. */
  conflictRate: number | null
  /** Of review outcomes, the fraction sent back for rework (差し戻し). */
  reworkRate: number | null
  /** Of dispatched workers, the fraction whose work landed. */
  workerSuccessRate: number | null
  /** Raw lifetime counters (the rate denominators), since this engine session. */
  counts: {
    dispatched: number
    integrated: number
    conflicted: number
    reworked: number
    crashed: number
    stalled: number
  }
}

/** Consumption snapshot (the BUDGET layer) — mirrors the server's
 *  SwarmConsumption. The unattended loop's live load + session spend + its
 *  ceiling/over-limit flag. */
export interface EngineConsumption {
  /** Live workers the engine is driving this instant (稼働 worker 数). */
  activeWorkers: number
  /** Combined in-flight wall-clock run time of those live workers, ms (累積実行時間). */
  activeRunMs: number
  /** Workers dispatched this engine session — the cumulative spend proxy (概算消費). */
  dispatched: number
  /** The configurable per-session dispatch ceiling the warning compares against. */
  limit: number
  /** dispatched >= limit — the loop crossed its consumption ceiling (the warning). */
  overLimit: boolean
}

export interface SwarmEngineState {
  /** Autonomy — the drain+dispatch loop is scheduled (Card① start/stop). */
  running: boolean
  /** The owner EXPLICITLY paused the engine (Autonomy OFF) and hasn't turned it
   *  back ON. Server-composed: the engine's in-memory flag OR the persisted
   *  `Settings.swarmManualStop` record, so it stays true across a server restart
   *  — the UI can tell a DELIBERATE stop from a never-started engine. Display
   *  only; an explicit Start always clears it. */
  manualStop: boolean
  /** Overseer — the autonomous proxy-you brainstem (EPIC C). Default OFF,
   *  in-memory. ASYMMETRIC: an explicit autonomy OFF CLEARS it, so the owner
   *  re-arms it every session (no persisted reminder — D1). (The old `autoMerge`
   *  auto-wake toggle was retired 2026-07-16 — waking the commander is now always
   *  on while the engine runs.) */
  overseer: boolean
  /** Workers the engine itself dispatched and still counts as live. */
  workers: EngineWorker[]
  /** Review-column swarm cards + their integration readiness (read-only). */
  reviews: EngineReview[]
  /** State inconsistencies detected this pass (mirrors the server). Empty when
   *  everything is coherent; the manager pane renders these as warnings. */
  anomalies: EngineAnomaly[]
  /** Drain/dispatch/integrate journal, oldest-first (server ring buffer). */
  log: EngineLogLine[]
  /** Concurrency ceiling the engine reports (0 until the route answers). */
  maxWorkers: number
  /** KPI roll-up (the analytics layer) — see {@link EngineKpis}. */
  kpis: EngineKpis
  /** Consumption snapshot (the BUDGET layer) — see {@link EngineConsumption}. A
   *  SEPARATE dashboard section from `kpis`. */
  consumption: EngineConsumption
  /** Persisted "autonomy was ON last session" reminder (server
   *  `Settings.swarmAutonomyOn`). The engine always relaunches OFF — this is NOT
   *  an auto-resume — so the UI shows a one-click "resume?" prompt while
   *  `!running && autonomyRemembered`. Surfaced even before an engine exists this
   *  session (right after a restart). */
  autonomyRemembered: boolean
  /** This session's engine is running because the BOOT RESUME restored it, not
   *  because the owner pressed ON here (server `autonomyResumed`). The UI shows a
   *  "restored from your last session" notice off THIS, not off
   *  `autonomyRemembered && running` — that pair is equally true after a plain
   *  manual ON, which restored nothing. Cleared server-side by either power-switch
   *  action. */
  autonomyResumed: boolean
  /** The persisted "the overseer was armed when this project last wrote its intent"
   *  record (server `engine.json`). NEVER an auto-arm — a restart deliberately
   *  leaves the overseer OFF — so the UI offers a ONE-CLICK restore banner while
   *  `overseerRemembered && !overseer`. Dismissing it goes through its OWN endpoint
   *  (…/overseer/dismiss), never `overseer:false`, which would be a no-op here. */
  overseerRemembered: boolean
  /** The commander desk's heartbeat (see {@link EngineManagerHeartbeat}), or null
   *  when there is none to show (never written / unreadable / an action-ack
   *  response that omits it — the GET poll refills it within seconds). The UI
   *  degrades to the standby wording on null — never an error (fail-safe). */
  manager: EngineManagerHeartbeat | null
  /** The SERVER's display verdict about the commander desk (missing/quiet/working).
   *  Absent ⇒ the server did not say; the pane must read that as "unknown", never
   *  as "no desk". See commanderPresence. */
  managerPresence?: SwarmManagerPresence
  /** The LIVE commander desk handle from the server's both-pools read, or null
   *  (none live) / undefined (old server — field absent). What the tab's
   *  reconcile (deskReconcile.ts) adopts so an engine-woken desk attaches
   *  within one poll instead of the pane pinning to a dead pre-restart id. */
  managerDesk?: { runtime: 'pty' | 'sdk'; handleId: string; agentSessionId: string | null } | null
  /** Same for the supply desk (PTY-only by design). */
  supplyDesk?: { runtime: 'pty'; handleId: string; agentSessionId: string | null } | null
}

export const EMPTY_KPIS: EngineKpis = {
  leadTime: { medianMs: null, count: 0 },
  conflictRate: null,
  reworkRate: null,
  workerSuccessRate: null,
  counts: { dispatched: 0, integrated: 0, conflicted: 0, reworked: 0, crashed: 0, stalled: 0 },
}

export const EMPTY_CONSUMPTION: EngineConsumption = {
  activeWorkers: 0,
  activeRunMs: 0,
  dispatched: 0,
  limit: 0,
  overLimit: false,
}

export const DEFAULT_ENGINE: SwarmEngineState = {
  running: false,
  manualStop: false,
  overseer: false,
  workers: [],
  reviews: [],
  anomalies: [],
  log: [],
  maxWorkers: 0,
  kpis: EMPTY_KPIS,
  consumption: EMPTY_CONSUMPTION,
  autonomyRemembered: false,
  autonomyResumed: false,
  overseerRemembered: false,
  manager: null,
}

const KNOWN_LEVELS: ReadonlySet<string> = new Set(['info', 'warn', 'error'])
const KNOWN_REVIEW_STATUS: ReadonlySet<string> = new Set(['ff', 'rebase', 'conflict', 'unknown'])
const KNOWN_LOG_KINDS: ReadonlySet<string> = new Set([
  'routine', 'dispatch', 'promote', 'integrate', 'conflict', 'cleanup', 'crash',
])
// THERE IS NO ANOMALY ALLOWLIST ANY MORE (2026-08-04). There was, and it dropped
// a kind the server emitted TWICE: 'no-heartbeat' was invisible from whenever it
// shipped until 2026-07-14, and the same lockstep broke again for
// 'recover-review' four days later. A hand-kept registration list fails by
// SILENCE — the row simply never appears — which CLAUDE.md names as the
// direction to convert away. The identical hole was found in the fatal-event
// list the same night (four of eleven events discarded, including the one that
// means no worker can start at all).
//
// So any anomaly with a non-empty kind is now KEPT, and the pane renders an
// unlabelled kind with its raw name. Label coverage is checked by
// swarmOverseerFatalLabels.test.ts, which parses the server's union out of
// types.ts and fails LOUDLY on a missing entry.
const isRenderableAnomalyKind = (kind: string): boolean => kind.trim().length > 0
// Same lockstep rule as KNOWN_ANOMALY_KINDS above, and it was broken the same way
// on 2026-07-18: 'recover-review' was added to the type, to MOVE_INTENT_LABEL and
// to both locales, but NOT here — so this filter stripped it, `a.intent` went
// undefined, and the pane fell back to the bare generic label. That intent is the
// ONLY surface for a ready worker whose card could not be returned to 'review'
// (it is deliberately excluded from the blocked escalation), so dropping it hid
// the state entirely. Keep in lockstep with EngineAnomaly['intent'].
const KNOWN_MOVE_INTENTS: ReadonlySet<string> = new Set([
  'review', 'done', 'recover', 'recover-review',
])

/** Coerce the untrusted KPI roll-up — every field defended (a forged shape can
 *  answer the route). A non-finite rate → null (a dash, never a fake 0%); a
 *  median / count → a finite ≥0 number or its empty default. PURE — unit-tested
 *  alongside sanitizeEngineState. */
export const sanitizeKpis = (raw: unknown): EngineKpis => {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  // A rate is a fraction in [0,1] — CLAMP a finite value to that band (defence in
  // depth: a buggy/forged server response that ever reports > 1 can't render as
  // "150%"; the server's own land-vs-resolve discrimination is the primary guard).
  const rate = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null
  const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  const lt = o.leadTime && typeof o.leadTime === 'object' ? (o.leadTime as Record<string, unknown>) : {}
  const c = o.counts && typeof o.counts === 'object' ? (o.counts as Record<string, unknown>) : {}
  return {
    leadTime: {
      medianMs:
        typeof lt.medianMs === 'number' && Number.isFinite(lt.medianMs) && lt.medianMs >= 0
          ? lt.medianMs
          : null,
      count: count(lt.count),
    },
    conflictRate: rate(o.conflictRate),
    reworkRate: rate(o.reworkRate),
    workerSuccessRate: rate(o.workerSuccessRate),
    counts: {
      dispatched: count(c.dispatched),
      integrated: count(c.integrated),
      conflicted: count(c.conflicted),
      reworked: count(c.reworked),
      crashed: count(c.crashed),
      stalled: count(c.stalled),
    },
  }
}

/** Coerce the untrusted consumption snapshot — every numeric field defended to a
 *  finite ≥0 number (a forged shape can answer the route), `overLimit` a strict
 *  boolean. PURE — unit-tested alongside sanitizeKpis. */
export const sanitizeConsumption = (raw: unknown): EngineConsumption => {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)
  return {
    activeWorkers: num(o.activeWorkers),
    activeRunMs: num(o.activeRunMs),
    dispatched: num(o.dispatched),
    limit: num(o.limit),
    overLimit: o.overLimit === true,
  }
}

// The engine response is untrusted (on disk anything could answer the route), so
// coerce every field and drop malformed rows rather than letting a bad shape
// crash the render. Same defensive discipline as SwarmModule's localStorage
// loaders.
export const sanitizeEngineState = (raw: unknown): SwarmEngineState => {
  if (!raw || typeof raw !== 'object') return DEFAULT_ENGINE
  const o = raw as Record<string, unknown>

  const log = Array.isArray(o.log)
    ? o.log
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map((e, i): EngineLogLine => {
          const at = typeof e.at === 'string' ? e.at : ''
          const level =
            typeof e.level === 'string' && KNOWN_LEVELS.has(e.level)
              ? (e.level as EngineLogLevel)
              : 'info'
          return {
            id: `${at}-${i}`,
            at,
            level,
            message: typeof e.message === 'string' ? e.message : '',
            // Only known kinds are accepted; anything else folds to an
            // uncategorized (always-shown) event — defensive, like `level` above.
            ...(typeof e.kind === 'string' && KNOWN_LOG_KINDS.has(e.kind)
              ? { kind: e.kind as EngineLogKind }
              : {}),
          }
        })
        .slice(-200) // cap the rendered log — a long-running engine emits many
    : []

  const workers = Array.isArray(o.workers)
    ? o.workers
        .filter((w): w is Record<string, unknown> => !!w && typeof w === 'object')
        // ADDRESSABLE IN EITHER POOL — never "has a terminalId".
        //
        // This filter used to read `typeof w.terminalId === 'string'`, which is
        // the PTY-only question in its purest form. It survives today only by
        // luck: the engine still writes terminalId:'' for an SDK worker, so the
        // empty string satisfies the typeof. The day that field stops being
        // emitted (it carries no information for an SDK worker and the record
        // documents it as EMPTY), EVERY SDK worker silently vanishes from the
        // commander's monitor — no error, no warning, just an emptying roster
        // beside desks that are visibly working. Ask the question the identity
        // invariant actually poses: can this row be addressed in the pool it
        // claims (pty ⇔ terminalId, sdk ⇔ sdkSessionId)?
        // ⚠ NON-EMPTY, because `typeof '' === 'string'`. An SDK worker's
        // terminalId is ALWAYS the empty string by the identity invariant, so
        // the typeof form admits every row — including `{terminalId:'',
        // sdkSessionId:''}`, which is addressable in neither pool and is exactly
        // what `workerKey` throws on. The question is "can this row be addressed
        // in the pool it claims", and only a non-empty handle answers it.
        .filter((w) => Boolean(w.terminalId) || Boolean(w.sdkSessionId))
        .map((w): EngineWorker => ({
          terminalId: typeof w.terminalId === 'string' ? w.terminalId : '',
          // Carried, not dropped — see EngineWorker.sdkSessionId for the three
          // failures dropping them caused. Only a literal 'sdk' selects the SDK
          // renderer/address, matching the server's own "absent ⇒ pty" rule —
          // and only WITH a handle to address it by, so the sibling pair can
          // never be half-true (see sanitizeSwarmWorkers for the same rule).
          ...(w.runtime === 'sdk' && typeof w.sdkSessionId === 'string' && w.sdkSessionId
            ? { runtime: 'sdk' as const }
            : {}),
          ...(typeof w.sdkSessionId === 'string' && w.sdkSessionId
            ? { sdkSessionId: w.sdkSessionId }
            : {}),
          branch: typeof w.branch === 'string' ? w.branch : '',
          taskId: typeof w.taskId === 'string' ? w.taskId : '',
          taskTitle: typeof w.taskTitle === 'string' ? w.taskTitle : '',
          startedAt: typeof w.startedAt === 'string' ? w.startedAt : '',
          stage:
            w.stage === 'starting' || w.stage === 'running' || w.stage === 'done'
              ? w.stage
              : undefined,
          // Heartbeat passthrough (display-only) — coerced + omitted when blank.
          ...(typeof w.phase === 'string' && w.phase ? { phase: w.phase } : {}),
          ...(typeof w.note === 'string' && w.note ? { note: w.note } : {}),
          ...(typeof w.heartbeatAt === 'string' && w.heartbeatAt ? { heartbeatAt: w.heartbeatAt } : {}),
        }))
    : []

  const reviews = Array.isArray(o.reviews)
    ? o.reviews
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .filter((r) => typeof r.taskId === 'string')
        .map((r): EngineReview => ({
          taskId: String(r.taskId),
          branch: typeof r.branch === 'string' ? r.branch : '',
          taskTitle: typeof r.taskTitle === 'string' ? r.taskTitle : '',
          status:
            typeof r.status === 'string' && KNOWN_REVIEW_STATUS.has(r.status)
              ? (r.status as EngineReviewStatus)
              : 'unknown',
        }))
    : []

  const anomalies = Array.isArray(o.anomalies)
    ? o.anomalies
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .filter(
          (a) =>
            typeof a.kind === 'string' &&
            isRenderableAnomalyKind(a.kind) &&
            typeof a.ref === 'string' &&
            a.ref.length > 0,
        )
        .map((a): EngineAnomaly => ({
          kind: a.kind as EngineAnomalyKind,
          ref: String(a.ref),
          ...(typeof a.branch === 'string' ? { branch: a.branch } : {}),
          ...(typeof a.taskTitle === 'string' ? { taskTitle: a.taskTitle } : {}),
          ...(typeof a.staleMinutes === 'number' && Number.isFinite(a.staleMinutes)
            ? { staleMinutes: a.staleMinutes }
            : {}),
          ...(typeof a.intent === 'string' && KNOWN_MOVE_INTENTS.has(a.intent)
            ? { intent: a.intent as EngineAnomaly['intent'] }
            : {}),
          ...(typeof a.attempts === 'number' && Number.isFinite(a.attempts)
            ? { attempts: a.attempts }
            : {}),
          // 'high-risk-hold' — the matched paths; strings only, capped (defensive).
          ...(Array.isArray(a.files)
            ? { files: a.files.filter((f): f is string => typeof f === 'string').slice(0, 20) }
            : {}),
        }))
        .slice(0, 50) // cap — defensive against a forged huge list
    : []

  // The commander heartbeat (display-only presence line). Coerced whole-or-null:
  // a record missing/forging its updatedAt, ageMs, or fresh is dropped entirely —
  // the standby wording is the fail-safe direction (never a fake "active now").
  const manager = ((): EngineManagerHeartbeat | null => {
    const m = o.manager
    if (!m || typeof m !== 'object') return null
    const r = m as Record<string, unknown>
    if (typeof r.updatedAt !== 'string' || !r.updatedAt) return null
    if (typeof r.ageMs !== 'number' || !Number.isFinite(r.ageMs) || r.ageMs < 0) return null
    return {
      updatedAt: r.updatedAt,
      ageMs: r.ageMs,
      fresh: r.fresh === true,
      ...(typeof r.phase === 'string' && r.phase ? { phase: r.phase } : {}),
      ...(typeof r.note === 'string' && r.note ? { note: r.note } : {}),
    }
  })()

  // The live desk handles (whole-or-null-or-undefined). `undefined` is
  // MEANINGFUL here — an old server omits the field, and the reconcile treats
  // that as "keep the old behaviour", never as "no desk".
  const parseDesk = (
    v: unknown,
  ): { runtime: 'pty' | 'sdk'; handleId: string; agentSessionId: string | null } | null | undefined => {
    if (v === undefined) return undefined
    if (v === null || typeof v !== 'object') return null
    const r = v as Record<string, unknown>
    if (r.runtime !== 'pty' && r.runtime !== 'sdk') return null
    if (typeof r.handleId !== 'string' || !r.handleId) return null
    return {
      runtime: r.runtime,
      handleId: r.handleId,
      agentSessionId: typeof r.agentSessionId === 'string' ? r.agentSessionId : null,
    }
  }
  const managerDesk = parseDesk(o.managerDesk)
  // The server's display verdict. An unknown / absent value stays UNDEFINED, which
  // the pane reads as "we don't know" — never as "no desk". Narrowed against the
  // shared union so a typo on either side degrades to unknown rather than to a
  // confident wrong sentence.
  const managerPresence: SwarmManagerPresence | undefined =
    o.managerPresence === 'missing' || o.managerPresence === 'quiet' || o.managerPresence === 'working'
      ? o.managerPresence
      : undefined
  const supplyDeskRaw = parseDesk(o.supplyDesk)
  const supplyDesk =
    supplyDeskRaw && supplyDeskRaw.runtime === 'pty'
      ? { runtime: 'pty' as const, handleId: supplyDeskRaw.handleId, agentSessionId: supplyDeskRaw.agentSessionId }
      : supplyDeskRaw === undefined
        ? undefined
        : null

  return {
    ...(managerPresence !== undefined ? { managerPresence } : {}),
    running: o.running === true,
    // Strict boolean like `running`: a forged / absent value folds to FALSE — the
    // fail-safe direction (no spurious "stopped by hand" badge).
    manualStop: o.manualStop === true,
    overseer: o.overseer === true,
    workers,
    reviews,
    anomalies,
    log,
    maxWorkers: typeof o.maxWorkers === 'number' && Number.isFinite(o.maxWorkers) ? o.maxWorkers : 0,
    kpis: sanitizeKpis(o.kpis),
    consumption: sanitizeConsumption(o.consumption),
    autonomyRemembered: o.autonomyRemembered === true,
    // Strict booleans, same fail-safe direction as the rest: a forged / absent value
    // folds to FALSE ⇒ at worst a missing banner, never a spurious one.
    autonomyResumed: o.autonomyResumed === true,
    overseerRemembered: o.overseerRemembered === true,
    manager,
    ...(managerDesk !== undefined ? { managerDesk } : {}),
    ...(supplyDesk !== undefined ? { supplyDesk } : {}),
  }
}

// ── Fatal-event notifications (条件3) ─────────────────────────────────────────
// The escalation safety valve (card 6fe48c1f) PERSISTS every fatal event of the
// unmanned loop as a notification, surfaced by GET /api/swarm/notifications. The
// flow pane reads THESE — the AUTHORITATIVE source — for its "needs attention"
// banner, so every fatal kind shows: the engine-side ones (rework-exhausted /
// all-workers-down / exec-timeout / review-panel-failed) AND the two that come
// from the Electron self-update cycle (rollback / canary-failed) and never touch
// the engine state at all. Mirrors the server's SwarmFatalEvent /
// SwarmFatalNotification (a LOCAL mirror keeps this front-end decoupled, like the
// engine-state mirror above).
/** The events this client can NAME. `string` is deliberately part of the union:
 *  the server's list is longer and grows independently, and dropping the rest
 *  meant losing the alerts that matter most (see isRenderableFatalEvent). The
 *  named members keep autocomplete and the label map exhaustive-checkable; the
 *  `string` arm is what stops an unknown event from being discarded. */
export type SwarmFatalEventKind =
  | 'rework-exhausted'
  | 'all-workers-down'
  | 'exec-timeout'
  | 'rollback'
  | 'canary-failed'
  | 'review-panel-failed'
  | 'high-risk-hold'
  // The commander desk is up but not integrating and has ignored every nudge
  // (2026-08-14). Named here so it keeps autocomplete + the exhaustive label
  // check; the `string` arm below is what guarantees it renders regardless.
  | 'manager-unresponsive'
  | (string & {})

export interface SwarmFatalView {
  /** Stable React key (the persisted notification id). */
  id: string
  event: SwarmFatalEventKind
  /** Server-composed one-line summary of WHAT happened (Japanese specifics). */
  detail: string
  /** The `swarm/*` branch involved, when known (display-only). */
  branch?: string
  /** The card title involved, when known (display-only). */
  taskTitle?: string
  taskId?: string
  /** A one-line pointer to where to dig in (engine log / Board column). */
  logHint?: string
  /** The project this fatal concerns — absent for app-global self-update events
   *  (rollback / canary-failed), which aren't card-rooted. */
  projectPath?: string
  /** Epoch ms — newest-first ordering + the relative-time token. */
  createdAt?: number
  /** The owner marked this row handled (server-side `handledAt`), so the
   *  needs-attention feed hides it. NOT the bell's read-state: opening the bell
   *  marks everything SEEN, which must not empty a work list. */
  handled?: boolean
}

/** ⚠ THE ALLOWLIST USED TO DROP ROWS, AND THAT IS THE WRONG DIRECTION.
 *
 *  This is the SAFETY channel — the one place a swarm failure reaches the owner.
 *  It filtered on a hand-written list of 7 events while the server's
 *  SwarmFatalEvent union has 11, with no compile-time link between them, so four
 *  real alerts were discarded in silence: `guard-unwired` (the deterministic
 *  deny veto could not be verified — every worker spawn is now refused),
 *  `manager-unrevivable`, `engine-resume-suppressed` (autonomy did not come back
 *  after a restart) and `data-integrity` (home data lost entries). With none of
 *  them rendered the pane showed its "all quiet — nothing for you to do" state
 *  while the engine could not start a single worker.
 *
 *  A registration list fails by SILENCE, which CLAUDE.md names as the direction
 *  to avoid. So an unrecognised event is now KEPT and rendered with its raw
 *  event string as the label: a row the owner does not recognise is a question
 *  they can ask, where a missing row is a failure they never learn about. */
const isRenderableFatalEvent = (event: string): boolean => event.trim().length > 0

// The notifications file is untrusted on disk (hand-editable), so coerce every
// field and drop malformed rows — the SAME defensive discipline as
// sanitizeEngineState. Reads the AppNotificationsResponse shape
// ({ notifications: [{ id, kind, createdAt, swarmFatal }] }), keeps only the
// 'swarm-fatal' rows with a known event, newest-first.
export const sanitizeFatalNotifications = (raw: unknown): SwarmFatalView[] => {
  if (!raw || typeof raw !== 'object') return []
  const arr = (raw as Record<string, unknown>).notifications
  if (!Array.isArray(arr)) return []
  const out: SwarmFatalView[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (o.kind !== 'swarm-fatal') continue
    const f = o.swarmFatal
    if (!f || typeof f !== 'object') continue
    const sf = f as Record<string, unknown>
    if (typeof sf.event !== 'string' || !isRenderableFatalEvent(sf.event)) continue
    const createdAt =
      typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) ? o.createdAt : undefined
    out.push({
      id: typeof o.id === 'string' && o.id ? o.id : `${sf.event}:${out.length}`,
      event: sf.event as SwarmFatalEventKind,
      detail: typeof sf.detail === 'string' ? sf.detail : '',
      ...(typeof sf.branch === 'string' && sf.branch ? { branch: sf.branch } : {}),
      ...(typeof sf.taskTitle === 'string' && sf.taskTitle ? { taskTitle: sf.taskTitle } : {}),
      ...(typeof sf.taskId === 'string' && sf.taskId ? { taskId: sf.taskId } : {}),
      ...(typeof sf.logHint === 'string' && sf.logHint ? { logHint: sf.logHint } : {}),
      ...(typeof sf.projectPath === 'string' && sf.projectPath ? { projectPath: sf.projectPath } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      // Marked handled by the owner from the needs-attention feed (server-side
      // `handledAt`, NOT the bell's read-state — see markSwarmNotificationHandled).
      ...(typeof o.handledAt === 'number' && Number.isFinite(o.handledAt) ? { handled: true } : {}),
    })
  }
  // Newest-first (the route already sorts, but don't trust on-disk order).
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return out
}

// ── Env preflight (git/shell) — mirrors the server's SwarmEnvIssue/Result
// (src/lib/server/swarmEnvPreflight.ts). The SAME check the worker/supply/
// manager spawn routes gate on, polled here as a plain read so the Swarm tab
// can show every unmet prerequisite as ONE banner before the owner ever
// presses a launch button, instead of only discovering it as a failed spawn.
export type SwarmEnvIssueId = 'gitMissing' | 'notAGitRepo' | 'shellMissing'

export interface SwarmEnvIssue {
  id: SwarmEnvIssueId
}

// Exported so a client call site that only gets the terse 503 body shape
// (`{ envIssues: string[] }` — see the /worker /supply /manager spawn routes)
// can validate ids itself without duplicating this list (SwarmModule.tsx's
// envIssuesErrorMessage).
export const KNOWN_ENV_ISSUE_IDS: ReadonlySet<string> = new Set([
  'gitMissing', 'notAGitRepo', 'shellMissing',
])

// The route response is untrusted like every other one — keep only known ids
// (an id the client has no copy for would render as an empty banner row).
export const sanitizeEnvIssues = (raw: unknown): SwarmEnvIssue[] => {
  if (!raw || typeof raw !== 'object') return []
  const arr = (raw as Record<string, unknown>).issues
  if (!Array.isArray(arr)) return []
  const out: SwarmEnvIssue[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const id = (item as Record<string, unknown>).id
    if (typeof id === 'string' && KNOWN_ENV_ISSUE_IDS.has(id)) {
      out.push({ id: id as SwarmEnvIssueId })
    }
  }
  return out
}

const KNOWN_ORCH_STAGES: ReadonlySet<string> = new Set(['starting', 'running', 'done'])

/** Non-empty string, else absent. The house rule for every optional text field
 *  on the wire: an empty string carries no information and writing it would make
 *  a JSON round-trip differ from what the server actually sent. */
const wireString = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
/** STRICTLY `true`, else absent — a forged `'yes'` / `1` must never read as a
 *  worker declaring itself ready or blocked. */
const wireTrue = (v: unknown): true | undefined => (v === true ? true : undefined)

/** One coercer per field of {@link SwarmWorkerRecord}, `undefined` ⇒ omit the key.
 *
 *  ⚠ WRITTEN AS A MAPPED TYPE OVER THE RECORD ON PURPOSE — do NOT "simplify" it
 *  back into a hand-written object literal that copies fields one at a time.
 *  A mapped type over `Required<SwarmWorkerRecord>` makes the two halves of this
 *  contract impossible to drift: a field added to the record and not to this
 *  table is a COMPILE error ("Property 'x' is missing in type"), and a key here
 *  that the record does not have is one too. The old copy-each-field shape could
 *  say nothing when they drifted — and they did drift, silently, in the one place
 *  it mattered most:
 *
 *  the server carries `runtime` + `sdkSessionId` all the way through
 *  swarmWorkerRegistry.ts SPECIFICALLY so the tab can tell an SDK worker from a
 *  PTY one, and this function dropped both. Every SDK worker therefore reached
 *  the render as `runtime: undefined` (⇒ 'pty') with no terminalId, fell through
 *  to the PTY renderer, and was drawn as an ENDED session — with a Restart button
 *  wired to the PTY path, over a `claude` that was alive and working. The SDK tile
 *  (SdkWorkerPane) and its stop button were unreachable dead code in production.
 *
 *  The end-to-end guard is useSwarmEngine.workerWireContract.test.ts: it runs the
 *  REAL server builder and this REAL sanitizer over one record and asserts nothing
 *  is lost — so "the server sends it, the client drops it" fails a test, not a
 *  release. */
type SwarmWorkerFieldCoercers = {
  [K in keyof Required<SwarmWorkerRecord>]: (v: unknown) => SwarmWorkerRecord[K] | undefined
}

const SWARM_WORKER_FIELDS: SwarmWorkerFieldCoercers = {
  worktree: wireString,
  branch: wireString,
  terminalId: wireString,
  // Only the two runtimes the client can actually render. Anything else (a
  // forged value, a runtime a newer server knows and this client does not)
  // folds to absent ⇒ 'pty', which is the server's own "absent ⇒ pty" rule and
  // the only renderer this build is sure it has.
  runtime: (v) => (v === 'sdk' || v === 'pty' ? v : undefined),
  sdkSessionId: wireString,
  taskId: wireString,
  taskTitle: wireString,
  startedAt: wireString,
  stage: (v) =>
    typeof v === 'string' && KNOWN_ORCH_STAGES.has(v)
      ? (v as SwarmWorkerRecord['stage'])
      : undefined,
  phase: wireString,
  note: wireString,
  heartbeatAt: wireString,
  ready: wireTrue,
  blocked: wireTrue,
  blockers: wireString,
}

/** Every field this sanitizer carries — i.e. every field of `SwarmWorkerRecord`,
 *  because the table above is exhaustive BY TYPE.
 *
 *  Exported so the wire-contract test can assert its FIXTURE still exercises all
 *  of them. That closes the last hole: a new field is a compile error until it is
 *  added to the table, adding it to the table grows this list, and growing this
 *  list turns the contract test red until a real server-built record actually
 *  carries the field through. Without that ratchet the contract test would keep
 *  passing on a fixture that no longer covers what the server sends. */
export const SWARM_WORKER_KEYS = Object.keys(SWARM_WORKER_FIELDS) as (keyof SwarmWorkerRecord)[]

// GET /api/swarm/workers is the SERVER-TRUTH worker list (project_swarm_worker_registry):
// live PTYs + live SDK sessions + the engine's own roster + heartbeat files, already
// unified server-side — see src/lib/server/swarmWorkerRegistry.ts. Untrusted like every
// other route response, so coerce every field and drop a row with no identifiable
// worktree/branch rather than letting a bad shape crash the render.
export const sanitizeSwarmWorkers = (raw: unknown): SwarmWorkerRecord[] => {
  if (!raw || typeof raw !== 'object') return []
  const arr = (raw as Record<string, unknown>).workers
  if (!Array.isArray(arr)) return []
  const out: SwarmWorkerRecord[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const row: Record<string, unknown> = {}
    for (const key of SWARM_WORKER_KEYS) {
      const value = SWARM_WORKER_FIELDS[key](o[key])
      // Omit rather than write `undefined`: the record is compared against the
      // server's own object in the wire-contract test, and an explicit
      // `undefined` key is a different object than an absent one.
      if (value !== undefined) row[key] = value
    }
    // SIBLING INVARIANT: runtime 'sdk' ⇔ a usable sdkSessionId.
    //
    // The coercer table above is exhaustive by TYPE but blind ACROSS fields —
    // each coercer sees one value and nothing else — so `{runtime:'sdk'}` with no
    // session handle sailed straight through, and the record's central invariant
    // (pty ⇔ terminalId, sdk ⇔ sdkSessionId) was true of the server and merely
    // hoped for here. A record that claims the SDK pool but names no session in
    // it is addressable by NOBODY: the SDK tile can't mount (SwarmModule checks
    // both), and `stopWorkerDesk` takes the sdk arm, finds no id, falls through,
    // finds no terminalId either — so a "restart" would spawn a second claude
    // into a worktree the first may still be writing in. That is the twin
    // hazard, reached from a malformed payload.
    //
    // Fold the CLAIM, keep the row: without the claim it is exactly the shape of
    // a dead worker (no runtime, no id, worktree intact), which is a real state
    // this UI already handles honestly — visible, terminable, restartable.
    // Dropping the row instead would hide a worktree that exists on disk.
    if (row.runtime === 'sdk' && typeof row.sdkSessionId !== 'string') delete row.runtime
    // Identity. A row without both of these cannot be keyed, addressed, or acted
    // on, so it is dropped instead of rendered as a nameless tile. Re-stating the
    // two narrowed values in the pushed object is what lets the assertion hold:
    // a bare `Record<string, unknown>` has no overlap with the record type.
    const { worktree, branch } = row
    if (typeof worktree !== 'string' || typeof branch !== 'string') continue
    out.push({ ...row, worktree, branch } as SwarmWorkerRecord)
  }
  return out
}

// ── The single master power switch's contract (条件: 単一の開始/停止スイッチ) ─────
// One control governs the whole Swarm tab's "power". Turning it ON starts the
// autonomous orchestrator engine (which drains the Board's todo column and
// dispatches workers) AND launches the commander (/manage) + supply (/supply)
// conversations TOGETHER. Turning it OFF only halts NEW dispatch — the engine
// stops, but running workers finish on their own and their worktrees/branches
// are kept (this switch never tears anything down or kills a conversation).
//
// This pure planner is the SINGLE source of those semantics, so the idempotency
// rules are unit-testable without React: ON never re-starts an already-running
// engine and never re-launches a conversation that's already up
// (既に起動済みなら二重起動しない); OFF only ever stops the engine and never
// touches the conversations. SwarmModule executes the plan against the actions
// it owns (toggleAutonomy / launchSupply / launchManager), each of which ALSO
// guards itself — so the planner is the documented contract and the action
// guards are the second line of defence.
export interface SwarmPowerInputs {
  /** The orchestrator engine is currently running (its drain+dispatch loop). */
  running: boolean
  /** A supply (補給官 /supply) conversation session already exists. */
  hasSupply: boolean
  /** A commander (司令官 /manage) conversation session already exists. */
  hasManager: boolean
}

export interface SwarmPowerPlan {
  /** Desired engine state to set, or undefined when no change is needed (ON while
   *  already running, or OFF while already stopped). */
  engine?: boolean
  /** Launch the supply conversation (ON only, and only when it's not already up). */
  launchSupply: boolean
  /** Launch the commander conversation (ON only, and only when it's not already up). */
  launchManager: boolean
}

/** Decide what flipping the master switch to `on` should do, given what's already
 *  running. PURE — no React, no fetch — so the idempotency + OFF-stops-dispatch-only
 *  semantics are locked by a unit test. */
export const planSwarmPower = (on: boolean, s: SwarmPowerInputs): SwarmPowerPlan =>
  on
    ? {
        // Start the engine only if it isn't already running (idempotent).
        ...(s.running ? {} : { engine: true }),
        // Launch each conversation only if it isn't already up (no double-launch).
        launchSupply: !s.hasSupply,
        launchManager: !s.hasManager,
      }
    : {
        // OFF stops the engine only — and only if it's actually running. The
        // conversations are LEFT ALONE (条件: オフは新規 dispatch の停止のみ).
        ...(s.running ? { engine: false } : {}),
        launchSupply: false,
        launchManager: false,
      }

// Poll cadence matches SwarmModule's other polls (Ground beacon / Board): every
// 5s, skipped while hidden, re-polled on focus.
export const ENGINE_POLL_MS = 5_000

export interface UseSwarmEngine {
  /** Latest engine state (DEFAULT_ENGINE until the route answers). */
  engine: SwarmEngineState
  /** Persisted fatal-event notifications for THIS project (条件3) — the escalation
   *  safety valve's authoritative source, polled on the same cadence as `engine`.
   *  Empty until the owner-only route answers (a 403 / 404 / throw → empty). */
  fatalNotifications: SwarmFatalView[]
  /** Ids dismissed from the needs-attention feed in THIS session — the optimistic
   *  half, so a clicked row vanishes immediately rather than on the next lap. The
   *  durable record is `SwarmFatalView.handled` (server-side `handledAt`). */
  handledFatalIds: ReadonlySet<string>
  /** Mark ONE fatal notification handled: optimistic locally, then persisted via
   *  POST /api/swarm/notifications/handled. Deliberately NOT the bell's
   *  read-state — "seen the bell" must not empty this work list. */
  markFatalHandled: (id: string) => void
  /** The SERVER-TRUTH worker list (GET /api/swarm/workers, polled on the same
   *  cadence) — the single source the Swarm worker tab renders, so a worker
   *  started ANY way (engine dispatch, the Board 実行 button, or a direct
   *  `POST /api/swarm/worker`) shows up. Empty until the route answers. */
  realWorkers: SwarmWorkerRecord[]
  /** Whether the orchestrator route answered at all (false = not built / offline:
   *  the dashboard switches dim instead of firing a POST that 404s). */
  available: boolean
  /** A start/stop or overseer round-trip is in flight (disables the switches). */
  busy: boolean
  /** Last engine-action failure, already localized. */
  error: string | null
  /** The overseer was armed WITHOUT the sandbox experiment (L3) — the manager pane
   *  shows a reduced-containment note. False whenever the overseer is off. */
  sandboxWarning: boolean
  /** Unmet git/shell prerequisites for spawning a swarm session in this project
   *  (GET /api/swarm/preflight — swarmEnvPreflight, the same gate the worker/
   *  supply/manager spawn routes enforce). Empty when everything checks out or
   *  the route hasn't answered yet (never blocks rendering on this alone). */
  envIssues: SwarmEnvIssue[]
  /** Re-read `envIssues` NOW, bypassing the server's 10s preflight cache
   *  (`?force=1`) — for the moment right after the owner fixes a prerequisite
   *  through the UI (the banner's one-click git set-up), when waiting up to a
   *  poll lap + cache TTL would leave a solved problem on screen. Resolves once
   *  the fresh answer (or a swallowed failure — the next poll reconciles) has
   *  been applied. */
  refreshEnvPreflight: () => Promise<void>
  /** Autonomy switch (Card①) — start/stop the drain+dispatch loop. */
  toggleAutonomy: (next: boolean) => void
  /** Dismiss the restart "autonomy was on — resume?" reminder without resuming:
   *  clears the persisted marker (POST stop → forgetSwarmAutonomy). Distinct from
   *  toggleAutonomy(false), which no-ops when the engine is already stopped. */
  dismissAutonomyReminder: () => void
  /** Overseer switch (EPIC C / C-core) — arm/disarm the autonomous proxy-you
   *  brainstem. Reads back `sandboxWarning` when arming without the sandbox (L3). */
  toggleOverseer: (next: boolean) => void
  /** Dismiss the OVERSEER restore reminder (card 2b) without restoring: clears the
   *  persisted `overseer:true` in engine.json through its OWN endpoint. Distinct
   *  from toggleOverseer(false), which is a guaranteed NO-OP while the banner is up
   *  (the overseer is already disarmed, so nothing is written and the banner
   *  returns on the next poll — the d1d6d704 trap). */
  dismissOverseerReminder: () => void
  /** Stop ONE engine-dispatched worker by its PTY id: the server tears down its
   *  worktree + PTY and parks its card in 'blocked', then this adopts the fresh
   *  state. A no-op while another engine round-trip is in flight. */
  stopWorker: (terminalId: string) => void
  /** Resolve a STUCK review card the engine can't auto-land (a real conflict /
   *  repeatedly-failing verification): the server moves it OUT of review ('blocked'
   *  to park for manual resolution, 'todo' to requeue a fresh worker), clears its
   *  conflict flag + memos, and this adopts the fresh state. A no-op while another
   *  engine round-trip is in flight. */
  resolveReview: (taskId: string, target: 'blocked' | 'todo') => void
}

/** Own the commander engine's state for one project: one poll, the two switches,
 *  and the available/busy/error bookkeeping. Called ONCE by SwarmModule so the
 *  worker tab and the manager dashboard share a single snapshot. */
export const useSwarmEngine = (projectPath: string): UseSwarmEngine => {
  const { t } = useT()

  const [engine, setEngine] = useState<SwarmEngineState>(DEFAULT_ENGINE)
  // Persisted fatal-event notifications for THIS project (条件3), polled alongside
  // the engine state in the same poll loop below (one interval, two endpoints).
  const [fatalNotifications, setFatalNotifications] = useState<SwarmFatalView[]>([])
  // Ids dismissed from the needs-attention feed during THIS session, held only so
  // the row disappears under the click instead of on the next 5s lap. The durable
  // record is the notification's own server-side `handledAt` (sanitized into
  // SwarmFatalView.handled), so nothing here needs to survive a reload.
  const [handledFatalIds, setHandledFatalIds] = useState<ReadonlySet<string>>(() => new Set())
  // The server-truth worker list, polled alongside the engine state (one
  // interval, three endpoints) so the worker tab never needs a second poll.
  const [realWorkers, setRealWorkers] = useState<SwarmWorkerRecord[]>([])
  const [available, setAvailable] = useState(false)
  // A start/stop or overseer round-trip is in flight — disables the switches.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // L3: the overseer was armed WITHOUT the sandbox experiment — the UI shows a
  // reduced-containment note. Set from the overseer toggle response; cleared when the
  // overseer is off. Advisory only (the structural READ-ONLY design + budget hold).
  const [sandboxWarning, setSandboxWarning] = useState(false)
  // Unmet git/shell prerequisites (GET /api/swarm/preflight), polled alongside
  // the engine state below (one interval, one more endpoint).
  const [envIssues, setEnvIssues] = useState<SwarmEnvIssue[]>([])

  // ── Poll concurrency guards ──────────────────────────────────────────────
  // The poll's OWN in-flight flag. Deliberately NOT `busy`: `busy` means "a
  // start/stop/overseer round-trip is in flight" (and is a dep of the poll
  // effect below), which says nothing about whether a poll lap is still
  // running. Merging the two would break the toggle guard's meaning.
  const pollInFlightRef = useRef(false)
  // Per-lap generation. Every lap stamps itself and the poll effect's cleanup
  // bumps the counter; a lap applies its setState only while its stamp is still
  // the newest, so a slow lap landing after a newer one can't clobber it. This
  // generalizes React's per-effect cleanup flag (react.dev "Synchronizing with
  // Effects" — "it doesn't matter in which order the requests complete"): that
  // flag is per-EFFECT and is therefore blind to the lap-vs-lap race that
  // overlapping ticks INSIDE one effect create.
  const pollSeqRef = useRef(0)

  // Reset when the hook is reused for another project (SwarmModule keeps one
  // instance across project switches, like the worker/supply state it resets).
  useEffect(() => {
    setEngine(DEFAULT_ENGINE)
    setFatalNotifications([])
    setHandledFatalIds(new Set())
    setRealWorkers([])
    setAvailable(false)
    setBusy(false)
    setError(null)
    setEnvIssues([])
  }, [projectPath])

  // Poll the orchestrator state. A non-ok response (the route 404s on an old
  // server) or a throw → available:false + DEFAULT_ENGINE, never an unhandled
  // error. We skip while a toggle is mid-flight so its authoritative response
  // isn't clobbered by a stale read landing a moment later.
  //
  // The reads are INDEPENDENT routes, so they fire in PARALLEL and land as one
  // snapshot. Serial awaits made a lap cost the SUM of four fs-reading routes;
  // under swarm load (load average 5-7, where pure I/O in this repo stretches to
  // 5-7s — measured in card d44b5ff0) that exceeds ENGINE_POLL_MS and laps start
  // overlapping — exactly when the commander is busiest.
  useEffect(() => {
    const poll = async () => {
      if (document.hidden) return
      // One lap at a time: a tick arriving while the previous lap is still in
      // flight is DROPPED, not queued.
      if (pollInFlightRef.current) return
      pollInFlightRef.current = true
      const seq = ++pollSeqRef.current
      // Each read absorbs its OWN failure and returns the state update to apply.
      // The per-read contract is unchanged (non-ok / throw ⇒ not-available /
      // empty); what changes is that one dead or slow route can no longer hold
      // up — nor take down — the others.
      const readEngine = async (): Promise<() => void> => {
        // 1) Engine orchestrator state (ok ⇒ available + state, non-ok / throw ⇒
        //    not available — the engine snapshot itself is left untouched).
        try {
          const res = await fetch(`/api/swarm/orchestrator?path=${encodeURIComponent(projectPath)}`)
          if (!res.ok) return () => setAvailable(false)
          const state = sanitizeEngineState(await res.json())
          return () => {
            setAvailable(true)
            setEngine(state)
          }
        } catch {
          return () => setAvailable(false)
        }
      }
      const readFatals = async (): Promise<() => void> => {
        // 2) Persisted fatal-event notifications for THIS project (条件3) — the
        //    escalation valve's authoritative source. Owner-gated; a 403 / 404 /
        //    throw ⇒ empty (never an error). App-global self-update fatals
        //    (rollback / canary-failed) carry no projectPath, so they pass the
        //    filter and surface in the loop view too; other projects' card-rooted
        //    fatals are filtered out.
        try {
          const res = await fetch('/api/swarm/notifications')
          const next = res.ok
            ? sanitizeFatalNotifications(await res.json()).filter(
                (n) => !n.projectPath || n.projectPath === projectPath,
              )
            : []
          return () => setFatalNotifications(next)
        } catch {
          return () => setFatalNotifications([])
        }
      }
      const readWorkers = async (): Promise<() => void> => {
        // 3) The SERVER-TRUTH worker list (GET /api/swarm/workers) — same
        //    owner-gated / non-ok-degrades-to-empty contract. Polled here (not a
        //    second interval) so the worker tab and the manager dashboard share
        //    this one snapshot too.
        try {
          const res = await fetch(`/api/swarm/workers?path=${encodeURIComponent(projectPath)}`)
          const next = res.ok ? sanitizeSwarmWorkers(await res.json()) : []
          return () => setRealWorkers(next)
        } catch {
          return () => setRealWorkers([])
        }
      }
      const readEnv = async (): Promise<() => void> => {
        // 4) Env preflight (git/shell) — the SAME gate the worker/supply/manager
        //    spawn routes enforce, polled here as a plain read so the Swarm tab
        //    can show every unmet prerequisite as ONE banner before the owner
        //    presses a launch button. Same owner-gated / non-ok-degrades-to-empty
        //    contract; folded into the parallel lap below (not a trailing await)
        //    so it shares the generation guard instead of the removed `cancelled`
        //    flag.
        try {
          const res = await fetch(`/api/swarm/preflight?path=${encodeURIComponent(projectPath)}`)
          const next = res.ok ? sanitizeEnvIssues(await res.json()) : []
          return () => setEnvIssues(next)
        } catch {
          return () => setEnvIssues([])
        }
      }
      try {
        // 1b) DRAIN-TICK: since card eadb25e6 the server side is a PURE idempotent
        //     state read — it no longer auto-starts a stopped engine (autonomy is
        //     strict opt-in via the Start toggle → POST /orchestrator/start; merely
        //     having this pane open must not spin up workers). The POST is kept for
        //     back-compat with older servers and as the seam a future
        //     consent-carrying tick would ride. Fire-and-forget + owner-gated: a
        //     403/404/throw is harmless, and being a pure read it needs no ordering
        //     against the GETs beside it. Skipped while a toggle is in flight (this
        //     runs inside the busy-guarded poll), so it never fights a manual ON/OFF.
        void fetch('/api/swarm/orchestrator/drain-tick', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: projectPath }),
        }).catch(() => {})
        // allSettled, not all: a reader that throws despite its own try/catch (a
        // sanitize bug, say) must not swallow its siblings' results.
        const settled = await Promise.allSettled([readEngine(), readFatals(), readWorkers(), readEnv()])
        // A lap superseded by a newer generation applies NOTHING. This replaces
        // the old effect-wide `cancelled` flag (same job for the cleanup case)
        // and additionally covers the lap-vs-lap race it was blind to.
        if (seq !== pollSeqRef.current) return
        for (const r of settled) if (r.status === 'fulfilled') r.value()
      } finally {
        // Release the slot only while we still own it: a superseded lap must not
        // clear the flag out from under the newer lap that replaced it.
        if (seq === pollSeqRef.current) pollInFlightRef.current = false
      }
    }
    // The effect re-runs when `busy` flips (it's a dep so the interval closure
    // sees fresh `busy`). Guard the immediate poll too — without it, toggling a
    // switch (which sets busy:true) re-runs the effect and fires a poll that can
    // land the server's PRE-toggle state and momentarily clobber the optimistic
    // flip before the POST response confirms it. Skip while a toggle is in flight.
    if (!busy) void poll()
    const id = window.setInterval(() => {
      if (!busy) void poll()
    }, ENGINE_POLL_MS)
    const onFocus = () => {
      if (!busy) void poll()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      // Retire every lap of THIS effect (bump the generation) and free the
      // in-flight slot so the next effect can poll immediately — a retired lap
      // can no longer setState, so the brief overlap is harmless.
      // The lint rule warns that `pollSeqRef.current` may have changed since the
      // effect ran — here that is exactly the point: this is a generation
      // counter, not a handle on a rendered node, and we WANT to advance
      // whatever the newest value is at teardown time.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      pollSeqRef.current++
      pollInFlightRef.current = false
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectPath, busy])

  // One-off env-preflight re-read with force=1 — the moment right after the
  // owner fixes a prerequisite through the UI (SwarmModule's one-click git
  // set-up): without force the server's 10s preflight cache would keep
  // answering the pre-fix "not a repo", and the banner would linger up to a
  // cache TTL + poll lap past the fix. Retires any in-flight poll lap FIRST
  // (generation bump — the same mechanism the effect cleanup uses) so a lap
  // that fetched the PRE-fix answer can't land after this and resurrect the
  // banner; the lap's sibling reads are dropped too, which the next 5s lap
  // repairs. A failed refresh keeps the current banner for the poll to
  // reconcile — never a throw.
  const refreshEnvPreflight = useCallback(async () => {
    pollSeqRef.current++
    pollInFlightRef.current = false
    try {
      const res = await fetch(
        `/api/swarm/preflight?path=${encodeURIComponent(projectPath)}&force=1`,
      )
      if (res.ok) setEnvIssues(sanitizeEnvIssues(await res.json()))
    } catch {
      // Keep the current issues; the next poll lap reconciles.
    }
  }, [projectPath])

  // POST an engine action and adopt the authoritative state it returns. All
  // (start / stop / overseer) return the full SwarmOrchestratorState; an
  // old server without the route 404s and the caller surfaces "not available".
  const callEngine = useCallback(
    async (action: 'start' | 'stop' | 'overseer', extra: Record<string, unknown>) => {
      const res = await fetch(`/api/swarm/orchestrator/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath, ...extra }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      return sanitizeEngineState(await res.json())
    },
    [projectPath],
  )

  // Autonomy switch — start/stop the engine loop (Card①). Optimistic flip, then
  // adopt the server's state; on failure revert and surface why.
  const toggleAutonomy = useCallback(
    async (next: boolean) => {
      if (busy || next === engine.running) return
      setBusy(true)
      setError(null)
      setEngine((s) => ({ ...s, running: next }))
      try {
        const fresh = await callEngine(next ? 'start' : 'stop', {})
        setEngine(fresh)
        setAvailable(true)
      } catch (e) {
        setEngine((s) => ({ ...s, running: !next }))
        setError(
          t('projectPanel.swarm.manager.engineFailed', { error: e instanceof Error ? e.message : String(e) }),
        )
      } finally {
        setBusy(false)
      }
    },
    [busy, engine.running, callEngine, t],
  )

  // Dismiss the restart reminder — the owner chose NOT to resume. POSTs 'stop'
  // (which clears the persisted marker via forgetSwarmAutonomy on the server)
  // UNCONDITIONALLY: toggleAutonomy short-circuits a no-op stop (next === running,
  // both false while the banner is up), but here it is the SERVER MARKER that must
  // change, not `running`. The banner is gated on autonomyRemembered, so flip that
  // off optimistically and adopt the server's (marker-cleared) state.
  const dismissAutonomyReminder = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setEngine((s) => ({ ...s, autonomyRemembered: false }))
    try {
      const fresh = await callEngine('stop', {})
      setEngine(fresh)
      setAvailable(true)
    } catch (e) {
      setEngine((s) => ({ ...s, autonomyRemembered: true })) // revert — still remembered
      setError(
        t('projectPanel.swarm.manager.engineFailed', { error: e instanceof Error ? e.message : String(e) }),
      )
    } finally {
      setBusy(false)
    }
  }, [busy, callEngine, t])

  // Dismiss the OVERSEER restore reminder (card 2b) — the owner saw the banner and
  // chose not to bring the overseer back. Its OWN endpoint, never toggleOverseer(false):
  // while the banner is up the overseer is by definition already disarmed, so a
  // `enabled:false` POST hits setOverseer's change-guard, never reaches the persist, and
  // leaves engine.json still saying true — the banner would return on the next poll and
  // [×] would be a no-op forever (the d1d6d704 trap, one toggle over). Unconditional
  // (no `next === current` short-circuit) for the same reason: it is the SERVER RECORD
  // that must change here, not an in-memory arm flag.
  const dismissOverseerReminder = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setEngine((s) => ({ ...s, overseerRemembered: false }))
    try {
      const res = await fetch('/api/swarm/orchestrator/overseer/dismiss', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      setEngine(sanitizeEngineState(await res.json()))
      setAvailable(true)
    } catch (e) {
      setEngine((s) => ({ ...s, overseerRemembered: true })) // revert — still remembered
      setError(
        t('projectPanel.swarm.manager.engineFailed', { error: e instanceof Error ? e.message : String(e) }),
      )
    } finally {
      setBusy(false)
    }
  }, [busy, projectPath, t])

  // (The auto-wake toggle that used to live here — POST …/automerge — was retired
  // 2026-07-16: waking the commander is always on while the engine runs.)

  // Overseer switch — the THIRD toggle (EPIC C / C-core). Same optimistic-then-confirm
  // shape. Its own fetch (not callEngine) so it can read the `sandboxWarning` the route
  // adds when arming WITHOUT the sandbox experiment (L3). Default OFF; an explicit
  // autonomy OFF clears it server-side (D1), so the next state poll drops it back.
  const toggleOverseer = useCallback(
    async (next: boolean) => {
      if (busy || next === engine.overseer) return
      setBusy(true)
      setError(null)
      setEngine((s) => ({ ...s, overseer: next }))
      try {
        const res = await fetch('/api/swarm/orchestrator/overseer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: projectPath, enabled: next }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        const raw = (await res.json()) as { sandboxWarning?: boolean }
        setEngine(sanitizeEngineState(raw))
        setSandboxWarning(next && raw.sandboxWarning === true)
        setAvailable(true)
      } catch (e) {
        setEngine((s) => ({ ...s, overseer: !next }))
        setError(
          t('projectPanel.swarm.manager.engineFailed', { error: e instanceof Error ? e.message : String(e) }),
        )
      } finally {
        setBusy(false)
      }
    },
    [busy, engine.overseer, projectPath, t],
  )

  // Stop ONE engine worker (the owner clicked "stop" on its row). No optimistic
  // flip — the worker simply drops out of the authoritative state the POST
  // returns. Same busy/error bookkeeping as the switches so the dashboard disables
  // during the round-trip; a 404 (old server) surfaces the engine-failure note.
  const stopWorker = useCallback(
    async (terminalId: string) => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/swarm/orchestrator/worker/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: projectPath, terminalId }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        setEngine(sanitizeEngineState(await res.json()))
        setAvailable(true)
      } catch (e) {
        setError(
          t('projectPanel.swarm.manager.engineFailed', { error: e instanceof Error ? e.message : String(e) }),
        )
      } finally {
        setBusy(false)
      }
    },
    [busy, projectPath, t],
  )

  // Resolve a stuck review card (the owner clicked "park" / "requeue" on a card the
  // engine can't auto-land). Same busy/error bookkeeping + authoritative-state
  // adoption as stopWorker; a 404 (old server) surfaces the engine-failure note.
  const resolveReview = useCallback(
    async (taskId: string, target: 'blocked' | 'todo') => {
      if (busy) return
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/swarm/orchestrator/review/resolve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: projectPath, taskId, target }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        setEngine(sanitizeEngineState(await res.json()))
        setAvailable(true)
      } catch (e) {
        setError(
          t('projectPanel.swarm.manager.engineFailed', { error: e instanceof Error ? e.message : String(e) }),
        )
      } finally {
        setBusy(false)
      }
    },
    [busy, projectPath, t],
  )

  // Mark one fatal notification handled. Optimistic first (the row disappears
  // under the click, no waiting on a round-trip), then persisted server-side as
  // `handledAt` on the notification itself — NOT the bell's read-state, which
  // means "seen" and is written wholesale when the bell opens. A lost POST only
  // means the row returns after a reload: an alert can be re-dismissed, never
  // silently destroyed.
  const markFatalHandled = useCallback((id: string) => {
    if (!id) return
    setHandledFatalIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
    void fetch('/api/swarm/notifications/handled', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => {})
  }, [])

  return {
    engine,
    fatalNotifications,
    handledFatalIds,
    markFatalHandled,
    realWorkers,
    available,
    busy,
    error,
    sandboxWarning,
    envIssues,
    refreshEnvPreflight,
    toggleAutonomy: (next) => void toggleAutonomy(next),
    dismissAutonomyReminder: () => void dismissAutonomyReminder(),
    toggleOverseer: (next) => void toggleOverseer(next),
    dismissOverseerReminder: () => void dismissOverseerReminder(),
    stopWorker: (terminalId) => void stopWorker(terminalId),
    resolveReview: (taskId, target) => void resolveReview(taskId, target),
  }
}

// Re-export the worker-status vocabulary so consumers can pull engine + status
// types from one module if they prefer (the type itself still lives with the
// pane that renders it).
export type { WorkerStatus }
