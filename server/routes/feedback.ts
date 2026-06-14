// server/routes/feedback.ts — Hono sub-router for the in-app feedback feature.
//
// WHY A SERVER PROXY (not a direct browser → Supabase call):
// OPEN GROUND ships to strangers as a packaged Electron app, and its Hono
// server is loopback-only. We forward feedback through THIS route so the
// Supabase anon key never lands in the client bundle — the public build is
// safe with no credentials baked in. The route reads SUPABASE_URL +
// SUPABASE_ANON_KEY (+ optional SUPABASE_FEEDBACK_TABLE, default 'feedback')
// from the SERVER env only. See docs/FEEDBACK_SETUP.md for the table SQL,
// RLS policy (insert-only for anon), and where to read submissions.
//
// GRACEFUL DEGRADE: when the env vars are unset (the default public build),
// GET /api/feedback/config reports { enabled: false } so the UI hides its
// entry, and POST /api/feedback returns a clear 503 "feedback not configured"
// instead of attempting a forward. NO hardcoded secrets, ever.
//
// Method-chaining style (new Hono().get(...).post(...)) so hc<AppType> on the
// client recovers this group's route tree.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { zValidator } from '@hono/zod-validator'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { release } from 'os'
import { createHash } from 'crypto'
import { getSettings } from '@/lib/server/store'
import { readSession } from '@/lib/server/authStore'
import { FeedbackApiBodySchema, sanitizeFeedbackImages } from '@/lib/schemas'

// --- Env-driven configuration ----------------------------------------------
// Read lazily (per request) rather than frozen at module load so the operator
// can set the vars and restart the server without a code change taking effect
// — and so tests can flip them with vi.stubEnv between cases.
interface FeedbackConfig {
  url: string
  key: string
  table: string
}

// SUPABASE_URL + the chosen key env + optional table. Returns null unless BOTH
// url and key are present. One reader, parameterised by which key it pulls, so
// the url/table/strip logic lives in exactly one place.
const readConfig = (
  keyEnv: 'SUPABASE_ANON_KEY' | 'SUPABASE_SERVICE_ROLE_KEY',
): FeedbackConfig | null => {
  const url = process.env.SUPABASE_URL?.trim()
  const key = process.env[keyEnv]?.trim()
  if (!url || !key) return null
  const table = process.env.SUPABASE_FEEDBACK_TABLE?.trim() || 'feedback'
  return { url: url.replace(/\/+$/, ''), key, table }
}

// Write path: the anon key (insert-only under RLS). Present on every build that
// wants to COLLECT feedback.
const readFeedbackConfig = () => readConfig('SUPABASE_ANON_KEY')

// Read path: the SERVICE-ROLE key bypasses RLS so the owner can READ rows back.
// Owner machine only — NEVER baked into the public Electron build (the anon key
// can't SELECT, so a shipped build reports canRead:false and the inbox/dot never
// appear).
const readServiceConfig = () => readConfig('SUPABASE_SERVICE_ROLE_KEY')

// Stable, non-secret id for the data source (url+table) so the client can scope
// its "last seen" marker per Supabase project/table. A one-way hash — never the
// url or key itself; only emitted to the loopback client when canRead.
const sourceId = (config: FeedbackConfig): string =>
  createHash('sha1').update(`${config.url}/${config.table}`).digest('hex').slice(0, 12)

// --- Owner identity gate (optional) ----------------------------------------
// FEEDBACK_ADMIN_EMAILS is an OPT-IN allowlist of owner emails (comma-separated)
// that may read feedback. Service-role key present but list UNSET → reads stay
// gated by the key alone (the prior loopback-trust behaviour, backward-compat).
// Set the list → reads additionally require a signed-in session whose email is
// on it, so feedback (which holds third-party PII) is no longer readable by any
// process that can reach the loopback port. Lowercased for case-insensitive match.
const readAdminEmails = (): Set<string> => {
  const raw = process.env.FEEDBACK_ADMIN_EMAILS?.trim()
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  )
}

// Whether the current request is allowed to READ feedback. True when no
// allowlist is configured (opt-in); otherwise true only when the persisted app
// session's email is on the allowlist. Reads identity from authStore — the same
// single session /api/auth/session serves — never a token.
const isOwner = async (): Promise<boolean> => {
  const admins = readAdminEmails()
  if (admins.size === 0) return true
  const session = await readSession()
  const email = session?.user.email?.trim().toLowerCase()
  return !!email && admins.has(email)
}

// --- Supabase REST helpers --------------------------------------------------
// One call with this feature's auth + a 10s timeout. `path` is appended after
// /rest/v1/<table>; callers branch on status/body. Centralising this keeps the
// auth headers and timeout from drifting between the insert/list/unread paths.
const supabaseFetch = (
  config: FeedbackConfig,
  path: string,
  init: RequestInit = {},
) =>
  fetch(`${config.url}/rest/v1/${config.table}${path}`, {
    ...init,
    headers: {
      apikey: config.key,
      Authorization: `Bearer ${config.key}`,
      ...(init.headers as Record<string, string> | undefined),
    },
    signal: AbortSignal.timeout(10_000),
  })

// Shared 502 for a non-ok Supabase response: log Supabase's reason server-side
// (RLS/schema hints the operator needs) but return a generic message so the url
// and key context never leak to the loopback client.
const badGateway = async (c: Context, res: Response, label: string) => {
  const detail = await res.text().catch(() => '')
  console.error(`[openground:feedback] ${label} supabase ${res.status}: ${detail}`)
  return c.json({ error: `feedback service responded ${res.status}` }, 502)
}

// Shared 502 for a thrown request (network error / timeout / bad body).
const unreachable = (c: Context, label: string, e: unknown) => {
  const msg = e instanceof Error ? e.message : `feedback ${label} failed`
  console.error(`[openground:feedback] ${label} failed`, msg)
  return c.json({ error: 'could not reach feedback service' }, 502)
}

// --- Server-side metadata helpers ------------------------------------------
// App version from package.json (best-effort; never throws). Matches the
// readCurrentVersion pattern in routes/misc.ts.
const readAppVersion = async (): Promise<string> => {
  try {
    const raw = await readFile(join(process.cwd(), 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

// Cheap project count for feedback metadata: just the registry size. Must
// never be slow or fatal, so it avoids scanProjects() (which reads every
// project's .openground/tasks.json).
const countProjects = async (): Promise<number | null> => {
  try {
    const settings = await getSettings()
    return settings.projects?.length ?? 0
  } catch {
    return null
  }
}

const osString = (): string => `${process.platform} ${release()}`.trim()

export const feedbackRoutes = new Hono()
  // --- GET /api/feedback/config ---------------------------------------------
  // Lets the SPA decide what to show. `enabled` gates the "Send feedback" entry
  // (anon key present); `canRead` gates the owner-only "Incoming feedback" inbox
  // (service-role key present AND — when an admin allowlist is set — the signed-in
  // user is on it). Reports only booleans/an opaque id — never the url or key.
  .get('/api/feedback/config', async (c) => {
    const service = readServiceConfig()
    const canRead = service !== null && (await isOwner())
    return c.json({
      enabled: readFeedbackConfig() !== null,
      canRead,
      // Owner-only: lets the client scope its 'last seen' marker per data source.
      ...(canRead && service ? { sourceId: sourceId(service) } : {}),
    })
  })
  // --- GET /api/feedback/list -----------------------------------------------
  // Owner-only inbox: reads submissions with the SERVICE-ROLE key (which alone
  // can SELECT past the insert-only RLS). 503 when no service key is configured
  // — exactly the public build, where the inbox is never shown anyway. Rows are
  // returned ONLY to the loopback client; the key itself never leaves the server.
  .get('/api/feedback/list', async (c) => {
    const config = readServiceConfig()
    if (!config) {
      return c.json({ error: 'feedback reading not configured' }, 503)
    }
    if (!(await isOwner())) {
      return c.json({ error: 'not authorized' }, 403)
    }

    try {
      // Fetch one past the cap so we can flag truncation without a 2nd query.
      const res = await supabaseFetch(
        config,
        '?select=*&order=created_at.desc&limit=201',
      )
      if (!res.ok) return badGateway(c, res, 'list')

      const body = (await res.json()) as unknown
      const rows = Array.isArray(body) ? body : []
      const truncated = rows.length > 200
      const page = truncated ? rows.slice(0, 200) : rows
      // Re-validate each row's images before handing them to the client: `anon`
      // can write arbitrary JSON to the images column (RLS with_check=true), so
      // a crafted row must not crash the inbox (f.images.map on a non-array) or
      // bloat the payload. See sanitizeFeedbackImages.
      const items = page.map((row) =>
        row && typeof row === 'object'
          ? {
              ...(row as Record<string, unknown>),
              images: sanitizeFeedbackImages((row as { images?: unknown }).images),
            }
          : row,
      )
      return c.json({ items, truncated })
    } catch (e) {
      return unreachable(c, 'list', e)
    }
  })
  // --- GET /api/feedback/unread ---------------------------------------------
  // Cheap badge feed for the owner-only "new feedback" dot on the settings gear.
  // Returns just a COUNT (never row bodies) of submissions newer than `since`
  // (an ISO timestamp the client last marked as seen); omit `since` to count
  // all rows. Uses a HEAD + `Prefer: count=exact`, so Supabase reports the total
  // in the Content-Range header without transferring any rows. 503 (like /list)
  // when no service key is configured — the public build never polls this.
  .get('/api/feedback/unread', async (c) => {
    const config = readServiceConfig()
    if (!config) {
      return c.json({ error: 'feedback reading not configured' }, 503)
    }
    if (!(await isOwner())) {
      return c.json({ error: 'not authorized' }, 403)
    }

    const since = c.req.query('since')?.trim()
    const filter = since ? `&created_at=gt.${encodeURIComponent(since)}` : ''

    try {
      // count=exact makes PostgREST put the total after the slash in
      // Content-Range (e.g. "*/12"); HEAD returns no body.
      const res = await supabaseFetch(config, `?select=id${filter}`, {
        method: 'HEAD',
        headers: { Prefer: 'count=exact' },
      })

      // PostgREST answers HEAD count requests with 200 or 206.
      if (!res.ok && res.status !== 206) return badGateway(c, res, 'unread')

      const range = res.headers.get('content-range') || ''
      const total = Number.parseInt(range.split('/')[1] ?? '', 10)
      if (!Number.isFinite(total)) {
        // A 2xx with no usable count means a dropped Prefer header / proxy issue,
        // not "genuinely zero new rows" — log it so the dot's silence is
        // explainable rather than silently swallowed.
        console.error(
          `[openground:feedback] unread: no count in Content-Range "${range}"`,
        )
      }
      return c.json({ count: Number.isFinite(total) ? total : 0 })
    } catch (e) {
      return unreachable(c, 'unread', e)
    }
  })
  // --- POST /api/feedback ---------------------------------------------------
  // zValidator emits a 400 with a clear message on an empty/over-long body
  // BEFORE we touch Supabase. When the env isn't configured we 503 with a
  // clear message so the (rare) client that POSTs anyway gets a useful error.
  .post('/api/feedback', zValidator('json', FeedbackApiBodySchema), async (c) => {
    const config = readFeedbackConfig()
    if (!config) {
      return c.json({ error: 'feedback not configured' }, 503)
    }

    const { message, email, context, images } = c.req.valid('json')

    const [appVersion, projectCount] = await Promise.all([
      readAppVersion(),
      countProjects(),
    ])

    // Persist the UI context WITHOUT assuming a new DB column: prefix the
    // stored message with a parseable tag (e.g. "[ctx:board] …"). Non-breaking
    // with the existing insert-only feedback table — readers can strip the
    // leading "[ctx:…] " to recover the bare message + its source tab.
    const ctx = context?.trim()
    const taggedMessage = ctx ? `[ctx:${ctx}] ${message}` : message

    const row = {
      message: taggedMessage,
      // Normalise an empty/absent email to null so the column stays clean.
      email: email && email.trim() ? email.trim() : null,
      app_version: appVersion,
      os: osString(),
      project_count: projectCount,
      // Inline base64 image attachments (zod-defaulted to []). Goes into the
      // `images` jsonb column added for this feature; sent explicitly rather
      // than leaning on the DB default so the contract is visible here.
      images,
    }

    try {
      const res = await supabaseFetch(config, '', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // We only insert; never read rows back to the loopback client.
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
      })

      if (!res.ok) return badGateway(c, res, 'insert')
      return c.json({ ok: true })
    } catch (e) {
      return unreachable(c, 'insert', e)
    }
  })
