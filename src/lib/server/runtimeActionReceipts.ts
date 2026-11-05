import { createHash } from 'node:crypto'
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk'
import { acceptConversationReceipt, claimConversationReceipt, finishConversationReceipt, listConversationReceipts } from './conversationReceipts'
import { projectUUIDFromPath } from './projectDataPath'
import { hasChatGptAccess } from './chatgptAccess'
import { runtimeOwnerKey } from './runtimeOwner'

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>
const idFor = (sessionId: string, toolId: string) => `tool-${createHash('sha256').update(JSON.stringify([sessionId, toolId])).digest('hex')}`
/** Audit hooks never grant permission: every existing guard remains authoritative.
 * Started-without-post receipts are conservative recovery holds, even when a
 * native permission denial may have prevented the effect. */
export const guardClaudeRuntimeTools = async (cwd: string, sessionId: string, raw: unknown = {}, expectedOwnerKey?: string): Promise<Hooks> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid runtime tool guards.')
  const hooks = raw as Hooks
  if (Object.values(hooks).some((matchers) => !Array.isArray(matchers) || matchers.some((matcher) => !matcher || !Array.isArray(matcher.hooks) || matcher.hooks.some((hook) => typeof hook !== 'function')))) throw new Error('Invalid runtime tool guards.')
  if (!await hasChatGptAccess()) {
    if (expectedOwnerKey) throw new Error('The owner account changed.')
    return hooks
  }
  const scope = await projectUUIDFromPath(cwd).catch(() => null)
  if (!scope) return hooks // assistant has its own read-only/proposal journal
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  const { agentConversationHandles } = await import('./liveDesks')
  const handles = agentConversationHandles(sessionId)
  if (handles.length !== 1) throw new Error('A unique recorded actor is required before a tool can execute.')
  const execution = { ...handles[0], sessionId }
  const recordingFaults = new Set<string>()
  const result = { ...hooks }
  result.PreToolUse = [...(hooks.PreToolUse ?? []), { hooks: [async (input, toolId) => {
    try {
    if (recordingFaults.size) throw new Error('A tool result could not be recorded.')
    if (input.hook_event_name !== 'PreToolUse') throw new Error('Invalid tool receipt hook.')
    if (await runtimeOwnerKey() !== owner) throw new Error('The owner account changed.')
    await assertNoUncertainRuntimeActions(cwd, false)
    const callId = toolId ?? input.tool_use_id
    if (!callId) throw new Error('A tool call without an ID cannot execute.')
    const id = idFor(sessionId, callId)
    await acceptConversationReceipt(scope, id, { kind: 'runtime-tool', provider: 'claude', sessionId, toolId: callId, tool: input.tool_name,
      // Hash arguments, rather than copying file contents or credentials into a
      // second store. The native transcript supplies private inspection detail.
      inputHash: createHash('sha256').update(JSON.stringify(input.tool_input ?? null)).digest('hex') }, undefined, owner)
    if (!await claimConversationReceipt(scope, id, execution, owner)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This tool call already has a receipt or an uncertain result. Inspect it before proceeding.' } }
    await runtimeOwnerKey(owner)
    return {}
    } catch {
      // A native hook exception can be treated as an advisory hook failure.
      // An explicit permission denial makes an unavailable journal fail closed.
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Owner authorization or durable action recording is unavailable. No action was authorized.' } }
    }
  }] }]
  result.PostToolUse = [...(hooks.PostToolUse ?? []), { hooks: [async (input, toolId) => {
    if (input.hook_event_name !== 'PostToolUse') throw new Error('Invalid tool receipt hook.')
    const id = idFor(sessionId, toolId ?? input.tool_use_id)
    try { await finishConversationReceipt(scope, id, 'delivered', { confirmed: true }, owner); recordingFaults.delete(id) }
    catch (error) { recordingFaults.add(id); throw error }
    return {}
  }] }]
  result.PostToolUseFailure = [...(hooks.PostToolUseFailure ?? []), { hooks: [async (input, toolId) => {
    if (input.hook_event_name !== 'PostToolUseFailure') throw new Error('Invalid tool receipt hook.')
    // A returned failure is a confirmed result (possibly with partial effects).
    // An interrupted effect still needs inspection; it is never called undone.
    const id = idFor(sessionId, toolId ?? input.tool_use_id)
    try { await finishConversationReceipt(scope, id, input.is_interrupt ? 'uncertain' : 'delivered', { failed: true, interrupted: input.is_interrupt === true }, owner); recordingFaults.delete(id) }
    catch (error) { recordingFaults.add(id); throw error }
    return {}
  }] }]
  return result
}
export const assertNoUncertainRuntimeActions = async (cwd?: string, includeExecuting = true): Promise<void> => {
  if (!await hasChatGptAccess()) return
  const scope = cwd ? await projectUUIDFromPath(cwd) : undefined
  const { isAgentConversationOccupied, isRecordedRuntimeHandleOccupied } = await import('./liveDesks')
  const uncertain = (await listConversationReceipts()).filter((r) => {
    const body = r.body as { kind?: unknown; sessionId?: unknown } | null
    const relevant = body?.kind === 'runtime-tool' || body?.kind === 'president-input'
    const originalActorLive = r.execution ? isRecordedRuntimeHandleOccupied(r.execution.runtime, r.execution.handleId) : typeof body?.sessionId === 'string' && isAgentConversationOccupied(body.sessionId)
    return (!scope || r.scope === scope) && relevant && (r.state === 'uncertain' || (r.state === 'executing' && (includeExecuting || !originalActorLive)))
  })
  if (uncertain.length) throw new Error('A previous tool operation has an unconfirmed result. Inspect the saved project work before resuming automatic work.')
}
/** A native abort only taints this actor's unconfirmed effects, never a
 * different worker's healthy parallel tool call in the same project. */
export const interruptRuntimeActions = async (sessionId: string, expectedOwnerKey?: string): Promise<void> => {
  if (!await hasChatGptAccess()) { if (expectedOwnerKey) throw new Error('The owner account changed.'); return }
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  for (const receipt of await listConversationReceipts(owner)) {
    const body = receipt.body as { kind?: string; sessionId?: string } | null
    if (receipt.state === 'executing' && body?.kind === 'runtime-tool' && body.sessionId === sessionId) await finishConversationReceipt(receipt.scope, receipt.id, 'uncertain', { interrupted: true }, owner)
  }
}
