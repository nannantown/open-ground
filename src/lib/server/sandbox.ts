// sandbox.ts — the owner-only `experiments.sandbox` mechanism (macOS only).
//
// When the experiment gate is OPEN (owner + the settings toggle — resolved
// server-side in experiments.ts, NEVER from a request body), OPEN GROUND wraps
// the `claude` it launches in a macOS Seatbelt sandbox via the built-in
// `/usr/bin/sandbox-exec`, confining it to its project cwd. The companion
// behaviour lives in claudeTerminal.launchClaude: a sandboxed launch ALSO runs
// in permission-`bypass` mode, because the OS sandbox now provides the
// containment the interactive permission menu otherwise provided — that pairing
// is the whole point (the goal "権限プロンプトを激減させる"): prompts go to zero,
// and an escape past the (now-absent) menu is contained by the kernel instead.
//
// WHY this is safe to bolt on (see the lineage memory): OPEN GROUND ships with
// App Sandbox deliberately OFF + hardened-runtime ON, so a child Seatbelt
// profile composes cleanly — there is no parent App Sandbox for the child to be
// forced to inherit. (If OG were ever App-Sandboxed this whole approach breaks;
// keep entitlements.mac.plist as-is.)
//
// SCOPE / HONEST LIMITS of pure Seatbelt (documented, not hidden):
//   • Filesystem confinement is the ROCK-SOLID core: writes are confined to the
//     cwd (+ a small, explicit allowlist below); reads are broad (so node / git /
//     the toolchain work) EXCEPT the credential dirs, which are re-denied.
//   • NETWORK: Seatbelt cannot filter outbound by hostname (that needs a local
//     proxy — claude's own settings.json `network.allowedDomains`, or the srt
//     runtime; a separate follow-up). What this profile enforces is coarse but
//     real and safe: outbound is allowed (claude → Anthropic, git/npm, the
//     app-context curl to loopback), while ALL listeners — inbound + bind, public
//     AND loopback — are denied, so a contained agent cannot open a backdoor.
//   • `sandbox-exec` is deprecated by Apple (warns on stderr from macOS Sequoia
//     on) but functions on every current macOS; removal is unannounced. This is
//     an EXPERIMENT, gated + default-off, so that long-tail risk is acceptable.

import { join } from 'path'

export interface SandboxProfileInput {
  /** Absolute, REAL (symlinks resolved) path of the project / worktree the
   *  sandboxed claude may write freely within. */
  cwd: string
  /** The user's home dir — anchors the credential read-denies and the
   *  claude / app state write-allows. */
  home: string
  /** Extra absolute subpaths to additionally grant WRITE. The swarm worker passes
   *  ONLY its repo's shared `.git` (a worktree's objects/refs live in the main
   *  checkout, OUTSIDE the worktree cwd — without this `git commit`/`push` would
   *  be denied; the `.git` hooks/config + intermediate gitdirs are re-denied
   *  below). node_modules is deliberately NOT here — it's a symlink to the main
   *  checkout and is left fully READ-only (build/test work read-only). This is a
   *  tight carve-out — a worker can't scribble on the main checkout's source. */
  extraWriteSubpaths?: string[]
  /** Network egress policy. 'all' (the default — the historical worker/interactive
   *  profile): outbound open, every listener denied. 'loopback': outbound is
   *  allowed ONLY to loopback + local unix sockets — every off-machine destination
   *  falls to (deny default) and is KERNEL-refused (EPERM). 'loopback' is the
   *  egress-proxy pattern (docs/SANDBOX_EXPERIMENT.md follow-up): the confined
   *  claude reaches Anthropic exclusively through a host-side allowlist CONNECT
   *  proxy on 127.0.0.1 (HTTPS_PROXY), so what leaves the machine is decided
   *  OUTSIDE the sandbox. The overseer brain uses this — it holds the private
   *  you-corpus, so its direct egress is structurally closed, not permission-
   *  layer-closed. (Verified on the real kernel: remote-ip localhost allows,
   *  1.1.1.1:443 EPERMs, DNS still resolves via mDNSResponder mach IPC.) */
  network?: 'all' | 'loopback'
}

// Escape a string for an SBPL double-quoted string literal: backslash first,
// then the double-quote. Real macOS paths never contain control chars; this is
// belt-and-suspenders so a path with a quote (legal on macOS) can't break out of
// the literal and inject profile syntax.
const sbStr = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')

// Escape a string so it is matched LITERALLY inside an SBPL `#"…"` regex literal
// (POSIX-extended). Used for the home prefix of the `.claude.json` family rule
// below. Escapes the regex metacharacters AND the double-quote that would
// otherwise close the `#"…"` literal (a home dir may legally contain one). The
// emitted backslashes are written verbatim into the profile text.
const sbRegexLiteral = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '\\"')

/**
 * Build the SBPL (Seatbelt Profile Language) text for a cwd-confined claude.
 *
 * Pure + deterministic so the security contract is unit-tested without invoking
 * the kernel: the test asserts the deny-default, the cwd write-allow, the
 * credential read-denies, and the execution-config write-denies.
 *
 * SBPL evaluation is LAST-MATCHING-RULE-WINS, which is why both the credential
 * `(deny file-read* …)` and the execution-config `(deny file-write* …)` lines
 * come AFTER the broad allows — for a path under ~/.ssh (read) or ~/.claude/hooks
 * (write) the deny is the last match and wins, while every other path keeps the
 * broad allow. (scripts/sandbox-probe.ts proves this empirically on a real kernel.)
 */
export const buildSandboxProfile = (input: SandboxProfileInput): string => {
  const { cwd, home } = input
  const homeRx = sbRegexLiteral(home)

  // Writable subpaths: the project cwd, claude's own state dir + temp dirs, and
  // any caller-supplied carve-outs. macOS resolves /tmp → /private/tmp and
  // TMPDIR (/var/folders/…) → /private/var/folders/…, and the kernel matches on
  // the resolved path, so BOTH forms are listed.
  const writeSubpaths = [
    cwd,
    join(home, '.claude'),
    join(home, '.openground'),
    // Tool caches — NOT credentials, just missing-allow friction that would
    // otherwise break `npm install`/`npm ci` and non-node toolchains (go / rust /
    // pip / Playwright) that write outside cwd. Safe to grant (residual: see docs
    // HOME tool-cache poisoning).
    join(home, '.npm'),
    join(home, '.cache'),
    join(home, 'Library/Caches'),
    '/private/tmp',
    '/tmp',
    '/private/var/folders',
    '/var/folders',
    '/private/var/tmp',
    '/var/tmp',
    ...(input.extraWriteSubpaths ?? []),
  ]

  // Credential dirs/files re-denied for READ AFTER the broad read (last-match-wins,
  // so they win over `(allow file-read* (subpath "/"))`). Without these, the broad
  // read + `(allow network-outbound)` is a token-exfil channel — and because
  // sandbox-on flips to bypass, the "Read outside the project?" prompt that default
  // mode would have shown is GONE, so it's a SILENT exfil. Covered: SSH/GPG keys,
  // cloud + cluster + container creds (aws/gcloud/kube/docker), and the package /
  // git / IaC token stores. Credential DIRS use subpath; credential FILES use
  // literal where the parent dir also holds read-needed build data (cargo/gem/
  // terraform registries + plugins) so we deny only the secret, not the dir.
  // NOTE (honest limit): the login KEYCHAIN's secrets are reached via securityd
  // IPC (mach-lookup, allowed — it's how https git push authenticates), NOT by
  // reading these files, so a determined payload can still `git credential fill` a
  // stored token. Denying these files does not close that; true secret isolation
  // needs the egress-proxy follow-up (docs/SANDBOX_EXPERIMENT.md).
  const denyReadSubpaths = [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.gnupg'),
    join(home, '.config/gh'),
    join(home, '.config/gcloud'),
    join(home, '.docker'),
    join(home, '.kube'),
    join(home, '.azure'), // Azure CLI tokens
    join(home, '.wrangler'), // Cloudflare wrangler (legacy token location)
    join(home, '.config/.wrangler'), // Cloudflare wrangler (current token location)
    // The login-keychain FILES — but NOT under 'loopback': claude's subscription
    // credential lives in the login keychain, and Security.framework READS the
    // keychain db files from the CLIENT process (verified on the real kernel: a
    // sandboxed `security find-generic-password` fails with this deny and
    // succeeds without it — the securityd mach IPC alone is NOT the whole path),
    // so keeping the deny leaves the confined claude "Not logged in". Under
    // 'loopback' the deny also buys ~nothing: the db is encrypted at rest and
    // every off-machine byte still has to pass the host-side allowlist proxy —
    // there is no exfil destination. Under 'all' (worker/interactive) outbound
    // is open, so the file-level deny stays as the historical exfil-surface trim.
    ...(input.network === 'loopback' ? [] : [join(home, 'Library/Keychains')]),
  ]
  const denyReadLiterals = [
    join(home, '.netrc'),
    join(home, '.git-credentials'),
    join(home, '.config/git/credentials'), // XDG git credential store (the ~/.git-credentials twin)
    join(home, '.npmrc'), // npm auth token (npm falls back to public defaults — build still works)
    join(home, '.yarnrc.yml'), // yarn-berry npmAuthToken
    join(home, '.pypirc'), // PyPI upload token
    join(home, '.cargo/credentials.toml'), // crates.io token (cargo registry cache stays readable)
    join(home, '.cargo/credentials'), // legacy cargo token filename
    join(home, '.gem/credentials'), // RubyGems API key (gem specs/cache stay readable)
    join(home, '.terraform.d/credentials.tfrc.json'), // Terraform Cloud token
    join(home, '.vault-token'), // HashiCorp Vault token
    join(home, '.gradle/gradle.properties'), // Gradle signing / repo creds (gradle caches stay readable)
    join(home, '.m2/settings.xml'), // Maven repo creds (the local .m2/repository stays readable)
  ]

  // AUTO-EXECUTING config re-denied for WRITE (last-match-wins, so it overrides
  // the broad write-allows above — including the cwd and the worker's `.git`
  // carve-out). This closes the sandbox's biggest escape: a contained claude
  // planting a payload that RUNS OUTSIDE the sandbox on the NEXT claude / git
  // launch — a non-sandboxed OG utility session (generateDescription /
  // generateTaskTitle / canvasAi run with cwd=projectPath, bypass, NO sandbox),
  // the user's own terminal claude, or after the experiment is turned off.
  //
  // PATH-AGNOSTIC regexes (not home-literals) so they cover the config in BOTH the
  // GLOBAL ~/.claude AND any PROJECT-LOCAL <cwd>/.claude (+ <cwd>/.mcp.json) — the
  // project-local copy is INSIDE the writable cwd, and is the one OG's own auto
  // sessions trigger. We deny only code-bearing config that EXECUTES on a later
  // launch: hook scripts, MCP servers, plugins, SKILL scripts, the settings.json
  // that wires hooks, and git hooks/config (incl. submodules + per-worktree). Pure
  // INSTRUCTION files (CLAUDE.md, .claude/commands, .claude/agents — markdown, no
  // embedded scripts) are editable project CONTENT and stay writable; their
  // injection risk is a documented residual (lower than code exec). Existing
  // hooks/skills still RUN (read+exec stay allowed) — they just can't be
  // PLANTED/altered, so denying WRITE costs no functionality. (~/.claude.json is
  // the one config claude DOES rewrite, so it stays writable; its `mcpServers` key
  // is a residual persistence vector documented in docs/SANDBOX_EXPERIMENT.md.)
  const denyWriteLiterals = [
    join(home, '.claude/CLAUDE.md'), // GLOBAL instructions (project CLAUDE.md is legit content)
    join(home, '.openground/settings.json'), // OG's `projects` allowlist = the validateProjectPath boundary
  ]
  // Every deny here is anchored at the ENTRY (`$`), NOT just its children. The
  // parent of each (~/.claude / the cwd / the worker's .git carve-out) is
  // write-allowed, so a CHILD-only deny (`.../X/.*`) is insufficient: a worker can
  // `mv X X.bak && ln -s /evil X`, then a write to `X/child` RESOLVES to
  // `/evil/child` (outside the deny) and the planted hook runs UN-sandboxed on the
  // owner's next git/claude (symlink-swap escape, proven on the real kernel). The
  // `(/.*)?$` forms deny renaming/replacing the dir ENTRY too; the bare `.../X$`
  // forms deny swapping the whole `.git` / `.claude` (children stay writable via
  // the subpath allows — only the entry write/rename is blocked).
  const denyWriteRegexes = [
    '.*/\\.claude/settings(\\.local)?\\.json$', // hook / permission config (global + project)
    '.*/\\.claude/(hooks|plugins|skills)(/.*)?$', // hook scripts / plugin / skill code (entry + children)
    '.*/\\.mcp\\.json$', // project MCP servers (load = command exec)
    // git hooks at ANY gitdir level (entry + children): the top .git/hooks AND a
    // submodule/worktree .git/(modules|worktrees)/<name>/hooks — all run a command
    // on git ops. Entry-anchored (vs symlink-swap).
    '.*/\\.git/(modules/.*/|worktrees/.*/)?hooks(/.*)?$',
    // git config in ALL its forms (fsmonitor / alias / core.hooksPath run a
    // command): main .git/config, submodule .git/modules/*/config, and the
    // per-worktree .git/worktrees/*/config.worktree. `config.lock` (git's atomic
    // tmp) is intentionally NOT matched — it's moot once config itself is denied.
    '.*/\\.git/(modules/.*/|worktrees/.*/)?config(\\.worktree)?$',
    // The intermediate gitdir DIRS themselves — .git/modules, .git/worktrees, each
    // per-name .git/modules/<name> / .git/worktrees/<name>, AND any NESTED
    // submodule level (.git/modules/<a>/modules[/<b>]) via the `(modules/[^/]+/)*`
    // prefix — entry-anchored so they can't be `mv X X.bak && ln -s /evil X`
    // symlink-swapped to redirect the config/hooks below them. The prefix only
    // matches `modules`/`worktrees` at a real gitdir position, so a branch named
    // `modules` (`.git/refs/heads/modules`) is NOT denied; and `(/[^/]+)?$` keeps
    // DEEP children (HEAD/index/logs/objects) writable, so commit/push are unchanged.
    '.*/\\.git/(modules/[^/]+/)*(modules|worktrees)(/[^/]+)?$',
    // The sensitive DIR entries themselves, so the WHOLE `.git` / `.claude` /
    // `.openground` can't be renamed+symlinked to redirect every child at once.
    // git/claude/OG write INSIDE these (children, still allowed — incl. the
    // worker's `~/.openground/swarm/…` heartbeat), never the entry, so it's free.
    // `.openground` matters because it holds settings.json = the validateProjectPath
    // allowlist; entry-denying it makes its protection explicit, not incidental.
    '.*/\\.git$',
    '.*/\\.claude$',
    '.*/\\.openground$',
    // custom-tab module CODE: a sandboxed claude must not register/alter a module
    // (index.json / <id>/source.tsx). It renders in a sandboxed iframe (opaque
    // origin) so direct renderer escape is already blocked — this is
    // defense-in-depth against the loopback-API CSRF surface a planted module
    // could otherwise probe. Authoring happens in the NON-sandboxed
    // /api/terminal/custom-module session, unaffected by this deny.
    '.*/\\.openground/custom-modules(/.*)?$',
    // The PreToolUse deny veto's INSTALLED copy (A3/L4 — hooksInstall.ts wires
    // ~/.openground/guard/openground-guard.js into settings.json). The veto is
    // exactly what a contained claude must not rewrite; its settings.json
    // wiring is already denied above, this denies the script body too. Entry-
    // anchored like the others (vs symlink-swap).
    '.*/\\.openground/guard(/.*)?$',
  ]

  const lines: string[] = [
    '(version 1)',
    '(deny default)',
    // Let claude spawn its toolchain (node, git, npm, bash …); children inherit
    // the sandbox — that inheritance is what confines the whole worker.
    '(allow process-exec*)',
    '(allow process-fork)',
    '(allow signal (target children) (target self))',
    // System plumbing claude / node / dyld need. These are not a filesystem-write
    // or network-egress risk (the dimensions we contain). `mach-lookup` is broad
    // by necessity — claude/node reach many system services through it, and it's
    // ALSO how https git push authenticates via the keychain (securityd) — so it
    // is NOT a tight jail boundary (a determined payload could reach securityd or,
    // in theory, launchd). `iokit-open` is intentionally omitted: claude/node do
    // not need hardware device access, so leaving it out trims attack surface.
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow system-socket)',
    // Broad READ so the toolchain, system libraries, git config and the repo are
    // all visible. The credential denies below override this for secret dirs.
    '(allow file-read* (subpath "/"))',
    // The PTY slave tty + /dev/null + /dev/urandom: read, write AND ioctl
    // (termios / window-size ioctls are checked at call time, not just open()).
    '(allow file-read* file-write* file-ioctl (subpath "/dev"))',
  ]

  // Write-allows.
  for (const p of writeSubpaths) {
    lines.push(`(allow file-write* (subpath "${sbStr(p)}"))`)
  }
  // claude rewrites ~/.claude.json (+ its atomic .tmp / .lock / .backup siblings)
  // mid-session; it sits directly in $HOME so it can't be a subpath of an allowed
  // dir — allow the family by a regex anchored at BOTH ends: `.claude.json`
  // optionally followed by a DOT-LED suffix, so `~/.claude.jsonEVIL` and
  // `~/.claude.jsonDIR/sub` (a prefix-only regex would have matched both) do NOT.
  // `(\..*)?$` (not a `[…]` char class — sandbox-exec's regex engine rejects the
  // bracket expression) keeps it to the atomic-sibling shape.
  lines.push(`(allow file-write* (regex #"^${homeRx}/\\.claude\\.json(\\..*)?$"))`)

  // Credential read-denies LAST so they win over the broad read above.
  for (const p of denyReadSubpaths) {
    lines.push(`(deny file-read* (subpath "${sbStr(p)}"))`)
  }
  for (const p of denyReadLiterals) {
    lines.push(`(deny file-read* (literal "${sbStr(p)}"))`)
  }
  // Execution-config write-denies LAST so they win over the write-allows above.
  for (const p of denyWriteLiterals) {
    lines.push(`(deny file-write* (literal "${sbStr(p)}"))`)
  }
  for (const re of denyWriteRegexes) {
    lines.push(`(deny file-write* (regex #"${re}"))`)
  }

  // Network. We open NO listener in either mode: bind/inbound fall through to
  // (deny default), so a contained agent can't stand up a server, public OR
  // loopback (no backdoor; no dev server). Seatbelt's `(local ip …)` bind filter
  // does not reliably scope a listen to loopback (empirically even `*:*` fails to
  // grant node's listen), so "no listeners at all" is the honest, enforceable line.
  if (input.network === 'loopback') {
    // 'loopback' — outbound ONLY to the local machine; everything off-machine is
    // KERNEL-refused. Local unix sockets are allowed too (they are IPC, not
    // egress — and libinfo's DNS path may ride /var/run/mDNSResponder as a unix
    // socket on some macOS versions; resolution is harmless when every off-machine
    // connect is denied anyway). The confined claude reaches Anthropic exclusively
    // through the host-side allowlist CONNECT proxy on 127.0.0.1 (HTTPS_PROXY) —
    // sandbox.test.ts pins that NO bare `(allow network-outbound)` is emitted here.
    lines.push('(allow network-outbound (remote unix-socket))')
    lines.push('(allow network-outbound (remote ip "localhost:*"))')
  } else {
    // 'all' (default) — OUTBOUND is allowed (claude → Anthropic over 443, git/npm,
    // and the app-context curl to 127.0.0.1 — loopback outbound verified).
    // Outbound is host-blind — domain-level egress filtering needs a local proxy
    // (the 'loopback' mode above / claude's own settings.json
    // `network.allowedDomains`, or the srt runtime).
    lines.push('(allow network-outbound)')
  }

  // Trailing newline so the file is well-formed for `sandbox-exec -f`.
  return lines.join('\n') + '\n'
}

/**
 * Prepend the `sandbox-exec -f <profile>` invocation to an already-quoted claude
 * argv (the tokens buildClaudeArgv returns are shell-quoted for the host shell).
 *
 * `-f <file>` (not `-p <inline-string>`) deliberately: a full SBPL profile is
 * easily > 1 KB, and an inline string would hit the same PTY canonical-line
 * limit (~1 KB MAX_CANON on macOS) that promptFileArg already routes the prompt
 * around — so the profile rides a temp file exactly like the prompt / context do.
 * macOS-only, so only POSIX single-quoting of the profile path is needed.
 */
export const wrapWithSandboxExec = (argv: string[], profilePath: string): string[] => {
  const q = `'${profilePath.replace(/'/g, "'\\''")}'`
  // Absolute path (not bare `sandbox-exec`): a Finder-launched .app inherits a
  // stripped PATH, and this binary is ALWAYS at /usr/bin on macOS — same
  // PATH-immunity reasoning resolvedClaudeBin applies to `claude`.
  return ['/usr/bin/sandbox-exec', '-f', q, ...argv]
}
