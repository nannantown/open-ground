// SwarmWorkerSeat — an SDK worker's seat on the one-screen Swarm tab, FOLDED:
// who (rabbit · role tint), in what state, on which job, and the open question
// if it is waiting on the owner. Nothing streams here — the status comes from
// the module's GET /api/terminal/active poll (both pools, liveDesks.ts) and
// the question from its one escalations poll.
//
// WHY folded by default (2026-09-23 review): every open seat that shows a live
// transcript holds one EventSource, and the app talks to its server over
// HTTP/1.1 on one loopback host, where Chromium allows only 6 connections.
// Supply + manager + 4 streaming workers used all 6 and every other request
// (roster poll, stop, terminate) hung. The owner only needs "who is doing
// what" at a glance anyway; the transcript opens on demand, ONE seat at a time
// (SwarmModule's `openWorktree`), which bounds the screen at 3 streams.

import { Power, RotateCcw, Trash2, AlertTriangle, ScrollText } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { BEACON_SPRITE } from '@/lib/swarm/sprites'
import type { WorkerStatus } from './SwarmWorkerPane'
import { SwarmSeatHeader } from './SwarmSeatHeader'

const SMALL_BTN =
  'flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-micro text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1'

export const SwarmWorkerSeat = ({
  branch,
  taskTitle,
  status,
  question,
  busy = false,
  retainedReason,
  onOpenLog,
  onTerminate,
  onForceRemove,
  onRestart,
}: {
  branch: string
  taskTitle: string
  status: WorkerStatus
  /** The open question this worker asked the owner, or null. */
  question: string | null
  busy?: boolean
  retainedReason?: string
  /** Unfold this seat into the live transcript. */
  onOpenLog: () => void
  /** Manual workers only — the engine owns an engine worker's lifecycle. */
  onTerminate?: () => void
  onForceRemove?: () => void
  onRestart?: () => void
}) => {
  const { t } = useT()
  const live = status !== 'exited'
  // An open question outranks every other state (spriteStateFor's rule).
  const asking = live && question !== null
  const statusLabel = asking
    ? t('projectPanel.swarm.sdk.statusQuestion')
    : {
        working: t('projectPanel.swarm.statusWorking'),
        waiting: t('projectPanel.swarm.statusWaiting'),
        starting: t('projectPanel.swarm.statusStarting'),
        exited: t('projectPanel.swarm.statusExited'),
      }[status]
  const job = taskTitle || branch

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <SwarmSeatHeader
        role="worker"
        sprite={asking ? 'asking' : BEACON_SPRITE[status]}
        statusLabel={statusLabel}
        waiting={asking || status === 'waiting'}
        detailTitle={taskTitle ? `${taskTitle} — ${branch}` : branch}
      >
        {onTerminate ? (
          <button
            type="button"
            onClick={onTerminate}
            disabled={busy}
            title={t('projectPanel.swarm.terminate')}
            className={SMALL_BTN}
          >
            <Power size={10} strokeWidth={2.25} />
            {busy ? t('projectPanel.swarm.terminating') : t('projectPanel.swarm.terminate')}
          </button>
        ) : null}
      </SwarmSeatHeader>

      {retainedReason && onForceRemove ? (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line-soft bg-bg-inset px-2.5 py-1">
          <AlertTriangle size={11} className="shrink-0 text-ochre" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-micro text-ink-muted" title={retainedReason}>
            {t('projectPanel.swarm.retained')}
          </span>
          <button type="button" onClick={onForceRemove} disabled={busy} className={SMALL_BTN}>
            <Trash2 size={10} strokeWidth={2.25} />
            {t('projectPanel.swarm.forceRemove')}
          </button>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {/* The job, in full — the nameplate above has no room for it. */}
        <p className="text-ui leading-snug text-ink" title={branch}>
          {job}
        </p>
        {asking ? (
          <div role="status" className="rounded-[3px] border border-ochre/40 bg-ochre/10 px-2.5 py-2">
            <div className="text-meta font-medium text-ochre">
              {t('projectPanel.swarm.sdk.questionBanner')}
            </div>
            <div className="mt-0.5 line-clamp-4 text-ui leading-snug text-ink" title={question ?? undefined}>
              {question}
            </div>
            <div className="mt-1 text-micro text-ink-muted">
              {t('projectPanel.swarm.seat.questionHint')}
            </div>
          </div>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-2">
          <button type="button" onClick={onOpenLog} className={SMALL_BTN}>
            <ScrollText size={11} strokeWidth={2} aria-hidden />
            {t('projectPanel.swarm.seat.openLog')}
          </button>
          {!live && onRestart ? (
            <button type="button" onClick={onRestart} disabled={busy} className={SMALL_BTN}>
              <RotateCcw size={10} strokeWidth={2.25} />
              {busy ? t('projectPanel.swarm.restarting') : t('projectPanel.swarm.restart')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}
