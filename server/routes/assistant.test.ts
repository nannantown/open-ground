import { beforeEach, describe, expect, it, vi } from 'vitest'
import { assistantRuntimeRoutes } from './assistant'
import { __resetAssistantRuntimeForTest, mutateAssistantRuntime, readAssistantRuntime } from '@/lib/server/assistantRuntimeStore'
import { __forgetAssistantExecutionForTest } from '@/lib/server/phoneAssistant'

const h = vi.hoisted(() => ({ owner: 'owner-a', afterRequestOwner: undefined as string | undefined, blocked: true, provider: 'claude' as 'claude' | 'chatgpt' }))
vi.mock('@/lib/server/runtimeOwner', () => ({
  runtimeRequestOwnerKey: async (claim?: string) => {
    if (!h.owner || claim && claim !== h.owner) throw new Error('forbidden')
    const captured = h.owner
    if (h.afterRequestOwner) h.owner = h.afterRequestOwner
    return captured
  },
  runtimeOwnerKey: async (expected?: string) => {
    if (!h.owner || expected && expected !== h.owner) throw new Error('forbidden')
    return h.owner
  },
}))
vi.mock('@/lib/server/runtimeTransitionStore', async original => ({ ...await original<typeof import('@/lib/server/runtimeTransitionStore')>(), runtimeAdmissionBlocked: () => h.blocked, getRuntimeTransition: () => undefined }))
vi.mock('@/lib/server/chatgptRuntime', async original => ({ ...await original<typeof import('@/lib/server/chatgptRuntime')>(), selectedRuntime: async () => h.provider }))
vi.mock('@/lib/server/chatgptAuth', async original => ({ ...await original<typeof import('@/lib/server/chatgptAuth')>(), getChatGptAccountKey: async () => { throw new Error('synthetic target not connected') } }))

const request = (path: string, body?: unknown, owner = 'owner-a') => assistantRuntimeRoutes.request(`http://localhost${path}`, {
  ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  headers: { 'content-type': 'application/json', 'X-OpenGround-Owner': owner },
})
beforeEach(() => {
  h.owner = 'owner-a'; h.afterRequestOwner = undefined; h.blocked = true; h.provider = 'claude'
  __resetAssistantRuntimeForTest(); __forgetAssistantExecutionForTest()
})

describe('owner-bound durable assistant routes', () => {
  it('returns a persisted accepted receipt, replays it, and rejects another body for that ID', async () => {
    const input = { id: 'stable-message', text: 'synthetic message' }
    const first = await request('/api/assistant/inbox', input)
    expect(first.status).toBe(202)
    const body = await first.json()
    expect(body.receipt).toMatchObject({ id: input.id, state: 'queued' })
    expect(body.receipt).not.toHaveProperty('ownerKey')
    expect(body.receipt).not.toHaveProperty('bodyHash')
    expect(readAssistantRuntime().turns).toHaveLength(1)
    expect((await request('/api/assistant/inbox', input)).status).toBe(202)
    expect((await request('/api/assistant/inbox', { ...input, text: 'different' })).status).toBe(409)
    expect((await (await request('/api/assistant/inbox/stable-message')).json()).receipt.id).toBe(input.id)
  })
  it('rejects a stale owner header before reading or mutating the inbox', async () => {
    expect((await request('/api/assistant/runtime', undefined, 'owner-b')).status).toBe(403)
    expect((await request('/api/assistant/inbox', { id: 'denied', text: 'never accepted' }, 'owner-b')).status).toBe(403)
    expect(readAssistantRuntime().turns).toEqual([])
  })
  it('rechecks the captured owner if authentication changes after middleware acceptance', async () => {
    h.afterRequestOwner = 'owner-b'
    expect((await request('/api/assistant/inbox', { id: 'owner-race', text: 'never transferred' })).status).toBe(503)
    expect(readAssistantRuntime().turns).toEqual([])
  })
  it('does not reset or expose a journal bound to another owner', async () => {
    mutateAssistantRuntime(state => { state.ownerKey = 'owner-b' })
    expect((await request('/api/assistant/runtime')).status).toBe(409)
    const before = readAssistantRuntime()
    expect((await request('/api/assistant/reset', { operationId: 'wrong-owner-reset', kind: 'new-conversation' })).status).toBe(409)
    expect(readAssistantRuntime()).toEqual(before)
  })
  it('retains input during an unauthenticated target handoff without admitting a model turn', async () => {
    h.provider = 'chatgpt'
    expect((await request('/api/assistant/inbox', { id: 'target-pending', text: 'keep this while I reconnect' })).status).toBe(202)
    expect(readAssistantRuntime().turns[0]).toMatchObject({ id: 'target-pending', state: 'queued', ownerKey: 'owner-a' })
    expect(readAssistantRuntime().turns[0].accountKey).toBeUndefined()
    h.blocked = false
    expect((await request('/api/assistant/inbox', { id: 'stable-disconnected', text: 'cannot start a disconnected model' })).status).toBe(503)
    expect(readAssistantRuntime().turns).toHaveLength(1)
    h.blocked = true
  })
})
