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

// The Persona surface is owner-wide (its data lives in ~/.openground/ and is
// identical on every project), so it is addressed from Ground rather than from
// the per-project tab row. It is owner-only and hidden by default: App passes
// onOpenPersona ONLY when the persona-or-swarm gate is open, so the absence of
// the handler is the whole gate at this layer — the public build must not draw
// the button at all, not draw it and refuse.
describe('Toolbar — Ground Persona entry', () => {
  it('hides the entry when the gate is closed (onOpenPersona omitted)', () => {
    render(<Toolbar {...base} />)
    expect(screen.queryByTitle('toolbar.personaTooltip')).toBeNull()
    expect(screen.queryByRole('button', { name: 'toolbar.persona' })).toBeNull()
  })

  it('shows the entry when the gate is open (onOpenPersona provided)', () => {
    render(<Toolbar {...base} onOpenPersona={() => {}} />)
    expect(screen.getByTitle('toolbar.personaTooltip')).toBeTruthy()
    // Named by its VISIBLE label, so the accessible name contains it (WCAG 2.5.3).
    expect(screen.getByRole('button', { name: 'toolbar.persona' })).toBeTruthy()
  })

  it('invokes onOpenPersona when clicked (opens the Ground panel)', () => {
    const onOpenPersona = vi.fn()
    render(<Toolbar {...base} onOpenPersona={onOpenPersona} />)
    fireEvent.click(screen.getByTitle('toolbar.personaTooltip'))
    expect(onOpenPersona).toHaveBeenCalledTimes(1)
  })
})
