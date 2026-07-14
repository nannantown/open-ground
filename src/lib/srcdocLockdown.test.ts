import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import {
  buildMockSrcdoc,
  buildLockdownPlaceholderSrcdoc,
  LOCKDOWN_IFRAME_CSP,
} from './mockSrcdoc'
import { buildScreenSrcdoc } from './screenSrcdoc'

// Work mode (lockdown) — the renderer-side srcdoc layer (docs/SECURITY.md
// §12). The audited egress rows these lock down: unpkg.com +
// cdn.tailwindcss.com inside mock/screen/custom-tab iframes (§1-A #7 / §8-7)
// and the font beacon (§8-8, killed for good by self-hosting). The Electron
// webRequest floor covers the same policy at the network layer; these tests
// pin the DOCUMENT layer, which is what protects plain-browser usage too.

/** Every external host a srcdoc template historically referenced. */
const EXTERNAL = /https?:\/\/(unpkg\.com|cdn\.tailwindcss\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)/

describe('buildMockSrcdoc under lockdown', () => {
  it('react (CDN-backed) → explicit placeholder: zero external refs, CSP, bilingual key text', () => {
    const out = buildMockSrcdoc('function App() { return null }', 'react', 'dark', { lockdown: true })
    expect(out).not.toMatch(EXTERNAL)
    expect(out).toContain(LOCKDOWN_IFRAME_CSP)
    // The placeholder is explicit — never a silent blank frame.
    expect(out).toContain('Blocked by work mode')
    // The user's code must NOT ride along into a frame that can't run it.
    expect(out).not.toContain('function App()')
  })

  it('html (no CDN runtime) keeps rendering, sealed by the CSP', () => {
    const code = '<div id="mine">hello</div>'
    const out = buildMockSrcdoc(code, 'html', 'light', { lockdown: true })
    expect(out).toContain(code) // still renders
    expect(out).toContain(LOCKDOWN_IFRAME_CSP) // but cannot dial out
    expect(out).not.toMatch(EXTERNAL)
  })

  it('OFF (default) is byte-for-byte the pre-lockdown behaviour: CDN runtime, no CSP', () => {
    const out = buildMockSrcdoc('function App() { return null }', 'react', 'light')
    expect(out).toContain('unpkg.com/react@18')
    expect(out).not.toContain('Content-Security-Policy')
    const html = buildMockSrcdoc('<b>x</b>', 'html', 'light')
    expect(html).toContain('<b>x</b>')
    expect(html).not.toContain('Content-Security-Policy')
  })
})

describe('buildScreenSrcdoc under lockdown', () => {
  it('react AND html templates are CDN-backed (Tailwind Play) → both become the placeholder', () => {
    for (const fw of ['react', 'html'] as const) {
      const out = buildScreenSrcdoc('<div>x</div>', fw, 'dark', undefined, { lockdown: true })
      expect(out).not.toMatch(EXTERNAL)
      expect(out).toContain(LOCKDOWN_IFRAME_CSP)
      expect(out).toContain('Blocked by work mode')
      expect(out).not.toContain('<div>x</div>')
    }
  })

  it('OFF keeps the CDN runtime but fonts are SELF-HOSTED (the §8-8 fix is unconditional)', () => {
    const out = buildScreenSrcdoc('<div>x</div>', 'react', 'light')
    expect(out).toContain('cdn.tailwindcss.com') // unchanged CDN runtime while off
    expect(out).toContain('/fonts/fonts.css') // …but never Google Fonts
    expect(out).not.toContain('fonts.googleapis.com')
  })
})

describe('the placeholder itself', () => {
  it('is self-contained for every theme', () => {
    for (const theme of ['light', 'dark', 'auto'] as const) {
      const out = buildLockdownPlaceholderSrcdoc(theme)
      expect(out).not.toMatch(EXTERNAL)
      expect(out).not.toMatch(/https?:\/\//) // NO network reference at all
      expect(out).toContain(LOCKDOWN_IFRAME_CSP)
    }
  })
})

describe('self-hosted fonts (the app shell)', () => {
  const root = resolve(__dirname, '../..')

  it('index.html never dials Google Fonts — it loads /fonts/fonts.css', () => {
    const html = readFileSync(resolve(root, 'index.html'), 'utf8')
    expect(html).not.toContain('fonts.googleapis.com')
    expect(html).not.toContain('fonts.gstatic.com')
    expect(html).toContain('/fonts/fonts.css')
  })

  it('public/fonts/fonts.css exists, references only bundled woff2 files, and they exist', () => {
    const cssPath = resolve(root, 'public/fonts/fonts.css')
    expect(existsSync(cssPath)).toBe(true)
    const css = readFileSync(cssPath, 'utf8')
    expect(css).not.toMatch(/https?:\/\//) // fully local
    const files = Array.from(css.matchAll(/url\(\/fonts\/([^)]+)\)/g), (m) => m[1])
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      expect(existsSync(resolve(root, 'public/fonts', f))).toBe(true)
    }
    // All three families the UI's font tokens reference are present.
    for (const fam of ['Fraunces', 'Instrument Sans', 'JetBrains Mono']) {
      expect(css).toContain(`font-family: '${fam}'`)
    }
  })
})
