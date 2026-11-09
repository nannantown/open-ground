import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assertClaudeSubscriptionLaunch, assertClaudeSubscriptionStatus, assertSubscriptionSettings, subscriptionOnlyEnvironment } from './subscriptionOnly'
import { buildLaunchCommand } from './claudeTerminal'
import { homedir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ probe: vi.fn(), read: vi.fn() }))
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: h.probe }),
}))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(), readFile: h.read }))
beforeEach(() => { h.probe.mockReset(); h.read.mockReset().mockRejectedValue(Object.assign(new Error('synthetic absent settings'), { code: 'ENOENT' })) })
const source = { PATH: '/fixture/bin', OPENGROUND_CLAUDE_BIN: '/fixture/claude', CLAUDE_CONFIG_DIR: '/fixture/config', ANTHROPIC_API_KEY: 'synthetic-never-inherited' }
const signedOut = { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty', apiKeySource: null }
const signedIn = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: null }

describe('subscription-only execution boundary', () => {
  it('shadows metered parent env in an SDK overlay without mutating that parent', () => {
    const parent = { PATH: '/bin', ANTHROPIC_API_KEY: 'synthetic-key', ANTHROPIC_BASE_URL: 'https://fake.invalid', CLAUDE_CODE_USE_BEDROCK: '1', OPENAI_API_KEY: 'synthetic-key' }
    const clean = { ...parent, ...subscriptionOnlyEnvironment(parent) }
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined(); expect(clean.OPENAI_API_KEY).toBeUndefined()
    expect(clean.ANTHROPIC_BASE_URL).toBeUndefined(); expect(clean.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(clean.PATH).toBe('/bin'); expect(parent.ANTHROPIC_API_KEY).toBe('synthetic-key')
  })
  it('requires positive first-party subscription proof, never merely loggedIn', () => {
    expect(() => assertClaudeSubscriptionStatus({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })).not.toThrow()
    for (const status of [{ loggedIn: true }, { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'bedrock' }, { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: 'helper' }]) expect(() => assertClaudeSubscriptionStatus(status)).toThrow()
  })
  it('refuses API helpers and alternate providers from settings instead of invoking them', () => {
    expect(() => assertSubscriptionSettings({ permissions: { allow: ['Read'] } })).not.toThrow()
    for (const settings of [{ apiKeyHelper: 'do-not-run' }, { env: { ANTHROPIC_API_KEY: 'synthetic-key' } }, { env: { CLAUDE_CODE_USE_VERTEX: '1' } }]) expect(() => assertSubscriptionSettings(settings)).toThrow()
  })
  it('removes paid env at the native CLI boundary after a login profile could set it again', () => {
    const posix = buildLaunchCommand(["'/fixture/claude'"], 'darwin', { ANTHROPIC_API_KEY: 'synthetic-key', CLAUDE_CONFIG_DIR: '/fixture/config' }, ['ANTHROPIC_API_KEY'])
    expect(posix).toContain("env -u ANTHROPIC_API_KEY '/fixture/claude'")
    expect(posix).not.toContain('synthetic-key')
    const windows = buildLaunchCommand(["'C:\\fixture\\claude.exe'"], 'win32', {}, ['ANTHROPIC_API_KEY'])
    expect(windows).toContain('Remove-Item Env:ANTHROPIC_API_KEY')
  })
  it('classifies the CLI exit-one signed-out JSON without returning command, stdout or stderr', async () => {
    h.probe.mockRejectedValue(Object.assign(new Error('Command failed: /private/host/claude auth status; synthetic-private-output'), {
      code: 1, killed: false, signal: null, stdout: JSON.stringify(signedOut), stderr: 'synthetic-private-output',
    }))
    await expect(assertClaudeSubscriptionLaunch('/fixture/project', source)).rejects.toThrow(/^Sign in to a Claude subscription\./)
    const error = await assertClaudeSubscriptionLaunch('/fixture/project', source).catch(error => error as Error)
    expect(String(error)).not.toContain('/private/host'); expect(String(error)).not.toContain('synthetic-private-output')
  })
  it('verifies the exact cwd/binary with the sanitized child overlay and accepts only successful subscription proof', async () => {
    h.probe.mockResolvedValue({ stdout: JSON.stringify(signedIn) })
    const env = await assertClaudeSubscriptionLaunch('/fixture/project', source)
    expect(h.probe).toHaveBeenCalledExactlyOnceWith('/fixture/claude', ['auth', 'status'], expect.objectContaining({ cwd: '/fixture/project', env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/fixture/config', ANTHROPIC_API_KEY: undefined }) }))
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  })
  it('preserves the normal login namespace when config is absent, while still inspecting default settings', async () => {
    // Field observation: the same official CLI/cwd reported max/claude.ai with
    // no override, but none/loggedOut when the default path was explicitly set.
    // This fake exposes that namespace distinction without invoking a vendor.
    h.probe.mockImplementation(async (_binary, _args, options: { env: NodeJS.ProcessEnv }) => {
      if (options.env.CLAUDE_CONFIG_DIR !== undefined) throw Object.assign(new Error('synthetic separate auth namespace'), { code: 1, stdout: JSON.stringify(signedOut) })
      return { stdout: JSON.stringify(signedIn) }
    })
    const normal: NodeJS.ProcessEnv = { PATH: '/fixture/bin', OPENGROUND_CLAUDE_BIN: '/fixture/claude' }
    const env = await assertClaudeSubscriptionLaunch('/fixture/project', normal)
    expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(h.probe.mock.calls[0][2].env).not.toHaveProperty('CLAUDE_CONFIG_DIR')
    expect(h.read).toHaveBeenCalledWith(join(homedir(), '.claude', 'settings.json'), 'utf8')
    await expect(assertClaudeSubscriptionLaunch('/fixture/project', { ...normal, CLAUDE_CONFIG_DIR: join(homedir(), '.claude') })).rejects.toThrow(/^Sign in to a Claude subscription\./)
  })
  it.each([
    { code: 1, stdout: JSON.stringify(signedIn) },
    { code: 1, stdout: 'synthetic-private-output' },
    { code: 1, killed: true, signal: 'SIGTERM', stdout: JSON.stringify(signedOut) },
    { code: 2, stdout: JSON.stringify(signedOut) },
    { code: 'ENOENT', stdout: '' },
  ])('fails closed and sanitizes an unproven auth-status failure: %j', async failure => {
    h.probe.mockRejectedValue(Object.assign(new Error('Command failed: /private/host/claude synthetic-private-output'), { killed: false, signal: null, stderr: 'synthetic-private-output', ...failure }))
    await expect(assertClaudeSubscriptionLaunch('/fixture/project', source)).rejects.toThrow(/^Claude subscription authentication could not be verified\./)
  })
  it('does not expose malformed successful auth JSON', async () => {
    h.probe.mockResolvedValue({ stdout: 'synthetic-private-output is not JSON' })
    await expect(assertClaudeSubscriptionLaunch('/fixture/project', source)).rejects.toThrow(/^Claude subscription authentication could not be verified\./)
  })
})
