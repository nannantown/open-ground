import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { getFreshSession } from './supabaseAuth'
import type { StoredSession } from './authStore'
const h = vi.hoisted(() => ({ session: null as StoredSession | null }))
vi.mock('./authStore', () => ({ readSession: async () => h.session, writeSession: async (s: StoredSession) => { h.session = s } }))
vi.mock('./lockdown', () => ({ isLockdownEnabledSync: () => false }))
beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://auth.example'); vi.stubEnv('SUPABASE_ANON_KEY', 'public')
  h.session = { user: { id: 'a', provider: 'google' }, accessToken: 'old', refreshToken: `refresh-${Math.random()}`, expiresAt: 0 }
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it('concurrent callers share one rotated-token refresh', async () => {
  const fetcher = vi.fn(async () => Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 }))
  vi.stubGlobal('fetch', fetcher)
  const [a, b] = await Promise.all([getFreshSession(), getFreshSession()])
  expect(fetcher).toHaveBeenCalledTimes(1); expect(a?.accessToken).toBe('new'); expect(b).toEqual(a)
  expect(h.session?.refreshToken).toBe('rotated')
})
it('late refresh cannot resurrect a signed-out session', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { h.session = null; return Response.json({ access_token: 'new', refresh_token: 'rotated' }) }))
  expect(await getFreshSession()).toBeNull(); expect(h.session).toBeNull()
})
it('temporary refresh failure preserves stored login for recovery', async () => {
  const old = h.session
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
  expect(await getFreshSession()).toBeNull(); expect(h.session).toEqual(old)
})
