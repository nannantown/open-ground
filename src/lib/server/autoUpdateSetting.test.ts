import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setUserSettings, setSettings } from './store'

// Settings.autoUpdate (hands-free updates, 2026-08-03) — same persistence
// contract as theme/swarmPaneOrder: the POST route (setUserSettings) must
// ACCEPT the key (USER_SETTINGS_KEYS — an unlisted key is silently dropped, the
// "保存が消える既知の罠"), NARROW it to a real boolean (only literal `true`
// enables; the Electron main process re-reads settings.json raw with the same
// `=== true`, so the two processes must agree on forged values), and round-trip
// through the production reader. HOME is isolated by the global test setup.

describe('Settings.autoUpdate persistence (setUserSettings)', () => {
  beforeEach(async () => {
    await setSettings({ autoUpdate: undefined })
  })

  it('persists true and round-trips through getSettings', async () => {
    const applied = await setUserSettings({ autoUpdate: true })
    expect(applied).toContain('autoUpdate')
    expect((await getSettings()).autoUpdate).toBe(true)
  })

  it('persists false back over true (the off switch works)', async () => {
    await setUserSettings({ autoUpdate: true })
    await setUserSettings({ autoUpdate: false })
    expect((await getSettings()).autoUpdate).toBe(false)
  })

  it('narrows a forged truthy string to false — never hands-free by accident', async () => {
    await setUserSettings({ autoUpdate: 'yes' })
    expect((await getSettings()).autoUpdate).toBe(false)
  })
})
