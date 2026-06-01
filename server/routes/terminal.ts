// server/routes/terminal.ts — F-terminal group Hono sub-router.
// Thin adapter port of src/app/api/terminal/* route handlers. All
// src/lib/server/terminal logic stays IDENTICAL; only the HTTP plumbing
// changes: NextResponse.json(x[,{status}]) -> c.json(x[,status]),
// req.json() -> c.req.json(), [id] -> :id via c.req.param('id').
//
// Notes vs the Next version:
// - `export const dynamic/runtime` are Next-only and intentionally dropped;
//   Hono streams/serves natively.
// - Only the create route touches validateProjectPath (it validates `cwd`).
//   The input/resize/[id] routes never received a project path, so the
//   security boundary is unchanged (we don't add a guard where there wasn't one).
// - These routes parse the body manually (no zod schema exists for terminal),
//   matching the original loose `body?.field` reads + try/catch on invalid JSON.
//
// Mounted by the Integration phase: app.route('/', terminalRoutes) in server/app.ts.

import { Hono } from 'hono'
import { validateProjectPath } from '@/lib/server/projectData'
import {
  createTerminal,
  getTerminal,
  killTerminal,
  resizeTerminal,
  writeInput,
} from '@/lib/server/terminal'

export const terminalRoutes = new Hono()
  // --- POST /api/terminal — start a terminal in a project dir (validates cwd) ---
  .post('/api/terminal', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const cwd = typeof body?.cwd === 'string' ? body.cwd : ''
    if (!cwd) return c.json({ error: 'cwd is required' }, 400)
    if (!(await validateProjectPath(cwd))) return c.json({ error: 'cwd not allowed' }, 403)
    const cols = Number.isFinite(body?.cols) ? Number(body.cols) : undefined
    const rows = Number.isFinite(body?.rows) ? Number(body.rows) : undefined
    try {
      const info = createTerminal({ cwd, cols, rows })
      return c.json(info)
    } catch (e: any) {
      return c.json({ error: `failed to start terminal: ${e?.message ?? e}` }, 500)
    }
  })
  // --- GET /api/terminal/:id — fetch terminal info ---
  .get('/api/terminal/:id', (c) => {
    const info = getTerminal(c.req.param('id'))
    if (!info) return c.json({ error: 'not found' }, 404)
    return c.json(info)
  })
  // --- DELETE /api/terminal/:id — kill a terminal ---
  .delete('/api/terminal/:id', (c) => {
    const ok = killTerminal(c.req.param('id'))
    if (!ok) return c.json({ error: 'not found' }, 404)
    return c.json({ ok: true })
  })
  // --- POST /api/terminal/:id/input — write to terminal stdin ---
  .post('/api/terminal/:id/input', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const data = typeof body?.data === 'string' ? body.data : ''
    const ok = writeInput(c.req.param('id'), data)
    if (!ok) return c.json({ error: 'not found or finished' }, 404)
    return c.json({ ok: true })
  })
  // --- POST /api/terminal/:id/resize — resize the pty ---
  .post('/api/terminal/:id/resize', async (c) => {
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const cols = Number(body?.cols)
    const rows = Number(body?.rows)
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return c.json({ error: 'cols/rows required' }, 400)
    }
    const ok = resizeTerminal(c.req.param('id'), cols, rows)
    if (!ok) return c.json({ error: 'not found or finished' }, 404)
    return c.json({ ok: true })
  })
