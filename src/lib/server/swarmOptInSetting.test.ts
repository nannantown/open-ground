import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setUserSettings, setSettings } from './store'

// Settings.swarmOptIn (the PUBLIC swarm opt-in, all users — 2026-08-20) — same
// persistence contract as autoUpdate/lockdownMode: the POST route
// (setUserSettings) must ACCEPT the key (USER_SETTINGS_KEYS — an unlisted key is
// silently dropped, the "保存が消える既知の罠"), NARROW it to a real boolean
// (only literal `true` opts in; a forged truthy string must not), and round-trip
// through the production reader. macOS-gating happens at READ time
// (isSwarmOptInEnabled), never here — the stored value stays honest. HOME is
// isolated by the global test setup.

describe('Settings.swarmOptIn persistence (setUserSettings)', () => {
  beforeEach(async () => {
    await setSettings({ swarmOptIn: undefined })
  })

  it('is on the allowlist and round-trips true through getSettings', async () => {
    const applied = await setUserSettings({ swarmOptIn: true })
    // ⚠ the allowlist admission is the "保存が消える" guard: an unlisted key is
    // dropped and the toggle would silently never persist.
    expect(applied).toContain('swarmOptIn')
    expect((await getSettings()).swarmOptIn).toBe(true)
  })

  it('persists false back over true (the off switch works)', async () => {
    await setUserSettings({ swarmOptIn: true })
    await setUserSettings({ swarmOptIn: false })
    expect((await getSettings()).swarmOptIn).toBe(false)
  })

  it('⚠ narrows a forged truthy value to false — never opts in by accident', async () => {
    await setUserSettings({ swarmOptIn: 'yes' as unknown as boolean })
    expect((await getSettings()).swarmOptIn).toBe(false)
  })
})
