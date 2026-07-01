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
  getCorpusStatus,
} from '@/lib/server/youCorpus'
import { hostIsLocal, originIsLocal } from '../loopback'
import type { YouCorpusAppendResponse } from '@/lib/types'

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
  // --- POST /api/you-corpus/rebuild -----------------------------------------
  // Re-assemble from the mechanical sources (auto-memory + CONCEPT.md +
  // business_model_vision) plus the hand-added judgments. The "导线" (pipeline).
  .post('/api/you-corpus/rebuild', async (c) => c.json(await assembleYouCorpus()))
  // --- POST /api/you-corpus/append ------------------------------------------
  // Add a NEW judgment, then re-assemble. The "new decision" command/UI seam.
  .post('/api/you-corpus/append', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: unknown
      tags?: unknown
      context?: unknown
    }
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return c.json({ error: 'text required' }, 400)
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === 'string')
      : undefined
    const context = typeof body.context === 'string' ? body.context : undefined
    const result = await appendJudgment({ text, tags, context })
    return c.json<YouCorpusAppendResponse>(result)
  })
