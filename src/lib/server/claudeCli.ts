// claudeCli.ts — readiness probe for the local `claude` CLI.
//
// OPEN GROUND is SUBSCRIPTION-ONLY: it drives the user's installed `claude`
// CLI (which bills against their Claude Pro/Max subscription) and NEVER an
// Anthropic API key. So if `claude` isn't installed / not on PATH, every run
// fails — historically with a bare "command not found" buried in the PTY
// scrollback. This module gives the server one cheap, cached way to answer
// "is the claude CLI present?" so the UI can warn the user up-front and the
// run route can reject a run with a clear message instead of a cryptic failure.
//
// PRESENCE ONLY. Authentication is interactive (the CLI prompts in its own
// TTY) and a full first-run wizard is out of scope — this only answers whether
// the binary can be invoked. We resolve PATH the same way an actual run does:
// in packaged Electron the forked server already inherits the resolved
// login-shell PATH (see CLAUDE.md / electron/main.js), so `execFile('claude')`
// here sees exactly what a PTY-spawned run will see.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFile = promisify(execFileCb)

export interface ClaudeProbe {
  installed: boolean
  version: string | null
  /** Human-readable hint surfaced verbatim in Settings / empty-state / errors. */
  message: string
}

// Cache the probe briefly so opening Settings, the empty-state, and starting a
// run don't each spawn `claude --version`. 10s is long enough to dedupe a
// burst of UI checks, short enough that "install claude, click Re-check" feels
// live. A successful detect is cached as well as a miss.
let cached: { at: number; probe: ClaudeProbe } | null = null
const CACHE_MS = 10_000

const MISSING_MESSAGE =
  'The `claude` CLI was not found on this machine. OPEN GROUND drives your ' +
  'local Claude Code CLI (subscription-only — it never uses an Anthropic API ' +
  'key), so install Claude Code and sign in with an active Claude subscription ' +
  'before running a project.'

export const probeClaudeCli = async (force = false): Promise<ClaudeProbe> => {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.probe
  }
  let probe: ClaudeProbe
  try {
    const { stdout } = await execFile('claude', ['--version'], { timeout: 5000 })
    const version = stdout.trim() || null
    probe = {
      installed: true,
      version,
      message: version ? `claude CLI detected (${version}).` : 'claude CLI detected.',
    }
  } catch {
    probe = { installed: false, version: null, message: MISSING_MESSAGE }
  }
  cached = { at: Date.now(), probe }
  return probe
}
