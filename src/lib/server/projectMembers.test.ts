import { describe, it, expect, vi, beforeEach } from 'vitest'

// findOwnProjectIdByPath's TRI-STATE contract is what keeps the collab mirror
// honest (collabMirror.ts caches null as "definitely not shared" but retries
// undefined): a transient token-refresh failure while a session EXISTS must be
// `undefined`, never a cacheable null — otherwise an offline stretch longer
// than the access-token lifetime consumes pending mirrors as "not shared" and
// the c2e4c57c revert bug resurfaces (review must-fix).

const mocks = vi.hoisted(() => ({
  readAuthConfig: vi.fn(),
  getFreshAccessToken: vi.fn(),
  readSession: vi.fn(),
}))
vi.mock('./supabaseAuth', () => ({
  readAuthConfig: mocks.readAuthConfig,
  getFreshAccessToken: mocks.getFreshAccessToken,
}))
vi.mock('./authStore', () => ({
  readSession: mocks.readSession,
}))

import { findOwnProjectIdByPath } from './projectMembers'

const CONFIG = { url: 'https://sb.example', anonKey: 'anon' }
const SESSION = { user: { id: 'uid-1' } }

beforeEach(() => {
  vi.restoreAllMocks()
  mocks.readAuthConfig.mockReturnValue(CONFIG)
  mocks.getFreshAccessToken.mockResolvedValue('tok')
  mocks.readSession.mockResolvedValue(SESSION)
})

describe('findOwnProjectIdByPath — tri-state (string | null | undefined)', () => {
  it('unconfigured → null (DEFINITE, cacheable)', async () => {
    mocks.readAuthConfig.mockReturnValue(null)
    await expect(findOwnProjectIdByPath('/p')).resolves.toBeNull()
  })

  it('genuinely signed out (no stored session) → null (DEFINITE, cacheable)', async () => {
    mocks.readSession.mockResolvedValue(null)
    await expect(findOwnProjectIdByPath('/p')).resolves.toBeNull()
  })

  it('session EXISTS but the token refresh failed → undefined (TRANSIENT — retry, never cache)', async () => {
    mocks.getFreshAccessToken.mockResolvedValue(null) // offline / auth blip
    await expect(findOwnProjectIdByPath('/p')).resolves.toBeUndefined()
  })

  it('a failed Supabase lookup → undefined (findOwnProjectByHash contract preserved)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'))
    await expect(findOwnProjectIdByPath('/p')).resolves.toBeUndefined()
    fetchSpy.mockRestore()
  })

  it('a found row → its id; no row → null (find-only, one GET, never a create)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify([{ id: 'pid-1' }]), { status: 200 }))
    await expect(findOwnProjectIdByPath('/p')).resolves.toBe('pid-1')
    fetchSpy.mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
    await expect(findOwnProjectIdByPath('/p')).resolves.toBeNull()
    // find-only: every call was a GET (no POST = no row creation)
    for (const call of fetchSpy.mock.calls) {
      const init = call[1] as RequestInit | undefined
      expect(init?.method ?? 'GET').toBe('GET')
    }
    fetchSpy.mockRestore()
  })
})