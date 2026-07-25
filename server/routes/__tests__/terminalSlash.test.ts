import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { app } from '../../app'
import type { TerminalInfo } from '@/lib/server/terminal'
import { CTRL_U } from '@/lib/server/claudeSlash'

// Route-level contract for POST /api/terminal/:id/slash — the context gauge's
// manual escape hatch (docs/CONTEXT_MANAGEMENT_PLAN.md §3-B1/B2). Same fake-PTY
// seam as ack.test.ts: no node-pty, no shell. `writes` is the evidence — a
// refused request must put NOTHING into the user's session.
//
// The route is id-based (like input / resize / ack) and takes no project path,
// so there is no registry or home setup here.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

interface FakeSessionShape {
  info: TerminalInfo
  pty: { write: (d: string) => void }
  buffer: string
  listeners: Set<unknown>
  exitListeners: Set<unknown>
}

const state = () =>
  (globalThis as { __openground_terminal?: { sessions: Map<string, FakeSessionShape> } })
    .__openground_terminal!

/** A live claude pane whose rendered screen is `buffer` (getTerminalScreen
 *  falls back to the raw buffer when there is no headless terminal). */
const fakePane = (id: string, writes: string[], buffer = ''): void => {
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
    pty: { write: (d: string) => writes.push(d) },
    buffer,
    listeners: new Set(),
    exitListeners: new Set(),
  })
}

// claude mid-turn: the interrupt hint below the input box's closing rule.
const BUSY = ['⏺ working…', '──────────────────', '  esc to interrupt'].join('\n')

beforeEach(() => {
  state().sessions.clear()
})

afterAll(() => {
  state().sessions.clear()
})

describe('POST /api/terminal/:id/slash — what it accepts', () => {
  it('invalid JSON body → 400', async () => {
    const res = await app.request('/api/terminal/x/slash', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('refuses any command outside the allowlist — and types nothing', async () => {
    const writes: string[] = []
    fakePane('t1', writes)
    for (const command of [undefined, '', 'exit', '/compact', 'compact; rm -rf /', 7]) {
      const res = await app.request('/api/terminal/t1/slash', json({ command }))
      expect(res.status).toBe(400)
    }
    // The teeth: this route writes raw keystrokes, so a rejected command must
    // not reach the pane at all.
    expect(writes).toEqual([])
  })
})

describe('POST /api/terminal/:id/slash — what it does', () => {
  it('types /compact into the pane: line-kill first, then the command', async () => {
    const writes: string[] = []
    fakePane('t1', writes)
    const res = await app.request('/api/terminal/t1/slash', json({ command: 'compact' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(writes).toEqual([CTRL_U, '/compact\r'])
  })

  it('types /clear the same way', async () => {
    const writes: string[] = []
    fakePane('t1', writes)
    const res = await app.request('/api/terminal/t1/slash', json({ command: 'clear' }))
    expect(res.status).toBe(200)
    expect(writes).toEqual([CTRL_U, '/clear\r'])
  })

  it('carries a focus hint for /compact, stripped of anything that could submit early', async () => {
    const writes: string[] = []
    fakePane('t1', writes)
    const res = await app.request(
      '/api/terminal/t1/slash',
      json({ command: 'compact', focus: 'keep the API work\rrm -rf /' }),
    )
    expect(res.status).toBe(200)
    // One line, one Enter — the injected CR became a space.
    expect(writes[1]).toBe('/compact keep the API work rm -rf /\r')
    expect(writes.filter(w => w.includes('\r'))).toHaveLength(1)
  })

  it('409 while claude is mid-turn — and types nothing', async () => {
    const writes: string[] = []
    fakePane('t1', writes, BUSY)
    const res = await app.request('/api/terminal/t1/slash', json({ command: 'compact' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toBe('busy')
    expect(writes).toEqual([])
  })

  it('404 when the pane is gone', async () => {
    const res = await app.request('/api/terminal/ghost/slash', json({ command: 'clear' }))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('not-found')
  })
})
