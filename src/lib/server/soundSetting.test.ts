import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setUserSettings, setSettings } from './store'

// Settings.soundOnDone / soundOnDoneVolume (completion chime, 2026-08-03) —
// the same persistence contract as theme/autoUpdate: POST /api/settings
// (setUserSettings) must ACCEPT both keys (USER_SETTINGS_KEYS — an unlisted
// key is silently dropped), NARROW them (boolean; clamped 0–100 integer), and
// round-trip through the production reader. The Stop hook re-reads the raw
// file with the same `=== true` / clamp semantics, so the two must agree.
// HOME is isolated by the global test setup.

describe('Settings.soundOnDone / soundOnDoneVolume persistence', () => {
  beforeEach(async () => {
    await setSettings({ soundOnDone: undefined, soundOnDoneVolume: undefined })
  })

  it('persists the toggle and round-trips', async () => {
    const applied = await setUserSettings({ soundOnDone: true, soundOnDoneVolume: 40 })
    expect(applied).toContain('soundOnDone')
    expect(applied).toContain('soundOnDoneVolume')
    const s = await getSettings()
    expect(s.soundOnDone).toBe(true)
    expect(s.soundOnDoneVolume).toBe(40)
  })

  it('narrows a forged truthy string to false — never rings by accident', async () => {
    await setUserSettings({ soundOnDone: 'yes' })
    expect((await getSettings()).soundOnDone).toBe(false)
  })

  it('clamps volume into 0–100 and rounds', async () => {
    await setUserSettings({ soundOnDoneVolume: 250 })
    expect((await getSettings()).soundOnDoneVolume).toBe(100)
    await setUserSettings({ soundOnDoneVolume: -3 })
    expect((await getSettings()).soundOnDoneVolume).toBe(0)
    await setUserSettings({ soundOnDoneVolume: 33.4 })
    expect((await getSettings()).soundOnDoneVolume).toBe(33)
  })

  it('drops a garbage volume so the previous value survives', async () => {
    await setUserSettings({ soundOnDoneVolume: 70 })
    await setUserSettings({ soundOnDoneVolume: 'loud' })
    expect((await getSettings()).soundOnDoneVolume).toBe(70)
  })
})
