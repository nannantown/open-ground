// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

// t is the identity function in tests, so rendered text == the message KEY (and
// interpolation vars are dropped) — assertions match on keys.
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))

import { NotificationBell } from './NotificationBell'
import type { AppNotification } from '@/lib/types'

const invite = (
  id: string,
  label: string | null,
  inviter: string | null,
): AppNotification => ({
  id: `collab-invite:${id}`,
  kind: 'collab-invite',
  collabInvite: { collabProjectId: id, label, inviterEmail: inviter },
})

afterEach(() => vi.restoreAllMocks())

describe('NotificationBell (Ground お知らせ)', () => {
  it('shows the unread dot ONLY when unreadCount > 0', () => {
    const { container, rerender } = render(
      <NotificationBell notifications={[]} unreadCount={0} onOpen={() => {}} onPanelOpen={() => {}} />,
    )
    expect(container.querySelector('.rounded-full.bg-accent')).toBeNull()
    rerender(
      <NotificationBell
        notifications={[invite('a', 'X', 'b@x')]}
        unreadCount={1}
        onOpen={() => {}}
        onPanelOpen={() => {}}
      />,
    )
    expect(container.querySelector('.rounded-full.bg-accent')).not.toBeNull()
  })

  it('opening the panel fires onPanelOpen ONCE (mark read) and lists the invite', () => {
    const onPanelOpen = vi.fn()
    render(
      <NotificationBell
        notifications={[invite('a', 'Design', 'boss@x')]}
        unreadCount={1}
        onOpen={() => {}}
        onPanelOpen={onPanelOpen}
      />,
    )
    // Panel is closed until the bell is clicked.
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'notifications.bellWithUnread' }))
    expect(onPanelOpen).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('notifications.collabInvite')).toBeTruthy()
  })

  it('clicking the invite action calls onOpen(notification) and closes the panel', () => {
    const onOpen = vi.fn()
    const n = invite('proj-1', 'Design', 'boss@x')
    render(
      <NotificationBell notifications={[n]} unreadCount={1} onOpen={onOpen} onPanelOpen={() => {}} />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'notifications.bellWithUnread' }))
    fireEvent.click(screen.getByText('notifications.join'))
    expect(onOpen).toHaveBeenCalledWith(n)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows the empty state with no notifications, and no badge', () => {
    const { container } = render(
      <NotificationBell notifications={[]} unreadCount={0} onOpen={() => {}} onPanelOpen={() => {}} />,
    )
    expect(container.querySelector('.rounded-full.bg-accent')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'notifications.bell' }))
    expect(screen.getByText('notifications.empty')).toBeTruthy()
  })

  it('closes the panel on Escape', () => {
    render(
      <NotificationBell
        notifications={[invite('a', 'Design', 'boss@x')]}
        unreadCount={1}
        onOpen={() => {}}
        onPanelOpen={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'notifications.bellWithUnread' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
