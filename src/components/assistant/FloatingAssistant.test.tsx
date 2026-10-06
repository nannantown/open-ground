// @vitest-environment jsdom
// The floating assistant: reachable from any screen, the talk is the one log on
// this Mac (shared with the iPhone), and closing the window never drops a line
// that is still being answered.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const ui = vi.hoisted(() => ({ lang: 'ja' }))
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k, lang: ui.lang }) }))

import { EXPANDED_KEY, FloatingAssistant, clampPos, panelPlacement } from './FloatingAssistant'

interface Line { id: string; at: number; who: 'owner' | 'assistant'; text: string }
let log: Line[]
let cfg: { name: string; look: string }
let status: number
let answer: { resolve: () => void } | null
/** Extra fields of the next answers. */
let sayExtra: Record<string, unknown> = {}
/** The proposals the server lists with the log (the frames). */
let proposals: Record<string, unknown>[] = []

const json = (body: unknown, s = 200) => ({ ok: s < 400, status: s, json: async () => body }) as Response

// jsdom has no pointer capture; user-event's real clicks press the character.
Element.prototype.setPointerCapture ??= () => {}

beforeEach(() => {
  log = [{ id: 'a', at: 1, who: 'assistant', text: '昨日のつづきです' }]
  cfg = { name: 'ノノ', look: 'moss' }
  status = 200
  answer = null
  sayExtra = {}
  proposals = []
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (status !== 200) return json({ error: 'owner only' }, status)
    if (url.endsWith('/log')) return json({ entries: log, ...cfg, logDays: 30, memoryChars: 4000, proposals })
    if (url.endsWith('/config')) {
      Object.assign(cfg, JSON.parse(String(init?.body)))
      return json(cfg)
    }
    if (/\/proposals\/[^/]+\/(approve|drop)$/.test(url)) {
      proposals = proposals.map((p) => ({ ...p, state: url.endsWith('/drop') ? 'dropped' : 'done' }))
      return json({ ok: true, proposals })
    }
    if (url.endsWith('/say')) {
      const text = JSON.parse(String(init?.body)).text as string
      await new Promise<void>((resolve) => (answer = { resolve }))
      log = [...log, { id: `o${log.length}`, at: 2, who: 'owner', text }, { id: `r${log.length}`, at: 3, who: 'assistant', text: `答え:${text}` }]
      return json({ reply: `答え:${text}`, ...sayExtra })
    }
    return json({}, 404)
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const character = () => screen.getByRole('button', { name: 'ノノ' })

describe('FloatingAssistant', () => {
  it('shows nothing where the assistant routes refuse this machine (not the owner)', async () => {
    status = 403
    const { container } = render(<FloatingAssistant disabled={false} />)
    await act(async () => {})
    expect(container.innerHTML).toBe('')
  })

  it('opens on a click, shows the shared log (once unfolded) under the owner-given name, closes on Esc', async () => {
    render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    const dialog = screen.getByRole('dialog', { name: 'ノノ' })
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.showTalk' }))
    expect(await screen.findByText('昨日のつづきです')).toBeTruthy()
    expect(dialog.textContent).toContain('ノノ')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(character())
  })

  it('a line sent, then the window closed: the answer still lands, marked unread, and is there on reopening', async () => {
    render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    const input = screen.getByRole('textbox', { name: 'misc.assistant.message' })
    fireEvent.change(input, { target: { value: '明日の予定は?' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText('明日の予定は?')).toBeTruthy()
    expect(screen.getByTestId('assistant-thinking')).toBeTruthy()

    fireEvent.click(character()) // close while it is answering
    expect(screen.queryByRole('dialog')).toBeNull()
    await waitFor(() => expect(answer).not.toBeNull())
    await act(async () => answer!.resolve())
    expect(await screen.findByTestId('assistant-unread')).toBeTruthy()

    fireEvent.click(character())
    expect(await screen.findByText('答え:明日の予定は?')).toBeTruthy()
    expect(screen.queryByTestId('assistant-unread')).toBeNull()
  })

  it('a failed line comes back into the input with a plain reason', async () => {
    render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    const input = screen.getByRole('textbox', { name: 'misc.assistant.message' }) as HTMLInputElement
    vi.mocked(fetch).mockImplementationOnce(async () => json({ error: 'busy', detail: 'いま手がふさがっています' }, 429))
    fireEvent.change(input, { target: { value: 'やあ' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText('いま手がふさがっています')).toBeTruthy()
    expect(input.value).toBe('やあ')
  })

  it('a line that failed after it was logged is not given back (no double line); a refused one is', async () => {
    render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    const input = screen.getByRole('textbox', { name: 'misc.assistant.message' }) as HTMLInputElement
    vi.mocked(fetch).mockImplementationOnce(async () => json({ error: 'timeout', detail: '時間内に答えられませんでした' }, 502))
    fireEvent.change(input, { target: { value: 'ひとつめ' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText('時間内に答えられませんでした')).toBeTruthy()
    expect(input.value).toBe('')
    vi.mocked(fetch).mockImplementationOnce(async () => json({ error: 'too-long', max: 2000 }, 400))
    fireEvent.change(input, { target: { value: 'ふたつめ' } })
    fireEvent.submit(input.closest('form')!)
    expect(await screen.findByText('misc.assistant.tooLong')).toBeTruthy()
    expect(input.value).toBe('ふたつめ')
  })

  it('leaves the screen once the routes refuse this machine (signed out)', async () => {
    const { container } = render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    const input = screen.getByRole('textbox', { name: 'misc.assistant.message' })
    status = 403
    fireEvent.change(input, { target: { value: 'やあ' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(container.innerHTML).toBe(''))
  })

  it('Esc inside the window closes it before the app underneath sees it; an IME Esc does not', async () => {
    const underneath = vi.fn()
    window.addEventListener('keydown', underneath)
    try {
      render(<FloatingAssistant disabled={false} />)
      fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
      const send = screen.getByRole('button', { name: 'misc.assistant.send' })
      fireEvent.keyDown(send, { key: 'Escape', isComposing: true })
      expect(screen.getByRole('dialog')).toBeTruthy()
      underneath.mockClear()
      fireEvent.keyDown(send, { key: 'Escape' })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(underneath).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', underneath)
    }
  })

  // Real clicks move focus (user-event): a click on the talk, or a mouse send that
  // disables the send button, must not drop focus to <body> — where Esc would go
  // to the app underneath and close the project instead of the window.
  const escKeepsToTheWindow = async (user: ReturnType<typeof userEvent.setup>) => {
    const underneath = vi.fn()
    window.addEventListener('keydown', underneath)
    try {
      expect(document.activeElement).not.toBe(document.body)
      await user.keyboard('{Escape}')
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(underneath).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', underneath)
    }
  }

  it('a click on the talk keeps Esc for the window', async () => {
    localStorage.setItem(EXPANDED_KEY, '1')
    const user = userEvent.setup()
    render(<FloatingAssistant disabled={false} />)
    await user.click(await screen.findByRole('button', { name: 'ノノ' }))
    await user.click(await screen.findByText('昨日のつづきです'))
    await escKeepsToTheWindow(user)
  })

  it('a mouse send keeps focus in the window (the input), so Esc is still the window’s', async () => {
    const user = userEvent.setup()
    render(<FloatingAssistant disabled={false} />)
    await user.click(await screen.findByRole('button', { name: 'ノノ' }))
    const input = screen.getByRole('textbox', { name: 'misc.assistant.message' })
    await user.type(input, 'やあ')
    await user.click(screen.getByRole('button', { name: 'misc.assistant.send' }))
    expect(await screen.findByTestId('assistant-thinking')).toBeTruthy()
    expect(document.activeElement).toBe(input)
    await escKeepsToTheWindow(user)
    await waitFor(() => expect(answer).not.toBeNull())
    await act(async () => answer!.resolve())
  })

  it('Esc in the name field undoes the edit and leaves focus in the window', async () => {
    const user = userEvent.setup()
    render(<FloatingAssistant disabled={false} />)
    await user.click(await screen.findByRole('button', { name: 'ノノ' }))
    const look = screen.getByRole('button', { name: 'misc.assistant.look' })
    await user.click(look)
    await user.click(screen.getByRole('textbox', { name: 'misc.assistant.name' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('textbox', { name: 'misc.assistant.name' })).toBeNull()
    expect(document.activeElement).toBe(look)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('a failed first read is asked again, so the assistant still appears', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      status = 500
      render(<FloatingAssistant disabled={false} />)
      await act(async () => {})
      expect(screen.queryByRole('button', { name: 'ノノ' })).toBeNull()
      status = 200
      await act(async () => void (await vi.advanceTimersByTimeAsync(3_000)))
      expect(await screen.findByRole('button', { name: 'ノノ' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('work mode closes an open window, and it stays closed after', async () => {
    const { rerender } = render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    rerender(<FloatingAssistant disabled />)
    rerender(<FloatingAssistant disabled={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('the name and colour are saved for the Mac and the phone alike', async () => {
    render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.look' }))
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.color.ochre' }))
    await waitFor(() => expect(cfg.look).toBe('ochre'))
    const name = screen.getByRole('textbox', { name: 'misc.assistant.name' })
    fireEvent.change(name, { target: { value: 'ハル' } })
    fireEvent.blur(name)
    await waitFor(() => expect(cfg.name).toBe('ハル'))
    expect(await screen.findByRole('button', { name: 'ハル' })).toBeTruthy()
  })

  it('is held still and cannot be opened in work mode', async () => {
    render(<FloatingAssistant disabled />)
    const b = (await screen.findByRole('button', { name: 'ノノ' })) as HTMLButtonElement
    expect(b.disabled).toBe(true)
    fireEvent.click(b)
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('where it sits and where the window opens', () => {
  it('stays on screen however small the window gets', () => {
    expect(clampPos({ right: 5000, bottom: -40 }, 800, 600)).toEqual({ right: 800 - 50 - 12, bottom: 12 })
  })

  it('opens the window on the side with room: above and leftward from the bottom-right corner', () => {
    const p = panelPlacement({ right: 20, bottom: 64 }, 1200, 800)
    expect(p).toMatchObject({ right: 20, bottom: 64 + 50 + 10, width: 340 })
    expect(p).not.toHaveProperty('top')
    expect(p).not.toHaveProperty('left')
  })

  it('below and rightward from the top-left corner', () => {
    const p = panelPlacement({ right: 1200 - 50 - 20, bottom: 800 - 50 - 20 }, 1200, 800)
    expect(p).toMatchObject({ left: 20, top: 20 + 50 + 10 })
  })
})

describe('it never takes the app’s keys', () => {
  it('with the window open but focus outside it, Esc reaches the app and no overlay is claimed', async () => {
    render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    // [data-esc-overlay] would make every app Esc handler yield to the window.
    expect(document.querySelector('[data-esc-overlay]')).toBeNull()
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const app = vi.fn((e: KeyboardEvent) => e.defaultPrevented)
    window.addEventListener('keydown', app)
    try {
      outside.focus()
      fireEvent.keyDown(outside, { key: 'Escape' })
      expect(app).toHaveBeenCalledTimes(1)
      expect(app.mock.results[0].value).toBe(false) // not swallowed on the way
      expect(screen.getByRole('dialog')).toBeTruthy()
    } finally {
      window.removeEventListener('keydown', app)
      outside.remove()
    }
  })
})

describe('the first read retries a failure, and stops', () => {
  const reads = () =>
    (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([u]) => String(u).endsWith('/log')).length
  const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)))

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('a refusal (403) after a 500 ends the retries', async () => {
    status = 500
    const { container } = render(<FloatingAssistant disabled={false} />)
    await advance(0)
    expect(reads()).toBe(1)
    status = 403
    await advance(3_000)
    expect(reads()).toBe(2)
    await advance(10 * 60_000)
    expect(reads()).toBe(2)
    expect(container.innerHTML).toBe('')
  })

  it('unmounting after a 500 stops it asking', async () => {
    status = 500
    const { unmount } = render(<FloatingAssistant disabled={false} />)
    await advance(0)
    expect(reads()).toBe(1)
    unmount()
    await advance(10 * 60_000)
    expect(reads()).toBe(1)
  })

  it('a server that keeps failing is asked less and less often', async () => {
    status = 500
    render(<FloatingAssistant disabled={false} />)
    await advance(0)
    await advance(3_000)
    expect(reads()).toBe(2)
    await advance(5_000) // the next wait is 6 s, not 3
    expect(reads()).toBe(2)
    await advance(1_000)
    expect(reads()).toBe(3)
    // 3+6+12+24+48 s, then once a minute: ~14 reads in 10 minutes, not ~200.
    await advance(10 * 60_000)
    expect(reads()).toBeLessThanOrEqual(15)
  })
})

// The window says what it is for in one faint line, keeps the talk folded until
// the owner asks for it, and can be talked to by voice (owner 2026-10-04).
describe('FloatingAssistant: the faint line, the folded talk, voice', () => {
  class FakeES {
    static all: FakeES[] = []
    closed = false
    onmessage: ((m: { data: string }) => void) | null = null
    onerror: (() => void) | null = null
    constructor(public url: string) {
      FakeES.all.push(this)
    }
    close() {
      this.closed = true
    }
    emit(e: object) {
      act(() => this.onmessage?.({ data: JSON.stringify(e) }))
    }
  }
  const ears = () => FakeES.all.filter((e) => !e.closed)
  class FakeUtterance {
    lang = ''
    onstart: (() => void) | null = null
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(public text: string) {}
  }
  let synth: { speak: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn>; speaking: boolean; pending: boolean }
  const spoken = () => synth.speak.mock.calls.map(([u]) => (u as FakeUtterance).text)

  beforeEach(() => {
    FakeES.all = []
    ui.lang = 'ja'
    // Nothing else is speaking until a test says so; ours starts at once.
    synth = {
      speak: vi.fn((u: FakeUtterance) => {
        synth.speaking = true
        u.onstart?.()
      }),
      cancel: vi.fn(),
      speaking: false,
      pending: false,
    }
    vi.stubGlobal('EventSource', FakeES)
    vi.stubGlobal('speechSynthesis', synth)
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance)
    Object.assign(cfg, { voice: true })
  })

  const open = async () => {
    render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    return screen.getByRole('dialog', { name: 'ノノ' })
  }
  const input = () => screen.getByRole('textbox', { name: 'misc.assistant.message' }) as HTMLInputElement
  const mic = () => screen.getByRole('button', { name: /misc\.assistant\.dictate(On|Off)/ })
  const says = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/say'))
  const call = () => fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.call' }))
  const callState = () => screen.getByRole('status').textContent
  const answerNow = async () => {
    await waitFor(() => expect(answer).not.toBeNull())
    await act(async () => answer!.resolve())
    answer = null
  }

  it('an empty input shows only the faint "say something" line — no history, no greeting', async () => {
    const dialog = await open()
    expect(input().placeholder).toBe('misc.assistant.placeholder')
    expect(input().className).toContain('placeholder:text-ink-faint')
    expect(dialog.textContent).not.toContain('昨日のつづきです')
    expect(screen.queryByTestId('assistant-talk')).toBeNull()
  })

  it('the talk unfolds only when asked, folds again, and the choice is kept', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.showTalk' }))
    expect(await screen.findByText('昨日のつづきです')).toBeTruthy()
    cleanup()
    await open()
    expect(screen.getByText('昨日のつづきです')).toBeTruthy() // remembered
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.hideTalk' }))
    expect(screen.queryByText('昨日のつづきです')).toBeNull()
    cleanup()
    await open()
    expect(screen.queryByText('昨日のつづきです')).toBeNull()
  })

  it('folded, the window shows just the exchange made now, gone after closing', async () => {
    await open()
    fireEvent.change(input(), { target: { value: 'やあ' } })
    fireEvent.submit(input().closest('form')!)
    await answerNow()
    expect(await screen.findByText('答え:やあ')).toBeTruthy()
    expect(screen.queryByText('昨日のつづきです')).toBeNull()
    fireEvent.click(character())
    fireEvent.click(character())
    expect(screen.queryByText('答え:やあ')).toBeNull()
  })

  /** The layout jsdom does not do: the window has `room` px left for the frames'
   *  box (less if the box is given a smaller max-height), which starts 500 px down
   *  the screen; each frame is `frame` px tall, 10 px apart. */
  const layout = (room: number, frame = 100) => {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    const real = Element.prototype.getBoundingClientRect
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get(this: HTMLElement) { return this.dataset.testid === 'assistant-proposals' ? Math.min(room, parseFloat(this.style.maxHeight) || Infinity) : 0 } })
    Element.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.dataset?.testid === 'assistant-proposals') return rect(500, this.clientHeight)
      if (this.dataset?.proposal) return rect(500 + Array.from(this.parentElement?.children ?? []).indexOf(this) * (frame + 10), frame)
      return real.call(this)
    }
    return () => {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight
      Element.prototype.getBoundingClientRect = real
    }
  }
  const card = { id: 'prop-1', kind: 'card', projectId: 'p-beta', project: 'beta', title: 'ログインを直す', body: 'やること: 固まらない\n完了の条件:\n- テスト緑', at: 1, expiresAt: Date.now() + 600_000, state: 'open' }
  const sha = async (parts: string[]) => (await import('crypto')).createHash('sha256').update(parts.join('\n')).digest('hex')
  const presses = () => vi.mocked(fetch).mock.calls.filter(([u]) => /\/proposals\//.test(String(u)))

  it('a proposal shows in its own frame above the input, outside the talk; 「出す」 sends the check of the text the frame shows — a typed yes sends nothing', async () => {
    const undo = layout(300)
    try {
      proposals = [card]
      await open()
      fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.showTalk' }))
      const frame = await screen.findByRole('region', { name: 'misc.assistant.proposalCard' })
      expect(frame.textContent).toContain('ログインを直す')
      expect(frame.textContent).toContain('- テスト緑')
      expect(frame.closest('[data-testid="assistant-talk"]')).toBeNull()
      // Right above the input row.
      expect(screen.getByTestId('assistant-proposals').nextElementSibling?.contains(input())).toBe(true)
      // A typed yes is only a line to the assistant.
      fireEvent.change(input(), { target: { value: 'うん' } })
      fireEvent.submit(input().closest('form')!)
      await answerNow()
      expect(Object.keys(JSON.parse(String(says()[0][1]?.body))).sort()).toEqual(['stream', 'text'])
      expect(presses()).toEqual([])
      fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.proposalAdd' }))
      await waitFor(() => expect(presses()).toHaveLength(1))
      expect(String(presses()[0][0])).toBe('/api/phone-link/assistant/proposals/prop-1/approve')
      expect(JSON.parse(String(presses()[0][1]?.body))).toEqual({ hash: await sha(['card', 'p-beta', 'beta', 'ログインを直す', 'やること: 固まらない\n完了の条件:\n- テスト緑']) })
      // Done: faded, no buttons.
      // Done: one faded line, no frame, no buttons.
      await waitFor(() => expect(document.querySelector('[data-proposal="prop-1"]')?.getAttribute('data-state')).toBe('closed'))
      expect(screen.queryByRole('region', { name: 'misc.assistant.proposalCard' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'misc.assistant.proposalAdd' })).toBeNull()
    } finally {
      undo()
    }
  })

  it('a frame not seen whole cannot be pressed (and says to ask the president); nor where the layout cannot be measured; an expired one has no buttons', async () => {
    for (const room of [150, 0]) {
      const undo = layout(room)
      try {
        proposals = [{ ...card, id: 'a' }, { ...card, id: 'b', title: '二つ目' }]
        await open()
        const adds = await screen.findAllByRole('button', { name: 'misc.assistant.proposalAdd' })
        // 150 px: the first (0–100) fits, the second (110–210) is cut. 0: none can be measured.
        expect([room, adds.map((b) => (b as HTMLButtonElement).disabled)]).toEqual([room, room ? [false, true] : [true, true]])
        expect(screen.getByText('misc.assistant.proposalTooLong')).toBeTruthy()
        // Still droppable.
        expect(screen.getAllByRole('button', { name: 'misc.assistant.proposalDrop' }).every((b) => !(b as HTMLButtonElement).disabled)).toBe(true)
      } finally {
        undo()
        cleanup()
      }
    }
    // A line cut sideways (a long name running out of the frame): not pressable.
    const undo = layout(300)
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return this.dataset.part === 'project' ? 400 : 0 } })
    try {
      proposals = [card]
      await open()
      expect((await screen.findByRole('button', { name: 'misc.assistant.proposalAdd' }) as HTMLButtonElement).disabled).toBe(true)
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth
      undo()
      cleanup()
    }
    // No layout at all (nothing can be measured): not pressable.
    proposals = [card]
    await open()
    expect((await screen.findByRole('button', { name: 'misc.assistant.proposalAdd' }) as HTMLButtonElement).disabled).toBe(true)
    cleanup()
    proposals = [{ ...card, expiresAt: Date.now() - 1 }]
    await open()
    await waitFor(() => expect(document.querySelector('[data-proposal]')?.getAttribute('data-state')).toBe('closed'))
    expect(screen.queryByRole('button', { name: 'misc.assistant.proposalAdd' })).toBeNull()
  })

  it('the one faded line is the proposal that closed last (not the last made), and an added one carries the green check', async () => {
    // A made, then B; B dropped first, then A added: the line is A, marked done.
    proposals = [
      { ...card, id: 'a', title: 'A を出した', state: 'done', closedAt: 200 },
      { ...card, id: 'b', title: 'B をやめた', state: 'dropped', closedAt: 100 },
    ]
    await open()
    await waitFor(() => expect(document.querySelector('[data-state="closed"]')?.getAttribute('data-proposal')).toBe('a'))
    expect(screen.getByRole('img', { name: 'misc.assistant.proposalDone' })).toBeTruthy()
    cleanup()
    proposals = [{ ...card, id: 'b', state: 'dropped', closedAt: 100 }]
    await open()
    await waitFor(() => expect(document.querySelector('[data-state="closed"]')).toBeTruthy())
    expect(screen.queryByRole('img', { name: 'misc.assistant.proposalDone' })).toBeNull()
  })

  it('「やめる」 drops it; in a call the frames show too — given the height the window really has left, so a 200 px card can be pressed — and what is said there is just a line', async () => {
    // A two-condition card is ~200 px; the window has 260 px left for it during the call.
    const undo = layout(260, 200)
    try {
      proposals = [card]
      await open()
      call()
      ears()[0].emit({ type: 'ready' })
      ears()[0].emit({ type: 'final', text: 'うん' })
      await waitFor(() => expect(says()).toHaveLength(1))
      expect(Object.keys(JSON.parse(String(says()[0][1]?.body))).sort()).toEqual(['stream', 'text'])
      await answerNow()
      expect(screen.getByTestId('assistant-call')).toBeTruthy()
      await screen.findByRole('region', { name: 'misc.assistant.proposalCard' })
      await waitFor(() => expect((screen.getByRole('button', { name: 'misc.assistant.proposalAdd' }) as HTMLButtonElement).disabled).toBe(false))
      fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.proposalDrop' }))
      await waitFor(() => expect(presses()).toHaveLength(1))
      expect(String(presses()[0][0])).toBe('/api/phone-link/assistant/proposals/prop-1/drop')
    } finally {
      undo()
    }
  })

  it('no mic and no call where this Mac cannot listen', async () => {
    Object.assign(cfg, { voice: false })
    await open()
    expect(screen.queryByRole('button', { name: /misc\.assistant\.dictate/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'misc.assistant.call' })).toBeNull()
    expect(screen.getByRole('button', { name: 'misc.assistant.send' })).toBeTruthy()
  })

  // Chat mode (owner 2026-10-06): the mic only types. Press = on, what is
  // said lands in the input, nothing is sent or read aloud; press again = off.
  it('chat: the mic types what is said into the input — it sends nothing and reads nothing aloud', async () => {
    await open()
    expect(mic().getAttribute('aria-pressed')).toBe('false')
    expect(FakeES.all).toHaveLength(0)

    fireEvent.click(mic())
    expect(mic().getAttribute('aria-pressed')).toBe('true')
    expect(ears()).toHaveLength(1)
    expect(ears()[0].url).toBe('/api/phone-link/assistant/listen?lang=ja')
    ears()[0].emit({ type: 'ready' })
    expect(mic().hasAttribute('data-hearing')).toBe(true)
    ears()[0].emit({ type: 'partial', text: '明日の' })
    expect(input().value).toBe('明日の')
    ears()[0].emit({ type: 'final', text: '明日の予定は?' })
    expect(input().value).toBe('明日の予定は?')
    ears()[0].emit({ type: 'final', text: '会議は何時' })
    expect(input().value).toBe('明日の予定は?会議は何時')
    expect(ears()).toHaveLength(1) // still on
    expect(says()).toHaveLength(0)
    expect(synth.speak).not.toHaveBeenCalled()

    fireEvent.click(mic())
    expect(mic().getAttribute('aria-pressed')).toBe('false')
    expect(ears()).toHaveLength(0) // off = the mic is off
    expect(input().value).toBe('明日の予定は?会議は何時')
  })

  it('chat: English words get a space between utterances', async () => {
    ui.lang = 'en'
    await open()
    fireEvent.click(mic())
    expect(ears()[0].url).toBe('/api/phone-link/assistant/listen?lang=en')
    ears()[0].emit({ type: 'final', text: 'hello' })
    ears()[0].emit({ type: 'final', text: 'there' })
    expect(input().value).toBe('hello there')
  })

  it('chat: sending stops typing by voice, and sends what the input shows — answer not read aloud', async () => {
    await open()
    fireEvent.click(mic())
    ears()[0].emit({ type: 'final', text: 'やあ' })
    ears()[0].emit({ type: 'partial', text: '元気' })
    fireEvent.submit(input().closest('form')!)
    expect(ears()).toHaveLength(0)
    expect(mic().getAttribute('aria-pressed')).toBe('false')
    await answerNow()
    expect(JSON.parse(String(says()[0][1]!.body)).text).toBe('やあ元気')
    expect(await screen.findByText('答え:やあ元気')).toBeTruthy()
    expect(synth.speak).not.toHaveBeenCalled()
  })

  it('chat: stopping the mic keeps the words heard so far; typing over them is not undone', async () => {
    await open()
    fireEvent.click(mic())
    ears()[0].emit({ type: 'partial', text: 'あした' })
    fireEvent.change(input(), { target: { value: 'あした、' } })
    ears()[0].emit({ type: 'final', text: 'あしたの予定' })
    expect(input().value).toBe('あした、の予定')
    ears()[0].emit({ type: 'partial', text: '会議' })
    fireEvent.click(mic())
    expect(input().value).toBe('あした、の予定会議')
  })

  it('chat: no permission — the mic turns itself off and says so plainly (no reconnect loop)', async () => {
    await open()
    fireEvent.click(mic())
    ears()[0].emit({ type: 'error', reason: 'denied' })
    expect(screen.getByText('misc.assistant.voiceDenied')).toBeTruthy()
    expect(mic().getAttribute('aria-pressed')).toBe('false')
    expect(ears()).toHaveLength(0)
    expect(FakeES.all).toHaveLength(1)
  })

  it('chat: a Mac that cannot listen at all says so — without asking to try again', async () => {
    await open()
    fireEvent.click(mic())
    ears()[0].emit({ type: 'error', reason: 'unavailable' })
    expect(screen.getByText('misc.assistant.voiceUnavailable')).toBeTruthy()
    expect(screen.queryByText('misc.assistant.voiceFailed')).toBeNull()
  })

  it('closing the window turns the mic off — without silencing speech that is not its own', async () => {
    await open()
    fireEvent.click(mic())
    fireEvent.click(character())
    expect(ears()).toHaveLength(0)
    expect(synth.cancel).not.toHaveBeenCalled() // e.g. a Research digest being read
    fireEvent.click(character())
    expect(mic().getAttribute('aria-pressed')).toBe('false')
  })

  // Call mode (iPhone CallView): talk, the answer comes back aloud; speaker,
  // mute and end. The call key sits where send is while the input is empty.
  it('call: the empty input offers a call; typing turns that key into send', async () => {
    await open()
    expect(screen.getByRole('button', { name: 'misc.assistant.call' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'misc.assistant.send' })).toBeNull()
    fireEvent.change(input(), { target: { value: 'やあ' } })
    expect(screen.queryByRole('button', { name: 'misc.assistant.call' })).toBeNull()
    expect(screen.getByRole('button', { name: 'misc.assistant.send' })).toBeTruthy()
  })

  it('call: what is said is sent and the answer comes back aloud; the mic is shut while it thinks and speaks', async () => {
    await open()
    call()
    expect(screen.getByTestId('assistant-call')).toBeTruthy()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(callState()).toBe('misc.assistant.callConnecting')
    expect(ears()).toHaveLength(1)
    ears()[0].emit({ type: 'ready' })
    expect(callState()).toBe('misc.assistant.callHearing')

    ears()[0].emit({ type: 'final', text: '明日の予定は?' })
    await waitFor(() => expect(says()).toHaveLength(1))
    expect(callState()).toBe('misc.assistant.callThinking')
    expect(ears()).toHaveLength(0)
    await answerNow()
    await waitFor(() => expect(spoken()).toEqual(['答え:明日の予定は?']))
    expect(synth.cancel).not.toHaveBeenCalled() // whatever was already speaking (Research) is not cut
    expect((synth.speak.mock.calls[0][0] as FakeUtterance).lang).toBe('ja-JP')
    expect(callState()).toBe('misc.assistant.callSpeaking')
    expect(ears()).toHaveLength(0) // the mic would hear the reply
    act(() => (synth.speak.mock.calls[0][0] as FakeUtterance).onend!())
    expect(ears()).toHaveLength(1)
  })

  it('call: a "let me look" is read the moment it comes; the answer reads only its short spoken part', async () => {
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined
    const enc = new TextEncoder()
    const line = (o: object) => enc.encode(JSON.stringify(o) + '\n')
    const base = vi.mocked(fetch).getMockImplementation()!
    vi.mocked(fetch).mockImplementation(async (url, init) =>
      String(url).endsWith('/say') ? new Response(new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) })) : base(url as never, init),
    )
    await open()
    call()
    ears()[0].emit({ type: 'ready' })
    ears()[0].emit({ type: 'final', text: '記録どこ?' })
    await waitFor(() => expect(ctl).toBeDefined())
    act(() => ctl!.enqueue(line({ interim: 'ちょっと待ってね' })))
    await waitFor(() => expect(spoken()).toEqual(['ちょっと待ってね']))
    // The answer comes while that line is still being said: it waits its turn, nothing is cut.
    act(() => {
      ctl!.enqueue(line({ reply: 'assistant フォルダにあるよ。\n\nlog/ と memory.md', speak: 'assistant フォルダにあるよ。' }))
      ctl!.close()
    })
    // The answer is in (no longer thinking) while the wait-line still plays.
    await waitFor(() => expect(callState()).toBe('misc.assistant.callSpeaking'))
    expect(spoken()).toEqual(['ちょっと待ってね'])
    expect(synth.cancel).not.toHaveBeenCalled()
    synth.speaking = false
    act(() => (synth.speak.mock.calls[0][0] as FakeUtterance).onend!())
    await waitFor(() => expect(spoken()).toEqual(['ちょっと待ってね', 'assistant フォルダにあるよ。']))
  })

  it('call: speaker off — the answer is not read aloud, and turning it off mid-reply stops the reading', async () => {
    await open()
    call()
    ears()[0].emit({ type: 'final', text: 'ひとつ' })
    await answerNow()
    await waitFor(() => expect(synth.speak).toHaveBeenCalledTimes(1))
    const speakerKey = screen.getByRole('button', { name: 'misc.assistant.speaker' })
    expect(speakerKey.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(speakerKey)
    expect(speakerKey.getAttribute('aria-pressed')).toBe('false')
    expect(synth.cancel).toHaveBeenCalledTimes(1)
    synth.speaking = false
    expect(ears()).toHaveLength(1)
    ears()[0].emit({ type: 'final', text: 'ふたつ' })
    await answerNow()
    await waitFor(() => expect(ears()).toHaveLength(1))
    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('assistant-call').textContent).toContain('答え:ふたつ') // shown, not read
  })

  it('call: mute shuts the mic and says so; unmute opens it again', async () => {
    await open()
    call()
    ears()[0].emit({ type: 'ready' })
    const muteKey = screen.getByRole('button', { name: 'misc.assistant.mute' })
    fireEvent.click(muteKey)
    expect(muteKey.getAttribute('aria-pressed')).toBe('true')
    expect(ears()).toHaveLength(0)
    expect(callState()).toBe('misc.assistant.callMuted')
    fireEvent.click(muteKey)
    expect(ears()).toHaveLength(1)
    expect(callState()).not.toBe('misc.assistant.callMuted')
  })

  it('call: end returns to the chat with the mic off and its own reading stopped', async () => {
    await open()
    call()
    ears()[0].emit({ type: 'final', text: 'やあ' })
    await answerNow()
    await waitFor(() => expect(synth.speak).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.callEnd' }))
    expect(screen.queryByTestId('assistant-call')).toBeNull()
    expect(input()).toBeTruthy()
    expect(ears()).toHaveLength(0)
    expect(synth.cancel).toHaveBeenCalled()
    expect(mic().getAttribute('aria-pressed')).toBe('false')
  })

  it('call: a refused mic shows why and offers to try again — never redials by itself', async () => {
    await open()
    call()
    ears()[0].emit({ type: 'error', reason: 'denied' })
    expect(callState()).toBe('misc.assistant.voiceDenied')
    expect(ears()).toHaveLength(0)
    expect(FakeES.all).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.callRetry' }))
    expect(ears()).toHaveLength(1)
  })

  it('call: a line the assistant could not answer is said on the call screen', async () => {
    await open()
    call()
    status = 500
    ears()[0].emit({ type: 'final', text: 'やあ' })
    expect(await screen.findByText('misc.assistant.failed')).toBeTruthy()
    expect(screen.getByTestId('assistant-call').textContent).toContain('misc.assistant.failed')
  })

  it('call: signing out ends the call and its reading; signing back in does not turn the mic on', async () => {
    const { container } = render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    call()
    ears()[0].emit({ type: 'ready' })
    ears()[0].emit({ type: 'final', text: 'ひとつ' })
    await answerNow()
    await waitFor(() => expect(synth.speak).toHaveBeenCalled())
    status = 403 // the next read of the log is refused (signed out)
    await waitFor(() => expect(container.innerHTML).toBe(''), { timeout: 7000 })
    expect(synth.cancel).toHaveBeenCalled() // the reply stops with it
    expect(ears()).toHaveLength(0)
    const opened = FakeES.all.length
    status = 200 // signed in again: the window comes back…
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'ノノ' })).toBeTruthy(), { timeout: 7000 })
    expect(screen.queryByTestId('assistant-call')).toBeNull() // …in the chat, not the call
    expect(mic().getAttribute('aria-pressed')).toBe('false')
    expect(FakeES.all).toHaveLength(opened) // the mic never came on
  }, 20_000)

  it('call: the assistant going away (re-mounted on sign-out) stops its reading', async () => {
    await open()
    call()
    ears()[0].emit({ type: 'final', text: 'やあ' })
    await answerNow()
    await waitFor(() => expect(synth.speak).toHaveBeenCalled())
    cleanup()
    expect(synth.cancel).toHaveBeenCalled()
  })

  it('call: 聞いています only once the mic says it is ready — not while it reopens after a reply', async () => {
    await open()
    call()
    ears()[0].emit({ type: 'ready' })
    expect(callState()).toBe('misc.assistant.callHearing')
    ears()[0].emit({ type: 'final', text: 'やあ' })
    await answerNow()
    await waitFor(() => expect(synth.speak).toHaveBeenCalled())
    act(() => (synth.speak.mock.calls[0][0] as FakeUtterance).onend!())
    expect(ears()).toHaveLength(1)
    expect(callState()).toBe('misc.assistant.callWaiting') // reopening: words now would be lost
    ears()[0].emit({ type: 'ready' })
    expect(callState()).toBe('misc.assistant.callHearing')
  })

  it('call: closing the window ends it', async () => {
    await open()
    call()
    fireEvent.click(character())
    expect(ears()).toHaveLength(0)
    fireEvent.click(character())
    expect(screen.queryByTestId('assistant-call')).toBeNull()
  })

  it('call: two utterances heard back to back send one line, not two', async () => {
    await open()
    call()
    act(() => {
      ears()[0].onmessage?.({ data: JSON.stringify({ type: 'final', text: 'ひとつめ' }) })
      ears()[0].onmessage?.({ data: JSON.stringify({ type: 'final', text: 'ふたつめ' }) })
    })
    await waitFor(() => expect(answer).not.toBeNull())
    expect(says()).toHaveLength(1)
    await answerNow()
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.callEnd' }))
    expect(input().value).toBe('') // the refused second line does not wait in the input
  })

  it('call: other speech (a Research digest) is never cut or queued behind — the mic stays shut while it plays', async () => {
    synth.speaking = true // someone else is reading
    await open()
    call()
    await act(async () => {})
    expect(ears()).toHaveLength(0) // it would hear the narration
    synth.speaking = false
    await waitFor(() => expect(ears()).toHaveLength(1), { timeout: 1500 })
    ears()[0].emit({ type: 'final', text: 'やあ' })
    await waitFor(() => expect(answer).not.toBeNull())
    synth.speaking = true // the digest starts again while the answer is made
    await answerNow()
    await waitFor(() => expect(screen.getByTestId('assistant-call').textContent).toContain('答え:やあ'))
    expect(synth.speak).not.toHaveBeenCalled() // not queued behind it…
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.callEnd' }))
    expect(synth.cancel).not.toHaveBeenCalled() // …and never cut
  })

  it('call: started while typing by voice, it opens fresh ears and calls first', async () => {
    await open()
    fireEvent.click(mic())
    ears()[0].emit({ type: 'ready' })
    ears()[0].emit({ type: 'partial', text: 'けした' })
    fireEvent.change(input(), { target: { value: '' } })
    expect(input().value).toBe('')
    call()
    expect(FakeES.all).toHaveLength(2)
    expect(FakeES.all[0].closed).toBe(true)
    expect(callState()).toBe('misc.assistant.callConnecting')
  })

  it('call: the call screen takes focus (Esc stays the window’s) and gives it back to the input', async () => {
    const dialog = await open()
    call()
    expect(document.activeElement).toBe(dialog)
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.callEnd' }))
    expect(document.activeElement).toBe(input())
  })

  it('a voice error goes with the call or window it belonged to', async () => {
    await open()
    call()
    ears()[0].emit({ type: 'error', reason: 'denied' })
    fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.callEnd' }))
    expect(screen.queryByText('misc.assistant.voiceDenied')).toBeNull()
    fireEvent.click(mic())
    ears()[0].emit({ type: 'error', reason: 'failed' })
    expect(screen.getByText('misc.assistant.voiceFailed')).toBeTruthy()
    fireEvent.click(character())
    fireEvent.click(character())
    expect(screen.queryByText('misc.assistant.voiceFailed')).toBeNull()
  })

  it('chat: words heard during an IME conversion wait for it to finish', async () => {
    await open()
    fireEvent.click(mic())
    fireEvent.compositionStart(input())
    ears()[0].emit({ type: 'partial', text: 'てすと' })
    expect(input().value).toBe('')
    ears()[0].emit({ type: 'final', text: 'テスト' })
    expect(input().value).toBe('')
    fireEvent.compositionEnd(input())
    expect(input().value).toBe('テスト')
  })

  it('call: if the voice never reports its end, the mic still reopens once it falls quiet', async () => {
    await open()
    call()
    ears()[0].emit({ type: 'final', text: 'やあ' })
    await answerNow()
    await waitFor(() => expect(synth.speak).toHaveBeenCalled())
    expect(ears()).toHaveLength(0)
    synth.speaking = false // finished, but no onend came
    await waitFor(() => expect(ears()).toHaveLength(1), { timeout: 2500 })
  })

  // Release 2 of the voice redesign (docs/research/voice-assistant-2026-10.md §1
  // 「2 回目」, owner 2026-10-07): sentence by sentence as written, a stop key.
  describe('call: read as it is written, and the stop key', () => {
    let ctl: ReadableStreamDefaultController<Uint8Array> | undefined
    const enc = new TextEncoder()
    const put = (o: object) => act(() => ctl!.enqueue(enc.encode(JSON.stringify(o) + '\n')))
    const finish = (o: object) =>
      act(() => {
        ctl!.enqueue(enc.encode(JSON.stringify(o) + '\n'))
        ctl!.close()
      })
    const utter = (i: number) => synth.speak.mock.calls[i][0] as FakeUtterance
    const hushes = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith('/hush')).map(([, i]) => JSON.parse(String(i?.body)))
    beforeEach(() => {
      ctl = undefined
      const base = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (url, init) =>
        String(url).endsWith('/say') ? new Response(new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) })) : base(url as never, init),
      )
      synth.cancel.mockImplementation(() => void (synth.speaking = false))
    })
    const ask = async (text: string) => {
      ctl = undefined
      ears().at(-1)!.emit({ type: 'final', text })
      await waitFor(() => expect(ctl).toBeDefined())
    }

    it('the first sentence is read the moment it comes, the next after it; the answer is not read again', async () => {
      await open()
      call()
      ears()[0].emit({ type: 'ready' })
      await ask('やあ')
      put({ say: 'やあ、元気だよ。' })
      await waitFor(() => expect(spoken()).toEqual(['やあ、元気だよ。']))
      expect(callState()).toBe('misc.assistant.callSpeaking') // speaking while the answer is still written
      put({ say: '今日は晴れ。' })
      expect(spoken()).toEqual(['やあ、元気だよ。']) // its turn comes after, nothing is cut
      finish({ reply: 'やあ、元気だよ。今日は晴れ。', speak: 'やあ、元気だよ。今日は晴れ。', said: true })
      synth.speaking = false
      act(() => utter(0).onend!())
      await waitFor(() => expect(spoken()).toEqual(['やあ、元気だよ。', '今日は晴れ。']))
      synth.speaking = false
      act(() => utter(1).onend!())
      await waitFor(() => expect(ears()).toHaveLength(1))
      expect(spoken()).toHaveLength(2) // `said`: the pieces were the reading
      expect(synth.cancel).not.toHaveBeenCalled()
    })

    it('a look-up starting after a piece went out hushes it; the finished answer is read instead', async () => {
      await open()
      call()
      await ask('記録どこ?')
      put({ say: '見てみるね。' })
      await waitFor(() => expect(spoken()).toEqual(['見てみるね。']))
      put({ hush: true })
      await waitFor(() => expect(synth.cancel).toHaveBeenCalledTimes(1))
      put({ interim: 'ちょっと待ってね。' })
      await waitFor(() => expect(spoken()).toEqual(['見てみるね。', 'ちょっと待ってね。']))
      finish({ reply: 'assistant フォルダにあるよ。', speak: 'assistant フォルダにあるよ。' })
      synth.speaking = false
      act(() => utter(1).onend!())
      await waitFor(() => expect(spoken()).toEqual(['見てみるね。', 'ちょっと待ってね。', 'assistant フォルダにあるよ。']))
      // Stopped now: what was heard is the answer's reading only, not the hushed piece.
      fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.callStop' }))
      await waitFor(() => expect(hushes()).toEqual([{ heard: 'assistant フォルダにあるよ。' }]))
    })

    it('pressing it while it speaks quiets it at once and listens — even before the answer is in; the server hears what was heard', async () => {
      // The server's answer to the stop is held, to see that the held line waits for it.
      let release: (() => void) | undefined
      const before = vi.mocked(fetch).getMockImplementation()!
      vi.mocked(fetch).mockImplementation(async (url, init) =>
        String(url).endsWith('/hush') ? new Promise<Response>((r) => (release = () => r(new Response('{}')))) : before(url as never, init),
      )
      const dialog = await open()
      call()
      ears()[0].emit({ type: 'ready' })
      await ask('長い話して')
      put({ say: '昔々あるところに。' })
      put({ say: 'おじいさんがいました。' })
      await waitFor(() => expect(spoken()).toEqual(['昔々あるところに。']))
      expect(ears()).toHaveLength(0)
      const stopKey = screen.getByRole('button', { name: 'misc.assistant.callStop' })
      stopKey.focus() // pressed by keyboard or click, the key had the focus
      fireEvent.click(stopKey)
      expect(synth.cancel).toHaveBeenCalledTimes(1)
      expect(dialog.contains(document.activeElement)).toBe(true) // the key went; focus stays in the call
      await waitFor(() => expect(ears()).toHaveLength(1)) // listening, though the answer is still being written
      expect(screen.queryByRole('button', { name: 'misc.assistant.callStop' })).toBeNull()
      ears()[0].emit({ type: 'ready' })
      expect(callState()).toBe('misc.assistant.callHearing')
      // Said meanwhile: it goes once the stopped line is answered.
      ears()[0].emit({ type: 'final', text: 'やっぱり短く' })
      expect(says()).toHaveLength(1)
      const first = ctl!
      ctl = undefined
      act(() => {
        first.enqueue(enc.encode(JSON.stringify({ reply: '昔々あるところに。おじいさんがいました。', speak: '昔々あるところに。おじいさんがいました。', said: true }) + '\n'))
        first.close()
      })
      await waitFor(() => expect(hushes()).toEqual([{ heard: '昔々あるところに。' }]))
      // The server hears of the stop before the held line goes: its note rides on that line.
      await act(async () => {})
      expect(says()).toHaveLength(1)
      await act(async () => release!())
      await waitFor(() => expect(says()).toHaveLength(2))
      expect(JSON.parse(String(says()[1][1]?.body)).text).toBe('やっぱり短く')
      expect(spoken()).toEqual(['昔々あるところに。']) // the piece after the stop was never read
    })

    it('a stop on a line that then gets no answer tells the server nothing (the note would land on an older answer)', async () => {
      await open()
      call()
      await ask('記録どこ?')
      put({ interim: 'ちょっと待ってね。' })
      await waitFor(() => expect(spoken()).toEqual(['ちょっと待ってね。']))
      fireEvent.click(screen.getByRole('button', { name: 'misc.assistant.callStop' }))
      finish({ error: 'assistant-failed', detail: 'だめでした' })
      await waitFor(() => expect(callState()).not.toBe('misc.assistant.callThinking'))
      await act(async () => {})
      expect(hushes()).toEqual([])
    })

    it('Space quiets it too; a stop after the answer is in tells the server at once', async () => {
      const dialog = await open()
      call()
      await ask('やあ')
      finish({ reply: 'やあ。元気。', speak: 'やあ。元気。' })
      await waitFor(() => expect(spoken()).toEqual(['やあ。元気。']))
      fireEvent.keyDown(dialog, { key: ' ' })
      expect(synth.cancel).toHaveBeenCalledTimes(1)
      await waitFor(() => expect(hushes()).toEqual([{ heard: 'やあ。元気。' }]))
      await waitFor(() => expect(ears()).toHaveLength(1))
    })
  })
})

describe('default position', () => {
  // Owner 2026-10-06: the character must not jump when a project opens. It has
  // ONE default spot (level with Ground's pen) and the agent-team bar makes room.
  const reserve = () => document.documentElement.style.getPropertyValue('--og-assistant-reserve')
  const reserveY = () => document.documentElement.style.getPropertyValue('--og-assistant-reserve-y')
  it('renders level with the pen until dragged and asks the bar for room while there', async () => {
    localStorage.removeItem('og.assistant.pos')
    const { FloatingAssistant: FA, ASSISTANT_RESERVE_PX, ASSISTANT_RESERVE_Y_PX } = await import('./FloatingAssistant')
    const { container, unmount } = render(<FA disabled={false} />)
    await act(async () => {})
    const b = container.querySelector('button') as HTMLElement
    expect(b.style.bottom).toBe('18px')
    expect(b.style.right).toBe('20px')
    // the reserve covers the character's width plus its gap to the edge
    expect(reserve()).toBe(`${ASSISTANT_RESERVE_PX}px`)
    expect(ASSISTANT_RESERVE_PX).toBeGreaterThan(20 + 50)
    // ...and the floor a project keeps free: its top (18 + 50) plus a gap
    expect(reserveY()).toBe(`${ASSISTANT_RESERVE_Y_PX}px`)
    expect(ASSISTANT_RESERVE_Y_PX).toBeGreaterThan(18 + 50)
    unmount()
    expect(reserve()).toBe('')
    expect(reserveY()).toBe('')
  })
  it('the room stays while the character is dragged and goes once it is dropped elsewhere', async () => {
    localStorage.removeItem('og.assistant.pos')
    const { FloatingAssistant: FA } = await import('./FloatingAssistant')
    const { container } = render(<FA disabled={false} />)
    await act(async () => {})
    const b = container.querySelector('button') as HTMLElement
    fireEvent.pointerDown(b, { clientX: 500, clientY: 500, pointerId: 1 })
    fireEvent.pointerMove(b, { clientX: 400, clientY: 400, pointerId: 1 })
    expect(b.style.bottom).not.toBe('18px') // it moves...
    expect(reserveY()).not.toBe('') // ...the screen does not reflow under the drag
    fireEvent.pointerUp(b, { pointerId: 1 })
    await act(async () => {})
    expect(reserve()).toBe('')
    expect(reserveY()).toBe('')
    localStorage.removeItem('og.assistant.pos')
  })
  it('a spot the owner dragged to is kept, and the bar takes its full width back', async () => {
    localStorage.setItem('og.assistant.pos', JSON.stringify({ right: 300, bottom: 200 }))
    const { FloatingAssistant: FA } = await import('./FloatingAssistant')
    const { container } = render(<FA disabled={false} />)
    await act(async () => {})
    expect((container.querySelector('button') as HTMLElement).style.bottom).toBe('200px')
    expect(reserve()).toBe('')
    localStorage.removeItem('og.assistant.pos')
  })
})
