// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ConversationDraftOwnerContext } from '@/lib/useConversationDraft'
import { useAssistantRuntime } from './useAssistantRuntime'
const wrapper = ({ children }: { children: React.ReactNode }) => <ConversationDraftOwnerContext.Provider value="owner-fixture">{children}</ConversationDraftOwnerContext.Provider>
const runtime = { conversationId: 'conversation-one', epoch: 2, pending: [{ id: 'running-turn', state: 'running', text: '相談' }], uncertainActions: [] }
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())
it('retries a lost reset acknowledgement with the persisted operation ID after renderer restart', async () => {
  const operations: unknown[] = []
  let lost = true
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/reset')) {
      operations.push(JSON.parse(String(init?.body)))
      if (lost) throw new Error('response lost')
    }
    return Response.json(runtime)
  }))
  const first = renderHook(() => useAssistantRuntime(true), { wrapper })
  await waitFor(() => expect(first.result.current.runtime).toEqual(runtime))
  await act(async () => { await first.result.current.reset('stop-turn') })
  expect(first.result.current.error).toBe(true)
  first.unmount()
  lost = false
  const second = renderHook(() => useAssistantRuntime(true), { wrapper })
  await waitFor(() => expect(second.result.current.runtime).toEqual(runtime))
  await act(async () => { await second.result.current.reset('stop-turn') })
  expect(operations).toHaveLength(2)
  expect(operations[1]).toEqual(operations[0])
  expect(operations[0]).toMatchObject({ kind: 'stop-turn', turnId: 'running-turn', conversationId: 'conversation-one', epoch: 2 })
  expect(fetch).toHaveBeenCalledWith('/api/assistant/reset', expect.objectContaining({ headers: { 'Content-Type': 'application/json', 'X-OpenGround-Owner': 'owner-fixture' } }))
})
it('does not request owner runtime or reset controls until permission is confirmed', () => {
  vi.stubGlobal('fetch', vi.fn())
  const hook = renderHook(() => useAssistantRuntime(false))
  expect(hook.result.current.runtime).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['failed', 'interrupted'])('permits an explicit fresh attempt only for settled %s without an action receipt', async state => {
  let actions: { id: string; state: string }[] = []
  vi.stubGlobal('fetch', vi.fn(async input => String(input).includes('/receipt?') ? Response.json({ id: 'original-message', state }) : Response.json({ ...runtime, actions })))
  const hook = renderHook(() => useAssistantRuntime(true), { wrapper })
  await waitFor(() => expect(hook.result.current.runtime).toBeTruthy())
  let next!: Awaited<ReturnType<typeof hook.result.current.retryIdentity>>
  await act(async () => { next = await hook.result.current.retryIdentity('original-message') })
  expect(next!.clientId).not.toBe('original-message')
  expect(next).toMatchObject({ conversationId: runtime.conversationId, epoch: runtime.epoch })
  actions = [{ id: 'approval', state: 'completed' }]
  await act(async () => { next = await hook.result.current.retryIdentity('original-message') })
  expect(next).toBeNull()
  expect(hook.result.current.needsReview).toBe(true)
})
it('retains the same identity for unknown delivery and never replaces an uncertain effect', async () => {
  let uncertain = false
  vi.stubGlobal('fetch', vi.fn(async input => String(input).includes('/receipt?') ? uncertain ? Response.json({ id: 'original-message', state: 'uncertain' }) : Response.json({}, { status: 404 }) : Response.json(runtime)))
  const hook = renderHook(() => useAssistantRuntime(true), { wrapper })
  await waitFor(() => expect(hook.result.current.runtime).toBeTruthy())
  await act(async () => expect(await hook.result.current.retryIdentity('original-message')).toEqual({ clientId: 'original-message' }))
  uncertain = true
  await act(async () => expect(await hook.result.current.retryIdentity('original-message')).toBeNull())
  expect(hook.result.current.needsReview).toBe(true)
})
