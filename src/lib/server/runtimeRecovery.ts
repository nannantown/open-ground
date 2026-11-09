import { hasChatGptAccess } from './chatgptAccess'
import { basename } from 'node:path'
import { getChatGptConnection } from './chatgptAuth'
import { listConversationReceipts } from './conversationReceipts'
import { finishConversationReceipt } from './conversationReceipts'
import { listChatGptUncertainActions } from './chatgptResponses'
import { isAgentConversationOccupied, isRecordedRuntimeHandleOccupied } from './liveDesks'
import { runtimeOwnerKey } from './runtimeOwner'
import { getSettings } from './store'
import { presidentInputHasKnownFinal } from './presidentInbox'
import { listSwarmLaunchRecoveryIssues, listNativeConversationRecoveryIssues } from './swarmRuntimeTransition'

export interface RuntimeRecoveryIssue {
  id: string
  scope: string
  kind: 'input' | 'tool' | 'conversation' | 'launch'
  tool?: string
  conversationId?: string
  callId?: string
  projectName?: string
  projectPath?: string
  state: 'uncertain'
  inspectionError?: 'native-history-unavailable'
}
/** Metadata only. Arguments, file contents, credentials and raw reasoning stay private. */
export const runtimeRecoveryIssues = async (expectedOwnerKey?: string): Promise<RuntimeRecoveryIssue[]> => {
  if (!await hasChatGptAccess()) return []
  const owner = await runtimeOwnerKey(expectedOwnerKey)
  const settings = await getSettings()
  const receipts = await listConversationReceipts(owner)
  for (const receipt of receipts) {
    const body = receipt.body as { kind?: string; sessionId?: string; agentSessionId?: string } | null
    if (receipt.state !== 'executing' || !['president-input', 'runtime-tool', 'swarm-handoff-input'].includes(body?.kind ?? '') || presidentInputHasKnownFinal(receipt)) continue
    const sessionId = receipt.execution?.sessionId ?? body?.sessionId ?? body?.agentSessionId
    const occupied = receipt.execution ? isRecordedRuntimeHandleOccupied(receipt.execution.runtime, receipt.execution.handleId) : sessionId && isAgentConversationOccupied(sessionId)
    if (!occupied) {
      await finishConversationReceipt(receipt.scope, receipt.id, 'uncertain', { reason: 'actor-ended-without-result', automaticReplay: false }, owner)
      receipt.state = 'uncertain'
    }
  }
  const issues: RuntimeRecoveryIssue[] = receipts.filter((r) => r.scope !== 'control-recovery' && r.state === 'uncertain' && ((r.body as { kind?: unknown } | null)?.kind !== 'runtime-tool'
    || !(r.execution ? isRecordedRuntimeHandleOccupied(r.execution.runtime, r.execution.handleId) : isAgentConversationOccupied((r.body as { sessionId: string }).sessionId)))).map((r) => {
    const body = r.body as { kind?: string; tool?: string } | null
    return { id: r.id, scope: r.scope, kind: body?.kind === 'runtime-tool' ? 'tool' : 'input', ...(body?.tool ? { tool: body.tool } : {}), state: 'uncertain' }
  })
  // Signed-out history is preserved; inspecting it must not refresh an API key.
  if (!settings.lockdownMode && (await getChatGptConnection()).state === 'connected') for (const action of await listChatGptUncertainActions()) {
    if (isAgentConversationOccupied(action.conversationId)) continue
    issues.push({ id: `${action.conversationId}:${action.callId}`, scope: 'swarm', kind: 'conversation', ...action, state: 'uncertain' })
  }
  for (const issue of await listSwarmLaunchRecoveryIssues()) issues.push({ id: issue.id, scope: 'swarm', kind: 'launch', state: 'uncertain' })
  issues.push(...await listNativeConversationRecoveryIssues())
  for (const issue of issues) {
    const project = settings.projects?.find(project => project.id === issue.scope)
    if (project) { issue.projectName = project.displayName || basename(project.path); issue.projectPath = project.path }
  }
  await runtimeOwnerKey(owner)
  return issues
}
