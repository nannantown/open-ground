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

describe('ProjectCard', () => {
  it('owned card shows the folder path and carries no Shared badge', () => {
    render(<ProjectCard project={owned} />)
    expect(screen.getByText('My Project')).toBeTruthy()
    expect(screen.getByText('/Users/me/code/my-project')).toBeTruthy()
    // The shared-only chrome must be absent on an owned card.
    expect(screen.queryByText('projectPanel.groundSharedBadge')).toBeNull()
    expect(screen.queryByText('projectPanel.groundSharedTitle')).toBeNull()
  })

  it('owned card still shows the open-task stamp (shared variant does not steal it)', () => {
    render(<ProjectCard project={{ ...owned, openTaskCount: 3 }} />)
    expect(screen.getByText('3 open')).toBeTruthy()
    expect(screen.queryByText('projectPanel.groundSharedBadge')).toBeNull()
  })

  it('shared card shows the Shared badge + "shared with you" caption and hides the folder path', () => {
    // Member flow: only id + name (the label) are real; the other fields are the
    // synthetic placeholders the Ground passes and the shared variant ignores.
    const sharedMeta: ProjectMeta = { ...owned, name: 'Shared Alpha', path: '', hasGit: false }
    render(<ProjectCard project={sharedMeta} shared />)
    expect(screen.getByText('Shared Alpha')).toBeTruthy()
    expect(screen.getByText('projectPanel.groundSharedBadge')).toBeTruthy()
    // The body caption (also reused as the card's title tooltip).
    expect(screen.getByText('projectPanel.groundSharedTitle')).toBeTruthy()
    // A shared card never leaks the (empty) synthetic path or an owner-only stamp.
    expect(screen.queryByText('0 open')).toBeNull()
  })
})
