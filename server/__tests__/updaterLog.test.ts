import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  appendUpdaterLog,
  makeUpdaterLogger,
  tailUpdaterLog,
  writePendingInstall,
  readPendingInstall,
  clearPendingInstall,
  decidePendingInstall,
  checkPendingInstall,
  updaterLogPath,
  pendingInstallPath,
  formatArgs,
} from '../../electron/updaterLog'

// ⚠ THE HOLE THIS PINS (owner, 2026-09-13, third sighting). "Restart now" → the
// app quit → it came back on the OLD version, and nothing on disk said why:
// every updater line went to a packaged app's stdout, and the OS installer's
// own log had no entry at all. These tests pin the two things that make the
// NEXT failure diagnosable: the file log survives (and is capped), and the
// pending-install marker turns "came back as the old version" into a stated
// verdict on the next boot.

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'og-updater-log-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('paths follow the app home (OPENGROUND_HOME override, else ~/.openground)', () => {
  it('resolves under OPENGROUND_HOME when set', () => {
    expect(updaterLogPath({ OPENGROUND_HOME: '/x/home' })).toBe(join('/x/home', 'updater.log'))
    expect(pendingInstallPath({ OPENGROUND_HOME: '/x/home' })).toBe(join('/x/home', 'update-pending.json'))
  })
  it('falls back to ~/.openground', () => {
    expect(updaterLogPath({})).toMatch(/\.openground[\\/]updater\.log$/)
  })
})

describe('appendUpdaterLog — the file that survives a packaged launch', () => {
  it('creates the file (and its directory) and timestamps every line', () => {
    const path = join(dir, 'nested', 'updater.log')
    expect(appendUpdaterLog('hello', { path, now: Date.UTC(2026, 8, 13, 1, 2, 3) })).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('2026-09-13T01:02:03.000Z hello\n')
  })

  it('caps the file: past maxBytes the OLDER half is dropped, the newest lines survive', () => {
    const path = join(dir, 'updater.log')
    for (let i = 0; i < 200; i++) appendUpdaterLog(`line ${i} ${'x'.repeat(40)}`, { path, maxBytes: 4096 })
    const raw = readFileSync(path, 'utf8')
    expect(raw.length).toBeLessThanOrEqual(4096 + 200) // one line of slack past the cap
    expect(raw).toContain('line 199 ') // newest kept
    expect(raw).not.toContain('line 0 ') // oldest gone
    expect(raw.startsWith('20')).toBe(true) // cut on a line boundary — starts with a timestamp
  })

  it('never throws when the path cannot be written', () => {
    // A file where the directory should be: mkdir fails, append fails — returns false.
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'not a dir')
    expect(appendUpdaterLog('x', { path: join(blocker, 'updater.log') })).toBe(false)
  })
})

describe('makeUpdaterLogger — console-shaped, so electron-updater can be pointed at it', () => {
  it('writes level + tag + console-style formatting, without mirroring when told not to', () => {
    const path = join(dir, 'updater.log')
    let t = Date.UTC(2026, 8, 13)
    const log = makeUpdaterLogger({ path, tag: 'electron-updater', mirror: false, now: () => (t += 1000) })
    log.info('Proxy server for native Squirrel.Mac is created', { port: 1 })
    log.warn(new Error('No update available, can\'t quit and install'))
    log.error('boom', 42)
    log.debug('fine')
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toMatch(/^2026-09-13T00:00:01\.000Z info {2}\[electron-updater\] Proxy server for native Squirrel\.Mac is created \{"port":1\}$/)
    expect(lines[1]).toContain('warn  [electron-updater] No update available')
    expect(lines[2]).toContain('error [electron-updater] boom 42')
    expect(lines[3]).toContain('debug [electron-updater] fine')
  })

  it('formatArgs: strings verbatim, Errors by message, objects as JSON', () => {
    expect(formatArgs(['a', new Error('b'), { c: 1 }, 2])).toBe('a b {"c":1} 2')
  })
})

describe('tailUpdaterLog', () => {
  it('returns the last N lines, or empty when there is no log', () => {
    const path = join(dir, 'updater.log')
    expect(tailUpdaterLog(path, 5)).toBe('')
    for (let i = 0; i < 10; i++) appendUpdaterLog(`l${i}`, { path })
    const tail = tailUpdaterLog(path, 3).split('\n')
    expect(tail).toHaveLength(3)
    expect(tail[2]).toContain('l9')
    expect(tail[0]).toContain('l7')
  })
})

describe('the pending-install marker — "we quit to install X, running Y"', () => {
  it('round-trips, and a corrupt/foreign file reads as no marker', () => {
    const path = join(dir, 'update-pending.json')
    expect(readPendingInstall(path)).toBeNull()
    expect(writePendingInstall({ path, from: '0.11.108', to: '0.11.110', now: Date.UTC(2026, 8, 13) })).toBe(true)
    expect(readPendingInstall(path)).toEqual({ from: '0.11.108', to: '0.11.110', at: '2026-09-13T00:00:00.000Z' })
    writeFileSync(path, '[1,2]')
    expect(readPendingInstall(path)).toBeNull()
    writeFileSync(path, '{"from":1}')
    expect(readPendingInstall(path)).toBeNull()
    writeFileSync(path, 'not json')
    expect(readPendingInstall(path)).toBeNull()
    clearPendingInstall(path)
    expect(existsSync(path)).toBe(false)
    clearPendingInstall(path) // idempotent
  })

  it('decidePendingInstall: installed / FAILED / stale / none', () => {
    const pending = { from: '0.11.108', to: '0.11.110' }
    expect(decidePendingInstall({ pending: null, currentVersion: '0.11.108' })).toBe('none')
    expect(decidePendingInstall({ pending, currentVersion: '0.11.110' })).toBe('installed')
    // The 2026-09-13 shape: quit to install .110, woke up as .108.
    expect(decidePendingInstall({ pending, currentVersion: '0.11.108' })).toBe('failed')
    // A hand install of something else in between: not the install's failure.
    expect(decidePendingInstall({ pending, currentVersion: '0.11.111' })).toBe('stale')
  })

  it('checkPendingInstall reads, decides, and CLEARS the marker — one quit, one verdict', () => {
    const path = join(dir, 'update-pending.json')
    writePendingInstall({ path, from: '0.11.108', to: '0.11.110' })
    const v = checkPendingInstall({ path, currentVersion: '0.11.108' })
    expect(v.kind).toBe('failed')
    expect(v.from).toBe('0.11.108')
    expect(v.to).toBe('0.11.110')
    // Cleared: the next boot must not report the same failure twice.
    expect(existsSync(path)).toBe(false)
    expect(checkPendingInstall({ path, currentVersion: '0.11.108' })).toEqual({ kind: 'none' })
  })
})
