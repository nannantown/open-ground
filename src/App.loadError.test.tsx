// @vitest-environment jsdom
//
// App.tsx BOOTSTRAP-FAILURE test — audit 856daefb finding #34 (MINOR).
//
// GET /api/projects is the Ground's only bootstrap. load() read its body
// without an res.ok guard, so a 5xx `{ error }` envelope was adopted as
// ProjectsResponse: `data.canvas` was undefined, autoLayout threw, and the
// restore effect (a bare `.then`, no `.catch`) swallowed the rejection. Since
// settings/canvas are only set on success, App fell through to its
// `<div className="bg-bg" />` early return and STUCK there — no error, no
// spinner, no Retry. ⌘R and the focus re-scan hit the same wall silently.
//
// These tests pin the fixed behaviour: an explicit error + Retry (the same
// treatment ProjectPanel's initial load got in f6443d0), Retry actually
// recovers, and a failed load does not burn the one-shot restore.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react'
import App from './App'
import { I18nProvider } from '@/i18n/I18nContext'
import { AuthProvider } from '@/lib/auth/AuthContext'
import { RealtimeProvider } from '@/lib/collab/RealtimeContext'
import { loadPersistedView, savePersistedView } from '@/lib/persistView'
import type { ProjectMeta } from '@/lib/types'

class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const SETTINGS = { projectsRoot: null, archiveDirName: '', excludePatterns: [] }
const EMPTY_CANVAS = { positions: {}, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] }

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

/** /api/projects answers with `state.status` — flipped between renders/retries
 *  so one mock can serve "server down, then server back". */
function installFetch(state: { status: number; error?: string; projects?: ProjectMeta[] }) {
  const fetchMock = vi.fn((input: unknown) => {
    const url = urlOf(input)
    if (url.includes('/api/projects')) {
      return state.status >= 300
        ? reply(state.status, { error: state.error ?? 'boom' })
        : reply(200, { settings: SETTINGS, projects: state.projects ?? [], canvas: EMPTY_CANVAS })
    }
    if (url.includes('/api/settings')) return reply(200, { ...SETTINGS, suggestedDisplayName: null })
    if (url.includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
    if (url.includes('/api/terminal/active')) return reply(200, { cwds: [], claude: [] })
    if (url.includes('/api/auth/session')) return reply(503, {})
    if (url.includes('/api/collab/config')) return reply(200, { enabled: false })
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

const projectsCalls = (mock: ReturnType<typeof installFetch>) =>
  mock.mock.calls.filter((c) => urlOf(c[0]).includes('/api/projects')).length

beforeEach(() => {
  localStorage.clear() // deterministic UI language (en) — copy below is English
  vi.stubGlobal('ResizeObserver', ROStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App — Ground bootstrap failure (audit 856daefb #34)', () => {
  it('shows the error + Retry instead of sticking on the blank Ground when GET /api/projects 500s', async () => {
    installFetch({ status: 500, error: 'scan failed: EACCES settings.json' })
    await act(async () => {
      renderApp()
    })

    // misc.ground.loadFailed / .loadFailedBody (en) — the blank <div bg-bg> is gone.
    expect(await screen.findByText("Couldn't load your projects.")).toBeInTheDocument()
    expect(
      screen.getByText('The OPEN GROUND server returned an error. It may still be starting up.'),
    ).toBeInTheDocument()
    // The server's own {error} text is surfaced, not a generic status code.
    expect(screen.getByText(/scan failed: EACCES settings\.json/)).toBeInTheDocument()
    // And there is a way out.
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()
  })

  it('falls back to the HTTP status when the 5xx body carries no {error}', async () => {
    // Non-JSON / empty error bodies (a proxy's 502 page) must still be legible.
    const fetchMock = vi.fn((input: unknown) => {
      const url = urlOf(input)
      if (url.includes('/api/projects'))
        return Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        } as unknown as Response)
      if (url.includes('/api/auth/session')) return reply(503, {})
      if (url.includes('/api/collab/config')) return reply(200, { enabled: false })
      return reply(200, {})
    })
    vi.stubGlobal('fetch', fetchMock)
    await act(async () => {
      renderApp()
    })
    expect(await screen.findByText(/GET \/api\/projects failed \(502\)/)).toBeInTheDocument()
  })

  it('Retry re-runs the load and paints the Ground once the server recovers', async () => {
    const state = { status: 500, error: 'boom' }
    const fetchMock = installFetch(state)
    await act(async () => {
      renderApp()
    })
    await screen.findByText("Couldn't load your projects.")
    const before = projectsCalls(fetchMock)

    state.status = 200 // server is back
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })

    // The Ground boots: first-run empty state (misc.empty.title) replaces the error.
    expect(await screen.findByText('Begin your atlas.')).toBeInTheDocument()
    expect(screen.queryByText("Couldn't load your projects.")).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(projectsCalls(fetchMock)).toBeGreaterThan(before) // Retry really refetched
  })

  it('renders the recovered Ground cards after a Retry (not just the empty state)', async () => {
    const state = {
      status: 500,
      projects: [
        {
          id: 'a',
          name: 'Northwind Atlas',
          path: '/a',
          description: '',
          lastModified: '2020-01-01T00:00:00Z',
          hasGit: false,
          openTaskCount: 0,
          totalTaskCount: 0,
        } as ProjectMeta,
      ],
    }
    installFetch(state)
    await act(async () => {
      renderApp()
    })
    await screen.findByRole('button', { name: 'Retry' })

    state.status = 200
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    expect(await screen.findByText('Northwind Atlas')).toBeInTheDocument()
  })

  it('does not burn the one-shot restore on a failed load — Retry still restores the saved view', async () => {
    // The saved project is a ghost (not in the recovered list), so the restore
    // pass proves it ran by CLEANING the stale id. If a failed load had marked
    // didRestore (the pre-fix ordering), the id would be dropped at mount and
    // the post-Retry restore would never run.
    savePersistedView({ projectId: 'ghost-project' })
    const state = { status: 500, projects: [] as ProjectMeta[] }
    installFetch(state)
    await act(async () => {
      renderApp()
    })
    await screen.findByRole('button', { name: 'Retry' })

    // Failed bootstrap must leave the saved view untouched.
    expect(loadPersistedView().projectId).toBe('ghost-project')

    state.status = 200
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    })
    await screen.findByText('Begin your atlas.')
    // Restore ran on the retried load and pruned the now-vanished project.
    await waitFor(() => expect(loadPersistedView().projectId).toBeUndefined())
  })

  it('never shows the error screen on a healthy boot (negative control)', async () => {
    installFetch({ status: 200 })
    await act(async () => {
      renderApp()
    })
    await screen.findByText('Begin your atlas.')
    expect(screen.queryByText("Couldn't load your projects.")).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
  })
})
