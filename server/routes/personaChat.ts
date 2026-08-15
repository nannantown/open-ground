// server/routes/personaChat.ts — Hono sub-router for the persona CONVERSATION
// (talking to the stand-in) and for importing a claude.ai export into it.
// Declares FULL /api/... paths (mount prefix in app.ts is empty). Handlers are
// THIN ADAPTERS over src/lib/server/personaChat.ts + personaImport.ts.
//
// ITS OWN ROUTER, deliberately not more surface on routes/persona.ts. Those
// routes score an instrument and read a store; these SPAWN `claude` and WRITE to
// the owner's corpus, which is a different risk class and takes a second gate:
//
//   1. blockNonLoopback — the DNS-rebinding half (the app-level CSRF guard only
//      covers mutations, and a rebinding page's GET is same-origin so the SOP
//      lets it READ). The thread here is the owner's own words about themselves;
//      this gate is a privacy boundary, not a formality.
//   2. the persona EXPERIMENT — owner-ANDed server-side. Every route below can
//      cost money on the owner's subscription, so it stays shut unless the
//      feature is actually open for this caller.
//
// SUBSCRIPTION-ONLY: the spawning routes preflight the owner's `claude` CLI and
// answer 503 when it is missing or signed out. There is no API-key path here and
// none may be added (claudeTerminal.ts "THE TWO RULES").

import { createHash } from 'crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { claudeRunPreflight } from '@/lib/server/claudePreflight'
import { isExperimentEnabled } from '@/lib/server/experiments'
import {
  cancelPersonaChatTurn,
  getPersonaChatState,
  getPersonaChatTurn,
  startPersonaChatTurn,
  PersonaChatBusyError,
} from '@/lib/server/personaChat'
import {
  getPersonaImportJob,
  startPersonaImport,
  PersonaImportAlreadyError,
  PersonaImportBusyError,
  PersonaImportShaError,
} from '@/lib/server/personaImport'
import { hostIsLocal, originIsLocal } from '../loopback'
import { PERSONA_EXPERIMENTS } from '@/lib/persona/gate'
import {
  MAX_EXPORT_UPLOAD_BYTES,
  readClaudeExportBytes,
} from '@/lib/server/claudeExportFile'
import type {
  PersonaChatCancelResponse,
  PersonaChatStartResponse,
  PersonaChatStateResponse,
  PersonaChatTurnResponse,
  PersonaImportJobResponse,
  PersonaImportStartResponse,
} from '@/lib/types'

// Same gate, same reasoning as server/routes/youCorpus.ts and
// server/routes/persona.ts. A browser always sends Host; local non-browser
// clients (curl, the vitest app.request) send none → allowed.
const blockNonLoopback = (c: Context): Response | null => {
  const host = c.req.header('host')
  if (host !== undefined && !hostIsLocal(host)) {
    return c.json({ error: 'invalid host' }, 403)
  }
  const origin = c.req.header('origin')
  if (origin !== undefined && !originIsLocal(origin)) {
    return c.json({ error: 'cross-origin request rejected' }, 403)
  }
  return null
}

/** Both gates, in cost order (the cheap header check first). Returns a Response
 *  to short-circuit, or null to pass. */
const gate = async (c: Context): Promise<Response | null> => {
  const blocked = blockNonLoopback(c)
  if (blocked) return blocked
  // ⚠ THE SAME PREDICATE THE SCREEN USES, not a narrower one.
  //
  // This checked only `persona` while the surface mounts on
  // `isPersonaOpen` = persona OR swarm (src/lib/persona/gate.ts). A swarm-only
  // owner — which is most of them, since swarm is the flag that has ever been
  // handed out — therefore got the whole Persona screen with a conversation
  // that answered 403 forever. Not a locked door they could understand: a
  // visible feature that silently never works.
  //
  // Derived from PERSONA_EXPERIMENTS rather than re-listed, so the two can
  // never drift again.
  const open = await Promise.all(PERSONA_EXPERIMENTS.map((id) => isExperimentEnabled(id)))
  if (!open.some(Boolean)) {
    return c.json({ error: 'not found' }, 403)
  }
  return null
}

export const personaChatRoutes = new Hono()
  // --- GET /api/persona/chat -------------------------------------------------
  // The thread so far + whether a turn is in flight, so re-opening the panel
  // does not lose the conversation. A FAILED read here must never be rendered as
  // an empty thread — that is the client's rule, and it is why this route has no
  // "return [] on error" branch: an unexpected throw is a 500 the screen can
  // tell apart from `{ turns: [] }`.
  .get('/api/persona/chat', async (c) =>
    (await gate(c)) ?? c.json<PersonaChatStateResponse>(getPersonaChatState()),
  )
  // --- POST /api/persona/chat ------------------------------------------------
  // Start ONE turn. 202 + the turn id; the run is a job, not this connection.
  //   503 — the CLI is missing / signed out (before anything spawns)
  //   409 — a turn is already running (ONE live conversation, period)
  .post('/api/persona/chat', async (c) => {
    const blocked = await gate(c)
    if (blocked) return blocked
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown }
    const text = typeof body.text === 'string' ? body.text : ''
    if (!text.trim()) return c.json({ error: 'text is required' }, 400)
    // BEFORE the spawn, always: a missing or signed-out CLI must be a plain 503
    // the screen can explain, not a PTY that dies with a shell error in it.
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    try {
      const turnId = startPersonaChatTurn({ text })
      return c.json<PersonaChatStartResponse>({ turnId }, 202)
    } catch (e) {
      if (e instanceof PersonaChatBusyError) return c.json({ error: e.message, busy: true }, 409)
      throw e
    }
  })
  // --- GET /api/persona/chat/turn/:id ----------------------------------------
  // Polled at ~500ms. 404 for an id this server does not hold (a restart drops
  // the thread) — distinct from a turn that ran and failed, which is a 200 with
  // `state: 'failed'` and the owner's words still on screen beside it.
  .get('/api/persona/chat/turn/:id', async (c) => {
    const blocked = await gate(c)
    if (blocked) return blocked
    const turn = getPersonaChatTurn(c.req.param('id'))
    if (!turn) return c.json({ error: 'not found' }, 404)
    return c.json<PersonaChatTurnResponse>(turn)
  })
  // --- POST /api/persona/chat/cancel -----------------------------------------
  // The ONLY thing that stops a run — a dropped HTTP connection does not.
  .post('/api/persona/chat/cancel', async (c) => {
    const blocked = await gate(c)
    if (blocked) return blocked
    const body = (await c.req.json().catch(() => ({}))) as { turnId?: unknown }
    const turnId = typeof body.turnId === 'string' ? body.turnId : ''
    if (!turnId) return c.json({ error: 'turnId is required' }, 400)
    return c.json<PersonaChatCancelResponse>({ cancelled: cancelPersonaChatTurn(turnId) })
  })
  // --- POST /api/persona/import ----------------------------------------------
  // A parsed claude.ai `conversations.json` + the sha of the file's bytes.
  //   400 — not an export at all (a partial count over an unparsed file is the
  //         exact failure mode, so nothing is reported), or a malformed sha
  //   409 — this exact file already landed / an import is already running
  //   503 — the CLI is missing or signed out
  .post('/api/persona/import', async (c) => {
    const blocked = await gate(c)
    if (blocked) return blocked
    const body = (await c.req.json().catch(() => ({}))) as {
      json?: unknown
      fileSha?: unknown
    }
    const fileSha = typeof body.fileSha === 'string' ? body.fileSha : ''
    if (body.json === undefined) return c.json({ error: 'json is required' }, 400)
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    try {
      const importId = await startPersonaImport({ json: body.json, fileSha })
      return c.json<PersonaImportStartResponse>({ importId }, 202)
    } catch (e) {
      if (e instanceof PersonaImportAlreadyError) {
        return c.json({ error: e.message, alreadyImported: true, at: e.at }, 409)
      }
      if (e instanceof PersonaImportBusyError) return c.json({ error: e.message, busy: true }, 409)
      if (e instanceof PersonaImportShaError) return c.json({ error: e.message }, 400)
      // parseClaudeExport's own throw: the file is not an export.
      return c.json(
        { error: e instanceof Error ? e.message : 'unreadable file', unreadableFile: true },
        400,
      )
    }
  })
  // --- POST /api/persona/import/file ------------------------------------------
  // The file's RAW BYTES — the export zip exactly as claude.ai hands it over, or
  // a conversations.json someone already pulled out of one. Content-sniffed, so
  // the owner is never asked which of the two they have.
  //
  // ⚠ THIS EXISTS BECAUSE THE JSON ROUTE ABOVE CANNOT TAKE A REAL EXPORT
  // (measured 2026-08-15 against the owner's own): 23 MB zipped, 98 MB raw. On
  // that path the browser had to unzip nothing (zips were refused outright),
  // hold five copies of a 98 MB string on the thread that draws the screen, and
  // then re-serialise the parsed object into a request body. The bytes route
  // does none of it — the client uploads and stops, and Node does the work.
  //
  // The digest is computed HERE, over the bytes as received, which is also the
  // stronger contract: the "already imported" check now keys on what actually
  // arrived rather than on a number the client says it computed.
  //   400 — empty, not a zip we can read, not JSON, or not an export
  //   409 — this exact file already landed / an import is already running
  //   413 — larger than MAX_EXPORT_UPLOAD_BYTES
  //   503 — the CLI is missing or signed out
  .post('/api/persona/import/file', async (c) => {
    const blocked = await gate(c)
    if (blocked) return blocked
    let bytes: Buffer
    try {
      bytes = Buffer.from(await c.req.arrayBuffer())
    } catch {
      return c.json({ error: 'could not read the upload', unreadableFile: true }, 400)
    }
    if (bytes.length > MAX_EXPORT_UPLOAD_BYTES) {
      return c.json({ error: 'the file is larger than this can take in', tooLarge: true }, 413)
    }
    let json: unknown
    try {
      json = readClaudeExportBytes(bytes)
    } catch (e) {
      return c.json(
        {
          error: e instanceof Error ? e.message : 'unreadable file',
          unreadableFile: true,
        },
        400,
      )
    }
    const fileSha = createHash('sha256').update(bytes).digest('hex')
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    try {
      const importId = await startPersonaImport({ json, fileSha })
      return c.json<PersonaImportStartResponse>({ importId }, 202)
    } catch (e) {
      if (e instanceof PersonaImportAlreadyError) {
        return c.json({ error: e.message, alreadyImported: true, at: e.at }, 409)
      }
      if (e instanceof PersonaImportBusyError) return c.json({ error: e.message, busy: true }, 409)
      if (e instanceof PersonaImportShaError) return c.json({ error: e.message }, 400)
      return c.json(
        { error: e instanceof Error ? e.message : 'unreadable file', unreadableFile: true },
        400,
      )
    }
  })
  // --- GET /api/persona/import/:id -------------------------------------------
  // `counts` appears as soon as PARSING landed — before the distillation
  // finishes — so the screen shows what arrived while it is still reading.
  .get('/api/persona/import/:id', async (c) => {
    const blocked = await gate(c)
    if (blocked) return blocked
    const job = getPersonaImportJob(c.req.param('id'))
    if (!job) return c.json({ error: 'not found' }, 404)
    return c.json<PersonaImportJobResponse>(job)
  })
