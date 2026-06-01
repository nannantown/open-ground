import {
  createTerminal,
  killTerminal,
  writeInput,
  type TerminalInfo,
} from './terminal'

// Launches `claude` interactively inside a PTY hosted by OPEN GROUND.
// This is the post-2026-06-15 replacement for spawning `claude -p` directly:
// because the PTY exposes a real TTY to claude, the session bills against the
// user's Claude subscription rate-limit pool, not the new programmatic credit
// pool. The user types in xterm.js; OPEN GROUND observes the session JSONL
// (~/.claude/projects/<cwd-hyphenated>/<session-id>.jsonl) for state.

export type ClaudePermissionMode =
  | 'plan'
  | 'bypass'
  | 'acceptEdits'
  | 'auto'
  | 'default'

export interface LaunchClaudeOpts {
  cwd: string
  // OPEN GROUND-generated UUID. Used as `--session-id` for fresh runs (the
  // resulting JSONL is named after it, so the observer can locate it
  // deterministically) or as `--resume` target for continuations.
  agentSessionId: string
  // Initial prompt, passed as claude's positional argument so it lands in the
  // input box without any PTY-timing race. Multi-line prompts are supported.
  // Pass empty string for a bare resume where the user will type the next
  // turn themselves.
  initialPrompt?: string
  permissionMode?: ClaudePermissionMode
  // false (default) = fresh session with --session-id <uuid>
  // true            = resume an existing session with --resume <uuid>
  resume?: boolean
  // Optional override of model alias / full name (e.g. 'sonnet', 'opus',
  // 'claude-sonnet-4-6'). Falls through to the CLI default if omitted.
  model?: string
  // Optional display name shown in claude's prompt box / /resume picker.
  name?: string
  cols?: number
  rows?: number
}

export interface ClaudeTerminalRef {
  terminalId: string
  agentSessionId: string
  info: TerminalInfo
}

const isWindows = process.platform === 'win32'

// Single-quote a shell argument for the host shell.
//   - POSIX (zsh/bash): preserve embedded newlines and every byte except `'`,
//     escaped via the standard `'\''` idiom.
//   - PowerShell (Windows default PTY shell, see terminal.ts pickShell): a
//     single-quoted string is literal except `'`, which is escaped by doubling
//     it (`''`). Newlines inside a single-quoted PowerShell string are fine.
// UNTESTED ON WINDOWS — see file footer note. The interactive prompt arg with
// embedded newlines is the riskiest part of the Windows path.
// Exported for unit testing. `platform` is injectable so the test can exercise
// both the POSIX and PowerShell branches on a single host; production always
// passes the real `process.platform` (via the default).
export const shellQuoteArg = (
  s: string,
  platform: NodeJS.Platform = process.platform,
): string =>
  platform === 'win32'
    ? `'${s.replace(/'/g, "''")}'`
    : `'${s.replace(/'/g, "'\\''")}'`

const sq = (s: string): string => shellQuoteArg(s, process.platform)

export const launchClaude = (opts: LaunchClaudeOpts): ClaudeTerminalRef => {
  const info = createTerminal({
    cwd: opts.cwd,
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
    tag: 'claude',
  })

  // Build the argv. Keep order roughly: id flag → mode/options → positional
  // prompt last (some shells/users find that more readable in the scrollback).
  const args: string[] = ['claude']
  if (opts.resume) {
    args.push('--resume', opts.agentSessionId)
  } else {
    args.push('--session-id', opts.agentSessionId)
  }
  if (opts.permissionMode === 'plan') {
    args.push('--permission-mode', 'plan')
  } else if (opts.permissionMode === 'bypass') {
    // The interactive equivalent of the old `--dangerously-skip-permissions`
    // path. Opt-in only — the whole point of the de-`-p` refactor is to let
    // the user approve tools live; bypass mode is for batch/auto-continue
    // flows that explicitly waive that.
    args.push('--dangerously-skip-permissions')
  } else if (opts.permissionMode && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode)
  }
  if (opts.model) args.push('--model', sq(opts.model))
  if (opts.name) args.push('--name', sq(opts.name))
  if (opts.initialPrompt && opts.initialPrompt.length > 0) {
    args.push(sq(opts.initialPrompt))
  }

  // `; exit` so when claude quits (`/quit`, Ctrl-D, finished --print, etc.)
  // the wrapping shell exits too. The PTY then closes and the observer's
  // pty-exit listener fires the cancelled / finished transition.
  //
  // `OPENGROUND_OWNED=1` is a per-command env-var that marks this specific
  // claude invocation as launched by OPEN GROUND. The hook script
  // (scripts/openground-hook.js) inherits it via claude → hook process
  // and uses it as a gate: any claude session started elsewhere on the
  // user's machine (their own shell, another tool) has no such env and
  // the hook no-ops, so OPEN GROUND never records data from unrelated
  // sessions. The variable is scoped to this single command — the shell
  // does NOT export it, so even subsequent commands typed into the same
  // PTY (after claude exits but before `; exit` fires) won't carry it.
  // Mark this specific claude invocation as OPEN GROUND-owned (the hook script
  // gates on OPENGROUND_OWNED) and chain `exit` so the wrapping shell closes
  // when claude quits — the PTY-exit listener is the run-completion signal.
  //
  // The env-prefix syntax is shell-specific:
  //   - POSIX (zsh/bash): `VAR=1 cmd ; exit` — VAR is scoped to that one
  //     command only (the shell does NOT export it), so a later command typed
  //     into the same PTY won't carry it.
  //   - PowerShell (Windows default PTY shell): there is no inline per-command
  //     env syntax, so we set `$env:OPENGROUND_OWNED='1'` as a separate
  //     statement. NOTE: unlike the POSIX form this leaks into the rest of the
  //     PowerShell session — acceptable because the very next statement is the
  //     claude run and then `exit` tears the shell down. UNTESTED ON WINDOWS.
  const cmd = isWindows
    ? `$env:OPENGROUND_OWNED='1'; ` + args.join(' ') + ` ; exit\n`
    : 'OPENGROUND_OWNED=1 ' + args.join(' ') + ' ; exit\n'
  writeInput(info.id, cmd)

  return {
    terminalId: info.id,
    agentSessionId: opts.agentSessionId,
    info,
  }
}

// Type a follow-up prompt into a still-running claude PTY (the user's claude
// session is alive and at the input prompt). Used for resume-in-place where
// we don't want to spin up a new PTY just to add another turn.
export const seedPrompt = (terminalId: string, text: string): boolean => {
  // `\r` is the Enter key in xterm/PTY; Claude's TUI submits on it.
  return writeInput(terminalId, text + '\r')
}

// Send Ctrl-C to a claude PTY — first-press cancel. Claude's TUI handles it
// as a soft interrupt (cancels current generation, leaves the session up).
// For a hard kill, escalate to killTerminal().
export const sendInterrupt = (terminalId: string): boolean => {
  return writeInput(terminalId, '')
}

// Hard-kill the PTY (SIGHUP via node-pty). Second-press cancel or shutdown.
export const forceKill = (terminalId: string): boolean => {
  return killTerminal(terminalId)
}
