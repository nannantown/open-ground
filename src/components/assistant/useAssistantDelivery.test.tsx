// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationDraftOwnerContext } from '@/lib/useConversationDraft'
import { readAssistantOutbox } from '@/lib/assistantOutbox'
import { useAssistant, type AssistantWords } from './useAssistant'
const words: AssistantWords = { failed: 'failed', busy: 'busy', tooLong: 'tooLong', workMode: 'workMode', photoType: 'photoType', photoTooLarge: 'photoTooLarge', proposalGone: 'proposalGone' }
afterEach(() => vi.unstubAllGlobals())
it('clears a durable draft only on accepted receipt, never merely HTTP200 opening', async () => {
  let push!: (text: string) => void
  let finish!: () => void
  const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input).endsWith('/say') ? new Response(new ReadableStream({ start(controller) {
    push = text => controller.enqueue(new TextEncoder().encode(text + '\n'))
    finish = () => controller.close()
  } })) : Response.json({ entries: [], name: 'Assistant' }))
  vi.stubGlobal('fetch', fetcher)
  const hook = renderHook(() => useAssistant(false, words))
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  const accepted = vi.fn()
  let sending!: Promise<boolean>
  act(() => { sending = hook.result.current.say('相談', undefined, undefined, undefined, undefined, { clientId: 'stable-message', draftClientId: 'desktop-one', draftRevision: 4 }, accepted) })
  await waitFor(() => expect(push).toBeTypeOf('function'))
  expect(accepted).not.toHaveBeenCalled()
  expect(hook.result.current.pendingState).toBe('sending')
  await act(async () => { push('{"accepted":true,"receipt":{"id":"stable-message","state":"queued"}}'); await Promise.resolve() })
  expect(accepted).toHaveBeenCalledOnce()
  await act(async () => { push('{"reply":"確認しました"}'); finish(); await sending })
  const call = fetcher.mock.calls.find(([input]) => String(input).endsWith('/say'))
  expect(call).toBeTruthy()
  expect(JSON.parse(String(call?.[1]?.body))).toMatchObject({ clientId: 'stable-message', draftClientId: 'desktop-one', draftRevision: 4 })
  expect(hook.result.current.pending).toBeNull()
})


it('journals every owner message and its epoch before posting, including a fresh retry or spoken line', async () => {
  localStorage.clear()
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, action: () => Promise<unknown>) => action() } })
  let posted: Record<string, unknown> | undefined
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input)
    if (path.endsWith('/runtime')) return Response.json({ conversationId: 'conversation-one', epoch: 3 })
    if (path.endsWith('/say')) {
      posted = JSON.parse(String(init?.body))
      expect(readAssistantOutbox('owner-fixture')[0]).toMatchObject({ clientId: posted!.clientId, text: '声での相談', sent: true, conversationId: 'conversation-one', epoch: 3 })
      return new Response(JSON.stringify({ accepted: true, receipt: { id: posted!.clientId, state: 'queued' } }) + '\n' + JSON.stringify({ reply: '確認しました' }) + '\n')
    }
    return Response.json({ entries: [], name: 'Assistant' })
  }))
  const wrapper = ({ children }: { children: React.ReactNode }) => <ConversationDraftOwnerContext.Provider value="owner-fixture">{children}</ConversationDraftOwnerContext.Provider>
  const hook = renderHook(() => useAssistant(false, words), { wrapper })
  await waitFor(() => expect(hook.result.current.ready).toBe(true))
  await act(async () => { await hook.result.current.say('声での相談') })
  expect(posted).toMatchObject({ text: '声での相談', conversationId: 'conversation-one', epoch: 3 })
  await waitFor(() => expect(readAssistantOutbox('owner-fixture')).toEqual([]))
})
