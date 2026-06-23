// SwarmWorkerPane — one swarm worker's tile: a thin header (live status · branch
// · terminate) wrapping the EXISTING ClaudeTerminalPane. The PTY, its SSE
// stream, xterm rendering, flow-control ACK and clipboard chords all come from
// ClaudeTerminalPane verbatim (chrome={false} so our header replaces its
// built-in one) — this file adds NO terminal logic, only the swarm-specific
// chrome around it. The worker PTY is spawned by SwarmModule via the B API
// (POST /api/swarm/worker); this pane only attaches to the returned terminalId.

import { Power, Trash2, AlertTriangle } from 'lucide-react'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { useT } from '@/i18n/I18nContext'

/** Display state of a worker, derived by SwarmModule from the active-terminal
 *  poll + the pane's own exit signal:
 *  - working/waiting come straight from GET /api/terminal/active (the same
 *    azure/ochre beacon vocabulary the Board + Ground cards use),
 *  - starting = spawned but not yet seen by the poll (optimistic),
 *  - exited   = the PTY closed (ClaudeTerminalPane.onExit / a dead probe). */
export type WorkerStatus = 'working' | 'waiting' | 'starting' | 'exited'

interface Props {
  /** PTY id the B API assigned when it launched `claude` in the worktree. */
  terminalId: string
  /** swarm/* branch the worker works on (also recorded on the Board card). */
  branch: string
  /** The dispatched card's title — shown in the header tooltip for context. */
  taskTitle: string
  status: WorkerStatus
  /** Set when a soft "Terminate" kept the worktree (dirty/locked); shows a
   *  force-remove affordance. Undefined = the worktree is clean / gone. */
  retainedReason?: string
  /** A terminate / force-remove request is in flight for this worker. */
  busy: boolean
  /** The PTY closed — SwarmModule marks the worker 'exited'. */
  onExit: () => void
  /** Kill the PTY + remove the worktree (soft: keeps a dirty tree). */
  onTerminate: () => void
  /** Remove the worktree with --force (the dirty/abandon case). */
  onForceRemove: () => void
}

// Status dot colour — the SAME beacon vocabulary as the Ground/Board cards
// (ProjectCard.tsx, BoardTab.tsx): azure = busy, ochre = waiting for input.
const DOT: Record<WorkerStatus, string> = {
  working: 'bg-azure',
  waiting: 'bg-ochre',
  starting: 'bg-line-strong',
  exited: 'bg-line-strong',
}

export const SwarmWorkerPane = ({
  terminalId,
  branch,
  taskTitle,
  status,
  retainedReason,
  busy,
  onExit,
  onTerminate,
  onForceRemove,
}: Props) => {
  const { t } = useT()
  const statusLabel: string = {
    working: t('projectPanel.swarm.statusWorking'),
    waiting: t('projectPanel.swarm.statusWaiting'),
    starting: t('projectPanel.swarm.statusStarting'),
    exited: t('projectPanel.swarm.statusExited'),
  }[status]

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#1a1a1a]">
      {/* Header: status dot+label · branch (+ task title in tooltip) · terminate */}
      <div className="flex shrink-0 items-center gap-2 border-b border-line-soft bg-bg-card px-2.5 py-1.5">
        <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${DOT[status]}`} aria-hidden />
        <span
          className={`label-cap shrink-0 ${status === 'waiting' ? 'text-[var(--beacon-waiting)]' : 'text-ink-faint'}`}
        >
          {statusLabel}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted"
          title={taskTitle ? `${branch} — ${taskTitle}` : branch}
        >
          {branch}
        </span>
        <button
          type="button"
          onClick={onTerminate}
          disabled={busy}
          title={t('projectPanel.swarm.terminate')}
          className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
        >
          <Power size={10} strokeWidth={2.25} />
          {busy ? t('projectPanel.swarm.terminating') : t('projectPanel.swarm.terminate')}
        </button>
      </div>

      {/* Retained-worktree strip: a soft terminate kept a dirty/locked tree so
          the worker's uncommitted work isn't lost. Offer an explicit force. */}
      {retainedReason && (
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line-soft bg-bg-inset px-2.5 py-1">
          <AlertTriangle size={11} className="shrink-0 text-ochre" aria-hidden />
          <span
            className="min-w-0 flex-1 truncate text-[10px] text-ink-subtle"
            title={retainedReason}
          >
            {t('projectPanel.swarm.retained')}
          </span>
          <button
            type="button"
            onClick={onForceRemove}
            disabled={busy}
            className="flex shrink-0 items-center gap-1 rounded-[3px] border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:text-accent active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
          >
            <Trash2 size={10} strokeWidth={2.25} />
            {t('projectPanel.swarm.forceRemove')}
          </button>
        </div>
      )}

      {/* The PTY itself — reused verbatim. onExit bubbles the close up so the
          module flips the worker to 'exited' (our header shows it; the pane's
          own exit strip stays hidden under chrome={false} until then). */}
      <div className="min-h-0 flex-1">
        <ClaudeTerminalPane terminalId={terminalId} chrome={false} onExit={() => onExit()} />
      </div>
    </div>
  )
}
