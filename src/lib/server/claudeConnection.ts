// claudeConnection.ts — reliable, cross-platform "is the user's Claude usable?"
//
// Supersedes the old presence-only probe (claudeCli.ts), which was UNIX-centric
// and gave false negatives — `execFile('claude')` without a shell can't run
// claude.cmd on Windows, the login-shell stage defaulted to /bin/zsh (absent on
// Windows), and the well-known paths were all UNIX. So a perfectly-installed
// `claude` showed up as "not found" on Windows (and on nvm/volta Macs).
//
// OPEN GROUND does NOT manage Claude's login — it only REFLECTS it. The single
// source of truth is `claude auth status` (JSON), which answers both questions
// at once: is the CLI runnable (installed) AND is the user signed in (loggedIn).
// We surface that as a passive indicator; we never gate onboarding on it.
//
// CROSS-PLATFORM RESOLUTION: run `claude auth status` the same way a real run
// resolves the binary — through a shell on Windows (so claude.cmd resolves) and
// through a fresh login shell on macOS/Linux (so nvm/volta PATHs are honoured),
// then fall back to the per-OS well-known install targets.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { homedir } from 'os'
import { join } from 'path'
import { resolveViaLoginShell } from './cliResolve'

const execFile = promisify(execFileCb)
const isWindows = process.platform === 'win32'

export interface ClaudeConnection {
  /** The `claude` CLI is present and runnable on this machine. */
  installed: boolean
  /** Signed in to a Claude subscription (only meaningful when installed). */
  loggedIn: boolean
  /** Subscription tier from `claude auth status` (pro/max/team/enterprise), if any. */
  plan: string | null
  /** Account email from `claude auth status`, if signed in. */
  email: string | null
  /** Human-readable one-liner for tooltips / settings. */
  message: string
}

// Cache briefly so a toolbar indicator + Settings + a launch don't each spawn
// `claude auth status`. A signed-in result and a miss are both cached.
let cached: { at: number; conn: ClaudeConnection } | null = null
const CACHE_MS = 10_000

const NOT_INSTALLED_MSG =
  'Claude Code CLI not found. OPEN GROUND runs your local `claude` CLI ' +
  '(subscription-only — never an API key). Install Claude Code, then sign in.'
const NOT_SIGNED_IN_MSG =
  'Claude Code is installed but not signed in. Run `claude` once (or `claude ' +
  'auth login`) and sign in with a paid Claude plan (Pro, Max, Team, Enterprise).'

// Well-known install targets, per OS. macOS/Linux: official install.sh
// (~/.local/bin), claude's migrate-installer dir, and both Homebrew prefixes.
// Windows: npm global prefix (claude.cmd) and the native install dir.
export const knownClaudeLocations = (): string[] => {
  if (isWindows) {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return [
      join(appData, 'npm', 'claude.cmd'),
      join(homedir(), '.local', 'bin', 'claude.exe'),
      join(localAppData, 'Programs', 'claude', 'claude.exe'),
    ]
  }
  return [
    join(homedir(), '.local', 'bin', 'claude'),
    join(homedir(), '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]
}

// Extract the JSON object from `claude auth status` output. We run claude
// DIRECTLY (no login shell — see authStatusOf), so stdout is normally just the
// JSON; this match is a defensive grab in case claude ever prints a stray
// surrounding line. `auth status` emits a single object. Returns it, or null.
const parseAuthStatus = (stdout: string): Record<string, unknown> | null => {
  const m = stdout.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
}

// Run `<bin> auth status` and parse it. shell:true on Windows so a `claude.cmd`
// shim (or a bare name on PATH) actually executes. Returns null on any failure
// (not installed / not runnable / unparseable).
const authStatusOf = async (bin: string): Promise<Record<string, unknown> | null> => {
  try {
    const { stdout } = await execFile(bin, ['auth', 'status'], {
      timeout: 6000,
      shell: isWindows,
    })
    return parseAuthStatus(stdout)
  } catch {
    return null
  }
}

// Resolve a claude binary path the OS-native way when the server's PATH snapshot
// missed it: a fresh login shell on POSIX (honours nvm/volta), `where` on Windows.
const resolveClaudeBin = async (): Promise<string | null> => {
  if (isWindows) {
    try {
      const { stdout } = await execFile('where', ['claude'], { timeout: 6000 })
      const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
      return first || null
    } catch {
      return null
    }
  }
  const map = await resolveViaLoginShell(['claude'])
  return map.claude ?? null
}

const build = (json: Record<string, unknown> | null): ClaudeConnection => {
  if (!json) {
    return { installed: false, loggedIn: false, plan: null, email: null, message: NOT_INSTALLED_MSG }
  }
  const loggedIn = json.loggedIn === true
  const plan = typeof json.subscriptionType === 'string' ? json.subscriptionType : null
  const email = typeof json.email === 'string' ? json.email : null
  return {
    installed: true,
    loggedIn,
    plan,
    email,
    message: loggedIn
      ? `Connected${plan ? ` (Claude ${plan})` : ''}${email ? ` — ${email}` : ''}.`
      : NOT_SIGNED_IN_MSG,
  }
}

export const claudeConnection = async (force = false): Promise<ClaudeConnection> => {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.conn

  const override = process.env.OPENGROUND_CLAUDE_BIN
  // 1) Direct: the override (E2E stub) or the bare name on the server's PATH.
  let json = await authStatusOf(override || 'claude')
  // 2) OS-native fresh resolution (login shell / `where`) — catches installs the
  //    boot-time PATH snapshot can't see, and non-standard prefixes (nvm/volta).
  if (!json && !override) {
    const bin = await resolveClaudeBin()
    if (bin) json = await authStatusOf(bin)
  }
  // 3) Well-known absolute install targets (no shell dependency).
  if (!json && !override) {
    for (const bin of knownClaudeLocations()) {
      json = await authStatusOf(bin)
      if (json) break
    }
  }

  const conn = build(json)
  cached = { at: Date.now(), conn }
  return conn
}
