// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collabRoutes } from '../collab'
import { clearSession, writeSession } from '@/lib/server/authStore'
import { clearMembershipCache } from '@/lib/server/projectMembers'

// MEMBER flow: a collaborator who joined by invite has NO local folder, so they
// resolve a room by ?collabProjectId= (NOT ?path=). These pin that /project and
// /ticket accept the id-source WITHOUT demanding a path, and still gate strictly
// on MEMBERSHIP (resolved under the caller's JWT via og_project_members).
// setup-home.ts isolates OPENGROUND_HOME + clears SUPABASE_*; the collab env vars
// are newer so we clear/stub them ourselves.

const PID = '44444444-4444-4444-4444-444444444444'
const WS = 'wss://collab.example.workers.dev'

const signIn = () =>
  writeSession({
    user: { id: 'u-mem', email: 'm@e.co', provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'tok',
    refreshToken: 'r',
  })

// Route the global fetch stub by URL: the Supabase membership lookup, the label
// read, AND — in the zero-config model — the Worker's POST /ticket relay (the
// route no longer mints locally; it forwards the access token to the Worker,
// which returns the ticket). The membership rows drive whether the relay is even
// reached.
const stubSupabase = (memberRows: unknown[]) => {
  const spy = vi.fn(async (url: string) => {
    if (url.includes('og_project_members'))
      return new Response(JSON.stringify(memberRows), { status: 200 })
    if (url.includes('og_projects'))
      return new Response(JSON.stringify([{ label: 'Shared X' }]), { status: 200 })
    if (url.includes('/ticket'))
      return new Response(
        JSON.stringify({ room: 'relayed', token: 'aGVhZA.c2ln', expiresAt: Date.now() + 60_000 }),
        { status: 200 },
      )
    return new Response('[]', { status: 200 })
  })
  vi.stubGlobal('fetch', spy as unknown as typeof fetch)
  return spy
}

const anonEnv = () => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon')
}
// NO OPENGROUND_COLLAB_TICKET_SECRET — the zero-config relay needs no local
// secret; the Worker holds the only copy.
const enableCollab = () => {
  anonEnv()
  vi.stubEnv('OPENGROUND_REALTIME', '1')
  vi.stubEnv('OPENGROUND_COLLAB_WS_URL', WS)
}

beforeEach(async () => {
  delete process.env.OPENGROUND_REALTIME
  delete process.env.OPENGROUND_COLLAB_WS_URL
  delete process.env.OPENGROUND_COLLAB_TICKET_SECRET
  delete process.env.OPENGROUND_COLLAB_MEMBER_PROJECTS
  clearMembershipCache()
  await clearSession()
})
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  clearMembershipCache()
  await clearSession()
})

describe('GET /api/collab/project?collabProjectId= (member, no path)', () => {
  it('resolves membership by id WITHOUT a path → {member:true, label}', async () => {
    anonEnv()
    await signIn()
    stubSupabase([{ project_id: PID, user_id: 'u-mem', role: 'member' }])
    const res = await collabRoutes.request(`/api/collab/project?collabProjectId=${PID}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      collabProjectId: PID,
      member: true,
      label: 'Shared X',
    })
  })

  it('non-member id → {collabProjectId:null, member:false} (no leak)', async () => {
    anonEnv()
    await signIn()
    stubSupabase([]) // RLS returns no membership row
    const res = await collabRoutes.request(`/api/collab/project?collabProjectId=${PID}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ collabProjectId: null, member: false })
  })
})

describe('GET /api/collab/ticket?collabProjectId= (member, no path)', () => {
  it('does NOT require a path: collab-disabled → 503 (not 400 path-required)', async () => {
    // No collab env → collabEnabled false. A collabProjectId + no path must 503
    // (disabled), proving the route no longer demands ?path=.
    await signIn()
    const res = await collabRoutes.request(
      `/api/collab/ticket?collabProjectId=${PID}&scope=board`,
    )
    expect(res.status).toBe(503)
  })

  it('rejects a bad scope (400) before resolving', async () => {
    enableCollab()
    await signIn()
    const res = await collabRoutes.request(
      `/api/collab/ticket?collabProjectId=${PID}&scope=bogus`,
    )
    expect(res.status).toBe(400)
  })

  it('enabled + signed in but NOT a member → 412 (RLS hides the project)', async () => {
    enableCollab()
    await signIn()
    stubSupabase([]) // membership lookup returns nothing
    // A non-member can't even see the og_projects row (RLS), so the id resolves
    // to null → 412 "no collab project" (rather than 403), which leaks nothing
    // about whether the project exists. Either way: no ticket is minted.
    const res = await collabRoutes.request(
      `/api/collab/ticket?collabProjectId=${PID}&scope=board`,
    )
    expect(res.status).toBe(412)
  })

  it('enabled + member → 200 with a ticket bound to <pid>:board', async () => {
    enableCollab()
    await signIn()
    stubSupabase([{ project_id: PID, user_id: 'u-mem', role: 'member' }])
    const res = await collabRoutes.request(
      `/api/collab/ticket?collabProjectId=${PID}&scope=canvas:abc`,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { room: string; wsUrl: string; token: string }
    expect(body.room).toBe(`${PID}:canvas:abc`)
    expect(body.wsUrl).toBe(WS)
    expect(body.token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })
})
