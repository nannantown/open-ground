// SwarmSupplyPane — the supply officer (補給官) tile: a thin header (live status
// · identity · stop) wrapping the EXISTING ClaudeTerminalPane, exactly like
// SwarmWorkerPane. The PTY, its SSE stream, xterm rendering, flow-control ACK
// and clipboard chords all come from ClaudeTerminalPane verbatim (chrome={false}
// so our header replaces its built-in one) — this file adds NO terminal logic,
// only the supply-specific chrome. The supply PTY is spawned by SwarmModule via
// POST /api/swarm/supply (NO worktree — it runs in the project's primary
// checkout, running /supply); this pane only attaches to the returned terminalId
// and reports its close. Stopping it is a plain PTY kill (no worktree to remove).

import { Power, Inbox } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { useT } from '@/i18n/I18nContext'
import type { WorkerStatus } from './SwarmWorkerPane'

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
}

// Status dot colour — the SAME beacon vocabulary as the worker tiles
// (SwarmWorkerPane) and the Ground/Board cards: azure = busy, ochre = waiting.
// starting/exited use ink-faint so the inert grey dot clears the 3:1 graphic
// floor on the paper header (line-strong ≈ 2.1:1 was near-invisible).
const DOT: Record<WorkerStatus, string> = {
  working: 'bg-azure',
  waiting: 'bg-ochre',
  starting: 'bg-ink-faint',
  exited: 'bg-ink-faint',
}

export const SwarmSupplyPane = ({ terminalId, status, busy, onExit, onStop }: Props) => {
  const { t } = useT()
  const statusLabel: string = {
    working: t('projectPanel.swarm.statusWorking'),
    waiting: t('projectPanel.swarm.statusWaiting'),
    starting: t('projectPanel.swarm.statusStarting'),
    exited: t('projectPanel.swarm.statusExited'),
  }[status]

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1a1a1a]">
      {/* Header: status dot+label · supply identity · stop. Mirrors the worker
          pane header so the two surfaces read as siblings. */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-2.5 py-1.5">
        <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${DOT[status]}`} aria-hidden />
        <span
          className={`label-cap shrink-0 ${status === 'waiting' ? 'text-[var(--beacon-waiting)]' : 'text-ink-faint'}`}
        >
          {statusLabel}
        </span>
        <span
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-[11px] text-ink-muted"
          title={t('projectPanel.swarm.supply.hint')}
        >
          <Inbox size={11} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
          <span className="truncate">{t('projectPanel.swarm.supply.identity')}</span>
        </span>
        <button
          type="button"
          onClick={onStop}
          disabled={busy}
          title={t('projectPanel.swarm.supply.stop')}
          className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        >
          <Power size={10} strokeWidth={2.25} />
          {busy ? t('projectPanel.swarm.supply.stopping') : t('projectPanel.swarm.supply.stop')}
        </button>
      </div>

      {/* The PTY itself — reused verbatim. onExit bubbles the close up so the
          module flips the session to 'exited' (our header shows it). */}
      <div className="min-h-0 flex-1">
        <ClaudeTerminalPane terminalId={terminalId} chrome={false} onExit={() => onExit()} />
      </div>
    </div>
  )
}
