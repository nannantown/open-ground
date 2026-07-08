// useSwarmEngine — the SINGLE source of the commander engine's state for the
// Swarm surface. It owns the one orchestrator poll + the start/stop/automerge
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

import { useCallback, useEffect, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import type { WorkerStatus } from './SwarmWorkerPane'
import type { SwarmWorkerRecord } from '@/lib/types'

// ── Engine contract (mirrors the server's SwarmOrchestratorState) ─────────────
// Kept as a LOCAL mirror (not imported from src/lib/types.ts) on purpose: the
// server half lives behind the orchestrator route and a local mirror keeps this
// front-end decoupled. The shape stays in lockstep with the server's
// `SwarmOrchestratorState` (incl. `autoMerge` + the read-only `reviews`).
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

export interface EngineWorker {
  terminalId: string
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
   *  worker stuck in doing), so the pane can name the exact zombie. */
  intent?: 'review' | 'done' | 'recover'
  /** 'move-stuck' only — consecutive kept writes (display-only). */
  attempts?: number
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
  /** Auto-integrate — the engine lands completed review cards itself (Card③).
   *  A separate switch from `running`, default OFF. */
  autoMerge: boolean
  /** Overseer — the autonomous proxy-you brainstem (EPIC C). The THIRD toggle,
   *  default OFF, in-memory. ASYMMETRIC to autoMerge: an explicit autonomy OFF
   *  CLEARS it, so the owner re-arms it every session (no persisted reminder — D1). */
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
  autoMerge: false,
  overseer: false,
  workers: [],
  reviews: [],
  anomalies: [],
  log: [],
  maxWorkers: 0,
  kpis: EMPTY_KPIS,
  consumption: EMPTY_CONSUMPTION,
  autonomyRemembered: false,
}

const KNOWN_LEVELS: ReadonlySet<string> = new Set(['info', 'warn', 'error'])
const KNOWN_REVIEW_STATUS: ReadonlySet<string> = new Set(['ff', 'rebase', 'conflict', 'unknown'])
const KNOWN_LOG_KINDS: ReadonlySet<string> = new Set([
  'routine', 'dispatch', 'promote', 'integrate', 'conflict', 'cleanup', 'crash',
])
const KNOWN_ANOMALY_KINDS: ReadonlySet<string> = new Set([
  'orphan-doing', 'worktree-missing', 'worker-stale', 'move-stuck', 'rework-exhausted',
])
const KNOWN_MOVE_INTENTS: ReadonlySet<string> = new Set(['review', 'done', 'recover'])

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
        .filter((w) => typeof w.terminalId === 'string')
        .map((w): EngineWorker => ({
          terminalId: String(w.terminalId),
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
            KNOWN_ANOMALY_KINDS.has(a.kind) &&
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
        }))
        .slice(0, 50) // cap — defensive against a forged huge list
    : []

  return {
    running: o.running === true,
    // Strict boolean like `running`: a forged / absent value folds to FALSE — the
    // fail-safe direction (no spurious "stopped by hand" badge).
    manualStop: o.manualStop === true,
    autoMerge: o.autoMerge === true,
    overseer: o.overseer === true,
    workers,
    reviews,
    anomalies,
    log,
    maxWorkers: typeof o.maxWorkers === 'number' && Number.isFinite(o.maxWorkers) ? o.maxWorkers : 0,
    kpis: sanitizeKpis(o.kpis),
    consumption: sanitizeConsumption(o.consumption),
    autonomyRemembered: o.autonomyRemembered === true,
  }
}

// ── Fatal-event notifications (条件3) ─────────────────────────────────────────
// The escalation safety valve (card 6fe48c1f) PERSISTS every fatal event of the
// unmanned loop as a notification, surfaced by GET /api/swarm/notifications. The
// flow pane reads THESE — the AUTHORITATIVE source — for its "needs attention"
// banner, so all five fatal kinds show: the three engine-side ones (rework-
// exhausted / all-workers-down / exec-timeout) AND the two that come from the
// Electron self-update cycle (rollback / canary-failed) and never touch the engine
// state at all. Mirrors the server's SwarmFatalEvent / SwarmFatalNotification (a
// LOCAL mirror keeps this front-end decoupled, like the engine-state mirror above).
export type SwarmFatalEventKind =
  | 'rework-exhausted'
  | 'all-workers-down'
  | 'exec-timeout'
  | 'rollback'
  | 'canary-failed'

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
}

const KNOWN_FATAL_EVENTS: ReadonlySet<string> = new Set([
  'rework-exhausted', 'all-workers-down', 'exec-timeout', 'rollback', 'canary-failed',
])

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
    if (typeof sf.event !== 'string' || !KNOWN_FATAL_EVENTS.has(sf.event)) continue
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
    })
  }
  // Newest-first (the route already sorts, but don't trust on-disk order).
  out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  return out
}

const KNOWN_ORCH_STAGES: ReadonlySet<string> = new Set(['starting', 'running', 'done'])

// GET /api/swarm/workers is the SERVER-TRUTH worker list (project_swarm_worker_registry):
// live PTYs + the engine's own roster + heartbeat files, already unified server-side —
// see src/lib/server/swarmWorkerRegistry.ts. Untrusted like every other route response,
// so coerce every field and drop a row with no identifiable worktree/branch rather than
// letting a bad shape crash the render.
export const sanitizeSwarmWorkers = (raw: unknown): SwarmWorkerRecord[] => {
  if (!raw || typeof raw !== 'object') return []
  const arr = (raw as Record<string, unknown>).workers
  if (!Array.isArray(arr)) return []
  const out: SwarmWorkerRecord[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.worktree !== 'string' || !o.worktree) continue
    if (typeof o.branch !== 'string' || !o.branch) continue
    out.push({
      worktree: o.worktree,
      branch: o.branch,
      ...(typeof o.terminalId === 'string' && o.terminalId ? { terminalId: o.terminalId } : {}),
      ...(typeof o.taskId === 'string' && o.taskId ? { taskId: o.taskId } : {}),
      ...(typeof o.taskTitle === 'string' && o.taskTitle ? { taskTitle: o.taskTitle } : {}),
      ...(typeof o.startedAt === 'string' && o.startedAt ? { startedAt: o.startedAt } : {}),
      ...(typeof o.stage === 'string' && KNOWN_ORCH_STAGES.has(o.stage)
        ? { stage: o.stage as SwarmWorkerRecord['stage'] }
        : {}),
      ...(typeof o.phase === 'string' && o.phase ? { phase: o.phase } : {}),
      ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}),
      ...(typeof o.heartbeatAt === 'string' && o.heartbeatAt ? { heartbeatAt: o.heartbeatAt } : {}),
      ...(o.ready === true ? { ready: true } : {}),
      ...(o.blocked === true ? { blocked: true } : {}),
      ...(typeof o.blockers === 'string' && o.blockers ? { blockers: o.blockers } : {}),
    })
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
const ENGINE_POLL_MS = 5_000

export interface UseSwarmEngine {
  /** Latest engine state (DEFAULT_ENGINE until the route answers). */
  engine: SwarmEngineState
  /** Persisted fatal-event notifications for THIS project (条件3) — the escalation
   *  safety valve's authoritative source, polled on the same cadence as `engine`.
   *  Empty until the owner-only route answers (a 403 / 404 / throw → empty). */
  fatalNotifications: SwarmFatalView[]
  /** The SERVER-TRUTH worker list (GET /api/swarm/workers, polled on the same
   *  cadence) — the single source the Swarm worker tab renders, so a worker
   *  started ANY way (engine dispatch, the Board 実行 button, or a direct
   *  `POST /api/swarm/worker`) shows up. Empty until the route answers. */
  realWorkers: SwarmWorkerRecord[]
  /** Whether the orchestrator route answered at all (false = not built / offline:
   *  the dashboard switches dim instead of firing a POST that 404s). */
  available: boolean
  /** A start/stop or auto-merge round-trip is in flight (disables both switches). */
  busy: boolean
  /** Last engine-action failure, already localized. */
  error: string | null
  /** The overseer was armed WITHOUT the sandbox experiment (L3) — the manager pane
   *  shows a reduced-containment note. False whenever the overseer is off. */
  sandboxWarning: boolean
  /** Autonomy switch (Card①) — start/stop the drain+dispatch loop. */
  toggleAutonomy: (next: boolean) => void
  /** Dismiss the restart "autonomy was on — resume?" reminder without resuming:
   *  clears the persisted marker (POST stop → forgetSwarmAutonomy). Distinct from
   *  toggleAutonomy(false), which no-ops when the engine is already stopped. */
  dismissAutonomyReminder: () => void
  /** Auto-integrate switch (Card③) — arm/disarm the engine's own landing. */
  toggleAutoMerge: (next: boolean) => void
  /** Overseer switch (EPIC C / C-core) — arm/disarm the autonomous proxy-you
   *  brainstem. Reads back `sandboxWarning` when arming without the sandbox (L3). */
  toggleOverseer: (next: boolean) => void
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
  // The server-truth worker list, polled alongside the engine state (one
  // interval, three endpoints) so the worker tab never needs a second poll.
  const [realWorkers, setRealWorkers] = useState<SwarmWorkerRecord[]>([])
  const [available, setAvailable] = useState(false)
  // A start/stop or auto-merge round-trip is in flight — disables both switches.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // L3: the overseer was armed WITHOUT the sandbox experiment — the UI shows a
  // reduced-containment note. Set from the overseer toggle response; cleared when the
  // overseer is off. Advisory only (the structural READ-ONLY design + budget hold).
  const [sandboxWarning, setSandboxWarning] = useState(false)

  // Reset when the hook is reused for another project (SwarmModule keeps one
  // instance across project switches, like the worker/supply state it resets).
  useEffect(() => {
    setEngine(DEFAULT_ENGINE)
    setFatalNotifications([])
    setRealWorkers([])
    setAvailable(false)
    setBusy(false)
    setError(null)
  }, [projectPath])

  // Poll the orchestrator state. A non-ok response (the route 404s on an old
  // server) or a throw → available:false + DEFAULT_ENGINE, never an unhandled
  // error. We skip while a toggle is mid-flight so its authoritative response
  // isn't clobbered by a stale read landing a moment later.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.hidden) return
      // 1) Engine orchestrator state (semantics unchanged — ok ⇒ available + state,
      //    non-ok / throw ⇒ not available). No early return: the notifications fetch
      //    below is INDEPENDENT and must run even when the engine route is offline.
      try {
        const res = await fetch(`/api/swarm/orchestrator?path=${encodeURIComponent(projectPath)}`)
        if (!cancelled) {
          if (!res.ok) {
            setAvailable(false)
          } else {
            const state = sanitizeEngineState(await res.json())
            if (!cancelled) {
              setAvailable(true)
              setEngine(state)
            }
          }
        }
      } catch {
        if (!cancelled) setAvailable(false)
      }
      // 1b) DRAIN-TICK: since card eadb25e6 the server side is a PURE idempotent state
      //     read — it no longer auto-starts a stopped engine (autonomy is strict opt-in
      //     via the Start toggle → POST /orchestrator/start; merely having this pane
      //     open must not spin up workers). The POST is kept for back-compat with older
      //     servers and as the seam a future consent-carrying tick would ride.
      //     Fire-and-forget + owner-gated: a 403/404/throw is harmless. Skipped while a
      //     toggle is in flight (this runs inside the busy-guarded poll), so it never
      //     fights a manual ON/OFF.
      void fetch('/api/swarm/orchestrator/drain-tick', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      }).catch(() => {})
      // 2) Persisted fatal-event notifications for THIS project (条件3) — the
      //    escalation valve's authoritative source. Owner-gated; a 403 / 404 / throw
      //    ⇒ empty (never an error). App-global self-update fatals (rollback /
      //    canary-failed) carry no projectPath, so they pass the filter and surface
      //    in the loop view too; other projects' card-rooted fatals are filtered out.
      try {
        const res = await fetch('/api/swarm/notifications')
        if (!cancelled) {
          setFatalNotifications(
            res.ok
              ? sanitizeFatalNotifications(await res.json()).filter(
                  (n) => !n.projectPath || n.projectPath === projectPath,
                )
              : [],
          )
        }
      } catch {
        if (!cancelled) setFatalNotifications([])
      }
      // 3) The SERVER-TRUTH worker list (GET /api/swarm/workers) — independent of
      //    the two fetches above, same owner-gated / non-ok-degrades-to-empty
      //    contract. Polled here (not a second interval) so the worker tab and
      //    the manager dashboard share this one snapshot too.
      try {
        const res = await fetch(`/api/swarm/workers?path=${encodeURIComponent(projectPath)}`)
        if (!cancelled) setRealWorkers(res.ok ? sanitizeSwarmWorkers(await res.json()) : [])
      } catch {
        if (!cancelled) setRealWorkers([])
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
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [projectPath, busy])

  // POST an engine action and adopt the authoritative state it returns. All
  // (start / stop / automerge / overseer) return the full SwarmOrchestratorState; an
  // old server without the route 404s and the caller surfaces "not available".
  const callEngine = useCallback(
    async (action: 'start' | 'stop' | 'automerge' | 'overseer', extra: Record<string, unknown>) => {
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

  // Auto-integrate switch — Card③. Same optimistic-then-confirm shape as autonomy;
  // an old server without the route 404s, so we revert and show the engine-failure
  // note (the switch stays present + default OFF).
  const toggleAutoMerge = useCallback(
    async (next: boolean) => {
      if (busy || next === engine.autoMerge) return
      setBusy(true)
      setError(null)
      setEngine((s) => ({ ...s, autoMerge: next }))
      try {
        const fresh = await callEngine('automerge', { enabled: next })
        setEngine(fresh)
        setAvailable(true)
      } catch (e) {
        setEngine((s) => ({ ...s, autoMerge: !next }))
        setError(
          t('projectPanel.swarm.manager.engineFailed', { error: e instanceof Error ? e.message : String(e) }),
        )
      } finally {
        setBusy(false)
      }
    },
    [busy, engine.autoMerge, callEngine, t],
  )

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

  return {
    engine,
    fatalNotifications,
    realWorkers,
    available,
    busy,
    error,
    sandboxWarning,
    toggleAutonomy: (next) => void toggleAutonomy(next),
    dismissAutonomyReminder: () => void dismissAutonomyReminder(),
    toggleAutoMerge: (next) => void toggleAutoMerge(next),
    toggleOverseer: (next) => void toggleOverseer(next),
    stopWorker: (terminalId) => void stopWorker(terminalId),
    resolveReview: (taskId, target) => void resolveReview(taskId, target),
  }
}

// Re-export the worker-status vocabulary so consumers can pull engine + status
// types from one module if they prefer (the type itself still lives with the
// pane that renders it).
export type { WorkerStatus }
