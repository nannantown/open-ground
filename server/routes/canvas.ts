// server/routes/canvas.ts — Hono sub-router for the D-canvas group.
// Declares FULL /api/... paths (app.ts mounts with app.route('/', canvasRoutes)).
// Handlers are THIN ADAPTERS over the existing src/lib/server/* logic — no
// business logic lives here. NextResponse.json(x[,status]) -> c.json(x[,status]);
// (await req.json()) -> (await c.req.json()); url.searchParams.get('x') ->
// c.req.query('x'); FormData -> (await c.req.formData()).
//
// Routes:
//   - canvas            GET/POST          (whole-canvas state)
//   - canvas/asset      POST/GET/DELETE   (per-canvas image assets)
//   - paste-image       POST              (clipboard image -> ~/.openground/paste)
//
// The original routes hand-roll their validation (query params, FormData,
// base64 bodies) rather than using zod, and return precise status codes
// (400/403/404/409/413/500). That behaviour is reproduced verbatim — these
// are not zod-validatable JSON-body routes, so the @hono/zod-validator path
// from the template does not apply here.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { randomUUID } from 'crypto'
import { writeFile } from 'fs/promises'
import { join } from 'path'

import { getCanvas, setCanvas } from '@/lib/server/store'
import { validateProjectPath } from '@/lib/server/projectData'
import {
  deleteCanvasAsset,
  extForMime,
  isValidAssetId,
  isValidCanvasId,
  readCanvasAsset,
  writeCanvasAsset,
} from '@/lib/server/canvasImages'
import { ensurePasteDir, pasteDir } from '@/lib/server/paths'

// ── Module-level helpers (hoisted above the chain) ───────────────────────────
// In the prior statement style these sat interleaved between route
// registrations. Method-chaining needs one uninterrupted expression, so every
// handler-dependency (guards, body types, scaffolding helpers) is declared up
// front here.

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // 50 MB — same cap as task images

type AssetGuard =
  | { ok: true; projectPath: string; canvasId: string; assetId: string }
  | { ok: false; err: Response }

// Mirror of the original `guard()`: query-param validation + the
// validateProjectPath security boundary (CONTRACT §3.3). Returns either the
// validated fields or a Hono Response to return as-is.
const assetGuard = async (c: Context, requireAsset: boolean): Promise<AssetGuard> => {
  const projectPath = c.req.query('path') ?? ''
  const canvasId = c.req.query('canvasId') ?? ''
  const assetId = c.req.query('assetId') ?? ''
  if (!projectPath) {
    return { ok: false, err: c.json({ error: 'path required' }, 400) }
  }
  if (!isValidCanvasId(canvasId)) {
    return { ok: false, err: c.json({ error: 'bad canvasId' }, 400) }
  }
  if (requireAsset && !isValidAssetId(assetId)) {
    return { ok: false, err: c.json({ error: 'bad assetId' }, 400) }
  }
  if (!(await validateProjectPath(projectPath))) {
    return { ok: false, err: c.json({ error: 'path not allowed' }, 403) }
  }
  return { ok: true, projectPath, canvasId, assetId }
}

// /api/paste-image helpers
// (extension lookup is shared via extForMime; unknown image types fall back
//  to `.bin`, matching the prior local extFor behaviour.)

// Cap at 50MB — bigger than any reasonable screenshot, small enough that a
// runaway clipboard read can't exhaust memory.
const MAX_BYTES = 50 * 1024 * 1024

// ── The chain ────────────────────────────────────────────────────────────────
// All routes are method-chained off the router instance so hc<AppType> on the
// client recovers this group's route tree. Behaviour is identical to the prior
// statement style.

export const canvasRoutes = new Hono()
  // =========================================================================
  // /api/canvas — whole-canvas state (card positions + viewport)
  // =========================================================================
  .get('/api/canvas', async (c) => {
    return c.json(await getCanvas())
  })
  .post('/api/canvas', async (c) => {
    const body = await c.req.json()
    await setCanvas(body)
    return c.json({ ok: true })
  })
  // =========================================================================
  // /api/canvas/asset — per-canvas image assets (POST upload / GET / DELETE)
  //   ?path=<projectPath>  &canvasId=<uuid>  &assetId=<uuid v4 — GET/DELETE only>
  // =========================================================================
  .post('/api/canvas/asset', async (c) => {
    const g = await assetGuard(c, false)
    if (!g.ok) return g.err

    let form: FormData
    try {
      form = await c.req.formData()
    } catch {
      return c.json({ error: 'expected multipart/form-data' }, 400)
    }
    const file = form.get('file')
    if (!(file instanceof Blob)) {
      return c.json({ error: 'file field missing' }, 400)
    }
    if (file.size === 0) {
      return c.json({ error: 'empty file' }, 400)
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      return c.json({ error: 'file too large' }, 413)
    }
    const mime = file.type
    if (!extForMime(mime)) {
      return c.json({ error: `unsupported mime: ${mime}` }, 400)
    }
    const assetId = randomUUID()
    const data = Buffer.from(await file.arrayBuffer())
    try {
      await writeCanvasAsset(g.projectPath, g.canvasId, assetId, mime, data)
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'write failed' }, 500)
    }
    const filename = file instanceof File && file.name ? file.name : 'pasted'
    return c.json({ assetId, filename, mime })
  })
  .get('/api/canvas/asset', async (c) => {
    const g = await assetGuard(c, true)
    if (!g.ok) return g.err
    const out = await readCanvasAsset(g.projectPath, g.canvasId, g.assetId)
    if (!out) {
      return c.json({ error: 'not found' }, 404)
    }
    // Binary body, not JSON — matches the original `new Response(...)`.
    return c.body(out.data as unknown as ArrayBuffer, 200, {
      'content-type': out.mime,
      // Local single-user tool — private cache is appropriate. Short TTL so a
      // replacement upload shows up without a hard refresh.
      'cache-control': 'private, max-age=300',
    })
  })
  .delete('/api/canvas/asset', async (c) => {
    const g = await assetGuard(c, true)
    if (!g.ok) return g.err
    await deleteCanvasAsset(g.projectPath, g.canvasId, g.assetId)
    return c.json({ ok: true })
  })
  // =========================================================================
  // /api/paste-image — clipboard image (base64) -> ~/.openground/paste/<file>
  //   (extForMime / MAX_BYTES hoisted above)
  // =========================================================================
  .post('/api/paste-image', async (c) => {
    let body: { mime?: unknown; dataBase64?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const mime = typeof body?.mime === 'string' ? body.mime : ''
    const dataBase64 = typeof body?.dataBase64 === 'string' ? body.dataBase64 : ''
    if (!mime.startsWith('image/') || !dataBase64) {
      return c.json({ error: 'missing image data' }, 400)
    }
    const buf = Buffer.from(dataBase64, 'base64')
    if (buf.length === 0) {
      return c.json({ error: 'empty image' }, 400)
    }
    if (buf.length > MAX_BYTES) {
      return c.json({ error: 'image too large' }, 413)
    }
    await ensurePasteDir()
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const filename = `${ts}-${randomUUID().slice(0, 8)}.${extForMime(mime) ?? 'bin'}`
    const path = join(pasteDir(), filename)
    await writeFile(path, buf)
    return c.json({ path })
  })
