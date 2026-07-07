import { describe, it, expect, vi, afterEach } from 'vitest'
// Stub the PTY layer so sendInterrupt's byte contract can be asserted without
// spawning a real terminal (createTerminal/writeInput hit node-pty).
vi.mock('./terminal', () => ({
  writeInput: vi.fn(() => true),
  killTerminal: vi.fn(() => true),
  createTerminal: vi.fn(),
}))
// launchClaude's collaborators that would otherwise touch the real machine:
// claudeTrust writes ~/.claude.json (keep the test hermetic — see
// feedback_tests_isolate_home) and resolvedClaudeBin reads the last live probe
// (null here → the bare `claude`, matching a fresh process).
vi.mock('./claudeTrust', () => ({ ensureClaudeFolderTrusted: vi.fn() }))
vi.mock('./claudeConnection', () => ({ resolvedClaudeBin: vi.fn(() => null) }))
import {
  shellQuoteArg,
  buildClaudeArgv,
  buildLaunchCommand,
  buildAppContextPrompt,
  launchOptsFromPrefs,
  launchClaude,
  sendInterrupt,
} from './claudeTerminal'
import { writeInput, createTerminal } from './terminal'

describe('sendInterrupt (Ctrl-C control byte)', () => {
  it('writes the ETX byte (\\x03), never an empty string', () => {
    const mock = vi.mocked(writeInput)
    mock.mockClear()
    sendInterrupt('tid-1')
    expect(mock).toHaveBeenCalledTimes(1)
    const [id, data] = mock.mock.calls[0]
    expect(id).toBe('tid-1')
    // Pin the exact byte. This is a regression guard: the interrupt char was
    // once stored as an INVISIBLE literal control byte in the source, which is
    // trivially clobbered to '' by an editor (and reads as empty to the eye) —
    // sending nothing and silently breaking Ctrl-C. Assert it's the 1-byte ETX.
    expect(data).toBe('\x03')
    expect(data.length).toBe(1)
    expect(data.charCodeAt(0)).toBe(3)
  })
})

describe('buildClaudeArgv (launch argv order/quoting contract)', () => {
  const base = { agentSessionId: 'SID', permissionMode: 'bypass' as const }

  it('emits --add-dir BEFORE --session-id so its variadic list cannot swallow the prompt', () => {
    const argv = buildClaudeArgv({ ...base, addDir: '/data/dir' }, '/tmp/p.txt')
    const addIdx = argv.indexOf('--add-dir')
    const sidIdx = argv.indexOf('--session-id')
    expect(addIdx).toBeGreaterThanOrEqual(0)
    expect(addIdx).toBeLessThan(sidIdx)
    // a flag (not the positional prompt) immediately follows --add-dir's value
    expect(argv[addIdx + 2]).toBe('--session-id')
  })

  it('accepts MULTIPLE add-dirs on ONE variadic --add-dir, still bounded by --session-id', () => {
    const argv = buildClaudeArgv(
      { ...base, addDir: ['/data/worktrees', '/data/task-assets'] },
      '/tmp/p.txt',
    )
    const addIdx = argv.indexOf('--add-dir')
    expect(argv.slice(addIdx, addIdx + 3)).toEqual([
      '--add-dir',
      "'/data/worktrees'",
      "'/data/task-assets'",
    ])
    expect(argv[addIdx + 3]).toBe('--session-id')
    // an empty list emits no flag at all
    expect(buildClaudeArgv({ ...base, addDir: [] }, null)).not.toContain('--add-dir')
  })

  it('passes the prompt via "$(cat <file>)" as the LAST arg, never inline', () => {
    const argv = buildClaudeArgv(base, '/tmp/prompt.txt')
    expect(argv[argv.length - 1]).toBe(`"$(cat '/tmp/prompt.txt')"`)
    // the literal prompt text never appears on the command line
    expect(argv.join(' ')).not.toContain('reply READY')
  })

  it('omits the positional prompt entirely for a bare resume (null promptFile)', () => {
    const argv = buildClaudeArgv({ ...base, resume: true }, null)
    expect(argv).toContain('--resume')
    expect(argv).toContain('SID')
    expect(argv.some((a) => a.includes('$(cat'))).toBe(false)
  })

  it('uses --resume (not --session-id) when resuming', () => {
    const argv = buildClaudeArgv({ ...base, resume: true }, null)
    expect(argv).toContain('--resume')
    expect(argv).not.toContain('--session-id')
  })

  it('bypass mode adds --dangerously-skip-permissions', () => {
    expect(buildClaudeArgv(base, null)).toContain('--dangerously-skip-permissions')
  })

  it('app context rides --append-system-prompt via "$(cat …)" BEFORE the positional prompt', () => {
    const argv = buildClaudeArgv(base, '/tmp/prompt.txt', '/tmp/ctx.md')
    const flagIdx = argv.indexOf('--append-system-prompt')
    expect(flagIdx).toBeGreaterThanOrEqual(0)
    expect(argv[flagIdx + 1]).toBe(`"$(cat '/tmp/ctx.md')"`)
    // positional prompt stays LAST
    expect(argv[argv.length - 1]).toBe(`"$(cat '/tmp/prompt.txt')"`)
  })

  it('omits --append-system-prompt when no context file (appContext: false)', () => {
    const argv = buildClaudeArgv(base, '/tmp/prompt.txt', null)
    expect(argv).not.toContain('--append-system-prompt')
  })

  it('emits --remote-control <name> (quoted) when remoteControl is set', () => {
    const argv = buildClaudeArgv({ ...base, remoteControl: 'supply' }, '/tmp/prompt.txt')
    const idx = argv.indexOf('--remote-control')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(argv[idx + 1]).toBe("'supply'")
  })

  it('omits --remote-control entirely when no name is given (off = CLI default)', () => {
    expect(buildClaudeArgv(base, '/tmp/prompt.txt')).not.toContain('--remote-control')
    // an empty string is "off" too (falsy) — never a bare flag that would swallow
    // the positional prompt as its optional name
    expect(buildClaudeArgv({ ...base, remoteControl: '' }, '/tmp/prompt.txt')).not.toContain(
      '--remote-control',
    )
  })

  it("keeps the positional prompt LAST so --remote-control's optional name can't swallow it", () => {
    // claude's `--remote-control [name]` takes an OPTIONAL value; the explicit
    // name must be the token right after the flag, and the prompt must stay last.
    const argv = buildClaudeArgv(
      { ...base, remoteControl: 'worker' },
      '/tmp/prompt.txt',
      '/tmp/ctx.md',
    )
    const idx = argv.indexOf('--remote-control')
    expect(argv[idx + 1]).toBe("'worker'") // its name, never the prompt
    expect(argv[idx + 1]).not.toContain('$(cat') // not the prompt/context file arg
    expect(argv[argv.length - 1]).toBe(`"$(cat '/tmp/prompt.txt')"`) // prompt stays last
  })

  it('emits --strict-mcp-config (a bare flag) when strictMcpConfig is set; prompt stays last', () => {
    const argv = buildClaudeArgv({ ...base, strictMcpConfig: true }, '/tmp/prompt.txt')
    expect(argv).toContain('--strict-mcp-config')
    // It takes NO value, so it's safe to sit right before the positional prompt —
    // unlike --remote-control's optional name, it can't consume the prompt. The
    // prompt therefore stays LAST (proof it wasn't swallowed as a flag value).
    expect(argv[argv.length - 1]).toBe(`"$(cat '/tmp/prompt.txt')"`)
  })

  it('omits --strict-mcp-config by default (the user terminal keeps its MCP servers)', () => {
    expect(buildClaudeArgv(base, '/tmp/prompt.txt')).not.toContain('--strict-mcp-config')
  })

  it('emits --disallowed-tools as ONE comma-joined quoted token, bounded by --session-id', () => {
    const argv = buildClaudeArgv(
      { ...base, disallowedTools: ['WebFetch', 'WebSearch', 'Bash'] },
      '/tmp/p.txt',
    )
    const i = argv.indexOf('--disallowed-tools')
    expect(i).toBeGreaterThanOrEqual(0)
    // The list rides ONE token (comma form), so this variadic flag can never
    // swallow the positional prompt — and a value-taking flag still bounds it.
    expect(argv[i + 1]).toBe("'WebFetch,WebSearch,Bash'")
    expect(argv[i + 2]).toBe('--session-id')
    expect(argv[argv.length - 1]).toBe(`"$(cat '/tmp/p.txt')"`)
  })

  it('omits --disallowed-tools by default and for an empty/blank list (worker/supply/user launches unchanged)', () => {
    expect(buildClaudeArgv(base, '/tmp/prompt.txt')).not.toContain('--disallowed-tools')
    expect(buildClaudeArgv({ ...base, disallowedTools: [] }, null)).not.toContain('--disallowed-tools')
    expect(buildClaudeArgv({ ...base, disallowedTools: ['  ', ''] }, null)).not.toContain('--disallowed-tools')
  })
})

describe('buildClaudeArgv on Windows (platform=win32 — PowerShell framing)', () => {
  // The bug: PowerShell (the default Windows PTY shell) can't parse the POSIX
  // `$(cat <file>)` the prompt/context were passed through, so claude launched
  // with an empty/garbled prompt (Board run / auto-title / auto-description /
  // skill-gen all silently no-op'd). On win32 the file is read with
  // `$(Get-Content -Raw …)` instead, landing as a single claude argument.
  const base = { agentSessionId: 'SID', permissionMode: 'bypass' as const }
  const WIN = 'win32' as const

  it('reads the positional prompt via $(Get-Content -Raw …), never $(cat …)', () => {
    const argv = buildClaudeArgv(base, 'C:\\tmp\\prompt.txt', null, null, WIN)
    expect(argv[argv.length - 1]).toBe("$(Get-Content -Raw 'C:\\tmp\\prompt.txt')")
    expect(argv.join(' ')).not.toContain('$(cat')
  })

  it('reads --append-system-prompt context via $(Get-Content -Raw …), BEFORE the prompt', () => {
    const argv = buildClaudeArgv(base, 'C:\\tmp\\prompt.txt', 'C:\\tmp\\ctx.md', null, WIN)
    const flagIdx = argv.indexOf('--append-system-prompt')
    expect(flagIdx).toBeGreaterThanOrEqual(0)
    expect(argv[flagIdx + 1]).toBe("$(Get-Content -Raw 'C:\\tmp\\ctx.md')")
    expect(argv[argv.length - 1]).toBe("$(Get-Content -Raw 'C:\\tmp\\prompt.txt')")
    expect(argv.join(' ')).not.toContain('$(cat')
  })

  it('single-quotes the resolved absolute bin + add-dir paths the PowerShell way (backslashes literal)', () => {
    const argv = buildClaudeArgv(
      { ...base, addDir: 'C:\\data\\worktrees' },
      'C:\\tmp\\prompt.txt',
      null,
      'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd',
      WIN,
    )
    expect(argv[0]).toBe("'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'")
    const addIdx = argv.indexOf('--add-dir')
    expect(argv[addIdx + 1]).toBe("'C:\\data\\worktrees'")
  })

  it('still single-quotes --model / --effort for PowerShell', () => {
    const opts = launchOptsFromPrefs({ permissionMode: 'acceptEdits', model: 'opus', effort: 'high' })
    const argv = buildClaudeArgv({ agentSessionId: 'SID', ...opts }, null, null, null, WIN)
    expect(argv[argv.indexOf('--model') + 1]).toBe("'opus'")
    expect(argv[argv.indexOf('--effort') + 1]).toBe("'high'")
  })
})

describe('launchOptsFromPrefs (personal launch prefs → LaunchClaudeOpts)', () => {
  it('no prefs: interactive default, CLI-default model', () => {
    expect(launchOptsFromPrefs(undefined)).toEqual({ permissionMode: 'default' })
    expect(launchOptsFromPrefs(null)).toEqual({ permissionMode: 'default' })
    expect(launchOptsFromPrefs({})).toEqual({ permissionMode: 'default' })
  })

  it('maps each stored mode 1:1 (bypass → bypass etc.)', () => {
    expect(launchOptsFromPrefs({ permissionMode: 'default' }).permissionMode).toBe('default')
    expect(launchOptsFromPrefs({ permissionMode: 'acceptEdits' }).permissionMode).toBe('acceptEdits')
    expect(launchOptsFromPrefs({ permissionMode: 'plan' }).permissionMode).toBe('plan')
    expect(launchOptsFromPrefs({ permissionMode: 'bypass' }).permissionMode).toBe('bypass')
  })

  it('unknown/junk mode (hand-edited data) falls back to default', () => {
    expect(
      launchOptsFromPrefs({ permissionMode: 'sudo' as never }).permissionMode,
    ).toBe('default')
  })

  it('passes the model through trimmed; blank means CLI default (omitted)', () => {
    expect(launchOptsFromPrefs({ model: ' sonnet ' }).model).toBe('sonnet')
    expect(launchOptsFromPrefs({ model: '   ' }).model).toBeUndefined()
    expect(launchOptsFromPrefs({ model: '' }).model).toBeUndefined()
  })

  it('passes only a CLI-accepted effort; junk/blank means CLI default (omitted)', () => {
    expect(launchOptsFromPrefs({ effort: 'xhigh' }).effort).toBe('xhigh')
    expect(launchOptsFromPrefs({ effort: 'max' }).effort).toBe('max')
    expect(launchOptsFromPrefs({ effort: 'turbo' as never }).effort).toBeUndefined()
    expect(launchOptsFromPrefs({}).effort).toBeUndefined()
  })

  it('mapped prefs reach the launch argv: --permission-mode / --model / --effort / bypass flag', () => {
    // acceptEdits + model + effort → explicit flags on the claude command line
    const opts = launchOptsFromPrefs({
      permissionMode: 'acceptEdits',
      model: 'opus',
      effort: 'high',
    })
    const argv = buildClaudeArgv({ agentSessionId: 'SID', ...opts }, null)
    const pmIdx = argv.indexOf('--permission-mode')
    expect(pmIdx).toBeGreaterThanOrEqual(0)
    expect(argv[pmIdx + 1]).toBe('acceptEdits')
    const mIdx = argv.indexOf('--model')
    expect(argv[mIdx + 1]).toBe("'opus'")
    const eIdx = argv.indexOf('--effort')
    expect(argv[eIdx + 1]).toBe("'high'")
    // No effort → no flag at all (the CLI default must stay untouched).
    expect(
      buildClaudeArgv({ agentSessionId: 'SID', ...launchOptsFromPrefs({}) }, null),
    ).not.toContain('--effort')
    // bypass → the dangerously-skip flag, not --permission-mode
    const bypass = buildClaudeArgv(
      { agentSessionId: 'SID', ...launchOptsFromPrefs({ permissionMode: 'bypass' }) },
      null,
    )
    expect(bypass).toContain('--dangerously-skip-permissions')
    expect(bypass).not.toContain('--permission-mode')
    // default → neither flag
    const dflt = buildClaudeArgv(
      { agentSessionId: 'SID', ...launchOptsFromPrefs(undefined) },
      null,
    )
    expect(dflt).not.toContain('--permission-mode')
    expect(dflt).not.toContain('--dangerously-skip-permissions')
  })
})

describe('buildAppContextPrompt', () => {
  it('names the project path, the tasks API with the right port, and the board rule', () => {
    const text = buildAppContextPrompt('/Users/me/projects/My App', 47776)
    expect(text).toContain('/Users/me/projects/My App')
    expect(text).toContain('http://127.0.0.1:47776/api/project/tasks')
    expect(text).toContain('"path":"/Users/me/projects/My App"')
    // The read URL must be safely encoded (spaces never raw in a URL).
    expect(text).toContain(encodeURIComponent('/Users/me/projects/My App'))
    expect(text).toMatch(/NOT to your internal todo list/)
  })
})

describe('buildClaudeArgv launch-binary seam (OPENGROUND_CLAUDE_BIN)', () => {
  const base = { agentSessionId: 'SID', permissionMode: 'bypass' as const }
  afterEach(() => vi.unstubAllEnvs())

  it('defaults to bare `claude` (PATH-resolved) when the env var is unset', () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', '')
    // stubEnv('') sets an empty string; the seam treats falsy as "use default".
    expect(buildClaudeArgv(base, null)[0]).toBe('claude')
  })

  it('uses OPENGROUND_CLAUDE_BIN as argv[0] when set (E2E/test stub)', () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', '/tmp/fake-claude.sh')
    expect(buildClaudeArgv(base, null)[0]).toBe("'/tmp/fake-claude.sh'")
  })

  it('shell-quotes a custom path containing spaces (repo dir is `…/OPEN GROUND`)', () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', '/Users/x/OPEN GROUND/e2e/fixtures/fake-claude.sh')
    // Single-quoted so the PTY command line treats the spaced path as one token.
    expect(buildClaudeArgv(base, null)[0]).toBe(
      "'/Users/x/OPEN GROUND/e2e/fixtures/fake-claude.sh'",
    )
  })

  // PATH-drift fix (distributed builds): launchClaude passes the absolute path
  // claudeConnection just validated as the 4th arg, so the PTY runs the EXACT
  // claude even when its non-interactive login shell (`zsh -l`, no `.zshrc`)
  // can't resolve a bare `claude` the way the probe (`zsh -lic`) did.
  it('uses the resolved absolute bin (4th arg) as argv[0] when the env var is unset', () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', undefined)
    expect(buildClaudeArgv(base, null, null, '/Users/x/.local/bin/claude')[0]).toBe(
      "'/Users/x/.local/bin/claude'",
    )
  })

  it('OPENGROUND_CLAUDE_BIN (operator/E2E override) beats the resolved bin', () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', '/tmp/override-claude')
    expect(buildClaudeArgv(base, null, null, '/Users/x/.local/bin/claude')[0]).toBe(
      "'/tmp/override-claude'",
    )
  })

  it('falls back to bare `claude` when neither the env var nor a resolved bin is set', () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', undefined)
    expect(buildClaudeArgv(base, null, null, null)[0]).toBe('claude')
  })
})

describe('shellQuoteArg (PowerShell / POSIX prompt quoting)', () => {
  describe('win32 (PowerShell single-quoted string)', () => {
    it('wraps a plain string in single quotes', () => {
      expect(shellQuoteArg('hello', 'win32')).toBe("'hello'")
    })

    it("doubles embedded single quotes ('→'')", () => {
      // PowerShell escapes a literal ' inside a single-quoted string by
      // doubling it. `it's` → 'it''s'.
      expect(shellQuoteArg("it's a test", 'win32')).toBe("'it''s a test'")
    })

    it('preserves embedded newlines (multi-line prompt)', () => {
      const prompt = 'line one\nline two\nline three'
      expect(shellQuoteArg(prompt, 'win32')).toBe(
        "'line one\nline two\nline three'",
      )
    })

    it('does not mangle backslashes (literal in single-quoted PS string)', () => {
      expect(shellQuoteArg('C:\\path\\file', 'win32')).toBe("'C:\\path\\file'")
    })
  })

  describe('posix (zsh/bash single-quoted string)', () => {
    it('wraps a plain string in single quotes', () => {
      expect(shellQuoteArg('hello', 'darwin')).toBe("'hello'")
    })

    it("escapes embedded single quotes via the '\\'' idiom", () => {
      expect(shellQuoteArg("it's", 'darwin')).toBe("'it'\\''s'")
    })

    it('preserves embedded newlines', () => {
      expect(shellQuoteArg('a\nb', 'darwin')).toBe("'a\nb'")
    })
  })
})

describe('buildLaunchCommand (per-shell PTY command framing)', () => {
  // The argv content is buildClaudeArgv's contract; this pins only the per-shell
  // FRAMING — env-prefix, the Windows call operator, and the `; exit` teardown.
  const argv = ['claude', '--session-id', 'SID']

  it('POSIX: inline env-prefix, no call operator, `; exit` teardown', () => {
    expect(buildLaunchCommand(argv, 'darwin')).toBe(
      'OPENGROUND_OWNED=1 claude --session-id SID ; exit\n',
    )
  })

  it('Windows: `$env:` statement + `&` call operator + `; exit` teardown', () => {
    expect(buildLaunchCommand(argv, 'win32')).toBe(
      "$env:OPENGROUND_OWNED='1'; & claude --session-id SID ; exit\n",
    )
  })

  it('Windows invokes a QUOTED absolute bin through `&` (string-expression trap)', () => {
    // This is the exact string launchClaude would write to the PTY on Windows:
    // buildLaunchCommand(buildClaudeArgv(…, win32), win32). Without `&`, the
    // leading quoted `claude.cmd` path is a PowerShell string expression and
    // claude never runs — a second Windows launch breakage beyond `$(cat …)`.
    const win = buildLaunchCommand(
      buildClaudeArgv(
        { agentSessionId: 'SID', permissionMode: 'bypass' },
        'C:\\tmp\\prompt.txt',
        'C:\\tmp\\ctx.md',
        'C:\\claude.cmd',
        'win32',
      ),
      'win32',
    )
    // Exact PTY string launchClaude writes on Windows (completion condition 3):
    // `&` call operator + single-quoted bin, BOTH file-read args via
    // $(Get-Content -Raw …), `$env:` env-set, `; exit` teardown.
    expect(win).toBe(
      "$env:OPENGROUND_OWNED='1'; & 'C:\\claude.cmd' --session-id SID " +
        '--dangerously-skip-permissions --append-system-prompt ' +
        "$(Get-Content -Raw 'C:\\tmp\\ctx.md') " +
        "$(Get-Content -Raw 'C:\\tmp\\prompt.txt') ; exit\n",
    )
    // …and the same pinned piecewise, as readable documentation of each part:
    expect(win).toContain("& 'C:\\claude.cmd'")
    expect(win).toContain("--append-system-prompt $(Get-Content -Raw 'C:\\tmp\\ctx.md')")
    expect(win.endsWith("$(Get-Content -Raw 'C:\\tmp\\prompt.txt') ; exit\n")).toBe(true)
    // No POSIX-isms leaked: no $(cat …), no inline `VAR=1 ` prefix.
    expect(win).not.toContain('$(cat')
    expect(win).not.toContain('OPENGROUND_OWNED=1 ')
    expect(win.startsWith("$env:OPENGROUND_OWNED='1'; &")).toBe(true)
  })

  // The extra-env port (in-app swarm manager). Workers pass NONE → the launch
  // line stays byte-identical to before; a future manager passes SWARM_MANAGER.
  it('no env → byte-identical to the pre-env launch line (workers pass none)', () => {
    expect(buildLaunchCommand(argv, 'darwin', {})).toBe(
      'OPENGROUND_OWNED=1 claude --session-id SID ; exit\n',
    )
    expect(buildLaunchCommand(argv, 'win32', {})).toBe(
      "$env:OPENGROUND_OWNED='1'; & claude --session-id SID ; exit\n",
    )
  })

  it('POSIX: inline K=\'v\' assignments precede OPENGROUND_OWNED', () => {
    expect(buildLaunchCommand(argv, 'darwin', { SWARM_MANAGER: '1' })).toBe(
      "SWARM_MANAGER='1' OPENGROUND_OWNED=1 claude --session-id SID ; exit\n",
    )
  })

  it('Windows: $env: statements precede OPENGROUND_OWNED', () => {
    expect(buildLaunchCommand(argv, 'win32', { SWARM_MANAGER: '1' })).toBe(
      "$env:SWARM_MANAGER='1'; $env:OPENGROUND_OWNED='1'; & claude --session-id SID ; exit\n",
    )
  })

  it('shell-quotes env values (a crafted value cannot break the line)', () => {
    // A single quote in the value is escaped by the POSIX `'\''` idiom.
    expect(buildLaunchCommand(argv, 'darwin', { K: "a'b" })).toBe(
      "K='a'\\''b' OPENGROUND_OWNED=1 claude --session-id SID ; exit\n",
    )
  })

  it('drops env keys that are not POSIX env-name shaped (defence in depth)', () => {
    const out = buildLaunchCommand(argv, 'darwin', { 'bad key': 'x', '1nope': 'y', OK_1: 'z' })
    expect(out).toContain("OK_1='z'")
    expect(out).not.toContain('bad key')
    expect(out).not.toContain('1nope')
  })
})

describe('launchClaude (routes the prompt through a temp file + buildLaunchCommand)', () => {
  afterEach(() => vi.useRealTimers())

  it('writes ONE launch command that reads the prompt from a file, never inline', () => {
    vi.mocked(createTerminal).mockReturnValue({
      id: 'tid',
      cwd: '/p',
      shell: '/bin/zsh',
      cols: 120,
      rows: 32,
      startedAt: 'now',
    } as never)
    const wi = vi.mocked(writeInput)
    wi.mockClear()
    // Fake timers so launchClaude's 60s temp-file cleanup timer doesn't linger
    // past the test; runOnlyPendingTimers fires the rm so nothing is left behind.
    vi.useFakeTimers()
    launchClaude({
      cwd: '/p',
      agentSessionId: 'SID',
      initialPrompt: 'SECRET-PROMPT-TEXT',
      appContext: false,
    })
    vi.runOnlyPendingTimers()
    expect(wi).toHaveBeenCalledTimes(1)
    const [id, cmd] = wi.mock.calls[0]
    expect(id).toBe('tid')
    // POSIX host: env-prefixed, reads the prompt via $(cat <tmpfile>), tears down.
    expect(cmd).toContain('OPENGROUND_OWNED=1 ')
    expect(cmd).toMatch(/\$\(cat '[^']+'\)/)
    expect((cmd as string).endsWith(' ; exit\n')).toBe(true)
    // The literal prompt text NEVER appears inline on the PTY command line.
    expect(cmd).not.toContain('SECRET-PROMPT-TEXT')
  })
})
