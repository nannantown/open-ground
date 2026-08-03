// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// i18n stub: t() echoes its key, so a rendered key string proves the right
// message slot was used (groundSharedBadge / groundSharedTitle).
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))

import { ProjectCard } from './ProjectCard'
import type { ProjectMeta } from '@/lib/types'

const owned: ProjectMeta = {
  id: '1a2b3c4d',
  name: 'My Project',
  path: '/Users/me/code/my-project',
  description: '',
  lastModified: '',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
}

// A folder-less collab project shared WITH the user (the synthetic meta the
// Ground builds): no path, no git, the shared caption in the description slot.
const sharedMeta: ProjectMeta = {
  ...owned,
  name: 'Shared Alpha',
  path: '',
  hasGit: false,
  description: 'Shared with you',
}

describe('ProjectCard', () => {
  it('owned card shows the folder path and carries no Shared badge', () => {
    render(<ProjectCard project={owned} />)
    expect(screen.getByText('My Project')).toBeTruthy()
    expect(screen.getByText('/Users/me/code/my-project')).toBeTruthy()
    // The shared-only chrome must be absent on an owned card.
    expect(screen.queryByLabelText('projectPanel.groundSharedBadge')).toBeNull()
  })

  it('owned card still shows the open-task stamp (shared variant does not steal it)', () => {
    render(<ProjectCard project={{ ...owned, openTaskCount: 3 }} />)
    expect(screen.getByText('3 open')).toBeTruthy()
    expect(screen.queryByLabelText('projectPanel.groundSharedBadge')).toBeNull()
  })

  it('shared card (shared prop) wears the invite Shared badge + keeps its caption', () => {
    // Member flow: the Ground passes the synthetic meta AND shared=true, which
    // paints the invite accent and restores the Shared badge so the card is
    // distinguishable at a glance from the user's own cards.
    render(<ProjectCard project={sharedMeta} shared />)
    expect(screen.getByText('Shared Alpha')).toBeTruthy()
    // The Shared badge (invite chrome) is present — since the 0803 text-diet it
    // is a GLYPH whose word lives on the aria-label/tooltip, not visible text.
    expect(screen.getByLabelText('projectPanel.groundSharedBadge')).toBeTruthy()
    // ...and the shared caption still shows through the description slot.
    expect(screen.getByText('Shared with you')).toBeTruthy()
    // hasGit:false + openTaskCount:0 → no git/task stamp leaks in.
    expect(screen.queryByText('0 open')).toBeNull()
  })

  it('the invite chrome is driven by the shared PROP, not the meta shape', () => {
    // A shared-shaped meta rendered WITHOUT shared=true is just a local card:
    // no badge, no invite accent — proving owned cards are never altered by the
    // mere shape of their meta.
    render(<ProjectCard project={sharedMeta} />)
    expect(screen.getByText('Shared Alpha')).toBeTruthy()
    expect(screen.queryByLabelText('projectPanel.groundSharedBadge')).toBeNull()
  })
})
