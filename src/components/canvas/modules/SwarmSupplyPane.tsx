// SwarmSupplyPane — the supply officer (補給官) tile: a thin header (live status
// · identity · stop) wrapping the EXISTING ClaudeTerminalPane, exactly like
// SwarmWorkerPane. The PTY, its SSE stream, xterm rendering, flow-control ACK
// and clipboard chords all come from ClaudeTerminalPane verbatim (chrome={false}
// so our header replaces its built-in one) — this file adds NO terminal logic,
// only the supply-specific chrome. The supply PTY is spawned by SwarmModule via
// POST /api/swarm/supply (NO worktree — it runs in the project's primary
// checkout, running /supply); this pane only attaches to the returned terminalId
// and reports its close. Stopping it is a plain PTY kill (no worktree to remove).

import { Power } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { BEACON_SPRITE } from '@/lib/swarm/sprites'
import { useT } from '@/i18n/I18nContext'
import type { WorkerStatus } from './SwarmWorkerPane'
import { SwarmSeatHeader } from './SwarmSeatHeader'

interface Props {
  /** PTY id the supply route assigned when it launched `claude` in the cwd. */
  terminalId: string
  /** Display status, derived by SwarmModule from the active-terminal poll +
   *  this pane's exit signal — the SAME vocabulary the worker tiles use. */
  status: WorkerStatus
  /** A stop request is in flight (the PTY kill round-trip). */
  busy: boolean
  /** The PTY closed (claude /quit, Ctrl-D, …) — SwarmModule marks it exited. */
  onExit: () => void
  /** Kill the PTY (there is no worktree to tear down for supply). */
  onStop: () => void
  /** Relaunch the supply PTY after it exits — wired to the exit overlay's
   *  Restart button inside ClaudeTerminalPane (POST /api/swarm/supply again). */
  onRestart: () => void
}

export const SwarmSupplyPane = ({ terminalId, status, busy, onExit, onStop, onRestart }: Props) => {
  const { t } = useT()
  const statusLabel: string = {
    working: t('projectPanel.swarm.statusWorking'),
    waiting: t('projectPanel.swarm.statusWaiting'),
    starting: t('projectPanel.swarm.statusStarting'),
    exited: t('projectPanel.swarm.statusExited'),
  }[status]

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1a1a1a]">
      {/* The seat's nameplate (role tint · otter · status) + stop. */}
      <SwarmSeatHeader
        role="supply"
        sprite={BEACON_SPRITE[status]}
        statusLabel={statusLabel}
        waiting={status === 'waiting'}
        detailTitle={t('projectPanel.swarm.supply.hint')}
      >
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          title={t('projectPanel.swarm.supply.stop')}
          className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-micro text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        >
          <Power size={10} strokeWidth={2.25} />
          {busy ? t('projectPanel.swarm.supply.stopping') : t('projectPanel.swarm.supply.stop')}
        </button>
      </SwarmSeatHeader>

      {/* The PTY itself — reused verbatim. onExit bubbles the close up so the
          module flips the session to 'exited' (our header shows it). */}
      <div className="min-h-0 flex-1">
        <ClaudeTerminalPane
          terminalId={terminalId}
          chrome={false}
          onExit={() => onExit()}
          onRestart={onRestart}
        />
      </div>
    </div>
  )
}
