import { describe, it, expect } from 'vitest'
// Plain-CJS main-process module (no Electron runtime needed) — same import
// style as updateMenu.test.ts / autoUpdate.test.ts.
import {
  AUTO_APPLY_UNFOCUSED_MIN_MS,
  autoUpdateFromSettingsRaw,
  decideAutoApply,
} from '../../electron/autoUpdatePolicy'

// The hands-free apply decision (electron/autoUpdatePolicy.js). Every input is
// supplied by main.js; this pins the FAIL-CLOSED shape: any missing/negative
// condition defers, and only the full conjunction applies. A flipped branch
// here is an unattended restart on top of running work — the exact incident
// class the shipped dialog design existed to prevent.

const base = {
  enabled: true,
  lockdown: false,
  hasDownloaded: true,
  unfocusedMs: AUTO_APPLY_UNFOCUSED_MIN_MS,
  safety: { safe: true, generating: 0, userPtys: 0 },
}

describe('autoUpdateFromSettingsRaw', () => {
  it('only a literal true enables', () => {
    expect(autoUpdateFromSettingsRaw(JSON.stringify({ autoUpdate: true }))).toBe(true)
    expect(autoUpdateFromSettingsRaw(JSON.stringify({ autoUpdate: 'true' }))).toBe(false)
    expect(autoUpdateFromSettingsRaw(JSON.stringify({ autoUpdate: 1 }))).toBe(false)
    expect(autoUpdateFromSettingsRaw(JSON.stringify({}))).toBe(false)
  })
  it('corrupt json reads as OFF (fail closed)', () => {
    expect(autoUpdateFromSettingsRaw('{not json')).toBe(false)
  })
})

describe('decideAutoApply', () => {
  it('applies only on the full conjunction', () => {
    expect(decideAutoApply(base).apply).toBe(true)
  })
  it('defers when the toggle is off', () => {
    expect(decideAutoApply({ ...base, enabled: false }).apply).toBe(false)
  })
  it('defers under work mode (lockdown)', () => {
    expect(decideAutoApply({ ...base, lockdown: true }).apply).toBe(false)
  })
  it('defers with nothing downloaded', () => {
    expect(decideAutoApply({ ...base, hasDownloaded: false }).apply).toBe(false)
  })
  it('defers while the user is (recently) at the window', () => {
    expect(decideAutoApply({ ...base, unfocusedMs: 0 }).apply).toBe(false)
    expect(decideAutoApply({ ...base, unfocusedMs: AUTO_APPLY_UNFOCUSED_MIN_MS - 1 }).apply).toBe(false)
  })
  it('defers when the safety probe is unreachable (fail closed)', () => {
    expect(decideAutoApply({ ...base, safety: null }).apply).toBe(false)
  })
  it('defers when the server reports busy', () => {
    expect(
      decideAutoApply({ ...base, safety: { safe: false, generating: 1, userPtys: 0 } }).apply,
    ).toBe(false)
  })
})
