import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  session: null as { user: { id: string; email: string } } | null,
  settings: {} as { swarmLocalOwner?: boolean; swarmOptIn?: boolean },
}))
vi.mock('./authStore', () => ({ readSession: async () => state.session }))
vi.mock('./store', () => ({ getSettings: async () => state.settings }))
vi.mock('./supabaseAuth', () => ({ readAuthConfig: () => null, getFreshAccessToken: async () => null }))

import { hasChatGptAccess } from './chatgptAccess'
import { hasSwarmOwnerAccess } from './swarmGate'

beforeEach(() => {
  state.session = null
  state.settings = {}
  vi.stubEnv('OPENGROUND_OWNER_EMAILS', 'owner@example.test')
  vi.stubEnv('OPENGROUND_TESTER_EMAILS', 'tester@example.test')
  vi.stubEnv('OPENGROUND_LOCAL_OWNER', '')
})
afterEach(() => vi.unstubAllEnvs())

describe('ChatGPT access requires a signed-in owner account', () => {
  it('refuses a signed-out local environment unlock while preserving the general Swarm unlock', async () => {
    vi.stubEnv('OPENGROUND_LOCAL_OWNER', '1')
    expect(await hasSwarmOwnerAccess()).toBe(true)
    expect(await hasChatGptAccess()).toBe(false)
  })

  it('refuses a tester with the local settings unlock while preserving the general Swarm unlock', async () => {
    state.session = { user: { id: 'synthetic-tester', email: 'tester@example.test' } }
    state.settings.swarmLocalOwner = true
    expect(await hasSwarmOwnerAccess()).toBe(true)
    expect(await hasChatGptAccess()).toBe(false)
  })

  it.each(['tester@example.test', 'ordinary@example.test'])('refuses public opt-in for %s without changing the public Swarm gate', async (email) => {
    state.session = { user: { id: 'synthetic-user', email } }
    state.settings.swarmOptIn = true
    if (process.platform === 'darwin') expect(await hasSwarmOwnerAccess()).toBe(true)
    expect(await hasChatGptAccess()).toBe(false)
  })

  it('allows the signed-in owner without requiring either local unlock or public opt-in', async () => {
    state.session = { user: { id: 'synthetic-owner', email: 'owner@example.test' } }
    expect(await hasChatGptAccess()).toBe(true)
  })

  it('revokes ChatGPT access immediately at sign-out even when local unlock stays enabled', async () => {
    state.session = { user: { id: 'synthetic-owner', email: 'owner@example.test' } }
    state.settings.swarmLocalOwner = true
    expect(await hasChatGptAccess()).toBe(true)
    state.session = null
    expect(await hasChatGptAccess()).toBe(false)
    expect(await hasSwarmOwnerAccess()).toBe(true)
  })

  it('refuses an owner email without a signed-in user identity', async () => {
    state.session = { user: { id: '', email: 'owner@example.test' } }
    expect(await hasChatGptAccess()).toBe(false)
  })
})
