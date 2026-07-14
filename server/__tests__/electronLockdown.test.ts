import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  settingsFilePath,
  lockdownFromSettingsRaw,
  isLockdownEnabled,
  isRendererUrlAllowedUnderLockdown,
} from '../../electron/lockdown'

// electron/lockdown.js — the MAIN-process work-mode probe main.js consults
// immediately before every electron-updater check (the forked server's fetch
// floor cannot reach the main process, so this is its counterpart). Plain CJS,
// tested here without an Electron runtime — same pattern as autoUpdate.test.ts.

describe('settingsFilePath', () => {
  it('honours OPENGROUND_HOME (the same override src/lib/server/paths.ts uses)', () => {
    expect(settingsFilePath({ OPENGROUND_HOME: '/x/home' } as NodeJS.ProcessEnv)).toBe(
      join('/x/home', 'settings.json'),
    )
  })

  it('falls back to ~/.openground', () => {
    const p = settingsFilePath({} as NodeJS.ProcessEnv)
    expect(p.endsWith(join('.openground', 'settings.json'))).toBe(true)
  })
})

describe('lockdownFromSettingsRaw — pure decision', () => {
  it('only a literal true turns it on', () => {
    expect(lockdownFromSettingsRaw(JSON.stringify({ lockdownMode: true }))).toBe(true)
    expect(lockdownFromSettingsRaw(JSON.stringify({ lockdownMode: false }))).toBe(false)
    expect(lockdownFromSettingsRaw(JSON.stringify({ lockdownMode: 'true' }))).toBe(false)
    expect(lockdownFromSettingsRaw(JSON.stringify({}))).toBe(false)
  })

  it('garbage reads as OFF (the server default for a broken file)', () => {
    expect(lockdownFromSettingsRaw('not json')).toBe(false)
    expect(lockdownFromSettingsRaw(JSON.stringify(['array']))).toBe(false)
    expect(lockdownFromSettingsRaw(JSON.stringify('string'))).toBe(false)
    expect(lockdownFromSettingsRaw('')).toBe(false)
    expect(lockdownFromSettingsRaw(null)).toBe(false)
    expect(lockdownFromSettingsRaw(undefined)).toBe(false)
  })
})

describe('isLockdownEnabled — fresh disk read per call (the live-toggle contract)', () => {
  it('reads the flag, follows edits, and treats a missing file as OFF', () => {
    const home = mkdtempSync(join(tmpdir(), 'og-lockdown-'))
    const env = { OPENGROUND_HOME: home } as NodeJS.ProcessEnv

    // No settings.json yet → OFF.
    expect(isLockdownEnabled(env)).toBe(false)

    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ lockdownMode: true }))
    expect(isLockdownEnabled(env)).toBe(true)

    // The per-check re-read is the point: an edit flips the answer with no
    // restart (main.js calls this before EVERY updater tick).
    writeFileSync(join(home, 'settings.json'), JSON.stringify({ lockdownMode: false }))
    expect(isLockdownEnabled(env)).toBe(false)
  })
})

describe('isRendererUrlAllowedUnderLockdown — the webRequest allowlist', () => {
  it('allows the app itself (loopback), any port and scheme', () => {
    expect(isRendererUrlAllowedUnderLockdown('http://127.0.0.1:47776/api/settings')).toBe(true)
    expect(isRendererUrlAllowedUnderLockdown('http://localhost:5174/src/main.tsx')).toBe(true)
    expect(isRendererUrlAllowedUnderLockdown('ws://127.0.0.1:5174/')).toBe(true) // Vite HMR
    expect(isRendererUrlAllowedUnderLockdown('http://[::1]:47776/api/health')).toBe(true)
  })

  it('allows local/synthetic schemes (file/data/blob/devtools)', () => {
    expect(isRendererUrlAllowedUnderLockdown('file:///Users/x/app/index.html')).toBe(true)
    expect(isRendererUrlAllowedUnderLockdown('data:image/png;base64,AAAA')).toBe(true)
    expect(isRendererUrlAllowedUnderLockdown('blob:http://127.0.0.1:47776/uuid')).toBe(true)
    expect(isRendererUrlAllowedUnderLockdown('devtools://devtools/bundled/root.js')).toBe(true)
  })

  it('allows Anthropic (exact + subdomains), never a lookalike', () => {
    expect(isRendererUrlAllowedUnderLockdown('https://anthropic.com/')).toBe(true)
    expect(isRendererUrlAllowedUnderLockdown('https://api.anthropic.com/v1/messages')).toBe(true)
    expect(isRendererUrlAllowedUnderLockdown('https://claude.ai/settings')).toBe(true)
    expect(isRendererUrlAllowedUnderLockdown('https://evil-anthropic.com/')).toBe(false)
    expect(isRendererUrlAllowedUnderLockdown('https://anthropic.com.evil.io/')).toBe(false)
  })

  it('blocks the audited renderer egress rows: Google Fonts, unpkg, Tailwind CDN, collab WS', () => {
    expect(isRendererUrlAllowedUnderLockdown('https://fonts.googleapis.com/css2?family=Fraunces')).toBe(false)
    expect(isRendererUrlAllowedUnderLockdown('https://fonts.gstatic.com/s/fraunces/x.woff2')).toBe(false)
    expect(isRendererUrlAllowedUnderLockdown('https://unpkg.com/react@18/umd/react.development.js')).toBe(false)
    expect(isRendererUrlAllowedUnderLockdown('https://cdn.tailwindcss.com/')).toBe(false)
    expect(isRendererUrlAllowedUnderLockdown('wss://og-collab.mindbrew.workers.dev/room')).toBe(false)
    expect(isRendererUrlAllowedUnderLockdown('https://lh3.googleusercontent.com/avatar.png')).toBe(false)
  })

  it('fails closed on garbage', () => {
    expect(isRendererUrlAllowedUnderLockdown('not a url')).toBe(false)
    expect(isRendererUrlAllowedUnderLockdown('')).toBe(false)
  })
})
