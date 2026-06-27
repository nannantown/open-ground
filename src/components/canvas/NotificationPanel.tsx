import { UserPlus } from 'lucide-react'
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
        <span className="font-display text-[13px] leading-none text-ink">
          {t('notifications.title')}
        </span>
      </div>
      {notifications.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-ink-faint">
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

// One notification row. Switches on `kind` — today only 'collab-invite'. Returns
// null for an unknown kind so a forward-compat payload can never crash the panel.
const NotificationRow = ({
  n,
  onAction,
}: {
  n: AppNotification
  onAction: (n: AppNotification) => void
}) => {
  const { t } = useT()

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
          <p className="break-words text-[12px] leading-relaxed text-ink">{text}</p>
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
