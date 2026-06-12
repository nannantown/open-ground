import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { customModuleDir } from '@/lib/server/paths'
import type { TerminalInfo } from '@/lib/server/terminal'
import type { CustomModuleDef } from '@/lib/types'

// Route-level contract for the custom-tab module API
// (server/routes/customModules.ts, docs/CUSTOM_TABS_PLAN.md): server-side role
// gating (403 { error: 'forbidden' }), uuid-validated ids (404 before any
// filesystem touch), and env-gated Supabase publish/marketplace (503 when
// unconfigured, fetch mocked when configured — never a real Supabase).

const OWNER = 'owner@example.com'
const TESTER = 'tester@example.com'

// Roles ship with NO built-in emails (the binary must not identify anyone) —
// grant them explicitly through the env override so these route tests stay
// network-free (the override skips the Supabase og_roles lookup).
process.env.OPENGROUND_OWNER_EMAILS = OWNER
process.env.OPENGROUND_TESTER_EMAILS = TESTER

const signInAs = (email: string) =>
  writeSession({
    user: { id: 'test-user', email, provider: 'google' },
    expiresAt: Date.now() + 3_600_000,
    accessToken: 'test-access',
    refreshToken: 'test-refresh',
  })

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

const createAsOwner = async (label = 'Tab', description = 'desc'): Promise<CustomModuleDef> => {
  await signInAs(OWNER)
  const res = await app.request('/api/custom-modules', json('POST', { label, description }))
  expect(res.status).toBe(200)
  return res.json()
}

// Terminal-pool seam (the same globalThis injection customModuleTerminal.test.ts
// uses; importing ../../app pulled in terminal.ts, which initialises the pool):
// the DELETE route must kill any live PTY cwd'd in the module dir before the
// rm — the sidebar claude session would otherwise outlive its tab, headless.
interface FakePtySession {
  info: TerminalInfo
  pty: { kill: () => void }
  buffer: string
  listeners: Set<unknown>
  exitListeners: Set<unknown>
}

const termSessions = () =>
  (globalThis as { __openground_terminal?: { sessions: Map<string, FakePtySession> } })
    .__openground_terminal!.sessions

const fakeClaudePty = (id: string, cwd: string, kills: string[]): FakePtySession => ({
  info: {
    id,
    cwd,
    shell: '/bin/zsh',
    cols: 100,
    rows: 30,
    startedAt: new Date().toISOString(),
    tag: 'claude',
  } as TerminalInfo,
  pty: { kill: () => kills.push(id) },
  buffer: '',
  listeners: new Set(),
  exitListeners: new Set(),
})

let home: string
const prevHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'og-custom-routes-'))
  process.env.OPENGROUND_HOME = home
  termSessions().clear()
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  termSessions().clear()
  await clearSession()
  process.env.OPENGROUND_HOME = prevHome
  await rm(home, { recursive: true, force: true })
})

describe('GET /api/custom-modules — role + list for any caller', () => {
  it('signed out → role none, empty list', async () => {
    const res = await app.request('/api/custom-modules')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ role: 'none', modules: [] })
  })

  it('owner sees role owner and the created modules', async () => {
    const def = await createAsOwner('My Tab')
    const body = await (await app.request('/api/custom-modules')).json()
    expect(body.role).toBe('owner')
    expect(body.modules).toEqual([def])
  })

  it('existing modules stay listed for role none (read-only render)', async () => {
    const def = await createAsOwner()
    await clearSession()
    const body = await (await app.request('/api/custom-modules')).json()
    expect(body.role).toBe('none')
    expect(body.modules).toEqual([def])
  })
})

describe('POST /api/custom-modules — owner-only create', () => {
  it('403 forbidden when signed out', async () => {
    const res = await app.request('/api/custom-modules', json('POST', { label: 'X' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden')
  })

  it('403 forbidden for a tester', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/custom-modules', json('POST', { label: 'X' }))
    expect(res.status).toBe(403)
  })

  it('validates label (required, ≤60) and description (≤4000)', async () => {
    await signInAs(OWNER)
    expect(
      (await app.request('/api/custom-modules', json('POST', { label: '   ' }))).status,
    ).toBe(400)
    expect(
      (await app.request('/api/custom-modules', json('POST', { label: 'x'.repeat(61) })))
        .status,
    ).toBe(400)
    expect(
      (
        await app.request(
          '/api/custom-modules',
          json('POST', { label: 'ok', description: 'x'.repeat(4001) }),
        )
      ).status,
    ).toBe(400)
  })

  it('creates and returns the def (origin local, framework default react)', async () => {
    const def = await createAsOwner('New Tab', 'what it does')
    expect(def.origin).toBe('local')
    expect(def.framework).toBe('react')
    expect(def.label).toBe('New Tab')
  })
})

describe('GET /api/custom-modules/:id/source', () => {
  it('returns source + mtimeMs to any caller', async () => {
    const def = await createAsOwner()
    await clearSession()
    const res = await app.request(`/api/custom-modules/${def.id}/source`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.source).toContain('export default function')
    expect(typeof body.mtimeMs).toBe('number')
  })

  it('404 for a non-uuid id (traversal rejected before the filesystem)', async () => {
    const res = await app.request('/api/custom-modules/..%2F..%2Fetc/source')
    expect(res.status).toBe(404)
  })

  it('404 for an unknown uuid', async () => {
    const res = await app.request(
      '/api/custom-modules/123e4567-e89b-42d3-a456-426614174000/source',
    )
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/custom-modules/:id — owner-only update', () => {
  it('403 for tester / signed out', async () => {
    const def = await createAsOwner()
    await signInAs(TESTER)
    expect(
      (await app.request(`/api/custom-modules/${def.id}`, json('PUT', { label: 'N' }))).status,
    ).toBe(403)
    await clearSession()
    expect(
      (await app.request(`/api/custom-modules/${def.id}`, json('PUT', { label: 'N' }))).status,
    ).toBe(403)
  })

  it('owner patches meta + source', async () => {
    const def = await createAsOwner('Old')
    const res = await app.request(
      `/api/custom-modules/${def.id}`,
      json('PUT', { label: 'New', source: 'export default () => null\n' }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).label).toBe('New')
    const src = await (await app.request(`/api/custom-modules/${def.id}/source`)).json()
    expect(src.source).toBe('export default () => null\n')
  })

  it('404 for unknown uuid as owner', async () => {
    await signInAs(OWNER)
    const res = await app.request(
      '/api/custom-modules/123e4567-e89b-42d3-a456-426614174000',
      json('PUT', { label: 'N' }),
    )
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/custom-modules/:id — owner; tester for installed only', () => {
  it('owner deletes a local module (dir removed)', async () => {
    const def = await createAsOwner()
    const res = await app.request(`/api/custom-modules/${def.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    await expect(stat(customModuleDir(def.id))).rejects.toThrow()
  })

  it('kills a live claude PTY running in the module dir before the rm', async () => {
    const def = await createAsOwner()
    const kills: string[] = []
    termSessions().set('in-module', fakeClaudePty('in-module', customModuleDir(def.id), kills))
    termSessions().set('elsewhere', fakeClaudePty('elsewhere', '/somewhere/else', kills))
    const res = await app.request(`/api/custom-modules/${def.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
    // The sidebar session in the (now removed) module dir is killed; an
    // unrelated live session is untouched.
    expect(kills).toEqual(['in-module'])
  })

  it('tester may NOT delete a local module', async () => {
    const def = await createAsOwner()
    await signInAs(TESTER)
    const res = await app.request(`/api/custom-modules/${def.id}`, { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  it('tester MAY delete an installed module', async () => {
    // Install via the marketplace route (anon fetch mocked).
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    const row = {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      name: 'M',
      description: '',
      framework: 'react',
      source: 'export default () => null\n',
      version: 1,
      published_at: '2026-06-12T00:00:00Z',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify([row]), { status: 200 })),
    )
    await signInAs(TESTER)
    const installed: CustomModuleDef = await (
      await app.request('/api/marketplace/install', json('POST', { remoteId: row.id }))
    ).json()
    expect(installed.origin).toBe('installed')

    const res = await app.request(`/api/custom-modules/${installed.id}`, { method: 'DELETE' })
    expect(res.status).toBe(200)
  })

  it('signed out → 403; unknown uuid as owner → 404', async () => {
    expect(
      (
        await app.request('/api/custom-modules/123e4567-e89b-42d3-a456-426614174000', {
          method: 'DELETE',
        })
      ).status,
    ).toBe(403)
    await signInAs(OWNER)
    expect(
      (
        await app.request('/api/custom-modules/123e4567-e89b-42d3-a456-426614174000', {
          method: 'DELETE',
        })
      ).status,
    ).toBe(404)
  })
})

describe('POST /api/custom-modules/:id/publish', () => {
  it('403 for non-owner (checked before the env gate)', async () => {
    await signInAs(TESTER)
    const res = await app.request(
      '/api/custom-modules/123e4567-e89b-42d3-a456-426614174000/publish',
      { method: 'POST' },
    )
    expect(res.status).toBe(403)
  })

  it('503 publishUnavailable when the service-role env is missing', async () => {
    const def = await createAsOwner()
    const res = await app.request(`/api/custom-modules/${def.id}/publish`, { method: 'POST' })
    expect(res.status).toBe(503)
    expect((await res.json()).publishUnavailable).toBe(true)
  })

  it('first publish INSERTs with the SERVICE key and stamps remoteId/version', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co/')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const def = await createAsOwner('Pub', 'd')
    const returned = [
      {
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        name: 'Pub',
        description: 'd',
        framework: 'react',
        version: 1,
        published_at: '2026-06-12T00:00:00Z',
      },
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(returned), { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await app.request(`/api/custom-modules/${def.id}/publish`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.remoteId).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
    expect(body.version).toBe(1)

    // Default table og_custom_modules; service key in both headers; source rides
    // the row body.
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://example.supabase.co/rest/v1/og_custom_modules')
    expect(init.method).toBe('POST')
    expect(init.headers.apikey).toBe('service-role-key')
    expect(init.headers.Authorization).toBe('Bearer service-role-key')
    const sent = JSON.parse(init.body)
    expect(sent.name).toBe('Pub')
    expect(sent.source).toContain('export default function')
    // No author identity rides the row — the published table carries nothing
    // that names the publisher (author_email was dropped, see the plan).
    expect('author_email' in sent).toBe(false)
  })

  it('re-publish UPDATEs by remoteId with version+1', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const def = await createAsOwner('Pub2')
    const remoteId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

    // First publish (INSERT) to stamp remoteId/version on the local def.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            { id: remoteId, version: 1, published_at: '2026-06-12T00:00:00Z' },
          ]),
          { status: 201 },
        ),
      ),
    )
    await app.request(`/api/custom-modules/${def.id}/publish`, { method: 'POST' })

    // Second publish must PATCH ?id=eq.<remoteId> with version 2.
    const patchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([{ id: remoteId, version: 2, published_at: '2026-06-12T00:00:00Z' }]),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', patchMock)
    const res = await app.request(`/api/custom-modules/${def.id}/publish`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect((await res.json()).version).toBe(2)
    const [url, init] = patchMock.mock.calls[0]
    expect(url).toContain(`?id=eq.${remoteId}`)
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body).version).toBe(2)
  })

  it('502 (generic, no url/key leak) when Supabase rejects', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-key')
    const def = await createAsOwner()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('rls says no', { status: 401 })),
    )
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await app.request(`/api/custom-modules/${def.id}/publish`, { method: 'POST' })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error).toMatch(/responded 401/)
    expect(JSON.stringify(body)).not.toContain('service-role-key')
  })
})

describe('GET /api/marketplace', () => {
  it('403 for role none', async () => {
    expect((await app.request('/api/marketplace')).status).toBe(403)
  })

  it('503 when the anon env is missing (owner or tester)', async () => {
    await signInAs(TESTER)
    expect((await app.request('/api/marketplace')).status).toBe(503)
  })

  it('tester lists published modules via the ANON key', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    const rows = [
      {
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        name: 'M',
        description: 'd',
        framework: 'react',
        version: 2,
        published_at: '2026-06-12T00:00:00Z',
      },
    ]
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await signInAs(TESTER)
    const res = await app.request('/api/marketplace')
    expect(res.status).toBe(200)
    expect((await res.json()).items).toEqual([
      {
        remoteId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        name: 'M',
        description: 'd',
        framework: 'react',
        version: 2,
        publishedAt: '2026-06-12T00:00:00Z',
      },
    ])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/rest/v1/og_custom_modules?')
    expect(init.headers.apikey).toBe('anon-key')
  })
})

describe('POST /api/marketplace/install', () => {
  it('403 for role none; 400 without remoteId; 404 when the row is missing', async () => {
    expect(
      (await app.request('/api/marketplace/install', json('POST', { remoteId: 'x' }))).status,
    ).toBe(403)

    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    await signInAs(TESTER)
    expect(
      (await app.request('/api/marketplace/install', json('POST', {}))).status,
    ).toBe(400)

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('[]', { status: 200 })),
    )
    expect(
      (await app.request('/api/marketplace/install', json('POST', { remoteId: 'nope' })))
        .status,
    ).toBe(404)
  })

  it('installs a row locally and re-install updates in place', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key')
    const row = {
      id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      name: 'Installed',
      description: 'd',
      framework: 'react',
      source: 'export default () => null\n',
      version: 1,
      published_at: '2026-06-12T00:00:00Z',
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify([row]), { status: 200 })),
    )
    await signInAs(TESTER)
    const first: CustomModuleDef = await (
      await app.request('/api/marketplace/install', json('POST', { remoteId: row.id }))
    ).json()
    expect(first.origin).toBe('installed')
    expect(first.remoteId).toBe(row.id)

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify([{ ...row, version: 2 }]), { status: 200 }),
        ),
    )
    const second: CustomModuleDef = await (
      await app.request('/api/marketplace/install', json('POST', { remoteId: row.id }))
    ).json()
    expect(second.id).toBe(first.id)
    expect(second.version).toBe(2)

    const list = await (await app.request('/api/custom-modules')).json()
    expect(list.modules).toHaveLength(1)
  })
})
