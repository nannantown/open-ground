import { z } from 'zod'
import { hasChatGptAccess } from './chatgptAccess'
import { runtimeTransitions } from './runtimeTransitions'
import { readConversationDraft, saveConversationDraft } from './conversationDrafts'
import { acceptConversationReceipt, claimConversationReceipt, finishConversationReceipt, publicConversationReceipt, readConversationReceipt, readConversationContext } from './conversationReceipts'
import { runtimeOwnerKey } from './runtimeOwner'
import { readAssistantRuntime, getAssistantTurnReceipt } from './assistantRuntimeStore'
import { getSettings } from './store'

export const CONVERSATION_CAPABILITIES = { conversationControl: 1, durableSay: 1 } as const
const wire = z.object({
  type: z.literal('conversation-control'), id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), ts: z.number().optional(),
  action: z.enum(['status', 'set-provider', 'retry', 'cancel', 'stop-turn', 'new-conversation', 'draft-read', 'draft-write', 'receipt']),
  scope: z.enum(['assistant', 'swarm']), projectId: z.string().max(128).optional(),
  revision: z.number().int().nonnegative().optional(), provider: z.enum(['claude', 'chatgpt']).optional(),
  originId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), text: z.string().max(32768).optional(), draftRevision: z.number().int().nonnegative().optional(),
  messageId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(), conversationId: z.string().max(128).optional(), epoch: z.number().int().nonnegative().optional(), turnId: z.string().max(128).optional(),
}).strict()
export const conversationCapabilities = async () => await hasChatGptAccess() ? CONVERSATION_CAPABILITIES : undefined
/** New controls are sealed by phoneLink; no credential fields are accepted or returned. */
export const handleConversationControl = async (raw: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const parsed = wire.safeParse(raw)
  const id = typeof raw.id === 'string' ? raw.id : undefined
  const ack = (state: 'queued' | 'delivered' | 'rejected', extra: Record<string, unknown> = {}) => ({ type: 'ack', id, state, ...extra })
  if (!parsed.success) return ack('rejected', { reason: 'bad-frame' })
  const f = parsed.data
  if (!await hasChatGptAccess()) return ack('rejected', { reason: 'forbidden' })
  const owner = await runtimeOwnerKey()
  const scope = f.scope === 'assistant' ? 'assistant' : f.projectId
  const project = f.scope === 'swarm' && f.projectId ? ((await getSettings()).projects ?? []).find((p) => p.id === f.projectId) : undefined
  if (!scope || (f.scope === 'swarm' && !project)) return ack('rejected', { reason: 'no-project' })
  let claimedScope: string | undefined
  try {
    const runtime = (await runtimeTransitions().status())[f.scope]
    await runtimeOwnerKey(owner)
    if (f.action === 'status') {
      const context = f.scope === 'assistant' ? readAssistantRuntime() : await readConversationContext(scope)
      const activeTurnId = f.scope === 'assistant' ? readAssistantRuntime().turns.find(turn => turn.state === 'running' && turn.ownerKey === owner)?.id
        : await (await import('./swarmRuntimeTransition')).presidentActiveTurnId(project!.path, owner)
      await runtimeOwnerKey(owner)
      return ack('delivered', { capabilities: CONVERSATION_CAPABILITIES, runtime, conversationId: context.conversationId, epoch: context.epoch, ...(activeTurnId ? { activeTurnId } : {}) })
    }
    if (f.action === 'draft-read') {
      if (!f.originId) return ack('rejected', { reason: 'bad-frame' })
      return ack('delivered', { draft: await readConversationDraft(scope, f.originId, owner) })
    }
    if (f.action === 'receipt') {
      if (!f.messageId) return ack('rejected', { reason: 'bad-frame' })
      const receipt = scope === 'assistant' ? getAssistantTurnReceipt(f.messageId, owner) : await readConversationReceipt(scope, f.messageId, owner).then((r) => r ? publicConversationReceipt(r) : null)
      return receipt ? ack('delivered', { receipt }) : ack('rejected', { reason: 'not-found' })
    }
    // State-changing controls also replay a durable receipt. A crash after an
    // unknown effect cannot run a reset or send another instruction twice.
    if ((f.action === 'stop-turn' || f.action === 'new-conversation') && (!f.conversationId || f.epoch === undefined || f.action === 'stop-turn' && !f.turnId)) return ack('rejected', { reason: 'stale-conversation' })
    const controlScope = `control-${f.scope}`
    const { ts: _ts, id: _id, ...body } = f
    const receipt = await acceptConversationReceipt(controlScope, f.id, body, undefined, owner)
    if (receipt.state === 'delivered') return ack('delivered', receipt.result as Record<string, unknown>)
    if (receipt.state === 'uncertain' || receipt.state === 'rejected' || receipt.state === 'cancelled') return ack('rejected', { reason: receipt.state, receipt: publicConversationReceipt(receipt) })
    if (!await claimConversationReceipt(controlScope, f.id, undefined, owner)) return ack('queued', { receipt: publicConversationReceipt(receipt) })
    claimedScope = controlScope
    let result: Record<string, unknown>
    if (f.action === 'set-provider') {
      if (!f.provider) throw new Error('bad-frame')
      const runtimes = await runtimeTransitions().request({ [f.scope === 'assistant' ? 'assistantProvider' : 'swarmProvider']: f.provider }, owner)
      result = { runtime: runtimes[f.scope] }
    } else if (f.action === 'retry' || f.action === 'cancel') {
      if (f.revision === undefined) throw new Error('bad-frame')
      result = { runtime: (await runtimeTransitions().control(f.action, f.scope, f.revision, owner))[f.scope] }
    } else if (f.action === 'draft-write') {
      if (!f.originId || f.draftRevision === undefined || f.text === undefined) throw new Error('bad-frame')
      result = { draft: await saveConversationDraft(scope, f.originId, f.draftRevision, f.text, owner) }
    } else if (f.action === 'stop-turn' || f.action === 'new-conversation') {
      if (f.scope === 'assistant') {
        const { resetAssistantRuntime } = await import('./assistantRuntimeTransition')
        await resetAssistantRuntime({ operationId: f.id, kind: f.action, turnId: f.turnId, conversationId: f.conversationId, epoch: f.epoch, expectedOwnerKey: owner })
        const context = readAssistantRuntime()
        result = { conversationId: context.conversationId, epoch: context.epoch }
      } else {
        const { controlPresidentConversation } = await import('./swarmRuntimeTransition')
        await controlPresidentConversation(project!.path, { action: f.action, operationId: f.id, turnId: f.turnId, conversationId: f.conversationId, epoch: f.epoch, expectedOwnerKey: owner })
        result = await readConversationContext(scope)
      }
    } else throw new Error('bad-frame')
    await finishConversationReceipt(controlScope, f.id, 'delivered', result, owner)
    return ack('delivered', result)
  } catch (error) {
    if (claimedScope) await finishConversationReceipt(claimedScope, f.id, 'uncertain', undefined, owner).catch(() => {})
    // A retriable validation/start error never authorizes model/API fallback.
    return ack('rejected', { reason: 'control-failed', detail: error instanceof Error ? error.message.slice(0, 300) : 'The operation could not finish. Saved work was retained.' })
  }
}
