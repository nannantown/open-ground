// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import type { CanvasFile } from '@/lib/types'

// The Canvas "✦ Generate with Claude" bar (CanvasWorkspace) now drives a
// SERVER-SIDE JOB: the POST returns a { jobId } fast and the run survives this
// component unmounting (tab / project / Ground switch) — the bar starts the job
// and POLLS it for the result, it never holds the request open and never kills
// the run on unmount. The bar must still read as ALIVE (label + ticking elapsed
// while the job runs), route a signed-out 503 to the "sign in to Claude" CTA,
// keep the claudeMissing install copy, and insert the elements when the job
// completes.

// t(key) → key, so assertions match message keys (mirrors the other canvas suites).
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
// Heavy / side-effecting children are irrelevant to the generate-bar logic.
vi.mock('./InfiniteCanvas', () => ({ InfiniteCanvas: () => <div data-testid="surface" /> }))
vi.mock('./ToolPalette', () => ({
  // Expose the ✦ generate trigger so a test can open the prompt bar.
  ToolPalette: ({ onGenerate }: { onGenerate: () => void }) => (
    <button type="button" data-testid="open-generate" onClick={onGenerate}>
      generate
    </button>
  ),
}))
vi.mock('./SelectionInspector', () => ({ SelectionInspector: () => null }))
vi.mock('./LayersPanel', () => ({ LayersPanel: () => null }))
vi.mock('./ClaudeTerminalPane', () => ({
  ClaudeTerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="login-terminal">{terminalId}</div>
  ),
}))

import { CanvasWorkspace } from './CanvasWorkspace'

const makeCanvas = (): CanvasFile => ({
  id: 'c1',
  name: 'Canvas 1',
  rev: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [],
  chats: [],
  activeChatId: null,
  sidebarOpen: false,
  sidebarWidth: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const renderWorkspace = (onChange = vi.fn()) => ({
  onChange,
  ...render(
    <CanvasWorkspace projectPath="/tmp/proj" canvas={makeCanvas()} onChange={onChange} />,
  ),
})

// A response object shaped like fetch's Response (the bits the code reads).
const reply = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CanvasWorkspace — generation progress', () => {
  it('shows a live elapsed-seconds counter (not a bare spinner) while the job runs', () => {
    vi.useFakeTimers()
    // active → none (no re-attach). generate / job hang, so the bar stays pending.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
        return new Promise<never>(() => {})
      }),
    )

    const { getByTestId, getByPlaceholderText, getByText } = renderWorkspace()
    fireEvent.click(getByTestId('open-generate'))
    fireEvent.change(getByPlaceholderText('canvas.generate.placeholder'), {
      target: { value: 'a login screen' },
    })
    fireEvent.click(getByText('canvas.generate.go'))

    // The pending bar announces it's WORKING — a label, not just a spinner.
    expect(getByText('canvas.generate.generating')).toBeTruthy()
    const elapsed = getByTestId('canvas-gen-elapsed')
    expect(elapsed.textContent).toContain('0')
    // A clearly-labelled cancel replaces the lone ✕ while pending.
    expect(getByText('canvas.generate.cancel')).toBeTruthy()

    // The counter ticks every second (driven by the job's startedAt baseline).
    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(getByTestId('canvas-gen-elapsed').textContent).toContain('3')
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(getByTestId('canvas-gen-elapsed').textContent).toContain('5')
  })
})

describe('CanvasWorkspace — claudeLoggedOut handling', () => {
  it('a signed-out 503 shows the sign-in CTA (not a generic error) and opens the login terminal', async () => {
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
      if (u.includes('/api/canvas/ai/generate'))
        return reply(503, { error: 'signed out', claudeLoggedOut: true })
      if (u.includes('/api/terminal/claude-login')) return reply(200, { id: 'login-pty-1' })
      return reply(200, {})
    })
    vi.stubGlobal('fetch', fetchMock)

    const { getByTestId, getByPlaceholderText, getByText, queryByText, findByText, findByTestId } =
      renderWorkspace()
    fireEvent.click(getByTestId('open-generate'))
    fireEvent.change(getByPlaceholderText('canvas.generate.placeholder'), {
      target: { value: 'a login screen' },
    })
    await act(async () => {
      fireEvent.click(getByText('canvas.generate.go'))
    })

    // The sign-in CTA, NOT the generic failure copy.
    expect(await findByText('canvas.generate.signIn')).toBeTruthy()
    expect(queryByText('canvas.generate.error')).toBeNull()

    // Clicking it routes to the ONE login terminal via /api/terminal/claude-login.
    await act(async () => {
      fireEvent.click(getByText('canvas.generate.signIn'))
    })
    expect((await findByTestId('login-terminal')).textContent).toContain('login-pty-1')
    const loginCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/api/terminal/claude-login'),
    )
    expect(loginCalls.length).toBe(1)
  })

  it('keeps the existing claudeMissing copy (install guidance), distinct from the sign-in CTA', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
        if (u.includes('/api/canvas/ai/generate'))
          return reply(503, { error: 'no cli', claudeMissing: true })
        return reply(200, {})
      }),
    )

    const { getByTestId, getByPlaceholderText, getByText, queryByText, findByText } =
      renderWorkspace()
    fireEvent.click(getByTestId('open-generate'))
    fireEvent.change(getByPlaceholderText('canvas.generate.placeholder'), {
      target: { value: 'a card' },
    })
    await act(async () => {
      fireEvent.click(getByText('canvas.generate.go'))
    })

    expect(await findByText('canvas.generate.claudeMissing')).toBeTruthy()
    expect(queryByText('canvas.generate.signIn')).toBeNull()
  })
})

describe('CanvasWorkspace — success flow (job completes)', () => {
  it('polls the job and inserts the generated elements when it is done, then closes the bar', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
        if (u.includes('/api/canvas/ai/generate')) return reply(200, { jobId: 'job-1' })
        if (u.includes('/api/canvas/ai/job/')) {
          // The job is already done with one element to insert.
          return reply(200, {
            id: 'job-1',
            kind: 'generate',
            canvasId: 'c1',
            status: 'done',
            startedAt: '2026-01-01T00:00:00.000Z',
            elapsedMs: 1000,
            elements: [
              { id: 'g1', type: 'text', x: 0, y: 0, width: 120, height: 40, text: 'Hello' },
            ],
          })
        }
        return reply(200, {})
      }),
    )

    const { onChange, getByTestId, getByPlaceholderText, getByText, queryByText } = renderWorkspace()
    fireEvent.click(getByTestId('open-generate'))
    fireEvent.change(getByPlaceholderText('canvas.generate.placeholder'), {
      target: { value: 'a hello label' },
    })
    await act(async () => {
      fireEvent.click(getByText('canvas.generate.go'))
    })

    // The job poll lands → the element is inserted (onChange carries it) …
    await waitFor(() => {
      const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as CanvasFile | undefined
      expect(last?.elements?.some((e) => e.id === 'g1')).toBe(true)
    })
    // … and the bar closes (no error, no sign-in CTA).
    expect(queryByText('canvas.generate.signIn')).toBeNull()
    expect(queryByText('canvas.generate.error')).toBeNull()
  })
})

describe('CanvasWorkspace — cancel vs navigate-away (the headline invariant)', () => {
  // The running-job mock keeps a started generation pending so the bar stays in
  // its cancellable state.
  const runningJobFetch = (jobId: string) =>
    vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
      if (u.includes('/api/canvas/ai/generate')) return reply(200, { jobId })
      if (u.includes(`/api/canvas/ai/job/${jobId}/cancel`)) return reply(200, { ok: true })
      if (u.includes('/api/canvas/ai/job/'))
        return reply(200, {
          id: jobId,
          kind: 'generate',
          canvasId: 'c1',
          status: 'running',
          startedAt: '2026-01-01T00:00:00.000Z',
          elapsedMs: 500,
        })
      return reply(200, {})
    })

  it('explicit Cancel kills the job (POSTs /cancel)', async () => {
    const fetchMock = runningJobFetch('job-9')
    vi.stubGlobal('fetch', fetchMock)
    const { getByTestId, getByPlaceholderText, getByText } = renderWorkspace()
    fireEvent.click(getByTestId('open-generate'))
    fireEvent.change(getByPlaceholderText('canvas.generate.placeholder'), {
      target: { value: 'x' },
    })
    await act(async () => {
      fireEvent.click(getByText('canvas.generate.go'))
    })
    await act(async () => {
      fireEvent.click(getByText('canvas.generate.cancel'))
    })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) =>
          String(c[0]).includes('/api/canvas/ai/job/job-9/cancel'),
        ),
      ).toBe(true),
    )
  })

  it('navigating away (unmount) does NOT cancel the job — it keeps running server-side', async () => {
    const fetchMock = runningJobFetch('job-7')
    vi.stubGlobal('fetch', fetchMock)
    const { unmount, getByTestId, getByPlaceholderText, getByText } = renderWorkspace()
    fireEvent.click(getByTestId('open-generate'))
    fireEvent.change(getByPlaceholderText('canvas.generate.placeholder'), {
      target: { value: 'x' },
    })
    await act(async () => {
      fireEvent.click(getByText('canvas.generate.go'))
    })
    unmount()
    await new Promise((r) => setTimeout(r, 30))
    // The whole point of the refactor: unmount must NEVER cancel the run.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/cancel'))).toBe(false)
  })

  it('Cancel during the start POST still kills the job it creates (race)', async () => {
    let resolveGen!: () => void
    const genGate = new Promise<void>((r) => {
      resolveGen = r
    })
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
      if (u.includes('/api/canvas/ai/generate'))
        // Hold the POST open until we release it (so we can cancel mid-flight).
        return genGate.then(() => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ jobId: 'job-r' }),
        }))
      if (u.includes('/cancel')) return reply(200, { ok: true })
      return reply(200, {})
    })
    vi.stubGlobal('fetch', fetchMock)
    const { getByTestId, getByPlaceholderText, getByText } = renderWorkspace()
    fireEvent.click(getByTestId('open-generate'))
    fireEvent.change(getByPlaceholderText('canvas.generate.placeholder'), {
      target: { value: 'x' },
    })
    // Go — the generate POST is held; the bar is pending + cancellable.
    fireEvent.click(getByText('canvas.generate.go'))
    await act(async () => {
      fireEvent.click(getByText('canvas.generate.cancel'))
    })
    // Now let the POST resolve with the jobId — submit must cancel it.
    await act(async () => {
      resolveGen()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) =>
          String(c[0]).includes('/api/canvas/ai/job/job-r/cancel'),
        ),
      ).toBe(true),
    )
  })
})
