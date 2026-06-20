// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collabRoutes } from '../collab'
import { clearSession, writeSession } from '@/lib/server/authStore'

// The global capability gate (ZERO-CONFIG model). `enabled` is true ONLY when
// ALL THREE hold (see collabEnabled() in server/routes/collab.ts):
//   1. OPENGROUND_REALTIME flag on,
//   2. OPENGROUND_COLLAB_WS_URL set (the Worker WS endpoint),
//   3. a signed-in session.
// The HMAC ticket secret is NO LONGER part of the gate — it lives only on the
// operator Worker now (the Hono relays the user's access token to the Worker,
// which mints), so a user's machine needs no secret to enable collab. When the
// flag is unset (the public build) the gate is always false, which keeps the
// y-partyserver/yjs bundle and the collab UI out of the default experience.
// setup-home.ts clears SUPABASE_* but NOT these collab vars (they're newer), so
// we delete them ourselves before each case and stub per-test.

const WS_URL = 'wss://collab.example.workers.dev'

const signIn = () =>
  writeSession({
    user: { id: 'u1', email: 'a@b.co', provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'tok',
    refreshToken: 'r',
  })

const enabled = async (): Promise<boolean> => {
  const res = await collabRoutes.request('/api/collab/config')
  return ((await res.json()) as { enabled: boolean }).enabled
}

beforeEach(async () => {
  // The owner's live shell may export these; clear so the gate is hermetic.
  delete process.env.OPENGROUND_REALTIME
  delete process.env.OPENGROUND_COLLAB_WS_URL
  delete process.env.OPENGROUND_COLLAB_TICKET_SECRET
  await clearSession()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  await clearSession()
})

describe('GET /api/collab/config', () => {
  it('disabled when OPENGROUND_REALTIME is unset (even with WS URL + signed in)', async () => {
    vi.stubEnv('OPENGROUND_COLLAB_WS_URL', WS_URL)
    await signIn()
    expect(await enabled()).toBe(false)
  })

  it('disabled when the flag is on but the Worker WS URL is unset', async () => {
    vi.stubEnv('OPENGROUND_REALTIME', '1')
    await signIn()
    expect(await enabled()).toBe(false)
  })

  it('disabled when flag + WS URL are set but signed out', async () => {
    vi.stubEnv('OPENGROUND_REALTIME', '1')
    vi.stubEnv('OPENGROUND_COLLAB_WS_URL', WS_URL)
    await clearSession()
    expect(await enabled()).toBe(false)
  })

  it('enabled with flag + WS URL + session — NO ticket secret needed (it lives only on the Worker)', async () => {
    vi.stubEnv('OPENGROUND_REALTIME', '1')
    vi.stubEnv('OPENGROUND_COLLAB_WS_URL', WS_URL)
    // OPENGROUND_COLLAB_TICKET_SECRET intentionally NOT set — the zero-config
    // relay needs no local secret, yet the gate must still enable.
    await signIn()
    expect(await enabled()).toBe(true)
  })
})

// Member-flow groundwork (server only): the "shared with me" enumeration route.
// listMyProjects() itself is unit-tested in projectMembers.test.ts; here we just
// prove the route is wired and shaped as { projects }. Signed out (no auth) →
// listMyProjects bails to [], so the route returns an empty list (no throw).
describe('GET /api/collab/projects', () => {
  it('returns { projects: [] } when signed out (no fetch / no throw)', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const res = await collabRoutes.request('/api/collab/projects')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ projects: [] })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
