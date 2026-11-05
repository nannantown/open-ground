import { useCallback, useEffect, useState } from 'react'
import type { ChatGptStatus } from './types'

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
    if (!enabled || status?.connection.state !== 'connecting') return
    const timer = window.setInterval(refresh, 2_000)
    return () => window.clearInterval(timer)
  }, [enabled, status?.connection.state, refresh])
  return { status, eligible, error, loading, refresh }
}

export type ChatGptPreferencePatch = { [K in keyof ChatGptStatus['preferences']]?: ChatGptStatus['preferences'][K] | null }
export const saveChatGptPreferences = async (patch: ChatGptPreferencePatch): Promise<ChatGptStatus['preferences']> => {
  const response = await fetch('/api/chatgpt/preferences', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })
  if (!response.ok) throw new Error('preferences not saved')
  const body = await response.json() as { preferences: ChatGptStatus['preferences'] }
  refreshChatGptConnection()
  return body.preferences
}
