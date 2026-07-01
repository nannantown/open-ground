// @vitest-environment jsdom
//
// useClaudeConnection integration test. The hook passively reflects the user's
// `claude` CLI status (GET /api/claude-connection). Its non-obvious behaviours —
// suppressed while disabled, auto re-probe on window focus WHILE NOT connected,
// and unsubscribing once connected so a settled positive costs nothing — were
// untested. This pins all three against a stubbed fetch (the hc `api.*` client
// funnels through global fetch).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useClaudeConnection, type ClaudeConnection } from './useClaudeConnection'

const conn = (over: Partial<ClaudeConnection> = {}): ClaudeConnection => ({
  installed: false,
  loggedIn: false,
  plan: null,
  email: null,
  message: 'x',
  ...over,
})

const reply = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response)

// hc may hand fetch a string, URL, or Request — normalise to the path string.
const reqUrl = (call: unknown[]): string => {
  const x = call[0]
  if (typeof x === 'string') return x
  if (x instanceof URL) return x.href
  return (x as Request)?.url ?? ''
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useClaudeConnection', () => {
  it('does not probe and stays null while disabled', async () => {
    const fetchMock = vi.fn(() => reply(conn()))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useClaudeConnection(false))
    // Give any (erroneous) effect a chance to fire.
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it('probes /api/claude-connection when enabled and reflects the status', async () => {
    const fetchMock = vi.fn(() => reply(conn({ installed: true, loggedIn: true, plan: 'max', message: 'ok' })))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useClaudeConnection(true))
    await waitFor(() => expect(result.current).not.toBeNull())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(reqUrl(fetchMock.mock.calls[0])).toContain('/api/claude-connection')
    // The first probe does NOT force a cache bypass.
    expect(reqUrl(fetchMock.mock.calls[0])).not.toContain('force=1')
    expect(result.current).toMatchObject({ installed: true, loggedIn: true, plan: 'max' })
  })

  it('re-probes with force=1 on window focus WHILE NOT connected', async () => {
    const fetchMock = vi.fn(() => reply(conn({ installed: false, loggedIn: false })))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useClaudeConnection(true))
    await waitFor(() => expect(result.current).not.toBeNull())
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    // The focus-driven re-check forces the cache bypass so a just-completed
    // sign-in reflects immediately.
    expect(reqUrl(fetchMock.mock.calls[1])).toContain('force=1')
  })

  it('stops re-probing on focus once connected (settled positive costs nothing)', async () => {
    const fetchMock = vi.fn(() => reply(conn({ installed: true, loggedIn: true })))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useClaudeConnection(true))
    await waitFor(() => expect(result.current?.loggedIn).toBe(true))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
    })
    // Connected → the focus listener unsubscribed; no second probe.
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
