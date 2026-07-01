// @vitest-environment jsdom
//
// Regression guard for the initial-load `res.ok` check (ProjectPanel's load
// effect). Before the fix `.then(r => r.json())` parsed the body regardless of
// status, so a non-2xx `{ error }` envelope — e.g. a 403 when the project was
// unregistered in ANOTHER window, then this card is opened — was adopted as
// `data`. That left `loadError` null (no Retry UI) AND fed BoardModule a
// tasks-less object → `data.tasks.find` TypeError → white screen. The guard
// throws on `!r.ok` so the load routes through the catch → setLoadError → the
// designed Retry UI, matching reloadProjectData / persist / the describe poll.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ProjectData, ProjectMeta } from '@/lib/types'

// --- Mocks -----------------------------------------------------------------

// Identity translator: assert on i18n KEYS (projectPanel.retry / .loadFailed)
// rather than localized copy. (RealtimeContext's default is { enabled:false },
// so useCollab needs no provider; ProjectPanel's owner body renders no
// CollabPresence/useAuth, so no AuthProvider is needed either.)
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))

// The claude `auth status` probe is irrelevant here and would add async churn —
// stub it to a settled "connected" so no /api/claude-connection fetch fires.
vi.mock('@/lib/useClaudeConnection', () => ({
  useClaudeConnection: () => ({ installed: true, loggedIn: true }),
}))

// Stub the heavy render targets. The Board mock reads `data.tasks.length` — this
// is the TEETH: if the res.ok guard regresses and an `{ error }` envelope ever
// reaches `data`, the success branch renders this and throws on `data.tasks`,
// failing the test. On the error path the Board must never mount at all.
vi.mock('@/components/canvas/modules/BoardModule', () => ({
  BoardModule: (props: { data: ProjectData }) => (
    <div data-testid="board">{props.data.tasks.length}</div>
  ),
}))
vi.mock('@/components/canvas/CanvasWorkspace', () => ({
  CanvasWorkspace: () => <div data-testid="canvas-ws" />,
}))

// Control the initial-load GET per test; every OTHER api path resolves benignly
// via a deep proxy so unrelated mount effects never hit the network or throw on
// an undefined route.
const h = vi.hoisted(() => ({
  projectGet: null as null | ((...a: unknown[]) => Promise<Response>),
}))
vi.mock('@/lib/api-client', () => {
  const benign = () =>
    Promise.resolve(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    )
  const deep = (path: string[]): unknown =>
    new Proxy(function () {} as object, {
      get: (_t, prop) =>
        prop === 'then' ? undefined : deep([...path, typeof prop === 'string' ? prop : String(prop)]),
      apply: (_t, _this, args: unknown[]) =>
        path.join('.') === 'project.$get' && h.projectGet ? h.projectGet(...args) : benign(),
    })
  return { api: { api: deep([]) } }
})

import { ProjectPanel } from '@/components/canvas/ProjectPanel'

// --- Fixtures --------------------------------------------------------------

const PROJECT: ProjectMeta = {
  id: 'uuid-1',
  name: 'proj',
  path: '/tmp/proj',
  description: '',
  lastModified: '2026-06-30T00:00:00Z',
  hasGit: true,
  openTaskCount: 0,
  totalTaskCount: 0,
}

const VALID: ProjectData = {
  description: '',
  tasks: [],
  notes: '',
  updatedAt: '2026-06-30T00:00:00Z',
}

const noop = () => {}
const errorResponse = (status: number) =>
  Promise.resolve(
    new Response(JSON.stringify({ error: 'project not registered' }), { status }),
  )

const renderPanel = () =>
  render(<ProjectPanel project={PROJECT} onClose={noop} onRemove={noop} frameLabel={null} />)

beforeEach(() => {
  // Any raw fetch() mount effect (editors / branch-changes / describe-active …)
  // gets a benign 200 so it can't throw or hit a real server (HOME-isolated).
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    ),
  )
})
afterEach(() => {
  h.projectGet = null
  vi.unstubAllGlobals()
})

describe('ProjectPanel initial load — res.ok guard', () => {
  it('shows the Retry UI (loadError set) instead of crashing when the GET 403s', async () => {
    h.projectGet = () => errorResponse(403)
    renderPanel()
    // loadError is set → the body renders the designed Retry affordance …
    expect(await screen.findByText('projectPanel.retry')).toBeTruthy()
    // … and the { error } body was NOT adopted as data, so the Board (which
    // would crash on data.tasks.find) never mounts. No white screen.
    expect(screen.queryByTestId('board')).toBeNull()
  })

  it.each([404, 500])('shows Retry on a %i too (no white screen)', async (status) => {
    h.projectGet = () => errorResponse(status)
    renderPanel()
    expect(await screen.findByText('projectPanel.retry')).toBeTruthy()
    expect(screen.queryByTestId('board')).toBeNull()
  })

  it('renders the board normally on a 200 (normal load is unchanged)', async () => {
    h.projectGet = () => Promise.resolve(new Response(JSON.stringify(VALID), { status: 200 }))
    renderPanel()
    // Valid ProjectData flows through to BoardModule (tasks readable) and no
    // error surface appears — the ok path is untouched by the guard.
    expect(await screen.findByTestId('board')).toBeTruthy()
    expect(screen.queryByText('projectPanel.retry')).toBeNull()
  })
})
