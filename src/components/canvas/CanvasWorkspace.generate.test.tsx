// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import type { CanvasFile } from '@/lib/types'

// The Canvas "✦ Generate with Claude" bar (CanvasWorkspace) must read as ALIVE,
// not frozen: a whole claude session runs 30s–3min, so the pending bar shows a
// label + a ticking elapsed-seconds counter, and a signed-out 503 routes to a
// "sign in to Claude" CTA (the SAME /api/terminal/claude-login terminal the
// Board drawer uses) instead of a generic error. claudeMissing keeps its own
// install-guidance copy; the success insert flow is unchanged.

// t(key) → key, so assertions match message keys (mirrors the other canvas suites).
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
// Heavy / side-effecting children are irrelevant to the generate-bar logic:
// the surface (canvas/WebGL), the docked panels (portal'd, not mounted here),
// and the login terminal pane (SSE). Stub them all.
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

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CanvasWorkspace — generation progress', () => {
  it('shows a live elapsed-seconds counter (not a bare spinner) while generating', () => {
    vi.useFakeTimers()
    // A generation that never resolves keeps the bar in its pending state.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))

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

    // The counter ticks every second.
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
      if (String(url).includes('/api/canvas/generate-elements')) {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: 'signed out', claudeLoggedOut: true }),
        })
      }
      if (String(url).includes('/api/terminal/claude-login')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'login-pty-1' }),
        })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
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
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({ error: 'no cli', claudeMissing: true }),
        }),
      ),
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

describe('CanvasWorkspace — success flow (no regression)', () => {
  it('inserts the generated elements and closes the bar on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              elements: [
                { id: 'g1', type: 'text', x: 0, y: 0, width: 120, height: 40, text: 'Hello' },
              ],
            }),
        }),
      ),
    )

    const { onChange, getByTestId, getByPlaceholderText, getByText, queryByText } = renderWorkspace()
    fireEvent.click(getByTestId('open-generate'))
    fireEvent.change(getByPlaceholderText('canvas.generate.placeholder'), {
      target: { value: 'a hello label' },
    })
    await act(async () => {
      fireEvent.click(getByText('canvas.generate.go'))
    })

    // The element lands on the canvas (onChange with one text element) …
    await waitFor(() => expect(onChange).toHaveBeenCalled())
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0] as CanvasFile
    expect(lastCall.elements).toHaveLength(1)
    expect(lastCall.elements[0].type).toBe('text')
    // … and the bar closes (no error, no sign-in CTA).
    expect(queryByText('canvas.generate.signIn')).toBeNull()
    expect(queryByText('canvas.generate.error')).toBeNull()
  })
})
