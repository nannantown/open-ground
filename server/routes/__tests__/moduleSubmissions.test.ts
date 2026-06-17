import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { app } from '../../app'
import { writeSession } from '@/lib/server/authStore'

// Route-level contract for the module-submission review queue
// (server/routes/moduleSubmissions.ts, docs/CUSTOM_TABS_PLAN.md): a tester
// submits a built tab (anon-key INSERT, gated owner|tester), the owner reviews
// (service-role key + optional admin allowlist) and approve PUBLISHES into
// og_custom_modules via the existing publishModule. Supabase is always mocked —
// never a real network call — and env is flipped per case with vi.stubEnv.

const OWNER = 'owner@example.com'
const TESTER = 'tester@example.com'
const OUTSIDER = 'nobody@example.com'

// Resolve roles through the env override (skips the Supabase og_roles lookup) so
// these route tests stay network-free. Cleared by setup-home, set here per file.
process.env.OPENGROUND_OWNER_EMAILS = OWNER
process.env.OPENGROUND_TESTER_EMAILS = TESTER

const SUB_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

const signInAs = (email: string) =>
  writeSession({
    user: { id: 'test-user', email, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
  })

const signOut = () =>
  // A fresh tmp home per test already has no session; this is belt-and-braces
  // for cases that signed in earlier in the same test.
  import('@/lib/server/authStore').then((m) => m.clearSession())

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

// Configure the anon (submit) and/or service-role (review) tiers for a case.
const stubSupabase = (opts: { anon?: boolean; service?: boolean }) => {
  vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co/')
  if (opts.anon) vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
  if (opts.service) vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await signOut()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/module-submissions/config', () => {
  it('all false when no Supabase env (the public build)', async () => {
    const body = await (await app.request('/api/module-submissions/config')).json()
    expect(body).toEqual({ enabled: false, canReview: false })
  })

  it('enabled when the anon key is present', async () => {
    stubSupabase({ anon: true })
    const body = await (await app.request('/api/module-submissions/config')).json()
    expect(body.enabled).toBe(true)
    expect(body.canReview).toBe(false)
  })

  it('canReview + sourceId when the service key is present (no allowlist)', async () => {
    stubSupabase({ anon: true, service: true })
    const body = await (await app.request('/api/module-submissions/config')).json()
    expect(body.canReview).toBe(true)
    expect(typeof body.sourceId).toBe('string')
    // Opaque id only — never the url or key.
    expect(body.sourceId).not.toContain('example.supabase.co')
    expect(JSON.stringify(body)).not.toContain('service-role-key')
  })

  it('canReview false when an allowlist excludes the signed-in account', async () => {
    stubSupabase({ service: true })
    vi.stubEnv('MODULE_ADMIN_EMAILS', OWNER)
    await signInAs(TESTER)
    const body = await (await app.request('/api/module-submissions/config')).json()
    expect(body.canReview).toBe(false)
  })
})

describe('POST /api/module-submissions — submit (owner|tester)', () => {
  it('403 when signed out (role none)', async () => {
    stubSupabase({ anon: true })
    const res = await app.request(
      '/api/module-submissions',
      json('POST', { name: 'X', framework: 'react', source: 'export default () => null' }),
    )
    expect(res.status).toBe(403)
  })

  it('503 when the anon env is missing (signed-in tester)', async () => {
    await signInAs(TESTER)
    const res = await app.request(
      '/api/module-submissions',
      json('POST', { name: 'X', framework: 'react', source: 'export default () => null' }),
    )
    expect(res.status).toBe(503)
  })

  it('400 when the body is invalid (no source)', async () => {
    stubSupabase({ anon: true })
    await signInAs(TESTER)
    const res = await app.request('/api/module-submissions', json('POST', { name: 'X' }))
    expect(res.status).toBe(400)
  })

  it('a tester INSERTs a pending row with the anon key + their session email', async () => {
    stubSupabase({ anon: true })
    await signInAs(TESTER)
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.request(
      '/api/module-submissions',
      json('POST', {
        name: 'My tab',
        description: 'does things',
        framework: 'react',
        source: 'export default () => null',
      }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.supabase.co/rest/v1/og_module_submissions')
    expect(init.method).toBe('POST')
    expect(init.headers.apikey).toBe('anon-key')
    const sent = JSON.parse(init.body)
    expect(sent.status).toBe('pending')
    expect(sent.name).toBe('My tab')
    expect(sent.source).toBe('export default () => null')
    expect(sent.submitter_email).toBe(TESTER)
  })

  it('502 (generic, no key leak) when Supabase rejects the insert', async () => {
    stubSupabase({ anon: true })
    await signInAs(TESTER)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('rls', { status: 401 })))
    const res = await app.request(
      '/api/module-submissions',
      json('POST', { name: 'X', framework: 'react', source: 'export default () => null' }),
    )
    expect(res.status).toBe(502)
    expect(JSON.stringify(await res.json())).not.toContain('anon-key')
  })
})

describe('GET /api/module-submissions — owner review queue', () => {
  it('503 when the service key is missing', async () => {
    expect((await app.request('/api/module-submissions')).status).toBe(503)
  })

  it('403 when an allowlist excludes the signed-in account', async () => {
    stubSupabase({ service: true })
    vi.stubEnv('MODULE_ADMIN_EMAILS', OWNER)
    await signInAs(OUTSIDER)
    expect((await app.request('/api/module-submissions')).status).toBe(403)
  })

  it('lists pending rows (no source selected) with the service key', async () => {
    stubSupabase({ service: true })
    const rows = [
      {
        id: SUB_ID,
        created_at: '2026-06-16T00:00:00Z',
        submitter_email: TESTER,
        name: 'Sub',
        description: 'd',
        framework: 'react',
        status: 'pending',
        published_remote_id: null,
      },
    ]
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.request('/api/module-submissions')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].name).toBe('Sub')
    expect(body.truncated).toBe(false)
    // The list query is light — it must NOT select the source column.
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('status=eq.pending')
    expect(url).not.toContain('source')
    expect(init.headers.apikey).toBe('service-role-key')
  })
})

describe('GET /api/module-submissions/unread', () => {
  it('returns the pending count from the Content-Range header', async () => {
    stubSupabase({ service: true })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(null, { status: 206, headers: { 'content-range': '0-2/3' } }),
      ),
    )
    const res = await app.request('/api/module-submissions/unread?since=2026-06-15T00:00:00Z')
    expect(res.status).toBe(200)
    expect((await res.json()).count).toBe(3)
  })

  it('503 when the service key is missing', async () => {
    expect((await app.request('/api/module-submissions/unread')).status).toBe(503)
  })
})

describe('GET /api/module-submissions/:id — one row with source', () => {
  it('503 when the service key is missing', async () => {
    expect((await app.request(`/api/module-submissions/${SUB_ID}`)).status).toBe(503)
  })

  it('returns the submission WITH its source for the review preview', async () => {
    stubSupabase({ service: true })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: SUB_ID,
              created_at: '2026-06-16T00:00:00Z',
              submitter_email: TESTER,
              name: 'Sub',
              description: 'd',
              framework: 'react',
              status: 'pending',
              published_remote_id: null,
              source: 'export default () => null',
            },
          ]),
          { status: 200 },
        ),
      ),
    )
    const res = await app.request(`/api/module-submissions/${SUB_ID}`)
    expect(res.status).toBe(200)
    expect((await res.json()).source).toBe('export default () => null')
  })

  it('404 when the id matches no row', async () => {
    stubSupabase({ service: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
    expect((await app.request(`/api/module-submissions/${SUB_ID}`)).status).toBe(404)
  })
})

describe('POST /api/module-submissions/:id/approve', () => {
  it('503 when the service key is missing', async () => {
    expect(
      (await app.request(`/api/module-submissions/${SUB_ID}/approve`, { method: 'POST' })).status,
    ).toBe(503)
  })

  it('404 when the submission row is gone', async () => {
    stubSupabase({ service: true })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })))
    const res = await app.request(`/api/module-submissions/${SUB_ID}/approve`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('publishes the source into og_custom_modules and marks the row approved', async () => {
    stubSupabase({ service: true })
    const calls: { url: string; method: string; body?: string }[] = []
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body as string | undefined })
      // 1) getSubmission — the row WITH source.
      if (url.includes('og_module_submissions') && method === 'GET') {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: SUB_ID,
                created_at: '2026-06-16T00:00:00Z',
                submitter_email: TESTER,
                name: 'Sub',
                description: 'd',
                framework: 'react',
                status: 'pending',
                published_remote_id: null,
                source: 'export default function App(){return null}',
              },
            ]),
            { status: 200 },
          ),
        )
      }
      // 2) publishModule — INSERT into the public marketplace.
      if (url.includes('og_custom_modules') && method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify([
              { id: 'remote-xyz', name: 'Sub', version: 1, published_at: '2026-06-16T00:00:00Z' },
            ]),
            { status: 201 },
          ),
        )
      }
      // 3) markSubmission — PATCH the queue row.
      if (url.includes('og_module_submissions') && method === 'PATCH') {
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      return Promise.resolve(new Response('unexpected', { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.request(`/api/module-submissions/${SUB_ID}/approve`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()).remoteId).toBe('remote-xyz')

    // The published INSERT carries the submitted source into og_custom_modules.
    const publish = calls.find((c) => c.url.includes('og_custom_modules') && c.method === 'POST')
    expect(publish).toBeDefined()
    const published = JSON.parse(publish!.body!)
    expect(published.source).toContain('export default function App')
    expect(published.name).toBe('Sub')
    expect('author_email' in published).toBe(false)

    // The queue row is stamped approved + linked to the new marketplace id.
    const mark = calls.find((c) => c.url.includes('og_module_submissions') && c.method === 'PATCH')
    expect(mark).toBeDefined()
    const marked = JSON.parse(mark!.body!)
    expect(marked.status).toBe('approved')
    expect(marked.published_remote_id).toBe('remote-xyz')
  })
})

describe('POST /api/module-submissions/:id/reject', () => {
  it('503 when the service key is missing', async () => {
    expect(
      (await app.request(`/api/module-submissions/${SUB_ID}/reject`, { method: 'POST' })).status,
    ).toBe(503)
  })

  it('marks the row rejected with the service key', async () => {
    stubSupabase({ service: true })
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)
    const res = await app.request(`/api/module-submissions/${SUB_ID}/reject`, { method: 'POST' })
    expect(res.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain(`?id=eq.${SUB_ID}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body).status).toBe('rejected')
  })
})
