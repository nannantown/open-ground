import { useCallback, useContext, useEffect, useRef, useState } from 'react'

import { ConversationDraftOwnerContext } from '@/lib/useConversationDraft'

export interface AssistantPendingTurn { id: string; text: string; state: string; error?: string }
export interface AssistantRuntimeView { conversationId: string; epoch: number; pending: AssistantPendingTurn[]; uncertainActions: { id: string }[]; actions?: { id: string; state: string }[] }
export type AssistantReset = 'stop-turn' | 'new-conversation' | 'delete-memory' | 'delete-history'
interface ResetOperation { operationId: string; kind: AssistantReset; turnId?: string; conversationId: string; epoch: number }

/** Reset request identity survives a lost response; a retry cannot reset twice. */
export const useAssistantRuntime = (enabled: boolean) => {
  const owner = useContext(ConversationDraftOwnerContext)
  const currentOwner = useRef(owner)
  currentOwner.current = owner
  const operationKey = `openground:assistant-control:${encodeURIComponent(owner ?? '')}`
  const [runtime, setRuntime] = useState<AssistantRuntimeView | null>(null)
  const [busy, setBusy] = useState(false)
  const [needsReview, setNeedsReview] = useState(false)
  const [error, setError] = useState(false)
  const pendingReset = useRef<ResetOperation | null>(null)
  const load = useCallback(async () => {
    if (!enabled) return
    const response = await fetch('/api/assistant/runtime', { cache: 'no-store', headers: owner ? { 'X-OpenGround-Owner': owner } : {} })
    if (!response.ok) throw new Error('runtime-unavailable')
    const next = await response.json() as AssistantRuntimeView
    if (currentOwner.current === owner) setRuntime(next)
  }, [enabled, owner])
  useEffect(() => {
    if (!enabled) { setRuntime(null); return }
    const refresh = () => void load().catch(() => setError(true))
    pendingReset.current = null
    try {
      const saved = localStorage.getItem(operationKey)
      if (saved) {
        const value = JSON.parse(saved) as ResetOperation | null
        if (value && typeof value.operationId === 'string' && ['stop-turn', 'new-conversation', 'delete-memory', 'delete-history'].includes(value.kind)) pendingReset.current = value
      }
    } catch { setError(true) }
    refresh()
    const timer = setInterval(refresh, 2000)
    return () => clearInterval(timer)
  }, [enabled, load, operationKey])
  const reset = async (kind: AssistantReset) => {
    if (!runtime || busy) return
    if (pendingReset.current && pendingReset.current.kind !== kind) { setError(true); return }
    const operation = pendingReset.current ?? { operationId: crypto.randomUUID(), kind, conversationId: runtime.conversationId, epoch: runtime.epoch,
      ...(kind === 'stop-turn' ? { turnId: runtime.pending.find(turn => turn.state === 'running')?.id } : {}) }
    pendingReset.current = operation
    setBusy(true); setError(false)
    try {
      localStorage.setItem(operationKey, JSON.stringify(operation))
      const response = await fetch('/api/assistant/reset', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(owner ? { 'X-OpenGround-Owner': owner } : {}) }, body: JSON.stringify(operation) })
      if (currentOwner.current !== owner) return
      if (!response.ok) { if (response.status >= 400 && response.status < 500) { pendingReset.current = null; localStorage.removeItem(operationKey) }; throw new Error('reset-unavailable') }
      setRuntime(await response.json() as AssistantRuntimeView)
      pendingReset.current = null
      localStorage.removeItem(operationKey)
      window.dispatchEvent(new Event('openground:assistant-reset'))
    } catch { setError(true) } finally { setBusy(false) }
  }
  const retryIdentity = async (clientId: string): Promise<{ clientId: string; conversationId?: string; epoch?: number } | null> => {
    if (!owner) return null
    const headers = { 'X-OpenGround-Owner': owner }
    setNeedsReview(false)
    try {
      const response = await fetch(`/api/conversation/receipt?scope=assistant&clientId=${encodeURIComponent(clientId)}`, { cache: 'no-store', headers })
      if (currentOwner.current !== owner) return null
      if (response.status === 404) return { clientId }
      if (!response.ok) throw new Error('receipt-unavailable')
      const receipt = await response.json() as { state?: string }
      if (receipt.state === 'uncertain') { setNeedsReview(true); return null }
      if (receipt.state === 'failed' || receipt.state === 'interrupted') {
        const status = await fetch('/api/assistant/runtime', { cache: 'no-store', headers })
        if (!status.ok) throw new Error('runtime-unavailable')
        const fresh = await status.json() as AssistantRuntimeView
        if (currentOwner.current !== owner) return null
        setRuntime(fresh)
        if (fresh.uncertainActions.length || !Array.isArray(fresh.actions) || fresh.actions.length) { setNeedsReview(true); return null }
        return { clientId: crypto.randomUUID(), conversationId: fresh.conversationId, epoch: fresh.epoch }
      }
      return { clientId }
    } catch { setError(true); return null }
  }
  return { runtime, busy, error, needsReview, reset, retryIdentity }
}
