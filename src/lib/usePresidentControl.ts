import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ConversationDraftOwnerContext } from './useConversationDraft'

export interface PresidentRuntimeView {
  conversationId: string
  epoch: number
  activeTurnId?: string
  capabilities: { conversationControl: number }
}
interface StopOperation { path: string; operationId: string; conversationId: string; epoch: number; turnId: string }
const validOperation = (value: unknown, path: string): value is StopOperation => {
  const op = value as StopOperation | null
  return !!op && op.path === path && typeof op.operationId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(op.operationId)
    && typeof op.conversationId === 'string' && !!op.conversationId && typeof op.turnId === 'string' && !!op.turnId
    && Number.isSafeInteger(op.epoch) && op.epoch >= 0
}

/** Exact-turn control is separate from the seat's power switch. The operation
 * is captured before I/O and survives a lost acknowledgement unchanged. */
export const usePresidentControl = (projectPath: string, enabled: boolean) => {
  const owner = useContext(ConversationDraftOwnerContext)
  const identity = `${owner ?? ''}\n${projectPath}`
  const key = `openground:president-stop:${encodeURIComponent(owner ?? '')}:${encodeURIComponent(projectPath)}`
  const currentIdentity = useRef(identity)
  currentIdentity.current = identity
  const [view, setView] = useState<{ identity: string; status: PresidentRuntimeView | null; available: boolean }>({ identity, status: null, available: false })
  const [action, setAction] = useState<{ identity: string; busy: boolean; error: boolean; queued: boolean; pending: boolean }>({ identity, busy: false, error: false, queued: false, pending: false })
  const pending = useRef<{ identity: string; operation: StopOperation } | null>(null)
  const flight = useRef<AbortController | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const refresh = useCallback(() => setRefreshNonce(value => value + 1), [])
  useEffect(() => {
    if (!enabled || !owner) return
    let operation: StopOperation | null = null
    try {
      const saved = localStorage.getItem(key)
      const value: unknown = saved ? JSON.parse(saved) : null
      if (validOperation(value, projectPath)) operation = value
    } catch { /* A later explicit stop must persist its identity before I/O. */ }
    pending.current = operation ? { identity, operation } : null
    setAction({ identity, busy: false, error: !!operation, queued: false, pending: !!operation })
    return () => { flight.current?.abort(); flight.current = null }
  }, [enabled, owner, projectPath, key, identity])
  useEffect(() => {
    if (!enabled || !owner) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const controller = new AbortController()
    const poll = async () => {
      try {
        const response = await fetch(`/api/conversation/president/status?path=${encodeURIComponent(projectPath)}`, {
          cache: 'no-store', signal: controller.signal, headers: { 'X-OpenGround-Owner': owner },
        })
        if (!alive || currentIdentity.current !== identity) return
        if (response.status === 403 || response.status === 404) {
          setView({ identity, status: null, available: false })
          return
        }
        if (!response.ok) throw new Error('runtime-unavailable')
        const data = await response.json() as PresidentRuntimeView & { state?: string }
        if (!alive || currentIdentity.current !== identity) return
        if (data.state !== 'delivered' || data.capabilities?.conversationControl !== 1 || typeof data.conversationId !== 'string' || !data.conversationId || !Number.isSafeInteger(data.epoch) || data.epoch < 0
          || (data.activeTurnId !== undefined && (typeof data.activeTurnId !== 'string' || !data.activeTurnId))) throw new Error('runtime-unavailable')
        setView({ identity, status: data, available: true })
      } catch {
        if (alive && currentIdentity.current === identity) setView(previous => previous.identity === identity ? { ...previous, available: false } : { identity, status: null, available: false })
      }
      if (alive) timer = setTimeout(() => void poll(), 2500)
    }
    void poll()
    return () => { alive = false; controller.abort(); clearTimeout(timer) }
  }, [enabled, owner, projectPath, identity, refreshNonce])
  const status = enabled && owner && view.identity === identity ? view.status : null
  const available = !!(enabled && owner && view.identity === identity && view.available)
  const state = action.identity === identity ? action : { busy: false, error: false, queued: false, pending: false }
  const stop = async () => {
    if (!owner || !available || flight.current) return
    const operation = pending.current?.identity === identity ? pending.current.operation : status?.activeTurnId
      ? { path: projectPath, operationId: crypto.randomUUID(), conversationId: status.conversationId, epoch: status.epoch, turnId: status.activeTurnId } : null
    if (!operation) return
    const controller = new AbortController()
    flight.current = controller
    pending.current = { identity, operation }
    setAction({ identity, busy: true, error: false, queued: false, pending: true })
    try {
      localStorage.setItem(key, JSON.stringify(operation))
      const response = await fetch('/api/conversation/president/stop', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-OpenGround-Owner': owner }, body: JSON.stringify(operation),
      })
      if (currentIdentity.current !== identity || controller.signal.aborted) return
      const ack = await response.json() as { type?: string; id?: string; state?: string }
      if (currentIdentity.current !== identity || controller.signal.aborted) return
      if (ack.type !== 'ack' || ack.id !== operation.operationId || pending.current?.operation.operationId !== operation.operationId) throw new Error('stop-unconfirmed')
      if (ack.state === 'rejected' || response.ok && ack.state === 'delivered') {
        localStorage.removeItem(key)
        pending.current = null
        setAction({ identity, busy: false, error: ack.state === 'rejected', queued: false, pending: false })
      } else if (response.ok && ack.state === 'queued') setAction({ identity, busy: false, error: false, queued: true, pending: true })
      else throw new Error('stop-unconfirmed')
      refresh()
    } catch {
      if (currentIdentity.current === identity && !controller.signal.aborted) setAction({ identity, busy: false, error: true, queued: false, pending: true })
    } finally { if (flight.current === controller) flight.current = null }
  }
  return { status, available, ...state, canStop: available && !state.busy && (!!status?.activeTurnId || state.pending), stop }
}
