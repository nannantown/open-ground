// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useGroundLook } from './useGroundLook'

// Opening a project is the read receipt for the Ground card's eye (2026-09-26).
// What matters is WHERE the stamp goes: 'opened' must never hit /seen (that
// would clear the president's hand on a mere visit).

const stub = () => {
  const calls: Array<{ url: string; body: unknown }> = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response('{}')
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useGroundLook', () => {
  it("'opened' stamps /api/ground/opened on open and again on leave — never /seen", async () => {
    const calls = stub()
    const { unmount } = renderHook(() => useGroundLook('/p', 'opened'))
    await waitFor(() => expect(calls).toHaveLength(1))
    unmount()
    expect(calls.map((c) => c.url)).toEqual(['/api/ground/opened', '/api/ground/opened'])
    expect(calls[0].body).toEqual({ path: '/p' })
  })

  it('no project, or an inactive look, stamps nothing', () => {
    const calls = stub()
    renderHook(() => useGroundLook(undefined, 'opened')).unmount()
    renderHook(() => useGroundLook('/p', 'seen', false)).unmount()
    expect(calls).toEqual([])
  })

  it("'seen' goes to /api/ground/seen", async () => {
    const calls = stub()
    renderHook(() => useGroundLook('/p', 'seen'))
    await waitFor(() => expect(calls.map((c) => c.url)).toEqual(['/api/ground/seen']))
  })
})
