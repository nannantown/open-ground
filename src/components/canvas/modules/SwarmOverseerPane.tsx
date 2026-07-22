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
//   ② the NEEDS-ATTENTION feed — the persisted FATAL notifications (all five
//      kinds: rework-exhausted / all-workers-down / exec-timeout + the two
//      Electron self-update ones) folded with the engine anomalies (drift), the
//      exact content the removed Flow tab's banner carried
//      (swarmOverseerFeed.deriveOverseerAlerts). Read-only.
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
const ANOMALY_LABEL: Record<EngineAnomaly['kind'], MessageKey> = {
  'orphan-doing': 'projectPanel.swarm.manager.anomalyOrphanDoing',
  'worktree-missing': 'projectPanel.swarm.manager.anomalyWorktreeMissing',
  'worker-stale': 'projectPanel.swarm.manager.anomalyWorkerStale',
  'no-heartbeat': 'projectPanel.swarm.overseer.anomalyNoHeartbeat',
  'move-stuck': 'projectPanel.swarm.manager.anomalyMoveStuck',
  'rework-exhausted': 'projectPanel.swarm.overseer.anomalyReworkExhausted',
  'review-panel-failed': 'projectPanel.swarm.overseer.anomalyReviewPanelFailed',
  'high-risk-hold': 'projectPanel.swarm.overseer.anomalyHighRiskHold',
}
const MOVE_INTENT_LABEL: Record<NonNullable<EngineAnomaly['intent']>, MessageKey> = {
  review: 'projectPanel.swarm.manager.moveStuckReview',
  done: 'projectPanel.swarm.manager.moveStuckDone',
  recover: 'projectPanel.swarm.manager.moveStuckRecover',
  'recover-review': 'projectPanel.swarm.manager.moveStuckRecoverReview',
}

// Fatal-event kind → localized label. The three engine-side events plus the two
// Electron self-update ones — each names WHAT fired regardless of UI language
// (the server `detail` rides as a secondary line and stays Japanese).
const FATAL_EVENT_LABEL: Record<SwarmFatalEventKind, MessageKey> = {
  'rework-exhausted': 'projectPanel.swarm.overseer.fatalReworkExhausted',
  'all-workers-down': 'projectPanel.swarm.overseer.fatalAllWorkersDown',
  'exec-timeout': 'projectPanel.swarm.overseer.fatalExecTimeout',
  rollback: 'projectPanel.swarm.overseer.fatalRollback',
  'canary-failed': 'projectPanel.swarm.overseer.fatalCanaryFailed',
  'review-panel-failed': 'projectPanel.swarm.overseer.fatalReviewPanelFailed',
  'high-risk-hold': 'projectPanel.swarm.overseer.fatalHighRiskHold',
}

export const SwarmOverseerPane = ({
  projectPath,
  engine,
  fatalNotifications,
  openCount,
  onOpenCountChange,
}: Props) => {
  const { t } = useT()
  // One clock read per render — every relative-time token agrees within a frame.
  // The 5s engine poll re-renders this for free.
  const nowMs = Date.now()

  const alerts = deriveOverseerAlerts(engine, fatalNotifications)
  const quiet = alerts.length === 0 && openCount === 0
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
        {/* ① The escalation inbox — actionable, so it leads. Renders null while
            empty. Stays mounted even when this tab is hidden (SwarmModule wraps
            the whole pane in a hidden container) so its poll keeps the badge live. */}
        <SwarmEscalationsPane projectPath={projectPath} onOpenCountChange={onOpenCountChange} />

        {/* ② Needs attention — fatal notifications + engine anomalies (read-only). */}
        {alerts.length > 0 && (
          <section
            aria-label={t('projectPanel.swarm.overseer.alertsHeading')}
            className="shrink-0 overflow-hidden rounded-[4px] border border-line bg-bg-card"
          >
            <div className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
              <AlertTriangle size={13} strokeWidth={2.25} className="shrink-0 text-accent" aria-hidden />
              <span className="label-cap text-ink">{t('projectPanel.swarm.overseer.alertsHeading')}</span>
              <span className="rounded-full bg-accent-soft px-1.5 text-[11px] leading-[18px] text-accent tabular-nums">
                {alerts.length}
              </span>
            </div>
            <ul className="flex flex-col divide-y divide-line-soft">
              {alerts.map((a) => (
                <AlertRow key={a.id} alert={a} nowMs={nowMs} t={t} />
              ))}
            </ul>
          </section>
        )}

        {/* Quiet state — nothing needs the owner (no open questions, no alerts).
            Explains what arrives here and points at the overseer switch's home. */}
        {quiet && (
          <div className="flex flex-col items-center gap-2 px-8 py-10 text-center">
            <div className="inline-flex h-11 w-11 items-center justify-center rounded-[3px] border border-line bg-bg-inset text-ink-muted">
              <ShieldCheck size={20} strokeWidth={1.75} />
            </div>
            <p className="text-[13px] font-medium text-ink">{t('projectPanel.swarm.overseer.emptyTitle')}</p>
            <p className="max-w-sm text-[12px] leading-relaxed text-ink-subtle">
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
const AlertRow = ({ alert, nowMs, t }: { alert: OverseerAlert; nowMs: number; t: TFn }) => {
  if (alert.source === 'fatal' && alert.fatal) {
    const f = alert.fatal
    const age = f.createdAt ? compactAge(new Date(f.createdAt).toISOString(), nowMs) : null
    const where = f.branch || f.taskTitle
    return (
      <li className="flex flex-col gap-0.5 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 rounded-full bg-accent px-1.5 py-0.5 text-[9px] font-medium text-bg-card">
            {t(FATAL_EVENT_LABEL[f.event])}
          </span>
          {where && (
            <span className="min-w-0 truncate text-[11px] text-ink" title={where}>
              {where}
            </span>
          )}
          {age && (
            <span className="ml-auto shrink-0 text-[10px] tabular-nums text-ink-faint">
              {t('projectPanel.swarm.overseer.ago', { age })}
            </span>
          )}
        </div>
        {f.detail && <span className="text-[10px] leading-snug text-ink-subtle">{f.detail}</span>}
      </li>
    )
  }
  if (alert.source === 'anomaly' && alert.anomaly) {
    return (
      <li className="px-3 py-2 text-[11px] leading-snug text-ink">{anomalyText(alert.anomaly, t)}</li>
    )
  }
  return null
}

// Localize one anomaly: its mapped label + the stale-minutes / move-stuck-intent
// detail when present + the branch.
const anomalyText = (a: EngineAnomaly, t: TFn): string => {
  const base = t(ANOMALY_LABEL[a.kind])
  const branch = a.branch ? ` · ${a.branch}` : ''
  if ((a.kind === 'worker-stale' || a.kind === 'no-heartbeat') && typeof a.staleMinutes === 'number') {
    return `${base} (${t('projectPanel.swarm.manager.anomalyStaleFor', { min: a.staleMinutes })})${branch}`
  }
  if (a.kind === 'move-stuck' && a.intent) {
    return `${base} (${t(MOVE_INTENT_LABEL[a.intent])})${branch}`
  }
  return `${base}${branch}`
}
