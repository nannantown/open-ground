// @vitest-environment node
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import {
  getMyMembership,
  isMyProject,
  upsertProjectMembers,
  removeProjectMember,
  cancelPendingInvite,
  acceptInvite,
  ensureOwnProject,
  clearMembershipCache,
  listMyProjects,
  listProjectMembers,
  getProjectLabel,
  setProjectLabel,
} from '../projectMembers'
import { writeSession, clearSession } from '../authStore'
import type { ProjectMember } from '../../types'

// Membership-resolution matrix for og_project_members (the realtime-collab
// allowlist). Identity comes from the persisted app session (HOME is
// tmp-isolated by src/test/setup-home.ts, which also clears SUPABASE_* so the
// owner's live shell can't flip these cases). OPENGROUND_COLLAB_MEMBER_PROJECTS
// is a NEW env var setup-home doesn't know about, so we clear it ourselves.
//
// The shipped default is "nothing configured" → null for everyone. Membership
// comes from the Supabase table via the user's own JWT (RLS returns only the
// caller's own row). WRITES (v2 / Cloudflare-DO model, migration 0005) are
// owner-managed under RLS with the SAME caller JWT — there is NO service-role
// key in the collab path anymore.

const PROJECT = '11111111-1111-1111-1111-111111111111'

// Sign in so getFreshAccessToken returns 'test-access' without a refresh grant
// (fresh expiry), mirroring roles.test.ts / authRealtime tests.
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

// Stub fetch to return the given rows (or reject, to simulate offline).
const stubFetch = (rows: MemberRowLike[] | 'reject') => {
  const fn = vi.fn(async () => {
    if (rows === 'reject') throw new Error('offline')
    return new Response(JSON.stringify(rows), { status: 200 })
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

interface MemberRowLike {
  project_id?: string
  user_id?: string | null
  email?: string | null
  role?: string
  status?: string | null
  // og_projects rows reused through the same stub (listMyProjects / getProjectLabel).
  id?: string
  name?: string | null
  label?: string | null
  owner_id?: string | null
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>

beforeEach(() => {
  // Belt-and-braces: setup-home doesn't clear our new override var.
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

describe('getMyMembership — shipped defaults (nothing configured)', () => {
  it('unconfigured (no SUPABASE_URL) → null, no network', async () => {
    const fetchSpy = stubFetch([{ role: 'owner' }])
    await signInAs('whoever@example.com')
    expect(await getMyMembership(PROJECT)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('signed out (no JWT) → null, no network even with anon env', async () => {
    stubAnonEnv()
    const fetchSpy = stubFetch([{ role: 'owner' }])
    expect(await getMyMembership(PROJECT)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('empty collabProjectId → null, no network', async () => {
    stubAnonEnv()
    const fetchSpy = stubFetch([{ role: 'owner' }])
    await signInAs('person@example.com')
    expect(await getMyMembership('')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('getMyMembership — remote og_project_members lookup', () => {
  it('maps the caller’s row → ProjectMember and queries correctly', async () => {
    stubAnonEnv()
    const fetchSpy = stubFetch([
      {
        project_id: PROJECT,
        user_id: 'u-123',
        email: 'person@example.com',
        role: 'member',
      },
    ])
    await signInAs('person@example.com')

    const member = await getMyMembership(PROJECT)
    expect(member).toEqual<ProjectMember>({
      projectId: PROJECT,
      userId: 'u-123',
      email: 'person@example.com',
      role: 'member',
      // No status on the row → resolves to 'accepted' (pre-0013 / full member).
      status: 'accepted',
    })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain(`og_project_members?project_id=eq.${PROJECT}`)
    expect(url).toContain('select=')
    expect(headersOf(init).apikey).toBe('anon-key')
    expect(headersOf(init).Authorization).toBe('Bearer test-access')
  })

  it('no rows → null (not a member)', async () => {
    stubAnonEnv()
    stubFetch([])
    await signInAs('stranger@example.com')
    expect(await getMyMembership(PROJECT)).toBeNull()
  })

  it('a PENDING-only email invite → null (no access until accepted)', async () => {
    stubAnonEnv()
    stubFetch([
      { project_id: PROJECT, email: 'invitee@example.com', role: 'member', status: 'pending' },
    ])
    await signInAs('invitee@example.com')
    // The row exists (RLS lets them read it for the お知らせ bell) but it grants no
    // ACCESS — getMyMembership is the access gate, so a pending invite resolves null.
    expect(await getMyMembership(PROJECT)).toBeNull()
  })

  it('an ACCEPTED member row → member (access granted)', async () => {
    stubAnonEnv()
    stubFetch([
      { project_id: PROJECT, email: 'invitee@example.com', role: 'member', status: 'accepted' },
    ])
    await signInAs('invitee@example.com')
    const member = await getMyMembership(PROJECT)
    expect(member?.role).toBe('member')
    expect(member?.status).toBe('accepted')
  })

  it('owner row always grants access regardless of status', async () => {
    stubAnonEnv()
    // Defensive: an owner row should never be pending, but even if it were, owner
    // access is unconditional.
    stubFetch([{ project_id: PROJECT, user_id: 'u-1', role: 'owner', status: 'pending' }])
    await signInAs('owner@example.com', 'u-1')
    expect((await getMyMembership(PROJECT))?.role).toBe('owner')
  })

  it('owner wins when both a user_id row and an email row match', async () => {
    stubAnonEnv()
    stubFetch([
      { project_id: PROJECT, email: 'p@example.com', role: 'member' },
      { project_id: PROJECT, user_id: 'u-1', role: 'owner' },
    ])
    await signInAs('p@example.com')
    const member = await getMyMembership(PROJECT)
    expect(member?.role).toBe('owner')
  })

  it('a null user_id in the row maps to undefined (clean shape)', async () => {
    stubAnonEnv()
    stubFetch([
      { project_id: PROJECT, user_id: null, email: 'p@example.com', role: 'member' },
    ])
    await signInAs('p@example.com')
    const member = await getMyMembership(PROJECT)
    expect(member?.userId).toBeUndefined()
    expect(member?.email).toBe('p@example.com')
  })

  it('isMyProject is true with a row, false without', async () => {
    stubAnonEnv()
    stubFetch([{ project_id: PROJECT, role: 'member' }])
    await signInAs('p@example.com')
    expect(await isMyProject(PROJECT)).toBe(true)

    clearMembershipCache()
    stubFetch([])
    expect(await isMyProject(PROJECT)).toBe(false)
  })
})

describe('getMyMembership — caching', () => {
  it('caches per project for 5 minutes (one fetch for two calls)', async () => {
    stubAnonEnv()
    const fetchSpy = stubFetch([{ project_id: PROJECT, role: 'member' }])
    await signInAs('p@example.com')
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('caches the “not a member” null too (no re-fetch within TTL)', async () => {
    stubAnonEnv()
    const fetchSpy = stubFetch([])
    await signInAs('p@example.com')
    expect(await getMyMembership(PROJECT)).toBeNull()
    expect(await getMyMembership(PROJECT)).toBeNull()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('re-fetches after the TTL lapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-14T00:00:00Z'))
    stubAnonEnv()
    const first = stubFetch([{ project_id: PROJECT, role: 'member' }])
    await signInAs('p@example.com')
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect(first).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-06-14T00:06:00Z'))
    const second = stubFetch([{ project_id: PROJECT, role: 'owner' }])
    expect((await getMyMembership(PROJECT))?.role).toBe('owner')
    expect(second).toHaveBeenCalledTimes(1)
  })
})

describe('getMyMembership — offline / stale', () => {
  it('serves the stale cached membership when a later refresh fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-14T00:00:00Z'))
    stubAnonEnv()
    stubFetch([{ project_id: PROJECT, role: 'owner' }])
    await signInAs('p@example.com')
    expect((await getMyMembership(PROJECT))?.role).toBe('owner')

    // Past the TTL the cache is stale; a failing refresh must not yank collab
    // away mid-session.
    vi.setSystemTime(new Date('2026-06-14T00:06:00Z'))
    stubFetch('reject')
    expect((await getMyMembership(PROJECT))?.role).toBe('owner')
  })

  it('fails CLOSED: drops a stale POSITIVE once it is older than 2x the TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-14T00:00:00Z'))
    stubAnonEnv()
    stubFetch([{ project_id: PROJECT, role: 'owner' }])
    await signInAs('p@example.com')
    expect((await getMyMembership(PROJECT))?.role).toBe('owner')

    // Just past 1x TTL (5m) but under 2x (10m) and offline → still served.
    vi.setSystemTime(new Date('2026-06-14T00:06:00Z'))
    stubFetch('reject')
    expect((await getMyMembership(PROJECT))?.role).toBe('owner')

    // Past 2x TTL (>10m) and STILL offline → the stale positive is no longer
    // trusted (a revoked member must lose access), so resolve null.
    vi.setSystemTime(new Date('2026-06-14T00:11:00Z'))
    stubFetch('reject')
    expect(await getMyMembership(PROJECT)).toBeNull()
  })

  it('network error with no prior cache → null', async () => {
    stubAnonEnv()
    stubFetch('reject')
    await signInAs('p@example.com')
    expect(await getMyMembership(PROJECT)).toBeNull()
  })
})

describe('getMyMembership — env override (skips the network)', () => {
  it('a listed collabProjectId → member without any fetch', async () => {
    vi.stubEnv('OPENGROUND_COLLAB_MEMBER_PROJECTS', `other-id, ${PROJECT}`)
    stubAnonEnv()
    const fetchSpy = stubFetch([{ role: 'owner' }])
    await signInAs('p@example.com')
    const member = await getMyMembership(PROJECT)
    expect(member).toEqual<ProjectMember>({
      projectId: PROJECT,
      role: 'member',
      status: 'accepted',
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('an unlisted id still goes to the remote path', async () => {
    vi.stubEnv('OPENGROUND_COLLAB_MEMBER_PROJECTS', 'some-other-id')
    stubAnonEnv()
    const fetchSpy = stubFetch([{ project_id: PROJECT, role: 'member' }])
    await signInAs('p@example.com')
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('upsertProjectMembers — caller-JWT (owner) write', () => {
  it('unconfigured (no SUPABASE_URL) → {ok:false,written:0}, no fetch', async () => {
    // No anon env at all → readAuthConfig() is null, so ownerAuth() bails.
    await signInAs('owner@example.com')
    const fetchSpy = stubFetch([])
    const res = await upsertProjectMembers(PROJECT, ['a@example.com'])
    expect(res).toEqual({ ok: false, written: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('signed out (no JWT) → {ok:false,written:0}, no fetch even with anon env', async () => {
    stubAnonEnv()
    const fetchSpy = stubFetch([])
    const res = await upsertProjectMembers(PROJECT, ['a@example.com'])
    expect(res).toEqual({ ok: false, written: 0 })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('empty / blank emails → {ok:false,written:0}, no fetch', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = stubFetch([])
    expect(await upsertProjectMembers(PROJECT, [])).toEqual({ ok: false, written: 0 })
    expect(await upsertProjectMembers(PROJECT, ['  ', ''])).toEqual({
      ok: false,
      written: 0,
    })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('writes one row per unique lowercased email under the owner JWT, owner vs member', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)

    const res = await upsertProjectMembers(
      PROJECT,
      ['Owner@Example.com', 'm1@example.com', 'M1@EXAMPLE.COM', 'm2@example.com'],
      { ownerEmail: 'owner@example.com' },
    )
    // 3 unique after lowercase-dedupe (owner, m1, m2).
    expect(res).toEqual({ ok: true, written: 3 })

    // One PLAIN insert per unique row (no on_conflict — the ON CONFLICT
    // speculative-insertion path spuriously fails this table's subquery RLS).
    expect(fetchSpy).toHaveBeenCalledTimes(3)
    const calls = fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>
    for (const [url, init] of calls) {
      expect(url).toContain('/rest/v1/og_project_members')
      expect(url).not.toContain('on_conflict')
      expect(init.method).toBe('POST')
      // Caller-JWT write: anon apikey + the user's OWN access token, NOT service-role.
      expect(headersOf(init).apikey).toBe('anon-key')
      expect(headersOf(init).Authorization).toBe('Bearer test-access')
      expect(headersOf(init).Prefer).toContain('return=minimal')
      expect(headersOf(init).Prefer).not.toContain('resolution=ignore-duplicates')
    }
    // Each call inserts a SINGLE row object (not a bulk array).
    const rows = calls.map(
      ([, init]) =>
        JSON.parse(init.body as string) as {
          project_id: string
          email: string
          role: string
          status: string
        },
    )
    expect(rows.every((r) => r.project_id === PROJECT)).toBe(true)
    const byEmail = Object.fromEntries(rows.map((r) => [r.email, r.role]))
    expect(byEmail['owner@example.com']).toBe('owner')
    expect(byEmail['m1@example.com']).toBe('member')
    expect(byEmail['m2@example.com']).toBe('member')
    // The owner seeds themselves ACCEPTED; every invited email lands PENDING
    // (no access until they accept the in-app お知らせ).
    const statusByEmail = Object.fromEntries(rows.map((r) => [r.email, r.status]))
    expect(statusByEmail['owner@example.com']).toBe('accepted')
    expect(statusByEmail['m1@example.com']).toBe('pending')
    expect(statusByEmail['m2@example.com']).toBe('pending')
  })

  it('treats a 409 duplicate as an idempotent success (re-invite), fails on other errors', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    // dup → 409 (already a member), new → 201. The 409 must NOT fail the result.
    const dupSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      const email = (JSON.parse((init?.body as string) ?? '{}') as { email?: string }).email
      return new Response(null, { status: email === 'dup@example.com' ? 409 : 201 })
    })
    vi.stubGlobal('fetch', dupSpy as unknown as typeof fetch)
    expect(await upsertProjectMembers(PROJECT, ['dup@example.com', 'new@example.com'])).toEqual({
      ok: true,
      written: 1, // only the 201 counts as written; the 409 is a no-op
    })

    // A non-409 error (e.g. RLS 403) fails closed.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('denied', { status: 403 })) as unknown as typeof fetch,
    )
    expect((await upsertProjectMembers(PROJECT, ['x@example.com'])).ok).toBe(false)
  })

  it('all members when no ownerEmail is given', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchSpy)

    await upsertProjectMembers(PROJECT, ['a@example.com', 'b@example.com'])
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const rows = (fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>).map(
      ([, init]) => JSON.parse(init.body as string) as { role: string },
    )
    expect(rows.every((r) => r.role === 'member')).toBe(true)
  })

  it('a non-ok Supabase response (RLS no-op for a non-owner) → {ok:false,written:0} (no throw)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 })),
    )
    expect(await upsertProjectMembers(PROJECT, ['a@example.com'])).toEqual({
      ok: false,
      written: 0,
    })
  })

  it('a thrown fetch → {ok:false,written:0} (never throws to caller)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    expect(await upsertProjectMembers(PROJECT, ['a@example.com'])).toEqual({
      ok: false,
      written: 0,
    })
  })

  it('invalidates the read cache for the project after a successful write', async () => {
    // 1) Prime the read cache via the caller-JWT read path (cached as a member).
    stubAnonEnv()
    await signInAs('p@example.com')
    const readFetch = stubFetch([{ project_id: PROJECT, role: 'member' }])
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect(readFetch).toHaveBeenCalledTimes(1)
    // Cached: a second read does not fetch.
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect(readFetch).toHaveBeenCalledTimes(1)

    // 2) A successful owner-JWT write must drop that cache entry.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 201 })))
    expect(await upsertProjectMembers(PROJECT, ['p@example.com'])).toEqual({
      ok: true,
      written: 1,
    })

    // 3) The next read re-resolves against a fresh fetch (here: now an owner).
    const reFetch = stubFetch([{ project_id: PROJECT, role: 'owner' }])
    expect((await getMyMembership(PROJECT))?.role).toBe('owner')
    expect(reFetch).toHaveBeenCalledTimes(1)
  })
})

describe('removeProjectMember — caller-JWT (owner) delete', () => {
  it('unconfigured / signed out / blank email → {ok:false}, no fetch', async () => {
    const fetchSpy = stubFetch([])
    // unconfigured (no anon env)
    await signInAs('owner@example.com')
    expect(await removeProjectMember(PROJECT, 'a@example.com')).toEqual({ ok: false })
    expect(fetchSpy).not.toHaveBeenCalled()

    // configured + signed in but blank email
    stubAnonEnv()
    expect(await removeProjectMember(PROJECT, '  ')).toEqual({ ok: false })
    expect(fetchSpy).not.toHaveBeenCalled()

    // configured but signed out
    await clearSession()
    expect(await removeProjectMember(PROJECT, 'a@example.com')).toEqual({ ok: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('DELETEs the row by lowercased email under the owner JWT, invalidates cache', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')

    // Prime the read cache so we can prove the delete invalidates it.
    const readFetch = stubFetch([{ project_id: PROJECT, role: 'member' }])
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect(readFetch).toHaveBeenCalledTimes(1)
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect(readFetch).toHaveBeenCalledTimes(1) // served from cache

    const delFetch = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', delFetch)
    expect(await removeProjectMember(PROJECT, 'Gone@Example.com')).toEqual({ ok: true })

    const [url, init] = delFetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('DELETE')
    expect(url).toContain('/rest/v1/og_project_members')
    expect(url).toContain(`project_id=eq.${PROJECT}`)
    expect(url).toContain('email=eq.gone%40example.com') // lowercased + encoded
    expect(headersOf(init).apikey).toBe('anon-key')
    expect(headersOf(init).Authorization).toBe('Bearer test-access')

    // Cache was dropped → the next read re-fetches.
    const reFetch = stubFetch([])
    expect(await getMyMembership(PROJECT)).toBeNull()
    expect(reFetch).toHaveBeenCalledTimes(1)
  })

  it('ALSO revokes the project invite links (close the re-entry path on eviction)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const calls: Array<{ url: string; method?: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method })
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    )
    expect(await removeProjectMember(PROJECT, 'Gone@Example.com')).toEqual({ ok: true })

    // 1) the roster row delete (by lowercased email)
    expect(
      calls.some(
        (cl) =>
          cl.method === 'DELETE' &&
          cl.url.includes('/rest/v1/og_project_members') &&
          cl.url.includes(`project_id=eq.${PROJECT}`) &&
          cl.url.includes('email=eq.gone%40example.com'),
      ),
    ).toBe(true)
    // 2) the project-wide invite-link delete — a held code can no longer rejoin
    expect(
      calls.some(
        (cl) =>
          cl.method === 'DELETE' &&
          cl.url.includes('/rest/v1/og_project_invites') &&
          cl.url.includes(`project_id=eq.${PROJECT}`),
      ),
    ).toBe(true)
  })

  it('a failed invite-link sweep does NOT flip the result (member is already removed)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    // The roster DELETE succeeds (204); the invite-link DELETE fails (500). The
    // member is removed regardless, so the result stays {ok:true} — the sweep is
    // best-effort hardening, not the primary contract.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('og_project_invites')
          ? new Response('boom', { status: 500 })
          : new Response(null, { status: 204 }),
      ) as unknown as typeof fetch,
    )
    expect(await removeProjectMember(PROJECT, 'a@example.com')).toEqual({ ok: true })
  })

  it('a non-ok response → {ok:false} (no throw); a thrown fetch → {ok:false}', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')

    // The roster DELETE 403s (RLS no-op for a non-owner) → bail BEFORE the invite
    // sweep, so no link rotation is even attempted.
    const fetchSpy = vi.fn(async () => new Response('nope', { status: 403 }))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await removeProjectMember(PROJECT, 'a@example.com')).toEqual({ ok: false })
    expect(fetchSpy).toHaveBeenCalledTimes(1) // member DELETE only; no invite sweep

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    expect(await removeProjectMember(PROJECT, 'a@example.com')).toEqual({ ok: false })
  })
})

describe('ensureOwnProject — caller-JWT (owner) create', () => {
  it('unconfigured / signed out → null, no fetch', async () => {
    const fetchSpy = stubFetch([])
    // unconfigured
    await signInAs('owner@example.com', 'owner-uid')
    expect(await ensureOwnProject('My Project')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()

    // configured but signed out
    stubAnonEnv()
    await clearSession()
    expect(await ensureOwnProject('My Project')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs an og_projects row owned by self and echoes back its id', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com', 'owner-uid')
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify([{ id: 'proj-123' }]), { status: 201 }),
    )
    vi.stubGlobal('fetch', fetchSpy)

    expect(await ensureOwnProject('  My Project  ')).toBe('proj-123')

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/rest/v1/og_projects')
    expect(init.method).toBe('POST')
    expect(headersOf(init).apikey).toBe('anon-key')
    expect(headersOf(init).Authorization).toBe('Bearer test-access')
    expect(headersOf(init).Prefer).toContain('return=representation')
    const body = JSON.parse(init.body as string) as { owner_id: string; name: string }
    expect(body.owner_id).toBe('owner-uid')
    expect(body.name).toBe('My Project') // trimmed
  })

  it('a non-ok response → null (no throw); a thrown fetch → null', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com', 'owner-uid')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    expect(await ensureOwnProject('x')).toBeNull()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    expect(await ensureOwnProject('x')).toBeNull()
  })
})

describe('listMyProjects — readable projects (owner OR ACCEPTED member)', () => {
  // listMyProjects now reads BOTH og_projects AND og_project_members (to learn the
  // caller's acceptance per shared project), so the stub discriminates by URL: an
  // og_projects request gets `projects`, an og_project_members request gets `roster`.
  const stubProjectsAndRoster = (
    projects: MemberRowLike[],
    roster: MemberRowLike[],
  ) => {
    const fn = vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(url.includes('og_project_members') ? roster : projects),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fn as unknown as typeof fetch)
    return fn
  }

  it('unconfigured / signed out → [], no fetch', async () => {
    const fetchSpy = stubFetch([])
    expect(await listMyProjects()).toEqual([])
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('owned projects always show; a SHARED project shows ONLY when I have an accepted row', async () => {
    stubAnonEnv()
    await signInAs('me@example.com', 'me-uid') // myUid = 'me-uid'
    const fetchSpy = stubProjectsAndRoster(
      [
        { id: 'p1', owner_id: 'me-uid', label: 'Design System' }, // I own → owned
        { id: 'p2', owner_id: 'other-uid', label: 'Joined' }, // shared, accepted → shown
        { id: 'p3', owner_id: 'other-uid', label: 'Invited' }, // shared, PENDING → hidden
        { id: 'p4', owner_id: 'other-uid', label: 'Stranger' }, // no row for me → hidden
        { id: '', owner_id: 'me-uid', label: 'skip-me' }, // malformed id → dropped
        { id: 'p5', owner_id: 'me-uid', label: '' }, // blank label → omitted; owned
      ],
      [
        // My roster rows across those shared projects.
        { project_id: 'p2', email: 'me@example.com', role: 'member', status: 'accepted' },
        { project_id: 'p3', email: 'me@example.com', role: 'member', status: 'pending' },
      ],
    )

    expect(await listMyProjects()).toEqual([
      { id: 'p1', label: 'Design System', owned: true },
      { id: 'p2', label: 'Joined', owned: false }, // accepted shared → a card
      // p3 (pending) and p4 (no row) are NOT cards — p3 lives in the bell.
      { id: 'p5', owned: true },
    ])

    const urls = (fetchSpy.mock.calls as unknown as Array<[string, RequestInit]>).map(([u]) => u)
    expect(urls.some((u) => u.includes('/rest/v1/og_projects'))).toBe(true)
    expect(urls.some((u) => u.includes('/rest/v1/og_project_members'))).toBe(true)
  })

  it('falls CLOSED to owned:false when the caller uid is unknown (and no accepted row → hidden)', async () => {
    stubAnonEnv()
    // Signed in so the JWT exists, but craft a row whose owner_id can't match.
    await signInAs('p@example.com', 'me-uid')
    stubProjectsAndRoster([{ id: 'p9', owner_id: 'someone' }], [])
    // Not owned + no accepted member row → not surfaced.
    expect(await listMyProjects()).toEqual([])
  })

  it('a non-array / non-ok / thrown response → [] (never throws)', async () => {
    stubAnonEnv()
    await signInAs('p@example.com')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    expect(await listMyProjects()).toEqual([])

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    expect(await listMyProjects()).toEqual([])

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    expect(await listMyProjects()).toEqual([])
  })
})

describe('listProjectMembers — full roster for the owner Collaborators UI', () => {
  it('unconfigured / signed out / empty id → [], no fetch', async () => {
    const fetchSpy = stubFetch([])
    await signInAs('owner@example.com')
    expect(await listProjectMembers(PROJECT)).toEqual([]) // unconfigured
    expect(fetchSpy).not.toHaveBeenCalled()
    stubAnonEnv()
    expect(await listProjectMembers('')).toEqual([]) // empty id
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('maps every roster row → ProjectMember, querying og_project_members by id', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com', 'owner-uid')
    const fetchSpy = stubFetch([
      { project_id: PROJECT, user_id: 'owner-uid', email: 'owner@example.com', role: 'owner' },
      { project_id: PROJECT, email: 'mate@example.com', role: 'member' },
    ])
    const roster = await listProjectMembers(PROJECT)
    expect(roster).toHaveLength(2)
    expect(roster.map((m) => m.role).sort()).toEqual(['member', 'owner'])
    expect(roster.find((m) => m.role === 'member')?.email).toBe('mate@example.com')

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/rest/v1/og_project_members')
    expect(url).toContain(`project_id=eq.${PROJECT}`)
    expect(headersOf(init).Authorization).toBe('Bearer test-access')
  })

  it('a non-array / non-ok / thrown response → [] (never throws)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    expect(await listProjectMembers(PROJECT)).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    expect(await listProjectMembers(PROJECT)).toEqual([])
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    expect(await listProjectMembers(PROJECT)).toEqual([])
  })
})

describe('getProjectLabel — member-visible shared name (caller-JWT read)', () => {
  it('unconfigured / signed out / empty id → null, no fetch', async () => {
    const fetchSpy = stubFetch([{ label: 'X' }])
    // unconfigured
    await signInAs('p@example.com')
    expect(await getProjectLabel(PROJECT)).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
    // configured + signed in but empty id
    stubAnonEnv()
    expect(await getProjectLabel('')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('returns the trimmed label string, querying og_projects by id', async () => {
    stubAnonEnv()
    await signInAs('p@example.com')
    const fetchSpy = stubFetch([{ label: 'Design System' }] as unknown as MemberRowLike[])
    expect(await getProjectLabel(PROJECT)).toBe('Design System')

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/rest/v1/og_projects')
    expect(url).toContain(`id=eq.${PROJECT}`)
    expect(url).toContain('select=label')
    expect(headersOf(init).Authorization).toBe('Bearer test-access')
  })

  it('null / missing / blank label → null', async () => {
    stubAnonEnv()
    await signInAs('p@example.com')

    stubFetch([{ label: null }] as unknown as MemberRowLike[])
    expect(await getProjectLabel(PROJECT)).toBeNull()

    stubFetch([] as unknown as MemberRowLike[]) // no row
    expect(await getProjectLabel(PROJECT)).toBeNull()

    stubFetch([{ label: '' }] as unknown as MemberRowLike[])
    expect(await getProjectLabel(PROJECT)).toBeNull()
  })

  it('a non-ok / thrown response → null (never throws)', async () => {
    stubAnonEnv()
    await signInAs('p@example.com')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    expect(await getProjectLabel(PROJECT)).toBeNull()

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    expect(await getProjectLabel(PROJECT)).toBeNull()
  })
})

describe('setProjectLabel — owner-JWT UPDATE of the shared name', () => {
  it('unconfigured / signed out / empty id → {ok:false}, no fetch', async () => {
    const fetchSpy = stubFetch([])
    await signInAs('owner@example.com')
    expect(await setProjectLabel(PROJECT, 'X')).toEqual({ ok: false }) // unconfigured
    expect(fetchSpy).not.toHaveBeenCalled()
    stubAnonEnv()
    expect(await setProjectLabel('', 'X')).toEqual({ ok: false }) // empty id
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('PATCHes og_projects.label (trimmed) under the owner JWT and echoes it back', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)

    expect(await setProjectLabel(PROJECT, '  Design System  ')).toEqual({
      ok: true,
      label: 'Design System',
    })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.method).toBe('PATCH')
    expect(url).toContain('/rest/v1/og_projects')
    expect(url).toContain(`id=eq.${PROJECT}`)
    expect(headersOf(init).Authorization).toBe('Bearer test-access')
    const body = JSON.parse(init.body as string) as { label: string | null }
    expect(body.label).toBe('Design System')
  })

  it('a blank label clears it (stores NULL, returns {ok:true} with no label)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchSpy)

    expect(await setProjectLabel(PROJECT, '   ')).toEqual({ ok: true })
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    const body = JSON.parse(init.body as string) as { label: string | null }
    expect(body.label).toBeNull()
  })

  it('a non-ok (RLS no-op for a non-owner) / thrown response → {ok:false}', async () => {
    stubAnonEnv()
    await signInAs('not-owner@example.com')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    expect(await setProjectLabel(PROJECT, 'X')).toEqual({ ok: false })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('boom')
      }),
    )
    expect(await setProjectLabel(PROJECT, 'X')).toEqual({ ok: false })
  })
})

describe('listProjectMembers — carries acceptance status for the owner roster', () => {
  it('maps each row’s status (pending vs accepted), defaulting absent → accepted', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com', 'owner-uid')
    stubFetch([
      { project_id: PROJECT, user_id: 'owner-uid', email: 'owner@example.com', role: 'owner', status: 'accepted' },
      { project_id: PROJECT, email: 'joined@example.com', role: 'member', status: 'accepted' },
      { project_id: PROJECT, email: 'invited@example.com', role: 'member', status: 'pending' },
      { project_id: PROJECT, email: 'legacy@example.com', role: 'member' }, // no status → accepted
    ])
    const roster = await listProjectMembers(PROJECT)
    const byEmail = Object.fromEntries(roster.map((m) => [m.email, m.status]))
    expect(byEmail['owner@example.com']).toBe('accepted')
    expect(byEmail['joined@example.com']).toBe('accepted')
    expect(byEmail['invited@example.com']).toBe('pending')
    expect(byEmail['legacy@example.com']).toBe('accepted')
  })
})

describe('cancelPendingInvite — owner cancels a PENDING email invite', () => {
  it('unconfigured / signed out / blank email → {ok:false}, no fetch', async () => {
    const fetchSpy = stubFetch([])
    await signInAs('owner@example.com')
    expect(await cancelPendingInvite(PROJECT, 'a@example.com')).toEqual({ ok: false })
    expect(fetchSpy).not.toHaveBeenCalled()
    stubAnonEnv()
    expect(await cancelPendingInvite(PROJECT, '  ')).toEqual({ ok: false })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('DELETEs the pending row scoped to status=pending, and does NOT rotate links', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    const calls: Array<{ url: string; method?: string }> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: init.method })
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    )
    expect(await cancelPendingInvite(PROJECT, 'Invited@Example.com')).toEqual({ ok: true })

    // ONE delete — the pending roster row, scoped to status=pending + lowercased email.
    expect(calls).toHaveLength(1)
    const { url, method } = calls[0]
    expect(method).toBe('DELETE')
    expect(url).toContain('/rest/v1/og_project_members')
    expect(url).toContain(`project_id=eq.${PROJECT}`)
    expect(url).toContain('email=eq.invited%40example.com')
    expect(url).toContain('status=eq.pending')
    // Crucially NOT an og_project_invites delete — quick-share links stay intact.
    expect(calls.some((cl) => cl.url.includes('og_project_invites'))).toBe(false)
  })

  it('a non-ok / thrown response → {ok:false} (never throws)', async () => {
    stubAnonEnv()
    await signInAs('owner@example.com')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 403 })))
    expect(await cancelPendingInvite(PROJECT, 'a@example.com')).toEqual({ ok: false })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    expect(await cancelPendingInvite(PROJECT, 'a@example.com')).toEqual({ ok: false })
  })
})

describe('acceptInvite — the invitee accepts their own pending invite (RPC)', () => {
  it('unconfigured / signed out / empty id → {ok:false}, no fetch', async () => {
    const fetchSpy = stubFetch([])
    await signInAs('invitee@example.com')
    expect(await acceptInvite(PROJECT)).toEqual({ ok: false }) // unconfigured
    expect(fetchSpy).not.toHaveBeenCalled()
    stubAnonEnv()
    expect(await acceptInvite('')).toEqual({ ok: false }) // empty id
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs to the accept_invite RPC under the caller JWT and returns the flip count', async () => {
    stubAnonEnv()
    await signInAs('invitee@example.com')
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ project_id: PROJECT, accepted: 1 }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchSpy as unknown as typeof fetch)

    expect(await acceptInvite(PROJECT)).toEqual({ ok: true, accepted: 1 })

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toContain('/rest/v1/rpc/accept_invite')
    expect(init.method).toBe('POST')
    expect(headersOf(init).Authorization).toBe('Bearer test-access')
    const body = JSON.parse(init.body as string) as { p_project_id: string }
    expect(body.p_project_id).toBe(PROJECT)
  })

  it('invalidates the membership cache so the next read sees the accepted row', async () => {
    stubAnonEnv()
    await signInAs('invitee@example.com')
    // 1) Prime the cache as a pending invite → null (no access).
    const readFetch = stubFetch([
      { project_id: PROJECT, email: 'invitee@example.com', role: 'member', status: 'pending' },
    ])
    expect(await getMyMembership(PROJECT)).toBeNull()
    expect(readFetch).toHaveBeenCalledTimes(1)
    expect(await getMyMembership(PROJECT)).toBeNull() // cached
    expect(readFetch).toHaveBeenCalledTimes(1)

    // 2) Accept → must drop the cache.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ accepted: 1 }), { status: 200 })) as unknown as typeof fetch,
    )
    expect((await acceptInvite(PROJECT)).ok).toBe(true)

    // 3) Next read re-resolves — now accepted → a member.
    const reFetch = stubFetch([
      { project_id: PROJECT, email: 'invitee@example.com', role: 'member', status: 'accepted' },
    ])
    expect((await getMyMembership(PROJECT))?.role).toBe('member')
    expect(reFetch).toHaveBeenCalledTimes(1)
  })

  it('a non-ok / thrown response → {ok:false} (never throws)', async () => {
    stubAnonEnv()
    await signInAs('invitee@example.com')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })))
    expect(await acceptInvite(PROJECT)).toEqual({ ok: false })
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    expect(await acceptInvite(PROJECT)).toEqual({ ok: false })
  })
})
