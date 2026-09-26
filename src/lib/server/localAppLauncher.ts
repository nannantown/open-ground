// Starts the NENE Songs server (serve.js, :8899) for the Songs custom tab, so
// the owner never has to run a shell command when it is down (owner decision
// 2026-09-26: "no terminal work for me").
//
// Security: the endpoint takes NO input. The command is fixed — the Node that
// runs this server, on `<registered project>/serve.js` — and the folder is
// taken only from the project registry (a registered folder holding serve.js,
// songs-data.js and a package.json named "nene-songs"). No shell, no
// client-supplied path or argument, and a minimal child env.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettings } from './store'
import { NENE_ORIGIN } from '../localAppFrame'

export type LocalAppStartFailure = 'not-found' | 'exited' | 'timeout'
export type LocalAppStartResult =
  | { ok: true; already?: boolean }
  | { ok: false; reason: LocalAppStartFailure }

const PROBE_URL = `${NENE_ORIGIN}/songs-data.js`
const START_WAIT_MS = 15_000
const POLL_MS = 300

/** Same "up" definition the tab uses (CustomModuleView): songs-data.js
 *  answers with a 2xx. An error status (another process on :8899, a broken
 *  serve.js) is "down", never "up". */
export const probeNene = async (): Promise<boolean> => {
  try {
    const r = await fetch(PROBE_URL, { method: 'HEAD', signal: AbortSignal.timeout(1000) })
    return r.ok
  } catch {
    return false
  }
}

export const findNeneDir = async (): Promise<string | null> => {
  const { projects = [] } = await getSettings()
  const hit = projects.find((p) => isNene(p.path))
  return hit?.path ?? null
}

// File names alone are not identity: an imported repo could also have a
// serve.js. NENE's package.json names itself "nene-songs".
const isNene = (dir: string): boolean => {
  if (!existsSync(join(dir, 'serve.js')) || !existsSync(join(dir, 'songs-data.js'))) return false
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === 'nene-songs'
  } catch {
    return false
  }
}

// One start at a time: concurrent requests (two open views, a retry click)
// share the same attempt instead of spawning serve.js twice.
let inflight: Promise<LocalAppStartResult> | null = null

export const startNene = (): Promise<LocalAppStartResult> => {
  inflight ??= doStart().finally(() => { inflight = null })
  return inflight
}

const doStart = async (): Promise<LocalAppStartResult> => {
  if (await probeNene()) return { ok: true, already: true }
  const dir = await findNeneDir()
  if (!dir) return { ok: false, reason: 'not-found' }

  let exited = false
  try {
    // process.execPath = real node in dev; the Electron binary in prod, where
    // ELECTRON_RUN_AS_NODE=1 (already in this forked server's env) makes it
    // plain Node. detached + unref: serve.js outlives an app restart so music
    // playing in the tab is not cut.
    const child = spawn(process.execPath, [join(dir, 'serve.js')], {
      cwd: dir,
      detached: true,
      stdio: 'ignore',
      // Minimal env: never hand over the OG server's own (PORT=47776, tokens…).
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
        NENE_PORT: '8899',
        ELECTRON_RUN_AS_NODE: '1',
      },
    })
    child.on('error', () => { exited = true })
    child.on('exit', () => { exited = true })
    child.unref()
  } catch {
    return { ok: false, reason: 'exited' }
  }

  const deadline = Date.now() + START_WAIT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    if (await probeNene()) return { ok: true }
    if (exited) return { ok: false, reason: 'exited' }
  }
  return { ok: false, reason: 'timeout' }
}
