import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import { ConversationDraftOwnerContext } from './useConversationDraft'
import type { RuntimeTransitionStatus } from './types'
import { actOnRuntimeTransition } from './useChatGptConnection'

export interface PresidentRuntimeView {
  conversationId: string
  epoch: number
  activeTurnId?: string
  capabilities: { conversationControl: number }
  runtime?: RuntimeTransitionStatus
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
  const [recovery, setRecovery] = useState({ identity, busy: false, error: false })
  const pending = useRef<{ identity: string; operation: StopOperation } | null>(null)
  const flight = useRef<AbortController | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const refresh = useCallback(() => setRefreshNonce(value => value + 1), [])
  const readStatus = useCallback(async (signal?: AbortSignal): Promise<PresidentRuntimeView | null> => {
    const response = await fetch(`/api/conversation/president/status?path=${encodeURIComponent(projectPath)}`, {
      cache: 'no-store', signal, headers: { 'X-OpenGround-Owner': owner! },
    })
    if (signal?.aborted || currentIdentity.current !== identity) return null
    if (response.status === 403 || response.status === 404) { setView({ identity, status: null, available: false }); return null }
    if (!response.ok) throw new Error('runtime-unavailable')
    const data = await response.json() as PresidentRuntimeView & { state?: string }
    if (signal?.aborted || currentIdentity.current !== identity) return null
    if (data.state !== 'delivered' || data.capabilities?.conversationControl !== 1 || typeof data.conversationId !== 'string' || !data.conversationId || !Number.isSafeInteger(data.epoch) || data.epoch < 0
      || (data.activeTurnId !== undefined && (typeof data.activeTurnId !== 'string' || !data.activeTurnId))
      || data.runtime && (data.runtime.scope !== 'swarm' || !Number.isSafeInteger(data.runtime.revision) || data.runtime.revision < 0
        || !['stable', 'draining', 'checkpointed', 'retiring', 'launching', 'attention'].includes(data.runtime.phase))) throw new Error('runtime-unavailable')
    setView({ identity, status: data, available: true })
    return data
  }, [owner, projectPath, identity])
  useEffect(() => {
    if (!enabled || !owner) return
    window.addEventListener('openground:chatgpt-change', refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener('openground:chatgpt-change', refresh); window.removeEventListener('focus', refresh) }
  }, [enabled, owner, refresh])
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
        if (!await readStatus(controller.signal)) return
      } catch {
        if (alive && currentIdentity.current === identity) setView(previous => previous.identity === identity ? { ...previous, available: false } : { identity, status: null, available: false })
      }
      if (alive) timer = setTimeout(() => void poll(), 2500)
    }
    void poll()
    return () => { alive = false; controller.abort(); clearTimeout(timer) }
  }, [enabled, owner, projectPath, identity, refreshNonce, readStatus])
  const status = enabled && owner && view.identity === identity ? view.status : null
  const available = !!(enabled && owner && view.identity === identity && view.available)
  const state = action.identity === identity ? action : { busy: false, error: false, queued: false, pending: false }
  const recoveryState = recovery.identity === identity ? recovery : { busy: false, error: false }
  const admissionBlocked = !!owner && enabled && (!available || !!status?.runtime && status.runtime.phase !== 'stable')
  const checkAdmission = useCallback(async (): Promise<boolean> => {
    if (!owner) return true // The legacy public/local desk has no owner runtime controls.
    if (!enabled) return false
    try { const next = await readStatus(); return !!next && (!next.runtime || next.runtime.phase === 'stable') }
    catch { if (currentIdentity.current === identity) setView(previous => ({ ...previous, available: false })); return false }
  }, [owner, enabled, readStatus, identity])
  const transition = async (next: 'retry' | 'cancel') => {
    if (!owner || !available || status?.runtime?.phase !== 'attention' || flight.current) return
    const controller = new AbortController()
    flight.current = controller
    setRecovery({ identity, busy: true, error: false })
    try {
      await actOnRuntimeTransition(next, 'swarm', status.runtime.revision, { owner, signal: controller.signal })
      if (currentIdentity.current === identity && !controller.signal.aborted) refresh()
    } catch { if (currentIdentity.current === identity && !controller.signal.aborted) setRecovery({ identity, busy: true, error: true }) }
    finally {
      if (currentIdentity.current === identity && !controller.signal.aborted) setRecovery(previous => ({ ...previous, busy: false }))
      if (flight.current === controller) flight.current = null
    }
  }
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
  return { status, available, ...state, admissionBlocked, checkAdmission, transition, transitionBusy: recoveryState.busy, transitionError: recoveryState.error,
    canStop: available && !state.busy && !recoveryState.busy && (!!status?.activeTurnId || state.pending), stop }
}
