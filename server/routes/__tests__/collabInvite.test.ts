// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collabRoutes } from '../collab'
import { clearSession, writeSession } from '@/lib/server/authStore'
import { clearMembershipCache } from '@/lib/server/projectMembers'

// HTTP contract for the LINK-based self-join routes (migration 0007). The helper
// behaviour (createInviteLink / joinWithInvite) is unit-tested in
// src/lib/server/__tests__/collabInvites.test.ts; here we pin the route wiring:
// the project-path security boundary on /invite-link, and the login-required +
// input-validation contract on /join. setup-home.ts isolates OPENGROUND_HOME and
// clears SUPABASE_*, so /etc is registered by NOBODY (→ 403) and a signed-out
// /join can reach no backend.

const ETC = '/etc' // never registered → 403 from the path guard

const postJson = (path: string, body: unknown) =>
  collabRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const signIn = () =>
  writeSession({
    user: { id: 'u1', email: 'a@b.co', provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'tok',
    refreshToken: 'r',
  })

beforeEach(async () => {
  clearMembershipCache()
  await clearSession()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  clearMembershipCache()
  await clearSession()
})

describe('POST /api/collab/invite-link — path security boundary', () => {
  it('400 when no path is supplied', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)
    const res = await postJson('/api/collab/invite-link', {})
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('403 for an unregistered path (registry is the allowlist) — no Supabase write', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)
    await signIn()
    const res = await postJson('/api/collab/invite-link', { path: ETC })
    expect(res.status).toBe(403)
    // The path guard rejects BEFORE any membership resolution or invite mint.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/collab/join — login-required, input-validated', () => {
  it('400 when the code field is missing or blank (no backend call)', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify('x'), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await signIn()

    expect((await postJson('/api/collab/join', {})).status).toBe(400)
    expect((await postJson('/api/collab/join', { code: '   ' })).status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('signed out → 200 {ok:false,error:not signed in}, no backend call (login-required)', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify('x'), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    // No session, no Supabase env (setup-home cleared it): joinWithInvite bails
    // at callerAuth before any network.
    const res = await postJson('/api/collab/join', { code: 'some-code' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, error: 'not signed in' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('valid code (signed in + configured) → 200 {ok:true,collabProjectId} from the RPC', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await signIn()
    const PID = '33333333-3333-3333-3333-333333333333'
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(PID), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)

    const res = await postJson('/api/collab/join', { code: 'good-code' })
    expect(res.status).toBe(200)
    // Legacy bare-uuid RPC body → treated as an immediate join.
    expect(await res.json()).toEqual({ ok: true, collabProjectId: PID, status: 'joined' })
    const [url] = fetchSpy.mock.calls[0] as unknown as [string]
    expect(url).toContain('/rest/v1/rpc/join_with_invite')
  })

  it('approval-mode redeem (jsonb {status:pending}) → 200 {ok,status:pending}', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await signIn()
    const PID = '44444444-4444-4444-4444-444444444444'
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ project_id: PID, status: 'pending' }), { status: 200 }),
      ),
    )
    const res = await postJson('/api/collab/join', { code: 'approval-code' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, collabProjectId: PID, status: 'pending' })
  })
})

describe('POST /api/collab/label — owner sets the shared name, path-gated', () => {
  it('400 when no path is supplied', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    const res = await postJson('/api/collab/label', { label: 'X' })
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('403 for an unregistered path — no Supabase write', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    await signIn()
    const res = await postJson('/api/collab/label', { path: ETC, label: 'X' })
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/collab/invite-link/revoke — owner revokes all links, path-gated', () => {
  it('400 when no path is supplied', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    const res = await postJson('/api/collab/invite-link/revoke', {})
    expect(res.status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('403 for an unregistered path — no Supabase delete', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    await signIn()
    const res = await postJson('/api/collab/invite-link/revoke', { path: ETC })
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

const getReq = (path: string) => collabRoutes.request(path, { method: 'GET' })

describe('invite v2 routes — path security boundary', () => {
  it('POST /invite-link accepts mode/maxUses/memberCap but stays path-gated (403 on ETC)', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)
    await signIn()
    const res = await postJson('/api/collab/invite-link', {
      path: ETC,
      mode: 'approval',
      maxUses: 1,
      memberCap: 5,
    })
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POST /invite-link/reset: 400 no path, 403 unregistered (no Supabase)', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect((await postJson('/api/collab/invite-link/reset', {})).status).toBe(400)
    await signIn()
    expect(
      (await postJson('/api/collab/invite-link/reset', { path: ETC })).status,
    ).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POST /invite-link/revoke accepts an inviteId but stays path-gated (403 on ETC)', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    await signIn()
    const res = await postJson('/api/collab/invite-link/revoke', {
      path: ETC,
      inviteId: 'inv-1',
    })
    expect(res.status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('GET /invite-links: 400 no path, 403 unregistered', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect((await getReq('/api/collab/invite-links')).status).toBe(400)
    await signIn()
    expect(
      (await getReq(`/api/collab/invite-links?path=${encodeURIComponent(ETC)}`)).status,
    ).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('GET /join-requests: 400 no path, 403 unregistered', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect((await getReq('/api/collab/join-requests')).status).toBe(400)
    await signIn()
    expect(
      (await getReq(`/api/collab/join-requests?path=${encodeURIComponent(ETC)}`)).status,
    ).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POST /join-requests/approve: 400 no path, 403 unregistered, never hits Supabase', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect((await postJson('/api/collab/join-requests/approve', { requestId: 'r' })).status).toBe(400)
    await signIn()
    expect(
      (await postJson('/api/collab/join-requests/approve', { path: ETC, requestId: 'r' })).status,
    ).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POST /join-requests/deny: 400 no path, 403 unregistered', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect((await postJson('/api/collab/join-requests/deny', { requestId: 'r' })).status).toBe(400)
    await signIn()
    expect(
      (await postJson('/api/collab/join-requests/deny', { path: ETC, requestId: 'r' })).status,
    ).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POST /invite/cancel: 400 no path, 403 unregistered (path-gated like /remove)', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect((await postJson('/api/collab/invite/cancel', { email: 'a@b.co' })).status).toBe(400)
    await signIn()
    expect(
      (await postJson('/api/collab/invite/cancel', { path: ETC, email: 'a@b.co' })).status,
    ).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('POST /api/collab/accept — invitee accepts their own pending invite (member flow)', () => {
  const WS_URL = 'wss://collab.example.workers.dev'
  // accept is gated on collabEnabled() (flag + WS URL + session) — NOT a path.
  const enableCollab = async () => {
    vi.stubEnv('OPENGROUND_REALTIME', '1')
    vi.stubEnv('OPENGROUND_COLLAB_WS_URL', WS_URL)
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await signIn()
  }

  it('503 when collab is disabled (the default build), no backend call', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await signIn() // signed in, but OPENGROUND_REALTIME unset → collab off
    const res = await postJson('/api/collab/accept', {
      collabProjectId: '33333333-3333-3333-3333-333333333333',
    })
    expect(res.status).toBe(503)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('400 for a malformed collabProjectId (strict-UUID guard), no backend call', async () => {
    await enableCollab()
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect((await postJson('/api/collab/accept', {})).status).toBe(400)
    expect((await postJson('/api/collab/accept', { collabProjectId: 'not-a-uuid' })).status).toBe(400)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('valid id → calls the accept_invite RPC and returns its result', async () => {
    await enableCollab()
    const PID = '33333333-3333-3333-3333-333333333333'
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ project_id: PID, accepted: 1 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)
    const res = await postJson('/api/collab/accept', { collabProjectId: PID })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, accepted: 1 })
    const [url] = fetchSpy.mock.calls[0] as unknown as [string]
    expect(url).toContain('/rest/v1/rpc/accept_invite')
  })
})
