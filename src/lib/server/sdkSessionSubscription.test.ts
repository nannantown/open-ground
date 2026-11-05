import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const f = vi.hoisted(() => ({ auth: vi.fn(), hooks: vi.fn(), actions: vi.fn() }))
vi.mock('./subscriptionOnly', () => ({ assertClaudeSubscriptionLaunch: f.auth }))
vi.mock('./runtimeActionReceipts', () => ({ guardClaudeRuntimeTools: f.hooks, assertNoUncertainRuntimeActions: f.actions }))
import { __setDefaultQueryFnForTests, __setSdkImporterForTests, getSdkSession, preloadSdk, spawnSdkSession, terminateSdkSession, type SdkQueryParams } from './sdkSession'
import { withRuntimeOwner } from './runtimeOwner'
import * as runtimeOwner from './runtimeOwner'

const ids: string[] = []
beforeEach(() => {
  vi.spyOn(runtimeOwner, 'runtimeOwnerKey').mockImplementation(async expected => expected ?? 'synthetic-owner')
  f.auth.mockReset().mockResolvedValue({ PATH: '/synthetic/bin', CLAUDE_CONFIG_DIR: '/synthetic/claude', ANTHROPIC_API_KEY: undefined })
  f.hooks.mockReset().mockResolvedValue({ PreToolUse: [] })
  f.actions.mockReset().mockResolvedValue(undefined)
  __setDefaultQueryFnForTests(null)
})
afterEach(async () => {
  for (const id of ids.splice(0)) { terminateSdkSession(id); await vi.waitFor(() => expect(getSdkSession(id)?.reaped).toBe(true)) }
  __setSdkImporterForTests(null)
  vi.restoreAllMocks()
})
describe('real SDK launch admission (offline SDK fixture)', () => {
  const sdk = async () => {
    const query = vi.fn(({ prompt }: SdkQueryParams) => ({
      async *[Symbol.asyncIterator]() { for await (const _input of prompt) yield { type: 'result', subtype: 'success', terminal_reason: 'completed' } },
      interrupt: async () => {},
    }))
    __setSdkImporterForTests(async () => ({ query, USAGE_LIMIT_ERROR_PREFIXES: [] }))
    return { query, sdk: await preloadSdk() }
  }
  it('verifies the exact executable/environment and installs receipts before the SDK can start', async () => {
    const loaded = await sdk()
    const session = spawnSdkSession({ cwd: '/synthetic/project', role: 'manager', sdk: loaded.sdk,
      options: { cwd: '/synthetic/project', sessionId: 'synthetic-conversation', runtimeOwnerKey: 'admitted-owner', pathToClaudeCodeExecutable: '/synthetic/bin/claude', env: { ANTHROPIC_API_KEY: 'synthetic-key' } }, initialPrompt: 'status' })
    ids.push(session.id)
    await vi.waitFor(() => expect(getSdkSession(session.id)?.status).toBe('waiting'))
    expect(f.auth).toHaveBeenCalledExactlyOnceWith('/synthetic/project', { ANTHROPIC_API_KEY: 'synthetic-key', OPENGROUND_CLAUDE_BIN: '/synthetic/bin/claude' })
    expect(f.hooks).toHaveBeenCalledExactlyOnceWith('/synthetic/project', 'synthetic-conversation', undefined, 'admitted-owner')
    expect(loaded.query).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({
      env: { PATH: '/synthetic/bin', CLAUDE_CONFIG_DIR: '/synthetic/claude', ANTHROPIC_API_KEY: undefined }, hooks: { PreToolUse: [] },
    }) }))
    expect(loaded.query.mock.calls[0][0]).toHaveProperty('options')
    expect(loaded.query.mock.calls[0][0].options).not.toHaveProperty('runtimeOwnerKey')
  })
  it('never calls the SDK or a fallback when subscription verification fails', async () => {
    const loaded = await sdk()
    f.auth.mockRejectedValue(new Error('Only subscription login is permitted'))
    const session = spawnSdkSession({ cwd: '/synthetic/project', role: 'worker', sdk: loaded.sdk,
      options: { cwd: '/synthetic/project', sessionId: 'synthetic-conversation', env: { ANTHROPIC_API_KEY: 'synthetic-key' } }, initialPrompt: 'work' })
    ids.push(session.id)
    await vi.waitFor(() => expect(getSdkSession(session.id)?.reaped).toBe(true))
    expect(getSdkSession(session.id)?.status).toBe('failed')
    expect(loaded.query).not.toHaveBeenCalled()
    expect(f.hooks).not.toHaveBeenCalled()
  })
  it('does not downgrade an owner launch to a legacy launch after logout during asynchronous preflight', async () => {
    const loaded = await sdk()
    let release = () => {}
    const preflight = new Promise<void>(resolve => { release = resolve })
    f.auth.mockImplementation(async () => { await preflight; return {} })
    const session = withRuntimeOwner('original-owner', () => spawnSdkSession({ cwd: '/synthetic/project', role: 'manager', sdk: loaded.sdk,
      options: { cwd: '/synthetic/project', sessionId: 'owner-conversation' } }))
    ids.push(session.id)
    // Synthetic account revocation: owner-pinned launch fails, a legacy launch
    // would still be allowed by this fixture. No real CLI or account is read.
    f.hooks.mockImplementation(async (_cwd, _session, _hooks, expected) => {
      if (expected) throw new Error('Owner signed out during launch')
      return {}
    })
    release()
    await vi.waitFor(() => expect(getSdkSession(session.id)?.reaped).toBe(true))
    expect(f.hooks).toHaveBeenCalledExactlyOnceWith('/synthetic/project', 'owner-conversation', undefined, 'original-owner')
    expect(loaded.query).not.toHaveBeenCalled()
  })
})
