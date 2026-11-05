import { beforeEach, describe, expect, it, vi } from 'vitest'
const access = vi.hoisted(() => ({ allowed: true }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => access.allowed }))
import { getSettings, setSettings, setUserSettings, setChatGptPreferences } from './store'

describe('owner ChatGPT preferences through the production settings reader', () => {
  beforeEach(async () => {
    access.allowed = true
    await setSettings({ assistantProvider: undefined, swarmProvider: undefined, chatgptModel: undefined, chatgptEffort: undefined, assistantModel: 'opus', assistantEffort: 'max', lockdownMode: false, displayName: '' })
  })
  it('persists independent runtimes and leaves Claude choices intact', async () => {
    await setChatGptPreferences({ assistantProvider: 'chatgpt', swarmProvider: 'claude', chatgptModel: 'catalog-model-1', chatgptEffort: 'high' })
    expect(await getSettings()).toMatchObject({ assistantProvider: 'chatgpt', swarmProvider: 'claude', chatgptModel: 'catalog-model-1', chatgptEffort: 'high', assistantModel: 'opus', assistantEffort: 'max' })
    await setChatGptPreferences({ assistantProvider: null, swarmProvider: null, chatgptModel: null, chatgptEffort: null })
    const s = await getSettings()
    expect([s.assistantProvider, s.swarmProvider, s.chatgptModel, s.chatgptEffort]).toEqual([undefined, undefined, undefined, undefined])
  })
  it('refuses non-owner writes and limits the dedicated setter to runtime preferences', async () => {
    access.allowed = false
    await setChatGptPreferences({ assistantProvider: 'chatgpt', swarmProvider: 'chatgpt', chatgptModel: 'catalog-model-1', chatgptEffort: 'high', displayName: 'Kept preference' })
    const s = await getSettings()
    expect([s.assistantProvider, s.swarmProvider, s.chatgptModel, s.chatgptEffort]).toEqual([undefined, undefined, undefined, undefined])
    expect(s.displayName).not.toBe('Kept preference')
  })
  it('a stale full settings save cannot revert a newer ChatGPT runtime selection', async () => {
    await setChatGptPreferences({ assistantProvider: 'chatgpt', chatgptModel: 'catalog-model-1' })
    await setUserSettings({ assistantProvider: 'claude', chatgptModel: 'old-model', displayName: 'New display name' })
    expect(await getSettings()).toMatchObject({ assistantProvider: 'chatgpt', chatgptModel: 'catalog-model-1', displayName: 'New display name' })
  })
  it('refuses invalid literals and cannot select ChatGPT while work mode is enabled', async () => {
    await setChatGptPreferences({ assistantProvider: 'claude', swarmProvider: 'claude', chatgptModel: 'catalog-model-1', chatgptEffort: 'high' })
    await setChatGptPreferences({ assistantProvider: 'other', chatgptModel: '--exec $HOME', chatgptEffort: 'max' })
    expect(await getSettings()).toMatchObject({ assistantProvider: 'claude', chatgptModel: 'catalog-model-1', chatgptEffort: 'high' })
    await setUserSettings({ lockdownMode: true })
    await setChatGptPreferences({ assistantProvider: 'chatgpt', swarmProvider: 'chatgpt' })
    expect(await getSettings()).toMatchObject({ lockdownMode: true, assistantProvider: 'claude', swarmProvider: 'claude' })
    await setChatGptPreferences({ assistantProvider: 'chatgpt' })
    expect((await getSettings()).assistantProvider).toBe('claude')
  })
})
