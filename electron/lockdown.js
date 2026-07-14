// electron/lockdown.js — work mode (業務モード) probe for the Electron MAIN
// process, factored out of main.js so it is unit-testable WITHOUT an Electron
// runtime (the same plain-CJS split as autoUpdate.js / forkEnv.js / startup.js).
//
// WHY THE MAIN PROCESS NEEDS ITS OWN PROBE. The lockdown switch lives in
// ~/.openground/settings.json and is ENFORCED inside the forked Hono server
// (route gates + a global-fetch floor, src/lib/server/lockdown.ts) — but
// electron-updater runs in the MAIN process, a different process the server's
// floor cannot reach. So main.js re-reads the same settings.json here, right
// before every update check (the initial one and each 4-hour tick), and skips
// the check while the switch is on. Reading per-check (not once at boot) is
// what makes the toggle live: flipping it in Settings takes effect at the next
// tick with no app restart, in both directions.
//
// FAIL DIRECTION. A missing / unreadable / hand-corrupted settings.json reads
// as OFF — the same default the server resolves (store.ts getSettings falls
// back to defaults), so the two processes can never disagree about a broken
// file. Lockdown is a deliberate opt-in; only an explicit `"lockdownMode": true`
// suppresses the update check.

'use strict'

const { readFileSync } = require('fs')
const { homedir } = require('os')
const { join } = require('path')

/**
 * The settings.json path — the same resolution as src/lib/server/paths.ts
 * (OPENGROUND_HOME override for tests / isolated homes, else ~/.openground).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function settingsFilePath(env = process.env) {
  const home = env.OPENGROUND_HOME || join(homedir(), '.openground')
  return join(home, 'settings.json')
}

/**
 * Pure decision: does this settings.json CONTENT say lockdown is on?
 * Only a literal `true` counts (the server stores the switch as a real
 * boolean); any parse error / other shape / other value is OFF.
 * @param {string | null | undefined} raw settings.json content
 * @returns {boolean}
 */
function lockdownFromSettingsRaw(raw) {
  if (typeof raw !== 'string' || raw === '') return false
  try {
    const parsed = JSON.parse(raw)
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed.lockdownMode === true
      : false
  } catch {
    return false
  }
}

/**
 * Is work mode (lockdown) on right now? Fresh disk read per call — see the
 * header for why per-check freshness is the point.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
function isLockdownEnabled(env = process.env) {
  let raw
  try {
    raw = readFileSync(settingsFilePath(env), 'utf8')
  } catch {
    return false
  }
  return lockdownFromSettingsRaw(raw)
}

// ---------------------------------------------------------------------------
// Renderer egress allowlist (the webRequest guard in main.js).
//
// The server's fetch floor only covers the SERVER process; requests issued by
// the RENDERER (the SPA window and every iframe in it — Canvas mocks, custom
// marketplace tabs) leave through Chromium's network stack, which only the
// main process can filter (session.webRequest). While lockdown is ON, a
// renderer request may reach: the app itself (loopback — API/SSE/fonts/HMR),
// local/synthetic schemes, and Anthropic (the product's reason to exist —
// e.g. docs links prefetch; claude itself is a child process, not the
// renderer, but the same allowlist keeps the two floors identical). Anything
// else — Google Fonts, unpkg, a marketplace module phoning home — is
// cancelled.
// ---------------------------------------------------------------------------

/** Non-network schemes a renderer legitimately uses. devtools/chrome cover
 *  DevTools-internal fetches so opening the inspector under lockdown does not
 *  degrade it. */
const LOCKDOWN_ALLOWED_SCHEMES = new Set([
  'file:',
  'data:',
  'blob:',
  'about:',
  'devtools:',
  'chrome:',
  'chrome-extension:',
])

/** Suffix-matched Anthropic hosts — the SAME pair the server floor
 *  (src/lib/server/lockdown.ts) and egressProxy.ts allow. */
const LOCKDOWN_ANTHROPIC_HOSTS = ['anthropic.com', 'claude.ai']

const isLoopbackHostname = (host) =>
  // URL.hostname keeps the brackets on IPv6 literals ('[::1]').
  host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1' || host === '0.0.0.0'

/**
 * May this renderer-originated URL proceed while lockdown is ON?
 * Pure — safe to call on every request (no I/O). Unparseable URLs are
 * BLOCKED (fail-closed: lockdown is already known to be on when the verdict
 * matters, and a URL Chromium is about to fetch always parses).
 * @param {string} rawUrl
 * @returns {boolean}
 */
function isRendererUrlAllowedUnderLockdown(rawUrl) {
  let u
  try {
    u = new URL(String(rawUrl))
  } catch {
    return false
  }
  if (LOCKDOWN_ALLOWED_SCHEMES.has(u.protocol)) return true
  if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ws:' || u.protocol === 'wss:') {
    const host = u.hostname
    if (isLoopbackHostname(host)) return true
    return LOCKDOWN_ANTHROPIC_HOSTS.some((s) => host === s || host.endsWith('.' + s))
  }
  return false
}

module.exports = {
  settingsFilePath,
  lockdownFromSettingsRaw,
  isLockdownEnabled,
  isRendererUrlAllowedUnderLockdown,
}
