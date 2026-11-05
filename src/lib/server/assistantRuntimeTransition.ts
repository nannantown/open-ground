import { randomUUID } from 'node:crypto'
import { clearAssistantLog, clearAssistantMemory, appendAssistantReceiptEntries, type AssistantEntry } from './assistantMemory'
import { clearProposals, assistantApprovalsSettled, __resetProposals, listProposals } from './assistantProposals'
import { closeAssistantSession } from './assistantSession'
import { mutateAssistantRuntime, readAssistantRuntime, recoverAssistantRuntime, resetAssistantRuntimeState,
  AssistantRuntimeConflict, type AssistantResetKind } from './assistantRuntimeStore'
import { assistantRuntimeDirectory, publicAssistantTurnReceipt, type AssistantActionReceipt } from './assistantRuntimeStore'
import { clearAssistantRuntimeHistoryPayloads, getAssistantResetOperation } from './assistantRuntimeStore'
import { runtimeOwnerKey } from './runtimeOwner'
import type { RuntimeProfile } from '../types'

export const assistantRuntimeStatus = () => {
  const state = readAssistantRuntime()
  const publicAction = (action: AssistantActionReceipt) => {
    const { hash: _hash, proposal, ...receipt } = action
    if (!proposal) return receipt
    const { path: _path, about: _about, originTurnId: _origin, pressing: _pressing, cancel: _cancel, ...shown } = proposal
    return { ...receipt, proposal: shown }
  }
  return { conversationId: state.conversationId, epoch: state.epoch, generation: state.generation,
    pending: state.turns.filter(t => t.state !== 'completed' && t.state !== 'cancelled').map(publicAssistantTurnReceipt),
    proposals: listProposals(), uncertainActions: state.actions.filter(a => a.state === 'uncertain').map(publicAction),
    receipts: state.turns.map(publicAssistantTurnReceipt), actions: state.actions.map(publicAction) }
}
export const drainAssistantRuntime = async (): Promise<Record<string, unknown>> => {
  mutateAssistantRuntime(state => { state.drainPaused = true; state.paused = true })
  const assistant = await import('./phoneAssistant')
  await Promise.all([assistant.waitForAssistantRuntimeIdle(), assistant.assistantFoldsSettled(), assistantApprovalsSettled()])
  const state = readAssistantRuntime()
  return { version: 1, conversationId: state.conversationId, epoch: state.epoch, generation: state.generation,
    queued: state.turns.filter(t => t.state === 'queued').map(t => t.id), actions: state.actions.filter(a => a.state === 'completed').map(a => a.id) }
}
/** Cancel a drain before retirement. Keep the admitted attempt and its native
 * actor intact; the coordinator releases the global gate before queue kick. */
export const cancelAssistantRuntimeDrain = async (): Promise<void> => {
  mutateAssistantRuntime(state => {
    state.drainPaused = false
    state.paused = state.operations.some(operation => operation.phase === 'prepared')
  })
}
export const retireAssistantRuntime = async (checkpoint: unknown): Promise<void> => {
  const state = readAssistantRuntime()
  const saved = checkpoint as { conversationId?: unknown; epoch?: unknown } | null
  if (!saved || saved.conversationId !== state.conversationId || saved.epoch !== state.epoch) throw new AssistantRuntimeConflict('checkpoint-retired')
  closeAssistantSession()
  mutateAssistantRuntime(s => { s.generation++; s.drainPaused = true; s.paused = true })
}
export const resumeAssistantRuntime = async (profile: RuntimeProfile, checkpoint: unknown): Promise<void> => {
  const state = readAssistantRuntime()
  const saved = checkpoint as { conversationId?: unknown; epoch?: unknown } | null
  if (saved?.conversationId !== undefined && (saved.conversationId !== state.conversationId || saved.epoch !== state.epoch)) throw new AssistantRuntimeConflict('checkpoint-retired')
  recoverAssistantRuntime()
  for (const operation of readAssistantRuntime().operations) if (operation.phase === 'prepared' && operation.kind)
    await resetAssistantRuntime({ operationId: operation.id, kind: operation.kind, turnId: operation.turnId })
  __resetProposals(true) // discard only the old process cache, preserving disk receipts
  mutateAssistantRuntime(s => { s.profile = profile; s.drainPaused = false; s.paused = false })
  for (const receipt of readAssistantRuntime().turns) if (receipt.state === 'completed' && receipt.result?.entries) {
    await appendAssistantReceiptEntries(receipt.id, receipt.result.entries as unknown as Omit<AssistantEntry, 'id'>[], () => readAssistantRuntime().epoch === receipt.epoch)
  }
  void (await import('./phoneAssistant')).resumeQueuedAssistantTurns().catch(() => {})
}
type ResetInput = { operationId?: string; kind: AssistantResetKind; turnId?: string; conversationId?: string; epoch?: number; expectedOwnerKey?: string }
const resets = new Map<string, Promise<ReturnType<typeof assistantRuntimeStatus>>>()
export const resetAssistantRuntime = async (input: ResetInput): Promise<ReturnType<typeof assistantRuntimeStatus>> => {
  if (input.expectedOwnerKey) {
    await runtimeOwnerKey(input.expectedOwnerKey)
    const owner = readAssistantRuntime().ownerKey
    if (owner && owner !== input.expectedOwnerKey) throw new AssistantRuntimeConflict('owner-changed')
  }
  const operationId = input.operationId ?? randomUUID()
  const key = JSON.stringify([assistantRuntimeDirectory(), operationId])
  const active = resets.get(key)
  if (active) {
    // Verify duplicate content even while the first call is awaiting I/O.
    resetAssistantRuntimeState(operationId, input.kind, input.turnId)
    return active
  }
  const run = performReset({ ...input, operationId })
  resets.set(key, run)
  try { return await run } finally { if (resets.get(key) === run) resets.delete(key) }
}
const performReset = async (input: ResetInput & { operationId: string }): Promise<ReturnType<typeof assistantRuntimeStatus>> => {
  const state = readAssistantRuntime()
  if (input.expectedOwnerKey && state.ownerKey && input.expectedOwnerKey !== state.ownerKey) throw new AssistantRuntimeConflict('owner-changed')
  const operationId = input.operationId
  const previous = getAssistantResetOperation(operationId)
  const duplicate = previous !== undefined
  if (!duplicate && (input.conversationId !== undefined && input.conversationId !== state.conversationId || input.epoch !== undefined && input.epoch !== state.epoch)) throw new AssistantRuntimeConflict('conversation-changed')
  resetAssistantRuntimeState(operationId, input.kind, input.turnId)
  if (getAssistantResetOperation(operationId)?.phase === 'completed') return assistantRuntimeStatus()
  closeAssistantSession()
  if (input.kind === 'new-conversation' || input.kind === 'delete-history') clearProposals()
  ;(await import('./phoneAssistant')).notifyAssistantRuntimeReset()
  if (input.expectedOwnerKey) await runtimeOwnerKey(input.expectedOwnerKey)
  if (input.kind === 'delete-memory') await clearAssistantMemory()
  if (input.kind === 'delete-history') { await clearAssistantLog('assistant'); clearAssistantRuntimeHistoryPayloads() }
  mutateAssistantRuntime(s => {
    const operation = s.operations.find(operation => operation.id === operationId)
    if (operation) { operation.phase = 'completed'; s.paused = s.drainPaused || (operation.resumePaused ?? false) }
  })
  void (await import('./phoneAssistant')).resumeQueuedAssistantTurns().catch(() => {})
  return assistantRuntimeStatus()
}
