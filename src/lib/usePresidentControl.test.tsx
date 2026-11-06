// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConversationDraftOwnerContext } from './useConversationDraft'
import { usePresidentControl } from './usePresidentControl'

const owner = ({ children }: { children: ReactNode }) => <ConversationDraftOwnerContext.Provider value="fixture-owner">{children}</ConversationDraftOwnerContext.Provider>
const status = (turn: string | undefined = 'turn-a') => ({ state: 'delivered', capabilities: { conversationControl: 1 }, conversationId: 'conversation-one', epoch: 4, ...(turn ? { activeTurnId: turn } : {}) })
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals() })

it('never reads private runtime without owner context and gracefully omits unavailable controls', async () => {
  const fetcher = vi.fn(async () => new Response('{}', { status: 403 }))
  vi.stubGlobal('fetch', fetcher)
  const anonymous = renderHook(() => usePresidentControl('/fixture', true))
  expect(fetcher).not.toHaveBeenCalled()
  expect(anonymous.result.current.canStop).toBe(false)
  anonymous.unmount()
  const eligible = renderHook(() => usePresidentControl('/fixture', true), { wrapper: owner })
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
  expect(eligible.result.current.available).toBe(false)
  expect(eligible.result.current.canStop).toBe(false)
})

it('binds the displayed turn and keeps its operation unchanged after a lost ack and remount', async () => {
  const bodies: Record<string, unknown>[] = []
  let turn = 'turn-a'
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    expect((init?.headers as Record<string, string>)['X-OpenGround-Owner']).toBe('fixture-owner')
    if (!url.endsWith('/stop')) return new Response(JSON.stringify(status(turn)))
    bodies.push(JSON.parse(init!.body as string))
    if (bodies.length === 1) { turn = 'turn-b'; throw new Error('ack lost') }
    return new Response(JSON.stringify({ type: 'ack', id: bodies.at(-1)!.operationId, state: 'delivered' }))
  })
  const first = renderHook(() => usePresidentControl('/fixture', true), { wrapper: owner })
  await waitFor(() => expect(first.result.current.canStop).toBe(true))
  await act(async () => { await first.result.current.stop() })
  expect(first.result.current.error).toBe(true)
  first.unmount()
  const second = renderHook(() => usePresidentControl('/fixture', true), { wrapper: owner })
  await waitFor(() => expect(second.result.current.status?.activeTurnId).toBe('turn-b'))
  await act(async () => { await second.result.current.stop() })
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toEqual(bodies[1])
  expect(bodies[1]).toMatchObject({ path: '/fixture', turnId: 'turn-a', conversationId: 'conversation-one', epoch: 4 })
  expect(second.result.current.pending).toBe(false)
})

it('does not create an unbound stop when no active turn was reported', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify(status(undefined))))
  // Explicitly omit the active ID (the default argument above is intentional).
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ state: 'delivered', capabilities: { conversationControl: 1 }, conversationId: 'c', epoch: 0 })))
  vi.stubGlobal('fetch', fetcher)
  const view = renderHook(() => usePresidentControl('/fixture', true), { wrapper: owner })
  await waitFor(() => expect(view.result.current.available).toBe(true))
  expect(view.result.current.canStop).toBe(false)
  await act(async () => { await view.result.current.stop() })
  expect(fetcher).toHaveBeenCalledOnce()
})

it('ignores a late stop acknowledgement after switching project and never applies the old operation to the new one', async () => {
  let complete: ((response: Response) => void) | undefined
  const bodies: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/stop')) return new Response(JSON.stringify(status()))
    bodies.push(JSON.parse(init!.body as string))
    if (bodies.length === 1) return new Promise<Response>(resolve => { complete = resolve })
    return new Response(JSON.stringify({ type: 'ack', id: bodies.at(-1)!.operationId, state: 'delivered' }))
  })
  const view = renderHook(({ path }) => usePresidentControl(path, true), { initialProps: { path: '/first' }, wrapper: owner })
  await waitFor(() => expect(view.result.current.canStop).toBe(true))
  let first: Promise<void> | undefined
  act(() => { first = view.result.current.stop() })
  await waitFor(() => expect(complete).toBeDefined())
  view.rerender({ path: '/second' })
  await waitFor(() => expect(view.result.current.canStop).toBe(true))
  await act(async () => { complete!(new Response(JSON.stringify({ type: 'ack', id: bodies[0].operationId, state: 'delivered' }))); await first })
  expect(view.result.current.pending).toBe(false)
  expect(localStorage.getItem('openground:president-stop:fixture-owner:%2Ffirst')).not.toBeNull()
  await act(async () => { await view.result.current.stop() })
  expect(bodies[1]).toMatchObject({ path: '/second', turnId: 'turn-a' })
  expect(bodies[1].operationId).not.toBe(bodies[0].operationId)
})

it('settles only a matching terminal rejection and lets a later explicit click bind the new displayed turn', async () => {
  const bodies: Record<string, unknown>[] = []
  let turn = 'turn-a'
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    if (!url.endsWith('/stop')) return new Response(JSON.stringify(status(turn)))
    bodies.push(JSON.parse(init!.body as string)); turn = 'turn-b'
    return new Response(JSON.stringify({ type: 'ack', id: bodies.at(-1)!.operationId, state: 'rejected', reason: 'control-failed' }), { status: 409 })
  })
  const view = renderHook(() => usePresidentControl('/fixture', true), { wrapper: owner })
  await waitFor(() => expect(view.result.current.canStop).toBe(true))
  await act(async () => { await view.result.current.stop() })
  expect(view.result.current.pending).toBe(false)
  expect(view.result.current.error).toBe(true)
  expect(bodies).toHaveLength(1)
  await waitFor(() => expect(view.result.current.status?.activeTurnId).toBe('turn-b'))
  await act(async () => { await view.result.current.stop() })
  expect(bodies[1].turnId).toBe('turn-b')
  expect(bodies[1].operationId).not.toBe(bodies[0].operationId)
})

it('does not settle an acknowledgement for a different operation', async () => {
  vi.stubGlobal('fetch', async (url: string) => new Response(JSON.stringify(url.endsWith('/stop')
    ? { type: 'ack', id: 'another-operation', state: 'rejected' } : status())))
  const view = renderHook(() => usePresidentControl('/fixture', true), { wrapper: owner })
  await waitFor(() => expect(view.result.current.canStop).toBe(true))
  await act(async () => { await view.result.current.stop() })
  expect(view.result.current.pending).toBe(true)
  expect(view.result.current.error).toBe(true)
})
