// /api/phone-link — pair / unpair the owner's iPhone with this Mac's president
// desks (src/lib/server/phoneLink.ts, docs/PHONE_LINK.md). Owner-only: the
// president is an owner seat, and the pairing code is a key.
import { Hono, type MiddlewareHandler } from 'hono'
import { pushKeySaved, hasPhoneLinkAccess, pairPhone, pairingCode, phoneLinkStatus, readPhoneLinkConfig, unpairPhone } from '@/lib/server/phoneLink'
import { savePushKey } from '@/lib/server/phonePush'
import {
  ASSISTANT_SAY_MAX,
  AssistantFailure,
  askAssistant,
  assistantBusy,
  plainAssistantError,
  readAssistantStyle,
  saveAssistantStyle,
} from '@/lib/server/phoneAssistant'
import {
  clearAssistantLog,
  clearAssistantMemory,
  deleteAssistantEntry,
  readAssistantConfig,
  readAssistantLog,
  readAssistantMemory,
  saveAssistantConfig,
} from '@/lib/server/assistantMemory'
import { getPromptLang } from '@/lib/server/promptLang'
import { isLockdownEnabledSync } from '@/lib/server/lockdown'
import { hostIsLocal, originIsLocal } from '../loopback'

// The pairing code is a WRITE credential (whoever holds it speaks as the owner),
// so even a GET here must not be readable by a DNS-rebinding page: the app-wide
// guard checks Host/Origin only on state-changing methods — this checks every one.
const ownerOnly: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header('origin')
  const host = c.req.header('host')
  if ((origin !== undefined && !originIsLocal(origin)) || (host !== undefined && !hostIsLocal(host))) {
    return c.json({ error: 'forbidden' }, 403)
  }
  return (await hasPhoneLinkAccess()) ? next() : c.json({ error: 'forbidden' }, 403)
}

const reply = (r: object) => ('error' in r ? Response.json(r, { status: 409 }) : Response.json(r))

export const phoneLinkRoutes = new Hono()
  .use('/api/phone-link', ownerOnly)
  .use('/api/phone-link/*', ownerOnly)
  .get('/api/phone-link', async (c) => c.json(await phoneLinkStatus()))
  // New keys: the previously paired phone stops working and its relay room is erased.
  .post('/api/phone-link/pair', async () => reply(await pairPhone()))
  // The current code again (to set up the same phone a second time). POST: it is a key.
  .post('/api/phone-link/code', async (c) => {
    const cfg = await readPhoneLinkConfig()
    return cfg ? c.json({ code: pairingCode(cfg) }) : c.json({ error: 'not paired' }, 404)
  })
  .post('/api/phone-link/unpair', async () => reply(await unpairPhone()))
  // How the assistant talks (phoneAssistant.ts) — the owner's free text, read
  // fresh on every turn. Empty = back to the default.
  .get('/api/phone-link/assistant-style', async (c) => c.json(await readAssistantStyle()))
  .post('/api/phone-link/assistant-style', async (c) => {
    const r = await saveAssistantStyle(((await c.req.json().catch(() => ({}))) as { style?: unknown }).style)
    return 'error' in r ? c.json(r, 400) : c.json(await readAssistantStyle())
  })
  // The assistant's records, kept on this Mac only (assistantMemory.ts): the
  // screen reads them here, the phone through the link (`assistant-history`).
  .get('/api/phone-link/assistant/log', async (c) =>
    c.json({ entries: await readAssistantLog(), memory: await readAssistantMemory(), ...(await readAssistantConfig()) }),
  )
  .delete('/api/phone-link/assistant/log', async (c) => (await clearAssistantLog(), c.json({ ok: true })))
  .delete('/api/phone-link/assistant/log/:id', async (c) =>
    (await deleteAssistantEntry(c.req.param('id'))) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404),
  )
  .delete('/api/phone-link/assistant/memory', async (c) => (await clearAssistantMemory(), c.json({ ok: true })))
  // How many days the log is kept, how long the memo may be.
  .post('/api/phone-link/assistant/config', async (c) => {
    const r = await saveAssistantConfig(await c.req.json().catch(() => ({})))
    return 'error' in r ? c.json(r, 400) : c.json(r)
  })
  // Talk to the assistant from the screen: the same assistant, the same log.
  .post('/api/phone-link/assistant/say', async (c) => {
    const text = ((await c.req.json().catch(() => ({}))) as { text?: unknown }).text
    const line = typeof text === 'string' ? text.trim() : ''
    if (!line) return c.json({ error: 'empty' }, 400)
    if (line.length > ASSISTANT_SAY_MAX) return c.json({ error: 'too-long', max: ASSISTANT_SAY_MAX }, 400)
    if (isLockdownEnabledSync()) return c.json({ error: 'work-mode' }, 409)
    if (assistantBusy()) return c.json({ error: 'busy' }, 429)
    try {
      return c.json(await askAssistant(line, { via: 'screen' }))
    } catch (e) {
      const f: AssistantFailure = plainAssistantError(e, await getPromptLang().catch(() => 'en' as const))
      return c.json({ error: f.reason, detail: f.message }, f.reason === 'busy' ? 429 : 502)
    }
  })
  // The owner's APNs key (Push to Talk), once. Stored 0600, never returned.
  .post('/api/phone-link/push-key', async (c) => {
    const r = await savePushKey(await c.req.json().catch(() => ({})))
    if ('error' in r) return c.json(r, 400)
    await pushKeySaved()
    return c.json(r)
  })
