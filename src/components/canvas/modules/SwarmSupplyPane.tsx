// The owner's president seat: SDK transcript or legacy Claude terminal, with
// one conversation composer shared across runtime/session changes. The parent
// owns launch/stop/restart. SDK input uses its session route; Claude PTY input
// uses the guarded president queue and retains the native terminal controls.

import { useEffect, useState } from 'react'
import { Power, Trash2 } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { BEACON_SPRITE } from '@/lib/swarm/sprites'
import { useT } from '@/i18n/I18nContext'
import type { WorkerStatus } from './SwarmWorkerPane'
import { SwarmSeatHeader } from './SwarmSeatHeader'
import { SwarmSeatFeed, SwarmSeatSay, sayToWorker, sayToPresidentPty, type SeatDraftState } from './SwarmSeatTalk'

interface Props {
  projectPath: string
  /** The legacy Claude PTY address; empty for an SDK desk. */
  terminalId: string
  runtime?: 'pty' | 'sdk'
  sdkSessionId?: string
  /** Display status, derived by SwarmModule from the active-session poll +
   *  this pane's exit signal — the SAME vocabulary the worker tiles use. */
  status: WorkerStatus
  /** A launch, stop or restart request is in flight. */
  busy: boolean
  /** The attached desk closed — SwarmModule marks it exited. */
  onExit: () => void
  /** Stop this desk (there is no president worktree to tear down). */
  onStop: () => void
  /** Relaunch an exited desk through POST /api/swarm/supply. */
  onRestart: () => void
  /** Owned by the project module so closing this surface keeps unsent words. */
  draftState?: SeatDraftState
}

/** "14:05" today, "10/5 14:05" (month/day in `lang`) on any other day. */
export const callStamp = (at: number, lang: string, now = Date.now()): string => {
  const d = new Date(at)
  const today = d.toDateString() === new Date(now).toDateString()
  return d.toLocaleString(lang, today ? { hour: '2-digit', minute: '2-digit' } : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
export const callDuration = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

export const SwarmSupplyPane = ({ projectPath, terminalId, runtime = 'pty', sdkSessionId, status, busy, onExit, onStop, onRestart, draftState }: Props) => {
  const { t, lang } = useT()
  // `text` is the line as saved (in the language of that moment); shown only
  // for an old record without `seconds`.
  const [calls, setCalls] = useState<{ id: string; at: number; text: string; seconds?: number }[]>([])
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    setCalls([])
    const poll = async () => {
      try {
        const r = await fetch(`/api/phone-link/call-notes?path=${encodeURIComponent(projectPath)}`)
        if (alive && r.ok) {
          const data = await r.json()
          if (alive) setCalls(Array.isArray(data.entries) ? data.entries.slice(-5) : [])
        }
      } catch { /* Reload or temporary connection loss: retain the last read. */ }
      if (alive) timer = setTimeout(() => void poll(), 5000)
    }
    void poll()
    return () => { alive = false; if (timer) clearTimeout(timer) }
  }, [projectPath])
  // Two presses: the first arms (the button turns solid), the second clears.
  const [armed, setArmed] = useState(false)
  const clearCalls = async () => {
    if (!armed) return setArmed(true)
    setArmed(false)
    const r = await fetch(`/api/phone-link/call-notes?path=${encodeURIComponent(projectPath)}`, { method: 'DELETE' }).catch(() => null)
    if (r?.ok) setCalls([])
  }
  const statusLabel: string = {
    working: t('projectPanel.swarm.statusWorking'),
    waiting: t('projectPanel.swarm.statusWaiting'),
    starting: t('projectPanel.swarm.statusStarting'),
    exited: t('projectPanel.swarm.statusExited'),
  }[status]

  return (
    <div className={`flex h-full min-h-0 flex-col ${runtime === 'sdk' ? 'bg-bg' : 'bg-[#1a1a1a]'}`}>
      {/* The seat's nameplate (role tint · otter · status) + stop. */}
      <SwarmSeatHeader
        role="supply"
        sprite={BEACON_SPRITE[status]}
        statusLabel={statusLabel}
        tone={status === 'working' ? 'run' : undefined}
        detailTitle={t('projectPanel.swarm.supply.hint')}
      >
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          title={t('projectPanel.swarm.supply.stop')}
          className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-micro text-ink-muted transition-colors hover:border-accent hover:bg-bg-hover hover:text-accent active:bg-accent active:text-bg-card disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        >
          <Power size={10} strokeWidth={2.25} />
          {busy ? t('projectPanel.swarm.supply.stopping') : t('projectPanel.swarm.supply.stop')}
        </button>
      </SwarmSeatHeader>

      {calls.length > 0 && (
        <div className="flex max-h-24 shrink-0 items-start gap-2 border-b border-line-soft bg-bg-card px-3 py-1">
          <ul className="min-h-0 flex-1 self-stretch overflow-y-auto text-meta text-ink-muted" aria-label={t('projectPanel.swarm.supply.calls')}>
            {calls.map((call) => (
              <li key={call.id}>
                <time dateTime={new Date(call.at).toISOString()}>{callStamp(call.at, lang)}</time> ·{' '}
                {typeof call.seconds === 'number' ? t('projectPanel.swarm.supply.call', { duration: callDuration(call.seconds) }) : call.text}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void clearCalls()}
            onBlur={() => setArmed(false)}
            title={armed ? t('projectPanel.swarm.supply.clearCallsConfirm') : t('projectPanel.swarm.supply.clearCalls')}
            aria-label={armed ? t('projectPanel.swarm.supply.clearCallsConfirm') : t('projectPanel.swarm.supply.clearCalls')}
            className={`flex shrink-0 items-center rounded-[3px] border p-0.5 transition-colors active:scale-[0.98] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1 ${armed ? 'border-accent bg-accent text-bg-card hover:opacity-90' : 'border-transparent text-ink-muted hover:border-line hover:text-ink'}`}
          >
            <Trash2 size={11} strokeWidth={2.25} />
          </button>
        </div>
      )}

      {/* Closing either surface reports the same desk lifecycle to the parent. */}
      {runtime === 'sdk' && sdkSessionId ? <>
        <SwarmSeatFeed sdkSessionId={sdkSessionId} projectPath={projectPath} onExit={onExit} />
        {status === 'exited' ? <button type="button" onClick={onRestart} disabled={busy}
          className="m-2 rounded border border-line bg-bg-card px-2 py-1 text-ui text-ink transition-colors hover:bg-bg-hover active:bg-accent active:text-bg-card disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
          {t('projectPanel.swarm.restart')}
        </button> : null}
      </> : <div className="min-h-0 flex-1">
        <ClaudeTerminalPane
          terminalId={terminalId}
          chrome={false}
          autoFocus={false}
          onExit={() => onExit()}
          onRestart={onRestart}
        />
      </div>}
      {/* One composer across runtime/handle changes, so an unsent draft stays. */}
      <SwarmSeatSay alwaysOpen draftState={draftState}
        disabled={busy || (status !== 'waiting' && status !== 'working') || !(runtime === 'sdk' ? sdkSessionId : terminalId)}
        placeholder={t('projectPanel.swarm.say.presidentPlaceholder')}
        onSend={(text, send) => runtime === 'sdk' && sdkSessionId
          ? sayToWorker(projectPath, sdkSessionId, text, t, send)
          : sayToPresidentPty(projectPath, terminalId, text, t, send)} />
    </div>
  )
}
