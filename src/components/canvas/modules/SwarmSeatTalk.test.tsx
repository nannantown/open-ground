// @vitest-environment jsdom
//
// A seat's polled conversation and its send-a-word box (SwarmSeatTalk).

import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
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
