import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setUserSettings, setSettings, getDeskContextCapTokens } from './store'
import { DEFAULT_DESK_CONTEXT_CAP_TOKENS } from '../types'

// Settings.deskContextCapTokens — the resident-desk context cap (2026-09-18).
// Read back through the PRODUCTION reader (getDeskContextCapTokens — what the
// commander spawn and the supply loop call), never "the write returned ok":
// POST /api/settings narrows the body to USER_SETTINGS_KEYS, and a key missing
// from that list is dropped with no error, no log, and a UI that still shows it.
describe('Settings.deskContextCapTokens (setUserSettings → getDeskContextCapTokens)', () => {
  beforeEach(async () => {
    await setSettings({ deskContextCapTokens: undefined })
  })

  it('defaults to 300,000 when never set', async () => {
    expect(DEFAULT_DESK_CONTEXT_CAP_TOKENS).toBe(300_000)
    expect(await getDeskContextCapTokens()).toBe(300_000)
  })

  it('is on the allowlist: a POSTed value reaches the production reader', async () => {
    const applied = await setUserSettings({ deskContextCapTokens: 150_000 })
    expect(applied).toContain('deskContextCapTokens')
    expect(await getDeskContextCapTokens()).toBe(150_000)
  })

  it('0 turns the cap off (and survives as 0, not as the default)', async () => {
    await setUserSettings({ deskContextCapTokens: 0 })
    expect((await getSettings()).deskContextCapTokens).toBe(0)
    expect(await getDeskContextCapTokens()).toBe(0)
  })

  it('stores a fractional value floored', async () => {
    await setUserSettings({ deskContextCapTokens: 250_000.7 })
    expect(await getDeskContextCapTokens()).toBe(250_000)
  })

  it('⚠ refuses garbage — the previous value survives (a forged string cannot disable or skew it)', async () => {
    await setUserSettings({ deskContextCapTokens: 200_000 })
    for (const bad of ['0', 'off', -1, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
      const applied = await setUserSettings({ deskContextCapTokens: bad as unknown as number })
      expect(applied).not.toContain('deskContextCapTokens')
      expect(await getDeskContextCapTokens()).toBe(200_000)
    }
  })

  it('a hand-corrupted settings.json value falls back to the default', async () => {
    await setSettings({ deskContextCapTokens: 'lots' as unknown as number })
    expect(await getDeskContextCapTokens()).toBe(DEFAULT_DESK_CONTEXT_CAP_TOKENS)
  })
})
