// SwarmManagerPane — the commander's (司令官) seat on the one-screen Swarm tab.
//
// The owner talks only to the president (社長, owner decision 2026-09-23), so
// this seat is deliberately almost invisible: the nameplate (figure · role ·
// running / stopped / not there) and ONE quiet start/stop button. Nothing else.
// Everything the seat used to carry — the commander's transcript / terminal,
// the command bar (状況 / マージ / 掃除), the engine dashboard (KPIs, landed per
// week, consumption, presence line) — was removed with that decision. (The
// Monitoring switch went to the bar's header, then off the screen entirely on
// 2026-09-24 — the owner asks the president to change it.)
//
// The desk's lifecycle (launch / stop / restart / reconcile after a restart)
// is owned by SwarmModule; its status comes from SwarmModule's active-desk
// poll (GET /api/terminal/active lists BOTH pools, so an SDK commander is seen
// there too). This component never fetches.

import { Power } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'
import { BEACON_SPRITE } from '@/lib/swarm/sprites'
import type { WorkerStatus } from './SwarmWorkerPane'
import { SwarmSeatHeader } from './SwarmSeatHeader'

/** What the owner is told about the commander — three words, nothing finer. */
export type CommanderSeatState = 'running' | 'stopped' | 'absent'

/** No desk ⇒ absent; a desk whose stream closed ⇒ stopped; any live status
 *  (working / waiting / starting) ⇒ running. Pure so the mapping is provable. */
export const commanderSeatState = (status: WorkerStatus | null): CommanderSeatState =>
  status === null ? 'absent' : status === 'exited' ? 'stopped' : 'running'

const STATE_LABEL: Record<CommanderSeatState, MessageKey> = {
  running: 'projectPanel.swarm.manager.stateRunning',
  stopped: 'projectPanel.swarm.manager.stateStopped',
  absent: 'projectPanel.swarm.manager.stateAbsent',
}

interface Props {
  /** The commander desk's live status, or null when there is no desk. */
  status: WorkerStatus | null
  /** A launch / stop round-trip is in flight. */
  busy: boolean
  /** No desk → start one (POST /api/swarm/manager, via SwarmModule). */
  onLaunch: () => void
  /** A live desk → stop it (via SwarmModule). */
  onStop: () => void
  /** A stopped desk → start it again (via SwarmModule). */
  onRestart: () => void
}

export const SwarmManagerPane = ({ status, busy, onLaunch, onStop, onRestart }: Props) => {
  const { t } = useT()
  const state = commanderSeatState(status)
  const running = state === 'running'
  // The seat is narrow, so the button shows the short word; its accessible
  // name says whose start / stop it is (the top bar has its own Start / Stop).
  const label = running
    ? busy ? 'projectPanel.swarm.manager.stopping' : 'projectPanel.swarm.manager.stop'
    : busy ? 'projectPanel.swarm.manager.launching' : 'projectPanel.swarm.manager.start'
  const name = running ? 'projectPanel.swarm.manager.stopFull' : 'projectPanel.swarm.manager.launch'
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <SwarmSeatHeader
        role="commander"
        sprite={status ? BEACON_SPRITE[status] : null}
        statusLabel={t(STATE_LABEL[state])}
      >
        <button
          type="button"
          onClick={running ? onStop : state === 'stopped' ? onRestart : onLaunch}
          disabled={busy}
          // While busy the visible word (Starting… / Stopping…) IS the name, so
          // a screen reader hears the progress too.
          aria-label={busy ? undefined : t(name)}
          aria-busy={busy}
          title={t(name)}
          className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-micro text-ink-muted transition-colors duration-150 enabled:hover:border-accent enabled:hover:text-accent enabled:active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        >
          <Power size={10} strokeWidth={2.25} aria-hidden />
          {t(label)}
        </button>
      </SwarmSeatHeader>
      {/* One faint line, so an empty seat does not read as a broken one. */}
      <p className="px-3 py-3 text-meta leading-relaxed text-ink-faint">
        {t('projectPanel.swarm.manager.conversationHint')}
      </p>
    </div>
  )
}
