// Local custom-tab CRUD. Distribution endpoints are retired; existing installed
// tabs remain readable and retain their original edit/delete permissions.
import { Hono } from 'hono'
import type { Context } from 'hono'
import { getCustomTabRole } from '@/lib/server/roles'
import { killTerminalsByCwd } from '@/lib/server/terminal'
import { customModuleDir } from '@/lib/server/paths'
import {
  createModule,
  deleteModule,
  getModule,
  listModules,
  readModuleSource,
  updateModule,
} from '@/lib/server/customModules'
// Contract limits (docs/CUSTOM_TABS_PLAN.md): label 1–60 chars, description
// ≤ 4000. Shared by create + update so the bounds can't drift.
const MAX_LABEL = 60
const MAX_DESCRIPTION = 4000

const forbidden = (c: Context) => c.json({ error: 'forbidden' }, 403)
const notFound = (c: Context) => c.json({ error: 'not found' }, 404)

export const customModulesRoutes = new Hono()
  // --- GET /api/custom-modules — role + module list (any caller) -------------
  // Even role 'none' gets the list: existing on-disk custom tabs still render
  // read-only; only the management UI is role-gated (and re-checked here on
  // every mutating route).
  .get('/api/custom-modules', async (c) => {
    const [role, modules] = await Promise.all([getCustomTabRole(), listModules()])
    return c.json({ role, modules })
  })
  // --- POST /api/custom-modules — create a local module (owner | tester) -----
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
