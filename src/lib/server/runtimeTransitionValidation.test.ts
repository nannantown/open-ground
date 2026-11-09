import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getSettings } from './store'
import { hasChatGptAccess } from './chatgptAccess'
import { listChatGptModels } from './chatgptAuth'
import { claudeRunPreflight } from './claudePreflight'
import { chatGptShellPreflight } from './chatgptTools'
import { validateRuntimePreferences } from './runtimeTransitionValidation'
import { assertClaudeSubscriptionLaunch } from './subscriptionOnly'
import { tmpdir } from 'node:os'
import type { Settings } from '../types'

vi.mock('./store', () => ({ getSettings: vi.fn() }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: vi.fn() }))
vi.mock('./chatgptAuth', () => ({ listChatGptModels: vi.fn() }))
vi.mock('./claudePreflight', () => ({ claudeRunPreflight: vi.fn() }))
vi.mock('./chatgptTools', () => ({ chatGptShellPreflight: vi.fn() }))
vi.mock('./subscriptionOnly', () => ({ assertClaudeSubscriptionLaunch: vi.fn() }))

const settings = (patch: Partial<Settings> = {}): Settings => ({ projectsRoot: null, archiveDirName: '_archive', excludePatterns: [], assistantProvider: 'claude', swarmProvider: 'claude', ...patch })
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getSettings).mockResolvedValue(settings())
  vi.mocked(hasChatGptAccess).mockResolvedValue(true)
  vi.mocked(claudeRunPreflight).mockResolvedValue({ ok: true })
  vi.mocked(listChatGptModels).mockRejectedValue(new Error('ChatGPT account is offline.'))
  vi.mocked(assertClaudeSubscriptionLaunch).mockResolvedValue({})
})

describe('runtime preference validation respects the affected execution scope', () => {
  it.each(['assistant', 'swarm'] as const)('can return %s to Claude while the other scope still selects an offline ChatGPT account', async (scope) => {
    vi.mocked(getSettings).mockResolvedValue(settings({ assistantProvider: 'chatgpt', swarmProvider: 'chatgpt', chatgptModel: 'offline-gpt' }))
    const patch = scope === 'assistant' ? { assistantProvider: 'claude' } as const : { swarmProvider: 'claude' } as const
    await expect(validateRuntimePreferences(patch)).resolves.toBeUndefined()
    expect(claudeRunPreflight).toHaveBeenCalledTimes(1)
    expect(assertClaudeSubscriptionLaunch).toHaveBeenCalledWith(tmpdir())
    expect(listChatGptModels).not.toHaveBeenCalled()
    expect(chatGptShellPreflight).not.toHaveBeenCalled()
  })
  it.each([{ chatgptModel: 'future-gpt' }, { chatgptEffort: 'xhigh' }] as const)('can save an unused ChatGPT preference without requiring an account or shell: %j', async (patch) => {
    vi.mocked(getSettings).mockResolvedValue(settings({ lockdownMode: true }))
    await expect(validateRuntimePreferences(patch)).resolves.toBeUndefined()
    expect(listChatGptModels).not.toHaveBeenCalled()
    expect(chatGptShellPreflight).not.toHaveBeenCalled()
    expect(claudeRunPreflight).not.toHaveBeenCalled()
    expect(assertClaudeSubscriptionLaunch).not.toHaveBeenCalled()
  })
  it('still requires the ChatGPT catalog when a shared model changes an active ChatGPT scope', async () => {
    vi.mocked(getSettings).mockResolvedValue(settings({ assistantProvider: 'chatgpt' }))
    await expect(validateRuntimePreferences({ chatgptModel: 'next-gpt' })).rejects.toThrow('ChatGPT account is offline.')
    expect(listChatGptModels).toHaveBeenCalledTimes(1)
    expect(claudeRunPreflight).not.toHaveBeenCalled()
  })
  it('rejects an unsupported reasoning choice for the selected active ChatGPT model', async () => {
    vi.mocked(getSettings).mockResolvedValue(settings({ swarmProvider: 'chatgpt', chatgptModel: 'selected-gpt' }))
    vi.mocked(listChatGptModels).mockResolvedValue([{ id: 'selected-gpt', name: 'Selected GPT', supportedEfforts: ['low', 'medium'] }])
    await expect(validateRuntimePreferences({ chatgptEffort: 'xhigh' })).rejects.toThrow('does not support')
    expect(chatGptShellPreflight).not.toHaveBeenCalled()
  })
  it('does not bypass owner authorization when moving away from an offline account', async () => {
    vi.mocked(hasChatGptAccess).mockResolvedValue(false)
    await expect(validateRuntimePreferences({ swarmProvider: 'claude' })).rejects.toThrow('Owner sign-in is required.')
    expect(getSettings).not.toHaveBeenCalled()
    expect(claudeRunPreflight).not.toHaveBeenCalled()
    expect(listChatGptModels).not.toHaveBeenCalled()
  })
  it('checks shared subscription auth once before switching, without probing every registered project', async () => {
    vi.mocked(getSettings).mockResolvedValue(settings({ swarmProvider: 'chatgpt', projects: Array.from({ length: 54 }, (_, i) => ({ id: `project-${i}`, path: `/inactive-${i}`, addedAt: '2026-11-09T00:00:00.000Z' })) }))
    vi.mocked(assertClaudeSubscriptionLaunch).mockRejectedValue(new Error('Sign in to a Claude subscription.'))
    await expect(validateRuntimePreferences({ swarmProvider: 'claude' })).rejects.toThrow('Sign in to a Claude subscription.')
    expect(assertClaudeSubscriptionLaunch).toHaveBeenCalledExactlyOnceWith(tmpdir())
  })
  it('probes assistant auth in the parent of its new temporary session, without reading unrelated project auth', async () => {
    await validateRuntimePreferences({ assistantProvider: 'claude' })
    expect(assertClaudeSubscriptionLaunch).toHaveBeenCalledExactlyOnceWith(tmpdir())
  })
})
