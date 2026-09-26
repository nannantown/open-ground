// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))

import { ProjectJumpPalette } from './ProjectJumpPalette'
import type { ProjectMeta } from '@/lib/types'

// jsdom has no layout, so no scrollIntoView (the palette keeps the active row in view).
Element.prototype.scrollIntoView = () => {}

const meta = (id: string, name: string, description = ''): ProjectMeta => ({
  id,
  name,
  path: `/p/${id}`,
  description,
  lastModified: '',
  hasGit: false,
  openTaskCount: 0,
  totalTaskCount: 0,
})

const projects = [meta('a', 'alpha'), meta('b', 'beta', '家庭菜園の記録')]

describe('ProjectJumpPalette', () => {
  it('shows each row’s running / question / review mark', () => {
    render(
      <ProjectJumpPalette
        open
        projects={projects}
        onClose={() => {}}
        onPick={() => {}}
        lamps={new Map([['a', 'working'], ['b', 'question']])}
      />,
    )
    expect(screen.getByText('toolbar.searchLampWorking')).toBeTruthy()
    // An icon, not a word (owner 2026-09-26) — its name lives in the label.
    expect(screen.getByRole('img', { name: 'toolbar.searchLampQuestion' })).toBeTruthy()
    expect(screen.queryByText('toolbar.searchLampQuestion', { ignore: 'title' })).toBeNull()
  })

  it('a delivered-unseen row carries the eye, not the hand', () => {
    render(
      <ProjectJumpPalette
        open
        projects={projects}
        onClose={() => {}}
        onPick={() => {}}
        lamps={new Map([['a', 'review']])}
      />,
    )
    expect(screen.getByRole('img', { name: 'toolbar.searchLampReview' })).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'toolbar.searchLampQuestion' })).toBeNull()
  })

  it('picks a description match on Enter, but not while an IME is composing', () => {
    const onPick = vi.fn()
    render(<ProjectJumpPalette open projects={projects} onClose={() => {}} onPick={onPick} />)
    const input = screen.getByPlaceholderText('toolbar.searchPlaceholder')
    fireEvent.change(input, { target: { value: '菜園' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(onPick).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(projects[1])
  })
})
