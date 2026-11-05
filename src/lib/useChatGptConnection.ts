import { useCallback, useEffect, useState } from 'react'
import type { ChatGptStatus, RuntimeScope } from './types'

const CHANGED = 'openground:chatgpt-change'
export const refreshChatGptConnection = () => window.dispatchEvent(new Event(CHANGED))

/** An inaccessible owner route stays hidden. A failed read remains unknown. */
export const useChatGptConnection = (enabled: boolean) => {
  const [status, setStatus] = useState<ChatGptStatus | null>(null)
  const [eligible, setEligible] = useState<boolean | null>(null)
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  const refresh = useCallback(() => setNonce((n) => n + 1), [])
  useEffect(() => {
    if (!enabled) return
    window.addEventListener(CHANGED, refresh)
    window.addEventListener('focus', refresh)
    return () => {
      window.removeEventListener(CHANGED, refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [enabled, refresh])
  useEffect(() => {
    if (!enabled) return
    const controller = new AbortController()
    setLoading(true)
    void fetch('/api/chatgpt/status', { cache: 'no-store', signal: controller.signal })
      .then(async (r) => {
        if (r.status === 403) {
          if (!controller.signal.aborted) { setEligible(false); setStatus(null); setError(false) }
          return
        }
        if (!r.ok) throw new Error('status unavailable')
        const next = await r.json() as ChatGptStatus
        if (!controller.signal.aborted) { setStatus(next); setEligible(true); setError(false) }
      })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [enabled, nonce])
  useEffect(() => {
    if (!enabled || (status?.connection.state !== 'connecting' && !Object.values(status?.runtime ?? {}).some(runtime => runtime.phase !== 'stable'))) return
    const timer = window.setInterval(refresh, 2_000)
    return () => window.clearInterval(timer)
  }, [enabled, status?.connection.state, status?.runtime, refresh])
  return { status, eligible, error, loading, refresh }
}

export type ChatGptPreferencePatch = { [K in keyof ChatGptStatus['preferences']]?: ChatGptStatus['preferences'][K] | null }
export interface ChatGptPreferenceResult { preferences: ChatGptStatus['preferences']; runtime?: ChatGptStatus['runtime'] }
export const requestChatGptPreferences = async (patch: ChatGptPreferencePatch): Promise<ChatGptPreferenceResult> => {
  const response = await fetch('/api/chatgpt/preferences', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error('preferences not saved')
  const body = await response.json() as ChatGptPreferenceResult
  refreshChatGptConnection()
  return body
}
export const saveChatGptPreferences = async (patch: ChatGptPreferencePatch): Promise<ChatGptStatus['preferences']> => {
  return (await requestChatGptPreferences(patch)).preferences
}
export const actOnRuntimeTransition = async (action: 'retry' | 'cancel', scope: RuntimeScope, revision: number): Promise<void> => {
  const response = await fetch('/api/chatgpt/transition', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, scope, revision }),
  })
  if (!response.ok) throw new Error('transition not changed')
  refreshChatGptConnection()
}
