// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// Regression guard for a MEASURED, SILENT file-descriptor leak.
//
// node-pty's macOS/BSD spawn path opens a kqueue (`int kq = kqueue()` in
// src/unix/pty.cc) to wait for the child's NOTE_EXIT. node-pty <= 1.2.0-beta.13
// never `close()`s it, so EVERY PTY spawned leaks ONE kqueue fd — plus the
// ~6 KB UnixTerminal JS object libuv pins to the un-closed handle. Confirmed by
// lsof (the leaked fds are type KQUEUE) over a create -> kill -> sweep loop:
// the pool's `sessions` Map drains to 0, yet fds climb 1:1 with spawns and are
// NOT reclaimed by GC or by node-pty's own destroy(). Over a long-running
// session that opens/restarts terminals — or an autonomous swarm spawning many
// workers — the process creeps toward EMFILE ("too many open files") and new
// terminals stop spawning. This is exactly the "degrades when left running"
// failure that long-uptime stability is meant to rule out.
//
// 1.2.0-beta.14 adds the missing `close(kq)`. The fix lives in the NATIVE
// source, so the Electron production build (electron-builder install-app-deps
// rebuilds node-pty from source for its ABI) picks it up too — not just the
// prebuilt binary.
//
// We DELIBERATELY keep the floor on the 1.2.x beta line, not stable 1.1.0: the
// 1.2.x spawn-helper/asar handling is why this project is on 1.2.x at all (see
// CLAUDE.md "asar: false" + patches/node-pty+1.2.0-beta.14.patch). Fail loudly
// if anyone pins below the fixed beta and silently reintroduces the leak.

const FLOOR = { major: 1, minor: 2, patch: 0, beta: 14 }

/** True iff `version` is >= 1.2.0-beta.14 (the kqueue-fix floor). Self-contained
 *  so the guard needs no semver dependency / @types. Handles the 1.2.0-beta.N
 *  prerelease line and treats a stable release of the same x.y.z (no `-beta`) as
 *  newer than any of its betas, and any higher major/minor/patch as newer. */
const meetsKqueueFix = (version: string): boolean => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?/.exec(version.trim())
  if (!m) return false
  const major = Number(m[1])
  const minor = Number(m[2])
  const patch = Number(m[3])
  // No `-beta.N` ⇒ a stable build, which outranks every beta of the same x.y.z.
  const beta = m[4] === undefined ? Number.POSITIVE_INFINITY : Number(m[4])
  if (major !== FLOOR.major) return major > FLOOR.major
  if (minor !== FLOOR.minor) return minor > FLOOR.minor
  if (patch !== FLOOR.patch) return patch > FLOOR.patch
  return beta >= FLOOR.beta
}

/** Strip a leading range operator (^ ~ >=) so a caret-pinned range yields its
 *  floor version (`^1.2.0-beta.14` → `1.2.0-beta.14`). */
const rangeFloor = (range: string): string => range.replace(/^[\s^~>=]+/, '')

describe('node-pty version floor (kqueue fd-leak fix)', () => {
  it('comparator: < 1.2.0-beta.14 fails, >= passes (incl. stable / higher lines)', () => {
    // Sanity-check the self-contained comparator so a false PASS can't hide a
    // real downgrade.
    expect(meetsKqueueFix('1.2.0-beta.13')).toBe(false)
    expect(meetsKqueueFix('1.1.0')).toBe(false)
    expect(meetsKqueueFix('1.2.0-beta.14')).toBe(true)
    expect(meetsKqueueFix('1.2.0-beta.20')).toBe(true)
    expect(meetsKqueueFix('1.2.0')).toBe(true)
    expect(meetsKqueueFix('1.3.0')).toBe(true)
    expect(meetsKqueueFix('2.0.0')).toBe(true)
  })

  it('package.json pins node-pty at/above the fix', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const range = pkg.dependencies?.['node-pty']
    expect(range, 'node-pty must be a direct dependency').toBeTruthy()
    expect(
      meetsKqueueFix(rangeFloor(range as string)),
      `node-pty pinned to ${range} is BELOW 1.2.0-beta.14 — that reintroduces the ` +
        `per-PTY kqueue fd leak (src/unix/pty.cc missing close(kq)).`,
    ).toBe(true)
  })

  it('lockfile resolves node-pty at/above the fix', () => {
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string }>
    }
    const resolved = lock.packages?.['node_modules/node-pty']?.version
    expect(resolved, 'node-pty must be present in the lockfile').toBeTruthy()
    expect(
      meetsKqueueFix(resolved as string),
      `lockfile resolves node-pty ${resolved}, below the 1.2.0-beta.14 kqueue fd-leak fix.`,
    ).toBe(true)
  })
})
