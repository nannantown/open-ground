import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { app } from '../../app'
import { COALESCE_MS } from '../sse'
import { FLOW_HIGH_WATERMARK, FLOW_PAUSE_CAP_MS } from '@/lib/server/terminal'
import type { TerminalInfo } from '@/lib/server/terminal'

// Integration for GET /api/terminal/:id/stream through the fake-session seam:
// the test drives the session's listener sets directly (exactly what
// terminal.ts onData/onExit would do), so there is no PTY and no shell. The
// contract under test is the LEADING-EDGE coalescing + exit ordering: the
// first chunk after an idle gap goes out immediately, chunks arriving while
// the window is open merge into ONE `data` event per COALESCE_MS, and the
// exit path flushes the pending event SYNCHRONOUSLY before `exit` — which
// also makes the exit test deterministic (no waiting on the coalesce window).

interface FakeSessionShape {
  info: TerminalInfo
  pty: unknown
  buffer: string
  listeners: Set<(chunk: string) => void>
  exitListeners: Set<(info: TerminalInfo) => void>
  flows?: Map<string, { sent: number; acked: number; controlled: boolean }>
  paused?: boolean
}

const state = () =>
  (globalThis as { __openground_terminal?: { sessions: Map<string, FakeSessionShape> } })
    .__openground_terminal!

const fakeSession = (id: string, buffer: string): FakeSessionShape => {
  const s: FakeSessionShape = {
    info: {
      id,
      cwd: '/tmp/proj-a',
      shell: '/bin/zsh',
      cols: 100,
      rows: 30,
      startedAt: new Date().toISOString(),
      tag: 'claude',
    } as TerminalInfo,
    pty: {},
    buffer,
    listeners: new Set(),
    exitListeners: new Set(),
  }
  state().sessions.set(id, s)
  return s
}

// Poll until the route's streamSSE callback has subscribed (it runs async
// after app.request returns the Response).
const until = async (cond: () => boolean, ms = 2000): Promise<void> => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition')
    await new Promise((r) => setTimeout(r, 5))
  }
}

// Parse the SSE wire text into ordered {event, data} frames. All payloads are
// JSON.stringify'd by the route, so a frame never holds a literal newline —
// one `data:` line per frame.
const parseSSE = (text: string): Array<{ event?: string; data?: string }> =>
  text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1],
      data: /^data: (.*)$/m.exec(block)?.[1],
    }))

beforeEach(() => {
  state().sessions.clear()
})

afterAll(() => {
  state().sessions.clear()
})

describe('GET /api/terminal/:id/stream — coalescing + exit ordering', () => {
  it('first chunk leads; in-window chunks merge into one data event, flushed BEFORE exit; init carries streamId', async () => {
    const s = fakeSession('t1', 'REPLAY')

    const res = await app.request('/api/terminal/t1/stream')
    expect(res.status).toBe(200)

    // Drain concurrently from the start so stream backpressure can never
    // deadlock the route's writes against our event-driving below.
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    const drained = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += dec.decode(value, { stream: true })
      }
    })()

    await until(() => s.listeners.size === 1)

    // Three chunks in the same tick: the first goes out IMMEDIATELY (leading
    // edge), the rest land inside the now-open window and merge.
    for (const l of Array.from(s.listeners)) {
      l('hello ')
      l('wor')
      l('ld')
    }
    // Exit immediately, before the window timer can fire: the route must
    // flush the pending output synchronously first, so nothing is lost and
    // the merged `data` precedes `exit`. Mimic terminal.ts onExit (finishedAt
    // before listeners fire).
    s.info.finishedAt = new Date().toISOString()
    s.info.exitCode = 0
    for (const l of Array.from(s.exitListeners)) l(s.info)

    await drained

    const frames = parseSSE(text)
    expect(frames.map((f) => f.event)).toEqual(['init', 'data', 'data', 'exit'])

    const init = JSON.parse(frames[0].data!)
    expect(init.replay).toBe('REPLAY')
    expect(init.info.id).toBe('t1')
    // streamId is the additive field ACKs are keyed by.
    expect(typeof init.streamId).toBe('string')
    expect(init.streamId.length).toBeGreaterThan(0)

    // The leading-edge flush carried the first chunk alone…
    expect(JSON.parse(frames[1].data!).chunk).toBe('hello ')
    // …and the in-window chunks merged into ONE event, in order.
    expect(JSON.parse(frames[2].data!).chunk).toBe('world')

    const exit = JSON.parse(frames[3].data!)
    expect(exit.exitCode).toBe(0)

    // The stream tore down its subscription (closeAll ran).
    expect(s.listeners.size).toBe(0)
    expect(s.exitListeners.size).toBe(0)
  })
})

// Like `until`, but on the fake clock: each step advances 5ms and flushes
// microtasks so the route's async writes and the body reader make progress.
const untilFake = async (cond: () => boolean, steps = 400): Promise<void> => {
  for (let i = 0; i < steps; i++) {
    if (cond()) return
    await vi.advanceTimersByTimeAsync(5)
  }
  throw new Error('timeout waiting for condition (fake clock)')
}

describe('GET /api/terminal/:id/stream — burst cadence (fake clock)', () => {
  it('one event per window during a burst; an empty window stops the cadence so the next chunk leads again', async () => {
    vi.useFakeTimers()
    try {
      const s = fakeSession('t3', '')

      const res = await app.request('/api/terminal/t3/stream')
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let text = ''
      const drained = (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          text += dec.decode(value, { stream: true })
        }
      })()

      await untilFake(() => text.includes('event: init'))

      // Burst: 'a' leads (immediate flush + window opens); 'b' and 'c' pile
      // into the open window…
      for (const l of Array.from(s.listeners)) {
        l('a')
        l('b')
        l('c')
      }
      // …one window later they go out merged, and the cadence re-arms…
      await vi.advanceTimersByTimeAsync(COALESCE_MS)
      for (const l of Array.from(s.listeners)) l('d')
      // …so 'd' (mid-burst) waits for the NEXT window close…
      await vi.advanceTimersByTimeAsync(COALESCE_MS)
      // …and an empty window ends the cadence.
      await vi.advanceTimersByTimeAsync(COALESCE_MS)

      // Stopped cadence means a fresh chunk leads again: 'e' must hit the
      // wire within <16ms of fake time (3×5ms steps) — a still-armed window
      // could not have fired yet, so seeing it proves the leading edge.
      for (const l of Array.from(s.listeners)) l('e')
      await untilFake(() => text.includes('"e"'), 3)

      s.info.finishedAt = new Date().toISOString()
      s.info.exitCode = 0
      for (const l of Array.from(s.exitListeners)) l(s.info)
      await drained

      const chunks = parseSSE(text)
        .filter((f) => f.event === 'data')
        .map((f) => JSON.parse(f.data!).chunk)
      expect(chunks).toEqual(['a', 'bc', 'd', 'e'])
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('GET /api/terminal/:id/stream — pause-cap stall drop', () => {
  it('force-ends the stream of a flow that holds the PTY paused past the cap', async () => {
    // The whole scenario is timer-driven (coalesce flush, pause cap), so it
    // runs on the fake clock — also what keeps it instant despite the 10s cap.
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      const s = fakeSession('t2', '')
      s.pty = { pause: () => calls.push('pause'), resume: () => calls.push('resume') }

      const res = await app.request('/api/terminal/t2/stream')
      expect(res.status).toBe(200)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let text = ''
      const drained = (async () => {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          text += dec.decode(value, { stream: true })
        }
      })()

      await untilFake(() => text.includes('event: init'))
      const streamId = JSON.parse(parseSSE(text)[0].data!).streamId as string

      // First ACK marks the flow controlled (an un-ACKing legacy client is
      // never stall-dropped); then one oversized chunk jams it past HIGH at
      // its leading-edge flush. The window advance just pumps the wire write.
      const ack = await app.request('/api/terminal/t2/ack', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ streamId, bytes: 1 }),
      })
      expect(ack.status).toBe(200)
      for (const l of Array.from(s.listeners)) l('x'.repeat(FLOW_HIGH_WATERMARK + 2))
      expect(calls).toEqual(['pause'])
      await vi.advanceTimersByTimeAsync(COALESCE_MS)

      // No further ACKs (a background-throttled renderer): the cap must end
      // THIS stream and resume the PTY instead of holding claude blocked.
      await vi.advanceTimersByTimeAsync(FLOW_PAUSE_CAP_MS)
      expect(calls).toEqual(['pause', 'resume'])
      await drained
      expect(s.listeners.size).toBe(0)
      expect(s.exitListeners.size).toBe(0)
      // A stall drop is NOT an exit — the PTY is alive; the client just sees
      // the connection end, auto-reconnects, and repaints from a fresh init.
      expect(parseSSE(text).every((f) => f.event !== 'exit')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
