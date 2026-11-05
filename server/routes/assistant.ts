import { Hono } from 'hono'
import { z } from 'zod'
import { hostIsLocal, originIsLocal } from '../loopback'
import { acceptAssistantInput, ASSISTANT_SAY_MAX } from '@/lib/server/phoneAssistant'
import { assistantRuntimeStatus, resetAssistantRuntime } from '@/lib/server/assistantRuntimeTransition'
import { AssistantRuntimeConflict, getAssistantTurnReceipt, publicAssistantTurnReceipt } from '@/lib/server/assistantRuntimeStore'
import { runtimeOwnerKey, runtimeRequestOwnerKey } from '@/lib/server/runtimeOwner'

const id = z.string().min(1).max(100).regex(/^[\w.:-]+$/)
const inputSchema = z.object({ id, text: z.string().trim().min(1).max(ASSISTANT_SAY_MAX), via: z.enum(['phone', 'screen']).optional(),
  conversationId: id.optional(), epoch: z.number().int().nonnegative().optional(),
  draftClientId: id.optional(), draftRevision: z.number().int().nonnegative().optional() }).strict()
const resetSchema = z.object({ operationId: id, kind: z.enum(['stop-turn', 'new-conversation', 'delete-memory', 'delete-history']),
  turnId: id.optional(), conversationId: id.optional(), epoch: z.number().int().nonnegative().optional() }).strict()

export const assistantRuntimeRoutes = new Hono<{ Variables: { assistantOwnerKey: string } }>()
  .use('/api/assistant/*', async (c, next) => {
    const origin = c.req.header('origin'); const host = c.req.header('host')
    if (origin !== undefined && !originIsLocal(origin) || host !== undefined && !hostIsLocal(host)) return c.json({ error: 'forbidden' }, 403)
    try { c.set('assistantOwnerKey', await runtimeRequestOwnerKey(c.req.header('X-OpenGround-Owner'))) }
    catch { return c.json({ error: 'forbidden' }, 403) }
    return next()
  })
  .onError((error, c) => error instanceof AssistantRuntimeConflict
    ? c.json({ error: error.reason }, 409)
    : c.json({ error: 'assistant-runtime-unavailable' }, 503))
  .get('/api/assistant/runtime', async c => {
    const owner = c.get('assistantOwnerKey')
    await runtimeOwnerKey(owner)
    const { readAssistantRuntime } = await import('@/lib/server/assistantRuntimeStore')
    const state = readAssistantRuntime()
    if (state.ownerKey && state.ownerKey !== owner) return c.json({ error: 'owner-changed' }, 409)
    return c.json(assistantRuntimeStatus())
  })
  .get('/api/assistant/inbox/:id', async c => {
    await runtimeOwnerKey(c.get('assistantOwnerKey'))
    const receipt = getAssistantTurnReceipt(c.req.param('id'), c.get('assistantOwnerKey'))
    return receipt ? c.json({ receipt }) : c.json({ error: 'not-found' }, 404)
  })
  .post('/api/assistant/inbox', async c => {
    const parsed = inputSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid-assistant-input' }, 400)
    const { id: clientId, text, ...deps } = parsed.data
    const receipt = publicAssistantTurnReceipt(await acceptAssistantInput(text, { ...deps, clientId, expectedOwnerKey: c.get('assistantOwnerKey') }))
    return c.json({ receipt }, receipt.state === 'completed' ? 200 : 202)
  })
  .post('/api/assistant/reset', async c => {
    const parsed = resetSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'invalid-assistant-reset' }, 400)
    return c.json(await resetAssistantRuntime({ ...parsed.data, expectedOwnerKey: c.get('assistantOwnerKey') }))
  })
