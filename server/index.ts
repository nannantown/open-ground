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
import {
  pruneOldAttachments,
  pruneOldRunFiles,
  sweepCrossRepoResidue,
  sweepPersonaScratch,
  RAW_RETENTION_DAYS,
} from '@/lib/server/retention'
import { pruneResolvedEscalations, ESCALATION_RETENTION_DAYS } from '@/lib/server/swarmEscalations'
import { installLockdownFetchGuard } from '@/lib/server/lockdown'
import { getSettings } from '@/lib/server/store'
import { registerIncomingNotifications, createSwarmInfoNotification } from '@/lib/server/swarmNotifications'
import { startStuckProcessWatchLoop } from '@/lib/server/stuckProcessWatch'
import { installGateGroupReaper } from '@/lib/server/gateProcess'
import { checkHomeIntegrity } from '@/lib/server/homeIntegrity'
import { startAutoDrainLoop, bootAutoDrainEnabled, resumeEngines } from '@/lib/server/swarmOrchestrator'
import { ensureCoolingTableLoaded } from '@/lib/server/swarmQuota'
import { warmTierProbeAtBoot } from '@/lib/server/swarmTierProbe'
import { startTerminalSweepLoop } from '@/lib/server/terminal'
import { startDailyFuelReportLoop } from '@/lib/server/dailyFuelReport'
import { startOwnerDeskLimitLoop } from '@/lib/server/ownerDeskLimit'
import { installHooks } from '@/lib/server/hooksInstall'
import { installOgManageSkill } from '@/lib/server/ogManageSkill'
import { installSwarmTooling } from '@/lib/server/swarmToolingInstall'
import { installCompactInstructions } from '@/lib/server/compactInstructionsInstall'

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

// WORK MODE (lockdown) fetch floor — wrap this process's global fetch so that
// while Settings.lockdownMode is ON, any http(s) request to a non-loopback,
// non-Anthropic host throws instead of connecting (src/lib/server/lockdown.ts).
// The per-feature route gates are the first layer; this is the backstop for a
// call site they missed. Installed before boot's own background work so nothing
// can race it; fire-and-forget (never blocks startup — the guard resolves after
// one settings read warms the mirror). Real-server entry only: unit tests mount
// the Hono app and install/uninstall the guard explicitly where they test it.
void installLockdownFetchGuard().catch((e) =>
  console.error('[openground:hono] lockdown fetch guard install failed', e),
)

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOSTNAME }, (info) => {
  // Stable startup line the launcher / log tail can grep for.
  console.log(`[openground:hono] listening on http://${HOSTNAME}:${info.port}`)
})

// Escalation safety valve (INWARD half): listen for electron/main.js asking us to
// create an in-app notification for a self-update rollback / canary failure (events
// only Electron observes). Fail-safe — a no-op unless we're the forked engine with
// an IPC channel (prod). The OUTWARD half (server→Electron OS toast) is osNotify.ts.
registerIncomingNotifications()

// HOME-DATA DAMAGE CHECK — compare settings.json (the project registry) and
// canvas.json (the card layout) against the watermark this check itself recorded
// last boot, and WARN if entries vanished or a test fixture value landed in the
// real home. On 2026-07-18 the registry silently went 45 → 3 entries; nothing
// noticed, and by the time it was found by hand the card layout was already
// unrecoverable. The paired half is homeBackup.ts, which now snapshots both files
// before every overwrite so there is something to point the user at.
//
// READ-ONLY over the files it judges and it NEVER auto-restores (a shrink can be
// a legitimate deletion, and silently reviving removed projects would be the same
// bug pointed the other way) — it warns and lists restore candidates; the choice
// is the owner's. GET /api/home-integrity serves the same report on demand.
//
// Fire-and-forget, never fatal: a check that can crash the cockpit is worse than
// the damage it looks for. It is STARTED first among the boot side-effects, but
// nothing orders it against them — it awaits I/O like everything else here, so
// treat the read as "roughly at boot", never as "before the migration writes".
// Correctness does not depend on that ordering: the backup hook snapshots
// whatever any later writer replaces.
void checkHomeIntegrity().catch((e) =>
  console.error('[openground:hono] home integrity check failed', e),
)

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

// Warm the TOP tier's pre-launch probe verdict (layer E, swarmTierProbe),
// detached: a healthy-tier probe measures 19-73s — far past the 8s a launch
// will wait — so probing once at boot means the first spawn after a restart
// (usually the commander) finds the verdict already recorded instead of
// launching fail-open while the probe still runs. Fire-and-forget by contract:
// runs the claude preflight itself, never throws, never blocks boot.
warmTierProbeAtBoot()

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
    // Persona conversation scratch dirs + their ~/.claude.json trust entries.
    // Nothing in production ends a conversation (there is no moment that means
    // "the owner is finished talking"), so without this sweep every conversation
    // ever held leaves a directory AND a line in the user's own claude config,
    // forever. Boot is the honest lifecycle event.
    const scratch = await sweepPersonaScratch().catch(() => null)
    if (scratch?.removed) {
      console.log(
        `[openground:hono] persona scratch: removed ${scratch.removed} stale conversation dir(s) + trust entries`,
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

// STUCK-PROCESS WATCH — the one machine state OPEN GROUND can create and NOTHING
// can clean up: orphaned subprocesses wedged in uninterruptible sleep (a deleted
// cwd is the known trigger — docs/commander/07-test-isolation-contract.md §7).
// They ignore SIGKILL and survive every app restart, so they accumulate silently
// and surface only as "the machine feels heavy" — 2026-07-28 cost 5h35m of a
// degraded machine before anyone connected symptom to cause. The engineering
// cause is fixed (gitRepoGuard); this closes the DETECTION gap for whatever
// wedges next. Report-only by contract: a restart is the ONLY remedy, so there
// is deliberately no cleanup action (see the module header). Fire-and-forget,
// never blocks boot, silent below the count/age floor and a no-op on Windows.
// PERIODIC, not boot-once (2026-07-29). Boot is the one moment the count is
// guaranteed to be LOW — orphans accumulate WHILE the app runs, so a single
// startup scan reports yesterday's news and then goes blind. Repeats are
// suppressed unless the leak GROWS (STUCK_RENOTIFY_MS), because the set never
// shrinks until a restart and a per-interval bell would train the owner to
// ignore it. Kill-switch: OPENGROUND_STUCK_WATCH=0.
if (process.env.OPENGROUND_STUCK_WATCH !== '0') {
  startStuckProcessWatchLoop(undefined, {
    notify: (detail) =>
      createSwarmInfoNotification({ event: 'stuck-processes', detail }).catch(() => {}),
  })
}

// GATE-CHILD SHUTDOWN REAPER — runGateProcess spawns its vitest/eslint children
// DETACHED (their own process group) so it can group-kill the fork pool. The cost
// is that they also survive US: nothing signals a detached child when the server
// dies, so an Electron quit or a fatal exit mid-gate leaves a whole vitest pool
// running with no parent — and if its worktree is removed underneath it, that is
// the un-killable U-state class of 07 章 §7. Installed HERE ONLY (the real-server
// entry): importing gateProcess inside a vitest worker must not change that
// worker's signal handling. Idempotent, no-op on Windows.
installGateGroupReaper()

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
  // Worker-facing swarm toolkit — /order・/supply スキルと swarm-beat.sh(+openground-swarm-lib.sh)
  // を ~/.claude へ同じ idempotent install で配備する。無いと、OG を新規インストール
  // した環境で spawn した worker が自分の /order も心拍コマンドも解決できない。
  try {
    const results = await installSwarmTooling()
    for (const { name, result: r } of results) {
      if (r.outcome === 'installed' || r.outcome === 'refreshed') {
        console.log(`[openground:hono] swarm tooling ${name} ${r.outcome}: ${r.path}`)
      }
      // adopted = the copy on disk was a PRE-MARKER vintage of our own shipped
      // file (digest-matched, swarmToolingInstall.ts), so it has now been claimed
      // and brought up to date. A one-time transition per file — worth its own
      // line because until it happened those updates were silently not applying.
      if (r.outcome === 'adopted') {
        console.log(`[openground:hono] swarm tooling ${name} adopted (pre-marker copy of ours — now managed + updated): ${r.path}`)
      }
      // kept-user means the shipped source has DRIFTED from the user's copy but we
      // never overwrite it (ownership contract) — log it so that drift is at least
      // visible, instead of silently never surfacing again.
      if (r.outcome === 'kept-user') {
        console.log(`[openground:hono] swarm tooling ${name} kept-user (not overwritten — marker missing): ${r.path}`)
      }
      if (r.outcome === 'error') console.error(`[openground:hono] swarm tooling ${name} install: ${r.error}`)
    }
  } catch (e) {
    console.error('[openground:hono] swarm tooling install failed', e)
  }
  // Context management (docs/CONTEXT_MANAGEMENT_PLAN.md §4) — put the native
  // "Compact Instructions" section into ~/.claude/CLAUDE.md so Claude Code's own
  // compactor keeps the changed files / open work / last test result in the
  // summary. OG writes no compression logic; this only deploys the text. Added
  // once (settings sentinel), version-followed while our marker is there, and a
  // user-authored section of the same kind always wins.
  try {
    const { result: r } = await installCompactInstructions()
    if (r.outcome === 'installed' || r.outcome === 'refreshed') {
      console.log(`[openground:hono] compact instructions ${r.outcome}: ${r.path}`)
    }
    if (r.outcome === 'kept-user') {
      console.log(`[openground:hono] compact instructions kept-user (you already have a "Compact Instructions" section): ${r.path}`)
    }
    if (r.outcome === 'kept-symlink') {
      console.log(`[openground:hono] compact instructions kept-symlink (that path is a symlink — left to your dotfiles setup): ${r.path}`)
    }
    if (r.outcome === 'opted-out') {
      console.log(`[openground:hono] compact instructions opted-out (section removed by hand — leaving it out): ${r.path}`)
    }
    if (r.outcome === 'error') console.error(`[openground:hono] compact instructions install: ${r.error}`)
  } catch (e) {
    console.error('[openground:hono] compact instructions install failed', e)
  }
})()

// ENGINE RESUME (card 2, docs/ENGINE_PERSISTENCE_PLAN.md §4) — re-hydrate any
// registered project whose swarm engine was EXPLICITLY running before this
// boot (that project's engine.json `desiredRunning`, written by
// startOrchestrator/stopOrchestrator). This is DIFFERENT from the AUTO-DRAIN
// loop below: auto-drain is "spin up ANY project sitting on an idle todo",
// strict opt-in via OPENGROUND_SWARM_AUTODRAIN; this is "put back EXACTLY what
// the owner had already turned on", gated by the crash-loop breaker (10-minute
// window / 3 boots same version ⇒ suppress + fatal notify) and by the owner's
// persisted manual-stop record (supremacy — an explicit pause always wins).
//
// GATED ON `process.send` — the SAME "are we the real forked prod engine?"
// test osNotify.ts already uses (sendOsNotification's own doc comment: "in dev
// tsx, vitest, or a bare node run there is no parent listening"). Only the
// packaged app's Electron-forked server has that IPC channel; `tsx watch`
// (`npm run dev` / `dev:server` / `electron:dev`) re-executes this ENTIRE
// module on every file save, and without this gate that would mean: (a) real
// claude PTYs spawn on every dev save for a project the developer had ON, (b)
// a normal save cadence (a few per 10 minutes) trips the crash-loop breaker
// and spams a fatal bell + OS toast, worsening every single save after the
// first three. Both would land on the DEVELOPER, not a real crash scenario —
// this module's own dev workflow was the one at risk, exactly the thing card 2
// must never make worse. Fire-and-forget after boot; resumeEngines() is
// fail-quiet-to-OFF per project and never throws.
if (typeof process.send === 'function') {
  void resumeEngines().catch((e) => console.error('[openground:hono] engine resume failed', e))
}

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
// process-wide, role-INDEPENDENT spawn switch that can start a project the owner has
// NEVER turned on. (card 2's resumeEngines() above is a DIFFERENT kind of switch —
// it never starts anything the owner did not already opt into for that SPECIFIC
// project, so it does not need this same "unset ⇒ off" default; the two are
// deliberately not the same gate. Neither is a security boundary on its own — see
// swarmGate.ts's "feature-VISIBILITY flag, not a security boundary" — this comment
// is about accidental auto-run, not about bypassing the owner gate.)
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

// DAILY FUEL REPORT loop (card swarm-token-blocked) — the once-a-day,
// DETERMINISTIC (zero-LLM, read-only) self-analysis of the swarm's session
// JSONLs: a plain-language report to the bell every day at 09:00 local, plus —
// on a degraded day only — one improvement-proposal card filed into the Board's
// blocked column (owner approval = moving it to todo; the engine never
// dispatches from blocked). Runs on APP uptime like the retention sweep —
// independent of the swarm engine being on. Same wiring contract as the loops
// above: real-server entry only, unref'd, reload-safe, kill-switch env.
if (process.env.OPENGROUND_FUEL_REPORT !== '0') {
  startDailyFuelReportLoop()
}

// OWNER-DESK MODEL-LIMIT watch — tells the owner when one of THEIR OWN claude
// conversations (Terminal tab pane, Board 実行, commander / supply desk) stopped
// because the model's usage limit was reached. Engine-INDEPENDENT on purpose: the
// swarm rescues the workers it manages, so the desks left silent are precisely the
// ones with no engine watching (the 2026-07-18 event). Notify-only — it never
// touches the conversation. Same boot-loop shape as the sweep above (unref'd,
// reload-safe, this entry only). Kill-switch: OPENGROUND_DESK_LIMIT_WATCH=0.
if (process.env.OPENGROUND_DESK_LIMIT_WATCH !== '0') {
  startOwnerDeskLimitLoop()
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
