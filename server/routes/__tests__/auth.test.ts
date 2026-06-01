import { describe, it, expect, afterEach, vi } from 'vitest'
import { app } from '../../app'

// Tests for the env-gated optional app login (server/routes/auth.ts). The route
// reads SUPABASE_URL / SUPABASE_ANON_KEY LAZILY per request, so we flip them
// with vi.stubEnv between cases. The global fetch is mocked whenever a
// "configured" path needs to verify the Supabase token exchange — we NEVER hit
// a real Supabase.
//
// HOME is already isolated to a tmp dir by src/test/setup-home.ts, so the
// session persistence (authStore.ts → auth.json) lands in the throwaway home,
// never the real ~/.openground.

const ENV = {
  url: 'https://example.supabase.co',
  anon: 'anon-test-key',
}

const configure = () => {
  vi.stubEnv('SUPABASE_URL', ENV.url)
  vi.stubEnv('SUPABASE_ANON_KEY', ENV.anon)
}
const unconfigure = () => {
  vi.stubEnv('SUPABASE_URL', '')
  vi.stubEnv('SUPABASE_ANON_KEY', '')
}

const post = (path: string) =>
  Promise.resolve(app.request(path, { method: 'POST' }))

afterEach(async () => {
  // Best-effort: clear any persisted session so cases don't leak into each
  // other. Done while still configured so /signout actually runs.
  configure()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
  await post('/api/auth/signout').catch(() => {})
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('auth — config gating (env unset = public build)', () => {
  it('GET /api/auth/config → { enabled: false } when env is unset', async () => {
    unconfigure()
    const res = await app.request('/api/auth/config')
    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(false)
  })

  it('GET /api/auth/start → 503 when not configured', async () => {
    unconfigure()
    const res = await app.request('/api/auth/start?provider=google')
    expect(res.status).toBe(503)
  })

  it('GET /api/auth/session → 200 { user: null } when not configured', async () => {
    unconfigure()
    const res = await app.request('/api/auth/session')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ user: null })
  })

  it('GET /api/auth/config → { enabled: true } when env is set', async () => {
    configure()
    const res = await app.request('/api/auth/config')
    expect(res.status).toBe(200)
    expect((await res.json()).enabled).toBe(true)
  })
})

describe('auth — /start (authorize URL + PKCE, no client state)', () => {
  it('returns a well-formed Supabase authorize URL with PKCE and no client state', async () => {
    configure()
    const res = await app.request('/api/auth/start?provider=github')
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }

    const parsed = new URL(url)
    expect(parsed.origin).toBe(ENV.url)
    expect(parsed.pathname).toBe('/auth/v1/authorize')
    expect(parsed.searchParams.get('provider')).toBe('github')
    expect(parsed.searchParams.get('redirect_to')).toBe(
      'http://127.0.0.1:47776/api/auth/callback',
    )
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
    // PKCE challenge present + non-trivial (base64url).
    expect(parsed.searchParams.get('code_challenge') ?? '').toMatch(/^[A-Za-z0-9_-]{20,}$/)
    // No client `state` — GoTrue manages its own; sending one → bad_oauth_state.
    expect(parsed.searchParams.get('state')).toBeNull()
  })

  it('rejects an unknown provider with 400', async () => {
    configure()
    const res = await app.request('/api/auth/start?provider=myspace')
    expect(res.status).toBe(400)
  })
})

describe('auth — /callback (PKCE exchange + persist) and /session', () => {
  it('exchanges the code, persists a session, and /session reads it back', async () => {
    configure()

    // 1) Start a flow to register the in-flight PKCE verifier the callback takes.
    //    We don't open a browser in tests.
    await app.request('/api/auth/start?provider=google')

    // 2) Mock the Supabase token endpoint for the PKCE grant.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          user: {
            id: 'user-123',
            email: 'me@example.com',
            app_metadata: { provider: 'google' },
            user_metadata: { full_name: 'Test User', avatar_url: 'https://x/y.png' },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    // 3) Hit the callback with the code (the verifier is taken from the slot).
    const cbRes = await app.request('/api/auth/callback?code=auth-code-xyz')
    expect(cbRes.status).toBe(200)
    expect(cbRes.headers.get('content-type') ?? '').toMatch(/text\/html/)

    // Verify the PKCE token exchange used the anon key + auth_code + verifier.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [tokenUrl, init] = fetchMock.mock.calls[0]
    expect(String(tokenUrl)).toBe(`${ENV.url}/auth/v1/token?grant_type=pkce`)
    expect(init.headers.apikey).toBe(ENV.anon)
    const sentBody = JSON.parse(init.body)
    expect(sentBody.auth_code).toBe('auth-code-xyz')
    expect(typeof sentBody.code_verifier).toBe('string')

    // 4) /session reads the persisted session (token still fresh → no refresh).
    const sessRes = await app.request('/api/auth/session')
    expect(sessRes.status).toBe(200)
    const body = (await sessRes.json()) as { user: { id: string; email?: string; provider: string } | null }
    expect(body.user?.id).toBe('user-123')
    expect(body.user?.email).toBe('me@example.com')
    expect(body.user?.provider).toBe('google')
    // The session response must NEVER carry tokens.
    expect(JSON.stringify(body)).not.toContain('access-1')
    expect(JSON.stringify(body)).not.toContain('refresh-1')
  })

  it('rejects a callback with no in-flight login (replay/forged) → 400', async () => {
    configure()
    // No /start ran here, so there is no pending verifier to take → reject.
    const res = await app.request('/api/auth/callback?code=abc')
    expect(res.status).toBe(400)
  })

  it('/session refreshes an expired token and persists the rotated refresh token', async () => {
    configure()

    // Seed an expired session via the callback path with expires_in negative
    // (so it's already past). First register a pending state.
    await app.request('/api/auth/start?provider=github')

    // Token endpoint: first call (pkce) returns an already-expired token; second
    // call (refresh_token) returns a fresh, rotated one.
    const fetchMock = vi
      .fn()
      // pkce exchange → expired
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-old',
            refresh_token: 'refresh-old',
            expires_in: -10,
            user: { id: 'u-9', email: 'a@b.c', app_metadata: { provider: 'github' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      // refresh → rotated
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'access-new',
            refresh_token: 'refresh-new',
            expires_in: 3600,
            user: { id: 'u-9', email: 'a@b.c', app_metadata: { provider: 'github' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    await app.request('/api/auth/callback?code=c')

    const sessRes = await app.request('/api/auth/session')
    expect(sessRes.status).toBe(200)
    const body = (await sessRes.json()) as { user: { id: string } | null }
    expect(body.user?.id).toBe('u-9')

    // The second fetch must be the refresh grant with the OLD refresh token.
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [refreshUrl, refreshInit] = fetchMock.mock.calls[1]
    expect(String(refreshUrl)).toBe(`${ENV.url}/auth/v1/token?grant_type=refresh_token`)
    expect(JSON.parse(refreshInit.body).refresh_token).toBe('refresh-old')

    // A subsequent /session should NOT refresh again (rotated token is fresh) —
    // proves the rotated refresh_token was persisted.
    fetchMock.mockClear()
    const sess2 = await app.request('/api/auth/session')
    expect(sess2.status).toBe(200)
    expect((await sess2.json()).user.id).toBe('u-9')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('auth — /signout clears the session', () => {
  it('clears auth.json so /session returns null', async () => {
    configure()

    // Seed a session via the callback path.
    await app.request('/api/auth/start?provider=google')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 3600,
            user: { id: 'u-signout', app_metadata: { provider: 'google' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    )
    await app.request('/api/auth/callback?code=c')

    // Sign out (logout fetch is best-effort; the mock above answers it 200).
    const out = await post('/api/auth/signout')
    expect(out.status).toBe(200)
    expect((await out.json()).ok).toBe(true)

    const sess = await app.request('/api/auth/session')
    expect(sess.status).toBe(200)
    expect((await sess.json()).user).toBeNull()
  })
})
