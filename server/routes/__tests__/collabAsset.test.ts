// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { collabRoutes } from '../collab'
import { clearSession, writeSession } from '@/lib/server/authStore'
import { clearMembershipCache } from '@/lib/server/projectMembers'

// u14b-2: the loopback image proxy. The security-critical surface is the MEMBER
// GET (membership gate + strict-id traversal guard + server-minted ticket →
// Worker proxy), which is fully covered here. The OWNER POST's happy path needs a
// registered project + an on-disk asset + the Worker PUT — that round-trip is
// proven by the Worker miniflare test (PUT) and the client sweep test, plus real
// 2-user QA; here we pin the POST's fast gates (disabled / bad id). HOME is
// isolated by setup-home so nothing touches the real ~/.openground.

const PID = '55555555-5555-5555-5555-555555555555'
const CID = 'cv-abc123'
const AID = 'asset-xyz789'

const signIn = () =>
  writeSession({
    user: { id: 'u-mem', email: 'm@e.co', provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'tok',
    refreshToken: 'r',
  })

// Turn collab ON (the zero-config gate: flag + WS URL + session) + Supabase
// config for membership lookups. NO OPENGROUND_COLLAB_TICKET_SECRET — the asset
// routes now relay for their board ticket (the Worker holds the only secret).
const collabEnv = () => {
  vi.stubEnv('OPENGROUND_REALTIME', '1')
  vi.stubEnv('OPENGROUND_COLLAB_WS_URL', 'wss://og-collab.example.workers.dev')
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon')
}

// Stub global fetch for Supabase membership, the Worker's POST /ticket relay
// (the asset routes mint no ticket locally now — they relay for a board-scope
// one), AND the Worker /assets proxy target. `members` drives og_project_members;
// the asset branch returns a fake image (GET) or 204 (PUT), or a forced status.
const stubFetch = (opts: {
  members?: unknown[]
  assetStatus?: number
  assetBody?: Uint8Array
  assetCT?: string
}) => {
  const {
    members = [],
    assetStatus = 200,
    assetBody = new Uint8Array([1, 2, 3, 4]),
    assetCT = 'image/png',
  } = opts
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('og_project_members')) {
      return new Response(JSON.stringify(members), { status: 200 })
    }
    if (u.includes('/ticket')) {
      // The Worker mints a board ticket after verifying membership under the
      // relayed access token; role echoes back so the PUT (owner) gate works.
      return new Response(
        JSON.stringify({ room: `${PID}:board`, token: 'aGVhZA.c2ln', expiresAt: Date.now() + 60_000 }),
        { status: 200 },
      )
    }
    if (u.includes('/assets/')) {
      if (init?.method === 'PUT') return new Response(null, { status: 204 })
      if (assetStatus === 200) {
        return new Response(assetBody as unknown as BodyInit, {
          status: 200,
          headers: { 'content-type': assetCT },
        })
      }
      return new Response('x', { status: assetStatus })
    }
    return new Response('[]', { status: 200 })
  })
  vi.stubGlobal('fetch', fn as unknown as typeof fetch)
  return fn
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

describe('GET /api/collab/asset — member download proxy', () => {
  it('503 when collab is disabled (no env)', async () => {
    await signIn()
    const res = await collabRoutes.request(
      `/api/collab/asset?collabProjectId=${PID}&canvasId=${CID}&assetId=${AID}`,
    )
    expect(res.status).toBe(503)
  })

  it('400 for a non-uuid id / traversal canvasId, BEFORE any membership lookup', async () => {
    collabEnv()
    await signIn()
    const spy = stubFetch({})
    const bad1 = await collabRoutes.request(
      `/api/collab/asset?collabProjectId=${encodeURIComponent('../evil')}&canvasId=${CID}&assetId=${AID}`,
    )
    expect(bad1.status).toBe(400)
    const bad2 = await collabRoutes.request(
      `/api/collab/asset?collabProjectId=${PID}&canvasId=${encodeURIComponent('../x')}&assetId=${AID}`,
    )
    expect(bad2.status).toBe(400)
    expect(spy).not.toHaveBeenCalled() // rejected before Supabase + Worker
  })

  it('403 for a non-member', async () => {
    collabEnv()
    await signIn()
    stubFetch({ members: [] })
    const res = await collabRoutes.request(
      `/api/collab/asset?collabProjectId=${PID}&canvasId=${CID}&assetId=${AID}`,
    )
    expect(res.status).toBe(403)
  })

  it('member → 200 streaming the Worker bytes + content-type', async () => {
    collabEnv()
    await signIn()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7])
    stubFetch({
      members: [{ project_id: PID, user_id: 'u-mem', role: 'member' }],
      assetBody: bytes,
      assetCT: 'image/png',
    })
    const res = await collabRoutes.request(
      `/api/collab/asset?collabProjectId=${PID}&canvasId=${CID}&assetId=${AID}`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    const got = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(got)).toEqual(Array.from(bytes))
  })

  it('member + Worker 404 → 404', async () => {
    collabEnv()
    await signIn()
    stubFetch({ members: [{ project_id: PID, role: 'member' }], assetStatus: 404 })
    const res = await collabRoutes.request(
      `/api/collab/asset?collabProjectId=${PID}&canvasId=${CID}&assetId=${AID}`,
    )
    expect(res.status).toBe(404)
  })
})

describe('POST /api/collab/asset — owner upload gates', () => {
  it('503 when collab is disabled', async () => {
    await signIn()
    const res = await collabRoutes.request(
      `/api/collab/asset?path=/x&canvasId=${CID}&assetId=${AID}`,
      { method: 'POST' },
    )
    expect(res.status).toBe(503)
  })

  it('400 for a traversal canvasId, before path validation', async () => {
    collabEnv()
    await signIn()
    const spy = stubFetch({})
    const res = await collabRoutes.request(
      `/api/collab/asset?path=/x&canvasId=${encodeURIComponent('../x')}&assetId=${AID}`,
      { method: 'POST' },
    )
    expect(res.status).toBe(400)
    expect(spy).not.toHaveBeenCalled()
  })
})
