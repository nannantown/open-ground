// /api/phone-link — pair / unpair the owner's iPhone with this Mac's president
// desks (src/lib/server/phoneLink.ts, docs/PHONE_LINK.md). Owner-only: the
// president is an owner seat, and the pairing code is a key.
import { Hono, type MiddlewareHandler } from 'hono'
import { streamSSE } from 'hono/streaming'
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
import { readFile } from 'fs/promises'
import {
  ASSISTANT_PHOTO_MAX_BYTES,
  ASSISTANT_PHOTO_TYPES,
  assistantPhotoPath,
  saveAssistantPhoto,
  sniffPhoto,
  assistantEntriesFor,
  clearAssistantLog,
  clearAssistantMemory,
  deleteAssistantEntry,
  readAssistantConfig,
  readAssistantLog,
  readAssistantMemory,
  saveAssistantConfig,
} from '@/lib/server/assistantMemory'
import { getPromptLang } from '@/lib/server/promptLang'
import { listenBinary, startListening } from '@/lib/server/assistantListen'
import { isLockdownEnabledSync } from '@/lib/server/lockdown'
import { projectUUIDFromPath } from '@/lib/server/projectDataPath'
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
    c.json({ entries: assistantEntriesFor(await readAssistantLog()), memory: await readAssistantMemory(), ...(await readAssistantConfig()), voice: listenBinary() !== null }),
  )
  // President call metadata is owned by this app, never injected into Claude's
  // transcript or prompts. The registry resolver validates the incoming path.
  .get('/api/phone-link/call-notes', async (c) => {
    const path = c.req.query('path')
    if (!path) return c.json({ error: 'path required' }, 400)
    let projectId: string
    try { projectId = await projectUUIDFromPath(path) }
    catch { return c.json({ error: 'forbidden' }, 403) }
    return c.json({ entries: assistantEntriesFor(await readAssistantLog(), projectId).filter((e) => e.kind === 'call') })
  })
  // Clear that president's call notes from the Mac — only that project's; the
  // assistant's talk and other projects' notes stay (f59b7a1f).
  .delete('/api/phone-link/call-notes', async (c) => {
    const path = c.req.query('path')
    if (!path) return c.json({ error: 'path required' }, 400)
    let projectId: string
    try { projectId = await projectUUIDFromPath(path) }
    catch { return c.json({ error: 'forbidden' }, 403) }
    await clearAssistantLog(projectId)
    return c.json({ ok: true })
  })
  .delete('/api/phone-link/assistant/log', async (c) => (await clearAssistantLog('assistant'), c.json({ ok: true })))
  .delete('/api/phone-link/assistant/log/:id', async (c) =>
    (await deleteAssistantEntry(c.req.param('id'), 'assistant')) ? c.json({ ok: true }) : c.json({ error: 'not found' }, 404),
  )
  // A photo the owner sent (only names assistantMemory made resolve).
  .get('/api/phone-link/assistant/photo/:name', async (c) => {
    const path = assistantPhotoPath(c.req.param('name'))
    const bytes = path ? await readFile(path).catch(() => null) : null
    const ext = bytes && sniffPhoto(bytes)
    if (!bytes || !ext) return c.json({ error: 'not found' }, 404)
    return c.body(bytes, 200, { 'content-type': ASSISTANT_PHOTO_TYPES[ext], 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff' })
  })
  .delete('/api/phone-link/assistant/memory', async (c) => (await clearAssistantMemory(), c.json({ ok: true })))
  // How many days the log is kept, how long the memo may be.
  .post('/api/phone-link/assistant/config', async (c) => {
    const r = await saveAssistantConfig(await c.req.json().catch(() => ({})))
    return 'error' in r ? c.json(r, 400) : c.json(r)
  })
  // Voice in (assistantListen.ts): what the owner says, as it is heard, while
  // the screen keeps this stream open. Closing it stops the listening.
  .get('/api/phone-link/assistant/listen', (c) => {
    // A GET a foreign page can fire with no Origin and a local Host (an <img>
    // pointed here) — and this one turns the mic on. The browser says where the
    // request came from: only this app's own pages (or no browser at all) may.
    const site = c.req.header('sec-fetch-site')
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return c.json({ error: 'forbidden' }, 403)
    if (isLockdownEnabledSync()) return c.json({ error: 'work-mode' }, 409)
    if (!listenBinary()) return c.json({ error: 'unavailable' }, 404)
    const lang = c.req.query('lang') === 'en' ? 'en' : 'ja'
    return streamSSE(c, async (stream) => {
      // The window may hang up while the owner check above is still waiting —
      // then the stream never sees an abort, and ears started now would stay
      // open with nobody listening. The request's own signal does know.
      const signal = c.req.raw.signal
      if (signal.aborted) return
      let stop = () => {}
      await new Promise<void>((done) => {
        stream.onAbort(done)
        signal.addEventListener('abort', () => done(), { once: true })
        // In order, and the stream ends only once the last (the reason) is out —
        // closing with a write still in flight drops it.
        let wrote = Promise.resolve()
        stop = startListening(lang, (e) => {
          wrote = wrote.then(() => stream.writeSSE({ data: JSON.stringify(e) })).catch(() => {})
          if (e.type === 'error') void wrote.then(done)
        })
      })
      stop()
    })
  })
  // Talk to the assistant from the screen: the same assistant, the same log.
  // A photo rides along as base64 (`photo`); its bytes decide its format.
  .post('/api/phone-link/assistant/say', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown; photo?: unknown }
    const line = typeof body.text === 'string' ? body.text.trim() : ''
    let bytes: Buffer | null = null
    if (body.photo !== undefined) {
      if (typeof body.photo !== 'string') return c.json({ error: 'photo-type' }, 415)
      // base64 is 4 chars per 3 bytes: refuse an oversized one before decoding it.
      if (body.photo.length > Math.ceil(ASSISTANT_PHOTO_MAX_BYTES / 3) * 4 + 4) return c.json({ error: 'photo-too-large', max: ASSISTANT_PHOTO_MAX_BYTES }, 413)
      bytes = Buffer.from(body.photo, 'base64')
      if (bytes.length > ASSISTANT_PHOTO_MAX_BYTES) return c.json({ error: 'photo-too-large', max: ASSISTANT_PHOTO_MAX_BYTES }, 413)
    }
    const ext = bytes ? sniffPhoto(bytes) : null
    if (bytes && !ext) return c.json({ error: 'photo-type' }, 415)
    if (!line && !bytes) return c.json({ error: 'empty' }, 400)
    if (line.length > ASSISTANT_SAY_MAX) return c.json({ error: 'too-long', max: ASSISTANT_SAY_MAX }, 400)
    if (isLockdownEnabledSync()) return c.json({ error: 'work-mode' }, 409)
    if (assistantBusy()) return c.json({ error: 'busy' }, 429)
    try {
      const photo = bytes && ext ? await saveAssistantPhoto(bytes, ext) : undefined
      return c.json(await askAssistant(line, { via: 'screen', ...(photo ? { photo } : {}) }))
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
