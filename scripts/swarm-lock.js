#!/usr/bin/env node
// Cross-process integration lock for commander sessions. The engine no longer
// integrates branches, but manual commanders must still exclude one another.
// Repo-key derivation matches swarmJanitor.ts and openground-swarm-lib.sh.
//
// IMPORTANT — the pid stored in the lock is NOT this script's own pid (a
// one-shot CLI invocation exits immediately, which would make the lock look
// stale the instant it's written). It defaults to `process.ppid` — the
// invoking shell/tmux pane, which stays alive for the whole manual
// integration window — so the lock's liveness probe (`kill -0 <pid>`) reads
// true for as long as that pane is open. Override with --pid=<n> if needed.
//
// Usage:
//   node scripts/swarm-lock.js acquire [--repo=<path>] [--label=<text>] [--pid=<n>] [--stale-ms=<n>]
//   node scripts/swarm-lock.js release [--repo=<path>] [--pid=<n>]
//   node scripts/swarm-lock.js status  [--repo=<path>]
//
// Exit codes: acquire → 0 acquired, 1 held by someone else (alive), 2 error.
//             release → 0 released or already free, 1 held by someone else
//             (not released), 2 error. status → always 0 (prints JSON).

'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const args = process.argv.slice(2)
const cmd = args[0]
const flags = {}
for (const a of args.slice(1)) {
  const m = /^--([^=]+)=(.*)$/.exec(a)
  if (m) flags[m[1]] = m[2]
}

const repoPath = path.resolve(flags.repo || process.cwd())
const DEFAULT_STALE_MS = 10 * 60 * 1000

function openGroundHome() {
  return process.env.OPENGROUND_HOME || path.join(os.homedir(), '.openground')
}

function git(cwd, gitArgs) {
  try {
    return execFileSync('git', gitArgs, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** Mirrors swarmJanitor.ts's swarmRepoKey / swarm-lib.sh's sw_repokey. */
function repoKey(cwd) {
  const commonDir = git(cwd, ['rev-parse', '--git-common-dir'])
  if (commonDir === null) return null
  let abs
  try {
    abs = fs.realpathSync(path.resolve(cwd, commonDir.trim()))
  } catch {
    return null
  }
  const h = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 8)
  const base = path.basename(path.dirname(abs)).replace(/[ /]/g, '_')
  return `${base}-${h}`
}

function lockPathFor(key) {
  return path.join(openGroundHome(), 'swarm', key, 'integration.lock')
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e && e.code !== 'ESRCH'
  }
}

function readLock(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.pid !== 'number' || typeof parsed.acquiredAt !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

function acquire() {
  const key = repoKey(repoPath)
  if (!key) {
    console.error('swarm-lock: not a git repo (or git unavailable):', repoPath)
    return 2
  }
  const lockPath = lockPathFor(key)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })

  const pid = flags.pid ? Number(flags.pid) : process.ppid
  const staleMs = flags['stale-ms'] ? Number(flags['stale-ms']) : DEFAULT_STALE_MS
  const label = flags.label || 'tmux-cli'

  for (let attempt = 0; attempt < 2; attempt++) {
    const holder = { pid, acquiredAt: new Date().toISOString(), label }
    // Write to a private tmp file first, then atomically claim the real path
    // via linkSync (EEXIST if already taken)
    // so the lock file is NEVER observably empty to a concurrent reader (a
    // plain exclusive create-then-write leaves a 0-byte window a competitor
    // could misread as "vanished").
    const tmp = `${lockPath}.tmp-${crypto.randomUUID().slice(0, 8)}-${pid}`
    try {
      fs.writeFileSync(tmp, JSON.stringify(holder), { flag: 'wx' })
      fs.linkSync(tmp, lockPath)
      fs.unlinkSync(tmp)
      console.log(JSON.stringify({ acquired: true, holder }))
      return 0
    } catch (e) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* already gone (unlinked above) or never created */
      }
      if (!e || e.code !== 'EEXIST') {
        console.error('swarm-lock: could not create lock file:', e && e.message)
        return 2
      }
      const existing = readLock(lockPath)
      if (!existing) {
        try {
          fs.unlinkSync(lockPath)
        } catch {
          /* racer already cleared it */
        }
        continue
      }
      const age = Date.now() - Date.parse(existing.acquiredAt)
      const stale = !isPidAlive(existing.pid) || !Number.isFinite(age) || age > staleMs
      if (!stale) {
        console.error(
          `swarm-lock: held by pid ${existing.pid} (${existing.label || '?'}) since ${existing.acquiredAt} — not acquired`,
        )
        console.log(JSON.stringify({ acquired: false, holder: existing }))
        return 1
      }
      try {
        fs.unlinkSync(lockPath)
      } catch {
        /* lost the reclaim race — retry loop tells the real outcome */
      }
      continue
    }
  }

  const existing = readLock(lockPath)
  console.error('swarm-lock: could not acquire (lost the race) — held by', existing)
  console.log(JSON.stringify({ acquired: false, holder: existing }))
  return 1
}

function release() {
  const key = repoKey(repoPath)
  if (!key) {
    console.error('swarm-lock: not a git repo (or git unavailable):', repoPath)
    return 2
  }
  const lockPath = lockPathFor(key)
  const existing = readLock(lockPath)
  if (!existing) {
    console.log(JSON.stringify({ released: true, reason: 'already free' }))
    return 0
  }
  const pid = flags.pid ? Number(flags.pid) : process.ppid
  if (existing.pid !== pid) {
    console.error(
      `swarm-lock: held by pid ${existing.pid} (${existing.label || '?'}), not ours (${pid}) — not released`,
    )
    console.log(JSON.stringify({ released: false, holder: existing }))
    return 1
  }
  try {
    fs.unlinkSync(lockPath)
  } catch {
    /* already gone */
  }
  console.log(JSON.stringify({ released: true }))
  return 0
}

function status() {
  const key = repoKey(repoPath)
  if (!key) {
    console.log(JSON.stringify({ locked: false, reason: 'not a git repo' }))
    return 0
  }
  const existing = readLock(lockPathFor(key))
  if (!existing) {
    console.log(JSON.stringify({ locked: false }))
    return 0
  }
  console.log(JSON.stringify({ locked: true, holder: existing, alive: isPidAlive(existing.pid) }))
  return 0
}

let code
switch (cmd) {
  case 'acquire':
    code = acquire()
    break
  case 'release':
    code = release()
    break
  case 'status':
    code = status()
    break
  default:
    console.error('usage: node scripts/swarm-lock.js <acquire|release|status> [--repo=<path>] [--label=<text>] [--pid=<n>] [--stale-ms=<n>]')
    code = 2
}
process.exit(code)
