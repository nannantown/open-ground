// server/routes/persona.ts — Hono sub-router for the Persona tab's COURSES
// (the self-report instruments). Declares FULL /api/... paths (mount prefix in
// app.ts is empty). Handlers are THIN ADAPTERS over
// src/lib/server/personaCourses.ts; the instrument and its scoring live in the
// pure src/lib/persona/instruments.ts and are never reimplemented here.
//
// Local, personal, single-user state — a result sheet and the corpus nodes it
// mints are as private as the judgments beside them. The cross-origin/CSRF guard
// in server/app.ts already covers the mutating route; the loopback gate below is
// the DNS-rebinding half, mirroring server/routes/youCorpus.ts.

import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  getPersonaCourseHistory,
  getPersonaPortrait,
  listPersonaCourses,
  submitPersonaCourse,
  UnknownPersonaCourseError,
} from '@/lib/server/personaCourses'
import { getPersonaLedger } from '@/lib/server/personaLedger'
import { PersonaScoringError } from '@/lib/persona/instruments'
import { hostIsLocal, originIsLocal } from '../loopback'
import type {
  PersonaCourseHistoryResponse,
  PersonaCoursesResponse,
  PersonaLedgerResponse,
  PersonaPortrait,
  SubmitPersonaCourseResponse,
} from '@/lib/types'

// Same gate, same reasoning as server/routes/youCorpus.ts: a page that rebinds
// its domain to 127.0.0.1 makes a SAME-ORIGIN request, which the SOP lets it
// READ — so a sensitive GET needs its own check even though the app-level CSRF
// guard covers mutations. A browser always sends Host; local non-browser clients
// (curl, the vitest app.request) send none → allowed. Returns a 403 Response to
// short-circuit, or null to pass.
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

export const personaRoutes = new Hono()
  // --- GET /api/persona/courses ---------------------------------------------
  // The catalogue + what the owner has already scored (lastTakenAt / headline,
  // null when never taken). Never fails on a corrupt store — see
  // readPersonaCoursesStore's fail-open note.
  .get('/api/persona/courses', async (c) =>
    blockNonLoopback(c) ?? c.json<PersonaCoursesResponse>(await listPersonaCourses()),
  )
  // --- GET /api/persona/courses/:id/history ----------------------------------
  // Every stored take of one course, NEWEST FIRST (the current result is the
  // first entry, the displaced ones follow newest → oldest). 404 for an id no
  // instrument answers to; a course that exists but was never taken is a 200
  // with `takes: []` — "you have not taken this", not "no such thing".
  .get('/api/persona/courses/:id/history', async (c) => {
    const blocked = blockNonLoopback(c)
    if (blocked) return blocked
    try {
      const res = await getPersonaCourseHistory(c.req.param('id'))
      return c.json<PersonaCourseHistoryResponse>(res)
    } catch (e) {
      if (e instanceof UnknownPersonaCourseError) return c.json({ error: 'not found' }, 404)
      throw e
    }
  })
  // --- GET /api/persona/portrait ---------------------------------------------
  // The composed digest + the counts shown beside it. Every line comes from
  // composePortrait (the pure composer) — this route adds no sentence of its
  // own, and an EMPTY `lines` is the correct answer when nothing is evidenced
  // yet. Never fails on an unreadable store or corpus, same reasoning as the
  // catalogue above: a glance must not 500 the screen.
  .get('/api/persona/portrait', async (c) =>
    blockNonLoopback(c) ?? c.json<PersonaPortrait>(await getPersonaPortrait()),
  )
  // --- GET /api/persona/ledger -----------------------------------------------
  // The DECISION LEDGER: what the owner's stand-in actually DID (answered on their
  // behalf / asked them / abstained), as counts + the newest entries.
  //
  // ⚠ LOOPBACK-ONLY, and the gate matters MORE here than on its siblings: `recent`
  // carries free text from the owner's own local work (the questions their swarm
  // was blocked on). The gate above is the DNS-rebinding half; nothing on this
  // route may ever be relaxed to a non-loopback caller — see personaLedger.ts's
  // privacy note.
  //
  // Never fails on an unreadable or corrupt ledger — readLedger fails open, so the
  // worst case is zeros and an empty list, which is what a fresh machine shows.
  .get('/api/persona/ledger', async (c) =>
    blockNonLoopback(c) ?? c.json<PersonaLedgerResponse>(await getPersonaLedger()),
  )
  // --- POST /api/persona/courses/:id/submit ---------------------------------
  // Score → persist → mint. 404 for an id no instrument answers to, 400 with the
  // scoring error's own message for an answer vector that does not match the
  // instrument (wrong length / out of range) — both BEFORE anything is written,
  // so a half-answered course neither stores a sheet nor mints corpus nodes.
  .post('/api/persona/courses/:id/submit', async (c) => {
    const blocked = blockNonLoopback(c)
    if (blocked) return blocked
    const body = (await c.req.json().catch(() => ({}))) as { answers?: unknown }
    if (!Array.isArray(body.answers)) {
      return c.json({ error: 'answers must be an array of numbers' }, 400)
    }
    // Element types are NOT filtered here: scoreCourse checks every entry with
    // Number.isInteger and reports which one is wrong. Coercing or dropping bad
    // entries first would turn "you sent a string" into a silently shifted
    // answer vector — the one thing a scored instrument must never do.
    const answers = body.answers as number[]
    try {
      const res = await submitPersonaCourse(c.req.param('id'), answers)
      return c.json<SubmitPersonaCourseResponse>(res)
    } catch (e) {
      if (e instanceof UnknownPersonaCourseError) return c.json({ error: 'not found' }, 404)
      if (e instanceof PersonaScoringError) return c.json({ error: e.message }, 400)
      throw e
    }
  })
