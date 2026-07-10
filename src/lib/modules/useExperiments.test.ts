// @vitest-environment jsdom
//
// Regression test for audit 856daefb (MINOR): ProjectPanel's moduleGate
// useMemo used to depend on `experiments?.swarm` — a hand-picked key that a
// future ExperimentId could be added without anyone remembering to extend the
// dep list, silently breaking gate recomputation for the new flag. The fix
// makes useExperiments() hand out a referentially-stable `flags` object (so
// callers can depend on the whole object instead of individual keys) —
// stable when a refresh resolves to the same values, a new reference the
// moment any value actually changes, no matter which key.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useExperiments } from './useExperiments'

const reply = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('useExperiments', () => {
  it('keeps the same flags object reference across a no-op refresh', async () => {
    const fetchMock = vi.fn(() => reply({ eligible: true, flags: { swarm: true, sandbox: false } }))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useExperiments())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const firstFlags = result.current.flags

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.flags).toBe(firstFlags)
  })

  it('hands out a new flags object the moment any flag value changes — including one not special-cased by a caller', async () => {
    const fetchMock = vi.fn(() => reply({ eligible: true, flags: { swarm: false, sandbox: false } }))
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useExperiments())
    await waitFor(() => expect(result.current.loaded).toBe(true))
    const firstFlags = result.current.flags
    expect(firstFlags.sandbox).toBe(false)

    // Only `sandbox` flips — the flag a caller might be tempted to omit from a
    // hand-picked dependency list (as ProjectPanel used to for `swarm`).
    fetchMock.mockImplementation(() => reply({ eligible: true, flags: { swarm: false, sandbox: true } }))

    await act(async () => {
      await result.current.refresh()
    })

    expect(result.current.flags).not.toBe(firstFlags)
    expect(result.current.flags.sandbox).toBe(true)
  })
})
