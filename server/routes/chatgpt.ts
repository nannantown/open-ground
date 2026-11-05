import { Hono, type MiddlewareHandler } from 'hono'
import { hasChatGptAccess } from '@/lib/server/chatgptAccess'
import { getSettings, setChatGptPreferences } from '@/lib/server/store'
import { beginChatGptLogin, cancelChatGptLogin, disconnectChatGpt, getChatGptConnection } from '@/lib/server/chatgptAuth'
import type { ChatGptStatus, Settings } from '@/lib/types'
import { hostIsLocal, originIsLocal } from '../loopback'

const ownerOnly: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')
  const host = c.req.header('host')
  if ((origin !== undefined && !originIsLocal(origin)) || (host !== undefined && !hostIsLocal(host))) return c.json({ error: 'forbidden' }, 403)
  return (await hasChatGptAccess()) ? next() : c.json({ error: 'forbidden' }, 403)
}

const preferences = async (): Promise<ChatGptStatus['preferences']> => {
  const s = await getSettings()
  return { assistantProvider: s.assistantProvider, swarmProvider: s.swarmProvider, chatgptModel: s.chatgptModel, chatgptEffort: s.chatgptEffort }
}
let activeLoginId: string | undefined

export const chatgptRoutes = new Hono()
  .use('/api/chatgpt/*', ownerOnly)
  .get('/api/chatgpt/status', async (c) => {
    const lockdown = (await getSettings()).lockdownMode === true
    // Work mode must not refresh credentials or request the model catalog.
    const connection = lockdown ? { state: 'error' as const, models: [], error: 'work-mode' } : await getChatGptConnection()
    return c.json<ChatGptStatus>({ connection, lockdown, preferences: await preferences() })
  })
  .post('/api/chatgpt/login', async (c) => {
    if ((await getSettings()).lockdownMode === true) return c.json({ error: 'work-mode' }, 403)
    try { const login = await beginChatGptLogin(); activeLoginId = login.loginId; return c.json(login) }
    catch { return c.json({ error: 'Could not start ChatGPT sign-in.' }, 503) }
  })
  .post('/api/chatgpt/cancel', async (c) => {
    const body = await c.req.json().catch(() => null) as { loginId?: unknown } | null
    if (body?.loginId !== undefined && (typeof body.loginId !== 'string' || body.loginId.length > 128)) return c.json({ error: 'invalid login' }, 400)
    const id = typeof body?.loginId === 'string' ? body.loginId : activeLoginId
    if (id) await cancelChatGptLogin(id)
    activeLoginId = undefined
    return c.json({ ok: true })
  })
  .post('/api/chatgpt/disconnect', async (c) => {
    await disconnectChatGpt()
    activeLoginId = undefined
    return c.json({ ok: true })
  })
  .post('/api/chatgpt/preferences', async (c) => {
    const raw = await c.req.json().catch(() => null)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return c.json({ error: 'invalid preferences' }, 400)
    const patch = Object.fromEntries(['assistantProvider', 'swarmProvider', 'chatgptModel', 'chatgptEffort']
      .filter((key) => Object.prototype.hasOwnProperty.call(raw, key))
      .map((key) => [key, (raw as Record<string, unknown>)[key]]))
    const applied = await setChatGptPreferences(patch)
    if (Object.keys(patch).some((key) => !applied.includes(key as keyof Settings))) return c.json({ error: 'preferences refused', preferences: await preferences() }, 400)
    return c.json({ preferences: await preferences() })
  })
