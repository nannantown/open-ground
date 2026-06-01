// Hono node-server entry — the process Electron forks in production and that
// `tsx server/index.ts` runs in dev. This file owns exactly two things: the
// port/host contract and starting the listener. All routing lives in
// `server/app.ts`.
//
// CONTRACT (docs/HONO_MIGRATION_PLAN.md §3.1): fixed port 47776 on 127.0.0.1.
// PORT may be overridden by the launcher's env, but there is NO auto-increment
// fallback — if the port is taken the process fails loudly (matching the
// single-instance launcher's "never silently shift ports" rule). Binding to
// 127.0.0.1 (not 0.0.0.0) keeps this local-only, same as `next dev` here.

import { serve } from '@hono/node-server'
import { app } from './app'

const PORT = Number(process.env.PORT) || 47776
const HOSTNAME = '127.0.0.1'

// G1 crash resilience — process-level last-resort handlers.
//
// The cockpit spawns `claude` PTYs, watches the filesystem, and streams SSE;
// an async failure deep in any of those paths (a rejected promise nobody
// awaited, a throw inside an event-emitter callback) would otherwise tear the
// whole Hono process down and take every live run with it. We log loudly to
// stderr and STAY UP — a single stuck run must never kill the server.
//
// CRITICAL: these handlers must NOT mask a genuine *startup* failure. Binding
// failure (EADDRINUSE on the fixed port 47776) is surfaced separately on the
// server's own 'error' event below, which calls process.exit(1) — that path
// fires before/independently of uncaughtException, so the loud "port taken,
// refuse to start" contract (single-instance launcher rule) is preserved.
process.on('unhandledRejection', (reason) => {
  console.error('[openground:hono] unhandledRejection', reason)
})
process.on('uncaughtException', (err) => {
  console.error('[openground:hono] uncaughtException', err)
})

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOSTNAME }, (info) => {
  // Stable startup line the launcher / log tail can grep for.
  console.log(`[openground:hono] listening on http://${HOSTNAME}:${info.port}`)
})

// Listen errors (chiefly EADDRINUSE on the fixed port) are a TRUE fatal: the
// single-instance contract says we must fail loudly, never silently shift
// ports. Handle them here — distinct from the uncaughtException handler above,
// which only swallows runtime faults — so a failed bind still exits non-zero.
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `[openground:hono] FATAL: port ${PORT} already in use — refusing to start (single-instance contract)`,
    )
  } else {
    console.error('[openground:hono] FATAL: server listen error', err)
  }
  process.exit(1)
})
