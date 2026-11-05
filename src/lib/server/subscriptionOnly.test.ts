import { describe, expect, it } from 'vitest'
import { assertClaudeSubscriptionStatus, assertSubscriptionSettings, subscriptionOnlyEnvironment } from './subscriptionOnly'
import { buildLaunchCommand } from './claudeTerminal'

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
})
