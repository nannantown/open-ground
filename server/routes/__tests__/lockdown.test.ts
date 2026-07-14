import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { app } from '../../app'
import { getSettings, setSettings } from '@/lib/server/store'
import { writeSession, readSession, clearSession } from '@/lib/server/authStore'

// Work mode (lockdown) — the route-gate layer (src/lib/server/lockdown.ts
// LAYER 1). Every external-egress feature must report itself unavailable /
// refuse while Settings.lockdownMode is on, WITHOUT touching the network, and
// come straight back when it is turned off (the toggle round-trip contract).
//
// HOME is tmp-isolated (src/test/setup-home.ts), so setSettings writes a real
// settings.json in the sandbox and the routes read it back — the same path
// production takes. The global fetch is replaced with a spy that THROWS on any
// call: these gates must answer before any egress code runs, so "fetch was
// never called" is the strongest observable fact each case asserts.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const lockdownOn = () => setSettings({ lockdownMode: true })
const lockdownOff = () => setSettings({ lockdownMode: false })

// A fetch spy that fails the test loudly if ANY route under lockdown reaches
// for the network.
const trapFetch = () => {
  const spy = vi.fn(async (input: unknown) => {
    throw new Error(`unexpected egress during lockdown: ${String(input)}`)
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await clearSession()
  await lockdownOff()
})

// ─── The switch itself (the 3-piece persistence set) ─────────────────────────

describe('lockdown — the settings switch persists through the untrusted route', () => {
  it('POST /api/settings {lockdownMode:true} is SAVED (USER_SETTINGS_KEYS) and read back', async () => {
    const res = await app.request('/api/settings', json({ lockdownMode: true }))
    expect(res.status).toBe(200)
    expect((await getSettings()).lockdownMode).toBe(true)

    const get = await app.request('/api/settings')
    const body = await get.json()
    expect(body.lockdownMode).toBe(true)
  })

  it('a forged truthy non-boolean persists as false (never turns the mode on)', async () => {
    await app.request('/api/settings', json({ lockdownMode: 'yes' }))
    expect((await getSettings()).lockdownMode).toBe(false)
  })

  it('POST {lockdownMode:false} turns it back off (round trip)', async () => {
    await app.request('/api/settings', json({ lockdownMode: true }))
    await app.request('/api/settings', json({ lockdownMode: false }))
    expect((await getSettings()).lockdownMode).toBe(false)
  })
})

// ─── Update check + release notes (GitHub egress) ─────────────────────────────

describe('lockdown ON — GitHub routes answer locally, zero fetch', () => {
  it('GET /api/update/check → lockdown:true, hasUpdate:false, no fetch', async () => {
    await lockdownOn()
    const spy = trapFetch()
    const res = await app.request('/api/update/check')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lockdown).toBe(true)
    expect(body.hasUpdate).toBe(false)
    expect(body.current).toBe(body.latest)
    expect(spy).not.toHaveBeenCalled()
  })

  it('GET /api/release-notes → lockdown:true, empty list, no fetch', async () => {
    await lockdownOn()
    const spy = trapFetch()
    const res = await app.request('/api/release-notes')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lockdown).toBe(true)
    expect(body.releases).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })
})

// ─── Feedback (Supabase egress) ───────────────────────────────────────────────

describe('lockdown ON — feedback reports disabled and refuses, even when env-configured', () => {
  it('GET /api/feedback/config → enabled:false, canRead:false (config present)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
    await lockdownOn()
    const spy = trapFetch()
    const res = await app.request('/api/feedback/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false, canRead: false })
    expect(spy).not.toHaveBeenCalled()
  })

  it('POST /api/feedback → 503, no fetch', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await lockdownOn()
    const spy = trapFetch()
    const res = await app.request('/api/feedback', json({ message: 'hello' }))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/work mode/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it('GET /api/feedback/list and /unread → 503, no fetch', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-key')
    await lockdownOn()
    const spy = trapFetch()
    expect((await app.request('/api/feedback/list')).status).toBe(503)
    expect((await app.request('/api/feedback/unread')).status).toBe(503)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ─── App login (Supabase Auth egress) ─────────────────────────────────────────

describe('lockdown ON — auth reports disabled; the stored session survives untouched', () => {
  const authEnv = () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  }

  it('GET /api/auth/config → enabled:false (config present)', async () => {
    authEnv()
    await lockdownOn()
    const res = await app.request('/api/auth/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
  })

  it('GET /api/auth/start → 503', async () => {
    authEnv()
    await lockdownOn()
    const res = await app.request('/api/auth/start?provider=google')
    expect(res.status).toBe(503)
  })

  it('GET /api/auth/session with an EXPIRED session → {user:null}, NO refresh fetch, auth.json kept', async () => {
    authEnv()
    await writeSession({
      user: { id: 'u1', email: 'a@example.com', provider: 'google' },
      expiresAt: Date.now() - 1000, // expired → the non-lockdown path would refresh
      accessToken: 'stale-access',
      refreshToken: 'still-valid-refresh',
    })
    await lockdownOn()
    const spy = trapFetch()
    const res = await app.request('/api/auth/session')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: null })
    expect(spy).not.toHaveBeenCalled()
    // The stored session must survive so lockdown-off restores the account.
    expect(await readSession()).not.toBeNull()
  })

  it('POST /api/auth/signout → 503, session kept, no remote revoke', async () => {
    authEnv()
    await writeSession({
      user: { id: 'u1', email: 'a@example.com', provider: 'google' },
      expiresAt: Date.now() + 3_600_000,
      accessToken: 'access',
      refreshToken: 'refresh',
    })
    await lockdownOn()
    const spy = trapFetch()
    const res = await app.request('/api/auth/signout', { method: 'POST' })
    expect(res.status).toBe(503)
    expect(spy).not.toHaveBeenCalled()
    expect(await readSession()).not.toBeNull()
  })
})

// ─── Collab (Supabase + Cloudflare Worker egress) ─────────────────────────────

describe('lockdown ON — collab config reports disabled; every other collab route 503s', () => {
  const collabEnv = () => {
    vi.stubEnv('OPENGROUND_REALTIME', '1')
    vi.stubEnv('OPENGROUND_COLLAB_WS_URL', 'wss://og-collab.example.workers.dev')
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  }

  it('GET /api/collab/config → {enabled:false} even fully configured + signed in', async () => {
    collabEnv()
    await writeSession({
      user: { id: 'u1', email: 'a@example.com', provider: 'google' },
      expiresAt: Date.now() + 3_600_000,
      accessToken: 'access',
      refreshToken: 'refresh',
    })
    await lockdownOn()
    const spy = trapFetch()
    const res = await app.request('/api/collab/config')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ enabled: false })
    expect(spy).not.toHaveBeenCalled()
  })

  it('ticket / project / invites / join → 503 via the group middleware, no fetch', async () => {
    collabEnv()
    await lockdownOn()
    const spy = trapFetch()
    for (const path of [
      '/api/collab/ticket?path=/tmp&scope=board',
      '/api/collab/project?path=/tmp',
      '/api/collab/invites',
    ]) {
      const res = await app.request(path)
      expect(res.status, path).toBe(503)
      expect((await res.json()).error, path).toMatch(/work mode/i)
    }
    const join = await app.request('/api/collab/join', json({ code: 'abc' }))
    expect(join.status).toBe(503)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ─── Marketplace + module submissions (Supabase egress) ───────────────────────

describe('lockdown ON — marketplace refuses; LOCAL custom-module CRUD stays available', () => {
  it('GET /api/custom-modules still 200 (local list), with marketAvailable:false', async () => {
    await lockdownOn()
    const res = await app.request('/api/custom-modules')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.marketAvailable).toBe(false)
    expect(Array.isArray(body.modules)).toBe(true)
  })

  it('marketplace list / install / publish → 503, no fetch', async () => {
    await lockdownOn()
    const spy = trapFetch()
    expect((await app.request('/api/marketplace')).status).toBe(503)
    expect(
      (await app.request('/api/marketplace/install', json({ remoteId: 'x' }))).status,
    ).toBe(503)
    expect(
      (await app.request('/api/custom-modules/some-id/publish', { method: 'POST' })).status,
    ).toBe(503)
    expect(spy).not.toHaveBeenCalled()
  })

  it('module-submissions: config reports disabled; submit/list 503', async () => {
    await lockdownOn()
    const spy = trapFetch()
    const config = await app.request('/api/module-submissions/config')
    expect(config.status).toBe(200)
    expect(await config.json()).toEqual({ enabled: false, canReview: false })

    const submit = await app.request(
      '/api/module-submissions',
      json({ name: 'x', framework: 'react', source: 'export default 1' }),
    )
    expect(submit.status).toBe(503)
    expect((await app.request('/api/module-submissions')).status).toBe(503)
    expect(spy).not.toHaveBeenCalled()
  })
})

// ─── The round trip (OFF restores everything) ─────────────────────────────────

describe('lockdown round trip — turning it OFF restores every gate', () => {
  it('update/check fetches GitHub again after OFF', async () => {
    await lockdownOn()
    let res = await app.request('/api/update/check')
    expect((await res.json()).lockdown).toBe(true)

    await lockdownOff()
    // Now the route SHOULD reach for GitHub — serve a canned release.
    const spy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.0.1',
          html_url: 'https://example.com',
          published_at: '2026-01-01T00:00:00Z',
          body: '',
          draft: false,
          prerelease: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', spy)
    res = await app.request('/api/update/check')
    const body = await res.json()
    expect(body.lockdown).toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('feedback/auth/collab configs report their env-derived state again after OFF', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await lockdownOn()
    expect((await (await app.request('/api/feedback/config')).json()).enabled).toBe(false)
    expect((await (await app.request('/api/auth/config')).json()).enabled).toBe(false)

    await lockdownOff()
    expect((await (await app.request('/api/feedback/config')).json()).enabled).toBe(true)
    expect((await (await app.request('/api/auth/config')).json()).enabled).toBe(true)
    // Collab stays false for its OWN reasons (no realtime env) — but the
    // middleware no longer 503s the group.
    const project = await app.request('/api/collab/invites')
    expect(project.status).toBe(200)
  })

  it('marketplace availability returns after OFF', async () => {
    await lockdownOn()
    expect((await (await app.request('/api/custom-modules')).json()).marketAvailable).toBe(false)
    await lockdownOff()
    expect((await (await app.request('/api/custom-modules')).json()).marketAvailable).toBe(true)
  })
})

// ─── The Anthropic path is deliberately OUTSIDE the switch ────────────────────
// Work mode exists so the user's own Claude subscription is the ONLY egress —
// the claude CLI control plane must keep answering while everything else 503s.

describe('lockdown — claude/PTY control plane is NOT gated', () => {
  it('ON: the terminal router still answers (no 503, no fetch)', async () => {
    await lockdownOn()
    const spy = trapFetch()
    const res = await app.request('/api/terminal/active')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { claude: unknown[] }
    expect(Array.isArray(body.claude)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('the claude launch/exec sources never import the lockdown module (the §12 contract)', () => {
    // Static pin: if a future edit routes claude/PTY spawning through the
    // lockdown gate, this fails before any user hits a dead terminal.
    // Imports only — prose/comments may legitimately mention the word.
    const root = resolve(__dirname, '../../..')
    for (const rel of [
      'src/lib/server/claudeTerminal.ts',
      'src/lib/server/terminal.ts',
      'src/lib/server/swarmLaunch.ts',
      'server/routes/terminal.ts',
    ]) {
      const src = readFileSync(resolve(root, rel), 'utf8')
      expect(
        /(?:import[^\n]*|require\()[^\n]*lockdown/i.test(src),
        `${rel} must not import lockdown`,
      ).toBe(false)
    }
  })
})
