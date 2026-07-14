// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import type { PresencePeer } from '@/lib/types'

vi.mock('@/lib/auth/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'alice@example.com', provider: 'google' } }),
}))

import { CollabPresence, usePublishPresence, type PresenceChannel } from './CollabPresence'

// A controllable presence channel: setPresence is a spy; onPresence captures the
// callback so a test can emit peer sets, and fires once with [] like the real one.
const makeChannel = () => {
  let cb: ((peers: PresencePeer[]) => void) | null = null
  const channel: PresenceChannel = {
    setPresence: vi.fn(),
    onPresence: vi.fn((c) => {
      cb = c
      c([])
      return () => {
        cb = null
      }
    }),
  }
  return { channel, emit: (peers: PresencePeer[]) => act(() => cb?.(peers)) }
}

afterEach(() => vi.clearAllMocks())

describe('CollabPresence (u15 awareness avatars)', () => {
  it('renders nothing with no channel, or a channel but no peers', () => {
    const { container } = render(<CollabPresence channel={null} />)
    expect(container.firstChild).toBeNull()

    const { channel } = makeChannel()
    const { container: c2 } = render(<CollabPresence channel={channel} />)
    expect(c2.firstChild).toBeNull() // bound but alone → nothing
  })

  it('publishes the local identity (name local-part + full email + color) and renders peers', () => {
    const { channel, emit } = makeChannel()
    render(<CollabPresence channel={channel} />)
    // Published our presence: the email local-part as the compact name, PLUS the
    // full email so a peer's tooltip can show the complete address.
    expect(channel.setPresence).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'alice',
        email: 'alice@example.com',
        color: expect.stringContaining('hsl'),
      }),
    )
    // A peer arrives → an avatar with their initials + the "N others here" label.
    emit([{ clientId: 2, name: 'bob', color: '#ff0000' }])
    expect(screen.getByText('BO')).toBeTruthy()
    expect(screen.getByLabelText(/1 other/)).toBeTruthy()
  })

  it('avatar tooltip shows the full email, falling back to name for older peers', () => {
    const { channel, emit } = makeChannel()
    render(<CollabPresence channel={channel} />)
    emit([
      { clientId: 2, name: 'op', color: '#ff0000', email: 'op@example.org' },
      { clientId: 3, name: 'bob', color: '#00ff00' }, // older peer: no email field
    ])
    // The peer that published an email → its avatar tooltip is the FULL address.
    expect(screen.getByText('OP').getAttribute('title')).toBe('op@example.org')
    // The peer with no email → tooltip falls back to the name (unchanged behaviour).
    expect(screen.getByText('BO').getAttribute('title')).toBe('bob')
    // The initials themselves are unchanged (still derived from the name).
    expect(screen.getByText('OP')).toBeTruthy()
  })

  it('caps avatars at 5 and shows a +N overflow', () => {
    const { channel, emit } = makeChannel()
    render(<CollabPresence channel={channel} />)
    emit(
      Array.from({ length: 7 }, (_, i) => ({ clientId: i + 2, name: `u${i}`, color: '#123456' })),
    )
    expect(screen.getByText('+2')).toBeTruthy()
  })

  it('usePublishPresence publishes on mount and clears on unmount (owner surfaces)', () => {
    const { channel } = makeChannel()
    const Probe = () => {
      usePublishPresence(channel)
      return null
    }
    const { unmount } = render(<Probe />)
    expect(channel.setPresence).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'alice' }),
    )
    unmount()
    expect(channel.setPresence).toHaveBeenLastCalledWith(null)
  })

  it('publish={false} is display-only: shows peers but never publishes', () => {
    const { channel, emit } = makeChannel()
    render(<CollabPresence channel={channel} publish={false} />)
    // Display-only mount must NOT touch the shared local state (another surface
    // owns publishing — a second publisher's unmount would clear it).
    expect(channel.setPresence).not.toHaveBeenCalled()
    emit([{ clientId: 2, name: 'bob', color: '#ff0000' }])
    expect(screen.getByText('BO')).toBeTruthy()
  })
})
