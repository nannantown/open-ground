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
import { AuthProvider, useAuth } from '@/lib/auth/AuthContext'
import { RealtimeProvider } from '@/lib/collab/RealtimeContext'
import type { CanvasState, GroundLampRow, ProjectMeta, ProjectData } from '@/lib/types'
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
  canvasPost?: (body: CanvasState) => Promise<Response>
  authUserId?: string
  settings?: Record<string, unknown>
  projects?: ProjectMeta[]
  projectData?: ProjectData
  feedbackEnabled?: boolean
  aiActiveJobs?: number
  /** Non-2xx status for POST /api/settings, to exercise the save-failure path. */
  settingsPostStatus?: number
  settingsPostError?: string
  /** GET /api/experiments — the owner-only gate, resolved SERVER-side. Omitted ⇒
   *  the shipped/non-owner answer (nothing eligible, every flag closed). */
  experiments?: { eligible: boolean; assistantEligible?: boolean; flags: Record<string, boolean> }
  /** GET /api/ground/lamps — what each card's lamp is decided from. Omitted ⇒
   *  no rows, i.e. every card dark, which is the resting state. */
  lamps?: GroundLampRow[]
}

const methodOf = (input: unknown, init?: RequestInit): string =>
  init?.method ?? (input instanceof Request ? input.method : 'GET')

function installFetch(opts: MockOpts = {}) {
  const settings = { ...SETTINGS, ...opts.settings }
  const projects = opts.projects ?? []
  const jobs = Array.from({ length: opts.aiActiveJobs ?? 0 }, (_, i) => ({ id: `job-${i}` }))
  const fetchMock = vi.fn((input: unknown, init?: RequestInit) => {
    const url = urlOf(input)
    if (new URL(url, 'http://fixture').pathname === '/api/canvas' && methodOf(input, init) === 'POST') {
      const body = JSON.parse(String(init?.body)) as CanvasState
      return opts.canvasPost?.(body) ?? reply(200, { ok: true, canvas: body })
    }
    if (new URL(url, 'http://fixture').pathname === '/api/canvas') return reply(200, EMPTY_CANVAS)
    if (url.includes('/api/settings') && methodOf(input, init) === 'POST') {
      const status = opts.settingsPostStatus ?? 200
      return reply(status, status >= 300 ? { error: opts.settingsPostError ?? 'save failed' } : { ok: true })
    }
    if (url.includes('/api/settings')) return reply(200, { ...settings, suggestedDisplayName: null })
    if (url.includes('/api/projects'))
      return reply(200, { settings, projects, canvas: EMPTY_CANVAS })
    if (url.includes('/api/project?') && opts.projectData) return reply(200, opts.projectData)
    if (url.includes('/api/feedback/config')) return reply(200, { enabled: !!opts.feedbackEnabled })
    if (url.includes('/api/experiments'))
      return reply(
        200,
        opts.experiments ? { ...opts.experiments, assistantEligible: opts.experiments.assistantEligible ?? opts.experiments.eligible } : {
          eligible: false,
          assistantEligible: false,
          flags: { swarm: false, sandbox: false, persona: false },
        },
      )
    if (url.includes('/api/canvas/ai/active')) return reply(200, { jobs })
    if (url.includes('/api/terminal/active')) return reply(200, { cwds: [], claude: [] })
    if (url.includes('/api/ground/lamps')) return reply(200, { lamps: opts.lamps ?? [] })
    if (url.includes('/api/auth/session')) return opts.authUserId ? reply(200, { user: { id: opts.authUserId } }) : reply(503, {})
    if (url.includes('/api/collab/config')) return reply(200, { enabled: false })
    if (url.includes('/api/assistant/runtime')) return reply(200, { conversationId: 'synthetic-assistant', epoch: 0, pending: [], uncertainActions: [], actions: [] })
    // Everything else (feedback/config, notifications,
    // auth/config, usage, …) reads optionally — an empty object collapses to
    // the default (disabled) build, which is what we render here.
    return reply(200, {})
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const AuthTestControls = () => {
  const auth = useAuth()
  return <aside><button type="button" onClick={() => { void auth.refresh() }}>Refresh synthetic identity</button><output data-testid="synthetic-identity">{auth.user?.id ?? 'signed-out'}</output></aside>
}
const renderApp = (authControls = false) =>
  render(
    <I18nProvider>
      <AuthProvider>
        <RealtimeProvider>
          {authControls && <AuthTestControls />}
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
  it('creates and saves one owner-designated automation frame and rebases later saves onto the committed revision', async () => {
    const writes: CanvasState[] = []
    installFetch({ authUserId: 'owner-a', projects: [projectMeta()], experiments: { eligible: true, flags: { swarm: true } }, canvasPost: async (body) => {
      writes.push(structuredClone(body))
      return reply(200, { ok: true, canvas: { ...body, automation: { ...body.automation, revision: 1 } }, reconciliation: 'complete' })
    } })
    localStorage.setItem('openground:onboarded', '1')
    await act(async () => { renderApp() })
    fireEvent.click(await screen.findByRole('button', { name: 'Automatic operation' }))
    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].automation).toMatchObject({ version: 1, revision: 0, enabled: true })
    const designated = writes[0].elements.filter((element) => element.groundRole === 'automation')
    expect(designated).toHaveLength(1)
    expect(writes[0].automation?.frameId).toBe(designated[0].id)
    expect(designated[0].x).toBeGreaterThan(writes[0].positions.id.x + 256)
    await waitFor(() => expect((screen.getByRole('button', { name: 'Automatic operation' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'Automatic operation' }))
    await waitFor(() => expect(writes).toHaveLength(2))
    expect(writes[1].automation?.revision).toBe(1)
    expect(writes[1].elements.filter((element) => element.groundRole === 'automation')).toHaveLength(1)
  })

  it('retains a visible unsaved frame on a conflicting save and exposes the saved-layout recovery action', async () => {
    installFetch({ authUserId: 'owner-a', projects: [projectMeta()], experiments: { eligible: true, flags: { swarm: true } }, canvasPost: async () => reply(409, { error: 'conflict' }) })
    localStorage.setItem('openground:onboarded', '1')
    await act(async () => { renderApp() })
    fireEvent.click(await screen.findByRole('button', { name: 'Automatic operation' }))
    const recover = await screen.findByRole('button', { name: 'Load saved layout' })
    expect(recover).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('unsaved layout changes will be replaced')
    expect((screen.getByRole('button', { name: 'Automatic operation' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not authorize owner A’s pending layout as owner B after a debounce, and permits an explicit retry after A signs back in', async () => {
    const options: MockOpts = { authUserId: 'owner-a', projects: [projectMeta()], experiments: { eligible: true, flags: { swarm: true } } }
    const calls = installFetch(options)
    localStorage.setItem('openground:onboarded', '1')
    await act(async () => { renderApp(true) })
    await waitFor(() => expect(screen.getByTestId('synthetic-identity').textContent).toBe('owner-a'))
    fireEvent.click(await screen.findByRole('button', { name: 'Automatic operation' }))
    options.authUserId = 'owner-b'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh synthetic identity' }))
    await waitFor(() => expect(screen.getByTestId('synthetic-identity').textContent).toBe('owner-b'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
    const saves = () => calls.mock.calls.filter(([input, init]) => new URL(urlOf(input), 'http://fixture').pathname === '/api/canvas' && methodOf(input, init) === 'POST')
    expect(saves()).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toContain('another account')
    options.authUserId = 'owner-a'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh synthetic identity' }))
    await waitFor(() => expect(screen.getByTestId('synthetic-identity').textContent).toBe('owner-a'))
    expect(saves()).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }))
    await waitFor(() => expect(saves()).toHaveLength(1))
    expect(new Headers(saves()[0][1]?.headers).get('X-OpenGround-Owner')).toBe('owner-a')
  })

  it('does not clear or rebase A’s pending layout when its accepted ACK arrives after an account switch', async () => {
    let acknowledge!: (value: Response) => void
    let sent!: CanvasState
    const options: MockOpts = { authUserId: 'owner-a', projects: [projectMeta()], experiments: { eligible: true, flags: { swarm: true } },
      canvasPost: async (body) => { sent = body; return new Promise((resolve) => { acknowledge = resolve }) } }
    const calls = installFetch(options)
    localStorage.setItem('openground:onboarded', '1')
    await act(async () => { renderApp(true) })
    fireEvent.click(await screen.findByRole('button', { name: 'Automatic operation' }))
    await waitFor(() => expect(sent?.automation).toBeTruthy())
    options.authUserId = 'owner-b'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh synthetic identity' }))
    await waitFor(() => expect(screen.getByTestId('synthetic-identity').textContent).toBe('owner-b'))
    await act(async () => { acknowledge(await reply(200, { ok: true, canvas: { ...sent, automation: { ...sent.automation, revision: 777 } } })) })
    expect(screen.getByRole('alert').textContent).toContain('another account')
    expect(document.querySelector(`[data-element-id="${sent.automation!.frameId}"]`)).toBeTruthy()
    fireEvent(window, new Event('focus'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(document.querySelector(`[data-element-id="${sent.automation!.frameId}"]`)).toBeTruthy()
    expect(calls.mock.calls.filter(([input, init]) => new URL(urlOf(input), 'http://fixture').pathname === '/api/canvas' && methodOf(input, init) === 'POST')).toHaveLength(1)
  })

  it('does not submit an anonymous pending canvas edit as a newly signed-in owner', async () => {
    const options: MockOpts = { projects: [projectMeta()], experiments: { eligible: true, flags: { swarm: true } } }
    const calls = installFetch(options)
    localStorage.setItem('openground:onboarded', '1')
    let view!: ReturnType<typeof renderApp>
    await act(async () => { view = renderApp(true) })
    const viewport = view.container.querySelector('main > div.contents > div')!
    expect(viewport).toBeTruthy()
    fireEvent.wheel(viewport, { deltaX: 10, deltaY: 20 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    options.authUserId = 'owner-a'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh synthetic identity' }))
    await waitFor(() => expect(screen.getByTestId('synthetic-identity').textContent).toBe('owner-a'))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
    expect(calls.mock.calls.filter(([input, init]) => new URL(urlOf(input), 'http://fixture').pathname === '/api/canvas' && methodOf(input, init) === 'POST')).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toContain('another account')
  })

  it('rechecks the editing identity after a flush waits behind an older in-flight save', async () => {
    let acknowledge!: (value: Response) => void
    let first!: CanvasState
    const posted: CanvasState[] = []
    const options: MockOpts = { authUserId: 'owner-a', projects: [projectMeta()], experiments: { eligible: true, flags: { swarm: true } }, canvasPost: async (body) => {
      posted.push(body)
      if (posted.length === 1) { first = body; return new Promise((resolve) => { acknowledge = resolve }) }
      return reply(200, { ok: true, canvas: body })
    } }
    installFetch(options)
    localStorage.setItem('openground:onboarded', '1')
    let view!: ReturnType<typeof renderApp>
    await act(async () => { view = renderApp(true) })
    fireEvent.click(await screen.findByRole('button', { name: 'Automatic operation' }))
    await waitFor(() => expect(posted).toHaveLength(1))
    fireEvent.wheel(view.container.querySelector('main > div.contents > div')!, { deltaX: 20, deltaY: 30 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    fireEvent(window, new Event('focus'))
    options.authUserId = 'owner-b'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh synthetic identity' }))
    await waitFor(() => expect(screen.getByTestId('synthetic-identity').textContent).toBe('owner-b'))
    await act(async () => { acknowledge(await reply(200, { ok: true, canvas: { ...first, automation: { ...first.automation, revision: 1 } } })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 450)) })
    expect(posted).toHaveLength(1)
    expect(screen.getByRole('alert').textContent).toContain('another account')
  })

  it('does not transfer an explicit reload to a newer drag made while the reload waits for an old ACK', async () => {
    let acknowledge!: (value: Response) => void
    let sent!: CanvasState
    const options: MockOpts = { authUserId: 'owner-a', projects: [projectMeta()], experiments: { eligible: true, flags: { swarm: true } },
      canvasPost: async (body) => { sent = body; return new Promise((resolve) => { acknowledge = resolve }) } }
    const calls = installFetch(options)
    localStorage.setItem('openground:onboarded', '1')
    let view!: ReturnType<typeof renderApp>
    await act(async () => { view = renderApp(true) })
    fireEvent.click(await screen.findByRole('button', { name: 'Automatic operation' }))
    await waitFor(() => expect(sent?.automation).toBeTruthy())
    options.authUserId = 'owner-b'
    fireEvent.click(screen.getByRole('button', { name: 'Refresh synthetic identity' }))
    await waitFor(() => expect(screen.getByTestId('synthetic-identity').textContent).toBe('owner-b'))
    fireEvent.click(await screen.findByRole('button', { name: 'Load saved layout' }))
    fireEvent.wheel(view.container.querySelector('main > div.contents > div')!, { deltaX: 20, deltaY: 30 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    await act(async () => { acknowledge(await reply(200, { ok: true, canvas: sent })) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)) })
    expect(calls.mock.calls.filter(([input, init]) => new URL(urlOf(input), 'http://fixture').pathname === '/api/canvas' && methodOf(input, init) === 'GET')).toHaveLength(0)
    expect(document.querySelector(`[data-element-id="${sent.automation!.frameId}"]`)).toBeTruthy()
  })

  it('assistant owner gate waits for the real role before reading the closed talk or provider status', async () => {
    const fetchMock = installFetch()
    const original = fetchMock.getMockImplementation()!
    let resolveRole!: (response: Response) => void
    const role = new Promise<Response>((resolve) => { resolveRole = resolve })
    fetchMock.mockImplementation((input, init) => urlOf(input).includes('/api/experiments') ? role : original(input, init))
    localStorage.setItem('openground:onboarded', '1')
    await act(async () => { renderApp() })
    const calls = (path: string) => fetchMock.mock.calls.filter(([input]) => urlOf(input).includes(path))
    expect(calls('/api/phone-link/assistant/log')).toHaveLength(0)
    expect(calls('/api/chatgpt/status')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: 'Assistant' })).toBeNull()
    await act(async () => { resolveRole(await reply(200, { eligible: true, assistantEligible: true, flags: { swarm: false, sandbox: false } })) })
    const assistant = await screen.findByRole('button', { name: 'Assistant' })
    expect(calls('/api/phone-link/assistant/log')).toHaveLength(1)
    expect(calls('/api/chatgpt/status')).toHaveLength(0)
    fireEvent.click(assistant)
    await waitFor(() => expect(calls('/api/chatgpt/status')).toHaveLength(1))
  })

  it('assistant owner gate never probes private routes for a non-owner with public Swarm enabled', async () => {
    const fetchMock = installFetch({ settings: { swarmOptIn: true }, experiments: { eligible: false, assistantEligible: false, flags: { swarm: true, sandbox: false } } })
    localStorage.setItem('openground:onboarded', '1')
    await act(async () => { renderApp() })
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByRole('dialog', { name: 'Settings' })
    expect(fetchMock.mock.calls.filter(([input]) => /\/api\/(phone-link\/assistant\/log|chatgpt\/status)/.test(urlOf(input)))).toEqual([])
    expect(screen.queryByRole('button', { name: 'Assistant' })).toBeNull()
  })

  it('keeps the locally authorized Claude assistant without reading the owner ChatGPT account', async () => {
    const fetchMock = installFetch({ settings: { swarmLocalOwner: true, assistantProvider: 'claude', assistantModel: 'haiku' }, experiments: { eligible: false, assistantEligible: true, flags: { swarm: true, sandbox: false } } })
    localStorage.setItem('openground:onboarded', '1')
    await act(async () => { renderApp() })
    const assistant = await screen.findByRole('button', { name: 'Assistant' })
    expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).includes('/api/phone-link/assistant/log'))).toHaveLength(1)
    fireEvent.click(assistant)
    fireEvent.click(screen.getByRole('button', { name: 'Model and effort' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Haiku' })).toHaveAttribute('aria-pressed', 'true'))
    expect(fetchMock.mock.calls.filter(([input]) => urlOf(input).includes('/api/chatgpt/status'))).toEqual([])
    expect(screen.queryByRole('button', { name: 'ChatGPT' })).toBeNull()
  })

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
      // Ground card + the project title's hover tooltip (owner 2026-10-02:
      // the details dialog is gone; the name's title carries the description).
      const titled = () => within(screen.getByTestId('project-header')).getByText('Project').getAttribute('title')
      expect(screen.getAllByText(summary)).toHaveLength(1)
      expect(titled()).toBe(`Project\n${summary}`)
      opts.projectData = { ...opts.projectData!, notes: 'External edit', updatedAt: '2026-09-21T00:00:01.000Z' }
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(screen.getAllByText(summary)).toHaveLength(1)
      expect(titled()).toBe(`Project\n${summary}`)
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
    // The owner's floating assistant (the routes answer here) — absent from the public view.
    const assistant = () => screen.queryByRole('button', { name: 'Assistant' })
    await waitFor(() => expect(assistant()).toBeTruthy())
    const writes = () => fetchMock.mock.calls.filter(([input, init]) => methodOf(input, init) !== 'GET')
    const before = writes().length
    const settingsSwitch = () => within(screen.getByRole('dialog', { name: 'Settings' })).getByRole('group', { name: 'Show as a public user sees it' })
    expect(screen.queryByRole('button', { name: 'Public view' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    fireEvent.click(within(settingsSwitch()).getByRole('button', { name: 'On' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Skills' })).toBeNull()
    expect(assistant()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    expect(screen.queryByText('WordPress', { exact: true })).toBeNull()
    expect(writes()).toHaveLength(before)
    // The way back must stay reachable while the public view is on.
    fireEvent.click(within(settingsSwitch()).getByRole('button', { name: 'Off' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'Skills' })).toBeTruthy()
    await waitFor(() => expect(assistant()).toBeTruthy())
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
