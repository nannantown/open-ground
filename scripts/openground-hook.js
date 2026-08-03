#!/usr/bin/env node
/* eslint-disable */
// OPEN GROUND's Claude Code hook handler.
//
// Invoked by Claude Code's hook system (configured in ~/.claude/settings.json)
// at SessionStart / Stop / PostToolUse. Reads the hook payload from stdin as
// JSON, writes a status marker to ~/.openground/sessions/<session_id>.json,
// and nudges a running OPEN GROUND server (if any) so its observer engine
// drains the new JSONL events immediately.
//
// This script is deliberately tiny and dependency-free so it can run as
// `node scripts/openground-hook.js <phase>` from a vanilla Node install.
// It must NEVER block Claude: any error is swallowed and `{}` is printed.
//
// Phases (passed as argv[2]):
//   session-start  — write a "running" marker
//   stop           — bump marker, signal turn-complete
//   post-tool-use  — bump marker mtime (heartbeat)

const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')

const PHASE = process.argv[2] || 'unknown'

// Hard gate: only act on claude sessions OPEN GROUND launched itself.
// claudeTerminal.launchClaude prefixes the spawn with `OPENGROUND_OWNED=1`,
// which propagates through claude into this hook process via env inheritance.
// Any other claude session on the machine (the user's own shell, an editor's
// integrated terminal, a different tool) will not have this variable set —
// the hook exits immediately without writing markers or pinging the server.
// Output `{}` on stdout to satisfy Claude Code's hook contract.
if (process.env.OPENGROUND_OWNED !== '1') {
  process.stdout.write('{}')
  process.exit(0)
}

// Read all of stdin synchronously. Hook stdin is small (usually <50 KB).
const readStdinSync = () => {
  try {
    return fs.readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

const sessionsDir = path.join(os.homedir(), '.openground', 'sessions')

const ensureDir = (dir) => {
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
}

const writeMarker = (sessionId, payload) => {
  ensureDir(sessionsDir)
  const file = path.join(sessionsDir, `${sessionId}.json`)
  try {
    let prev = {}
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
    const merged = { ...prev, ...payload, updatedAt: new Date().toISOString() }
    fs.writeFileSync(file, JSON.stringify(merged, null, 2))
  } catch {
    // Best-effort: never block claude on a write failure.
  }
}

const nudgeServer = (sessionId, phase) => {
  // Read OPEN GROUND's current dev-server port. Absent → server not running,
  // skip the nudge silently.
  const portFile = path.join(os.homedir(), '.openground', 'server.port')
  let port
  try { port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10) } catch { return }
  if (!port || Number.isNaN(port)) return

  const data = JSON.stringify({ sid: sessionId, phase })
  const req = http.request({
    hostname: '127.0.0.1',
    port,
    path: '/api/observer/nudge',
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
    // Hooks should never wait long on the server — if the server is busy or
    // unreachable, we drop the nudge. The observer still gets the event via
    // fs.watch when the next JSONL chunk lands.
    timeout: 500,
  })
  req.on('error', () => {})
  req.on('timeout', () => { try { req.destroy() } catch {} })
  req.write(data)
  req.end()
}

const main = () => {
  let input = readStdinSync()
  let payload = {}
  try { payload = JSON.parse(input || '{}') } catch {}

  const sessionId = payload.session_id
  if (!sessionId) {
    process.stdout.write('{}')
    return
  }

  const cwd = payload.cwd
  const transcript = payload.transcript_path

  if (PHASE === 'session-start') {
    writeMarker(sessionId, {
      phase: 'running',
      cwd,
      transcriptPath: transcript,
      startedAt: new Date().toISOString(),
      source: payload.source,
      model: payload.model,
    })
  } else if (PHASE === 'stop') {
    // Note: we intentionally do NOT persist payload.last_assistant_message
    // even though it's available. The observer engine reads the assistant
    // text directly from the JSONL transcript, so OPEN GROUND already has
    // the data — duplicating it into the marker file would add no value
    // and would store the same text twice on disk.
    writeMarker(sessionId, {
      phase: 'turn-complete',
      cwd,
      transcriptPath: transcript,
      stoppedAt: new Date().toISOString(),
    })
    nudgeServer(sessionId, 'stop')
    // Completion chime (settings.soundOnDone, 2026-08-03 — replaces the
    // owner's hand-added `afplay Glass.aiff` Stop hook, which hooksInstall
    // migrates away). Settings are re-read per stop so the toggle/volume in
    // the app apply to the NEXT chime with no hook reinstall. UNATTENDED
    // desks (swarm workers, hidden utility runs — claudeTerminal sets the
    // env) stay silent: a fleet finishing turns is machinery, not a doorbell.
    // Fail-silent like everything else here: no sound is never worth a
    // broken hook contract.
    try {
      if (process.env.OPENGROUND_UNATTENDED !== '1') {
        const s = JSON.parse(
          fs.readFileSync(path.join(os.homedir(), '.openground', 'settings.json'), 'utf8'),
        )
        if (s && s.soundOnDone === true) {
          const rawVol = Number(s.soundOnDoneVolume)
          const vol = Number.isFinite(rawVol) ? Math.min(100, Math.max(0, rawVol)) / 100 : 1
          if (vol > 0) {
            const { spawn } = require('child_process')
            if (process.platform === 'darwin') {
              spawn('afplay', ['-v', String(vol), '/System/Library/Sounds/Glass.aiff'], {
                detached: true,
                stdio: 'ignore',
              }).unref()
            } else if (process.platform === 'win32') {
              // SystemSounds has no volume API — the toggle still governs.
              spawn(
                'powershell',
                ['-NoProfile', '-c', '[System.Media.SystemSounds]::Asterisk.Play()'],
                { detached: true, stdio: 'ignore' },
              ).unref()
            }
          }
        }
      }
    } catch {}
  } else if (PHASE === 'post-tool-use') {
    writeMarker(sessionId, {
      phase: 'tool-used',
      lastToolName: payload.tool_name,
      lastToolAt: new Date().toISOString(),
    })
  }

  // Always print empty JSON so Claude's hook contract is satisfied
  // (the contract is: stdout = JSON or empty, exit 0 = pass).
  process.stdout.write('{}')
}

try {
  main()
} catch {
  // Last-ditch safety. Hooks must not interrupt Claude.
  process.stdout.write('{}')
  process.exit(0)
}
