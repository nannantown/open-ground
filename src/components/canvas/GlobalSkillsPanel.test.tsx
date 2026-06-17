// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { GlobalSkillsPanel } from './GlobalSkillsPanel'

const noop = () => {}

// Stateful fetch mock: GET /api/skills/global returns `skills`; POST
// /api/skills/global/create appends a skill (or fails per opts) so the panel's
// post-create re-fetch reflects it.
let skills: Array<Record<string, string>>
const makeFetch = (opts: { createFails?: 'claudeMissing' | 'error' } = {}) =>
  vi.fn((url: string, init?: { method?: string }) => {
    if (url.includes('/api/skills/global/create')) {
      if (opts.createFails === 'claudeMissing') {
        return Promise.resolve({
          ok: false,
          status: 503,
          statusText: 'x',
          json: async () => ({ error: 'no claude', claudeMissing: true }),
        })
      }
      if (opts.createFails === 'error') {
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'boom',
          json: async () => ({ error: 'boom' }),
        })
      }
      const skill = {
        id: 'new-skill',
        name: 'New Skill',
        description: 'freshly made',
        file: '~/.claude/skills/new-skill/SKILL.md',
      }
      skills = [...skills, skill]
      return Promise.resolve({ ok: true, json: async () => ({ skill }) })
    }
    // GET list
    void init
    return Promise.resolve({ ok: true, json: async () => ({ skills }) })
  })

describe('GlobalSkillsPanel', () => {
  beforeEach(() => {
    skills = []
    vi.stubGlobal('fetch', makeFetch())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders nothing when closed (and does not fetch)', () => {
    const fetchSpy = makeFetch()
    vi.stubGlobal('fetch', fetchSpy)
    const { container } = render(<GlobalSkillsPanel open={false} onClose={noop} />)
    expect(container.firstChild).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('lists the global skills on open', async () => {
    skills = [
      { id: 'a', name: 'Agent Pipeline', description: 'orchestrate', file: '~/.claude/skills/a/SKILL.md' },
    ]
    vi.stubGlobal('fetch', makeFetch())
    render(<GlobalSkillsPanel open onClose={noop} />)
    expect(await screen.findByText('Agent Pipeline')).toBeTruthy()
    expect(screen.getByText('~/.claude/skills/a/SKILL.md')).toBeTruthy()
  })

  it('creates a skill from the form and shows it after the run', async () => {
    render(<GlobalSkillsPanel open onClose={noop} />)
    // empty state first
    expect(await screen.findByText('projectPanel.skillsEmptyGlobal')).toBeTruthy()

    const textarea = screen.getByPlaceholderText('projectPanel.skillsCreatePlaceholder')
    fireEvent.change(textarea, { target: { value: 'a skill that makes PDFs' } })
    fireEvent.click(screen.getByRole('button', { name: 'projectPanel.skillsCreateButton' }))

    // After the (mocked) run + re-fetch, the new skill appears.
    expect(await screen.findByText('New Skill')).toBeTruthy()
    // the request field is cleared
    expect((textarea as HTMLTextAreaElement).value).toBe('')
  })

  it('surfaces the claude-missing error (503) without crashing', async () => {
    vi.stubGlobal('fetch', makeFetch({ createFails: 'claudeMissing' }))
    render(<GlobalSkillsPanel open onClose={noop} />)
    await screen.findByText('projectPanel.skillsEmptyGlobal')
    fireEvent.change(screen.getByPlaceholderText('projectPanel.skillsCreatePlaceholder'), {
      target: { value: 'x' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'projectPanel.skillsCreateButton' }))
    await waitFor(() =>
      expect(screen.getByText('projectPanel.skillsClaudeMissing')).toBeTruthy(),
    )
  })
})
