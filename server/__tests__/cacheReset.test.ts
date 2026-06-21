import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VERSION_MARKER_FILE,
  CHROMIUM_CACHE_DIRS,
  readLastVersion,
  writeLastVersion,
  clearChromiumCaches,
  maybeResetCachesOnVersionChange,
} from '../../electron/cacheReset'

// Tests for the white-screen-after-reinstall self-heal (electron/cacheReset.js).
//
// The shipped behaviour: electron/main.js persists app.getVersion() into the
// user-data dir and, on the next launch, clears ONLY the regenerable Chromium
// caches when the version changed (update/reinstall) — never localStorage /
// IndexedDB / cookies / login state. We prove the decision logic, that a same-
// version relaunch is a no-op, and — the load-bearing safety property — that a
// clear deletes the caches while leaving every user-state directory intact.
//
// Everything targets a throwaway tmp dir; nothing here touches the real
// ~/Library/Application Support/openground. The module requires only fs+path
// (no electron), so it runs in the plain node test environment.

let userData: string

// Create `<userData>/<name>/marker.bin` so a directory exists with real content,
// letting us assert it was (or was not) recursively removed.
function seedDir(name: string): string {
  const dir = join(userData, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'marker.bin'), 'x')
  return dir
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'og-cachereset-'))
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('cacheReset — allowlist is caches only, never user state', () => {
  it('lists the four directories the spec names, and none that hold user state', () => {
    for (const required of ['Cache', 'Code Cache', 'GPUCache', 'DawnWebGPUCache']) {
      expect(CHROMIUM_CACHE_DIRS).toContain(required)
    }
    // These hold login / session / app state and must NEVER be in the delete list.
    for (const forbidden of [
      'Local Storage',
      'IndexedDB',
      'Cookies',
      'Session Storage',
      'Local State',
      'Network',
      'Service Worker',
    ]) {
      expect(CHROMIUM_CACHE_DIRS).not.toContain(forbidden)
    }
  })
})

describe('cacheReset — version marker round-trip', () => {
  it('readLastVersion returns null when no marker exists', () => {
    expect(readLastVersion(userData)).toBeNull()
  })

  it('writeLastVersion persists a version that readLastVersion reads back', () => {
    expect(writeLastVersion(userData, '0.10.1')).toBe(true)
    expect(existsSync(join(userData, VERSION_MARKER_FILE))).toBe(true)
    expect(readLastVersion(userData)).toBe('0.10.1')
  })

  it('writeLastVersion creates the user-data dir if it does not exist yet', () => {
    const fresh = join(userData, 'nested', 'profile')
    expect(writeLastVersion(fresh, '1.2.3')).toBe(true)
    expect(readLastVersion(fresh)).toBe('1.2.3')
  })

  it('readLastVersion returns null for a corrupt marker', () => {
    writeFileSync(join(userData, VERSION_MARKER_FILE), 'not json {{{')
    expect(readLastVersion(userData)).toBeNull()
  })
})

describe('cacheReset — clearChromiumCaches deletes caches, preserves the rest', () => {
  it('removes only the allowlisted cache dirs and leaves user-state dirs intact', () => {
    // Caches that should be wiped.
    seedDir('Cache')
    seedDir('Code Cache')
    seedDir('GPUCache')
    seedDir('DawnWebGPUCache')
    // User state that must survive (the login/session-bearing directories).
    seedDir('Local Storage')
    seedDir('IndexedDB')
    seedDir('Cookies')
    seedDir('Service Worker')
    seedDir('Network')

    const { cleared, failed } = clearChromiumCaches(userData)

    expect(failed).toEqual([])
    expect(cleared.sort()).toEqual(
      ['Cache', 'Code Cache', 'DawnWebGPUCache', 'GPUCache'].sort(),
    )
    // Caches gone.
    expect(existsSync(join(userData, 'Cache'))).toBe(false)
    expect(existsSync(join(userData, 'Code Cache'))).toBe(false)
    expect(existsSync(join(userData, 'GPUCache'))).toBe(false)
    expect(existsSync(join(userData, 'DawnWebGPUCache'))).toBe(false)
    // User state preserved.
    expect(existsSync(join(userData, 'Local Storage', 'marker.bin'))).toBe(true)
    expect(existsSync(join(userData, 'IndexedDB', 'marker.bin'))).toBe(true)
    expect(existsSync(join(userData, 'Cookies', 'marker.bin'))).toBe(true)
    expect(existsSync(join(userData, 'Service Worker', 'marker.bin'))).toBe(true)
    expect(existsSync(join(userData, 'Network', 'marker.bin'))).toBe(true)
  })

  it('skips absent cache dirs without throwing (only reports what existed)', () => {
    seedDir('Cache') // the only one present
    const { cleared, failed } = clearChromiumCaches(userData)
    expect(cleared).toEqual(['Cache'])
    expect(failed).toEqual([])
  })
})

describe('cacheReset — maybeResetCachesOnVersionChange', () => {
  it('same version → no clear, caches and marker untouched (fast path)', () => {
    writeLastVersion(userData, '0.10.1')
    seedDir('Cache')
    seedDir('Code Cache')

    const result = maybeResetCachesOnVersionChange({
      userDataPath: userData,
      currentVersion: '0.10.1',
    })

    expect(result.changed).toBe(false)
    expect(result.cleared).toEqual([])
    // Caches still there — a normal relaunch must not pay the clear cost.
    expect(existsSync(join(userData, 'Cache'))).toBe(true)
    expect(existsSync(join(userData, 'Code Cache'))).toBe(true)
    expect(readLastVersion(userData)).toBe('0.10.1')
  })

  it('version change → clears caches, keeps login state, records new version', () => {
    writeLastVersion(userData, '0.10.1')
    seedDir('Cache')
    seedDir('Code Cache')
    seedDir('Local Storage')
    seedDir('IndexedDB')

    const result = maybeResetCachesOnVersionChange({
      userDataPath: userData,
      currentVersion: '0.11.0',
    })

    expect(result.changed).toBe(true)
    expect(result.previousVersion).toBe('0.10.1')
    expect(result.cleared.sort()).toEqual(['Cache', 'Code Cache'].sort())
    expect(existsSync(join(userData, 'Cache'))).toBe(false)
    expect(existsSync(join(userData, 'Code Cache'))).toBe(false)
    // Login/session state survives the update.
    expect(existsSync(join(userData, 'Local Storage', 'marker.bin'))).toBe(true)
    expect(existsSync(join(userData, 'IndexedDB', 'marker.bin'))).toBe(true)
    // Marker advanced so the NEXT same-version launch is a no-op.
    expect(readLastVersion(userData)).toBe('0.11.0')
  })

  it('first run (no marker) is treated as a change and records the version', () => {
    // No cache dirs exist (truly fresh install) → clearing is a harmless no-op,
    // but we still write the marker so subsequent launches take the fast path.
    const result = maybeResetCachesOnVersionChange({
      userDataPath: userData,
      currentVersion: '0.11.0',
    })

    expect(result.changed).toBe(true)
    expect(result.previousVersion).toBeNull()
    expect(result.cleared).toEqual([])
    expect(readLastVersion(userData)).toBe('0.11.0')
  })

  it('first run WITH a stale cache (upgrade into the fix) heals it', () => {
    // The user updates from a pre-fix version (no marker) and carries a corrupt
    // cache forward: the absent marker must force a clear.
    seedDir('Cache')
    seedDir('Code Cache')
    seedDir('Local Storage')

    const result = maybeResetCachesOnVersionChange({
      userDataPath: userData,
      currentVersion: '0.11.0',
    })

    expect(result.changed).toBe(true)
    expect(result.cleared.sort()).toEqual(['Cache', 'Code Cache'].sort())
    expect(existsSync(join(userData, 'Cache'))).toBe(false)
    expect(existsSync(join(userData, 'Local Storage', 'marker.bin'))).toBe(true)
    expect(readLastVersion(userData)).toBe('0.11.0')
  })

  it('emits a single summary log line only when it clears', () => {
    writeLastVersion(userData, '0.10.1')
    const lines: string[] = []
    const log = (m: string) => lines.push(m)

    // Same version: silent.
    maybeResetCachesOnVersionChange({ userDataPath: userData, currentVersion: '0.10.1', log })
    expect(lines).toEqual([])

    // Changed version: one line.
    maybeResetCachesOnVersionChange({ userDataPath: userData, currentVersion: '0.11.0', log })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('0.10.1')
    expect(lines[0]).toContain('0.11.0')
  })

  it('does not leave the marker inside any directory it deletes', () => {
    // Guards against a regression where the marker lands in a cache dir and gets
    // wiped — it must sit at the user-data root.
    writeLastVersion(userData, '0.10.1')
    maybeResetCachesOnVersionChange({ userDataPath: userData, currentVersion: '0.11.0' })
    const markerRaw = readFileSync(join(userData, VERSION_MARKER_FILE), 'utf8')
    expect(markerRaw).toContain('0.11.0')
  })
})
