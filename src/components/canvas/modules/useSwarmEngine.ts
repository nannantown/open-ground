// useSwarmEngine — the SINGLE source of the commander engine's state for the
// Swarm surface. It owns the one orchestrator poll + the start/stop/automerge
// actions, and exposes a PURE merge (`mergeSwarmWorkers`) that folds the manual
// worker registry and the engine's own workers into ONE deduped list.
//
// WHY this lives here, not inside SwarmManagerPane: both Swarm sub-views need the
// engine's workers — the manager dashboard (its monitor) AND the worker tab (its
// tiles). Polling + merging in the manager pane left the worker tab blind to
// engine-spawned workers (it only knew the localStorage registry), so the worker
// tab showed an empty state while the engine had live workers. Hoisting the poll
// to SwarmModule (which calls this hook ONCE) and passing the merged list down to
// BOTH views makes the two tabs a single source of truth — no second poll, no
// second merge, deduped by PTY id. The orchestrator route is unchanged.
//
// The hook DEGRADES GRACEFULLY when the orchestrator route isn't there (a 404 →
// available:false + DEFAULT_ENGINE, never a scary error) — the same contract the
// manager pane had before, just relocated.

import { useCallback, useEffect, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import type { WorkerStatus } from './SwarmWorkerPane'

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
export type EngineAnomalyKind = 'orphan-doing' | 'worktree-missing' | 'worker-stale'

export interface EngineAnomaly {
  kind: EngineAnomalyKind
  /** Stable identity for the React key + dedup (taskId or branch). */
  ref: string
  branch?: string
  taskTitle?: string
  /** 'worker-stale' only — minutes since the last heartbeat (display-only). */
  staleMinutes?: number
}

export interface SwarmEngineState {
  /** Autonomy — the drain+dispatch loop is scheduled (Card① start/stop). */
  running: boolean
  /** Auto-integrate — the engine lands completed review cards itself (Card③).
   *  A separate switch from `running`, default OFF. */
  autoMerge: boolean
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
}

export const DEFAULT_ENGINE: SwarmEngineState = {
  running: false,
  autoMerge: false,
  workers: [],
  reviews: [],
  anomalies: [],
  log: [],
  maxWorkers: 0,
}

const KNOWN_LEVELS: ReadonlySet<string> = new Set(['info', 'warn', 'error'])
const KNOWN_REVIEW_STATUS: ReadonlySet<string> = new Set(['ff', 'rebase', 'conflict', 'unknown'])
const KNOWN_LOG_KINDS: ReadonlySet<string> = new Set([
  'routine', 'dispatch', 'promote', 'integrate', 'conflict', 'cleanup', 'crash',
])
const KNOWN_ANOMALY_KINDS: ReadonlySet<string> = new Set([
  'orphan-doing', 'worktree-missing', 'worker-stale',
])

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
        }))
        .slice(0, 50) // cap — defensive against a forged huge list
    : []

  return {
    running: o.running === true,
    autoMerge: o.autoMerge === true,
    workers,
    reviews,
    anomalies,
    log,
    maxWorkers: typeof o.maxWorkers === 'number' && Number.isFinite(o.maxWorkers) ? o.maxWorkers : 0,
  }
}

// ── Unified worker view (the single source both Swarm tabs render) ────────────
// The manual registry entry SwarmModule persists in localStorage. Kept minimal —
// just the fields the merge needs (the full SwarmWorker adds startedAt).
export interface ManualWorkerInput {
  terminalId: string
  branch: string
  worktree: string
  taskId?: string
  taskTitle: string
}

/** One worker as BOTH Swarm tabs see it. `source` distinguishes a manually
 *  dispatched worker (terminable from the worker tab — it owns the worktree)
 *  from one the autonomous engine spawned (read-only here; the engine owns its
 *  lifecycle, exactly as the manager monitor already treated it). */
export interface SwarmWorkerView {
  terminalId: string
  branch: string
  taskTitle: string
  source: 'manual' | 'engine'
  /** Manual workers only — the worktree path the terminate path tears down.
   *  Engine workers don't expose it (the engine tears its own down). */
  worktree?: string
  taskId?: string
  /** The engine's reported stage (engine source only). Manual workers derive
   *  their stage from the live PTY poll at render — see SwarmModule. */
  engineStage?: ManagerWorkerStage
  /** Heartbeat passthrough (engine source only, display-only, 条件3) — the
   *  worker's self-reported phase + one-line summary. Absent for manual workers
   *  (the engine doesn't read their heartbeat) and until a worker beats. */
  phase?: string
  note?: string
}

/** Fold the manual registry and the engine's own workers into ONE list, deduped
 *  by PTY id (manual wins on a collision — it carries the worktree the terminate
 *  path needs). Manual workers come first (the order the user dispatched them),
 *  then engine workers the manual registry doesn't know. PURE — no React, no
 *  fetch — so the single-source invariant is unit-testable (see the test). */
export const mergeSwarmWorkers = (
  manual: readonly ManualWorkerInput[],
  engineWorkers: readonly EngineWorker[],
): SwarmWorkerView[] => {
  const out: SwarmWorkerView[] = []
  const seen = new Set<string>()
  for (const w of manual) {
    if (seen.has(w.terminalId)) continue // a forged dup id in localStorage — keep first
    seen.add(w.terminalId)
    out.push({
      terminalId: w.terminalId,
      branch: w.branch,
      taskTitle: w.taskTitle,
      source: 'manual',
      worktree: w.worktree,
      taskId: w.taskId,
    })
  }
  for (const ew of engineWorkers) {
    if (seen.has(ew.terminalId)) continue // manual wins on a PTY-id collision
    seen.add(ew.terminalId)
    out.push({
      terminalId: ew.terminalId,
      branch: ew.branch,
      taskTitle: ew.taskTitle,
      source: 'engine',
      engineStage: ew.stage,
      ...(ew.phase ? { phase: ew.phase } : {}),
      ...(ew.note ? { note: ew.note } : {}),
    })
  }
  return out
}

// Poll cadence matches SwarmModule's other polls (Ground beacon / Board): every
// 5s, skipped while hidden, re-polled on focus.
const ENGINE_POLL_MS = 5_000

export interface UseSwarmEngine {
  /** Latest engine state (DEFAULT_ENGINE until the route answers). */
  engine: SwarmEngineState
  /** Whether the orchestrator route answered at all (false = not built / offline:
   *  the dashboard switches dim instead of firing a POST that 404s). */
  available: boolean
  /** A start/stop or auto-merge round-trip is in flight (disables both switches). */
  busy: boolean
  /** Last engine-action failure, already localized. */
  error: string | null
  /** Autonomy switch (Card①) — start/stop the drain+dispatch loop. */
  toggleAutonomy: (next: boolean) => void
  /** Auto-integrate switch (Card③) — arm/disarm the engine's own landing. */
  toggleAutoMerge: (next: boolean) => void
  /** Stop ONE engine-dispatched worker by its PTY id: the server tears down its
   *  worktree + PTY and parks its card in 'blocked', then this adopts the fresh
   *  state. A no-op while another engine round-trip is in flight. */
  stopWorker: (terminalId: string) => void
}

/** Own the commander engine's state for one project: one poll, the two switches,
 *  and the available/busy/error bookkeeping. Called ONCE by SwarmModule so the
 *  worker tab and the manager dashboard share a single snapshot. */
export const useSwarmEngine = (projectPath: string): UseSwarmEngine => {
  const { t } = useT()

  const [engine, setEngine] = useState<SwarmEngineState>(DEFAULT_ENGINE)
  const [available, setAvailable] = useState(false)
  // A start/stop or auto-merge round-trip is in flight — disables both switches.
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset when the hook is reused for another project (SwarmModule keeps one
  // instance across project switches, like the worker/supply state it resets).
  useEffect(() => {
    setEngine(DEFAULT_ENGINE)
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
      try {
        const res = await fetch(`/api/swarm/orchestrator?path=${encodeURIComponent(projectPath)}`)
        if (cancelled) return
        if (!res.ok) {
          setAvailable(false)
          return
        }
        const state = sanitizeEngineState(await res.json())
        if (cancelled) return
        setAvailable(true)
        setEngine(state)
      } catch {
        if (!cancelled) setAvailable(false)
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

  // POST an engine action and adopt the authoritative state it returns. All three
  // (start / stop / automerge) return the full SwarmOrchestratorState; an old
  // server without the route 404s and the caller surfaces "not available".
  const callEngine = useCallback(
    async (action: 'start' | 'stop' | 'automerge', extra: Record<string, unknown>) => {
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

  return {
    engine,
    available,
    busy,
    error,
    toggleAutonomy: (next) => void toggleAutonomy(next),
    toggleAutoMerge: (next) => void toggleAutoMerge(next),
    stopWorker: (terminalId) => void stopWorker(terminalId),
  }
}

// Re-export the worker-status vocabulary so consumers can pull engine + status
// types from one module if they prefer (the type itself still lives with the
// pane that renders it).
export type { WorkerStatus }
