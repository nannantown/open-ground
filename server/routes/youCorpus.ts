// server/routes/youCorpus.ts — Hono sub-router for the proxy judgment corpus
// ("あなたの判断軸"). Declares FULL /api/... paths (mount prefix in app.ts is
// empty). Handlers are THIN ADAPTERS over src/lib/server/youCorpus.ts.
//
// This is local, personal, single-user state (the corpus lives under
// ~/.openground, never git-shared). The cross-origin/CSRF guard in server/app.ts
// already protects the mutating routes; there is no extra auth gate (mirrors
// /api/settings — purely local machine state).

import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  assembleYouCorpus,
  appendJudgment,
  readYouCorpus,
  readManualJudgments,
  liveJudgments,
  retiredJudgments,
  retireJudgment,
  restoreJudgment,
  getCorpusStatus,
} from '@/lib/server/youCorpus'
import { answerTellApart, nextTellApart, skipTellApart } from '@/lib/server/personaTellApart'
import {
  answerTodayQuestion,
  ensureTodayQuestion,
  nextQuestion,
  peekTodayQuestion,
  skipTodayQuestion,
} from '@/lib/server/personaInterview'
import { hostIsLocal, originIsLocal } from '../loopback'
import type {
  PersonaInterviewResponse,
  PersonaTellApartAnswerResponse,
  PersonaTellApartResponse,
  YouCorpusAppendResponse,
  YouCorpusJudgmentsResponse,
} from '@/lib/types'

// The corpus is the user's PERSONAL behavioural clone — reading it must not be
// exposed to a remote page. The app-level CSRF guard only covers mutating
// methods, so a sensitive GET would otherwise be reachable via DNS rebinding (a
// page that rebinds its domain to 127.0.0.1 makes a SAME-ORIGIN GET, which the
// SOP allows it to read). A browser always sends a Host header, so we reject any
// GET whose Host (or Origin, when present) is not loopback. Local non-browser
// clients (curl, the vitest app.request) send no Host → allowed, exactly like
// the app-level guard. Returns a 403 Response to short-circuit, or null to pass.
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

export const youCorpusRoutes = new Hono()
  // --- GET /api/you-corpus --------------------------------------------------
  // Status of the assembled corpus + which sources are available right now.
  // Loopback-gated: the status leaks the home path + memory dir + counts.
  .get('/api/you-corpus', async (c) => blockNonLoopback(c) ?? c.json(await getCorpusStatus()))
  // --- GET /api/you-corpus/raw ----------------------------------------------
  // The injectable markdown itself (assembled on demand if missing). This is the
  // text a proxy launcher would prepend as context at startup. Loopback-gated —
  // this returns the WHOLE personal corpus (see blockNonLoopback).
  .get('/api/you-corpus/raw', async (c) => {
    const blocked = blockNonLoopback(c)
    if (blocked) return blocked
    const text = await readYouCorpus()
    return c.body(text, 200, { 'Content-Type': 'text/markdown; charset=utf-8' })
  })
  // --- GET /api/you-corpus/judgments ----------------------------------------
  // The hand-added judgments as STRUCTURED records, NEWEST FIRST (the same
  // order the assembled corpus renders them in, so the UI and the proxy agree
  // on which call is freshest). Loopback-gated for the same reason as /raw —
  // these ARE the personal corpus, just not yet rendered to markdown.
  .get('/api/you-corpus/judgments', async (c) => {
    const blocked = blockNonLoopback(c)
    if (blocked) return blocked
    // LIVE only: what is drawn on the figure and counted as 「わかっていること」
    // has to be what the stand-in actually reads, or the number on the stage
    // describes a corpus nobody uses. Superseded lines are never deleted —
    // GET /api/you-corpus/raw still serves the whole file.
    //
    // ⚠ ONE READ FOR BOTH HALVES. `retired` is derived from the SAME array as
    // `judgments`, so the two cannot disagree about a line's state — two reads
    // could land either side of a write and return a line as both live and
    // taken back.
    const all = await readManualJudgments()
    const judgments = liveJudgments(all)
    return c.json<YouCorpusJudgmentsResponse>({
      judgments: [...judgments].reverse(),
      // Newest first, like the live list — 「取り消したもの」 is read the same way.
      retired: [...retiredJudgments(all)].reverse(),
    })
  })
  // --- POST /api/you-corpus/rebuild -----------------------------------------
  // Re-assemble from the mechanical sources (auto-memory + CONCEPT.md +
  // business_model_vision) plus the hand-added judgments. Source resolution is
  // cwd-independent (registry-aware — the packaged app's server cwd is not the
  // repo), and an assembly that resolves NO mechanical source refuses to
  // overwrite an existing corpus (meta.skipped + meta.warning; see youCorpus.ts).
  .post('/api/you-corpus/rebuild', async (c) => c.json(await assembleYouCorpus()))
  // --- POST /api/you-corpus/append ------------------------------------------
  // Add a NEW judgment, then re-assemble. The "new decision" command/UI seam.
  .post('/api/you-corpus/append', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: unknown
      tags?: unknown
      context?: unknown
      correctsId?: unknown
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'text required' }, 400)
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === 'string')
      : undefined
    const context = typeof body.context === 'string' ? body.context : undefined
    const correctsId = typeof body.correctsId === 'string' ? body.correctsId : undefined
    const result = await appendJudgment({ text, tags, context, correctsId })
    return c.json<YouCorpusAppendResponse>(result)
  })
  // --- POST /api/you-corpus/retire ------------------------------------------
  // 「取り消す」. Appends a tombstone; deletes nothing (see retireJudgment).
  //
  // ⚠ ITS OWN ROUTE, NOT A FLAG ON /append. Adding a note and withdrawing one
  // are different acts with different blast radii, and a single endpoint that
  // could do both would mean any path able to write a note could also make
  // lines disappear.
  .post('/api/you-corpus/retire', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) return c.json({ error: 'id required' }, 400)
    try {
      return c.json<YouCorpusAppendResponse>(await retireJudgment(id))
    } catch {
      // The only expected failure is "no such judgment" — a 404 rather than a
      // 500, because the client asking is a stale list, not a broken server.
      return c.json({ error: 'no such judgment' }, 404)
    }
  })
  // --- POST /api/you-corpus/restore -----------------------------------------
  // 「戻す」. The opposite marker, so taking something back is not a one-way door.
  .post('/api/you-corpus/restore', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown }
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!id) return c.json({ error: 'id required' }, 400)
    try {
      return c.json<YouCorpusAppendResponse>(await restoreJudgment(id))
    } catch {
      return c.json({ error: 'no such judgment' }, 404)
    }
  })
  // --- POST /api/you-corpus/tell-apart --------------------------------------
  // 「どれが自分ではないか」 — two of his own lines and one written to be true of
  // anybody (src/lib/persona/tellApart.ts). A POST because it can WRITE: the
  // three options are frozen on disk the moment they are drawn, so a reload
  // re-reads the same question instead of dealing a new hand.
  .post('/api/you-corpus/tell-apart', async (c) => {
    const blocked = blockNonLoopback(c)
    if (blocked) return blocked
    return c.json<PersonaTellApartResponse>({ check: await nextTellApart() })
  })
  // --- POST /api/you-corpus/tell-apart/answer -------------------------------
  // ⚠ THE ANSWER IS CHECKED HERE, never in the browser — the page that asks
  // 「どれが自分ではないか」 must not be carrying the answer to it.
  .post('/api/you-corpus/tell-apart/answer', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; optionId?: unknown }
    const id = typeof body.id === 'string' ? body.id : ''
    const optionId = typeof body.optionId === 'string' ? body.optionId : ''
    if (!id || !optionId) return c.json({ error: 'id and optionId required' }, 400)
    const result = await answerTellApart(id, optionId)
    // Null ⇒ a stale tab answering a check that is already gone. 409, not 500:
    // nothing is wrong, the question simply moved on.
    if (!result) return c.json({ error: 'no such check' }, 409)
    return c.json<PersonaTellApartAnswerResponse>(result)
  })
  // --- POST /api/you-corpus/tell-apart/skip ---------------------------------
  .post('/api/you-corpus/tell-apart/skip', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown }
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return c.json({ error: 'id required' }, 400)
    return c.json({ skipped: await skipTellApart(id) })
  })
  // --- GET /api/you-corpus/interview ----------------------------------------
  // READ-ONLY view of today's question. Never generates — a GET that mutates is
  // exactly the shape that made the swarm drain-tick spawn workers off a read.
  // Loopback-gated: the question quotes the owner's own card titles.
  .get('/api/you-corpus/interview', async (c) => {
    const blocked = blockNonLoopback(c)
    if (blocked) return blocked
    const { question, generated } = await peekTodayQuestion()
    return c.json<PersonaInterviewResponse>({
      question,
      // 'no-material' is a claim about the owner's records, so it is only made
      // for a day that was actually swept.
      ...(question ? {} : { reason: generated ? ('no-material' as const) : ('not-generated' as const) }),
    })
  })
  // --- POST /api/you-corpus/interview ---------------------------------------
  // ENSURE-AND-RETURN today's question: generates on the first call of a local
  // day, then returns that same record (status and all) for the rest of it.
  // This is the mutating twin of the GET above, and the call the tab makes on
  // mount — the once-a-day sweep happens here, never on a read.
  .post('/api/you-corpus/interview', async (c) => {
    // Same gate as the GET twin: this returns the identical payload — a question
    // quoting the owner's own card titles — so leaving it off made the weaker
    // door the one worth knocking on. (The CSRF guard in app.ts already covers
    // this route; defence that depends on a second layer staying in place is
    // exactly what an audit is supposed to flag.)
    const blocked = blockNonLoopback(c)
    if (blocked) return blocked
    const question = await ensureTodayQuestion()
    return c.json<PersonaInterviewResponse>({
      question,
      ...(question ? {} : { reason: 'no-material' as const }),
    })
  })
  // --- POST /api/you-corpus/interview/next ----------------------------------
  // ANOTHER ONE, ON DEMAND. The daily path above offers a question without being
  // asked; this is the owner asking. Same gate and same honesty rule: a null
  // question here means the sweep SUCCEEDED and found nothing left, because an
  // incomplete sweep throws through to onError (500) rather than reporting an
  // emptiness nobody verified.
  .post('/api/you-corpus/interview/next', async (c) => {
    const blocked = blockNonLoopback(c)
    if (blocked) return blocked
    const question = await nextQuestion()
    return c.json<PersonaInterviewResponse>({
      question,
      ...(question ? {} : { reason: 'no-material' as const }),
    })
  })
  // --- POST /api/you-corpus/interview/answer --------------------------------
  // The owner answers. The ANSWER lands in the corpus (Q + A + date) — this
  // route reports the question's new status, not the corpus write. A corpus
  // failure throws through to app.onError (500) so the UI can offer a retry
  // rather than showing the question as answered with the words lost.
  .post('/api/you-corpus/interview/answer', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown; answer?: unknown }
    const id = typeof body.id === 'string' ? body.id : ''
    const answer = typeof body.answer === 'string' ? body.answer.trim() : ''
    if (!id) return c.json({ error: 'id required' }, 400)
    if (!answer) return c.json({ error: 'answer required' }, 400)
    try {
      const { question, corpusStale } = await answerTodayQuestion(id, answer)
      return c.json<PersonaInterviewResponse>({
        question,
        ...(corpusStale ? { corpusStale: true } : {}),
      })
    } catch (e) {
      if ((e as Error).message === 'question not found') return c.json({ error: 'not found' }, 404)
      throw e
    }
  })
  // --- POST /api/you-corpus/interview/skip ----------------------------------
  // The owner passes. Nothing is written to the corpus, but the observation is
  // already recorded as asked, so this exact question never comes back.
  .post('/api/you-corpus/interview/skip', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { id?: unknown }
    const id = typeof body.id === 'string' ? body.id : ''
    if (!id) return c.json({ error: 'id required' }, 400)
    try {
      return c.json<PersonaInterviewResponse>({ question: await skipTodayQuestion(id) })
    } catch (e) {
      if ((e as Error).message === 'question not found') return c.json({ error: 'not found' }, 404)
      throw e
    }
  })
