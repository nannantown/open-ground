import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setUserSettings, setSettings } from './store'

// Settings.theme (第三弾「計器盤」2026-08-03) — the light/dark palette choice,
// persisted centrally in ~/.openground/settings.json. These pin the same
// persistence contract as swarmPaneOrder: POST /api/settings (setUserSettings)
// must ACCEPT the key (USER_SETTINGS_KEYS — an unlisted key is silently
// dropped, the "保存が消える既知の罠"), NARROW it to the two literals, and
// round-trip through the PRODUCTION reader (getSettings). HOME is isolated to
// a tmp dir by the global test setup.

describe('Settings.theme persistence (setUserSettings)', () => {
  beforeEach(async () => {
    await setSettings({ theme: undefined })
  })

  it('persists "dark" and round-trips through getSettings (the production reader)', async () => {
    const applied = await setUserSettings({ theme: 'dark' })
    expect(applied).toContain('theme')
    expect((await getSettings()).theme).toBe('dark')
  })

  it('persists "light" back over "dark"', async () => {
    await setUserSettings({ theme: 'dark' })
    await setUserSettings({ theme: 'light' })
    expect((await getSettings()).theme).toBe('light')
  })

  it('drops a garbage value so the previous choice survives', async () => {
    await setUserSettings({ theme: 'dark' })
    const applied = await setUserSettings({ theme: 'neon' })
    // Narrowed away: the key is NOT applied and the stored value is untouched.
    expect(applied).not.toContain('theme')
    expect((await getSettings()).theme).toBe('dark')
  })

  it('drops a non-string value (forged boolean) without clobbering', async () => {
    await setUserSettings({ theme: 'dark' })
    await setUserSettings({ theme: true })
    expect((await getSettings()).theme).toBe('dark')
  })
})
