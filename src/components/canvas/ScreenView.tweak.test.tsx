// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import type { CanvasElement } from '@/lib/types'

// The Screen/Mock in-tile "tweak" flow (useInspectTweak, in ScreenView) must
// match the Canvas generate bar: a signed-out 503 routes to a "sign in to
// Claude" CTA (the SAME /api/terminal/claude-login terminal the Board drawer +
// generate bar use) instead of a generic error. claudeMissing keeps its own
// install-guidance copy; the success path (rewritten source → onChangeText) is
// unchanged.

// t(key) → key, so assertions match message keys (mirrors the other canvas suites).
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
// The login terminal pane is SSE-backed; stub it to a marker carrying its id.
vi.mock('./ClaudeTerminalPane', () => ({
  ClaudeTerminalPane: ({ terminalId }: { terminalId: string }) => (
    <div data-testid="login-terminal">{terminalId}</div>
  ),
}))

import { ScreenView } from './ScreenView'

const makeElement = (): CanvasElement => ({
  id: 's1',
  type: 'screen',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  text: 'export default function S(){ return <button>Hi</button> }',
})

const renderScreen = (onChangeText = vi.fn()) => ({
  onChangeText,
  ...render(
    <ScreenView
      element={makeElement()}
      selected
      editing={false}
      onPointerDown={() => {}}
      onChangeText={onChangeText}
      onEditDone={() => {}}
      ring=""
      projectPath="/tmp/proj"
    />,
  ),
})

// Enter tweak mode, then replay the "pick" the inspect bridge posts from inside
// the sandboxed iframe. The hook only accepts picks whose `source` is OUR
// iframe's contentWindow, so we read it off the rendered iframe and pass it
// verbatim — matching whatever jsdom assigns (a Window, or null for a sandboxed
// frame; either way the test value === the hook's value, so the guard passes).
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
      if (String(url).includes('/api/canvas/tweak-screen')) {
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
        if (String(url).includes('/api/canvas/tweak-screen')) {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: () => Promise.resolve({ error: 'no cli', claudeMissing: true }),
          })
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
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

describe('ScreenView tweak — success flow (no regression)', () => {
  it('routes the rewritten source through onChangeText and shows the applied notice', async () => {
    const NEW_SOURCE = 'export default function S(){ return <button>Bigger</button> }'
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (String(url).includes('/api/canvas/tweak-screen')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ source: NEW_SOURCE }),
          })
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
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

    // Same persistence path as a manual edit — the rewritten source flows out.
    await waitFor(() => expect(onChangeText).toHaveBeenCalled())
    expect(onChangeText).toHaveBeenCalledWith(NEW_SOURCE)
    // Success notice; no sign-in CTA and no error.
    expect(await findByText('canvasEl.tweak.applied')).toBeTruthy()
    expect(queryByText('canvas.generate.signIn')).toBeNull()
    expect(queryByText('canvasEl.tweak.error')).toBeNull()
  })
})
