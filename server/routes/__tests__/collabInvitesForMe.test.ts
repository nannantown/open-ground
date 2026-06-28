// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collabRoutes } from '../collab'
import { clearSession, writeSession } from '@/lib/server/authStore'
import { clearMembershipCache } from '@/lib/server/projectMembers'

// HTTP contract for GET /api/collab/invites — the signed-in user's pending collab
// INVITES (projects shared WITH them they don't own), the first notification
// source for the Ground お知らせ bell. The route is SELF-SCOPED BY RLS server-side:
// listInvitesForMe reads og_project_members under the caller's own JWT, so a user
// can only ever see invites addressed to themselves. setup-home.ts isolates HOME
// and clears SUPABASE_*, so the signed-out path reaches no backend.

const SHARED = '11111111-1111-1111-1111-111111111111'
const OWNED = '22222222-2222-2222-2222-222222222222'

const getReq = (path: string) => collabRoutes.request(path, { method: 'GET' })

const signIn = () =>
  writeSession({
    user: { id: 'u1', email: 'me@x.co', provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'tok',
    refreshToken: 'r',
  })

// Route the fetch mock by table name in the URL (og_project_members vs og_projects).
const stubBackend = (rosterRows: unknown[], projectRows: unknown[]) => {
  const spy = vi.fn(async (url: string) => {
    if (url.includes('og_project_members'))
      return new Response(JSON.stringify(rosterRows), { status: 200 })
    if (url.includes('og_projects'))
      return new Response(JSON.stringify(projectRows), { status: 200 })
    return new Response('[]', { status: 200 })
  })
  vi.stubGlobal('fetch', spy as unknown as typeof fetch)
  return spy
}

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

describe('GET /api/collab/invites', () => {
  it('signed out → 200 {invites:[]} and NO backend call', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    const res = await getReq('/api/collab/invites')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ invites: [] })
    // listInvitesForMe bails at ownerAuth (no session / no env) before any network.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('composes invites from rosters + projects, and SKIPS projects I own', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await signIn()
    stubBackend(
      [
        // SHARED: I'm a PENDING invitee (matched by email); the owner row is the inviter.
        { project_id: SHARED, user_id: null, email: 'me@x.co', role: 'member', status: 'pending', created_at: '2026-06-20T00:00:00Z' },
        { project_id: SHARED, user_id: 'boss-uid', email: 'boss@x.co', role: 'owner', status: 'accepted', created_at: '2026-06-19T00:00:00Z' },
        // OWNED: I'm the owner → NOT an invite.
        { project_id: OWNED, user_id: 'u1', email: 'me@x.co', role: 'owner', status: 'accepted', created_at: '2026-06-18T00:00:00Z' },
      ],
      [
        { id: SHARED, label: 'Design System', owner_id: 'boss-uid' },
        { id: OWNED, label: null, owner_id: 'u1' },
      ],
    )
    const res = await getReq('/api/collab/invites')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      invites: [
        {
          collabProjectId: SHARED,
          label: 'Design System',
          inviterEmail: 'boss@x.co',
          invitedAt: Date.parse('2026-06-20T00:00:00Z'),
        },
      ],
    })
  })

  it('matches an email-only invite (uid not yet linked, case-insensitive) and tolerates missing label/owner-email', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await signIn()
    const P = '33333333-3333-3333-3333-333333333333'
    stubBackend(
      [
        { project_id: P, user_id: null, email: 'ME@X.CO', role: 'member', status: 'pending' }, // case-insensitive match, no created_at
        { project_id: P, user_id: 'o', email: null, role: 'owner', status: 'accepted' }, // owner email unresolved
      ],
      [{ id: P, label: null, owner_id: 'o' }],
    )
    const res = await getReq('/api/collab/invites')
    expect(await res.json()).toEqual({
      invites: [{ collabProjectId: P, label: null, inviterEmail: null, invitedAt: undefined }],
    })
  })

  it('an ACCEPTED membership is NOT an invite (it shows as a Ground card, not the bell)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await signIn()
    // I'm already an ACCEPTED member of SHARED — once joined, it must leave the
    // お知らせ bell (the invite is done) and live on the Ground instead.
    stubBackend(
      [
        { project_id: SHARED, user_id: 'u1', email: 'me@x.co', role: 'member', status: 'accepted', created_at: '2026-06-20T00:00:00Z' },
        { project_id: SHARED, user_id: 'boss-uid', email: 'boss@x.co', role: 'owner', status: 'accepted' },
      ],
      [{ id: SHARED, label: 'Design System', owner_id: 'boss-uid' }],
    )
    const res = await getReq('/api/collab/invites')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ invites: [] })
  })

  it('returns [] when the backend read fails (never an error to the client)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await signIn()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    )
    const res = await getReq('/api/collab/invites')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ invites: [] })
  })
})
