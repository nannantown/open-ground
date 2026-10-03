// @vitest-environment jsdom
// The floating assistant: reachable from any screen, the talk is the one log on
// this Mac (shared with the iPhone), and closing the window never drops a line
// that is still being answered.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { FloatingAssistant, clampPos, panelPlacement } from './FloatingAssistant'

interface Line { id: string; at: number; who: 'owner' | 'assistant'; text: string }
let log: Line[]
let cfg: { name: string; look: string }
let status: number
let answer: { resolve: () => void } | null

const json = (body: unknown, s = 200) => ({ ok: s < 400, status: s, json: async () => body }) as Response

// jsdom has no pointer capture; user-event's real clicks press the character.
Element.prototype.setPointerCapture ??= () => {}

beforeEach(() => {
  log = [{ id: 'a', at: 1, who: 'assistant', text: '昨日のつづきです' }]
  cfg = { name: 'ノノ', look: 'moss' }
  status = 200
  answer = null
  localStorage.clear()
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (status !== 200) return json({ error: 'owner only' }, status)
    if (url.endsWith('/log')) return json({ entries: log, ...cfg, logDays: 30, memoryChars: 4000 })
    if (url.endsWith('/config')) {
      Object.assign(cfg, JSON.parse(String(init?.body)))
      return json(cfg)
    }
    if (url.endsWith('/say')) {
      const text = JSON.parse(String(init?.body)).text as string
      await new Promise<void>((resolve) => (answer = { resolve }))
      log = [...log, { id: `o${log.length}`, at: 2, who: 'owner', text }, { id: `r${log.length}`, at: 3, who: 'assistant', text: `答え:${text}` }]
      return json({ reply: `答え:${text}` })
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

  it('opens on a click, shows the shared log under the owner-given name, closes on Esc', async () => {
    render(<FloatingAssistant disabled={false} />)
    fireEvent.click(await screen.findByRole('button', { name: 'ノノ' }))
    const dialog = screen.getByRole('dialog', { name: 'ノノ' })
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
