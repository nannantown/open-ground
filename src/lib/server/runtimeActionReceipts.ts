import { createHash } from 'node:crypto'
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk'
import { acceptConversationReceipt, claimConversationReceipt, finishConversationReceipt, listConversationReceipts, readConversationReceipt } from './conversationReceipts'
import { projectUUIDFromPath } from './projectDataPath'
import { hasChatGptAccess } from './chatgptAccess'
import { runtimeOwnerKey } from './runtimeOwner'

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>
const idFor = (sessionId: string, toolId: string) => `tool-${createHash('sha256').update(JSON.stringify([sessionId, toolId])).digest('hex')}`
// Persisted receipt hashes retain their original format. Only comparisons
// across SDK message/hook JSON ignore object key order; arrays retain order.
const inputHash = (input: unknown) => createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex')
const inputValueHash = (input: unknown): string => {
  const ancestors = new Set<object>()
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
    if (typeof value !== 'object' || ancestors.has(value)
      || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Invalid JSON tool input.')
    ancestors.add(value)
    try {
      return Array.isArray(value) ? `[${Array.from(value, canonical).join(',')}]`
        : `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
    } finally { ancestors.delete(value) }
  }
  return createHash('sha256').update(canonical(input ?? null)).digest('hex')
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
export interface ClaudeRuntimeToolAudit { hooks: Hooks; observeSdkMessage(message: unknown): Promise<void> }
/** Audit hooks never grant permission: every existing guard remains authoritative.
 * Started-without-post receipts are conservative recovery holds, even when a
 * native permission denial may have prevented the effect. */
export const createClaudeRuntimeToolAudit = async (cwd: string, sessionId: string, raw: unknown = {}, expectedOwnerKey?: string): Promise<ClaudeRuntimeToolAudit> => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid runtime tool guards.')
  const hooks = raw as Hooks
  if (Object.values(hooks).some((matchers) => !Array.isArray(matchers) || matchers.some((matcher) => !matcher || !Array.isArray(matcher.hooks) || matcher.hooks.some((hook) => typeof hook !== 'function')))) throw new Error('Invalid runtime tool guards.')
  if (!await hasChatGptAccess()) {
    if (expectedOwnerKey) throw new Error('The owner account changed.')
    return { hooks, observeSdkMessage: async () => {} }
  }
  const scope = await projectUUIDFromPath(cwd).catch(() => null)
  if (!scope) return { hooks, observeSdkMessage: async () => {} } // assistant has its own read-only/proposal journal
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  const { agentConversationHandles } = await import('./liveDesks')
  const handles = agentConversationHandles(sessionId)
  if (handles.length !== 1) throw new Error('A unique recorded actor is required before a tool can execute.')
  const execution = { ...handles[0], sessionId }
  const recordingFaults = new Set<string>()
  const claimed = new Map<string, { id: string; tool: string; inputHash: string; inputValueHash: string; claimed: boolean; ambiguous: boolean; backgroundRequested: boolean }>()
  const observed = new Map<string, { tool: string; inputValueHash: string; currentSession: boolean; ambiguous: boolean }>()
  const denied = new Map<string, { tool: string; inputValueHash: string }>()
  const forget = (callId: string) => { claimed.delete(callId); observed.delete(callId); denied.delete(callId) }
  const result = { ...hooks }
  const existingPre = (hooks.PreToolUse ?? []).map(matcher => ({ ...matcher, hooks: matcher.hooks.map(hook => async (...args: Parameters<typeof hook>) => {
    const output = await hook(...args), [input, toolId] = args, decision = object(object(output)?.hookSpecificOutput)
    // Observe the real guard's unchanged decision. Command stdout alone can
    // never prove a veto, even if it prints the same native error prefix.
    try {
      if (input.hook_event_name === 'PreToolUse' && decision?.hookEventName === 'PreToolUse' && decision.permissionDecision === 'deny'
        && typeof decision.permissionDecisionReason === 'string' && decision.permissionDecisionReason.startsWith('openground-guard BLOCKED: ')) {
        const callId = toolId ?? input.tool_use_id
        if (callId && (denied.size < 256 || denied.has(callId))) denied.set(callId, { tool: input.tool_name, inputValueHash: inputValueHash(input.tool_input) })
        else recordingFaults.add('guard-observation-capacity')
      }
    } catch { recordingFaults.add('guard-observation-unavailable') }
    return output
  }) }))
  result.PreToolUse = [...existingPre, { hooks: [async (input, toolId) => {
    try {
    if (input.hook_event_name !== 'PreToolUse') throw new Error('Invalid tool receipt hook.')
    const callId = toolId ?? input.tool_use_id
    if (!callId) throw new Error('A tool call without an ID cannot execute.')
    // Reserve before any await: a denied duplicate must never provide outcome
    // evidence for an earlier, possibly executing use of the same tool ID.
    const previous = claimed.get(callId)
    if (previous) {
      previous.ambiguous = true
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This tool call already has a receipt or an uncertain result. Inspect it before proceeding.' } }
    }
    if (claimed.size >= 256) throw new Error('Too many unconfirmed tool calls.')
    const id = idFor(sessionId, callId)
    const candidate = { id, tool: input.tool_name, inputHash: inputHash(input.tool_input), inputValueHash: inputValueHash(input.tool_input), claimed: false, ambiguous: false,
      backgroundRequested: object(input.tool_input)?.run_in_background === true }
    claimed.set(callId, candidate)
    if (recordingFaults.size) throw new Error('A tool result could not be recorded.')
    if (await runtimeOwnerKey() !== owner) throw new Error('The owner account changed.')
    await assertNoUncertainRuntimeActions(cwd, false)
    await acceptConversationReceipt(scope, id, { kind: 'runtime-tool', provider: 'claude', sessionId, toolId: callId, tool: input.tool_name,
      // Hash arguments, rather than copying file contents or credentials into a
      // second store. The native transcript supplies private inspection detail.
      inputHash: inputHash(input.tool_input) }, undefined, owner)
    if (!await claimConversationReceipt(scope, id, execution, owner)) {
      candidate.ambiguous = true
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This tool call already has a receipt or an uncertain result. Inspect it before proceeding.' } }
    }
    candidate.claimed = true
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
    const callId = toolId ?? input.tool_use_id, id = idFor(sessionId, callId)
    try { await finishConversationReceipt(scope, id, 'delivered', { confirmed: true }, owner); recordingFaults.delete(id); forget(callId) }
    catch (error) { recordingFaults.add(id); throw error }
    return {}
  }] }]
  result.PostToolUseFailure = [...(hooks.PostToolUseFailure ?? []), { hooks: [async (input, toolId) => {
    if (input.hook_event_name !== 'PostToolUseFailure') throw new Error('Invalid tool receipt hook.')
    // A returned failure is a confirmed result (possibly with partial effects).
    // An interrupted effect still needs inspection; it is never called undone.
    const callId = toolId ?? input.tool_use_id, id = idFor(sessionId, callId)
    try { await finishConversationReceipt(scope, id, input.is_interrupt ? 'uncertain' : 'delivered', { failed: true, interrupted: input.is_interrupt === true }, owner); recordingFaults.delete(id); forget(callId) }
    catch (error) { recordingFaults.add(id); throw error }
    return {}
  }] }]
  return { hooks: result, observeSdkMessage: async message => {
    const item = object(message), content = object(item?.message)?.content
    if (!item || !Array.isArray(content) || item.session_id !== undefined && item.session_id !== sessionId) return
    if (item.type === 'assistant') {
      for (const rawBlock of content) {
        const block = object(rawBlock)
        if (block?.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string' || !('input' in block)) continue
        if (observed.size >= 256 && !observed.has(block.id)) throw new Error('Too many unconfirmed tool observations.')
        const value = { tool: block.name, inputValueHash: inputValueHash(block.input), currentSession: item.session_id === sessionId, ambiguous: false }, previous = observed.get(block.id)
        if (previous && (previous.tool !== value.tool || previous.inputValueHash !== value.inputValueHash)) throw new Error('The observed tool identity changed.')
        if (previous) previous.ambiguous = true
        else observed.set(block.id, value)
      }
      return
    }
    if (item.type !== 'user') return
    const singleResult = content.filter(rawBlock => object(rawBlock)?.type === 'tool_result').length === 1
    for (const rawBlock of content) {
      const block = object(rawBlock)
      if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const callId = block.tool_use_id, candidate = claimed.get(callId), use = observed.get(callId), denial = denied.get(callId)
      // PostToolUseFailure does not run when PreToolUse vetoes a call. Only
      // this explicit OG veto result proves nonexecution. A strict native Bash
      // pre-hook failure proves a returned failure, never that effects were undone.
      const veto = candidate?.claimed && !candidate.ambiguous && denial && denial.tool === candidate.tool && denial.inputValueHash === candidate.inputValueHash
        && block.is_error === true && block.is_interrupt !== true && item.is_interrupt !== true && object(item.message)?.is_interrupt !== true
        && typeof block.content === 'string' && block.content.startsWith(`PreToolUse:${candidate.tool} hook error: openground-guard BLOCKED: `)
        && (item.tool_use_result === undefined || typeof item.tool_use_result === 'string')
      const nativeFailure = candidate?.claimed && !candidate.ambiguous && !candidate.backgroundRequested && candidate.tool === 'Bash'
        && use?.currentSession && !use.ambiguous && use.tool === candidate.tool && use.inputValueHash === candidate.inputValueHash
        && singleResult && item.session_id === sessionId && item.parent_tool_use_id === null && item.isSynthetic !== true && object(item.message)?.role === 'user'
        && block.is_error === true && block.is_interrupt !== true && item.is_interrupt !== true && object(item.message)?.is_interrupt !== true
        && typeof block.content === 'string' && block.content.startsWith('PreToolUse:Bash hook error: ') && block.content.slice('PreToolUse:Bash hook error: '.length).trim().length > 0
        && typeof item.tool_use_result === 'string' && item.tool_use_result === `Error: ${block.content}`
      if (!veto && !nativeFailure) { if (!candidate?.ambiguous) forget(callId); continue }
      try {
        await runtimeOwnerKey(owner)
        const receipt = await readConversationReceipt(scope, candidate.id, owner)
        if (claimed.get(callId) !== candidate || !candidate.claimed || candidate.ambiguous
          || !veto && (observed.get(callId) !== use || use?.ambiguous !== false)) continue
        if (!receipt || receipt.state !== 'executing') { forget(callId); continue }
        const body = object(receipt.body), actor = receipt.execution
        if (receipt.owner !== owner || receipt.scope !== scope || body?.kind !== 'runtime-tool' || body.provider !== 'claude'
          || body.sessionId !== sessionId || body.toolId !== callId || body.tool !== candidate.tool || body.inputHash !== candidate.inputHash
          || use && (use.tool !== candidate.tool || use.inputValueHash !== candidate.inputValueHash)
          || actor?.runtime !== 'sdk' || actor.sessionId !== sessionId || actor.handleId !== execution.handleId || execution.runtime !== 'sdk')
          throw new Error('The denied tool result does not match its recorded execution.')
        await runtimeOwnerKey(owner)
        const current = agentConversationHandles(sessionId)
        if (current.length !== 1 || current[0].runtime !== execution.runtime || current[0].handleId !== execution.handleId)
          throw new Error('The denied tool result belongs to a different actor.')
        if (claimed.get(callId) !== candidate || !candidate.claimed || candidate.ambiguous
          || !veto && (observed.get(callId) !== use || use?.ambiguous !== false)) continue
        await finishConversationReceipt(scope, candidate.id, veto ? 'rejected' : 'delivered', veto
          ? { confirmed: true, failed: true, denied: true, source: 'sdk-guard-veto', automaticReplay: false, effectsRolledBack: false }
          : { confirmed: true, failed: true, source: 'sdk-native-pretool-failure', automaticReplay: false, effectsRolledBack: false }, owner)
        recordingFaults.delete(candidate.id)
        forget(callId)
      } catch (error) { recordingFaults.add(candidate.id); throw error }
    }
  } }
}
/** Compatibility for callers that need only the permission hooks. */
export const guardClaudeRuntimeTools = async (cwd: string, sessionId: string, raw: unknown = {}, expectedOwnerKey?: string): Promise<Hooks> =>
  (await createClaudeRuntimeToolAudit(cwd, sessionId, raw, expectedOwnerKey)).hooks
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
