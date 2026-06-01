// Typed Hono RPC client (`hc`) for the OPEN GROUND backend.
//
// WHY THIS EXISTS
// ---------------
// The frontend talks to the Hono server over the same fixed-port contract the
// rest of the app relies on (127.0.0.1:47776 — see server/index.ts and the
// launcher in scripts/openground-launch.sh). Historically every call site used
// a raw `fetch('/api/...')` string. `hc<AppType>` lets us call the backend with
// compile-time-checked paths and (where the server route is chained) typed
// request/response bodies, so a renamed or removed route becomes a tsc error
// instead of a 404 at runtime.
//
// BASE URL
// --------
// In the browser the SPA is served from the same origin as the API (Hono serves
// dist-web in prod; the Vite dev server proxies /api → 47776 in dev), so a
// relative base ('') keeps every request same-origin and avoids CORS. We do NOT
// hard-code http://127.0.0.1:47776 here: that would break the dev proxy and the
// production single-origin model. The fixed-port contract is owned by the
// server/launcher, not the client.
//
// TYPE-INFERENCE CAVEAT (IMPORTANT — read before converting more call sites)
// --------------------------------------------------------------------------
// `hc<AppType>` only recovers a route's *path + body* types when that route is
// declared with Hono's METHOD-CHAINING style on the router instance, i.e.
//
//   export const r = new Hono()
//     .get('/api/x', ...)
//     .post('/api/y', ...)
//
// The routers in server/routes/*.ts are now chained (and app.ts chains the
// mounts), so `AppType` carries the full route tree: `api.api.health.$get`,
// `api.api.run.list.$get`, etc. all type-check and a renamed/removed route is a
// tsc error instead of a runtime 404.
//
// USAGE NOTES (for the next person converting fetch() → api.*):
//  - GET: `api.api.usage.$get({}, { init: { cache, signal } })`. Query params go
//    in the first arg: `api.api.project.$get({ query: { path } })`.
//  - POST: `api.api.run.cancel.$post({ json: body })`.
//  - Routes validated with `zValidator('json', schema)` (e.g. /api/run/cancel)
//    expose a TYPED request body; routes that read `c.req.json()` raw accept the
//    body loosely. Response `.json()` is typed where the route's `c.json(...)`
//    shape is inferable, and `unknown` otherwise — cast at the call site to keep
//    the previous behaviour (the old `fetch().json()` was `any`).
//  - SSE / EventSource endpoints (/api/run/events, /api/terminal/:id/stream,
//    /api/screen/watch) are NOT hc targets — keep them on raw fetch/EventSource.

import { hc } from 'hono/client'
import type { AppType } from '../../server/app'

// Same-origin base. Empty string = relative URLs, which is correct for both the
// Vite dev proxy and the prod single-origin serve. Override via env only if a
// future split-origin deployment needs it.
export const API_BASE = ''

export const api = hc<AppType>(API_BASE)

export type Api = typeof api
