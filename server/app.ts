// Hono app factory — the single place where the backend's middleware and
// sub-routers are wired together. Kept separate from `server/index.ts` (the
// node-server entry) so tests can import the bare `app` and exercise routes via
// `app.request('/api/...')` without binding a TCP port.
//
// Migration note (docs/HONO_MIGRATION_PLAN.md): route handlers are *thin
// adapters*. They translate Hono's `c.req` / `c.json` to the existing
// `src/lib/server/*` logic and back — they never reimplement business logic.
// Mount every sub-router here with `app.route('/', router)`; each router owns
// its own `/api/...` paths so the mount prefix stays empty.

import { Hono } from 'hono'
import { logger } from 'hono/logger'
import { serveStatic } from '@hono/node-server/serve-static'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { health } from './routes/health'
import { projectRoutes } from './routes/project'
import { shareRoutes } from './routes/share'
import { canvasRoutes } from './routes/canvas'
import { miscRoutes } from './routes/misc'
import { terminalRoutes } from './routes/terminal'
import { sseRoutes } from './routes/sse'
import { feedbackRoutes } from './routes/feedback'
import { authRoutes } from './routes/auth'
import { voiceRoutes } from './routes/voice'

export const createApp = () => {
  const app = new Hono()

  // Request logging — mirrors the visibility `next dev` gave us in the
  // terminal. Cheap, and the launcher tails server.log so this is useful.
  app.use('*', logger())

  // Centralized error handler. Route handlers may `throw` (or let
  // src/lib/server helpers throw); everything funnels here so we emit a
  // consistent JSON error shape instead of leaking a stack to the client.
  // Individual routes that need a specific status (400/403/404/409) should
  // still return `c.json({ error }, status)` directly — this is the safety net.
  app.onError((err, c) => {
    console.error('[openground:hono] unhandled error', err)
    return c.json({ error: err instanceof Error ? err.message : 'internal error' }, 500)
  })

  // ── Sub-router mount points ──────────────────────────────────────────────
  // health is the only contract that must exist from Phase 0. The remaining
  // routes (REST groups A–F, SSE x3) are mounted here during the Integration
  // phase. Each is a Hono sub-router exporting its own `/api/...` paths, e.g.
  //
  //   import { projectRoutes } from './routes/project'
  //   app.route('/', projectRoutes)
  //
  //   import { terminalRoutes } from './routes/terminal'   // dynamic + SSE
  //   app.route('/', terminalRoutes)
  //
  // Keep the empty-prefix convention: routers declare full `/api/...` paths.
  // Each router declares its own full /api/... paths, so the mount prefix
  // stays empty ('/'). Hono matches in registration order, but because every
  // path is fully spelled out there are no prefix collisions between groups.
  // The SSE router is mounted alongside the REST ones — its streaming path
  // (/api/terminal/:id/stream) is distinct from any REST path so order is moot.
  //
  // `app.route()` returns `this`, so the mounts are CHAINED: this threads each
  // sub-router's (now method-chained) route tree into `typeof app`, which is
  // what `export type AppType` captures. That is what lets `hc<AppType>` on the
  // client recover every route's path + body types (see src/lib/api-client.ts).
  // The capture is the chain's return value (`routed`), NOT the bare `app`
  // binding above — `new Hono()` alone is typed with an empty schema.
  const routed = app
    .route('/', health)
    .route('/', projectRoutes)   // A — project / tasks / canvases
    .route('/', shareRoutes)     // C — git-shared data (status / sync)
    .route('/', canvasRoutes)    // D — canvas / asset / paste
    .route('/', miscRoutes)      // E — projects / settings / usage
    .route('/', terminalRoutes)  // F — terminal CRUD (dynamic :id)
    .route('/', sseRoutes)       // SSE — terminal stream
    .route('/', feedbackRoutes)  // G — in-app feedback proxy (env-gated)
    .route('/', authRoutes)      // H — optional app login (Supabase Auth, env-gated)
    .route('/', voiceRoutes)     // I — voice dictation (whisper.cpp STT)

  // Any /api/* not matched above is a genuine API 404 — it must NOT fall
  // through to the SPA static handler below (which would return index.html
  // HTML for a missing API route and break clients that expect JSON).
  routed.all('/api/*', (c) => c.json({ error: 'not found' }, 404))

  // ── Static SPA (production) ──────────────────────────────────────────────
  // In dev the Vite dev server hosts index.html + HMR and proxies /api here, so
  // there is nothing to serve. In prod the Vite build (dist-web/) is served by
  // Hono so the whole app is one origin on the fixed port — `next start` is
  // gone. OPENGROUND_WEB_ROOT lets the Electron launcher point at the shipped
  // dist-web under resourcesPath; otherwise we fall back to <cwd>/dist-web.
  //
  // Mounted AFTER every /api route so it never shadows the API. Any non-/api,
  // non-asset path that 404s on disk falls back to index.html (history API).
  const webRoot = process.env.OPENGROUND_WEB_ROOT || resolve(process.cwd(), 'dist-web')
  if (existsSync(webRoot)) {
    routed.use('/*', serveStatic({ root: webRoot }))
    // SPA fallback: serve index.html for any unmatched GET that isn't /api.
    routed.get('*', serveStatic({ path: 'index.html', root: webRoot }))
  }

  // Return the CHAINED instance (same object as `app`, but its static type now
  // carries every mounted route). `typeof app` (the bare `new Hono()`) has an
  // empty schema; `typeof routed` is what `hc<AppType>` needs.
  return routed
}

export const app = createApp()
export type AppType = typeof app
