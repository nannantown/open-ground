import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolve } from 'path'
import { probeClaudeCli } from './claudeCli'

// The launch-binary seam (OPENGROUND_CLAUDE_BIN) must apply to the readiness
// probe too, otherwise a machine without the real `claude` (CI, the E2E suite)
// gets installed:false and every run is 503'd before it can spawn the stub.
const FAKE = resolve(__dirname, '../../../e2e/fixtures/fake-claude.sh')

describe('probeClaudeCli launch-binary seam (OPENGROUND_CLAUDE_BIN)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('reports installed when OPENGROUND_CLAUDE_BIN points at the stub', async () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', FAKE)
    // force=true bypasses the 10s cache so we read this env, not a prior probe.
    const probe = await probeClaudeCli(true)
    expect(probe.installed).toBe(true)
    expect(probe.version).toContain('fake-claude')
  })

  it('reports missing when pointed at a nonexistent binary', async () => {
    vi.stubEnv('OPENGROUND_CLAUDE_BIN', '/no/such/claude-binary-xyz')
    const probe = await probeClaudeCli(true)
    expect(probe.installed).toBe(false)
    expect(probe.version).toBeNull()
  })
})

// The install-while-running fix: when the direct PATH lookup misses, the probe
// re-resolves through a fresh login shell and then well-known install targets
// (the server's PATH is a boot-time snapshot; the onboarding flow installs
// claude AFTER boot). These cover the pure pieces — the orchestration rides
// the same execFile seam the existing cases exercise.
import { loginShellArgv, knownClaudeLocations, pathFromShellOutput } from './claudeCli'

describe('login-shell claude resolution helpers', () => {
  it('zsh gets -lic (profile AND rc), other shells -lc', () => {
    expect(loginShellArgv('/bin/zsh')).toEqual(['/bin/zsh', ['-lic', 'command -v claude']])
    expect(loginShellArgv('/usr/local/bin/zsh')[1][0]).toBe('-lic')
    expect(loginShellArgv('/bin/bash')).toEqual(['/bin/bash', ['-lc', 'command -v claude']])
    expect(loginShellArgv('/bin/sh')[1][0]).toBe('-lc')
  })

  it('extracts the binary path from noisy profile output (last absolute-path line)', () => {
    expect(pathFromShellOutput('Last login: today\nwelcome!\n/Users/x/.local/bin/claude\n')).toBe(
      '/Users/x/.local/bin/claude',
    )
    expect(pathFromShellOutput('\n  /usr/local/bin/claude  \n')).toBe('/usr/local/bin/claude')
    expect(pathFromShellOutput('motd only, no hit\n')).toBeNull()
    expect(pathFromShellOutput('')).toBeNull()
  })

  it('known locations cover the official installer, migrate-installer and both brew prefixes', () => {
    const locs = knownClaudeLocations()
    expect(locs.some(l => l.endsWith('/.local/bin/claude'))).toBe(true)
    expect(locs.some(l => l.endsWith('/.claude/local/claude'))).toBe(true)
    expect(locs).toContain('/opt/homebrew/bin/claude')
    expect(locs).toContain('/usr/local/bin/claude')
  })
})
