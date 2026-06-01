// Child test: this is what the Next standalone server would be in production.
// For the spike we just need to prove node-pty loads in ELECTRON_RUN_AS_NODE
// and that pty.spawn('claude') (or any binary) produces output.

// Spike evidence: also write to ~/.openground-spike.log so a packaged
// (no-console) cold run leaves a verifiable trail proving node-pty loaded +
// claude spawned under hardened runtime.
const _fs = require('fs')
const LOGFILE = require('path').join(process.env.HOME, '.openground-spike.log')
function flog(line) {
  try { _fs.appendFileSync(LOGFILE, new Date().toISOString() + ' ' + line + '\n') } catch {}
}
try { _fs.writeFileSync(LOGFILE, '') } catch {}

flog('[child] starting ELECTRON_RUN_AS_NODE=' + process.env.ELECTRON_RUN_AS_NODE + ' node=' + process.version + ' arch=' + process.arch)
console.log('[child] starting, ELECTRON_RUN_AS_NODE=', process.env.ELECTRON_RUN_AS_NODE)
console.log('[child] node version=', process.version, 'platform=', process.platform, 'arch=', process.arch)
console.log('[child] execPath=', process.execPath)

let pty
try {
  pty = require('node-pty')
  flog('[child] node-pty loaded OK')
  console.log('[child] node-pty loaded successfully')
  if (process.send) process.send({ type: 'ready', detail: 'node-pty loaded' })
} catch (e) {
  flog('[child] FAILED require node-pty: ' + e.message)
  console.error('[child] FAILED to require node-pty:', e.message)
  console.error(e.stack)
  if (process.send) process.send({ type: 'error', message: 'require(node-pty) failed: ' + e.message })
  process.exit(1)
}

// Try a tiny spawn: `echo hello` first (safe, always works if pty works)
try {
  const echoChild = pty.spawn('/bin/echo', ['hello-from-pty'], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  })
  echoChild.onData((d) => {
    flog('[echo-pty] data=' + JSON.stringify(d))
    console.log('[echo-pty]', JSON.stringify(d))
    if (process.send) process.send({ type: 'pty-output', data: d })
  })
  echoChild.onExit(({ exitCode }) => {
    flog('[echo-pty] exited code=' + exitCode)
    console.log('[echo-pty] exited code=', exitCode)
    if (process.send) process.send({ type: 'pty-exit', code: exitCode, which: 'echo' })

    // After echo succeeds, try `claude --version` (if installed)
    setTimeout(() => testClaude(), 500)
  })
} catch (e) {
  console.error('[child] pty.spawn FAILED:', e.message)
  if (process.send) process.send({ type: 'error', message: 'pty.spawn failed: ' + e.message })
}

function testClaude() {
  const claudePath = findClaude()
  if (!claudePath) {
    console.log('[child] claude not found in PATH — skipping claude test')
    if (process.send) process.send({ type: 'pty-output', data: '[claude not found in PATH]\n' })
    setTimeout(() => process.exit(0), 200)
    return
  }
  flog('[child] claude found at ' + claudePath + ' — spawning --version')
  console.log('[child] claude found at:', claudePath, '— testing claude --version')
  const claudeChild = pty.spawn(claudePath, ['--version'], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.env.HOME,
    env: process.env,
  })
  claudeChild.onData((d) => {
    flog('[claude-pty] data=' + JSON.stringify(d))
    console.log('[claude-pty]', JSON.stringify(d))
    if (process.send) process.send({ type: 'pty-output', data: '[claude] ' + d })
  })
  claudeChild.onExit(({ exitCode }) => {
    flog('[claude-pty] exited code=' + exitCode + ' — SPIKE COMPLETE')
    console.log('[claude-pty] exited code=', exitCode)
    if (process.send) process.send({ type: 'pty-exit', code: exitCode, which: 'claude' })
    setTimeout(() => process.exit(0), 200)
  })
}

function findClaude() {
  const { execSync } = require('child_process')
  // Try `which claude` first
  try {
    const p = execSync('command -v claude', { encoding: 'utf8' }).trim()
    if (p) return p
  } catch {}
  // Common install locations
  const fs = require('fs')
  const candidates = [
    process.env.HOME + '/.local/bin/claude',
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    process.env.HOME + '/.npm-global/bin/claude',
  ]
  for (const c of candidates) {
    try { if (fs.statSync(c)) return c } catch {}
  }
  return null
}
