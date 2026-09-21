import { describe, expect, it } from 'vitest'
import { app } from '../../app'
import { getSettings, setSettings } from '@/lib/server/store'

describe('retired external-app menu routes', () => {
  it('rejects old read/save/launch routes without erasing stored preferences', async () => {
    const openApps = [{ name: 'Saved app', path: '/not-launched.app', mode: 'open' as const }]
    await setSettings({ openApps })
    for (const method of ['GET', 'POST', 'PUT']) {
      const res = await app.request('/api/project/open', {
        method,
        ...(method !== 'GET' ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apps: [], path: '/tmp', app: 'Saved app' }) } : {}),
      })
      expect(res.status).toBe(404)
    }
    expect((await getSettings()).openApps).toEqual(openApps)
    expect((await app.request('/api/project/editors')).status).toBe(200)
  })
})
