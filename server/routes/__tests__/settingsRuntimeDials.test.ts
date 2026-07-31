import { describe, it, expect } from 'vitest'
import { app } from '../../app'
import { getWorkerRuntimeDial, getManagerRuntimeDial, setSettings } from '@/lib/server/store'

// The Agent-SDK runtime dials, POSTed by the manager dashboard's switches.
//
// WHY THIS FILE EXISTS. The switches were built, wired and type-checked before
// anyone asked whether POST /api/settings would actually STORE what they sent —
// and it would not have: the route narrows every body to USER_SETTINGS_KEYS, and
// these two keys were not on it. The switch would have flipped, the UI would
// have shown ON, the write would have been silently dropped, and every desk
// would have kept launching on PTY. Nothing would have thrown. So the assertion
// that matters here is not "the route returns ok" — it is the ROUND TRIP:
// POST, then read through the same dial readers the spawn paths use.
//
// HOME is redirected to a throwaway tmp dir by ./src/test/setup-home.ts, so every
// write here lands in an isolated home — never the real ~/.openground.

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('POST /api/settings — Agent SDK runtime dials round-trip', () => {
  it('worker dial: the switch reaches the reader the spawn path consults', async () => {
    const res = await app.request('/api/settings', post({ swarmWorkerRuntime: { mode: 'sdk' } }))
    expect(res.status).toBe(200)
    // THE assertion: the same function swarmWorker.ts calls before spawning.
    expect((await getWorkerRuntimeDial()).mode).toBe('sdk')

    await app.request('/api/settings', post({ swarmWorkerRuntime: { mode: 'pty' } }))
    expect((await getWorkerRuntimeDial()).mode).toBe('pty')
  })

  it('commander dial: same round trip, independently of the worker dial', async () => {
    await app.request('/api/settings', post({ swarmManagerRuntime: { mode: 'sdk' } }))
    expect((await getManagerRuntimeDial()).mode).toBe('sdk')
    // The worker dial is untouched by a commander write (they are separate
    // decisions — the recommended rollout turns workers on FIRST).
    expect((await getWorkerRuntimeDial()).mode).toBe('pty')

    await app.request('/api/settings', post({ swarmManagerRuntime: { mode: 'pty' } }))
    expect((await getManagerRuntimeDial()).mode).toBe('pty')
  })

  it('the worker dial keeps sdkMaxWorkers; the commander dial has no such field', async () => {
    await app.request(
      '/api/settings',
      post({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 3 } }),
    )
    expect(await getWorkerRuntimeDial()).toEqual({ mode: 'sdk', sdkMaxWorkers: 3 })

    await app.request(
      '/api/settings',
      // A cap on the commander is meaningless (there is exactly one desk) — it is
      // dropped rather than stored as a field no reader will ever consult.
      post({ swarmManagerRuntime: { mode: 'sdk', sdkMaxWorkers: 9 } }),
    )
    expect(await getManagerRuntimeDial()).toEqual({ mode: 'sdk' })
  })

  it('a garbage patch is REFUSED — the previous dial survives, it never falls to a default', async () => {
    await app.request('/api/settings', post({ swarmWorkerRuntime: { mode: 'sdk' } }))
    for (const junk of [
      { mode: 'SDK' }, // wrong case is not a mode
      { mode: 'turbo' },
      { mode: true },
      {},
      'sdk',
      ['sdk'],
      null,
      42,
    ]) {
      await app.request('/api/settings', post({ swarmWorkerRuntime: junk }))
      expect((await getWorkerRuntimeDial()).mode, JSON.stringify(junk)).toBe('sdk')
    }
  })

  it('an absent / hand-corrupted field reads as PTY — never as the experiment', async () => {
    // The fail direction that matters: anything we cannot read must land on the
    // shipped behaviour. Written straight to the store to simulate a hand-edited file.
    await setSettings({
      swarmWorkerRuntime: undefined,
      swarmManagerRuntime: { mode: 'nonsense' } as never,
    })
    expect((await getWorkerRuntimeDial()).mode).toBe('pty')
    expect((await getManagerRuntimeDial()).mode).toBe('pty')
  })

  it('a negative / non-numeric sdkMaxWorkers is dropped, not stored', async () => {
    for (const cap of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, '4', null]) {
      await app.request('/api/settings', post({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: cap } }))
      expect(await getWorkerRuntimeDial(), String(cap)).toEqual({ mode: 'sdk' })
    }
    // A fractional cap floors rather than persisting a fraction into a count.
    await app.request('/api/settings', post({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 2.7 } }))
    expect(await getWorkerRuntimeDial()).toEqual({ mode: 'sdk', sdkMaxWorkers: 2 })
  })
})
