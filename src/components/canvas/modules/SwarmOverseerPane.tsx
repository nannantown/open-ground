// SwarmOverseerPane — the Overseer (監督) tab: the single place the swarm's
// messages to the owner live. Two sections:
//
//   ① the ESCALATION INBOX (SwarmEscalationsPane) — the open questions awaiting
//      the owner's answer (answer / dismiss, C1). This used to be PINNED above
//      the whole Swarm tab strip, stacking up over every sub-view; it now sits
//      here, read when the owner opens this tab — the same "open it to see it"
//      contract the commander and worker views follow. The tab label carries an
//      unanswered-count badge (via onOpenCountChange) so a new question is still
//      noticeable without the pinning. (Server-side, an OS notification + the
//      app bell already fire per question — this tab is where it gets HANDLED.)
//
//   ② the NEEDS-ATTENTION feed — the persisted FATAL notifications (EVERY kind
//      the server can raise, engine-side and otherwise: no client allowlist,
//      after a hand-kept one silently dropped four of them) folded with the
//      engine anomalies (drift), the exact content the removed Flow tab's banner
//      carried (swarmOverseerFeed.deriveOverseerAlerts). Each fatal row carries
//      a 対応済み button so the feed can return to its quiet state — persisted
//      fatals otherwise pin it open forever.
//
// PURELY PRESENTATIONAL for the engine: `engine` / `fatalNotifications` come
// from the shared useSwarmEngine poll SwarmModule already runs — no own fetch.
// The escalation inbox polls its own owner-gated GET (inside
// SwarmEscalationsPane), which is why SwarmModule keeps this pane MOUNTED
// (hidden) while another sub-view is active — the poll, and therefore the tab
// badge, stays live.
//
// SECURITY: mounted only inside SwarmModule, itself behind the owner+toggle
// gate — nothing extra to gate here (the trace-zero guarantee is structural).

import { useState } from 'react'
import { AlertTriangle, ShieldCheck } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'
import type { EngineAnomaly, SwarmEngineState, SwarmFatalEventKind, SwarmFatalView } from './useSwarmEngine'
import { compactAge, deriveOverseerAlerts, type OverseerAlert } from './swarmOverseerFeed'
import { SwarmEscalationsPane } from './SwarmEscalationsPane'

interface Props {
  /** Feeds the escalation inbox (its own poll lives in SwarmEscalationsPane). */
  projectPath: string
  /** Latest engine state — polled once by SwarmModule (useSwarmEngine). */
  engine: SwarmEngineState
  /** Persisted fatal-event notifications for this project — polled by the same
   *  hook; the authoritative source for the needs-attention feed. */
  fatalNotifications: readonly SwarmFatalView[]
  /** Ids dismissed in THIS session — the optimistic half, so a clicked row
   *  vanishes at once. The durable half rides on each notification
   *  (`SwarmFatalView.handled`, server-side `handledAt`). */
  handledFatalIds: ReadonlySet<string>
  /** Mark one fatal row handled (optimistic + persisted). */
  onMarkFatalHandled: (id: string) => void
  /** The inbox's current open-question count — SwarmModule's state, fed by
   *  onOpenCountChange below. Drives the quiet/empty state (the inbox itself
   *  renders null while empty, so the pane can't read its count synchronously). */
  openCount: number
  /** Reports the inbox's open-question count for the tab badge (see
   *  SwarmEscalationsPane.onOpenCountChange). */
  onOpenCountChange: (count: number) => void
}

// Anomaly kind → localized base label. orphan/worktree/stale/move-stuck REUSE the
// manager.anomaly* keys; no-heartbeat / rework-exhausted have no manager key (the
// manager pane doesn't render anomalies) so they live in the overseer namespace.
export const ANOMALY_LABEL: Record<string, MessageKey> = {
  'orphan-doing': 'projectPanel.swarm.manager.anomalyOrphanDoing',
  'unowned-doing': 'projectPanel.swarm.overseer.anomalyUnownedDoing',
  'worktree-missing': 'projectPanel.swarm.manager.anomalyWorktreeMissing',
  'worker-stale': 'projectPanel.swarm.manager.anomalyWorkerStale',
  'no-heartbeat': 'projectPanel.swarm.overseer.anomalyNoHeartbeat',
  'move-stuck': 'projectPanel.swarm.manager.anomalyMoveStuck',
  'rework-exhausted': 'projectPanel.swarm.overseer.anomalyReworkExhausted',
  'review-panel-failed': 'projectPanel.swarm.overseer.anomalyReviewPanelFailed',
  'high-risk-hold': 'projectPanel.swarm.overseer.anomalyHighRiskHold',
  'all-workers-down': 'projectPanel.swarm.overseer.anomalyAllWorkersDown',
  'manager-unrevivable': 'projectPanel.swarm.overseer.anomalyManagerUnrevivable',
}
const MOVE_INTENT_LABEL: Record<NonNullable<EngineAnomaly['intent']>, MessageKey> = {
  review: 'projectPanel.swarm.manager.moveStuckReview',
  done: 'projectPanel.swarm.manager.moveStuckDone',
  recover: 'projectPanel.swarm.manager.moveStuckRecover',
  'recover-review': 'projectPanel.swarm.manager.moveStuckRecoverReview',
}

// Fatal-event kind → localized label. Every member of the server's
// `SwarmFatalEvent` union (src/lib/types.ts) gets a row here — engine-side, the
// worker spawn path, the Electron self-update cycle, and the boot-time data
// check — each naming WHAT fired regardless of UI language (the server `detail`
// rides as a secondary line and stays Japanese).
//
// Exported ONLY so swarmOverseerFatalLabels.test.ts can compare these keys
// against that union: a new server event with no label here fails that test
// LOUDLY. At runtime an unlabelled event still renders (raw name) — a row the
// owner doesn't recognise is a question they can ask; a dropped row is a failure
// they never learn about.
export const FATAL_EVENT_LABEL: Record<string, MessageKey> = {
  'rework-exhausted': 'projectPanel.swarm.overseer.fatalReworkExhausted',
  'all-workers-down': 'projectPanel.swarm.overseer.fatalAllWorkersDown',
  'exec-timeout': 'projectPanel.swarm.overseer.fatalExecTimeout',
  rollback: 'projectPanel.swarm.overseer.fatalRollback',
  'canary-failed': 'projectPanel.swarm.overseer.fatalCanaryFailed',
  'review-panel-failed': 'projectPanel.swarm.overseer.fatalReviewPanelFailed',
  'high-risk-hold': 'projectPanel.swarm.overseer.fatalHighRiskHold',
  'guard-unwired': 'projectPanel.swarm.overseer.fatalGuardUnwired',
  'worker-spawn-failed': 'projectPanel.swarm.overseer.fatalWorkerSpawnFailed',
  'manager-unrevivable': 'projectPanel.swarm.overseer.fatalManagerUnrevivable',
  'manager-unresponsive': 'projectPanel.swarm.overseer.fatalManagerUnresponsive',
  'engine-resume-suppressed': 'projectPanel.swarm.overseer.fatalEngineResumeSuppressed',
  'data-integrity': 'projectPanel.swarm.overseer.fatalDataIntegrity',
}

export const SwarmOverseerPane = ({
  projectPath,
  engine,
  fatalNotifications,
  handledFatalIds,
  onMarkFatalHandled,
  openCount,
  onOpenCountChange,
}: Props) => {
  const { t } = useT()
  // False until the inbox answers once — see the quiet-state comment below.
  const [inboxLoaded, setInboxLoaded] = useState(false)
  // One clock read per render — every relative-time token agrees within a frame.
  // The 5s engine poll re-renders this for free.
  const nowMs = Date.now()

  const alerts = deriveOverseerAlerts(engine, fatalNotifications, handledFatalIds)
  // "Nothing needs you" is a CLAIM, and it must not be made out of no
  // information (2026-08-04). The inbox swallows a failed read — a 403 from a
  // degraded owner-role lookup, a transient network fault — leaving its list
  // empty, which used to render as the reassuring shield. Until the inbox has
  // actually been read once, say we don't know instead.
  const inboxUnknown = !inboxLoaded
  const quiet = alerts.length === 0 && openCount === 0 && !inboxUnknown
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
        {/* ① The escalation inbox — actionable, so it leads. Renders null while
            empty. Stays mounted even when this tab is hidden (SwarmModule wraps
            the whole pane in a hidden container) so its poll keeps the badge live. */}
        <SwarmEscalationsPane
          projectPath={projectPath}
          onOpenCountChange={onOpenCountChange}
          onLoadedChange={setInboxLoaded}
        />

        {/* ② Needs attention — fatal notifications + engine anomalies (read-only). */}
        {alerts.length > 0 && (
          <section
            aria-label={t('projectPanel.swarm.overseer.alertsHeading')}
            className="shrink-0 overflow-hidden rounded-[4px] border border-line bg-bg-card"
          >
            <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
              <AlertTriangle size={13} strokeWidth={2.25} className="shrink-0 text-accent" aria-hidden />
              <span className="label-cap text-ink">{t('projectPanel.swarm.overseer.alertsHeading')}</span>
              <span className="rounded-full bg-accent-soft px-1.5 text-meta leading-[18px] text-accent tabular-nums">
                {alerts.length}
              </span>
            </div>
            <ul className="flex flex-col divide-y divide-line-soft">
              {alerts.map((a) => (
                <AlertRow key={a.id} alert={a} nowMs={nowMs} t={t} onMarkHandled={onMarkFatalHandled} />
              ))}
            </ul>
          </section>
        )}

        {/* Could not read the inbox — say so rather than implying all-clear. */}
        {alerts.length === 0 && inboxUnknown && (
          <div className="flex flex-col items-center gap-2 px-8 py-10 text-center">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-[3px] border border-line bg-bg-inset text-ink-muted">
              <AlertTriangle size={20} strokeWidth={1.75} />
            </div>
            <p className="text-ui font-medium text-ink">
              {t('projectPanel.swarm.overseer.inboxUnknownTitle')}
            </p>
            <p className="max-w-sm text-ui leading-relaxed text-ink-subtle">
              {t('projectPanel.swarm.overseer.inboxUnknownBody')}
            </p>
          </div>
        )}

        {/* Quiet state — nothing needs the owner (no open questions, no alerts).
            Explains what arrives here and points at the overseer switch's home. */}
        {quiet && (
          <div className="flex flex-col items-center gap-2 px-8 py-10 text-center">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-[3px] border border-line bg-bg-inset text-ink-muted">
              <ShieldCheck size={20} strokeWidth={1.75} />
            </div>
            <p className="text-ui font-medium text-ink">{t('projectPanel.swarm.overseer.emptyTitle')}</p>
            <p className="max-w-sm text-ui leading-relaxed text-ink-subtle">
              {t('projectPanel.swarm.overseer.emptyBody')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

type TFn = ReturnType<typeof useT>['t']

// One alert row. A fatal NOTIFICATION shows its localized event label (chip) + the
// branch / card it concerns + a relative age, with the server-composed detail as a
// secondary line. An ANOMALY shows its mapped label (+ stale-minutes / move-stuck
// intent + branch) on one line.
const AlertRow = ({
  alert,
  nowMs,
  t,
  onMarkHandled,
}: {
  alert: OverseerAlert
  nowMs: number
  t: TFn
  onMarkHandled: (id: string) => void
}) => {
  if (alert.source === 'fatal' && alert.fatal) {
    const f = alert.fatal
    const age = f.createdAt ? compactAge(new Date(f.createdAt).toISOString(), nowMs) : null
    const where = f.branch || f.taskTitle
    return (
      <li className="flex flex-col gap-0.5 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-plate font-medium text-bg-card">
            {/* An event this build has no label for still renders — with its raw
                name. A row the owner does not recognise is a question they can
                ask; a dropped row is a failure they never learn about (the
                four server events this client used to discard included
                guard-unwired, which means no worker can start at all). */}
            {FATAL_EVENT_LABEL[f.event] ? t(FATAL_EVENT_LABEL[f.event]) : f.event}
          </span>
          {where && (
            <span className="min-w-0 truncate text-meta text-ink" title={where}>
              {where}
            </span>
          )}
          {age && (
            <span className="ml-auto shrink-0 text-micro tabular-nums text-ink-faint">
              {t('projectPanel.swarm.overseer.ago', { age })}
            </span>
          )}
          {/* Mark handled — hides this row (server-persisted as the
              notification's own handledAt, NOT the bell's "seen" state).
              Without it the feed could never return to quiet: a fatal
              notification lives until it falls out of the 50-row cap. */}
          <button
            type="button"
            onClick={() => onMarkHandled(f.id)}
            title={t('projectPanel.swarm.overseer.markHandledHint')}
            className={`shrink-0 rounded-[3px] border border-line px-1.5 py-0.5 text-micro text-ink-subtle transition-all duration-150
              hover:border-line-strong hover:bg-plane hover:text-ink
              active:bg-bg-deep active:text-ink-onDeep
              focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent
              ${age ? '' : 'ml-auto'}`}
          >
            {t('projectPanel.swarm.overseer.markHandled')}
          </button>
        </div>
        {f.detail && <span className="text-micro leading-snug text-ink-subtle">{f.detail}</span>}
      </li>
    )
  }
  if (alert.source === 'anomaly' && alert.anomaly) {
    return (
      <li className="px-3 py-2 text-meta leading-snug text-ink">{anomalyText(alert.anomaly, t)}</li>
    )
  }
  return null
}

// Localize one anomaly: its mapped label + the stale-minutes / move-stuck-intent
// detail when present + the branch.
const anomalyText = (a: EngineAnomaly, t: TFn): string => {
  // An unlabelled kind renders as its RAW name rather than vanishing — same
  // rule as the fatal rows, for the same measured reason (a hand-kept list
  // dropped 'no-heartbeat' for months, then 'recover-review').
  const base = ANOMALY_LABEL[a.kind] ? t(ANOMALY_LABEL[a.kind]) : a.kind
  const branch = a.branch ? ` · ${a.branch}` : ''
  if ((a.kind === 'worker-stale' || a.kind === 'no-heartbeat') && typeof a.staleMinutes === 'number') {
    return `${base} (${t('projectPanel.swarm.manager.anomalyStaleFor', { min: a.staleMinutes })})${branch}`
  }
  if (a.kind === 'move-stuck' && a.intent) {
    return `${base} (${t(MOVE_INTENT_LABEL[a.intent])})${branch}`
  }
  return `${base}${branch}`
}
