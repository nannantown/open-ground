import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CustomModuleDef } from '@/lib/types'

const h = vi.hoisted(() => ({
  modules: [] as Partial<CustomModuleDef>[],
  startNene: vi.fn(async () => ({ ok: true as const })),
}))
vi.mock('@/lib/server/customModules', async (orig) => ({
  ...(await orig<typeof import('@/lib/server/customModules')>()),
  listModules: async () => h.modules,
}))
vi.mock('@/lib/server/localAppLauncher', () => ({ startNene: h.startNene }))

import { app } from '../../app'
import { setLockdownCache } from '@/lib/server/lockdown'

const START = '/api/local-apps/nene-songs/start'
const SONGS = { id: 'x', label: 'Songs', localApp: 'nene-songs' as const }

afterEach(() => {
  setLockdownCache(false)
  h.modules = []
  h.startNene.mockClear()
})

describe('POST /api/local-apps/nene-songs/start', () => {
  it('starts NENE when a tab declares the integration', async () => {
    h.modules = [SONGS]
    const res = await app.request(START, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(h.startNene).toHaveBeenCalledTimes(1)
  })

  it('refuses under work-mode lockdown without starting anything', async () => {
    h.modules = [SONGS]
    setLockdownCache(true)
    const res = await app.request(START, { method: 'POST' })
    expect(res.status).toBe(403)
    expect(h.startNene).not.toHaveBeenCalled()
  })

  it('404s when no tab declares nene-songs, without starting anything', async () => {
    h.modules = [{ id: 'y', label: 'Other' }]
    const res = await app.request(START, { method: 'POST' })
    expect(res.status).toBe(404)
    expect(h.startNene).not.toHaveBeenCalled()
  })
})
