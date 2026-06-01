import { describe, it, expect, afterEach, vi } from 'vitest'
import { app } from '../../app'

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

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
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
