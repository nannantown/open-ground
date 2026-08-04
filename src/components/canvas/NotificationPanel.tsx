import { UserPlus, AlertTriangle, Inbox } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { Btn } from '@/components/ui/Btn'
import type { AppNotification } from '@/lib/types'

// The dropdown panel that lists in-app notifications (Ground お知らせ), anchored
// under the bell. PURELY PRESENTATIONAL: it renders a kind-specific row + action
// for each notification, plus an empty state, and reports an action click upward.
// Open/close + read-state persistence live in NotificationBell / App. Styled on
// SEMANTIC tokens only (theme-agnostic: works in the paper light theme and any
// future dark theme); the action uses the design-system <Btn> so its five
// interaction states (hover/active/disabled/focus/default) come for free.
export const NotificationPanel = ({
  notifications,
  onAction,
}: {
  notifications: AppNotification[]
  /** The user activated a notification's primary action (e.g. open the invite). */
  onAction: (n: AppNotification) => void
}) => {
  const { t } = useT()
  return (
    <div
      role="dialog"
      aria-label={t('notifications.title')}
      className="absolute right-0 top-full z-20 mt-1.5 w-[340px] max-w-[92vw] overflow-hidden rounded-[3px] border border-line bg-bg-card shadow-card-hover"
    >
      <div className="border-b border-line-soft px-3.5 py-2.5">
        <span className="font-display text-ui leading-none text-ink">
          {t('notifications.title')}
        </span>
      </div>
      {notifications.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-ui leading-relaxed text-ink-faint">
          {t('notifications.empty')}
        </p>
      ) : (
        <ul className="max-h-[60vh] overflow-y-auto py-1">
          {notifications.map((n) => (
            <li key={n.id}>
              <NotificationRow n={n} onAction={onAction} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// One notification row. Switches on `kind` ('collab-invite' | 'swarm-fatal').
// Returns null for an unknown kind so a forward-compat payload can never crash the
// panel.
const NotificationRow = ({
  n,
  onAction,
}: {
  n: AppNotification
  onAction: (n: AppNotification) => void
}) => {
  const { t } = useT()

  // Fatal swarm event (escalation safety valve) — informational: WHAT happened, the
  // card/branch it concerns, and the engine-log 導線. No primary action (the OS toast
  // already woke the user; the row is the durable record); rendered with the alert
  // accent + a distinct icon so it never reads as a routine invite.
  if (n.kind === 'swarm-fatal' && n.swarmFatal) {
    const f = n.swarmFatal
    const ctx = [f.taskTitle ? `「${f.taskTitle}」` : '', f.branch].filter(Boolean).join(' · ')
    return (
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <AlertTriangle size={13} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-ui leading-relaxed text-ink">{f.detail}</p>
          {ctx && (
            <p className="mt-0.5 break-words font-mono text-meta leading-relaxed text-ink-faint">
              {ctx}
            </p>
          )}
          {f.logHint && (
            <p className="mt-1 break-words text-meta leading-relaxed text-ink-faint">{f.logHint}</p>
          )}
        </div>
      </div>
    )
  }

  // Info-grade swarm event (the overseer/escalation lane, C1) — same durable-
  // record role as swarm-fatal, calmer presentation (ink icon, not the alert
  // accent): nothing broke, a question is waiting. The Escalations inbox panel
  // in the project's Swarm tab is where the answer happens; this row is the
  // machine-wide "something is waiting" pointer.
  if (n.kind === 'swarm-info' && n.swarmInfo) {
    const i = n.swarmInfo
    const ctx = [i.taskTitle ? `「${i.taskTitle}」` : '', i.branch].filter(Boolean).join(' · ')
    return (
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-inset text-ink-muted">
          <Inbox size={13} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-ui leading-relaxed text-ink">{i.detail}</p>
          {ctx && (
            <p className="mt-0.5 break-words font-mono text-meta leading-relaxed text-ink-faint">
              {ctx}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (n.kind === 'collab-invite' && n.collabInvite) {
    const inviter = n.collabInvite.inviterEmail || t('notifications.someone')
    const project = n.collabInvite.label
    // With a known project name we say "X invited you to “Project”"; without it,
    // a name-less variant (the owner hasn't set a shared name yet).
    const text = project
      ? t('notifications.collabInvite', { inviter, project })
      : t('notifications.collabInviteNoName', { inviter })
    return (
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <UserPlus size={13} strokeWidth={1.75} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words text-ui leading-relaxed text-ink">{text}</p>
          <Btn
            variant="primary"
            size="xs"
            className="mt-1.5"
            onClick={() => onAction(n)}
          >
            {t('notifications.join')}
          </Btn>
        </div>
      </div>
    )
  }

  return null
}
