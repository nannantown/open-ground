// @vitest-environment jsdom
//
// A seat's polled conversation and its send-a-word box (SwarmSeatTalk).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useT } from '@/i18n/I18nContext'
import { FEED_FRAMES, SwarmSeatFeed, SwarmSeatSay, mergeTail, sayToWorker } from './SwarmSeatTalk'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string, v?: Record<string, unknown>) => (v ? `${k}:${JSON.stringify(v)}` : k) }),
}))

/** The box exactly as SwarmWorkerSeat wires it. */
const SwarmWorkerSeatSayForTest = () => {
  const { t } = useT()
  return <SwarmSeatSay placeholder="w" onSend={(text) => sayToWorker('/p', 's1', text, t)} />
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const f = (seq: number, text = `line ${seq}`) => ({ seq, ev: { kind: 'text' as const, text } })

describe('mergeTail', () => {
  it('appends only newer frames and keeps the newest FEED_FRAMES', () => {
    const held = [f(1), f(2)]
    expect(mergeTail(held, [f(2), f(3)]).map((x) => x.seq)).toEqual([1, 2, 3])
    expect(mergeTail(held, [f(1)])).toBe(held)
    const many = Array.from({ length: FEED_FRAMES + 5 }, (_, i) => f(i + 3))
    const merged = mergeTail(held, many)
    expect(merged).toHaveLength(FEED_FRAMES)
    expect(merged[merged.length - 1].seq).toBe(FEED_FRAMES + 7)
  })
})

describe('SwarmSeatFeed', () => {
  it('renders complete Japanese blocks with their paragraph and tool boundaries', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const text = '切り替えは\nこのまま進めます。\n\n次の段落です。' + '確認を続けます。'.repeat(12)
    const answers = [
      { frames: [{ seq: 1, ev: { kind: 'input', text: '調べてください。' } }], reaped: false },
      { frames: [f(2, text),
        { seq: 3, ev: { kind: 'tool_use', name: 'Read', detail: 'file.ts' } },
        { seq: 4, ev: { kind: 'tool_result', ok: true, head: '読みました' } },
        f(5, '確認しました。'), { seq: 6, ev: { kind: 'turn_end', reason: 'completed', isError: false } }], reaped: true },
    ]
    let polls = 0
    vi.stubGlobal('fetch', () => Promise.resolve(new Response(JSON.stringify(answers[Math.min(polls++, 1)]))))
    const { container, findByText, getByText } = render(<SwarmSeatFeed sdkSessionId="streamed" projectPath="/p" />)
    await findByText('調べてください。')
    await vi.advanceTimersByTimeAsync(3000)
    await findByText('切り替えは このまま進めます。')
    expect(Array.from(container.querySelectorAll('p')).map((p) => p.textContent)).toEqual([
      '切り替えは\nこのまま進めます。', '次の段落です。' + '確認を続けます。'.repeat(12), '確認しました。',
    ])
    getByText('Read file.ts')
  })

  it('asks again from the last seq it holds, shows what the desk was told, and stops once reaped', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const urls: string[] = []
    const answers = [
      { frames: [{ seq: 1, ev: { kind: 'input', text: '/order build it' } }, f(2, 'on it')], reaped: false },
      { frames: [f(3, 'done')], reaped: true },
    ]
    vi.stubGlobal('fetch', (u: string) => {
      urls.push(u)
      return Promise.resolve(new Response(JSON.stringify(answers[Math.min(urls.length - 1, 1)])))
    })
    const { findByText, getByText } = render(<SwarmSeatFeed sdkSessionId="w 1" projectPath="/p" />)
    await findByText('/order build it')
    getByText('projectPanel.swarm.feed.input')
    getByText('on it')
    await vi.advanceTimersByTimeAsync(3000)
    await findByText('done')
    expect(urls[1]).toBe('/api/sdk-session/w%201/tail?path=%2Fp&after=2&limit=80')
    // Reaped ⇒ no further polls.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(urls).toHaveLength(2)
  })
})

describe('SwarmSeatFeed — a gone session', () => {
  it('stops asking after a 404 (the session is gone, not the network)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let calls = 0
    vi.stubGlobal('fetch', () => {
      calls++
      return Promise.resolve(new Response(JSON.stringify({ error: 'no such sdk session' }), { status: 404 }))
    })
    const { findByText } = render(<SwarmSeatFeed sdkSessionId="gone" projectPath="/p" />)
    await findByText('projectPanel.swarm.feed.empty')
    await vi.advanceTimersByTimeAsync(1000)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(calls).toBe(1)
  })
})

describe('the worker send box', () => {
  it('posts the word to the SDK input path and reports a refusal with the words kept', async () => {
    const reqs: { url: string; body: string }[] = []
    vi.stubGlobal('fetch', (u: string, init: RequestInit) => {
      reqs.push({ url: u, body: init.body as string })
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'session is no longer accepting input' }), { status: 409 }),
      )
    })
    const { getByText, container, findByText } = render(<SwarmWorkerSeatSayForTest />)
    fireEvent.click(getByText('projectPanel.swarm.say.open'))
    const box = container.querySelector('textarea')!
    fireEvent.change(box, { target: { value: 'use the other API' } })
    fireEvent.click(getByText('projectPanel.swarm.say.send'))
    await findByText(
      'projectPanel.swarm.say.failed:{"error":"session is no longer accepting input"}',
    )
    expect(reqs).toEqual([
      { url: '/api/sdk-session/s1/input?path=%2Fp', body: JSON.stringify({ text: 'use the other API' }) },
    ])
    await waitFor(() => expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('use the other API'))
  })
})

describe('the president conversation composer', () => {
  it('stays visible after sending with Enter and never takes focus on mount', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const, note: 'delivered' }))
    const view = render(<><input aria-label="another field" autoFocus /><SwarmSeatSay alwaysOpen placeholder="社長に話す" onSend={onSend} /></>)
    expect(view.getByLabelText('another field')).toHaveFocus()
    const box = view.getByRole('textbox', { name: '社長に話す' })
    expect(view.getByRole('button', { name: 'projectPanel.swarm.say.send' })).toBeDisabled()
    fireEvent.change(box, { target: { value: 'このまま進めて' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await view.findByText('delivered')
    expect(onSend).toHaveBeenCalledExactlyOnceWith('このまま進めて')
    expect(box).toBeInTheDocument()
    expect(box).toHaveValue('')
    expect(box).toHaveFocus()
    expect(view.queryByText('projectPanel.swarm.say.cancel')).toBeNull()
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(box).toBeInTheDocument()
  })

  it('keeps Shift+Enter as a newline and IME confirmation as composition, then sends the complete draft', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const, note: 'delivered' }))
    const user = userEvent.setup()
    const view = render(<SwarmSeatSay alwaysOpen placeholder="社長に話す" onSend={onSend} />)
    const box = view.getByRole('textbox')
    await user.click(box)
    await user.type(box, '一行目')
    await user.keyboard('{Shift>}{Enter}{/Shift}二行目')
    expect(box).toHaveValue('一行目\n二行目')
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 })
    fireEvent.compositionStart(box)
    fireEvent.keyDown(box, { key: 'Enter' })
    fireEvent.keyDown(box, { key: 'Escape' })
    expect(onSend).not.toHaveBeenCalled()
    expect(box).toHaveValue('一行目\n二行目')
    fireEvent.compositionEnd(box)
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(onSend).toHaveBeenCalledExactlyOnceWith('一行目\n二行目'))
  })

  it('keeps the refused draft and prevents duplicate sends while pending or disabled', async () => {
    let finish!: (result: { ok: false; error: string }) => void
    const onSend = vi.fn(() => new Promise<{ ok: false; error: string }>(resolve => { finish = resolve }))
    const view = render(<SwarmSeatSay alwaysOpen placeholder="社長に話す" onSend={onSend} />)
    const box = view.getByRole('textbox')
    fireEvent.change(box, { target: { value: '消さないで' } })
    fireEvent.click(view.getByRole('button', { name: 'projectPanel.swarm.say.send' }))
    expect(box).toHaveAttribute('readonly')
    expect(box).toHaveFocus()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    finish({ ok: false, error: 'not accepted' })
    await view.findByText('not accepted')
    expect(box).toHaveValue('消さないで')
    view.rerender(<SwarmSeatSay alwaysOpen disabled placeholder="社長に話す" onSend={onSend} />)
    expect(box).toBeDisabled()
    expect(view.getByRole('button', { name: 'projectPanel.swarm.say.send' })).toBeDisabled()
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(box).toHaveValue('消さないで')
  })

  it('keeps the other seats folded by default, with plain Enter as a newline and Cmd/Ctrl+Enter as send', async () => {
    const onSend = vi.fn(async () => ({ ok: true as const, note: 'delivered' }))
    const view = render(<SwarmSeatSay placeholder="worker" onSend={onSend} />)
    expect(view.queryByRole('textbox')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: 'projectPanel.swarm.say.open' }))
    const box = view.getByRole('textbox')
    expect(box).toHaveFocus()
    fireEvent.change(box, { target: { value: 'worker draft' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
    await view.findByText('delivered')
    expect(onSend).toHaveBeenCalledExactlyOnceWith('worker draft')
    expect(view.queryByRole('textbox')).toBeNull()
  })
})
