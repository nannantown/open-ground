import { beforeEach, describe, expect, it, vi } from 'vitest'
import { currentRuntimeOwnerKey } from '@/lib/server/runtimeOwner'

const h = vi.hoisted(() => ({ allowed: true, owner: 'owner-a', project: vi.fn(), control: vi.fn(), history: vi.fn(), settings: vi.fn() }))
vi.mock('@/lib/server/chatgptAccess', () => ({ hasChatGptAccess: async () => h.allowed }))
vi.mock('@/lib/server/runtimeOwner', async original => ({
  ...await original<typeof import('@/lib/server/runtimeOwner')>(),
  runtimeRequestOwnerKey: async (claimed?: string) => {
    if (claimed !== undefined && claimed !== h.owner) throw new Error('owner changed')
    return h.owner
  },
  runtimeOwnerKey: async (expected?: string) => {
    if (expected && expected !== h.owner) throw new Error('owner changed')
    return h.owner
  },
}))
vi.mock('@/lib/server/projectDataPath', () => ({ projectUUIDFromPath: h.project }))
vi.mock('@/lib/server/conversationControl', () => ({ handleConversationControl: h.control }))
vi.mock('@/lib/server/swarmSupplyRuntime', async original => ({ ...await original<typeof import('@/lib/server/swarmSupplyRuntime')>(), getSupplyPublicConversation: h.history }))
vi.mock('@/lib/server/store', async original => ({ ...await original<typeof import('@/lib/server/store')>(), getSettings: h.settings }))
import { conversationRoutes } from './conversation'

const status = (headers: Record<string, string> = {}) => conversationRoutes.request('/api/conversation/president/status?path=%2Ffixture%2Fproject', { headers: { 'X-OpenGround-Owner': 'owner-a', ...headers } })
const observed = { path: '/fixture/project', operationId: 'stop-once', conversationId: 'conversation-a', epoch: 4, turnId: 'observed-turn' }
const stop = (body: object = observed, headers: Record<string, string> = {}) => conversationRoutes.request('/api/conversation/president/stop', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenGround-Owner': 'owner-a', ...headers }, body: JSON.stringify(body) })
beforeEach(() => {
  vi.resetAllMocks(); h.allowed = true; h.owner = 'owner-a'
  h.project.mockResolvedValue('registered-project')
  h.settings.mockResolvedValue({ projects: [{ id: 'registered-project', path: '/canonical/project' }] })
  h.history.mockReturnValue({ lines: [{ kind: 'input', text: 'Owner words.' }], overflow: false, seq: 90, revision: '1:0' })
  h.control.mockImplementation(async frame => {
    if (currentRuntimeOwnerKey() !== h.owner) throw new Error('owner changed')
    return { type: 'ack', id: frame.id, state: 'delivered', conversationId: 'conversation-a', epoch: 4, activeTurnId: 'observed-turn' }
  })
})

describe('desktop president exact-turn controls', () => {
  it('reads the registered project status with the admitted owner pinned', async () => {
    const response = await status()
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ state: 'delivered', conversationId: 'conversation-a', epoch: 4, activeTurnId: 'observed-turn', capabilities: { cancelPresidentInputs: 1 } })
    expect(h.project).toHaveBeenCalledExactlyOnceWith('/fixture/project')
    expect(h.control).toHaveBeenCalledExactlyOnceWith({ type: 'conversation-control', id: expect.any(String), action: 'status', scope: 'swarm', projectId: 'registered-project' })
  })
  it('advertises desktop cancellation without replacing the existing status capabilities', async () => {
    h.control.mockResolvedValue({ state: 'delivered', capabilities: { conversationControl: 1, durableSay: 1 } })
    expect(await (await status()).json()).toMatchObject({ capabilities: { conversationControl: 1, durableSay: 1, cancelPresidentInputs: 1 } })
  })
  it('returns only the bounded public projection for the canonical project and admitted owner', async () => {
    const response = await conversationRoutes.request('/api/conversation/president/history?path=%2Ffixture%2Fproject&sessionId=sdk-fixture', { headers: { 'X-OpenGround-Owner': 'owner-a' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ lines: [{ kind: 'input', text: 'Owner words.' }], overflow: false, seq: 90, revision: '1:0' })
    expect(h.history).toHaveBeenCalledExactlyOnceWith('/canonical/project', 'sdk-fixture', 'owner-a')
    expect(h.control).not.toHaveBeenCalled()
  })
  it('does not substitute a different actor when the requested history is unavailable', async () => {
    h.history.mockReturnValue(null)
    const response = await conversationRoutes.request('/api/conversation/president/history?path=%2Ffixture%2Fproject&sessionId=old-sdk', { headers: { 'X-OpenGround-Owner': 'owner-a' } })
    expect(response.status).toBe(404)
    expect(h.history).toHaveBeenCalledOnce()
    expect(h.control).not.toHaveBeenCalled()
  })
  it('revalidates the admitted owner after reading the canonical history project', async () => {
    h.settings.mockImplementation(async () => { h.owner = 'owner-b'; return { projects: [{ id: 'registered-project', path: '/canonical/project' }] } })
    expect((await conversationRoutes.request('/api/conversation/president/history?path=%2Ffixture%2Fproject&sessionId=sdk-fixture', { headers: { 'X-OpenGround-Owner': 'owner-a' } })).status).toBe(403)
    expect(h.history).not.toHaveBeenCalled()
  })
  it('forwards the observed turn and stable operation ID without choosing a newer turn', async () => {
    expect((await stop()).status).toBe(200)
    expect(h.control).toHaveBeenCalledExactlyOnceWith({ type: 'conversation-control', id: 'stop-once', action: 'stop-turn', scope: 'swarm', projectId: 'registered-project', conversationId: 'conversation-a', epoch: 4, turnId: 'observed-turn' })
  })
  it.each([{ turnId: undefined }, { epoch: undefined }, { conversationId: '' }, { epoch: -1 }, { operationId: '' }, { provider: 'claude' }, { accessToken: 'injected' }])('rejects incomplete or extended stop controls: %j', async invalid => {
    expect((await stop({ ...observed, ...invalid })).status).toBe(400)
    expect(h.control).not.toHaveBeenCalled()
  })
  it('returns a conflict when the controller refuses an outdated turn, without creating another control', async () => {
    h.control.mockResolvedValue({ type: 'ack', id: 'stop-once', state: 'rejected', reason: 'stale-conversation' })
    const response = await stop()
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ state: 'rejected', reason: 'stale-conversation' })
    expect(h.control).toHaveBeenCalledOnce()
  })
  it('preserves queued acknowledgement so the caller retries the same operation', async () => {
    h.control.mockResolvedValue({ type: 'ack', id: 'stop-once', state: 'queued' })
    const response = await stop()
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ id: 'stop-once', state: 'queued' })
  })
  it('refuses foreign origins and stale renderer owners before resolving a project', async () => {
    expect((await status({ Origin: 'https://foreign.example' })).status).toBe(403)
    expect((await stop(observed, { 'X-OpenGround-Owner': 'owner-before' })).status).toBe(403)
    h.allowed = false
    expect((await status()).status).toBe(403)
    expect(h.project).not.toHaveBeenCalled(); expect(h.control).not.toHaveBeenCalled()
  })
  it('refuses an unregistered project without touching its actor or exposing the host error', async () => {
    h.project.mockRejectedValue(new Error('private host path must not be returned'))
    const response = await stop()
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('private host path')
    expect(h.control).not.toHaveBeenCalled()
  })
  it('does not use a replacement owner after awaited project lookup', async () => {
    h.project.mockImplementation(async () => { h.owner = 'owner-b'; return 'registered-project' })
    expect((await stop()).status).toBe(403)
    expect(h.control).not.toHaveBeenCalled()
  })
})
