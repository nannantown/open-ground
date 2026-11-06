import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSwarmWorker } from './swarmWorker'
import { spawnSwarmSupply } from './swarmSupply'
import { spawnSwarmManager } from './swarmManager'

const fixture = vi.hoisted(() => ({ allowed: false, select: vi.fn(async () => 'chatgpt' as const), spawn: vi.fn(), record: vi.fn(async () => {}) }))
vi.mock('./automationPolicy', async (original) => {
  const actual = await original<typeof import('./automationPolicy')>()
  return { ...actual, assertAutomaticOperationAllowed: async () => { if (!fixture.allowed) throw new actual.AutomationPolicyError() } }
})
vi.mock('./swarmRuntimeAdmission', async (original) => ({ ...await original<typeof import('./swarmRuntimeAdmission')>(), trackSwarmRuntimeLaunch: (_handoff: unknown, launch: () => Promise<unknown>) => launch() }))
vi.mock('./chatgptRuntime', async (original) => ({ ...await original<typeof import('./chatgptRuntime')>(), selectedRuntime: () => fixture.select(), chatGptLaunchConfig: async () => ({ model: 'fixture' }) }))
vi.mock('./sdkSession', async (original) => ({ ...await original<typeof import('./sdkSession')>(), spawnSdkSession: fixture.spawn }))
vi.mock('./swarmSessions', async (original) => ({ ...await original<typeof import('./swarmSessions')>(), recordSwarmSession: fixture.record }))
vi.mock('./promptLang', async (original) => ({ ...await original<typeof import('./promptLang')>(), getPromptLang: async () => 'ja' }))
vi.mock('./ogManageSkill', () => ({ installOgManageSkill: async () => ({ outcome: 'installed', path: '/fixture/skill' }) }))
beforeEach(() => {
  fixture.allowed = false
  fixture.select.mockReset().mockResolvedValue('chatgpt')
  fixture.spawn.mockReset()
  fixture.record.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('automatic admission reaches the real worker and desk launch leaves', () => {
  it.each(['worker', 'supply', 'manager'] as const)('refuses a default automatic %s launch before provider selection or SDK spawn outside', async role => {
    const pending = role === 'worker'
      ? spawnSwarmWorker({ projectPath: '/fixture/project', title: 'Fixture', hint: 'fixture' })
      : role === 'supply' ? spawnSwarmSupply({ projectPath: '/fixture/project' }) : spawnSwarmManager({ projectPath: '/fixture/project' })
    await expect(pending).rejects.toMatchObject({ code: 'automation-frame-off' })
    expect(fixture.select).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.record).not.toHaveBeenCalled()
  })

  it.each(['supply', 'manager'] as const)('lets a server-authorized owner %s conversation reach its ordinary provider checks outside', async role => {
    fixture.select.mockRejectedValue(new Error('synthetic provider checkpoint'))
    const pending = role === 'supply'
      ? spawnSwarmSupply({ projectPath: '/fixture/project', cause: 'owner' })
      : spawnSwarmManager({ projectPath: '/fixture/project', cause: 'owner' })
    await expect(pending).rejects.toThrow('synthetic provider checkpoint')
    expect(fixture.select).toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('does not create a ChatGPT president when membership changes during its final awaited launch check', async () => {
    fixture.allowed = true
    await expect(spawnSwarmSupply({ projectPath: '/fixture/project', fresh: true,
      beforeLaunch: async () => { fixture.allowed = false },
    })).rejects.toMatchObject({ code: 'automation-frame-off' })
    expect(fixture.select).toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
    expect(fixture.record).not.toHaveBeenCalled()
  })
})
