// electron/updaterLog.js — the auto-updater's MEMORY, factored out of
// electron/main.js so it is unit-testable WITHOUT an Electron runtime
// (server/__tests__/updaterLog.test.ts) — the same plain-CJS split as
// electron/autoUpdate.js / cacheReset.js / lockdown.js.
//
// ⚠ THE HOLE THIS CLOSES (owner, 2026-09-13, third sighting of "the update did
// not apply"). The owner pressed "Restart now", the app quit, and it came back
// as the OLD version. Nothing on disk said why: every updater line — ours and
// electron-updater's — went to a packaged app's stdout, which nobody can read,
// and the OS installer's own log (ShipIt) had no entry at all, which only told
// us where the failure was NOT. Three releases of updater fixes were diagnosed
// by reading source and guessing. That is not acceptable for the one path that
// delivers every other fix.
//
// Two mechanisms, both dumb on purpose:
//   1. A FILE LOG (~/.openground/updater.log): every updater line, ours and
//      electron-updater's (via `autoUpdater.logger`), and the OS installer's
//      error events, appended with a timestamp and capped in size. Whatever
//      happens next time, the answer is in one file the owner can hand over.
//   2. A PENDING-INSTALL MARKER (~/.openground/update-pending.json): written
//      immediately before the install call ("quitting to install X, from Y").
//      On the next boot the app compares itself against it: came back as X ⇒
//      installed, marker cleared silently; came back as Y ⇒ the install FAILED
//      — say so, with the log's tail, instead of showing the same "downloaded"
//      dialog again as if nothing had happened. The app cannot watch the OS
//      installer work (it is gone by then); it CAN notice, on waking, that
//      nothing changed.

'use strict'

const { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, mkdirSync, unlinkSync } = require('fs')
const { join, dirname } = require('path')
// The app home is derived THROUGH lockdown.js's settingsFilePath, never resolved
// here: the repo allows exactly one `homedir() + '.openground'` resolver per
// runtime (docs/commander/07-test-isolation-contract.md §3 — the guard in
// src/testHomeEnvGuard.test.ts counts them), because a second copy is a second
// place a test process could reach the owner's REAL home. A new one was caught
// by that guard on 2026-09-13, which is the guard doing its job.
const { settingsFilePath } = require('./lockdown')

/** Keep the log this small; when it grows past this, the OLDER half is dropped. */
const UPDATER_LOG_MAX_BYTES = 512 * 1024

/** The app home — the directory lockdown.js resolves settings.json into
 *  (OPENGROUND_HOME override for tests and isolated homes, else ~/.openground). */
function updaterHome(env = process.env) {
  return dirname(settingsFilePath(env))
}

function updaterLogPath(env = process.env) {
  return join(updaterHome(env), 'updater.log')
}

function pendingInstallPath(env = process.env) {
  return join(updaterHome(env), 'update-pending.json')
}

/** Format like console does: strings verbatim, Errors by message, the rest JSON. */
function formatArgs(args) {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return a.message || String(a)
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

/**
 * Append one line to the updater log, capping its size. Never throws — a log
 * that cannot be written must never take the updater (or the app) down.
 * @param {string} line
 * @param {{ path: string, now?: number, maxBytes?: number }} opts
 * @returns {boolean} true when the line was written
 */
function appendUpdaterLog(line, opts) {
  const path = opts.path
  const now = opts.now ?? Date.now()
  const maxBytes = opts.maxBytes ?? UPDATER_LOG_MAX_BYTES
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${new Date(now).toISOString()} ${line}\n`, 'utf8')
    let size = 0
    try {
      size = statSync(path).size
    } catch {
      return true
    }
    if (size > maxBytes) {
      // Drop the older half, on a line boundary, so the file never grows without
      // bound and the newest lines — the ones that explain today — always survive.
      const raw = readFileSync(path, 'utf8')
      const cut = raw.indexOf('\n', Math.floor(raw.length / 2))
      writeFileSync(path, cut === -1 ? raw : raw.slice(cut + 1), 'utf8')
    }
    return true
  } catch {
    return false
  }
}

/**
 * A console-shaped logger ({info, warn, error, debug}) that writes to the file
 * AND mirrors to the console (so a Terminal-launched diagnosis still streams).
 * Shaped to satisfy electron-updater's `logger` contract, so its internal lines
 * ("Proxy server for native Squirrel.Mac …", native errors) land in the same file.
 * @param {{ path: string, tag: string, mirror?: boolean, now?: () => number }} opts
 */
function makeUpdaterLogger(opts) {
  const mirror = opts.mirror !== false
  const now = opts.now ?? (() => Date.now())
  const write = (level, args) => {
    const text = formatArgs(args)
    appendUpdaterLog(`${level.padEnd(5)} [${opts.tag}] ${text}`, { path: opts.path, now: now() })
    if (mirror) {
      const out = level === 'error' || level === 'warn' ? console.error : console.log
      out(`[${opts.tag}] ${text}`)
    }
  }
  return {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
    debug: (...args) => write('debug', args),
  }
}

/** Last `lines` lines of the log, or '' when unreadable. For the failure dialog. */
function tailUpdaterLog(path, lines = 40) {
  try {
    const raw = readFileSync(path, 'utf8')
    return raw.trimEnd().split('\n').slice(-lines).join('\n')
  } catch {
    return ''
  }
}

/**
 * Record "we are quitting NOW to install `to`, running `from`". Written right
 * before the install call; the next boot reads it (see checkPendingInstall).
 * Never throws — the marker must never keep an install from happening.
 * @param {{ path: string, from: string, to: string, now?: number }} opts
 */
function writePendingInstall(opts) {
  try {
    mkdirSync(dirname(opts.path), { recursive: true })
    writeFileSync(
      opts.path,
      JSON.stringify({ from: opts.from, to: opts.to, at: new Date(opts.now ?? Date.now()).toISOString() }),
      'utf8',
    )
    return true
  } catch {
    return false
  }
}

/** @returns {{ from: string, to: string, at: string } | null} */
function readPendingInstall(path) {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (typeof parsed.from !== 'string' || typeof parsed.to !== 'string') return null
    return { from: parsed.from, to: parsed.to, at: typeof parsed.at === 'string' ? parsed.at : '' }
  } catch {
    return null
  }
}

function clearPendingInstall(path) {
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* a marker we cannot delete is re-read next boot — harmless, it decides the same */
  }
}

/**
 * Pure decision: what does the version we woke up as say about the install we
 * quit for?
 *   'none'      — no marker: an ordinary launch.
 *   'installed' — we are `to`: the install worked.
 *   'failed'    — we are still `from`: the OS installer did not replace the app.
 *   'stale'     — some third version: a hand install in between, nothing to say.
 * @param {{ pending: { from: string, to: string } | null, currentVersion: string }} input
 */
function decidePendingInstall(input) {
  const p = input.pending
  if (!p) return 'none'
  if (input.currentVersion === p.to) return 'installed'
  if (input.currentVersion === p.from) return 'failed'
  return 'stale'
}

/**
 * Boot-time check: read the marker, decide, clear it (in every case — a marker
 * is a statement about ONE quit, never carried into a second).
 * @param {{ path: string, currentVersion: string }} opts
 * @returns {{ kind: 'none'|'installed'|'failed'|'stale', from?: string, to?: string, at?: string }}
 */
function checkPendingInstall(opts) {
  const pending = readPendingInstall(opts.path)
  const kind = decidePendingInstall({ pending, currentVersion: opts.currentVersion })
  if (pending) clearPendingInstall(opts.path)
  return pending ? { kind, from: pending.from, to: pending.to, at: pending.at } : { kind }
}

module.exports = {
  UPDATER_LOG_MAX_BYTES,
  updaterHome,
  updaterLogPath,
  pendingInstallPath,
  formatArgs,
  appendUpdaterLog,
  makeUpdaterLogger,
  tailUpdaterLog,
  writePendingInstall,
  readPendingInstall,
  clearPendingInstall,
  decidePendingInstall,
  checkPendingInstall,
}
