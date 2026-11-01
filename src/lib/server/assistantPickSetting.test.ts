import { describe, it, expect, beforeEach } from 'vitest'
import { getSettings, setUserSettings, setSettings } from './store'

// Settings.assistantModel / assistantEffort — the floating assistant's model and
// effort pick (owner 2026-11-01). POST /api/settings (setUserSettings) must
// accept both keys, narrow them to known literals, clear them on null, and drop
// a picked model the usable-models mask turns off. Read back through the
// production reader (getSettings). HOME is isolated by the global test setup.

describe('the assistant pick through POST /api/settings', () => {
  beforeEach(async () => {
    await setSettings({ assistantModel: undefined, assistantEffort: undefined, swarmAllowedModels: undefined })
  })

  it('persists a model and an effort', async () => {
    expect(await setUserSettings({ assistantModel: 'opus', assistantEffort: 'high' })).toEqual(expect.arrayContaining(['assistantModel', 'assistantEffort']))
    const s = await getSettings()
    expect([s.assistantModel, s.assistantEffort]).toEqual(['opus', 'high'])
  })

  it('null puts it back on auto; garbage is refused and the pick survives', async () => {
    await setUserSettings({ assistantModel: 'opus', assistantEffort: 'high' })
    await setUserSettings({ assistantModel: 'gpt', assistantEffort: 'huge' })
    expect((await getSettings()).assistantModel).toBe('opus')
    expect((await getSettings()).assistantEffort).toBe('high')
    await setUserSettings({ assistantModel: null, assistantEffort: null })
    const s = await getSettings()
    expect([s.assistantModel, s.assistantEffort]).toEqual([undefined, undefined])
  })

  it('turning the picked model off in the usable models puts the pick back on auto', async () => {
    await setUserSettings({ assistantModel: 'opus' })
    await setUserSettings({ swarmAllowedModels: { fable: true, opus: true, sonnet: false, haiku: true } })
    expect((await getSettings()).assistantModel).toBe('opus')
    await setUserSettings({ swarmAllowedModels: { fable: true, opus: false, sonnet: true, haiku: true } })
    expect((await getSettings()).assistantModel).toBeUndefined()
  })
})
