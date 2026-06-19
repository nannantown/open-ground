import { describe, it, expect, vi, afterEach } from 'vitest'
// Stub the PTY layer so sendInterrupt's byte contract can be asserted without
// spawning a real terminal (createTerminal/writeInput hit node-pty).
vi.mock('./terminal', () => ({
  writeInput: vi.fn(() => true),
  killTerminal: vi.fn(() => true),
  createTerminal: vi.fn(),
}))
import {
  shellQuoteArg,
  buildClaudeArgv,
  buildAppContextPrompt,
  launchOptsFromPrefs,
  sendInterrupt,
} from './claudeTerminal'
import { writeInput } from './terminal'

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
