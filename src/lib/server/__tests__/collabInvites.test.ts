// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  createInviteLink,
  joinWithInvite,
  revokeProjectInvites,
  resetInviteLinks,
  listInviteLinks,
  getProjectMemberCap,
  setProjectMemberCap,
  listJoinRequests,
  approveJoinRequest,
  denyJoinRequest,
} from '../collabInvites'
import {
  getMyMembership,
  clearMembershipCache,
} from '../projectMembers'
import { writeSession, clearSession } from '../authStore'

// LINK-based self-join (migration 0007). Identity comes from the persisted app
// session; HOME is tmp-isolated by src/test/setup-home.ts (which also clears
// SUPABASE_*). Both helpers run with the caller's OWN JWT (no service-role) and
// must NEVER throw — a non-owner mint / bad-code redeem / offline call is a quiet
// { ok:false }. Mirrors projectMembers.test.ts.

const PROJECT = '22222222-2222-2222-2222-222222222222'

const signInAs = (email: string, id = 'test-user') =>
  writeSession({
    user: { id, email, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
  })

const stubAnonEnv = () => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>

beforeEach(() => {
  delete process.env.OPENGROUND_COLLAB_MEMBER_PROJECTS
  clearMembershipCache()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  clearMembershipCache()
  await clearSession()
})

describe('createInviteLink — owner-JWT mint of an og_project_invites row', () => {
  it('unconfigured (no SUPABASE_URL) → {ok:false}, no fetch', async () => {
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await createInviteLink(PROJECT)).toEqual({ ok: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('signed out (no JWT) → {ok:false}, no fetch even with anon env', async () => {
    stubAnonEnv()
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await createInviteLink(PROJECT)).toEqual({ ok: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('empty collabProjectId → {ok:false}, no fetch', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await createInviteLink('')).toEqual({ ok: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs a random base64url token under the owner JWT and returns code + parsed expiry', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com', 'owner-uid')
    const expiresIso = '2026-06-22T00:00:00.000Z'
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      // Echo the row PostgREST would return (Prefer: return=representation),
      // copying back the server-generated token from the request body.
      const sent = JSON.parse(init.body as string) as { token: string }
      return new Response(
        JSON.stringify([{ token: sent.token, expires_at: expiresIso }]),
        { status: 201 },
      )
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    const res = await createInviteLink(PROJECT)
    expect(res.ok).toBe(true)
    // 256-bit base64url secret: 43 chars, URL-safe alphabet, no padding.
    expect(res.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(res.expiresAt).toBe(Date.parse(expiresIso))

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/rest/v1/og_project_invites')
    expect(init.method).toBe('POST')
    expect(headersOf(init).apikey).toBe('anon-key')
    expect(headersOf(init).Authorization).toBe('Bearer test-access')
    expect(headersOf(init).Prefer).toContain('return=representation')
    const body = JSON.parse(init.body as string) as { project_id: string; token: string }
    expect(body.project_id).toBe(PROJECT)
    expect(body.token).toBe(res.code) // the row echoes the server-generated token
  })

  it('generates a DISTINCT token on each call (no reuse)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const seen: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const sent = JSON.parse(init.body as string) as { token: string }
        seen.push(sent.token)
        return new Response(JSON.stringify([{ token: sent.token }]), { status: 201 })
      }) as unknown as typeof fetch,
    )
    const a = await createInviteLink(PROJECT)
    const b = await createInviteLink(PROJECT)
    expect(a.code).toBeTruthy()
    expect(b.code).toBeTruthy()
    expect(a.code).not.toBe(b.code)
    expect(new Set(seen).size).toBe(2)
  })

  it('ok with code but undefined expiry when the row has no/invalid expires_at', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const sent = JSON.parse(init.body as string) as { token: string }
        return new Response(JSON.stringify([{ token: sent.token }]), { status: 201 })
      }) as unknown as typeof fetch,
    )
    const res = await createInviteLink(PROJECT)
    expect(res.ok).toBe(true)
    expect(res.code).toBeTruthy()
    expect(res.expiresAt).toBeUndefined()
  })

  it('a non-ok response (RLS no-op for a non-owner) → {ok:false} (no throw)', async () => {
    stubAnonEnv()
    await signInAs('not-the-owner@example.com')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    expect(await createInviteLink(PROJECT)).toEqual({ ok: false })
  })

  it('a row missing token → {ok:false}; a thrown fetch → {ok:false}', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('[{}]', { status: 201 })))
    expect(await createInviteLink(PROJECT)).toEqual({ ok: false })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    expect(await createInviteLink(PROJECT)).toEqual({ ok: false })
  })
})

describe('joinWithInvite — caller-JWT redeem via the join_with_invite RPC', () => {
  it('blank code → {ok:false,error:no code}, no fetch', async () => {
    stubAnonEnv()
    await signInAs('joiner@example.com')
    const fetchSpy = vi.fn(async () => new Response('"x"', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await joinWithInvite('   ')).toEqual({ ok: false, error: 'no code' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('signed out → {ok:false,error:not signed in}, no fetch (login-required)', async () => {
    stubAnonEnv()
    const fetchSpy = vi.fn(async () => new Response('"x"', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await joinWithInvite('some-code')).toEqual({
      ok: false,
      error: 'not signed in',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('unconfigured → {ok:false,error:not signed in}, no fetch', async () => {
    await signInAs('joiner@example.com')
    const fetchSpy = vi.fn(async () => new Response('"x"', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await joinWithInvite('some-code')).toEqual({
      ok: false,
      error: 'not signed in',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('valid code → calls the RPC under the caller JWT and returns the joined id', async () => {
    stubAnonEnv()
    await signInAs('joiner@example.com', 'joiner-uid')
    const fetchSpy = vi.fn(async () =>
      // PostgREST renders a scalar `returns uuid` as a bare JSON string.
      new Response(JSON.stringify(PROJECT), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    const res = await joinWithInvite('  the-secret-code  ')
    // Legacy 0007/0008 RPC rendered a bare uuid string → treated as a join.
    expect(res).toEqual({ ok: true, collabProjectId: PROJECT, status: 'joined' })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/rest/v1/rpc/join_with_invite')
    expect(init.method).toBe('POST')
    expect(headersOf(init).apikey).toBe('anon-key')
    expect(headersOf(init).Authorization).toBe('Bearer test-access')
    const body = JSON.parse(init.body as string) as { invite_token: string }
    expect(body.invite_token).toBe('the-secret-code') // trimmed
  })

  it('an invalid/expired code (RPC raise → 400) → {ok:false,error:generic}', async () => {
    stubAnonEnv()
    await signInAs('joiner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: 'invite expired' }), {
            status: 400,
          }),
      ),
    )
    expect(await joinWithInvite('expired')).toEqual({
      ok: false,
      error: 'invalid or expired invite',
    })
  })

  it('a non-string RPC body → {ok:false,error:generic}; a thrown fetch → {ok:false,error:join failed}', async () => {
    stubAnonEnv()
    await signInAs('joiner@example.com')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })))
    expect(await joinWithInvite('weird')).toEqual({
      ok: false,
      error: 'invalid or expired invite',
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    expect(await joinWithInvite('boom')).toEqual({ ok: false, error: 'join failed' })
  })

  it('a successful join invalidates the membership cache for the joined project', async () => {
    stubAnonEnv()
    await signInAs('joiner@example.com')

    // 1) Prime the read cache as a NON-member (RLS returns no rows).
    const readMiss = vi.fn(async () => new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', readMiss)
    expect(await getMyMembership(PROJECT)).toBeNull()
    expect(readMiss).toHaveBeenCalledTimes(1)
    expect(await getMyMembership(PROJECT)).toBeNull() // served from cache
    expect(readMiss).toHaveBeenCalledTimes(1)

    // 2) Join — the RPC returns the project id; this must drop the cached null.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(PROJECT), { status: 200 })))
    expect(await joinWithInvite('code')).toEqual({
      ok: true,
      collabProjectId: PROJECT,
      status: 'joined',
    })

    // 3) The next read re-resolves against a fresh fetch (now a member row).
    const reRead = vi.fn(async () =>
      new Response(JSON.stringify([{ project_id: PROJECT, role: 'member' }]), {
        status: 200,
      }),
    )
    vi.stubGlobal('fetch', reRead)
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect(reRead).toHaveBeenCalledTimes(1)
  })
})

describe('revokeProjectInvites — owner-JWT delete of all invite links (eviction)', () => {
  it('unconfigured / signed out / empty id → {ok:false}, no fetch', async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    await signInAs('owner@example.com')
    expect(await revokeProjectInvites(PROJECT)).toEqual({ ok: false }) // unconfigured
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.stubGlobal('fetch', fetchSpy)
    stubAnonEnv()
    expect(await revokeProjectInvites('')).toEqual({ ok: false }) // empty id
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('DELETEs og_project_invites for the project under the owner JWT', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await revokeProjectInvites(PROJECT)).toEqual({ ok: true })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(url).toContain('/rest/v1/og_project_invites')
    expect(url).toContain(`project_id=eq.${PROJECT}`)
    expect(headersOf(init).Authorization).toBe('Bearer test-access')
  })

  it('a non-ok (RLS no-op for a non-owner) / thrown response → {ok:false}', async () => {
    stubAnonEnv()
    await signInAs('not-owner@example.com')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    expect(await revokeProjectInvites(PROJECT)).toEqual({ ok: false })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    expect(await revokeProjectInvites(PROJECT)).toEqual({ ok: false })
  })

  it('per-link revoke scopes the DELETE to project_id AND id', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await revokeProjectInvites(PROJECT, 'inv-9')).toEqual({ ok: true })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(url).toContain(`project_id=eq.${PROJECT}`)
    expect(url).toContain('id=eq.inv-9')
  })
})

describe('createInviteLink — v2 mode + bounds', () => {
  it('sends mode + max_uses and returns the parsed row (id/mode/maxUses/expiry)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string) as {
        token: string
        mode: string
        max_uses?: number
      }
      return new Response(
        JSON.stringify([
          {
            id: 'inv-1',
            token: sent.token,
            mode: sent.mode,
            max_uses: sent.max_uses ?? null,
            expires_at: '2026-06-27T00:00:00.000Z',
          },
        ]),
        { status: 201 },
      )
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    const res = await createInviteLink(PROJECT, { mode: 'approval', maxUses: 1 })
    expect(res.ok).toBe(true)
    expect(res.id).toBe('inv-1')
    expect(res.mode).toBe('approval')
    expect(res.maxUses).toBe(1)
    expect(res.expiresAt).toBe(Date.parse('2026-06-27T00:00:00.000Z'))

    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as { mode: string; max_uses?: number }
    expect(body.mode).toBe('approval')
    expect(body.max_uses).toBe(1)
  })

  it('defaults to open and OMITS max_uses when unbounded', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(init.body as string) as { token: string; mode: string }
      return new Response(
        JSON.stringify([{ id: 'i', token: sent.token, mode: sent.mode }]),
        { status: 201 },
      )
    })
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    const res = await createInviteLink(PROJECT)
    expect(res.mode).toBe('open')
    expect(res.maxUses).toBeNull()
    const body = JSON.parse(
      (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    ) as Record<string, unknown>
    expect(body.mode).toBe('open')
    expect('max_uses' in body).toBe(false)
  })
})

describe('joinWithInvite — v2 jsonb { project_id, status }', () => {
  it('open-mode join → status joined', async () => {
    stubAnonEnv()
    await signInAs('joiner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ project_id: PROJECT, status: 'joined' }), { status: 200 }),
      ),
    )
    expect(await joinWithInvite('code')).toEqual({
      ok: true,
      collabProjectId: PROJECT,
      status: 'joined',
    })
  })

  it('approval-mode redeem → status pending', async () => {
    stubAnonEnv()
    await signInAs('joiner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ project_id: PROJECT, status: 'pending' }), { status: 200 }),
      ),
    )
    expect(await joinWithInvite('code')).toEqual({
      ok: true,
      collabProjectId: PROJECT,
      status: 'pending',
    })
  })

  it('jsonb without a project_id → invalid', async () => {
    stubAnonEnv()
    await signInAs('joiner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'joined' }), { status: 200 })),
    )
    expect(await joinWithInvite('code')).toEqual({
      ok: false,
      error: 'invalid or expired invite',
    })
  })

  it('an over-long code is rejected before any fetch (defensive cap)', async () => {
    stubAnonEnv()
    await signInAs('joiner@example.com')
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify(PROJECT), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await joinWithInvite('x'.repeat(600))).toEqual({
      ok: false,
      error: 'invalid or expired invite',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('resetInviteLinks — mint fresh then sweep the rest', () => {
  it('mints a new link then DELETEs every OTHER link (id=neq.new)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const calls: Array<{ url: string; method?: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method })
        if (init.method === 'POST') {
          const sent = JSON.parse(init.body as string) as { token: string }
          return new Response(
            JSON.stringify([{ id: 'new-1', token: sent.token, mode: 'open' }]),
            { status: 201 },
          )
        }
        return new Response(null, { status: 204 }) // the sweep DELETE
      }) as unknown as typeof fetch,
    )
    const res = await resetInviteLinks(PROJECT)
    expect(res.ok).toBe(true)
    expect(res.id).toBe('new-1')
    const del = calls.find((cl) => cl.method === 'DELETE')
    expect(del?.url).toContain('id=neq.new-1')
  })

  it('a mint failure resets nothing (no sweep DELETE)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response('nope', { status: 403 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    expect(await resetInviteLinks(PROJECT)).toEqual({ ok: false })
    expect(fetchSpy.mock.calls.every((call) => call[1]?.method !== 'DELETE')).toBe(true)
  })
})

describe('listInviteLinks — owner metadata (no tokens)', () => {
  it('maps rows to items; the select never asks for the token', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).not.toContain('token')
        return new Response(
          JSON.stringify([
            {
              id: 'a',
              mode: 'approval',
              max_uses: 3,
              use_count: 1,
              expires_at: '2026-06-27T00:00:00.000Z',
              created_at: '2026-06-20T00:00:00.000Z',
            },
            { id: 'b', mode: 'open', max_uses: null, use_count: 0 },
          ]),
          { status: 200 },
        )
      }),
    )
    const links = await listInviteLinks(PROJECT)
    expect(links).toHaveLength(2)
    expect(links[0]).toMatchObject({ id: 'a', mode: 'approval', maxUses: 3, useCount: 1 })
    expect(links[0].expiresAt).toBe(Date.parse('2026-06-27T00:00:00.000Z'))
    expect(links[1]).toMatchObject({ id: 'b', mode: 'open', maxUses: null, useCount: 0 })
  })

  it('a non-array / error body → []', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })))
    expect(await listInviteLinks(PROJECT)).toEqual([])
  })
})

describe('member cap read/write', () => {
  it('getProjectMemberCap parses member_cap; null when unset', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([{ member_cap: 5 }]), { status: 200 })),
    )
    expect(await getProjectMemberCap(PROJECT)).toBe(5)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify([{ member_cap: null }]), { status: 200 })),
    )
    expect(await getProjectMemberCap(PROJECT)).toBeNull()
  })

  it('setProjectMemberCap PATCHes member_cap (number, then null to clear)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await setProjectMemberCap(PROJECT, 3)).toEqual({ ok: true })
    const init0 = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(init0.method).toBe('PATCH')
    expect(JSON.parse(init0.body as string)).toEqual({ member_cap: 3 })
    expect(await setProjectMemberCap(PROJECT, null)).toEqual({ ok: true })
    const init1 = (fetchSpy.mock.calls[1] as unknown as [string, RequestInit])[1]
    expect(JSON.parse(init1.body as string)).toEqual({ member_cap: null })
  })
})

describe('join requests — list / approve / deny', () => {
  it('listJoinRequests filters status=pending and maps rows', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('status=eq.pending')
        return new Response(
          JSON.stringify([{ id: 'r1', email: 'a@b.co', created_at: '2026-06-20T00:00:00.000Z' }]),
          { status: 200 },
        )
      }),
    )
    expect(await listJoinRequests(PROJECT)).toEqual([
      { id: 'r1', email: 'a@b.co', createdAt: Date.parse('2026-06-20T00:00:00.000Z') },
    ])
  })

  it('approveJoinRequest calls the RPC with request_id; a raise → {ok:false}', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ project_id: PROJECT, status: 'approved' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    expect(await approveJoinRequest(PROJECT, 'r1')).toEqual({ ok: true })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/rest/v1/rpc/approve_join_request')
    expect(JSON.parse(init.body as string)).toEqual({ request_id: 'r1' })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ message: 'project full' }), { status: 400 })),
    )
    expect(await approveJoinRequest(PROJECT, 'r1')).toEqual({ ok: false })
  })

  it('approveJoinRequest with a blank id → {ok:false}, no fetch', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await approveJoinRequest(PROJECT, '')).toEqual({ ok: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('denyJoinRequest DELETEs the request scoped by id + project_id', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await denyJoinRequest(PROJECT, 'r1')).toEqual({ ok: true })
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(url).toContain('id=eq.r1')
    expect(url).toContain(`project_id=eq.${PROJECT}`)
  })
})
