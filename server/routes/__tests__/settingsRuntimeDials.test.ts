import { describe, it, expect } from 'vitest'
import { app } from '../../app'
import { getSettings, getManagerRuntimeDial, setSettings } from '@/lib/server/store'

// The commander's Agent-SDK runtime dial, POSTed by the manager dashboard's
// switch.
//
// WHY THIS FILE EXISTS. The switch was built, wired and type-checked before
// anyone asked whether POST /api/settings would actually STORE what it sent —
// and it would not have: the route narrows every body to USER_SETTINGS_KEYS,
// and the dial key was not on it. The switch would have flipped, the UI would
// have shown ON, the write would have been silently dropped, and the desk
// would have kept launching on PTY. Nothing would have thrown. So the assertion
// that matters here is not "the route returns ok" — it is the ROUND TRIP:
// POST, then read through the same dial reader the desk-launch path uses.
//
// (Until 2026-08-13 this file also round-tripped the WORKER dial and its
// sdkMaxWorkers slot cap. Both died with the PTY worker runtime — workers are
// SDK-only now — and the surviving contract for the old key is the OPPOSITE
// one: a POSTed `swarmWorkerRuntime` must be silently IGNORED, pinned below.)
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

describe('POST /api/settings — commander runtime dial round-trip', () => {
  it('commander dial: the switch reaches the reader the desk launch consults', async () => {
    const res = await app.request('/api/settings', post({ swarmManagerRuntime: { mode: 'sdk' } }))
    expect(res.status).toBe(200)
    // THE assertion: the same function swarmManager.ts calls before seating.
    expect((await getManagerRuntimeDial()).mode).toBe('sdk')

    await app.request('/api/settings', post({ swarmManagerRuntime: { mode: 'pty' } }))
    expect((await getManagerRuntimeDial()).mode).toBe('pty')
  })

  it('the commander dial has no cap field — a smuggled sdkMaxWorkers is dropped', async () => {
    await app.request(
      '/api/settings',
      // A cap on the commander is meaningless (there is exactly one desk) — it is
      // dropped rather than stored as a field no reader will ever consult.
      post({ swarmManagerRuntime: { mode: 'sdk', sdkMaxWorkers: 9 } }),
    )
    expect(await getManagerRuntimeDial()).toEqual({ mode: 'sdk' })
  })

  it('a garbage patch is REFUSED — the previous dial survives, it never falls to a default', async () => {
    await app.request('/api/settings', post({ swarmManagerRuntime: { mode: 'pty' } }))
    for (const junk of [
      { mode: 'PTY' }, // wrong case is not a mode
      { mode: 'turbo' },
      { mode: true },
      {},
      'pty',
      ['pty'],
      null,
      42,
    ]) {
      await app.request('/api/settings', post({ swarmManagerRuntime: junk }))
      // pty seeded on purpose: absent ⇒ sdk, so only an explicit pty can prove
      // the junk patch did not clobber the stored value.
      expect((await getManagerRuntimeDial()).mode, JSON.stringify(junk)).toBe('pty')
    }
  })

  it('a hand-corrupted field reads as PTY; an ABSENT one is the fresh-install default', async () => {
    // The fail direction that matters: a value we cannot READ must land on the
    // shipped behaviour. ABSENT is a different question and has the opposite
    // answer — nothing written yet is a fresh install, whose default flipped to
    // sdk on 2026-08-02. Written straight to the store to simulate a
    // hand-edited file.
    await setSettings({ swarmManagerRuntime: { mode: 'nonsense' } as never })
    expect((await getManagerRuntimeDial()).mode).toBe('pty')
    await setSettings({ swarmManagerRuntime: undefined })
    expect((await getManagerRuntimeDial()).mode).toBe('sdk')
  })

  it('a POSTed swarmWorkerRuntime is silently IGNORED — dropped, never stored, never an error', async () => {
    // The back-compat contract of the 2026-08-13 worker-dial deletion: an old
    // client (or a script from the dial era) that still POSTs the worker key
    // must get a 200 and NO stored key — the allowlist narrowing drops it the
    // same way it drops any non-user-preference field. Read back through the
    // PRODUCTION reader (getSettings), not the response.
    const res = await app.request(
      '/api/settings',
      post({ swarmWorkerRuntime: { mode: 'pty', sdkMaxWorkers: 3 }, displayName: 'ok' }),
    )
    expect(res.status).toBe(200)
    const stored = await getSettings()
    expect('swarmWorkerRuntime' in stored).toBe(false)
    // The rest of the same body still lands — the drop is per-key, not per-request.
    expect(stored.displayName).toBe('ok')
  })
})
