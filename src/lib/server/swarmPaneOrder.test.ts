import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setUserSettings, setSettings } from './store'

// Settings.swarmPaneOrder is the GLOBAL, personal order of the Swarm tab's four
// sub-tabs (補給官/司令官/ワーカー/監督), persisted centrally in
// ~/.openground/settings.json — never the user's repo. These pin the
// persistence CONTRACT the UI depends on (完了条件2 "順序が永続化される"): the
// untrusted POST /api/settings route (setUserSettings) must ACCEPT it (it is in
// the USER_SETTINGS_KEYS allowlist — an unlisted key is silently dropped, the
// "保存が消える既知の罠"), NARROW it to the known pane ids, and round-trip
// through getSettings so the order survives a reload / restart. HOME is isolated
// to a tmp dir by the global test setup, so these writes never touch the real
// ~/.openground.

describe('Settings.swarmPaneOrder persistence (setUserSettings)', () => {
  beforeEach(async () => {
    // Clear any order a previous test left so each starts from "unset".
    await setSettings({ swarmPaneOrder: undefined })
  })

  it('persists a valid reordered list and round-trips through getSettings (条件2)', async () => {
    const applied = await setUserSettings({
      swarmPaneOrder: ['manager', 'supply', 'workers'],
    })
    expect(applied).toContain('swarmPaneOrder')
    const s = await getSettings()
    expect(s.swarmPaneOrder).toEqual(['manager', 'supply', 'workers'])
  })

  it('is on the USER_SETTINGS_KEYS allowlist (else the POST would silently drop it)', async () => {
    const applied = await setUserSettings({
      swarmPaneOrder: ['workers', 'supply', 'manager'],
    })
    // Listed ⇒ it actually applies; an unlisted key would return [] here.
    expect(applied).toEqual(['swarmPaneOrder'])
  })

  it('narrows out unknown ids and dedupes, keeping the caller order', async () => {
    await setUserSettings({
      // Retired ids ('flow', and 'overseer' since 2026-09-23), a duplicate, and a
      // non-string all get scrubbed.
      swarmPaneOrder: ['workers', 'overseer', 'flow', 'workers', 'supply', 42, 'manager'],
    })
    const s = await getSettings()
    expect(s.swarmPaneOrder).toEqual(['workers', 'supply', 'manager'])
  })

  it('refuses an all-garbage array — keeps the previous order rather than wiping it', async () => {
    await setUserSettings({ swarmPaneOrder: ['manager', 'supply', 'workers'] })
    const applied = await setUserSettings({ swarmPaneOrder: ['nope', 123, null] })
    // Nothing valid survived ⇒ the key is not applied (mirrors the
    // swarmAllowedModels all-off guard), so the stored order is untouched.
    expect(applied).not.toContain('swarmPaneOrder')
    const s = await getSettings()
    expect(s.swarmPaneOrder).toEqual(['manager', 'supply', 'workers'])
  })

  it('ignores a non-array value entirely', async () => {
    const applied = await setUserSettings({ swarmPaneOrder: 'supply' })
    expect(applied).not.toContain('swarmPaneOrder')
  })
})
