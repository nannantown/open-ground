// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { CollabBinding } from '@/lib/collab/RealtimeContext'
import type { CanvasFile, ProjectData } from '@/lib/types'

// Identity translator (assert on keys). Mock the shared bindings + BoardModule +
// CanvasWorkspace so we test the panel's WIRING (doc adoption → module props,
// connecting vs unavailable, the Board/Canvas switcher) without a real Y.Doc.
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {} }),
}))

let mockBinding: CollabBinding<ProjectData> | null = null
let mockCanvasBinding: CollabBinding<CanvasFile> | null = null
vi.mock('@/lib/collab/RealtimeContext', () => ({
  useBoardCollabShared: () => mockBinding,
  useCanvasCollabShared: () => mockCanvasBinding,
}))
// Stub presence avatars (they call useAuth, which needs an AuthProvider we don't
// mount here) — the panel's header just renders this; its content isn't under test.
vi.mock('@/components/canvas/CollabPresence', () => ({
  CollabPresence: () => null,
  usePublishPresence: () => {},
}))

// Stub BoardModule: surface the props the panel must feed it (so we can assert
// the synthetic project + adopted data + that the member terminal stubs are off).
vi.mock('@/components/canvas/modules/BoardModule', () => ({
  BoardModule: (props: {
    project: { name: string; path: string }
    data: ProjectData
    hasTerminalSlot: (id: string) => boolean
    liveTerminalId: (id: string) => string | null
  }) => (
    <div data-testid="board">
      <span data-testid="proj-name">{props.project.name}</span>
      <span data-testid="proj-path">{`[${props.project.path}]`}</span>
      <span data-testid="task-count">{props.data.tasks.length}</span>
      <span data-testid="has-slot">{String(props.hasTerminalSlot('x'))}</span>
      <span data-testid="live-term">{String(props.liveTerminalId('x'))}</span>
    </div>
  ),
}))
// Stub CanvasWorkspace (the member canvas render target).
vi.mock('@/components/canvas/CanvasWorkspace', () => ({
  CanvasWorkspace: (props: { canvas: CanvasFile; projectPath: string }) => (
    <div data-testid="canvas-ws">
      <span data-testid="cv-path">{`[${props.projectPath}]`}</span>
      <span data-testid="cv-id">{props.canvas.id}</span>
    </div>
  ),
}))

import { SharedProjectBody } from './SharedProjectBody'

const makeBinding = (
  tasks: Array<{ id: string }>,
  synced: boolean,
  canvasIndex?: { id: string; name: string }[],
): CollabBinding<ProjectData> => ({
  doc: {} as CollabBinding<ProjectData>['doc'],
  synced,
  seed: vi.fn(),
  // extract layers the doc's tasks (+ optional canvas index) over the base.
  extract: (base: ProjectData) => ({
    ...base,
    tasks: tasks as ProjectData['tasks'],
    ...(canvasIndex ? { canvasIndex } : {}),
  }),
  onRemote: () => () => {},
  setPresence: vi.fn(),
  onPresence: () => () => {},
})

const makeCanvasBinding = (synced: boolean): CollabBinding<CanvasFile> => ({
  doc: {} as CollabBinding<CanvasFile>['doc'],
  synced,
  seed: vi.fn(),
  extract: (base: CanvasFile) => base,
  onRemote: () => () => {},
  setPresence: vi.fn(),
  onPresence: () => () => {},
})

afterEach(() => {
  mockBinding = null
  mockCanvasBinding = null
  vi.clearAllMocks()
})

describe('SharedProjectBody (member Board view)', () => {
  it('renders the board with the adopted doc tasks + the shared label, no local path', () => {
    mockBinding = makeBinding([{ id: 't1' }, { id: 't2' }], true)
    render(
      <SharedProjectBody collabProjectId="pid-1" label="Design System" onClose={() => {}} />,
    )
    expect(screen.getByTestId('board')).toBeTruthy()
    expect(screen.getByTestId('proj-name').textContent).toBe('Design System')
    // Synthetic path is empty so BoardModule's internal collab binding stays null.
    expect(screen.getByTestId('proj-path').textContent).toBe('[]')
    // The doc's two tasks were adopted into the rendered board.
    expect(screen.getByTestId('task-count').textContent).toBe('2')
    // Member terminal stubs are inert (Claude runs on the owner's machine).
    expect(screen.getByTestId('has-slot').textContent).toBe('false')
    expect(screen.getByTestId('live-term').textContent).toBe('null')
  })

  it('shows the Live status when the doc is synced', () => {
    mockBinding = makeBinding([], true)
    render(<SharedProjectBody collabProjectId="pid-1" label="X" onClose={() => {}} />)
    expect(screen.getByText('projectPanel.collabSharedLive')).toBeTruthy()
  })

  it('shows "unavailable" (not the board) when the binding is null (non-member / disabled)', () => {
    mockBinding = null
    render(<SharedProjectBody collabProjectId="pid-1" label="X" onClose={() => {}} />)
    expect(screen.queryByTestId('board')).toBeNull()
    expect(screen.getByText('projectPanel.collabSharedUnavailable')).toBeTruthy()
  })

  it('shows "connecting" (NOT an editable board) until the doc has synced', () => {
    // binding present but synced:false → interactivity is gated so a pre-sync edit
    // can't seed empty meta over the authoritative doc (review Finding 2).
    mockBinding = makeBinding([{ id: 't1' }], false)
    render(<SharedProjectBody collabProjectId="pid-1" label="X" onClose={() => {}} />)
    expect(screen.queryByTestId('board')).toBeNull()
    // "Connecting" shows in both the status pill and the body until synced.
    expect(screen.getAllByText('projectPanel.collabSharedConnecting').length).toBeGreaterThan(0)
  })

  it('shows the cached board READ-ONLY (option A) while connecting, with a banner', async () => {
    // Hydrate returns a cached board; binding is present but NOT synced (!ready),
    // so the cached copy is shown read-only instead of "connecting" text.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/api/collab/shared-data')
          ? new Response(
              JSON.stringify({
                data: { description: '', notes: '', updatedAt: '', tasks: [{ id: 'c1' }, { id: 'c2' }] },
              }),
              { status: 200 },
            )
          : new Response('{}', { status: 200 }),
      ) as unknown as typeof fetch,
    )
    mockBinding = makeBinding([], false) // present but not synced → !ready
    render(<SharedProjectBody collabProjectId="pid-1" label="X" onClose={() => {}} />)
    // The cached board renders (its 2 tasks) with the read-only banner.
    expect(await screen.findByTestId('board')).toBeTruthy()
    expect(screen.getByTestId('task-count').textContent).toBe('2')
    expect(screen.getByText('projectPanel.collabSharedCachedBanner')).toBeTruthy()
  })

  it('mirrors the synced board to the cache once (debounced POST) after ready', async () => {
    vi.useFakeTimers()
    try {
      const calls: Array<{ url: string; method?: string }> = []
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url: String(url), method: init?.method })
          return new Response(JSON.stringify({ data: null }), { status: 200 }) // hydrate: no cache
        }) as unknown as typeof fetch,
      )
      mockBinding = makeBinding([{ id: 't1' }], true) // synced → ready
      render(<SharedProjectBody collabProjectId="pid-1" label="X" onClose={() => {}} />)
      // Flush effects + the 800ms mirror debounce.
      await vi.advanceTimersByTimeAsync(900)
      const posts = calls.filter(
        (c) => c.url.includes('/api/collab/shared-data') && c.method === 'POST',
      )
      expect(posts.length).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('lists shared canvases and opens one into CanvasWorkspace (path-less)', async () => {
    mockBinding = makeBinding([], true, [
      { id: 'cv1', name: 'Wireframes' },
      { id: 'cv2', name: 'Moodboard' },
    ])
    mockCanvasBinding = makeCanvasBinding(true)
    render(<SharedProjectBody collabProjectId="pid-1" label="X" onClose={() => {}} />)

    // Switch to the Canvas tab → the shared canvas index lists the canvases.
    fireEvent.click(screen.getByText('Canvas'))
    expect(await screen.findByText('Wireframes')).toBeTruthy()
    expect(screen.getByText('Moodboard')).toBeTruthy()

    // Open one → CanvasWorkspace renders with NO local path + the canvas id.
    fireEvent.click(screen.getByText('Wireframes'))
    expect(await screen.findByTestId('canvas-ws')).toBeTruthy()
    expect(screen.getByTestId('cv-path').textContent).toBe('[]')
    expect(screen.getByTestId('cv-id').textContent).toBe('cv1')
  })

  it('Escape closes the panel', () => {
    mockBinding = makeBinding([], true)
    const onClose = vi.fn()
    render(<SharedProjectBody collabProjectId="pid-1" label="X" onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('Back to Ground calls onClose', () => {
    mockBinding = makeBinding([], true)
    const onClose = vi.fn()
    render(<SharedProjectBody collabProjectId="pid-1" label="X" onClose={onClose} />)
    fireEvent.click(screen.getByText('projectPanel.backToGround'))
    expect(onClose).toHaveBeenCalledOnce()
  })
})
