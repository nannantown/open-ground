import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { handleConversationControl, conversationCapabilities } from './conversationControl'
import { listConversationReceipts, readConversationReceipt } from './conversationReceipts'
import { readAssistantRuntime, __resetAssistantRuntimeForTest } from './assistantRuntimeStore'
import { openGroundHome } from './paths'

const h = vi.hoisted(() => ({ owner: 'owner-a', access: true, status: vi.fn(), request: vi.fn(), control: vi.fn(), reset: vi.fn() }))
const runtimes = { assistant: { scope: 'assistant', revision: 2, phase: 'stable', effective: { provider: 'claude' }, desired: { provider: 'claude' } },
  swarm: { scope: 'swarm', revision: 3, phase: 'stable', effective: { provider: 'claude' }, desired: { provider: 'claude' } } }
vi.mock('./runtimeOwner', async original => ({ ...(await original<typeof import('./runtimeOwner')>()), runtimeOwnerKey: async (expected?: string) => {
  if (!h.owner || expected && expected !== h.owner) throw new Error('owner changed')
  return h.owner
} }))
vi.mock('./chatgptAccess', () => ({ hasChatGptAccess: async () => h.access }))
vi.mock('./runtimeTransitions', () => ({ runtimeTransitions: () => ({ status: h.status, request: h.request, control: h.control }) }))
vi.mock('./assistantRuntimeTransition', () => ({ resetAssistantRuntime: h.reset }))
vi.mock('./store', () => ({ getSettings: async () => ({ projects: [{ id: 'project-a', path: '/synthetic/project' }] }) }))
const frame = (extra: Record<string, unknown> = {}) => ({ type: 'conversation-control', id: 'control-a', action: 'set-provider', scope: 'assistant', provider: 'chatgpt', ...extra })
beforeEach(async () => {
  h.owner = 'owner-a'; h.access = true
  h.status.mockReset().mockResolvedValue(runtimes)
  h.request.mockReset().mockResolvedValue(runtimes)
  h.control.mockReset().mockResolvedValue(runtimes)
  h.reset.mockReset().mockResolvedValue({})
  await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true }); __resetAssistantRuntimeForTest()
})
afterEach(() => vi.restoreAllMocks())

describe('sealed conversation control receipts', () => {
  it('requires the tap-time turn and conversation epoch before accepting a stop control', async () => {
    const context = readAssistantRuntime()
    for (const extra of [{}, { conversationId: context.conversationId, epoch: context.epoch }, { turnId: 'turn-a' }]) {
      expect(await handleConversationControl(frame({ action: 'stop-turn', provider: undefined, ...extra }))).toMatchObject({ state: 'rejected', reason: 'stale-conversation' })
    }
    expect(h.reset).not.toHaveBeenCalled()
    expect(await listConversationReceipts()).toEqual([])
    expect(await handleConversationControl(frame({ action: 'stop-turn', provider: undefined, conversationId: context.conversationId, epoch: context.epoch, turnId: 'turn-a' }))).toMatchObject({ state: 'delivered' })
    expect(h.reset).toHaveBeenCalledExactlyOnceWith({ operationId: 'control-a', kind: 'stop-turn', turnId: 'turn-a', conversationId: context.conversationId, epoch: context.epoch, expectedOwnerKey: 'owner-a' })
  })
  it('replays one control ID without requesting the provider transition twice, ignoring transport timestamp changes', async () => {
    const first = await handleConversationControl(frame({ ts: 10 }))
    expect(first).toMatchObject({ type: 'ack', state: 'delivered', id: 'control-a' })
    expect(await handleConversationControl(frame({ ts: 20 }))).toEqual(first)
    expect(h.request).toHaveBeenCalledExactlyOnceWith({ assistantProvider: 'chatgpt' }, 'owner-a')
    expect((await listConversationReceipts()).map(r => r.state)).toEqual(['delivered'])
  })
  it('rejects a changed operation body instead of applying a second preference under the same ID', async () => {
    await handleConversationControl(frame())
    expect(await handleConversationControl(frame({ provider: 'claude' }))).toMatchObject({ state: 'rejected', reason: 'control-failed' })
    expect(h.request).toHaveBeenCalledOnce()
  })
  it('holds an unknown transition result and cannot replay it automatically', async () => {
    h.request.mockRejectedValueOnce(new Error('synthetic acknowledgement lost'))
    expect(await handleConversationControl(frame())).toMatchObject({ state: 'rejected', reason: 'control-failed' })
    expect((await readConversationReceipt('control-assistant', 'control-a'))?.state).toBe('uncertain')
    expect(await handleConversationControl(frame())).toMatchObject({ state: 'rejected', reason: 'uncertain' })
    expect(h.request).toHaveBeenCalledOnce()
  })
  it('does not start actors, change settings, reset, or claim an effect when reading status', async () => {
    const context = readAssistantRuntime()
    const file = join(openGroundHome(), 'assistant', 'runtime.json')
    const before = await readFile(file, 'utf8')
    expect(await handleConversationControl(frame({ action: 'status', provider: undefined }))).toMatchObject({ state: 'delivered', conversationId: context.conversationId, epoch: 0 })
    expect(h.request).not.toHaveBeenCalled(); expect(h.control).not.toHaveBeenCalled(); expect(h.reset).not.toHaveBeenCalled()
    expect(await listConversationReceipts()).toEqual([])
    expect(await readFile(file, 'utf8')).toBe(before)
  })
  it('refuses non-owner controls, unknown projects, and injected credential fields before any mutation', async () => {
    h.access = false
    expect(await conversationCapabilities()).toBeUndefined()
    expect(await handleConversationControl(frame())).toMatchObject({ state: 'rejected', reason: 'forbidden' })
    h.access = true
    expect(await handleConversationControl(frame({ scope: 'swarm', projectId: 'not-registered' }))).toMatchObject({ state: 'rejected', reason: 'no-project' })
    expect(await handleConversationControl(frame({ accessToken: 'synthetic-never-used' }))).toMatchObject({ state: 'rejected', reason: 'bad-frame' })
    expect(h.request).not.toHaveBeenCalled()
    expect(await listConversationReceipts()).toEqual([])
  })
  it('does not execute an old-owner frame as a replacement owner after an awaited status read', async () => {
    h.status.mockImplementationOnce(async () => { h.owner = 'owner-b'; return runtimes })
    expect(await handleConversationControl(frame())).toMatchObject({ state: 'rejected' })
    expect(h.request).not.toHaveBeenCalled()
    expect(await listConversationReceipts()).toEqual([])
  })
})
