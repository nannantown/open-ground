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
// the binary can be invoked.
//
// RESOLUTION ORDER (the install-while-running trap): the server process's
// PATH is a snapshot from app boot, but the onboarding flow's whole point is
// installing claude WHILE the app runs — the new binary (and any PATH line
// the installer appended to the user's shell profile) is invisible to a bare
// execFile('claude') until the next app launch, even though every PTY
// (a fresh login shell) sees it immediately. So when the direct lookup
// misses, re-resolve through a fresh login shell (the same source of truth a
// real run uses), then fall back to the well-known install targets.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { join } from 'path'

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

// argv for "resolve claude through a fresh login shell". zsh gets -i too so
// PATH lines a user (or an installer) appended to .zshrc — not just .zprofile
// — are honoured; bash/other POSIX shells read their profile with -l alone
// (interactive bash can block on rc prompts, so no -i there). Exported for
// unit tests.
export const loginShellArgv = (shell: string): [string, string[]] => {
  const args = shell.endsWith('zsh') ? ['-lic'] : ['-lc']
  return [shell, [...args, 'command -v claude']]
}

// Well-known install targets, tried last (no shell involved): the official
// install.sh (~/.local/bin), claude's migrate-installer location, Homebrew on
// Apple Silicon and Intel (the latter doubles as the default npm prefix).
// Exported for unit tests.
export const knownClaudeLocations = (): string[] => [
  join(homedir(), '.local', 'bin', 'claude'),
  join(homedir(), '.claude', 'local', 'claude'),
  '/opt/homebrew/bin/claude',
  '/usr/local/bin/claude',
]

// `command -v` output can ride along profile noise (echoes, motd) — the
// binary path is the last non-empty line that looks like an absolute path.
// Exported for unit tests.
export const pathFromShellOutput = (stdout: string): string | null => {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith('/')) return lines[i]
  }
  return null
}

const versionOf = async (bin: string): Promise<string | null> => {
  const { stdout } = await execFile(bin, ['--version'], { timeout: 5000 })
  return stdout.trim() || null
}

export const probeClaudeCli = async (force = false): Promise<ClaudeProbe> => {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.probe
  }
  let version: string | null = null
  let installed = false
  // 1) The explicit override (E2E stub) or the bare name on the server's own
  //    PATH — exactly what the old probe did.
  try {
    version = await versionOf(process.env.OPENGROUND_CLAUDE_BIN || 'claude')
    installed = true
  } catch {
    /* fall through to the fresh-PATH paths below */
  }
  // 2) A fresh login shell. This is what every PTY run actually resolves
  //    against, so it sees an install that happened after app boot. Skipped
  //    when the explicit override is set (tests pin the binary).
  if (!installed && !process.env.OPENGROUND_CLAUDE_BIN) {
    try {
      const [shell, args] = loginShellArgv(process.env.SHELL || '/bin/zsh')
      const { stdout } = await execFile(shell, args, { timeout: 8000 })
      const bin = pathFromShellOutput(stdout)
      if (bin) {
        version = await versionOf(bin)
        installed = true
      }
    } catch {
      /* shell missing / profile error / timeout — try absolute paths */
    }
  }
  // 3) Well-known absolute install targets (no shell dependency at all).
  if (!installed && !process.env.OPENGROUND_CLAUDE_BIN) {
    for (const bin of knownClaudeLocations()) {
      try {
        version = await versionOf(bin)
        installed = true
        break
      } catch {
        /* not here — next candidate */
      }
    }
  }
  const probe: ClaudeProbe = installed
    ? {
        installed: true,
        version,
        message: version ? `claude CLI detected (${version}).` : 'claude CLI detected.',
      }
    : { installed: false, version: null, message: MISSING_MESSAGE }
  cached = { at: Date.now(), probe }
  return probe
}
