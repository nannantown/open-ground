// server/routes/moduleSubmissions.ts — Hono sub-router for the module-submission
// review queue (docs/CUSTOM_TABS_PLAN.md — submit → review → publish).
//
// A tester builds a custom tab locally and submits its source to the owner; the
// owner reviews this PRIVATE queue and approves (→ published into the public
// og_custom_modules marketplace via the existing publishModule) or rejects.
// Mirrors server/routes/feedback.ts:
//   - submit → the anon key (server-proxied INSERT; the table RLS pins
//     status='pending'), gated server-side to owner|tester.
//   - review → the SERVICE-ROLE key (reads/moderates past the insert-only RLS),
//     additionally gated by an admin-email allowlist when one is configured.
// Nothing identifying ships in the binary; missing env → 503, never a crash.
//
// Method-chaining style so hc<AppType> on the client recovers this group's tree.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { createHash } from 'crypto'
import { getCustomTabRole } from '@/lib/server/roles'
import { readSession } from '@/lib/server/authStore'
import { SubmitModuleBodySchema } from '@/lib/schemas'
import {
  SubmissionError,
  type SubmissionsConfig,
  countPendingSince,
  getSubmission,
  listSubmissions,
  markSubmission,
  readSubmissionAdminConfig,
  readSubmitConfig,
  submitModule,
} from '@/lib/server/customModulesSubmissions'
import {
  MarketError,
  publishModule,
  readPublishConfig,
} from '@/lib/server/customModulesMarket'
import type { CustomModuleDef } from '@/lib/types'

// --- admin gate (optional allowlist; the service-role key is the real gate) ---
// MODULE_ADMIN_EMAILS, falling back to FEEDBACK_ADMIN_EMAILS so an owner who
// already set the feedback allowlist doesn't have to set a second var. Unset →
// reads stay gated by the service-role key alone (loopback trust, feedback parity).
const readAdminEmails = (): Set<string> => {
  const raw =
    process.env.MODULE_ADMIN_EMAILS?.trim() || process.env.FEEDBACK_ADMIN_EMAILS?.trim()
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )
}

// Whether the current request may READ/moderate the queue. True when no allowlist
// is set (the service-role key alone gates it — owner machine only); otherwise
// true only when the persisted app session's email is on the allowlist.
const isReviewer = async (): Promise<boolean> => {
  const admins = readAdminEmails()
  if (admins.size === 0) return true
  const session = await readSession()
  const email = session?.user.email?.trim().toLowerCase()
  return !!email && admins.has(email)
}

// Stable, non-secret id (one-way hash of url+table) so the client scopes its
// "last seen" unread marker per data source. Never the url or key itself.
const sourceId = (config: SubmissionsConfig): string =>
  createHash('sha1').update(`${config.url}/${config.table}`).digest('hex').slice(0, 12)

// --- shared 502 translators (the feedback / market pattern) -------------------
const badGateway = (c: Context, e: SubmissionError | MarketError) => {
  console.error(
    `[openground:module-submissions] ${e.label} supabase ${e.status}: ${e.detail}`,
  )
  return c.json({ error: `submission service responded ${e.status}` }, 502)
}
const unreachable = (c: Context, label: string, e: unknown) => {
  const msg = e instanceof Error ? e.message : `submissions ${label} failed`
  console.error(`[openground:module-submissions] ${label} failed`, msg)
  return c.json({ error: 'could not reach submission service' }, 502)
}

const forbidden = (c: Context) => c.json({ error: 'forbidden' }, 403)

export const moduleSubmissionsRoutes = new Hono()
  // --- GET /api/module-submissions/config -----------------------------------
  // enabled: a tester can submit (anon key present). canReview: the owner review
  // inbox shows (service-role key present AND — when an allowlist is set — the
  // signed-in account is on it). Reports only booleans / an opaque id.
  .get('/api/module-submissions/config', async (c) => {
    const admin = readSubmissionAdminConfig()
    const canReview = admin !== null && (await isReviewer())
    return c.json({
      enabled: readSubmitConfig() !== null,
      canReview,
      ...(canReview && admin ? { sourceId: sourceId(admin) } : {}),
    })
  })
  // --- POST /api/module-submissions — a tester submits a built tab -----------
  // owner|tester (only 'none' forbidden). The submitter's email is read from the
  // app session (display-only, never trusted); the body is the built source.
  .post('/api/module-submissions', zValidator('json', SubmitModuleBodySchema), async (c) => {
    if ((await getCustomTabRole()) === 'none') return forbidden(c)
    const config = readSubmitConfig()
    if (!config) return c.json({ error: 'submissions not configured' }, 503)
    const { name, description, framework, source } = c.req.valid('json')
    const session = await readSession()
    try {
      await submitModule(config, {
        name,
        description,
        framework,
        source,
        submitterEmail: session?.user.email ?? null,
      })
      return c.json({ ok: true })
    } catch (e) {
      if (e instanceof SubmissionError) return badGateway(c, e)
      return unreachable(c, 'submit', e)
    }
  })
  // --- GET /api/module-submissions — owner review queue (service-role) -------
  .get('/api/module-submissions', async (c) => {
    const config = readSubmissionAdminConfig()
    if (!config) return c.json({ error: 'submission review not configured' }, 503)
    if (!(await isReviewer())) return forbidden(c)
    try {
      const { items, truncated } = await listSubmissions(config)
      return c.json({ items, truncated })
    } catch (e) {
      if (e instanceof SubmissionError) return badGateway(c, e)
      return unreachable(c, 'list', e)
    }
  })
  // --- GET /api/module-submissions/unread — count for the settings-gear dot ---
  .get('/api/module-submissions/unread', async (c) => {
    const config = readSubmissionAdminConfig()
    if (!config) return c.json({ error: 'submission review not configured' }, 503)
    if (!(await isReviewer())) return forbidden(c)
    const since = c.req.query('since')?.trim()
    try {
      const count = await countPendingSince(config, since || undefined)
      return c.json({ count })
    } catch (e) {
      if (e instanceof SubmissionError) return badGateway(c, e)
      return unreachable(c, 'unread', e)
    }
  })
  // --- GET /api/module-submissions/:id — one submission WITH source (review) --
  // Feeds the inbox's "View code" expander (the list omits source to stay light).
  // Registered AFTER /unread so the static path wins over this :id param.
  .get('/api/module-submissions/:id', async (c) => {
    const config = readSubmissionAdminConfig()
    if (!config) return c.json({ error: 'submission review not configured' }, 503)
    if (!(await isReviewer())) return forbidden(c)
    try {
      const sub = await getSubmission(config, c.req.param('id'))
      if (!sub) return c.json({ error: 'not found' }, 404)
      return c.json(sub)
    } catch (e) {
      if (e instanceof SubmissionError) return badGateway(c, e)
      return unreachable(c, 'get', e)
    }
  })
  // --- POST /api/module-submissions/:id/approve — publish + mark approved -----
  // The ONLY path that writes the public og_custom_modules table, and it goes
  // through the existing service-role publishModule (an INSERT — a fresh
  // marketplace row), so the public marketplace only ever holds owner-approved
  // source. Then the submission row is stamped approved + linked to the new id.
  .post('/api/module-submissions/:id/approve', async (c) => {
    const config = readSubmissionAdminConfig()
    if (!config) return c.json({ error: 'submission review not configured' }, 503)
    if (!(await isReviewer())) return forbidden(c)
    const pubConfig = readPublishConfig()
    if (!pubConfig) {
      return c.json({ error: 'publishing not configured', publishUnavailable: true }, 503)
    }
    const id = c.req.param('id')
    try {
      const sub = await getSubmission(config, id)
      if (!sub) return c.json({ error: 'not found' }, 404)
      // Build a CustomModuleDef for publishModule (no remoteId → it INSERTs).
      const def: CustomModuleDef = {
        id: sub.id,
        label: sub.name,
        description: sub.description,
        framework: sub.framework,
        origin: 'local',
        createdAt: sub.created_at,
        updatedAt: sub.created_at,
      }
      const result = await publishModule(pubConfig, def, sub.source ?? '')
      await markSubmission(config, id, {
        status: 'approved',
        publishedRemoteId: result.remoteId,
      })
      return c.json({ remoteId: result.remoteId })
    } catch (e) {
      if (e instanceof SubmissionError || e instanceof MarketError) return badGateway(c, e)
      return unreachable(c, 'approve', e)
    }
  })
  // --- POST /api/module-submissions/:id/reject — mark rejected ---------------
  .post('/api/module-submissions/:id/reject', async (c) => {
    const config = readSubmissionAdminConfig()
    if (!config) return c.json({ error: 'submission review not configured' }, 503)
    if (!(await isReviewer())) return forbidden(c)
    const id = c.req.param('id')
    try {
      // PATCH by id; a row that's already gone/resolved is a harmless no-op.
      await markSubmission(config, id, { status: 'rejected' })
      return c.json({ ok: true })
    } catch (e) {
      if (e instanceof SubmissionError) return badGateway(c, e)
      return unreachable(c, 'reject', e)
    }
  })
