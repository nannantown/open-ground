// SwarmPowerBar — the SINGLE master on/off switch for the whole Swarm bar,
// an INLINE piece that SwarmModule places on its one-line header (the old full-width bar + the separate mode row + the
// separate tab row were three stacked strips that squeezed the terminal area —
// now everything lives on the tab row itself).
//
// One control governs the in-app swarm's "power". Turning it ON starts the
// autonomous orchestrator engine (which drains the Board's todo column and
// dispatches workers) AND launches the commander (/manage) + supply (/supply)
// conversations together — all idempotent, so flipping it on when something is
// already up never double-launches. Turning it OFF only halts NEW dispatch: the
// orchestrator stops handing out work, but workers already running finish on
// their own and their worktrees/branches are kept (teardown is the worker
// seats' / commander's job, never this switch's).
//
// The status pill ("running · N workers") and the Monitoring switch that used
// to sit beside it were removed (owner 2026-09-24): the switch alone says on /
// off, and monitoring is changed by asking the president in words.
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

/** The SINGLE master switch — one on/off toggle, no words (owner 2026-09-24:
 *  "an on/off switch is enough, as long as I can tell which it is"). The state
 *  reads from the knob's side AND the track colour — moss when on, a quiet grey
 *  track when off. role=switch
 *  + aria-checked gives screen readers "<team>, on/off"; as a native button it
 *  already takes Space / Enter. Hover / focus-visible / disabled per
 *  ui-interactive-states. */
export const SwarmPowerSwitch = ({ running, available, busy, onToggle }: SwitchProps) => {
  const { t } = useT()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={running}
      aria-label={t('projectPanel.swarm.power.label')}
      title={t(available ? 'projectPanel.swarm.power.hint' : 'projectPanel.swarm.power.offline')}
      disabled={busy || !available}
      onClick={() => onToggle(!running)}
      className={[
        'group inline-flex h-6 shrink-0 items-center rounded-full px-0.5',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        'disabled:cursor-not-allowed disabled:opacity-40',
      ].join(' ')}
    >
      <span
        aria-hidden
        className={[
          'relative inline-block h-[18px] w-[32px] rounded-full border transition-colors duration-150',
          running
            ? 'border-moss bg-moss group-enabled:group-hover:bg-moss/80 group-enabled:group-active:bg-moss/65'
            : 'border-ink-faint bg-bg-inset group-enabled:group-hover:border-ink-muted group-enabled:group-hover:bg-plane group-enabled:group-active:bg-line-soft',
        ].join(' ')}
      >
        <span
          className={[
            'absolute top-[2px] h-[12px] w-[12px] rounded-full transition-[left,background-color] duration-150',
            running ? 'left-[16px] bg-bg-card' : 'left-[2px] bg-ink-muted',
          ].join(' ')}
        />
      </span>
    </button>
  )
}
