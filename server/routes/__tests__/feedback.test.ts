import { describe, it, expect, afterEach, vi } from 'vitest'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'

// Sign in (persist a session to the tmp-isolated HOME) as the given email, so
// the feedback owner-gate (FEEDBACK_ADMIN_EMAILS) has an identity to check.
const signInAs = (email: string) =>
  writeSession({
    user: { id: 'test-user', email, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
  })

// Tests for the env-gated in-app feedback proxy (server/routes/feedback.ts).
// The route reads SUPABASE_URL / SUPABASE_ANON_KEY LAZILY per request, so we
// flip them with vi.stubEnv between cases. The global fetch is mocked when the
// "configured" path needs to verify forwarding — we never hit a real Supabase.
//
// HOME is already isolated to a tmp dir by src/test/setup-home.ts, so the
// countProjects() metadata call (which reads settings.projectsRoot) is
// hermetic and returns null (no projectsRoot set) rather than scanning a real
// machine.

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  // Clear any persisted session so the owner-gate tests don't leak identity.
  await clearSession()
})

describe('feedback — config gating (env unset = public build)', () => {
  it('GET /api/feedback/config → { enabled: false } when env is unset', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    const res = await app.request('/api/feedback/config')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.enabled).toBe(false)
  })

  it('POST /api/feedback (valid body) → 503 when not configured', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    const res = await app.request('/api/feedback', json({ message: 'hello' }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toMatch(/not configured/i)
  })
})

describe('feedback — body validation (zValidator runs first)', () => {
  it('POST /api/feedback {} (no message) → 400', async () => {
    // Validation runs before the config check, so this 400s even unconfigured.
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_ANON_KEY', '')
    const res = await app.request('/api/feedback', json({}))
    expect(res.status).toBe(400)
  })

  it('POST /api/feedback { message: "" } (empty) → 400', async () => {
    const res = await app.request('/api/feedback', json({ message: '   ' }))
    expect(res.status).toBe(400)
  })

  it('POST /api/feedback (message > 5000 chars) → 400', async () => {
    const res = await app.request(
      '/api/feedback',
      json({ message: 'x'.repeat(5001) }),
    )
    expect(res.status).toBe(400)
  })

  it('POST /api/feedback (malformed email) → 400', async () => {
    const res = await app.request(
      '/api/feedback',
      json({ message: 'hi', email: 'not-an-email' }),
    )
    expect(res.status).toBe(400)
  })
})

describe('feedback — configured (env set, Supabase forward mocked)', () => {
  it('GET /api/feedback/config → { enabled: true } when env is set', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-test-key')
    const res = await app.request('/api/feedback/config')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.enabled).toBe(true)
  })

  it('POST /api/feedback forwards an insert to Supabase REST and returns ok', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co/')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-test-key')
    vi.stubEnv('SUPABASE_FEEDBACK_TABLE', 'feedback')

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.request(
      '/api/feedback',
      json({ message: 'great app', email: 'me@example.com' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)

    // Verify the forward used the REST insert URL, the anon key in both
    // headers, Prefer: return=minimal, and server-augmented metadata in the
    // body (never trusting the client for app_version / os).
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    // Trailing slash on SUPABASE_URL is normalised away.
    expect(url).toBe('https://example.supabase.co/rest/v1/feedback')
    expect(init.method).toBe('POST')
    expect(init.headers.apikey).toBe('anon-test-key')
    expect(init.headers.Authorization).toBe('Bearer anon-test-key')
    expect(init.headers.Prefer).toBe('return=minimal')
    const sent = JSON.parse(init.body)
    expect(sent.message).toBe('great app')
    expect(sent.email).toBe('me@example.com')
    expect(typeof sent.app_version).toBe('string')
    expect(typeof sent.os).toBe('string')
    expect(sent).toHaveProperty('project_count')
  })

  it('GET /api/feedback/config → canRead reflects the service-role key', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-test-key')

    // No service key → reading disabled (the public build).
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const off = await (await app.request('/api/feedback/config')).json()
    expect(off.enabled).toBe(true)
    expect(off.canRead).toBe(false)

    // Service key present (owner's machine) → reading enabled.
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const on = await (await app.request('/api/feedback/config')).json()
    expect(on.canRead).toBe(true)
  })

  it('POST /api/feedback → 502 when Supabase rejects', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-test-key')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('row level security', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    // Silence the expected server-side error log.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/api/feedback', json({ message: 'hi' }))
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/responded 401/i)
  })
})

describe('feedback — owner inbox (GET /api/feedback/list)', () => {
  it('→ 503 when no service-role key is configured (public build)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-test-key')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const res = await app.request('/api/feedback/list')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toMatch(/not configured/i)
  })

  it('reads rows with the service key and returns them newest-first', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co/')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubEnv('SUPABASE_FEEDBACK_TABLE', 'feedback')

    const rows = [
      {
        id: '1',
        created_at: '2026-06-01T00:00:00Z',
        message: 'love it',
        email: 'a@b.com',
        app_version: '1.2.3',
        os: 'darwin 25.2.0',
        project_count: 4,
      },
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(rows), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.request('/api/feedback/list')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toEqual(rows)
    expect(body.truncated).toBe(false)

    // Verify the read used the REST select with order + the SERVICE key in both
    // headers — never the anon key. Asserted with toContain (not an exact string)
    // so harmless query-param reordering doesn't break the test.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/rest/v1/feedback?')
    expect(url).toContain('order=created_at.desc')
    expect(url).toContain('limit=201') // fetch one past the cap to detect truncation
    expect(init.headers.apikey).toBe('service-role-key')
    expect(init.headers.Authorization).toBe('Bearer service-role-key')
  })

  it('flags truncated:true and slices to 200 when 201 rows come back', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const rows = Array.from({ length: 201 }, (_, i) => ({
      id: String(i),
      created_at: '2026-06-01T00:00:00Z',
      message: `m${i}`,
      email: null,
      app_version: null,
      os: null,
      project_count: null,
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 })),
    )

    const body = await (await app.request('/api/feedback/list')).json()
    expect(body.items).toHaveLength(200)
    expect(body.truncated).toBe(true)
  })

  it('→ 502 when Supabase rejects the read', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/api/feedback/list')
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/responded 401/i)
  })
})

describe('feedback — unread count (GET /api/feedback/unread)', () => {
  it('→ 503 without a service-role key (public build never polls it)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    const res = await app.request('/api/feedback/unread')
    expect(res.status).toBe(503)
  })

  it('parses the total from Content-Range and passes `since` as a gt filter', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubEnv('SUPABASE_FEEDBACK_TABLE', 'feedback')

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 206,
        headers: { 'content-range': '*/7' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const since = '2026-06-01T00:00:00Z'
    const res = await app.request(
      `/api/feedback/unread?since=${encodeURIComponent(since)}`,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(7)

    const [url, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('HEAD')
    expect(init.headers.Prefer).toBe('count=exact')
    expect(url).toContain('select=id')
    expect(url).toContain(`created_at=gt.${encodeURIComponent(since)}`)
  })

  it('counts all rows when `since` is omitted', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { 'content-range': '*/3' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.request('/api/feedback/unread')
    expect(res.status).toBe(200)
    expect((await res.json()).count).toBe(3)
    const [url] = fetchMock.mock.calls[0]
    expect(url).not.toContain('created_at=gt')
  })

  it('treats an empty/whitespace `since` like omitted (no gt filter)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 200, headers: { 'content-range': '*/0' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await app.request('/api/feedback/unread?since=')
    await app.request('/api/feedback/unread?since=%20%20')
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).not.toContain('created_at=gt')
    }
  })

  it('falls back to count:0 when Content-Range is absent or unknown (*/*)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    // The route logs (by design) when a 2xx carries no usable count — silence it.
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // No content-range header at all.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
    )
    expect((await (await app.request('/api/feedback/unread')).json()).count).toBe(0)

    // PostgREST count-unknown form "*/*".
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 200, headers: { 'content-range': '*/*' } }),
        ),
    )
    expect((await (await app.request('/api/feedback/unread')).json()).count).toBe(0)
  })

  it('→ 502 on a non-206 error status', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('boom', { status: 500 })),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/api/feedback/unread')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/responded 500/i)
  })

  it('→ 502 when the fetch rejects (Supabase unreachable)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/api/feedback/unread')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/could not reach/i)
  })
})

describe('feedback — read-path edge cases & invariants', () => {
  it('/list → 502 when the fetch rejects (could not reach)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/api/feedback/list')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/could not reach/i)
  })

  it('/list → 502 when Supabase returns a 200 with a non-JSON body', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    // res.ok but res.json() throws → falls into the catch.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not json', { status: 200 })),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/api/feedback/list')
    expect(res.status).toBe(502)
    expect((await res.json()).error).toMatch(/could not reach/i)
  })

  it('/list → items:[] when Supabase returns a non-array JSON body', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )

    const res = await app.request('/api/feedback/list')
    expect(res.status).toBe(200)
    expect((await res.json()).items).toEqual([])
  })

  it('read path uses the SERVICE key — never the anon key — when BOTH are set', async () => {
    // The real owner machine has both keys. Pin that /list picks the service key.
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-DO-NOT-USE')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('[]', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await app.request('/api/feedback/list')
    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.apikey).toBe('service-role-key')
    expect(init.headers.Authorization).toBe('Bearer service-role-key')
    expect(JSON.stringify(init.headers)).not.toContain('anon-DO-NOT-USE')
  })

  it('canRead:false and /list 503 when the service key is set but SUPABASE_URL is missing', async () => {
    vi.stubEnv('SUPABASE_URL', '')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')

    const cfg = await (await app.request('/api/feedback/config')).json()
    expect(cfg.canRead).toBe(false)
    expect((await app.request('/api/feedback/list')).status).toBe(503)
  })
})

describe('feedback — owner allowlist gate (FEEDBACK_ADMIN_EMAILS)', () => {
  const okList = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('[]', { status: 200 })),
    )

  it('allowlist UNSET → service key alone still gates (backward compatible)', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    // No FEEDBACK_ADMIN_EMAILS, no session.
    okList()
    const cfg = await (await app.request('/api/feedback/config')).json()
    expect(cfg.canRead).toBe(true)
    expect((await app.request('/api/feedback/list')).status).toBe(200)
  })

  it('allowlist SET + signed-in allowlisted owner → canRead + 200', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubEnv('FEEDBACK_ADMIN_EMAILS', 'owner@example.com, other@example.com')
    await signInAs('owner@example.com')
    okList()

    const cfg = await (await app.request('/api/feedback/config')).json()
    expect(cfg.canRead).toBe(true)
    expect(typeof cfg.sourceId).toBe('string')
    expect((await app.request('/api/feedback/list')).status).toBe(200)
  })

  it('matches the allowlist case-insensitively', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubEnv('FEEDBACK_ADMIN_EMAILS', 'Owner@Example.com')
    await signInAs('OWNER@example.COM')
    okList()
    const cfg = await (await app.request('/api/feedback/config')).json()
    expect(cfg.canRead).toBe(true)
  })

  it('allowlist SET + signed-in NON-allowlisted user → canRead:false, 403 on reads', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubEnv('FEEDBACK_ADMIN_EMAILS', 'owner@example.com')
    await signInAs('stranger@example.com')

    const cfg = await (await app.request('/api/feedback/config')).json()
    expect(cfg.canRead).toBe(false)
    expect(cfg.sourceId).toBeUndefined()
    expect((await app.request('/api/feedback/list')).status).toBe(403)
    expect((await app.request('/api/feedback/unread')).status).toBe(403)
  })

  it('allowlist SET + signed OUT → canRead:false, 403 on reads', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    vi.stubEnv('FEEDBACK_ADMIN_EMAILS', 'owner@example.com')
    // No signInAs → no session.
    const cfg = await (await app.request('/api/feedback/config')).json()
    expect(cfg.canRead).toBe(false)
    expect((await app.request('/api/feedback/list')).status).toBe(403)
    expect((await app.request('/api/feedback/unread')).status).toBe(403)
  })

  it('owner-gate 403 takes effect only after the service-key 503 check', async () => {
    // No service key but allowlist set + signed out: the missing key wins (503),
    // so a public build never even reaches the 403 path.
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '')
    vi.stubEnv('FEEDBACK_ADMIN_EMAILS', 'owner@example.com')
    expect((await app.request('/api/feedback/list')).status).toBe(503)
  })
})
