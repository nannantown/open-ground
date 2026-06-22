// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import type { CanvasElement } from '@/lib/types'

// The Screen/Mock in-tile "tweak" flow (useInspectTweak, in ScreenView) now
// drives a SERVER-SIDE JOB, matching the Canvas generate bar: the POST returns
// a { jobId } fast and the run survives the tile unmounting — the hook starts
// the job and POLLS it for the result, never holding the request open. A
// signed-out 503 still routes to the "sign in to Claude" CTA; claudeMissing
// keeps its install copy; and the rewritten source (job done) flows out through
// onChangeText, exactly like a manual edit.

// t(key) → key, so assertions match message keys (mirrors the other canvas suites).
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
// The login terminal pane is SSE-backed; stub it to a marker carrying its id.
vi.mock('./ClaudeTerminalPane', () => ({
  ClaudeTerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="login-terminal">{terminalId}</div>
  ),
}))

import { ScreenView } from './ScreenView'
import { CanvasAssetProvider } from './CanvasAssetContext'

const makeElement = (): CanvasElement => ({
  id: 's1',
  type: 'screen',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  text: 'export default function S(){ return <button>Hi</button> }',
})

// The hook reads canvasId from CanvasAssetProvider (the persistence target of
// the tweak job), so the tile must be wrapped in it.
const renderScreen = (onChangeText = vi.fn()) => ({
  onChangeText,
  ...render(
    <CanvasAssetProvider value={{ projectPath: '/tmp/proj', canvasId: 'c1' }}>
      <ScreenView
        element={makeElement()}
        selected
        editing={false}
        onPointerDown={() => {}}
        onChangeText={onChangeText}
        onEditDone={() => {}}
        ring=""
        projectPath="/tmp/proj"
      />
    </CanvasAssetProvider>,
  ),
})

const reply = (status: number, body: unknown) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) })

// Enter tweak mode, then replay the "pick" the inspect bridge posts from inside
// the sandboxed iframe (the hook only accepts picks from OUR iframe, so we read
// it off the rendered iframe and pass it verbatim).
const enterTweakAndPick = (
  container: HTMLElement,
  getByText: (t: string) => HTMLElement,
) => {
  fireEvent.click(getByText('canvasEl.tweak.enter'))
  const iframe = container.querySelector('iframe') as HTMLIFrameElement
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          og: 'pick',
          payload: {
            tag: 'button',
            classes: 'btn',
            text: 'Hi',
            html: '<button>Hi</button>',
          },
        },
        source: iframe.contentWindow,
      }),
    )
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ScreenView tweak — claudeLoggedOut handling', () => {
  it('a signed-out 503 shows the sign-in CTA (not a generic error) and opens the login terminal', async () => {
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
      if (u.includes('/api/canvas/ai/tweak'))
        return reply(503, { error: 'signed out', claudeLoggedOut: true })
      if (u.includes('/api/terminal/claude-login')) return reply(200, { id: 'login-pty-1' })
      return reply(200, {})
    })
    vi.stubGlobal('fetch', fetchMock)

    const { container, getByText, getByPlaceholderText, queryByText, findByText, findByTestId } =
      renderScreen()
    enterTweakAndPick(container, getByText)

    fireEvent.change(getByPlaceholderText('canvasEl.tweak.placeholder'), {
      target: { value: 'make this button bigger' },
    })
    await act(async () => {
      fireEvent.click(getByText('canvasEl.tweak.send'))
    })

    // The sign-in CTA, NOT the generic failure copy.
    expect(await findByText('canvas.generate.signIn')).toBeTruthy()
    expect(queryByText('canvasEl.tweak.error')).toBeNull()

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
        if (u.includes('/api/canvas/ai/tweak'))
          return reply(503, { error: 'no cli', claudeMissing: true })
        return reply(200, {})
      }),
    )

    const { container, getByText, getByPlaceholderText, queryByText, findByText } = renderScreen()
    enterTweakAndPick(container, getByText)
    fireEvent.change(getByPlaceholderText('canvasEl.tweak.placeholder'), {
      target: { value: 'tweak me' },
    })
    await act(async () => {
      fireEvent.click(getByText('canvasEl.tweak.send'))
    })

    expect(await findByText('canvasEl.tweak.claudeMissing')).toBeTruthy()
    expect(queryByText('canvas.generate.signIn')).toBeNull()
  })
})

describe('ScreenView tweak — success flow (job completes)', () => {
  it('polls the job and routes the rewritten source through onChangeText, with the applied notice', async () => {
    const NEW_SOURCE = 'export default function S(){ return <button>Bigger</button> }'
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const u = String(url)
        if (u.includes('/api/canvas/ai/active')) return reply(200, { jobs: [] })
        if (u.includes('/api/canvas/ai/tweak')) return reply(200, { jobId: 'tj1' })
        if (u.includes('/api/canvas/ai/job/')) {
          return reply(200, {
            id: 'tj1',
            kind: 'tweak',
            canvasId: 'c1',
            elementId: 's1',
            status: 'done',
            startedAt: '2026-01-01T00:00:00.000Z',
            elapsedMs: 1000,
            source: NEW_SOURCE,
          })
        }
        return reply(200, {})
      }),
    )

    const { container, onChangeText, getByText, getByPlaceholderText, queryByText, findByText } =
      renderScreen()
    enterTweakAndPick(container, getByText)
    fireEvent.change(getByPlaceholderText('canvasEl.tweak.placeholder'), {
      target: { value: 'make the button say Bigger' },
    })
    await act(async () => {
      fireEvent.click(getByText('canvasEl.tweak.send'))
    })

    // Same persistence path as a manual edit — the rewritten source flows out
    // once the job completes.
    await waitFor(() => expect(onChangeText).toHaveBeenCalledWith(NEW_SOURCE))
    // Success notice; no sign-in CTA and no error.
    expect(await findByText('canvasEl.tweak.applied')).toBeTruthy()
    expect(queryByText('canvas.generate.signIn')).toBeNull()
    expect(queryByText('canvasEl.tweak.error')).toBeNull()
  })
})
