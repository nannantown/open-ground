// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationDraftOwnerContext, resetConversationDraftControllersForTests, useConversationDraft } from './useConversationDraft'

const wrapper = ({ children }: { children: React.ReactNode }) => <ConversationDraftOwnerContext.Provider value="owner-fixture">{children}</ConversationDraftOwnerContext.Provider>
let draft = { revision: 0, text: '', updatedAt: '2026-11-05T00:00:00Z' }
let receipt: object | null
const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).includes('/receipt?')) return Response.json(receipt ?? {}, { status: receipt ? 200 : 404 })
  if (init?.method === 'PUT') {
    const body = JSON.parse(String(init.body)) as { revision: number; text: string }
    if (body.revision !== draft.revision) return Response.json({ draft }, { status: 409 })
    draft = { ...draft, revision: draft.revision + 1, text: body.text }
  }
  return Response.json(draft)
})
beforeEach(() => { localStorage.clear(); draft = { revision: 0, text: '', updatedAt: '2026-11-05T00:00:00Z' }; receipt = null; request.mockClear(); vi.stubGlobal('fetch', request) })
afterEach(() => { resetConversationDraftControllersForTests(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks() })
const ready = async (scope = 'assistant') => {
  const hook = renderHook(() => useConversationDraft(scope), { wrapper })
  await waitFor(() => expect(hook.result.current.loaded).toBe(true))
  return hook
}
describe('durable conversation draft', () => {
  it('does not read owner draft endpoints without a confirmed actual owner', async () => {
    const hook = renderHook(() => useConversationDraft('assistant'))
    expect(hook.result.current.enabled).toBe(false)
    expect(request).not.toHaveBeenCalled()
  })
  it('saves server revision and request identity before returning a send', async () => {
    const hook = await ready()
    act(() => hook.result.current.setText?.('相談です'))
    let send!: Awaited<ReturnType<NonNullable<typeof hook.result.current.prepareSend>>>
    await act(async () => { send = await hook.result.current.prepareSend!() })
    expect(draft.text).toBe('相談です')
    expect(send.draftRevision).toBe(draft.revision)
    expect(JSON.stringify([...Array(localStorage.length)].map((_, i) => localStorage.getItem(localStorage.key(i)!)))).toContain(send.clientId)
    await act(async () => expect(await hook.result.current.prepareSend!()).toEqual(send))
  })
  it('recovers an unacknowledged request after renderer restart using the same ID', async () => {
    const first = await ready()
    act(() => first.result.current.setText?.('再起動の前'))
    let id = ''
    await act(async () => { id = (await first.result.current.prepareSend!()).clientId })
    first.unmount(); resetConversationDraftControllersForTests()
    const second = await ready()
    await act(async () => expect((await second.result.current.prepareSend!()).clientId).toBe(id))
    receipt = { id, state: 'queued' }; draft = { ...draft, text: '', revision: draft.revision + 1 }
    await act(async () => { await second.result.current.recover!() })
    expect(second.result.current.text).toBe('')
    expect(second.result.current.attempt).toBeNull()
  })
  it('late accepted revision cannot clear a new edit even when its words match', async () => {
    const hook = await ready()
    act(() => hook.result.current.setText?.('同じ相談'))
    let send!: Awaited<ReturnType<NonNullable<typeof hook.result.current.prepareSend>>>
    await act(async () => { send = await hook.result.current.prepareSend!() })
    act(() => hook.result.current.setText?.('別の相談'))
    act(() => hook.result.current.setText?.('同じ相談'))
    draft = { ...draft, text: '', revision: draft.revision + 1 }
    await act(async () => { await hook.result.current.accepted!(send) })
    expect(hook.result.current.text).toBe('同じ相談')
    await act(async () => { await hook.result.current.flush!() })
    expect(draft.text).toBe('同じ相談')
  })
  it('retains a conflicting draft until explicit recovery selects which version to keep', async () => {
    const hook = await ready()
    act(() => hook.result.current.setText?.('こちらの下書き'))
    draft = { ...draft, revision: 2, text: '別窓の下書き' }
    await act(async () => { await expect(hook.result.current.flush!()).rejects.toThrow('draft-conflict') })
    expect(hook.result.current.text).toBe('こちらの下書き')
    await act(async () => { await hook.result.current.resolveConflict!(true) })
    expect(draft.text).toBe('こちらの下書き')
    expect(draft.revision).toBe(3)
  })
  it('does not submit if stable request identity cannot be persisted', async () => {
    const hook = await ready()
    act(() => hook.result.current.setText?.('保持する文章'))
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('unavailable') })
    await act(async () => { await expect(hook.result.current.prepareSend!()).rejects.toThrow() })
    expect(hook.result.current.text).toBe('保持する文章')
    expect(hook.result.current.attempt).toBeNull()
    storage.mockRestore()
  })
})


it('binds draft requests to the confirmed owner and stops delayed writes on unmount', async () => {
  const hook = await ready()
  expect(request).toHaveBeenCalledWith(expect.stringContaining('/api/conversation/draft?'), expect.objectContaining({ headers: { 'X-OpenGround-Owner': 'owner-fixture' } }))
  vi.useFakeTimers()
  act(() => hook.result.current.setText?.('この所有者だけの下書き'))
  const before = request.mock.calls.length
  hook.unmount()
  await vi.advanceTimersByTimeAsync(200)
  expect(request.mock.calls.length).toBe(before)
})

const acceptedPresidentInput = async () => {
  const hook = await ready('project-fixture')
  act(() => hook.result.current.setText?.('This work was completed elsewhere.'))
  let send!: Awaited<ReturnType<NonNullable<typeof hook.result.current.prepareSend>>>
  await act(async () => { send = await hook.result.current.prepareSend!() })
  draft = { ...draft, text: '', revision: draft.revision + 1 }
  await act(async () => { await hook.result.current.accepted!(send, { id: send.clientId, state: 'queued' }) })
  return { hook, id: send.clientId }
}

it('cancels only the selected accepted input and preserves a newer unsent draft', async () => {
  const { hook, id } = await acceptedPresidentInput()
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>)['X-OpenGround-Owner']).toBe('owner-fixture')
    if (url.includes('/president/status')) return Response.json({ state: 'delivered', capabilities: { cancelPresidentInputs: 1 }, conversationId: 'current', epoch: 4 })
    if (url.endsWith('/cancel-inputs')) {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ ok: true, receipts: [{ id, state: 'cancelled' }] })
    }
    return Response.json(draft)
  })
  act(() => hook.result.current.setText?.('Keep this new question.'))
  await act(async () => { await hook.result.current.cancelReceipt!('/fixture/project', id, 'Completed elsewhere; cancel this request.') })
  expect(bodies).toEqual([expect.objectContaining({ path: '/fixture/project', conversationId: 'current', epoch: 4, messageIds: [id] })])
  expect(hook.result.current.receipts.find(r => r.id === id)?.state).toBe('cancelled')
  expect(hook.result.current.text).toBe('Keep this new question.')
})

it('reuses the same cancellation after a lost acknowledgement and renderer restart', async () => {
  const { hook, id } = await acceptedPresidentInput()
  const bodies: Record<string, unknown>[] = []
  let statusReads = 0
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (url.includes('/president/status')) { statusReads++; return Response.json({ state: 'delivered', capabilities: { cancelPresidentInputs: 1 }, conversationId: 'original', epoch: 4 }) }
    if (url.endsWith('/cancel-inputs')) {
      bodies.push(JSON.parse(String(init?.body)))
      if (bodies.length === 1) throw new Error('ack lost')
      return Response.json({ ok: true, receipts: [{ id, state: 'cancelled' }] })
    }
    return Response.json(draft)
  })
  await act(async () => { await expect(hook.result.current.cancelReceipt!('/fixture/project', id, 'Cancel this request.')).rejects.toThrow() })
  hook.unmount(); resetConversationDraftControllersForTests()
  const second = await ready('project-fixture')
  await act(async () => { await second.result.current.cancelReceipt!('/fixture/project', id, 'Cancel this request.') })
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(statusReads).toBe(1)
  expect(second.result.current.receipts.find(r => r.id === id)?.state).toBe('cancelled')
})

it('does not hide a pending instruction on a mismatched cancellation response', async () => {
  const { hook, id } = await acceptedPresidentInput()
  vi.stubGlobal('fetch', async (url: string) => Response.json(url.includes('/president/status')
    ? { state: 'delivered', capabilities: { cancelPresidentInputs: 1 }, conversationId: 'c', epoch: 1 }
    : { ok: true, receipts: [{ id: 'another-request', state: 'cancelled' }] }))
  await act(async () => { await expect(hook.result.current.cancelReceipt!('/fixture/project', id, 'Cancel this request.')).rejects.toThrow() })
  expect(hook.result.current.receipts.find(r => r.id === id)?.state).toBe('queued')
})

it('never cancels when the cancellation identity cannot be persisted', async () => {
  const { hook, id } = await acceptedPresidentInput()
  const posts = vi.fn()
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') posts()
    return Response.json({ state: 'delivered', capabilities: { cancelPresidentInputs: 1 }, conversationId: 'c', epoch: 1 })
  })
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable') })
  await act(async () => { await expect(hook.result.current.cancelReceipt!('/fixture/project', id, 'Cancel this request.')).rejects.toThrow() })
  expect(posts).not.toHaveBeenCalled()
  expect(hook.result.current.receipts.find(r => r.id === id)?.state).toBe('queued')
  storage.mockRestore()
})

it('does not revive a cancelled instruction from an earlier pending receipt poll', async () => {
  let poll!: () => void
  const originalInterval = globalThis.setInterval
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number) => {
    if (delay === 2000 && typeof callback === 'function') { poll = () => callback(); return 0 as unknown as ReturnType<typeof setInterval> }
    return originalInterval(callback, delay)
  }) as typeof setInterval)
  const { hook, id } = await acceptedPresidentInput()
  let release!: (response: Response) => void
  vi.stubGlobal('fetch', async (url: string) => {
    if (url.includes('/receipt?')) return new Promise<Response>(resolve => { release = resolve })
    if (url.includes('/president/status')) return Response.json({ state: 'delivered', capabilities: { cancelPresidentInputs: 1 }, conversationId: 'c', epoch: 1 })
    return Response.json({ ok: true, receipts: [{ id, state: 'cancelled' }] })
  })
  act(() => poll())
  await act(async () => { await hook.result.current.cancelReceipt!('/fixture/project', id, 'Cancel this request.') })
  expect(hook.result.current.receipts.find(r => r.id === id)?.state).toBe('cancelled')
  await act(async () => { release(Response.json({ id, state: 'queued' })) })
  expect(hook.result.current.receipts.find(r => r.id === id)?.state).toBe('cancelled')
})
