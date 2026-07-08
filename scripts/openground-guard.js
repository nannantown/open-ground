#!/usr/bin/env node
/* eslint-disable */
// openground-guard.js — OPEN GROUND's DETERMINISTIC PreToolUse deny veto (A3 / L4).
//
// Invoked by Claude Code's hook system (wired into ~/.claude/settings.json by
// hooksInstall.ts, which also copies this file to ~/.openground/guard/ — a path
// the sandbox profile write-denies, so a contained claude can't rewrite its own
// veto). Reads the PreToolUse payload from stdin as JSON and answers with the
// ONLY verdict that `--dangerously-skip-permissions` cannot override:
//
//   exit 2 + stderr  → BLOCK (the stderr line is fed back to the model)
//   exit 0 + `{}`    → allow
//
// exit 1 is deliberately NEVER produced: Claude Code treats exit 1 as a
// NON-BLOCKING hook error and lets the tool call proceed — a guard that fails
// with exit 1 is a guard that silently vanished. Every internal error past the
// gate maps to exit 2 (fail-CLOSED), never 1.
//
// GATE (WORKER-ONLY, 2026-07): enforcement runs for ONE kind of session —
//   OPENGROUND_GUARD=1  … in-app swarm WORKERS / overseer sessions: unattended,
//                          bypass-permissions claude PTYs that are the real
//                          autonomous-execution risk. launchClaude injects it plus
//                          OPENGROUND_GUARD_WRITE_ROOTS=<colon-separated abs roots>
//                          confining Write/Edit + Bash writes to a throwaway
//                          worktree. THESE are the sessions the veto polices.
// EVERY other session — including the swarm MANAGER / supply officer
// (SWARM_MANAGER=1) and any plain claude — exits 0 instantly (a no-op). The
// manager is the human-in-the-loop INTEGRATION DESK: a TRUSTED commander the user
// talks to, not an unattended executor, so it is not policed. Policing the
// trusted, unconfined manager was an unbounded game of whack-a-mole — a shell is
// Turing-complete, so every legit-looking manager op needed a carve-out and each
// carve-out was a fresh hole (four adversarial rounds, every leak in the manager
// path). Scoping the veto to the CONFINED worker — narrow, inspectable workflow —
// closes that whole class BY DESIGN. (User decision "B".)
//
// WHAT IT DENIES (the A3 classes + the evasion routes into them):
//   • rm -rf on absolute/home/parent paths (workers: any path outside their
//     write roots; relative rm after an out-of-roots cd counts as outside)
//   • git push — ALL of it, plain/FF included, any remote, any refspec (plus
//     the plumbing spellings send-pack / http-push, git-svn's dcommit, and the
//     DASH-FORM binaries — git-push / git-send-pack / git-http-push / git-svn,
//     callable by absolute libexec path with no `git` driver word — which are
//     routed back through the same git analysis, so both spellings get one
//     verdict). Integration is the COMMANDER's job: a worker commits locally,
//     beats ready, and stops. The old force-only vetting (inherited from the
//     manager-era guard, where a plain FF push was the manager's legitimate
//     integration step) left `git push origin HEAD:main` open — the 2e7beb2
//     bypass, where a heartbeat-less worker integrated itself past the
//     commander's re-verify + adversarial review. Blanket subcommand denial
//     leaves no flag/quoting/computed-word surface to evade on the ARGUMENT
//     side; the one KNOWN residual on the NAME side is a PRE-EXISTING
//     user/system gitconfig alias (`git p` with `[alias] p = push`) — see
//     Known residuals below. History nukes
//     stay denied as before (reset --hard, clean -f, filter-branch,
//     update-ref -d, branch -D, stash drop/clear/pop, checkout -f/--,
//     restore of the worktree, reflog expire / gc --prune=now)
//   • writes outside the session's write roots (Write/Edit/NotebookEdit file
//     paths, Bash redirections and write-verbs like tee/cp/mv/dd) when
//     OPENGROUND_GUARD_WRITE_ROOTS is set — plus, ALWAYS, writes to the guard's
//     own substrate (this file's installed copy, settings.json hook wiring,
//     ~/.claude/swarm-*.sh, CLAUDE.md), mirroring swarm-guard.sh's tier-2 rule.
//   • the evasion routes the official docs call out as defeating naive argument
//     regexes: command-position variables/command-substitution, eval/source,
//     sh -c / bash -c / interpreter stdin (`curl … | sh`, `base64 -d | bash`),
//     alias definitions + expand_aliases, function definitions, sudo, and
//     inline-code flags (node -e / python -c …). Dispatch whose targets the guard
//     can't see — `xargs <verb>` (targets from stdin) and `find … -exec <verb>`
//     (targets from the matched start point, ALL -exec clauses) — is closed by
//     INVERSION: only a read-only allowlist of verbs is permitted, everything
//     else (destructive verb, in-place editor, interpreter, unknown/wrapper) is
//     denied fail-CLOSED (a denylist would leak every omitted write-capable verb).
//     Unparseable input (unbalanced quotes, unterminated heredoc/substitution)
//     is DENIED, not skipped — "I can't read it" must never mean "it runs".
//
// HONEST SCOPE (same honesty swarm-guard.sh keeps): this is L4 of a layered
// defence, not a sandbox. A payload staged INSIDE the write roots (a script
// written to the worktree, then `node script.js` doing damage from within a
// live process) is invisible to any PreToolUse parser — containing that is
// L3's job (sandbox.ts, OS-enforced). What L4 guarantees is deterministic:
// the LITERAL destructive tool calls, and every recognizable indirection
// around them, get exit 2 even under --dangerously-skip-permissions, where
// no permission prompt exists to catch them.
//
// Known residuals (documented, not hidden):
//  • MCP TOOLS: this hook only vetoes Bash + the file-write tools (Write/Edit/
//    MultiEdit/NotebookEdit). MCP tools (mcp__*) sit OUTSIDE the veto — a
//    filesystem/shell MCP or a data-mutating one would be an unguarded path. The
//    swarm worker closes this at the SOURCE by launching with --strict-mcp-config
//    (swarmWorker.ts), so a worker has NO MCP servers loaded and thus no mcp__*
//    tools to call. Any FUTURE guarded session that omits strictMcpConfig would
//    re-open this gap — pair the two.
//  • NON-STOCK interpreters/editors: the guard covers the common code-runners
//    (node/deno/bun, python, perl, ruby, php) and file editors (sed, awk/gawk/
//    mawk/nawk incl. gawk's `|&` coprocess, ed/ex, vim/vi/nvim, emacs) — the set a
//    dev machine actually has. A genuinely exotic runner (a niche language shell,
//    a hand-built REPL) outside that set would be inline-code the guard doesn't
//    recognize; that residual is L3's (a payload run from a live process is
//    invisible to any PreToolUse parser anyway). New common tools are cheap to add.
//  • RUN-A-COMMAND WRAPPERS on the MAIN command line: the guard strips the common
//    ones (env, nice, nohup, timeout, stdbuf, setsid, busybox, command, exec, …)
//    to reach the real verb, but this is an allowlist. A wrapper NOT in the set
//    that takes a positional arg before its command (`flock <lockfile> <cmd>`,
//    `chroot <dir> <cmd>` — Linux util-linux, absent on stock macOS) would run a
//    destructive verb the guard reads as the wrapper name. In DISPATCH position
//    (`xargs`/`find -exec`) this is already closed by the read-only inversion
//    above (an un-stripped wrapper name isn't read-only ⇒ denied); only the bare
//    main-line form on a Linux worker remains, and it is the same "exotic tool" L3
//    class. New wrappers are cheap to add to WRAPPERS / stripWrappers.
//  • COMMAND IDENTITY is by BASENAME: a symlink or copy named `cat` that actually
//    points to a writer (`ln -s /usr/bin/tee ./cat`) is read as `cat` and, in the
//    read-only dispatch allowlist, would pass. This is the SAME conceded residual
//    as a renamed/staged executable run from a live process (`node planted.js`) —
//    the guard can't realpath-verify a command's true target without TOCTOU, so a
//    deliberately mis-named binary is L3's (OS-enforced) job, not L4's. The `ln`
//    that CREATES such a shadow into a read-only name is itself allowed (in-roots),
//    exactly like writing planted.js; what L4 still guarantees is that the LITERAL
//    stock verbs and their recognizable indirections get exit 2.
//  • SYMLINK write-confinement: the write-root checks resolve paths LEXICALLY
//    (path.resolve, not realpath), so a symlink INSIDE the roots pointing OUT
//    (`ln -s /etc x; echo … > x/passwd`) resolves to an in-roots path and is
//    allowed by L4, while the write follows the link outside. Realpath at check
//    time is unreliable (TOCTOU + the target may not exist yet); the OS-enforced
//    L3 sandbox handles symlink-swap via entry-anchored write-denies. (The `ln`
//    that CREATES such a link into the substrate is denied — only escapes via a
//    pre-existing benign-looking link remain.)
//  • A write/rm target that is FULLY or PARTLY computed (`> "$LOG"`,
//    `tee out-$(date).log`) is DENIED, not guessed: the guard can't prove where a
//    substitution's output lands (a var could hold `/etc/passwd` or `../../x`),
//    and quietly allowing it by a literal-prefix heuristic would be a bypass. The
//    substitution ITSELF is still vetted (`> $(rm -rf /)` is caught); only the
//    computed-PATH case fails closed.
//  • A redirect target chosen WITHIN a stream editor's script from a runtime
//    VARIABLE (`sed 'w '"$D"` built by shell concat, or awk `print > VAR`) is
//    left to L3. The LITERAL in-script writes ARE caught L4-side now: sed's
//    `w /path` / `W` / `s///w` / GNU `e` and awk's `print > "file"` / `system()`
//    / `| "cmd"` are denied when the path/command is literal, and the FILE
//    ARGUMENTS of in-place editors (sed -i / perl -i / ruby -i) deny a computed
//    target symmetric with rm.
//  • GITCONFIG ALIASES that PRE-DATE the session: `git p` where the user's own
//    global/system gitconfig already defines `[alias] p = push` reaches push
//    without the literal subcommand ever appearing on the command line —
//    statically unresolvable (vetting it would mean reading gitconfig at veto
//    time — TOCTOU — and blanket-denying unknown subcommands would break every
//    READ alias: `git st`, `git co`, …). Every IN-SESSION route into this is
//    closed — defining one (`git config alias.*`), inlining one (`git -c
//    alias.*=…` / `--config-env`), and `--exec-path` relocation are all denied
//    — so exploiting it requires an alias the USER already shipped on the
//    machine before spawn. Neutralizing those via GIT_CONFIG_GLOBAL=/dev/null
//    (+ GIT_CONFIG_SYSTEM) in the worker env was considered and REJECTED: it
//    also strips user.name/email (breaking the worker's whole commit flow —
//    its core contract) and credential helpers (breaking fetch/pull), a
//    legitimate-path regression bought for a user-authored corner case.
//  • TRACKED-SOURCE STAGING: `git apply` / `patch` / `git checkout <ref> --
//    <path>` can rewrite the REPO's tracked copy of this file
//    (scripts/openground-guard.js) — it sits inside the write roots, and the
//    substrate basename rule covers Write/Edit/shell writes/git mv|rm, not
//    content-level patch application. The INSTALLED copy (~/.openground/guard/)
//    stays write-denied, so this cannot disarm the LIVE veto — it is a
//    plant-and-wait-for-deploy channel, and it is closed at integration time
//    (the commander's re-verify + adversarial review + the swarm-code merge
//    gate), not at L4.
// A worker that needs to rewrite a file uses the Edit tool or a script the guard
// can see.
//
// The analyzer core is exported (module.exports.evaluate) so the safety suite
// (src/lib/server/swarmSafety.test.ts) unit-tests verdicts in-process AND
// end-to-end (spawn + stdin + exit code) — teeth over both surfaces.

'use strict'

const path = require('path')
const os = require('os')

// ────────────────────────────────────────────────────────────────────────────
// Tokenizer — a small, honest POSIX-shell lexer. It understands quoting
// ('…', "…", $'…', \x), operators, comments, heredocs, and the substitution
// forms ($VAR, ${…}, $(…), `…`, <(…), >(…), $((…))) so the analyzer can reason
// about STRUCTURE instead of raw substrings ("rm -rf" inside a commit message
// is a quoted WORD — never a command). Anything it cannot lex is a parse
// error, which the caller maps to deny (fail-closed).
//
// Token shapes:
//   { t: 'op', op: ';' | '&&' | '||' | '|' | '&' | '(' | ')' | '\n'
//              | '>' | '>>' | '<' | '<<<' | 'dupfd' }        // dupfd: 2>&1 &- forms
//   { t: 'word', parts: Part[] }
// Part shapes:
//   { k: 'lit',  s: string }                    // literal text (quotes resolved)
//   { k: 'var',  name: string }                 // $NAME / ${…}
//   { k: 'cmdsub', inner: string }              // $(…) / `…`  (inner source text)
//   { k: 'procsub', inner: string }             // <(…) / >(…)
//   { k: 'arith' }                              // $((…))
// Words carry `parts` so the analyzer can ask: is this word fully literal?
// what is its literal text? does it embed a substitution?
// ────────────────────────────────────────────────────────────────────────────

class ParseError extends Error {}

const isOpStart = (c) => c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '<' || c === '>' || c === '\n'
const isSpace = (c) => c === ' ' || c === '\t'
const DIGITS = /^[0-9]+$/

// Read a $'…' ANSI-C quoted body starting after the opening quote; returns
// [decodedText, indexAfterClosingQuote]. Decodes enough (\n \t \\ \' \" \xHH
// \NNN octal \uHHHH) that 'r'$'\155' cannot smuggle an "rm" past the analyzer.
function readAnsiC(src, i) {
  let out = ''
  while (i < src.length) {
    const c = src[i]
    if (c === "'") return [out, i + 1]
    if (c === '\\') {
      const n = src[i + 1]
      if (n === undefined) throw new ParseError('unterminated $\'…\'')
      const simple = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', e: '\x1b', E: '\x1b', '0': '\0' }
      if (n === 'x') {
        const m = /^[0-9a-fA-F]{1,2}/.exec(src.slice(i + 2))
        if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += 2 + m[0].length; continue }
        out += 'x'; i += 2; continue
      }
      if (n === 'u' || n === 'U') {
        const m = /^[0-9a-fA-F]{1,8}/.exec(src.slice(i + 2))
        if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += 2 + m[0].length; continue }
        out += n; i += 2; continue
      }
      if (n >= '0' && n <= '7') {
        const m = /^[0-7]{1,3}/.exec(src.slice(i + 1))
        out += String.fromCharCode(parseInt(m[0], 8)); i += 1 + m[0].length; continue
      }
      if (n in simple) { out += simple[n]; i += 2; continue }
      out += n; i += 2; continue
    }
    out += c; i += 1
  }
  throw new ParseError('unterminated $\'…\'')
}

// Read a balanced $(…) / <(…) / >(…) body starting after the opening paren.
// Tracks nested parens and quotes so `$(echo "(" )` closes correctly.
// Returns [innerText, indexAfterClosingParen].
function readBalancedParen(src, i) {
  let depth = 1
  let out = ''
  while (i < src.length) {
    const c = src[i]
    if (c === "'") { // single-quoted span — copy verbatim
      const end = src.indexOf("'", i + 1)
      if (end < 0) throw new ParseError('unterminated quote in substitution')
      out += src.slice(i, end + 1); i = end + 1; continue
    }
    if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue }
    if (c === '"') { // double-quoted span — copy verbatim incl. escapes
      out += c; i += 1
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue }
        out += src[i]; i += 1
      }
      if (i >= src.length) throw new ParseError('unterminated quote in substitution')
      out += '"'; i += 1; continue
    }
    if (c === '(') { depth += 1; out += c; i += 1; continue }
    if (c === ')') {
      depth -= 1
      if (depth === 0) return [out, i + 1]
      out += c; i += 1; continue
    }
    out += c; i += 1
  }
  throw new ParseError('unterminated substitution')
}

// Read a `…` command substitution starting after the opening backtick.
function readBacktick(src, i) {
  let out = ''
  while (i < src.length) {
    const c = src[i]
    if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue }
    if (c === '`') return [out, i + 1]
    out += c; i += 1
  }
  throw new ParseError('unterminated backtick substitution')
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*|^[0-9]|^[@*#?$!-]/

// Read one $-form at src[i] ('$' position). Returns [part, nextIndex].
function readDollar(src, i) {
  // $(( … )) arithmetic — balance from AFTER the second '(' so the inner
  // paren-matcher closes on the first of the two trailing ')', then require
  // the second one explicitly. KEEP the inner text as `raw`: bash runs any
  // command-substitution embedded in an arithmetic expression BEFORE evaluating
  // it (`$(($(rm -rf /)))`), so the analyzer must scan it — dropping it was a
  // veto bypass.
  if (src.startsWith('$((', i)) {
    const [inner, after] = readBalancedParen(src, i + 3)
    if (src[after] !== ')') throw new ParseError('unterminated arithmetic')
    return [{ k: 'arith', raw: inner }, after + 1]
  }
  if (src.startsWith('$(', i)) {
    const [inner, after] = readBalancedParen(src, i + 2)
    return [{ k: 'cmdsub', inner }, after]
  }
  if (src.startsWith('${', i)) {
    let depth = 1
    let j = i + 2
    let name = ''
    while (j < src.length && depth > 0) {
      if (src[j] === '{') depth += 1
      else if (src[j] === '}') { depth -= 1; if (depth === 0) break }
      name += src[j]; j += 1
    }
    if (depth !== 0) throw new ParseError('unterminated ${…}')
    // KEEP the body as `raw`: a parameter expansion's word side runs embedded
    // command-substitutions (`${x:-$(rm -rf /)}`, `${x/y/$(rm)}`) — the analyzer
    // scans `raw` for them. Dropping the body was a veto bypass.
    return [{ k: 'var', name, raw: name }, j + 1]
  }
  const m = VAR_NAME.exec(src.slice(i + 1))
  if (m) return [{ k: 'var', name: m[0] }, i + 1 + m[0].length]
  return [{ k: 'lit', s: '$' }, i + 1] // a lone `$`
}

// Tokenize one command string. Returns { tokens } or throws ParseError.
function tokenize(src) {
  const tokens = []
  const heredocQueue = [] // { delim, stripTabs, quoted }
  let i = 0
  let parts = [] // parts of the word being built

  const flushWord = () => {
    if (parts.length > 0) { tokens.push({ t: 'word', parts }); parts = [] }
  }
  const pushLit = (s) => {
    const last = parts[parts.length - 1]
    if (last && last.k === 'lit') last.s += s
    else parts.push({ k: 'lit', s })
  }

  // After a newline, consume pending heredoc bodies up to their delimiters.
  // Unquoted-delimiter heredocs EXPAND — a `$(…)` in the body runs — so those
  // bodies are scanned for substitutions which the caller must vet.
  const heredocSubs = [] // collected {k:'cmdsub',inner} parts found in expanding heredoc bodies

  const consumeHeredocs = () => {
    while (heredocQueue.length > 0) {
      const { delim, stripTabs, quoted } = heredocQueue.shift()
      let found = false
      while (i <= src.length) {
        let lineEnd = src.indexOf('\n', i)
        if (lineEnd < 0) lineEnd = src.length
        let line = src.slice(i, lineEnd)
        const cmp = stripTabs ? line.replace(/^\t+/, '') : line
        if (cmp === delim) { i = Math.min(lineEnd + 1, src.length); found = true; break }
        if (!quoted) {
          // scan the body line for $(…) / `…` — these EXECUTE on expansion
          let k = 0
          while (k < line.length) {
            if (line.startsWith('$(', k) && !line.startsWith('$((', k)) {
              try {
                const [inner, after] = readBalancedParen(line, k + 2)
                heredocSubs.push({ k: 'cmdsub', inner }); k = after; continue
              } catch { throw new ParseError('unterminated substitution in heredoc body') }
            }
            if (line[k] === '`') {
              try {
                const [inner, after] = readBacktick(line, k + 1)
                heredocSubs.push({ k: 'cmdsub', inner }); k = after; continue
              } catch { throw new ParseError('unterminated backtick in heredoc body') }
            }
            k += 1
          }
        }
        if (lineEnd >= src.length) { i = src.length; break }
        i = lineEnd + 1
      }
      if (!found) throw new ParseError(`unterminated heredoc (<<${delim})`)
    }
  }

  while (i < src.length) {
    const c = src[i]

    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue } // line continuation
      if (src[i + 1] === undefined) throw new ParseError('trailing backslash')
      pushLit(src[i + 1]); i += 2; continue
    }

    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      if (end < 0) throw new ParseError('unterminated single quote')
      pushLit(src.slice(i + 1, end)); i = end + 1
      // mark that this word had quoting (an empty '' still makes a word)
      if (parts.length === 0) parts.push({ k: 'lit', s: '' })
      continue
    }

    if (c === '"') {
      i += 1
      if (parts.length === 0) parts.push({ k: 'lit', s: '' })
      while (i < src.length && src[i] !== '"') {
        const d = src[i]
        if (d === '\\') {
          const n = src[i + 1]
          if (n === undefined) throw new ParseError('unterminated double quote')
          if (n === '"' || n === '\\' || n === '$' || n === '`') { pushLit(n); i += 2 }
          else { pushLit('\\' + n); i += 2 }
          continue
        }
        if (d === '$') { const [p, ni] = readDollar(src, i); parts.push(p); i = ni; continue }
        if (d === '`') { const [inner, ni] = readBacktick(src, i + 1); parts.push({ k: 'cmdsub', inner }); i = ni; continue }
        pushLit(d); i += 1
      }
      if (i >= src.length) throw new ParseError('unterminated double quote')
      i += 1; continue
    }

    if (c === '$' && src[i + 1] === "'") {
      const [text, ni] = readAnsiC(src, i + 2)
      pushLit(text); i = ni; continue
    }

    if (c === '$') { const [p, ni] = readDollar(src, i); parts.push(p); i = ni; continue }
    if (c === '`') { const [inner, ni] = readBacktick(src, i + 1); parts.push({ k: 'cmdsub', inner }); i = ni; continue }

    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const [inner, ni] = readBalancedParen(src, i + 2)
      parts.push({ k: 'procsub', inner, dir: c }); i = ni; continue
    }

    if (isSpace(c)) { flushWord(); i += 1; continue }

    if (c === '#' && parts.length === 0) { // comment to end of line
      let end = src.indexOf('\n', i)
      if (end < 0) end = src.length
      i = end; continue
    }

    if (isOpStart(c)) {
      flushWord()
      // multi-char operators first
      const three = src.slice(i, i + 3)
      const two = src.slice(i, i + 2)
      if (three === '<<<') { tokens.push({ t: 'op', op: '<<<' }); i += 3; continue }
      // `&>>` (append BOTH stdout+stderr) — a real redirect-to-file, so the
      // target must be write-checked, not misread as `&>` + a dangling `>`.
      if (three === '&>>') { tokens.push({ t: 'op', op: '>>' }); i += 3; continue }
      if (two === '<<') {
        const stripTabs = src[i + 2] === '-'
        let j = i + 2 + (stripTabs ? 1 : 0)
        while (j < src.length && isSpace(src[j])) j += 1
        // read the delimiter word (may be quoted)
        let delim = ''
        let quoted = false
        while (j < src.length && !isSpace(src[j]) && !isOpStart(src[j])) {
          const d = src[j]
          if (d === "'") { const e = src.indexOf("'", j + 1); if (e < 0) throw new ParseError('bad heredoc delimiter'); delim += src.slice(j + 1, e); quoted = true; j = e + 1; continue }
          if (d === '"') { const e = src.indexOf('"', j + 1); if (e < 0) throw new ParseError('bad heredoc delimiter'); delim += src.slice(j + 1, e); quoted = true; j = e + 1; continue }
          if (d === '\\') { delim += src[j + 1] ?? ''; quoted = true; j += 2; continue }
          delim += d; j += 1
        }
        if (delim === '') throw new ParseError('missing heredoc delimiter')
        heredocQueue.push({ delim, stripTabs, quoted })
        // Emit an input-redirect marker so the command analyzer can SEE that this
        // command reads from a heredoc (the body is consumed separately, below,
        // into heredocSubs). Without it, `python3 <<EOF … EOF` looked argument-less
        // and slipped the "interpreter reads its program from stdin" check. `<<`
        // carries no following target word (the delimiter was just consumed), so
        // splitCommands records it as a self-contained input, not a redir+target.
        tokens.push({ t: 'op', op: '<<' })
        i = j
        continue
      }
      if (two === '&&' || two === '||' || two === ';;' || two === '>>' || two === '>|' || two === '&>' || two === '<&' || two === '>&') {
        if (two === '<&' || two === '>&') {
          // `2>&1` / `>&2` are fd duplication — consume the digit/`-` operand.
          // But `>& file` (the legacy stdout+stderr redirect) has NO digit
          // operand: treat it as `&>` so the file target is checked, not
          // silently swallowed into argv.
          let j = i + 2
          let sawFd = false
          while (j < src.length && (src[j] === '-' || (src[j] >= '0' && src[j] <= '9'))) { j += 1; sawFd = true }
          if (sawFd || two === '<&') { tokens.push({ t: 'op', op: 'dupfd' }); i = j; continue }
          tokens.push({ t: 'op', op: '&>' }); i += 2; continue
        }
        tokens.push({ t: 'op', op: two === ';;' ? ';' : two }); i += 2; continue
      }
      if (c === '\n') {
        tokens.push({ t: 'op', op: '\n' })
        i += 1
        consumeHeredocs()
        continue
      }
      tokens.push({ t: 'op', op: c }); i += 1; continue
    }

    pushLit(c); i += 1
  }
  flushWord()
  if (heredocQueue.length > 0) {
    // Command ended without a newline: `cat <<EOF` with no body — the shell
    // would wait for more input; for a one-shot Bash tool call this is an
    // unterminated construct.
    throw new ParseError('unterminated heredoc')
  }
  return { tokens, heredocSubs }
}

// ────────────────────────────────────────────────────────────────────────────
// Word helpers
// ────────────────────────────────────────────────────────────────────────────

const wordIsLiteral = (w) => w.parts.every((p) => p.k === 'lit')
const wordText = (w) => w.parts.map((p) => (p.k === 'lit' ? p.s : ' ')).join('') // \0 marks dynamic spans
const literalText = (w) => (wordIsLiteral(w) ? w.parts.map((p) => p.s).join('') : null)
const wordHasExpansion = (w) => w.parts.some((p) => p.k !== 'lit')

// Scan a raw string for embedded command substitutions ($(…) / `…` / $((…)))
// and return their inner command texts. Used for the substitution-bearing spans
// a naive part list MISSES: a parameter-expansion word side (${x:-$(rm)}) and an
// arithmetic body ($(($(rm)))). Scanned RAW (quotes not tracked) so a dangerous
// sub can't hide behind quoting inside the expansion — over-catching a quoted
// benign sub only adds a deny, which fail-closed policy accepts. Nested subs are
// found because readBalancedParen returns the FULL inner, which the caller then
// re-scans via the recursive analyzeBash it runs on each result.
function extractCmdSubs(text) {
  const inners = []
  let k = 0
  while (k < text.length) {
    if (text.startsWith('$((', k)) {
      try { const [inner, after] = readBalancedParen(text, k + 3); inners.push(inner); k = text[after] === ')' ? after + 1 : after; continue } catch { break }
    }
    if (text.startsWith('$(', k)) {
      try { const [inner, after] = readBalancedParen(text, k + 2); inners.push(inner); k = after; continue } catch { break }
    }
    if (text[k] === '`') {
      try { const [inner, after] = readBacktick(text, k + 1); inners.push(inner); k = after; continue } catch { break }
    }
    k += 1
  }
  return inners
}

// Every substitution a word runs: the direct $()/`…`/<()/>() parts, PLUS the
// command-subs embedded in a ${…} word side or a $((…)) arithmetic body (their
// `raw` text). Each entry is {inner} — a command string to vet recursively.
const wordSubs = (w) => {
  const out = []
  for (const p of w.parts) {
    if (p.k === 'cmdsub' || p.k === 'procsub') out.push({ inner: p.inner })
    else if ((p.k === 'var' || p.k === 'arith') && typeof p.raw === 'string') {
      for (const inner of extractCmdSubs(p.raw)) out.push({ inner })
    }
  }
  return out
}

// The trailing run of LITERAL characters of a word — the suffix after its last
// dynamic (var/sub) part. For `$SNAP:main` → ":main"; for `v1.2.3` → "v1.2.3";
// for `$X` → "". Used to vet a COMPUTED git refspec's DESTINATION: `<sha>:main`
// (the release runbook's FF snapshot) has a computed source but a literal `:main`
// tail, and a non-force push to main can only fast-forward — safe to allow even
// though the whole word is non-literal.
const wordLiteralTail = (w) => {
  let tail = ''
  for (let k = w.parts.length - 1; k >= 0; k -= 1) {
    if (w.parts[k].k === 'lit') tail = w.parts[k].s + tail
    else break
  }
  return tail
}

// Expand a leading ~ / ~/ to HOME so path reasoning sees one form.
const tildeExpand = (s, home) => {
  if (s === '~') return home
  if (s.startsWith('~/')) return home + s.slice(1)
  return s
}

// Any tilde form (`~`, `~/…`, `~user`, `~user/…`), an absolute path, or a
// parent traversal is "absolute-ish" — i.e. NOT trivially inside the cwd — so
// the write/rm rules resolve + policy-check it instead of assuming it's local.
const isAbsoluteish = (s) => s.startsWith('/') || s.startsWith('~') || s === '..' || s.startsWith('../') || s.includes('/../') || s.endsWith('/..')

// ────────────────────────────────────────────────────────────────────────────
// Analyzer
// ────────────────────────────────────────────────────────────────────────────

const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'csh', 'tcsh', 'fish'])
const CODE_INTERPRETERS = new Set(['node', 'nodejs', 'deno', 'bun', 'python', 'python2', 'python3', 'perl', 'ruby', 'php'])
const INLINE_CODE_FLAGS = new Set(['-e', '-c', '-p', '--eval', '--print', '-E'])
// PER-interpreter inline-code (eval) flags. The same letter differs by language:
// python `-c`=eval but `-E`=ignore-env; ruby `-e`=eval but `-c`=syntax-check &
// `-E`=encoding; perl `-e`/`-E`=eval but `-c`=compile-check; php `-r`=eval but
// `-c`=ini-file. A uniform set false-blocks the non-eval uses.
const INLINE_EVAL_FLAGS = {
  node: new Set(['-e', '--eval', '-p', '--print']),
  nodejs: new Set(['-e', '--eval', '-p', '--print']),
  deno: new Set(['-e', '--eval', '-p', '--print']),
  bun: new Set(['-e', '--eval', '-p', '--print']),
  python: new Set(['-c']),
  python2: new Set(['-c']),
  python3: new Set(['-c']),
  perl: new Set(['-e', '-E']),
  ruby: new Set(['-e']),
  php: new Set(['-r']),
}
// Wrappers that forward to an inner command: strip and re-inspect the target.
// busybox/toybox are multi-call binaries — `busybox rm -rf /` runs the rm applet.
const WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'nice', 'stdbuf', 'time', 'caffeinate', 'arch', 'setsid', 'busybox', 'toybox'])

// The dangerous coreutils whose GNU builds ship under a `g`-prefix via Homebrew
// (`grm`/`gsed`/`gtar`/`gcp`/…). Map the prefixed name back so the switch's
// rm/tar/cp/… rules fire — WITHOUT stripping `g` off unrelated commands
// (`grep`→`rep`, `git`→`it`, `go`, `gzip` all stay themselves because their tail
// is not in this set).
const G_PREFIXED = new Set(['rm', 'sed', 'tar', 'cp', 'mv', 'chmod', 'chown', 'dd', 'ln', 'install', 'truncate', 'shred', 'find', 'awk', 'cpio'])
const normalizeCmdName = (name) => {
  if (name.length > 1 && name[0] === 'g' && G_PREFIXED.has(name.slice(1))) return name.slice(1)
  return name
}

// Dispatch closure by INVERSION (fail-CLOSED). `xargs <verb>` and
// `find … -exec <verb>` feed the verb targets the guard can't inspect (stdin
// items for xargs; the matched files under the start point for find). A DENYLIST
// of "destructive verbs" fails OPEN on anything omitted — an in-place editor
// (`sed -i`, `gawk -i inplace`), a niche tool, a wrapper name read as the verb.
// So instead we ALLOW only a conservative set of verbs that provably cannot
// mutate a file given as an argument (they read + write stdout), and DENY every
// other verb (destructive, unknown, interpreter, editor, git, wrapper). A
// confined worker that needs to WRITE bulk files uses `find <in-roots> -exec …`
// (a guard-visible start point) or names the paths directly — both inspectable.
const XARGS_READONLY = new Set([
  // readers + hashers (read files / stdin → stdout; never write a file arg).
  // NB: `xxd IN OUT` (2nd arg = output file), macOS `base64 -o`, and `sort -o`
  // can WRITE — deliberately EXCLUDED from this read-only set.
  'cat', 'tac', 'nl', 'head', 'tail', 'wc', 'cksum', 'sum', 'strings', 'od', 'hexdump',
  'md5', 'md5sum', 'shasum', 'sha1sum', 'sha224sum', 'sha256sum', 'sha384sum', 'sha512sum', 'b2sum',
  // search — plain matchers with NO command-exec option. EXCLUDED on purpose:
  // rg (ripgrep `--pre CMD`), ag/ack (`--pager CMD`) RUN an external command per
  // file → NOT read-only; and script-wrapper matchers (zgrep) that shell out.
  'grep', 'egrep', 'fgrep', 'pcregrep', 'look',
  // path / metadata (read-only)
  'ls', 'stat', 'file', 'basename', 'dirname', 'realpath', 'readlink', 'du', 'wc',
  // compare (read two inputs → stdout). EXCLUDED colordiff (a perl-script wrapper).
  'diff', 'cmp', 'comm',
  // stdout-only text transforms (no file write)
  'cut', 'tr', 'rev', 'fold', 'fmt', 'expand', 'unexpand', 'column', 'paste', 'join', 'pr', 'tsort',
  // trivial / no file effect
  'echo', 'printf', 'true', 'false', 'test', 'seq', 'yes', 'date',
])

function denyV(reason) { return { decision: 'deny', reason } }
const ALLOW = { decision: 'allow' }

// Scan a sed PROGRAM (the -e value or the positional script) for its own
// write/exec commands — the sed analogue of the awk scan, so a LITERAL
// `sed -n 'w /etc/x'` / `sed 's/a/b/w /etc/x'` / GNU `sed 'e cmd'` is caught in
// L4 (not left to the owner-only/default-off L3). Returns
// { exec: bool, writeTargets: (string|null)[] } — null = a path the guard can't
// read (fail-closed at the caller). It walks the program skipping the spans that
// can CONTAIN a `w`/`e` letter without it being a command — `s<d>…<d>…<d>`,
// `y<d>…<d>…<d>`, and `/regex/`|`\cREc` addresses — so `sed 's/w/x/'` (w in the
// regex) and `sed 's/a/w/'` (w in the replacement) do NOT false-trigger.
function scanSedProgram(prog) {
  const n = prog.length
  let i = 0
  let exec = false
  const writeTargets = []
  // Skip a delimited body starting at j (AFTER the opening delim), returning the
  // index just past the closing delim. Escaped delimiters (\<d>) don't close.
  const skipBody = (j, d) => {
    while (j < n) {
      if (prog[j] === '\\') { j += 2; continue }
      if (prog[j] === d) return j + 1
      j += 1
    }
    return n
  }
  while (i < n) {
    const c = prog[i]
    if (c === ';' || c === '\n' || c === ' ' || c === '\t' || c === '{' || c === '}' || c === '!') { i += 1; continue }
    // addresses: /regex/, \cREGEXc, line numbers, $, ranges, step (~), +N
    if (c === '/') { i = skipBody(i + 1, '/'); continue }
    if (c === '\\') { const d = prog[i + 1]; i = d === undefined ? n : skipBody(i + 2, d); continue }
    if (c >= '0' && c <= '9') { i += 1; continue }
    if (c === '$' || c === ',' || c === '+' || c === '~') { i += 1; continue }
    // commands
    if (c === 's' || c === 'y') {
      const d = prog[i + 1]
      if (d === undefined) { i = n; break }
      let j = skipBody(i + 2, d) // regex / from-set
      j = skipBody(j, d) // replacement / to-set
      // flags run to the next command separator
      let flags = ''
      while (j < n && ![';', '\n', ' ', '\t', '}'].includes(prog[j])) { flags += prog[j]; j += 1 }
      if (c === 's') {
        if (/[eE]/.test(flags)) exec = true // s///e executes the result
        const wIdx = flags.search(/[wW]/)
        if (wIdx >= 0) {
          // in `s/a/b/[nums|g|p]*[wW] filename` the FILENAME is the rest of the
          // line after the w flag (sed reads it to end-of-line, incl. spaces).
          let k = i // recover the whole s-command line to slice the filename
          // find the filename portion: it's everything after the w flag char in
          // the ORIGINAL text — re-locate by walking from the flags' start.
          const filename = flags.slice(wIdx + 1).replace(/^\s+/, '')
          // flags may have stopped at the first space, so also take the rest of
          // the physical line as the filename (w's arg extends to newline).
          let rest = ''
          let m = j
          while (m < n && prog[m] !== '\n') { rest += prog[m]; m += 1 }
          const full = (filename + rest).trim()
          writeTargets.push(full.length ? full : null)
          j = m
          void k
        }
      }
      i = j
      continue
    }
    if (c === 'w' || c === 'W') {
      // filename is the rest of the physical line (sed's `w` reads to newline).
      let j = i + 1
      while (j < n && (prog[j] === ' ' || prog[j] === '\t')) j += 1
      let fname = ''
      while (j < n && prog[j] !== '\n') { fname += prog[j]; j += 1 }
      writeTargets.push(fname.trim() || null)
      i = j
      continue
    }
    if (c === 'e') { exec = true; let j = i + 1; while (j < n && prog[j] !== '\n') j += 1; i = j; continue }
    if (c === 'r' || c === 'R') { let j = i + 1; while (j < n && prog[j] !== '\n') j += 1; i = j; continue } // read — not a write
    if (c === 'a' || c === 'i' || c === 'c') { // append/insert/change text
      let j = i + 1
      while (j < n && prog[j] !== '\n') { if (prog[j] === '\\') j += 1; j += 1 }
      i = j
      continue
    }
    // every other command letter (p d n N P D g G h H x l = q Q z F b t T : #)
    i += 1
  }
  return { exec, writeTargets }
}

// Split token stream into simple commands. Returns array of
// { words: word[], redirs: [{op, target|null}], pipedFromPrev: bool }.
// `(` / `)` group boundaries behave as separators (contents are inspected the
// same; cd-tracking snapshots around them).
function splitCommands(tokens) {
  const cmds = []
  let cur = { words: [], redirs: [], inputs: [], pipedFromPrev: false, opensGroup: 0, closesGroup: 0 }
  let expectRedirTarget = null
  let nextPiped = false
  const flush = () => {
    // Keep even word-less commands when they carry group markers, so the
    // cd-tracking group stack in analyzeBash pushes/pops symmetrically for
    // `(cd /tmp)`-style subshells.
    if (cur.words.length > 0 || cur.redirs.length > 0 || cur.opensGroup > 0 || cur.closesGroup > 0) {
      cur.pipedFromPrev = nextPiped
      cmds.push(cur)
      nextPiped = false
    }
    cur = { words: [], redirs: [], inputs: [], pipedFromPrev: false, opensGroup: 0, closesGroup: 0 }
  }
  for (const tk of tokens) {
    if (tk.t === 'op') {
      // A redirection operator followed by another operator (`echo > ; rm x`)
      // is a shell syntax error — but if we silently dropped the dangling
      // redirection, the NEXT word (`rm`) would be consumed as its target and
      // escape command analysis. Fail closed instead.
      if (expectRedirTarget) throw new ParseError('redirection with no target')
      if (tk.op === '>' || tk.op === '>>' || tk.op === '>|' || tk.op === '&>' || tk.op === '<' || tk.op === '<<<') {
        expectRedirTarget = tk.op
        continue
      }
      if (tk.op === '<<') {
        // heredoc: a self-contained input (its delimiter + body were already
        // consumed by the tokenizer). Record an INERT empty word so the interpreter
        // "reads its program from stdin" check sees a stdin source; it expects NO
        // following target word, so do not arm expectRedirTarget. Empty parts keep
        // it safe for the substitution sweep (the body's subs are vetted separately).
        cur.inputs.push({ t: 'word', parts: [] })
        continue
      }
      if (tk.op === 'dupfd') continue
      if (tk.op === '|') { flush(); nextPiped = true; continue }
      if (tk.op === ';' || tk.op === '\n' || tk.op === '&' || tk.op === '&&' || tk.op === '||') { flush(); continue }
      if (tk.op === '(') { flush(); cur.opensGroup += 1; continue }
      if (tk.op === ')') { flush(); cur.closesGroup += 1; continue }
      continue
    }
    // word
    if (expectRedirTarget) {
      if (expectRedirTarget !== '<' && expectRedirTarget !== '<<<') {
        cur.redirs.push({ op: expectRedirTarget, target: tk })
      } else {
        // INPUT redirect (`< file` / `<<< herestring` / `< <(cmd)`): the target
        // is READ, not written — so it is NOT write-checked, but bash STILL
        // expands it, running any $()/`…`/<() inside (`cat < $(rm -rf /)`). Keep
        // it so step-1 sub-vetting sees it; dropping it entirely was a bypass.
        cur.inputs.push(tk)
      }
      expectRedirTarget = null
      continue
    }
    // a pure-digit word immediately before a redirection op is an fd number;
    // splitCommands sees it as a word — harmless (it becomes an argv word), the
    // analyzer treats unknown words conservatively anyway.
    cur.words.push(tk)
  }
  if (expectRedirTarget) throw new ParseError('redirection with no target')
  flush()
  return cmds
}

// Strip leading VAR=value assignments; returns { assignments, rest, subParts }.
function stripAssignments(words) {
  const assignments = []
  const subParts = []
  let idx = 0
  while (idx < words.length) {
    const w = words[idx]
    const txt = wordText(w)
    const eq = txt.indexOf('=')
    // an assignment word: NAME=… where NAME is a valid identifier BEFORE any
    // dynamic span ( )
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(txt.slice(0, eq))) {
      assignments.push(w)
      for (const p of wordSubs(w)) subParts.push(p)
      idx += 1
      continue
    }
    break
  }
  return { assignments, rest: words.slice(idx), subParts }
}

// Strip wrapper commands (nohup, command, timeout 5, env A=B, sudo → deny …).
// Returns { words, denied } — denied is a verdict or null.
function stripWrappers(words) {
  let ws = words
  for (let guard = 0; guard < 8; guard += 1) {
    if (ws.length === 0) return { words: ws, denied: null }
    const w0 = ws[0]
    if (!wordIsLiteral(w0)) return { words: ws, denied: null } // dynamic cmd0 — handled by caller
    const name = path.basename(literalText(w0))
    if (name === 'sudo' || name === 'doas') return { words: ws, denied: denyV('sudo/doas is never allowed in a guarded session') }
    if (name === 'env') {
      // env [-i] [VAR=v…] cmd …
      let j = 1
      while (j < ws.length) {
        const t = wordText(ws[j])
        if (t.startsWith('-')) { j += 1; continue }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { j += 1; continue }
        break
      }
      ws = ws.slice(j); continue
    }
    if (name === 'timeout') {
      // timeout [opts] DURATION cmd …
      let j = 1
      while (j < ws.length && wordText(ws[j]).startsWith('-')) j += 1
      if (j < ws.length && /^[0-9]/.test(wordText(ws[j]))) j += 1
      ws = ws.slice(j); continue
    }
    if (WRAPPERS.has(name)) {
      let j = 1
      while (j < ws.length && wordText(ws[j]).startsWith('-')) j += 1
      ws = ws.slice(j); continue
    }
    return { words: ws, denied: null }
  }
  return { words: ws, denied: null }
}

// Does a literal flag-word bundle contain a given short letter? ("-rf" ⊃ r)
const bundleHas = (txt, letter) => /^-[A-Za-z]+$/.test(txt) && txt.includes(letter)

// Path-permission helper set up per evaluation.
function makePathPolicy(env, payloadCwd) {
  const home = env.HOME || os.homedir()
  const rootsRaw = env.OPENGROUND_GUARD_WRITE_ROOTS || ''
  const roots = rootsRaw
    .split(':')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => path.resolve(tildeExpand(s, home)))
  const confined = roots.length > 0

  // Shared scratch space every claude needs (mirrors sandbox.ts writeSubpaths).
  const commonWrite = [
    '/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp',
    '/var/folders', '/private/var/folders',
    path.join(home, '.claude', 'projects'), // auto-memory (instruction files, not code)
    path.join(home, '.openground', 'swarm'), // heartbeat files
  ]

  // The guard's own substrate — write-denied ALWAYS (even unconfined managers),
  // mirroring swarm-guard.sh's tier-2 list. Editing any of these from a guarded
  // session could disable the veto itself.
  const substratePrefixes = [
    path.join(home, '.openground', 'guard'),
    path.join(home, '.claude', 'hooks'),
  ]
  const substrateLiterals = [
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.local.json'),
    path.join(home, '.claude', 'CLAUDE.md'),
    path.join(home, '.openground', 'settings.json'), // the validateProjectPath allowlist
  ]
  const substrateBasenames = ['openground-guard.js', 'openground-hook.js']
  const substrateHomeGlobs = [/\/\.claude\/(swarm-[^/]*\.sh|og-[^/]*\.sh|test-swarm-safety\.sh)$/]

  const isUnder = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/')

  const resolveFrom = (baseCwd, raw) => {
    let s = tildeExpand(raw, home)
    // A surviving leading `~` means `~otheruser[/…]` — bash expands it to that
    // user's home (e.g. ~root → /var/root), which we can't reliably resolve and
    // which is NEVER inside the worktree roots. Anchor it under a sentinel that
    // no root can contain, so writeAllowed()/isSubstrate() treat it as outside
    // (fail-closed) rather than joining it onto cwd and reading it as local.
    if (s.startsWith('~')) return path.join('/ otherhome', s.slice(1))
    if (!path.isAbsolute(s)) s = path.resolve(baseCwd || payloadCwd || process.cwd(), s)
    else s = path.resolve(s)
    return s
  }
  // Resolve against the current tracked cwd (baseCwd) so a relative target after
  // a `cd` is judged from where the shell actually is. resolveTarget = payload.cwd.
  const resolveTarget = (raw) => resolveFrom(undefined, raw)

  return {
    home,
    roots,
    confined,
    // baseCwd = the current tracked cwd (after any `cd`); relative names resolve
    // against it so `cd ~/.claude && rm settings.json` is caught. Substrate is
    // off-limits in EVERY guarded session (confined or not).
    isSubstrate(rawPath, baseCwd) {
      const p = resolveFrom(baseCwd, rawPath)
      if (substrateLiterals.includes(p)) return true
      if (substratePrefixes.some((r) => isUnder(p, r))) return true
      if (substrateBasenames.includes(path.basename(p))) return true
      if (substrateHomeGlobs.some((re) => re.test(p)) && isUnder(p, path.join(home, '.claude'))) return true
      return false
    },
    // Would a RECURSIVE delete rooted at rawPath reach substrate? True when the
    // resolved root IS a substrate path OR an ANCESTOR of one — so `rm -rf
    // ~/.claude`, `cd ~/.openground && rm -rf .`, `find ~ -delete` are caught even
    // though the container dir (~/.claude, ~/.openground, ~) is not itself a
    // "substrate" leaf. The substrate leaves are the guard's files + its dirs.
    containsSubstrate(rawPath, baseCwd) {
      const p = resolveFrom(baseCwd, rawPath)
      const substrateThings = [...substrateLiterals, ...substratePrefixes]
      const containers = [path.join(home, '.claude'), path.join(home, '.openground')]
      // (a) p is an ANCESTOR of / equal to a substrate file|dir → recursion reaches it.
      if (substrateThings.some((s) => isUnder(s, p))) return true
      // (b) p is a CONTAINER (or above one) holding substrate — but being merely
      //     INSIDE a container (e.g. ~/.claude/projects, the writable auto-memory)
      //     does NOT count.
      if (containers.some((c) => isUnder(c, p))) return true
      // (c) p is INSIDE an actual substrate dir (the guard dir, hooks).
      if (substratePrefixes.some((d) => isUnder(p, d))) return true
      return false
    },
    // The UNIFIED substrate predicate: does a destructive op on rawPath endanger
    // the veto? True for the substrate itself / a descendant (isSubstrate) OR an
    // ANCESTOR / container of it (containsSubstrate). Every destructive verb runs
    // this — one class, not per-verb combos. (Commander round-3 structural fix.)
    endangersSubstrate(rawPath, baseCwd) {
      return this.isSubstrate(rawPath, baseCwd) || this.containsSubstrate(rawPath, baseCwd)
    },
    // May this session write to rawPath? (only meaningful when confined)
    writeAllowed(rawPath, baseCwd) {
      const p = resolveFrom(baseCwd, rawPath)
      if (p === '/dev/null' || p === '/dev/stdout' || p === '/dev/stderr' || p.startsWith('/dev/fd/')) return true
      if (this.roots.some((r) => isUnder(p, r))) return true
      if (commonWrite.some((r) => isUnder(p, r))) return true
      return false
    },
    // The cwdState to SEED a command with. A confined session whose actual cwd
    // (payload.cwd) is OUTSIDE the write roots must start 'outside', so a relative
    // `rm x` / `echo > y` there is judged against the true location — closing the
    // multi-Bash-call `cd /outside` escape (the `cd` in one call, the destructive
    // relative op in the next, whose payload.cwd is the escaped dir). When cwd is
    // unknown (no payload.cwd) we DON'T over-deny — the normal worker cwd is the
    // worktree (in roots). (rev-bypass follow-up D.)
    initialCwdState() {
      if (!confined) return 'inside'
      if (typeof payloadCwd !== 'string' || payloadCwd.length === 0) return 'inside'
      return this.writeAllowed(resolveTarget('.')) ? 'inside' : 'outside'
    },
    // The starting cwd (resolved payload.cwd), the seed for cd tracking.
    initialCwdPath() { return resolveTarget('.') },
    resolveTarget,
    resolveFrom,
  }
}

// Analyze one command string (recursively, for substitutions).
// ctx: { policy, isManager, depth }
function analyzeBash(cmdText, ctx) {
  if (ctx.depth > 6) return denyV('substitutions nested too deep to analyze')
  let lexed
  let cmds
  try {
    lexed = tokenize(cmdText)
    cmds = splitCommands(lexed.tokens)
  } catch (e) {
    return denyV(`command could not be parsed (${e.message}) — the guard denies what it cannot read; write the command in a plain, direct form`)
  }

  // Any $(…)/`…` found in an EXPANDING heredoc body executes: vet it.
  for (const sub of lexed.heredocSubs) {
    const v = analyzeBash(sub.inner, { ...ctx, depth: ctx.depth + 1 })
    if (v.decision === 'deny') return v
  }

  // cd tracking. cwdState ('inside'|'outside'|'unknown') drives the CONFINED
  // write-roots logic; cwdPath (the actual resolved path) drives SUBSTRATE
  // resolution so a relative op after `cd` is judged from where the shell IS —
  // and, crucially, that tracking runs for the UNCONFINED manager too, so
  // `cd ~/.claude && rm settings.json` / `cd guard && rm -rf .` can't delete the
  // veto. Both are SEEDED from the real payload.cwd. groupStack saves/restores
  // across `( … )` subshells; pushdStack does the same for pushd/popd.
  let cwdState = ctx.policy.initialCwdState()
  let cwdPath = ctx.policy.initialCwdPath()
  // Expose the live cwd so checkWriteTargetText / the substrate checks resolve
  // relative names against it (the getter reads the CURRENT cwdPath closure var).
  ctx.getBaseCwd = () => cwdPath
  const groupStack = []
  const pushdStack = []
  const ctl = {
    get: () => cwdState,
    set: (s) => { cwdState = s },
    getPath: () => cwdPath,
    setPath: (p) => { cwdPath = p },
    push: () => pushdStack.push({ s: cwdState, p: cwdPath }),
    pop: () => {
      const x = pushdStack.pop()
      cwdState = x ? x.s : 'inside'
      cwdPath = x ? x.p : ctx.policy.initialCwdPath()
    },
  }

  for (const sc of cmds) {
    for (let g = 0; g < sc.opensGroup; g += 1) groupStack.push({ s: cwdState, p: cwdPath })
    const v = analyzeSimple(sc, ctx, ctl.get, ctl.set, ctl.push, ctl.pop, ctl.getPath, ctl.setPath)
    if (v.decision === 'deny') return v
    for (let g = 0; g < sc.closesGroup; g += 1) {
      const x = groupStack.pop()
      if (x) { cwdState = x.s; cwdPath = x.p }
    }
  }
  return ALLOW
}

function analyzeSimple(sc, ctx, getCwdState, setCwdState, pushCwd = () => {}, popCwd = () => {}, getCwdPath = () => undefined, setCwdPath = () => {}) {
  const { policy, isManager } = ctx

  // 1) every substitution ANYWHERE in the command runs first — vet inners.
  //    Covers argv words, redirection TARGETS (both output and input), so a
  //    `$(rm)` hidden in `cat < $(rm)` / `> $(rm)` / a ${…}/$((…)) span is vetted.
  const subCarriers = [...sc.words, ...sc.redirs.map((r) => r.target).filter(Boolean), ...(sc.inputs || [])]
  for (const w of subCarriers) {
    for (const p of wordSubs(w)) {
      const v = analyzeBash(p.inner, { ...ctx, depth: ctx.depth + 1 })
      if (v.decision === 'deny') return v
    }
  }

  // 2) redirection targets (writes)
  for (const r of sc.redirs) {
    const v = checkWriteTarget(r.target, ctx, getCwdState())
    if (v) return v
  }

  if (sc.words.length === 0) return ALLOW

  const { rest, subParts } = stripAssignments(sc.words)
  // assignment values already vetted via wordSubs above; subParts kept for clarity
  void subParts
  if (rest.length === 0) return ALLOW

  // Reserved-word prefixes: in `if rm -rf /; then` / `while …; do rm -rf /;
  // done`, the ACTUAL command sits after the keyword — without stripping,
  // cmd0 would be `do` and `rm` would sail through as its argument.
  let rest2 = rest
  for (let guard = 0; guard < 6; guard += 1) {
    if (rest2.length === 0) return ALLOW
    const head = wordIsLiteral(rest2[0]) ? literalText(rest2[0]) : null
    if (head === 'if' || head === 'elif' || head === 'while' || head === 'until' || head === 'then' || head === 'else' || head === 'do' || head === '!' || head === '{') {
      rest2 = rest2.slice(1)
      continue
    }
    if (head === 'for' || head === 'case' || head === 'select') return ALLOW // header line only; the body arrives via do/then
    if (head === 'done' || head === 'fi' || head === 'esac' || head === '}') return ALLOW
    break
  }

  const stripped = stripWrappers(rest2)
  if (stripped.denied) return stripped.denied
  const words = stripped.words
  if (words.length === 0) return ALLOW

  const w0 = words[0]

  // 3) command position must be LITERAL — `$CMD …`, `$(pick-a-cmd) …` and
  // friends are exactly the indirection a regex guard can't see through.
  if (!wordIsLiteral(w0)) {
    return denyV('command name is computed (variable/substitution in command position) — write the literal command instead')
  }
  const cmd0full = tildeExpand(literalText(w0), policy.home)
  const cmd0 = normalizeCmdName(path.basename(cmd0full))
  const args = words.slice(1)
  const argText = (w) => {
    const t = literalText(w)
    return t === null ? null : tildeExpand(t, policy.home)
  }

  // function definition: `name () { … }` reaches here as word `name` followed
  // by `(` `)` group ops — splitCommands turned those into group markers, so
  // detect the classic one-liner shape instead: a word ending in "()" or the
  // literal `function` keyword.
  if (cmd0 === 'function') return denyV('shell function definitions are not allowed in a guarded session')
  if (/\(\)\s*$/.test(wordText(w0)) || (args[0] && wordText(args[0]) === '()')) {
    return denyV('shell function definitions are not allowed in a guarded session')
  }

  // 4) stdin-is-the-program: an interpreter with NO script argument runs whatever
  // its stdin delivers — a pipe (`curl|sh`, `base64 -d|python`), a heredoc
  // (`python3 <<EOF … EOF`), a here-string (`node <<< code`), or an input redirect
  // (`python < prog`). The guard can't see that program (and for a non-shell
  // interpreter can't even parse the language), so it fails CLOSED. `-c`/`-e`
  // inline code is handled per-interpreter below; a script arg (`python x.py`,
  // `python -m pytest`) or a bare diagnostic (`python --version`) has no stdin
  // program and is unaffected.
  if (SHELL_INTERPRETERS.has(cmd0) || CODE_INTERPRETERS.has(cmd0)) {
    const stdinIsProgram = sc.pipedFromPrev || (Array.isArray(sc.inputs) && sc.inputs.length > 0)
    // A LITERAL, non-flag arg is the interpreter's script. A bare fd DIGIT is NOT
    // a script: `python3 0<<EOF` flushes the `0` (the redirect's fd) as its own
    // word, and counting it as a "script arg" defeated the stdin veto by simply
    // prefixing the redirect with its fd number (`<<` → `0<<`). Exclude `^\d+$`.
    const hasScriptArg = args.some((a) => {
      const t = argText(a)
      return t !== null && !t.startsWith('-') && !/^[0-9]+$/.test(t)
    })
    if (stdinIsProgram && !hasScriptArg) {
      return denyV(`${cmd0} reads its program from stdin (pipe/heredoc/here-string/redirect) — the guard cannot see it; run a script file the guard can read`)
    }
    // A code interpreter whose PROGRAM slot is COMPUTED — a process substitution
    // (`python3 <(echo code)` runs /dev/fd/N), a command substitution, or a bare
    // variable — runs generated code the guard can't read, so it fails CLOSED.
    // (A literal script arg means any computed word is mere data → allowed; shells
    // are already covered by the `case 'sh'/'bash'` computed-script rejection.)
    if (CODE_INTERPRETERS.has(cmd0) && !hasScriptArg && args.some((a) => {
      if (argText(a) !== null) return false
      const parts = a.parts || []
      const lit = parts.find((p) => p.k === 'lit')
      if (lit && lit.s.startsWith('-')) return false // a flag (possibly with a computed value)
      return parts.some((p) => p.k === 'procsub' || p.k === 'cmdsub' || p.k === 'var' || p.k === 'arith')
    })) {
      return denyV(`${cmd0} runs a computed / process-substitution program the guard cannot read — run a script file the guard can see`)
    }
  }

  // git's DASH-FORM binaries: every `git <sub>` is equally callable as
  // `git-<sub>` — the spellings live in git's libexec/git-core and run fine by
  // absolute path (`/usr/libexec/git-core/git-push origin main`), no PATH edit
  // needed. cmd0 is a BASENAME, so that call used to read as an unknown command
  // `git-push` and fall through to the default ALLOW, sidestepping analyzeGit
  // (the blanket push ban above all). Re-enter analyzeGit with the subcommand
  // restored: dash-form and driver-form then yield IDENTICAL verdicts —
  // git-push / git-send-pack / git-http-push hit the push ban, git-svn's
  // dcommit/branch/tag vetting sees its args, the destructive-flag rules
  // (git-reset --hard, git-branch -D, …) keep working, and read spellings
  // (git-status, git-log) stay allowed exactly like their driver forms.
  // Third-party git-* tools (git-lfs, git-flow) resolve to an unknown
  // subcommand → default ALLOW, the same verdict as `git lfs` / `git flow`.
  if (cmd0.startsWith('git-') && cmd0.length > 4) {
    return analyzeGit([{ t: 'word', parts: [{ k: 'lit', s: cmd0.slice(4) }] }, ...args], ctx, getCwdState)
  }

  switch (cmd0) {
    case 'eval':
      return denyV('eval executes computed text — write the command directly')
    case 'source':
    case '.':
      return denyV('source/. executes a file in-shell — run it as a plain script the guard can see, or inline the steps')
    case 'alias':
      if (args.length === 0) return ALLOW // listing aliases is harmless
      return denyV('defining aliases can disguise later commands — aliases are not allowed in a guarded session')
    case 'shopt': {
      const hasExpand = args.some((a) => argText(a) === 'expand_aliases')
      if (hasExpand) return denyV('enabling expand_aliases can disguise later commands')
      return ALLOW
    }
    case 'sh': case 'bash': case 'zsh': case 'dash': case 'ksh': case 'csh': case 'tcsh': case 'fish': {
      // -c always denied. The one allowed shape is a LITERAL script path under
      // ~/.claude/ (the swarm ops scripts — write-protected substrate):
      // `bash ~/.claude/swarm-beat.sh …` is the worker heartbeat. Once the
      // script is identified as allowed, its remaining argv is DATA (the
      // script is tamper-protected), so a computed heartbeat message is fine.
      let script = null
      for (const a of args) {
        const t = argText(a)
        if (t === null) {
          if (script === null) return denyV(`${cmd0} with a computed script argument — not analyzable`)
          continue // computed args AFTER an allowed script are data
        }
        if (t === '-c') return denyV(`${cmd0} -c executes an inline string the guard cannot see through — run the commands directly`)
        if (script === null && !t.startsWith('-')) script = t
      }
      if (script === null) return denyV(`bare ${cmd0} reads commands from stdin — run the commands directly`)
      const resolved = policy.resolveTarget(script)
      if (resolved.startsWith(path.join(policy.home, '.claude') + path.sep) && resolved.endsWith('.sh')) return ALLOW
      return denyV(`${cmd0} <script> hides the executed commands from the guard (only the write-protected ~/.claude/*.sh ops scripts are allowed) — run the steps directly`)
    }
    case 'node': case 'nodejs': case 'deno': case 'bun':
    case 'python': case 'python2': case 'python3': case 'perl': case 'ruby': case 'php': {
      // The SAME short flag means different things per interpreter, so the
      // inline-code (eval) set is PER-interpreter — a uniform set false-blocks
      // `ruby -c` (syntax check), `perl -c` (compile check), `python -E` (ignore
      // env), `php -c` (ini file), none of which run inline code.
      const evalFlags = INLINE_EVAL_FLAGS[cmd0] || new Set(['-e', '-c'])
      const isPerlish = cmd0 === 'perl' || cmd0 === 'ruby'
      let perlInPlace = false
      for (const a of args) {
        const t = argText(a)
        if (t === null) continue
        if (evalFlags.has(t)) {
          return denyV(`${cmd0} ${t} runs inline code the guard cannot see through — put it in a project script file and run that`)
        }
        // perl/ruby BUNDLE flags: -pe / -ne / -nE carry inline code via a
        // following (or bundled) expression. `-i` (alone or `-i.bak`) means
        // in-place FILE writes. `-c` (compile-check) and `-w`/`-n`/`-p` alone
        // are NOT eval, so only a bundle that INCLUDES e/E (and isn't bare -e)
        // is inline code.
        if (isPerlish && /^-[A-Za-z]+(\.[A-Za-z]*)?$/.test(t)) {
          const flagLetters = t.replace(/^-/, '').split('.')[0]
          if (/[eE]/.test(flagLetters) && t !== '-e' && t !== '-E') {
            return denyV(`${cmd0} ${t} runs inline code (bundled -e) the guard cannot see through — use a script file`)
          }
          if (flagLetters.includes('i')) perlInPlace = true
        }
      }
      if (perlInPlace) {
        // every non-flag path arg is an in-place write target. A COMPUTED one
        // (variable/substitution) is denied — symmetric with `rm`/`sed -i`: we
        // can't tell what file it rewrites, so `perl -i.bak edit.pl "$D/hosts"`
        // must not slip. This closes it in L4 itself, not relying on the
        // owner-only (default-off) L3 sandbox.
        for (let k = 0; k < args.length; k += 1) {
          const t = argText(args[k])
          if (t === null) return denyV(`${cmd0} -i with a computed file target — the guard cannot tell what would be rewritten`)
          if (t.startsWith('-')) continue
          const v = checkWriteTargetText(t, ctx, getCwdState())
          if (v) return v
        }
      }
      return ALLOW
    }
    case 'xargs': {
      // find the verb xargs will run
      let j = 0
      while (j < args.length) {
        const t = argText(args[j])
        if (t === null) return denyV('xargs with a computed argument — not analyzable')
        if (t.startsWith('-')) {
          // value-taking flags consume the NEXT word too, else the flag's value is
          // misread as the verb (`xargs -a listfile chmod` → verb read as listfile).
          const valueFlag = ['-a', '-d', '-I', '-i', '-n', '-P', '-s', '-E', '-L',
            '--arg-file', '--delimiter', '--replace', '--max-args', '--max-procs', '--max-chars', '--eof'].includes(t)
          j += valueFlag ? 2 : 1
          continue
        }
        break
      }
      if (j >= args.length) return denyV('bare xargs defaults to echo but its input is unbounded — name the command explicitly')
      // Strip wrappers (env/nice/nohup/timeout/setsid/busybox/…; sudo/doas → deny)
      // BEFORE reading the verb — `xargs env chmod` / `xargs nice rm` must be seen
      // as chmod / rm, not the harmless-looking wrapper name.
      const xsw = stripWrappers(args.slice(j))
      if (xsw.denied) return xsw.denied
      if (xsw.words.length === 0) return ALLOW
      const vtext = argText(xsw.words[0])
      if (vtext === null) return denyV('xargs runs a computed command — not analyzable')
      const verb = path.basename(vtext)
      // xargs appends STDIN items as arguments the guard can't see. ALLOW only a
      // verb that provably can't mutate a file given as an argument; DENY every
      // other one — a destructive verb, an in-place editor (`sed -i`/`gawk -i`),
      // an interpreter, git, sudo, or an unrecognized / wrapper name. Fail-CLOSED
      // by INVERSION (a denylist would leak every omitted write-capable verb).
      if (!XARGS_READONLY.has(verb)) {
        return denyV(`xargs ${verb} may act on stdin-supplied targets the guard cannot inspect — run it on named paths, or use \`find <in-roots> -exec …\``)
      }
      return ALLOW
    }
    case 'find': {
      // deny -delete / -exec <danger> on absolute/parent start points
      const txts = args.map((a) => argText(a))
      if (txts.some((t) => t === null)) return denyV('find with a computed argument — not analyzable')
      const hasDelete = txts.includes('-delete')
      const startPoints = []
      for (const t of txts) {
        if (t.startsWith('-')) break
        startPoints.push(t)
      }
      const outsideStart = startPoints.some((t) => {
        // a start point that IS or CONTAINS substrate (cd-resolved) → deny in EVERY
        // session, so `cd guard && find . -delete` / `find ~/.claude -delete` can't
        // nuke the veto (the container ~/.claude holds settings.json etc.).
        // A relative start point after a COMPUTED cd (cwd unknown) is fail-closed.
        if (!isAbsoluteish(t) && getCwdPath() === undefined) return true
        if (policy.endangersSubstrate(t, getCwdPath())) return true
        if (!isAbsoluteish(t)) return getCwdState() !== 'inside'
        if (!policy.confined) return true // manager-mode: any absolute start point with -delete/-exec rm is the swarm-guard rule
        return !policy.writeAllowed(t, getCwdPath())
      })
      // find runs EVERY -exec/-execdir/-ok/-okdir clause — a benign first clause
      // must not shield a destructive SECOND one (`find X -exec echo \; -exec rm {} \;`).
      // Analyze each clause independently.
      const EXEC_KW = new Set(['-exec', '-execdir', '-ok', '-okdir'])
      for (let i = 0; i < args.length; i += 1) {
        if (!EXEC_KW.has(argText(args[i]))) continue
        // this clause spans from after the keyword up to its ; or + terminator
        let end = i + 1
        while (end < args.length) { const tt = argText(args[end]); if (tt === ';' || tt === '+') break; end += 1 }
        // KEEP `{}` (drop only the ;/+ terminator) so a multi-positional verb like
        // `cp {} DEST` / `mv {} DEST` still presents its DESTINATION to the write
        // checks in analyzeSimple below — filtering `{}` out dropped a positional
        // and hid the dest (`cp {} ~/.openground/guard/…`). `{}` itself resolves to
        // an in-roots relative name (a harmless source).
        const rawClause = args.slice(i + 1, end).filter((a) => { const t = argText(a); return t !== ';' && t !== '+' })
        // Strip wrappers (env/nice/nohup/…; sudo/doas → deny) BEFORE reading the verb.
        const sw = stripWrappers(rawClause)
        if (sw.denied) return sw.denied
        const clause = sw.words
        i = end // resume after this clause's terminator (don't re-scan its words)
        if (clause.length === 0) continue
        // the clause's OWN literal write targets (cp/mv/install DEST, sed -i file…)
        // are checked here; `{}` resolves in-roots so this misses the find-supplied
        // targets — the outsideStart gate below covers those.
        const v = analyzeSimple({ words: clause, redirs: [], inputs: [], pipedFromPrev: false, opensGroup: 0, closesGroup: 0 }, ctx, getCwdState, setCwdState, pushCwd, popCwd, getCwdPath, setCwdPath)
        if (v.decision === 'deny') return v
        // find applies the clause to EVERY match; those targets are find-supplied.
        // So over a start point outside the roots / endangering the substrate, ANY
        // verb that isn't provably READ-ONLY is mass-mutation the guard can't see
        // (`sed -i`, `chmod`, `truncate`, a niche editor — inverted, fail-CLOSED).
        const verb = path.basename(argText(clause[0]) ?? '')
        if (outsideStart && !XARGS_READONLY.has(verb)) {
          return denyV('find -exec <mutating verb> rooted outside the write roots or over the guard substrate')
        }
      }
      if (hasDelete && outsideStart) return denyV('find -delete rooted outside the session write roots')
      return ALLOW
    }
    case 'cd': case 'pushd': {
      // Track the REAL cwd PATH through cd — for EVERY session, confined or not,
      // because the unconfined manager still needs substrate resolution
      // (`cd ~/.claude && rm settings.json`). The path is resolved against the
      // CURRENT cwd so successive/relative cds compose. cwdState (the confined
      // write-roots enum) is then DERIVED from the new path.
      if (cmd0 === 'pushd') pushCwd()
      const t = args.length > 0 ? argText(args[0]) : ''
      let newPath
      if (t === null || t === '-') newPath = undefined            // computed / `cd -` → unknown
      else if (t === '' || t === '~') newPath = policy.home        // bare `cd` / `cd ~` → home
      else newPath = policy.resolveFrom(getCwdPath(), t)           // resolve against current cwd
      setCwdPath(newPath)
      if (policy.confined) {
        setCwdState(newPath === undefined ? 'outside' : (policy.writeAllowed(newPath) ? 'inside' : 'outside'))
      }
      return ALLOW
    }
    case 'popd': { popCwd(); return ALLOW }
    case 'rm': {
      let recursive = false
      let force = false
      const targets = []
      let afterDoubleDash = false
      for (const a of args) {
        const t = argText(a)
        if (t === null) {
          // computed rm target/flag
          return denyV('rm with a computed argument (variable/substitution) — the guard cannot tell what would be deleted')
        }
        if (!afterDoubleDash && t === '--') { afterDoubleDash = true; continue }
        if (!afterDoubleDash && t.startsWith('-') && t !== '-') {
          if (t === '--recursive' || bundleHas(t, 'r') || bundleHas(t, 'R')) recursive = true
          if (t === '--force' || bundleHas(t, 'f')) force = true
          continue
        }
        targets.push(t)
      }
      void force
      // UNIFIED substrate gate FIRST, EVERY rm (recursive or single-file, confined
      // or not): deleting the guard / its wiring / a dir that CONTAINS it disables
      // the veto (a wired-but-missing hook fails OPEN). substrateBlock covers
      // self|descendant|ancestor + the computed-cd fail-closed, so `rm settings.json`
      // after `cd $HOME/.claude` and `rm -rf ~/.claude` are all caught.
      for (const t of targets) {
        const sub = substrateBlock(t, ctx, getCwdPath(), 'rm')
        if (sub) return sub
      }
      if (!recursive) {
        // Single-file rm: allowed inside the write roots / common scratch (the
        // heartbeat cleanup). In a CONFINED session an out-of-roots single-file
        // delete is still a destructive write outside the sandbox → deny
        // (symmetric with recursive rm; substrate already handled above).
        for (const t of targets) {
          if (!policy.confined) continue
          if (isAbsoluteish(t)) { if (!policy.writeAllowed(t, getCwdPath())) return denyV(`rm of a file outside the session write roots ('${t}')`) }
          else if (getCwdState() !== 'inside') return denyV(`rm on a relative path after cd out of the write roots ('${t}')`)
        }
        return ALLOW
      }
      for (const t of targets) {
        if (isAbsoluteish(t)) {
          if (!policy.confined) return denyV(`recursive rm on an absolute/home/parent path ('${t}')`)
          if (!policy.writeAllowed(t, getCwdPath())) return denyV(`recursive rm outside the session write roots ('${t}')`)
        } else if (getCwdState() !== 'inside') {
          return denyV(`recursive rm on a relative path after cd out of the write roots ('${t}')`)
        }
      }
      return ALLOW
    }
    case 'unlink': case 'rmdir': {
      for (const a of args) {
        const t = argText(a)
        if (t === null) return denyV(`${cmd0} with a computed argument — not analyzable`)
        if (t.startsWith('-')) continue
        const sub = substrateBlock(t, ctx, getCwdPath(), cmd0)
        if (sub) return sub
        if (policy.confined) {
          if (isAbsoluteish(t)) { if (!policy.writeAllowed(t, getCwdPath())) return denyV(`${cmd0} outside the session write roots ('${t}')`) }
          else if (getCwdState() !== 'inside') return denyV(`${cmd0} on a relative path after cd out of the write roots ('${t}')`)
        }
      }
      return ALLOW
    }
    case 'git':
      return analyzeGit(args, ctx, getCwdState)
    case 'tee': {
      for (const a of args) {
        const t = argText(a)
        if (t === null) { const v = checkWriteTargetText(null, ctx, getCwdState()); if (v) return v; continue }
        if (t.startsWith('-')) continue
        const v = checkWriteTargetText(t, ctx, getCwdState())
        if (v) return v
      }
      return ALLOW
    }
    case 'dd': {
      for (const a of args) {
        const t = argText(a)
        if (t === null) return denyV('dd with a computed argument — not analyzable')
        if (t.startsWith('of=')) {
          const target = t.slice(3)
          if (/^\/dev\/(disk|rdisk)/.test(target)) return denyV('dd onto a raw disk device')
          const v = checkWriteTargetText(target, ctx, getCwdState())
          if (v) return v
        }
      }
      return ALLOW
    }
    case 'cp': case 'mv': case 'install': case 'rsync': case 'ln': case 'rename': {
      // Destination is normally the LAST non-flag arg — BUT `-t DIR` /
      // `--target-directory=DIR` (GNU) puts it in the flag instead, and then
      // EVERY positional is a source into DIR. Handle both forms.
      let targetDir = null
      let rsyncRemovesSource = false
      const nonFlags = []
      for (let k = 0; k < args.length; k += 1) {
        const t = argText(args[k])
        if (t === null) return denyV(`${cmd0} with a computed argument — not analyzable`)
        if (t === '--remove-source-files' || t === '--remove-sent-files') { rsyncRemovesSource = true; continue }
        if (t === '-t' || t === '--target-directory') { targetDir = argText(args[k + 1]); k += 1; continue }
        if (t.startsWith('--target-directory=')) { targetDir = t.slice('--target-directory='.length); continue }
        if (t.startsWith('-t') && t.length > 2 && !t.startsWith('--')) { targetDir = t.slice(2); continue }
        if (!t.startsWith('-')) nonFlags.push(t)
      }
      // DESTINATION write-check (into the target dir, or the last positional).
      if (targetDir !== null) {
        const v = checkWriteTargetText(targetDir, ctx, getCwdState())
        if (v) return v
      } else if (nonFlags.length >= 2) {
        const dest = nonFlags[nonFlags.length - 1]
        const v = checkWriteTargetText(dest, ctx, getCwdState())
        if (v) return v
      }
      // SOURCE-REMOVAL check: `mv`, `rename`, and `rsync --remove-source-files`
      // DELETE their source from its original location — a `mv ~/.ssh/id_rsa /tmp`
      // exfiltrates+destroys an out-of-roots file even though the DEST is fine. So
      // each SOURCE gets the SAME write-check as an rm target (deny out-of-roots /
      // substrate). cp/ln/install leave the source in place → sources not checked.
      // (rev-bypass follow-up A/F; extends Commander MUST-FIX 1 beyond substrate.)
      if (cmd0 === 'mv' || cmd0 === 'rename' || (cmd0 === 'rsync' && rsyncRemovesSource)) {
        const sources = targetDir !== null ? nonFlags : nonFlags.slice(0, -1)
        for (const s of sources) {
          const v = checkWriteTargetText(s, ctx, getCwdState())
          if (v) return denyV(`${cmd0} removes its source — ${v.reason}`)
        }
      }
      return ALLOW
    }
    case 'truncate': case 'shred': {
      for (const a of args) {
        const t = argText(a)
        if (t === null) return denyV(`${cmd0} with a computed argument — not analyzable`)
        if (t.startsWith('-')) continue
        const v = checkWriteTargetText(t, ctx, getCwdState())
        if (v) return v
      }
      return ALLOW
    }
    case 'sed': case 'gsed': {
      // Two write surfaces:
      //  (1) in-place (`-i` / `-iBAK` GNU, `-i ''`/`-i BAK` BSD) rewrites the
      //      FILE ARGUMENTS — a computed target is denied like rm.
      //  (2) the sed PROGRAM's own `w /path` / `W /path` / `s///w /path` write
      //      commands and GNU `e`/`s///e` exec — scanned by scanSedProgram so a
      //      LITERAL `sed -n 'w /etc/x'` is caught in L4 (symmetric with awk),
      //      not left to the default-off L3 sandbox.
      // Identify PROGRAM strings precisely (never scan file paths — a path can
      // contain letters that a sed parser misreads as a `w`/`e` command). The
      // program is every -e/--expression value, or — if no -e/-f at all — the
      // FIRST positional non-flag. `-f scriptfile` is NOT scanned (its content is
      // the same "staged payload" residual as `node script.js`, L3's job).
      let inPlace = false
      let sawScriptFlag = false
      const programs = []
      const positionalFiles = []
      let positionalProgram = null
      for (let k = 0; k < args.length; k += 1) {
        const t = argText(args[k])
        if (t === null) return denyV(`${cmd0} with a computed argument — not analyzable`)
        if (t === '-e' || t === '--expression') {
          const p = argText(args[k + 1])
          if (p === null) return denyV(`${cmd0} -e with a computed program — not analyzable`)
          if (p !== undefined) programs.push(p)
          sawScriptFlag = true; k += 1; continue
        }
        if (t.startsWith('--expression=')) { programs.push(t.slice('--expression='.length)); sawScriptFlag = true; continue }
        if (t === '-f' || t === '--file') { sawScriptFlag = true; k += 1; continue } // script file — not scanned (residual)
        if (t.startsWith('--file=')) { sawScriptFlag = true; continue }
        if (t === '-i' || t === '--in-place') {
          inPlace = true
          // BSD `-i` takes a SEPARATE suffix arg (often `''`); GNU `-i` does not.
          // Consume the next arg as the suffix ONLY when it looks like a backup
          // suffix (empty, or a dotted/plain token with no sed syntax) so it is
          // not mistaken for the program. A real program contains `/`, `;`, a
          // delimiter, or spaces — none of which the suffix pattern allows.
          const nx = argText(args[k + 1])
          if (typeof nx === 'string' && (nx === '' || /^\.?[A-Za-z0-9_-]+$/.test(nx)) && positionalProgram === null && programs.length === 0) {
            k += 1
          }
          continue
        }
        if (t.startsWith('--in-place=')) { inPlace = true; continue }
        if (t.startsWith('-i')) { inPlace = true; continue } // -iBAK glued (GNU)
        if (t.startsWith('-')) continue
        // positional: the FIRST is the program (when no -e/-f), the rest are files
        if (!sawScriptFlag && positionalProgram === null) { positionalProgram = t; continue }
        positionalFiles.push(t)
      }
      if (positionalProgram !== null) programs.push(positionalProgram)

      for (const prog of programs) {
        const { exec, writeTargets } = scanSedProgram(prog)
        if (exec) return denyV(`${cmd0} 'e'/'s///e' executes a command (GNU) — not allowed in a guarded session`)
        for (const target of writeTargets) {
          if (target === null) { if (policy.confined) return denyV(`${cmd0} w/W with a computed file target — not analyzable`); continue }
          const v = checkWriteTargetText(target, ctx, getCwdState())
          if (v) return v
        }
      }
      if (inPlace) {
        // the in-place TARGETS are the positional files (a computed one is already
        // denied above via t===null). The program string is never a target.
        for (const f of positionalFiles) {
          const v = checkWriteTargetText(f, ctx, getCwdState())
          if (v) return v
        }
        // when the program is positional (`sed -i 's/a/b/' file`), `file` is in
        // positionalFiles — the program itself is not double-checked as a path.
      }
      return ALLOW
    }
    case 'tar': {
      // extraction (-x) writes files; a `-C <dir>` or absolute members can land
      // outside the roots. Only engage on extract; create/list are read-only.
      // tar accepts a DASHLESS bundle as its first arg (`tar xf`, `tar xzf`), so
      // match the extract letter with OR without a leading dash.
      const texts = args.map(argText)
      if (texts.some((t) => t === null)) return denyV('tar with a computed argument — not analyzable')
      const extract = texts.some((t, idx) =>
        t === '-x' || t === '--extract' ||
        (/^-[A-Za-z]+$/.test(t) && t.includes('x')) ||
        (idx === 0 && /^[A-Za-z]+$/.test(t) && t.includes('x')),
      )
      if (!extract) return ALLOW
      for (let k = 0; k < texts.length; k += 1) {
        const t = texts[k]
        if (t === '-C' || t === '--directory') {
          const v = checkWriteTargetText(texts[k + 1] ?? '', ctx, getCwdState()); if (v) return v
        } else if (t.startsWith('-C')) {
          const v = checkWriteTargetText(t.slice(2), ctx, getCwdState()); if (v) return v
        } else if (t.startsWith('--directory=')) {
          const v = checkWriteTargetText(t.slice('--directory='.length), ctx, getCwdState()); if (v) return v
        }
      }
      return ALLOW
    }
    case 'unzip': {
      const texts = args.map(argText)
      if (texts.some((t) => t === null)) return denyV('unzip with a computed argument — not analyzable')
      const dIdx = texts.findIndex((t) => t === '-d')
      if (dIdx >= 0) {
        const v = checkWriteTargetText(texts[dIdx + 1] ?? '', ctx, getCwdState()); if (v) return v
      }
      return ALLOW
    }
    case 'chmod': case 'chown': case 'chgrp': {
      // A mode-change on a path is a WRITE to that path's metadata. The
      // substrate is off-limits in every guarded session; when confined, a
      // target outside the write roots is denied too (chmod 000 /etc/passwd,
      // chmod -R 777 ~/.ssh). The first non-flag arg is the MODE/owner spec,
      // not a path — skip it.
      let seenSpec = false
      for (const a of args) {
        const t = argText(a)
        if (t === null) { if (policy.confined) return denyV(`${cmd0} with a computed path — not analyzable`); continue }
        if (t.startsWith('-')) continue
        if (!seenSpec) { seenSpec = true; continue } // mode / owner spec
        // UNIFIED gate: a chmod/chown/chgrp on the substrate OR an ANCESTOR of it
        // (`chmod 000 ~/.openground` strips the traverse bit → the guard becomes
        // unreadable → the hook EACCESes → fails OPEN) is denied for the manager too.
        const sub = substrateBlock(t, ctx, getCwdPath(), cmd0)
        if (sub) return sub
        if (policy.confined) {
          if (isAbsoluteish(t)) { if (!policy.writeAllowed(t, getCwdPath())) return denyV(`${cmd0} outside the session write roots ('${t}')`) }
          else if (getCwdState() !== 'inside') return denyV(`${cmd0} on a relative path after cd out of the write roots ('${t}')`)
        }
      }
      return ALLOW
    }
    case 'awk': case 'gawk': case 'mawk': case 'nawk': {
      // awk is usually a read-only stream filter (`… | awk '{print $2}'`) — do
      // NOT deny that. But its program can WRITE (`print > "file"`) and EXEC
      // (`system("rm -rf /")`, `"cmd" | getline`, `print | "sh"`). Scan the
      // program text for those forms; a QUOTED path after `>`/`>>`/`|` is a
      // filename/command (never the numeric comparison `$1 > 5`, which has no
      // quote), so this catches the write/exec vectors without FP'ing on
      // comparisons. Unquoted `> VAR` (filename via a variable) is a documented
      // residual left to L3. The program is the first non-flag arg (or -f FILE).
      for (const a of args) {
        const t = argText(a)
        if (t === null) return denyV('awk with a computed argument — not analyzable')
        if (t.startsWith('-')) continue
        // `>`/`>>`/`|` followed by a QUOTE, an OPEN PAREN, or a `(` after space is
        // a redirect/pipe to a file/command: `print > "f"`, `print > (f)`,
        // `print > ("/etc/" "x")` (concat), `print | ("cmd")`. The paren forms
        // slipped a quote-only regex. `$1 > (5)` (a parenthesized numeric compare)
        // is a rare FP we accept — awk is normally a read-only filter and the
        // write/exec vector is the real risk.
        // `|&` is gawk's bidirectional COPROCESS — always arbitrary command exec
        // (`print "x" |& "cmd"`, `"cmd" |& getline`), so ANY `|&` is denied. The
        // `\|&?` in the pipe/getline alternatives also lets the coprocess forms
        // that DO quote match. (rev-bypass 3rd-round: gawk is in the awk case.)
        if (/system\s*\(|>>?\s*[("']|\|&|\|&?\s*[("']|\|&?\s*getline|print\s*\|/.test(t)) {
          return denyV('awk program writes to a file or executes a command (print >"…" / print >(…) / system() / | "cmd" / |& coprocess) — not allowed; use the Edit tool or a script the guard can see')
        }
        break // only the FIRST non-flag arg is the program; the rest are data files
      }
      return ALLOW
    }
    case 'ed': case 'ex': case 'red':
    case 'vim': case 'vi': case 'nvim': case 'view': case 'rvim': case 'rview': case 'gvim': case 'evim':
    case 'emacs': case 'emacsclient': {
      // line/screen editors write to their file argument via a scripted command
      // stream the guard can't see: `ed -s file <<< …`, and crucially the SAME ex
      // engine reachable as `vim -es -c '%d' -c 'wq' <file>` (ex/silent mode) —
      // which rewrites/wipes any file, substrate included. emacs `--batch --eval`
      // / `--script` is the same class as node -e / python -c: an inline-code
      // interpreter that also does arbitrary file I/O. An unattended (bypass)
      // worker can't use an interactive editor anyway (it would hang), and the
      // scripted forms are a write/exec vector, so deny the whole family in a
      // confined session; the worker uses the Edit tool. (rev-bypass follow-up C.)
      if (policy.confined) return denyV(`${cmd0} can script an in-place file rewrite / run inline code the guard cannot see — use the Edit tool`)
      return ALLOW
    }
    case 'crontab':
      if (args.some((a) => argText(a) === '-r' || argText(a) === null)) return denyV('crontab -r / computed crontab')
      return ALLOW
    case 'launchctl':
      return denyV('launchctl mutates login/system services — not allowed in a guarded session')
    default: {
      void isManager
      return ALLOW
    }
  }
}

// The UNIFIED substrate gate every destructive verb runs on each of its targets
// (rm/mv-source/rename/rsync-source/chmod/chown/chgrp/find/unlink/rmdir/redirect
// /tee/dd/truncate/git mv|rm/Write/Edit). Closes the CLASS rather than per-verb
// combos: (self|descendant|ancestor) of substrate, CONFINEMENT-INDEPENDENT (the
// unconfined manager is bound too), and FAIL-CLOSED when a plain-relative target
// follows a COMPUTED cd (cwd unknown → the path can't be resolved, so it might BE
// the substrate). `cwd` is the current tracked cwd (undefined after a computed cd).
// (Commander round-3: all holes were manager-path; this shuts the whole door.)
function substrateBlock(rawTarget, ctx, cwd, verb) {
  if (typeof rawTarget !== 'string' || rawTarget.length === 0) return null
  const plainRelative = !isAbsoluteish(rawTarget) // not absolute, not ~, not ..
  if (plainRelative && cwd === undefined) {
    return denyV(`${verb} on a relative path after a computed 'cd' (cwd unknown) — refused: the guard cannot tell whether it hits the guard substrate`)
  }
  if (ctx.policy.endangersSubstrate(rawTarget, cwd)) {
    return denyV(`${verb} would reach the guard substrate ('${rawTarget}') — deleting/moving/permission-changing the veto (or a directory that contains it) is not allowed`)
  }
  return null
}

function checkWriteTarget(targetWord, ctx, cwdState) {
  if (!targetWord) return null
  if (!wordIsLiteral(targetWord)) {
    if (ctx.policy.confined) return denyV('redirecting output to a computed path — the guard cannot tell where it would write')
    return null
  }
  return checkWriteTargetText(tildeExpand(literalText(targetWord), ctx.policy.home), ctx, cwdState)
}

function checkWriteTargetText(text, ctx, cwdState) {
  const { policy } = ctx
  const baseCwd = ctx.getBaseCwd ? ctx.getBaseCwd() : undefined
  if (text === null) {
    if (policy.confined) return denyV('write target is computed — not analyzable')
    return null
  }
  // UNIFIED substrate gate (self|descendant|ancestor + computed-cd fail-closed),
  // confinement-independent — so `cd ~/.claude && > x`, `> ~/.openground/…` etc.
  // are caught for the manager too.
  const sub = substrateBlock(text, ctx, baseCwd, 'write')
  if (sub) return sub
  if (!policy.confined) return null
  if (isAbsoluteish(text)) {
    if (!policy.writeAllowed(text, baseCwd)) return denyV(`write outside the session write roots ('${text}')`)
    return null
  }
  if (cwdState !== 'inside') return denyV(`relative-path write after cd out of the write roots ('${text}')`)
  return null
}

// git config keys that make git RUN a command on a later op — the vectors an
// attacker reaches via inline `-c key=val` or the `config` subcommand while the
// visible subcommand stays innocent. Anchored at the key start; case-insensitive
// (git section/name are case-insensitive). `alias.*` is included because an
// inline alias can BE a force-push (or a `!shell` command); `include(If).path`
// because it can pull in a config file that sets any of the above.
const GIT_CONFIG_EXEC_KEY = /^(alias\.|core\.(hookspath|fsmonitor|pager|editor|sshcommand|askpass)|sequence\.editor|gpg\.(program|ssh\.program)|credential\.(.*\.)?helper|diff\.(.*\.command|external)|merge\.(.*\.driver)|filter\.(.*\.(clean|smudge|process))|uploadpack\.packobjectshook|protocol\.(.*\.)?allow|pager\.|include\.path|includeif\.)/i

// git subcommand analysis. Mirrors + extends ~/.claude/swarm-guard.sh; token-
// based so quoting tricks ("--force", ":main") can't hide a flag.
function analyzeGit(args, ctx, getCwdState) {
  const { policy, isManager } = ctx
  const texts = []
  for (const a of args) {
    const t = literalText(a)
    if (t === null) {
      // A computed word anywhere in a git invocation: refspecs/remotes decide
      // destructiveness, so a computed one is unanalyzable → deny. (Plain
      // `git commit -m "$(date)"` was already vetted via the substitution
      // recursion; the WORD is still dynamic, but commit is not in the
      // dangerous set — so only deny for the dangerous subcommands below.)
      texts.push(null)
    } else {
      texts.push(tildeExpand(t, policy.home))
    }
  }

  // strip global flags: -C <path>, -c k=v, --git-dir=…, --work-tree=…
  // BUT vet the code-executing ones: `git -c alias.X='push --force' X`,
  // `git -c core.hooksPath=/tmp/h status`, `git -c protocol.ext.allow=always …`
  // and `git --exec-path=/tmp …` all run attacker-chosen commands on the NEXT
  // git op while the SUBCOMMAND still looks innocent — the classic argument-regex
  // evasion. A `-c` whose key executes code (same denylist as the `config`
  // subcommand, plus alias/include) is denied; `--exec-path` (relocates git's
  // subcommand binary lookup) is denied; a COMPUTED `-c` value can't be vetted
  // so it's denied (fail-closed). Plain path/identity flags pass.
  let i = 0
  while (i < texts.length) {
    const t = texts[i]
    if (t === null) break // computed global flag — let the subcommand check below decide
    if (t === '-C') { i += 2; continue }
    if (t === '--exec-path' || t.startsWith('--exec-path=')) return denyV('git --exec-path relocates git\'s subcommand lookup (arbitrary exec) — not allowed')
    // inline config: `-c k=v` (two tokens) | `-ck=v` (glued) | `--config-env=k=ENV`
    let kv = null
    if (t === '-c') {
      if (texts[i + 1] === null) return denyV('git -c with a computed value — not analyzable')
      kv = texts[i + 1]; i += 2
    } else if (t.startsWith('-c') && t.length > 2) {
      kv = t.slice(2); i += 1
    } else if (t.startsWith('--config-env=')) {
      kv = t.slice('--config-env='.length); i += 1
    } else if (t.startsWith('--git-dir') || t.startsWith('--work-tree') || t.startsWith('--namespace')) {
      i += 1; continue
    } else {
      break
    }
    if (kv !== null) {
      const key = kv.split('=')[0]
      if (GIT_CONFIG_EXEC_KEY.test(key)) return denyV(`git -c ${key}=… injects a code-executing config (alias/hook/pager/filter/protocol) — not allowed`)
    }
  }
  const sub = texts[i]
  if (sub === undefined) return ALLOW
  if (sub === null) return denyV('computed git subcommand — not analyzable')
  const rest = texts.slice(i + 1)

  const DANGEROUS_NULL = () => rest.some((t) => t === null)

  switch (sub) {
    case 'push': case 'send-pack': case 'http-push': {
      // WORKERS NEVER PUSH — every shape, every remote, every refspec, plain
      // FF included (send-pack / http-push are the plumbing spellings of the
      // same outbound write). A policed session is a confined worker whose
      // contract is "commit locally, beat ready, STOP — the commander
      // re-verifies, adversarially reviews, and integrates". The shape
      // analysis that used to live here (force/--mirror/--delete/:ref vetting
      // + an origin/openground remote allowlist) was inherited from the
      // MANAGER-era guard, where a plain FF push was the manager's legitimate
      // integration step; rescoped to the worker-only veto it left `git push
      // origin HEAD:main` wide open — the 2e7beb2 bypass, where a worker with
      // zero heartbeats integrated itself past the commander's re-verify and
      // adversarial review. Blanket-denying the subcommand needs no argument
      // analysis at all, so there is no flag/quoting/computed-word surface
      // left to evade on the argument side; the NAME side is covered by the
      // dash-form route in analyzeSimple (git-push / git-send-pack /
      // git-http-push / git-svn by absolute libexec path re-enter this
      // switch), leaving ONE known residual — a pre-existing user gitconfig
      // alias (`git p`), documented in the header's Known residuals. Reads
      // (fetch/pull/status/log/rebase/merge-base) and local mechanics
      // (add/commit/merge on the worker's own branch) are untouched.
      return denyV('git push is forbidden in a worker session — ALL pushes, plain/FF included (integration is the commander\'s job): commit locally, then `swarm-beat.sh done true` and STOP')
    }
    case 'svn': {
      // git-svn's `dcommit`/`branch`/`tag` WRITE to the upstream SVN repo —
      // the same outbound-integration class as `git push`. Reads (fetch /
      // rebase / log / info) stay allowed. Exotic on a dev Mac, but one line
      // closes it for good.
      if (rest.some((t) => t === 'dcommit' || t === 'branch' || t === 'tag')) {
        return denyV('git svn dcommit/branch/tag writes to the upstream repo — integration is the commander\'s job')
      }
      return ALLOW
    }
    case 'reset': {
      if (rest.some((t) => t === '--hard' || t === '--keep' || t === '--merge')) {
        return denyV('git reset --hard/--keep/--merge discards work')
      }
      return ALLOW
    }
    case 'clean': {
      // `-n`/`--dry-run` deletes NOTHING (it only lists what would go), so it's a
      // safe diagnostic even with -d/-x bundled — don't false-block `git clean -nd`.
      if (rest.some((t) => t === '--dry-run' || (t !== null && bundleHas(t, 'n')))) return ALLOW
      if (rest.some((t) => t !== null && (bundleHas(t, 'f') || bundleHas(t, 'd') || bundleHas(t, 'x') || t === '--force'))) {
        return denyV('git clean deletes untracked work')
      }
      return ALLOW
    }
    case 'checkout': {
      if (rest.some((t) => t === '-f' || t === '--force' || (t !== null && bundleHas(t, 'f')))) return denyV('git checkout -f discards uncommitted work')
      if (rest.some((t) => t === '--')) return denyV('git checkout -- <paths> discards uncommitted work')
      return ALLOW
    }
    case 'restore': {
      // `--staged`/`-S` (WITHOUT `--worktree`/`-W`) only rewrites the INDEX — the
      // working tree is untouched, so `git restore --staged .` (the standard
      // unstage, the modern `git reset .`) discards NO uncommitted work. Only a
      // restore that TOUCHES the worktree (`.`/`--worktree`/`--source` without a
      // staged-only scope) is the destructive form.
      const stagedOnly = rest.some((t) => t === '--staged' || t === '-S') && !rest.some((t) => t === '--worktree' || t === '-W')
      if (!stagedOnly && rest.some((t) => t === '.' || t === '--worktree' || t === '-W' || (t !== null && t.startsWith('--source')))) {
        return denyV('git restore of the working tree discards uncommitted work')
      }
      return ALLOW
    }
    case 'stash': {
      if (rest.some((t) => t === 'drop' || t === 'clear' || t === 'pop')) return denyV('git stash drop/clear/pop can destroy stashed work')
      return ALLOW
    }
    case 'mv': case 'rm': {
      // `git mv`/`git rm` only touch REPO-TRACKED files, so they can't reach the
      // substrate under ~/.openground|~/.claude in practice — but the substrate
      // basename guard (openground-guard.js / -hook.js) is applied here too for
      // defense-in-depth + consistency with the Write/Edit/shell-rm policy, so a
      // tracked copy of the veto source can't be moved/removed from a guarded run.
      const gBase = ctx.getBaseCwd ? ctx.getBaseCwd() : undefined
      for (const t of rest) {
        if (t === null) continue
        const v = substrateBlock(t, ctx, gBase, `git ${sub}`)
        if (v) return v
      }
      return ALLOW
    }
    case 'branch': {
      const hasForceDelete = rest.some((t) => t === '-D' || (t !== null && /^-[a-zA-Z]+$/.test(t) && t.includes('D')))
      const hasDelete = rest.some((t) => t === '-d' || t === '--delete')
      const hasForce = rest.some((t) => t === '-f' || t === '--force')
      if (hasForceDelete || (hasDelete && hasForce)) return denyV('git branch force-delete (-D)')
      if (hasDelete) {
        if (DANGEROUS_NULL()) return denyV('git branch -d with a computed name — not analyzable')
        const names = rest.filter((t) => t !== null && !t.startsWith('-'))
        const allSwarm = names.length > 0 && names.every((n) => n.startsWith('swarm/'))
        if (isManager && allSwarm) return ALLOW
        if (names.length === 0) return ALLOW
        return denyV(`git branch -d of a non-swarm branch ('${names.join(' ')}')${isManager ? '' : ' — branch cleanup is the manager\'s job'}`)
      }
      return ALLOW
    }
    case 'filter-branch': case 'filter-repo':
      return denyV('git history rewrite')
    case 'update-ref': {
      if (rest.some((t) => t === '-d')) return denyV('git update-ref -d (ref deletion)')
      return ALLOW
    }
    case 'worktree': {
      if (rest[0] === 'remove' && rest.some((t) => t === '--force' || t === '-f')) {
        return denyV('git worktree remove --force')
      }
      return ALLOW
    }
    case 'reflog': {
      if (rest.includes('expire') && rest.some((t) => t !== null && t.startsWith('--expire'))) {
        return denyV('git reflog expire destroys the recovery log')
      }
      return ALLOW
    }
    case 'gc': {
      if (rest.some((t) => t !== null && t.startsWith('--prune=now'))) return denyV('git gc --prune=now destroys unreferenced history immediately')
      return ALLOW
    }
    case 'config': {
      // A code-executing config key (hooksPath / alias / pager / filter /
      // protocol.*.allow / include) smuggles a command into a later git run.
      // Same denylist as the inline `-c` vetting above. The key is the first
      // non-flag token (`git config core.hooksPath /tmp/h` or `git config
      // core.hooksPath=/tmp/h`), OR appears in `--add`/`--replace-all` forms —
      // so test EVERY literal token's leading key against the regex.
      for (const t of rest) {
        if (t === null) continue
        const key = t.replace(/^--[a-z-]+=?/, '').split('=')[0]
        if (GIT_CONFIG_EXEC_KEY.test(key) || GIT_CONFIG_EXEC_KEY.test(t)) {
          return denyV(`git config of a code-executing key ('${key}') — alias/hook/pager/filter/protocol/include are not allowed`)
        }
      }
      return ALLOW
    }
    case 'remote': {
      // `git remote set-url origin ext::sh -c '…'` / adding a remote whose URL is
      // an ext::/fd:: transport runs a command on the next fetch/push. Deny the
      // executable-transport URL forms; plain https/ssh/file remotes are fine.
      if (rest.some((t) => t !== null && /^(ext|fd)::/i.test(t))) {
        return denyV('git remote with an ext::/fd:: transport executes a command — not allowed')
      }
      return ALLOW
    }
    default:
      return ALLOW
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Tool dispatch
// ────────────────────────────────────────────────────────────────────────────

function evaluate(payload, env) {
  // WORKER-ONLY scoping (see the GATE header): the veto polices ONLY the confined
  // worker / overseer (OPENGROUND_GUARD=1). The manager / supply (SWARM_MANAGER=1)
  // and every other session are TRUSTED no-ops — allow unconditionally.
  if (env.OPENGROUND_GUARD !== '1') return ALLOW

  const policy = makePathPolicy(env, typeof payload?.cwd === 'string' ? payload.cwd : undefined)
  // isManager is RETIRED: a policed session is always a confined worker, never a
  // manager. Pinned false so the old manager-only ALLOW carve-outs (release-push
  // shapes, swarm `branch -d`, find/rm unconfined trust) can never fire in a
  // policed session — the worker gets the strict deny path uniformly.
  const ctx = { policy, isManager: false, depth: 0 }

  const tool = payload?.tool_name
  if (typeof tool !== 'string') return denyV('malformed hook payload (no tool_name) — fail-closed')

  if (tool === 'Bash') {
    const cmd = payload?.tool_input?.command
    if (typeof cmd !== 'string' || cmd.length === 0) return denyV('malformed Bash payload (no command) — fail-closed')
    return analyzeBash(cmd, ctx)
  }

  if (tool === 'Write' || tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit') {
    const fp = payload?.tool_input?.file_path ?? payload?.tool_input?.notebook_path
    if (typeof fp !== 'string' || fp.length === 0) return denyV(`malformed ${tool} payload (no file path) — fail-closed`)
    if (policy.isSubstrate(fp)) {
      return denyV(`${tool} on the guard substrate ('${fp}') — the guard, its hook wiring (settings.json), ~/.claude/swarm-*.sh and CLAUDE.md are off-limits in a guarded session`)
    }
    if (policy.confined) {
      if (!policy.writeAllowed(fp)) {
        return denyV(`${tool} outside the session write roots ('${fp}') — this session may write only under: ${policy.roots.join(', ')} (+ temp dirs)`)
      }
    }
    return ALLOW
  }

  return ALLOW
}

module.exports = { evaluate, tokenize, analyzeBash: (cmd, env, payloadCwd) => analyzeBash(cmd, { policy: makePathPolicy(env ?? process.env, payloadCwd), isManager: false, depth: 0 }) }

// ────────────────────────────────────────────────────────────────────────────
// CLI — Claude Code hook contract
// ────────────────────────────────────────────────────────────────────────────

if (require.main === module) {
  // The gate runs BEFORE any risky work so a non-worker session can never be
  // blocked by a guard bug: no stdin parsing, no path math — just env. WORKER-ONLY
  // scoping: only OPENGROUND_GUARD=1 (the confined worker/overseer) is policed; the
  // manager (SWARM_MANAGER=1) and everything else no-op here. (See the GATE header.)
  if (process.env.OPENGROUND_GUARD !== '1') {
    process.stdout.write('{}')
    process.exit(0)
  }
  // Initialise to DENY so that if anything below throws OR returns a malformed
  // verdict, the final check falls to exit 2 — never leaving `verdict` undefined
  // (a `verdict.decision` TypeError would escape to exit 1 = the fail-OPEN trap).
  let verdict = denyV('guard did not produce a verdict — denying by default')
  try {
    const fs = require('fs')
    const raw = fs.readFileSync(0, 'utf8')
    const payload = JSON.parse(raw)
    const v = evaluate(payload, process.env)
    // A well-formed verdict is {decision:'allow'|'deny'}; anything else is a bug
    // and must fail CLOSED, not slip through as allow.
    if (v && (v.decision === 'allow' || v.decision === 'deny')) verdict = v
    else verdict = denyV('guard returned a malformed verdict — denying by default')
  } catch (e) {
    // FAIL-CLOSED: any error past the gate is a deny (exit 2), NEVER exit 1 —
    // Claude Code treats exit 1 as a non-blocking hook error and would let the
    // tool call through, which is exactly the trap this guard exists to avoid.
    verdict = denyV(`guard error (${e && e.message ? e.message : 'unknown'}) — denying by default`)
  }
  if (verdict.decision === 'deny') {
    process.stderr.write(`openground-guard BLOCKED: ${verdict.reason}\n`)
    process.exit(2)
  }
  process.stdout.write('{}')
  process.exit(0)
}
