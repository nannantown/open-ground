// electron/cacheReset.js — heal a corrupt Chromium cache after an update/reinstall.
//
// THE PROBLEM THIS SOLVES: when a user reinstalls or updates OPEN GROUND over an
// existing install, the Electron user-data dir (~/Library/Application Support/
// openground) keeps the PREVIOUS install's Chromium caches — the HTTP `Cache`,
// the V8 `Code Cache` (compiled-bytecode cache for JS bundles), and the GPU
// shader caches. If those caches are stale/corrupt relative to the freshly
// installed SPA bundle, the renderer can fail to boot and the window paints
// nothing but the background colour — the "white screen after reinstall" bug.
// (Observed 2026-06-21 on a real machine; moving the `Cache` dirs aside fixed it,
// which is what this does automatically.)
//
// THE FIX: persist the app version into user-data and compare it on every launch.
// When it differs from app.getVersion() (an update, a reinstall over a different
// version, or the first launch of a version that carries this fix) we delete ONLY
// the Chromium cache directories BEFORE the window — and thus the renderer — opens
// them, then record the new version. A normal relaunch (same version) finds the
// marker matching and does nothing, so steady-state startup speed is untouched.
//
// SAFETY — caches only, never user state:
//   - We delete a tight ALLOWLIST of regenerable Chromium cache directories
//     (CHROMIUM_CACHE_DIRS). Everything else — `Local Storage`, `IndexedDB`,
//     `Cookies`, `Session Storage`, `Local State`, `Network`, `Service Worker`,
//     `Preferences` — is left untouched, so login/session state and any app data
//     survive the clear. The login is a Supabase session persisted by the
//     renderer; wiping it would silently sign the user out, which we must not do.
//   - Plain CommonJS that requires ONLY `fs` + `path` (NOT `electron`), so the
//     decision + deletion logic is unit-testable in vitest against a tmp dir
//     (see server/__tests__/cacheReset.test.ts), exactly like electron/runtimeConfig.js.
//     electron/main.js passes the real userData path + app.getVersion() in.

const fs = require('fs')
const path = require('path')

// The marker file under user-data that remembers the version we last launched as.
const VERSION_MARKER_FILE = 'cache-version.json'

// The ONLY directories we ever delete — all are regenerable Chromium caches that
// hold no user state. Names are relative to the user-data dir. We delete whichever
// of these exist; absent ones are simply skipped (different Chromium versions ship
// different subsets — e.g. the Dawn/WebGPU caches are newer).
//
//   Cache             HTTP response cache
//   Code Cache        V8/WASM compiled-bytecode cache (js/ + wasm/) — the prime
//                     suspect for a renderer that won't boot after a bundle swap
//   GPUCache          GPU program/blob cache
//   DawnWebGPUCache   WebGPU (Dawn) pipeline cache
//   DawnGraphiteCache Dawn Graphite backend cache
//   GrShaderCache     Ganesh GPU raster shader cache
//   ShaderCache       legacy GPU shader cache
//
// NOTE: deliberately NOT included — `Service Worker` (holds registrations, not just
// CacheStorage), `Network` (holds Cookies + transport security), `Local Storage`,
// `IndexedDB`, `Session Storage`. Those can carry login/app state.
const CHROMIUM_CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnWebGPUCache',
  'DawnGraphiteCache',
  'GrShaderCache',
  'ShaderCache',
]

function markerPath(userDataPath) {
  return path.join(userDataPath, VERSION_MARKER_FILE)
}

// Read the version we recorded on the previous launch. Returns null when the
// marker is missing (first launch ever, or first launch of the version that adds
// this fix) or unreadable/corrupt — both cases are treated as "unknown previous
// version", which forces a clear (the conservative, self-healing default).
function readLastVersion(userDataPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(markerPath(userDataPath), 'utf8'))
    return typeof parsed.version === 'string' && parsed.version ? parsed.version : null
  } catch {
    return null
  }
}

// Persist the version we're launching as, so the next launch can compare. Creates
// the user-data dir if needed. Best-effort: a write failure is logged and swallowed
// (it must never block launch) — the only cost is we may re-clear next launch.
function writeLastVersion(userDataPath, version, log = (/** @type {string} */ _message) => {}) {
  try {
    fs.mkdirSync(userDataPath, { recursive: true })
    fs.writeFileSync(
      markerPath(userDataPath),
      JSON.stringify({ version, updatedAt: new Date().toISOString() }, null, 2) + '\n',
    )
    return true
  } catch (err) {
    log(`cache-version marker write failed: ${err && err.message ? err.message : err}`)
    return false
  }
}

// Delete the allowlisted Chromium cache directories that exist under user-data.
// Each removal is isolated in its own try/catch so one failure (a permission
// error, or a race with a cache file being rewritten) never aborts the others and
// never throws out of here. Returns { cleared, failed } for logging/tests.
function clearChromiumCaches(userDataPath) {
  const cleared = []
  const failed = []
  for (const name of CHROMIUM_CACHE_DIRS) {
    const target = path.join(userDataPath, name)
    try {
      if (!fs.existsSync(target)) continue
      fs.rmSync(target, { recursive: true, force: true })
      cleared.push(name)
    } catch (err) {
      failed.push({ name, error: err && err.message ? err.message : String(err) })
    }
  }
  return { cleared, failed }
}

// The orchestrator electron/main.js calls once, in whenReady, BEFORE creating the
// window (so the renderer hasn't opened the HTTP/Code caches yet). If the recorded
// version differs from currentVersion, clear the Chromium caches and record the new
// version; otherwise do nothing. Returns a result describing what happened. Logs a
// single summary line via `log` only when it actually clears — a normal same-version
// launch is silent and does zero filesystem work beyond one small marker read.
function maybeResetCachesOnVersionChange({
  userDataPath,
  currentVersion,
  log = (/** @type {string} */ _message) => {},
}) {
  const previousVersion = readLastVersion(userDataPath)
  if (previousVersion === currentVersion) {
    return { changed: false, previousVersion, cleared: [], failed: [] }
  }

  const { cleared, failed } = clearChromiumCaches(userDataPath)
  writeLastVersion(userDataPath, currentVersion, log)

  log(
    `cleared Chromium caches on version change ${previousVersion || '(first run)'} → ${currentVersion}: ` +
      `[${cleared.join(', ') || 'none'}]` +
      (failed.length ? `; failed [${failed.map((f) => f.name).join(', ')}]` : ''),
  )

  return { changed: true, previousVersion, cleared, failed }
}

module.exports = {
  VERSION_MARKER_FILE,
  CHROMIUM_CACHE_DIRS,
  markerPath,
  readLastVersion,
  writeLastVersion,
  clearChromiumCaches,
  maybeResetCachesOnVersionChange,
}
