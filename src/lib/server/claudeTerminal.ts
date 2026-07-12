import { mkdtempSync, writeFileSync, rm, realpathSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import {
  createTerminal,
  killTerminal,
  writeInput,
  type TerminalInfo,
} from './terminal'
import { ensureClaudeFolderTrusted } from './claudeTrust'
import { resolvedClaudeBin } from './claudeConnection'
import { buildSandboxProfile, wrapWithSandboxExec } from './sandbox'
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
  // Remote Control session name. When set (non-empty), the session starts with
  // claude's Remote Control ENABLED under this name (`--remote-control <name>`),
  // so it shows up as a controllable session on claude.ai / mobile with NO
  // manual toggle — exactly what the in-app swarm roles want. ALWAYS pass an
  // explicit, non-empty name: claude's `--remote-control [name]` takes an
  // OPTIONAL value, so a BARE flag would consume the following positional prompt
  // as the name (the same optional/variadic-swallows-the-prompt hazard
  // --add-dir guards). Empty/undefined = off (CLI default) — ordinary launches
  // (Board 実行, generateDescription) leave it off; only the swarm sets it.
  remoteControl?: string
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
  // Pass `--strict-mcp-config` so claude loads ONLY explicitly-passed MCP config
  // and IGNORES the user-scope `~/.claude.json` `mcpServers` (+ project `.mcp.json`).
  // Set TRUE on OG's NON-sandboxed, auto-triggered utility sessions
  // (generateDescription / generateTaskTitle / canvasAi / generateSkill): they run
  // bypass with no sandbox, so if a *sandboxed* claude had planted a malicious
  // user-scope MCP server in ~/.claude.json (a file claude rewrites, so the
  // sandbox can't deny writing it), an auto-triggered utility run would otherwise
  // spawn it OUTSIDE the sandbox = RCE. These utility runs never need MCP, so
  // strict-mode closes that trigger at zero cost. (Left OFF for the user's own
  // interactive terminal, which may legitimately use their MCP servers.)
  strictMcpConfig?: boolean
  // Deny-list of TOOL names for THIS claude invocation (`--disallowed-tools`).
  // Enforced by claude's own permission layer, where deny rules take precedence
  // over every mode — including `--dangerously-skip-permissions` (bypass) — so
  // the listed tools are structurally unusable, not merely un-prompted. Opt-in
  // per launch and empty by default: ONLY containment-critical utility sessions
  // pass it (the overseer brain denies WebFetch/WebSearch/Bash/Task so a prompt-
  // injected brain has no network-egress tool — nor a sub-agent to launch one —
  // to exfiltrate the you-corpus with); workers / supply / the user's own
  // terminals pass nothing and their launch line stays byte-identical.
  disallowedTools?: string[]
  // Mark this as a HEADLESS UTILITY session: a real claude PTY whose output is
  // marker-scraped, with NO user-visible pane (auto-title / auto-description).
  // Carried onto the pool entry (TerminalInfo.hidden) so listActiveTerminals
  // excludes it — a background titling/describe run must NEVER flash the Ground's
  // "claude working" beacon on a card. Default false: every user-launched pane
  // (the terminal routes, Board 実行, the swarm roles) stays visible as before.
  hidden?: boolean
  // Extra environment variables to inject into THIS claude invocation's command
  // line, scoped to the one command (exactly like OPENGROUND_OWNED=1). The
  // commander/supply spawns (swarmManager.ts / swarmSupply.ts) pass
  // `{ SWARM_MANAGER: '1' }` here — a role TAG for tooling/skills, NOT a guard
  // opt-in: the PreToolUse veto is WORKER-ONLY, armed via the `guard` opt below
  // (OPENGROUND_GUARD=1), so a worker passes NO env at all. Keys must
  // be POSIX env-name shaped (others are dropped in buildLaunchCommand); values
  // are shell-quoted for the host shell. NEVER sourced from an API request body.
  env?: Record<string, string>
  // Owner-only `experiments.sandbox` (macOS only): wrap this claude in a Seatbelt
  // sandbox (sandbox-exec) confined to `cwd`, and run it permission-`bypass` so it
  // acts prompt-free WITHIN that OS-enforced boundary (see sandbox.ts +
  // docs/SANDBOX_EXPERIMENT.md). The CALLER resolves the gate server-side
  // (resolveExperiments — owner && the toggle) and passes the boolean; this layer
  // never reads roles/settings itself, and silently ignores the flag off-darwin.
  // Default false → byte-identical to the pre-sandbox launch line.
  sandbox?: boolean
  // Extra absolute subpaths the sandbox profile must grant WRITE beyond `cwd`.
  // The swarm worker passes ONLY its repo's shared `.git` (it lives OUTSIDE the
  // worktree cwd, so without this `git commit`/`push` would be denied; hooks/config
  // + intermediate gitdirs are re-denied in the profile). node_modules is NOT
  // passed — it's a symlink to the main checkout and stays fully READ-only.
  // Ignored unless `sandbox` is on.
  sandboxWritePaths?: string[]
  // Sandbox network egress policy (sandbox.ts). Default 'all' (the historical
  // profile: outbound open, no listeners) — workers / the interactive terminal
  // are unchanged. 'loopback' kernel-denies every off-machine destination; the
  // caller pairs it with an `env` HTTPS_PROXY pointing at the host-side
  // allowlist CONNECT proxy (egressProxy.ts) — the overseer brain's egress
  // close. Ignored unless `sandbox` is on.
  sandboxNetwork?: 'all' | 'loopback'
  // Arm the DETERMINISTIC PreToolUse deny veto (A3/L4) for this session:
  // injects OPENGROUND_GUARD=1 (+ OPENGROUND_GUARD_WRITE_ROOTS from writeRoots)
  // so the openground-guard.js hook (wired globally by hooksInstall.ts, an
  // instant no-op without the env) enforces exit-2 denies — the ONE veto
  // `--dangerously-skip-permissions` cannot override. INDEPENDENT of `sandbox`:
  // L4 must hold when the L3 experiment is off, and under sandbox the hook
  // (a child of claude) simply runs inside the same Seatbelt boundary.
  // writeRoots confines Write/Edit + Bash writes to these absolute roots
  // (+ temp dirs); the swarm worker passes its worktree. Empty array = no
  // write confinement, denylist rules only (the manager shape).
  guard?: { writeRoots: string[] }
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

// Single-quote a shell argument for the host shell — used for the launch
// binary, --add-dir paths, --model / --effort / --name values, and (on Windows)
// the temp-file PATHS the prompt / context are read from. None of those carry
// newlines: the multi-line prompt / context CONTENT is never placed inline on
// the command line — it is read from a temp file at launch (see promptFileArg)
// on BOTH platforms.
//   - POSIX (zsh/bash): every byte except `'` is literal; `'` is escaped via
//     the standard `'\''` idiom.
//   - PowerShell (Windows default PTY shell, see terminal.ts pickShell): a
//     single-quoted string is literal except `'`, escaped by doubling it (`''`).
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

// One argv token that hands a temp FILE's contents to claude as a SINGLE
// argument, read by the host shell at launch — so the PTY command line itself
// stays tiny and newline-free. A long, multi-line value placed inline would
// blow the TTY's canonical line limit (~1KB MAX_CANON on macOS) AND, on any
// interactive shell, its embedded newlines would submit the command early.
//   - POSIX (zsh/bash): `"$(cat '<path>')"` — command substitution; the double
//     quotes keep the whole result one argument. (Unchanged from before.)
//   - PowerShell (Windows): `$(Get-Content -Raw '<path>')` — PowerShell cannot
//     parse `$(cat …)` at all (the bug this fixes). `-Raw` returns the file as
//     ONE string (without it Get-Content yields an array → one arg PER LINE); a
//     subexpression result is passed to a native command as a single argument
//     (PowerShell does not word-split it), so no surrounding quotes are wanted.
// SCOPE — this fixes the PARSE-level breakage: PowerShell choking on `$(cat …)`
// and launching claude with NO prompt. One DELIVERY-level limitation sits below
// it, inherent to Windows: a child process is created from a single command-LINE
// STRING (POSIX exec takes an argv ARRAY and is immune), so claude re-parses its
// argv from the string PowerShell builds. Windows PowerShell 5.1 auto-quotes a
// space-containing argument VALUE, so ordinary prose prompts (spaces, newlines)
// arrive as one argument — but it does NOT robustly escape a value's embedded
// double quotes (about_Parsing 5.1; PowerShell#1995), so an argument that itself
// contains `"` — e.g. the app-context JSON below — can be corrupted / re-split
// on claude's side. That is a Windows native-arg limitation, not a shell-quoting
// one; the remedy (escape inner quotes once Windows-tested, or have claude read
// the prompt from a file) is a separate change, to be confirmed on real Windows.
const promptFileArg = (path: string, platform: NodeJS.Platform): string =>
  platform === 'win32'
    ? `$(Get-Content -Raw ${shellQuoteArg(path, platform)})`
    : `"$(cat ${shellQuoteArg(path, platform)})"`

// Assemble the `claude …` argv. Pure + exported so the order/quoting contract
// is unit-tested (claudeTerminal.test.ts) — two ordering bugs here silently
// wedged every run, so a regression guard is load-bearing:
//
//  1. `--add-dir` is VARIADIC (accepts a space-separated list of dirs). Right
//     before the positional prompt it swallows the prompt as another directory
//     — claude starts but never gets a message, idles, writes no session JSONL
//     (run wedges, empty log). So it MUST be followed by another flag: we emit
//     it FIRST, right after `claude`, so `--session-id`/`--resume` bounds it.
//  2. The positional prompt goes LAST, read from `promptFilePath` at launch via
//     promptFileArg (`$(cat …)` on POSIX, `$(Get-Content -Raw …)` on
//     PowerShell), never inline — a long / multi-line prompt inline exceeds the
//     TTY canonical line limit (~1KB MAX_CANON on macOS) and/or submits early.
//     Passing a file path keeps the PTY command line tiny on every platform.
export const buildClaudeArgv = (
  opts: Pick<
    LaunchClaudeOpts,
    | 'addDir'
    | 'resume'
    | 'agentSessionId'
    | 'permissionMode'
    | 'model'
    | 'effort'
    | 'name'
    | 'remoteControl'
    | 'strictMcpConfig'
    | 'disallowedTools'
  >,
  promptFilePath: string | null,
  contextFilePath: string | null = null,
  resolvedBin: string | null = null,
  // Injectable so one host can unit-test the PowerShell framing. Production
  // always passes the real platform (via the default). Every embedded arg is
  // quoted for THIS platform (the local `q` below) — replacing the old
  // module-level `sq`, which hard-coded process.platform.
  platform: NodeJS.Platform = process.platform,
): string[] => {
  const q = (s: string): string => shellQuoteArg(s, platform)
  // Launch binary seam, in priority order:
  //   1. OPENGROUND_CLAUDE_BIN — the E2E/operator override (tests + the E2E suite
  //      point it at an absolute stub so the whole run flow is exercised without
  //      the real CLI / a live subscription; the product is subscription-only,
  //      there is no `claude` in CI).
  //   2. resolvedBin — the absolute path claudeConnection just VALIDATED. Passing
  //      an absolute path makes the spawn immune to the PTY login shell (`zsh -l`,
  //      no `.zshrc`) resolving `claude` differently than the connection probe
  //      (`zsh -lic`) did — the gap that left auto title/description silently
  //      empty on distributed builds (indicator green, spawned claude not found).
  //   3. bare `claude` — resolved by the PTY's inherited PATH (unchanged default).
  // Any custom path is shell-quoted so an absolute path containing spaces (the
  // repo dir is `…/OPEN GROUND`) survives intact in the PTY command line.
  const claudeBin = process.env.OPENGROUND_CLAUDE_BIN ?? resolvedBin
  // The truthiness check (not `??`) is what maps an empty-string override back to
  // the bare name — `OPENGROUND_CLAUDE_BIN=''` means "use the default", and `''`
  // is not nullish so `?? resolvedBin` wouldn't catch it. Keep this `? :`.
  const args: string[] = [claudeBin ? q(claudeBin) : 'claude']
  // `--add-dir` is variadic, so multiple dirs ride ONE flag (still bounded by
  // the `--session-id`/`--resume` flag that always follows — see rule 1 above).
  const addDirs = typeof opts.addDir === 'string' ? [opts.addDir] : opts.addDir ?? []
  if (addDirs.length) args.push('--add-dir', ...addDirs.map(q))
  // `--disallowed-tools` is VARIADIC like --add-dir (space- or comma-separated
  // tool names), so it carries the same swallows-the-positional-prompt hazard
  // (rule 1 above). Two belts: the list is joined into ONE comma-separated,
  // quoted token, AND it sits here before `--session-id`/`--resume` so a flag
  // that takes a value always bounds it.
  const disallowed = (opts.disallowedTools ?? []).map((t) => t.trim()).filter(Boolean)
  if (disallowed.length) args.push('--disallowed-tools', q(disallowed.join(',')))
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
  if (opts.model) args.push('--model', q(opts.model))
  if (opts.effort) args.push('--effort', q(opts.effort))
  if (opts.name) args.push('--name', q(opts.name))
  // `--strict-mcp-config` is a bare boolean flag (no value), so it can't swallow
  // the positional prompt — safe among the flags. Ignores user-scope ~/.claude.json
  // mcpServers + project .mcp.json, closing the planted-MCP auto-trigger on OG's
  // non-sandboxed utility sessions (see strictMcpConfig opt above).
  if (opts.strictMcpConfig) args.push('--strict-mcp-config')
  // Remote Control: start the session controllable from claude.ai / mobile under
  // an explicit name. claude's `--remote-control [name]` takes an OPTIONAL value,
  // so the name MUST be explicit + non-empty — a bare flag would consume the
  // following positional prompt as the name (the same optional/variadic hazard
  // --add-dir guards in rule 1 above). We only emit it for a non-empty name, and
  // it sits among the flags (the positional prompt always stays LAST), so the one
  // token after `--remote-control` is reliably its own name, never the prompt.
  if (opts.remoteControl) args.push('--remote-control', q(opts.remoteControl))
  // App-context system prompt — read from a file via promptFileArg, same as the
  // positional prompt (an inline multi-line value would blow the canonical line
  // limit / submit early). Placed BEFORE the positional prompt; the flag takes
  // exactly one value, so it can never swallow the prompt the way --add-dir could.
  if (contextFilePath) {
    args.push('--append-system-prompt', promptFileArg(contextFilePath, platform))
  }
  if (promptFilePath) args.push(promptFileArg(promptFilePath, platform))
  return args
}

// Assemble the ONE PTY command line that runs the claude argv and tears the
// wrapping shell down (`; exit`) when claude quits (`/quit`, Ctrl-D, finished
// --print …) — the PTY-exit listener is the run-completion signal. Pure +
// platform-injectable so both shells' framing is unit-tested on one host.
//
// `OPENGROUND_OWNED=1` marks THIS claude invocation as OPEN GROUND-launched; the
// hook script (scripts/openground-hook.js) inherits it and gates on it, so a
// claude the user starts in their own shell never feeds OPEN GROUND data.
//   - POSIX (zsh/bash): `OPENGROUND_OWNED=1 <argv> ; exit` — the env var is
//     scoped to this one command (not exported), so a later command typed into
//     the same PTY won't carry it.
//   - PowerShell (Windows default PTY shell): no inline per-command env syntax,
//     so set `$env:OPENGROUND_OWNED='1'` as its own statement (it leaks into the
//     rest of the session — fine: the next statement is the claude run, then
//     `exit` tears the shell down). argv[0] is invoked through the call operator
//     `&` because a QUOTED absolute path (the distributed-build norm —
//     resolvedClaudeBin hands back an absolute `claude.cmd` / `claude.exe`) at
//     statement position would otherwise parse as a string EXPRESSION and never
//     run. `& <bareword>` is equally valid, so the operator is unconditional.
// Validates an extra-env KEY before it reaches the command line. env is set by
// internal callers (never an API body), but a malformed key must never break
// the launch line, so anything not POSIX env-name shaped is dropped.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const buildLaunchCommand = (
  argv: string[],
  platform: NodeJS.Platform = process.platform,
  // Extra env injected ahead of OPENGROUND_OWNED, scoped to this one command.
  // Empty by default → byte-identical to the pre-env launch line (workers pass
  // none). Values are shell-quoted for THIS platform, same as every other
  // embedded arg (shellQuoteArg). OPENGROUND_OWNED is always emitted LAST so a
  // caller-supplied key can never shadow it.
  env: Record<string, string> = {},
): string => {
  const pairs = Object.entries(env).filter(([k]) => ENV_KEY_RE.test(k))
  if (platform === 'win32') {
    // PowerShell has no inline per-command env syntax: each var is its own
    // `$env:K='v';` statement. It leaks into the rest of this short-lived
    // session — fine: the next statement is the claude run, then `; exit` tears
    // the wrapping shell down.
    const sets = pairs.map(([k, v]) => `$env:${k}=${shellQuoteArg(v, platform)};`).join(' ')
    return `${sets ? sets + ' ' : ''}$env:OPENGROUND_OWNED='1'; & ${argv.join(' ')} ; exit\n`
  }
  // POSIX: inline `K='v'` assignments scoped to the single command (not
  // exported), in front of the always-present OPENGROUND_OWNED=1.
  const prefix = pairs.map(([k, v]) => `${k}=${shellQuoteArg(v, platform)}`).join(' ')
  return `${prefix ? prefix + ' ' : ''}OPENGROUND_OWNED=1 ${argv.join(' ')} ; exit\n`
}

// Assemble + write the Seatbelt profile for a sandboxed launch and return the
// temp profile path. `sandbox-exec -f` reads it once at exec time (the policy is
// then in the kernel), so it's cleaned up on the same 60s timer as the prompt /
// context temp files. Resolves cwd to its REAL path (Seatbelt matches resolved
// paths). A worker worktree's node_modules (a symlink to the main checkout) is
// left fully READ-only — see the NOTE below — so the only cross-tree write
// carve-outs are the caller-supplied ones (the worker's shared .git, so
// `git commit`/`push` can land; .git/hooks + .git/config stay denied within it).
const writeSandboxProfile = (
  cwd: string,
  extraWritePaths: string[],
  network?: 'all' | 'loopback',
): string => {
  let realCwd = cwd
  try {
    realCwd = realpathSync(cwd)
  } catch {
    // cwd not on disk yet — fall back to the given path (best-effort).
  }
  const extra = new Set<string>()
  for (const p of extraWritePaths) {
    try {
      extra.add(realpathSync(p))
    } catch {
      extra.add(p)
    }
  }
  // A worker worktree's node_modules is a SYMLINK to the MAIN checkout's
  // node_modules. We deliberately carve out NONE of it — not .bin, not .cache,
  // and NOT .vite: `npm run build` + `npm test` run with it fully READ-only
  // (verified — they read the existing cache and write any transient cache to
  // TMPDIR/cwd, never into <main>/node_modules), and making ANY of it writable
  // would let a sandboxed worker poison code the owner later runs UN-sandboxed in
  // main = full-privilege escape. That includes vite's .vite/deps slices: the dev
  // server serves them to the browser and runs them in the dev/Electron origin,
  // and vite REUSES them on a metadata-hash match WITHOUT re-verifying each
  // slice's bytes — so an in-place overwrite executes as-is. (The interactive
  // case, where node_modules is a real dir inside cwd, stays writable via cwd.)
  const profile = buildSandboxProfile({
    cwd: realCwd,
    home: homedir(),
    extraWriteSubpaths: Array.from(extra),
    ...(network ? { network } : {}),
  })
  const profilePath = join(
    mkdtempSync(join(tmpdir(), 'openground-sandbox-')),
    'profile.sb',
  )
  writeFileSync(profilePath, profile)
  const f = profilePath
  setTimeout(() => {
    rm(f, { force: true }, () => {})
  }, 60_000)
  return profilePath
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
    // Hidden utility sessions (auto-title / auto-description) stay off the Ground
    // beacon — carried onto the pool entry so listActiveTerminals can filter them.
    ...(opts.hidden ? { hidden: true } : {}),
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
  // Spawn the EXACT claude the connection probe validated (absolute path) so the
  // PTY's non-interactive login shell can't fail to resolve a bare `claude` —
  // the distributed-build gap that silently broke auto title/description. Every
  // spawn route pre-flights claudeConnection() right before this, so the cached
  // absolute path is fresh; null falls through to the bare name in buildClaudeArgv.
  // Owner-only sandbox experiment (macOS only). When on, claude runs in
  // permission-`bypass` (the OS sandbox is the safety net, so it acts prompt-free
  // within the boundary — the "激減") and the whole argv is wrapped in
  // `sandbox-exec -f <profile>` confining writes to cwd. The flag is resolved
  // server-side by the caller (isExperimentEnabled); off-darwin it's a no-op.
  // An EXPLICIT 'plan' mode is preserved (read-only planning is intentional — the
  // sandbox shouldn't silently turn it into free execution); every other mode
  // flips to bypass, which is where the prompt reduction is felt.
  const sandboxed = opts.sandbox === true && process.platform === 'darwin'
  const args = buildClaudeArgv(
    sandboxed && opts.permissionMode !== 'plan'
      ? { ...opts, permissionMode: 'bypass' }
      : opts,
    promptFilePath,
    contextFilePath,
    resolvedClaudeBin(),
  )
  const launchArgs = sandboxed
    ? wrapWithSandboxExec(
        args,
        writeSandboxProfile(opts.cwd, opts.sandboxWritePaths ?? [], opts.sandboxNetwork),
      )
    : args

  // One command line: mark this invocation OPEN GROUND-owned, inject any caller
  // env (the swarm manager port — workers pass none), run claude, and `; exit`
  // the wrapping shell when it quits so the PTY-exit listener fires the
  // cancelled / finished transition. Shell-specific framing (POSIX env-prefix
  // vs PowerShell `$env:` + call operator) lives in buildLaunchCommand.
  // The guard vars are spread LAST so a caller-supplied env key can never
  // shadow the veto's gate.
  const launchEnv: Record<string, string> = {
    ...(opts.env ?? {}),
    ...(opts.guard
      ? {
          OPENGROUND_GUARD: '1',
          OPENGROUND_GUARD_WRITE_ROOTS: opts.guard.writeRoots.join(':'),
        }
      : {}),
  }
  writeInput(info.id, buildLaunchCommand(launchArgs, process.platform, launchEnv))

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
