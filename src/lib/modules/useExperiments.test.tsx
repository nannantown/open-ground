// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useExperiments } from './useExperiments'

afterEach(() => vi.unstubAllGlobals())

it('drops the previous account gate immediately and ignores its late response', async () => {
  const replies: ((response: Response) => void)[] = []
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => replies.push(resolve))))
  const response = (eligible: boolean) => ({ ok: true, json: async () => ({
    eligible, flags: { swarm: true, sandbox: false }, swarmOptIn: { available: true, enabled: true },
  }) }) as Response
  const { result, rerender } = renderHook(({ id }) => useExperiments(id), { initialProps: { id: 'owner' } })
  await act(async () => replies[0](response(true)))
  expect(result.current.eligible).toBe(true)
  let pending: Promise<void>
  act(() => { pending = result.current.refresh() })
  rerender({ id: 'public' })
  expect(result.current.eligible).toBe(false)
  await act(async () => replies[2](response(false)))
  await act(async () => { replies[1](response(true)); await pending })
  await waitFor(() => expect(result.current.loaded).toBe(true))
  expect(result.current.eligible).toBe(false)
  expect(result.current.flags.swarm).toBe(true)
})
