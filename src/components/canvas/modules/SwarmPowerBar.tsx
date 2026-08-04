// SwarmPowerBar — the SINGLE master Start/Stop switch for the whole Swarm tab,
// split into two INLINE pieces (status pill + switch) that SwarmModule composes
// into its one-line header (the old full-width bar + the separate mode row + the
// separate tab row were three stacked strips that squeezed the terminal area —
// now everything lives on the tab row itself).
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
// actions; these pieces render the state + the switch and call `onToggle`.
// (No separate auto-integrate switch exists — retired 2026-07-16. The engine
// never pushes; waking the commander for ready work rides the engine ON state.)
//
// SECURITY: rendered only inside SwarmModule, itself behind the owner+toggle
// gate; the /api/swarm/* routes the composition calls are owner-only too. No
// extra gating here — the trace-zero guarantee is structural (see SwarmModule).

import { useT } from '@/i18n/I18nContext'

interface StatusProps {
  /** The engine is running (drain+dispatch loop scheduled) — the pill's ON state. */
  running: boolean
  /** The owner EXPLICITLY stopped the engine (server-composed: in-memory flag OR the
   *  persisted record, so it survives restarts). While set (and not running) the
   *  status reads "stopped by hand" instead of the plain "stopped" — a deliberate
   *  pause is distinguishable from a never-started engine at a glance. */
  manualStop: boolean
  /** The orchestrator route answered (false → the offline label). */
  available: boolean
  /** Live worker count (manual + engine, deduped) — the "how many" in the status. */
  workerCount: number
}

/** State at a glance (条件: 稼働中/停止中・何体動いているか). running pops in MOSS
 *  — a calm "go" green, NOT the app's alarming accent red — so the live state is
 *  unmistakable; stopped / offline stay inert grey. ink-faint is the inert grey
 *  that still clears 3:1 on paper. A deliberate owner pause (manualStop) reads
 *  "stopped by hand", distinct from a merely never-started engine. */
export const SwarmPowerStatus = ({ running, manualStop, available, workerCount }: StatusProps) => {
  const { t } = useT()
  const live = available && running
  const statusLabel = !available
    ? t('projectPanel.swarm.power.offline')
    : running
      ? t('projectPanel.swarm.power.running')
      : manualStop
        ? t('projectPanel.swarm.power.manualStop')
        : t('projectPanel.swarm.power.stopped')
  return (
    <span
      className={[
        'flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-meta transition-colors duration-150',
        live ? 'bg-moss-soft text-ink' : 'text-ink-muted',
      ].join(' ')}
      title={t('projectPanel.swarm.power.hint')}
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
  )
}

interface SwitchProps {
  /** The engine is running — the switch's ON state. */
  running: boolean
  /** The orchestrator route answered (false dims the switch — nothing to power). */
  available: boolean
  /** A power round-trip is in flight (disables the switch during the engine call). */
  busy: boolean
  /** Flip the master switch — SwarmModule composes start/stop + the launches. */
  onToggle: (next: boolean) => void
}

/** The SINGLE master switch — a segmented Stop | Start on a subtle inset track.
 *  The SELECTED side is filled and colored by MEANING — Start-active = moss
 *  ("running"), Stop-active = ink ("stopped") — so WHICH state is current reads
 *  instantly (and without the old accent-red, which made a mere idle "Stop" look
 *  like a danger action). The inactive side is a ghost with an explicit hover;
 *  both share disabled + focus-visible (5-state, ui-interactive-states). */
export const SwarmPowerSwitch = ({ running, available, busy, onToggle }: SwitchProps) => {
  const { t } = useT()
  const disabled = busy || !available
  return (
    <div
      role="group"
      aria-label={t('projectPanel.swarm.power.label')}
      title={t('projectPanel.swarm.power.hint')}
      aria-disabled={disabled}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-[5px] border border-line bg-bg-inset p-0.5"
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
              'h-6 min-w-[52px] whitespace-nowrap rounded-[3px] px-2.5 text-meta font-medium transition-all duration-150',
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
  )
}
