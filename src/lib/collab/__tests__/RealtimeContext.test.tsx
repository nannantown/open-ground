// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import type { CollabTicketResponse } from '../../types'

// Mock ONLY the heavy transport (provider.ts) so this hook test never loads the
// y-partyserver WebSocket stack. The hook still loads the REAL yjs + the REAL
// board mappers (proving the binding wires them) — only the network/socket edge
// is faked. The DO transport itself is covered by worker/test/local.mjs.
//
// New provider surface (Cloudflare-DO edition): fetchCollabTicket(path, scope)
// mints a short-lived ticket; connectCollabDoc(doc, ticket, getFreshToken) opens
// the provider. The old createCollabClient/joinDoc/fetchRealtimeToken are gone.
const ticket: CollabTicketResponse = {
  wsUrl: 'wss://collab.example.workers.dev',
  room: 'c1:board',
  token: 'tkt',
  expiresAt: Date.now() + 60_000,
}
const fetchCollabTicket = vi.fn(async () => ticket)
const destroy = vi.fn()
// connectCollabDoc resolves a DocConnection: a provider exposing synced + on(),
// and a destroy(). `synced:true` flips the binding's synced flag deterministically.
const connectCollabDoc = vi.fn(async () => ({
  provider: { synced: true, on: vi.fn() } as never,
  destroy,
}))
vi.mock('../provider', () => ({ fetchCollabTicket, connectCollabDoc }))

import { RealtimeProvider, useBoardCollab } from '../RealtimeContext'

const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(RealtimeProvider, null, children)

const mockFetch = (routes: Record<string, unknown>) =>
  vi.fn(async (url: string) => {
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response('null', { status: 404 })
  })

beforeEach(() => {
  fetchCollabTicket.mockClear()
  connectCollabDoc.mockClear()
  destroy.mockClear()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useBoardCollab gating', () => {
  it('disabled config → null binding, never touches the transport', async () => {
    vi.stubGlobal('fetch', mockFetch({ '/api/collab/config': { enabled: false } }))
    const { result } = renderHook(() => useBoardCollab('/p'), { wrapper })
    await new Promise((r) => setTimeout(r, 40))
    expect(result.current).toBeNull()
    expect(connectCollabDoc).not.toHaveBeenCalled()
  })

  it('enabled but NOT a member → null binding, no connection', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/collab/config': { enabled: true },
        '/api/collab/project': { collabProjectId: 'c1', member: false },
      }),
    )
    const { result } = renderHook(() => useBoardCollab('/p'), { wrapper })
    await new Promise((r) => setTimeout(r, 50))
    expect(result.current).toBeNull()
    expect(connectCollabDoc).not.toHaveBeenCalled()
  })

  it('enabled + member → a doc binding with seed/extract, connectCollabDoc once', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch({
        '/api/collab/config': { enabled: true },
        '/api/collab/project': { collabProjectId: 'c1', member: true },
        '/api/collab/ticket': ticket,
      }),
    )
    const { result } = renderHook(() => useBoardCollab('/p'), { wrapper })
    await waitFor(() => expect(result.current).not.toBeNull(), { timeout: 2000 })
    expect(result.current?.doc).toBeTruthy()
    expect(typeof result.current?.seed).toBe('function')
    expect(typeof result.current?.extract).toBe('function')
    expect(connectCollabDoc).toHaveBeenCalledTimes(1)
  })
})
