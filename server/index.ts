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
import { pruneOldAttachments, pruneOldRunFiles, RAW_RETENTION_DAYS } from '@/lib/server/retention'
import { getSettings } from '@/lib/server/store'
import { registerIncomingNotifications } from '@/lib/server/swarmNotifications'
import { startAutoDrainLoop } from '@/lib/server/swarmOrchestrator'
import { startTerminalSweepLoop } from '@/lib/server/terminal'

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

// Escalation safety valve (INWARD half): listen for electron/main.js asking us to
// create an in-app notification for a self-update rollback / canary failure (events
// only Electron observes). Fail-safe — a no-op unless we're the forked engine with
// an IPC channel (prod). The OUTWARD half (server→Electron OS toast) is osNotify.ts.
registerIncomingNotifications()

// Retention sweep — drop the raw episodic layer (run cache + attachments) older
// than RAW_RETENTION_DAYS. Fire-and-forget after boot so it never blocks
// startup or crashes the process.
void (async () => {
  try {
    const removedRuns = await pruneOldRunFiles()
    const settings = await getSettings()
    let removedFiles = 0
    for (const p of settings.projects ?? []) {
      removedFiles += await pruneOldAttachments(p.path).catch(() => 0)
    }
    if (removedRuns || removedFiles) {
      console.log(
        `[openground:hono] retention(${RAW_RETENTION_DAYS}d): pruned ${removedRuns} run files, ${removedFiles} attachments`,
      )
    }
  } catch (e) {
    console.error('[openground:hono] retention sweep failed', e)
  }
})()

// AUTO-DRAIN background loop (card cf545637) — the UI-INDEPENDENT server-side tick that
// auto-starts any registered project's stopped engine sitting on a todo backlog + idle
// slot, so a todo added with NO swarm UI open still drains (the complete deadlock fix; the
// Swarm-pane drain-tick only covers the mounted-pane case). Reuses maybeAutoStartDrain's
// cap / manualStop / preflight / twin-dispatch guards — it can't over-spawn, override an
// explicit OFF, or double-drive a running engine. Started ONLY in this real-server entry
// (unit tests mount the Hono app, not this file), unref'd, idempotent.
//
// DEFAULT OFF (card eadb25e6 — release blocker): merely LAUNCHING the app must NOT
// auto-spawn workers across every registered project. Boot-time auto-drain is now
// STRICT OPT-IN — enable the global (all-projects) boot loop explicitly with
// OPENGROUND_SWARM_AUTODRAIN=1, or turn a SINGLE project's drain on at runtime from the
// Swarm UI (POST /api/swarm/orchestrator/start, owner-only → startOrchestrator(path)).
// No opt-in ⇒ no background drain, so a fresh install or a plain relaunch stays completely
// idle until the user explicitly asks for the swarm.
if (process.env.OPENGROUND_SWARM_AUTODRAIN === '1') {
  startAutoDrainLoop()
}

// TERMINAL-POOL sweep background loop — the UI-INDEPENDENT safety net that reaps
// dead PTY pool entries the happy-path 30s onExit timer can't: a reload-orphaned
// EXITED entry (the globalThis sessions Map survives a `tsx watch` reload but its
// pending setTimeout does not) and an ORPHAN (a PTY killed out-of-band whose
// node-pty onExit never fired, so it lingers as a PHANTOM "terminal active" beacon
// on a Ground card forever). Active-swarm-independent — a plain terminal user gets
// the cleanup too. Same pattern as the auto-drain loop above: started ONLY in this
// real-server entry (unit tests mount the Hono app, not this file), unref'd,
// reload-safe. Kill-switch: OPENGROUND_TERMINAL_SWEEP=0 disables it (default ON).
if (process.env.OPENGROUND_TERMINAL_SWEEP !== '0') {
  startTerminalSweepLoop()
}

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
