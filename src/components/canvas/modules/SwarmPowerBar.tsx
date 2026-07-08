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
  /** The owner EXPLICITLY stopped the engine (server-composed: in-memory flag OR the
   *  persisted record, so it survives restarts). While set (and not running) the
   *  status reads "stopped by hand" instead of the plain "stopped" — a deliberate
   *  pause is distinguishable from a never-started engine at a glance. */
  manualStop: boolean
  /** The orchestrator route answered (false dims the switch — nothing to power). */
  available: boolean
  /** A power round-trip is in flight (disables the switch during the engine call). */
  busy: boolean
  /** Live worker count (manual + engine, deduped) — the "how many" in the status. */
  workerCount: number
  /** Flip the master switch — SwarmModule composes start/stop + the launches. */
  onToggle: (next: boolean) => void
}

export const SwarmPowerBar = ({ running, manualStop, available, busy, workerCount, onToggle }: Props) => {
  const { t } = useT()

  // State at a glance (条件: 稼働中/停止中・何体動いているか). running pops in MOSS
  // — a calm "go" green, NOT the app's alarming accent red — so the live state is
  // unmistakable; stopped / offline stay inert grey. ink-faint is the inert grey
  // that still clears 3:1 on paper (unlike the near-invisible line-strong). A
  // deliberate owner pause (manualStop — survives restarts server-side) reads
  // "stopped by hand", distinct from a merely never-started engine.
  const live = available && running
  const statusLabel = !available
    ? t('projectPanel.swarm.power.offline')
    : running
      ? t('projectPanel.swarm.power.running')
      : manualStop
        ? t('projectPanel.swarm.power.manualStop')
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

      {/* Status: a MOSS-tinted pill when running (so "running · N workers" pops at
          a glance), inert when stopped / offline. dot + label (+ live worker count
          once the engine route answers). */}
      <span
        className={[
          'flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] transition-colors duration-150',
          live ? 'bg-moss-soft text-ink' : 'text-ink-muted',
        ].join(' ')}
      >
        <span
          className={`h-[6px] w-[6px] shrink-0 rounded-full ${live ? 'bg-moss' : 'bg-ink-faint'}`}
          aria-hidden
        />
        <span className="truncate">
          {statusLabel}
          {available && <> · {t('projectPanel.swarm.power.workers', { count: workerCount })}</>}
        </span>
      </span>

      {/* The SINGLE master switch — a segmented Stop | Start on a subtle inset
          track. The SELECTED side is filled and colored by MEANING — Start-active
          = moss ("running"), Stop-active = ink ("stopped") — so WHICH state is
          current reads instantly (and without the old accent-red, which made a
          mere idle "Stop" look like a danger action). The inactive side is a ghost
          with an explicit hover; both share disabled + focus-visible (5-state,
          ui-interactive-states). */}
      <div
        role="group"
        aria-label={t('projectPanel.swarm.power.label')}
        title={t('projectPanel.swarm.power.hint')}
        aria-disabled={disabled}
        className="ml-auto inline-flex shrink-0 items-center gap-0.5 rounded-[5px] border border-line bg-bg-inset p-0.5"
      >
        {(
          [
            [false, t('projectPanel.swarm.power.stop')],
            [true, t('projectPanel.swarm.power.start')],
          ] as [boolean, string][]
        ).map(([v, label]) => {
          const active = running === v
          // Selected fill colored by meaning: Start (v=true) → moss = running,
          // Stop (v=false) → ink = stopped; both inverse text for AA contrast.
          const activeClass = v ? 'border-moss bg-moss text-bg-card' : 'border-ink bg-ink text-bg-card'
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
                'h-6 min-w-[56px] rounded-[3px] px-3 text-[11px] font-medium transition-all duration-150',
                'border focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                'disabled:cursor-not-allowed disabled:opacity-40',
                active
                  ? activeClass
                  : 'border-transparent bg-transparent text-ink-muted enabled:hover:bg-bg-card enabled:hover:text-ink',
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
