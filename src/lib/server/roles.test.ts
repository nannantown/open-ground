import { describe, it, expect, afterEach, vi } from 'vitest'
import { getCustomTabRole } from './roles'
import { writeSession, clearSession } from './authStore'

// Role-resolution matrix for the custom-tab feature (docs/CUSTOM_TABS_PLAN.md).
// Identity comes from the persisted app session (HOME is tmp-isolated by
// src/test/setup-home.ts, which also clears the OPENGROUND_*_EMAILS /
// SUPABASE_* env vars so the owner's live shell can't flip these cases).
//
// The shipped default is "nothing configured" → 'none' for everyone: there are
// deliberately NO built-in emails (a distributed binary must not identify the
// owner). Roles come from the Supabase og_roles table via the user's own JWT;
// the env vars remain as an explicit override that skips the network.

const signInAs = (email: string, id = 'test-user') =>
  writeSession({
    user: { id, email, provider: 'google' },
    // Fresh token → getFreshAccessToken returns it without a refresh grant.
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
  })

const stubSupabaseEnv = () => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
  vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
}

const stubRolesFetch = (rows: Array<{ role: string }> | 'fail') => {
  const fn = vi.fn(async () =>
    rows === 'fail'
      ? new Response('boom', { status: 500 })
      : new Response(JSON.stringify(rows), { status: 200 }),
  )
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  globalThis.__openground_custom_roles?.clear()
  await clearSession()
})

describe('getCustomTabRole — shipped defaults (nothing configured)', () => {
  it('signed out → none', async () => {
    expect(await getCustomTabRole()).toBe('none')
  })

  it('signed in but no env and no Supabase config → none, no network', async () => {
    const fetchSpy = stubRolesFetch([{ role: 'owner' }])
    await signInAs('whoever@example.com')
    expect(await getCustomTabRole()).toBe('none')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('getCustomTabRole — remote og_roles lookup', () => {
  it('row(s) for the signed-in user decide the role', async () => {
    stubSupabaseEnv()
    stubRolesFetch([{ role: 'tester' }])
    await signInAs('person@example.com')
    expect(await getCustomTabRole()).toBe('tester')
  })

  it('no rows → none', async () => {
    stubSupabaseEnv()
    stubRolesFetch([])
    await signInAs('stranger@example.com')
    expect(await getCustomTabRole()).toBe('none')
  })

  it('owner wins when both a user_id row and an email row match', async () => {
    stubSupabaseEnv()
    stubRolesFetch([{ role: 'tester' }, { role: 'owner' }])
    await signInAs('person@example.com')
    expect(await getCustomTabRole()).toBe('owner')
  })

  it('queries with the user token + anon apikey against the roles table', async () => {
    stubSupabaseEnv()
    const fetchSpy = stubRolesFetch([{ role: 'owner' }])
    await signInAs('person@example.com')
    await getCustomTabRole()
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://example.supabase.co/rest/v1/og_roles?select=role')
    expect((init.headers as Record<string, string>).apikey).toBe('anon-key')
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer test-access',
    )
  })

  it('caches per user for 5 minutes (one fetch for two calls)', async () => {
    stubSupabaseEnv()
    const fetchSpy = stubRolesFetch([{ role: 'owner' }])
    await signInAs('person@example.com')
    expect(await getCustomTabRole()).toBe('owner')
    expect(await getCustomTabRole()).toBe('owner')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('serves the stale cached role when a later refresh fails', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-12T00:00:00Z'))
    stubSupabaseEnv()
    stubRolesFetch([{ role: 'owner' }])
    await signInAs('person@example.com')
    expect(await getCustomTabRole()).toBe('owner')
    // Past the TTL the cache is stale; the failing refresh must not yank the
    // role away mid-session.
    vi.setSystemTime(new Date('2026-06-12T00:06:00Z'))
    stubRolesFetch('fail')
    expect(await getCustomTabRole()).toBe('owner')
  })

  it('lookup failure with no cache → none', async () => {
    stubSupabaseEnv()
    stubRolesFetch('fail')
    await signInAs('person@example.com')
    expect(await getCustomTabRole()).toBe('none')
  })
})

describe('getCustomTabRole — env override (skips the network)', () => {
  it('owner / tester / neither, case-insensitive', async () => {
    vi.stubEnv('OPENGROUND_OWNER_EMAILS', 'boss@example.com, second@example.com')
    vi.stubEnv('OPENGROUND_TESTER_EMAILS', 'qa@example.com')
    const fetchSpy = stubRolesFetch([{ role: 'owner' }])
    await signInAs('  Second@Example.COM  ')
    expect(await getCustomTabRole()).toBe('owner')
    await signInAs('qa@example.com')
    expect(await getCustomTabRole()).toBe('tester')
    await signInAs('stranger@example.com')
    expect(await getCustomTabRole()).toBe('none')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('owner wins when an email is on both lists', async () => {
    vi.stubEnv('OPENGROUND_OWNER_EMAILS', 'both@example.com')
    vi.stubEnv('OPENGROUND_TESTER_EMAILS', 'both@example.com')
    await signInAs('both@example.com')
    expect(await getCustomTabRole()).toBe('owner')
  })

  it('setting only one env var still disables the remote path entirely', async () => {
    vi.stubEnv('OPENGROUND_OWNER_EMAILS', 'boss@example.com')
    stubSupabaseEnv()
    const fetchSpy = stubRolesFetch([{ role: 'tester' }])
    await signInAs('person@example.com')
    expect(await getCustomTabRole()).toBe('none')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
