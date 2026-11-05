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
afterEach(() => { resetConversationDraftControllersForTests(); vi.unstubAllGlobals(); vi.useRealTimers() })
const ready = async () => {
  const hook = renderHook(() => useConversationDraft('assistant'), { wrapper })
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
