import { mkdtempSync, writeFileSync, rm } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createTerminal,
  killTerminal,
  writeInput,
  type TerminalInfo,
} from './terminal'
import { ensureClaudeFolderTrusted } from './claudeTrust'
import { CLAUDE_EFFORTS, type ClaudeEffort, type ProjectLaunchPrefs } from '../types'

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
  // Optional effort level (`--effort`). Falls through to the CLI default if
  // omitted. Callers validate against CLAUDE_EFFORTS — this layer just quotes.
  effort?: string
  // Optional display name shown in claude's prompt box / /resume picker.
  name?: string
  // Absolute extra directory (or directories — the flag is variadic) to grant
  // the spawned claude read access to via `--add-dir` — the project's CENTRAL
  // data dirs (worktrees, task-assets). Per-project attachments and
  // screenshots live outside the repo (~/.openground/projects/<uuid>/), so a
  // non-bypass (plan) run, whose cwd is the repo, needs this to Read them.
  addDir?: string | string[]
  // App-context system prompt (default ON): teach the spawned claude that this
  // cwd is an OPEN GROUND project and how to talk to the app (board API etc.)
  // via --append-system-prompt. Set false for utility sessions whose output is
  // marker-scraped and must not drift (generateDescription).
  appContext?: boolean
  cols?: number
  rows?: number
}

// The OPEN GROUND usage card injected into every app-launched claude session.
// Kept SHORT (it rides every turn of the session as system prompt) and very
// concrete: the #1 failure it prevents is claude "tracking tasks" in its own
// internal todo list while the user stares at an empty Board.
export const buildAppContextPrompt = (cwd: string, port: number): string => {
  const api = `http://127.0.0.1:${port}`
  return [
    '# OPEN GROUND context (auto-injected by the app)',
    'This claude session was launched from OPEN GROUND, a local cockpit app managing this project. The user is looking at the app UI (Board / Canvas / Terminal tabs), not only at this terminal.',
    '',
    `- Project path: ${cwd}`,
    "- The user tracks work on the app's BOARD (kanban). When asked to create/track tasks (e.g. タスク化して), add cards to the Board — NOT to your internal todo list.",
    '- Add board cards (one title per card):',
    `  curl -s -X POST ${api}/api/project/tasks -H 'content-type: application/json' -d '{"path":"${cwd}","add":["Title 1","Title 2"]}'`,
    `- Read the current board: curl -s "${api}/api/project?path=${encodeURIComponent(cwd)}"`,
    `- Canvas (design surface) API: ${api}/api/project/canvases?path=…`,
    '- The Board UI auto-refreshes within ~5s of an API write — no further action needed.',
    '- Do NOT hand-create OPEN GROUND data files in the repo; always go through the API. (In a git-shared project the cards also exist as .openground/board/cards/*.json — still prefer the API.)',
  ].join('\n')
}

// Map a project's PERSONAL launch prefs (ProjectLaunchPrefs, stored centrally
// per project) onto LaunchClaudeOpts fields. Pure + exported so the mapping is
// unit-testable without spawning a PTY:
//  - permissionMode: the prefs enum is a subset of ClaudePermissionMode and
//    maps 1:1 ('bypass' → --dangerously-skip-permissions via buildClaudeArgv);
//    anything missing/unknown falls back to the interactive 'default'.
//  - model: passed through trimmed; empty means "CLI default" (omitted).
//  - effort: only a value the CLI actually accepts (CLAUDE_EFFORTS) passes —
//    legacy/hand-edited junk degrades to "CLI default", never a broken argv.
export const launchOptsFromPrefs = (
  prefs?: ProjectLaunchPrefs | null,
): { permissionMode: ClaudePermissionMode; model?: string; effort?: ClaudeEffort } => {
  const pm = prefs?.permissionMode
  const permissionMode: ClaudePermissionMode =
    pm === 'acceptEdits' || pm === 'plan' || pm === 'bypass' ? pm : 'default'
  const model =
    typeof prefs?.model === 'string' && prefs.model.trim() ? prefs.model.trim() : undefined
  const effort = CLAUDE_EFFORTS.includes(prefs?.effort as ClaudeEffort)
    ? (prefs?.effort as ClaudeEffort)
    : undefined
  return { permissionMode, ...(model ? { model } : {}), ...(effort ? { effort } : {}) }
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

// Assemble the `claude …` argv. Pure + exported so the order/quoting contract
// is unit-tested (claudeTerminal.test.ts) — two ordering bugs here silently
// wedged every run, so a regression guard is load-bearing:
//
//  1. `--add-dir` is VARIADIC (accepts a space-separated list of dirs). Right
//     before the positional prompt it swallows the prompt as another directory
//     — claude starts but never gets a message, idles, writes no session JSONL
//     (run wedges, empty log). So it MUST be followed by another flag: we emit
//     it FIRST, right after `claude`, so `--session-id`/`--resume` bounds it.
//  2. The positional prompt goes LAST, passed as `"$(cat <file>)"` (the caller
//     wrote it to `promptFilePath`), never inline — a long prompt written
//     inline to the PTY exceeds canonical-mode line length (~1KB MAX_CANON on
//     macOS) and gets truncated. Passing a file path keeps the PTY line tiny.
export const buildClaudeArgv = (
  opts: Pick<
    LaunchClaudeOpts,
    'addDir' | 'resume' | 'agentSessionId' | 'permissionMode' | 'model' | 'effort' | 'name'
  >,
  promptFilePath: string | null,
  contextFilePath: string | null = null,
): string[] => {
  // Launch binary seam. Default is the bare `claude` on PATH (unchanged). Tests
  // and the E2E suite set OPENGROUND_CLAUDE_BIN to an absolute stub path so the
  // whole run flow is exercised without the real CLI / a live subscription
  // (the product is subscription-only — there is no `claude` in CI). A custom
  // path is shell-quoted so an absolute path containing spaces (the repo dir is
  // `…/OPEN GROUND`) survives intact in the PTY command line.
  const claudeBin = process.env.OPENGROUND_CLAUDE_BIN
  const args: string[] = [claudeBin ? sq(claudeBin) : 'claude']
  // `--add-dir` is variadic, so multiple dirs ride ONE flag (still bounded by
  // the `--session-id`/`--resume` flag that always follows — see rule 1 above).
  const addDirs = typeof opts.addDir === 'string' ? [opts.addDir] : opts.addDir ?? []
  if (addDirs.length) args.push('--add-dir', ...addDirs.map(sq))
  if (opts.resume) {
    args.push('--resume', opts.agentSessionId)
  } else {
    args.push('--session-id', opts.agentSessionId)
  }
  if (opts.permissionMode === 'plan') {
    args.push('--permission-mode', 'plan')
  } else if (opts.permissionMode === 'bypass') {
    // The interactive equivalent of the old `--dangerously-skip-permissions`
    // path. Opt-in only — bypass mode is for batch/auto-continue flows that
    // explicitly waive live tool approval.
    args.push('--dangerously-skip-permissions')
  } else if (opts.permissionMode && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode)
  }
  if (opts.model) args.push('--model', sq(opts.model))
  if (opts.effort) args.push('--effort', sq(opts.effort))
  if (opts.name) args.push('--name', sq(opts.name))
  // App-context system prompt — same cat-a-file trick as the positional
  // prompt (an inline multi-line value would blow the PTY's canonical-mode
  // line limit). Placed BEFORE the positional prompt; the flag takes exactly
  // one value, so it can never swallow the prompt the way --add-dir could.
  if (contextFilePath) {
    args.push('--append-system-prompt', `"$(cat ${sq(contextFilePath)})"`)
  }
  if (promptFilePath) args.push(`"$(cat ${sq(promptFilePath)})"`)
  return args
}

export const launchClaude = (opts: LaunchClaudeOpts): ClaudeTerminalRef => {
  // Pre-accept claude's "trust this folder?" gate for this cwd (see
  // claudeTrust.ts). Without it, claude 2.1.167's blocking trust prompt wedges
  // the hidden PTY — the run hangs with an empty log. Best-effort; never throws.
  ensureClaudeFolderTrusted(opts.cwd)

  const info = createTerminal({
    cwd: opts.cwd,
    cols: opts.cols ?? 120,
    rows: opts.rows ?? 32,
    tag: 'claude',
    agentSessionId: opts.agentSessionId,
  })

  // Route the positional prompt through a temp file (see buildClaudeArgv §2):
  // a long prompt written inline to the PTY exceeds canonical-mode line length
  // (~1KB MAX_CANON on macOS) and gets silently truncated, corrupting the
  // invocation. Best-effort cleanup once the shell has had time to `cat` it.
  let promptFilePath: string | null = null
  if (opts.initialPrompt && opts.initialPrompt.length > 0) {
    promptFilePath = join(mkdtempSync(join(tmpdir(), 'openground-prompt-')), 'prompt.txt')
    writeFileSync(promptFilePath, opts.initialPrompt)
    const f = promptFilePath
    setTimeout(() => { rm(f, { force: true }, () => {}) }, 60_000)
  }
  // App context (default ON) — rides --append-system-prompt via the same
  // file trick. The file must outlive the shell's `cat` at launch only.
  let contextFilePath: string | null = null
  if (opts.appContext !== false) {
    const port = Number(process.env.PORT) || 47776
    contextFilePath = join(mkdtempSync(join(tmpdir(), 'openground-ctx-')), 'context.md')
    writeFileSync(contextFilePath, buildAppContextPrompt(opts.cwd, port))
    const f = contextFilePath
    setTimeout(() => { rm(f, { force: true }, () => {}) }, 60_000)
  }
  const args = buildClaudeArgv(opts, promptFilePath, contextFilePath)

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
  return writeInput(terminalId, '\x03')
}

// Hard-kill the PTY (SIGHUP via node-pty). Second-press cancel or shutdown.
export const forceKill = (terminalId: string): boolean => {
  return killTerminal(terminalId)
}
