import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptAssistantTurn, __resetAssistantRuntimeForTest, getAssistantTurnReceipt, readAssistantRuntime, resetAssistantRuntimeState } from './assistantRuntimeStore'
import { askAssistant, acceptAssistantInput, __resetAssistantMemory, __forgetAssistantExecutionForTest,
  resumeQueuedAssistantTurns, waitForAssistantRuntimeIdle } from './phoneAssistant'
import { clearAssistantLog, clearAssistantMemory, readAssistantLog, readAssistantMemory, writeAssistantMemory } from './assistantMemory'
import * as assistantMemory from './assistantMemory'
import { __resetProposals } from './assistantProposals'
import { cancelAssistantRuntimeDrain, drainAssistantRuntime, resetAssistantRuntime, retireAssistantRuntime, resumeAssistantRuntime } from './assistantRuntimeTransition'
import { withAssistantAccessScope } from './phoneAssistant'
import { withLocalClaudeAssistantScope } from './assistantRuntimeStore'
import { setSettings } from './store'
import { setLockdownCache } from './lockdown'
import type { AssistantModel } from './assistantSession'

const h = vi.hoisted(() => ({ blocked: false, owner: true, local: false, ownerKey: 'owner-a' }))
vi.mock('./runtimeTransitionStore', async original => ({ ...await original<typeof import('./runtimeTransitionStore')>(), runtimeAdmissionBlocked: () => h.blocked, getRuntimeTransition: () => undefined }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => h.owner }))
vi.mock('./assistantAccess', () => ({ hasAssistantAccess: async () => h.owner || h.local }))
vi.mock('./runtimeOwner', async original => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async (expected?: string) => {
  if (!h.owner || expected && expected !== h.ownerKey) throw new Error('owner changed')
  return h.ownerKey
} }))
const digest = async () => ({ text: 'synthetic state', projects: [] })
const model = () => {
  const systems: string[] = []
  const fake = { warm: vi.fn(async () => {}), ask: vi.fn(async (o: Parameters<AssistantModel['ask']>[0]) => { systems.push(await o.system()); return 'synthetic reply' }) } satisfies AssistantModel
  return { ...fake, systems }
}
beforeEach(async () => {
  h.blocked = true
  h.owner = true; h.local = false; h.ownerKey = 'owner-a'
  __resetAssistantRuntimeForTest(); __resetAssistantMemory(); __resetProposals()
  setLockdownCache(false)
  await clearAssistantLog(); await clearAssistantMemory(); await setSettings({ language: 'en' })
})
afterEach(async () => { h.blocked = true; await waitForAssistantRuntimeIdle() })

describe('assistant transition/restart boundaries', () => {
  it('cancels a pre-retirement drain without interrupting its admitted attempt or prematurely dequeuing new work', async () => {
    let release!: (answer: string) => void
    const old: AssistantModel = { warm: async () => {}, ask: vi.fn(() => new Promise<string>(resolve => { release = resolve })) }
    h.blocked = false
    const answering = askAssistant('keep running', { clientId: 'keep-active', model: old, digest })
    await vi.waitFor(() => expect(old.ask).toHaveBeenCalledOnce())
    const generation = readAssistantRuntime().generation
    h.blocked = true
    const draining = drainAssistantRuntime()
    const next = model()
    await acceptAssistantInput('after cancellation', { clientId: 'keep-queued', model: next, digest })
    await cancelAssistantRuntimeDrain()
    expect(readAssistantRuntime().paused).toBe(false)
    expect(readAssistantRuntime().generation).toBe(generation)
    expect(readAssistantRuntime().turns[0].state).toBe('running')
    expect(next.ask).not.toHaveBeenCalled()
    release('same old actor finished')
    await expect(answering).resolves.toMatchObject({ reply: 'same old actor finished' })
    await draining
    expect(next.ask).not.toHaveBeenCalled()
    h.blocked = false
    await resumeQueuedAssistantTurns()
    expect(next.ask).toHaveBeenCalledOnce()
  })
  it.each(['drain-first', 'reset-first'] as const)('keeps the reset pause through drain cancellation and releases it exactly once (%s)', async order => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const clear = assistantMemory.clearAssistantMemory
    const clearing = vi.spyOn(assistantMemory, 'clearAssistantMemory').mockImplementation(async () => { await gate; return clear() })
    if (order === 'drain-first') await drainAssistantRuntime()
    const resetting = resetAssistantRuntime({ operationId: `reset-during-${order}`, kind: 'delete-memory' })
    try {
      await vi.waitFor(() => expect(readAssistantRuntime().operations[0]?.phase).toBe('prepared'))
      if (order === 'reset-first') await drainAssistantRuntime()
      await cancelAssistantRuntimeDrain()
      expect(readAssistantRuntime()).toMatchObject({ drainPaused: false, paused: true })
      release()
      await resetting
      expect(readAssistantRuntime()).toMatchObject({ drainPaused: false, paused: false })
      expect(readAssistantRuntime().operations[0].phase).toBe('completed')
    } finally { release(); await resetting; clearing.mockRestore() }
  })
  it('accepts and deduplicates while draining, then restores a durable queued request without its old callbacks', async () => {
    const first = model()
    const accepted = await acceptAssistantInput('synthetic queued line', { clientId: 'queued-id', model: first, digest })
    expect(accepted.state).toBe('queued')
    expect((await acceptAssistantInput('synthetic queued line', { clientId: 'queued-id', model: first, digest })).id).toBe(accepted.id)
    expect(first.ask).not.toHaveBeenCalled()
    __forgetAssistantExecutionForTest()
    const restored = model()
    h.blocked = false
    await resumeQueuedAssistantTurns({ model: restored, digest })
    expect(restored.ask).toHaveBeenCalledOnce()
    expect(readAssistantRuntime().turns[0].state).toBe('completed')
    expect(await askAssistant('synthetic queued line', { clientId: 'queued-id', model: restored, digest })).toMatchObject({ reply: 'synthetic reply' })
    expect(restored.ask).toHaveBeenCalledOnce()
    expect((await readAssistantLog()).map(e => e.id)).toEqual(['turn:queued-id:0', 'turn:queued-id:1'])
  })

  it('settles only the admitted turn, retains newly accepted inbox work, and hands shared history to the next actor', async () => {
    let release!: (answer: string) => void
    const old: AssistantModel = { warm: async () => {}, ask: vi.fn(() => new Promise<string>(resolve => { release = resolve })) }
    h.blocked = false
    const answering = askAssistant('first', { clientId: 'old-turn', model: old, digest })
    await vi.waitFor(() => expect(old.ask).toHaveBeenCalledOnce())
    const draining = drainAssistantRuntime()
    const next = model()
    await acceptAssistantInput('next', { clientId: 'next-turn', model: next, digest })
    expect(next.ask).not.toHaveBeenCalled()
    release('confirmed old answer')
    await answering
    const checkpoint = await draining
    expect(next.ask).not.toHaveBeenCalled()
    await retireAssistantRuntime(checkpoint)
    await resumeAssistantRuntime({ provider: 'chatgpt', model: 'synthetic-model' }, checkpoint)
    await waitForAssistantRuntimeIdle()
    expect(next.ask).toHaveBeenCalledOnce()
    expect(next.systems[0]).toContain('confirmed old answer')
    expect(readAssistantRuntime().turns.map(t => t.state)).toEqual(['completed', 'completed'])
  })

  it('new conversation cancels old inbox work and rejects a late result instead of resurrecting old history', async () => {
    let release!: (answer: string) => void
    const old: AssistantModel = { warm: async () => {}, ask: vi.fn(() => new Promise<string>(resolve => { release = resolve })) }
    h.blocked = false
    const answering = askAssistant('old active', { clientId: 'old-active', model: old, digest })
    const rejected = expect(answering).rejects.toMatchObject({ reason: 'conversation-reset' })
    await vi.waitFor(() => expect(old.ask).toHaveBeenCalledOnce())
    const queued = askAssistant('old queued', { clientId: 'old-queued', model: old, digest })
    const queueRejected = expect(queued).rejects.toMatchObject({ reason: 'conversation-reset' })
    await vi.waitFor(() => expect(readAssistantRuntime().turns).toHaveLength(2))
    await resetAssistantRuntime({ operationId: 'reset-once', kind: 'new-conversation' })
    await rejected; await queueRejected
    release('must never reappear')
    await waitForAssistantRuntimeIdle()
    expect(await readAssistantLog()).toEqual([])
    expect(readAssistantRuntime().turns).toEqual([])
    expect(['old-active', 'old-queued'].map(id => getAssistantTurnReceipt(id)?.state)).toEqual(['cancelled', 'cancelled'])
    expect(old.ask).toHaveBeenCalledOnce()
  })

  it('finishes a prepared memory-delete after a crash, and never applies that operation twice', async () => {
    await writeAssistantMemory('synthetic old memo')
    resetAssistantRuntimeState('delete-memo-once', 'delete-memory')
    expect(readAssistantRuntime().paused).toBe(true)
    await resumeAssistantRuntime({ provider: 'claude' }, {})
    expect(await readAssistantMemory()).toBe('')
    expect(readAssistantRuntime().operations.find(o => o.id === 'delete-memo-once')?.phase).toBe('completed')
    await writeAssistantMemory('new memo after the reset')
    await resetAssistantRuntime({ operationId: 'delete-memo-once', kind: 'delete-memory' })
    expect(await readAssistantMemory()).toBe('new memo after the reset')
  })

  it('does not automatically replay a previously running turn after process recovery', async () => {
    acceptAssistantTurn({ id: 'unknown-turn', text: 'unknown state' })
    const { claimAssistantTurn } = await import('./assistantRuntimeStore')
    claimAssistantTurn('unknown-turn')
    const next = model()
    await resumeAssistantRuntime({ provider: 'claude' }, {})
    await resumeQueuedAssistantTurns({ model: next, digest })
    expect(next.ask).not.toHaveBeenCalled()
    expect(readAssistantRuntime().turns[0]).toMatchObject({ state: 'interrupted', error: 'app-restarted' })
  })
  it('keeps local-unlock Claude talk outside the owner inbox, and refuses local use when ChatGPT is requested', async () => {
    await setSettings({ assistantProvider: 'claude' })
    h.owner = false; h.local = true
    await withLocalClaudeAssistantScope(async () => { __resetAssistantRuntimeForTest(); await clearAssistantLog(); await clearAssistantMemory() })
    const local = model()
    await withAssistantAccessScope(() => askAssistant('local synthetic line', { model: local, digest }))
    expect(local.ask).toHaveBeenCalledOnce()
    expect(readAssistantRuntime().turns).toEqual([])
    expect(await readAssistantLog()).toEqual([])
    expect(await withLocalClaudeAssistantScope(() => readAssistantLog())).toHaveLength(2)
    await setSettings({ assistantProvider: 'chatgpt' })
    await expect(withAssistantAccessScope(() => askAssistant('must not fall back', { model: local, digest }))).rejects.toMatchObject({ reason: 'owner-required' })
    expect(local.ask).toHaveBeenCalledOnce()
  })
  it('binds legacy owner reads and writes to the signed-in owner rather than exposing the previous owner journal', async () => {
    await withAssistantAccessScope(async () => { await writeAssistantMemory('owner-a private memo') })
    expect(readAssistantRuntime().ownerKey).toBe('owner-a')
    h.ownerKey = 'owner-b'
    await expect(withAssistantAccessScope(() => readAssistantMemory())).rejects.toMatchObject({ reason: 'owner-changed' })
    expect(await readAssistantMemory()).toBe('owner-a private memo')
  })
  it('keeps a stale stop request from retiring a different active turn', async () => {
    let release!: (answer: string) => void
    const active: AssistantModel = { warm: async () => {}, ask: vi.fn(() => new Promise<string>(resolve => { release = resolve })) }
    h.blocked = false
    const answering = askAssistant('active', { clientId: 'active-now', model: active, digest })
    await vi.waitFor(() => expect(active.ask).toHaveBeenCalledOnce())
    const before = readAssistantRuntime()
    await resetAssistantRuntime({ operationId: 'stale-stop', kind: 'stop-turn', turnId: 'already-finished' })
    expect(readAssistantRuntime().generation).toBe(before.generation)
    expect(readAssistantRuntime().turns[0].state).toBe('running')
    release('still the same active turn')
    await expect(answering).resolves.toMatchObject({ reply: 'still the same active turn' })
  })
  it('collapses concurrent retries of one memory reset before allowing new memo writes', async () => {
    await writeAssistantMemory('old memo')
    await Promise.all([resetAssistantRuntime({ operationId: 'same-reset', kind: 'delete-memory' }), resetAssistantRuntime({ operationId: 'same-reset', kind: 'delete-memory' })])
    await writeAssistantMemory('new memo')
    await resetAssistantRuntime({ operationId: 'same-reset', kind: 'delete-memory' })
    expect(await readAssistantMemory()).toBe('new memo')
    expect(readAssistantRuntime().operations.filter(o => o.id === 'same-reset')).toHaveLength(1)
  })
})
