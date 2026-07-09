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
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import App from './App'
import { I18nProvider } from '@/i18n/I18nContext'
import { AuthProvider } from '@/lib/auth/AuthContext'
import { RealtimeProvider } from '@/lib/collab/RealtimeContext'
import type { ProjectMeta } from '@/lib/types'

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
  aiActiveJobs?: number
  /** Non-2xx status for POST /api/settings, to exercise the save-failure path. */
  settingsPostStatus?: number
  settingsPostError?: string
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
    if (url.includes('/api/canvas/ai/active')) return reply(200, { jobs })
    if (url.includes('/api/terminal/active')) return reply(200, { cwds: [], claude: [] })
    if (url.includes('/api/auth/session')) return reply(503, {}) // signed-out (default build)
    if (url.includes('/api/collab/config')) return reply(200, { enabled: false })
    // Everything else (feedback/config, module-submissions, notifications,
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
    const nameInput = await screen.findByRole('textbox')
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
