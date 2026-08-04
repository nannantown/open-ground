// SwarmOnboarding — the SINGLE centered screen the Swarm tab shows while the
// swarm is fully idle (engine stopped + no supply / commander / worker sessions
// — the OFF / first-run state). It answers "what is this and how does it work?"
// BEFORE the owner presses Start:
//
//   • a FLOW diagram (the 図) — request → filed to Board to-do → pulled &
//     dispatched to a worker → built in an isolated worktree → review →
//     integrated → done — with each step tagged by the role that owns it, so the
//     sequence visually maps onto the three roles.
//   • a ROLE summary (the 表) — what each of supply officer / commander / worker
//     does, one line each.
//   • a START note + CTA — what pressing Start actually does, so it's understood
//     before it's pressed (条件2).
//
// PURELY PRESENTATIONAL: the Start CTA calls `onStart` (SwarmModule's
// powerSwarm(true) — the SAME master-power composition the SwarmPowerBar drives),
// and the component owns no engine state and changes no wiring (planSwarmPower is
// untouched). It only EXPLAINS the existing behavior and offers the button.
//
// i18n: role NAMES are REUSED from the existing supply / manager / worker keys
// (no duplicate text); only the flow steps + role one-liners + the framing copy
// are new (条件3). There is no separate dark theme in this app — the surface uses
// the shared paper semantic tokens (bg / ink / line / role tints), which keep
// 4.5:1+ contrast, exactly like the sibling empty states (条件: dark/light).
//
// SECURITY: mounted only inside SwarmModule, itself behind the owner+toggle gate
// — nothing extra to gate here (the trace-zero guarantee is structural).
//
// Once anything starts (engine running, or a supply / commander / worker session
// exists), SwarmModule stops rendering this and shows the normal tab surface — so
// the onboarding is OFF / first-run only (条件5).

import { Inbox, Gauge, Boxes, Power, ChevronRight } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'

interface Props {
  /** Fire the master-power composition (engine + supply + commander), the SAME as
   *  the SwarmPowerBar's Start. SwarmModule passes powerSwarm(true). */
  onStart: () => void
  /** A power round-trip is in flight (disables the Start button during the call). */
  busy: boolean
  /** The orchestrator route answered (false = engine not available yet; mirror the
   *  power bar — disable Start and show the offline note). */
  available: boolean
  /** Last engine-action failure, already localized (null when none). Surfaced
   *  next to the Start CTA so a failed start isn't silent — without it the engine
   *  error would be unreachable here (its usual home, SwarmManagerPane, isn't
   *  mounted while the onboarding is showing). */
  error?: string | null
}

// Which role owns one flow step — drives the step's tint + role tag, or 'state'
// for a milestone node (review / done) that has no single owner.
type FlowRole = 'you' | 'supply' | 'manager' | 'worker' | 'state'

// The work-flow, in order (条件1). Each entry is just the step's i18n key + the
// role that owns it — no copy lives here. The labels are NEW flow keys; the role
// NAMES are REUSED existing keys (see ROLE_NAME).
const FLOW: { key: string; role: FlowRole }[] = [
  { key: 'flowRequest', role: 'you' },
  { key: 'flowQueue', role: 'supply' },
  { key: 'flowDispatch', role: 'manager' },
  { key: 'flowImplement', role: 'worker' },
  { key: 'flowReview', role: 'state' },
  { key: 'flowIntegrate', role: 'manager' },
  { key: 'flowDone', role: 'state' },
]

// Role → flow-node tint. Reuses the app's existing role-ish semantic colors
// (azure / moss / ochre, the same trio used as soft tints across the app — see
// ManualPanel / BranchChangesModal). The NODE only tints its background + dot;
// the action text itself stays text-ink so it always clears AA regardless of the
// tint. 'you' / 'state' are the inert neutral surfaces.
const NODE_TINT: Record<FlowRole, string> = {
  you: 'bg-bg-inset',
  supply: 'bg-azure-soft',
  manager: 'bg-moss-soft',
  worker: 'bg-ochre-soft',
  state: 'bg-bg-inset',
}
const NODE_DOT: Record<FlowRole, string> = {
  you: 'bg-ink-faint',
  supply: 'bg-azure',
  manager: 'bg-moss',
  worker: 'bg-ochre',
  state: 'bg-ink-faint',
}
// Role → its NAME i18n key. REUSED from the existing role strings (no new role
// names — 条件3). 'state' nodes (review / done) carry no role tag.
const ROLE_NAME: Record<FlowRole, string> = {
  you: 'projectPanel.swarm.onboarding.roleYou',
  supply: 'projectPanel.swarm.supply.badge',
  manager: 'projectPanel.swarm.manager.badge',
  worker: 'projectPanel.swarm.workersTab',
  state: '',
}

// The three roles, for the summary table. icon + REUSED name key + NEW one-line
// description key, and the role tint that ties each row back to the flow above.
const ROLES: {
  key: 'supply' | 'manager' | 'worker'
  icon: typeof Inbox
  nameKey: string
  descKey: string
}[] = [
  { key: 'supply', icon: Inbox, nameKey: 'projectPanel.swarm.supply.badge', descKey: 'projectPanel.swarm.onboarding.roleSupply' },
  { key: 'manager', icon: Gauge, nameKey: 'projectPanel.swarm.manager.badge', descKey: 'projectPanel.swarm.onboarding.roleManager' },
  { key: 'worker', icon: Boxes, nameKey: 'projectPanel.swarm.workersTab', descKey: 'projectPanel.swarm.onboarding.roleWorker' },
]
// Role-icon chip tint for the summary table — soft tint bg + the role color for
// the icon (graphic, ≥3:1), matching the flow nodes so color maps role→step.
const ROLE_ICON: Record<'supply' | 'manager' | 'worker', string> = {
  supply: 'bg-azure-soft text-azure',
  manager: 'bg-moss-soft text-moss',
  worker: 'bg-ochre-soft text-ochre',
}

export const SwarmOnboarding = ({ onStart, busy, available, error }: Props) => {
  const { t } = useT()
  const disabled = busy || !available

  return (
    // Centered, SCROLLABLE paper surface (bg-bg) so the one screen never clips on
    // a short viewport and the paper ink tokens keep 4.5:1+ contrast.
    <div className="min-h-0 flex-1 overflow-y-auto bg-bg">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 px-8 py-7">
        {/* Identity — REUSE the swarm badge + title; one new framing line. */}
        <header className="text-center">
          <p className="label-cap mb-2 text-ink-faint">{t('projectPanel.swarm.badge')}</p>
          <h2 className="mb-2 text-title font-medium text-ink">{t('projectPanel.swarm.title')}</h2>
          <p className="mx-auto max-w-md text-ui leading-relaxed text-ink-subtle">
            {t('projectPanel.swarm.onboarding.intro')}
          </p>
        </header>

        {/* ── Flow diagram (the 図): request → … → done, each node a role-tinted
            chip so the sequence visually maps onto the three roles. Wraps on a
            narrow pane. ── */}
        <section>
          <p className="label-cap mb-3 text-ink-faint">{t('projectPanel.swarm.onboarding.flowHeading')}</p>
          <ol className="flex flex-wrap items-stretch gap-x-1 gap-y-2">
            {FLOW.map((step, i) => {
              const roleName = ROLE_NAME[step.role]
              return (
                <li key={step.key} className="flex items-stretch gap-1">
                  <span
                    className={`flex min-w-0 flex-col justify-center gap-0.5 rounded-[5px] border border-line-soft px-2.5 py-1.5 ${NODE_TINT[step.role]}`}
                  >
                    {roleName && (
                      <span className="flex items-center gap-1 text-plate font-medium text-ink-muted">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${NODE_DOT[step.role]}`} aria-hidden />
                        {t(roleName)}
                      </span>
                    )}
                    <span className="text-meta font-medium leading-tight text-ink">
                      {t(`projectPanel.swarm.onboarding.${step.key}`)}
                    </span>
                  </span>
                  {i < FLOW.length - 1 && (
                    <ChevronRight
                      size={13}
                      strokeWidth={2}
                      className="shrink-0 self-center text-ink-faint"
                      aria-hidden
                    />
                  )}
                </li>
              )
            })}
          </ol>
        </section>

        {/* ── Role summary (the 表): what each of the three roles does. Icons +
            REUSED role names + NEW one-line descriptions; the icon tint matches
            the flow nodes so the color ties role→step. ── */}
        <section>
          <p className="label-cap mb-3 text-ink-faint">{t('projectPanel.swarm.onboarding.rolesHeading')}</p>
          <ul className="flex flex-col gap-px overflow-hidden rounded-[5px] border border-line">
            {ROLES.map(({ key, icon: Icon, nameKey, descKey }) => (
              <li key={key} className="flex items-start gap-3 bg-bg-card px-3 py-2.5">
                <span
                  className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[4px] ${ROLE_ICON[key]}`}
                >
                  <Icon size={14} strokeWidth={2} aria-hidden />
                </span>
                <div className="min-w-0">
                  <div className="text-ui font-medium text-ink">{t(nameKey)}</div>
                  <div className="text-meta leading-snug text-ink-subtle">{t(descKey)}</div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Start: what pressing it does (条件2) + the primary CTA, which fires
            the same master-power composition as the bar above. ── */}
        <section className="flex flex-col items-center gap-3 text-center">
          <p className="mx-auto max-w-md text-meta leading-relaxed text-ink-subtle">
            {t('projectPanel.swarm.onboarding.startNote')}
          </p>
          <button
            type="button"
            onClick={() => {
              if (!disabled) onStart()
            }}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-[4px] border border-accent bg-accent px-4 py-2 text-ui font-medium text-bg-card transition-all duration-150 enabled:hover:border-accent-hover enabled:hover:bg-accent-hover enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Power size={14} strokeWidth={2.25} aria-hidden />
            {t('projectPanel.swarm.power.start')}
          </button>
          {!available && <p className="text-meta text-ink-faint">{t('projectPanel.swarm.power.offline')}</p>}
          {error && <p className="mx-auto max-w-md text-meta leading-relaxed text-accent">{error}</p>}
        </section>
      </div>
    </div>
  )
}
