import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const mock = vi.hoisted(() => ({
  owner: true,
  get: vi.fn(), begin: vi.fn(), cancel: vi.fn(), disconnect: vi.fn(),
  coordinator: undefined as ReturnType<typeof import('@/lib/server/runtimeTransitions')['createRuntimeTransitionCoordinator']> | undefined,
}))
vi.mock('@/lib/server/chatgptAccess', () => ({ hasChatGptAccess: async () => mock.owner }))
vi.mock('@/lib/server/chatgptAuth', () => ({ getChatGptConnection: mock.get, listChatGptModels: async () => (await mock.get()).models, beginChatGptLogin: mock.begin, cancelChatGptLogin: mock.cancel, disconnectChatGpt: mock.disconnect }))
vi.mock('@/lib/server/authStore', async original => ({ ...(await original<typeof import('@/lib/server/authStore')>()), readSession: async () => ({ user: { id: 'synthetic-owner' } }) }))
vi.mock('@/lib/server/claudePreflight', () => ({ claudeRunPreflight: async () => ({ ok: true }) }))
vi.mock('@/lib/server/subscriptionOnly', () => ({ assertClaudeSubscriptionLaunch: async () => ({}) }))
vi.mock('@/lib/server/runtimeTransitions', async original => ({ ...(await original<typeof import('@/lib/server/runtimeTransitions')>()), runtimeTransitions: () => mock.coordinator! }))
import { chatgptRoutes } from '../chatgpt'
import { getSettings, setSettings, setChatGptPreferences } from '@/lib/server/store'
import { createRuntimeTransitionCoordinator } from '@/lib/server/runtimeTransitions'
import { validateRuntimePreferences } from '@/lib/server/runtimeTransitionValidation'
import { runtimeOwnerKey } from '@/lib/server/runtimeOwner'
const post = (path: string, body: object = {}) => chatgptRoutes.request(`/api/chatgpt/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('owner ChatGPT routes', () => {
  let priorHome: string | undefined
  beforeEach(async () => {
    priorHome = process.env.OPENGROUND_HOME
    process.env.OPENGROUND_HOME = await mkdtemp(join(tmpdir(), 'og-chatgpt-routes-'))
    mock.owner = true
    vi.clearAllMocks()
    mock.get.mockResolvedValue({ state: 'connected', email: 'owner@example.test', models: [{ id: 'catalog-model-1', name: 'Catalog model' }] })
    mock.begin.mockResolvedValue({ authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=public-state', loginId: 'login-1' })
    await setSettings({ lockdownMode: false, assistantProvider: undefined, swarmProvider: undefined, chatgptModel: undefined, chatgptEffort: undefined })
    mock.coordinator = createRuntimeTransitionCoordinator({
      profiles: async () => ({ assistant: { provider: 'claude' }, swarm: { provider: 'claude' } }),
      ownerKey: runtimeOwnerKey, validate: validateRuntimePreferences,
      commit: async patch => { await setChatGptPreferences(patch) },
      participant: async () => ({ drain: async () => null, retire: async () => {}, resume: async () => {} }),
    })
  })
  afterEach(async () => { await mock.coordinator?.settle(); process.env.OPENGROUND_HOME = priorHome })
  it('keeps identity and credential operations inaccessible to non-owners and foreign GET origins', async () => {
    mock.owner = false
    expect((await chatgptRoutes.request('/api/chatgpt/status')).status).toBe(403)
    expect((await post('login')).status).toBe(403)
    expect((await post('disconnect')).status).toBe(403)
    expect((await post('preferences', { assistantProvider: 'chatgpt' })).status).toBe(403)
    expect((await getSettings()).assistantProvider).toBeUndefined()
    mock.owner = true
    const foreignHeaders: Record<string, string>[] = [{ origin: 'https://foreign.example' }, { host: 'foreign.example' }]
    for (const headers of foreignHeaders) expect((await chatgptRoutes.request('/api/chatgpt/status', { headers })).status).toBe(403)
    expect(mock.get).not.toHaveBeenCalled()
    expect(mock.begin).not.toHaveBeenCalled()
  })
  it('returns only connection metadata, persists model preferences, and cannot mutate unrelated settings', async () => {
    const status = await (await chatgptRoutes.request('/api/chatgpt/status')).json()
    expect(status).toMatchObject({ connection: { state: 'connected', email: 'owner@example.test', models: [{ id: 'catalog-model-1', name: 'Catalog model' }] }, lockdown: false, preferences: {}, runtime: { assistant: { phase: 'stable', effective: { provider: 'claude' } }, swarm: { phase: 'stable', effective: { provider: 'claude' } } } })
    const requested = await post('preferences', { assistantProvider: 'chatgpt', swarmProvider: 'claude', chatgptModel: 'catalog-model-1', projects: [{ path: '/etc' }] })
    expect(requested.status).toBe(202)
    expect(await requested.json()).toMatchObject({ runtime: { assistant: { phase: 'draining', effective: { provider: 'claude' }, desired: { provider: 'chatgpt' } } } })
    await mock.coordinator!.settle()
    expect(await getSettings()).toMatchObject({ assistantProvider: 'chatgpt', swarmProvider: 'claude', chatgptModel: 'catalog-model-1', projects: [] })
    expect((await post('preferences', { chatgptModel: '$(bad)' })).status).toBe(400)
    expect((await getSettings()).chatgptModel).toBe('catalog-model-1')
  })
  it('work mode blocks connection/model network activity and runtime selection', async () => {
    await setSettings({ lockdownMode: true })
    expect(await (await chatgptRoutes.request('/api/chatgpt/status')).json()).toMatchObject({ lockdown: true, connection: { state: 'error', models: [], error: 'work-mode' } })
    expect((await post('login')).status).toBe(403)
    expect((await post('preferences', { assistantProvider: 'chatgpt' })).status).toBe(400)
    expect(mock.get).not.toHaveBeenCalled()
    expect(mock.begin).not.toHaveBeenCalled()
  })
  it('allows cancellation after reopening settings without exposing credentials', async () => {
    expect(await (await post('login')).json()).toEqual({ authorizationUrl: 'https://auth.openai.com/api/accounts/authorize?state=public-state', loginId: 'login-1' })
    await post('cancel')
    expect(mock.cancel).toHaveBeenCalledWith('login-1')
    await post('disconnect')
    expect(mock.disconnect).toHaveBeenCalledOnce()
  })
})
