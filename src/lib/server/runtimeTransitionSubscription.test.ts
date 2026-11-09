import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { openGroundHome } from './paths'
import { createRuntimeTransitionCoordinator } from './runtimeTransitions'
import { getRuntimeJournal, runtimeAdmissionBlocked } from './runtimeTransitionStore'
import { validateRuntimePreferences } from './runtimeTransitionValidation'

const h = vi.hoisted(() => ({ signedIn: true, auth: vi.fn() }))
vi.mock('./store', () => ({ getSettings: async () => ({ assistantProvider: 'chatgpt', swarmProvider: 'chatgpt', projects: [] }) }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => true }))
vi.mock('./chatgptAuth', () => ({ listChatGptModels: vi.fn() }))
vi.mock('./claudePreflight', () => ({ claudeRunPreflight: async () => ({ ok: true }) }))
vi.mock('./chatgptTools', () => ({ chatGptShellPreflight: vi.fn() }))
vi.mock('./subscriptionOnly', () => ({ assertClaudeSubscriptionLaunch: h.auth }))
vi.mock('./sdkSession', () => ({ listSdkSessions: () => [] }))
vi.mock('./terminal', () => ({ listOwnerDeskTerminals: () => [] }))
vi.mock('./swarmSupplyRuntime', () => ({ SUPPLY_DESK_LABEL: '補給官' }))
let previousHome: string | undefined
beforeEach(async () => {
  previousHome = process.env.OPENGROUND_HOME
  process.env.OPENGROUND_HOME = await mkdtemp(join(openGroundHome(), 'subscription-switch-'))
  h.signedIn = true; h.auth.mockReset().mockImplementation(async () => { if (!h.signedIn) throw new Error('Sign in to a Claude subscription.'); return {} })
})
afterEach(() => { process.env.OPENGROUND_HOME = previousHome })
const rig = () => {
  let oldActorRunning = true, modelInputs = 0
  const participant = { drain: vi.fn(async () => ({ accepted: ['original-owner-message'] })),
    retire: vi.fn(async () => { oldActorRunning = false }), resume: vi.fn(async () => { await h.auth('/fixture/target'); modelInputs++ }) }
  const commit = vi.fn(async () => {})
  const coordinator = createRuntimeTransitionCoordinator({ profiles: async () => ({ assistant: { provider: 'chatgpt' }, swarm: { provider: 'chatgpt' } }),
    ownerKey: async () => 'synthetic-owner', validate: validateRuntimePreferences, commit, participant: async () => participant })
  return { coordinator, participant, commit, oldActorRunning: () => oldActorRunning, modelInputs: () => modelInputs }
}
describe('subscription proof precedes accepting a provider transition', () => {
  it.each(['assistant', 'swarm'] as const)('keeps the old %s actor and settings when cached availability passes but subscription auth is signed out', async scope => {
    const f = rig(); h.signedIn = false
    try { await expect(f.coordinator.request(scope === 'assistant' ? { assistantProvider: 'claude' } : { swarmProvider: 'claude' })).rejects.toThrow('Sign in to a Claude subscription.') }
    finally { await f.coordinator.settle() }
    expect(f.oldActorRunning()).toBe(true); expect(f.modelInputs()).toBe(0)
    expect(f.participant.drain).not.toHaveBeenCalled(); expect(f.participant.retire).not.toHaveBeenCalled(); expect(f.participant.resume).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
    expect(getRuntimeJournal()?.pending).toBeUndefined()
    expect(runtimeAdmissionBlocked(scope)).toBe(false)
    expect((await f.coordinator.status())[scope]).toMatchObject({ phase: 'stable', effective: { provider: 'chatgpt' }, desired: { provider: 'chatgpt' } })
  })
  it('retains recovery after auth is revoked between validation and the exact launch, without another automatic attempt', async () => {
    const f = rig()
    f.participant.retire.mockImplementation(async () => { h.signedIn = false })
    await f.coordinator.request({ swarmProvider: 'claude' }); await f.coordinator.settle()
    expect((await f.coordinator.status()).swarm).toMatchObject({ phase: 'attention', effective: { provider: 'chatgpt' }, desired: { provider: 'claude' } })
    expect(getRuntimeJournal()?.pending).toMatchObject({ committed: true, retired: ['swarm'], checkpoints: { swarm: { accepted: ['original-owner-message'] } } })
    expect(f.modelInputs()).toBe(0); expect(f.participant.resume).toHaveBeenCalledTimes(1)
    expect(f.participant.retire).toHaveBeenCalledTimes(1); expect(f.commit).toHaveBeenCalledTimes(1)
    await f.coordinator.status(); await f.coordinator.settle()
    expect(f.participant.resume).toHaveBeenCalledTimes(1); expect(runtimeAdmissionBlocked('swarm')).toBe(true)
  })
})
