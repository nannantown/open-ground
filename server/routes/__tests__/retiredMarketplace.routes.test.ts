import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { app } from '../../app'
import { customModuleSourceFile, customModulesIndexFile } from '@/lib/server/paths'
import type { CustomModuleDef } from '@/lib/types'

vi.mock('@/lib/server/roles', () => ({ getCustomTabRole: async () => 'owner' }))

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const SOURCE = '<!doctype html><html><body>Saved local tab</body></html>'
const DEF: CustomModuleDef = {
  id: ID, label: 'Saved tab', description: 'Existing installation', framework: 'html',
  origin: 'installed', createdAt: '2026-06-12T00:00:00Z', updatedAt: '2026-06-12T00:00:00Z',
  remoteId: '11111111-2222-4333-8444-555555555555', version: 3,
  publishedAt: '2026-06-12T00:00:00Z',
}
let home: string
const previousHome = process.env.OPENGROUND_HOME

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'og-retired-market-'))
  process.env.OPENGROUND_HOME = home
  await mkdir(join(home, 'custom-modules', ID), { recursive: true })
  await writeFile(customModulesIndexFile(), JSON.stringify([DEF]))
  await writeFile(customModuleSourceFile(ID, 'html'), SOURCE)
  vi.stubEnv('SUPABASE_URL', 'https://example.invalid')
  vi.stubEnv('SUPABASE_ANON_KEY', 'test-anon')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No external requests allowed')))
})

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  process.env.OPENGROUND_HOME = previousHome
  await rm(home, { recursive: true, force: true })
})

describe('retired tab distribution', () => {
  it.each([
    ['GET', '/api/marketplace'],
    ['POST', '/api/marketplace/install'],
    ['POST', `/api/custom-modules/${ID}/publish`],
    ['GET', '/api/module-submissions/config'],
    ['GET', '/api/module-submissions'],
    ['POST', '/api/module-submissions'],
    ['GET', '/api/module-submissions/unread'],
    ['GET', `/api/module-submissions/${ID}`],
    ['POST', `/api/module-submissions/${ID}/approve`],
    ['POST', `/api/module-submissions/${ID}/reject`],
  ])('%s %s is absent even with owner access and cloud configuration', async (method, path) => {
    const before = await readFile(customModulesIndexFile(), 'utf8')
    const response = await app.request(path, { method })
    expect(response.status).toBe(404)
    expect(fetch).not.toHaveBeenCalled()
    expect(await readFile(customModulesIndexFile(), 'utf8')).toBe(before)
    expect(await readFile(customModuleSourceFile(ID, 'html'), 'utf8')).toBe(SOURCE)
  })

  it('reads an existing installed tab unchanged without a marketplace capability', async () => {
    const index = await readFile(customModulesIndexFile(), 'utf8')
    const list = await (await app.request('/api/custom-modules')).json()
    expect(list).toEqual({ role: 'owner', modules: [DEF] })
    const source = await (await app.request(`/api/custom-modules/${ID}/source`)).json()
    expect(source.source).toBe(SOURCE)
    expect(await readFile(customModulesIndexFile(), 'utf8')).toBe(index)
    expect(fetch).not.toHaveBeenCalled()
  })
})
