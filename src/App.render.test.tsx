// @vitest-environment jsdom
//
// App.tsx WHOLE-RENDER integration test — the long-standing "full-render gap"
// (App.collab.test.tsx covers only the two pure helpers, noting "App pulls in
// the entire canvas tree — a known full-render gap"). This mounts the REAL App
// inside its production provider tree (main.tsx order: I18n → Auth → Realtime)
// with the network stubbed, so we exercise:
//   * the mount path actually renders without throwing (the fragile part),
//   * the first-run empty state vs the populated Ground (one Ground card per
//     registered project — proves load() → /api/projects wiring reaches the UI),
//   * the global "Claude is designing" beacon driven by /api/canvas/ai/active.
//
// fetch is stubbed (both raw fetch('/api/…') AND the hc `api.*` client funnel
// through global fetch); ResizeObserver is stubbed because InfiniteCanvas
// observes its viewport. No claude, no real network, HOME already isolated by
// the suite-wide setup-home.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent, waitFor, within } from '@testing-library/react'
import App from './App'
import { I18nProvider } from '@/i18n/I18nContext'
import { AuthProvider } from '@/lib/auth/AuthContext'
import { RealtimeProvider } from '@/lib/collab/RealtimeContext'
import type { GroundLampRow, ProjectMeta, ProjectData } from '@/lib/types'
import { projectPanel } from '@/i18n/messages/projectPanel'

/** The Ground card marks are icons; their names are the hover text (en). */
const QUESTION_MARK = projectPanel.en['projectPanel.groundMarkQuestion']
const REVIEW_MARK = projectPanel.en['projectPanel.groundMarkReview']
const RUNNING_MARK = projectPanel.en['projectPanel.groundMarkWorking']
const UNKNOWN_MARK = projectPanel.en['projectPanel.groundMarkUnknown']

// InfiniteCanvas observes its viewport with a ResizeObserver — absent in jsdom.
class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// Minimal but SHAPE-CORRECT payloads. /api/projects carries the whole Ground
// bootstrap ({ settings, projects, canvas }) — load() reads data.canvas.positions
// + data.settings, so those must exist or autoLayout/setSettings throw.
const SETTINGS = { projectsRoot: null, archiveDirName: '', excludePatterns: [] }
const EMPTY_CANVAS = { positions: {}, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] }

const projectMeta = (over: Partial<ProjectMeta> = {}): ProjectMeta => ({
  id: 'id',
  name: 'Project',
  path: '/tmp/project',
  description: '',
  lastModified: '2020-01-01T00:00:00Z',
  hasGit: false,
  openTaskCount: 0,
  totalTaskCount: 0,
  ...over,
})

const reply = (status: number, body: unknown) =>
  Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response)

const urlOf = (input: unknown): string =>
  typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : ((input as Request)?.url ?? '')

interface MockOpts {
  projects?: ProjectMeta[]
  projectData?: ProjectData
  feedbackEnabled?: boolean
  aiActiveJobs?: number
  /** Non-2xx status for POST /api/settings, to exercise the save-failure path. */
  settingsPostStatus?: number
  settingsPostError?: string
  /** GET /api/experiments — the owner-only gate, resolved SERVER-side. Omitted ⇒
   *  the shipped/non-owner answer (nothing eligible, every flag closed). */
  experiments?: { eligible: boolean; flags: Record<string, boolean> }
  /** GET /api/ground/lamps — what each card's lamp is decided from. Omitted ⇒
   *  no rows, i.e. every card dark, which is the resting state. */
  lamps?: GroundLampRow[]
}

const methodOf = (input: unknown, init?: RequestInit): string =>
  init?.method ?? (input instanceof Request ? input.method : 'GET')

function installFetch(opts: MockOpts = {}) {
  const projects = opts.projects ?? []
  const jobs = Array.from({ length: opts.aiActiveJobs ?? 0 }, (_, i) => ({ id: `job-${i}` }))
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = urlOf(input)
    if (url.includes('/api/settings') && methodOf(input, init) === 'POST') {
      const status = opts.settingsPostStatus ?? 200
      return reply(status, status >= 300 ? { error: opts.settingsPostError ?? 'save failed' } : { ok: true })
    }
    if (url.includes('/api/settings')) return reply(200, { ...SETTINGS, suggestedDisplayName: null })
    if (url.includes('/api/projects'))
      return reply(200, { settings: SETTINGS, projects, canvas: EMPTY_CANVAS })
    if (url.includes('/api/project?') && opts.projectData) return reply(200, opts.projectData)
    if (url.includes('/api/feedback/config')) return reply(200, { enabled: !!opts.feedbackEnabled })
    if (url.includes('/api/experiments'))
      return reply(
        200,
        opts.experiments ?? {
          eligible: false,
          flags: { swarm: false, sandbox: false, persona: false },
        },
      )
    if (url.includes('/api/canvas/ai/active')) return reply(200, { jobs })
    if (url.includes('/api/terminal/active')) return reply(200, { cwds: [], claude: [] })
    if (url.includes('/api/ground/lamps')) return reply(200, { lamps: opts.lamps ?? [] })
    if (url.includes('/api/auth/session')) return reply(503, {}) // signed-out (default build)
    if (url.includes('/api/collab/config')) return reply(200, { enabled: false })
    // Everything else (feedback/config, notifications,
    // auth/config, usage, …) reads optionally — an empty object collapses to
    // the default (disabled) build, which is what we render here.
    return reply(200, {})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const renderApp = () =>
  render(
    <I18nProvider>
      <AuthProvider>
        <RealtimeProvider>
          <App />
        </RealtimeProvider>
      </AuthProvider>
    </I18nProvider>,
  )

beforeEach(() => {
  // Deterministic UI language (the empty-state copy asserted below is English).
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ROStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App — whole-render integration', () => {
  it('keeps the generated language pair visible on Ground after a project refresh', async () => {
    vi.useFakeTimers()
    try {
      const summary = 'A retained bilingual project description'
      const opts: MockOpts = {
        projects: [projectMeta({ description: summary })],
        projectData: { description: '', descriptionEn: summary, tasks: [], notes: '', updatedAt: '2026-09-21T00:00:00.000Z' },
      }
      installFetch(opts)
      localStorage.setItem('openground:onboarded', '1')
      localStorage.setItem('openground.view', JSON.stringify({ projectId: 'id', panelTab: 'board' }))
      await act(async () => { renderApp() })
      fireEvent.click(screen.getByRole('button', { name: 'Project details' }))
      expect(screen.getAllByText(summary)).toHaveLength(2)
      opts.projectData = { ...opts.projectData!, notes: 'External edit', updatedAt: '2026-09-21T00:00:01.000Z' }
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(screen.getAllByText(summary)).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('keeps feedback on Ground without duplicating its entry in Settings', async () => {
    installFetch({ feedbackEnabled: true })
    localStorage.setItem('openground:onboarded', '1')
    await act(async () => { renderApp() })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByRole('button', { name: 'Send feedback' })).toBeNull()
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('button', { name: 'Feedback' }))
    expect(screen.getByRole('dialog', { name: 'Send feedback' })).toBeTruthy()
  })
  it('lets the owner preview public surfaces without saving settings or changing their role', async () => {
    const fetchMock = installFetch({ experiments: { eligible: true, flags: { swarm: true, sandbox: true } } })
    localStorage.setItem('openground:onboarded', '1')
    await act(async () => { renderApp() })
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy()
    const writes = () => fetchMock.mock.calls.filter(([input, init]) => methodOf(input, init) !== 'GET')
    const before = writes().length
    const settingsSwitch = () => within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('group', { name: 'Show as a public user sees it' })
    expect(screen.queryByRole('button', { name: 'Public view' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(within(settingsSwitch()).getByRole('button', { name: 'On' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByText('WordPress', { exact: true })).toBeNull()
    expect(writes()).toHaveLength(before)
    // The way back must stay reachable while the public view is on.
    fireEvent.click(within(settingsSwitch()).getByRole('button', { name: 'Off' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy()
    expect(writes()).toHaveLength(before)
  })

  it('never exposes the preview switch or global skills to a public user', async () => {
    installFetch()
    await act(async () => { renderApp() })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByRole('group', { name: 'Show as a public user sees it' })).toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Public view' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull()
  })
  it('mounts the full provider tree and shows the first-run empty state when no projects exist', async () => {
    installFetch({ projects: [] })
    await act(async () => {
      renderApp()
    })
    // misc.empty.title (en) — the first-run overlay headline.
    expect(await screen.findByText('Begin your atlas.')).toBeInTheDocument()
  })

  it('renders one Ground card per registered project and drops the empty state', async () => {
    // Distinctive, collision-proof names — a generic name like "Beta" would
    // also match the Toolbar's "Beta" feature badge and yield false multiples.
    installFetch({
      projects: [
        projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' }),
        projectMeta({ id: 'b', name: 'Cartographers Guild', path: '/b' }),
      ],
    })
    await act(async () => {
      renderApp()
    })
    // Cards are driven by load() → /api/projects → setProjects → InfiniteCanvas.
    // Finding both names proves the hc fetch funnel reached the UI.
    expect(await screen.findByText('Northwind Atlas')).toBeInTheDocument()
    expect(screen.getByText('Cartographers Guild')).toBeInTheDocument()
    // The empty-state overlay must be gone once the Ground has owned cards.
    expect(screen.queryByText('Begin your atlas.')).not.toBeInTheDocument()
  })

  // ── the Ground card lamp ─────────────────────────────────────────────────
  //
  // THE BUG THIS REPLACED, twice reported: every card read WAITING with every
  // task done, because the lamp was the collapsed list of live `claude` panes
  // and every project running a swarm holds a commander and a supply desk at
  // their prompts. The lamp is now about the WORK — /api/ground/lamps sends the
  // facts, the pure groundLamp() decides — and these assert the two ends of that
  // wire on the REAL card, not on the helper.
  it('shows nothing at all on a project whose cards are all done', async () => {
    // 「作業が終わってて何も出さない時にuserは見にいくんですよ」 — silence is the
    // signal, and a live process must not be able to break it.
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', started: 0, inFlight: 0, openQuestions: 0, liveWork: true }],
    })
    await act(async () => {
      renderApp()
    })
    await screen.findByText('Northwind Atlas')
    await waitFor(() =>
      expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0),
    )
    expect(screen.queryByLabelText(QUESTION_MARK)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(RUNNING_MARK)).not.toBeInTheDocument()
    // …and it is SILENT, not "No data" — the board was read, and it said done.
    expect(screen.queryByLabelText(UNKNOWN_MARK)).not.toBeInTheDocument()
  })

  it('says Running while a card is in flight — even with nothing generating (2026-09-26)', async () => {
    // A card in review / being handed over has no claude mid-turn, and the
    // card must not go dark then: 「全部終わるまでずっとこの表示」.
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', started: 1, inFlight: 1, openQuestions: 0, liveWork: false }],
    })
    await act(async () => {
      renderApp()
    })
    expect(await screen.findByLabelText(RUNNING_MARK)).toBeInTheDocument()
    expect(screen.queryByLabelText(QUESTION_MARK)).not.toBeInTheDocument()
  })

  it('stays SILENT on parked (blocked-only) work — waiting is only ever a question (2026-08-18)', async () => {
    // The owner's amendment: 「waitingは僕が何かをしないといけない時にだけ出しま
    // しょう」. Parked cards are the machine's problem; the card goes amber only
    // for an unanswered question (the case below).
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', started: 1, inFlight: 0, openQuestions: 0, liveWork: false }],
    })
    await act(async () => {
      renderApp()
    })
    await screen.findByText('Northwind Atlas')
    expect(screen.queryByLabelText(QUESTION_MARK)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(RUNNING_MARK)).not.toBeInTheDocument()
  })

  it('raises the QUESTION mark for an open question even while the swarm runs', async () => {
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', started: 2, inFlight: 2, openQuestions: 1, liveWork: true }],
    })
    await act(async () => {
      renderApp()
    })
    expect(await screen.findByLabelText(QUESTION_MARK)).toBeInTheDocument()
    expect(screen.queryByLabelText(RUNNING_MARK)).not.toBeInTheDocument()
  })

  // ── question / review marks (owner decision 2026-09-26) ──────────────────
  // Icons with hover text, never a label or an emoji. The timed marks compare
  // against seenAt (the last look at the president's seat).
  const T0 = Date.parse('2026-09-26T00:00:00Z')
  const markCase = async (row: Partial<GroundLampRow>) => {
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', started: 0, inFlight: 0, openQuestions: 0, liveWork: false, ...row }],
    })
    await act(async () => {
      renderApp()
    })
    await screen.findByText('Northwind Atlas')
  }

  it('the president ending on a question you have not seen ⇒ the QUESTION mark', async () => {
    await markCase({ presidentAskedAt: T0 + 60_000, seenAt: T0 })
    expect(await screen.findByLabelText(QUESTION_MARK)).toBeInTheDocument()
    expect(screen.queryByLabelText(REVIEW_MARK)).not.toBeInTheDocument()
  })

  it('delivered after your last look ⇒ the REVIEW mark (an eye), not the question', async () => {
    await markCase({ deliveredAt: T0 + 60_000, seenAt: T0 })
    expect(await screen.findByLabelText(REVIEW_MARK)).toBeInTheDocument()
    expect(screen.queryByLabelText(QUESTION_MARK)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(RUNNING_MARK)).not.toBeInTheDocument()
  })

  it('opening the project (openedAt) clears the eye', async () => {
    // Card b (same delivery, never opened) proves the lamps were APPLIED: its
    // eye is on screen, and the opened card a must have none.
    const row = { started: 0, inFlight: 0, openQuestions: 0, liveWork: false, deliveredAt: T0 + 60_000, seenAt: T0 }
    installFetch({
      projects: [
        projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' }),
        projectMeta({ id: 'b', name: 'Harbor Ledger', path: '/b' }),
      ],
      lamps: [
        { projectId: 'a', ...row, openedAt: T0 + 120_000 },
        { projectId: 'b', ...row },
      ],
    })
    await act(async () => {
      renderApp()
    })
    await screen.findByLabelText(REVIEW_MARK)
    expect(screen.getAllByLabelText(REVIEW_MARK)).toHaveLength(1)
  })

  it('both at once ⇒ the QUESTION mark wins', async () => {
    await markCase({ presidentAskedAt: T0 + 60_000, deliveredAt: T0 + 90_000, seenAt: T0 })
    expect(await screen.findByLabelText(QUESTION_MARK)).toBeInTheDocument()
    expect(screen.queryByLabelText(REVIEW_MARK)).not.toBeInTheDocument()
  })

  it('once you have looked (seenAt after both) ⇒ nothing at all', async () => {
    // A second card with an open question is the proof the lamps response was
    // APPLIED (waiting for the fetch call alone passed before any mark could
    // render). Once its mark is on screen, the looked-at card must have none.
    installFetch({
      projects: [
        projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' }),
        projectMeta({ id: 'b', name: 'Harbor Ledger', path: '/b' }),
      ],
      lamps: [
        { projectId: 'a', started: 0, inFlight: 0, openQuestions: 0, liveWork: false, presidentAskedAt: T0, deliveredAt: T0, seenAt: T0 + 60_000 },
        { projectId: 'b', started: 0, inFlight: 0, openQuestions: 1, liveWork: false },
      ],
    })
    await act(async () => {
      renderApp()
    })
    await screen.findByLabelText(QUESTION_MARK)
    expect(screen.getAllByLabelText(QUESTION_MARK)).toHaveLength(1)
    expect(screen.queryByLabelText(REVIEW_MARK)).not.toBeInTheDocument()
  })

  it('says NO DATA — not silence — over a board it could not read', async () => {
    // ⚠ THE SUBTLE ONE. `started` absent is not 0, and here the difference is
    // not a number on screen: SILENCE IS THE FINISHED STATE on this card. So a
    // corrupt tasks.json rendering as a blank card would tell the owner their
    // project is done, using a file nobody managed to open. It has to say
    // something, and what it says must be about the app, not about their work.
    installFetch({
      projects: [projectMeta({ id: 'a', name: 'Northwind Atlas', path: '/a' })],
      lamps: [{ projectId: 'a', liveWork: true }],
    })
    await act(async () => {
      renderApp()
    })
    expect(await screen.findByLabelText(UNKNOWN_MARK)).toBeInTheDocument()
    expect(screen.queryByLabelText(RUNNING_MARK)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(QUESTION_MARK)).not.toBeInTheDocument()
  })

  it('surfaces the global "Claude is designing" beacon while a Canvas AI job is active', async () => {
    installFetch({ projects: [], aiActiveJobs: 2 })
    await act(async () => {
      renderApp()
    })
    // canvas.generate.generating (en) — only rendered when aiActiveCount > 0,
    // i.e. /api/canvas/ai/active reported running jobs.
    expect(await screen.findByText('Generating with Claude…')).toBeInTheDocument()
  })

  it('hides the AI beacon when no Canvas AI job is running', async () => {
    installFetch({ projects: [], aiActiveJobs: 0 })
    await act(async () => {
      renderApp()
    })
    // Wait for the mount to settle on a known anchor, then assert the beacon is absent.
    await screen.findByText('Begin your atlas.')
    expect(screen.queryByText('Generating with Claude…')).not.toBeInTheDocument()
  })
})

describe('App - retired Persona', () => {
  it('keeps Persona absent even when an old experiment response enables it', async () => {
    installFetch({ projects: [], experiments: { eligible: true, flags: { swarm: true, sandbox: true, persona: true } } })
    await act(async () => { renderApp() })
    await screen.findByText('Begin your atlas.')
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Persona' })).not.toBeInTheDocument()
    expect(screen.queryByTestId('persona-panel')).not.toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Settings' })) })
    await screen.findByRole('textbox', { name: 'Display name' })
    expect(screen.queryByText('Persona', { exact: false })).not.toBeInTheDocument()
  })
})

describe('App - retired tab submissions', () => {
  it('does not load or poll the removed review queue', async () => {
    const calls = installFetch()
    await act(async () => { renderApp() })
    await screen.findByText('Begin your atlas.')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Settings' })) })
    await screen.findByRole('textbox', { name: 'Display name' })
    expect(calls.mock.calls.map(c => urlOf(c[0])).filter(url => url.includes('/api/module-submissions'))).toEqual([])
    expect(screen.queryByText('Tab submissions')).not.toBeInTheDocument()
  })
})

describe('App — saveSettings failure handling (audit 856daefb)', () => {
  it('surfaces an error and does NOT silently roll back the edit when POST /api/settings fails', async () => {
    const fetchMock = installFetch({
      projects: [],
      settingsPostStatus: 500,
      settingsPostError: 'disk full',
    })
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {})
    let unmount!: () => void
    await act(async () => {
      ;({ unmount } = renderApp())
    })
    await screen.findByText('Begin your atlas.')

    const projectsCallsBefore = fetchMock.mock.calls.filter((c) =>
      urlOf(c[0]).includes('/api/projects'),
    ).length

    const gear = screen.getByRole('button', { name: 'Settings' })
    fireEvent.click(gear)
    // Multiple textboxes exist now (the WordPress section) — name this one.
    const nameInput = await screen.findByRole('textbox', { name: 'Display name' })
    fireEvent.change(nameInput, { target: { value: 'New Name' } })
    fireEvent.blur(nameInput) // triggers the panel's immediate flush() → onSave

    // The failed save must be surfaced to the user…
    await waitFor(() => expect(alertSpy).toHaveBeenCalledTimes(1))
    expect(alertSpy.mock.calls[0][0]).toContain('disk full')
    // …and must NOT reload /api/projects (which would refetch the stale
    // settings and silently overwrite the user's edit with no explanation —
    // the exact bug from audit 856daefb).
    const projectsCallsAfter = fetchMock.mock.calls.filter((c) =>
      urlOf(c[0]).includes('/api/projects'),
    ).length
    expect(projectsCallsAfter).toBe(projectsCallsBefore)

    // Unmount while the mock is still installed — the panel's flush-on-unmount
    // effect re-fires onSave with the (still-pending) edit, which would
    // otherwise hit the real network after fetch is unstubbed in afterEach.
    await act(async () => {
      unmount()
    })
  })
})
