// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))
vi.mock('@/lib/auth/AuthContext', () => ({
  useAuth: () => ({ user: null, status: 'signed-out', signOut: () => {} }),
}))

import { Toolbar } from './Toolbar'

const base = {
  onNewProject: () => {},
  onImport: () => {},
  onOpenSettings: () => {},
  onOpenManual: () => {},
  onOpenSkills: () => {},
  projectCount: 0,
}

// Card 6067c41e: the member's entry to the INITIAL join. The "Shared with me"
// toolbar entry is gated on collab being enabled (the parent passes onOpenShared
// only then), so the default (collab-off) build shows nothing.
describe('Toolbar — member "Shared with me" entry (card 6067c41e)', () => {
  it('hides the join entry when collab is off (onOpenShared omitted)', () => {
    render(<Toolbar {...base} />)
    expect(screen.queryByTitle('toolbar.sharedWithMe')).toBeNull()
  })

  it('shows the join entry when collab is enabled (onOpenShared provided)', () => {
    render(<Toolbar {...base} onOpenShared={() => {}} />)
    expect(screen.getByTitle('toolbar.sharedWithMe')).toBeTruthy()
  })

  it('invokes onOpenShared when clicked (opens the join dialog)', () => {
    const onOpenShared = vi.fn()
    render(<Toolbar {...base} onOpenShared={onOpenShared} />)
    fireEvent.click(screen.getByTitle('toolbar.sharedWithMe'))
    expect(onOpenShared).toHaveBeenCalledTimes(1)
  })
})
