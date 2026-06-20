// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collabRoutes } from '../collab'
import { clearSession, writeSession } from '@/lib/server/authStore'
import { clearMembershipCache } from '@/lib/server/projectMembers'

// The member's local board cache routes (option A). Two gates: a strict-UUID id
// (path-traversal guard, checked BEFORE any lookup) and MEMBERSHIP (caller-JWT).
// The disk layer is unit-tested in src/lib/server/__tests__/sharedCache.test.ts;
// here we pin the HTTP gates. HOME is isolated by setup-home (writes never touch
// the real ~/.openground).

const PID = '55555555-5555-5555-5555-555555555555'

const signIn = () =>
  writeSession({
    user: { id: 'u-mem', email: 'm@e.co', provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'tok',
    refreshToken: 'r',
  })
const anonEnv = () => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon')
}
const stubMembers = (rows: unknown[]) => {
  const fn = vi.fn(async (url: string) =>
    url.includes('og_project_members')
      ? new Response(JSON.stringify(rows), { status: 200 })
      : new Response('[]', { status: 200 }),
  )
  vi.stubGlobal('fetch', fn as unknown as typeof fetch)
  return fn
}
const postJson = (path: string, body: unknown) =>
  collabRoutes.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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

describe('GET /api/collab/shared-data — strict id + membership', () => {
  it('400 for a non-uuid id (traversal guard) BEFORE any membership lookup', async () => {
    anonEnv()
    await signIn()
    const spy = stubMembers([])
    const res = await collabRoutes.request(
      '/api/collab/shared-data?collabProjectId=' + encodeURIComponent('../evil'),
    )
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled() // rejected before reaching Supabase
  })

  it('403 for a non-member', async () => {
    anonEnv()
    await signIn()
    stubMembers([])
    const res = await collabRoutes.request(`/api/collab/shared-data?collabProjectId=${PID}`)
    expect(res.status).toBe(403)
  })

  it('member → 200 { data: null } when nothing is cached yet', async () => {
    anonEnv()
    await signIn()
    stubMembers([{ project_id: PID, user_id: 'u-mem', role: 'member' }])
    const res = await collabRoutes.request(`/api/collab/shared-data?collabProjectId=${PID}`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: null })
  })
})

describe('POST /api/collab/shared-data — strict id + membership', () => {
  it('400 bad id, 400 bad data (member), 403 non-member', async () => {
    anonEnv()
    await signIn()
    stubMembers([{ project_id: PID, role: 'member' }])
    expect(
      (await postJson('/api/collab/shared-data', { collabProjectId: 'nope', data: { tasks: [] } }))
        .status,
    ).toBe(400)
    expect(
      (await postJson('/api/collab/shared-data', { collabProjectId: PID, data: { tasks: 'x' } }))
        .status,
    ).toBe(400)

    clearMembershipCache()
    stubMembers([])
    expect(
      (await postJson('/api/collab/shared-data', { collabProjectId: PID, data: { tasks: [] } }))
        .status,
    ).toBe(403)
  })

  it('member + valid data → { ok: true }', async () => {
    anonEnv()
    await signIn()
    stubMembers([{ project_id: PID, role: 'member' }])
    const res = await postJson('/api/collab/shared-data', {
      collabProjectId: PID,
      data: { description: '', notes: '', updatedAt: '', tasks: [] },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('GET/POST /api/collab/shared-canvas — strict ids + membership (cv4)', () => {
  const CID = 'cv-abc123' // safe canvas id

  it('GET 400 for a bad canvasId (traversal) before any lookup', async () => {
    anonEnv()
    await signIn()
    const spy = stubMembers([])
    const res = await collabRoutes.request(
      `/api/collab/shared-canvas?collabProjectId=${PID}&canvasId=` +
        encodeURIComponent('../evil'),
    )
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })

  it('GET 403 for a non-member; member → 200 { data: null } when uncached', async () => {
    anonEnv()
    await signIn()
    stubMembers([])
    expect(
      (await collabRoutes.request(`/api/collab/shared-canvas?collabProjectId=${PID}&canvasId=${CID}`))
        .status,
    ).toBe(403)

    clearMembershipCache()
    stubMembers([{ project_id: PID, user_id: 'u-mem', role: 'member' }])
    const res = await collabRoutes.request(
      `/api/collab/shared-canvas?collabProjectId=${PID}&canvasId=${CID}`,
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ data: null })
  })

  it('POST 400 bad id / bad data; member + valid → { ok: true }', async () => {
    anonEnv()
    await signIn()
    stubMembers([{ project_id: PID, role: 'member' }])
    expect(
      (await postJson('/api/collab/shared-canvas', { collabProjectId: PID, canvasId: '../x', data: { elements: [] } }))
        .status,
    ).toBe(400)
    expect(
      (await postJson('/api/collab/shared-canvas', { collabProjectId: PID, canvasId: CID, data: { elements: 'no' } }))
        .status,
    ).toBe(400)
    const ok = await postJson('/api/collab/shared-canvas', {
      collabProjectId: PID,
      canvasId: CID,
      data: { id: CID, name: 'C', viewport: { x: 0, y: 0, zoom: 1 }, elements: [], chats: [], activeChatId: null, sidebarOpen: false, sidebarWidth: null, createdAt: '', updatedAt: '' },
    })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ ok: true })
  })
})
