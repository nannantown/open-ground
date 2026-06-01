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
import { zValidator } from '@hono/zod-validator'
import { readFile, readdir } from 'fs/promises'
import { join } from 'path'
import { release } from 'os'
import { getSettings } from '@/lib/server/store'
import { FeedbackApiBodySchema } from '@/lib/schemas'

// --- Env-driven configuration ----------------------------------------------
// Read lazily (per request) rather than frozen at module load so the operator
// can set the vars and restart the server without a code change taking effect
// — and so tests can flip them with vi.stubEnv between cases.
interface FeedbackConfig {
  url: string
  anonKey: string
  table: string
}

const readFeedbackConfig = (): FeedbackConfig | null => {
  const url = process.env.SUPABASE_URL?.trim()
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim()
  if (!url || !anonKey) return null
  const table = process.env.SUPABASE_FEEDBACK_TABLE?.trim() || 'feedback'
  return { url: url.replace(/\/+$/, ''), anonKey, table }
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

// Cheap project count: count immediate subdirectories of projectsRoot
// (skipping dotfolders + the archive sentinel). This deliberately avoids
// scanProjects() — which reads every project's .openground/tasks.json — since
// feedback metadata only needs a rough number and must never be slow or fatal.
const countProjects = async (): Promise<number | null> => {
  try {
    const settings = await getSettings()
    if (!settings.projectsRoot) return null
    const entries = await readdir(settings.projectsRoot, { withFileTypes: true })
    let n = 0
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.')) continue
      if (e.name === settings.archiveDirName) continue
      n++
    }
    return n
  } catch {
    return null
  }
}

const osString = (): string => `${process.platform} ${release()}`.trim()

export const feedbackRoutes = new Hono()
  // --- GET /api/feedback/config ---------------------------------------------
  // Lets the SPA decide whether to show the "Send feedback" entry. Reports only
  // a boolean — never echoes the URL or key back to the client.
  .get('/api/feedback/config', (c) => {
    return c.json({ enabled: readFeedbackConfig() !== null })
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

    const { message, email } = c.req.valid('json')

    const [appVersion, projectCount] = await Promise.all([
      readAppVersion(),
      countProjects(),
    ])

    const row = {
      message,
      // Normalise an empty/absent email to null so the column stays clean.
      email: email && email.trim() ? email.trim() : null,
      app_version: appVersion,
      os: osString(),
      project_count: projectCount,
    }

    try {
      const res = await fetch(`${config.url}/rest/v1/${config.table}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: config.anonKey,
          Authorization: `Bearer ${config.anonKey}`,
          // We only insert; never read rows back to the loopback client.
          Prefer: 'return=minimal',
        },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(10_000),
      })

      if (!res.ok) {
        // Surface Supabase's reason in the server log (it may contain RLS /
        // schema hints the operator needs) but return a generic message to the
        // client so we never leak the URL/key context downstream.
        const detail = await res.text().catch(() => '')
        console.error(`[openground:feedback] supabase ${res.status}: ${detail}`)
        return c.json({ error: `feedback service responded ${res.status}` }, 502)
      }

      return c.json({ ok: true })
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'feedback request failed'
      console.error('[openground:feedback] forward failed', msg)
      return c.json({ error: 'could not reach feedback service' }, 502)
    }
  })
