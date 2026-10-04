// GET /api/phone-link/assistant/listen: the ears run exactly while the screen
// holds the stream. A window that hangs up — even before the owner check has
// answered — must leave no helper listening (review 2026-10-04: the stream
// never saw that abort, so og-listen kept the mic on).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ starts: 0, stops: 0, emit: null as null | ((e: object) => void), lockdown: false }))
vi.mock('@/lib/server/lockdown', async (orig) => ({
  ...(await orig<object>()),
  isLockdownEnabledSync: () => h.lockdown,
}))
vi.mock('@/lib/server/phoneLink', async (orig) => ({
  ...(await orig<object>()),
  hasPhoneLinkAccess: async () => true,
}))
vi.mock('@/lib/server/assistantListen', () => ({
  listenBinary: () => '/fake/og-listen',
  startListening: (_lang: string, onEvent: (e: object) => void) => {
    h.starts++
    h.emit = onEvent
    return () => void h.stops++
  },
}))

import { phoneLinkRoutes } from '../routes/phoneLink'

const listen = (signal?: AbortSignal, headers: Record<string, string> = {}) =>
  phoneLinkRoutes.request('/api/phone-link/assistant/listen?lang=ja', { headers: { host: '127.0.0.1:47776', ...headers }, signal })
const tick = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  h.starts = 0
  h.stops = 0
  h.emit = null
  h.lockdown = false
})

describe('assistant listen route', () => {
  // Review 2026-10-04: any web page could switch the mic on with
  // <img src="http://127.0.0.1:47776/api/phone-link/assistant/listen"> — no
  // Origin, a local Host, so the owner check let it through.
  it('a foreign page cannot open the ears; the app itself can', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const r = await listen(undefined, { 'sec-fetch-site': site })
      expect(r.status).toBe(403)
    }
    await tick()
    expect(h.starts).toBe(0)
    const ac = new AbortController()
    const ok = await listen(ac.signal, { 'sec-fetch-site': 'same-origin' })
    expect(ok.headers.get('content-type')).toContain('text/event-stream')
    await tick()
    expect(h.starts).toBe(1)
    ac.abort()
    await tick()
  })

  it('work mode keeps the ears shut, as it keeps the assistant quiet', async () => {
    h.lockdown = true
    const r = await listen(undefined, { 'sec-fetch-site': 'same-origin' })
    expect(r.status).toBe(409)
    await tick()
    expect(h.starts).toBe(0)
  })

  it('a window that already hung up starts no ears', async () => {
    const ac = new AbortController()
    ac.abort()
    const r = await Promise.resolve(listen(ac.signal)).catch(() => null)
    await r?.text().catch(() => '')
    await tick()
    expect(h.starts).toBe(0)
  })

  it('hanging up mid-listen stops the ears', async () => {
    const ac = new AbortController()
    const r = await listen(ac.signal)
    expect(r.headers.get('content-type')).toContain('text/event-stream')
    await tick()
    expect(h.starts).toBe(1)
    ac.abort()
    await tick()
    expect(h.stops).toBe(1)
  })

  it('what is heard goes out as events; an error ends the stream and the ears', async () => {
    const r = await listen()
    const reader = r.body!.getReader()
    await tick()
    h.emit!({ type: 'final', text: 'やあ' })
    h.emit!({ type: 'error', reason: 'denied' })
    let body = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      body += new TextDecoder().decode(value)
    }
    expect(body).toContain('"text":"やあ"')
    expect(body).toContain('"reason":"denied"')
    expect(h.stops).toBe(1)
  })
})
