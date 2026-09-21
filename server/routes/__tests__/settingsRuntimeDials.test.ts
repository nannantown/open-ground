import { describe, it, expect } from 'vitest'
import { app } from '../../app'
import { getSettings, setSettings } from '@/lib/server/store'

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('retired runtime settings', () => {
  it('ignores both old runtime switches while accepting live preferences', async () => {
    const res = await app.request('/api/settings', post({
      swarmManagerRuntime: { mode: 'pty' },
      swarmWorkerRuntime: { mode: 'pty', sdkMaxWorkers: 3 },
      runtimeDialsEffective: { manager: 'pty' },
      displayName: 'ok',
    }))
    expect(res.status).toBe(200)
    const stored = await getSettings()
    expect(stored).not.toHaveProperty('swarmManagerRuntime')
    expect(stored).not.toHaveProperty('swarmWorkerRuntime')
    expect(stored).not.toHaveProperty('runtimeDialsEffective')
    expect(stored.displayName).toBe('ok')
  })

  it('leaves legacy data intact but no longer advertises a runtime switch', async () => {
    const legacy = { mode: 'pty' }
    await setSettings({ swarmManagerRuntime: legacy } as never)
    await app.request('/api/settings', post({
      swarmManagerRuntime: { mode: 'sdk' }, language: 'ja',
    }))
    expect(await getSettings()).toMatchObject({ swarmManagerRuntime: legacy, language: 'ja' })
    const response = await app.request('/api/settings')
    expect(await response.json()).not.toHaveProperty('runtimeDialsEffective')
  })
})
