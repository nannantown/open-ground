// @vitest-environment jsdom
//
// Reliability-audit 856daefb repro — load() vs the debounced Ground canvas save.
//
// The bug: load() opened with a bare clearTimeout(saveTimer), CANCELLING the
// unsent debounced save, then unconditionally setCanvas(serverCanvas) — so a
// Ground edit younger than the 400ms debounce (sticky text typed right before
// ⌘R, or before the ≥30s focus re-scan) was silently clobbered by the older
// server state. The fix flushes the pending save BEFORE fetching and keeps the
// local canvas whenever a pending edit still exists (flush failed / edit landed
// mid-fetch).
//
// Test harness (App.render.test.tsx's whole-render style): the REAL App inside
// its production provider tree, network stubbed. Two twists:
//  * InfiniteCanvas is mocked so the test can drive onCanvasChange — the exact
//    entry point a user's Ground edit takes — and read back the canvas prop the
//    App feeds down after a reload.
//  * The fetch stub is STATEFUL: POST /api/canvas updates the "server" canvas
//    and GET /api/projects returns it — mirroring the real round-trip, which is
//    what makes "flushed before fetch" vs "discarded" observable.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import App from './App'
import { I18nProvider } from '@/i18n/I18nContext'
import { AuthProvider } from '@/lib/auth/AuthContext'
import { RealtimeProvider } from '@/lib/collab/RealtimeContext'
import type { CanvasElement, CanvasState } from '@/lib/types'

interface GroundCanvasProps {
  canvas: CanvasState
  onCanvasChange: (c: CanvasState) => void
}

// vi.mock is hoisted above the imports, so the capture array must be too.
const { canvasProps } = vi.hoisted(() => ({
  canvasProps: [] as GroundCanvasProps[],
}))

vi.mock('@/components/canvas/InfiniteCanvas', () => ({
  InfiniteCanvas: (props: GroundCanvasProps) => {
    canvasProps.push(props)
    return <div data-testid="ground-canvas" />
  },
}))

const latestCanvas = (): GroundCanvasProps => {
  const p = canvasProps[canvasProps.length - 1]
  if (!p) throw new Error('InfiniteCanvas has not rendered yet')
  return p
}

const SETTINGS = { projectsRoot: null, archiveDirName: '', excludePatterns: [] }
const EMPTY_CANVAS: CanvasState = {
  positions: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [],
}

const STICKY: CanvasElement = {
  id: 'sticky-fresh',
  type: 'sticky',
  x: 40,
  y: 40,
  width: 160,
  height: 160,
  text: 'typed 100ms ago',
}

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

interface StubOpts {
  /** HTTP status POST /api/canvas answers with (default 200). 500 = flush fails. */
  canvasPostStatus?: number
}

// Stateful stub: POST /api/canvas mutates `serverCanvas`; GET /api/projects
// serves it back — the same after-write read the real Hono store gives.
function installFetch(opts: StubOpts = {}) {
  let serverCanvas: CanvasState = EMPTY_CANVAS
  const canvasPosts: CanvasState[] = []
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = urlOf(input)
    const method = (
      init?.method ??
      (input instanceof Request ? input.method : 'GET')
    ).toUpperCase()
    // Order matters: '/api/canvas/ai/active' also contains '/api/canvas'.
    if (url.includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
    if (url.includes('/api/canvas') && method === 'POST') {
      const raw =
        init?.body != null
          ? String(init.body)
          : input instanceof Request
            ? await input.text()
            : ''
      const posted = JSON.parse(raw) as CanvasState
      canvasPosts.push(posted)
      const status = opts.canvasPostStatus ?? 200
      if (status < 300) serverCanvas = posted
      return reply(status, {})
    }
    if (url.includes('/api/projects'))
      return reply(200, { settings: SETTINGS, projects: [], canvas: serverCanvas })
    if (url.includes('/api/terminal/active')) return reply(200, { cwds: [], claude: [] })
    if (url.includes('/api/auth/session')) return reply(503, {}) // signed-out build
    if (url.includes('/api/collab/config')) return reply(200, { enabled: false })
    return reply(200, {})
  })
  vi.stubGlobal('fetch', fetchMock)
  const projectGets = () =>
    fetchMock.mock.calls.filter((c) => urlOf(c[0]).includes('/api/projects')).length
  return { fetchMock, canvasPosts, projectGets }
}

class ROStub {
  observe() {}
  unobserve() {}
  disconnect() {}
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

// Mount, wait for the first load() to hydrate the Ground, then apply a canvas
// edit through the same entry point a user's sticky-typing takes. Returns with
// the 400ms debounce armed and unflushed.
async function mountAndEditCanvas() {
  await act(async () => {
    renderApp()
  })
  await waitFor(() => expect(canvasProps.length).toBeGreaterThan(0))
  const { canvas, onCanvasChange } = latestCanvas()
  act(() => {
    onCanvasChange({ ...canvas, elements: [...canvas.elements, STICKY] })
  })
}

const pressCmdR = async () => {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', metaKey: true }))
  })
}

beforeEach(() => {
  localStorage.clear()
  canvasProps.length = 0
  vi.stubGlobal('ResizeObserver', ROStub)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App — load() must not drop the pending debounced canvas save', () => {
  it('⌘R inside the 400ms debounce window flushes the edit, and the reload keeps it', async () => {
    const { canvasPosts, projectGets } = installFetch()
    await mountAndEditCanvas()

    // Audit repro step 2: reload well within the debounce window (nothing has
    // been POSTed yet — the edit exists only in local state + the armed timer).
    expect(canvasPosts.length).toBe(0)
    await pressCmdR()

    // Wait for the ⌘R load() round-trip (2nd GET /api/projects) to fully land.
    await waitFor(() => expect(projectGets()).toBe(2))
    await act(async () => {})

    // The pending save was FLUSHED (not discarded): the first POST carries the
    // sticky, and it happened before the reload's GET…
    expect(canvasPosts.length).toBeGreaterThan(0)
    expect(canvasPosts[0].elements.some((el) => el.id === STICKY.id)).toBe(true)
    // …so the canvas the App feeds back down still shows the fresh sticky.
    expect(latestCanvas().canvas.elements.some((el) => el.id === STICKY.id)).toBe(true)
  })

  it('keeps the local canvas when the flush fails instead of adopting the stale server state', async () => {
    const { projectGets } = installFetch({ canvasPostStatus: 500 })
    await mountAndEditCanvas()
    await pressCmdR()

    await waitFor(() => expect(projectGets()).toBe(2))
    await act(async () => {})

    // The server never accepted the edit (500), so its snapshot is stale —
    // the reconcile guard must keep the local canvas on screen rather than
    // silently reverting the sticky.
    expect(latestCanvas().canvas.elements.some((el) => el.id === STICKY.id)).toBe(true)
  })

  it('still persists an edit through the normal ~400ms debounce (no regression)', async () => {
    const { canvasPosts } = installFetch()
    await mountAndEditCanvas()

    // No reload — just let the debounce fire.
    await waitFor(() => expect(canvasPosts.length).toBe(1), { timeout: 3000 })
    expect(canvasPosts[0].elements.some((el) => el.id === STICKY.id)).toBe(true)
  })
})
