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
//
// SCOPE: everything here is the VALUE level — given a settings.json we can read,
// which runtime does the stored value select. The level underneath (given a
// settings.json that is MISSING / unreadable / unparseable, which runtime wins)
// is src/lib/server/runtimeDialFileHealth.test.ts, and it is a separate file
// because the two levels had opposite answers until 2026-08-02: a chmod-000
// settings.json read as "nothing written yet" and flipped the commander's kill
// switch back to SDK. Nothing in THIS file could have caught that — every case
// here writes a readable file first.

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
    // Seed the worker dial EXPLICITLY rather than inheriting whatever the case
    // above left behind: since absent ⇒ sdk on both dials, "still pty" is only
    // evidence of independence if pty was written on purpose.
    await app.request('/api/settings', post({ swarmWorkerRuntime: { mode: 'pty' } }))
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

  it('a hand-corrupted field reads as PTY; an ABSENT one is the fresh-install default', async () => {
    // The fail direction that matters: a value we cannot READ must land on the
    // shipped behaviour. ABSENT is a different question and has the opposite
    // answer — nothing written yet is a fresh install, whose default flipped to
    // sdk (worker 2026-08-01, commander 08-02). Written straight to the store to
    // simulate a hand-edited file.
    await setSettings({
      swarmWorkerRuntime: undefined,
      swarmManagerRuntime: { mode: 'nonsense' } as never,
    })
    // ⚠ THIS SAID 'pty' UNTIL 2026-08-02 and was one of the two places the stale
    // default was pinned — the worker reader had not moved with the flip, so a
    // fresh install dispatched PTY workers under a switch drawn ON (0.11.47).
    expect((await getWorkerRuntimeDial()).mode).toBe('sdk')
    expect((await getManagerRuntimeDial()).mode).toBe('pty')
  })

  it('a negative / non-numeric sdkMaxWorkers is dropped, not stored', async () => {
    // NOTE: `0` used to head this list, and that was the bug — "run no SDK
    // workers" is a real setting, not junk, so dropping it made the panel show 0
    // while the server kept seating one. Its round trip is pinned in
    // src/lib/server/sdkDialAndFallback.test.ts.
    for (const cap of [-3, Number.NaN, Number.POSITIVE_INFINITY, '4', null]) {
      await app.request('/api/settings', post({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: cap } }))
      expect(await getWorkerRuntimeDial(), String(cap)).toEqual({ mode: 'sdk' })
    }
    // A fractional cap floors rather than persisting a fraction into a count.
    await app.request('/api/settings', post({ swarmWorkerRuntime: { mode: 'sdk', sdkMaxWorkers: 2.7 } }))
    expect(await getWorkerRuntimeDial()).toEqual({ mode: 'sdk', sdkMaxWorkers: 2 })
  })
})
