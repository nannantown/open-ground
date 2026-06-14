// server/routes/canvasAi.ts — Hono sub-router for the Canvas AI endpoints.
// Declares FULL /api/... paths (app.ts mounts with app.route('/', canvasAiRoutes)).
// Handlers are THIN ADAPTERS over src/lib/server/canvasAi.ts — no business
// logic lives here.
//
// Routes (contract: GenerateElementsRequest/Response, TweakScreenRequest/
// Response in src/lib/types.ts):
//   - canvas/generate-elements  POST  { path, prompt }            → { elements }
//   - canvas/tweak-screen       POST  { path, source, framework,
//                                       instruction, element }    → { source }
//
// Both spawn a one-off claude session (subscription-only, PTY via
// launchClaude), so each pre-flights claudeConnection and answers 503
// { claudeMissing: true } when the CLI is absent — same shape as
// /api/project/describe so the UI can disable the affordance. We gate on
// `.installed` only (claude prompts for login itself at runtime).

import { Hono } from 'hono'
import { requireProjectPath } from '../middleware/projectPath'
import { claudeConnection } from '@/lib/server/claudeConnection'
import { generateCanvasElements, tweakScreenSource } from '@/lib/server/canvasAi'
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

const str = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : ''

export const canvasAiRoutes = new Hono()
  // ── /api/canvas/generate-elements ─────────────────────────────────────────
  // POST { path, prompt } → claude authors native canvas elements (validated,
  // ids reassigned server-side). Positions are relative to (0,0); the client
  // offsets them to the viewport center before inserting.
  .post('/api/canvas/generate-elements', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    let body: { prompt?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (!prompt) return c.json({ error: 'prompt is required' }, 400)
    if (prompt.length > MAX_PROMPT_LEN) return c.json({ error: 'prompt too long' }, 400)
    const conn = await claudeConnection()
    if (!conn.installed) {
      return c.json({ error: conn.message, claudeMissing: true }, 503)
    }
    try {
      // The request's abort signal flows through: a hung-up client never
      // burns (or keeps burning) a queued claude session.
      const elements = await generateCanvasElements(prompt, {
        signal: c.req.raw.signal,
      })
      return c.json({ elements })
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : 'element generation failed' },
        500,
      )
    }
  })
  // ── /api/canvas/tweak-screen ──────────────────────────────────────────────
  // POST TweakScreenRequest → claude rewrites the screen/mock source per the
  // element-scoped instruction; returns the FULL rewritten source.
  .post('/api/canvas/tweak-screen', async (c) => {
    const path = await requireProjectPath(c)
    if (path instanceof Response) return path
    let body: Partial<TweakScreenRequest>
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const source = typeof body.source === 'string' ? body.source : ''
    const instruction =
      typeof body.instruction === 'string' ? body.instruction.trim() : ''
    const framework = body.framework
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
    const conn = await claudeConnection()
    if (!conn.installed) {
      return c.json({ error: conn.message, claudeMissing: true }, 503)
    }
    try {
      const result = await tweakScreenSource(req, { signal: c.req.raw.signal })
      return c.json(result)
    } catch (e) {
      return c.json(
        { error: e instanceof Error ? e.message : 'screen tweak failed' },
        500,
      )
    }
  })
