import { describe, it, expect } from 'vitest'
import { getSettings, setUserSettings } from './store'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { settingsFile } from './paths'

// `swarmPaneOrder` (the Swarm tab's sub-tab order) was REMOVED 2026-09-23 with
// the sub-tab strip itself — the tab is one screen of side-by-side seats. Old
// installs still carry the key in ~/.openground/settings.json and old clients
// may still POST it; both must be harmless. HOME is isolated to a tmp dir by the
// global test setup, so these writes never touch the real ~/.openground.

describe('retired Settings.swarmPaneOrder', () => {
  it('is no longer user-settable — POST /api/settings drops it', async () => {
    const applied = await setUserSettings({ swarmPaneOrder: ['manager', 'supply', 'workers'] })
    expect(applied).toEqual([])
    const s = (await getSettings()) as unknown as Record<string, unknown>
    expect(s.swarmPaneOrder).toBeUndefined()
  })

  it('a stale key already on disk does not break reading settings', async () => {
    await mkdir(dirname(settingsFile()), { recursive: true })
    await writeFile(settingsFile(), JSON.stringify({ swarmPaneOrder: ['workers', 'overseer'], language: 'ja' }))
    const s = await getSettings()
    expect(s.language).toBe('ja')
  })
})
