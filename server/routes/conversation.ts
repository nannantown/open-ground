import { Hono } from 'hono'
import { hasChatGptAccess } from '@/lib/server/chatgptAccess'
import { readConversationDraft, saveConversationDraft, DraftConflict } from '@/lib/server/conversationDrafts'
import { presidentInputReceipt } from '@/lib/server/presidentInbox'
import { getAssistantTurnReceipt } from '@/lib/server/assistantRuntimeStore'
import { runtimeOwnerKey, runtimeRequestOwnerKey, withRuntimeOwner } from '@/lib/server/runtimeOwner'
import { randomUUID } from 'node:crypto'
import { projectUUIDFromPath } from '@/lib/server/projectDataPath'
import { handleConversationControl } from '@/lib/server/conversationControl'
import { getSupplyPublicConversation } from '@/lib/server/swarmSupplyRuntime'
import { getSettings } from '@/lib/server/store'
import { z } from 'zod'
import { runtimeRecoveryIssues } from '@/lib/server/runtimeRecovery'
import { acceptConversationReceipt, claimConversationReceipt, readConversationReceipt, reviewConversationReceipt, settleRecoveryReviewReceipt } from '@/lib/server/conversationReceipts'
import { reviewChatGptUncertainAction } from '@/lib/server/chatgptResponses'
import { isAgentConversationOccupied } from '@/lib/server/liveDesks'
import { hostIsLocal, originIsLocal } from '../loopback'
import { reviewSwarmLaunchRecovery, reviewNativeConversationRecovery } from '@/lib/server/swarmRuntimeTransition'
import { notifyRuntimeRecoveryChanged } from '@/lib/server/runtimeRecoveryBoot'

const reviewSchema = z.object({ operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), id: z.string().min(1).max(256), scope: z.string().min(1).max(128), kind: z.enum(['input', 'tool', 'conversation', 'launch']), conversationId: z.string().max(128).optional(), callId: z.string().max(128).optional(), note: z.string().trim().min(1).max(1000) }).strict()

const presidentStopSchema = z.object({ path: z.string().min(1).max(4096), operationId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/), conversationId: z.string().min(1).max(128), epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), turnId: z.string().min(1).max(128) }).strict()

export const conversationRoutes = new Hono<{ Variables: { conversationOwner: string } }>()
  .use('/api/conversation/*', async (c, next) => {
    const origin = c.req.header('origin'), host = c.req.header('host')
    if (origin !== undefined && !originIsLocal(origin) || host !== undefined && !hostIsLocal(host)) return c.json({ error: 'forbidden' }, 403)
    if (!await hasChatGptAccess()) return c.json({ error: 'forbidden' }, 403)
    try { c.set('conversationOwner', await runtimeRequestOwnerKey(c.req.header('X-OpenGround-Owner'))) } catch { return c.json({ error: 'owner-changed' }, 403) }
    return next()
  })
  // Desktop shares the phone controller's durable, exact-conversation/turn
  // contract. The renderer never asks the server to pick whichever turn is new.
  .get('/api/conversation/president/status', async (c) => {
    const path = c.req.query('path') ?? ''
    if (!path || path.length > 4096) return c.json({ error: 'Invalid project.' }, 400)
    const owner = c.get('conversationOwner')
    try {
      const projectId = await projectUUIDFromPath(path)
      await runtimeOwnerKey(owner)
      const result = await withRuntimeOwner(owner, () => handleConversationControl({ type: 'conversation-control', id: randomUUID(), action: 'status', scope: 'swarm', projectId }))
      return c.json(result, result.state === 'rejected' ? 409 : 200)
    } catch { return c.json({ error: 'The project or owner is no longer available.' }, 403) }
  })
  .get('/api/conversation/president/history', async (c) => {
    const path = c.req.query('path') ?? '', id = c.req.query('sessionId') ?? ''
    if (!path || path.length > 4096 || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return c.json({ error: 'Invalid conversation.' }, 400)
    const owner = c.get('conversationOwner')
    try {
      const projectId = await projectUUIDFromPath(path)
      const project = (await getSettings()).projects?.find(project => project.id === projectId)
      await runtimeOwnerKey(owner)
      if (!project) return c.json({ error: 'Conversation is unavailable.' }, 404)
      const history = getSupplyPublicConversation(project.path, id, owner)
      return history ? c.json(history) : c.json({ error: 'Conversation is unavailable.' }, 404)
    } catch { return c.json({ error: 'The project or owner is no longer available.' }, 403) }
  })
  .post('/api/conversation/president/stop', async (c) => {
    const parsed = presidentStopSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid stop request.' }, 400)
    const owner = c.get('conversationOwner'), body = parsed.data
    try {
      const projectId = await projectUUIDFromPath(body.path)
      await runtimeOwnerKey(owner)
      const result = await withRuntimeOwner(owner, () => handleConversationControl({ type: 'conversation-control', id: body.operationId, action: 'stop-turn', scope: 'swarm', projectId, conversationId: body.conversationId, epoch: body.epoch, turnId: body.turnId }))
      return c.json(result, result.state === 'rejected' ? 409 : result.state === 'queued' ? 202 : 200)
    } catch { return c.json({ error: 'The project or owner is no longer available.' }, 403) }
  })
  .get('/api/conversation/recovery', async (c) => c.json({ issues: await runtimeRecoveryIssues(c.get('conversationOwner')) }))
  .post('/api/conversation/recovery/review', async (c) => {
    const owner = c.get('conversationOwner')
    const parsed = reviewSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Invalid recovery review.' }, 400)
    const body = parsed.data
    try {
      await runtimeOwnerKey(owner)
      const receipt = await acceptConversationReceipt('control-recovery', body.operationId, { ...body, kind: 'recovery-review', reviewKind: body.kind }, undefined, owner)
      if (receipt.state === 'delivered') return c.json(receipt.result as Record<string, unknown>)
      await claimConversationReceipt('control-recovery', body.operationId, undefined, owner)
      if (body.kind === 'launch') {
        if (body.scope !== 'swarm') throw new Error('Invalid launch scope.')
        await reviewSwarmLaunchRecovery({ id: body.id, note: body.note, expectedOwnerKey: owner })
      } else if (body.kind === 'conversation' && body.id.startsWith('native-')) {
        if (!body.conversationId) throw new Error('Missing native conversation.')
        await reviewNativeConversationRecovery({ id: body.id, projectId: body.scope, sessionId: body.conversationId, note: body.note, operationId: body.operationId, expectedOwnerKey: owner })
      } else if (body.kind === 'conversation') {
        if (!body.conversationId || !body.callId || body.id !== `${body.conversationId}:${body.callId}`) return c.json({ error: 'Invalid conversation action.' }, 400)
        await reviewChatGptUncertainAction(body.conversationId, body.callId, body.note, body.operationId, owner)
      } else {
        const target = await readConversationReceipt(body.scope, body.id, owner)
        const payload = target?.body as { kind?: string; sessionId?: string } | undefined
        const sessionId = target?.execution?.sessionId ?? payload?.sessionId
        if (sessionId && isAgentConversationOccupied(sessionId)) return c.json({ error: 'The actor is still running. Stop it before reviewing an unconfirmed effect.' }, 409)
        await reviewConversationReceipt(body.scope, body.id, body.note, body.operationId, owner)
      }
      const result = { ok: true, issues: await runtimeRecoveryIssues(owner) }
      await settleRecoveryReviewReceipt(body.operationId, result, owner)
      void notifyRuntimeRecoveryChanged().catch(() => {})
      return c.json(result)
    } catch { return c.json({ error: 'The receipt changed or could not be saved. Refresh before reviewing it again.' }, 409) }
  })
  .get('/api/conversation/receipt', async (c) => {
    const scope = c.req.query('scope') ?? ''
    const id = c.req.query('clientId') ?? ''
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scope) || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return c.json({ error: 'Invalid message ID.' }, 400)
    const owner = c.get('conversationOwner')
    await runtimeOwnerKey(owner)
    const receipt = scope === 'assistant' ? getAssistantTurnReceipt(id, owner) : await presidentInputReceipt(scope, id, owner)
    return receipt ? c.json(receipt) : c.json({ error: 'Message has not been accepted.' }, 404)
  })
  .get('/api/conversation/draft', async (c) => {
    try { return c.json(await readConversationDraft(c.req.query('scope') ?? '', c.req.query('clientId') ?? '', c.get('conversationOwner'))) }
    catch { return c.json({ error: 'Draft could not be read.' }, 503) }
  })
  .put('/api/conversation/draft', async (c) => {
    const owner = c.get('conversationOwner')
    const body = await c.req.json().catch(() => null) as { revision?: unknown; text?: unknown } | null
    if (!body || typeof body.revision !== 'number' || typeof body.text !== 'string') return c.json({ error: 'Invalid draft.' }, 400)
    try { return c.json(await saveConversationDraft(c.req.query('scope') ?? '', c.req.query('clientId') ?? '', body.revision, body.text, owner)) }
    catch (error) {
      if (error instanceof DraftConflict) return c.json({ error: error.message, draft: error.draft }, 409)
      return c.json({ error: 'Draft could not be saved. Your text was retained.' }, 503)
    }
  })
