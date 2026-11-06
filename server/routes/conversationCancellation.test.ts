import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { openGroundHome } from '@/lib/server/paths'
import { acceptConversationReceipt, claimConversationReceipt, readConversationContext, readConversationReceipt } from '@/lib/server/conversationReceipts'
import * as atomic from '@/lib/server/atomicWrite'

const h = vi.hoisted(() => ({ owner: 'owner-a', allowed: true, occupied: false, lookup: vi.fn() }))
vi.mock('@/lib/server/chatgptAccess', () => ({ hasChatGptAccess: async () => h.allowed }))
vi.mock('@/lib/server/runtimeOwner', () => ({ runtimeOwnerKey: async (expected?: string) => {
  if (expected && expected !== h.owner) throw new Error('owner changed')
  return h.owner
}, runtimeRequestOwnerKey: async (claimed?: string) => { if (claimed !== h.owner) throw new Error('owner changed'); return h.owner } }))
vi.mock('@/lib/server/liveDesks', () => ({ isAgentConversationOccupied: () => h.occupied, isRecordedRuntimeHandleOccupied: () => h.occupied }))
vi.mock('@/lib/server/projectDataPath', () => ({ projectUUIDFromPath: h.lookup }))
vi.mock('@/lib/server/store', () => ({ getSettings: async () => ({ projects: [{ id: 'project-a', path: '/fixture/project' }] }) }))
vi.mock('@/lib/server/conversationControl', () => ({ handleConversationControl: vi.fn() }))
vi.mock('@/lib/server/swarmSupplyRuntime', () => ({ getSupplyPublicConversation: vi.fn() }))
vi.mock('@/lib/server/presidentInbox', () => ({ presidentInputReceipt: vi.fn() }))
vi.mock('@/lib/server/assistantRuntimeStore', () => ({ getAssistantTurnReceipt: vi.fn() }))
vi.mock('@/lib/server/runtimeRecovery', () => ({ runtimeRecoveryIssues: vi.fn() }))
vi.mock('@/lib/server/chatgptResponses', () => ({ reviewChatGptUncertainAction: vi.fn() }))
vi.mock('@/lib/server/swarmRuntimeTransition', () => ({ reviewSwarmLaunchRecovery: vi.fn(), reviewNativeConversationRecovery: vi.fn() }))
vi.mock('@/lib/server/runtimeRecoveryBoot', () => ({ notifyRuntimeRecoveryChanged: vi.fn() }))
import { conversationRoutes } from './conversation'

const post = (body: object, headers: Record<string, string> = {}) => conversationRoutes.request('/api/conversation/president/cancel-inputs', { method: 'POST', headers: { 'content-type': 'application/json', 'X-OpenGround-Owner': 'owner-a', ...headers }, body: JSON.stringify(body) })
const input = (id = 'one') => acceptConversationReceipt('project-a', id, { kind: 'president-input', path: '/fixture/project', text: 'Synthetic owner request.' })
const body = async () => ({ path: '/fixture/project', operationId: 'cancel-once', ...await readConversationContext('project-a'), messageIds: ['one'], note: 'Completed elsewhere; cancel the remaining intent.' })
beforeEach(async () => { h.owner = 'owner-a'; h.allowed = true; h.occupied = false; h.lookup.mockReset().mockResolvedValue('project-a'); await rm(join(openGroundHome(), 'runtime'), { recursive: true, force: true }) })
afterEach(() => vi.restoreAllMocks())

describe('president input cancellation HTTP boundary with real durable receipts', () => {
  it('persists cancelled intent and replays the same operation without admitting another input', async () => {
    await input(); const request = await body()
    const response = await post(request)
    expect(response.status).toBe(200)
    const first = await response.json()
    expect(first).toMatchObject({ ok: true, conversationId: request.conversationId, epoch: request.epoch, receipts: [{ id: 'one', state: 'cancelled', result: { cancelledByOwner: true, effectsRolledBack: false, automaticReplay: false } }] })
    expect(await (await post(request)).json()).toEqual(first)
    expect((await readConversationReceipt('project-a', 'one'))?.state).toBe('cancelled')
    expect(JSON.stringify(first)).not.toContain('Synthetic owner request.')
    expect(await claimConversationReceipt('project-a', 'one')).toBe(false)
  })
  it('rejects executing input, stale context and missing IDs without cancelling another message', async () => {
    await input(); await input('active'); const request = await body()
    await claimConversationReceipt('project-a', 'active', { runtime: 'sdk', handleId: 'sdk-one', sessionId: 'chatgpt-one' })
    for (const invalid of [{ messageIds: ['one', 'active'] }, { messageIds: ['one', 'missing'] }, { epoch: request.epoch + 1 }]) {
      expect((await post({ ...request, ...invalid })).status).toBe(409)
      expect((await readConversationReceipt('project-a', 'one'))?.state).toBe('queued')
    }
  })
  it('refuses foreign origins, nonowners and owner changes during project lookup', async () => {
    await input(); const request = await body()
    expect((await post(request, { Origin: 'https://foreign.example' })).status).toBe(403)
    expect((await post(request, { 'X-OpenGround-Owner': 'stale-owner' })).status).toBe(403)
    h.allowed = false; expect((await post(request)).status).toBe(403); h.allowed = true
    h.lookup.mockImplementationOnce(async () => { h.owner = 'owner-b'; return 'project-a' })
    expect((await post(request)).status).toBe(403)
    h.owner = 'owner-a'; expect((await readConversationReceipt('project-a', 'one'))?.state).toBe('queued')
  })
  it('requires bounded exact IDs and an explicit nonempty owner note', async () => {
    await input(); const request = await body()
    for (const invalid of [{ messageIds: [] }, { messageIds: ['one', 'one'] }, { messageIds: ['../one'] }, { note: ' ' }, { provider: 'claude' }, { epoch: undefined }]) expect((await post({ ...request, ...invalid })).status).toBe(400)
    expect((await readConversationReceipt('project-a', 'one'))?.state).toBe('queued')
  })
  it('does not acknowledge cancellation when durable storage fails', async () => {
    await input(); const request = await body()
    vi.spyOn(atomic, 'atomicWriteJson').mockRejectedValueOnce(new Error('synthetic cancel fsync failure'))
    expect((await post(request)).status).toBe(409)
    expect((await readConversationReceipt('project-a', 'one'))?.state).toBe('queued')
  })
})
