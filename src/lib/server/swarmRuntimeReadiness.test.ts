import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resumeSwarmRuntime, type SwarmRuntimeCheckpoint } from './swarmRuntimeTransition'

const h = vi.hoisted(() => ({
  alive: true,
  terminal: { id: 'target-native', cwd: '/synthetic/project', agentSessionId: '11111111-1111-4111-8111-111111111111', deskLabel: '補給官' },
  read: vi.fn(), start: vi.fn(), phases: [] as string[], stored: undefined as SwarmRuntimeCheckpoint | undefined,
}))
vi.mock('./sdkSession', () => ({ getSdkSession: () => undefined, listSdkSessions: () => [], pushSdkInput: vi.fn() }))
vi.mock('./terminal', () => ({ getTerminal: () => h.terminal, isTerminalProcessAlive: () => h.alive,
  getTerminalScreen: () => ['─'.repeat(40), '❯ ', '─'.repeat(40), '⏵⏵ bypass permissions on'].join('\n'),
  listOwnerDeskTerminals: () => [h.terminal] }))
vi.mock('./swarmNativeTranscript', () => ({ readSwarmNativePublicConversation: h.read }))
vi.mock('./swarmOrchestrator', () => ({ drainSwarmEngines: vi.fn() }))
vi.mock('./swarmSupply', () => ({ spawnSwarmSupply: h.start, SUPPLY_DESK_LABEL: '補給官' }))
vi.mock('./swarmWorker', () => ({ spawnSwarmWorker: h.start }))
vi.mock('./swarmManager', () => ({ spawnSwarmManager: h.start }))
vi.mock('./presidentInbox', () => ({}))
vi.mock('./supplyNotice', () => ({}))
vi.mock('./swarmNativeRecovery', () => ({}))
vi.mock('./runtimeTransitionStore', () => ({ updateRuntimeCheckpoint: async (_scope: string, _revision: number, update: (checkpoint: unknown) => SwarmRuntimeCheckpoint) => {
  h.stored = update(h.stored)
  h.phases.push(h.stored.actors[0].launch!.phase)
} }))

const missing = () => Object.assign(new Error('synthetic native history is not created yet'), { code: 'ENOENT' })
const begin = () => resumeSwarmRuntime({ provider: 'claude' }, h.stored)
beforeEach(() => {
  vi.useFakeTimers()
  h.alive = true
  h.terminal = { id: 'target-native', cwd: '/synthetic/project', agentSessionId: '11111111-1111-4111-8111-111111111111', deskLabel: '補給官' }
  h.read.mockReset(); h.start.mockReset(); h.phases = []
  h.stored = { version: 1, revision: 1, capturedAt: new Date().toISOString(), engines: [], actors: [{
    id: 'retired-chatgpt', runtime: 'sdk', role: 'supply', provider: 'chatgpt', cwd: '/synthetic/project', projectPath: '/synthetic/project',
    agentSessionId: 'chatgpt-original', transcript: [], pendingInputs: [], repository: { head: '', branch: '', status: '' }, retired: true,
    launch: { operationId: h.terminal.agentSessionId, phase: 'activating', handleId: h.terminal.id, pausedStart: false, profile: { provider: 'claude' } },
  }] }
})
afterEach(() => { vi.useRealTimers() })

describe('the real default native handoff readiness loop', () => {
  it('waits for a fresh transcript to appear and confirm text on the same live actor, without another launch', async () => {
    h.read.mockRejectedValueOnce(missing()).mockResolvedValueOnce([]).mockResolvedValue([{ kind: 'text', text: 'Synthetic startup confirmed.' }])
    const observed = begin().then(() => undefined, error => error)
    await vi.advanceTimersByTimeAsync(40)
    expect(await observed).toBeUndefined()
    expect(h.read).toHaveBeenCalledTimes(3)
    expect(h.read).toHaveBeenCalledWith('/synthetic/project', h.terminal.agentSessionId)
    expect(h.phases).toEqual(['activating', 'restored'])
    expect(h.start).not.toHaveBeenCalled()
  })
  it.each(['EACCES', 'ENOTDIR'])('keeps nonmissing %s inspection errors held rather than claiming readiness', async code => {
    const error = Object.assign(new Error('Synthetic inspection denied.'), { code })
    h.read.mockRejectedValue(error)
    await expect(begin()).rejects.toBe(error)
    expect(h.stored!.actors[0].launch!.phase).toBe('activating')
    expect(h.start).not.toHaveBeenCalled()
  })
  it('does not retry or hide unconfirmed native tool effects', async () => {
    const error = new Error('The native conversation has unfinished tool receipts.')
    h.read.mockRejectedValue(error)
    await expect(begin()).rejects.toBe(error)
    expect(h.read).toHaveBeenCalledOnce()
    expect(h.stored!.actors[0].launch!.phase).toBe('activating')
  })
  it('stops waiting if the original process exits while its file is still missing', async () => {
    h.read.mockImplementation(async () => { h.alive = false; throw missing() })
    const observed = begin().then(() => undefined, error => error)
    await vi.advanceTimersByTimeAsync(20)
    expect(await observed).toMatchObject({ message: expect.stringContaining('exited') })
    expect(h.start).not.toHaveBeenCalled()
    expect(h.stored!.actors[0].launch!.phase).toBe('activating')
  })
  it.each(['agentSessionId', 'cwd'] as const)('does not confirm a changed %s after awaiting transcript inspection', async field => {
    h.read.mockImplementation(async () => {
      h.terminal = { ...h.terminal, [field]: field === 'cwd' ? '/synthetic/other-project' : '22222222-2222-4222-8222-222222222222' }
      return [{ kind: 'text', text: 'Text does not prove the original actor still owns this launch.' }]
    })
    await expect(begin()).rejects.toThrow('changed')
    expect(h.stored!.actors[0].launch!.phase).toBe('activating')
    expect(h.start).not.toHaveBeenCalled()
  })
  it('retains the existing startup deadline if the transcript never appears', async () => {
    h.read.mockRejectedValue(missing())
    const observed = begin().then(() => undefined, error => error)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await observed).toMatchObject({ message: expect.stringContaining('not confirmed startup') })
    expect(h.stored!.actors[0].launch!.phase).toBe('activating')
    expect(h.start).not.toHaveBeenCalled()
  })
})
