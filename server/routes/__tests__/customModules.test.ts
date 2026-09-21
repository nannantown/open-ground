import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { writeSession, clearSession } from '@/lib/server/authStore'
import { customModuleDir, customModuleSourceFile, customModulesIndexFile } from '@/lib/server/paths'
import type { TerminalInfo } from '@/lib/server/terminal'
import type { CustomModuleDef } from '@/lib/types'

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

// Legacy installations must remain usable without the retired install endpoint.
const seedInstalledTab = async (): Promise<CustomModuleDef> => {
  const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  const def: CustomModuleDef = {
    id, label: 'Installed', description: '', framework: 'react', origin: 'installed',
    createdAt: '2026-06-12T00:00:00Z', updatedAt: '2026-06-12T00:00:00Z',
    remoteId: '11111111-2222-4333-8444-555555555555', version: 1,
  }
  await mkdir(customModuleDir(id), { recursive: true })
  await writeFile(customModulesIndexFile(), JSON.stringify([def]))
  await writeFile(customModuleSourceFile(id), 'export default () => null\n')
  return def
}

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

describe('POST /api/custom-modules — owner|tester create (none forbidden)', () => {
  it('403 forbidden when signed out', async () => {
    const res = await app.request('/api/custom-modules', json('POST', { label: 'X' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('forbidden')
  })

  it('a tester MAY create a local module (authoring is open to testers)', async () => {
    await signInAs(TESTER)
    const res = await app.request('/api/custom-modules', json('POST', { label: 'Tester Tab' }))
    expect(res.status).toBe(200)
    const def: CustomModuleDef = await res.json()
    expect(def.origin).toBe('local')
    expect(def.label).toBe('Tester Tab')
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

describe('PUT /api/custom-modules/:id — owner any; tester local-only', () => {
  it('403 when signed out', async () => {
    const def = await createAsOwner()
    await clearSession()
    expect(
      (await app.request(`/api/custom-modules/${def.id}`, json('PUT', { label: 'N' }))).status,
    ).toBe(403)
  })

  it('a tester MAY edit a local module (their own authored tab)', async () => {
    // A tester-authored local module: the create gate is open to testers.
    await signInAs(TESTER)
    const def: CustomModuleDef = await (
      await app.request('/api/custom-modules', json('POST', { label: 'Mine' }))
    ).json()
    const res = await app.request(
      `/api/custom-modules/${def.id}`,
      json('PUT', { label: 'Renamed', source: 'export default () => null\n' }),
    )
    expect(res.status).toBe(200)
    expect((await res.json()).label).toBe('Renamed')
    const src = await (await app.request(`/api/custom-modules/${def.id}/source`)).json()
    expect(src.source).toBe('export default () => null\n')
  })

  it('a tester may NOT edit an installed module (someone else’s artifact)', async () => {
    const installed = await seedInstalledTab()
    await signInAs(TESTER)
    const res = await app.request(
      `/api/custom-modules/${installed.id}`,
      json('PUT', { label: 'Hijack', source: 'changed' }),
    )
    expect(res.status).toBe(403)
    expect(await readFile(customModuleSourceFile(installed.id), 'utf8')).toBe('export default () => null\n')
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
    const installed = await seedInstalledTab()
    await signInAs(TESTER)
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
