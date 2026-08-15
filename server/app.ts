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
import { canvasRoutes } from './routes/canvas'
import { canvasAiRoutes } from './routes/canvasAi'
import { miscRoutes } from './routes/misc'
import { terminalRoutes } from './routes/terminal'
import { swarmRoutes } from './routes/swarm'
import { sseRoutes } from './routes/sse'
import { sdkSessionRoutes } from './routes/sdkSession'
import { feedbackRoutes } from './routes/feedback'
import { authRoutes } from './routes/auth'
import { customModulesRoutes } from './routes/customModules'
import { moduleSubmissionsRoutes } from './routes/moduleSubmissions'
import { collabRoutes } from './routes/collab'
import { youCorpusRoutes } from './routes/youCorpus'
import { personaRoutes } from './routes/persona'
import { personaChatRoutes } from './routes/personaChat'
import { researchRoutes } from './routes/research'
import { originIsLocal, hostIsLocal } from './loopback'

// ── CSRF / cross-origin guard helpers ──────────────────────────────────────
// The loopback predicates live in ./loopback so route modules (e.g.
// routes/youCorpus.ts, which guards its sensitive GETs against DNS rebinding)
// can reuse the EXACT same check without importing this file (app ↔ route cycle).
// See ./loopback for the full threat-model note.

export const createApp = () => {
  const app = new Hono()

  // Request logging — mirrors the visibility `next dev` gave us in the
  // terminal. Cheap, and the launcher tails server.log so this is useful.
  app.use('*', logger())

  // ── CSRF / cross-origin guard ────────────────────────────────────────────
  // Registered BEFORE every sub-router so it runs first. Only STATE-CHANGING
  // methods are guarded: a cross-origin GET response is unreadable without CORS
  // headers (we set none) and EventSource (the terminal SSE stream) is a GET
  // that cannot set headers. For POST/PUT/PATCH/DELETE we reject when an Origin
  // header is present and not loopback (the CSRF case), and — defense against
  // DNS-rebinding, where Origin may be absent — when the Host header is present
  // and not loopback. Requests with NO Origin AND a loopback/absent Host (the
  // local non-browser clients) pass untouched. See the helper note above.
  app.use('*', async (c, next) => {
    const m = c.req.method
    if (m === 'POST' || m === 'PUT' || m === 'PATCH' || m === 'DELETE') {
      const origin = c.req.header('origin')
      if (origin !== undefined && !originIsLocal(origin)) {
        return c.json({ error: 'cross-origin request rejected' }, 403)
      }
      const host = c.req.header('host')
      if (host !== undefined && !hostIsLocal(host)) {
        return c.json({ error: 'invalid host' }, 403)
      }
    }
    // `return next()` (not bare `await next()`): every branch must return a value
    // under noImplicitReturns — the guard branches return a Response, so the
    // pass-through must return next()'s promise too. There is no post-next logic.
    return next()
  })

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
    .route('/', canvasRoutes)    // D — canvas / asset / paste
    .route('/', canvasAiRoutes)  // D2 — canvas AI (generate-elements / tweak-screen)
    .route('/', miscRoutes)      // E — projects / settings / usage
    .route('/', terminalRoutes)  // F — terminal CRUD (dynamic :id)
    .route('/', swarmRoutes)     // F2 — in-app swarm worker spawn + worktree lifecycle
    .route('/', sseRoutes)       // SSE — terminal stream
    .route('/', sdkSessionRoutes) // F3 — Agent SDK worker sessions (docs/SDK_WORKER_MIGRATION_PLAN.md)
    .route('/', feedbackRoutes)  // G — in-app feedback proxy (env-gated)
    .route('/', authRoutes)      // H — optional app login (Supabase Auth, env-gated)
    .route('/', customModulesRoutes) // I — custom tab modules (role-gated; docs/CUSTOM_TABS_PLAN.md)
    .route('/', moduleSubmissionsRoutes) // J — module submission review queue (env-gated; docs/CUSTOM_TABS_PLAN.md)
    .route('/', collabRoutes)    // K — realtime collab gating + per-project resolution (env-gated)
    .route('/', youCorpusRoutes) // L — proxy judgment corpus (you-corpus; local personal state)
    .route('/', personaRoutes)   // L2 — persona courses: score + store + mint into the corpus
    .route('/', personaChatRoutes) // L3 — persona conversation + claude.ai export import (spawns claude)
    .route('/', researchRoutes)  // M — research channels: checker + local-only cookie store

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
    // Self-hosted fonts are also loaded from inside sandboxed srcdoc iframes
    // (Canvas mock/screen — null origin, and font loads are CORS-gated), so
    // /fonts/* needs an explicit ACAO. Loopback-only server, GET-only assets —
    // the wildcard exposes nothing. Vite dev serves public/ with cors:true.
    routed.use('/fonts/*', async (c, next) => {
      await next()
      c.header('Access-Control-Allow-Origin', '*')
    })
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
