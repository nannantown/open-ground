// server/routes/canvasAi.ts — Hono sub-router for the Canvas AI endpoints.
// Declares FULL /api/... paths (app.ts mounts with app.route('/', canvasAiRoutes)).
// Handlers are THIN ADAPTERS over src/lib/server/canvasAi.ts — no business
// logic lives here.
//
// Canvas AI runs are SERVER-SIDE JOBS (see src/lib/server/canvasAi.ts top
// comment + types.ts CanvasAiJob*): a run is a whole claude PTY session
// (30s–3min) that MUST survive the client navigating away (tab / project /
// Ground switch unmounts the canvas). So the two POSTs return { jobId }
// immediately and the run keeps going even if the request connection drops —
// only an explicit cancel kills it. The result is persisted to the target
// canvas server-side on completion (canvasData.ts).
//
// Routes (contracts in src/lib/types.ts):
//   POST canvas/ai/generate        { path, canvasId, prompt }       → { jobId }
//   POST canvas/ai/tweak           { path, canvasId, elementId,
//                                    source, framework,
//                                    instruction, element }         → { jobId }
//   GET  canvas/ai/active                                           → { jobs }
//   GET  canvas/ai/job/:id                                          → CanvasAiJobState
//   POST canvas/ai/job/:id/cancel                                   → { ok }
//
// Each POST pre-flights the shared run gate (claudeRunPreflight) BEFORE creating
// a job and answers 503 with claudeMissing (CLI absent) | claudeLoggedOut
// (installed but signed out) — same shape as before, so the UI's "sign in to
// Claude" CTA is unchanged. We require installed && loggedIn: a signed-out
// claude opens its own OAuth browser, and sign-in goes through
// /api/terminal/claude-login.

import { Hono } from 'hono'
import { requireProjectPath } from '../middleware/projectPath'
import { claudeRunPreflight } from '@/lib/server/claudePreflight'
import {
  cancelCanvasAiJob,
  getCanvasAiJobState,
  listActiveCanvasAiJobs,
  startGenerateJob,
  startTweakJob,
} from '@/lib/server/canvasAi'
import type { TweakScreenRequest } from '@/lib/types'

// Size caps — these bodies feed a prompt file verbatim, so reject absurd
// payloads up front instead of burning a claude session on them.
const MAX_PROMPT_LEN = 4_000
const MAX_INSTRUCTION_LEN = 2_000
const MAX_SOURCE_LEN = 256_000
// The picked-element snippet is already truncated client-side; these are
// defensive prompt-budget caps, not validation errors.
const MAX_ELEMENT_HTML = 4_000
const MAX_ELEMENT_TEXT = 1_000
// Ids are uuids; cap defensively so a junk body can't bloat the registry key.
const MAX_ID_LEN = 200

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : ''

export const canvasAiRoutes = new Hono()
  // ── POST /api/canvas/ai/generate ──────────────────────────────────────────
  // Start a job: claude authors native canvas elements (validated, ids
  // reassigned server-side) and they're appended to the canvas at a
  // non-overlapping position on completion. Returns { jobId } immediately.
  .post('/api/canvas/ai/generate', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    let body: { canvasId?: unknown; prompt?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const canvasId = str(body.canvasId, MAX_ID_LEN)
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!canvasId) return c.json({ error: 'canvasId is required' }, 400)
    if (!prompt) return c.json({ error: 'prompt is required' }, 400)
    if (prompt.length > MAX_PROMPT_LEN) return c.json({ error: 'prompt too long' }, 400)
    // Pre-flight BEFORE creating a job, so a missing / signed-out CLI surfaces
    // the same 503 CTA the client already handles (no orphan job is created).
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    const jobId = startGenerateJob({ projectPath: path, canvasId, prompt })
    return c.json({ jobId })
  })
  // ── POST /api/canvas/ai/tweak ─────────────────────────────────────────────
  // Start a job: claude rewrites one screen/mock's source per the element-scoped
  // instruction; the rewritten source is written onto `elementId` in `canvasId`
  // on completion. Returns { jobId } immediately.
  .post('/api/canvas/ai/tweak', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    let body: Partial<{
      canvasId: string
      elementId: string
      source: string
      framework: string
      instruction: string
      element: { tag?: unknown; classes?: unknown; text?: unknown; html?: unknown }
    }>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const canvasId = str(body.canvasId, MAX_ID_LEN)
    const elementId = str(body.elementId, MAX_ID_LEN)
    const source = typeof body.source === 'string' ? body.source : ''
    const instruction =
      typeof body.instruction === 'string' ? body.instruction.trim() : ''
    const framework = body.framework
    if (!canvasId) return c.json({ error: 'canvasId is required' }, 400)
    if (!elementId) return c.json({ error: 'elementId is required' }, 400)
    if (!source) return c.json({ error: 'source is required' }, 400)
    if (source.length > MAX_SOURCE_LEN) return c.json({ error: 'source too large' }, 400)
    if (!instruction) return c.json({ error: 'instruction is required' }, 400)
    if (instruction.length > MAX_INSTRUCTION_LEN) {
      return c.json({ error: 'instruction too long' }, 400)
    }
    if (framework !== 'react' && framework !== 'html') {
      return c.json({ error: 'framework must be "react" or "html"' }, 400)
    }
    if (!body.element || typeof body.element !== 'object') {
      return c.json({ error: 'element is required' }, 400)
    }
    const req: TweakScreenRequest = {
      path,
      source,
      framework,
      instruction,
      element: {
        tag: str(body.element.tag, 100),
        classes: str(body.element.classes, MAX_ELEMENT_TEXT),
        text: str(body.element.text, MAX_ELEMENT_TEXT),
        html: str(body.element.html, MAX_ELEMENT_HTML),
      },
    }
    const pre = await claudeRunPreflight()
    if (!pre.ok) return c.json(pre.body, 503)
    const jobId = startTweakJob({ projectPath: path, canvasId, elementId, req })
    return c.json({ jobId })
  })
  // ── GET /api/canvas/ai/active ─────────────────────────────────────────────
  // Live (running) jobs — feeds the global "Claude is designing" beacon.
  // Deliberately unvalidated (mirrors /api/terminal/active): it returns only
  // metadata about jobs THIS app spawned. Distinct path segment from the dynamic
  // :id route below, so ordering doesn't matter.
  .get('/api/canvas/ai/active', (c) => c.json({ jobs: listActiveCanvasAiJobs() }))
  // ── GET /api/canvas/ai/job/:id ────────────────────────────────────────────
  // The starting client polls this for progress + result.
  .get('/api/canvas/ai/job/:id', (c) => {
    const state = getCanvasAiJobState(c.req.param('id'))
    if (!state) return c.json({ error: 'job not found' }, 404)
    return c.json(state)
  })
  // ── POST /api/canvas/ai/job/:id/cancel ────────────────────────────────────
  // Explicit cancel — kills the claude session (the ONLY thing that does).
  .post('/api/canvas/ai/job/:id/cancel', (c) => {
    const ok = cancelCanvasAiJob(c.req.param('id'))
    if (!ok) return c.json({ error: 'job not found' }, 404)
    return c.json({ ok: true })
  })
