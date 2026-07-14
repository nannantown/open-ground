// server/routes/customModules.ts — Hono sub-router for custom tab modules
// (docs/CUSTOM_TABS_PLAN.md). Thin adapter over src/lib/server/customModules
// (disk CRUD), customModulesMarket (Supabase glue) and roles (server-side
// gate). Role failures → 403 { error: 'forbidden' }; an id that fails the uuid
// regex OR isn't in index.json → 404 (the regex runs before any path is built,
// so traversal payloads never reach the filesystem). Missing Supabase env →
// 503, never a crash.
//
// Method-chaining style (new Hono().get(...).post(...)) so hc<AppType> on the
// client recovers this group's route tree.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCustomTabRole } from '@/lib/server/roles'
import { isLockdownEnabled } from '@/lib/server/store'
import { killTerminalsByCwd } from '@/lib/server/terminal'
import { customModuleDir } from '@/lib/server/paths'
import {
  createModule,
  deleteModule,
  getModule,
  installModule,
  listModules,
  markPublished,
  readModuleSource,
  updateModule,
} from '@/lib/server/customModules'
import {
  MarketError,
  fetchMarketplaceModule,
  listMarketplace,
  publishModule,
  readMarketConfig,
  readPublishConfig,
} from '@/lib/server/customModulesMarket'

// Contract limits (docs/CUSTOM_TABS_PLAN.md): label 1–60 chars, description
// ≤ 4000. Shared by create + update so the bounds can't drift.
const MAX_LABEL = 60
const MAX_DESCRIPTION = 4000

const forbidden = (c: Context) => c.json({ error: 'forbidden' }, 403)
const notFound = (c: Context) => c.json({ error: 'not found' }, 404)

// Shared 502 translators for Supabase failures (the feedback.ts pattern): log
// the operator-useful detail server-side, return a generic message so the url
// and key context never leak to the loopback client.
const badGateway = (c: Context, e: MarketError) => {
  console.error(`[openground:custom-modules] ${e.label} supabase ${e.status}: ${e.detail}`)
  return c.json({ error: `marketplace service responded ${e.status}` }, 502)
}

const unreachable = (c: Context, label: string, e: unknown) => {
  const msg = e instanceof Error ? e.message : `marketplace ${label} failed`
  console.error(`[openground:custom-modules] ${label} failed`, msg)
  return c.json({ error: 'could not reach marketplace service' }, 502)
}

export const customModulesRoutes = new Hono()
  // --- GET /api/custom-modules — role + module list (any caller) -------------
  // Even role 'none' gets the list: existing on-disk custom tabs still render
  // read-only; only the management UI is role-gated (and re-checked here on
  // every mutating route).
  .get('/api/custom-modules', async (c) => {
    const [role, modules, lockdown] = await Promise.all([
      getCustomTabRole(),
      listModules(),
      isLockdownEnabled(),
    ])
    // marketAvailable=false hides the client's "Browse marketplace" entries
    // while work mode blocks the marketplace routes below (local CRUD stays).
    return c.json({ role, modules, marketAvailable: !lockdown })
  })
  // --- POST /api/custom-modules — create a local module (owner | tester) -----
  // Authoring is open to testers (they build a tab locally, then submit it to
  // the owner for review); only role 'none' is forbidden. Publishing official
  // modules stays owner-only (see the publish route below).
  .post('/api/custom-modules', async (c) => {
    if ((await getCustomTabRole()) === 'none') return forbidden(c)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const label = typeof body?.label === 'string' ? body.label.trim() : ''
    if (!label || label.length > MAX_LABEL) {
      return c.json({ error: `label is required (1-${MAX_LABEL} chars)` }, 400)
    }
    const description = typeof body?.description === 'string' ? body.description : ''
    if (description.length > MAX_DESCRIPTION) {
      return c.json({ error: `description too long (max ${MAX_DESCRIPTION} chars)` }, 400)
    }
    const framework = body?.framework === 'html' ? 'html' : 'react'
    const def = await createModule({ label, description, framework })
    return c.json(def)
  })
  // --- GET /api/custom-modules/:id/source — iframe + hot-reload feed ---------
  // Any caller (rendering custom tabs is role-free). The id is regex-validated
  // inside readModuleSource before any path is built.
  .get('/api/custom-modules/:id/source', async (c) => {
    const src = await readModuleSource(c.req.param('id'))
    if (!src) return notFound(c)
    return c.json(src)
  })
  // --- PUT /api/custom-modules/:id — patch meta and/or source ----------------
  // owner: any module. tester: their OWN authored modules only (origin
  // 'local') — never an 'installed' one, which is someone else's published
  // artifact (the inverse of the DELETE handler's installed-only tester rule).
  // none: forbidden.
  .put('/api/custom-modules/:id', async (c) => {
    const role = await getCustomTabRole()
    if (role === 'none') return forbidden(c)
    const def = await getModule(c.req.param('id'))
    if (!def) return notFound(c)
    if (role === 'tester' && def.origin !== 'local') return forbidden(c)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const patch: { label?: string; description?: string; source?: string } = {}
    if (body?.label !== undefined) {
      const label = typeof body.label === 'string' ? body.label.trim() : ''
      if (!label || label.length > MAX_LABEL) {
        return c.json({ error: `label must be 1-${MAX_LABEL} chars` }, 400)
      }
      patch.label = label
    }
    if (body?.description !== undefined) {
      if (typeof body.description !== 'string' || body.description.length > MAX_DESCRIPTION) {
        return c.json({ error: `description too long (max ${MAX_DESCRIPTION} chars)` }, 400)
      }
      patch.description = body.description
    }
    if (body?.source !== undefined) {
      if (typeof body.source !== 'string') return c.json({ error: 'source must be a string' }, 400)
      patch.source = body.source
    }
    // Re-check existence inside the single-flight chain (the def read above is
    // for the role gate; a concurrent delete between then and now still 404s).
    const updated = await updateModule(c.req.param('id'), patch)
    if (!updated) return notFound(c)
    return c.json(updated)
  })
  // --- DELETE /api/custom-modules/:id — owner; tester for installed only -----
  .delete('/api/custom-modules/:id', async (c) => {
    const role = await getCustomTabRole()
    if (role === 'none') return forbidden(c)
    const def = await getModule(c.req.param('id'))
    if (!def) return notFound(c)
    // A tester may only remove modules they installed from the marketplace —
    // never the owner's local originals.
    if (role === 'tester' && def.origin !== 'installed') return forbidden(c)
    // The sidebar's "Edit with Claude" claude session lives IN this dir — kill
    // any such PTY before the rm -rf so no session lingers in an unlinked cwd
    // with every UI surface that could reach it gone (the Board's
    // kill-on-task-delete posture, see ProjectPanel's closeTaskTerminal).
    killTerminalsByCwd(customModuleDir(def.id))
    const ok = await deleteModule(def.id)
    if (!ok) return notFound(c)
    return c.json({ ok: true })
  })
  // --- POST /api/custom-modules/:id/publish — upsert to Supabase (owner) -----
  // Local module CRUD above stays available under work mode (lockdown) — it
  // never leaves the machine. The three Supabase-egress routes below do not.
  .post('/api/custom-modules/:id/publish', async (c) => {
    if (await isLockdownEnabled()) {
      return c.json({ error: 'disabled by work mode (lockdown)' }, 503)
    }
    if ((await getCustomTabRole()) !== 'owner') return forbidden(c)
    const config = readPublishConfig()
    if (!config) {
      return c.json({ error: 'publishing not configured', publishUnavailable: true }, 503)
    }
    const id = c.req.param('id')
    const def = await getModule(id)
    if (!def) return notFound(c)
    const src = await readModuleSource(id)
    if (!src) return notFound(c)
    try {
      const result = await publishModule(config, def, src.source)
      const updated = await markPublished(id, result)
      return c.json(updated ?? { ...def, ...result })
    } catch (e) {
      if (e instanceof MarketError) return badGateway(c, e)
      return unreachable(c, 'publish', e)
    }
  })
  // --- GET /api/marketplace — list published modules (owner | tester) --------
  .get('/api/marketplace', async (c) => {
    if (await isLockdownEnabled()) {
      return c.json({ error: 'disabled by work mode (lockdown)' }, 503)
    }
    const role = await getCustomTabRole()
    if (role === 'none') return forbidden(c)
    const config = readMarketConfig()
    if (!config) return c.json({ error: 'marketplace not configured' }, 503)
    try {
      const items = await listMarketplace(config)
      return c.json({ items })
    } catch (e) {
      if (e instanceof MarketError) return badGateway(c, e)
      return unreachable(c, 'list', e)
    }
  })
  // --- POST /api/marketplace/install — copy a row locally (owner | tester) ---
  .post('/api/marketplace/install', async (c) => {
    if (await isLockdownEnabled()) {
      return c.json({ error: 'disabled by work mode (lockdown)' }, 503)
    }
    const role = await getCustomTabRole()
    if (role === 'none') return forbidden(c)
    const config = readMarketConfig()
    if (!config) return c.json({ error: 'marketplace not configured' }, 503)
    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid body' }, 400)
    }
    const remoteId = typeof body?.remoteId === 'string' ? body.remoteId.trim() : ''
    if (!remoteId) return c.json({ error: 'remoteId is required' }, 400)
    try {
      const row = await fetchMarketplaceModule(config, remoteId)
      if (!row) return notFound(c)
      const def = await installModule({
        remoteId: row.remoteId,
        label: row.name,
        description: row.description,
        framework: row.framework,
        version: row.version,
        publishedAt: row.publishedAt,
        source: row.source,
      })
      return c.json(def)
    } catch (e) {
      if (e instanceof MarketError) return badGateway(c, e)
      return unreachable(c, 'install', e)
    }
  })
