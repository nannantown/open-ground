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
  it('shows each row’s running / your-turn lamp', () => {
    render(
      <ProjectJumpPalette
        open
        projects={projects}
        onClose={() => {}}
        onPick={() => {}}
        lamps={new Map([['a', 'working'], ['b', 'waiting']])}
      />,
    )
    expect(screen.getByText('toolbar.searchLampWorking')).toBeTruthy()
    expect(screen.getByText('toolbar.searchLampWaiting')).toBeTruthy()
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
