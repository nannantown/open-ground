// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { requestChatGptPreferences, useChatGptConnection } from './useChatGptConnection'
import type { ChatGptStatus, RuntimeTransitionStatus } from './types'

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })
it('recovers a failed status read after a 202 switch even when the previous observed status was stable', async () => {
  vi.useFakeTimers()
  const runtime = (phase: RuntimeTransitionStatus['phase']) => ({ scope: 'swarm' as const, revision: 3, phase, effective: { provider: 'chatgpt' as const }, desired: { provider: 'claude' as const }, updatedAt: '2026-11-09T00:00:00Z' })
  let phase: RuntimeTransitionStatus['phase'] = 'stable', failRead = false, reads = 0
  const body = (): ChatGptStatus => ({ connection: { state: 'signed-out', models: [] }, lockdown: false, preferences: {}, runtime: { assistant: { ...runtime('stable'), scope: 'assistant' }, swarm: runtime(phase) } })
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/preferences')) { phase = 'draining'; failRead = true; return new Response(JSON.stringify({ preferences: {}, runtime: body().runtime }), { status: 202 }) }
    reads++
    if (failRead) { failRead = false; throw new Error('synthetic temporary read failure') }
    return new Response(JSON.stringify(body()))
  }))
  const view = renderHook(() => useChatGptConnection(true))
  await act(async () => {})
  expect(view.result.current.status?.runtime?.swarm.phase).toBe('stable')
  await act(async () => { await requestChatGptPreferences({ swarmProvider: 'claude' }) })
  expect(view.result.current.error).toBe(true)
  phase = 'attention'
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(reads).toBeGreaterThanOrEqual(3)
  expect(view.result.current.status?.runtime?.swarm.phase).toBe('attention')
  expect(view.result.current.error).toBe(false)
})
