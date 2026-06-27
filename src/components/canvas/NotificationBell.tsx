import { useEffect, useRef, useState } from 'react'
import { Bell } from 'lucide-react'
import { useT } from '@/i18n/I18nContext'
import { IconButton } from '@/components/canvas/IconButton'
import { NotificationPanel } from '@/components/canvas/NotificationPanel'
import type { AppNotification } from '@/lib/types'

// The Ground お知らせ BELL — an always-present toolbar control that opens a panel
// of in-app notifications. A small accent dot marks unread (badge shown ONLY when
// unreadCount > 0, so it stays 控えめ when there's nothing / signed out). Opening
// the panel is what marks the shown notifications read (onPanelOpen → App persists
// it server-side, so a re-login doesn't resurface them). Follows the same popover
// contract as the toolbar's AddMenu/AccountControl: a `relative` wrapper, close on
// outside mousedown + Esc, unmount-when-closed. The trigger reuses <IconButton>
// (shared with the toolbar) so its five interaction states match the neighbours.
export const NotificationBell = ({
  notifications,
  unreadCount,
  onOpen,
  onPanelOpen,
}: {
  notifications: AppNotification[]
  /** Count not yet read — drives the badge dot (shown only when > 0). */
  unreadCount: number
  /** A notification's primary action was activated (e.g. open the invite). */
  onOpen: (n: AppNotification) => void
  /** The panel was OPENED (closed→open edge) — mark the shown notifications read. */
  onPanelOpen: () => void
}) => {
  const { t } = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside-click (mousedown — fires before a click elsewhere commits)
  // and on Escape. Listeners attach only while open. Mirrors AddMenu exactly.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const toggle = () => {
    const next = !open
    setOpen(next)
    // Opening marks everything currently shown as read. Computed OUTSIDE the state
    // updater so React StrictMode's double-invoked updater can't fire it twice.
    if (next) onPanelOpen()
  }

  const hasUnread = unreadCount > 0
  return (
    <div ref={ref} className="relative">
      <IconButton
        onClick={toggle}
        title={
          hasUnread
            ? t('notifications.bellWithUnread', { count: unreadCount })
            : t('notifications.bell')
        }
        active={open}
        dot={hasUnread}
      >
        <Bell size={13} strokeWidth={1.75} />
      </IconButton>
      {open && (
        <NotificationPanel
          notifications={notifications}
          onAction={(n) => {
            setOpen(false)
            onOpen(n)
          }}
        />
      )}
    </div>
  )
}
