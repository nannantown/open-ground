import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { app } from '../../app'
import {
  FLOW_HIGH_WATERMARK,
  registerFlowStream,
  trackFlowSent,
} from '@/lib/server/terminal'
import type { TerminalInfo } from '@/lib/server/terminal'

// Route-level contract for POST /api/terminal/:id/ack — the flow-control ACK
// the SSE client fires (fire-and-forget) after writing `data` chunks to xterm.
// Same fake-PTY seam as paste.test.ts (no node-pty, no shell): pause/resume
// spies on the fake pty observe the watermark machinery end to end through
// the route. No registry/home setup needed — like input/resize, ack is
// id-based and never takes a project path.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

interface FakeSessionShape {
  info: TerminalInfo
  pty: { pause: () => void; resume: () => void }
  buffer: string
  listeners: Set<unknown>
  exitListeners: Set<unknown>
  flows?: Map<string, { sent: number; acked: number; controlled: boolean }>
  paused?: boolean
}

const state = () =>
  (globalThis as { __openground_terminal?: { sessions: Map<string, FakeSessionShape> } })
    .__openground_terminal!

const fakePty = (id: string, calls: string[]): void => {
  state().sessions.set(id, {
    info: {
      id,
      cwd: '/tmp/proj-a',
      shell: '/bin/zsh',
      cols: 100,
      rows: 30,
      startedAt: new Date().toISOString(),
      tag: 'claude',
    } as TerminalInfo,
    pty: { pause: () => calls.push('pause'), resume: () => calls.push('resume') },
    buffer: '',
    listeners: new Set(),
    exitListeners: new Set(),
  })
}

beforeEach(() => {
  state().sessions.clear()
})

afterAll(() => {
  state().sessions.clear()
})

describe('POST /api/terminal/:id/ack — validation', () => {
  it('invalid JSON body → 400', async () => {
    const res = await app.request('/api/terminal/x/ack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/invalid body/i)
  })

  it('missing streamId → 400', async () => {
    const res = await app.request('/api/terminal/x/ack', json({ bytes: 10 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/streamId/i)
  })

  it('missing / zero / negative / non-numeric bytes → 400', async () => {
    for (const bytes of [undefined, 0, -5, 'ten', NaN]) {
      const res = await app.request('/api/terminal/x/ack', json({ streamId: 's', bytes }))
      expect(res.status).toBe(400)
      expect((await res.json()).error).toMatch(/bytes/i)
    }
  })
})

describe('POST /api/terminal/:id/ack — semantics', () => {
  it('unknown PTY → 200 {ok:true} (an ACK racing the exit is normal, not an error)', async () => {
    const res = await app.request('/api/terminal/ghost/ack', json({ streamId: 's', bytes: 10 }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('drains a paused PTY: ACKs through the route mark the flow controlled and fire resume', async () => {
    const calls: string[] = []
    fakePty('pty-1', calls)
    registerFlowStream('pty-1', 'st-1')
    // First ACK marks the flow controlled (an un-ACKing flow never pauses)…
    const first = await app.request('/api/terminal/pty-1/ack', json({ streamId: 'st-1', bytes: 1 }))
    expect(first.status).toBe(200)
    // …so jamming it past HIGH pauses the PTY…
    trackFlowSent('pty-1', 'st-1', FLOW_HIGH_WATERMARK + 2)
    expect(calls).toEqual(['pause'])
    // …and ACKing the backlog away through the route resumes it.
    const res = await app.request(
      '/api/terminal/pty-1/ack',
      json({ streamId: 'st-1', bytes: FLOW_HIGH_WATERMARK + 1 }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(calls).toEqual(['pause', 'resume'])
  })
})
