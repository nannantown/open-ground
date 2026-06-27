// SwarmPowerBar — the SINGLE master Start/Stop switch for the whole Swarm tab.
//
// One control governs the in-app swarm's "power". Turning it ON starts the
// autonomous orchestrator engine (which drains the Board's todo column and
// dispatches workers) AND launches the commander (/manage) + supply (/supply)
// conversations together — all idempotent, so flipping it on when something is
// already up never double-launches. Turning it OFF only halts NEW dispatch: the
// orchestrator stops handing out work, but workers already running finish on
// their own and their worktrees/branches are kept (teardown is the worker tab's
// / commander's job, never this switch's).
//
// PURELY PRESENTATIONAL: the power composition (start engine + launch commander
// + launch supply, each idempotent) lives in SwarmModule, which owns those
// actions; this bar renders the state + the switch and calls `onToggle`. The
// status — running / stopped / not-available, plus the live worker count —
// answers "is the swarm running, and how many workers are live?" at a glance
// from EVERY Swarm sub-view, because the bar sits above the supply/commander/
// worker tab strip (条件: 稼働状態を UI 表示). Auto-integrate stays a SEPARATE
// switch on the commander dashboard (default off) — this bar never touches it.
//
// SECURITY: rendered only inside SwarmModule, itself behind the owner+toggle
// gate; the /api/swarm/* routes the composition calls are owner-only too. No
// extra gating here — the trace-zero guarantee is structural (see SwarmModule).

import { Power } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'

interface Props {
  /** The engine is running (drain+dispatch loop scheduled) — the switch's ON state. */
  running: boolean
  /** The orchestrator route answered (false dims the switch — nothing to power). */
  available: boolean
  /** A power round-trip is in flight (disables the switch during the engine call). */
  busy: boolean
  /** Live worker count (manual + engine, deduped) — the "how many" in the status. */
  workerCount: number
  /** Flip the master switch — SwarmModule composes start/stop + the launches. */
  onToggle: (next: boolean) => void
}

export const SwarmPowerBar = ({ running, available, busy, workerCount, onToggle }: Props) => {
  const { t } = useT()

  // Status: not-available (route 404) · running (moss) · stopped (inert grey).
  // The dot carries the state at a glance; the label + live worker count spell it
  // out (条件: 稼働中/停止中・何体動いているか). ink-faint is the inert grey that
  // still clears 3:1 on paper (unlike the near-invisible line-strong).
  const statusDot = !available ? 'bg-ink-faint' : running ? 'bg-moss' : 'bg-ink-faint'
  const statusLabel = !available
    ? t('projectPanel.swarm.power.offline')
    : running
      ? t('projectPanel.swarm.power.running')
      : t('projectPanel.swarm.power.stopped')
  const disabled = busy || !available

  return (
    // A slim PAPER header strip (bg-bg) above the tab row, so the master control
    // and its status are visible from every Swarm sub-view (supply/commander/
    // workers). Paper ink tokens keep 4.5:1+ contrast.
    <div className="flex shrink-0 items-center gap-3 border-b border-line bg-bg px-3 py-2">
      {/* Identity — the master control's name + a power glyph. */}
      <span className="flex shrink-0 items-center gap-1.5 text-[12px] font-medium text-ink">
        <Power size={13} strokeWidth={2} className="shrink-0 text-ink-faint" aria-hidden />
        {t('projectPanel.swarm.power.label')}
      </span>

      {/* Status: dot + running/stopped/offline (+ live worker count when the
          engine route is reachable). */}
      <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-ink-muted">
        <span className={`h-[6px] w-[6px] shrink-0 rounded-full ${statusDot}`} aria-hidden />
        <span className="truncate">
          {statusLabel}
          {available && <> · {t('projectPanel.swarm.power.workers', { count: workerCount })}</>}
        </span>
      </span>

      {/* The SINGLE switch — segmented Stop | Start, the active side = current
          state. The house segmented pattern (SwarmManagerPane's ControlRow): the
          selected side flips BACKGROUND + TEXT together so contrast holds, with
          explicit hover / disabled / focus-visible states. */}
      <div
        role="group"
        aria-label={t('projectPanel.swarm.power.label')}
        title={t('projectPanel.swarm.power.hint')}
        aria-disabled={disabled}
        className="ml-auto inline-flex shrink-0 items-center gap-0 rounded-[3px] border border-line p-0.5"
      >
        {(
          [
            [false, t('projectPanel.swarm.power.stop')],
            [true, t('projectPanel.swarm.power.start')],
          ] as [boolean, string][]
        ).map(([v, label]) => {
          const active = running === v
          return (
            <button
              key={String(v)}
              type="button"
              onClick={() => {
                if (!disabled && running !== v) onToggle(v)
              }}
              aria-pressed={active}
              disabled={disabled}
              className={[
                'h-6 min-w-[52px] rounded-[2px] px-3 text-[11px] font-medium transition-all duration-150',
                'border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                'disabled:cursor-not-allowed disabled:opacity-40',
                active
                  ? 'border-accent bg-accent text-bg-card'
                  : 'border-line bg-transparent text-ink-muted enabled:hover:border-line-strong enabled:hover:bg-bg-inset enabled:hover:text-ink',
              ].join(' ')}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
