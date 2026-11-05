import { beforeEach, describe, expect, it, vi } from 'vitest'
const mock = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, owner: true, models: vi.fn() }))
vi.mock('./store', () => ({ getSettings: async () => mock.settings }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => mock.owner }))
vi.mock('./chatgptAuth', () => ({ listChatGptModels: mock.models }))
import { chatGptLaunchConfig, runtimeSpawnBlock, selectedRuntime } from './chatgptRuntime'
import { clearChatGptCooling, markChatGptRateLimited } from './chatgptQuota'
import { DEFAULT_SWARM_ALLOWED_MODELS } from '../types'

describe('ChatGPT runtime and Claude spending boundaries', () => {
  beforeEach(() => {
    mock.settings = {}; mock.owner = true
    mock.models.mockReset().mockResolvedValue([{ id: 'authorized-model', name: 'Authorized model', supportedEfforts: ['medium', 'high'] }])
    clearChatGptCooling()
  })
  it('preserves the existing default and keeps assistant/automatic choices independent', async () => {
    expect(await selectedRuntime('assistant')).toBe('claude')
    expect(await selectedRuntime('swarm')).toBe('claude')
    mock.settings = { assistantProvider: 'chatgpt', swarmProvider: 'claude' }
    expect(await selectedRuntime('assistant')).toBe('chatgpt')
    expect(await selectedRuntime('swarm')).toBe('claude')
    expect(mock.models).not.toHaveBeenCalled()
  })
  it('rechecks owner access and work mode instead of silently spending Claude quota', async () => {
    mock.settings = { assistantProvider: 'chatgpt', swarmProvider: 'chatgpt' }
    mock.owner = false
    await expect(chatGptLaunchConfig('assistant')).rejects.toThrow('owner')
    mock.owner = true; mock.settings.lockdownMode = true
    await expect(chatGptLaunchConfig('swarm')).rejects.toThrow('work mode')
    expect(mock.models).not.toHaveBeenCalled()
  })
  it('uses only catalog models and refuses an unavailable saved selection or effort', async () => {
    mock.settings = { assistantProvider: 'chatgpt', chatgptModel: 'authorized-model', chatgptEffort: 'high' }
    expect(await chatGptLaunchConfig('assistant')).toEqual({ model: 'authorized-model', effort: 'high' })
    mock.settings.chatgptModel = 'unavailable-model'
    await expect(chatGptLaunchConfig('assistant')).rejects.toThrow('choose a model')
    mock.settings.chatgptModel = 'authorized-model'; mock.settings.chatgptEffort = 'xhigh'
    await expect(chatGptLaunchConfig('assistant')).rejects.toThrow('reasoning')
  })
  it('ChatGPT cooling does not park Claude, and Claude model switches do not park ChatGPT', async () => {
    const now = Date.now()
    markChatGptRateLimited(now + 60_000)
    expect(await runtimeSpawnBlock(now, DEFAULT_SWARM_ALLOWED_MODELS)).toBeNull()
    mock.settings.swarmProvider = 'chatgpt'
    expect(await runtimeSpawnBlock(now, DEFAULT_SWARM_ALLOWED_MODELS)).toEqual({ kind: 'all-cooling', until: now + 60_000 })
    clearChatGptCooling()
    expect(await runtimeSpawnBlock(now, { fable: false, opus: false, sonnet: false, haiku: false })).toBeNull()
  })
})
