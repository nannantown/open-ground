// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen } from '@testing-library/react'

// Identity translator so assertions can match on message KEYS, not copy.
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { SkillsModal } from './SkillsModal'

const noop = () => {}

const mockSkills = (skills: unknown[]) =>
  vi.fn().mockResolvedValue({ ok: true, json: async () => ({ skills }) })

describe('SkillsModal (project-only)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockSkills([]))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders nothing when closed (and does not fetch)', () => {
    const fetchSpy = mockSkills([])
    vi.stubGlobal('fetch', fetchSpy)
    const { container } = render(
      <SkillsModal open={false} path="/p" projectName="proj" onClose={noop} />,
    )
    expect(container.firstChild).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('fetches only the project endpoint and renders the skills', async () => {
    const fetchSpy = mockSkills([
      { id: 'a', name: 'Commit Helper', description: 'Write commits', file: '.claude/skills/a/SKILL.md' },
    ])
    vi.stubGlobal('fetch', fetchSpy)
    render(<SkillsModal open path="/p" projectName="proj" onClose={noop} />)
    expect(await screen.findByText('Commit Helper')).toBeTruthy()
    expect(screen.getByText('.claude/skills/a/SKILL.md')).toBeTruthy()
    // project-only: it must NOT call the global endpoint
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/api/project/skills'))).toBe(true)
    expect(urls.some((u) => u.includes('/api/skills/global'))).toBe(false)
  })

  it('shows the empty state when the project has no skills', async () => {
    vi.stubGlobal('fetch', mockSkills([]))
    render(<SkillsModal open path="/p" projectName="proj" onClose={noop} />)
    expect(await screen.findByText('projectPanel.skillsEmptyProject')).toBeTruthy()
  })

  it('shows an error when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, statusText: 'boom', json: async () => ({ error: 'boom' }) }),
    )
    render(<SkillsModal open path="/p" projectName="proj" onClose={noop} />)
    expect(await screen.findByText('projectPanel.skillsLoadFailed')).toBeTruthy()
  })

  it('Escape closes the modal', async () => {
    const onClose = vi.fn()
    render(<SkillsModal open path="/p" projectName="proj" onClose={onClose} />)
    await screen.findByText('projectPanel.skillsEmptyProject')
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
