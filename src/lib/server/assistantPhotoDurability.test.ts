import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveAssistantPhoto } from './assistantMemory'
import { readAssistantRuntime, __resetAssistantRuntimeForTest } from './assistantRuntimeStore'
import { phoneLinkRoutes } from '../../../server/routes/phoneLink'
import { setLockdownCache } from './lockdown'

const h = vi.hoisted(() => ({ trace: [] as string[], fail: '', open: vi.fn() }))
vi.mock('fs/promises', async original => ({ ...await original<typeof import('fs/promises')>(), open: h.open }))
vi.mock('./assistantAccess', () => ({ hasAssistantAccess: async () => true }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => true }))
vi.mock('./runtimeOwner', async original => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async () => 'synthetic-owner', runtimeRequestOwnerKey: async () => 'synthetic-owner' }))
vi.mock('./runtimeTransitionStore', async original => ({ ...await original<typeof import('./runtimeTransitionStore')>(), runtimeAdmissionBlocked: () => true }))
const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
beforeEach(() => {
  __resetAssistantRuntimeForTest(); setLockdownCache(false); h.trace = []; h.fail = ''
  h.open.mockReset().mockImplementation(async (_path: string, flag: string, mode?: number) => {
    const kind = flag === 'wx' ? 'file' : 'directory'
    h.trace.push(`open:${kind}`)
    if (kind === 'file') expect(mode).toBe(0o600)
    return {
      writeFile: async () => { h.trace.push('write'); if (h.fail === 'write') throw new Error('synthetic write failure') },
      sync: async () => { h.trace.push(`sync:${kind}`); if (h.fail === `${kind}-sync`) throw new Error('synthetic sync failure') },
      close: async () => { h.trace.push(`close:${kind}`) },
    }
  })
})
describe('photo bytes precede durable assistant acceptance', () => {
  it('syncs and closes the unique private file and its directory before returning its name', async () => {
    expect(await saveAssistantPhoto(bytes, 'png')).toMatch(/\.png$/)
    expect(h.trace).toEqual(['open:file', 'write', 'sync:file', 'close:file', ...(process.platform === 'win32' ? [] : ['open:directory', 'sync:directory', 'close:directory'])])
  })
  it.each(['write', 'file-sync', ...(process.platform === 'win32' ? [] : ['directory-sync'])])('does not accept a photo message when %s fails', async fail => {
    h.fail = fail
    const response = await phoneLinkRoutes.request('http://localhost/api/phone-link/assistant/say', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'unsaved-photo', text: 'synthetic image', photo: Buffer.from(bytes).toString('base64') }) })
    expect(response.status).toBe(502)
    expect(await response.json()).toHaveProperty('error')
    expect(readAssistantRuntime().turns).toEqual([])
    expect(h.trace).toContain('close:file')
    if (fail === 'directory-sync') expect(h.trace).toContain('close:directory')
  })
})
