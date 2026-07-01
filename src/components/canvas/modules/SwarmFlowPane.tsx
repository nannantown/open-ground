// SwarmFlowPane — the FOURTH Swarm view: a live, read-only visualization of the
// autonomous loop. It is the dynamic, real-data version of the kitchen diagram
// (card 743ffdef): the drain → dispatch → monitor → integrate loop drawn as a
// pipeline, each worker's fine stage + heartbeat, the integration queue, a live
// event feed, and a "needs attention" banner for fatal events.
//
// PURELY PRESENTATIONAL: it never fetches. Every value comes from the shared
// `engine` state that SwarmModule already polls once via useSwarmEngine (condition
// "既存 useSwarmEngine の poll を再利用"), threaded down as props. Because that poll
// calls setEngine with a fresh object every 5s, this pane re-renders on the same
// cadence and recomputes its relative times / heartbeat liveness against a fresh
// `Date.now()` — so the loop reads as live without a second timer.
//
// FATAL EVENTS (条件3): the escalation safety valve (card 6fe48c1f, now MERGED)
// persists EVERY fatal event of the unmanned loop as a notification. The "needs
// attention" banner reads those — useSwarmEngine polls GET /api/swarm/notifications
// and passes them down as `fatalNotifications`, which swarmFlow.deriveFatalEvents
// folds into the banner alongside the engine `anomalies` (drift). An EARLIER
// model that derived "fatal" only from engine state (anomalies + crash/error log
// lines) MISSED condition 3: of the five fatal kinds, all-workers-down / exec-
// timeout don't reach the engine's public state and the two Electron self-update
// ones (rollback / canary-failed) never touch it at all — so the persisted
// notifications feed, NOT the engine log, is the authoritative source here.

import { type ReactNode } from 'react'
import { Activity, AlertTriangle, ArrowRight, Boxes, GitMerge, ListTodo, Workflow } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'
import type {
  EngineAnomaly,
  EngineLogKind,
  EngineLogLine,
  EngineReview,
  EngineReviewStatus,
  EngineWorker,
  SwarmEngineState,
  SwarmFatalEventKind,
  SwarmFatalView,
} from './useSwarmEngine'
import {
  compactAge,
  deriveFatalEvents,
  heartbeatLiveness,
  isFlowIdle,
  meaningfulEvents,
  summarizeFlow,
  workerStage,
  type FlowFatal,
  type FlowStage,
  type Liveness,
} from './swarmFlow'

interface Props {
  /** Latest engine state — polled once by SwarmModule (useSwarmEngine). */
  engine: SwarmEngineState
  /** Persisted fatal-event notifications for this project (条件3) — polled by the
   *  same hook; the authoritative source for the "needs attention" banner. */
  fatalNotifications: readonly SwarmFatalView[]
  /** Whether the orchestrator route answered (false → the offline placeholder). */
  available: boolean
}

// ── token maps (semantic tokens only → adapt to any theme; no hardcoded hex) ──

// Worker fine stage → chip tint + dot. A sensible progression: grey (starting),
// blue (audit/survey), amber (implementing — the main work), indigo (verifying),
// green (merge-ready), red (blocked). Each soft/DEFAULT pair clears WCAG AA.
const STAGE_TONE: Record<FlowStage, { chip: string; dot: string }> = {
  starting: { chip: 'bg-bg-inset text-ink-muted', dot: 'bg-ink-faint' },
  audit: { chip: 'bg-azure-soft text-azure', dot: 'bg-azure' },
  implement: { chip: 'bg-ochre-soft text-ochre', dot: 'bg-ochre' },
  verify: { chip: 'bg-invite-soft text-invite', dot: 'bg-invite' },
  awaiting: { chip: 'bg-moss-soft text-moss', dot: 'bg-moss' },
  blocked: { chip: 'bg-accent-soft text-accent', dot: 'bg-accent' },
}
const STAGE_LABEL: Record<FlowStage, MessageKey> = {
  starting: 'projectPanel.swarm.flow.stageStarting',
  audit: 'projectPanel.swarm.flow.stageAudit',
  implement: 'projectPanel.swarm.flow.stageImplement',
  verify: 'projectPanel.swarm.flow.stageVerify',
  awaiting: 'projectPanel.swarm.flow.stageAwaiting',
  blocked: 'projectPanel.swarm.flow.stageBlocked',
}

// Heartbeat liveness → dot. fresh = beating (green), aging = quiet (amber),
// stale = silent/likely stuck (red), none = not beat yet (grey).
const LIVENESS_DOT: Record<Liveness, string> = {
  fresh: 'bg-moss',
  aging: 'bg-ochre',
  stale: 'bg-accent',
  none: 'bg-ink-faint',
}
const LIVENESS_LABEL: Record<Liveness, MessageKey> = {
  fresh: 'projectPanel.swarm.flow.liveFresh',
  aging: 'projectPanel.swarm.flow.liveAging',
  stale: 'projectPanel.swarm.flow.liveStale',
  none: 'projectPanel.swarm.flow.liveNone',
}

// Review readiness → chip tint (labels REUSE the manager.* review keys).
const REVIEW_TONE: Record<EngineReviewStatus, string> = {
  ff: 'bg-moss-soft text-moss',
  rebase: 'bg-ochre-soft text-ochre',
  conflict: 'bg-accent-soft text-accent',
  unknown: 'bg-bg-inset text-ink-muted',
}
const REVIEW_LABEL: Record<EngineReviewStatus, MessageKey> = {
  ff: 'projectPanel.swarm.manager.reviewFf',
  rebase: 'projectPanel.swarm.manager.reviewRebase',
  conflict: 'projectPanel.swarm.manager.reviewConflict',
  unknown: 'projectPanel.swarm.manager.reviewUnknown',
}

// Log-event kind → chip tint (labels REUSE the manager.logKind* keys).
const KIND_TONE: Record<EngineLogKind, string> = {
  routine: 'bg-bg-inset text-ink-faint',
  dispatch: 'bg-azure-soft text-azure',
  promote: 'bg-invite-soft text-invite',
  integrate: 'bg-moss-soft text-moss',
  conflict: 'bg-ochre-soft text-ochre',
  cleanup: 'bg-bg-inset text-ink-muted',
  crash: 'bg-accent-soft text-accent',
}
const KIND_LABEL: Record<EngineLogKind, MessageKey> = {
  routine: 'projectPanel.swarm.manager.logImportant', // never shown (routine is filtered)
  dispatch: 'projectPanel.swarm.manager.logKindDispatch',
  promote: 'projectPanel.swarm.manager.logKindPromote',
  integrate: 'projectPanel.swarm.manager.logKindIntegrate',
  conflict: 'projectPanel.swarm.manager.logKindConflict',
  cleanup: 'projectPanel.swarm.manager.logKindCleanup',
  crash: 'projectPanel.swarm.manager.logKindCrash',
}

// Anomaly kind → localized base label. orphan/worktree/stale/move-stuck REUSE the
// manager.anomaly* keys; rework-exhausted has no manager key (the manager pane no
// longer renders anomalies) so it gets a flow-namespaced one.
const ANOMALY_LABEL: Record<EngineAnomaly['kind'], MessageKey> = {
  'orphan-doing': 'projectPanel.swarm.manager.anomalyOrphanDoing',
  'worktree-missing': 'projectPanel.swarm.manager.anomalyWorktreeMissing',
  'worker-stale': 'projectPanel.swarm.manager.anomalyWorkerStale',
  'move-stuck': 'projectPanel.swarm.manager.anomalyMoveStuck',
  'rework-exhausted': 'projectPanel.swarm.flow.anomalyReworkExhausted',
}
const MOVE_INTENT_LABEL: Record<NonNullable<EngineAnomaly['intent']>, MessageKey> = {
  review: 'projectPanel.swarm.manager.moveStuckReview',
  done: 'projectPanel.swarm.manager.moveStuckDone',
  recover: 'projectPanel.swarm.manager.moveStuckRecover',
}

// Fatal-event kind → localized label (条件3). The three engine-side events plus the
// two Electron self-update ones — each gets its own flow-namespaced key so the
// banner names WHAT fired regardless of UI language (the server `detail` rides as a
// secondary line / tooltip and stays Japanese).
const FATAL_EVENT_LABEL: Record<SwarmFatalEventKind, MessageKey> = {
  'rework-exhausted': 'projectPanel.swarm.flow.fatalReworkExhausted',
  'all-workers-down': 'projectPanel.swarm.flow.fatalAllWorkersDown',
  'exec-timeout': 'projectPanel.swarm.flow.fatalExecTimeout',
  rollback: 'projectPanel.swarm.flow.fatalRollback',
  'canary-failed': 'projectPanel.swarm.flow.fatalCanaryFailed',
}

export const SwarmFlowPane = ({ engine, fatalNotifications, available }: Props) => {
  const { t } = useT()
  // One clock read per render — fed to every relative-time / liveness derivation
  // so they all agree within a frame. The 5s engine poll re-renders this for free.
  const nowMs = Date.now()

  // Offline: the orchestrator route hasn't answered (old server / not built).
  if (!available) {
    return (
      <FlowEmpty
        icon={<Workflow size={20} strokeWidth={1.75} />}
        title={t('projectPanel.swarm.manager.engineOffline')}
        body={t('projectPanel.swarm.flow.offline')}
      />
    )
  }

  const fatals = deriveFatalEvents(engine, fatalNotifications)
  const summary = summarizeFlow(engine, available)
  const events = meaningfulEvents(engine)

  // Heartbeat health across the live workers (drives the Monitor station).
  const liveBeats = engine.workers.filter((w) => heartbeatLiveness(w.heartbeatAt, nowMs) === 'fresh').length
  const silentBeats = engine.workers.filter((w) => heartbeatLiveness(w.heartbeatAt, nowMs) === 'stale').length

  // Wholly idle: stopped + nothing in flight → a calm hint instead of empty rails.
  if (isFlowIdle(engine, fatalNotifications)) {
    return (
      <FlowEmpty
        icon={<Workflow size={20} strokeWidth={1.75} />}
        title={t('projectPanel.swarm.flow.idle')}
        body={t('projectPanel.swarm.flow.idleHint')}
      />
    )
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-4">
        {/* Header caption. */}
        <div className="flex items-center gap-2">
          <Workflow size={13} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
          <span className="label-cap text-ink-faint">{t('projectPanel.swarm.flow.title')}</span>
        </div>

        {/* ── Needs attention (条件3) — only when there are fatal events ──────── */}
        {fatals.length > 0 && <FatalBanner fatals={fatals} nowMs={nowMs} t={t} />}

        {/* ── The loop pipeline: drain → dispatch → monitor → integrate ──────── */}
        <div className="flex items-stretch gap-1.5 overflow-x-auto pb-1">
          <PhaseCard
            icon={<ListTodo size={14} strokeWidth={2} />}
            phase={t('projectPanel.swarm.flow.phaseDrain')}
            hint={t('projectPanel.swarm.flow.phaseDrainHint')}
            running={engine.running}
          >
            <div className="flex items-center gap-1.5">
              <span
                className={`h-[7px] w-[7px] shrink-0 rounded-full ${engine.running ? 'bg-moss motion-safe:animate-pulse' : 'bg-ink-faint'}`}
                aria-hidden
              />
              <span className="truncate text-[11px] text-ink-muted">
                {engine.running
                  ? t('projectPanel.swarm.flow.draining')
                  : t('projectPanel.swarm.flow.notDraining')}
              </span>
            </div>
          </PhaseCard>

          <Connector running={engine.running} />

          <PhaseCard
            icon={<Boxes size={14} strokeWidth={2} />}
            phase={t('projectPanel.swarm.flow.phaseDispatch')}
            hint={t('projectPanel.swarm.flow.phaseDispatchHint')}
            running={engine.running}
          >
            <Metric value={summary.workerCount} unit={t('projectPanel.swarm.flow.workersLive', { count: summary.workerCount })} />
          </PhaseCard>

          <Connector running={engine.running} />

          <PhaseCard
            icon={<Activity size={14} strokeWidth={2} />}
            phase={t('projectPanel.swarm.flow.phaseMonitor')}
            hint={t('projectPanel.swarm.flow.phaseMonitorHint')}
            running={engine.running}
          >
            {/* Heartbeat health summary — the act of "monitoring" made literal. */}
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-ink-muted">
              <span className="inline-flex items-center gap-1">
                <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${LIVENESS_DOT.fresh}`} aria-hidden />
                {liveBeats}
              </span>
              {silentBeats > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${LIVENESS_DOT.stale}`} aria-hidden />
                  {silentBeats}
                </span>
              )}
              <span className="text-ink-faint">{t('projectPanel.swarm.flow.heartbeat')}</span>
            </div>
          </PhaseCard>

          <Connector running={engine.running} />

          <PhaseCard
            icon={<GitMerge size={14} strokeWidth={2} />}
            phase={t('projectPanel.swarm.flow.phaseIntegrate')}
            hint={t('projectPanel.swarm.flow.phaseIntegrateHint')}
            running={engine.running}
          >
            <div className="flex flex-col gap-0.5">
              <Metric value={summary.reviewCount} unit={t('projectPanel.swarm.flow.reviewsWaiting', { count: summary.reviewCount })} />
              {summary.recentIntegrations > 0 && (
                <span className="text-[10px] text-moss">
                  {t('projectPanel.swarm.flow.merged', { count: summary.recentIntegrations })}
                </span>
              )}
            </div>
          </PhaseCard>
        </div>

        {/* ── Workers · live stage (条件1 + 条件2 心拍) ───────────────────────── */}
        <Section heading={t('projectPanel.swarm.flow.workersHeading')} count={engine.workers.length}>
          {engine.workers.length === 0 ? (
            <Empty text={t('projectPanel.swarm.flow.noWorkers')} />
          ) : (
            <ul className="flex flex-col gap-1">
              {engine.workers.map((w) => (
                <WorkerRow key={w.terminalId} worker={w} nowMs={nowMs} t={t} />
              ))}
            </ul>
          )}
        </Section>

        {/* ── Integration queue (条件2 統合フロー) ───────────────────────────── */}
        {engine.reviews.length > 0 && (
          <Section heading={t('projectPanel.swarm.flow.reviewsHeading')} count={engine.reviews.length}>
            <ul className="flex flex-col gap-1">
              {engine.reviews.map((r) => (
                <ReviewRow key={r.taskId} review={r} t={t} />
              ))}
            </ul>
          </Section>
        )}

        {/* ── Live events (条件2 列移動のリアルタイム反映) ─────────────────────── */}
        <Section heading={t('projectPanel.swarm.flow.eventsHeading')}>
          {events.length === 0 ? (
            <Empty text={t('projectPanel.swarm.flow.noEvents')} />
          ) : (
            <ul className="flex flex-col gap-0.5">
              {events.map((e) => (
                <EventRow key={e.id} line={e} nowMs={nowMs} t={t} />
              ))}
            </ul>
          )}
        </Section>
      </div>
    </div>
  )
}

type TFn = ReturnType<typeof useT>['t']

// ── Pieces ────────────────────────────────────────────────────────────────────

// A centered placeholder (offline / idle) — the paper-surface empty the other
// Swarm panes use.
const FlowEmpty = ({ icon, title, body }: { icon: ReactNode; title: string; body: string }) => (
  <div className="flex min-h-0 flex-1 items-center justify-center bg-bg px-8 text-center">
    <div className="max-w-sm">
      <div className="mx-auto mb-4 inline-flex h-11 w-11 items-center justify-center rounded-[3px] border border-line bg-bg-inset text-ink-muted">
        {icon}
      </div>
      <h2 className="mb-2 text-[15px] font-medium text-ink">{title}</h2>
      <p className="text-[12px] leading-relaxed text-ink-subtle">{body}</p>
    </div>
  </div>
)

// One pipeline phase card. Read-only; the `title` carries the phase hint. The
// border lifts to the strong line when the loop is running so the active pipeline
// reads as "warm".
const PhaseCard = ({
  icon,
  phase,
  hint,
  running,
  children,
}: {
  icon: ReactNode
  phase: string
  hint: string
  running: boolean
  children: ReactNode
}) => (
  <div
    title={hint}
    className={[
      'flex min-w-[124px] flex-1 flex-col gap-2 rounded-[4px] border bg-bg-card px-3 py-2.5 shadow-card transition-colors',
      running ? 'border-line-strong' : 'border-line',
    ].join(' ')}
  >
    <div className="flex items-center gap-1.5 text-ink-muted">
      <span className="shrink-0 text-ink-faint" aria-hidden>
        {icon}
      </span>
      <span className="label-cap truncate">{phase}</span>
    </div>
    {children}
  </div>
)

// A connecting arrow between phase cards — pulses (motion-safe) and warms toward
// the accent when the loop is running, sits inert grey when paused.
const Connector = ({ running }: { running: boolean }) => (
  <div className="flex shrink-0 items-center" aria-hidden>
    <ArrowRight
      size={14}
      strokeWidth={2.25}
      className={running ? 'text-accent motion-safe:animate-pulse' : 'text-ink-faint'}
    />
  </div>
)

// A big metric number + its localized unit caption (used on the pipeline cards).
const Metric = ({ value, unit }: { value: number; unit: string }) => (
  <div className="flex items-baseline gap-1.5">
    <span className="text-[18px] font-semibold leading-none text-ink tabular-nums">{value}</span>
    <span className="truncate text-[11px] text-ink-subtle">{unit}</span>
  </div>
)

// A titled section with an optional count badge.
const Section = ({
  heading,
  count,
  children,
}: {
  heading: string
  count?: number
  children: ReactNode
}) => (
  <section className="flex flex-col gap-1.5">
    <div className="flex items-center gap-2">
      <h3 className="label-cap text-ink-faint">{heading}</h3>
      {count !== undefined && count > 0 && (
        <span className="rounded-full border border-line px-1.5 text-[9px] font-medium leading-[14px] text-ink-faint tabular-nums">
          {count}
        </span>
      )}
    </div>
    {children}
  </section>
)

const Empty = ({ text }: { text: string }) => (
  <p className="rounded-[4px] border border-dashed border-line-soft bg-bg-card px-3 py-2.5 text-[11px] leading-relaxed text-ink-subtle">
    {text}
  </p>
)

// One worker row: a stage chip (条件1), the branch + note, and a heartbeat
// liveness dot with its relative age (条件2).
const WorkerRow = ({ worker, nowMs, t }: { worker: EngineWorker; nowMs: number; t: TFn }) => {
  const stage = workerStage(worker)
  const tone = STAGE_TONE[stage]
  const live = heartbeatLiveness(worker.heartbeatAt, nowMs)
  const age = compactAge(worker.heartbeatAt, nowMs)
  return (
    <li className="flex items-center gap-2 rounded-[4px] border border-line-soft bg-bg-card px-2.5 py-1.5">
      {/* Stage chip — background + text move together (contrast holds). */}
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone.chip}`}>
        {t(STAGE_LABEL[stage])}
      </span>
      {/* Branch + the worker's self-reported one-line note. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[11px] text-ink" title={worker.branch}>
          {worker.taskTitle || worker.branch}
        </span>
        {worker.note && (
          <span className="truncate text-[10px] text-ink-subtle" title={worker.note}>
            {worker.note}
          </span>
        )}
      </div>
      {/* Heartbeat: dot (fresh pulses) + "Live" / "{age} ago". */}
      <span
        className="flex shrink-0 items-center gap-1 text-[10px] text-ink-muted"
        title={t('projectPanel.swarm.flow.heartbeat')}
      >
        <span
          className={`h-[7px] w-[7px] shrink-0 rounded-full ${LIVENESS_DOT[live]} ${live === 'fresh' ? 'motion-safe:animate-pulse' : ''}`}
          aria-hidden
        />
        {live === 'none' || !age
          ? t(LIVENESS_LABEL[live])
          : t('projectPanel.swarm.flow.ago', { age })}
      </span>
    </li>
  )
}

// One review-queue row: title + readiness badge (条件2 統合フロー).
const ReviewRow = ({ review, t }: { review: EngineReview; t: TFn }) => (
  <li className="flex items-center gap-2 rounded-[4px] border border-line-soft bg-bg-card px-2.5 py-1.5">
    <GitMerge size={12} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
    <span className="min-w-0 flex-1 truncate text-[11px] text-ink" title={review.branch}>
      {review.taskTitle || review.branch}
    </span>
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${REVIEW_TONE[review.status]}`}>
      {t(REVIEW_LABEL[review.status])}
    </span>
  </li>
)

// One event-feed row: a kind chip + the message + its relative time. Crash /
// error tint (via KIND_TONE / the accent message) makes a fatal pop in the feed,
// reinforcing the banner (条件3).
const EventRow = ({ line, nowMs, t }: { line: EngineLogLine; nowMs: number; t: TFn }) => {
  const age = compactAge(line.at, nowMs)
  const isError = line.level === 'error' || line.kind === 'crash'
  return (
    <li className="flex items-start gap-2 px-1 py-0.5">
      {line.kind && line.kind !== 'routine' ? (
        <span className={`mt-px shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium ${KIND_TONE[line.kind]}`}>
          {t(KIND_LABEL[line.kind])}
        </span>
      ) : (
        <span className="mt-px shrink-0 rounded-full bg-bg-inset px-1.5 py-0.5 text-[9px] font-medium text-ink-faint">
          ·
        </span>
      )}
      <span className={`min-w-0 flex-1 break-words text-[11px] leading-snug ${isError ? 'text-accent' : 'text-ink-muted'}`}>
        {line.message}
      </span>
      {age && <span className="shrink-0 text-[10px] tabular-nums text-ink-faint">{age}</span>}
    </li>
  )
}

// ── Needs-attention banner (条件3) ───────────────────────────────────────────
// The "needs attention" set: persisted FATAL notifications (all five escalation
// kinds — the three engine-side ones + the two Electron self-update ones) plus
// engine anomalies (drift). Accent surface so it can't be missed.
const FatalBanner = ({ fatals, nowMs, t }: { fatals: FlowFatal[]; nowMs: number; t: TFn }) => (
  <div className="flex flex-col gap-1.5 rounded-[4px] border border-accent/40 bg-accent-soft px-3 py-2.5">
    <div className="flex items-center gap-1.5">
      <AlertTriangle size={13} strokeWidth={2.25} className="shrink-0 text-accent" aria-hidden />
      <span className="label-cap text-accent">{t('projectPanel.swarm.flow.fatalHeading')}</span>
      <span className="ml-auto rounded-full border border-accent/40 px-1.5 text-[9px] font-medium leading-[14px] text-accent tabular-nums">
        {fatals.length}
      </span>
    </div>
    <ul className="flex flex-col gap-1.5">
      {fatals.map((f) => (
        <FatalRow key={f.id} fatal={f} nowMs={nowMs} t={t} />
      ))}
    </ul>
  </div>
)

// One alert row. A fatal NOTIFICATION shows its localized event label (chip) + the
// branch / card it concerns + a relative age, with the server-composed detail as a
// secondary line. An ANOMALY shows its mapped label (+ stale-minutes / move-stuck
// intent + branch) on one line.
const FatalRow = ({ fatal, nowMs, t }: { fatal: FlowFatal; nowMs: number; t: TFn }) => {
  if (fatal.source === 'fatal' && fatal.fatal) {
    const f = fatal.fatal
    const age = f.createdAt ? compactAge(new Date(f.createdAt).toISOString(), nowMs) : null
    const where = f.branch || f.taskTitle
    return (
      <li className="flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-medium text-bg-card">
            {t(FATAL_EVENT_LABEL[f.event])}
          </span>
          {where && (
            <span className="min-w-0 truncate text-[11px] text-ink" title={where}>
              {where}
            </span>
          )}
          {age && <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-faint">{age}</span>}
        </div>
        {f.detail && <span className="text-[10px] leading-snug text-ink-subtle">{f.detail}</span>}
      </li>
    )
  }
  if (fatal.source === 'anomaly' && fatal.anomaly) {
    return <li className="text-[11px] leading-snug text-ink">{anomalyText(fatal.anomaly, t)}</li>
  }
  return null
}

// Localize one anomaly: its mapped label + the stale-minutes / move-stuck-intent
// detail when present + the branch.
const anomalyText = (a: EngineAnomaly, t: TFn): string => {
  const base = t(ANOMALY_LABEL[a.kind])
  const branch = a.branch ? ` · ${a.branch}` : ''
  if (a.kind === 'worker-stale' && typeof a.staleMinutes === 'number') {
    return `${base} (${t('projectPanel.swarm.manager.anomalyStaleFor', { min: a.staleMinutes })})${branch}`
  }
  if (a.kind === 'move-stuck' && a.intent) {
    return `${base} (${t(MOVE_INTENT_LABEL[a.intent])})${branch}`
  }
  return `${base}${branch}`
}
