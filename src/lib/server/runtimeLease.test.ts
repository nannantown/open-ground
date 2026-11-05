import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { admitChatGptRuntime } from './runtimeLease'

const h = vi.hoisted(() => ({ provider: 'chatgpt', owner: 'owner-a', account: 'account-a', lockdown: false, accountReads: vi.fn() }))
vi.mock('./chatgptRuntime', () => ({ selectedRuntime: async () => h.provider }))
vi.mock('./runtimeOwner', async original => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async (expected?: string) => {
  if (!h.owner) throw new Error('signed out')
  if (expected && expected !== h.owner) throw new Error('owner account changed')
  return h.owner
} }))
vi.mock('./chatgptAuth', () => ({ getChatGptAccountKey: async () => { h.accountReads(); if (!h.account) throw new Error('disconnected'); return h.account } }))
vi.mock('./store', () => ({ getSettings: async () => ({ lockdownMode: h.lockdown }) }))
beforeEach(() => { h.provider = 'chatgpt'; h.owner = 'owner-a'; h.account = 'account-a'; h.lockdown = false; h.accountReads.mockClear() })
afterEach(() => vi.unstubAllEnvs())

describe('ChatGPT admitted-turn account lease', () => {
  it('allows the old accepted turn to settle after a provider preference change', async () => {
    const authorize = await admitChatGptRuntime('assistant')
    h.provider = 'claude'
    await expect(authorize()).resolves.toBeUndefined()
  })
  it.each(['assistant', 'swarm'] as const)('revokes %s execution on owner replacement or logout', async scope => {
    const authorize = await admitChatGptRuntime(scope)
    h.owner = 'owner-b'
    await expect(authorize()).rejects.toThrow('owner account changed')
    h.owner = ''
    await expect(authorize()).rejects.toThrow('signed out')
  })
  it('revokes access on provider-account replacement and disconnect', async () => {
    const authorize = await admitChatGptRuntime('swarm')
    h.account = 'account-b'
    await expect(authorize()).rejects.toThrow('ChatGPT account changed')
    h.account = ''
    await expect(authorize()).rejects.toThrow('disconnected')
  })
  it('stops in work mode before reading a provider credential identity again', async () => {
    const authorize = await admitChatGptRuntime('assistant')
    h.accountReads.mockClear(); h.lockdown = true
    await expect(authorize()).rejects.toThrow('work mode')
    expect(h.accountReads).not.toHaveBeenCalled()
  })
  it('does not infer ChatGPT authorization from a metered API-key environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-never-used')
    h.provider = 'claude'
    await expect(admitChatGptRuntime('assistant')).rejects.toThrow('not selected')
    expect(h.accountReads).not.toHaveBeenCalled()
  })
  it('rejects an old actor owner before inspecting the replacement account credentials', async () => {
    h.owner = 'owner-b'
    await expect(admitChatGptRuntime('swarm', 'owner-a')).rejects.toThrow('owner account changed')
    expect(h.accountReads).not.toHaveBeenCalled()
  })
})
