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
import { pruneOldAttachments, pruneOldRunFiles, sweepCrossRepoResidue, RAW_RETENTION_DAYS } from '@/lib/server/retention'
import { pruneResolvedEscalations, ESCALATION_RETENTION_DAYS } from '@/lib/server/swarmEscalations'
import { getSettings } from '@/lib/server/store'
import { registerIncomingNotifications } from '@/lib/server/swarmNotifications'
import { startAutoDrainLoop, bootAutoDrainEnabled } from '@/lib/server/swarmOrchestrator'
import { ensureCoolingTableLoaded } from '@/lib/server/swarmQuota'
import { startTerminalSweepLoop } from '@/lib/server/terminal'
import { installHooks } from '@/lib/server/hooksInstall'
import { installOgManageSkill } from '@/lib/server/ogManageSkill'

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

// QUOTA COOLING TABLE — hydrate the persisted marks (~/.openground/swarm-quota.json)
// into swarmQuota's in-memory table. Without this the app forgets, on every single
// launch, which model tiers were dry — and since a launch usually follows a
// release, it re-learned the fact the expensive way: dispatch on fable → hit the
// limit screen → cool. One burned session per restart (observed 2026-07-13, 0.11.25).
//
// Fire-and-forget: the load is fail-safe (an unreadable / corrupt file yields NO
// cooling plus one log line — never a throw), so it cannot block or crash startup,
// and the quota routes await the SAME memoized promise before they answer — so
// there is no window where a read beats the hydration. Elapsed marks are dropped
// as they load (lazy expiry, same rule as isTierCooling), so a stale file can only
// ever cool LESS, never more.
void ensureCoolingTableLoaded(Date.now())

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
    // Escalations inbox (C1): RESOLVED records only — an unanswered ('open')
    // escalation is never pruned regardless of age (fail-closed, §8).
    const removedEscalations = await pruneResolvedEscalations().catch(() => 0)
    if (removedRuns || removedFiles || removedEscalations) {
      console.log(
        `[openground:hono] retention(${RAW_RETENTION_DAYS}d): pruned ${removedRuns} run files, ${removedFiles} attachments; ` +
          `escalations(${ESCALATION_RETENTION_DAYS}d): pruned ${removedEscalations} resolved`,
      )
    }
    // Cross-repo residue sweep — ghost heartbeats / orphan central worktrees /
    // unregistered data dirs. Repo-agnostic on purpose: the per-repo janitor
    // only runs while a cockpit is open in that repo, so leftovers in repos the
    // user stopped opening would otherwise linger forever.
    const residue = await sweepCrossRepoResidue().catch(() => null)
    if (
      residue &&
      (residue.heartbeats.removedFiles.length ||
        residue.heartbeats.removedDirs.length ||
        residue.worktrees.removed.length)
    ) {
      console.log(
        `[openground:hono] residue sweep: removed ${residue.heartbeats.removedFiles.length} ghost heartbeat(s), ` +
          `${residue.heartbeats.removedDirs.length} empty heartbeat dir(s), ` +
          `${residue.worktrees.removed.length} orphan worktree dir(s)`,
      )
    }
  } catch (e) {
    console.error('[openground:hono] retention sweep failed', e)
  }
})()

// HOOK INSTALL — idempotently wire OPEN GROUND's Claude Code hooks into the
// user's ~/.claude/settings.json at boot. This is the ONLY automatic caller
// (the /api/observer/install-hooks route exists for manual re-install, but
// nothing invokes it), so without this the hooks are never installed:
//   - the observer's SessionStart/Stop/PostToolUse markers (openground-hook.js), and
//   - the A3 PreToolUse DETERMINISTIC DENY VETO (openground-guard.js) — the one
//     block that survives `--dangerously-skip-permissions`. A hook that isn't in
//     settings.json is a hook Claude Code never runs, and a MISSING PreToolUse
//     guard fails OPEN (Claude Code treats a non-exit-2 hook as non-blocking), so
//     an unwired guard means a bypass swarm worker runs with NO deterministic
//     veto. Installing at boot makes the veto present by default (the sandbox
//     experiment L3 is owner-only/off, so on a default install L4 is the layer).
//     Boot install is only the FIRST line, though (GAP-2): the worker spawn path
//     re-verifies the full wiring itself and REFUSES to spawn when it cannot be
//     proven (ensureGuardWiring in spawnSwarmWorker — fail-closed), so a failure
//     here degrades to "workers refuse to start" + a bell notification, never to
//     an unguarded worker.
// Fire-and-forget after boot (never blocks/crashes startup); installHooks copies
// the guard to the sandbox-write-denied ~/.openground/guard/ and upserts the
// PreToolUse entries idempotently, preserving any user-authored hooks. Runs ONLY
// in this real-server entry (unit tests mount the Hono app, not this file).
void (async () => {
  try {
    const r = await installHooks()
    const touched = [...r.installed, ...r.refreshed]
    if (touched.length) console.log(`[openground:hono] hooks installed/refreshed: ${touched.join(', ')}`)
    if (r.errors.length) console.error(`[openground:hono] hook install errors: ${r.errors.join('; ')}`)
  } catch (e) {
    console.error('[openground:hono] hook install failed', e)
  }
  // The og-manage skill (the tmux-free in-app commander protocol) — same
  // boot-time idempotent install as the hooks above: the commander PTY
  // (POST /api/swarm/manager) hands claude `/og-manage`, which only resolves
  // if ~/.claude/skills/og-manage/SKILL.md exists. A user-authored file
  // (marker removed) is never overwritten; errors are logged, never fatal.
  try {
    const s = await installOgManageSkill()
    if (s.outcome === 'installed' || s.outcome === 'refreshed') {
      console.log(`[openground:hono] og-manage skill ${s.outcome}: ${s.path}`)
    }
    if (s.outcome === 'error') console.error(`[openground:hono] og-manage skill install: ${s.error}`)
  } catch (e) {
    console.error('[openground:hono] og-manage skill install failed', e)
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
// idle until the user explicitly asks for the swarm. The predicate is the exported
// `bootAutoDrainEnabled` (pinned by a regression test to "unset ⇒ off"): it is the only
// process-wide, role-INDEPENDENT spawn switch, so its default is what protects a
// non-owner user from any launch-time auto-run.
if (bootAutoDrainEnabled()) {
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
