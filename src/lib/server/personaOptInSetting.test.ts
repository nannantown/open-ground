import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setUserSettings, setSettings } from './store'

// Settings.personaOptIn (the PUBLIC persona opt-in, all users, all platforms —
// 2026-08-20) — same persistence contract as swarmOptIn: the POST route
// (setUserSettings) must ACCEPT the key (USER_SETTINGS_KEYS — an unlisted key is
// silently dropped, the "保存が消える既知の罠"), NARROW it to a real boolean (only
// literal `true` opts in; a forged truthy value must not), and round-trip
// through the production reader. Unlike swarmOptIn there is NO platform gate at
// read time (persona is all-platforms), so the stored value is the resolved
// value. HOME is isolated by the global test setup.

describe('Settings.personaOptIn persistence (setUserSettings)', () => {
  beforeEach(async () => {
    await setSettings({ personaOptIn: undefined })
  })

  it('is on the allowlist and round-trips true through getSettings', async () => {
    const applied = await setUserSettings({ personaOptIn: true })
    // ⚠ the allowlist admission is the "保存が消える" guard: an unlisted key is
    // dropped and the toggle would silently never persist.
    expect(applied).toContain('personaOptIn')
    expect((await getSettings()).personaOptIn).toBe(true)
  })

  it('persists false back over true (the off switch works)', async () => {
    await setUserSettings({ personaOptIn: true })
    await setUserSettings({ personaOptIn: false })
    expect((await getSettings()).personaOptIn).toBe(false)
  })

  it('⚠ narrows a forged truthy value to false — never opts in by accident', async () => {
    await setUserSettings({ personaOptIn: 'yes' as unknown as boolean })
    expect((await getSettings()).personaOptIn).toBe(false)
  })
})
