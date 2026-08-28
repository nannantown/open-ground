// swarmOrchestrator — the COMMANDER (司令官) engine: the in-app, server-side
// replacement for what the tmux `/manage` cockpit does BY HAND every few
// minutes — pull the oldest Board:todo card and dispatch it to a fresh worker.
// This is STAGES ①+② of the engine (project_inapp_swarm_port, Phase 2):
//
//   ① drain + dispatch.  todo → (spawn worker) → doing.
//   ② monitor + advance.  doing → review, when a worker is judged DONE.
//
// Integration (review → done) is a LATER stage that builds on this same engine —
// so the loop, the per-project state, and the globalThis seam here are
// intentionally shaped to grow, not to be torn out.
//
// MONITORING (Card②)
//   Every pass also re-examines each dispatched worker and advances its coarse
//   `stage` (starting → running → done). It judges a worker DONE — and only then
//   moves its card doing→review (recording the branch as the integration handle
//   the review stage reads) — CONSERVATIVELY: there must be integrable commits on
//   the worker's branch AND a completion sign (the worker's heartbeat reports
//   readyToMerge, or its PTY exited and the heartbeat is not blocked). A worker
//   that crashed with nothing committed, or that is merely mid-flight, is left in
//   'doing' — the engine never promotes broken/ambiguous work to review. The
//   per-worker stage is surfaced verbatim by the state API for the UI.
//
// HOW IT RUNS
//   - One ProjectEngine per project, keyed by the canonical project path, held
//     on a globalThis singleton (like the terminal pool / role cache) so a
//     `tsx watch` reload doesn't lose the running flag or the worker set.
//   - While `running`, a setTimeout CHAIN (never setInterval — the next pass is
//     scheduled only AFTER the current one finishes, so a slow pass can never
//     overlap itself) calls runDispatchPass every TICK_MS.
//   - OFF ⇒ the chain stops and nothing dispatches. The existing MANUAL worker
//     spawn (POST /api/swarm/worker, the Swarm UI button) is untouched — the
//     engine only ADDS an autonomous driver beside it.
//
// CONCURRENCY CAP
//   The engine never has more than ORCHESTRATOR_MAX_WORKERS *live* workers of
//   ITS OWN (mirrors the Swarm UI's MAX_WORKERS). A worker's `claude` PTY
//   exiting frees its slot (the engine prunes it); the next pass pulls the next
//   todo to refill. Advancing an exited worker's card past 'doing' is the later
//   monitoring/integration stages' job — this stage leaves the column where it
//   put it.
//
// SUBSCRIPTION-ONLY
//   Dispatch goes through spawnSwarmWorker → launchClaude — an interactive
//   `claude` PTY, never `claude -p` / the SDK. The default spawn dep runs the
//   shared claude preflight first, so a missing/signed-out CLI fails the
//   dispatch (logged) instead of orphaning a worktree on a doomed OAuth browser.
//
// BOARD ACCESS
//   Reads + the todo→doing column move go through the project's EXISTING Board
//   HTTP API on 127.0.0.1 (the same surface swarm-board.sh / the Swarm UI use) —
//   the engine never reaches into projectData internals, so it shares one board
//   seam with the future stages and inherits the route's CAS write. All of
//   fetchTodos / moveToDoing / spawnWorker / isAlive are INJECTABLE (OrchestratorDeps)
//   so the loop is unit-tested with fakes; the real self-fetch path is exercised
//   live (like the worker happy-path).
//
// OWNERSHIP / GATING lives in the route layer (server/routes/swarm.ts): start /
// stop / state are owner-only + validateProjectPath, exactly like the rest of
// /api/swarm/*. By the time a call reaches this module the caller is the owner
// and the path is a registered project.

import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { readFile, readdir, stat, lstat, symlink, unlink, mkdir } from 'fs/promises'
import { join, resolve, dirname, basename } from 'path'
import { createHash, randomUUID } from 'crypto'
import { canonicalize } from './canonicalize'
import { atomicWriteJson } from './atomicWrite'
// The fork-pool group reaper. It lives in a leaf module (not here) because
// swarmSelfSupply — which this module imports — needs the same reaper for its
// vitest/eslint scanners, and a back-import would close a cycle. Re-exported
// below so existing importers of `runGateProcess` keep their path.
import { runGateProcess, withGateEnv } from './gateProcess'
// The SCREEN model — read-only, client-safe, and shared with the ctx gauge's manual
// compact button (claudeSlash.ts). `isGenerating` is what lets the NOTICE channel be
// fast without being destructive; `readInputBoxText` is what replaces its ESC.
import { isGenerating, readInputBoxText } from '@/lib/claudeScreen'
// The numbered-option chooser detector the terminal pool already uses for `menuOpen`.
// While a menu is up, keystrokes are SELECTION — a notice would pick an option.
import { detectMenu } from '@/lib/claudeMenu'
import { openGroundHome } from './paths'
import {
  claudeSessionActivity,
  type ClaudeSessionActivity,
  getTerminal,
  getTerminalScreen,
  killTerminal,
  waitForTerminalGone,
  listLiveDesksIn,
  isTerminalProcessAlive,
  type OwnerDeskTerminal,
  subscribeTerminal,
  writeInput,
} from './terminal'
// The SDK pool's half of worker teardown. The engine reaches the RUNTIME through
// workerRuntime's adapters everywhere else; these two are needed directly because
// defaultRecoverWorker is handed ids, not a WorkerHandle, and must stop whichever
// runtime the id belongs to before it touches the worktree.
import { terminateSdkSession, isSdkSessionReaped, getSdkSession } from './sdkSession'
import { stopAllDesksInDirAndWait } from './liveDesks'
import { claudeRunPreflight } from './claudePreflight'
// card 2 (docs/ENGINE_PERSISTENCE_PLAN.md) — engine intent write-through +
// boot-time crash-loop breaker. See resumeEngines() below.
import {
  readEngineIntent,
  writeEngineIntent,
  patchEngineIntent,
  recordEngineBoot,
  isCrashLoopTripped,
} from './swarmEnginePersistence'
// card 3 (docs/ENGINE_PERSISTENCE_PLAN.md §3/§4-3) — worker roster write-through +
// boot reconcile (reconcile-first, spawn frozen). See syncRoster() + resumeEngines().
import {
  reconcileRoster,
  removeRosterEntry,
  readRoster,
  writeRoster,
  // orchestrator already has a by-BRANCH defaultWorktreeExists (line ~3185); the
  // roster probe is by raw PATH — alias to avoid the name clash.
  defaultWorktreeExists as rosterWorktreeExists,
  type RosterEntry,
  type RosterReconcileDeps,
  type RosterReconcileResult,
} from './swarmWorkerRoster'
// card 4 (ENGINE_PERSISTENCE_PLAN §5) — the SHARED transcript-loadable proof (same
// one swarmSessions' isSessionResumable uses), with the SIGKILL-orphan mtime guard
// enabled for the worker resume path. See adoptResumeCandidates().
import { proveTranscriptLoadable, ORPHAN_MTIME_WINDOW_MS } from './swarmTranscriptProof'
import { recordPromoted, sweepLanded } from './swarmLandedLedger'
// App version, read from package.json at BUILD time (same pattern as
// server/routes/health.ts) — the crash-loop breaker keys its window on it so a
// self-update's own cutover restarts don't count against the NEW build.
import { version as APP_VERSION } from '../../../package.json'
import {
  getSettings,
  getExecutionMode,
  getAllowedModelTiers,
  rememberSwarmAutonomy,
  forgetSwarmAutonomy,
  isSwarmAutonomyRemembered,
  rememberSwarmManualStop,
  forgetSwarmManualStop,
  isSwarmManualStopPersisted,
} from './store'
import { launchClaude } from './claudeTerminal'
import {
  runtimeOf,
  workerKey,
  workerRuntimeKind,
  type WorkerHandle,
  type WorkerRuntimeKind,
} from './workerRuntime'
import { removeClaudeFolderTrust } from './claudeTrust'
import { SWARM_LAUNCH_MODEL, execModeMaxWorkers, resolveAvailableTierProbed } from './swarmLaunch'
// The limit-wording detector, extracted to swarmRateLimitText.ts (2026-07-13) so
// the pre-launch tier probe shares it — see the re-export further down.
import { endsInRateLimit } from './swarmRateLimitText'
// [Quota] the engine is BOTH sides of the quota loop now: the rate-limit
// sighting in monitorWorkers is the swarm's SENSOR (markRateLimited — the one
// production write into the cooling table, attributing the sighting to the tier
// the worker launched on), and runDispatchPass / the reviewer panel are the
// ACTUATORS (the spawnBlock park gate). MODEL_TIER_LADDER narrows the recorded
// launch model to a known tier; an off-ladder / unrecorded model holds the
// worker exactly as before but marks nothing (never poison a tier by guess).
import { markRateLimited, isModelTier, MODEL_TIER_LADDER, ensureCoolingTableLoaded } from './swarmQuota'
// [Allowed] the owner's PERMANENT per-tier ON/OFF switch — the second, independent
// veto. `spawnBlock` ANDs it with the cooling table and is the ONE gate both
// actuators (dispatch + reviewer panel) consult, so a tier the owner retired can
// never be launched on by either. Unlike a cool it has no reset, so a swarm parked
// on 'none-allowed' escalates to a human instead of waiting for a clock.
import { spawnBlock, type SpawnBlock } from './swarmAllowedModels'
// A5 usage sensor, SYNC cache peek only (never awaited, never refreshed here) —
// the second-priority reset-time source markRateLimited resolves against when
// the worker's own screen wording didn't carry one.
import { peekCachedUsage } from './claudeUsageCli'
import {
  spawnSwarmWorker,
  removeSwarmWorktree,
  swarmWorktreeDirName,
  ensureSwarmWorktreeForBranch,
  type ReusableWork,
} from './swarmWorker'
import { SdkWorkerUnavailableError } from './swarmWorkerSdk'
import { centralWorktreesDir } from './paths'
import { liveDeskOccupies } from './liveDesks'
import { projectUUIDFromPath } from './projectDataPath'
import { appendEngineJournalLine } from './engineJournal'
import {
  resolveTarget,
  fetchTarget,
  classifyBranch,
  integrateBranch,
  isSwarmBranch,
  type ReviewReadiness,
  type IntegrateOutcome,
} from './swarmIntegrate'
import { acquireIntegrationLock, type AcquireIntegrationLockResult } from './swarmIntegrationLock'
import {
  initSelfSupplyRuntime,
  kickSelfSupplyPass,
  type SelfSupplyDeps,
  type SelfSupplyRuntime,
} from './swarmSelfSupply'
import { detectWorkerFreeTextQuestion } from './swarmQuestions'
import {
  defaultReceiptKey,
  deliverAnswerToWorker,
  openEscalation,
  type OpenEscalationInput,
} from './swarmEscalations'
import {
  runOverseerPass,
  initOverseerRuntime,
  defaultOverseerDeps,
  type OverseerRuntime,
} from './swarmOverseer'
import type {
  OrchestratorAnomaly,
  OrchestratorLogLine,
  OrchestratorReview,
  OrchestratorReviewStatus,
  OrchestratorWorker,
  OrchestratorWorkerStage,
  ProjectData,
  ProjectTask,
  SpawnSwarmWorkerResponse,
  SwarmConsumption,
  SwarmKpis,
  SwarmManagerHeartbeat,
  SwarmManagerPresence,
  SwarmOrchestratorState,
  SwarmFatalNotification,
} from '../types'
import { createSwarmFatalNotification, createSwarmInfoNotification } from './swarmNotifications'
// Manager-only integration (2026-07-15): the engine no longer merges — it WAKES the
// commander when a worker is ready. These are the seams the default wake dep uses.
import { spawnSwarmManager } from './swarmManager'
import {
  listManagerDesks,
  managerDeskForSession,
  sayToManagerDesk,
} from './swarmManagerRuntime'
import type { ManagerDeskHandle, ManagerRuntimeKind } from './swarmManagerRuntime'
import { SUPPLY_DESK_LABEL, spawnSwarmSupply } from './swarmSupply'
import { isGitRepoRoot, isUnderGitRepo } from './gitRepoGuard'
import { readSwarmSessions } from './swarmSessions'
import { sessionJsonlPath, sessionSubagentsDir } from './transcript'
import { readWorkerConsumptionLine } from './swarmTokenAudit'
import { sortByPriority } from '../boardPriority'

const execFile = promisify(execFileCb)

// ── Tunables ────────────────────────────────────────────────────────────────

/** Concurrency ceiling — the engine never has more live workers of its own than
 *  this. Mirrors the Swarm UI's MAX_WORKERS (SwarmModule.tsx); the two are
 *  independent counters (the UI's is per-client localStorage), but the engine is
 *  the only autonomous driver, so in practice this is THE cap when it's ON. The
 *  HARD upper bound of the dynamic worker band — {@link computeTargetWorkers}
 *  never targets past it, so a flood of independent todos can never spawn more
 *  than this many parallel workers (過剰並列で衝突する の防止). */
export const ORCHESTRATOR_MAX_WORKERS = 6

/** Floor of the dynamic worker band — the engine targets AT LEAST this many
 *  workers WHENEVER there is dispatchable work, so a non-empty queue is never
 *  under-served (並列度不足で枠を使い切れない の防止). It floors the TARGET number,
 *  not the live count: an EMPTY queue (nothing dispatchable) targets 0 — the floor
 *  only bites once independent work exists — and the actual spawn count is still
 *  bounded by how many non-conflicting cards there are (you cannot run more workers
 *  than there are independent cards). Clamped ≤ {@link ORCHESTRATOR_MAX_WORKERS} by
 *  computeTargetWorkers, so an inverted band can never breach the hard ceiling. */
export const ORCHESTRATOR_MIN_WORKERS = 1

/** How often the drain loop runs while ON. A few seconds matches the 5s polling
 *  etiquette elsewhere (Ground beacon, Board) — the queue does not need
 *  sub-second draining, and a worktree spawn already costs hundreds of ms. */
export const TICK_MS = 3000

/** How often the INTEGRATION stage (Card③) runs, throttled INSIDE the 3s loop:
 *  integration is heavier than a dispatch tick (a network fetch, sometimes a
 *  rebase worktree), and a review card does not need sub-15s attention. The
 *  loop still ticks every TICK_MS for dispatch responsiveness; integration just
 *  skips ticks until this much wall-clock has passed. */
export const INTEGRATE_TICK_MS = 15_000

/** Journal ring-buffer cap. The (separate) Swarm UI card renders these lines so
 *  the owner can watch the engine reason about the queue. */
export const MAX_LOG_LINES = 200

/** How long after dispatch a worker is shown 'starting' (claude boot + its first
 *  action) before it's assumed 'running' even with no commit/heartbeat yet. Only
 *  affects the displayed stage — never the (conservative, commit-gated) DONE
 *  judgement. A few tens of seconds matches a cold `claude` TUI start. */
export const STARTUP_GRACE_MS = 25_000

/** How many times the engine RE-QUEUES a card whose worker was LOST (its `claude`
 *  PTY died/was killed with no integrable commits and no completion sign) before
 *  parking it in 'blocked' for a human. 1 ⇒ a card is attempted at most twice
 *  (original + one auto-retry): a transient crash self-heals, but a card that
 *  reliably kills its worker escalates to a human instead of spinning forever
 *  (burning worktrees + `claude` sessions). A worker that reported a blocker, or
 *  that DECLARED itself done with nothing to merge, is parked immediately (no
 *  retry) — see {@link recoveryColumn}. */
export const RECOVER_MAX_REQUEUE = 1

/** How many consecutive passes the engine re-attempts a teardown that was refused
 *  because a desk is still live in the worktree, before it frees the slot anyway
 *  and says so at 'error' level. Three passes of the 3s tick chain is ~10s on top
 *  of the two 5s waits the teardown itself already performed — long enough for an
 *  ordinary unwind, short enough that a wedged worker does not hold a slot. */
const MAX_TEARDOWN_RETRIES = 3

/** How many times a Board COLUMN MOVE may be KEPT (its write rejected/failed) in a
 *  row before the engine ESCALATES instead of just logging + retrying forever. A
 *  handful of consecutive failures absorbs a transient CAS contention / board
 *  restart blip on the fast (3s) dispatch loop; beyond it the move is genuinely
 *  stuck and would zombie the card ("done なのに review" / "dead なのに doing"), so
 *  the engine escalates: a lost-worker recovery is parked in 'blocked', and every
 *  stuck move is surfaced as a 'move-stuck' anomaly for the owner. */
export const MOVE_STUCK_MAX_RETRIES = 5

/** REVIEW→DOING 差し戻し(rework)の往復上限 — レビューで must-fix(verify が RED)に
 *  なったカードを doing へ戻して worker に再作業させてよい回数(統合 conflict は別カウンタ
 *  {@link MAX_CONFLICT_REWORKS} で数える — conflict は worker のコード問題ではなく trunk が
 *  動いた結果なので予算を分ける。委譲先は同じ delegate→worker→再統合ループ)。
 *  これを超えたら 'blocked' へ退避し、review→doing→review の無限バウンスを断つ。
 *  手動運用の `swarm-board.sh rework <id> [max]` ループガードの in-app(自律エンジン)
 *  版で、同じ "差し戻しすぎたら人間に上げる" 契約。既定は控えめに 2(worker に最大 2
 *  回直すチャンス、3 度目の must-fix で blocked + 'rework-exhausted' anomaly)。
 *  2026-07-15 のマネージャ専任化以降、エンジン自身は差し戻さない(engine.reworks への
 *  加算経路は撤去済み)— この上限は 'rework-exhausted' anomaly 表示の判定にのみ残る。 */
export const MAX_REWORKS = 2

/** 統合 conflict → worker rebase 委譲 の往復上限(card 012a2848)。統合時に rebase 競合した
 *  カードを「自分のブランチを rebase して解消しろ」と worker へ差し戻してよい回数。司令塔が
 *  手でやっている "conflict は担当 worker に rebase 委譲" の自動化で、{@link MAX_REWORKS}
 *  (verify/レビュー差し戻し)とは別カウンタ — conflict は worker のコード品質ではなく「trunk が
 *  動いた」結果なので独立予算で数え、混ぜて早すぎる park を招かない。これを超えたら 'blocked'
 *  へ退避(conflict stamp を残す)、worker が解けない競合を無限に投げ返すループを断つ。conflict は
 *  trunk の動き次第で複数回起こりうるので既定は MAX_REWORKS より気持ち多めの 3。
 *  2026-07-15 のマネージャ専任化で委譲機構ごと撤去済み — 定数はカウンタの遺構として残る。 */
export const MAX_CONFLICT_REWORKS = 3

/** How many consecutive NO-majority adversarial reviews (defer) on the SAME tip are
 *  tolerated before the engine STOPS re-spawning the panel for that tip and surfaces
 *  the card "needs a human". Bounds the resource drain when reviewers persistently
 *  can't reach a verdict (a genuinely ambiguous diff, or a systemic claude outage that
 *  makes every reviewer abstain) — without it the panel re-burns N claude sessions
 *  every INTEGRATE_TICK_MS forever. A NEW commit (different tip) resets the count and
 *  re-arms the panel. Distinct from MAX_REWORKS: a defer is NOT the worker's fault, so
 *  it neither bumps the rework budget nor parks to 'blocked'.
 *  2 = the initial panel + exactly ONE retry (fail-closed review, 2026-07-14): an
 *  indecisive panel gets a single second chance, then the card freezes in 'review'
 *  and a 'review-panel-failed' anomaly + fatal notification hand it to a human —
 *  never an unbounded retry, never a merge on zero decisive votes. */
export const MAX_REVIEW_DEFERS = 2

/** STALL SELF-HEALING (Card e8022e — distinct from the crash recovery above,
 *  which handles a DEAD PTY). A worker can be ALIVE yet unresponsive — hung on an
 *  unsent prompt, a TUI wedge, or an API-overload stall (the documented "API 529"
 *  freeze). Such a worker never trips the crash path (its PTY lives), so without
 *  this it would sit in 'doing' forever holding a slot.
 *
 *  A worker is SILENT when BOTH its liveness channels go quiet — no heartbeat AND
 *  no PTY output — for this long. The AND matters: a worker streaming tokens (a
 *  long phase between heartbeats) is plainly alive, so requiring both to fall
 *  silent avoids interrupting real work. A `claude` that emits nothing for ten
 *  minutes is almost always waiting on input or wedged. */
export const STALL_SILENCE_MS = 10 * 60_000

/** How long an SDK worker sits quiet before its FREE-TEXT QUESTION is raised —
 *  deliberately far under {@link STALL_SILENCE_MS}.
 *
 *  The 10-minute gate exists for a PTY reason: a PTY worker that merely PRINTS
 *  question-shaped text mid-work is still streaming, and only long silence
 *  proves it actually stopped at the input box. An SDK worker needs no such
 *  inference — its session status ('waiting') is the pool's own authoritative
 *  "the turn ENDED", and detectSdkFreeTextQuestion already requires exactly
 *  that head. The remaining minute is a debounce for back-to-back turns, not a
 *  proof of idleness.
 *
 *  Measured cost of NOT having this (0.11.52 acceptance, 2026-08-03): the owner
 *  sat in front of an already-asked question for 10 straight minutes — twice —
 *  while the engine, by design, refused to look. For a runtime whose whole
 *  pitch is "a lookup where the PTY does an inference", that wait was pure
 *  inheritance, not caution. */
export const SDK_QUESTION_SILENCE_MS = 60_000

/** After nudging a silent worker (sending Enter), wait this long before nudging
 *  again or escalating to a reclaim — give the keystroke time to wake it and
 *  produce a fresh heartbeat. */
export const STALL_NUDGE_COOLDOWN_MS = 3 * 60_000

/** Try the cheap Enter-nudge this many times before reclaiming a worker that
 *  stays silent. 2 ⇒ ~10min(detect)+2×3min(nudge cooldowns) ≈ 16min to reclaim a
 *  truly wedged worker, well under the 30-min read-only worker-stale backstop. */
export const STALL_MAX_NUDGES = 2

/** PTY output within this window AFTER a nudge is treated as the Enter ECHO, not a
 *  sign of life. A bare CR makes a `claude` TUI repaint (stamping lastOutputAt),
 *  so without this guard the nudge's OWN echo would (a) reset the silence clock and
 *  (b) look like recovery — letting a wedged-but-echoing worker dodge reclaim, and
 *  resetting the nudge budget on nothing. A live worker that the nudge genuinely
 *  un-stuck streams output for far longer than a one-shot repaint, so output PAST
 *  this guard is real recovery; a heartbeat (never produced by an echo) is too. A
 *  few tens of seconds cleanly separates a single repaint from sustained work. */
export const STALL_ECHO_GUARD_MS = 30_000

/** Delay between the ESC interrupt and the follow-up continue-instruction the
 *  stall ESCALATION sends — long enough for `claude` to unwind the interrupted
 *  request before the next line lands. Matches the manually-verified field
 *  recovery (2026-07-02): ESC, ~3s settle, then a short continue instruction + CR. */
export const STALL_ESCALATE_DELAY_MS = 3_000

// The FOURTH liveness channel's safety valve — BG_TASK_GRACE_MS — is NOT here with the
// other STALL_* constants: it is defined next to MAX_EXEC_MS (below `envMinutesMs`),
// because the two numbers are deliberately equal and the reason is the design itself.

/** Read a minutes-valued tunable from the environment, clamped to a sane band,
 *  falling back to `defMin` when unset / unparseable. The "定数化・調整可"
 *  (constant-ised AND adjustable) contract for the non-progress thresholds: the
 *  exported consts below ARE the defaults, but an operator can retune them per
 *  machine without a rebuild (e.g. a slow box wanting a longer runaway ceiling).
 *  Resolved ONCE at module load — the engine is forked fresh per boot. */
const envMinutesMs = (name: string, defMin: number, minMin: number, maxMin: number): number => {
  const raw = process.env[name]
  const n = raw != null && raw.trim() !== '' ? Number(raw) : Number.NaN
  const mins = Number.isFinite(n) ? Math.max(minMin, Math.min(maxMin, n)) : defMin
  return Math.round(mins * 60_000)
}

/** Read an INTEGER-valued tunable from the environment, clamped to [min,max],
 *  falling back to `def` when unset / unparseable. The integer sibling of
 *  {@link envMinutesMs} (the consumption budget is a worker COUNT, not minutes) —
 *  same "定数化・調整可" contract, resolved ONCE at module load. */
const envInt = (name: string, def: number, min: number, max: number): number => {
  const raw = process.env[name]
  const n = raw != null && raw.trim() !== '' ? Number(raw) : Number.NaN
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def
}

/** RUNAWAY CEILING — the HARD wall-clock cap on one worker's lifetime, measured
 *  from dispatch. A worker still alive past this is a 暴走 (a task too big, an
 *  infinite /order loop, a wedge the silence detector can't see because it keeps
 *  emitting output): the engine STOPS it (teardown + re-home to 'blocked') and
 *  logs why, regardless of liveness — this is the one check that fires on a busy
 *  worker, not just a silent one. Generous by default (a real /order round —
 *  audit→implement→verify→integrate — legitimately runs long; the whole point of
 *  the swarm is heavy, unhurried work), so it never guillotines productive work;
 *  it only catches the genuinely-unbounded. Adjustable via env. Min 10m guards
 *  against an env typo bricking every worker.
 *
 *  IT COUNTS *WORKING* TIME, NOT RAW WALL-CLOCK: 統合待ち (idle in review,
 *  pending the commander) is CREDITED BACK ({@link isRunaway}'s idleMs). The
 *  2026-07-12 field loss taught the rule — a worker waited 20m on a quota
 *  limit, then worked 84m (104m wall-clock), was judged runaway at 90m, and
 *  was torn down with 15 uncommitted files (47KB) still in its worktree. The
 *  rate-limit HOLD that credit compensated died 2026-08-13 (a quota-stopped
 *  worker is requeued within ~a minute, never held against its budget), so
 *  the surviving credit is the integration wait. (The other half of that fix
 *  is {@link commitWipBeforeTeardown} — no reclaim, for ANY reason, may
 *  destroy uncommitted work again.) */
export const MAX_EXEC_MS = envMinutesMs('OPENGROUND_SWARM_MAX_EXEC_MIN', 90, 10, 600)

/** A worker with a BACKGROUND TASK still in flight counts as ALIVE for this long from
 *  that task's start — the FOURTH liveness channel's safety valve (see
 *  {@link sessionBackgroundTaskAt} for what "in flight" is read from).
 *
 *  WHY THE CHANNEL EXISTS (the 2026-07-27 false-kill). A worker running its completion
 *  gate does exactly the RIGHT thing: it starts `npm test` as a BACKGROUND task, says
 *  "I'll report when it finishes", and ENDS ITS TURN to wait for the notification. That
 *  is correct practice — and it freezes all three cheap channels AT ONCE: the heartbeat
 *  (beaten only at phase boundaries), the PTY frame (nothing repaints), and the
 *  transcript / sub-agent mtimes (the turn is OVER, so no file grows — the third channel
 *  was built for a worker inside ONE LONG turn, which is the opposite case). Ten minutes
 *  later the monitor called it silent, nudged twice, and RECLAIMED it. Four workers died
 *  this way in one morning, all in `phase: verify`; their transcripts end with the
 *  completion notification landing at the same minute as the reclaim, carrying
 *  `<status>killed</status>`. The engine killed the very tests it was waiting for.
 *
 *  WHY IT EQUALS {@link MAX_EXEC_MS} (90 min), and why the first cut's 45 was wrong.
 *  That 45 came from "2× the worst run I measured" — but the sample was the THREE tasks
 *  in the two transcripts that motivated the fix, and 2026-07-27's wider survey (484
 *  background tasks across 435 worker transcripts on this disk;
 *  `scripts/verify-bg-channel-on-real-transcripts.mts --survey`) shows that window was
 *  not the tail. ⚠ DERIVE FROM TASK **DURATION**, NOT FROM SILENCE — this cap is
 *  compared against `now − bgStartedAtMs`, i.e. how long the TASK has been in flight,
 *  not how long the transcript has been quiet. The first cut derived it from the
 *  silence column and landed 4 minutes short; see the script header
 *  (`verify-bg-channel-on-real-transcripts.mts`) for that off-by-one-metric.
 *  Task DURATION, in flight (the metric this constant is actually compared to):
 *      p50 2.0m   p90 18.8m   p99 52.6m   max 98.1m
 *  and every one of the long ones ended `killed` — i.e. they are LOWER BOUNDS. Tasks
 *  that would still lose the channel: **3 at a 45-min grace, 0 at 60, 0 at 90**.
 *  (For reference the SILENCE column — what the third channel would have seen — is
 *   p50 0.7m / p90 10.0m / p99 42.3m / max 86.1m. It is NOT what this cap measures.)
 *
 *  So the honest number is not "2× a worst case" — it is a question about WHOSE job the
 *  ceiling is. An in-flight background task answers "is this worker alive?", which is
 *  the only question the stall monitor asks. "How long may it live?" is a different
 *  question, and this engine already has an owner for it: the execution-time limit
 *  (MAX_EXEC_MS, counted in real work — §5.5). Setting the grace EQUAL to it says
 *  exactly that: while a task is in flight the stall path never pre-empts the execution
 *  path, and the worker is bounded by the clock that was designed to bound it. A larger
 *  grace could not change any outcome (MAX_EXEC_MS fires first); a smaller one only
 *  reintroduces false kills — which is what 45 was measurably still doing.
 *
 *  It remains a CAP, not a licence. A worker wedged with a task stuck in flight loses
 *  the channel here and then takes the ordinary escalation — nudge, cooldown, nudge,
 *  cooldown, escalate, cooldown — i.e. 3×STALL_NUDGE_COOLDOWN_MS ≈ 9 min more (the
 *  10-min detection window is already spent). Worst case ≈ 99 min from the task's start,
 *  and in practice less, because MAX_EXEC_MS reaches the same worker first.
 *
 *  Adjustable like every other non-progress threshold (the "定数化・調整可" contract) —
 *  the first cut made this the one bare literal in the family. */
export const BG_TASK_GRACE_MS = envMinutesMs('OPENGROUND_SWARM_BG_TASK_GRACE_MIN', 90, 5, 600)

/** CEILING on the 統合待ち credit (2026-07-19). A card sitting in 'review'
 *  early-continues the monitor, so while it waits its worker is subject to NO
 *  ceiling, NO stall check and NO heartbeat check — and the whole span is credited
 *  back on 差し戻し. Uncapped, a worker whose PTY is actually still BURNING (an
 *  /order loop under a card the commander hand-moved, or a promote off a stale
 *  ready heartbeat) earns unlimited credit: six hours of tokens in review, then a
 *  fresh full MAX_EXEC_MS of 'doing' before the ceiling can bite.
 *
 *  The engine cannot tell an idle waiter from a busy one here (the credit is a
 *  span between two OBSERVATIONS, not a measure of work — see §5.5(b)), so it
 *  bounds what it cannot measure. Generous by design: a normal overnight review
 *  is still forgiven whole, and the cap only engages on waits far longer than any
 *  healthy integration queue.
 *
 *  This reverses the original "統合待ちは cap しない" rule, whose stated reason —
 *  "a card left in review overnight would come back already past the ceiling and
 *  be torn down as a 暴走" — no longer holds: the 暴走 label and the 'blocked' park
 *  are now decided by `readyAt`, NOT by the credit. A ready worker that trips the
 *  ceiling because its credit was capped is stopped as 'integration-wait' and its
 *  card goes to 'review' with its work committed. That is a bounded, honest
 *  outcome; unbounded token burn is not. */
export const WAIT_CREDIT_CAP_MS = envMinutesMs('OPENGROUND_SWARM_WAIT_CREDIT_CAP_MIN', 480, 30, 2880)

/** RATE-LIMIT GRACE — the DEFAULT cooling span for a tier that hit a usage /
 *  quota / overload wall when no reset time can be parsed from the refusal text
 *  or the A5 usage cache (see swarmQuota.resolveCoolingUntil). (Until 2026-08-13
 *  this also drove the monitor's 20-minute in-place HOLD of a rate-limited PTY
 *  worker; the hold died with the PTY worker runtime — a quota-stopped SDK
 *  worker is requeued after {@link QUOTA_STOP_DEBOUNCE_MS}, and the pace of the
 *  retry is governed by this cooling span instead.) Adjustable via env. */
export const RATE_LIMIT_GRACE_MS = Math.min(
  envMinutesMs('OPENGROUND_SWARM_RATE_LIMIT_GRACE_MIN', 20, 2, 360),
  // CLAMP strictly under the runaway ceiling so a transient waiter is requeued
  // ('todo') before the runaway path could ever park it ('blocked') — robust even
  // if an operator inverts the two env knobs (the reviewer's band-inversion footgun).
  MAX_EXEC_MS - 60_000,
)

/** QUOTA-STOP DEBOUNCE (SDK-only workers, 2026-08-13). How long the pool's own
 *  quota verdict (`quotaBlocked` — 'quota-parked' status / a live
 *  `lastQuotaRefusalText`) must hold, with the worker silent, before the engine
 *  cools the tier and requeues the card. Short — the verdict is the CLI's own
 *  refusal event, not a wording guess, so there is no 10-minute silence gate to
 *  wait out (the PTY era's screen-scrape fast path — RATE_LIMIT_SCRAPE_QUIET /
 *  EARLY_ONSET / EARLY_CONFIRM and the engine.limitScreen onset clock — was
 *  deleted with the PTY worker runtime). Non-zero on purpose: a worker whose
 *  LAST event echoed refusal-like text but is still working clears the verdict
 *  with its next real event (lastQuotaRefusalText decays), so one debounce
 *  window is what separates "parked on the wall" from "mentioned the wall".
 *  Same length and rationale as {@link SDK_QUESTION_SILENCE_MS}. */
export const QUOTA_STOP_DEBOUNCE_MS = 60_000

/** FREE-TEXT QUESTION GRACE — how long a worker that idles at a detected free-text
 *  question is HELD (so the owner's escalation answer can W16-inject into the live
 *  worker) before the engine PARKS it in 'blocked'. Bounds the hold: an unanswered
 *  real question, or a courtesy/rhetorical "?" false-positive, must not squat the
 *  slot until the 90-min runaway ceiling. Generous (the owner may be away) but far
 *  under MAX_EXEC_MS; the question stays in the escalations inbox after parking, and
 *  'blocked' is the human lane (no auto-respawn re-asking). Adjustable via env. */
export const QUESTION_GRACE_MS = Math.min(
  envMinutesMs('OPENGROUND_SWARM_QUESTION_GRACE_MIN', 30, 5, 360),
  MAX_EXEC_MS - 60_000,
)

/** CONSUMPTION BUDGET — the per-session dispatch ceiling the UNATTENDED loop
 *  WARNS at (card 3f0fd4fa). Once the engine has dispatched this many workers
 *  since boot, the consumption snapshot flags `overLimit` and the commander pane
 *  warns the owner to check the loop. A SOFT nudge, never a hard stop: the engine
 *  keeps draining (per-worker wall-clock is already bounded by MAX_EXEC_MS, and
 *  the concurrency cap bounds parallelism — this only surfaces "the unattended
 *  loop has been busy a while, look at it"). Each dispatch is one `claude` session
 *  against the subscription, so the spawned-worker count is the honest proxy for
 *  total session spend. Adjustable via env, clamped so a typo can neither disable
 *  the warning (min 1) nor set an absurd ceiling. Resolved ONCE at module load. */
export const DISPATCH_BUDGET = envInt('OPENGROUND_SWARM_DISPATCH_BUDGET', 50, 1, 100_000)

/** AUTO-DRAIN background-scan cadence (card cf545637, server-tick variant) — how often
 *  the UI-INDEPENDENT server loop ({@link startAutoDrainLoop}) sweeps the registered
 *  projects to auto-start a STOPPED engine sitting on a todo backlog with a free slot.
 *  MUCH slower than the per-engine TICK_MS (3s): the sweep only acts on stopped engines
 *  (a running one is driven by its own chain and is a fast no-op here) and it touches
 *  EVERY project, so a 15s default keeps the all-projects cost negligible while still
 *  draining an unattended backlog within seconds. Env-overridable, clamped to a sane band
 *  (≥3s so it can never busy-spin, ≤10min so it stays responsive). Resolved ONCE at load. */
export const AUTO_DRAIN_SCAN_MS = envInt('OPENGROUND_SWARM_AUTODRAIN_SCAN_MS', 15_000, 3_000, 600_000)

// ── Pure helpers (exported, unit-tested without a server) ────────────────────

/** A Board card sitting in the `todo` column — mirrors BoardTab's columnOf
 *  (undefined boardColumn folds to 'done' when done, else 'todo'). */
export const isTodoCard = (t: ProjectTask): boolean =>
  (t.boardColumn ?? (t.done ? 'done' : 'todo')) === 'todo'

/** A Board card sitting in the `review` column — the integration stage's input.
 *  (An undefined column never folds to 'review', so the explicit check suffices.) */
export const isReviewCard = (t: ProjectTask): boolean => t.boardColumn === 'review'

/** Dispatch queue order. Delegates to the shared {@link sortByPriority} (in
 *  src/lib/boardPriority.ts — one source of truth with the Board UI) so the
 *  engine pulls cards by effective priority FIRST (static priority + aging:
 *  "急ぎを先に・古いカードの放置を防ぐ"), then by the owner's explicit drag order
 *  (boardOrder ascending, ordered-before-unordered), then oldest-createdAt first.
 *  The boardOrder/createdAt tail preserves the previous contract WITHIN a
 *  priority bucket. `now` defaults to wall-clock so the live caller (selectDispatch)
 *  ages cards in real time; tests inject a fixed `now` for determinism. */
export const sortTodos = (
  todos: readonly ProjectTask[],
  now: number = Date.now(),
): ProjectTask[] => sortByPriority(todos, now)

/** Collapse free text to a stable comparison form: NFKC-normalized (so full-width
 *  ＡＢＣ folds to ABC), whitespace folded, trimmed, lowercased. Used by both
 *  content-dedup and file-token normalization. */
const foldText = (s: string): string => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()

/** A content signature for a card — normalized title + notes — used to suppress
 *  DUPLICATE work: two cards (different ids) whose visible content folds to the
 *  same key are never dispatched concurrently (gate ③). Returns null for a card
 *  with no meaningful text, so blank cards are NOT all collapsed into one bucket
 *  (they fall back to the id gate). Pure. */
export const contentKey = (t: ProjectTask): string | null => {
  const title = foldText(t.title ?? '')
  const notes = foldText(typeof t.notes === 'string' ? t.notes : '')
  if (!title && !notes) return null
  // The separator is a NUL — LOAD-BEARING: foldText can emit spaces, so joining
  // with a space would let title="a b"/notes="c" collide with title="a"/notes="b
  // c". NUL cannot appear in folded text, keeping the title/notes boundary exact.
  // (It renders invisibly in editors/diffs — do NOT "tidy" it into a space.)
  return `${title}\u0000${notes}`
}

/** The files a card DECLARES it will touch — its known conflict surface (既知の
 *  競合領域). Read from explicit `files:` / `ファイル:` directive lines (the rest
 *  of that line is split on commas / whitespace into path tokens). The directive
 *  must lead its line, optionally behind list / quote / heading markers
 *  (`-` `*` `+` `>` `#`, or `1.` / `1)` ordered-list), so a `files:` substring
 *  mid-prose (e.g. "profiles:") never matches. This is OPT-IN: a card with no
 *  directive declares nothing and is never held by the file gate (it still passes
 *  the id + content gates) — a path mentioned only in prose is NOT a declaration.
 *  Tokens are normalized (NFKC; surrounding quotes/backticks/brackets/angles and
 *  trailing punctuation/slash and a trailing #fragment stripped; backslashes→
 *  slashes; leading `./` dropped; lowercased) so trivial spelling drift between
 *  two cards (`./src/x.ts`, `src\x.ts`, `"src/x.ts"`, `src/x.ts/`, `<src/x.ts>`,
 *  `src/x.ts#L9`) still collides onto one token. Pure + total. */
export const declaredFiles = (t: ProjectTask): Set<string> => {
  const text = `${t.title ?? ''}\n${typeof t.notes === 'string' ? t.notes : ''}`
  const out = new Set<string>()
  const re = /(?:^|\n)[ \t]*(?:(?:[-*+>#]+|\d+[.)])[ \t]*)*(?:files|ファイル)[ \t]*[:：][ \t]*([^\n]+)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    for (const raw of m[1].split(/[\s,、]+/)) {
      const tok = raw
        .normalize('NFKC')
        .replace(/^[`'"([<]+/, '')
        .replace(/#[^/]*$/, '')
        .replace(/[`'")\]>.,;:/]+$/, '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .trim()
        .toLowerCase()
      if (tok) out.add(tok)
    }
  }
  return out
}

/** The next cards to dispatch this pass. Queue order (sortTodos), gated by SIX
 *  independent rules so the engine never starts unsafe parallel work:
 *    ① COLUMN  — only `todo` cards are ever candidates. blocked / doing / review /
 *       done are filtered out here (the gate lives in this function, not just the
 *       caller, so it holds even if a mixed list is passed in).
 *    ② ID      — a card already in flight (its id in `dispatchedIds`, i.e. a
 *       counted worker) is skipped — no re-dispatch of the same card.
 *    ⑥ SELF-SUPPLY — a card the engine PROPOSED itself (selfSupplyKey set) is held
 *       until the owner approves it (selfSupplyApproved). The runaway defense for
 *       the self-supply stage (card b3fbbfba): a discovered improvement point can
 *       sit in todo but never spawns a worker without explicit owner sign-off.
 *    ③ CONTENT — a card whose content folds to a key already claimed by active
 *       work or by an earlier pick THIS pass is skipped — no double-dispatch of
 *       duplicate cards.
 *    ④ FILE    — a card declaring a file already claimed by active work (a `doing`
 *       or `review` card, or a counted worker) or by an earlier pick this pass is
 *       held back — same-file work is SERIALIZED, never run by two workers at
 *       once. The held card stays in todo and is reconsidered next pass, once the
 *       conflicting work has LANDED (left review for done) — not merely promoted.
 *    ⑤ DEPENDS — a card whose declared `dependsOn` lists a prerequisite that is
 *       not yet `done` is held until that prerequisite lands, so the supply
 *       officer's "B before A" ordering is honored. An absent (deleted) prereq
 *       id is treated as satisfied — it never strands a card forever.
 *  "Active work" = the doing column ∪ the review column ∪ the counted workers
 *  (dispatchedIds resolved against `tasks`). REVIEW is included because a promoted
 *  worker's branch is still UNMERGED while it sits in review (integration is a
 *  separate, possibly-disarmed stage): dispatching a same-file todo against it
 *  would build a second branch destined to conflict at integration. Active work's
 *  files + content seed the claimed sets, which then grow with each pick so
 *  within-pass conflicts are caught too. Capped at `slots`. Pure (no IO, no clock). */
export const selectDispatch = (
  tasks: readonly ProjectTask[],
  dispatchedIds: ReadonlySet<string>,
  slots: number,
): ProjectTask[] => {
  if (slots <= 0) return []
  const byId = new Map(tasks.map((t) => [t.id, t]))

  // Cards already finished — a `done` card SATISFIES a dependsOn pointing at it.
  const doneIds = new Set(
    tasks.filter((t) => (t.boardColumn ?? (t.done ? 'done' : 'todo')) === 'done').map((t) => t.id),
  )
  // ⑤ DEPENDS — a card's declared prerequisites (dependsOn) must all be done
  //   before it is dispatched, so the supply officer's "B before A" ordering is
  //   honored (mirrors the tmux /manage drain rule). A dependency that is ABSENT
  //   from the board (deleted / typo'd id) is treated as satisfied, never a
  //   permanent hold — only an EXISTING, not-yet-done prerequisite blocks. Pure.
  const prereqsMet = (t: ProjectTask): boolean => {
    const deps = Array.isArray(t.dependsOn) ? t.dependsOn : []
    return deps.every((id) => !byId.has(id) || doneIds.has(id))
  }

  // Seed the claimed conflict surface from work that is already underway: every
  // doing- AND review-column card (review = promoted but still-unmerged branch),
  // plus every counted worker (the latter covers a just-spawned card whose
  // todo→doing move is still lagging — its id is counted even if the board hasn't
  // flipped its column yet).
  const active = new Map<string, ProjectTask>()
  for (const t of tasks) {
    if (t.boardColumn === 'doing' || t.boardColumn === 'review') active.set(t.id, t)
  }
  dispatchedIds.forEach((id) => {
    const c = byId.get(id)
    if (c) active.set(id, c)
  })
  const claimedFiles = new Set<string>()
  const claimedContent = new Set<string>()
  active.forEach((c) => {
    declaredFiles(c).forEach((f) => claimedFiles.add(f))
    const k = contentKey(c)
    if (k) claimedContent.add(k)
  })

  const picks: ProjectTask[] = []
  for (const card of sortTodos(tasks.filter(isTodoCard))) {
    if (picks.length >= slots) break
    if (dispatchedIds.has(card.id)) continue // ② already in flight
    // ⑥ SELF-SUPPLY APPROVAL (card b3fbbfba) — a card the engine PROPOSED itself
    //   (selfSupplyKey set) is an inert proposal until the owner approves it. This
    //   is the primary runaway defense: the engine can fill todo with discovered
    //   improvement points, but NONE of them spawn a worker without explicit owner
    //   sign-off. A human-authored card (no selfSupplyKey) is unaffected.
    if (card.selfSupplyKey && !card.selfSupplyApproved) continue
    const k = contentKey(card)
    if (k && claimedContent.has(k)) continue // ③ duplicate content
    const files = Array.from(declaredFiles(card))
    if (files.some((f) => claimedFiles.has(f))) continue // ④ same-file conflict
    if (!prereqsMet(card)) continue // ⑤ a declared prerequisite isn't done yet
    picks.push(card)
    if (k) claimedContent.add(k)
    files.forEach((f) => claimedFiles.add(f))
  }
  return picks
}

/** DYNAMIC WORKER SCALING (card ea369937) — how many workers the engine TARGETS
 *  for a dispatch pass, the adaptive replacement for the old "always fill to MAX".
 *  The target tracks the live INDEPENDENT backlog, clamped to the [min, max] band:
 *
 *      demand = liveWorkers + dispatchableTodos
 *      target = demand === 0 ? 0 : clamp(demand, min, max)
 *
 *  • `dispatchableTodos` is the count of todo cards that pass EVERY parallel-safety
 *    gate RIGHT NOW (selectDispatch's column / id / content-dup / same-file /
 *    dependsOn rules) — i.e. the INDEPENDENT backlog, not the raw todo count. Two
 *    todos that would touch the same file fold into ONE unit of demand, so the
 *    target never asks for more parallelism than the work can absorb without
 *    conflict (過剰並列の回避). This is the "相互の独立性" half of the contract.
 *  • Many independent todos ⇒ demand high ⇒ target rides up to `max` (枠を使い切る).
 *    Few ⇒ target settles near `min`. An EMPTY queue with no live worker ⇒ 0 (an
 *    idle engine targets zero — the floor is for a backlog, not an empty board).
 *  • `max` is the HARD ceiling: a runaway flood of cards can NEVER target past it
 *    (the 暴走防止 invariant). `min` is clamped ≤ `max` first, so even an inverted
 *    band (min > max, an operator/env footgun) still cannot breach `max` — the
 *    same band-inversion guard RATE_LIMIT_GRACE_MS uses.
 *
 *  Inputs are floored / non-negative-clamped so a malformed signal (a fractional
 *  or negative count) can't produce a nonsense target. The caller derives the new
 *  spawns as max(0, target − live): when the target drops BELOW the live count
 *  (the queue drained), that is 0 and the engine simply stops refilling — it
 *  SHRINKS passively as live workers' PTYs exit, never killing a healthy worker
 *  to hit a lower number (that would discard committed work). Pure (no IO, no
 *  clock) — unit-tested directly for the three required cases (多→max / 少→min /
 *  上限頭打ち). */
export const computeTargetWorkers = (input: {
  liveWorkers: number
  dispatchableTodos: number
  min?: number
  max?: number
}): number => {
  const max = Math.max(0, Math.floor(input.max ?? ORCHESTRATOR_MAX_WORKERS))
  // min can never exceed max — clamp it down first so an inverted band still
  // honors the hard ceiling (target ≤ max always holds).
  const min = Math.min(max, Math.max(0, Math.floor(input.min ?? ORCHESTRATOR_MIN_WORKERS)))
  const demand = Math.max(0, Math.floor(input.liveWorkers)) + Math.max(0, Math.floor(input.dispatchableTodos))
  if (demand <= 0) return 0 // idle: nothing running, nothing to dispatch
  return Math.max(min, Math.min(max, demand))
}

const shorten = (s: string, n = 60): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat || '(untitled)'
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── KPI aggregation (the ANALYTICS layer — data foundation for improvement) ───
// A SEPARATE layer from the live observability above (workers/reviews/log/
// anomalies): those answer "what is happening NOW"; these answer "is the swarm
// getting BETTER?" — lead time, rework / conflict / worker-success rates.
//
// Two data sources, both READ-ONLY of state the engine already maintains (this
// stage adds NO new event-site hooks — it only READS):
//   • Lifetime event COUNTERS (engine.metrics) — bumped in the one logLine
//     chokepoint by event KIND, so they survive the journal ring buffer's
//     eviction (a rate over all-time-since-boot, not just the last 200 lines).
//   • The journal itself — for lead time, each `integrate` line carries the
//     completion timestamp; pairing it to the Board card's createdAt yields
//     todo→done. Window-limited to the journal's retained lines (documented).

/** Non-lossy lifetime event counters, bumped in {@link logLine} by event kind.
 *  In-memory on the engine (a restart resets them — a per-session roll-up, never
 *  persisted to disk). The rate denominators the KPI roll-up divides. */
export interface SwarmMetricsCounters {
  /** Workers launched (a 'dispatch' line at info level — a spawned PTY). */
  dispatched: number
  /** Dispatch attempts that FAILED to spawn (a 'dispatch' line at error level). */
  dispatchFailed: number
  /** Cards a worker was judged done on → moved doing→review ('promote'). */
  promoted: number
  /** Review branches the engine LANDED on the trunk ('integrate'). */
  integrated: number
  /** Auto-integration attempts that hit a rebase conflict ('conflict'). */
  conflicted: number
  /** Review→doing/todo 差し戻し (rework) rounds — matched by the rework log
   *  marker, since rework is not a structured journal `kind`. */
  reworked: number
  /** Workers reclaimed because their PTY died with nothing to land ('crash'). */
  crashed: number
  /** Workers reclaimed because they went silent past every nudge ('stall'). */
  stalled: number
}

export const emptyMetricsCounters = (): SwarmMetricsCounters => ({
  dispatched: 0,
  dispatchFailed: 0,
  promoted: 0,
  integrated: 0,
  conflicted: 0,
  reworked: 0,
  crashed: 0,
  stalled: 0,
})

/** The stable marker shared by BOTH rework SUCCESS log lines ("差し戻し review→
 *  doing …" and "差し戻し review→todo …"). It deliberately EXCLUDES the
 *  rework-exhausted PARK line ("差し戻し上限(N)超過 …"), which is a block, not a
 *  rework round. Centralised here (not the rework site — that's a different
 *  track's territory) so the KPI counter stays decoupled: if the message drifts
 *  the counter degrades to 0, it never throws. */
export const REWORK_LOG_MARKER = '差し戻し review→'

/** The integrate journal line's format (defaultMoveToDone's landing log):
 *  `integrated (<mode>): <shortened-title> → <target>`. The title was logged via
 *  {@link shorten}, so capturing it lets us pair the line back to a `done` card
 *  whose own `shorten(title)` matches EXACTLY (shorten is deterministic — not a
 *  fuzzy match). Non-greedy up to the FIRST " → " so a normal title is captured;
 *  a title literally containing " → " just won't pair (skipped, never mis-paired
 *  onto the wrong card unless its shortened form collides — rare, documented).
 *  DOUBLES as the land-vs-owner-resolve discriminator in {@link classifyMetricEvent}:
 *  kind:'integrate' is emitted by a real land AND by owner-resolve (a park/requeue),
 *  and only the former is land-shaped — so the rate counters and the lead-time
 *  pairing agree on what "a real land" is. */
const INTEGRATE_TITLE_RE = /^integrated \([^)]*\): (.+?) → /

/** Which lifetime counter (if any) a journal line increments — PURE so the whole
 *  mapping is unit-tested without an engine. Structured `kind` events map
 *  directly; a dispatch's level splits spawned vs failed; rework (which carries
 *  no `kind`) is recognised by {@link REWORK_LOG_MARKER}. Everything else
 *  (routine / cleanup / uncategorised) maps to null (counts toward nothing). */
export const classifyMetricEvent = (line: {
  kind?: OrchestratorLogLine['kind']
  level: OrchestratorLogLine['level']
  message: string
}): keyof SwarmMetricsCounters | null => {
  switch (line.kind) {
    case 'dispatch':
      return line.level === 'error' ? 'dispatchFailed' : 'dispatched'
    case 'promote':
      return 'promoted'
    case 'integrate':
      // kind:'integrate' is emitted by TWO sites: the real auto-land (message
      // "integrated (<mode>): <title> → <target>") AND owner-resolve
      // (resolveOrchestratorReview — "review resolved by owner — card → blocked/
      // todo …"), a PARK/REQUEUE that is NOT a land. Counting the latter as
      // `integrated` corrupts every rate (worker-success > 100%, a conflict that's
      // then owner-resolved double-counts into both conflictRate terms, reworkRate's
      // denominator inflates). So count ONLY when the message is land-shaped — the
      // SAME INTEGRATE_TITLE_RE the lead-time pairing already uses, so the two agree
      // on "a real land". (The journal still shows both as 'integrate' events — this
      // changes only the analytics classification, never the display.)
      return INTEGRATE_TITLE_RE.test(line.message) ? 'integrated' : null
    case 'conflict':
      return 'conflicted'
    case 'crash':
      return 'crashed'
    case 'stall':
      return 'stalled'
  }
  // Rework has no structured kind — recognise it by its (stable) success marker.
  if (line.message.includes(REWORK_LOG_MARKER)) return 'reworked'
  return null
}

/** A `done` Board card — the lead-time input. Mirrors isTodoCard's fold
 *  (undefined boardColumn → 'done' iff the card's `done` flag is set). */
const isDoneCard = (t: ProjectTask): boolean =>
  (t.boardColumn ?? (t.done ? 'done' : 'todo')) === 'done'

/** Median of a number list (rounded for the even case), or null when empty. Pure. */
export const medianOf = (xs: readonly number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/** Completed-card lead time todo→done, paired READ-ONLY from existing state:
 *  each `done` card's createdAt (todo entry) → its `integrate` journal line's
 *  timestamp (done), matched by the deterministic shortened title. Returns the
 *  median (ms) + paired count. Window-limited to the journal's retained lines.
 *  Skips a card with no matching integrate line, an unparseable createdAt, or a
 *  negative span (clock skew). Latest integrate line wins on a title collision.
 *  PURE (no IO, no clock). */
export const computeLeadTimeStats = (
  tasks: readonly ProjectTask[],
  log: readonly OrchestratorLogLine[],
): { medianMs: number | null; count: number } => {
  // shortened-title → latest integrate-event epoch ms (the done moment).
  const doneAtByTitle = new Map<string, number>()
  for (const line of log) {
    if (line.kind !== 'integrate') continue
    const m = INTEGRATE_TITLE_RE.exec(line.message)
    if (!m) continue
    const at = Date.parse(line.at)
    if (!Number.isFinite(at)) continue
    const prev = doneAtByTitle.get(m[1])
    if (prev === undefined || at > prev) doneAtByTitle.set(m[1], at)
  }
  const samples: number[] = []
  for (const t of tasks) {
    if (!isDoneCard(t)) continue
    const doneAt = doneAtByTitle.get(shorten(t.title ?? ''))
    if (doneAt === undefined) continue
    const createdAt = t.createdAt ? Date.parse(t.createdAt) : Number.NaN
    if (!Number.isFinite(createdAt)) continue
    const span = doneAt - createdAt
    if (span >= 0) samples.push(span)
  }
  return { medianMs: medianOf(samples), count: samples.length }
}

/** The PROMOTE line's title — the engine's own "this worker's card reached
 *  review" record. Same shortened-title pairing INTEGRATE_TITLE_RE uses. */
const PROMOTE_TITLE_RE = /^promoted to review: (.+?) → /

/** Cards the ENGINE carried to review that the Board now shows DONE.
 *
 *  ⚠ WHY THIS EXISTS (overnight review 2026-08-04). `counters.integrated` only
 *  counts the engine's OWN auto-land journal line — but since 2026-07-15 the
 *  engine deliberately does NOT integrate: it wakes the COMMANDER, who merges by
 *  hand. In that (default) mode no integrate line is ever written, so
 *  workerSuccessRate was structurally 0% and lead time a dash — a dashboard
 *  reporting "12 dispatched, nothing landed" while every card had in fact
 *  landed. Counting a promoted card that the Board shows done measures the
 *  OUTCOME (did the worker's work land?) instead of WHO pressed merge, so it is
 *  right in both modes. Pure; the journal's retention window bounds it, exactly
 *  like the lead-time pairing next to it. */
export const countLandedFromBoard = (
  tasks: readonly ProjectTask[],
  log: readonly OrchestratorLogLine[],
): number => {
  const promoted = new Set<string>()
  for (const line of log) {
    if (line.kind !== 'promote') continue
    const m = PROMOTE_TITLE_RE.exec(line.message)
    if (m) promoted.add(m[1])
  }
  if (promoted.size === 0) return 0
  let landed = 0
  for (const t of tasks) {
    if (!isDoneCard(t)) continue
    if (promoted.has(shorten(t.title ?? ''))) landed++
  }
  return landed
}

/** The full KPI roll-up — PURE over the engine's lifetime counters + the Board
 *  cards + the journal. A rate is null when its denominator is 0 ("no data yet",
 *  the UI shows a dash) so an empty engine never reads as 0% success. Definitions
 *  match {@link SwarmKpis}:
 *    • workerSuccessRate = integrated / dispatched
 *    • conflictRate      = conflicted / (integrated + conflicted)
 *    • reworkRate        = reworked / (reworked + integrated) */
export const computeSwarmKpis = (input: {
  counters: SwarmMetricsCounters
  tasks: readonly ProjectTask[]
  log: readonly OrchestratorLogLine[]
}): SwarmKpis => {
  const c = input.counters
  const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null)
  // "Landed" = the engine's own auto-lands PLUS the cards it carried to review
  // that the Board now shows done (the commander-merges mode, which is the
  // DEFAULT — see countLandedFromBoard). Max, not sum: the two sources overlap
  // whenever the engine landed a card itself, and double-counting would push
  // workerSuccessRate past 100%.
  const landed = Math.max(c.integrated, countLandedFromBoard(input.tasks, input.log))
  return {
    leadTime: computeLeadTimeStats(input.tasks, input.log),
    // ⚠ NEITHER OF THESE HAS A WRITER IN PRODUCTION (measured 2026-08-04).
    // `conflicted` is only bumped by a journal line with kind 'conflict', and no
    // logLine call passes that kind; `reworked` is only bumped by a line carrying
    // REWORK_LOG_MARKER, and nothing writes it since the engine stopped doing
    // 差し戻し itself (2026-07-15 — the commander does it through the Board API,
    // which the engine never sees). So the numerator is structurally 0, and the
    // moment ONE card lands the denominator turns positive and both rates freeze
    // at a confident "0%" — a dashboard telling the owner "no rework, no
    // conflicts, ever" about the two things that actually happen most.
    //
    // A zero we cannot observe is not a zero, it is UNKNOWN, and unknown is the
    // dash. Reporting `null` until a real event arrives keeps the panel honest
    // and needs no follow-up here when a writer appears: the number starts
    // showing itself. (This is the same defect that was fixed for
    // workerSuccessRate on 2026-08-04 — one of the three rows was repaired and
    // its two neighbours were left with the identical hole.)
    conflictRate: c.conflicted > 0 ? ratio(c.conflicted, landed + c.conflicted) : null,
    reworkRate: c.reworked > 0 ? ratio(c.reworked, c.reworked + landed) : null,
    workerSuccessRate: ratio(landed, c.dispatched),
    counts: {
      dispatched: c.dispatched,
      integrated: landed,
      conflicted: c.conflicted,
      reworked: c.reworked,
      crashed: c.crashed,
      stalled: c.stalled,
    },
  }
}

const emptyKpis = (): SwarmKpis => ({
  leadTime: { medianMs: null, count: 0 },
  conflictRate: null,
  reworkRate: null,
  workerSuccessRate: null,
  counts: { dispatched: 0, integrated: 0, conflicted: 0, reworked: 0, crashed: 0, stalled: 0 },
})

// ── Consumption metering (the BUDGET layer — runaway-spend guardrail) ─────────
// A SEPARATE layer from the KPI analytics above: KPIs answer "is the swarm
// getting BETTER?"; consumption answers "how much is the UNATTENDED loop SPENDING
// right now, and has it crossed a ceiling I should look at?". Like the KPI layer
// it is READ-ONLY of state the engine already maintains — it adds NO new
// event-site hooks (so it never collides with the dispatch / integrate / spawn
// sites the other stages own); it only READS two things:
//   • the LIVE worker set (each worker's startedAt vs now) → activeWorkers +
//     activeRunMs, the in-flight load this instant.
//   • the non-lossy lifetime dispatch counter (engine.metrics.dispatched, already
//     bumped in logLine) → the cumulative session spend proxy + the budget
//     subject.

/** The unattended loop's CONSUMPTION snapshot — PURE over the live worker set +
 *  the lifetime dispatch counter (no IO; `now` injected, defaulting to wall-clock
 *  like {@link sortTodos} so the live caller measures real time while tests pass a
 *  fixed clock). `overLimit` is the budget breach the UI warns on. Definitions
 *  match {@link SwarmConsumption}. */
export const computeSwarmConsumption = (input: {
  liveWorkers: readonly { startedAt: string }[]
  counters: SwarmMetricsCounters
  limit: number
  now?: number
}): SwarmConsumption => {
  const now = input.now ?? Date.now()
  let activeRunMs = 0
  for (const w of input.liveWorkers) {
    const started = Date.parse(w.startedAt)
    // Skip an unparseable/missing startedAt; clamp clock skew to 0 so a worker
    // stamped "in the future" reads as 0, never SUBTRACTING from the total.
    if (Number.isFinite(started)) activeRunMs += Math.max(0, now - started)
  }
  const dispatched = input.counters.dispatched
  return {
    activeWorkers: input.liveWorkers.length,
    activeRunMs,
    dispatched,
    limit: input.limit,
    overLimit: input.limit > 0 && dispatched >= input.limit,
  }
}

const emptyConsumption = (): SwarmConsumption => ({
  activeWorkers: 0,
  activeRunMs: 0,
  dispatched: 0,
  limit: DISPATCH_BUDGET,
  overLimit: false,
})

// ── Worker monitoring (Card②) — the conservative DONE judgement ──────────────

/** What a worker's heartbeat file (`swarm-beat.sh`) tells the monitor. `ready` /
 *  `blocked` DRIVE the conservative DONE judgement (classifyWorker); `phase` /
 *  `note` / `at` are DISPLAY-ONLY passthrough the commander pane renders so each
 *  worker's current phase + one-liner + freshness are legible (条件3). */
export interface HeartbeatSign {
  /** It declared itself integration-ready (readyToMerge). */
  ready: boolean
  /** It explicitly reported a blocker / a blocked phase. */
  blocked: boolean
  /** The RAW `blockers` text the worker wrote (swarm-beat.sh's blocker arg), when
   *  non-empty — the free-text a blocked worker is stuck on. The `blocked` boolean
   *  above already folds it in; this carries the TEXT so the overseer (S4) can read
   *  the actual question the worker is asking. Read-only / absent when empty. */
  blockers?: string
  /** Self-reported phase (audit / implement / verify / …), display-only. */
  phase?: string
  /** One-line summary of what it is doing, display-only. */
  note?: string
  /** ISO of the heartbeat's `updatedAt`, display-only / staleness. */
  at?: string
}

/** What a monitor pass observed about one worker's branch + PTY + heartbeat. */
export interface WorkerProbe {
  /** Is the worker's `claude` PTY still alive? */
  alive: boolean
  /** Commits the worker's branch carries AHEAD of trunk (the project's RESOLVED
   *  trunk — origin/main, origin/master, … — not a hardcoded ref; see
   *  countCommitsAhead). 0 ⇒ no integrable work yet (a freshly-branched or
   *  empty-handed worker). */
  commitsAhead: number
  /** True when the count above could NOT be read (no trunk ref resolved, git
   *  failed, the probe threw) — as opposed to a genuine zero. The two consumers
   *  disagree about which way to fall: the promote gate wants "no proof ⇒ no
   *  promotion" (harmless), while {@link recoveryColumn} wants "no proof ⇒ assume
   *  there IS work" (because guessing zero there orphans a committed branch).
   *  Absent ⇒ false, so an older/handwritten probe literal keeps today's meaning. */
  commitsUnknown?: boolean
  /** The worker's heartbeat sign, or null if it never wrote one. */
  heartbeat: HeartbeatSign | null
}

/** Coarse cause bucket for a dead worker's PTY exit — the only diagnosable trace
 *  left once a crash is reclaimed (2026-07 investigation: workers were observed
 *  dying unattended ~1h into a run with no recorded cause). Four buckets:
 *   - 'signal-kill' — the process was killed by a SIGNAL (OS OOM-kill, an external
 *                      kill, or a fatal fault like SIGSEGV). NOT self-inflicted.
 *   - 'clean'       — exited on its own with status 0.
 *   - 'abnormal'    — exited on its own with a non-zero status (a real crash /
 *                      uncaught error).
 *   - 'unknown'     — no exit code could be captured at all (the PTY session was
 *                      already gone by the time we looked — e.g. deleted by the
 *                      onExit timer before the reclaim ran).
 *
 *  ⚠ SIGNAL IS CHECKED FIRST, AND THAT ORDER IS THE WHOLE POINT. A signal death
 *  arrives as `exitCode 0` PLUS a non-zero signal, never as 137/143 — waitpid's
 *  WIFEXITED and WIFSIGNALED are mutually exclusive, and node-pty's native layer
 *  (unix/pty.cc) zero-initialises ExitEvent then fills exit_code only under the
 *  former and signal_code only under the latter. So a `exitCode === 0 ⇒ clean`
 *  test placed first swallows EVERY signal kill and reports the OOM this module
 *  exists to catch as a voluntary clean exit.
 *
 *  ⚠ AND THE SIGNAL FIELD IS USUALLY EMPTY IN PRODUCTION ANYWAY. The PTY's direct
 *  child is NOT `claude` — terminal.ts spawns a login shell (`zsh -l`) and
 *  claudeTerminal.ts writes `OPENGROUND_OWNED=1 <argv> ; exit` into its stdin, so
 *  `claude` runs as a FOREGROUND JOB. Killing that job does not kill the PTY child:
 *  the shell SURVIVES the signal, runs `exit`, and relays the death as its own
 *  status — the POSIX `128+n` convention. So the signal never reaches node-pty at
 *  all and we see a plain non-zero exitCode.
 *
 *  MEASURED, both arrangements, this repo's node-pty (1.2.0-beta.14), real signals:
 *
 *    A. bare PTY child signalled directly (what a naive probe measures):
 *       SIGKILL(9)→{0,9}  SIGTERM(15)→{0,15}  SIGHUP(1)→{0,1}  SIGSEGV(11)→{0,11}
 *
 *    B. PRODUCTION shape — `zsh -l` + foreground job (what actually happens):
 *       claude OOM-killed (SIGKILL) → {exitCode:137, signal:0}   ← 128+9
 *       claude SIGTERMed            → {exitCode:143, signal:0}   ← 128+15
 *       claude exits 0              → {exitCode:0,   signal:0}
 *       claude exits 3              → {exitCode:3,   signal:0}
 *       pty.kill() (killTerminal)   → {exitCode:1,   signal:0}   ← shell's own exit
 *
 *  Hence BOTH shapes must be recognised. Treating 137/143 as an ordinary non-zero
 *  exit — as an earlier revision of this function did — files the production OOM,
 *  the single case this module exists to catch, under 'abnormal' and sends the
 *  investigator after a CLI crash instead. Reading only the signal field is just as
 *  wrong in the other direction.
 *
 *  Any non-zero signal counts, not just 9/15: SIGHUP(1), SIGSEGV(11), SIGABRT(6)
 *  all arrive with exitCode 0 in arrangement A and would otherwise read 'clean'. */
export type WorkerExitCategory = 'clean' | 'signal-kill' | 'abnormal' | 'unknown'

/** The stuckMoves intents that are recorded AFTER a teardown already ran (see the
 *  alreadyTornDown call site). 'review' is deliberately absent: the promote path
 *  records it without ever tearing a worker down.
 *  ('recover-review' is belt-and-braces — such a kept move always maps back to
 *  reason 'integration-wait', which is not 'crash', so the gate never reaches it.
 *  Listed anyway so the set reads as "every post-teardown intent".) */
const TEARDOWN_INTENTS: ReadonlySet<string> = new Set(['recover', 'recover-review'])

/** Exit statuses a POSIX shell uses to relay "my foreground job was killed by
 *  signal n" — the shape production actually produces (arrangement B above).
 *  128+1(SIGHUP) … 128+31 covers every standard signal; anything at or above 128
 *  is a relayed death rather than a status the job chose. 128 itself is excluded:
 *  it is not a valid 128+n (n≥1) and appears as an ordinary status.
 *
 *  ⚠ TWO KNOWN IMPRECISIONS, both accepted deliberately:
 *   - A program that CHOOSES a status in this band (`exit 130`) is indistinguishable
 *     from a relay — measured, it reads 'signal-kill'.
 *   - The band is a POSIX convention. On Windows the shell is powershell.exe and
 *     128+n means nothing, so a status that lands here is mislabelled.
 *  Both are false POSITIVES: they put a death in the wrong bucket. The alternative —
 *  narrowing the band — reintroduces the false NEGATIVE that made the whole feature
 *  useless (the production OOM read 'abnormal'). A mislabelled bucket costs one
 *  wrong guess; a missed kill costs the investigation. Err toward catching it. */
const SHELL_RELAYED_SIGNAL_MIN = 129
const SHELL_RELAYED_SIGNAL_MAX = 159 // 128 + 31 (Darwin NSIG=32)

export const classifyWorkerExit = (
  exitCode: number | null | undefined,
  exitSignal?: number,
): WorkerExitCategory => {
  // Signal first — see the ordering note above. A directly-signalled PTY child
  // reports exitCode 0, so any `exitCode === 0` shortcut placed before this is a bug.
  if (typeof exitSignal === 'number' && exitSignal > 0) return 'signal-kill'
  if (exitCode === null || exitCode === undefined) return 'unknown'
  if (exitCode === 0) return 'clean'
  // …then the shell-relayed form. In production the signal never reaches node-pty
  // (the login shell absorbs it and exits 128+n), so WITHOUT this branch a real OOM
  // reads 'abnormal' and the investigator is pointed at a CLI crash. MEASURED:
  // claude OOM-killed under `zsh -l` ⇒ exitCode 137.
  if (exitCode >= SHELL_RELAYED_SIGNAL_MIN && exitCode <= SHELL_RELAYED_SIGNAL_MAX) {
    return 'signal-kill'
  }
  return 'abnormal'
}

/** Pure verdict for one worker from its probe (no IO, no clock — `startupElapsed`
 *  is passed in). The DONE rule is deliberately CONSERVATIVE ("壊れていない時だけ
 *  前進"): promote a card doing→review ONLY when the branch has integrable commits
 *  AND a completion sign is present —
 *    • the worker's heartbeat says readyToMerge (it declared success while its
 *      interactive PTY lingers — the common path: a `claude` TUI does not exit
 *      when /order finishes), OR
 *    • the PTY has EXITED and the heartbeat is not blocked (the session ended
 *      with committed work and no reported blocker).
 *  Everything else stays put: no commits ⇒ nothing to review; alive with no
 *  ready-sign ⇒ still working; dead-and-blocked / dead-with-nothing ⇒ left in
 *  'doing' (never promoted as if complete).
 *
 *  `stage` is the coarse display state: 'done' when promote, else 'starting' for a
 *  freshly-booted worker with no sign of work yet, else 'running'. When the worker
 *  is dead-but-not-promoted the stage is irrelevant (the caller drops it). */
export const classifyWorker = (
  probe: WorkerProbe,
  startupElapsed: boolean,
): { promote: boolean; stage: OrchestratorWorkerStage } => {
  const ready = probe.heartbeat?.ready === true
  const blocked = probe.heartbeat?.blocked === true
  const hasWork = probe.commitsAhead > 0
  const promote = hasWork && (ready || (!probe.alive && !blocked))
  if (promote) return { promote: true, stage: 'done' }
  if (!probe.alive) return { promote: false, stage: 'running' }
  const working = hasWork || probe.heartbeat !== null || startupElapsed
  return { promote: false, stage: working ? 'running' : 'starting' }
}

/** Why a worker was reclaimed/recovered — selects its recovery column and labels
 *  the journal. 'crash' = dead PTY; 'stall' = alive but silent past every nudge;
 *  'runaway' = blew the execution-time ceiling WITHOUT ever producing integrable
 *  work (a genuine 暴走); 'integration-wait' = crossed that same ceiling but had
 *  ALREADY reached ready, so it is not a 暴走 and its card belongs in review, not
 *  in the owner's blocked column (2026-07-18); 'rate-limit' = waited on a
 *  usage/quota limit past its grace; 'permission' = a startup prompt bypass
 *  couldn't clear. (Card 4880e9c6.) */
export type WorkerRecoveryReason =
  | 'crash'
  | 'stall'
  | 'runaway'
  | 'integration-wait'
  | 'rate-limit'
  // ('permission' died 2026-08-13 with the PTY worker runtime — the trust
  // dialog it parked on is a TUI frame an SDK session can never render.)
  | 'question'

/** WHY a worker's worktree is being torn down. The recovery reasons above PLUS the
 *  two teardowns that are not recoveries: an owner STOP, and a 差し戻し REWORK
 *  (the card goes back and a fresh worker is dispatched). Every one of them
 *  force-removes a possibly-dirty worktree, so every one of them must first
 *  salvage its uncommitted work — the reason rides into that commit's message so
 *  `git log <branch>` says WHY the WIP commit exists. (2026-07-12 全損 — see
 *  {@link commitWipBeforeTeardown}.) */
export type TeardownReason = WorkerRecoveryReason | 'stopped' | 'rework'

/** Where a LOST/RECLAIMED worker's card goes — called when its PTY is dead and
 *  {@link classifyWorker} did NOT promote it (a crash/kill, a self-declared block,
 *  a "done but produced nothing" finish), OR when an ALIVE worker is reclaimed for
 *  a non-progress reason (stall / runaway / rate-limit / permission). The card
 *  NEVER stays stranded in 'doing' (the old behavior — a zombie card no worker is
 *  draining); it always returns to the board. The reason decides first:
 *    • 'rate-limit' ⇒ 'todo' — a transient WAIT, never a human's problem: requeue
 *      so a later attempt retries once the limit has reset (its committed work is
 *      preserved on the branch). Auto-retry is correct here, NOT a block.
 *    • 'integration-wait' ⇒ 'review' — the worker crossed the execution ceiling
 *      but had ALREADY reached ready, so its branch holds integrable, committed
 *      work. That is a job for the commander (verify → land or 差し戻し), NOT an
 *      owner decision, so it must never land in 'blocked' — the 2026-07-18 harm
 *      was exactly this: a ready worker's card parked in the owner's column where
 *      nobody could act on it. 'review' is where a branch-with-commits belongs.
 *      SCOPE OF THE EXEMPTION (narrowed 2026-07-19): it jumps exactly ONE rule,
 *      `heartbeat.ready ⇒ 'blocked'`, because a 差し戻し'd worker still carries the
 *      stale `ready` from before the 差し戻し. It does NOT jump `heartbeat.blocked`
 *      — that is the worker's own LIVE report that a human is needed, and routing
 *      it to 'review' would discard the one signal it managed to raise.
 *    • 'runaway' ⇒ 'blocked' — a human is needed: a task that blows the time
 *      ceiling WITHOUT ever producing integrable work would just overrun again
 *      on retry. Park, don't loop.
 *  Otherwise (crash / stall — a possibly-transient failure) the heartbeat +
 *  COMMITTED-WORK signal + retry budget decide:
 *    • heartbeat `ready` ⇒ 'blocked' — it DECLARED itself done yet has nothing
 *      integrable; re-running a finished task is wrong, a human checks why.
 *    • heartbeat `blocked` ⇒ 'blocked' — it reported a real blocker; a human
 *      unblocks it (auto-retry would just hit the same wall).
 *    • COMMITTED WORK (`commitsAhead > 0`) ⇒ 'blocked' — the worker committed
 *      integrable work onto its swarm/* branch before it fell over. Requeuing to
 *      'todo' re-dispatches a FRESH branch which OVERWRITES the card's branch field
 *      (defaultRecoverCard keeps the branch, but the next dispatch's todo→doing move
 *      stamps the new one), orphaning the committed branch and paying tokens to
 *      re-implement work already on disk — the 2026-07-22/23 twin-dispatch (two
 *      near-identical swarm branches for ONE card, observed after a batch of workers
 *      crashed mid-gate with their work committed). Park so the commander ADOPTS the
 *      committed branch (or 差し戻し's a trivial commit back to todo). This is the
 *      same "never auto-redo work the engine can already see" principle as the
 *      `ready ⇒ blocked` rule above; a BARE crash (0 commits) still auto-retries via
 *      the budget below — an empty branch has nothing to orphan. (rate-limit /
 *      runaway / question / integration-wait all returned ABOVE, so
 *      this rule only ever governs a plain crash or stall.)
 *    • retry budget spent (`requeues >= maxRequeues`) ⇒ 'blocked' — a card that
 *      reliably kills its worker escalates instead of spinning forever.
 *
 *  ⚠ KNOWN GAP, LEFT AS A DELIBERATE TRADE (2026-08-04). The `rate-limit` arm
 *  returns 'todo' FIRST, before the committed-work rule — so a worker that had
 *  already committed and then hit a quota wall is requeued, and the next dispatch
 *  mints a fresh branch over `card.branch`, orphaning those commits exactly the
 *  way the rule below exists to prevent. Extending the rule here would park every
 *  quota-walled worker that had committed anything (i.e. most of them) and hand
 *  the unattended loop to a human on every wall — a real cost, and a change to
 *  what "autonomous" means rather than a bug fix. The honest repair is for the
 *  re-dispatch to REUSE the existing branch instead of minting one, which is a
 *  dispatch-path change. Flagged here so the next reader inherits the choice
 *  rather than the surprise.
 *    • otherwise (a BARE crash/kill: dead, no completion/blocker sign, no committed
 *      work, budget left) ⇒ 'todo' — a transient failure gets one more attempt.
 *  Pure (no IO, no clock). */
export const recoveryColumn = (
  probe: WorkerProbe,
  requeues: number,
  maxRequeues: number,
  reason: WorkerRecoveryReason = 'crash',
): 'todo' | 'blocked' | 'review' => {
  if (reason === 'rate-limit') return 'todo'
  if (reason === 'runaway' || reason === 'question') return 'blocked'
  // A worker's OWN blocked declaration outranks the integration-wait exemption.
  // The exemption exists to jump ONE rule — `heartbeat.ready ⇒ blocked` below,
  // which a 差し戻し'd worker still trips on its pre-差し戻し heartbeat (the 0718
  // harm). Jumping this one too was collateral: a worker that hit a genuine
  // blocker while re-working WROTE "a human is needed" into its heartbeat, and
  // routing it to 'review' discards that declaration silently — the commander
  // reviews an unverified tip, 差し戻し's it, and the worker hits the same wall.
  // `ready` is a stale artefact of an earlier state; `blocked` is a live report.
  if (probe.heartbeat?.blocked === true) return 'blocked'
  // Now the exemption: crossed the ceiling but had ALREADY delivered ⇒ the
  // commander's queue, never the owner's column.
  if (reason === 'integration-wait') return 'review'
  if (probe.heartbeat?.ready === true) return 'blocked'
  // COMMITTED WORK ⇒ 'blocked', NOT 'todo' (2026-07-23 twin-dispatch root cause).
  // A crash/stall whose branch already carries commits ahead of trunk did REAL work
  // before it fell over. Auto-requeuing to 'todo' lets the next dispatch mint a FRESH
  // swarm/* branch and stamp it onto the card (todo→doing), orphaning the committed
  // branch and spending tokens to redo what is already on disk — exactly the observed
  // twin (d44b5ff0 / 5c286c48 each grew two near-identical branches, one card). Park
  // it so the commander adopts the committed branch instead. Mirrors `ready ⇒ blocked`
  // above: never auto-redo work the engine can see already exists. A BARE crash
  // (commitsAhead === 0) still auto-retries via the budget below — nothing to orphan.
  // …and an UNREADABLE count parks it too (2026-08-04). `commitsAhead` used to be
  // 0 both when the branch was empty and when git could not answer, and this line
  // reads 0 as "safe to requeue". In a repo whose trunk is neither origin/main nor
  // main that was EVERY worker on EVERY pass: a crashed worker's committed branch
  // was orphaned by the next dispatch and the work redone from zero.
  if (probe.commitsAhead > 0 || probe.commitsUnknown === true) return 'blocked'
  if (requeues >= maxRequeues) return 'blocked'
  return 'todo'
}

/** Does a worker's in-flight BACKGROUND TASK still count as life right now? Returns
 *  `now` — positive evidence of life at this instant — when a background task that
 *  started at `bgStartedAtMs` is still unresolved AND still inside `graceMs`; null
 *  otherwise (nothing in flight, or something in flight so long we stop believing it).
 *
 *  The ONE place the fourth channel's cap lives, so the stall monitor and the read-only
 *  worker-stale anomaly can never disagree about it — the same reason
 *  {@link lastActivityMs} is shared. See {@link BG_TASK_GRACE_MS} for what the channel
 *  is and why the grace is 90 minutes. Pure. */
export const backgroundTaskAliveAt = (
  bgStartedAtMs: number | null | undefined,
  now: number,
  graceMs: number = BG_TASK_GRACE_MS,
): number | null =>
  typeof bgStartedAtMs === 'number' && Number.isFinite(bgStartedAtMs) && now - bgStartedAtMs <= graceMs
    ? now
    : null

/** The most recent sign of life from a worker (epoch ms) across BOTH liveness
 *  channels — its heartbeat and its PTY's last output — with its dispatch time as
 *  the floor. Unparseable / missing stamps are ignored; 0 only when nothing at all
 *  resolves (a worker always has a startedAt, so that floor is real in practice).
 *  Shared by the stall monitor AND the read-only worker-stale anomaly so the two
 *  AGREE on "silent": a worker streaming output but not beating (or beating but
 *  quiet) is alive to BOTH. Pure. */
export const lastActivityMs = (a: {
  heartbeatAt?: string
  lastOutputAt?: number | null
  startedAt?: string
  /** Newest mtime across the worker's OWN transcript + its sub-agent transcripts
   *  (already resolved & combined by {@link sessionAgentActivityAt}), or null/absent.
   *  The THIRD liveness channel: a worker sitting inside ONE long turn running a
   *  Task() sub-agent (its adversarial self-review) freezes BOTH its PTY frame and
   *  its (sparse) heartbeat, but that file keeps growing — the worker analog of the
   *  manager delivery clock's sub-agent channel (2026-07-23). Ignored when absent so
   *  every existing caller/read is unchanged. */
  agentActivityAtMs?: number | null
  /** `now` while a BACKGROUND TASK is in flight and inside its grace, else null —
   *  already capped by {@link backgroundTaskAliveAt}. The FOURTH liveness channel,
   *  and the only one that covers a worker whose TURN HAS ENDED: it launched its
   *  completion gate in the background, said "I'll report when it finishes", and is
   *  waiting for the notification. That freezes the other three at once (no beat, no
   *  repaint, no file growth — the turn is over), which is exactly how the engine came
   *  to reclaim four healthy workers on 2026-07-27. Ignored when absent so every
   *  existing caller/read is unchanged. */
  bgTaskAliveAtMs?: number | null
}): number => {
  const cands: number[] = []
  const hb = a.heartbeatAt ? Date.parse(a.heartbeatAt) : Number.NaN
  if (Number.isFinite(hb)) cands.push(hb)
  if (typeof a.lastOutputAt === 'number' && Number.isFinite(a.lastOutputAt)) cands.push(a.lastOutputAt)
  if (typeof a.agentActivityAtMs === 'number' && Number.isFinite(a.agentActivityAtMs)) cands.push(a.agentActivityAtMs)
  if (typeof a.bgTaskAliveAtMs === 'number' && Number.isFinite(a.bgTaskAliveAtMs)) cands.push(a.bgTaskAliveAtMs)
  const st = a.startedAt ? Date.parse(a.startedAt) : Number.NaN
  if (Number.isFinite(st)) cands.push(st)
  return cands.length ? Math.max(...cands) : 0
}

/** Tunables for {@link classifyStall} — injected so the unit test drives the whole
 *  escalation with tiny windows and a fake clock. */
export interface StallParams {
  /** No sign of life (heartbeat NOR real PTY output) for this long ⇒ silent. */
  stallMs: number
  /** Wait this long after a nudge before nudging again / reclaiming. */
  cooldownMs: number
  /** Output within this window after a nudge is the Enter echo, not life. */
  echoGuardMs: number
  /** Nudge attempts before a still-silent worker is reclaimed. */
  maxNudges: number
}

/** What to do about ONE alive worker's (possible) stall — PURE (clock + raw signals
 *  passed in). The escalation, in order:
 *    • active (any REAL life within `stallMs`) ⇒ 'none'.
 *    • silent, never nudged ⇒ 'nudge' (send Enter — the cheap un-stick).
 *    • silent, nudged but still inside `cooldownMs` ⇒ 'none' (let it take effect).
 *    • silent, nudged, cooldown elapsed, budget remains ⇒ 'nudge' again.
 *    • silent, nudges spent, cooldown elapsed, not yet escalated ⇒ 'escalate'
 *      (ESC + a short continue-instruction — tried exactly ONCE before reclaiming).
 *    • silent, already escalated, cooldown elapsed ⇒ 'reclaim' (tear down + re-home).
 *
 *  The 'escalate' step exists because a field test (2026-07-02) found bare-Enter
 *  nudges sometimes fail to un-stick a worker wedged mid-response-generation: 3 of
 *  4 wedged Fable/max workers only recovered after ESC (interrupting the in-flight
 *  request) followed by a short continue instruction. It rides the SAME cooldown /
 *  echo-guard machinery as a nudge (below) — an escalate bumps `lastNudgeAt` just
 *  like a nudge does, so its own PTY echo is discounted identically, and it is
 *  tried exactly once (`escalated` bookkeeping) before falling through to reclaim.
 *
 *  ECHO HANDLING (the load-bearing subtlety): a bare Enter makes a `claude` TUI
 *  repaint, stamping PTY output. So output landing within `echoGuardMs` AFTER our
 *  own nudge (or escalate) is DISCOUNTED — it counts as life for NEITHER the
 *  silence gate NOR the recovery signal. Otherwise the nudge's own echo would keep
 *  a wedged worker looking "alive" (dodging reclaim) and would falsely reset its
 *  budget.
 *
 *  `progressed` = REAL recovery since the last nudge/escalate, by EITHER channel: a
 *  fresh heartbeat (an echo can't write one — /order phases do), OR sustained output
 *  PAST the echo guard (a one-shot repaint can't). Both are needed because
 *  heartbeats are SPARSE (only at phase boundaries): a worker the nudge genuinely
 *  revived often resumes streaming output for many minutes before it next beats,
 *  and that real progress MUST clear the budget — else its next, independent stall
 *  would reclaim with zero nudges. The caller clears the whole nudge/escalate
 *  bookkeeping when `progressed`. */
export const classifyStall = (
  input: {
    /** Heartbeat epoch ms, or null if it never beat. */
    heartbeatAtMs: number | null
    /** PTY last-output epoch ms, or null if none. */
    lastOutputAtMs: number | null
    /** Dispatch epoch ms — the activity floor (a just-spawned worker isn't silent). */
    startedAtMs: number
    /** Newest mtime across the worker's OWN transcript + its sub-agent transcripts,
     *  or null/absent. Life that leaves NO PTY output and NO heartbeat: a worker
     *  sitting inside one long turn running a Task() sub-agent (its adversarial
     *  self-review). Folded into `activity` like the heartbeat — deliberately NOT
     *  echo-guarded, because an Enter/ESC repaint cannot append a transcript entry
     *  nor grow a sub-agent file (only real work does). The worker analog of
     *  {@link defaultManagerDeliveryAt}'s sub-agent channel (7517e4b1 fixed the
     *  desk; 2026-07-23 fixes the worker). Resolved by the caller ONLY for a worker
     *  the cheap channels already call silent — see the monitor's gated backstop. */
    agentActivityAtMs?: number | null
    /** `now` while a BACKGROUND TASK is in flight and inside its grace, else null —
     *  already capped by {@link backgroundTaskAliveAt}. The FOURTH channel, and the
     *  only one that survives the worker ENDING ITS TURN: a worker that launched
     *  `npm test` in the background and is waiting for the completion notification
     *  emits no beat, no repaint and no file growth, yet is doing precisely what the
     *  completion gate demands. Folded into `activity` like the others and likewise
     *  NOT echo-guarded — an Enter/ESC repaint cannot start a background task. See
     *  {@link BG_TASK_GRACE_MS} for the 2026-07-27 false-kill this closes. Resolved by
     *  the caller ONLY for a worker the cheap channels already call silent. */
    bgTaskAliveAtMs?: number | null
    /** Prior nudge bookkeeping, or undefined if never nudged. */
    nudge: { count: number; lastNudgeAt: number; escalated?: boolean } | undefined
  },
  now: number,
  p: StallParams,
): { action: 'none' | 'nudge' | 'escalate' | 'reclaim'; progressed: boolean; silentMs: number } => {
  const count = input.nudge?.count ?? 0
  const lastNudgeAt = input.nudge?.lastNudgeAt ?? 0
  const escalated = input.nudge?.escalated ?? false

  // Discount the Enter echo: output within echoGuardMs after our nudge/escalate is
  // the TUI repaint, not life. Kept output is either pre-nudge or sustained past
  // the guard.
  const realOutput =
    input.lastOutputAtMs !== null && count > 0 && input.lastOutputAtMs <= lastNudgeAt + p.echoGuardMs
      ? null
      : input.lastOutputAtMs
  // The file-based liveness channel (transcript + sub-agent mtime). NOT echo-guarded:
  // a repaint can't write these, so any freshness here is real work in flight.
  const agentAt = input.agentActivityAtMs ?? null
  // The BACKGROUND-TASK channel (already capped at BG_TASK_GRACE_MS by the caller):
  // `now` while a task is genuinely in flight, so it zeroes silentMs for exactly as
  // long as we are willing to believe that task is still running — and not one tick
  // longer. Deliberately NOT echo-guarded for the same reason as agentAt: a repaint
  // cannot start a background task.
  const bgAliveAt = input.bgTaskAliveAtMs ?? null
  const activity = Math.max(
    input.heartbeatAtMs ?? Number.NEGATIVE_INFINITY,
    realOutput ?? Number.NEGATIVE_INFINITY,
    agentAt ?? Number.NEGATIVE_INFINITY,
    bgAliveAt ?? Number.NEGATIVE_INFINITY,
    input.startedAtMs,
  )
  const silentMs = Math.max(0, now - activity)
  // Real recovery since the nudge/escalate — a fresh heartbeat, real (post-echo-guard)
  // output, OR file activity (transcript/sub-agent grew) strictly after it. Any clears
  // the budget; an echo can fake none. The background-task channel is deliberately NOT
  // a `progressed` signal: it is `now` by construction, so counting it would clear the
  // nudge budget on every pass for as long as a task sits in flight — and it cannot
  // matter anyway, since an in-flight task already makes silentMs 0 (the gate below
  // returns 'none' before the budget is ever consulted).
  const progressed =
    count > 0 &&
    ((input.heartbeatAtMs !== null && input.heartbeatAtMs > lastNudgeAt) ||
      (realOutput !== null && realOutput > lastNudgeAt) ||
      (agentAt !== null && agentAt > lastNudgeAt))

  if (silentMs < p.stallMs) return { action: 'none', progressed, silentMs } // alive
  if (count > 0) {
    if (progressed) return { action: 'none', progressed: true, silentMs } // recovered; re-stall handled fresh next pass
    if (now - lastNudgeAt < p.cooldownMs) return { action: 'none', progressed: false, silentMs } // give the nudge/escalate time
    if (count >= p.maxNudges) {
      // Nudge budget spent — try the ESC+continue escalation exactly once before
      // giving up on the cheap paths and reclaiming.
      if (!escalated) return { action: 'escalate', progressed: false, silentMs }
      return { action: 'reclaim', progressed: false, silentMs } // escalation ALSO failed, still silent
    }
  }
  return { action: 'nudge', progressed: false, silentMs }
}

// The rate/usage-limit WORDING detector — normalizeScreen, RATE_LIMIT_PATTERNS,
// matchesRateLimit, RATE_LIMIT_TAIL_MAX, endsInRateLimit — lived here (layer B's
// eyes) until 2026-07-13, when it moved VERBATIM to swarmRateLimitText.ts so the
// pre-launch tier probe (swarmTierProbe) can reuse the exact same patterns
// without importing this engine (probe → engine → probe would be a cycle, and a
// copy would drift the moment the CLI rewords a notice). Re-exported here so
// existing importers keep their paths; the engine itself imports the helpers at
// the top of this file like any other module.
export { RATE_LIMIT_PATTERNS, RATE_LIMIT_TAIL_MAX, endsInRateLimit } from './swarmRateLimitText'


// (PERMISSION_PROMPT_PATTERNS and the permission-wait arm were DELETED
// 2026-08-13 with the PTY worker runtime: the trust dialog is a claude TUI
// frame on a PTY, and an SDK session — launched with bypassPermissions
// structurally — can never render one.)

/** The reset time A5 (the CLI usage sensor) offers as a cooling horizon, or null.
 *
 *  A5's `resetsAt` is a STANDING display — the current window's end, shown even
 *  at 3% usage — so it is only trusted when that slot is actually SPENT
 *  (pct >= 100). Without the gate, a RATE_LIMIT_PATTERNS match on a transient
 *  429/5xx blip would cool a healthy tier until the session reset (up to ~5h) —
 *  a full park once cascaded — instead of the 20min grace (must-fix 差し戻し
 *  0708). When BOTH slots are spent the session's (sooner) reset wins: a
 *  too-early resume just re-marks on the next sighting, while over-trusting the
 *  weekly reset could park for days. Read-only peek (honors K8). */
const a5CoolingHint = (): string | null => {
  const a5 = peekCachedUsage()
  if (a5?.session && a5.session.pct >= 100) return a5.session.resetsAt
  if (a5?.weekAll && a5.weekAll.pct >= 100) return a5.weekAll.resetsAt
  return null
}

/** Classify a worker's recent output into WHY it might not be progressing:
 *    • 'question' — claude asked a FREE-TEXT question and idles awaiting the
 *                   owner (C3; detector in swarmQuestions.ts).
 *    • 'normal'   — otherwise; ordinary work (the silence-based stall path then
 *                   applies if it has also gone quiet).
 *  PURE (the only input is the text) — the TIMING gates live in the monitor.
 *  A null/empty output ⇒ 'normal' (no signal — never invent a wait).
 *
 *  ⚠ SHRUNK 2026-08-13 with the PTY worker runtime. Two arms died here:
 *  'permission-wait' (a PTY-only TUI frame — see the note above) and the
 *  'rate-limited' WORDING route (matchesRateLimit over a rendered screen). A
 *  quota stop is now decided by the pool's own verdict — the monitor's
 *  `quotaBlocked` read — which already outranked wording ("You're out of usage
 *  credits…" matched none of our patterns, 2026-08-04), not by guessing at
 *  text. `kind` is REQUIRED now (it used to default to 'pty'): every caller
 *  states which runtime's question detector it wants, and a legacy 'pty' kind
 *  simply yields 'normal' (the PTY question detector died too). */
export const classifyOutput = (
  screen: string | null,
  kind: WorkerRuntimeKind,
): 'question' | 'normal' => {
  if (!screen) return 'normal'
  if (detectWorkerFreeTextQuestion(kind, screen)) return 'question'
  return 'normal'
}

/** Has a worker blown the hard execution ceiling? Judged on its WORKING time:
 *  wall-clock since dispatch MINUS `idleMs`, every span it was demonstrably NOT
 *  working (see {@link executionCredit}) — today that is the INTEGRATION wait:
 *  READY, idle, pending the commander ({@link integrationWaitCredit}). The
 *  2026-07-18 loss: ready at 04:18, 差し戻し at 04:46, judged "runaway 91m" one
 *  pass later and parked in 'blocked' — 28 minutes of queue latency charged to
 *  the worker as work. Not the worker's doing; must not spend its budget.
 *  (The RATE-LIMIT hold credit — the 2026-07-12 sibling — died 2026-08-13 with
 *  the hold itself: a quota-stopped worker is requeued, not held.)
 *
 *  True iff its dispatch time is known (finite, > 0) and `maxExecMs` of WORKING
 *  time has elapsed. The finite/positive guard is load-bearing: a worker with an
 *  unparseable / missing startedAt is NEVER judged over the ceiling (no false kill
 *  on a clockless fixture). `idleMs` defaults to 0 — a worker that never waited is
 *  judged byte-for-byte as before — and a negative / non-finite credit is floored
 *  to 0 (a corrupt ledger can only ever make the check STRICTER, never grant
 *  infinite life). Pure (clock injected).
 *
 *  NOTE this answers "over the ceiling", NOT "is a 暴走", and NOT "may be torn
 *  down". Both of those belong to the caller, and BOTH were once described here
 *  in terms this function cannot deliver (2026-07-20 — the comment claimed a ready
 *  worker "is never labelled runaway", full stop, while the field produced exactly
 *  that label):
 *    • the LABEL is the caller's `readyAt` split — a worker the engine SAW deliver
 *      is stopped as 'integration-wait' (card → review), one it did not is a 暴走
 *      (card → blocked). `readyAt` is a poll observation, so a delivery made while
 *      the engine was blind used to arrive unwitnessed and wear the 暴走 label; the
 *      caller now also accepts the worker's own ready heartbeat — but ONLY on a
 *      差し戻し (`reworkAt` set) — and RECORDS it, so a bare premature ready (no
 *      commits, never 差し戻し'd) cannot fake a delivery and buy the exemption.
 *    • the TEARDOWN is unconditional once over the ceiling — both labels stop the
 *      worker and reclaim its worktree. Which is why the caller does not hand this
 *      function `startedAt` after a 差し戻し: it passes the CURRENT assignment's
 *      origin (`reworkAt`), so a re-work gets its own budget instead of being
 *      stopped on the pass that ordered it. See monitorWorkers' ceiling check. */
export const isRunaway = (
  startedAtMs: number,
  now: number,
  maxExecMs: number,
  idleMs = 0,
): boolean => {
  const credit = Number.isFinite(idleMs) ? Math.max(0, idleMs) : 0
  return Number.isFinite(startedAtMs) && startedAtMs > 0 && now - startedAtMs - credit >= maxExecMs
}

// ── Engine state (per project, on a globalThis singleton) ────────────────────

/** One card whose Board COLUMN MOVE keeps being KEPT (the write is rejected /
 *  errors) pass after pass — the anti-zombie tracker. `intent` is WHICH move is
 *  stuck (doing→review / review→done / lost-worker recovery); `attempts` is how
 *  many consecutive passes it has been kept. Reset to 1 when the intent changes
 *  (a different move), cleared the moment a move lands, escalated + surfaced once
 *  `attempts` crosses {@link MOVE_STUCK_MAX_RETRIES}. In-memory only. */
export interface StuckMove {
  intent: 'review' | 'done' | 'recover' | 'recover-review'
  attempts: number
  branch: string
  taskTitle: string
  /** For `intent:'recover-review'` ONLY — WHICH ceiling shape the original stop
   *  was, carried across the retry. The retry rebuilds the recovery from scratch
   *  on a later pass, and without this it fell back to the default 「差し戻し後の
   *  再作業」 verb: a 'capped-wait' or 'work' stop would log 「再作業 0m」 and then,
   *  one line later, claim a re-work that never happened — the exact contradiction
   *  02章 §5.6 forbids and this branch's own test pins. */
  shape?: 'rework' | 'capped-wait' | 'work'
}

/** A live ProjectEngine. Exported so the dispatch-pass unit test can drive a
 *  plain engine literal with fake deps — no timers, no globalThis. The `timer`
 *  handle and `log`/`workers` arrays are mutated in place by the loop. */
export interface ProjectEngine {
  /** Canonical project path — the engine key. */
  path: string
  /** True while the autonomous drain chain is scheduled. */
  running: boolean
  /** Owner EXPLICITLY paused the engine via the OFF toggle (stopOrchestrator). While
   *  set, {@link maybeAutoStartDrain} will NOT auto-start the drain — so a manual OFF
   *  genuinely halts new dispatch (条件2) even though a DEFAULT-off engine auto-drains
   *  on an idle-slot + todo backlog (条件1). Cleared by a manual ON (startOrchestrator),
   *  so the two toggle actions are the auto-drain consent. Optional (absent ⇒ NOT
   *  paused: a fresh / legacy engine auto-drains). This flag is the in-memory HALF: the
   *  stop/start toggles mirror it to `Settings.swarmManualStop` (the persisted record —
   *  see isSwarmManualStopPersisted), which maybeAutoStartDrain ALSO consults so the
   *  pause survives a restart, and which the state API surfaces so "stopped by hand"
   *  is machine-readable from outside (the 0707 twin-dispatch root cause). */
  manualStop?: boolean
  /** card 2b — this engine is `running` because the BOOT RESUME brought it back
   *  (`resumeEngines` honoured the persisted `desiredRunning:true`), not because
   *  the owner pressed ON in this session. Purely informational: the Swarm UI
   *  renders a "your last session's autonomy was restored" notice off it, since
   *  card 2 made the old `!running` restart reminder unreachable in exactly this
   *  case. In-memory only, and CLEARED by either power-switch action
   *  (startOrchestrator / stopOrchestrator) — after the owner touches the switch
   *  the engine's state is theirs, not a restored one. Optional (absent ⇒ not a
   *  resumed engine), so every existing engine literal in the tests stays valid. */
  autonomyResumed?: boolean
  /** True while a pass is mid-flight — the re-entrancy guard that GUARANTEES no two
   *  passes ever overlap (twin-dispatch defense). The setTimeout chain already
   *  serializes the SCHEDULED passes, but a stop→start within a slow pass's await
   *  window (or any future second driver) could otherwise run two passes at once,
   *  both reading the same pre-spawn worker set and dispatching the same card
   *  twice. runEnginePass check-and-sets this synchronously at entry, so the second
   *  pass bails before it can spawn. In-memory only. */
  /** Has THIS engine reconciled its persisted roster against reality yet?
   *  Only resumeEngines does that (reconcileRoster → adoptResumeCandidates), so
   *  engines started by startOrchestrator / maybeAutoStartDrain run with `false`.
   *  syncRoster reads it to decide whether an empty in-memory roster is EVIDENCE
   *  ("reconciled, nobody survived" ⇒ may overwrite) or merely IGNORANCE
   *  ("never looked" ⇒ must merge, never erase). See syncRoster. */
  rosterReconciled?: boolean
  passInFlight: boolean
  /** True while an INTEGRATE pass is mid-flight — its own re-entrancy guard, now
   *  that the (slow: per-card tsc/vitest verify + a diff-scaled adversarial
   *  review panel, minutes to ~20m) integrate stage runs BESIDE the tick instead
   *  of inside the passInFlight window. Holding passInFlight across it starved
   *  the monitor: every 3s tick bailed for the whole verify, so a worker that
   *  hit a rate limit mid-verify wasn't even LOOKED at until the vitest run
   *  finished (the measured 21-minute detection lag's third leg — and with the
   *  diff-scaled panel budget the blackout could reach 20 minutes). Guarded by
   *  kickIntegratePass (check-and-set synchronously, cleared in finally), so
   *  integrate passes still never overlap EACH OTHER. Optional (older-build /
   *  test-literal backfill). In-memory only. */
  integrateInFlight?: boolean
  /** Per-engine CRITICAL-SECTION tail — the FIFO promise chain {@link runExclusive}
   *  serializes the board-mutating dispatch pass against the owner's control-plane
   *  mutations (stop/resolve), so a stop/resolve can never INTERLEAVE with the
   *  monitor's await window and have its card-park silently overwritten by the
   *  still-looping monitor's stale pass-start snapshot. SEPARATE from
   *  {@link passInFlight} (which only bars a second PASS from overlapping — a control
   *  op never sets it): this lock is what a control op WAITS on. Absent ⇒ an idle
   *  (resolved) queue. In-memory only. */
  lock?: Promise<void>
  /** Monotonic start epoch — bumped on every (re)start so a STALE scheduling chain
   *  (a kick still awaiting when stop→start fired) dies at its next scheduleNext
   *  instead of arming a SECOND timer beside the fresh chain (which would tick two
   *  passes forever — the duplicate-chain zombie). Only the chain whose captured
   *  generation still equals this re-arms. In-memory only. */
  generation: number
  /** The pending setTimeout handle (the next pass), or null when stopped. */
  timer: ReturnType<typeof setTimeout> | null
  /** Workers the engine dispatched and still counts as live (≤ MAX_WORKERS). */
  workers: OrchestratorWorker[]
  /** card 3 — the last roster signature written to disk (identity + stage + rework
   *  markers of `workers`, EXCLUDING the time-varying workedMs). syncRoster() writes
   *  the roster only when this changes, so a plain time-passing tick (no set/stage/
   *  rework transition) does no I/O — the plan §3 "書くのは状態遷移点のみ" guard.
   *  In-memory only; a fresh boot starts undefined so the first sync always writes. */
  rosterSig?: string
  /** SDK spawn-failure backoff (SDK-only workers, 2026-08-13). Set when
   *  deps.spawnWorker throws SdkWorkerUnavailableError; while `until` is in the
   *  future the fill stage attempts NO new spawns (monitor/promote/reclaim run
   *  unaffected). Cleared by the first successful spawn. `failures` walks the
   *  backoff ladder; `notifiedAt` throttles the owner bell. In-memory like the
   *  rest of the engine's cognition — a restart retries immediately, which is
   *  the right bias (the cause may have been fixed while we were down). */
  sdkSpawnHold?: { until: number; failures: number; reason: string; notifiedAt: number }
  /** Read-only integration readiness of the review-column swarm cards, refreshed
   *  each integration pass (the "統合可" display). */
  reviews: OrchestratorReview[]
  /** Branches a real auto-integration attempt found to CONFLICT — skipped on
   *  later passes (no churny re-rebase) until they become fast-forwardable or
   *  leave review. In-memory only (the card carries the persistent stamp). */
  conflictedBranches: Set<string>
  /** Branches whose VERIFICATION (tsc on the rebased-onto-trunk tree) was RED,
   *  keyed branch → the exact tip sha that failed. The merge gate consults this to
   *  SKIP re-running tsc every pass for an unchanged-red branch (no fan thrash),
   *  while a NEW commit (different tip ⇒ a fix) re-verifies and can land. Pruned
   *  when the branch leaves review. In-memory only. */
  verifyFailed: Map<string, string>
  /** Branches whose ADVERSARIAL REVIEW (the independent N-reviewer majority vote
   *  that runs AFTER verify is green, card a14329dc) returned must-fix, keyed
   *  branch → the exact tip sha that was sent back. Consulted exactly like
   *  {@link verifyFailed}: a stuck worker re-reporting the SAME commit re-reworks
   *  WITHOUT re-spawning the (expensive) claude panel, while a NEW commit (a fix)
   *  re-reviews and can land. Pruned when the branch leaves review. In-memory only. */
  reviewFailed: Map<string, string>
  /** Branches whose adversarial review keeps reaching NO majority (defer), keyed
   *  branch → {tip, consecutive-defer count, per-lens abstention tallies}. After
   *  {@link MAX_REVIEW_DEFERS} defers on the SAME tip the panel is no longer
   *  re-spawned (it would just re-burn N claude sessions every pass — e.g. a
   *  systemic claude outage makes all reviewers abstain forever) — the card is
   *  surfaced "needs a human" and held until a NEW commit (different tip) resets
   *  the count. `abstains` accumulates `lens(cause)` → times-seen across the
   *  streak, so the needs-human hand-off can say WHO abstained WHY how often
   *  (完了条件3) instead of a bare 「多数決つかず」. Pruned when the branch
   *  leaves review. In-memory only. */
  reviewDeferred: Map<string, { tip: string; count: number; abstains: Record<string, number> }>
  /** Branches under a HIGH-RISK FORCE-HOLD (2026-07-15): their diff touches
   *  release/CI/signing/dependency/secrets-grade paths ({@link HIGH_RISK_PATHS} —
   *  the same set as the commander's manual-merge rule, skills/og-manage/SKILL.md
   *  §「マージ」手順 0), so the engine withholds auto-integration BY DESIGN — the
   *  card stays in 'review' and ONLY a human's manual merge lands it. Keyed
   *  branch → {tip at hold time, the matched paths}. The tip memo keeps the hold
   *  log/notification to one per commit (a re-pass on the same tip is silent); a
   *  NEW commit re-evaluates — if it no longer touches the set, the hold lifts
   *  and the normal verify→review→integrate path resumes. detectAnomalies reads
   *  this to surface the 'high-risk-hold' anomaly (+ fatal notification). Pruned
   *  when the branch leaves review. In-memory only. */
  highRiskHolds: Map<string, { tip: string; files: string[] }>
  /** Wall-clock (ms) of the last integration pass — the INTEGRATE_TICK_MS gate. */
  lastIntegrateAt: number
  /** When each swarm branch now in review was FIRST SEEN waiting (branch → epoch ms) —
   *  the OUTCOME clock behind {@link managerIntegrationStalled}. Stamped on first sight,
   *  pruned the moment the branch leaves review (same `present` sweep as the conflict /
   *  verify memos), so a card actually being integrated or 差し戻し-ed removes its entry
   *  and the "oldest waiting" instant moves FORWARD by itself — progress resets the clock
   *  without any separate bookkeeping. A newly promoted card does NOT reset it: the oldest
   *  one is still waiting, which is the thing being measured. Optional for older-build /
   *  test literal backfill (absent ⇒ lazy-init).
   *
   *  ⚠ NO LONGER IN-MEMORY-ONLY (2026-08-14). It is MIRRORED to `engine.json`
   *  ({@link EngineIntent.reviewWaitingSince}) and SEEDED BACK by the boot auto-resume,
   *  because "in-memory only, a restart relaunches the engine OFF" stopped being true
   *  the day resumeEngines started honouring `desiredRunning` — and this clock is the
   *  DWELL half of the stall check. A restart re-stamped every waiting branch as
   *  "arrived just now", so each app restart rewound the 40-minute timer from zero (three
   *  releases in one day rewound it three times, and a commander that had stopped
   *  integrating was never once judged stalled). The engine restarts on every
   *  self-update — exactly when work is most likely to be left waiting — so the clock
   *  that measures the stall was being reset by the loop it exists to catch.
   *  {@link startOrchestrator} still CLEARS it on an explicit owner ON, deliberately:
   *  time the engine was OFF must not count as 統合待ち. */
  reviewSeenAt?: Map<string, number>
  /** Signature of the `reviewSeenAt` set as last MIRRORED to disk — the cheap guard that
   *  keeps the mirror a state-transition write rather than a per-pass one (the same rule
   *  syncRoster follows). In-memory only; a stale/absent value costs one redundant write. */
  reviewSeenPersisted?: string
  /** The PENDING "a worker is ready" NOTICE — the delivery channel (2026-07-27) that
   *  exists purely to TELL the commander, as against the nudge that exists to REVIVE it.
   *
   *  Queued the pass a branch is FIRST seen waiting in review (the completion EVENT the
   *  engine never used to have), and cleared the pass it is delivered. Holds only WHICH
   *  branches are the news — how many are waiting is read fresh at delivery, since a
   *  notice may have waited out a long generation. Pruned against the review column on
   *  the same sweep as {@link reviewSeenAt}, so it can never announce a branch the
   *  commander has already integrated. ONE SLOT, newest wins: the payload is
   *  "work is waiting, go look",
   *  so a second arrival before the first is delivered simply refreshes it — nothing is
   *  lost by not queueing both, and an unbounded queue would let a long generation turn
   *  into a burst of lines typed at the desk the moment it frees up.
   *
   *  Undelivered is the normal resting state, not an error: the desk may be mid-turn or
   *  hold half-typed text, and both mean "not now, try the next tick" (15s). In-memory
   *  only, like every other reflex. */
  managerNotice?: { branches: string[]; queuedAt: number } | null
  /** MANAGER RESURRECTION reflex state (2026-07-15 card B) — the in-memory bookkeeping
   *  that lets the engine RE-wake a stopped/hung commander without (a) double-spawning a
   *  booting desk or (b) looping forever on one that keeps dying:
   *    - `attempts`   — consecutive resurrections since the desk was last seen HEALTHY.
   *                     Reset to 0 when it responds again (or no work is waiting); at
   *                     {@link MAX_MANAGER_RESUME_ATTEMPTS} the reflex gives up + escalates.
   *    - `lastWakeAt` — wall-clock (ms) of the last wake, so a freshly-woken desk gets
   *                     {@link MANAGER_RESUME_GRACE_MS} to boot + beat before re-judging.
   *    - `fatalFired` — the 'manager-unrevivable' escalation is one-shot per episode
   *                     (cleared when the desk recovers / no work waits).
   *    - `nudges` / `lastNudgeAt` — the SEPARATE budget for poking a desk that is up but
   *                     quiet (2026-07-18). Deliberately not merged with `attempts`: a
   *                     live desk is not a failed resurrection, must never spawn a second
   *                     desk, and must never reach 'manager-unrevivable' (完了条件2+3).
   *  Optional (absent ⇒ zero, lazy-init) for older-build / test-literal backfill. In-memory
   *  only — a restart relaunches the engine OFF anyway, so the reflex starts disarmed. */
  managerResume?: {
    attempts: number
    lastWakeAt: number
    fatalFired: boolean
    nudges?: number
    lastNudgeAt?: number
    /** One-shot "it ignored every nudge" log per episode (cleared with the rest). */
    unresponsiveLogged?: boolean
    /** Consecutive pokes that wrote NOTHING (2026-08-04) — the desk is live but
     *  the session store no longer names it, so neither writer can address it.
     *  Counted apart from `nudges` because an un-sent poke is not a turn the desk
     *  ignored; charging it to the budget retired the reflex without the
     *  commander ever having been spoken to. */
    unaddressable?: number
    /** One-shot "we cannot reach the desk" log per episode. */
    unaddressableLogged?: boolean
    /** Has the 'manager-unresponsive' BELL already rung this episode (2026-08-14)?
     *
     *  The two dead ends below it — the spent nudge budget and the three-times-
     *  undeliverable poke — used to end in ONE engine log line and then permanent
     *  silence, on the reasoning that a wedged desk is "a human matter". It is; the
     *  gap was that no human was ever told (docs/commander/03 §7-9/§7-10 recorded
     *  this as a regression in reachability, and the field bug of 2026-08-14 is what
     *  it looks like: two cards in review, the desk alive and idle, no bell).
     *  Episode-scoped like every other latch here — cleared when the review queue
     *  DRAINS or the desk is seen genuinely working, never on a mere respawn (a new
     *  desk inside the SAME waiting batch must not re-ring the bell). */
    unresponsiveFatalFired?: boolean
    /** Has the unresponsive SDK desk already been RECYCLED this episode (2026-08-14)?
     *  Same episode scope as `unresponsiveFatalFired`, and for a stronger reason: it
     *  is what stops a wedged desk being torn down and respawned in a loop. Never set
     *  for a PTY desk — that one shares the owner's cwd (see the recycle site). */
    deskRecycled?: boolean
    /** Wall-clock (ms) of the last NOTICE we typed into the desk (2026-07-27). Not a
     *  budget — the notice has none — but a SELF-WRITE instant, and it has to join
     *  `lastNudgeAt` / `lastWakeAt` in the echo cutoff the presence probe is handed.
     *  Our own keystrokes make claude's TUI repaint, which stamps `lastOutputAt`
     *  whether or not anything processed them; counting that as life would let a
     *  notice refund the nudge budget of a WEDGED desk and silently retire the
     *  resuscitation guard (the exact trap `echoUntil` was added for). */
    lastNoticeAt?: number
    /** One-shot "the desk paints but integration is stalled" log per episode — the line
     *  that explains why an `'active'` desk is being poked at all (2026-07-22). */
    stallLogged?: boolean
    /** Has the spent nudge budget already been re-armed once this episode
     *  ({@link MANAGER_NUDGE_REARM_MS})? Caps the engine's voice at ≤6 pokes per waiting
     *  batch — without it a batch that never drains (a card parked awaiting the owner)
     *  would be poked every hour forever. */
    nudgeRearmed?: boolean
    /** Has the desk we last SPAWNED ever been seen genuinely working ('active')?
     *
     *  Cleared on every spawn, set the first time presence reads 'active'. It is what
     *  separates "a desk exists" from "our resurrection actually WORKED", and without it
     *  the give-up guard cannot fire: 'idle' resets `attempts` (a live desk really does
     *  falsify "unrevivable"), so a desk that boots and dies over and over — never doing
     *  any work — would be resurrected forever with no escalation and no log line.
     *  Absent ⇒ treated as PROVEN, so a desk we never spawned (the owner's own, started by
     *  hand) can never be escalated about. */
    provenSinceWake?: boolean
    /** Did the LAST wake actually SPAWN a desk (wakeManager ⇒ true), or fail to for want
     *  of a usable model tier (false — every allowed tier cooling/masked)? It is ONE of the
     *  two signals that separate a TRANSIENT give-up (a quota wall that lifts on its own —
     *  no desk was ever seated, so retrying costs ZERO tokens) from a PERMANENT one (a desk
     *  that spawns and dies on arrival — a boot-crash bug; retrying just burns a desk each
     *  time, which is exactly what the give-up guard exists to stop). Re-armed after the
     *  backoff (完了条件2) when this reads `false` OR the give-up check finds every allowed
     *  tier currently unusable (`spawnBlock` — 2026-07-22: this bit alone missed the case
     *  where the LAST wake's probe passed and a desk WAS seated, but it then died on arrival
     *  for the same quota reason a `false` here would have shown). Absent ⇒ treated as
     *  spawned (permanent), the conservative default. Reset with the rest of this object on
     *  a full disarm (swarmCards.length === 0) — a stale `true`/`false` must never judge a
     *  NEW episode's first give-up on a PREVIOUS episode's outcome. */
    lastWakeSpawned?: boolean
  }
  /** How many times each card (taskId) has been RE-QUEUED after a lost worker —
   *  the {@link recoveryColumn} retry budget. Bumped on a 'todo' requeue, reset
   *  when the card is parked in 'blocked' (so a human requeue starts fresh) or
   *  succeeds/leaves the retry cycle. In-memory only. */
  recoveries: Map<string, number>
  /** How many consecutive passes a worker's teardown has been REFUSED because a
   *  desk is still live in its worktree (`stillOccupied`), keyed by taskId. The
   *  refusal's own contract is "the caller retries and the worktree stays intact
   *  meanwhile" — but no caller implemented it: the engine re-homed the card and
   *  dropped the worker from the roster, leaving a live claude in a worktree
   *  nobody owns (and, on the SDK pool, holding its slot for the life of the
   *  process, since a non-reaped session is never swept). Bounded by
   *  {@link MAX_TEARDOWN_RETRIES} so a genuinely wedged worker still frees its
   *  slot, loudly. Carries the ORIGINAL recovery reason so the retry finishes the
   *  job it started instead of re-detecting the fault (which re-fired one-shot
   *  side effects — see the retry short-circuit in monitorWorkers). Optional
   *  (absent ⇒ empty, lazy-init) so a hand-written test engine literal keeps
   *  compiling. In-memory only. */
  teardownRetries?: Map<string, { tries: number; reason: WorkerRecoveryReason }>
  /** How many times each card (taskId) has been sent review→doing on a 差し戻し
   *  (rework) — the {@link MAX_REWORKS} loop guard. Bumped on every rework; KEPT
   *  while the card is mid-cycle (doing/review) or PARKED past the budget (in
   *  'blocked' with count > MAX_REWORKS, which detectAnomalies reads to surface the
   *  'rework-exhausted' anomaly); PRUNED the moment the card reaches a
   *  fresh-start/success column (todo|done) so a human re-queue or a completion
   *  starts its budget fresh (mirrors swarm-board.sh's rework counter reset). Keyed
   *  by taskId — a card may be re-dispatched to a FRESH branch, so the branch is the
   *  wrong key. In-memory only. */
  reworks: Map<string, number>
  /** LEARNING LOOP (card fdf714ef): the REASON each card (taskId) was last sent
   *  back — a 差し戻し / rollback's cause: the RED verify tail (which tsc/test) or
   *  the adversarial-review must-fix summary. RECORDED by {@link reworkOrPark}
   *  every rework (overwritten so it's always the LATEST failure); CONSUMED +
   *  deleted by {@link runDispatchPass} when the SAME card is re-dispatched (it
   *  hands the reason to the fresh worker's /order via buildOrderInjection, so the
   *  swarm stops repeating the same failure), and the dispatch log records whether
   *  it was injected; PRUNED alongside {@link reworks} ({@link pruneReworks}) when
   *  the card reaches 'done' / vanishes so a stale reason never lingers. Keyed by
   *  taskId (stable across the fresh branch a re-dispatch mints), exactly like
   *  {@link reworks}. In-memory only. */
  reworkReasons: Map<string, string>
  /** How many times each card (taskId) has had a 統合 CONFLICT delegated back to its
   *  worker for a rebase-resolution (card 012a2848) — the {@link MAX_CONFLICT_REWORKS}
   *  loop guard, SEPARATE from {@link reworks} (a conflict is not the worker's code
   *  being wrong, just the trunk having moved, so it gets its own budget — mixing the
   *  two would prematurely park a card that legitimately reworked then merely hit a
   *  moved trunk). Bumped on every conflict delegation; KEPT across the doing/todo hop
   *  (taskId-keyed, stable across a re-dispatched branch); PRUNED when the card lands
   *  or leaves the cycle ({@link pruneReworks}) and cleared on a deliberate human
   *  resolve (resolveOrchestratorReview / stopOrchestratorWorker), exactly like
   *  {@link reworks}. In-memory only. */
  conflictReworks: Map<string, number>
  /** Cards whose Board COLUMN MOVE is stuck (kept pass after pass) — keyed by
   *  taskId. The anti-zombie tracker: bumped on every kept move, cleared when the
   *  move lands, escalated to 'blocked' (recovery) / surfaced as a 'move-stuck'
   *  anomaly once past {@link MOVE_STUCK_MAX_RETRIES}. See {@link StuckMove}.
   *  Pruned by board column (pruneStuckMoves) the moment a card leaves the stuck
   *  situation, so a resolved zombie never lingers. In-memory only. */
  stuckMoves: Map<string, StuckMove>
  /** Per-worker (keyed by terminalId) Enter-nudge bookkeeping for STALL recovery:
   *  how many times we've nudged this silent-but-alive worker and when last, plus
   *  whether the one-shot ESC+continue ESCALATION (past the nudge budget) has
   *  already been tried. Bumped on each nudge / set on escalate, cleared on real
   *  recovery (a post-nudge heartbeat) or when the worker leaves the live set
   *  (reclaimed / promoted-and-exited). Keyed by terminalId — not taskId — so a
   *  re-dispatched card's fresh worker gets a fresh budget. In-memory only.
   *  (Card stall self-healing; escalation added 2026-07 after a field test showed
   *  a bare Enter alone can leave a worker wedged — see {@link classifyStall}.) */
  nudges: Map<string, { count: number; lastNudgeAt: number; escalated?: boolean }>
  /* (The rate-limit HOLD ledger — `rateLimited`, `rateLimitHeldMs`,
   * `limitScreen`, `permissionWaits` — was DELETED 2026-08-13 with the PTY
   * worker sensor layer. A quota-stopped worker is requeued after
   * QUOTA_STOP_DEBOUNCE_MS instead of being held in place for 20 minutes, so
   * there is no hold span left to credit back to the execution clock; the
   * integration-wait credit below is the surviving half.) */
  /** Per-worker (keyed by terminalId) INTEGRATION-WAIT stamp: the epoch ms this
   *  worker was promoted to 'review' and started WAITING for the commander to
   *  integrate it. Set by {@link beginIntegrationWait} on every promote, banked +
   *  cleared by {@link endIntegrationWait} when a 差し戻し sends the card back to
   *  'doing'. A ready worker is IDLE, not working — see {@link integrationWaitMs}.
   *  Optional (older-build backfill). In-memory only. */
  integrationWaitSince?: Map<string, number>
  /** Per-worker (keyed by terminalId) BANKED integration wait, in ms: the total
   *  time this worker sat READY, waiting for the commander to integrate it.
   *  Credited back to its execution clock so 統合待ち never spends the MAX_EXEC_MS
   *  budget (the 2026-07-18 loss — see {@link integrationWaitCredit}). Added to on
   *  every 差し戻し ({@link endIntegrationWait}), dropped when the worker leaves
   *  the live set. Optional (older-build backfill). In-memory only. */
  integrationWaitMs?: Map<string, number>
  /** Per-worker (keyed by terminalId) FREE-TEXT-QUESTION bookkeeping (C3): the
   *  escalation receiptKey of the question last raised to the T3 inbox for this
   *  worker — so one question is raised once (openEscalation is idempotent too;
   *  this just spares the per-pass capture/notify I/O), while a NEW question
   *  from the same worker (different key) raises anew. Cleared when the screen
   *  reads normal again or the worker leaves the live set. Optional for engines
   *  minted by an older build (backfilled on start). In-memory only. */
  questionRaised?: Map<string, string>
  /** Per-worker (keyed by terminalId) FREE-TEXT-QUESTION hold clock (C3 MF2):
   *  `since` (epoch ms) the worker was first seen idling at a detected question.
   *  Drives the "hold for QUESTION_GRACE_MS so the owner's answer can W16-inject,
   *  then PARK in 'blocked'" bound — so an unanswered / false-positive question
   *  doesn't squat the slot until the runaway ceiling. Cleared when the screen
   *  reads normal or the worker leaves the live set. Optional (older-build
   *  backfill). In-memory only. */
  questionWaits?: Map<string, { since: number }>
  /** Drain/dispatch/integrate journal (ring buffer, oldest-first). */
  log: OrchestratorLogLine[]
  /** State inconsistencies detected on the latest pass (read-only — see
   *  detectAnomalies). Rebuilt every pass; surfaced verbatim by the state API. */
  anomalies: OrchestratorAnomaly[]
  /** SELF-SUPPLY (card b3fbbfba) state — armed flag + scan throttle + per-day cap
   *  bookkeeping. Default OFF; the engine proposes its own improvement cards only
   *  while this is enabled (and even then they are owner-approval-gated). In-memory
   *  only (a restart re-arms OFF — fail-safe). See {@link SelfSupplyRuntime}. */
  selfSupply: SelfSupplyRuntime
  /** OVERSEER (EPIC C / C-core) state — the autonomous proxy-you watcher's runtime:
   *  the third arm-able stage (D1), armed flag + edge-dedup (seen) + dwell (watch) +
   *  brain budget + fire-and-forget mailbox. Default OFF, in-memory ONLY (a restart
   *  re-arms OFF — K2). ASYMMETRIC to selfSupply: an explicit autonomy OFF
   *  (stopOrchestrator) CLEARS `overseer.enabled`, and an auto-drain re-ignition never
   *  sets it (only the owner POST does — D1). Optional for an engine minted by an
   *  older build (backfilled on retrieval). See {@link OverseerRuntime}. */
  overseer: OverseerRuntime
  /** Identity keys of FATAL events already pushed to the human (the escalation
   *  safety valve's RISING-EDGE dedup): a state-derived fatal condition
   *  (rework-exhausted / all-workers-down) notifies ONCE on enter and is removed
   *  the moment it clears, so a genuine recurrence re-notifies but a persisting
   *  one never spams every pass. In-memory only. (See fireFatalNotifications.) */
  notified: Set<string>
  /** EDGE-triggered fatal events queued by the monitor (e.g. a worker reclaimed
   *  for overrunning MAX_EXEC_MS) for the next runEnginePass to push, then drain.
   *  Unlike `notified` these are one-shot occurrences (not re-derivable state), so
   *  they're enqueued at the site and fired exactly once. In-memory only. */
  pendingFatal: SwarmFatalNotification[]
  /** KPI lifetime event counters (the analytics layer's denominators) — bumped
   *  in {@link logLine} by event kind so they survive the journal ring buffer.
   *  In-memory only (a restart resets them — a per-session roll-up). See
   *  {@link SwarmMetricsCounters} / {@link computeSwarmKpis}. */
  metrics: SwarmMetricsCounters
  /** The last DYNAMIC-SCALE target logged (card ea369937), as a string signature
   *  ("<target>"), so {@link runDispatchPass} emits the scale-decision journal line
   *  only when the target CHANGES — the dashboard shows scaling transitions
   *  (上がった/下がった) instead of a 3s heartbeat that would churn the 200-line ring
   *  buffer. Optional (a fresh engine has no prior decision). In-memory only. */
  lastScaleSig?: string
  /** QUOTA PARK (card 0add9d30) — epoch ms of the earliest reset while every
   *  ENABLED model tier is cooling (swarmAllowedModels.spawnBlock), mirrored here
   *  ONLY so the dashboard can show the deadline — the table itself lives in
   *  swarmQuota, this is not a second source of truth. Absent ⇒ not parked, OR
   *  parked with no deadline (every tier switched OFF — see {@link spawnBlockSig}).
   *  In-memory only. */
  parkUntil?: number
  /** The SPAWN PARK's enter-edge signature (`'none-allowed'` | `'cooling:<ms>'`) —
   *  what {@link runDispatchPass} compares to log the hold once (and escalate a
   *  none-allowed hold once) instead of every 3s tick. Absent ⇒ not held. Covers
   *  BOTH park kinds, where {@link parkUntil} can only express the cooling one
   *  (an all-tiers-disabled hold has no deadline). In-memory only. */
  spawnBlockSig?: string
  /** Card ids the engine is RIGHT NOW spawning a worker for — reserved BEFORE
   *  {@link OrchestratorDeps.spawnWorker} and released once that card's todo→doing
   *  move has settled (or the spawn threw). The window it covers: a worktree spawn
   *  takes hundreds of ms during which the card is still `todo` on the board and
   *  not yet in {@link workers}, so a CONCURRENT manual dispatch
   *  (`POST /api/swarm/worker`) would see a free card and spawn a TWIN worker on
   *  the same card (two branches, a guaranteed integration conflict). The manual
   *  route consults it through {@link isCardDispatchInFlight}. Engine-vs-engine
   *  needs no such reservation — passes are serialized by runExclusive. Optional
   *  (an engine minted by an older build backfills it on retrieval). In-memory only. */
  pendingDispatch?: Set<string>
}

interface OrchestratorStore {
  engines: Map<string, ProjectEngine>
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_swarm_orchestrator: OrchestratorStore | undefined
}

// Survive `tsx watch` reloads exactly like terminal.ts / roles.ts: the running
// flag + worker set live on globalThis, so a module re-eval doesn't silently
// abandon a running engine (which would keep its PTYs but lose the cap count).
const store: OrchestratorStore =
  globalThis.__openground_swarm_orchestrator ??
  (globalThis.__openground_swarm_orchestrator = { engines: new Map() })

const getOrCreateEngine = (key: string): ProjectEngine => {
  let engine = store.engines.get(key)
  if (!engine) {
    engine = {
      path: key,
      running: false,
      manualStop: false,
      passInFlight: false,
      generation: 0,
      timer: null,
      workers: [],
      reviews: [],
      conflictedBranches: new Set(),
      verifyFailed: new Map(),
      reviewFailed: new Map(),
      reviewDeferred: new Map(),
      highRiskHolds: new Map(),
      lastIntegrateAt: 0,
      recoveries: new Map(),
      teardownRetries: new Map(),
      reworks: new Map(),
      reworkReasons: new Map(),
      conflictReworks: new Map(),
      stuckMoves: new Map(),
      nudges: new Map(),
      integrationWaitSince: new Map(),
      reviewSeenAt: new Map(),
      integrationWaitMs: new Map(),
      questionRaised: new Map(),
      questionWaits: new Map(),
      log: [],
      anomalies: [],
      selfSupply: initSelfSupplyRuntime(),
      overseer: initOverseerRuntime(),
      notified: new Set(),
      pendingFatal: [],
      metrics: emptyMetricsCounters(),
      pendingDispatch: new Set(),
    }
    store.engines.set(key, engine)
  } else {
    // Defensive backfill: an engine persisted on globalThis by an EARLIER build
    // (a `tsx watch` reload across the commit that added stage ③) predates the
    // integration fields, so a bare `engine.conflictedBranches.has(...)` would
    // throw. Materialize any missing field once on retrieval. Harmless in prod
    // (forked fresh each boot); it only ever fires on a dev hot-reload.
    engine.manualStop ??= false
    engine.passInFlight ??= false
    engine.generation ??= 0
    engine.reviews ??= []
    engine.conflictedBranches ??= new Set()
    engine.verifyFailed ??= new Map()
    engine.reviewFailed ??= new Map()
    engine.reviewDeferred ??= new Map()
    engine.highRiskHolds ??= new Map()
    engine.lastIntegrateAt ??= 0
    engine.anomalies ??= []
    engine.recoveries ??= new Map()
    engine.reworks ??= new Map()
    engine.reworkReasons ??= new Map()
    engine.conflictReworks ??= new Map()
    engine.stuckMoves ??= new Map()
    engine.nudges ??= new Map()
    engine.integrationWaitSince ??= new Map()
    engine.integrationWaitMs ??= new Map()
    engine.reviewSeenAt ??= new Map()
    engine.integrateInFlight ??= false
    engine.questionRaised ??= new Map()
    engine.questionWaits ??= new Map()
    engine.selfSupply ??= initSelfSupplyRuntime()
    engine.overseer ??= initOverseerRuntime()
    engine.notified ??= new Set()
    engine.pendingFatal ??= []
    engine.metrics ??= emptyMetricsCounters()
    engine.pendingDispatch ??= new Set()
  }
  return engine
}

/** Is the autonomous engine ALREADY dispatching (or already running) a worker for
 *  this card? The mutual-exclusion probe the MANUAL dispatch route
 *  (`POST /api/swarm/worker`) asks before it claims a card, so the two dispatch
 *  paths can never put TWO workers (two `swarm/*` branches) on one card:
 *
 *    • `pendingDispatch` — the engine picked the card and is mid-spawn: the board
 *      still reads `todo` and {@link ProjectEngine.workers} is still empty for it.
 *    • `workers` — the engine's live roster, which also covers the case where the
 *      spawn landed but the card's todo→doing move was KEPT (a rejected write is
 *      retried next pass, so the board can lag behind the roster).
 *
 *  PURE READ — never mutates, never creates an engine (a project whose engine was
 *  never started answers false). The reverse direction is closed by the board
 *  itself: once the manual route's CAS claim moves the card to `doing`,
 *  {@link selectDispatch} no longer sees a todo card. */
export const isCardDispatchInFlight = async (
  projectPath: string,
  taskId: string,
): Promise<boolean> => {
  const engine = store.engines.get(await canonicalize(projectPath))
  if (!engine) return false
  if (engine.pendingDispatch?.has(taskId)) return true
  return engine.workers.some((w) => w.taskId === taskId)
}

/** Marks an owner-answer line inside the rework-reason slot, so the rework
 *  conduit's overwrites can recognise and PRESERVE it (see
 *  {@link mergeReworkReason}) and the /order reader sees its provenance. */
export const ESCALATION_ANSWER_MARKER = '【本人からの回答(escalation)】'

/** Separator between segments inside the rework-reason slot. A CONTROL byte
 *  (US, 0x1f) — deliberately NOT a content-bearing string like ' / ', which an
 *  owner answer legitimately contains (paths `src/a / src/b`, options
 *  `A / B`): splitting on that would fragment the answer and silently drop the
 *  marker-less tail. Segments can never contain this byte (the escalation
 *  conduit strips control bytes from its input; mergeReworkReason flattens the
 *  mechanical reason) and the /order consumer folds it to a plain space
 *  (buildOrderInjection → flattenOneLine), so the joined line stays readable. */
export const REWORK_REASON_SEP = '\x1f'

// Same control-byte flattening as swarmWorker's flattenOneLine — keeps every
// slot segment separator-free by construction.
// eslint-disable-next-line no-control-regex
const SLOT_CONTROL_BYTES = /[\x00-\x1f\x7f]/g

/** Overwrite semantics for the rework-reason slot that never lose an owner
 *  answer: the slot's mechanical rework reason IS meant to be replaced by the
 *  newest one (accumulating stale reasons was never the contract), but any
 *  escalation-answer segments (C1) queued in the same slot outrank machinery
 *  and must survive — INTACT — until a dispatch consumes them. Pure + exported
 *  for tests. */
export const mergeReworkReason = (existing: string | undefined, reasonLine: string): string => {
  // Flatten the incoming mechanical reason so it can't smuggle the separator
  // (verify tails etc. may carry raw control bytes).
  const fresh = reasonLine.replace(SLOT_CONTROL_BYTES, ' ')
  const answers =
    existing
      ?.split(REWORK_REASON_SEP)
      .filter((s) => s.includes(ESCALATION_ANSWER_MARKER) && !fresh.includes(s)) ?? []
  return [...answers, fresh].join(REWORK_REASON_SEP)
}

/** C1 escalation → next-dispatch conduit (docs/OVERSEER_DESIGN.md §8): when the
 *  owner answers an escalation whose worker is GONE, the answer rides the SAME
 *  learning-loop slot as rework reasons ({@link ProjectEngine.reworkReasons} →
 *  `priorFailure` → the fresh worker's /order), so the re-dispatched card starts
 *  with the owner's decision instead of re-asking. In-memory like the rest of
 *  the engine (a restart drops it — the escalation record itself stays
 *  'answered' in the inbox, so nothing is silently lost).
 *
 *  Two rules keep the slot coherent under concurrency:
 *   • the write happens INSIDE the engine critical section — the dispatch pass
 *     reads → spawns (await) → DELETES this slot under {@link runExclusive}, so
 *     a lock-free set landing mid-pass would be wiped by that delete without
 *     ever being read;
 *   • the line is clamped (the /order goal is one argv-bound slash-command
 *     line — the full answer lives on the escalation record) and marker-
 *     prefixed so {@link mergeReworkReason} can preserve it across later
 *     mechanical rework overwrites. */
/** What the owner's answer says about MOVING the card, read from the answer
 *  itself rather than from who happened to ask.
 *
 *  ⚠ WHY THE ANSWER, NOT THE ASKER (cycle-4, correcting cycle-3's correction).
 *  Gating the unpark on "a worker asked this" fixed the case where 「B: このまま
 *  保留」 itself moved the card — and broke its twin: the overseer's S5/S1
 *  raises offer 「A: 順番待ちの列に戻して、作業を再開させる」, and the unpark is
 *  the ONLY engine route out of 'blocked', so choosing A became a silent no-op
 *  while the UI promised delivery. Both options belong to the same menu; the
 *  discriminator has to be which one the owner picked.
 *
 *  The menus are OURS (swarmOverseer's plainQuestion templates), so the leading
 *  option letter is the strongest signal and is checked first — keyword scans
 *  come second precisely because a label like 「A: このまま任せる」 carries a
 *  hold-shaped phrase inside a resume-shaped choice. Anything unreadable is
 *  'unstated', which keeps the conservative caller-supplied default. PURE. */
export type UnparkIntent = 'resume' | 'hold' | 'unstated'

// Each phrase must be a DECISION on its own. 'そのままで' is deliberately ABSENT:
// it read 「そのままで大丈夫です、進めてください」 (a RESUME) as hold and stranded
// the card the unpark exists to free (measured 2026-08-04).
//
// The short natural holds below (保留 / 中止 / キャンセル / 待って / 止めて / やらなくて)
// were added the same night, after a measurement showed 「保留で」「このままで」
// 「いったん止めて」「やらなくていい」「中止して」「キャンセルで」「待って」 ALL
// resolving to 'unstated' — which, on a worker-asked question, UNPARKS. An
// unrecognised hold silently became a resume; an unrecognised resume is
// harmless. The asymmetry ran the wrong way.
// ⚠ EVERY ENTRY MUST BE A DECISION, NOT A NOUN (re-learned the hard way, twice in
// one night). The first version of this list was too narrow and short holds fell
// through to 'unstated'; the fix for that added the BARE words 保留 / 中止 /
// キャンセル / 待って / stop / cancel — and those are ordinary vocabulary in a
// card about a cancel button, a stop condition or a hold queue. Measured
// consequences of the bare forms, every one of which means RESUME and read as
// hold: 「保留の理由は解決したので戻してください」「待っている間に確認しました。進めて
// ください」「キャンセル機能の実装はそのままで、進めてください」「中止条件のテストだけ
// 直して、再開してください」"Go ahead, the cancel button is fine"
// "Continue — do not stop until tests pass" "Resume. The stopwatch widget is
// unrelated." (`stop`/`cancel` as substrings also hit stopped / stopwatch /
// non-stop / cancellation).
//
// So each phrase carries its own verb or particle. The cost is that a bare 「待って」
// or 「保留」 with no ending reads as 'unstated' — which, on an overseer-raised
// question, leaves the card where the owner already put it. That is the harmless
// side; matching a feature name is not.
const HOLD_PHRASES = [
  // 保留 needs its own ending: 「保留していた件、進めてOKです」 is a RESUME, so a
  // bare 保留し would strand it.
  'このまま保留', '保留で', '保留に', '保留のまま', '保留。', '保留です',
  '保留してください', '保留しておいて', '保留とし', '見送', '諦め',
  '止めておく', '止めてください', '止めてほしい', 'いったん止め',
  '中止して', '中止で', '中止に', 'キャンセルして', 'キャンセルで',
  // 待ってください/待ちます etc. — never the bare 待って, which is inside
  // 待っている / 待ってて, nor the bare 待ち, which is inside 順番待ち (the S5
  // menu's RESUME label).
  '待ってください', '待ってほしい', '待ちます', '待ちたい', '待とう',
  'やらなくて', 'やらないで', '動かさないで', '触らないで', 'そのまま置いて',
  'leave it', 'on hold', 'keep it parked', 'hold off', 'do not proceed',
]
const RESUME_PHRASES = [
  '戻して', '戻す', 'todo へ戻', 'todoへ戻', '再開', 'もう一度', 'やり直',
  '続きを', '続行', '進めて', 'resume', 'continue', 'go ahead',
]

// A refusal to resume IS a hold — not the absence of a decision. Scrubbing these
// to nothing (the first version of this rule) left 「再開しないでください」 as
// 'unstated', which on the worker-asked lane unparks: the owner's explicit "do
// not" produced exactly the act they refused (measured 2026-08-04, adversarial
// review of my own fix). The English arm only ever worked because "leave it on
// hold, do not resume" carries a second hold phrase; a bare 「再開しないで」 had
// nothing left.
const NEGATED_RESUME =
  /(?:\b(?:do not|don'?t|never|no need to)\s+(?:resume|continue|go ahead)|(?:再開|続行|進め)(?:は)?(?:せず|しないで|ないで|なくて))/i
// The mirror: a negated HOLD is not a hold. 「見送らずに再開してください」 must not
// be read as hold just because 見送 appears in it.
const NEGATED_HOLD =
  /(?:(?:見送|保留|止め|諦め|中止|キャンセル)(?:に|は|を)?(?:し|せ|ら|り|め)?(?:ず|ないで|なくて)|\b(?:don'?t|do not|never)\s+(?:hold|stop|cancel|pause))/i
// An option letter is only a CHOICE when it stands alone, opens a labelled option,
// or is followed by a particle that makes it the OBJECT of the sentence —
// 「A」「A: …」「A。」「Aで」「Aに」「Aを」「Aが」「Aの方針で」「Aだね」「Aと思います」「A案で」
// 「A please」. A letter that merely begins a word is prose: 「Aさんに聞いてから
// 決めます」 and "a human should look at this — leave it parked" both resolved to
// RESUME under the old letter-then-any-non-alphanumeric rule (measured 2026-08-04).
//
// ⚠ THE PARTICLE LIST IS LOAD-BEARING, AND IT WAS TOO SHORT (measured hours later,
// same night). With only で/に/案 the most ordinary phrasings — 「Aをお願いします」
// 「Aがいいです」「Aの方針で」「Aを選びます」「A please」 — fell through to 'unstated',
// and on an OVERSEER-raised question (workerAddressed=false) 'unstated' means
// "leave the card parked": the owner picked A, the UI said the answer was
// delivered, and the card never moved — verbatim the cycle-4 failure this reader
// was rewritten to fix. The same gap flipped B answers the other way on the
// worker lane. Widen before narrowing: a missed particle is a silent no-op.
const LEADING_OPTION =
  /^([abABＡＢａｂ])(?:\s*[:：.。、,)）\]】]|\s*(?:で|に|を|が|の|だ|と|案)|\s+please\b|\s*$)/i

/** Read the owner's DECISION out of their answer.
 *
 *  ⚠ FEED IT THE ANSWER, NEVER THE QUESTION+ANSWER LINE. The queued line is a
 *  concatenation whose FIRST half is the question — and the question carries
 *  the menu, so any scan over the line finds 「A: …」 before the owner's word.
 *  Measured 2026-08-04: every answer, including 「B: このまま保留」 and a plain
 *  English "Leave it on hold", resolved as resume and the card moved.
 *
 *  DIRECTION OF DOUBT: when both a hold and a resume signal survive, HOLD wins.
 *  The old rule was "the last decision word wins", which read
 *  「いまは保留にしておいて、来週になったら再開しよう」 as resume and moved the card
 *  NOW. Position is not scope. Preferring hold can only leave a card where the
 *  owner already put it; preferring resume overrides what they said. PURE. */
export const readUnparkIntent = (answer: string): UnparkIntent => {
  const s = (answer ?? '').replace(/\s+/g, ' ').trim()
  if (!s) return 'unstated'
  const norm = (c: string) => c.toLowerCase().replace('ａ', 'a').replace('ｂ', 'b')
  // 1. The option letter — the menus are OURS, so a real choice is the strongest
  //    signal and is checked first (a label like 「A: このまま任せる」 carries a
  //    hold-shaped phrase inside a resume-shaped choice).
  const lead = LEADING_OPTION.exec(s)
  if (lead) return norm(lead[1]) === 'a' ? 'resume' : 'hold'
  // 2. An explicit refusal to resume is a HOLD, stated.
  if (NEGATED_RESUME.test(s)) return 'hold'
  // 3. Strip negated HOLD words so only genuine ones are counted below.
  const scrubbed = s.replace(new RegExp(NEGATED_HOLD.source, 'gi'), ' ')
  const has = (phrases: readonly string[]): boolean =>
    phrases.some((p) => scrubbed.toLowerCase().includes(p.toLowerCase()))
  // 4. Hold wins a tie — see DIRECTION OF DOUBT above.
  if (has(HOLD_PHRASES)) return 'hold'
  if (has(RESUME_PHRASES)) return 'resume'
  return 'unstated'
}

export const recordEscalationAnswerForNextDispatch = async (
  projectPath: string,
  taskId: string,
  line: string,
  /** `workerAddressed` — did a WORKER ask the question this answers? The
   *  escalation record's persisted address is the evidence (swarmEscalations
   *  passes it). Only then is the unpark below meaningful: an overseer/board
   *  raise ("this card has been stuck — what should I do?") carries no worker,
   *  so 'blocked' is the OWNER's placement and their 「このまま保留」 must not
   *  be the thing that moves it. Absent ⇒ false (never unpark on a guess). */
  opts?: { workerAddressed?: boolean; answer?: string },
  deps?: {
    fetchTasks?: (p: string) => Promise<ProjectTask[]>
    unpark?: (p: string, id: string) => Promise<boolean>
    countCommitsAhead?: (p: string, branch: string) => Promise<number | null>
  },
): Promise<void> => {
  // Control bytes → space FIRST (so the segment can never contain
  // REWORK_REASON_SEP), then whitespace-fold + clamp.
  const text = line.replace(SLOT_CONTROL_BYTES, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
  if (!text) return
  const engine = getOrCreateEngine(await canonicalize(projectPath))
  const marked = text.includes(ESCALATION_ANSWER_MARKER)
    ? text
    : `${ESCALATION_ANSWER_MARKER} ${text}`
  let recorded = false
  await runExclusive(engine, async () => {
    const existing = engine.reworkReasons.get(taskId)
    // A re-delivery retry re-records the SAME answer — don't stack duplicates.
    if (existing?.split(REWORK_REASON_SEP).includes(marked)) return
    engine.reworkReasons.set(
      taskId,
      existing ? `${existing}${REWORK_REASON_SEP}${marked}` : marked,
    )
    recorded = true
  })
  if (!recorded) return
  // ── UNPARK (2026-08-03 overnight review, must-fix) ────────────────────────
  // This lane exists because the worker was GONE, and the commonest way it is
  // gone is that the engine PARKED it for the very question the owner just
  // answered (recoveryColumn: reason 'question' ⇒ 'blocked', QUESTION_GRACE_MS).
  // But 'blocked' is the HUMAN lane — the dispatch pass never picks from it. So
  // the answer sat in reworkReasons for "the next dispatch" that could not
  // happen, and from the owner's seat the card simply never moved again after
  // they answered. Recording the answer and leaving the card parked is a dead
  // end; the record and the unpark are ONE act, so they live together.
  //
  // Narrow on purpose: only a card still sitting in 'blocked' moves, and only
  // to 'todo' (the dispatch queue). A card in todo/doing/review is already
  // live or queued — touching it could yank work out from under a running
  // worker; a 'done' / vanished card is not ours to resurrect.
  // ⚠ logAwaited, NOT logLine: logLine's journal append is FIRE-AND-FORGET
  // (`void appendEngineJournalLine`), which is fine on the engine's own tick but
  // NOT here — this tail runs after an awaited board fetch, so the dangling
  // write outlived its caller and landed in a directory a test had already
  // started removing (ENOTEMPTY, doctrine §8: my own async tail racing
  // teardown, the second time). Awaiting the append keeps the line AND ends the
  // work inside the call the owner's answer is waiting on.
  const logAwaited = async (level: 'info' | 'warn', message: string): Promise<void> => {
    const entry = { at: new Date().toISOString(), level, message } as const
    engine.log.push(entry)
    if (engine.log.length > MAX_LOG_LINES) engine.log.splice(0, engine.log.length - MAX_LOG_LINES)
    await appendEngineJournalLine(engine.path, entry).catch(() => {})
  }
  // WHAT THE OWNER CHOSE decides, with "who asked" only as the tie-breaker:
  //   • 'hold'     — 「B: このまま保留」: never move it, whoever asked.
  //   • 'resume'   — 「A: 戻して再開」: move it, even though no worker asked
  //                  (the overseer's S5/S1 raises are exactly this shape, and
  //                  the unpark is the ONLY engine route out of 'blocked').
  //   • 'unstated' — free text with no menu choice: fall back to the worker
  //                  rule (a worker's question ⇒ resume it; nobody asked ⇒
  //                  leave the card where it is).
  // The ANSWER, never `line` — see readUnparkIntent's warning. An older caller
  // that passes no answer degrades to 'unstated', i.e. the who-asked fallback.
  const intent = readUnparkIntent(opts?.answer ?? '')
  if (intent === 'hold') return
  if (intent === 'unstated' && !opts?.workerAddressed) return
  try {
    const tasks = await (deps?.fetchTasks ?? defaultFetchTasks)(engine.path)
    const card = tasks.find((t) => t.id === taskId)
    if (!card || columnOf(card) !== 'blocked') return
    // ⚠ COMMITTED WORK STAYS PARKED — the twin-dispatch root fix (2026-07-23),
    // which this unpark bypassed when it first shipped (caught the same night by
    // the review fleet). A worker reclaimed for a question has already had its
    // uncommitted work WIP-committed onto its swarm/* branch by the teardown. A
    // dispatch from 'todo' spawns a FRESH worker with NO worktree, so
    // createSwarmWorktree mints a NEW swarm/* branch and moveToDoing stamps it
    // onto the card — orphaning the saved commits and redoing the work from
    // zero. recoveryColumn refuses exactly this (`commitsAhead > 0 ⇒ blocked`);
    // 'question' returns 'blocked' before reaching that line, so the guard has
    // to be re-stated HERE, at the other door into the dispatch queue.
    // The answer is still recorded either way — it rides the next dispatch of
    // this card whenever the commander sends it back.
    const branch = typeof card.branch === 'string' ? card.branch : ''
    const ahead = branch
      ? await (deps?.countCommitsAhead ?? defaultCountCommitsAhead)(engine.path, branch)
      : 0
    // `null` = git could not answer. STAY PARKED: unparking mints a fresh branch
    // over card.branch on the next dispatch, so guessing "no commits" here is the
    // one guess that destroys work. Parked is always recoverable — the commander
    // adopts the branch — while an orphaned branch is found only by hand.
    if (ahead === null || ahead > 0) {
      await logAwaited(
        'info',
        ahead === null
          ? `escalation answer recorded for card ${taskId}, but it stays in blocked — could not read how many commits ${branch} carries (git did not answer). Re-dispatching could orphan committed work, so the commander decides this one.`
          : `escalation answer recorded for card ${taskId}, but it stays in blocked — ${branch} already carries ${ahead} commit(s). Re-dispatching would mint a new branch and orphan them; the commander integrates or 差し戻し's this branch instead.`,
      )
      return
    }
    const ok = await (deps?.unpark ?? ((p: string, id: string) => setCardColumn(p, id, 'todo', '')))(
      engine.path,
      taskId,
    )
    await logAwaited(
      ok ? 'info' : 'warn',
      ok
        ? `escalation answer recorded — card ${taskId} unparked (blocked → todo) so the next dispatch carries it`
        : `escalation answer recorded but the unpark write FAILED for card ${taskId} — it stays in blocked; move it to todo to resume`,
    )
  } catch (e) {
    // FAIL-OPEN: the answer IS recorded (that write already succeeded). A board
    // read/write fault must not lose it — say so and let the owner move the card.
    await logAwaited(
      'warn',
      `escalation answer recorded but the unpark check failed for card ${taskId} (${e instanceof Error ? e.message : String(e)}) — move it from blocked to todo to resume`,
    )
  }
}

/** Per-engine CRITICAL SECTION — serialize the autonomous tick's board-mutating
 *  dispatch pass ({@link runDispatchPass}, driven by {@link runEnginePass} /
 *  {@link maybeAutoStartDrain}) with the owner's control-plane mutations
 *  ({@link stopOrchestratorWorker} / {@link resolveOrchestratorReview}) so the two
 *  never INTERLEAVE their read→decide→write on the shared card + worker state.
 *
 *  WHY (the bug this closes): a dispatch pass's monitor reads the board ONCE at pass
 *  start (the `byId` snapshot) and iterates the pass-start `engine.workers`; both go
 *  stale the instant a control op mutates them inside one of the monitor's await
 *  windows (countCommitsAhead / readHeartbeat). A `stop` that lands there kills the
 *  PTY, parks the card in 'blocked', and drops the worker — yet the still-looping
 *  monitor, blind to all three, re-homes that SAME card from its stale 'doing'
 *  snapshot (recoverLost → 'todo', or promote → 'review' when commitsAhead>0),
 *  silently undoing the owner's explicit halt and re-dispatching the very card they
 *  stopped. Running both through this ONE FIFO queue removes the interleave: a control
 *  op runs fully before or fully after a pass, so each always observes the other's
 *  COMMITTED result (a fresh board read + a current worker set), never a half-updated
 *  one.
 *
 *  A plain promise-chain mutex — append to the tail, run after it settles, and let
 *  the NEXT link chain off this section's settlement (success OR failure) so one
 *  thrown section never poisons the queue (every caller guards itself anyway). The
 *  returned promise settles with `fn`'s OWN result, so a caller still sees its real
 *  return/throw. NOT re-entrant — the route-driven control plane, the tick, and the
 *  integrate pass's write sections enter it, never one nested inside another
 *  (verified: no section body calls back into runExclusive).
 *  The SLOW integrate awaits (per-card tsc/vitest verify + the multi-minute
 *  adversarial-review panel) are intentionally NOT wrapped — blocking an owner's
 *  stop/resolve click on those would be a worse regression. Since the integrate
 *  pass now runs BESIDE the tick (kickIntegratePass — no longer serialized against
 *  the monitor by passInFlight), its board/worker WRITE sections (reworkOrPark /
 *  delegateConflict / the integrated-land block) DO take this section, so the
 *  monitor, the control plane, and integrate's mutations all serialize; only the
 *  slow read/verify stages overlap the tick. */
const runExclusive = <T>(engine: ProjectEngine, fn: () => Promise<T>): Promise<T> => {
  const prior = engine.lock ?? Promise.resolve()
  // Run our section once the prior holder settles — whether it fulfilled OR rejected
  // (a failed section must still release the queue), so the chain never wedges.
  const result = prior.then(
    () => fn(),
    () => fn(),
  )
  // The next waiter chains off THIS section's settlement, error-swallowed, so the tail
  // is always a clean Promise<void> (one section's throw can't poison the next).
  engine.lock = result.then(
    () => {},
    () => {},
  )
  return result
}

const logLine = (
  engine: ProjectEngine,
  level: OrchestratorLogLine['level'],
  message: string,
  // 'routine' marks the per-pass bookkeeping lines the dashboard hides by
  // default (slot freed / card gone / column reconciled) — see
  // OrchestratorLogLine.kind. Omit for a meaningful event (always shown).
  kind?: OrchestratorLogLine['kind'],
): void => {
  const entry: OrchestratorLogLine = { at: new Date().toISOString(), level, message, ...(kind ? { kind } : {}) }
  engine.log.push(entry)
  if (engine.log.length > MAX_LOG_LINES) {
    engine.log.splice(0, engine.log.length - MAX_LOG_LINES)
  }
  // Append-through to disk (survives a restart — the ring buffer above does
  // not). Fire-and-forget: appendEngineJournalLine fails open internally, so
  // this never delays or breaks the caller's dispatch/promote/... flow.
  void appendEngineJournalLine(engine.path, entry)
  // Tap the SAME line into the NON-LOSSY KPI counters (the analytics layer): this
  // is the one chokepoint every dispatch/promote/integrate/conflict/crash/stall/
  // rework event already flows through, so counters survive the ring buffer above
  // without hooking any event site. Bump-only — never changes what the engine does.
  const metricKey = classifyMetricEvent({ kind, level, message })
  if (metricKey) {
    engine.metrics ??= emptyMetricsCounters()
    engine.metrics[metricKey] += 1
  }
}

// card 2 (docs/ENGINE_PERSISTENCE_PLAN.md §3) — write-through the engine's
// current intent (desiredRunning mirrors engine.running; selfSupply/overseer
// mirror their .enabled flags) so a restart's resumeEngines() can tell "was
// this project deliberately running" from "never started". Called at every
// site that changes one of those three: startOrchestrator, stopOrchestrator,
// setSelfSupply, setOverseer. FAIL-OPEN (writeEngineIntent never throws) — a
// disk fault only loses the NEXT boot's resume, never disturbs this process.
const persistEngineIntent = async (engine: ProjectEngine, projectPath: string): Promise<void> => {
  const ok = await writeEngineIntent(projectPath, {
    desiredRunning: engine.running,
    selfSupply: engine.selfSupply.enabled,
    overseer: engine.overseer.enabled,
    // The daily cap rides along (2026-07-29). `enabled` was already restored at
    // boot while the COUNTER lived only in memory, so every restart re-armed
    // self-supply with a fresh day's budget — and the engine restarts on every
    // self-update, i.e. exactly when it has been improving itself. The guard that
    // exists to stop a runaway was being reset by the loop it bounds.
    selfSupplyDayKey: engine.selfSupply.dayKey,
    selfSupplyDayCount: engine.selfSupply.dayCount,
  })
  if (!ok) logLine(engine, 'warn', 'engine intent persist failed (disk) — in-memory state unaffected')
}

// ── Stuck-move tracker (anti-zombie: bounded retry → escalate → surface) ──────

/** Record that a Board column move for `taskId` was KEPT (its write rejected /
 *  errored) this pass, returning the new consecutive-kept count. Resets to 1 when
 *  the INTENT changes (a different move now fails). Marks the task touched THIS
 *  pass so the prune keeps a still-failing move and drops a stale one the moment
 *  its move site stops firing. Pure state mutation — no IO, no clock. */
const recordKeptMove = (
  engine: ProjectEngine,
  taskId: string,
  intent: StuckMove['intent'],
  branch: string,
  taskTitle: string,
  /** For 'recover-review': the ceiling shape to restore on the retry (see
   *  StuckMove.shape). Omitted for every other intent. */
  shape?: StuckMove['shape'],
): number => {
  const prev = engine.stuckMoves.get(taskId)
  // The counter is PER INTENT: a different intent restarts it at 1, because the
  // retry budget it feeds (MOVE_STUCK_MAX_RETRIES → the 'move-stuck' anomaly)
  // asks "how many times has THIS move failed", and two intents are two moves.
  //
  // CAUTION (2026-07-19 review): that also means an ALTERNATING intent sequence
  // for one card would reset the count forever and the anomaly would never fire.
  // No reachable alternation is known — a card's intent is a function of the
  // worker's state, which does not oscillate within a stuck-move run — and for
  // 'recover-review' the anomaly is the ONLY escape hatch (it is deliberately
  // excluded from the blocked escalation), so it must not be starved. If a new
  // intent is ever added, check it cannot interleave with an existing one.
  const attempts = (prev && prev.intent === intent ? prev.attempts : 0) + 1
  // Keep a previously recorded shape when this call does not carry one, so a
  // re-record mid-retry cannot silently downgrade the verb back to the default.
  const keptShape = shape ?? (prev?.intent === intent ? prev.shape : undefined)
  engine.stuckMoves.set(taskId, {
    intent,
    attempts,
    branch,
    taskTitle,
    ...(keptShape ? { shape: keptShape } : {}),
  })
  return attempts
}

/** A move for `taskId` LANDED (or the card left the stuck situation) — forget any
 *  stuck-move tracking so it never surfaces a now-resolved zombie. Idempotent. */
const clearKeptMove = (engine: ProjectEngine, taskId: string): void => {
  engine.stuckMoves.delete(taskId)
}

// (The rate-limit HOLD ledger — endRateLimitHold / rateLimitHoldCredit /
// HOLD_CREDIT_CAP_MS, the execution clock's other credit side — was DELETED
// 2026-08-13 with the 20-minute in-place hold it measured: a quota-stopped
// worker is now requeued after QUOTA_STOP_DEBOUNCE_MS, so no hold span exists
// to credit back. The 2026-07-12 loss the ledger fixed cannot recur in this
// shape: a worker is torn down within ~1 minute of a quota stop, never held
// against its MAX_EXEC_MS budget.)

// ── Integration-wait ledger (the execution clock's credit side) ───────────────
// THE 2026-07-18 LOSS: a worker reached ready at 04:18, its card sat in 'review'
// waiting for the commander, and at 04:46 the commander 差し戻し'd it (review→
// doing). The very next pass judged it "runaway — worked 91m ≥ 90m execution
// limit" and tore its worktree down, parking the card in 'blocked' — because the
// clock still measured raw wall-clock since dispatch, so the 28 minutes it spent
// IDLE waiting for integration were charged to it as work. The commander then
// misread the block as a 差し戻し-limit park and burned time diagnosing it.
//
// 統合待ち is not the worker's doing, exactly like a rate-limit hold is not: the
// worker is FINISHED and blocked on the commander's queue. So the engine banks
// every wait and subtracts it, the same shape as the rate-limit ledger above.
//
// WHAT IS ACTUALLY MEASURED: the span between two COLUMN transitions the engine
// itself owns — the promote that moves the card doing→review, and the 差し戻し
// that moves it back. That is "time the card was not in 'doing'", which is the
// engine's own definition of not-being-worked-on; it is NOT a liveness probe. A
// PTY the owner keeps typing into while its card sits in review is credited too,
// and so is a card parked elsewhere before coming back. That is acceptable
// precisely because the engine does not monitor a card outside 'doing' at all —
// such time was never on the execution clock to begin with (a review card
// early-continues out of the monitor), so carrying it forward changes nothing.
//
// The credit is capped (2026-07-19 — see WAIT_CREDIT_CAP_MS): while a card
// sits in 'review' the monitor early-continues, so the worker is unwatched,
// and the engine cannot tell an idle waiter from a desk still burning tokens
// in an /order loop. Uncapped, the burning one bought unlimited runway.
//
// An earlier version of this comment argued the opposite — that capping would
// re-open the 2026-07-18 bug, because "a card left in review overnight and then
// reworked would come back already past the ceiling". That reasoning died with
// the reason split: the 暴走 label and the 'blocked' park are now decided by
// `readyAt`, not by the credit, so hitting the ceiling after a long review stops
// the worker as 'integration-wait' and sends its card to 'review' with its work
// intact. Bounded and honest, rather than unbounded.

/** BEGIN a worker's integration wait — called when its card is promoted to
 *  'review' and it goes idle pending the commander. Idempotent: a worker already
 *  waiting keeps its ORIGINAL stamp, so a repeated promote observation can't
 *  restart (and thereby shorten) the wait. */
const beginIntegrationWait = (engine: ProjectEngine, key: string, now: number): void => {
  engine.integrationWaitSince ??= new Map() // lazy backfill (older-build engine / test literal)
  if (!engine.integrationWaitSince.has(key)) engine.integrationWaitSince.set(key, now)
}

/** END a worker's integration wait, BANKING its span into the execution-time
 *  credit ledger. THE single seam that clears `engine.integrationWaitSince` —
 *  clearing the map directly would silently drop the credit and re-open the
 *  2026-07-18 hole, so route every release through here.
 *
 *  Called when a 差し戻し puts the worker back to work, and defensively before the
 *  execution-ceiling check (an unobserved transition must never leave a stale
 *  stamp growing). Idempotent: a worker not waiting banks nothing. A clock that
 *  runs backwards (a fixture, an NTP step) banks 0, never a negative credit. */
const endIntegrationWait = (engine: ProjectEngine, key: string, now: number): void => {
  const since = engine.integrationWaitSince?.get(key)
  engine.integrationWaitSince?.delete(key)
  if (since === undefined) return
  const waited = Number.isFinite(since) ? Math.max(0, now - since) : 0
  if (waited <= 0) return
  engine.integrationWaitMs ??= new Map() // lazy backfill (older-build engine / test literal)
  engine.integrationWaitMs.set(key, (engine.integrationWaitMs.get(key) ?? 0) + waited)
}

/** How much 統合待ち to CREDIT BACK to this worker's execution clock: everything
 *  banked by {@link endIntegrationWait}, capped at {@link WAIT_CREDIT_CAP_MS}. A
 *  corrupt ledger is floored to 0 — it can only ever make the check STRICTER,
 *  never grant infinite life — and the cap does the same at the top end, so a
 *  worker burning tokens under a review card cannot buy unlimited runway.
 *
 *  Reads the BANK ONLY, deliberately. An in-flight wait is not summed here because
 *  it cannot exist at the one place this is read: the ceiling check ends the wait
 *  (idempotently) on the line before, so any still-open stamp is already banked by
 *  the time we look. Summing it too would have been dead arithmetic implying a
 *  second, unexercised path. Callers must keep that order — end, then credit. */
const integrationWaitCredit = (engine: ProjectEngine, key: string): number => {
  const banked = engine.integrationWaitMs?.get(key) ?? 0
  if (!Number.isFinite(banked)) return 0
  return Math.min(Math.max(0, banked), WAIT_CREDIT_CAP_MS)
}

/** The non-working credit for one worker's execution clock: 統合待ち — time the
 *  worker was FINISHED and idle pending the commander, which the execution
 *  ceiling must not charge as work ({@link isRunaway}). (Until 2026-08-13 this
 *  also summed rate-limit holds; the hold died with the PTY sensor layer — a
 *  quota-stopped worker is requeued within ~a minute, so no hold span exists.)
 *
 *  ORDERING CONTRACT: call {@link endIntegrationWait} first (see the ceiling check
 *  in monitorWorkers). {@link integrationWaitCredit} reads the bank only, so an
 *  un-ended wait would be silently omitted rather than credited. */
const executionCredit = (
  engine: ProjectEngine,
  key: string,
): { waitedMs: number; creditMs: number } => {
  const waitedMs = integrationWaitCredit(engine, key)
  return { waitedMs, creditMs: waitedMs }
}

const emptyState = (): SwarmOrchestratorState => ({
  running: false,
  manualStop: false,
  manualStopPersisted: false,
  selfSupply: false,
  overseer: false,
  workers: [],
  reviews: [],
  log: [],
  anomalies: [],
  maxWorkers: ORCHESTRATOR_MAX_WORKERS,
  kpis: emptyKpis(),
  consumption: emptyConsumption(),
  autonomyRemembered: false,
  autonomyResumed: false,
  overseerRemembered: false,
})

/** Public state snapshot. Reports only *live* workers (a dead PTY is filtered
 *  out without mutating engine.workers — the pass with its slot-freed log is the
 *  authoritative pruner) so the count the UI shows matches the cap math.
 *  `tasks` (the Board cards) is the lead-time input — defaulted to [] for the
 *  action endpoints that only ack a toggle (their rates still come from the
 *  non-lossy counters; the 5s poll's getOrchestratorState supplies the cards for
 *  the full lead-time figure), so no caller is forced to fetch the board. */
const stateOf = (
  engine: ProjectEngine,
  isAlive: (w: WorkerHandle) => boolean,
  tasks: readonly ProjectTask[] = [],
  // The persisted "autonomy was on last session" reminder flag — resolved async by
  // the caller (getOrchestratorState reads Settings.swarmAutonomyOn). Defaulted false
  // for the toggle endpoints, whose responses the 5s poll immediately supersedes.
  autonomyRemembered = false,
  // The persisted "stopped by hand" record (Settings.swarmManualStop) — resolved async
  // by the poll callers (getOrchestratorState / drainTickOrchestrator) and passed as a
  // literal by start/stop (which just wrote it). Defaulted false for the remaining
  // toggle endpoints, exactly like autonomyRemembered above.
  manualStopPersisted = false,
  // card 2b — the RAW `overseer` value from this project's engine.json, resolved
  // async by the caller (getOrchestratorState reads it via readEngineIntent; the
  // sites that WRITE the field pass what they just wrote). Defaulted false for the
  // remaining toggle endpoints, exactly like autonomyRemembered above — their ack
  // is superseded by the next 5s poll. NEVER an auto-arm input: the only consumer
  // is the UI's one-click restore banner (resumeEngines still ignores the field —
  // OVERSEER_DESIGN.md K2 / L9-③).
  overseerRemembered = false,
): SwarmOrchestratorState => {
  // Resolve the live worker set ONCE — both the reported `workers` array and the
  // consumption snapshot (activeWorkers / activeRunMs) read from it.
  const live = engine.workers.filter((w) => isAlive(w))
  const counters = engine.metrics ?? emptyMetricsCounters()
  return {
    running: engine.running,
    // The OR of the in-memory flag and the persisted record, so "stopped by hand"
    // reads true across a restart (fresh engine ⇒ flag false, record still true).
    manualStop: engine.manualStop === true || manualStopPersisted,
    manualStopPersisted,
    selfSupply: engine.selfSupply.enabled,
    overseer: engine.overseer.enabled,
    workers: live,
    // ⚠ FROZEN WHILE STOPPED IS A LIE (overnight review 2026-08-04). Both lists
    // are computed ONLY inside a running pass (runIntegratePass sets `reviews`,
    // runEnginePass sets `anomalies`), and both start with `if (!engine.running)
    // return` — while the engine is off, nothing recomputes them and nothing
    // clears them. `workers` right above already filters to what is genuinely
    // alive; these two kept publishing the last snapshot forever, so the panel
    // showed 「検品待ち: 3件」 for cards the commander had since integrated and a
    // worker-stale warning for a worker that no longer existed — beside a
    // correctly-empty worker list, on the same screen. A stopped engine has no
    // live observation to report: say nothing rather than something stale.
    // (The lists themselves are KEPT in memory — a restart re-populates them on
    // the first pass, and stopOrchestrator deliberately preserves the journal.)
    reviews: engine.running ? [...engine.reviews] : [],
    log: [...engine.log],
    anomalies: engine.running ? [...engine.anomalies] : [],
    maxWorkers: ORCHESTRATOR_MAX_WORKERS,
    kpis: computeSwarmKpis({ counters, tasks, log: engine.log }),
    consumption: computeSwarmConsumption({ liveWorkers: live, counters, limit: DISPATCH_BUDGET }),
    autonomyRemembered,
    autonomyResumed: engine.autonomyResumed === true,
    overseerRemembered,
    ...(engine.parkUntil != null ? { parkUntil: engine.parkUntil } : {}),
  }
}

// ── Injectable dependencies ──────────────────────────────────────────────────

export interface OrchestratorDeps {
  /** Read this project's full Board card list (any order — the pass derives the
   *  todo queue, and looks up each worker's card by id to monitor its column). */
  fetchTasks: (projectPath: string) => Promise<ProjectTask[]>
  /** Move a card todo→doing and record its branch. Resolves false on a kept
   *  (CAS-rejected / failed) write so the pass can retry next time. */
  moveToDoing: (projectPath: string, taskId: string, branch: string) => Promise<boolean>
  /** Move a card doing→review and (re-)record its branch — the integration
   *  handle the review stage reads. Resolves false on a kept write so the
   *  monitor pass can retry next time. (Card②) */
  moveToReview: (projectPath: string, taskId: string, branch: string) => Promise<boolean>
  /** Spawn one isolated worker for a goal (worktree + claude PTY + /order).
   *  `priorFailure` (LEARNING LOOP, card fdf714ef) is the reason this SAME card was
   *  last 差し戻し / rolled back — threaded into the worker's /order so a re-dispatch
   *  doesn't repeat the failure. Omitted on a first dispatch. */
  spawnWorker: (opts: {
    projectPath: string
    title: string
    notes?: string
    hint?: string
    priorFailure?: string
    // card 4 (ENGINE_PERSISTENCE_PLAN §5) — the boot RESUME path: re-enter this
    // EXISTING worktree and `--resume` the persisted conversation instead of
    // creating a fresh one. Both omitted on a normal dispatch (unchanged).
    worktree?: string
    resumeSessionId?: string
  }) => Promise<SpawnSwarmWorkerResponse>
  /** Is this worker's PTY still alive? (A freed slot ⇒ refill.) */
  isAlive: (w: WorkerHandle) => boolean
  /** Where this card's work already lives, if anywhere — see
   *  {@link ensureSwarmWorktreeForBranch}. `null` ⇒ dispatch fresh. Optional so
   *  existing dep literals keep compiling; the default resolver is used when
   *  absent. */
  resolveReusableWork?: (projectPath: string, card: ProjectTask) => Promise<ReusableWork | null>
  /** Commits the worker's `swarm/*` branch carries ahead of trunk — the
   *  "branch is ready" signal. 0 on any failure (conservative: no proof of
   *  work ⇒ no promotion). Probed from the shared repo by branch ref, so it
   *  works whether or not the worktree still exists. (Card②) */
  /** `null` ⇒ git could not answer. NEVER read that as 0 — see
   *  {@link defaultCountCommitsAhead}. */
  countCommitsAhead: (projectPath: string, branch: string) => Promise<number | null>
  /** The worker's heartbeat sign for its branch, or null when it never wrote
   *  one / it's unreadable. Carries the display-only phase/note/at too. (Card②) */
  readHeartbeat: (
    projectPath: string,
    branch: string,
  ) => Promise<HeartbeatSign | null>
  /** Move a LOST/STOPPED worker's card to a recovery column — 'todo' to requeue
   *  a crashed worker for one more attempt, 'blocked' to park one needing a human
   *  (a reported blocker, an exhausted retry budget, or an owner stop). False on a
   *  kept write so the caller can retry. (Card① crash recovery / owner stop) */
  recoverCard: (projectPath: string, taskId: string, column: 'todo' | 'blocked') => Promise<boolean>
  /** Park a card AND stamp the owner's 「見送る」 in one board write (see
   *  {@link abandonCardIntegration}). Optional so existing dep literals keep
   *  compiling; the default writer is used when absent. */
  markAbandoned?: (projectPath: string, taskId: string) => Promise<boolean>
  /** Tear down a LOST/STOPPED worker: remove its isolated worktree and kill its
   *  `claude` PTY (the zombie-eradication that the old monitor skipped — a
   *  crashed worker left its worktree on disk forever). Force-removes (a crashed
   *  session leaves a dirty/locked tree). Does NOT delete the branch — a blocked /
   *  owner-stopped worker's branch may carry commits a human picks up, and branch
   *  names are unique per spawn so a leftover never blocks re-dispatch. Resolves
   *  {removed:false, reason} on failure (logged; never throws into the loop).
   *
   *  SALVAGE FIRST: any uncommitted work in the worktree is committed to the
   *  worker's branch before the (forced) removal — `reason` names WHY the worker
   *  is being reclaimed and rides into that commit message. If the salvage commit
   *  fails, the implementation KEEPS the worktree ({removed:false}) rather than
   *  destroy the only copy of the work. (2026-07-12 全損 — see
   *  {@link commitWipBeforeTeardown}.) */
  recoverWorker: (opts: {
    projectPath: string
    worktree: string
    terminalId: string
    reason?: TeardownReason
    /** An EARLIER pass already tore this worker down (its Board write was kept and
     *  the recovery is being retried). The PTY's exit is then OUR kill, not the
     *  worker's death — implementations must not report it as exitInfo. */
    alreadyTornDown?: boolean
    /** The SDK session id when this worker runs on the Agent SDK. REQUIRED for
     *  such a worker: its `terminalId` is empty, so an implementation given only
     *  that stops NOTHING and still tears the worktree down under a live claude
     *  (see defaultRecoverWorker). Pass `w.sdkSessionId` at every call site. */
    sdkSessionId?: string
  }) => Promise<{
    removed: boolean
    reason?: string
    /** The removal was refused because a desk is still live in that worktree —
     *  "ask again", not "it failed". recoverLost retries a bounded number of
     *  passes instead of dropping the worker (which would orphan a live claude
     *  and, on the SDK pool, pin its slot for the life of the process). */
    stillOccupied?: boolean
    wip?: WipCommitResult
    /** The dead PTY's own exit code/signal, captured BEFORE this call's kill —
     *  i.e. only populated when the process had ALREADY died on its own (a real
     *  crash), never for a worker we are killing ourselves (stall reclaim /
     *  owner stop), so it can't be misread as "why we killed it". */
    exitInfo?: { code: number | null; signal?: number }
  }>
  /** Epoch ms of the worker PTY's last output chunk (terminal.ts stamps it on
   *  every onData), or null when unknown / it has produced none yet. The SECOND
   *  liveness channel beside the heartbeat: a worker streaming tokens is alive even
   *  between heartbeats, so a stall requires BOTH to fall silent. (Stall detection.) */
  lastOutputAt: (w: WorkerHandle) => number | null
  /** NUDGE a silent worker: send a bare Enter (CR) to its PTY to submit a prompt
   *  left unsent / un-stick a waiting TUI — the cheap first recovery before a
   *  reclaim. Returns false when the PTY is gone. Workers run permissionMode:
   *  'bypass' (no permission menus), so a stray Enter cannot approve anything.
   *  (Stall recovery.) */
  nudge: (w: WorkerHandle) => boolean
  /** ESCALATE a worker that stayed silent past the whole nudge budget: ESC
   *  (interrupt) then, after a short settle, a one-line continue instruction
   *  naming `taskTitle` — tried exactly ONCE (see {@link classifyStall}) before a
   *  still-silent worker is reclaimed. Returns false when the PTY is gone or
   *  either write failed. (Stall recovery escalation, 2026-07.) */
  escalate: (w: WorkerHandle, taskTitle: string) => Promise<boolean>
  /** Tell a LIVE worker its card was sent back review→doing from OUTSIDE the
   *  engine (Board API / UI drag). Optional: absent ⇒ swarmEscalations'
   *  deliverAnswerToWorker, the one conduit that speaks BOTH runtimes.
   *
   *  WHY THIS EXISTS (2026-08-03, measured on the owner's machine). The
   *  observation below re-arms MONITORING (stage/reworkAt) but told the worker
   *  nothing — for a commander-initiated rework that is fine (the commander
   *  speaks to the worker itself), but an OWNER-dragged card left the worker
   *  working obliviously toward its already-invalidated ready. The owner then
   *  reached for the tools that LOOK right and neither works: paste-task
   *  targets a terminalId (an SDK worker has none), and a worktree restart is
   *  refused by the occupancy guard precisely because the worker is still
   *  alive. The one seam that reaches both runtimes must therefore be wired
   *  HERE, where the rework is observed. */
  deliverReworkNotice?: (target: WorkerHandle, projectPath: string, text: string) => Promise<boolean>
  /** The worker's CURRENT recent output as plain text, or null when unknown.
   *  Read-only. The orchestrator classifies it (classifyOutput) to tell WHY a
   *  non-promoting worker isn't progressing — a usage/rate-limit WAIT or a
   *  startup permission prompt — rather than treating every quiet worker as a
   *  stall. (Card 4880e9c6 — 進まない分類.)
   *
   *  Takes the WORKER, not a terminal id: what "recent output" means depends on
   *  how the worker is running (a rendered TUI frame for a PTY worker; distilled
   *  events for an SDK one), and that choice belongs to workerRuntime, not here.
   *  Default: `runtimeOf(w).recentOutput(w)`, which for a PTY worker is the same
   *  `getTerminalScreen(w.terminalId)` call it always was. */
  recentOutput: (w: WorkerHandle) => string | null
  /** The runtime's own "parked on a usage limit" verdict — see
   *  WorkerRuntime.quotaBlocked. Injected in tests; production resolves it per
   *  worker through runtimeOf(w). */
  quotaBlocked?: (w: WorkerHandle) => boolean
  /** Newest mtime across a worker's OWN transcript + its sub-agent transcripts
   *  (its worktree cwd + agentSessionId), or null. The stall path's THIRD liveness
   *  channel, resolved ONLY for a worker the cheap channels (heartbeat + PTY output)
   *  already call silent — so a worker frozen inside a Task() sub-agent (its own
   *  adversarial review) is not false-reclaimed while that file grows in real time.
   *  Injected for the unit test; default reads the real ~/.claude tree. OPTIONAL:
   *  absent ⇒ the stall path uses only the cheap channels (existing fake-deps tests
   *  keep compiling/behaving). Default (defaultDeps): sessionAgentActivityAt. The
   *  worker analog of {@link defaultManagerDeliveryAt}'s fix — 2026-07-23. */
  sessionAgentActivityAt?: (cwd: string, sessionId: string) => Promise<number | null>
  /** Start time of the worker's NEWEST still-unresolved BACKGROUND TASK (its worktree
   *  cwd + agentSessionId), or null when none is in flight. The stall path's FOURTH
   *  liveness channel, resolved ONLY for a worker the first three already call silent
   *  — so a worker that launched its completion gate in the background, ended its turn
   *  (correctly) and is waiting for the notification is not false-reclaimed while the
   *  suite runs. Injected for the unit test; default reads the real ~/.claude
   *  transcript. OPTIONAL: absent ⇒ the stall path behaves exactly as before (existing
   *  fake-deps tests keep compiling/behaving). Default (defaultDeps):
   *  sessionBackgroundTaskAt. Closes the 2026-07-27 false-kill — see
   *  {@link BG_TASK_GRACE_MS}. */
  sessionBackgroundTaskAt?: (cwd: string, sessionId: string) => Promise<number | null>
  /** Raise a worker's FREE-TEXT question to the escalations inbox (C3). Until
   *  C-core lands its budgeted brain pass, this is the §6 S4 THROTTLED
   *  degradation: the bare question goes straight to T3 — openEscalation is
   *  LLM-free and receiptKey-idempotent, and the owner's answer re-enters the
   *  worker through answerEscalation → injectAnswerIntoWorker (W16). OPTIONAL:
   *  absent ⇒ the question arm only HOLDS the worker (no raise) — existing
   *  fake-deps tests keep compiling/behaving. Default (defaultDeps):
   *  openEscalation. */
  raiseQuestion?: (input: OpenEscalationInput) => Promise<unknown>
  /** Meter a just-promoted (done-judged) worker's claude session and render the
   *  one-line consumption summary for the journal (手数/束ね率/文脈max/出力 —
   *  swarmTokenAudit.formatConsumptionLine), or null when the session JSONL
   *  can't be located/read. FAIL-SAFE by contract: implementations never throw
   *  and the promote site swallows anyway, so a missing/corrupt JSONL (or an
   *  environment that doesn't write one) silently skips the line — it must
   *  never disturb the promote, spawn, or monitoring. OPTIONAL: absent ⇒ no
   *  consumption line (existing fake-deps tests unchanged). Default
   *  (defaultDeps): the real JSONL reader via the PTY's agentSessionId. */
  readConsumption?: (opts: {
    worktree: string
    terminalId: string
    /** The SDK session id when this worker runs on the Agent SDK. REQUIRED for
     *  one: the default implementation finds the claude session id by looking
     *  the PTY up in the terminal pool, and an SDK worker is not in it — so
     *  without this, every SDK worker silently reported NO consumption and
     *  vanished from the fuel accounting. */
    sdkSessionId?: string
  }) => Promise<string | null>
  /** Preflight `claude` before an AUTO-START engages the engine — `{ok:false}` when the
   *  CLI is missing / logged out. {@link maybeAutoStartDrain} consults it so it never flips
   *  `running` true into a spawn it knows will fail (which would make the chain — and the
   *  unattended background sweep — retry forever). OPTIONAL: absent ⇒ no preflight (the
   *  dispatch unit tests omit it; the manual ON path has its OWN claudeRunPreflight that
   *  throws a 503). Default (defaultDeps): claudeRunPreflight. */
  preflight?: () => Promise<{ ok: boolean }>
}

/** The self-supply stage's injectable surface. One OPTIONAL member: omitted in
 *  production (the stage builds its REAL tsc/lint/vitest scanners itself), supplied
 *  by tests — which must never spawn those tools, and which need a scanner they can
 *  hold open to prove the tick does not wait for one. */
export interface SelfSupplyPassDeps {
  selfSupplyDeps?: SelfSupplyDeps
}

/** The anomaly-detection stage's injectable surface — split from the others so
 *  the existing dispatch/integration tests/contracts stay untouched, and the
 *  worktree-existence probe is faked in unit tests (no real worktrees on disk). */
export interface AnomalyDeps {
  /** Does this worker's isolated `swarm/*` worktree dir still exist on disk?
   *  Used to spot a worker whose tree was deleted out from under it, and a
   *  'doing' card whose owning worktree is gone. Resolves false on any error
   *  (treated as missing — conservative: the anomaly check only WARNS, never
   *  mutates, so a transient stat error at worst shows one extra warning). */
  worktreeExists: (projectPath: string, branch: string) => Promise<boolean>
  /** Is a LIVE desk (either pool) sitting in this branch's worktree right now?
   *
   *  ⚠ THE MANUAL WORKER IS THE REASON. A worker spawned from the Board's 実行
   *  button (POST /api/swarm/worker) is never pushed to `engine.workers` — only
   *  the engine's own dispatch counts one — so "a doing card with no counted
   *  worker" describes a perfectly healthy manual worker just as well as an
   *  abandoned one. Without this probe the 'unowned-doing' row would fire on
   *  every manual worker in flight, which is worse than not reporting at all: a
   *  feed that cries on healthy state is a feed the owner learns to skip.
   *
   *  OPTIONAL + fail-quiet-to-OCCUPIED: absent, or a probe that throws, means
   *  "cannot prove nobody is there" and the row is withheld. Under-reporting a
   *  stall is recoverable (the delivered ones are collected automatically, and a
   *  human still sees the card in `doing`); crying wolf on a live worker is not.
   *  Default (defaultDeps): liveDeskOccupies over the branch's worktree. */
  deskOccupies?: (projectPath: string, branch: string) => Promise<boolean>
  /** Push a FATAL event to the human (the escalation safety valve): persist an
   *  in-app notification (the Ground bell) AND raise an OS toast. Called by
   *  fireFatalNotifications for the cases the unmanned loop can't self-heal
   *  (rework-exhausted / all-workers-down / exec-timeout). OPTIONAL + best-effort
   *  (never awaited into the pass, internal-catch) so a notification fault can
   *  never disturb a pass — and so existing tests/callers that don't set it keep
   *  working unchanged. Default (defaultDeps): createSwarmFatalNotification. */
  notify?: (n: SwarmFatalNotification) => void
}

/** The integration stage's (Card③) injectable surface — split from
 *  OrchestratorDeps so the dispatch tests/contract stay untouched, and so the
 *  whole risky git path is unit-tested with fakes (no real repo, no push). */
export interface IntegrationDeps {
  /** Read this project's REVIEW-column cards. */
  fetchReview: (projectPath: string) => Promise<ProjectTask[]>
  /** Resolve + freshen the trunk branch; null when there is no usable trunk
   *  (unresolvable name) — the caller then skips integration this pass. */
  prepareTarget: (projectPath: string) => Promise<string | null>
  /** Read-only readiness of one branch against the (already-prepared) trunk. */
  classify: (projectPath: string, branch: string, target: string) => Promise<ReviewReadiness>
  /** VERIFY the to-be-landed tree BEFORE it can touch the trunk — the gate that
   *  stops the engine from auto-merging code that doesn't even type-check. It
   *  checks the branch REBASED ONTO THE TRUNK (exactly what `integrate` will push),
   *  not the raw branch tip, so a worker that compiled against an older trunk but
   *  breaks against the current one (another worker changed a cross-file contract)
   *  is caught — that is the whole point. Returns `ok:false` ⇒ the caller MUST NOT
   *  integrate (card stays in review, reason logged). `tip` is the verified sha
   *  (the merge gate's memo key); `skipped` means it short-circuited on an
   *  unchanged-already-red tip (no tsc was run). A repo with no typecheck / no
   *  remote trunk / an already-merged or conflicting branch returns `ok:true` with
   *  a reason — the gate never FALSE-blocks work it cannot meaningfully verify, and
   *  defers a real conflict to `integrate` (which stamps it). `opts.skipIfTip`:
   *  when the branch's tip equals it, return `skipped` without running the check.
   *  `docsWarning`: a READ-ONLY soft-warn (TARGET-STATE §6) — set when the branch's
   *  diff touches swarm code ({@link touchesSwarmPaths}) but leaves docs/commander/
   *  untouched. It NEVER affects `ok` (never blocks the merge) — the caller only
   *  journals it. */
  verify: (
    projectPath: string,
    branch: string,
    target: string,
    opts?: { skipIfTip?: string },
  ) => Promise<{ ok: boolean; tip: string | null; reason?: string; skipped?: boolean; docsWarning?: string }>
  /** Independent ADVERSARIAL REVIEW of the to-be-landed tree, run AFTER `verify`
   *  is green and BEFORE `integrate` — the COMPLEMENT to the (mechanical) verify
   *  gate (card a14329dc). N fresh `claude` reviewers — NONE of them the worker —
   *  each fact-check the diff and a STRICT majority decides ({@link tallyReview}):
   *  'rework' (majority must-fix ⇒ 差し戻し review→doing, never merged), 'integrate'
   *  (majority clean ⇒ proceed to land), or 'defer' (no majority — a tie / reviewers
   *  that failed to vote ⇒ leave in review, retry next pass; never merge on thin
   *  signal). OPTIONAL: when absent the review stage is SKIPPED (pre-a14329dc
   *  behavior — integrate runs straight after verify); {@link defaultDeps} wires the
   *  real claude panel ({@link makeAdversarialReview}). `opts.tip` is the verified
   *  tip (the panel reviews exactly that). `opts.skipIfTip`: when it equals `tip`
   *  (an unchanged branch already reviewed must-fix) return {decision:'rework',
   *  skipped:true} WITHOUT re-spawning the panel — mirrors verify's memo. */
  review?: (
    projectPath: string,
    branch: string,
    target: string,
    opts: { tip: string; skipIfTip?: string },
  ) => Promise<ReviewResult>
  /** Repo-relative paths the branch changed vs the trunk (merge-base(target,tip)…tip
   *  — the branch's OWN diff), plus the tip sha — the HIGH-RISK FORCE-HOLD gate's
   *  read (run BEFORE verify so a held branch never burns tsc/tests/panels).
   *  MUST THROW on a git failure (unresolvable tip, diff error) — fail-closed: the
   *  caller then DEFERS integration (retries next pass) instead of reading an
   *  uncomputable diff as "no risky paths". (Deliberately NOT the fail-open
   *  changedFilesVsTrunk used by the docs soft-warn — that one may return [] on
   *  error because it only gates a warning.) Default: {@link defaultChangedPaths}. */
  changedPaths: (
    projectPath: string,
    branch: string,
    target: string,
  ) => Promise<{ tip: string; files: string[] }>
  /** Land one branch on the trunk (FF / rebase / conflict). Never forces. */
  integrate: (projectPath: string, branch: string, target: string) => Promise<IntegrateOutcome>
  /** Acquire the CROSS-PROCESS integration lock for this repo (0706 二重司令塔
   *  事故フォロー) — guards against a separate `claude` process (a tmux 司令塔
   *  driving the same repo by hand, via scripts/swarm-lock.js) rebasing/pushing
   *  the same branch onto the same trunk at the same moment this engine is
   *  mid-integrate. Called PER CARD, immediately before `integrate()` — NOT
   *  once for the whole pass — because a pass also runs verify/tsc and a
   *  multi-minute adversarial-review panel per card, which can hold a
   *  whole-pass lock past its staleness window and let a second process steal
   *  it (the exact race this lock exists to prevent). On failure, only THIS
   *  card's integration is skipped this pass (never the whole pass). Default:
   *  {@link acquireIntegrationLock}. Injectable so tests exercise the skip path
   *  without a real git repo at `engine.path`. */
  acquireLock: (projectPath: string) => Promise<AcquireIntegrationLockResult>
  /** Move a card review→done. False on a kept write (retry next pass). */
  moveToDone: (projectPath: string, taskId: string) => Promise<boolean>
  /** Stamp / clear a card's "needs manual integration" flag. */
  markConflict: (projectPath: string, taskId: string, value: boolean) => Promise<boolean>
  /** Tear down a landed branch's worktree + delete the branch (best-effort). */
  cleanup: (projectPath: string, branch: string) => Promise<{ removed: boolean; reason?: string }>
  /** Stop a just-landed worker's `claude` (post-integration teardown).
   *  cleanup() already kills any PTY by cwd; this is the by-handle
   *  belt-and-suspenders for the symlinked-home edge case a cwd match can miss,
   *  and it lets the engine free the slot IMMEDIATELY (no waiting for the next
   *  monitor pass to notice the process died).
   *  Default: `runtimeOf(w).kill(w)` — killTerminal for a PTY worker.
   *  ⚠ Currently DECLARED AND DEFAULTED BUT NEVER CALLED (verified 2026-07-30):
   *  the cwd-based cleanup() covers the live paths. Kept because the contract is
   *  the right one and the by-handle form is what an SDK worker will need. */
  killPty: (w: WorkerHandle) => void
  // ── 差し戻し(rework)用 — レビューで must-fix が出たカードを review→doing に戻して
  //    worker を再作業させるため runIntegratePass が使う seam。moveToDoing /
  //    recoverCard / isAlive / recoverWorker は OrchestratorDeps と同型・同実体
  //    (defaultDeps が両 interface に1つの実装を供給する)だが、runIntegratePass は
  //    IntegrationDeps しか受け取らないので、その差し戻し経路が使うぶんをここにも宣言する。
  /** Move a card review→doing (差し戻し) and re-record its branch — the same Board
   *  write seam as the dispatch/promotion moves. False on a kept write (retry next
   *  pass). (Same dep as OrchestratorDeps.moveToDoing.) */
  moveToDoing: (projectPath: string, taskId: string, branch: string) => Promise<boolean>
  /** Move a card to a recovery column — 'blocked' to PARK one whose rework budget is
   *  spent, 'todo' to RE-QUEUE (re-dispatch) one whose worker is already gone. False
   *  on a kept write. (Same dep as OrchestratorDeps.recoverCard.) */
  recoverCard: (projectPath: string, taskId: string, column: 'todo' | 'blocked') => Promise<boolean>
  /** Is this worker's PTY still alive? — picks the 差し戻し strategy: a LIVE worker is
   *  continued in place (review→doing + 修正指示); a DEAD one is re-dispatched
   *  (review→todo). (Same dep as OrchestratorDeps.isAlive.) */
  isAlive: (w: WorkerHandle) => boolean
  /** Tear down a worker's worktree + PTY (KEEPS its branch) — used to clean up a
   *  parked / re-dispatched worker on 差し戻し. Uncommitted work is salvaged onto the
   *  branch first (see OrchestratorDeps.recoverWorker — same dep, same contract). */
  recoverWorker: (opts: {
    projectPath: string
    worktree: string
    terminalId: string
    reason?: TeardownReason
    /** An EARLIER pass already tore this worker down (its Board write was kept and
     *  the recovery is being retried). The PTY's exit is then OUR kill, not the
     *  worker's death — implementations must not report it as exitInfo. */
    alreadyTornDown?: boolean
    /** The SDK session id when this worker runs on the Agent SDK. REQUIRED for
     *  such a worker: its `terminalId` is empty, so an implementation given only
     *  that stops NOTHING and still tears the worktree down under a live claude
     *  (see defaultRecoverWorker). Pass `w.sdkSessionId` at every call site. */
    sdkSessionId?: string
  }) => Promise<{
    removed: boolean
    reason?: string
    /** Refused because a desk is still live in that worktree — "ask again", not
     *  "it failed" (recoverLost retries a bounded number of passes). */
    stillOccupied?: boolean
    wip?: WipCommitResult
    /** The dead PTY's own exit code/signal, captured BEFORE this call's kill —
     *  i.e. only populated when the process had ALREADY died on its own (a real
     *  crash), never for a worker we are killing ourselves (stall reclaim /
     *  owner stop), so it can't be misread as "why we killed it". */
    exitInfo?: { code: number | null; signal?: number }
  }>
  /** @deprecated DEAD SEAM — nothing calls it, and nothing should call THIS shape.
   *
   *  WHAT IT WAS. "Tell a LIVE worker over its PTY why its card was sent back and
   *  to fix it in place" — one line written to its terminal, so a review→doing
   *  差し戻し restarted work instead of leaving an idle (post-done) worker sitting
   *  there. Its one caller was `reworkOrPark`, inside the engine's own
   *  verify→lens→差し戻し machinery.
   *
   *  WHY IT IS DEAD, traced (2026-08-01) rather than assumed. `reworkOrPark` was
   *  DELETED with the whole engine-side integration path in 675968e5
   *  (manager-only rework, 2026-07-15): the engine no longer verifies, reviews,
   *  merges or 差し戻す anything — it WAKES the commander. 差し戻し today is the
   *  commander's `POST /api/project { rework: [...] }` (server/routes/project.ts),
   *  which bumps reworkCount and moves the card review→doing; the REASON still
   *  reaches the worker, through {@link ProjectEngine.reworkReasons} injected into
   *  the next dispatch's /order context (see the priorFailure read in the dispatch
   *  pass). So this is dead plumbing left behind by that removal — NOT a 差し戻し
   *  instruction that silently goes nowhere.
   *
   *  WHY IT IS NOT MERELY DELETED. The field stays declared (optional) because
   *  existing `const deps: OrchestratorDeps & … = { instructRework: … }` literals
   *  in the test suite would fail the excess-property check without it. The
   *  IMPLEMENTATION and the {@link defaultDeps} wiring ARE gone, which is the part
   *  that mattered: its body was `writeInput(terminalId, …)`, keyed on a PTY
   *  terminalId. An SDK worker's terminalId is the EMPTY STRING, so re-wiring that
   *  body would have written a 差し戻し instruction into nothing for every SDK
   *  worker — silently, with no error anywhere (docs/MAP.md §5). Any future
   *  in-place 差し戻し conduit must take the WorkerHandle and go through
   *  `runtimeOf(w).say(w, line)` like {@link defaultEscalate} does, never a
   *  terminalId. Pinned by swarmEngineSdkBlindspots.test.ts. */
  instructRework?: (terminalId: string, message: string) => void
  // ── MANAGER-ONLY INTEGRATION + RESURRECTION (2026-07-15) — the engine WAKES the
  //    commander when a worker is ready instead of merging itself, and RE-wakes it if
  //    it dies/hangs (card B). These seams replace the verify→lens→FF-push→land
  //    machinery on the armed path (完了条件1+2+3) and add the resuscitation reflex. ──
  /** What is the state of the project's commander (manager) desk — `'absent'` (no live
   *  PTY: spawn one), `'idle'` (a desk is up but quiet: nudge it, NEVER spawn a second)
   *  or `'active'` (up and demonstrably working: leave it alone)? This is the guard that
   *  stops the engine spawning a SECOND commander PTY (二重起動防止, 完了条件2), the
   *  trigger that resuscitates a stopped one, and — since 2026-07-18 — the seam that keeps
   *  a LIVE-but-quiet desk out of the resurrection path entirely (完了条件1).
   *  `now` is the pass clock (injected for deterministic staleness). `echoUntil` is the
   *  instant up to which PTY paint must be treated as the ECHO of our own nudge rather
   *  than life (0 = nothing to discount); see {@link defaultManagerPresence}.
   *  MUST NOT throw — an unreadable session store ⇒ 'absent', so the safe default is to
   *  raise a desk rather than stall integration. Default: {@link defaultManagerPresence}. */
  managerPresence: (projectPath: string, now: number, echoUntil?: number) => Promise<ManagerPresence>
  /** Poke the LIVE commander desk about waiting work — the `'idle'` response, and the
   *  reason that state never spawns anything (完了条件2+5). Best-effort: false when the
   *  PTY is gone. MUST NOT throw. Default: {@link defaultNudgeManager}. */
  nudgeManager: (projectPath: string) => Promise<boolean>
  /** TELL the live commander a worker just finished — the NOTICE channel (2026-07-27),
   *  the thing this product did not have and whose absence cost 38 minutes.
   *
   *  Separate seam from {@link nudgeManager} on purpose: that one REVIVES a desk that
   *  looks hung and sends ESC to get through, so it must stay behind the four slow
   *  gates; this one merely SPEAKS to a healthy desk and is therefore allowed to be
   *  immediate — it writes only when the screen shows a desk that is neither generating
   *  nor holding half-typed input. Returns true iff the line actually landed; false is
   *  always "not now, still queued" (the caller re-offers it next pass), never "give
   *  up". MUST NOT throw. Default: {@link defaultNotifyManagerReady}. */
  notifyManagerReady?: (
    projectPath: string,
    notice: { branches: readonly string[]; total: number },
  ) => Promise<boolean>
  /** When the commander last demonstrably PRODUCED work — epoch ms, null when no channel
   *  says anything. The evidence {@link managerIntegrationStalled} judges a paint-only
   *  `'active'` desk against (2026-07-22). Read ONLY once the queue has already waited
   *  past {@link MANAGER_INTEGRATION_STALL_MS}, so the ordinary tick costs nothing extra.
   *  MUST NOT throw. Default: {@link defaultManagerDeliveryAt}. */
  managerDeliveryAt?: (projectPath: string) => Promise<number | null>
  /** WAKE / RESUSCITATE the commander so it can decide the integration: spawn/resume the
   *  manager PTY (spawnSwarmManager — resumes the days-long integration conversation, or
   *  opens fresh; on a quota wall it DROPS the model one tier via resolveSwarmModelEffort
   *  Probed inside — 完了条件4) AND raise ONE info notification naming the review branches
   *  now waiting on a merge decision (完了条件2 — BATCH: one wake for the whole set, token-
   *  thrifty). The spawned `/og-manage` reads the Board on startup and finds the review
   *  cards itself; the notification is the durable, human-facing record. Returns true iff
   *  the desk was actually woken; false ⇒ no usable model tier (every tier OFF/cooling) or
   *  the spawn failed — the caller counts it as a failed attempt and retries next pass.
   *  MUST NOT throw. Default: {@link defaultWakeManager}. */
  wakeManager: (
    projectPath: string,
    cards: readonly { branch: string; title: string }[],
  ) => Promise<boolean>
  /** WHICH RUNTIME carries the commander desk right now — `'sdk'`, `'pty'`, or null when
   *  there is no desk (or it cannot be identified). Read ONLY by the unresponsive-desk
   *  escalation, and the reason the recycle below is not simply "tear it down": a PTY
   *  commander is a terminal in the OWNER'S OWN cwd — the desk they may have started by
   *  hand and may be reading right now — so killing it is not recovery, it is taking the
   *  keyboard away. An SDK desk has no screen and no owner sitting at it; recycling one
   *  costs a conversation resume and nothing else. Optional + MUST NOT throw: absent or
   *  null ⇒ no recycle at all (fail-safe — a desk we cannot identify is never torn down;
   *  the bell still rings). Default: {@link defaultManagerDeskRuntime}. */
  managerDeskRuntime?: (projectPath: string) => Promise<ManagerRuntimeKind | null>
  /** TEAR DOWN the SDK commander desk so the absent-arm above can seat a fresh one —
   *  the recovery half of the unresponsive-desk escalation (2026-08-14). Returns true iff
   *  a desk was actually terminated. Called at most ONCE per waiting episode
   *  (`managerResume.deskRecycled`) and ONLY when {@link managerDeskRuntime} said `'sdk'`.
   *  A throw is swallowed by the caller — the owner's bell must never depend on the
   *  recycle succeeding. Optional. Default: {@link defaultRecycleManagerDesk}. */
  recycleManagerDesk?: (projectPath: string) => Promise<boolean>
  /** Push a FATAL event to the human (bell + OS toast) — the SAME seam as
   *  {@link OrchestratorDeps.notify}, surfaced here so the integrate pass can escalate a
   *  commander that keeps dying ('manager-unrevivable', 完了条件5). OPTIONAL + best-effort
   *  (never awaited, internal-catch) so a notification fault can never disturb a pass, and
   *  so tests/callers that don't set it keep working. Default (defaultDeps): the same
   *  createSwarmFatalNotification wiring. */
  notify?: (n: SwarmFatalNotification) => void
}

// --- Default (real) deps ------------------------------------------------------

/** Loopback origin of THIS server — the engine talks to its own Board HTTP API
 *  (127.0.0.1) rather than reaching into projectData, mirroring swarm-board.sh.
 *  The port follows server/index.ts's fixed-port contract (PORT override, else
 *  47776). The engine only ever runs inside a listening server (start is an HTTP
 *  call), so the listener is always up by the time a pass fires. */
const loopbackOrigin = (): string => `http://127.0.0.1:${Number(process.env.PORT) || 47776}`

const defaultFetchTasks = async (projectPath: string): Promise<ProjectTask[]> => {
  const res = await fetch(
    `${loopbackOrigin()}/api/project?path=${encodeURIComponent(projectPath)}`,
    { signal: AbortSignal.timeout(15_000) },
  )
  if (!res.ok) throw new Error(`board read HTTP ${res.status}`)
  const data = (await res.json()) as ProjectData
  return data.tasks ?? []
}

/** Move a card to `column` (+optionally record its branch) through the project's
 *  own Board HTTP API — the single write path shared by both the todo→doing
 *  dispatch and the doing→review promotion. */
const setCardColumn = async (
  projectPath: string,
  taskId: string,
  column: 'todo' | 'doing' | 'review',
  branch: string,
): Promise<boolean> => {
  const res = await fetch(`${loopbackOrigin()}/api/project/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: projectPath,
      setColumn: [{ id: taskId, column }],
      // Record the branch on the card too (same as the manual dispatch), so the
      // Review column's "merged?" check / the integration stage can find it.
      // Skip when unknown.
      setBranch: branch ? [{ id: taskId, branch }] : [],
    }),
    signal: AbortSignal.timeout(15_000),
  })
  return res.ok
}

const defaultMoveToDoing = (projectPath: string, taskId: string, branch: string): Promise<boolean> =>
  setCardColumn(projectPath, taskId, 'doing', branch)

const defaultMoveToReview = (projectPath: string, taskId: string, branch: string): Promise<boolean> =>
  setCardColumn(projectPath, taskId, 'review', branch)

// --- manager-only integration wake + resurrection (2026-07-15) ---------------
//
// The engine WAKES the commander when a worker is ready (it no longer integrates
// itself). Card B adds the RESUSCITATION reflex on top: a heartbeat the commander
// writes while it works, so the engine can tell a HUNG desk (live PTY, but silent —
// context overflow / API error / hang while a big diff floods in, the owner's actual
// complaint) from a healthy one, and re-wake it. The nervous system revives the brain.

/** No manager heartbeat within this window (while integration work is WAITING) ⇒ the
 *  commander is HUNG, not merely idle. Generous: an actively-integrating desk beats far
 *  more often (每 phase), so 10 min of TOTAL silence with review cards stacked up is a
 *  wedge, not a think-pause. Only ever consulted on the ARMED (autopilot) path, where a
 *  live desk is expected to be auto-integrating, never idle-waiting for a human. */
export const MANAGER_HEARTBEAT_STALE_MS = 10 * 60_000

/** What the engine can observe about the commander's desk — see
 *  {@link defaultManagerPresence} for why "is it there?" and "is it working?" must be
 *  separate answers (they carry DIFFERENT engine responses: spawn vs nudge vs nothing). */
export type ManagerPresence = 'absent' | 'idle' | 'active'

/** Minimum gap between nudges to a LIVE but quiet desk. Matched to the silence window
 *  so a nudged desk gets a full window to answer before it is poked again — and so an
 *  owner deliberately ignoring the swarm is not spammed. */
export const MANAGER_NUDGE_INTERVAL_MS = MANAGER_HEARTBEAT_STALE_MS

/** How many times a live desk is nudged about the same waiting batch before the engine
 *  gives up and stays quiet. A desk that is up but unresponsive to nudges is a HUMAN
 *  matter (the owner may simply be away from it); poking it forever helps no one — and
 *  unlike an absent desk, it is NOT a `manager-unrevivable` case (完了条件3): the desk
 *  exists, so "the commander cannot be started" would be a lie. */
export const MAX_MANAGER_NUDGES = 3

/** THE OUTCOME CLOCK (2026-07-22). How long the review queue may sit with NOTHING moving
 *  and NO commander heartbeat before the engine speaks up — **even when the desk reads
 *  `'active'`**.
 *
 *  WHY A SECOND, LONGER CLOCK EXISTS AT ALL. {@link defaultManagerPresence} answers "is
 *  the desk alive?" and its strongest everyday channel is PTY PAINT. That is the right
 *  answer to that question and the wrong answer to "is the integration progressing?" —
 *  the commander is a session that says one turn and STOPS. Paint proves it spoke; it
 *  does not prove it is still working. Measured 2026-07-22: the commander beat 統合完了 at
 *  10:31, two workers promoted into review at 10:37/10:40, and the engine said NOTHING
 *  until the owner woke it by hand at 11:51 — 80 minutes with four branches stacked up,
 *  because the presence probe kept answering the question it was asked. So liveness
 *  ('is a desk there?') now has a companion: DELIVERY ('is anything coming out of it?').
 *
 *  WHAT COUNTS AS DELIVERY. Not paint — paint is emitted by any TUI repaint, which is the
 *  whole bug above. The three files of {@link defaultManagerDeliveryAt} (heartbeat,
 *  session transcript, sub-agent transcripts) instead, because every one of them is
 *  written only as a BY-PRODUCT OF WORK and never by a repaint.
 *
 *  ⚠ THE BEAT ALONE IS NOT ENOUGH — 2026-07-22 差し戻し, and the reason this comment is
 *  long. `/og-manage` beats ONCE at the head of each branch (docs/commander/03 §3) and
 *  then does the whole branch INSIDE ONE TURN: `npx tsc --noEmit`, `npm test` (3–12
 *  minutes on this repo, worse under load), then adversarial reviewers via the Agent tool
 *  (5–20 minutes, several at once on a big diff). It cannot curl a beat from inside that
 *  turn. So "40 minutes with no beat" is the NORMAL shape of a commander doing its job,
 *  and a beat-only rule would have ESC-interrupted running reviews — turning a fix for a
 *  missing nudge into a machine that breaks the commander's actual work. The other two
 *  channels are what separate that desk from a stopped one; see defaultManagerDeliveryAt.
 *
 *  WHY 40 MINUTES (完了条件2 — the anti-false-positive margin). A nudge leads with ESC, so
 *  a wrong one interrupts a generation or clears typed input: the threshold must exceed
 *  the longest gap a genuinely WORKING commander can leave across ALL THREE channels at
 *  once. That gap is one long blocking tool call with no sub-agent running — a full
 *  `npm test`, measured at 3–12 minutes on this repo (2026-07-22, under swarm load) —
 *  because a sub-agent stretch keeps channel 3 moving and every other step appends a
 *  tool_result to channel 2. 40 minutes is more than triple that. It is a ceiling on how
 *  long a SILENT commander goes unnoticed, not a deadline for a working one — the ordinary
 *  10-minute {@link MANAGER_HEARTBEAT_STALE_MS} path still catches every desk whose PAINT
 *  also went quiet, which is the common case and much faster. */
export const MANAGER_INTEGRATION_STALL_MS = 40 * 60_000

/** RE-ARM the spent nudge budget once per episode after this long, while the queue is
 *  still stalled (完了条件1, the other half of the 80-minute silence).
 *
 *  {@link MAX_MANAGER_NUDGES} deliberately ends in silence: a desk that ignores three
 *  pokes is a human matter. But "the budget is spent" is a verdict about the DESK, and
 *  the episode it belongs to only ends when review DRAINS — so a batch that never drains
 *  (a commander that stopped, or cards parked awaiting the owner) leaves the engine mute
 *  for as long as the batch lives, which is indistinguishable from the bug this card
 *  fixes. One extra round, after a full hour of PROVABLE stall (no beat, nothing moving),
 *  bounds the engine's voice at ≤6 pokes per waiting batch while removing "mute forever
 *  with work stuck" — and the one-shot 「声かけに応答しません」 warn still fires exactly once. */
export const MANAGER_NUDGE_REARM_MS = 60 * 60_000

/** After the engine wakes/resuscitates a desk, wait this long before judging it again —
 *  a freshly-`claude --resume`d commander needs to boot AND emit its first beat, and the
 *  PREVIOUS (stale) heartbeat file still reads dead until it does. Without this grace the
 *  boot gap would look like a hang and the engine would double-spawn every 15s tick. */
export const MANAGER_RESUME_GRACE_MS = 5 * 60_000

/** Consecutive resurrections before the reflex GIVES UP and escalates (完了条件5). A
 *  commander that dies immediately every time (permanent quota wall / boot-crash bug)
 *  would otherwise burn tokens forever in a detect→spawn→die loop. After this many
 *  failed revivals the engine stops reviving and fires ONE 'manager-unrevivable' fatal
 *  notification instead. In-memory counter (engine.managerResume) — resets on restart,
 *  like all engine cognition. */
export const MAX_MANAGER_RESUME_ATTEMPTS = 3

/** After the give-up guard has fired ('manager-unrevivable'), wait this long since the
 *  last wake attempt before RE-ARMING one more resuscitation cycle (完了条件2, 2026-07-20).
 *
 *  WHY THIS EXISTS. The give-up guard (完了条件5) exists to stop a TIGHT detect→spawn→die
 *  loop from burning tokens forever — but "stop the tight loop" was implemented as "stop
 *  FOREVER": once `attempts` reached the max and `fatalFired` latched, the absent branch
 *  returned every tick and NOTHING re-woke the commander. The reset conditions
 *  (`presence` seen active/idle, or work drains) never fire when the desk is GENUINELY
 *  absent and work keeps waiting — so a TRANSIENT cause (every allowed tier momentarily
 *  cooling; the account-wide wall that lifts on its own; a machine that comes back) left
 *  integration stalled permanently after one toast the owner might have missed
 *  (observed shape 2026-07-20: 11 desks, then a wedged give-up state).
 *
 *  So the guard now stops the LOOP without stopping RECOVERY: after this backoff it lets
 *  ONE more resuscitation through. The fatal NOTIFICATION stays one-shot (`fatalFired`
 *  is NOT reset here) so the owner is alerted once per episode, not every cycle — only a
 *  desk that actually comes up clears it. Burn is bounded to one wake per this interval,
 *  and a wake with no usable tier (woke=false) spawns nothing at all. Deliberately much
 *  longer than {@link MANAGER_RESUME_GRACE_MS}: the point is a slow retry, not a loop. */
export const MANAGER_UNREVIVABLE_RETRY_MS = 30 * 60_000

/** The commander's own heartbeat file — a FIXED `manager.json` in the SAME per-repo dir
 *  the workers beat into (`~/.openground/swarm/<repoKey>/`, 完了条件1: 心拍の在処). Keyed
 *  by repo, not branch (the commander runs on the primary checkout, has no `swarm/*`
 *  branch of its own), so it never collides with a worker heartbeat. null when the repo
 *  key can't be derived (not a git repo / torn home). */
const managerHeartbeatFile = async (projectPath: string): Promise<string | null> => {
  const key = await swarmRepoKey(projectPath)
  return key ? join(openGroundHome(), 'swarm', key, 'manager.json') : null
}

/** Write/refresh the commander's heartbeat (the seam POST /api/swarm/manager/beat calls
 *  on the commander's behalf — it curls the app API for everything else too, so this
 *  fits its「HTTP API + git だけ」protocol). `now` is injected for deterministic tests.
 *  Best-effort: a write fault is swallowed (a missed beat at worst looks like a brief
 *  silence to the monitor — never a crash). */
export const writeManagerHeartbeat = async (
  projectPath: string,
  info: { phase?: string; note?: string } = {},
  now: number = Date.now(),
): Promise<boolean> => {
  const file = await managerHeartbeatFile(projectPath)
  if (!file) return false
  try {
    await mkdir(dirname(file), { recursive: true })
    await atomicWriteJson(file, {
      role: 'manager',
      updatedAt: new Date(now).toISOString(),
      ...(info.phase ? { phase: info.phase } : {}),
      ...(info.note ? { note: info.note } : {}),
    })
    return true
  } catch {
    return false
  }
}

/** Read the commander heartbeat's `updatedAt` as epoch ms, or null when absent /
 *  unreadable / unparseable (never beat, torn home, hand-corrupted). Pure read — the
 *  monitor decides freshness against its own clock ({@link isManagerHeartbeatFresh}). */
export const readManagerHeartbeatAt = async (projectPath: string): Promise<number | null> => {
  const file = await managerHeartbeatFile(projectPath)
  if (!file) return null
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as { updatedAt?: unknown }
    if (typeof j.updatedAt !== 'string') return null
    const t = Date.parse(j.updatedAt)
    return Number.isFinite(t) ? t : null
  } catch {
    return null
  }
}

/** Is the commander heartbeat FRESH at `now`? Pure (no IO/clock) so the freshness rule
 *  is unit-tested directly. `at == null` (never beat) is deliberately treated as FRESH
 *  (fail-open): a live desk that simply isn't beating — an old pre-heartbeat session, a
 *  desk the human started by hand — must not be torn down and respawned. Only a heartbeat
 *  that EXISTED and went stale past {@link MANAGER_HEARTBEAT_STALE_MS} reads as hung. */
export const isManagerHeartbeatFresh = (at: number | null, now: number): boolean =>
  at == null || now - at < MANAGER_HEARTBEAT_STALE_MS

/** Is INTEGRATION stalled — work waiting long enough that a working commander would have
 *  produced SOMETHING by now, and nothing produced? Pure (no IO/clock) so the rule is
 *  unit-tested directly. See {@link MANAGER_INTEGRATION_STALL_MS} for why this exists
 *  beside the presence probe and why the window is what it is.
 *
 *  BOTH clocks must be past the window, and they measure different things:
 *    - `waitingSinceMs` — when the OLDEST swarm card now in review was FIRST SEEN waiting.
 *      Without it a card that landed one second ago would be enough to poke a desk the
 *      owner is talking to, just because the last integration ended an hour back.
 *    - `deliveryAtMs` — {@link defaultManagerDeliveryAt}: the newest of heartbeat /
 *      session transcript / sub-agent transcripts. This is the half that keeps a
 *      genuinely-integrating desk safe (完了条件2). It must NOT be the heartbeat alone:
 *      the commander beats once per branch and then works for tens of minutes inside a
 *      single turn, so a beat-only rule reads honest work as a stall.
 *
 *  `deliveryAtMs === null` (no channel has anything to say) ⇒ NOT stalled, deliberately —
 *  the same fail-open {@link isManagerHeartbeatFresh} takes, and for the same reason: a
 *  rule that reads "silence" off channels that were never written would poke a desk we
 *  know nothing about. Nothing is lost: a desk that is stopped AND not painting still ages
 *  into `'idle'` on the ordinary 10-minute path, which does not consult this at all. */
export const managerIntegrationStalled = (input: {
  /** Epoch ms the oldest waiting review card was first seen, or null when none waits. */
  waitingSinceMs: number | null
  /** Epoch ms the commander last demonstrably produced work, or null when nothing says. */
  deliveryAtMs: number | null
  now: number
  /** Window override (tests). Default {@link MANAGER_INTEGRATION_STALL_MS}. */
  stallMs?: number
}): boolean => {
  const stallMs = input.stallMs ?? MANAGER_INTEGRATION_STALL_MS
  if (input.waitingSinceMs === null || input.deliveryAtMs === null) return false
  if (input.now - input.waitingSinceMs < stallMs) return false
  return input.now - input.deliveryAtMs >= stallMs
}

/** DISPLAY snapshot of the commander heartbeat — the full record (phase / note /
 *  updatedAt) plus a server-clock freshness read, for GET /api/swarm/orchestrator's
 *  `manager` field (the Swarm tab's "検品中/待機中" presence line — the post-worker
 *  quiet minutes explained). READ-ONLY and SEPARATE from the resurrection reflex:
 *  {@link readManagerHeartbeatAt} + {@link isManagerHeartbeatFresh} (whose null =
 *  fresh fail-open serves reviving, not rendering) are untouched — here an absent /
 *  unreadable / malformed file is simply `null` ("nothing to show", the UI degrades
 *  to its standby wording). Never throws. `now` injected for deterministic tests. */
export const readManagerHeartbeatInfo = async (
  projectPath: string,
  now: number = Date.now(),
): Promise<SwarmManagerHeartbeat | null> => {
  const file = await managerHeartbeatFile(projectPath)
  if (!file) return null
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    if (typeof j.updatedAt !== 'string') return null
    const at = Date.parse(j.updatedAt)
    if (!Number.isFinite(at)) return null
    const ageMs = Math.max(0, now - at) // clamp — a skewed future stamp reads as "just now"
    return {
      updatedAt: j.updatedAt,
      ageMs,
      fresh: ageMs < MANAGER_HEARTBEAT_STALE_MS,
      ...(typeof j.phase === 'string' && j.phase ? { phase: j.phase } : {}),
      ...(typeof j.note === 'string' && j.note ? { note: j.note } : {}),
    }
  } catch {
    return null // unreadable / torn / hand-corrupted — nothing to show (fail-safe)
  }
}

/** Newest mtime of the commander session's own claude transcript, or null when there
 *  is none / it can't be stat'd. The THIRD activity channel: claude appends an event
 *  to `~/.claude/projects/<cwd>/<id>.jsonl` for every turn, so a growing transcript
 *  proves the conversation is progressing even across a moment when the TUI happens
 *  not to be repainting. Never throws (a torn ~/.claude just contributes no signal). */
const managerTranscriptAt = async (cwd: string, sessionId: string): Promise<number | null> => {
  try {
    const st = await stat(sessionJsonlPath(cwd, sessionId))
    return st.isFile() ? st.mtimeMs : null
  } catch {
    return null
  }
}

/** Newest mtime across the SUB-AGENT transcripts this session has spawned, or null when
 *  there are none. The channel that proves a desk sitting inside ONE long turn is still
 *  working (2026-07-22).
 *
 *  A commander integrating a branch runs its adversarial reviewers with the Agent tool,
 *  and those turns do NOT land in the parent `<sessionId>.jsonl` — they go to
 *  `<sessionId>/subagents/agent-*.jsonl`. So the parent transcript FREEZES for the whole
 *  review while the desk is at its busiest. Measured on the real tree 2026-07-22: a
 *  39-minute reviewer wrote 229 entries into its own file and that file's mtime matched
 *  its last entry's timestamp to the second — i.e. these files are appended
 *  INCREMENTALLY, so their mtime tracks the sub-agent's progress in real time.
 *
 *  Never throws: a missing dir (no sub-agent ever ran) or a torn ~/.claude simply
 *  contributes no signal. Cheap by placement — only the stall probe calls it, and only
 *  after the queue has already waited past MANAGER_INTEGRATION_STALL_MS. */
const managerSubagentActivityAt = async (cwd: string, sessionId: string): Promise<number | null> => {
  const dir = sessionSubagentsDir(cwd, sessionId)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null // no subagents dir — this session has never spawned one
  }
  let newest = 0
  for (const name of names) {
    if (!name.startsWith('agent-') || !name.endsWith('.jsonl')) continue
    try {
      const st = await stat(join(dir, name))
      if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs
    } catch {
      // a file that vanished between readdir and stat contributes nothing
    }
  }
  return newest > 0 ? newest : null
}

/** Newest mtime across a claude session's OWN transcript AND its sub-agent transcripts
 *  — the two FILE channels that keep advancing while the PTY frame and the (sparse)
 *  heartbeat are both frozen, i.e. a session sitting inside ONE long turn running a
 *  Task() sub-agent. Generic over any {cwd, sessionId} (the two helpers below are named
 *  `manager*` for historical reasons but read nothing manager-specific): the manager
 *  delivery clock ({@link defaultManagerDeliveryAt}) reads the two parts directly, and
 *  the WORKER stall backstop reads them combined through here — the worker analog of
 *  7517e4b1 (2026-07-23). null when neither file has anything. Never throws. */
const sessionAgentActivityAt = async (cwd: string, sessionId: string): Promise<number | null> => {
  const [parentAt, subAt] = await Promise.all([
    managerTranscriptAt(cwd, sessionId),
    managerSubagentActivityAt(cwd, sessionId),
  ])
  const newest = Math.max(parentAt ?? 0, subAt ?? 0)
  return newest > 0 ? newest : null
}

/** Regex over ONE `queue-operation` record's content: every tool-use id the task
 *  notification names. A notification is written when a background task REACHES AN END
 *  — completed, failed or killed — so an id appearing here is an id no longer in
 *  flight. Module-scope (not rebuilt per line); `exec`-looped rather than `matchAll`
 *  so the scan never depends on downlevel-iteration settings. */
const BG_TASK_NOTIFICATION_ID_RE = /<tool-use-id>([^<]+)<\/tool-use-id>/g

/** The (few) transcript fields {@link sessionBackgroundTaskAt} reads. Deliberately all
 *  optional and `unknown`-ish: this is FOREIGN data written by another program, so every
 *  field is checked at the use site rather than trusted from a cast. */
type TranscriptRecord = {
  type?: unknown
  timestamp?: unknown
  /** queue-operation only — the `<task-notification>` block. */
  content?: unknown
  /** assistant: the `tool_use` blocks. user: the `tool_result` blocks. */
  message?: {
    content?: {
      type?: unknown
      /** tool_use: the id the notification will name. */
      id?: unknown
      input?: { run_in_background?: unknown }
      /** tool_result: the id of the tool_use it answers. */
      tool_use_id?: unknown
      /** tool_result: the CLI's reply text (a string in every sample; an array of
       *  blocks is tolerated defensively). */
      content?: unknown
    }[]
  }
}

/** The CLI's announcement that a FOREGROUND Bash outran its `timeout` and the harness
 *  moved it to the background by itself. Surveyed across every worker transcript on this
 *  disk (2026-07-27): 44 genuine occurrences, ONE spelling, always the WHOLE result text
 *  — "Command did not complete within its <N>s timeout and was moved to the background
 *  (ID: …). Output is being written to: …" (the observed timeouts were 120/180/300/420/600s).
 *
 *  ANCHORED, and not merely a `was moved to the background` substring, because that
 *  substring is not evidence — it is PROSE. A `tool_result` is also what a `Read` returns,
 *  so any file quoting the phrase becomes a phantom background task that never resolves
 *  and hands a genuinely stuck worker the full grace. Not hypothetical: the same survey
 *  found THREE tool_results already matching the loose form on this disk (two dumps of a
 *  transcript, one the investigation for this very fix), and the doc you are reading about
 *  it — 02-worker-lifecycle §5.4b — quotes the phrase too. Requiring the sentence from its
 *  first character rejects all of them and keeps all 44 real ones. */
const BG_TASK_AUTO_MOVE_RE = /^Command did not complete within its \S+ timeout and was moved to the background \(ID: /

/** A `tool_result` block's text. A plain string in every sample on this disk; the array
 *  form (`[{type:'text',text}]`) is tolerated so a CLI change cannot silently blind
 *  START B — the failure mode would be invisible (no error, just a worker killed again). */
const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const b of content) {
    const t = (b as { text?: unknown } | null)?.text
    if (typeof t === 'string') out += t
  }
  return out
}

/** Last answer per transcript path, keyed by the bytes that produced it.
 *
 *  Not a cache for speed's sake — a correctness-neutral memo. The stall gate keeps
 *  {@link sessionBackgroundTaskAt} being called every 3s tick for the WHOLE grace, and
 *  the worker it is asking about is (by the very definition of the case) appending
 *  nothing, so every one of those reads returns a byte-identical file. `(size, mtimeMs)`
 *  changing is what a new record looks like; anything else re-uses the answer.
 *
 *  Bounded by the number of distinct worker transcripts a boot ever probes, and entries
 *  are dropped as soon as a file stops stat-ing (teardown). Kept on `globalThis` with
 *  the rest of the engine's in-memory state so `tsx watch` reloads don't multiply it. */
const bgTaskMemo: Map<string, { sig: string; at: number | null }> = ((
  globalThis as { __openground_bgTaskMemo?: Map<string, { sig: string; at: number | null }> }
).__openground_bgTaskMemo ??= new Map())

/** WHEN did the worker's NEWEST still-unresolved BACKGROUND TASK start (epoch ms), or
 *  null when none is in flight — the FOURTH liveness channel's raw signal, the one that
 *  proves a worker with a FINISHED TURN is still working.
 *
 *  WHAT IT READS (verified against real killed workers' transcripts, 2026-07-27 —
 *  no constant or record name here is guessed):
 *    • START A — EXPLICIT. An `assistant` record whose `message.content[]` holds a
 *               `{type:'tool_use', id:'toolu_…', input:{run_in_background:true}}`.
 *               Its record `timestamp` is when the task was launched.
 *    • START B — AUTO-BACKGROUNDED, and the reason the first cut of this channel still
 *               let workers die. A FOREGROUND Bash that outruns its `timeout` is moved
 *               to the background BY THE HARNESS, and that `tool_use` record has NO
 *               `run_in_background` key at all — nothing about it says "background".
 *               The evidence is a `user` record whose `message.content[]` holds a
 *               `{type:'tool_result', tool_use_id:'toolu_…'}` whose text matches
 *               {@link BG_TASK_AUTO_MOVE_RE}. Its record `timestamp` is when the task
 *               BECAME a background task — which is the moment that matters here, since
 *               up to then the foreground Bash was holding the turn open (and feeding
 *               the third channel). Measured on this disk: 44 tasks are born this way,
 *               8 of them went on to fall silent past the stall gate, and 6 past the
 *               reclaim point — i.e. reading only START A leaves the SAME false kill
 *               live for ~15% of the exposure. gap-4, one of the two workers used to
 *               validate the original fix, has one in its own record:
 *               `toolu_016eNGirNrZE6cYbt7vX382s` — foreground at 08:50:49, auto-moved
 *               at 09:00:56, finished at 09:20:52. A full `npm test` ran in the
 *               background for 20 minutes and the first parser could not see it.
 *    • END    — a `queue-operation` record whose `content` is the `<task-notification>`
 *               block naming that same `<tool-use-id>`. Both `enqueue` (the notification
 *               is created the moment the task ends) and `remove`/`dequeue` (it was
 *               delivered or dropped) carry the id, and ALL of them mean the same thing
 *               here: that task is no longer pending. **Identical for both START forms**
 *               — an auto-moved task keeps its original tool_use id, so the END side
 *               needed no change (confirmed on gap-4's record above).
 *  The pairing is exact and was confirmed end to end — gap-7's last background
 *  `npm test` (`toolu_012rtVNy8uKsWUfPSjKYwgD5`, started 10:00:52) is named by the
 *  `queue-operation` at 10:20:33 carrying `<status>killed</status>`, which is the
 *  instant the engine reclaimed it.
 *
 *  KNOWN UNCOVERED SLICE: a worker RESUMED into a new session file whose task started in
 *  the PREVIOUS one has a start this cannot see, so it loses the channel. Safe-side (the
 *  worker is judged exactly as it was before this channel existed), and left alone
 *  deliberately — stitching sessions would mean trusting a resume chain to decide a kill.
 *
 *  A start with no matching end is IN FLIGHT. The NEWEST such start is returned. The
 *  tempting alternative — the oldest, so the cap always judges the longest-running task
 *  — has a hole that reopens the very bug this closes: ONE task that never reports back
 *  (a background dev server, a `tail -f`, anything killed in a way that lost its
 *  notification) would SHADOW every later task forever, and 90 minutes on the worker
 *  would lose the channel while genuinely running its tests. The newest has no such
 *  hole, and it cannot be abused: emitting a fresh `tool_use` requires the worker to be
 *  awake and working — that IS life, and it grows the transcript besides. A worker that
 *  has actually died launches nothing more, so its last task ages out of the grace on
 *  exactly the same clock and the ordinary escalation resumes.
 *
 *  COST. Only lines containing one of three marker substrings are JSON-parsed at all
 *  (20 of 815 lines in the 1.27 MB sample). But the read itself is O(file), the gate
 *  above stays OPEN for the whole grace, and `monitorWorkers` ticks every 3s — so a
 *  naive implementation re-reads the same bytes ~1800 times per worker per grace
 *  (measured: 3.7ms at 1.27 MB, 12-14ms at 5-6 MB, 57ms at 18.8 MB — and real worker
 *  transcripts DO reach 6 MB). Six such workers would spend ~80ms of the main thread
 *  every 3s tick, on the same process that is streaming PTY output over SSE. Hence
 *  {@link bgTaskMemo}: a worker waiting on a background task is by definition APPENDING
 *  NOTHING, so `(size, mtimeMs)` identify the bytes and the repeat scans are free.
 *
 *  Never throws: an unreadable / torn file simply contributes no signal, which leaves
 *  the previous verdict standing. */
export const sessionBackgroundTaskAt = async (cwd: string, sessionId: string): Promise<number | null> => {
  const path = sessionJsonlPath(cwd, sessionId)
  // Identify the BYTES before reading them. A worker sitting on a background task has
  // ended its turn and is appending nothing, so an unchanged (size, mtime) means an
  // unchanged answer — which is exactly the case the gate keeps us in for 90 minutes.
  let sig = ''
  try {
    const st = await stat(path)
    sig = `${st.size}:${st.mtimeMs}`
    const memo = bgTaskMemo.get(path)
    if (memo && memo.sig === sig) return memo.at
  } catch {
    bgTaskMemo.delete(path) // vanished ⇒ drop any stale answer
    return null
  }
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return null // no transcript (or a torn ~/.claude) ⇒ no signal
  }
  const startedAt = new Map<string, number>()
  const ended = new Set<string>()
  for (const line of text.split('\n')) {
    // Substring pre-filter FIRST — JSON.parse on every line of a multi-MB transcript
    // is the only thing that could make this probe expensive.
    const maybeStart = line.includes('run_in_background')
    const maybeAutoStart = line.includes('moved to the background')
    const maybeEnd = line.includes('queue-operation')
    if (!maybeStart && !maybeAutoStart && !maybeEnd) continue
    let rec: TranscriptRecord
    try {
      rec = JSON.parse(line) as TranscriptRecord
    } catch {
      continue // a half-written trailing line while claude appends — skip it
    }
    if (rec?.type === 'queue-operation') {
      const content = typeof rec.content === 'string' ? rec.content : ''
      BG_TASK_NOTIFICATION_ID_RE.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = BG_TASK_NOTIFICATION_ID_RE.exec(content)) !== null) ended.add(m[1])
      continue
    }
    if (rec?.type !== 'assistant' && rec?.type !== 'user') continue
    const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : Number.NaN
    if (!Number.isFinite(at)) continue
    const parts = Array.isArray(rec.message?.content) ? rec.message.content : []
    for (const part of parts) {
      // START A — launched as a background task outright.
      if (
        part?.type === 'tool_use' &&
        part.input?.run_in_background === true &&
        typeof part.id === 'string' &&
        !startedAt.has(part.id) // ids are unique per tool_use; keep the first stamp
      ) {
        startedAt.set(part.id, at)
        continue
      }
      // START B — a foreground Bash the harness moved to the background on timeout.
      // Keyed by the tool_use it answers, stamped when the MOVE happened (before that
      // the foreground command was holding the turn open, so the worker was not silent).
      if (
        part?.type === 'tool_result' &&
        typeof part.tool_use_id === 'string' &&
        !startedAt.has(part.tool_use_id) &&
        BG_TASK_AUTO_MOVE_RE.test(toolResultText(part.content))
      ) {
        startedAt.set(part.tool_use_id, at)
      }
    }
  }
  let newest: number | null = null
  startedAt.forEach((at, id) => {
    if (ended.has(id)) return
    if (newest === null || at > newest) newest = at
  })
  bgTaskMemo.set(path, { sig, at: newest })
  return newest
}

/** WHICH desk is the engine talking about, and when did it last paint? The resolution
 *  {@link defaultManagerPresence} and {@link defaultManagerDeliveryAt} must agree on —
 *  extracted so the two probes can never judge DIFFERENT desks (the orphan fallback below
 *  is subtle enough that a second hand-rolled copy would drift).
 *
 *  null ⇒ there is no desk anywhere (presence's `'absent'`). Otherwise the desk's own
 *  cwd + session id + newest paint — the ORPHAN's when the store's record is stale, since
 *  its session id and this project's path are what name ITS transcript, and judging the
 *  desk that exists by the activity of one that does not is precisely the 2026-07-19 bug.
 *  Throws only what its callers already catch (a torn session store). */
const resolveManagerDesk = async (
  projectPath: string,
  deps: {
    activity?: (agentSessionId: string) => ClaudeSessionActivity
    liveDesks?: (cwd: string, deskLabel: string) => OwnerDeskTerminal[]
    managerDesks?: typeof listManagerDesks
  },
): Promise<{ cwd: string; sessionId: string; paintedAt: number } | null> => {
  const rec = (await readSwarmSessions(projectPath)).manager
  const pty = rec
    ? (deps.activity ?? claudeSessionActivity)(rec.sessionId)
    : { live: false, lastOutputAt: null, terminalId: null }
  // The record's desk is gone (or there is no record). BEFORE concluding there is
  // no desk, ASK THE POOL (2026-07-19: eleven desks, none of them dead).
  //
  // 'absent' drives the only spawn, so reading it wrongly is what builds a twin —
  // and this probe used to read it from ONE slot in a store that every spawn
  // overwrites and whose write failure is swallowed (swarmManager). A desk whose
  // id has been overwritten keeps running while presence, asking only about the id
  // on file, calls it absent forever: engine spawns a replacement, that one's id
  // takes the slot, and the previous desk joins the pile. The desks were never
  // dead — they were UNNAMED. This is the hole 03 §2.3 recorded on 2026-07-19
  // (「登録されていない卓は presence から見えない」), closed here at its source.
  //
  // The pool cannot desynchronise from itself, so a labelled commander desk found
  // there is proof a desk EXISTS — which is exactly and only what 'absent' claims
  // the absence of. Reconciling the store is spawnSwarmManager's job (it holds the
  // write path); presence stays a pure read and simply stops lying.
  //
  // BOTH POOLS since stage 3. An SDK commander is in no PTY pool at all, so a
  // PTY-only sweep here would call a perfectly healthy desk 'absent' and ask for
  // a replacement EVERY PASS — the eleven-desk incident reproduced exactly, this
  // time by construction rather than by a store desync. `listManagerDesks` is the
  // one place that knows where commander desks can live.
  const orphan = pty.live
    ? null
    : ((deps.managerDesks ?? listManagerDesks)(projectPath, {
        ...(deps.liveDesks ? { ptyDesks: deps.liveDesks } : {}),
      })[0] ?? null)
  if (!pty.live && !orphan) return null // no desk anywhere — the ONLY spawn trigger
  return {
    cwd: orphan ? projectPath : rec!.cwd,
    sessionId: orphan ? (orphan.agentSessionId ?? '') : rec!.sessionId,
    paintedAt: (orphan ? orphan.lastOutputAt : pty.lastOutputAt) ?? 0,
  }
}

/** WHEN did the commander last demonstrably DO something — the DELIVERY clock the stall
 *  check ({@link managerIntegrationStalled}) judges an `'active'` desk against. Epoch ms,
 *  or null when no channel has anything to say.
 *
 *  The newest of THREE files, all of which are written only as a by-product of real work
 *  (never by a repaint):
 *    1. the commander's heartbeat — written per branch at the head of an integration;
 *    2. the session transcript — appended per tool_use / tool_result, i.e. every step of
 *       a turn that is running commands;
 *    3. the SUB-AGENT transcripts — the channel that covers the long stretch where (1)
 *       and (2) are both frozen because the desk is inside ONE turn waiting on reviewers
 *       (see {@link managerSubagentActivityAt}).
 *
 *  WHY ALL THREE (the 2026-07-22 差し戻し). The first cut of this check used the heartbeat
 *  ALONE, and that is wrong about how the commander actually works: `/og-manage` beats
 *  ONCE at the head of each branch and then does the whole branch — `npx tsc --noEmit`,
 *  `npm test` (3–12 minutes on this repo, worse under load), then adversarial reviewers
 *  via the Agent tool (5–20 minutes, several at once on a big diff) — INSIDE that single
 *  turn, during which it cannot curl a beat at all. So "40 minutes with no beat" is the
 *  NORMAL shape of a commander doing its job, and poking it there would ESC-interrupt a
 *  running review. Channels 2+3 are what separate that desk from one that has stopped:
 *  a commander that spoke and stopped freezes all three at the same instant.
 *
 *  Never throws — an unreadable store/home just yields whatever channels did answer. */
export const defaultManagerDeliveryAt = async (
  projectPath: string,
  deps: {
    activity?: (agentSessionId: string) => ClaudeSessionActivity
    liveDesks?: (cwd: string, deskLabel: string) => OwnerDeskTerminal[]
  } = {},
): Promise<number | null> => {
  try {
    const beatAt = await readManagerHeartbeatAt(projectPath)
    const desk = await resolveManagerDesk(projectPath, deps)
    const sid = desk?.sessionId ?? ''
    const [parentAt, subAt] = sid
      ? await Promise.all([
          managerTranscriptAt(desk!.cwd, sid),
          managerSubagentActivityAt(desk!.cwd, sid),
        ])
      : [null, null]
    const newest = Math.max(beatAt ?? 0, parentAt ?? 0, subAt ?? 0)
    return newest > 0 ? newest : null
  } catch {
    return null // nothing readable ⇒ no evidence ⇒ fail-open (never stalled)
  }
}

/** What the engine believes about the commander's desk ({@link IntegrationDeps.managerPresence}).
 *
 *  THREE states, because "present" and "engaged" are different questions and the
 *  engine's response to each must differ (the 2026-07-18 incident is exactly what
 *  conflating them costs):
 *    - `'absent'` — no live PTY holds the persisted manager session. There is NO desk.
 *      The only state that may SPAWN one, and therefore the only state that can count
 *      toward `manager-unrevivable` (完了条件3).
 *    - `'idle'`  — a desk IS up, but nothing says it is engaging with the waiting work
 *      (no fresh beat, no recent paint, no transcript growth). NEVER spawn a second
 *      desk here — nudge the one that exists (完了条件2+5).
 *    - `'active'` — a desk is up AND there is positive evidence of life. Leave it alone.
 *
 *  WHY the extra channels (完了条件1). The old probe ANDed a live PTY with heartbeat
 *  freshness, and that AND is a trap: `manager.json` is written only while the
 *  commander does heavy INTEGRATION work (the /og-manage protocol beats per phase), so
 *  a desk that is merely talking with the owner — or one that just booted and ran
 *  「状況」 — falls silent past the 10-minute window while being perfectly healthy. The
 *  fail-open for a NEVER-written beat did not save it: once any beat has landed the
 *  file exists forever, so every repo that has ever integrated once is permanently
 *  exposed. Observed 2026-07-18 05:44–05:59: three resurrections of a LIVE, working
 *  commander, then a false `manager-unrevivable` fatal, plus a pile of orphaned desks.
 *  So liveness now folds in evidence the PTY itself produces — `lastOutputAt` (claude
 *  repaints while it works and echoes keystrokes) and the session transcript's mtime —
 *  and the heartbeat becomes ONE of three positive signals rather than a veto.
 *
 *  NEVER throws: an unreadable session store (unregistered path, torn home) ⇒ 'absent',
 *  so the engine raises a desk rather than silently stalling integration. */
export const defaultManagerPresence = async (
  projectPath: string,
  now: number,
  // The PTY probe is injected (house style, cf. resolveSwarmSession's `isLive`) so the
  // file-driven half — real sessions store, real manager.json, real transcript — is
  // testable end-to-end without spawning a claude.
  //
  // `echoUntil` (0 = nothing to discount) disqualifies PTY paint at or before that instant
  // as evidence of life, because it is OUR OWN nudge coming back: writing a line into the
  // desk makes claude's TUI repaint, which stamps `lastOutputAt` whether or not anything
  // processed the prompt. Without it the poke is self-refuting — nudge → echo → 'active' →
  // budget reset → nudge again, forever, and the "3 pokes then say so once" contract
  // (03章 §7-10) can never fire (measured: 10+ pokes where 3 is promised). This is the
  // SAME trap the worker stall path already guards with {@link STALL_ECHO_GUARD_MS}
  // ("output within echoGuardMs after our nudge is the TUI repaint, not life") — the
  // manager path simply had not inherited it. Only the PTY channel is discounted: a
  // heartbeat and a transcript append are never produced by an echo, so a desk that
  // genuinely answers the nudge still reads 'active' and still refunds its budget.
  deps: {
    activity?: (agentSessionId: string) => ClaudeSessionActivity
    echoUntil?: number
    /** The POOL's live-commander-desk lookup (injected for tests) — the fallback
     *  authority when the session store does not name a desk that exists. */
    liveDesks?: (cwd: string, deskLabel: string) => OwnerDeskTerminal[]
  } = {},
): Promise<ManagerPresence> => {
  try {
    // WHICH desk (record's, or the pool's orphan when the record is stale) — shared with
    // the delivery probe so the two can never judge different desks. See resolveManagerDesk.
    const desk = await resolveManagerDesk(projectPath, deps)
    if (!desk) return 'absent' // no desk anywhere — the ONLY spawn trigger
    // A desk EXISTS. Is anything moving? Any ONE positive signal is enough — these are
    // alternative evidence of the same fact, never requirements to be ANDed (the AND is
    // precisely what broke). The heartbeat keeps its own documented rule, including the
    // never-beat fail-open: a live desk that has never beat is a hand-started desk.
    // A beat that EXISTS and is fresh is positive evidence. A beat that has NEVER been
    // written is not: `isManagerHeartbeatFresh` calls null "fresh" so the old single-bit
    // probe would not tear down a hand-started desk, but that fail-open predates the three
    // states. Honouring it here would short-circuit every live desk on a repo that has
    // never integrated straight to 'active' — the PTY and transcript channels would never
    // be consulted and such a desk could never be nudged at all. It is safe to drop
    // precisely because 'idle' no longer tears anything down: the worst case is now a poke.
    const beatAt = await readManagerHeartbeatAt(projectPath)
    if (beatAt !== null && isManagerHeartbeatFresh(beatAt, now)) return 'active'
    // The beat exists and went stale — which on its own means nothing (the commander only
    // beats while integrating). Ask the PTY itself before concluding anything.
    // NOTE (test hygiene): this reaches Claude Code's own transcript tree, which
    // `transcript.ts` resolves from `homedir()` — NOT from OPENGROUND_HOME. The suite's
    // `src/test/setup-home.ts` isolates OPENGROUND_HOME only and passes HOME through, so
    // this stat really does hit the developer's live ~/.claude/projects/ during tests. It
    // is a read-only stat against a fixture-fixed session uuid that no real session will
    // ever own, so it neither flakes nor writes anything today — but it is the reason the
    // presence tests should be run with HOME pointed at a throwaway dir. (Isolating HOME
    // inside setup-home.ts would close this properly and probably also stop the separately
    // observed real-~/.claude/settings.json pollution, but it re-anchors ~17 homedir()
    // call sites suite-wide — its own change, not this one's.)
    //
    // `desk` already carries the ORPHAN's own channels when it is the desk we found (its
    // session id and this project's path name ITS transcript, and its own paint is the
    // only paint that says anything about IT) — see resolveManagerDesk.
    const fileAt = desk.sessionId ? await managerTranscriptAt(desk.cwd, desk.sessionId) : null
    // Paint that is only our own nudge bouncing back is not life (see `echoUntil` above).
    // The transcript is left untouched by that discount — claude appends a real turn there
    // only when it actually processes something, so it is the honest half of the OR.
    const echoUntil = deps.echoUntil ?? 0
    const realPaint = echoUntil > 0 && desk.paintedAt <= echoUntil ? 0 : desk.paintedAt
    const newest = Math.max(realPaint, fileAt ?? 0)
    return newest > 0 && now - newest < MANAGER_HEARTBEAT_STALE_MS ? 'active' : 'idle'
  } catch {
    return 'absent'
  }
}

/** Poke the LIVE commander desk so it picks up waiting review work — the response to
 *  `'idle'`, and the reason that state never spawns anything (完了条件2+5).
 *
 *  ESC + one short instruction line + CR over the raw PTY write path — the FULL
 *  {@link defaultEscalate} sequence, not just its tail. The payload is a CONSTANT — no
 *  card-derived text reaches the PTY here, so there is no control-byte injection surface
 *  to strip.
 *
 *  WHY THE LEADING ESC (and why "the PTY echoes keystrokes" is not enough on its own).
 *  The obvious safety argument — a desk someone is actively typing into paints, so it
 *  reads 'active' and is never nudged — only covers the owner typing RIGHT NOW, and since
 *  2026-07-22 it does not even cover that: a desk reading 'active' purely from paint IS
 *  poked once the integration queue is provably stalled (see
 *  {@link MANAGER_INTEGRATION_STALL_MS}), so "it paints, therefore we never write to it"
 *  is no longer an invariant anywhere. What keeps that safe is the DELIVERY evidence the
 *  stall check requires ({@link defaultManagerDeliveryAt}) plus the ESC below, not the
 *  paint. The original hole remains too: a prompt typed and then LEFT SITTING has paint
 *  that ages out after {@link MANAGER_HEARTBEAT_STALE_MS}, the desk reads 'idle', and a
 *  bare line+CR would
 *  append to the half-written text and SUBMIT the two concatenated — on a desk running
 *  with `--dangerously-skip-permissions` (swarmManager.ts), i.e. with no approval gate to
 *  catch the malformed result. Our own ESC clears that pending input (and interrupts a
 *  generation in flight) before we type, exactly as the worker escalation does; the
 *  {@link STALL_ESCALATE_DELAY_MS} pause lets it settle. `sleep` is DI'd (default: real
 *  timer) so a unit test need not wait.
 *
 *  Best-effort: false when the session/PTY is gone (nothing to poke), or when either
 *  write misses — same both-writes-landed rule as defaultEscalate. */
/** What the stall nudge SAYS. A shared constant because two runtimes now deliver
 *  it by different means and the owner must read the same sentence either way —
 *  a divergence here would be invisible until someone compared two transcripts. */
export const MANAGER_STALL_NUDGE_TEXT =
  '統合待ちのカードがあります。「状況」を実行して review 列を確認し、統合の判断をしてください。'

export const defaultNudgeManager = async (
  projectPath: string,
  // `activity` is injected on the same seam defaultManagerPresence uses, so the
  // file-driven half is testable without a real PTY pool.
  deps?: {
    write?: typeof writeInput
    sleep?: (ms: number) => Promise<void>
    activity?: (agentSessionId: string) => ClaudeSessionActivity
    desk?: typeof managerDeskForSession
    say?: typeof sayToManagerDesk
  },
): Promise<boolean> => {
  const write = deps?.write ?? writeInput
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  try {
    const rec = (await readSwarmSessions(projectPath)).manager
    if (!rec) return false
    const desk = (deps?.desk ?? managerDeskForSession)(rec.sessionId, projectPath, {
      ...(deps?.activity ? { activity: deps.activity } : {}),
    })
    if (!desk) return false
    // An SDK desk has NO screen to clear and no draft to protect, so the ESC
    // (and the pause that lets it land) is skipped entirely rather than sent
    // into a stream that has no notion of it. The push is queued by the CLI even
    // mid-generation, and its acceptance comes back synchronously — the whole
    // reason this path had to be a two-step dance on a PTY.
    if (desk.runtime === 'sdk') {
      return (deps?.say ?? sayToManagerDesk)(desk, MANAGER_STALL_NUDGE_TEXT).ok
    }
    if (!write(desk.handleId, '\x1b')) return false
    await sleep(STALL_ESCALATE_DELAY_MS)
    return write(desk.handleId, `${MANAGER_STALL_NUDGE_TEXT}\r`)
  } catch {
    return false
  }
}

/** How much of a branch list the notice may name before it is summarised. Three is
 *  what the wake notification already shows, kept identical so the two surfaces read
 *  the same. */
const NOTICE_BRANCHES_SHOWN = 3

/** Longest branch name the notice will type. A branch is BOARD DATA, not a constant —
 *  it reaches this module from a card's `branch` field — so it is treated as untrusted
 *  text on its way to a raw PTY write. */
const NOTICE_BRANCH_MAX = 60

/** A branch name made safe to TYPE. Every control character becomes a space, runs of
 *  whitespace collapse, and the result is capped.
 *
 *  The nudge above can state that its payload is a CONSTANT and stop there; this one
 *  cannot, because it names the branches that are waiting. A raw CR inside a branch
 *  would submit the line early and run the remainder as its own prompt — at a desk
 *  launched with `--dangerously-skip-permissions`, i.e. with no approval gate behind
 *  it. Same discipline as `sanitizeSlashArg` in claudeSlash.ts, for the same reason. */
const sanitizeNoticeText = (raw: string): string =>
  // Codepoint test rather than a control-character REGEX on purpose: writing the class
  // out puts literal control bytes in this file, which makes `grep` treat the whole
  // module as binary and silently return nothing — a booby-trap for the next reader
  // diagnosing this code (measured while writing it).
  Array.from(raw)
    .map((ch) => {
      const cp = ch.codePointAt(0) ?? 0
      return cp < 0x20 || cp === 0x7f ? ' ' : ch
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTICE_BRANCH_MAX)

/** The line the notice types. Pure, so the wording is assertable without a PTY. */
export const managerNoticeText = (branches: readonly string[], total: number): string => {
  const named = branches
    .slice(0, NOTICE_BRANCHES_SHOWN)
    .map(sanitizeNoticeText)
    .filter((b) => b.length > 0)
  const list = named.join(', ') + (branches.length > named.length ? ` 他${branches.length - named.length}件` : '')
  return (
    `worker が完了しました — review に統合待ちが ${total} 件あります` +
    `${list ? `(${list})` : ''}。「状況」で確認して統合の判断をしてください。`
  )
}

/** MAY a notice be typed into this screen right now? The load-bearing safety property
 *  of the whole channel, kept PURE so it is assertable against a frame literal.
 *
 *  Three refusals, and together they are what stands in for the nudge's ESC:
 *
 *    1. NOT GENERATING — {@link isGenerating}, the same probe the ctx gauge's manual
 *       compact button already gates on in production (claudeSlash.ts). A pure
 *       negative: an unreadable or unfamiliar footer degrades to "not busy", so the
 *       worst case is the keystroke the owner would have typed themselves, never a
 *       sensor that goes quiet. Verified against a LIVE commander desk before this was
 *       written (2026-07-27): waiting ⇒ false, mid-turn ⇒ true, Japanese sitting unsent
 *       in the box ⇒ false — including when the box wraps to three rows, and when the
 *       literal footer phrase is typed into the box.
 *    2. INPUT BOX EMPTY — and empty as a POSITIVE reading, `=== ''`, never `null`.
 *       A desk holding half-typed text would otherwise have our line CONCATENATED onto
 *       it and the two submitted together — exactly the damage the nudge's ESC exists
 *       to pre-empt, and exactly what this channel promises not to do. `null` means no
 *       input box could be found on the frame at all (a desk still booting, or one
 *       caught mid-repaint), and writing into that lands the text in a shell prompt or
 *       in claude's own launch line. No box read ⇒ no evidence ⇒ do not write.
 *    3. NO MENU OPEN — {@link detectMenu}, the same numbered-option detector the pool
 *       already runs to drive a pane's `menuOpen` status (terminal.ts). While a chooser
 *       is up (`/model`, a theme picker, a trust dialog) the TUI reads keystrokes as
 *       SELECTION, so our line-plus-CR would not be a message at all — it would pick
 *       whatever option the cursor sits on and confirm it. That is the one way this
 *       channel could still do damage while satisfying (1) and (2), and it is not
 *       hypothetical: a menu frame has no reason to also lack an input box.
 *
 *  All three refusals mean the SAME thing to the caller — "not now" — and none loses the
 *  notice: it stays queued and the next tick (15s) asks again. */
export const noticeDeliverable = (screen: string | null | undefined): boolean =>
  !isGenerating(screen) && readInputBoxText(screen ?? '') === '' && detectMenu(screen ?? '') === null

/** TELL the live commander desk that a worker just finished — the delivery channel B
 *  (2026-07-27), and the reason the 38-minute lag existed at all.
 *
 *  ── WHY THIS IS NOT THE NUDGE ──────────────────────────────────────────────────
 *  {@link defaultNudgeManager} answers a different question: "this desk looks hung,
 *  wake it". It leads with ESC because a hung desk may be mid-generation or holding
 *  half-typed text, and getting through is worth destroying both. That destructiveness
 *  is the entire justification for the four conservative gates in front of it
 *  (10min stale → 5min grace → 10min interval → 3 pokes), and those gates are what
 *  made a HEALTHY commander the slowest one to hear about finished work: measured
 *  2026-07-27, a worker promoted to review at 00:05:47 and the desk was spoken to at
 *  00:44:20 — 38m33s, all of it by design, because the only channel available was an
 *  accident-recovery reflex being asked to carry routine news.
 *
 *  This channel carries the news instead, so it may be fast precisely because it is
 *  HARMLESS. It NEVER sends ESC and never sends Ctrl-U. It writes exactly ONE line, and
 *  only when {@link noticeDeliverable} says the screen shows a desk with nothing to
 *  lose — see there for what the two refusals are and why they replace the ESC.
 *
 *  A refusal never loses the notice: the caller keeps it queued
 *  (ProjectEngine.managerNotice) and re-offers it every pass, so a notice raised
 *  mid-generation lands on the first tick after the turn ends.
 *
 *  Best-effort, never throws: false when there is no desk, no live PTY, no readable
 *  screen, or the write missed. False always means "still queued", never "give up". */
export const defaultNotifyManagerReady = async (
  projectPath: string,
  notice: { branches: readonly string[]; total: number },
  // Injected on the same seam defaultNudgeManager / defaultManagerPresence use, so the
  // whole path is unit-testable against a screen literal with no PTY pool and no
  // registered project in sight.
  deps?: {
    write?: typeof writeInput
    activity?: (agentSessionId: string) => ClaudeSessionActivity
    getScreen?: (terminalId: string) => string | null
    sessions?: typeof readSwarmSessions
    desk?: typeof managerDeskForSession
    say?: typeof sayToManagerDesk
  },
): Promise<boolean> => {
  const getScreen = deps?.getScreen ?? getTerminalScreen
  try {
    // The RECORD's desk, deliberately — the same lookup defaultNudgeManager uses, so the
    // two writers can never type into different desks. (An orphan desk the pool knows but
    // the store does not is visible to `presence` and not to either writer; closing that
    // is a change to the nudge path too, and belongs with it rather than here.)
    const rec = (await (deps?.sessions ?? readSwarmSessions)(projectPath)).manager
    if (!rec) return false
    const desk = (deps?.desk ?? managerDeskForSession)(rec.sessionId, projectPath, {
      ...(deps?.activity ? { activity: deps.activity } : {}),
    })
    if (!desk) return false
    // `noticeDeliverable` is handed to the seam rather than applied here, so the
    // PTY arm keeps its two refusals byte-for-byte while the SDK arm — which has
    // no screen and no draft that a notice could clobber — simply does not
    // consult it. (Not "consults it and always passes": an SDK desk has no state
    // in which the notice must be withheld, and pretending otherwise would
    // reintroduce a queue that never drains.)
    const res = (deps?.say ?? sayToManagerDesk)(
      desk,
      managerNoticeText(notice.branches, notice.total),
      {
        screen: getScreen,
        deliverable: noticeDeliverable,
        ...(deps?.write ? { write: deps.write } : {}),
      },
    )
    return res.ok
  } catch {
    return false
  }
}

/** WAKE the commander ({@link IntegrationDeps.wakeManager}): spawn/resume its desk
 *  (spawnSwarmManager — resumes the days-long integration conversation, else fresh)
 *  and post ONE info notification naming the waiting review branches. The spawned
 *  `/og-manage` reads the Board and finds the review cards itself; the notification
 *  is the durable, human-facing record. NEVER throws — a NoAllowedModelTierError
 *  (every tier OFF/cooling) or any spawn fault ⇒ false, so the engine retries the
 *  wake next pass instead of marking the branches handed-off.
 *
 *  Since the 2026-08-13 fail-fast change, SdkManagerUnavailableError (SDK dial +
 *  a machine that cannot establish the SDK — CLI signed out / missing / too old)
 *  ALSO lands in this catch as `false`. That rides the reflex's EXISTING
 *  backoff: grace → 3-strike 'manager-unrevivable' fatal bell → the 30-min
 *  transient re-arm (an un-seated wake sets lastWakeSpawned=false ⇒
 *  transientWall). The 30-min retry against a signed-out CLI is deliberate and
 *  cheap — no desk was seated, nothing to tear down — and it is what makes the
 *  recovery automatic the moment the owner signs back in. */
const defaultWakeManager = async (
  projectPath: string,
  cards: readonly { branch: string; title: string }[],
): Promise<boolean> => {
  try {
    await spawnSwarmManager({ projectPath })
  } catch {
    return false // no usable tier / claude missing / spawn fault — retry next pass
  }
  const n = cards.length
  const list =
    cards
      .slice(0, 3)
      .map((c) => c.branch)
      .join(', ') + (n > 3 ? ` 他${n - 3}件` : '')
  await createSwarmInfoNotification({
    event: 'manager-woke',
    projectPath,
    branch: cards[0]?.branch,
    taskTitle: cards[0]?.title || undefined,
    detail: `review に ${n} 件の統合待ち — マネージャーを起こしました。統合を判断してください (${list})`,
  }).catch(() => {})
  return true
}

/** The desk this project's commander is sitting at, across BOTH pools — the record's
 *  desk when the session store still names one, else the pool's orphan. The SAME
 *  resolution `defaultNudgeManager` uses, so "who do we recycle" can never disagree
 *  with "who did we just fail to poke". Null ⇒ no desk we can name. Never throws. */
const resolveManagerDeskHandle = async (projectPath: string): Promise<ManagerDeskHandle | null> => {
  const rec = (await readSwarmSessions(projectPath)).manager
  const named = rec ? managerDeskForSession(rec.sessionId, projectPath) : null
  return named ?? listManagerDesks(projectPath)[0] ?? null
}

/** {@link IntegrationDeps.managerDeskRuntime} — which runtime carries the desk.
 *  NEVER throws: an unreadable session store / torn pool ⇒ null ⇒ the caller does not
 *  recycle anything (the conservative direction: doing nothing to a desk we cannot see). */
const defaultManagerDeskRuntime = async (projectPath: string): Promise<ManagerRuntimeKind | null> => {
  try {
    return (await resolveManagerDeskHandle(projectPath))?.runtime ?? null
  } catch {
    return null
  }
}

/** {@link IntegrationDeps.recycleManagerDesk} — close an unresponsive SDK commander desk.
 *
 *  ⚠ THE PTY REFUSAL IS RE-CHECKED HERE, not just at the call site. The caller already
 *  gates on {@link defaultManagerDeskRuntime} saying `'sdk'`, and this repeats the test
 *  against the handle it is about to terminate: the two reads are separated by an await,
 *  the pools change underneath (a desk can die and the owner's own PTY commander can take
 *  its place between them), and the cost of getting it wrong is asymmetric — killing an
 *  SDK desk loses a resumable conversation, killing a PTY desk takes the terminal out from
 *  under the owner in their own cwd. A gate whose only copy lives in the caller is a gate
 *  one refactor away from being gone.
 *
 *  Returns true iff a live desk was actually asked to stop. `terminateSdkSession` is
 *  synchronous-and-idempotent (it flips `closed`/`status` at once and lets the pump
 *  unwind), so the absent-arm's next pass sees the desk go and seats a fresh one through
 *  the ordinary wake path — no second spawn road. */
const defaultRecycleManagerDesk = async (projectPath: string): Promise<boolean> => {
  const desk = await resolveManagerDeskHandle(projectPath)
  if (!desk || desk.runtime !== 'sdk') return false
  return terminateSdkSession(desk.handleId)
}

// --- git + heartbeat probes (the monitor's read-only signals) ----------------

const GIT_OPTS = {
  timeout: 15_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}

/** Run git in `cwd`; trimmed stdout, or null on any failure (no git, not a repo,
 *  bad ref, …). */
const gitOut = async (cwd: string, args: string[]): Promise<string | null> => {
  if (!isGitRepoRoot(cwd)) return null // gitRepoGuard: never spawn git in a non-repo/vanishing cwd
  try {
    const { stdout } = await execFile('git', args, { cwd, ...GIT_OPTS })
    return stdout.trim()
  } catch {
    return null
  }
}

/** git for the ONE call that must locate the repo root from a path possibly
 *  BELOW it (`rev-parse --git-common-dir`). Gated on {@link isUnderGitRepo}
 *  rather than the root check — see swarmRepoKey. Nothing else may use it. */
const gitAllowingRepoWalk = async (cwd: string, args: string[]): Promise<string | null> => {
  if (!isUnderGitRepo(cwd)) return null
  try {
    const { stdout } = await execFile('git', args, { cwd, ...GIT_OPTS })
    return stdout.trim()
  } catch {
    return null
  }
}

/** Trunk refs a `swarm/*` branch is measured against, most- to least-preferred,
 *  RESOLVED for THIS project rather than hardcoded to origin/main. `resolveTarget`
 *  is the SAME trunk resolver the integrate stage uses (an explicit override, else
 *  origin/HEAD's symbolic target, else 'main'), so a non-main default branch — a
 *  `master` repo, or origin/HEAD → origin/release — is measured against ITS trunk.
 *  Remote-tracking ref first (`origin/<trunk>` — the push target the integrate
 *  stage lands on), then the local branch as the offline fallback. [] when no
 *  trunk name resolves (⇒ caller counts 0: no provable base, no promotion).
 *
 *  WHY this had to change: workers branch off the best of swarmWorker's
 *  ['origin/main','main','HEAD'] preference, so in a `master` repo they fork off
 *  HEAD (the master tip) — but the old hardcoded ['origin/main','main'] resolved
 *  NEITHER, so countCommitsAhead returned 0, classifyWorker saw hasWork=false, and
 *  a COMMITTED worker was never promoted to review (card stuck in doing →
 *  stall/runaway recovery → re-dispatch → forever). resolveTarget aligns the
 *  promote gate with the integrate gate, which already handled non-main trunks. */
const commitBasePreference = async (projectPath: string): Promise<string[]> => {
  const target = await resolveTarget(projectPath)
  return target ? [`origin/${target}`, target] : []
}

/** Count commits the worker's branch carries ahead of trunk. Uses the shared
 *  repo + branch ref (not the worktree path), so it still works after the
 *  worktree is removed. The trunk is RESOLVED per-project ({@link commitBasePreference}),
 *  not a hardcoded origin/main, so a committed worker in a non-main-default repo
 *  (master, …) is seen as ahead and promoted — matching how the integrate stage
 *  already resolves the trunk.
 *
 *  ⚠ `null` MEANS "COULD NOT ANSWER", AND IT IS NOT ZERO (2026-08-04).
 *  This used to fold three different facts into the number 0: the branch really
 *  has no commits, no trunk ref resolved, and git failed or timed out. That is
 *  harmless for the promote gate — 0 only withholds a promotion — but a second
 *  consumer arrived later with the OPPOSITE polarity: `recoveryColumn` reads
 *  `commitsAhead > 0` as "there is work here, park the card", so for IT a 0 means
 *  "safe to requeue onto a fresh branch". A repo whose trunk is neither
 *  `origin/main` nor `main` (a `git init` repo on `master`, a hand-added remote
 *  with no origin/HEAD) answered 0 for EVERY worker on EVERY pass — so a worker
 *  that committed and then crashed had its card requeued, the next dispatch minted
 *  a fresh swarm/* branch over `card.branch`, and the commits became reachable only
 *  by `git branch --list`. Nothing told the owner; the work was simply redone.
 *  A transient git failure under load produces the same result on one pass.
 *
 *  So the two answers are now distinguishable, and every caller states which way
 *  it wants "unknown" to fall. */
const defaultCountCommitsAhead = async (
  projectPath: string,
  branch: string,
): Promise<number | null> => {
  if (!branch) return 0 // no branch at all: genuinely nothing, not a failed read
  const bases = await commitBasePreference(projectPath)
  if (bases.length === 0) return null // no trunk name resolved — cannot measure
  for (const base of bases) {
    if ((await gitOut(projectPath, ['rev-parse', '--verify', '--quiet', base])) === null) continue
    const out = await gitOut(projectPath, ['rev-list', '--count', `${base}..${branch}`])
    if (out === null) return null // branch ref missing / git error ⇒ NOT a zero
    const n = Number.parseInt(out, 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  return null // every candidate trunk ref failed to verify
}

/** Repo-key cache (projectPath → swarm heartbeat dir key). The key is stable for
 *  a repo, so derive it once. Mirrors swarm-beat.sh's `_repokey`:
 *  `<basename(repoRoot)>-<sha1(realpath(.git))[:8]>`, with space/slash folded to
 *  underscore — so the path the in-app worker writes (from its worktree, whose
 *  --git-common-dir resolves to THIS repo's .git) is the one we read. */
const heartbeatKeyCache = new Map<string, string>()

const swarmRepoKey = async (projectPath: string): Promise<string | null> => {
  const cached = heartbeatKeyCache.get(projectPath)
  if (cached) return cached
  // NOT gitOut: its isGitRepoRoot gate is correct everywhere else, but this call
  // exists to walk UPWARD to the repo root, so a project registered as a
  // sub-directory of a repo returned null — losing the whole per-repo state dir
  // (heartbeats / roster.json / manager.json). isUnderGitRepo allows the walk and
  // still refuses a vanished cwd (the 07 章 §7 wedge). Mirror of swarmJanitor's
  // gitAllowingRepoWalk — the two keys MUST agree or the writer and the reader
  // look in different directories.
  if (!isUnderGitRepo(projectPath)) return null
  const commonDir = await gitAllowingRepoWalk(projectPath, ['rev-parse', '--git-common-dir'])
  if (commonDir === null) return null
  // Absolutize (it's repo-relative from the main checkout) + resolve symlinks,
  // exactly like swarm-beat's `cd "$cdir" && pwd -P`.
  let abs: string
  try {
    abs = await canonicalize(resolve(projectPath, commonDir))
  } catch {
    return null
  }
  const h = createHash('sha1').update(abs).digest('hex').slice(0, 8)
  const base = basename(dirname(abs)).replace(/[ /]/g, '_')
  const key = `${base}-${h}`
  heartbeatKeyCache.set(projectPath, key)
  return key
}

/** Read the worker's heartbeat completion sign (written by `swarm-beat.sh`, which
 *  the /order skill has the worker call). null when absent/unreadable — the
 *  monitor then leans on the PTY-exit signal instead. */
const defaultReadHeartbeat = async (
  projectPath: string,
  branch: string,
): Promise<HeartbeatSign | null> => {
  const key = await swarmRepoKey(projectPath)
  if (!key) return null
  const file = join(openGroundHome(), 'swarm', key, `${branch.replace(/\//g, '-')}.json`)
  try {
    const j = JSON.parse(await readFile(file, 'utf8')) as {
      readyToMerge?: unknown
      phase?: unknown
      blockers?: unknown
      task?: unknown
      updatedAt?: unknown
    }
    const ready = j.readyToMerge === true
    const phase = typeof j.phase === 'string' ? j.phase : ''
    const blockers = typeof j.blockers === 'string' ? j.blockers.trim() : ''
    // Display-only passthrough (条件3): the worker's one-line summary (`task`) and
    // its heartbeat freshness (`updatedAt`). Trimmed; omitted when empty so the
    // worker row falls back to its coarse stage instead of a blank phase.
    const note = typeof j.task === 'string' ? j.task.trim() : ''
    const at = typeof j.updatedAt === 'string' ? j.updatedAt : ''
    return {
      // blocked judgement UNCHANGED — same `phase === 'blocked' || blockers` rule.
      ready,
      blocked: !ready && (phase === 'blocked' || blockers.length > 0),
      // Carry the raw blockers TEXT (not just the boolean) so the overseer's S4 can
      // read the actual question a blocked worker is stuck on. Omitted when empty.
      ...(blockers ? { blockers } : {}),
      ...(phase ? { phase } : {}),
      ...(note ? { note } : {}),
      ...(at ? { at } : {}),
    }
  } catch {
    return null
  }
}

/** Does the worker's isolated `swarm/*` worktree dir still exist? Derived from
 *  the branch the SAME way swarmWorker mints it (central worktrees dir +
 *  swarmWorktreeDirName) — so detectAnomalies can spot a tree deleted out from
 *  under a still-counted worker. false on any error (missing uuid, stat fail) —
 *  conservative, since the anomaly check only WARNS, never mutates. */
/** {@link AnomalyDeps.deskOccupies} — resolve the branch's worktree the same way
 *  {@link defaultWorktreeExists} does, then ask BOTH desk pools whether anything
 *  is live in it. Any failure answers TRUE (occupied): see the dep's doc for why
 *  the unknown direction is "somebody is there". */
const defaultDeskOccupies = async (projectPath: string, branch: string): Promise<boolean> => {
  if (!branch) return true
  try {
    const uuid = await projectUUIDFromPath(projectPath)
    const dir = join(centralWorktreesDir(uuid), swarmWorktreeDirName(branch))
    return await liveDeskOccupies(dir)
  } catch {
    return true
  }
}

const defaultWorktreeExists = async (projectPath: string, branch: string): Promise<boolean> => {
  if (!branch) return false
  // Resolve the worktree dir from the branch (same mint as createSwarmWorktree).
  // A PROJECT-level failure here (e.g. a transient registry-unreadable race in
  // projectUUIDFromPath) is NOT per-branch evidence the tree is gone — returning
  // false would burst-flag EVERY worker + doing card as missing at once. Treat it
  // as "can't tell → assume present" (conservative: the anomaly check only warns,
  // and a genuinely-missing tree still surfaces once the registry settles).
  let dir: string
  try {
    const uuid = await projectUUIDFromPath(projectPath)
    dir = join(centralWorktreesDir(uuid), swarmWorktreeDirName(branch))
  } catch {
    return true
  }
  // BRANCH-level: now a stat miss (ENOENT) genuinely means this tree is gone.
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** Real spawn: preflight `claude` FIRST so a missing/signed-out CLI fails the
 *  dispatch loudly (the pass logs it) instead of orphaning a worktree + opening
 *  its own OAuth browser. Then the normal worktree + claude PTY + /order spawn. */
const defaultSpawnWorker = async (opts: {
  projectPath: string
  title: string
  notes?: string
  hint?: string
  priorFailure?: string
  // card 4 — carried straight through to spawnSwarmWorker (the RESTART worktree +
  // `--resume` path). preflight + guard wiring still run for a resume, so no bypass.
  worktree?: string
  resumeSessionId?: string
}): Promise<SpawnSwarmWorkerResponse> => {
  const pre = await claudeRunPreflight()
  if (!pre.ok) throw new Error(pre.body.error || 'claude not ready')
  return spawnSwarmWorker(opts)
}

// ── SDK spawn-failure backoff (SDK-only workers, 2026-08-13) ────────────────
// The PTY fallback used to absorb a broken SDK environment silently; with it
// deleted, a persistent failure (signed-out CLI, too-old CLI, unarmed guard)
// would otherwise burn a spawn attempt — and a fresh worktree+branch rollback —
// every 3s tick, invisibly. fail-fast means: hold NEW dispatch on a ladder
// (1m → 5m → 15m), tell the owner ONCE (bell + OS toast, re-notified hourly at
// most), and recover by ITSELF on the first successful spawn after the cause is
// fixed. Monitor / promote / reclaim are untouched by the hold — only the fill
// stage skips.
const SDK_SPAWN_HOLD_LADDER_MS = [60_000, 300_000, 900_000] as const
const SDK_SPAWN_NOTIFY_THROTTLE_MS = 60 * 60_000

const holdSdkSpawn = async (engine: ProjectEngine, reason: string, now: number): Promise<void> => {
  const prev = engine.sdkSpawnHold
  const failures = (prev?.failures ?? 0) + 1
  const step =
    SDK_SPAWN_HOLD_LADDER_MS[Math.min(failures - 1, SDK_SPAWN_HOLD_LADDER_MS.length - 1)]
  const renotify =
    !prev || prev.reason !== reason || now - prev.notifiedAt >= SDK_SPAWN_NOTIFY_THROTTLE_MS
  engine.sdkSpawnHold = {
    until: now + step,
    failures,
    reason,
    notifiedAt: renotify ? now : (prev as NonNullable<typeof prev>).notifiedAt,
  }
  logLine(
    engine,
    'warn',
    `worker spawn failed (SDK) — holding new dispatch for ${Math.round(step / 60_000)}m (attempt ${failures}): ${reason}`,
  )
  if (renotify) {
    // Awaited so a test can read the store right after the pass; the catch keeps
    // a notification-store fault from ever disturbing the pass itself.
    await createSwarmFatalNotification({
      event: 'worker-spawn-failed',
      detail: `worker を起動できません: ${reason}`,
      projectPath: engine.path,
      logHint:
        'claude へのサインインし直し(または CLI の更新)で直ることが多いです。原因が解消すれば自動で再開します — 再操作は不要。',
    }).catch(() => {})
  }
}

// (isWorkerAlive / defaultLastOutputAt / defaultNudge lived here until 2026-07-30.
//  Their bodies moved VERBATIM into workerRuntime.ptyWorkerRuntime so the engine
//  asks the runtime instead of the PTY pool — see docs/SDK_WORKER_MIGRATION_PLAN.md.)

/** Move a lost/stopped worker's card to a recovery column through the project's
 *  own Board HTTP API (the same write seam as the dispatch/promotion moves —
 *  CAS-protected, shared-mode transparent). 'todo' requeues; 'blocked' parks. */
const defaultRecoverCard = async (
  projectPath: string,
  taskId: string,
  column: 'todo' | 'blocked',
): Promise<boolean> => {
  const res = await fetch(`${loopbackOrigin()}/api/project/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: projectPath, setColumn: [{ id: taskId, column }] }),
    signal: AbortSignal.timeout(15_000),
  })
  return res.ok
}

/** Resolve where a todo card's work already lives (quota re-entry). Failure is
 *  `null`, never a throw: a card we cannot re-enter simply dispatches fresh. */
const defaultResolveReusableWork = async (
  projectPath: string,
  card: ProjectTask,
): Promise<ReusableWork | null> => {
  const branch = typeof card.branch === 'string' ? card.branch.trim() : ''
  if (!branch || !isSwarmBranch(branch)) return null
  return ensureSwarmWorktreeForBranch(projectPath, branch)
}

/** Park a card in 'blocked' AND stamp it 「見送る」 in ONE board write. */
const defaultMarkAbandoned = async (projectPath: string, taskId: string): Promise<boolean> => {
  const res = await fetch(`${loopbackOrigin()}/api/project/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      path: projectPath,
      setColumn: [{ id: taskId, column: 'blocked', abandoned: true }],
    }),
    signal: AbortSignal.timeout(15_000),
  })
  return res.ok
}

/** The outcome of the pre-teardown WIP commit ({@link commitWipBeforeTeardown}). */
export interface WipCommitResult {
  /** A WIP commit LANDED on the worker's branch (there was work to save). */
  committed: boolean
  /** There WAS (or might have been) uncommitted work and we could NOT commit it.
   *  The caller must then KEEP the worktree: it holds the only copy left. */
  failed?: boolean
  /** Detail for the log (short sha on success, the git failure otherwise). */
  reason?: string
  /** The branch the salvage commit landed ON — present only when `committed`.
   *  Proof that the commit is REACHABLE (a detached-HEAD commit is not, and is
   *  reported as `failed` instead — see commitWipBeforeTeardown), and what lets
   *  the caller count it toward the branch's commits-ahead before deciding the
   *  card's recovery column. */
  branch?: string
}

/** COMMIT whatever a reclaimed worker left UNCOMMITTED, onto its own `swarm/*`
 *  branch, BEFORE the worktree is force-removed.
 *
 *  THE 2026-07-12 LOSS: a worker was reclaimed at the execution-time ceiling with
 *  its implementation finished but not yet committed (worker discipline told it to
 *  commit AFTER the completion gate, and the gate was still running) — teardown
 *  force-removed the worktree and 15 files / 47KB of finished work ceased to
 *  exist. `--force` is required (a mid-implementation tree is dirty by
 *  definition), so the ONLY defense is to commit first. Every reclaim path
 *  (runaway / stall / crash / rate-limit / permission / question / owner-stop)
 *  routes through here.
 *
 *  Contract:
 *   • clean tree (or no worktree on disk) ⇒ NO-OP, `{committed:false}` — teardown
 *     proceeds exactly as before.
 *   • dirty ⇒ `git add -A` + a WIP commit NAMING THE RECLAIM REASON, so
 *     `git log <branch>` explains itself and the commander can pick the work up.
 *   • anything git refuses ⇒ `{failed:true}` — the caller KEEPS the worktree
 *     rather than destroy the only copy of the work. Losing a worktree slot is
 *     recoverable; losing the work is not.
 *
 *  The commit is deliberately UNVERIFIED (`--no-verify`, no tsc/test): this is a
 *  salvage, not a promotion. The branch's commits still face the ordinary verify +
 *  review gates before anything integrates, and the message says so.
 *
 *  node_modules: the worktree carries a SYMLINK to the repo's real node_modules
 *  (swarmWorker seeds it). Under the common `node_modules/` (trailing-slash)
 *  ignore pattern that symlink reads as UNTRACKED — `git add -A` would commit the
 *  pointer. Unlink it first (removeSwarmWorktree does the same before its own
 *  removal, and unlinking a symlink never touches the real modules it targets).
 *
 *  Never throws — gitOut swallows every git failure into null. */
export const commitWipBeforeTeardown = async (
  worktree: string,
  reason: TeardownReason,
): Promise<WipCommitResult> => {
  if (!worktree) return { committed: false }
  // Gone already (a pruned/never-created tree) ⇒ nothing to save; let teardown run
  // its idempotent course. NOT a failure — the caller must not keep a ghost.
  if (!(await stat(worktree).then(() => true).catch(() => false))) return { committed: false }

  // Drop the node_modules symlink so `git add -A` can never stage it (see above).
  try {
    const nm = join(worktree, 'node_modules')
    if ((await lstat(nm)).isSymbolicLink()) await unlink(nm)
  } catch {
    /* no symlink / already gone — best effort */
  }

  const status = await gitOut(worktree, ['status', '--porcelain'])
  // Status unavailable ⇒ we cannot PROVE the tree is clean. Fail CLOSED (keep the
  // worktree): the whole point of this function is that unproven-clean must never
  // be destroyed. A genuinely broken tree surfaces as a kept worktree in the log.
  if (status === null) return { committed: false, failed: true, reason: 'git status unavailable' }
  if (status === '') return { committed: false } // clean — no-op, teardown proceeds

  if ((await gitOut(worktree, ['add', '-A'])) === null) {
    return { committed: false, failed: true, reason: 'git add failed' }
  }

  const subject = `WIP: swarm reclaim auto-save (${reason})`
  const body =
    `The engine reclaimed this worker (reason: ${reason}) while its worktree still held ` +
    `uncommitted work, and committed it here so the teardown could not destroy it. ` +
    `NOTHING HERE IS VERIFIED — review, amend or drop this commit before integrating.`
  const bodyJa =
    `回収理由: ${reason} — worktree 削除の前に未コミットの作業を自動保全したコミット` +
    `(完了ゲート未通過。統合前に必ずレビューすること)。`
  const args = ['commit', '--no-verify', '-m', subject, '-m', body, '-m', bodyJa]

  let out = await gitOut(worktree, args)
  if (out === null) {
    // Most likely cause: no committer identity resolvable in this environment
    // (a stripped-env fork, a fresh CI box). Retry ONCE under a swarm identity —
    // a salvage commit under a synthetic author beats losing the work. Any other
    // failure just fails again here and is reported.
    out = await gitOut(worktree, [
      '-c',
      'user.name=OPEN GROUND swarm',
      '-c',
      'user.email=swarm@openground.local',
      ...args,
    ])
  }
  if (out === null) return { committed: false, failed: true, reason: 'git commit failed' }

  // A COMMIT IS NOT A RESCUE UNLESS A BRANCH CAN REACH IT (2026-07-29).
  //
  // `git commit` succeeding proves the objects were written — not that anything
  // will still point at them a second later. On a DETACHED HEAD (a worker
  // interrupted mid-rebase, mid-bisect, or on an explicit `git checkout <sha>`)
  // the commit lands on no branch at all, and the caller's very next act is
  // `git worktree remove --force`, which drops the only reference. The work is
  // then unreachable — recoverable in principle from the reflog of a directory
  // that no longer exists, i.e. not recoverable. And because we returned
  // `committed:true`, the caller believed the salvage had WORKED and tore the
  // tree down with confidence. That is worse than not trying: this function's
  // entire contract (02 章 §6 — "no reclaim, for ANY reason, may destroy
  // uncommitted work again") was reporting success while doing the destroying.
  //
  // So: report success only when HEAD is attached to a branch that now contains
  // the commit. Otherwise fail CLOSED — `failed:true` keeps the worktree, and the
  // work survives in a directory a human can still open.
  const branchRef = await gitOut(worktree, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (branchRef === null || !branchRef.trim()) {
    return {
      committed: false,
      failed: true,
      reason:
        'detached HEAD — the salvage commit is on no branch and would be unreachable after teardown',
    }
  }

  const sha = await gitOut(worktree, ['rev-parse', '--short', 'HEAD'])
  return { committed: true, branch: branchRef.trim(), reason: sha ?? undefined }
}

/** Tear down a lost/stopped worker's worktree + PTY. Kills the PTY by id FIRST
 *  (covers the symlinked-home cwd-miss that removeSwarmWorktree's by-cwd kill can
 *  drop), then — CRITICALLY — commits any uncommitted work to the worker's branch
 *  ({@link commitWipBeforeTeardown}) before force-removing the worktree (which
 *  also kills any PTY by cwd and is idempotent — already-gone reads as removed).
 *  If that salvage commit FAILS the worktree is KEPT, not destroyed: the work in
 *  it is unrecoverable, a leftover worktree is not. Branch is intentionally KEPT
 *  (see the dep doc). Never throws — a failure is reported for the log. */
/** Wait (bounded) for a terminated SDK session to actually stop being alive —
 *  the SDK counterpart of `waitForTerminalGone`, and needed for the same reason:
 *  `terminateSdkSession` only ASKS (it interrupts the current turn and lets the
 *  pump unwind), so salvaging the worktree immediately after would snapshot a
 *  tree claude is still writing to, and run our git against the index its git is
 *  still using. On timeout we proceed anyway — losing the WIP salvage entirely is
 *  worse than snapshotting a possibly-torn tree (the same trade the PTY wait makes). */
export const waitForSdkSessionGone = async (
  sdkSessionId: string,
  /** "Has the pump actually unwound?" — NOT `isSdkSessionAlive`.
   *
   *  ⚠ THE BUG THIS PARAMETER'S DEFAULT FIXES (2026-07-31). It used to default
   *  to `isSdkSessionAlive`, which reads `status`. `terminateSdkSession` sets
   *  `status:'exited'` SYNCHRONOUSLY — it only ASKS the session to stop, the
   *  `interrupt()` behind it being fire-and-forget — so the very first poll saw
   *  "not alive" and this returned in 0 ms. The gate existed and gated nothing:
   *  the salvage below still started while claude was writing, which is the pair
   *  of harms (torn snapshot, two gits on one index) the PTY path grew
   *  `waitForTerminalGone` for. `reaped` is set only by the pump's `finally`,
   *  i.e. once the SDK's iterator has genuinely returned. */
  reaped: (id: string) => boolean = isSdkSessionReaped,
  opts: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> => {
  const timeoutMs = opts.timeoutMs ?? 5_000
  const pollMs = opts.pollMs ?? 50
  const nap = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (reaped(sdkSessionId)) return true
    await nap(pollMs)
  }
  return reaped(sdkSessionId)
}

export const defaultRecoverWorker = async (
  opts: {
    projectPath: string
    worktree: string
    terminalId: string
    reason?: TeardownReason
    /** TRUE when an EARLIER pass already ran this teardown for the same worker (its
     *  Board write was kept, so the recovery is being retried). The PTY was killed
     *  back then, so whatever exit it now reports is OUR OWN kill — recording it
     *  would fabricate a cause of death. See the exitInfo gate below. */
    alreadyTornDown?: boolean
    /** The SDK session id, when this worker runs on the Agent SDK runtime.
     *
     *  ⚠ WITHOUT THIS, THE WHOLE TEARDOWN IS A NO-OP THAT STILL DELETES.
     *  An SDK worker's `terminalId` is EMPTY by the identity invariant
     *  (pty ⇔ terminalId, sdk ⇔ sdkSessionId), so every PTY step below —
     *  read, kill, wait-for-gone — silently did nothing for one, and the
     *  function went straight on to `git add -A` and remove the worktree WHILE
     *  CLAUDE WAS STILL WRITING INTO IT. That is precisely the pair of harms the
     *  "kill FIRST, then salvage" comment below was added to prevent (a torn
     *  snapshot; our git racing the worker's git on one index) — reintroduced by
     *  a second runtime the code did not know to stop. */
    sdkSessionId?: string
  },
  // Terminal-pool seam, injected the same way defaultNudgeManager takes its
  // write/sleep: it makes the exitInfo gate unit-testable without a real PTY
  // (pass `worktree: ''` and the function returns right after computing it).
  termDeps?: {
    getTerminal?: typeof getTerminal
    killTerminal?: typeof killTerminal
    /** SDK counterparts, injected for the same reason. */
    terminateSdk?: typeof terminateSdkSession
    isSdkReaped?: typeof isSdkSessionReaped
  },
): Promise<{
  removed: boolean
  reason?: string
  wip?: WipCommitResult
  exitInfo?: { code: number | null; signal?: number }
}> => {
  const readTerminal = termDeps?.getTerminal ?? getTerminal
  const endTerminal = termDeps?.killTerminal ?? killTerminal
  const endSdk = termDeps?.terminateSdk ?? terminateSdkSession
  const sdkReaped = termDeps?.isSdkReaped ?? isSdkSessionReaped
  const sdkId = opts.sdkSessionId ?? ''
  // Read BEFORE killTerminal — a PTY that is still alive has no exitCode yet, and
  // one we are about to kill ourselves must not have ITS exit mistaken for the
  // reason it died. Only meaningful for a reclaim of an ALREADY-dead worker
  // ('crash', the default): for every other reason (stall/runaway/stopped/…) WE
  // are the one about to kill it, so there is no "cause of death" to record yet.
  //
  // ⚠ `reason === 'crash'` ALONE IS NOT ENOUGH (2026-07-27 review). When a
  // reclaim's Board write is kept, the retry one pass later (TICK_MS = 3s)
  // rebuilds the recovery with a 'recover' intent, which maps back to reason
  // 'crash' — while the PTY is still in the pool's post-exit linger window,
  // carrying the exit of the SIGHUP *we* sent during the first pass. A stall
  // reclaim would then journal that kill (measured: `exitCode=1` under the
  // production framing — the login shell catches SIGHUP and exits itself) as the
  // worker's own cause of
  // death. `alreadyTornDown` is the caller's answer to "did we already kill this
  // one?", and it vetoes the record outright.
  // An SDK worker has no PTY and therefore no exit CODE — its cause of death
  // arrives as events on its own stream (api_error / quota_refusal, sdkEvents),
  // which is the whole point of the runtime. Reading the PTY pool with an empty
  // id would return undefined and be journalled as `{code:null}` = "it died and
  // we don't know why", inventing an unknown where a known answer exists.
  const preKill = sdkId ? undefined : readTerminal(opts.terminalId)
  const isCrashReclaim =
    !sdkId && (opts.reason ?? 'crash') === 'crash' && !opts.alreadyTornDown
  const exitInfo = !isCrashReclaim
    ? undefined
    : preKill?.finishedAt
      ? {
          code: preKill.exitCode ?? null,
          // Only a REAL signal is a signal (measured: node-pty reports signal 0 —
          // not undefined — for every voluntary exit, so an `!== undefined` test
          // would stamp `signal=0` on every clean line and say nothing).
          ...(typeof preKill.exitSignal === 'number' && preKill.exitSignal > 0
            ? { signal: preKill.exitSignal }
            : {}),
        }
      // The PTY session is gone entirely (its post-exit delete timer fired before
      // this reclaim got to it) — it died, but its exit code went with it. This is
      // the 'unknown' case classifyWorkerExit exists for.
      : { code: null }
  try {
    // Stop the worker on WHICHEVER runtime carries it. Branch on the id we were
    // given, matching the identity invariant — never on "is terminalId truthy",
    // which is how a runtime gets forgotten.
    if (sdkId) endSdk(sdkId)
    else endTerminal(opts.terminalId)
  } catch {
    /* already dead / absent — the worktree teardown below is what matters */
  }
  if (!opts.worktree) return { removed: false, reason: 'no worktree path on record', exitInfo }
  // Kill FIRST, then salvage: a dead PTY can't keep writing into the tree we are
  // about to snapshot.
  //
  // …but the kill above only SENDS a signal (node-pty returns immediately; the
  // exit is stamped later by an async handler), so "then salvage" used to start
  // while claude was still running (2026-07-29). Two concrete harms: the
  // `git add -A` snapshot captures a half-written tree, and our git runs against
  // the same index as the git calls claude is still making (index.lock
  // contention). Wait for the process to actually leave the table — that is also
  // the evidence the kernel delivered its hangup to claude, which is what makes
  // the tree quiescent. Bounded; on timeout we proceed anyway, because losing the
  // WIP salvage entirely is worse than snapshotting a possibly-torn tree.
  if (sdkId) await waitForSdkSessionGone(sdkId, sdkReaped).catch(() => false)
  else await waitForTerminalGone(opts.terminalId).catch(() => false)
  let wip: WipCommitResult = { committed: false }
  try {
    wip = await commitWipBeforeTeardown(opts.worktree, opts.reason ?? 'stopped')
  } catch (e) {
    wip = { committed: false, failed: true, reason: errMsg(e) }
  }
  if (wip.failed) {
    return {
      removed: false,
      reason: `uncommitted work could not be saved (${wip.reason ?? '?'}) — worktree kept`,
      wip,
      exitInfo,
    }
  }
  try {
    const res = await removeSwarmWorktree(opts.projectPath, opts.worktree, { force: true })
    return { ...res, wip, exitInfo }
  } catch (e) {
    return { removed: false, reason: errMsg(e), wip, exitInfo }
  }
}

/** The stall ESCALATION — tried once after the cheap nudge budget is spent and
 *  the worker is STILL silent: a short instruction (naming the card so the
 *  worker knows which goal to resume) delivered as a turn via the runtime seam.
 *
 *  ⚠ SHRUNK 2026-08-13 with the PTY worker runtime. The PTY arm was an
 *  ESC → settle ({@link STALL_ESCALATE_DELAY_MS}) → line+CR dance over the raw
 *  PTY write path, with a control-byte strip (ESCALATE_CONTROL_BYTES) guarding
 *  the card-derived title on that raw, auto-submitting conduit. An SDK worker
 *  has no half-typed line to dismiss and no CR to submit — the message IS the
 *  turn — so the dance and the strip died with the runtime that needed them
 *  (`say` delivers over the SDK protocol, where a control byte is inert text).
 *  A legacy PTY roster row reaches `say` on the dead PTY adapter and simply
 *  reports false — its recovery is the reclaim ladder, not the escalation. */
export const defaultEscalate = async (w: WorkerHandle, taskTitle: string): Promise<boolean> => {
  const safeTitle = taskTitle.replace(/\s+/g, ' ').trim()
  const line = `続けてください。${safeTitle} のゴールを続行。完了条件: 実装+テスト緑+コミット。`
  return runtimeOf(w).say(w, line)
}

/** The worker's current recent output, or null — the source classifyOutput
 *  inspects for a free-text question. Read-only. Routed through workerRuntime
 *  so the meaning of "recent output" follows HOW the worker runs. */
const defaultRecentOutput = (w: WorkerHandle): string | null => runtimeOf(w).recentOutput(w)

// (defaultInstructRework lived here until 2026-08-01. It wrote a one-line 差し戻し
//  instruction to a worker's PTY — `writeInput(terminalId, …)` — and had had NO
//  caller since 675968e5 deleted reworkOrPark with the engine's whole integration
//  path (manager-only rework, 2026-07-15). It is deleted rather than left lying
//  around because its terminalId-keyed shape is a trap under two runtimes: an SDK
//  worker's terminalId is '', so the next person to wire it up would have written
//  every SDK worker's 差し戻し into nothing. See OrchestratorDeps.instructRework's
//  @deprecated note for the full route trace and the correct shape.)

// --- Default integration deps (Card③) -----------------------------------------

const defaultFetchReview = async (projectPath: string): Promise<ProjectTask[]> => {
  const res = await fetch(
    `${loopbackOrigin()}/api/project?path=${encodeURIComponent(projectPath)}`,
    { signal: AbortSignal.timeout(15_000) },
  )
  if (!res.ok) throw new Error(`board read HTTP ${res.status}`)
  const data = (await res.json()) as ProjectData
  return (data.tasks ?? []).filter(isReviewCard)
}

/** Resolve the trunk name + one best-effort fetch so the ancestry/push checks
 *  run against the freshest remote-tracking ref. Returns the name even if the
 *  remote ref turns out missing — classify/integrate then degrade safely. */
const defaultPrepareTarget = async (projectPath: string): Promise<string | null> => {
  const target = await resolveTarget(projectPath)
  if (!target) return null
  await fetchTarget(projectPath, target)
  return target
}

/** Land a branch via swarmIntegrate, with the throwaway rebase worktree placed
 *  under the project's CENTRAL worktrees dir (inside validateProjectPath's
 *  boundary, auto-swept by the worktree cleaner). The dir name is engine-minted
 *  (randomUUID) — never user input. */
const defaultIntegrate = async (
  projectPath: string,
  branch: string,
  target: string,
): Promise<IntegrateOutcome> => {
  const uuid = await projectUUIDFromPath(projectPath)
  const integrateDir = join(centralWorktreesDir(uuid), `.integrate-${randomUUID().replace(/-/g, '').slice(0, 12)}`)
  return integrateBranch(projectPath, branch, { target, integrateDir })
}

// --- Verification gate (Card③ pre-merge) --------------------------------------

/** What it MEANS to verify a prepared (rebased-onto-trunk) worktree. Split from
 *  the worktree mechanics (makeVerify) so the gate is tested end-to-end with a
 *  fake verdict, and so a non-verifiable project is recognised CHEAPLY (no
 *  worktree) via `applicable`. The default is a tsc type-check. */
export interface VerifyCheck {
  /** Cheap predicate: can this project be meaningfully verified at all? false ⇒
   *  the gate passes WITHOUT building a worktree (never block work we can't
   *  check). For tsc: a tsconfig.json AND a node_modules to resolve types from. */
  applicable: (projectPath: string) => Promise<boolean>
  /** Run the check inside `worktreeDir` (the branch rebased onto the trunk, with
   *  node_modules symlinked from the main checkout). ok:false ⇒ block the merge;
   *  `output` is the tail surfaced in the log. Never throws (caught → ok:false). */
  run: (worktreeDir: string) => Promise<{ ok: boolean; output: string }>
}

/** A {@link VerifyCheck} paired with the predicate that decides whether THIS
 *  branch's diff makes it relevant. The primary check (tsc) runs for every branch
 *  it applies to; a conditional check runs only when `appliesTo` accepts the
 *  branch's changed-file set — so the swarm-safety suite is skipped for a branch
 *  that doesn't touch swarm code (the goal's condition 3: unrelated work is never
 *  slowed by an extra test run). */
export interface ConditionalCheck {
  /** Short label surfaced in the block reason / log (e.g. 'swarm-safety'). */
  label: string
  /** Relevant to this branch? Decided from the repo-relative paths it changed vs
   *  the trunk merge-base ({@link changedFilesVsTrunk}). */
  appliesTo: (changedFiles: string[]) => boolean
  /** The check run when `appliesTo` accepts (its own `applicable` still gates on the
   *  project actually carrying the fixtures, so a non-OPEN-GROUND repo is unaffected). */
  check: VerifyCheck
}

/** The default check: `tsc --noEmit`. `applicable` is a TS-PROJECT test (a
 *  tsconfig.json) — NOT an environment test — so a non-TS project (the engine can
 *  drive ANY registered repo) is never blocked, but a TS project we genuinely
 *  cannot type-check is NOT waved through: `run` reports RED when the compiler is
 *  absent (no node_modules ⇒ nothing installed). That keeps the gate's promise —
 *  unverified TS never auto-merges — instead of silently passing it. A nonzero tsc
 *  exit (a real type error) is likewise the RED that holds the card back. */
export const tscCheck: VerifyCheck = {
  applicable: async (projectPath) =>
    stat(join(projectPath, 'tsconfig.json'))
      .then(() => true)
      .catch(() => false),
  run: async (worktreeDir) => {
    // makeVerify symlinks node_modules from the main checkout; if the binary is
    // missing the project isn't installed — we CANNOT verify a TS project, so
    // BLOCK (conservative: never auto-merge unverified) rather than pass blindly.
    const tscBin = join(worktreeDir, 'node_modules', '.bin', 'tsc')
    if (!(await stat(tscBin).then(() => true).catch(() => false))) {
      return {
        ok: false,
        output: 'tsc unavailable (no node_modules in the project — run npm install to arm the merge gate)',
      }
    }
    try {
      // withGateEnv: tsc reads the WORKTREE's tsconfig, which can `extends` an
      // arbitrary module from the branch — so this is untrusted code too, and it
      // gets a throwaway OPENGROUND_HOME like every other gate spawn (gateProcess.ts).
      await withGateEnv((env) =>
        execFile(tscBin, ['--noEmit'], {
          cwd: worktreeDir,
          timeout: 180_000,
          maxBuffer: 16 * 1024 * 1024,
          env,
        }),
      )
      return { ok: true, output: '' }
    } catch (e: unknown) {
      const out = `${(e as { stdout?: string })?.stdout ?? ''}\n${(e as { stderr?: string })?.stderr ?? ''}`.trim()
      // tsc prints errors to stdout; keep the LAST lines (the error summary).
      const tail = out ? out.split('\n').filter(Boolean).slice(-6).join(' · ').slice(0, 600) : errMsg(e)
      return { ok: false, output: tail || 'tsc failed' }
    }
  },
}

// ── Swarm self-modification gate (card 34d42890) ──────────────────────────────
// When a branch changes swarm code, the swarm is editing ITSELF — so before it may
// auto-merge, the A1 safety net (swarmSafety.* — invariants A–D, card 8d778645)
// must still be GREEN against the to-be-landed tree. This wires that suite in as a
// diff-gated verify check: it runs ONLY for swarm-touching branches (unrelated work
// stays fast) and a RED suite blocks the merge through the SAME path a RED tsc does
// (review→doing 差し戻し, then 'blocked' after repeated failure — reworkOrPark).
// Full invariant list + code map: docs/SWARM_SAFETY_INVARIANTS.md.

/** Repo-relative path patterns that constitute "swarm code" — the goal's enumerated
 *  set: src/lib/server/swarm*.ts (orchestrator / integrate / worker / janitor / …,
 *  AND the swarmSafety.test.ts net itself), server/routes/swarm.ts (the /api/swarm
 *  surface), server/routes/project.ts (the Board API — the swarm contract's real
 *  surface: workers/manager drive every card verb through it, docs/commander/05),
 *  and src/components/canvas/modules/Swarm* (the UI panes). The anchors are
 *  deliberately tight: `swarm` must sit DIRECTLY under each dir (a nested
 *  `…/sub/swarmX.ts` or a stray `docs/swarm.ts` does NOT match). The route-level
 *  safety net (server/routes/__tests__/swarmSafety.routes.test.ts) is ALSO a trigger:
 *  the unit net (swarmSafety.test.ts) is already caught by the swarm*.ts glob, but the
 *  route net lives outside it — without this, a branch deleting/weakening JUST that
 *  file would never trip the gate. The same reasoning adds the gate-env family
 *  (2026-07-19): `gateProcess.ts` holds the untrusted-child env policy but is not
 *  named `swarm*`, and its tests live in two more places outside every glob above —
 *  so without these entries a branch that gutted the policy, or deleted the tests
 *  that pin it, would touch NO swarm path and the safety gate would never fire.
 *  Membership in {@link SWARM_SAFETY_TESTS} only makes deletion RED once the gate
 *  actually runs; that gate has to be triggered first.
 *  `server/index.ts` (2026-07-22, card 2) is added for the same reason: it's the
 *  ONE place `resumeEngines()` is actually wired in (the `process.send` dev/prod
 *  gate + the boot-time call itself) — none of it lives under `swarm*.ts` or
 *  `server/routes/swarm.ts`, so a future diff that quietly dropped the gate or
 *  the call (re-enabling unattended resume on every `tsx watch` save, or
 *  disabling the crash-loop-guarded resume in prod) would otherwise touch NO
 *  path this set already watches.
 *
 *  ── THE SDK RUNTIME (2026-08-01) ────────────────────────────────────────────
 *  WHAT THIS SET ACTUALLY DECIDES, traced before widening it (there are three
 *  candidates and only two are real): (1) {@link swarmSafetyConditional} — the
 *  A1 safety suite runs as a merge gate ONLY for a branch whose diff matches
 *  here, and (2) the docs/commander freshness soft-warn in {@link makeVerify}.
 *  It does NOT drive the engine self-update / canary rebuild: that fires from an
 *  observed integration event (selfUpdateOnIntegrate.ts — a confirmed non-force
 *  worktree removal whose tip is an ancestor of the trunk), not from a path
 *  match. So a miss here is not "the canary never rebuilds"; it is "swarm code
 *  changed and NOTHING re-proved the swarm's own safety invariants before it
 *  auto-merged". Which is worse, and was the state for the ENTIRE second desk
 *  pool: not one SDK-runtime file matched any pattern above.
 *
 *  THE MEMBERSHIP CRITERION (write this down, because a list of names rots): a
 *  file is swarm code when it can change how a swarm DESK behaves — i.e. it is
 *  one of the two desk pools, a seam that speaks to both, or something that
 *  drives one. Mechanically that is two families, and the patterns below are the
 *  cheap path-shaped approximation of them:
 *    (a) NAMED by convention — `swarm*` / `Swarm*` / `sdk*` / `Sdk*` sitting
 *        DIRECTLY under src/lib/server, server/routes(+__tests__) or
 *        src/components/canvas/modules. PREFIX patterns, deliberately: a new
 *        `sdkFoo.ts` is covered the day it lands, with no list to remember.
 *    (b) IMPORTS a desk-runtime seam — `./sdkSession` (the SDK pool),
 *        `./workerRuntime` (the pty⇔sdk dispatcher) or `./liveDesks` (the
 *        ask-BOTH-pools seam). Everything in (b) is already in (a) except
 *        `worktreeCleanup.ts` (it asks liveDesks whether a worktree is still
 *        under a LIVE desk before deleting it — get that wrong and the engine
 *        rm -rf's a running worker) and `server/routes/terminal.ts` (the PTY
 *        desk surface, and the one route that answers the both-pools desk
 *        query). Those two are named below; the rest of (b) needs no entry.
 *  Family (b) cannot be evaluated from a path string, so it is CHECKED ON DISK
 *  by swarmEngineSdkBlindspots.test.ts, which re-derives both families from the
 *  working tree and fails when a file joins either without being matched here.
 *  That test is the thing that makes this list survive the next SDK file. */
const SWARM_CODE_PATHS: readonly RegExp[] = [
  /^src\/lib\/server\/swarm[^/]*\.ts$/,
  /^server\/routes\/swarm\.ts$/,
  /^server\/routes\/project\.ts$/,
  /^server\/routes\/__tests__\/swarmSafety[^/]*$/,
  /^src\/components\/canvas\/modules\/Swarm[^/]*$/,
  /^src\/lib\/server\/gate(Process|Env)[^/]*$/,
  /^server\/__tests__\/gateEnvParity\.test\.ts$/,
  /^electron\/gateEnv\.js$/,
  /^server\/index\.ts$/,
  // ── family (a): the SDK runtime, by naming convention ──
  /^src\/lib\/server\/sdk[^/]*\.ts$/,
  /^server\/routes\/sdk[^/]*\.ts$/,
  /^server\/routes\/__tests__\/sdk[^/]*$/,
  /^src\/components\/canvas\/modules\/Sdk[^/]*$/,
  // ── the runtime seams + family (b)'s two non-conforming members ──
  // workerRuntime = the pty⇔sdk dispatcher every engine verb goes through;
  // liveDesks = the ONE seam that asks both pools; worktreeCleanup = the
  // destructive consumer of that answer; routes/terminal = the PTY desk surface.
  /^src\/lib\/server\/(workerRuntime|liveDesks|worktreeCleanup)[^/]*\.ts$/,
  /^server\/routes\/terminal\.ts$/,
  // groundLamps.ts joined family (b) 2026-08-15: it asks the liveDesks seam
  // whether anything is actually running for a project, and that answer becomes
  // the Ground card's lamp. A change here that gets the both-pools question
  // wrong does not crash — it tells the owner a working swarm has stalled, or a
  // stalled one is fine. That is a desk-behaviour claim, so it pays like one.
  /^src\/lib\/server\/groundLamps\.ts$/,
  // misc.ts joined family (b) 2026-08-03: GET /api/update/restart-safety calls
  // the liveDesks seam (the Electron shell's "may I restart the app on top of
  // whatever is running?" verdict), so changes here must pay for the
  // swarm-safety suite like every other seam importer.
  /^server\/routes\/misc\.ts$/,
]

/** Does this changed-file set (repo-relative paths) touch any swarm code? Pure — the
 *  cheap gate deciding whether a branch must pay for the swarm-safety suite. */
export const touchesSwarmPaths = (changedFiles: readonly string[]): boolean =>
  changedFiles.some((f) => SWARM_CODE_PATHS.some((re) => re.test(f)))

/** HIGH-RISK paths the engine must NEVER auto-merge (force-hold, 2026-07-15).
 *  MIRRORS the commander's manual-merge rule — skills/og-manage/SKILL.md
 *  §「マージ」手順 0 の高リスク force-hold — and the two lists MUST stay the same
 *  set: the unit test pins BOTH this set's match behavior AND the SKILL.md wording,
 *  so a drift on either side breaks the build (single-definition + sync-test in
 *  place of a shared constant, since the skill is prose). A branch whose diff vs
 *  the trunk touches ANY of these is withheld from auto-integration: the card
 *  stays in 'review' with a 'high-risk-hold' anomaly + fatal notification, and
 *  ONLY a human's manual merge (the commander's 「マージ」 flow) lands it.
 *  Matching leans fail-safe — a false hold costs one manual look, a miss ships a
 *  poisoned release pipeline (the 2026-07-14 release.yml auto-merge). The set:
 *   - CI/CD pipelines: `.github/workflows/` + release.yml / ci.yml anywhere
 *   - dependency/build-script injection: package.json + lockfiles
 *   - signing/notarization: `sign…` / `notar…` path segments (e.g.
 *     scripts/sign-and-notarize.sh; segment-anchored so design… / assign… never match)
 *   - the privileged Electron process: electron/main.js
 *   - secrets/credentials: `secret` anywhere, `.env` files, auth/token path segments
 *     AND camelCase joins (supabaseAuth.ts / authStore.ts — the 2026-07-15 gap: the
 *     segment-boundary regexes above can't see camel boundaries, and case-insensitive
 *     matching can't distinguish authStore from author, so the camel companions below
 *     are case-SENSITIVE and live as separate patterns)
 *   - the authorization core by explicit path: roles.ts / swarmGate.ts /
 *     swarmAllowedModels.ts decide WHO is owner and WHICH models swarm may use, but
 *     contain no auth-ish name segment. Deliberately NOT widened to swarmOrchestrator /
 *     swarmLaunch: those change on every engine iteration, and holding all swarm work
 *     would normalize overriding the hold — the fence stays on the decision layer. */
export const HIGH_RISK_PATHS: readonly RegExp[] = [
  /^\.github\/workflows\//,
  /(^|\/)(release|ci)\.ya?ml$/,
  /(^|\/)package\.json$/,
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.ya?ml|bun\.lockb?)$/,
  /(^|[/._-])(code)?sign(ing|ed)?([/._-]|$)/i,
  /notar/i,
  /^electron\/main\.js$/,
  /secret/i,
  /(^|\/)\.env(\.|$)/,
  /(^|[/._-])o?auth([/._-]|$)/i,
  /(^|[/._-])tokens?([/._-]|$)/i,
  // camelCase companions (case-sensitive — /i would swallow author/tokenizer):
  // an Upper word standing on a camel boundary (supabaseAuth.ts, AuthGate.tsx,
  // refreshTokens.ts, apiSecretKey.ts)…
  /(^|[/._-]|[a-z0-9])(OAuth|Auth|Tokens?|Secrets?)([/._-]|$|[A-Z0-9])/,
  // …and a segment-initial lower word continued in camelCase or by a digit
  // (authStore.ts, oauth2.ts, tokenRefresh.ts). author/authoring stay clear:
  // their next char is lowercase.
  /(^|[/._-])(o?auth|tokens?|secrets?)[A-Z0-9]/,
  // authorization core — no auth-ish segment in the names, so listed explicitly
  /^src\/lib\/server\/(roles|swarmGate|swarmAllowedModels)\.ts$/,
]

/** The subset of a changed-file list that matches {@link HIGH_RISK_PATHS}. Pure;
 *  [] ⇒ the branch is NOT high-risk. Exported for the force-hold gate + tests. */
export const highRiskChangedPaths = (changedFiles: readonly string[]): string[] =>
  changedFiles.filter((f) => HIGH_RISK_PATHS.some((re) => re.test(f)))

/** Repo-relative paths the branch changed vs the trunk (its own diff:
 *  merge-base(trunk,tip)…tip), as a pure read in the main checkout — no worktree.
 *  [] on any git failure: a diff we cannot compute triggers NO diff-gated check,
 *  keeping unrelated branches fast (the always-on tsc gate still runs); the only
 *  realistic failure (no merge-base) is a branch unrelated to the trunk, which
 *  integrate handles on its own. */
const changedFilesVsTrunk = async (
  projectPath: string,
  tip: string,
  targetRef: string,
): Promise<string[]> => {
  const out = await gitOut(projectPath, ['diff', '--name-only', `${targetRef}...${tip}`])
  if (!out) return []
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** {@link IntegrationDeps.changedPaths}'s real implementation — the HIGH-RISK
 *  FORCE-HOLD gate's read. Same three-dot read as {@link changedFilesVsTrunk}
 *  (merge-base(target,tip)…tip = the branch's OWN changes) but FAIL-CLOSED where
 *  that one is fail-open: gitOut returns null on a git FAILURE and '' on a
 *  genuinely empty diff (already merged) — here a failure THROWS (the caller
 *  defers integration; an unreadable diff is never "no risky paths") while an
 *  empty diff is a normal `{files: []}`. Pure read in the main checkout — no
 *  worktree, no mutation. */
const defaultChangedPaths = async (
  projectPath: string,
  branch: string,
  targetRef: string,
): Promise<{ tip: string; files: string[] }> => {
  const tip = await gitOut(projectPath, ['rev-parse', '--verify', `${branch}^{commit}`])
  if (!tip) throw new Error(`unresolvable branch tip: ${branch}`)
  const out = await gitOut(projectPath, ['diff', '--name-only', `${targetRef}...${tip}`])
  if (out === null) throw new Error(`diff --name-only failed: ${targetRef}...${branch}`)
  return {
    tip,
    files: out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

/** The swarm safety regression suite (the A1 net, card 8d778645). Running these
 *  files green proves the swarm's self-protection invariants (A–D) still hold.
 *  Membership here buys a file the EXISTENCE tamper guard in {@link swarmSafetyCheck}
 *  (deleting it is RED, not a vacuous pass) — so a test only belongs in this list if
 *  its DELETION would silently re-open a hole. gateEnv.test.ts qualifies: it is the
 *  only pin on the untrusted-child env handoff, and its source-text wiring check is
 *  what catches a spawn site reverting to a raw `{ ...process.env }` (2026-07-19). */
export const SWARM_SAFETY_TESTS: readonly string[] = [
  'src/lib/server/swarmSafety.test.ts',
  'server/routes/__tests__/swarmSafety.routes.test.ts',
  'src/lib/server/gateEnv.test.ts',
  // The ONLY pin on the two-copy env policy (gateProcess.ts ⟷ electron/gateEnv.js)
  // and on the producer/verifier assignment. Delete it and the copies drift in
  // silence — which is exactly the membership rule above. It spawns nothing, so it
  // costs the gate almost nothing (unlike gateEnvTamper.test.ts, deliberately out).
  'server/__tests__/gateEnvParity.test.ts',
]

// The gate's fork-pool-safe runner now lives in ./gateProcess (swarmSelfSupply needs it
// too, and importing it from here would close a cycle). Re-exported so the merge gate's
// existing importers — and its integration test — keep addressing it through this module.
export { runGateProcess }

/** A {@link VerifyCheck} that runs the swarm safety suite. Gated to swarm-touching
 *  branches by {@link swarmSafetyConditional}. `applicable` is an EXISTENCE test for
 *  the suite, so a project that isn't OPEN GROUND's own source (no such files) is
 *  never gated. `run` executes the suite with the project's own vitest INSIDE the
 *  rebased worktree (node_modules symlinked by makeVerify); a RED suite blocks the
 *  merge. The spawn goes through {@link withGateEnv}, so the child gets a THROWAWAY
 *  OPENGROUND_HOME the engine mkdtemp'd — the real home is never handed over.
 *  (Until 2026-07-19 this comment claimed the run was safe because the suite
 *  "re-pins OPENGROUND_HOME itself" via src/test/setup-home.ts. That was circular:
 *  setup-home.ts and the vitest.config.ts that loads it live IN THE WORKTREE, i.e.
 *  inside the very artifact being judged — see gateProcess.ts's header.)
 *  A missing vitest binary (project not installed) is RED — an unverified swarm
 *  change is never waved through (mirrors tscCheck's no-node_modules stance). */
export const swarmSafetyCheck: VerifyCheck = {
  applicable: async (projectPath) =>
    (
      await Promise.all(
        SWARM_SAFETY_TESTS.map((t) =>
          stat(join(projectPath, t))
            .then(() => true)
            .catch(() => false),
        ),
      )
    ).every(Boolean),
  run: async (worktreeDir) => {
    // The net must be INTACT in the to-be-landed tree FIRST. vitest, given an explicit
    // file list, silently SKIPS a missing file and runs the survivors — so a branch
    // that deleted/renamed a safety file would otherwise pass the gate on the
    // remaining (or zero) tests. Require every safety file to exist in the worktree;
    // a missing one is tampering → RED (an evasion attempt, not a pass).
    for (const t of SWARM_SAFETY_TESTS) {
      if (!(await stat(join(worktreeDir, t)).then(() => true).catch(() => false))) {
        return { ok: false, output: `safety test missing in branch: ${t} (the net must stay intact)` }
      }
    }
    const vitestBin = join(worktreeDir, 'node_modules', '.bin', 'vitest')
    if (!(await stat(vitestBin).then(() => true).catch(() => false))) {
      return {
        ok: false,
        output: 'vitest unavailable (no node_modules in the project — run npm install to arm the swarm-safety gate)',
      }
    }
    try {
      await withGateEnv((env) =>
        runGateProcess(vitestBin, ['run', ...SWARM_SAFETY_TESTS], {
          cwd: worktreeDir,
          timeout: 240_000,
          maxBuffer: 16 * 1024 * 1024,
          env,
        }),
      )
      return { ok: true, output: '' }
    } catch (e: unknown) {
      const out = `${(e as { stdout?: string })?.stdout ?? ''}\n${(e as { stderr?: string })?.stderr ?? ''}`.trim()
      const tail = out ? out.split('\n').filter(Boolean).slice(-8).join(' · ').slice(0, 800) : errMsg(e)
      return { ok: false, output: `regression RED: ${tail || 'vitest failed'}` }
    }
  },
}

/** The swarm-safety net wired as a diff-gated check: run {@link swarmSafetyCheck}
 *  iff the branch touches swarm code ({@link touchesSwarmPaths}). Passed to
 *  {@link makeVerify} as a conditional check by {@link defaultDeps}. */
export const swarmSafetyConditional: ConditionalCheck = {
  label: 'swarm-safety',
  appliesTo: (changed) => touchesSwarmPaths(changed),
  check: swarmSafetyCheck,
}

// ── The project-wide quality floor: lint + tsc + test on EVERY branch (card 4e7f2151) ──
// B2 (card 34d42890) made ONE suite (swarm-safety) a merge gate, and ONLY for branches
// that touch swarm code (its condition 3: don't slow unrelated work). This GENERALIZES
// that gate to the project's full quality floor: before ANY swarm branch may auto-merge
// it must be lint-clean, type-clean, AND have the FULL test suite green — the same
// first-red-blocks worktree run as tsc, surfaced through the same review→doing 差し戻し
// path (a RED check blocks exactly like a RED tsc: reworkOrPark, then 'blocked' after
// MAX_REWORKS; the failing check's label rides the reason into the engine log + the
// worker's fix instruction). B2 is CONTAINED, two ways: (a) the full `npm test` SUBSUMES
// the swarm-safety suite (those tests run inside it), and (b) swarmSafetyConditional is
// KEPT on top — not for re-running the tests, but for its TAMPER guard: a branch that
// DELETES a safety file passes the full suite (vitest silently skips a missing file) yet
// trips swarmSafetyCheck's explicit existence check. Each check's own `applicable` still
// skips a project that lacks the tooling, so a non-OPEN-GROUND repo the engine drives is
// never blocked on a gate it can't run (mirrors tscCheck).

/** eslint config filenames that signal "this project lints" — the `applicable` gate for
 *  {@link lintCheck}. Covers eslintrc (legacy — what OPEN GROUND uses: .eslintrc.cjs) and
 *  flat config. A reasonable signal, not exhaustive of every variant (e.g. an `eslintConfig`
 *  key in package.json is not detected): the goal is to ARM OPEN GROUND's own gate and SKIP
 *  a repo with no eslint, never to block one we can't lint. */
const ESLINT_CONFIG_FILES: readonly string[] = [
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  '.eslintrc',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
]

/** `npm run lint` (eslint . --ext .ts,.tsx) wired as a merge-gate {@link VerifyCheck}.
 *  `applicable` is a LINT-PROJECT test (an eslint config present) — NOT an environment
 *  test — so a repo with no eslint setup is never blocked; but a project that HAS one we
 *  cannot run is NOT waved through: `run` reports RED when the binary is absent (no
 *  node_modules), mirroring tscCheck's conservative stance (never auto-merge unverified).
 *  The argv matches the `lint` npm script byte-for-byte so the gate == what a human runs. */
export const lintCheck: VerifyCheck = {
  applicable: async (projectPath) =>
    (
      await Promise.all(
        ESLINT_CONFIG_FILES.map((f) =>
          stat(join(projectPath, f))
            .then(() => true)
            .catch(() => false),
        ),
      )
    ).some(Boolean),
  run: async (worktreeDir) => {
    const eslintBin = join(worktreeDir, 'node_modules', '.bin', 'eslint')
    if (!(await stat(eslintBin).then(() => true).catch(() => false))) {
      return {
        ok: false,
        output: 'eslint unavailable (no node_modules in the project — run npm install to arm the lint gate)',
      }
    }
    try {
      await withGateEnv((env) =>
        runGateProcess(eslintBin, ['.', '--ext', '.ts,.tsx'], {
          cwd: worktreeDir,
          timeout: 180_000,
          maxBuffer: 16 * 1024 * 1024,
          env,
        }),
      )
      return { ok: true, output: '' }
    } catch (e: unknown) {
      const out = `${(e as { stdout?: string })?.stdout ?? ''}\n${(e as { stderr?: string })?.stderr ?? ''}`.trim()
      // eslint prints the violation list to stdout; keep the LAST lines (the summary).
      const tail = out ? out.split('\n').filter(Boolean).slice(-8).join(' · ').slice(0, 800) : errMsg(e)
      return { ok: false, output: tail || 'eslint failed' }
    }
  },
}

/** vitest/vite config filenames that signal "this project has a test suite" — the
 *  `applicable` gate for {@link testCheck}. vitest reads a `test` block from a vite config
 *  too, so both families count. OPEN GROUND has vitest.config.ts. */
const VITEST_CONFIG_FILES: readonly string[] = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
]

/** `npm test` (vitest run — the FULL suite) wired as a merge-gate {@link VerifyCheck}. Runs
 *  EVERY test the project has against the to-be-landed tree, so a swarm change that breaks
 *  ANY test (not just the swarm-safety subset B2 gated on) cannot auto-merge. Spawned
 *  through {@link withGateEnv} — a throwaway OPENGROUND_HOME chosen by the ENGINE, so
 *  the user's real ~/.openground is never in the child's env at all. This is the check
 *  with the widest blast radius (it runs every test file the branch ships, under the
 *  branch's own vitest.config.ts), which is why the pre-2026-07-19 "the suite isolates
 *  itself" assumption was the wrong shape here first — gateProcess.ts's header has the
 *  full argument. `applicable` is a HAS-TESTS test (a vitest/vite config present); `run`
 *  reports RED when vitest is absent (mirrors tscCheck). The full suite is HEAVY — it runs
 *  at most once per new commit per card (makeVerify is memoized by tip in runIntegratePass),
 *  the deliberate cost of the quality floor the goal asks for. */
export const testCheck: VerifyCheck = {
  applicable: async (projectPath) =>
    (
      await Promise.all(
        VITEST_CONFIG_FILES.map((f) =>
          stat(join(projectPath, f))
            .then(() => true)
            .catch(() => false),
        ),
      )
    ).some(Boolean),
  run: async (worktreeDir) => {
    const vitestBin = join(worktreeDir, 'node_modules', '.bin', 'vitest')
    if (!(await stat(vitestBin).then(() => true).catch(() => false))) {
      return {
        ok: false,
        output: 'vitest unavailable (no node_modules in the project — run npm install to arm the test gate)',
      }
    }
    try {
      await withGateEnv((env) =>
        runGateProcess(vitestBin, ['run'], {
          cwd: worktreeDir,
          timeout: 600_000,
          maxBuffer: 32 * 1024 * 1024,
          env,
        }),
      )
      return { ok: true, output: '' }
    } catch (e: unknown) {
      const out = `${(e as { stdout?: string })?.stdout ?? ''}\n${(e as { stderr?: string })?.stderr ?? ''}`.trim()
      const tail = out ? out.split('\n').filter(Boolean).slice(-8).join(' · ').slice(0, 800) : errMsg(e)
      return { ok: false, output: tail || 'vitest failed' }
    }
  },
}

/** lint + full-test wired as ALWAYS-ON checks — `appliesTo` accepts EVERY branch (no
 *  diff-gating), in deliberate contrast to {@link swarmSafetyConditional}, which only fires
 *  for swarm-touching branches. THIS is the generalization (card 4e7f2151): B2's gate ran a
 *  suite only when the diff was relevant; the quality floor (lint/tsc/test) is relevant to
 *  ALL branches. (Each check's own `applicable` still skips a project missing the tooling.) */
export const lintConditional: ConditionalCheck = {
  label: 'lint',
  appliesTo: () => true,
  check: lintCheck,
}
export const testConditional: ConditionalCheck = {
  label: 'test',
  appliesTo: () => true,
  check: testCheck,
}

/** Build the real `verify` dep from a primary {@link VerifyCheck} (always run when
 *  `applicable` — the tsc gate) plus any number of {@link ConditionalCheck}s. A
 *  conditional with an always-true `appliesTo` runs for EVERY branch (the lint + full
 *  test quality-floor gates, card 4e7f2151); a diff-gated one runs only when the branch's
 *  changes make it relevant (the swarm-safety suite → only a branch touching swarm code).
 *  The worktree mechanics are identical for any check, so
 *  they live here once and the test drives the WHOLE real path (tip-resolve → rebase →
 *  symlink → check → teardown) with a fake verdict. The verified tree is the branch
 *  REBASED ONTO THE TRUNK — what `integrate` actually pushes — so a branch that compiled
 *  against an older trunk but breaks against the current one is caught. A non-FF /
 *  conflicting / unbuildable case never FALSE-blocks (returns ok:true with a reason); a
 *  real rebase conflict is deferred to `integrate` (which stamps it). */
export const makeVerify =
  (check: VerifyCheck, conditional: ConditionalCheck[] = []): IntegrationDeps['verify'] =>
  async (projectPath, branch, target, opts) => {
    const remote = 'origin'
    if (!isSwarmBranch(branch)) return { ok: true, tip: null, reason: 'not a swarm branch' }
    // Resolve the branch tip (local ref first — swarm branches commit locally —
    // then the remote-tracking ref). No tip ⇒ nothing to land ⇒ vacuously ok.
    const tip =
      (await gitOut(projectPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) ??
      (await gitOut(projectPath, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]))
    if (!tip) return { ok: true, tip: null, reason: 'no branch tip (nothing to verify)' }
    // Unchanged since it last failed → don't re-run the (expensive) check.
    if (opts?.skipIfTip && opts.skipIfTip === tip) {
      return { ok: false, tip, reason: 'unchanged since last failed verification', skipped: true }
    }
    const targetRef = `refs/remotes/${remote}/${target}`
    if ((await gitOut(projectPath, ['rev-parse', '--verify', '--quiet', targetRef])) === null) {
      return { ok: true, tip, reason: 'no remote trunk' } // integrate will skip too
    }
    // Already merged (tip ⊆ trunk) → nothing new lands → nothing to verify.
    // `merge-base --is-ancestor` exits 0 (gitOut → '' ≠ null) when tip ⊆ trunk.
    if ((await gitOut(projectPath, ['merge-base', '--is-ancestor', tip, targetRef])) !== null) {
      return { ok: true, tip, reason: 'already merged' }
    }
    // Decide WHICH checks this branch needs, cheaply, BEFORE building a worktree:
    //  • the primary check (tsc) runs for every project it is `applicable` to;
    //  • each conditional check runs only when the branch's diff makes it relevant
    //    (the swarm-safety net → ONLY a branch that touches swarm code) AND the
    //    project carries that check's fixtures. A branch needing NO check is waved
    //    through with no worktree (a non-TS, non-swarm change blocks nobody).
    const checks: { label: string; run: VerifyCheck['run'] }[] = []
    if (await check.applicable(projectPath)) checks.push({ label: 'tsc', run: check.run })
    // Computed unconditionally (not just when `conditional.length`) so the
    // docs-freshness soft-warn below fires even for a bare makeVerify(tsc)
    // (no conditional checks wired) — it is orthogonal to which checks run.
    const changed = await changedFilesVsTrunk(projectPath, tip, targetRef)
    for (const c of conditional) {
      if (c.appliesTo(changed) && (await c.check.applicable(projectPath))) {
        checks.push({ label: c.label, run: c.check.run })
      }
    }
    // READ-ONLY soft-warn (TARGET-STATE §6, card: docs追随の仕組み化) — a branch
    // that touches swarm code but leaves docs/commander/ untouched likely needs a
    // docs update. NEVER blocks: computed here (both docsWarning-bearing return
    // paths below carry it), never folded into `ok`.
    const docsWarning =
      touchesSwarmPaths(changed) && !changed.some((f) => f.startsWith('docs/commander/'))
        ? `swarm code changed without a docs/commander/ update (see docs/commander/TARGET-STATE.md §6)`
        : undefined
    if (checks.length === 0) {
      return { ok: true, tip, reason: 'no applicable check (nothing to verify)', docsWarning }
    }

    // Materialize EXACTLY what integrate will push: a detached worktree at the tip,
    // rebased onto the trunk. Engine-owned dir (randomUUID) under the central
    // worktrees boundary, force-torn-down whatever happens.
    let dir: string
    try {
      const uuid = await projectUUIDFromPath(projectPath)
      dir = join(centralWorktreesDir(uuid), `.verify-${randomUUID().replace(/-/g, '').slice(0, 12)}`)
    } catch (e) {
      // Can't even resolve the worktree dir → cannot prove safety. Conservative:
      // block (retry next pass) rather than merge unverified.
      return { ok: false, tip, reason: `verify setup failed: ${errMsg(e)}` }
    }
    if ((await gitOut(projectPath, ['worktree', 'add', '--detach', dir, tip])) === null) {
      return { ok: false, tip, reason: 'could not create verify worktree' }
    }
    try {
      // Rebase onto the trunk. A conflict here is integrate's to OWN (it stamps the
      // card), so verify DEFERS — returns ok so the gate doesn't double-report it.
      if ((await gitOut(dir, ['rebase', targetRef])) === null) {
        await gitOut(dir, ['rebase', '--abort'])
        return { ok: true, tip, reason: 'rebase conflict (deferred to integrate)' }
      }
      // Symlink node_modules from the MAIN checkout (complete + correct) so the
      // checks (tsc, and the swarm-safety suite's vitest) resolve their deps
      // reliably — a fresh worktree has none, and a swarm worktree's own
      // node_modules can be incomplete.
      try {
        await symlink(join(projectPath, 'node_modules'), join(dir, 'node_modules'))
      } catch {
        /* best-effort; if it fails the check below reports the real breakage */
      }
      // Run each applicable check IN ORDER; the FIRST red blocks. The order is
      // cheapest-first / heaviest-last (tsc → lint → swarm-safety → full test), so a fast
      // failure never pays the cost of the full test suite. The label is surfaced in the
      // reason so the operator sees WHICH gate blocked the merge.
      for (const c of checks) {
        const r = await c.run(dir)
        if (!r.ok) return { ok: false, tip, reason: `${c.label}: ${r.output}` }
      }
      return { ok: true, tip, docsWarning }
    } finally {
      await gitOut(projectPath, ['worktree', 'remove', '--force', dir])
      await gitOut(projectPath, ['worktree', 'prune'])
    }
  }

// ── Independent adversarial pre-merge review (card a14329dc) ───────────────────
// The verify gate above proves the to-be-landed tree is MECHANICALLY sound (tsc +
// swarm-safety green). This is the COMPLEMENTARY gate the goal asks for: an
// INDEPENDENT adversarial fact-check. Once verify is green and BEFORE a branch may
// auto-merge, N fresh `claude` reviewers — NONE of them the worker that wrote the
// code — each read the to-be-landed diff and judge must-fix vs clean, and a STRICT
// majority decides ({@link tallyReview}). This mirrors what the tmux /manage
// commander does by hand (別 subagent の敵対 fact-check 多数決) before it FF-pushes;
// here it runs unattended in the in-app auto-merge path. It is NOT a duplicate of
// the verify gate — verify = "does it build / do the safety tests pass", review =
// "is the change actually correct" (a human-judgment fact-check no test encodes).
//
// PTY-ONLY + SUBSCRIPTION-ONLY (canonical: claudeTerminal.ts "THE TWO RULES"):
// every reviewer is a real interactive PTY (launchClaude) — `claude -p` is
// FORBIDDEN here (same contract as the workers / generateDescription). ⚠ The
// reason is NOT billing; that rationale was measured wrong on 2026-07-30 (-p
// bills the subscription too). Read the canonical block before changing this.

/** One reviewer's verdict on a to-be-landed branch. */
export type ReviewVote = 'must-fix' | 'clean'

/** The specialized review lenses (card 5f85d2f5). In lens-panel mode each reviewer
 *  runs exactly ONE lens, so the panel covers DISTINCT failure modes (a correctness
 *  bug, a security hole, a perf cliff, a regression) instead of N reviewers
 *  re-checking the same surface — the goal's "異なる lens の独立レビュアーで失敗
 *  モードを網羅". */
export type ReviewLensKey = 'correctness' | 'security' | 'perf' | 'regression'

/** A specialized adversarial-review lens: ONE focused reviewer judges the
 *  to-be-landed diff through exactly this lens. */
export interface ReviewLens {
  /** Lens identity — surfaced per-lens in the engine log and the reviewer's PTY name. */
  key: ReviewLensKey
  /** Contribution to the rework decision. A lens that votes must-fix adds `weight`
   *  to the must-fix tally; the panel sends back when that tally reaches the
   *  threshold ({@link tallyLensReview}). Default 1 ⇒ ANY single lens's must-fix
   *  reworks (条件2 の既定). Lower a noisy lens (e.g. perf → 0.5) so its must-fix
   *  ALONE no longer blocks — it is still logged — but two such lenses together do. */
  weight?: number
  /** The focus instruction injected into this reviewer's prompt — what THIS lens
   *  must hunt for. Plain prose (never a verdict marker) so it stays echo-safe. */
  focus: string
}

/** WHY a reviewer produced no vote. Every non-vote used to collapse into a bare
 *  `vote:null` — the timeout, the dead PTY, and the unparseable output all became
 *  an indistinguishable "abstain", so a needs-human freeze gave the operator
 *  nothing to fix (card f3f1e5c6). Attributed per-reviewer so the tally summary —
 *  and therefore the engine log — names the cause:
 *   - 'timeout'      — the reviewer ran out of its wall-clock budget before
 *                      emitting a verdict marker (the dominant cause on large
 *                      diffs — see {@link computeReviewTimeoutMs}).
 *   - 'limit'        — the session's terminal utterance was the subscription
 *                      rate-limit notice ({@link endsInRateLimit}).
 *   - 'spawn-failed' — the PTY produced NO output at all (claude never really
 *                      started).
 *   - 'no-marker'    — the session ended on its own, produced output, but never
 *                      a parseable `OPENGROUND_REVIEW` marker.
 *   - 'aborted'      — the panel tore the reviewer down (engine stop / teardown).
 *   - 'error'        — the runner itself threw (spawn exception etc.). */
export type AbstainCause = 'timeout' | 'limit' | 'spawn-failed' | 'no-marker' | 'aborted' | 'error'

export interface ReviewerVerdict {
  /** 1-based reviewer index (surfaced in the log). */
  reviewer: number
  /** null ⇒ the reviewer produced no parseable verdict (timeout / PTY died / no
   *  marker) — a NON-vote, counted toward NEITHER side. */
  vote: ReviewVote | null
  /** Short reason surfaced in the log (the must-fix summary; '' otherwise). */
  note: string
  /** The specialized lens this reviewer ran (lens-panel mode only — {@link
   *  tallyLensReview}); undefined for the homogeneous majority panel
   *  ({@link tallyReview}). Surfaced per-lens in the engine log (条件3). */
  lens?: ReviewLensKey
  /** WHY this reviewer abstained — set EXACTLY when `vote` is null, so the
   *  engine log can say `lens=abstain(timeout)` instead of a bare abstain
   *  (棄権理由の可視化・完了条件1). */
  abstainCause?: AbstainCause
}

/** What the panel's majority vote resolved to:
 *   - 'rework'    → majority must-fix: 差し戻し (review→doing), never merge.
 *   - 'integrate' → majority clean: proceed to land.
 *   - 'defer'     → no majority (a tie / too many non-votes): leave in review and
 *     retry next pass — never merge on thin signal, never bump the 差し戻し count. */
export type ReviewDecision = 'integrate' | 'rework' | 'defer'

export interface ReviewResult {
  decision: ReviewDecision
  /** Per-reviewer verdicts (for the engine log / observability). */
  verdicts: ReviewerVerdict[]
  /** Decisive-vote tallies (mustFix + clean ≤ panelSize). */
  mustFix: number
  clean: number
  /** One-line summary handed to the worker on a 'rework' send-back, and logged. */
  reason: string
  /** The panel was SKIPPED (unchanged tip already reviewed must-fix) — the decision
   *  was carried over WITHOUT spawning reviewers (mirrors verify's `skipped`). */
  skipped?: boolean
  /** The panel was SKIPPED because every model tier is cooling (quota park) — an
   *  ENGINE hold, not a panel verdict. Callers MUST NOT count this toward the
   *  defer streak (MAX_REVIEW_DEFERS) — doing so would flip the card to
   *  needs-human and, via the defer-exhausted memo, never re-spawn the panel
   *  even after the park lifts. runIntegratePass normally pre-gates before
   *  calling review at all; this flag is the safety net for the window where
   *  the park began while the (multi-minute) verify stage was running, and for
   *  direct consumers of makeAdversarialReview. */
  skippedForPark?: boolean
}

/** Default panel size — three independent reviewers (odd ⇒ no ties when all vote;
 *  the goal's "例3"). Used by the homogeneous majority panel ({@link tallyReview});
 *  the default wiring uses the lens panel below instead. */
export const REVIEW_PANEL_SIZE = 3

/** The default lens panel (card 5f85d2f5): four INDEPENDENT specialists, each blind
 *  to the others, collectively covering the failure modes a homogeneous panel
 *  misses. Every lens carries the default weight (1) ⇒ ANY one lens's must-fix sends
 *  the branch back (条件2), and the weight is per-lens TUNABLE (条件2「設定可」). */
export const DEFAULT_REVIEW_LENSES: ReviewLens[] = [
  {
    key: 'correctness',
    focus:
      'Logic correctness ONLY: off-by-one / boundary errors, null/undefined and empty-input handling, wrong conditionals, broken control flow, mishandled async/promises, incorrect data transforms, and violated function/API contracts. Is the code actually right?',
  },
  {
    key: 'security',
    focus:
      'Security ONLY: unvalidated input, path traversal / directory escape, command or SQL injection, missing or weakened authz/authn or security boundary, secret leakage, and unsafe handling of untrusted data. Could this be abused?',
  },
  {
    key: 'perf',
    focus:
      'Performance ONLY: accidental quadratic / N+1 work, redundant recomputation or re-render, unbounded memory growth, leaked resources (timers, listeners, handles, PTYs), and blocking I/O on a hot path. Does it scale and clean up after itself?',
  },
  {
    key: 'regression',
    focus:
      'Regression ONLY: does this break or silently change existing behavior, remove or weaken a test / invariant it should keep, or alter a contract other code depends on? Is backward compatibility preserved?',
  },
]

/** Majority vote over a panel's verdicts. STRICT majority of the FULL panel
 *  (`panelSize` = the number LAUNCHED, not the number that voted — so a reviewer
 *  that failed to vote can NEVER lower the bar to a merge), counting only decisive
 *  votes:
 *    - mustFix ≥ majority → 'rework'    (送り返す・絶対にマージしない)    [条件2]
 *    - clean   ≥ majority → 'integrate' (統合に進む)                      [条件3]
 *    - neither            → 'defer'      (多数決つかず: 同票 / 棄権過多 — 保留して
 *      次パスで再評価。マージもせず 差し戻しカウントも進めない)。
 *  Pure + exported for unit tests. `majority = floor(panelSize/2)+1` (2 for 3). */
/** One `label=abstain(cause)` fragment per NON-vote — the shared "why did this
 *  reviewer not vote" wording for both tallies' reasons, so every defer the
 *  engine logs names each abstention's cause (完了条件1: `lens=abstain` で
 *  終わらせない). '' when everybody voted. */
const describeAbstentions = (verdicts: ReviewerVerdict[]): string =>
  verdicts
    .filter((v) => v.vote === null)
    .map((v) => `${v.lens ?? `r${v.reviewer}`}=abstain(${v.abstainCause ?? 'unknown'})`)
    .join(', ')

/** A defer streak's ACCUMULATED abstention tallies (`lens(cause)` → times seen,
 *  {@link SwarmEngine.reviewDeferred}) as one human-readable fragment —
 *  `correctness(timeout)×3, regression(timeout)×3` — for the needs-human hand-off
 *  (完了条件3). 'なし' for a streak of pure ties (nobody abstained). Exported for
 *  unit tests. */
export const describeAbstainTallies = (abstains: Record<string, number>): string => {
  const parts = Object.entries(abstains).map(([key, n]) => `${key}×${n}`)
  return parts.length > 0 ? parts.join(', ') : 'なし'
}

export const tallyReview = (verdicts: ReviewerVerdict[], panelSize: number): ReviewResult => {
  const mustFix = verdicts.filter((v) => v.vote === 'must-fix').length
  const clean = verdicts.filter((v) => v.vote === 'clean').length
  const majority = Math.floor(panelSize / 2) + 1
  if (mustFix >= majority) {
    const note = verdicts.find((v) => v.vote === 'must-fix' && v.note)?.note
    return {
      decision: 'rework',
      verdicts,
      mustFix,
      clean,
      reason: `敵対レビュー多数決: ${mustFix}/${panelSize} が must-fix 判定${note ? ` — ${note}` : ''}`,
    }
  }
  if (clean >= majority) {
    return { decision: 'integrate', verdicts, mustFix, clean, reason: `敵対レビュー多数決: ${clean}/${panelSize} clean` }
  }
  const abstainDetail = describeAbstentions(verdicts)
  return {
    decision: 'defer',
    verdicts,
    mustFix,
    clean,
    reason: `敵対レビュー多数決つかず (must-fix ${mustFix} / clean ${clean} / 全${panelSize})${abstainDetail ? ` [${abstainDetail}]` : ''} — 保留して次パスで再評価`,
  }
}

/** Decide a LENS panel's verdicts (card 5f85d2f5). Unlike {@link tallyReview}'s
 *  majority over homogeneous reviewers, each lens covers a DISTINCT failure mode, so
 *  the rule is a WEIGHTED OR, not a vote count:
 *    - must-fix weight (Σ of each must-fix lens's weight) ≥ `reworkThreshold`
 *      → 'rework'    (差し戻し・絶対にマージしない)                          [条件2]
 *    - else if EVERY lens is PRESENT and returned a decisive verdict (a full
 *      panel, no abstention, ≥1 decisive vote) → 'integrate' (統合に進む —
 *      must-fix weight is under threshold)                                   [条件4]
 *    - else (a lens ABSTAINED, or the verdict list is EMPTY/short of the panel ⇒
 *      that failure mode went UN-reviewed) → 'defer'
 *      (保留・次パスで再評価・マージもせず 差し戻しカウントも進めない)。
 *      FAIL-CLOSED: zero decisive votes can never integrate — "レビューできな
 *      かった" is not "クリーン" (2026-07-14, the [must-fix 0 / clean 0] land).
 *  Default lens weights are 1 and the default threshold 1, so ANY single lens's
 *  must-fix reworks — but a lens can be down-weighted so its must-fix alone does not
 *  block (条件2「lens別の重み付けは設定可」). Per-lens verdicts are folded into
 *  `reason`, which the engine already logs verbatim (条件3 — NO engine change). Pure
 *  + exported for unit tests. `mustFix`/`clean` stay lens COUNTS so the engine's
 *  `must-fix N / clean M` tally line keeps meaning. */
export const tallyLensReview = (
  verdicts: ReviewerVerdict[],
  lenses: ReviewLens[],
  reworkThreshold = 1,
): ReviewResult => {
  const weightOf = (key: ReviewLensKey | undefined): number => lenses.find((l) => l.key === key)?.weight ?? 1
  const mustFix = verdicts.filter((v) => v.vote === 'must-fix').length
  const clean = verdicts.filter((v) => v.vote === 'clean').length
  const abstained = verdicts.filter((v) => v.vote === null).length
  const mustFixWeight = verdicts
    .filter((v) => v.vote === 'must-fix')
    .reduce((sum, v) => sum + weightOf(v.lens), 0)
  // Per-lens summary, folded into the reason the engine logs (条件3): every lens's
  // verdict is named so the log shows WHICH lens flagged WHAT.
  const summary = verdicts
    .map((v) => {
      const label = v.lens ?? `r${v.reviewer}`
      if (v.vote === 'must-fix') return `${label}=must-fix${v.note ? `(${v.note})` : ''}`
      if (v.vote === 'clean') return `${label}=clean`
      // Name WHY the lens abstained (完了条件1) — a bare "abstain" told the
      // operator nothing when the defer streak froze a card to needs-human.
      return `${label}=abstain(${v.abstainCause ?? 'unknown'})`
    })
    .join(', ')
  if (mustFixWeight >= reworkThreshold) {
    return {
      decision: 'rework',
      verdicts,
      mustFix,
      clean,
      reason: `lens別敵対レビュー [${summary}] — must-fix 重み ${mustFixWeight} ≥ 閾値 ${reworkThreshold} で差し戻し`,
    }
  }
  // FAIL-CLOSED (2026-07-14): 'integrate' requires POSITIVE evidence — a FULL panel
  // where every lens voted decisively. `abstained === 0` alone is also true of an
  // EMPTY (or short) verdict list — a panel that never ran, or lost reviewers before
  // they entered the tally — and that shape is "nobody reviewed", not "everybody
  // approved". Zero decisive votes must never read as clean.
  const decisive = mustFix + clean
  if (abstained === 0 && decisive >= lenses.length && decisive > 0) {
    return {
      decision: 'integrate',
      verdicts,
      mustFix,
      clean,
      reason: `lens別敵対レビュー [${summary}] — 全lens判定済 (must-fix 重み ${mustFixWeight} < 閾値 ${reworkThreshold}) で統合`,
    }
  }
  const missing = Math.max(0, lenses.length - verdicts.length)
  const shortfall =
    missing > 0
      ? `${missing}個のlensの結果が欠落`
      : abstained > 0
        ? `${abstained}個のlensが未判定`
        : 'decisiveな票が0(パネル空)'
  return {
    decision: 'defer',
    verdicts,
    mustFix,
    clean,
    reason: `lens別敵対レビュー [${summary || '票なし'}] — ${shortfall}(未レビュー観点あり) → 保留して次パスで再評価`,
  }
}

// The reviewer's verdict marker. Bounded by an end token (like generateDescription's
// OPENGROUND_DESC) so it survives TUI repaints and a PTY line-wrap inside the note.
export const REVIEW_MARKER = 'OPENGROUND_REVIEW:'
export const REVIEW_END = '::OG_REVIEW_END::'
const REVIEW_VOTE_MUSTFIX = 'MUST_FIX'
const REVIEW_VOTE_CLEAN = 'CLEAN'
const REVIEW_NOTE_MAX = 200

/** The read-only adversarial-review prompt ONE reviewer runs. Handed the trunk ref
 *  so it diffs exactly what lands, and told to end with a single verdict marker.
 *
 *  ECHO SAFETY (critical): this prompt is rendered into the reviewer's PTY stream,
 *  so anything that LOOKS like a finished verdict line here will be scraped back by
 *  extractReviewVerdict. Therefore the only `OPENGROUND_REVIEW: … ::OG_REVIEW_END::`
 *  span in the prompt uses the placeholder body `<VERDICT>` — which does NOT start
 *  with MUST_FIX or CLEAN, so the parser skips it. The two real verdict WORDS are
 *  described on separate, non-marker lines. This is what guarantees that a reviewer
 *  which emits no verdict of its own (timeout / hang / refusal) scrapes to a NON-vote
 *  (null), never to the echoed example — a bare echoed `CLEAN` example would
 *  otherwise be miscounted as a clean vote and let unreviewed code auto-merge. */
export const buildReviewPrompt = (trunkRef: string, lens?: ReviewLens): string =>
  [
    lens
      ? `You are an INDEPENDENT adversarial code reviewer assigned the ${lens.key.toUpperCase()} lens. A SEPARATE coding agent produced the change on this git branch; you did NOT write it. Your job is to FACT-CHECK it THROUGH YOUR LENS before it is allowed to auto-merge into the trunk.`
      : 'You are an INDEPENDENT adversarial code reviewer. A SEPARATE coding agent produced the change on this git branch; you did NOT write it. Your job is to FACT-CHECK it before it is allowed to auto-merge into the trunk.',
    '',
    ...(lens ? [`YOUR LENS — judge ONLY this, and trust other independent reviewers to cover the rest: ${lens.focus}`, ''] : []),
    'Steps (STRICTLY READ-ONLY — do NOT create, edit, or delete any file, and do not mutate anything via commands):',
    `- Inspect the exact change this branch will land: run \`git diff ${trunkRef}...HEAD\` and read the touched files (plus any surrounding context you need to judge correctness).`,
    lens
      ? '- Decide ONLY whether there is a MUST-FIX problem WITHIN YOUR LENS: a real, concrete defect of the kind your lens names. Problems outside your lens — plus style, naming, formatting, and nits — are NOT your concern.'
      : '- Decide ONLY whether there is a MUST-FIX problem: a real correctness bug, a security hole, data loss, a broken or wrongly-weakened test, or a violation of an explicit invariant/contract. Style, naming, formatting, and nits are NOT must-fix.',
    '- When you are unsure whether something is truly must-fix, prefer the clean verdict — a false block wastes a rework cycle — but never wave through a concrete bug you can point to.',
    '',
    'Output contract — at the VERY END, output EXACTLY ONE line in this exact shape, and NOTHING after it:',
    `    ${REVIEW_MARKER} <VERDICT> ${REVIEW_END}`,
    'where you replace <VERDICT> (and its angle brackets) with ONE of:',
    `  - the word ${REVIEW_VOTE_MUSTFIX} followed by one short sentence naming the single most important must-fix — if you found one; or`,
    `  - the word ${REVIEW_VOTE_CLEAN} by itself — if the change has no must-fix.`,
    `Substitute the actual word ${REVIEW_VOTE_MUSTFIX} or ${REVIEW_VOTE_CLEAN}: do NOT output the literal text "<VERDICT>" or any angle brackets. Put nothing else on that line, and nothing after the ${REVIEW_END} token.`,
  ].join('\n')

// Strip ANSI escapes / control chars from a reviewer's raw PTY stream — the TUI
// POSITIONS text with cursor moves, so a naive strip fuses words. Mirrors
// generateDescription.ts's split strip (kept LOCAL so the review path never has to
// import that module's private control-char regexes): SGR (style) deletes silently
// (can sit mid-word); every OTHER CSI is a positioning/erase op → a space; OSC
// titles are removed; the remaining control chars become spaces in the candidate.
// eslint-disable-next-line no-control-regex
const REVIEW_SGR_RE = /\x1b\[[0-9;]*m/g
// eslint-disable-next-line no-control-regex
const REVIEW_CSI_OTHER_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const REVIEW_OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
// eslint-disable-next-line no-control-regex
const REVIEW_CTRL_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/** The LAST decisive `OPENGROUND_REVIEW: <VERDICT> … ::OG_REVIEW_END::` span in a
 *  reviewer's raw PTY output → its {vote, note}. The VOTE TOKEN that opens the body
 *  (MUST_FIX / CLEAN) is the discriminator: a span whose body does NOT start with one
 *  (notably the prompt's own echoed `<VERDICT>` placeholder — see buildReviewPrompt's
 *  ECHO SAFETY note) is SKIPPED, and scanning continues backward. So a reviewer that
 *  emitted no verdict of its own scrapes to a NON-vote (null) — never to the echoed
 *  example. A real must-fix NOTE may freely contain `<` (`i < n`, `List<T>`, `<div>`);
 *  it is no longer rejected (that earlier guard silently flipped such verdicts to
 *  clean). Exported for unit tests. */
export const extractReviewVerdict = (raw: string): { vote: ReviewVote | null; note: string } => {
  const text = raw.replace(REVIEW_OSC_RE, '').replace(REVIEW_SGR_RE, '').replace(REVIEW_CSI_OTHER_RE, ' ')
  let from = text.length
  for (;;) {
    const start = text.lastIndexOf(REVIEW_MARKER, from - 1)
    if (start < 0) return { vote: null, note: '' }
    const end = text.indexOf(REVIEW_END, start + REVIEW_MARKER.length)
    if (end >= 0) {
      const body = text
        .slice(start + REVIEW_MARKER.length, end)
        .replace(REVIEW_CTRL_RE, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      // The vote token opens the body — as a WHOLE WORD (end-of-body or a non-word
      // char follows). A body that starts with neither (the echoed `<VERDICT>`
      // placeholder, or junk) is skipped; and a contract-violating body that merely
      // begins with a vote-token PREFIX ("CLEANUP …", "MUST_FIXED …") is NOT read as a
      // vote — it falls through to a non-vote rather than fail-open to clean.
      const upper = body.toUpperCase()
      const opensWith = (token: string): boolean =>
        upper.startsWith(token) && (body.length === token.length || /\W/.test(body[token.length]))
      if (opensWith(REVIEW_VOTE_MUSTFIX)) {
        return { vote: 'must-fix', note: body.slice(REVIEW_VOTE_MUSTFIX.length).trim().slice(0, REVIEW_NOTE_MAX) }
      }
      if (opensWith(REVIEW_VOTE_CLEAN)) return { vote: 'clean', note: '' }
    }
    from = start
    if (from <= 0) return { vote: null, note: '' }
  }
}

const REVIEW_TIMEOUT_MS = 5 * 60_000
const REVIEW_POLL_MS = 750
const REVIEW_BUFFER = 64_000
const reviewSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Per-reviewer budget scaling — the ROOT-CAUSE fix for the lens-abstention
 *  freeze (card f3f1e5c6, 実測 2026-07-09): the budget was a FLAT 5 minutes
 *  regardless of diff size, and a reviewer must actually READ the diff before it
 *  can vote. Measured on one engine build (e583723) with an identical panel, the
 *  outcome separated monotonically on diff size — every diff ≤ 22,020 bytes got
 *  4/4 votes, every diff ≥ 33,891 bytes got exactly the 2 fast lenses and froze
 *  the card at needs-human after 3 defers. Anything self-repairing the engine
 *  (this file) exceeds 30KB, so the engine could never land its own fixes.
 *  The budget therefore grows with what the panel is asked to read:
 *  +10s per KB of diff above the flat floor, hard-capped at 20 minutes
 *  (a 34KB diff ⇒ ~10.7min, a 122KB diff ⇒ the cap). Reviewers run
 *  CONCURRENTLY, so the wall-clock cost is the slowest reviewer, not the sum. */
const REVIEW_TIMEOUT_PER_KB_MS = 10_000
const REVIEW_TIMEOUT_MAX_MS = 20 * 60_000

/** The per-reviewer wall-clock budget for a diff of `diffBytes`: `baseMs` as the
 *  floor, +{@link REVIEW_TIMEOUT_PER_KB_MS} per KB, capped at
 *  {@link REVIEW_TIMEOUT_MAX_MS}. `diffBytes === null` means the diff could not
 *  be sized (git failed / output overflow) — budget as if LARGE (the cap), because
 *  a too-short budget re-creates the permanent freeze while a too-long one merely
 *  waits. An explicit `baseMs` above the cap wins (the caller asked for it).
 *  Pure + exported for unit tests. */
export const computeReviewTimeoutMs = (baseMs: number, diffBytes: number | null): number => {
  const scaled =
    diffBytes === null
      ? REVIEW_TIMEOUT_MAX_MS
      : baseMs + Math.ceil(Math.max(0, diffBytes) / 1024) * REVIEW_TIMEOUT_PER_KB_MS
  return Math.max(baseMs, Math.min(REVIEW_TIMEOUT_MAX_MS, scaled))
}

/** Attribute WHY a reviewer produced no parseable verdict (完了条件1). `ended`
 *  is what the RUNNER observed (its loop's exit edge: budget expiry / panel
 *  abort); the raw transcript refines it:
 *   1. a transcript ENDING in the subscription rate-limit notice is 'limit'
 *      regardless of how the loop exited — the limit was that session's terminal
 *      utterance (same discriminator the panel's quota sensor uses);
 *   2. else the runner's edge ('timeout' / 'aborted') stands;
 *   3. else the PTY ended on its own: NO output at all ⇒ 'spawn-failed'
 *      (claude never really started), output but no marker ⇒ 'no-marker'.
 *  Pure + exported for unit tests. */
export const classifyAbstainCause = (raw: string, ended?: 'timeout' | 'aborted'): AbstainCause => {
  if (endsInRateLimit(raw)) return 'limit'
  if (ended) return ended
  if (raw.trim() === '') return 'spawn-failed'
  return 'no-marker'
}

/** Materialize EXACTLY what integrate will push — a detached worktree at `tip`
 *  rebased onto `targetRef` — run `fn(dir)` in it, and force-tear-it-down whatever
 *  happens. Engine-owned dir (randomUUID) under the central worktrees boundary.
 *  Mirrors makeVerify's worktree mechanics but kept SEPARATE so the review path
 *  cannot destabilize the freshly-landed verify gate, and with NO node_modules
 *  symlink (a reviewer reads code + `git diff`, it never builds). Outcome:
 *   - {ok:true, value} — fn ran on the rebased tree.
 *   - {ok:false, kind:'conflict'} — the rebase conflicted (caller defers to
 *     integrate, which owns/stamps the conflict, exactly like verify).
 *   - {ok:false, kind:'setup'}    — the worktree could not be created. */
type RebasedOutcome<T> = { ok: true; value: T } | { ok: false; kind: 'setup' | 'conflict' }

export const withRebasedWorktree = async <T>(
  projectPath: string,
  tip: string,
  targetRef: string,
  fn: (dir: string) => Promise<T>,
): Promise<RebasedOutcome<T>> => {
  let dir: string
  try {
    const uuid = await projectUUIDFromPath(projectPath)
    dir = join(centralWorktreesDir(uuid), `.review-${randomUUID().replace(/-/g, '').slice(0, 12)}`)
  } catch {
    return { ok: false, kind: 'setup' }
  }
  if ((await gitOut(projectPath, ['worktree', 'add', '--detach', dir, tip])) === null) {
    return { ok: false, kind: 'setup' }
  }
  try {
    if ((await gitOut(dir, ['rebase', targetRef])) === null) {
      await gitOut(dir, ['rebase', '--abort'])
      return { ok: false, kind: 'conflict' }
    }
    return { ok: true, value: await fn(dir) }
  } finally {
    // fn ran a reviewer here via launchClaude (defaultRunReviewer), which seeds a
    // ~/.claude.json folder-trust entry for this `.review-*` dir. This finally is the
    // ONLY teardown for that dir (it bypasses removeSwarmWorktree), so drop the trust
    // entry here too — otherwise every reviewed branch leaks one, the heaviest source
    // of ~/.claude.json bloat. Pruned BEFORE the remove, while the dir still exists,
    // so pathKeys resolves its realpath form as well (realpath-divergence robust).
    removeClaudeFolderTrust(dir)
    // ⚠ STOP AND **WAIT** BEFORE DELETING. `fn` ran real `claude` reviewers in
    // this dir, and each one's teardown is `killTerminal(ref.terminalId)` — a
    // SIGHUP that returns immediately and promises nothing about the process
    // having actually gone. Removing the tree in that gap is how OPEN GROUND
    // manufactured its own un-killable orphans: claude shells out to `git`
    // constantly, and a delete landing mid-run wedges the process in
    // uninterruptible sleep where no signal and no timeout can reach it again
    // (the 2026-07-28 machine freeze). `stopAllDesksInDirAndWait` is the seam
    // built for exactly this — it asks BOTH pools (a reviewer becomes an SDK
    // desk the day that dial goes on) and returns false when something is still
    // there after the budget.
    //
    // WHEN IT REFUSES, THE TREE IS LEAKED ON PURPOSE. A leftover `.review-*`
    // worktree is recoverable — `worktree prune` reaches it later and the next
    // panel makes its own dir. A tree deleted out from under a live claude is
    // not recoverable at all: it takes the machine with it. The asymmetry
    // decides this, not tidiness.
    if (await stopAllDesksInDirAndWait(dir)) {
      await gitOut(projectPath, ['worktree', 'remove', '--force', dir])
      await gitOut(projectPath, ['worktree', 'prune'])
    } else {
      console.warn(
        `[swarm] review worktree ${dir} still has a live desk after the stop budget — ` +
          `leaving it rather than deleting it under a running claude (worktree prune ` +
          `reclaims it once the desk is gone)`,
      )
    }
  }
}

/** Run ONE reviewer to a verdict: a real subscription `claude` PTY in `dir`
 *  (opus by default), marker-scraped, torn down the moment the verdict lands or the
 *  budget / abort fires. Returns the raw PTY buffer (the caller extracts the
 *  verdict) plus the loop's exit EDGE (`ended`) when the reviewer was cut off —
 *  'timeout' (budget expired) / 'aborted' (panel teardown) — so an abstention can
 *  be attributed ({@link classifyAbstainCause}) instead of collapsing into a bare
 *  vote:null. Mirrors generateProjectDescription's PTY-scrape loop. */
const defaultRunReviewer = async (args: {
  dir: string
  trunkRef: string
  index: number
  signal: AbortSignal
  timeoutMs: number
  model: string
  /** When set, this reviewer runs the specialized lens prompt + is named for it. */
  lens?: ReviewLens
}): Promise<{ raw: string; ended?: 'timeout' | 'aborted' }> => {
  if (args.signal.aborted) return { raw: '', ended: 'aborted' }
  // bypass = --dangerously-skip-permissions: no human is at the TTY to approve tool
  // use, and the prompt forbids any mutation, so the read-only review runs unattended.
  // appContext:false keeps the system prompt pristine (marker-scraped utility session,
  // like generateDescription) so the OPENGROUND_REVIEW contract can't drift. No Remote
  // Control: these are ephemeral, not roles the owner drives.
  const ref = launchClaude({
    cwd: args.dir,
    agentSessionId: randomUUID(),
    initialPrompt: buildReviewPrompt(args.trunkRef, args.lens),
    permissionMode: 'bypass',
    model: args.model,
    name: args.lens ? `review-${args.lens.key}` : `review-${args.index}`,
    appContext: false,
  })
  let buffer = ''
  let exited = false
  let aborted = false
  const onAbort = () => {
    aborted = true
    try {
      killTerminal(ref.terminalId)
    } catch {
      /* already gone */
    }
  }
  args.signal.addEventListener('abort', onAbort, { once: true })
  const sub = subscribeTerminal(
    ref.terminalId,
    (chunk) => {
      buffer = (buffer + chunk).slice(-REVIEW_BUFFER)
    },
    () => {
      exited = true
    },
  )
  const deadline = Date.now() + args.timeoutMs
  try {
    while (Date.now() < deadline) {
      await reviewSleep(REVIEW_POLL_MS)
      if (aborted) return { raw: buffer, ended: 'aborted' }
      // A verdict marker landed → done (don't wait out the budget).
      if (extractReviewVerdict(buffer).vote) return { raw: buffer }
      // PTY ended on its own — no edge to report; the transcript says whether it
      // ever started (spawn-failed) or just never voted (no-marker).
      if (exited || sub?.info.finishedAt) return { raw: buffer }
    }
    return { raw: buffer, ended: 'timeout' }
  } finally {
    args.signal.removeEventListener('abort', onAbort)
    sub?.unsubscribe()
    try {
      killTerminal(ref.terminalId)
    } catch {
      /* best-effort teardown */
    }
  }
}

export interface AdversarialReviewOpts {
  /** How many independent reviewers to launch in the HOMOGENEOUS majority panel.
   *  Default {@link REVIEW_PANEL_SIZE} (3). Ignored when `lenses` is set (the lens
   *  panel launches exactly one reviewer per lens). */
  reviewers?: number
  /** Specialized LENS panel (card 5f85d2f5): when set, launch ONE reviewer PER lens
   *  — each with its focused prompt ({@link buildReviewPrompt}) — and decide via
   *  {@link tallyLensReview} (weighted OR) instead of the homogeneous majority.
   *  {@link defaultDeps} wires {@link DEFAULT_REVIEW_LENSES} here. */
  lenses?: ReviewLens[]
  /** Lens mode only: the must-fix weight at/above which the panel reworks. Default 1
   *  ⇒ ANY single lens's must-fix sends back (条件2). */
  reworkThreshold?: number
  /** Per-reviewer wall-clock budget. Default {@link REVIEW_TIMEOUT_MS} (5 min). */
  timeoutMs?: number
  /** Reviewer model. Default {@link SWARM_LAUNCH_MODEL} (the top tier, Fable 5) — adversarial
   *  fact-check is a real judgment task. */
  model?: string
  /** Run ONE reviewer in `dir` and resolve its raw PTY output. INJECTABLE so the
   *  panel + tally logic is testable without spawning real claude (the default is
   *  the subscription PTY). `signal` aborts a reviewer mid-flight on panel teardown.
   *  `lens` is provided in lens mode so a fake can answer per-lens. `model` is the
   *  tier the panel RESOLVED for this spawn (through cooling + the owner's hard
   *  mask) — the real runner launches on it, and a fake can assert on it.
   *  Resolve either the raw transcript (string — the pre-abstain-attribution
   *  contract, still fully supported) or `{raw, ended?}` where `ended` names the
   *  cut-off edge ('timeout' / 'aborted') so an abstention is attributed
   *  ({@link classifyAbstainCause}) instead of logging as a bare abstain. */
  runReviewer?: (args: {
    dir: string
    trunkRef: string
    index: number
    signal: AbortSignal
    lens?: ReviewLens
    model: string
  }) => Promise<string | { raw: string; ended?: 'timeout' | 'aborted' }>
}

/** Build the real adversarial-review dep ({@link IntegrationDeps.review}). It
 *  materializes the to-be-landed tree (branch rebased onto the trunk — the SAME
 *  view verify checks and integrate pushes), launches independent reviewers in it
 *  CONCURRENTLY (each blind to the others), and tallies the result. Two modes:
 *   - LENS panel (`opts.lenses` — card 5f85d2f5, what {@link defaultDeps} wires):
 *     ONE reviewer per lens (correctness/security/perf/regression), each with its
 *     focused prompt, decided by weighted OR ({@link tallyLensReview}) — ANY lens's
 *     must-fix reworks (条件1/2), and each lens's verdict reaches the engine log via
 *     `reason` (条件3).
 *   - homogeneous panel (no `opts.lenses`): N identical reviewers, STRICT majority
 *     ({@link tallyReview}).
 *  Edge cases, all SAFE (never merge un-reviewed):
 *   - `skipIfTip === tip` (a stuck worker re-reporting the same commit) → carry the
 *     prior must-fix ({decision:'rework', skipped:true}) WITHOUT re-spawning the
 *     panel (mirrors verify's memo — no re-burning N claude sessions).
 *   - empty diff (already merged / nothing to land) → trivially 'integrate', no panel.
 *   - rebase conflict → 'integrate' (defer to integrate, which owns/stamps it — same
 *     as verify's deferral; review never resolves a conflict).
 *   - worktree setup failure → 'defer' (transient; retry next pass, never merge). */
/** One human-readable line for a {@link SpawnBlock}, shared by the engine journal
 *  and the reviewer panel's defer reason so both name the hold the same way. The
 *  two kinds read very differently on purpose: an `all-cooling` park LIFTS on its
 *  own at `until`, while `none-allowed` never does — only the owner re-enabling a
 *  tier ends it, so the copy says so instead of implying a wait. */
export const describeSpawnBlock = (block: SpawnBlock, suffix: string): string =>
  block.kind === 'none-allowed'
    ? `no model tier is enabled (Settings ▸ 使用可能モデル) — ${suffix}; nothing will run until a tier is switched back on`
    : `quota park: every enabled model tier is cooling until ${new Date(block.until).toISOString()} — ${suffix}`

export const makeAdversarialReview = (
  opts: AdversarialReviewOpts = {},
): NonNullable<IntegrationDeps['review']> => {
  const lenses = opts.lenses && opts.lenses.length > 0 ? opts.lenses : null
  const panel = lenses ? lenses.length : Math.max(1, opts.reviewers ?? REVIEW_PANEL_SIZE)
  const reworkThreshold = opts.reworkThreshold ?? 1
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS
  const model = opts.model ?? SWARM_LAUNCH_MODEL
  const customRun = opts.runReviewer
  return async (projectPath, branch, target, o) => {
    const tip = o.tip
    if (o.skipIfTip && o.skipIfTip === tip) {
      return {
        decision: 'rework',
        verdicts: [],
        mustFix: 0,
        clean: 0,
        skipped: true,
        reason: 'unchanged since last adversarial-review must-fix',
      }
    }
    const remote = 'origin'
    const targetRef = `refs/remotes/${remote}/${target}`
    const trunkRef = `${remote}/${target}` // human-friendly ref for the reviewer's `git diff`
    // Distinguish a genuinely-empty diff from a git FAILURE — changedFilesVsTrunk
    // collapses both to [], which would fail OPEN (a transient `git diff` error →
    // "nothing to land" → integrate un-reviewed). Probe git directly: null = the diff
    // could not be computed ⇒ DEFER (retry, never merge un-reviewed); '' = genuinely
    // nothing to land (already merged) ⇒ integrate (integrate finalizes it as a no-op).
    const diffOut = await gitOut(projectPath, ['diff', '--name-only', `${targetRef}...${tip}`])
    if (diffOut === null) {
      return { decision: 'defer', verdicts: [], mustFix: 0, clean: 0, reason: 'could not compute diff (deferred)' }
    }
    if (diffOut.trim() === '') {
      return { decision: 'integrate', verdicts: [], mustFix: 0, clean: 0, reason: 'no diff to review (nothing to land)' }
    }
    // Size the actual diff TEXT the reviewers must read and scale their budget on
    // it (the root-cause fix — see computeReviewTimeoutMs). Own execFile call, not
    // gitOut: a >1MB diff overflows execFile's default maxBuffer and gitOut would
    // report the diff "unsizable" for exactly the diffs that most need the bigger
    // budget. Sizing failure ⇒ null ⇒ budget as if large (fail toward waiting,
    // never toward the freeze).
    let diffBytes: number | null = null
    if (isGitRepoRoot(projectPath)) {
      try {
        const { stdout } = await execFile('git', ['diff', `${targetRef}...${tip}`], {
          cwd: projectPath,
          timeout: 30_000,
          maxBuffer: 32 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        })
        diffBytes = Buffer.byteLength(stdout, 'utf8')
      } catch {
        /* unsizable — keep null */
      }
    }
    const perReviewerTimeoutMs = computeReviewTimeoutMs(timeoutMs, diffBytes)
    // SPAWN PARK: no tier is both enabled and cooled-down ⇒ a reviewer `claude`
    // spawned now would hit the same wall the workers did (or has no model at
    // all) — defer (retry next pass; defer never merges un-reviewed), same
    // actuator as runDispatchPass's park gate. Sits AFTER the spawn-free early
    // returns above (skipIfTip carry / empty diff stay useful during a park) and
    // BEFORE any worktree/PTY cost. `skippedForPark` marks this as an ENGINE
    // hold, not a panel verdict, so the caller keeps it out of the
    // MAX_REVIEW_DEFERS streak (see ReviewResult).
    const allowed = await getAllowedModelTiers()
    const block = spawnBlock(Date.now(), allowed)
    if (block) {
      return {
        decision: 'defer',
        verdicts: [],
        mustFix: 0,
        clean: 0,
        skippedForPark: true,
        reason: describeSpawnBlock(block, 'review deferred'),
      }
    }
    // Resolve the reviewer tier THROUGH the quota table AND the owner's hard mask,
    // like worker launches do (resolveSwarmModelEffort): with only SOME tiers dry
    // (no park — the gate above didn't fire), a fable-pinned panel would spawn
    // straight into the cooled/disabled top tier, every reviewer would abstain, and
    // the defer streak would burn to needs-human (the symptom observed at 0a7c641).
    // Identity when every tier is enabled and nothing is cooling. The null branch is
    // unreachable behind `spawnBlock` — kept as a defer (never a throw, never a
    // silent fall-back onto the disabled tier) so this stays fail-CLOSED by
    // construction rather than by the gate above happening to run first.
    // PROBED (2026-07-13): when the chosen tier is UNKNOWN (no cooling mark, no
    // usage veto), one headless `claude --model <tier> -p` probe confirms it can
    // actually launch before the whole panel spawns into a wall /usage cannot
    // see (the fable-only exhaustion) — wall ⇒ the tier cools and the walk drops
    // a rung, exactly like the worker path (swarmTierProbe / resolveAvailableTierProbed).
    const panelModel = await resolveAvailableTierProbed(model, Date.now(), allowed)
    if (!panelModel) {
      return {
        decision: 'defer',
        verdicts: [],
        mustFix: 0,
        clean: 0,
        skippedForPark: true,
        reason: describeSpawnBlock({ kind: 'none-allowed' }, 'review deferred'),
      }
    }
    const mat = await withRebasedWorktree(projectPath, tip, targetRef, async (dir) => {
      // One controller for the whole panel: aborted in `finally` so any reviewer
      // still lingering after the others resolve is torn down (Promise.all already
      // awaited them, so this is teardown insurance, not an early-exit).
      const ac = new AbortController()
      try {
        const raws = await Promise.all(
          Array.from({ length: panel }, (_, i) => {
            // Lens mode: reviewer i runs lens i (its focused prompt); else identical.
            const lens = lenses ? lenses[i] : undefined
            return (customRun
              ? customRun({ dir, trunkRef, index: i + 1, signal: ac.signal, lens, model: panelModel })
              : defaultRunReviewer({ dir, trunkRef, index: i + 1, signal: ac.signal, timeoutMs: perReviewerTimeoutMs, model: panelModel, lens })
            )
              .then((out): { raw: string; vote: ReviewVote | null; note: string; abstainCause?: AbstainCause } => {
                const { raw, ended } = typeof out === 'string' ? { raw: out, ended: undefined } : out
                const verdict = extractReviewVerdict(raw)
                // A non-vote is ATTRIBUTED here, where both the transcript and the
                // runner's exit edge are still in hand (完了条件1) — one line past
                // this point only the cause label survives.
                return verdict.vote === null
                  ? { raw, ...verdict, abstainCause: classifyAbstainCause(raw, ended) }
                  : { raw, ...verdict }
              })
              // A reviewer that THREW (PTY spawn failed, etc.) is a non-vote, not a
              // panel failure — the tally is computed from whoever did vote.
              .catch(() => ({ raw: '', vote: null as ReviewVote | null, note: '', abstainCause: 'error' as AbstainCause }))
          }),
        )
        // QUOTA SENSOR (reviewer arm). The monitor's sensor only ever watches
        // WORKER screens, so a panel that walks into the wall first cools
        // nothing: every reviewer abstains, the tally reads "多数決つかず
        // [must-fix 0 / clean 0]", the defer streak burns to needs-human, and
        // the NEXT panel spawns on the same dry tier. Attribute it here instead.
        //
        // Two INDEPENDENT conditions must hold before a healthy tier is cooled —
        // an abstention that merely CONTAINS limit wording is not evidence, since
        // reviewing the rate-limit code itself (this file, swarmQuota.ts) puts the
        // verbatim notice in the diff, and a reviewer that quotes it while missing
        // its verdict marker would otherwise cool a live tier for 20 minutes:
        //   1. NOBODY on the panel voted. Every reviewer here ran on the SAME tier,
        //      concurrently — so one completed verdict is positive proof that tier
        //      still serves sessions. (If a reviewer raced in just before the wall,
        //      we simply don't cool this pass: the next panel finds the tier dry.)
        //   2. The abstention ENDS in the notice ({@link endsInRateLimit}) — the
        //      limit was that session's terminal utterance, not something it read
        //      and then kept working past.
        const anyVoted = raws.some((v) => v.vote !== null)
        const limitedRaw = anyVoted ? undefined : raws.find((v) => endsInRateLimit(v.raw))?.raw
        return {
          verdicts: raws.map((v, i): ReviewerVerdict => ({
            reviewer: i + 1,
            vote: v.vote,
            note: v.note,
            // Tag the lens so the tally can weight it and the log can name it (条件3).
            ...(lenses ? { lens: lenses[i].key } : {}),
            // Carry the abstention's cause into the verdict the tally summarizes.
            ...(v.abstainCause !== undefined ? { abstainCause: v.abstainCause } : {}),
          })),
          ...(limitedRaw !== undefined ? { limited: { raw: limitedRaw, tier: panelModel } } : {}),
        }
      } finally {
        try {
          ac.abort()
        } catch {
          /* best-effort */
        }
      }
    })
    if (!mat.ok) {
      if (mat.kind === 'conflict') {
        return { decision: 'integrate', verdicts: [], mustFix: 0, clean: 0, reason: 'rebase conflict (deferred to integrate)' }
      }
      return { decision: 'defer', verdicts: [], mustFix: 0, clean: 0, reason: 'could not prepare review worktree (deferred)' }
    }
    // A reviewer hit the tier's limit ⇒ cool that tier (so the next panel — and
    // every worker dispatch — steps down the ladder) and DEFER as an engine hold:
    // `skippedForPark` keeps this out of the MAX_REVIEW_DEFERS streak, because an
    // exhausted panel is not the card failing review. Never merge un-reviewed.
    if (mat.value.limited && isModelTier(mat.value.limited.tier)) {
      const { raw, tier } = mat.value.limited
      const until = markRateLimited(tier, {
        ptyText: raw,
        a5ResetsAt: a5CoolingHint(),
        graceMs: RATE_LIMIT_GRACE_MS,
        now: Date.now(),
      })
      return {
        decision: 'defer',
        verdicts: [],
        mustFix: 0,
        clean: 0,
        skippedForPark: true,
        reason: `reviewer hit the ${tier} usage limit — tier cooling until ${new Date(until).toISOString()}; review deferred`,
      }
    }
    const tallied = lenses
      ? tallyLensReview(mat.value.verdicts, lenses, reworkThreshold)
      : tallyReview(mat.value.verdicts, panel)
    // A defer carrying abstentions gets the sizing context appended — the log line
    // then reads "WHO abstained WHY (diff 36KB / budget 11min)", everything the
    // operator needs to see whether the budget, the model, or the diff is at fault.
    if (tallied.decision === 'defer' && tallied.verdicts.some((v) => v.vote === null)) {
      const kb = diffBytes === null ? '?' : String(Math.ceil(diffBytes / 1024))
      return {
        ...tallied,
        reason: `${tallied.reason} (diff ${kb}KB / budget ${Math.round(perReviewerTimeoutMs / 60_000)}min/reviewer)`,
      }
    }
    return tallied
  }
}

const defaultMoveToDone = async (projectPath: string, taskId: string): Promise<boolean> => {
  const res = await fetch(`${loopbackOrigin()}/api/project/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: projectPath, setColumn: [{ id: taskId, column: 'done' }] }),
    signal: AbortSignal.timeout(15_000),
  })
  return res.ok
}

const defaultMarkConflict = async (
  projectPath: string,
  taskId: string,
  value: boolean,
): Promise<boolean> => {
  const res = await fetch(`${loopbackOrigin()}/api/project/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: projectPath, setIntegrationConflict: [{ id: taskId, value }] }),
    signal: AbortSignal.timeout(15_000),
  })
  return res.ok
}

/** Tear down a landed worker's worktree, then delete its branch. FORCE-removes
 *  on purpose: cleanup runs ONLY after the branch's commits already landed on the
 *  trunk AND the card moved review→done, so the worktree holds nothing of value —
 *  only the worker's disposable scratch (untracked logs / build output a real
 *  `claude` session leaves behind). A NON-force remove would REFUSE on that
 *  scratch and strand the worktree on disk forever — exactly the zombie the
 *  autonomy loop must never leave. The committed work is on the trunk; there is
 *  no path by which that scratch can still matter. removeSwarmWorktree kills any
 *  live PTY in the tree first (by cwd); the engine ALSO kills it by id (killPty)
 *  so a symlinked-home cwd miss can't orphan the session. The branch is deleted
 *  once its worktree is gone (git refuses a checked-out branch). */
const defaultCleanup = async (
  projectPath: string,
  branch: string,
): Promise<{ removed: boolean; reason?: string }> => {
  let worktreeDir: string
  try {
    const uuid = await projectUUIDFromPath(projectPath)
    worktreeDir = join(centralWorktreesDir(uuid), swarmWorktreeDirName(branch))
  } catch (e) {
    return { removed: false, reason: errMsg(e) }
  }
  const res = await removeSwarmWorktree(projectPath, worktreeDir, { force: true })
  if (!res.removed) return { removed: false, reason: res.reason }
  // Branch ref deletion is best-effort: -D (we have external proof it landed on
  // the trunk; local `main` may be behind, so -d could wrongly refuse).
  if (isGitRepoRoot(projectPath)) {
    try {
      await execFile('git', ['branch', '-D', branch], {
        cwd: projectPath,
        timeout: 30_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
    } catch {
      /* branch already gone / never existed — the worktree teardown is what matters */
    }
  }
  return { removed: true }
}

/** The real, wired dep set. Exported so the live-git integration test can build
 *  on the REAL classify / integrate / cleanup / commit-count probes (overriding
 *  only the board + spawn + liveness seams with in-memory fakes) — so the engine's
 *  risky git path is exercised against a real repo, not only the unit fakes. */
/** Default consumption reader (card swarm-token): the worker PTY's
 *  `--session-id` (terminal pool, survives exit until sweep) names its session
 *  JSONL under the worktree's hyphenated dir — the same derivation
 *  transcript.ts owns. Null at every miss (PTY gone from the pool, no
 *  agentSessionId, JSONL absent/unreadable) — the promote site treats null as
 *  "skip the line", so this can never disturb the pass. */
const defaultReadConsumption = async (opts: {
  worktree: string
  terminalId: string
  sdkSessionId?: string
}): Promise<string | null> => {
  try {
    // Ask the pool this worker actually lives in. Reading the terminal pool with
    // an SDK worker's (empty) terminalId returns undefined, which read as "no
    // JSONL" and dropped every SDK worker out of the consumption journal.
    const sid = opts.sdkSessionId
      ? getSdkSession(opts.sdkSessionId)?.agentSessionId
      : getTerminal(opts.terminalId)?.agentSessionId
    if (!sid) return null
    return await readWorkerConsumptionLine(sessionJsonlPath(opts.worktree, sid))
  } catch {
    return null
  }
}

export const defaultDeps = (): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({
  fetchTasks: defaultFetchTasks,
  moveToDoing: defaultMoveToDoing,
  moveToReview: defaultMoveToReview,
  spawnWorker: defaultSpawnWorker,
  isAlive: (w) => runtimeOf(w).isAlive(w),
  countCommitsAhead: defaultCountCommitsAhead,
  readHeartbeat: defaultReadHeartbeat,
  recoverCard: defaultRecoverCard,
  recoverWorker: defaultRecoverWorker,
  lastOutputAt: (w) => runtimeOf(w).lastOutputAt(w),
  nudge: (w) => runtimeOf(w).nudge(w),
  escalate: (w, taskTitle) => defaultEscalate(w, taskTitle),
  recentOutput: defaultRecentOutput,
  sessionAgentActivityAt,
  sessionBackgroundTaskAt,
  raiseQuestion: openEscalation,
  readConsumption: defaultReadConsumption,
  fetchReview: defaultFetchReview,
  prepareTarget: defaultPrepareTarget,
  classify: classifyBranch,
  changedPaths: defaultChangedPaths,
  // The quality-floor gate (card 4e7f2151): lint + tsc + test green on EVERY branch
  // before it may auto-merge. tsc is the always-on primary; lint + the full test suite
  // are always-on too (appliesTo ⇒ true); swarm-safety stays diff-gated (B2 contained).
  // Order = cheapest-first / heaviest-last so a fast failure blocks before the full suite:
  // tsc → lint → swarm-safety (swarm branches only) → test.
  verify: makeVerify(tscCheck, [lintConditional, swarmSafetyConditional, testConditional]),
  // Lens panel (card 5f85d2f5): correctness/security/perf/regression specialists,
  // one reviewer each, so DISTINCT failure modes are covered (any lens's must-fix
  // reworks). Pre-a14329dc homogeneous majority remains available via
  // makeAdversarialReview() with no lenses.
  review: makeAdversarialReview({ lenses: DEFAULT_REVIEW_LENSES }),
  integrate: defaultIntegrate,
  acquireLock: (p) => acquireIntegrationLock(p, { label: 'engine' }),
  moveToDone: defaultMoveToDone,
  markConflict: defaultMarkConflict,
  cleanup: defaultCleanup,
  killPty: (w) => runtimeOf(w).kill(w),
  // instructRework is DELIBERATELY NOT WIRED (2026-08-01): the seam has had no
  // caller since the manager-only rework, and its terminalId shape cannot address
  // an SDK worker. See OrchestratorDeps.instructRework's @deprecated note.
  // Manager-only integration (2026-07-15): the engine wakes the commander instead of
  // merging. managerPresence decides WHICH response the desk needs (spawn / nudge /
  // nothing); wakeManager spawns, nudgeManager pokes a live one (2026-07-18).
  managerPresence: (p, now, echoUntil) => defaultManagerPresence(p, now, { echoUntil }),
  nudgeManager: defaultNudgeManager,
  notifyManagerReady: (p, notice) => defaultNotifyManagerReady(p, notice),
  // The DELIVERY evidence behind the stall check (2026-07-22) — read only once the queue
  // has already waited past MANAGER_INTEGRATION_STALL_MS, never on an ordinary tick.
  managerDeliveryAt: (p) => defaultManagerDeliveryAt(p),
  wakeManager: defaultWakeManager,
  // The unresponsive-desk escalation (2026-08-14): identify the desk's runtime, and —
  // for an SDK desk only — close it so the absent arm can seat a fresh one. Both are
  // read/called at most once per waiting episode, behind the spent nudge budget.
  managerDeskRuntime: defaultManagerDeskRuntime,
  recycleManagerDesk: defaultRecycleManagerDesk,
  worktreeExists: defaultWorktreeExists,
  deskOccupies: defaultDeskOccupies,
  // Auto-start preflight (card cf545637): the same claude readiness gate the manual ON
  // path uses, so the unattended background sweep never flips an engine `running` into a
  // spawn it knows will fail (no retry storm when claude is missing / logged out).
  preflight: claudeRunPreflight,
  // Escalation safety valve: persist an in-app notification + raise an OS toast.
  // Fire-and-forget with an internal catch so a notification fault never disturbs
  // a pass (it runs at the very end of runEnginePass anyway).
  notify: (n) => {
    void createSwarmFatalNotification(n).catch(() => {})
  },
})

// ── The monitor step (Card②) — advance + promote dispatched workers ──────────

const columnOf = (t: ProjectTask): string => t.boardColumn ?? (t.done ? 'done' : 'todo')

/** Fold a heartbeat's display-only fields (phase/note/at) onto a worker, or
 *  CLEAR them when the heartbeat is absent — so a freshly-probed worker reflects
 *  its LATEST heartbeat (a stale phase never lingers after the heartbeat went
 *  away). Applied on the 'doing'-column outcomes the monitor re-probes each pass;
 *  the early-return paths (card in review/done, card gone, card pulled back) keep
 *  the worker's prior fields verbatim — there is no fresh probe to fold there. */
const withHeartbeat = (w: OrchestratorWorker, hb: HeartbeatSign | null): OrchestratorWorker => ({
  ...w,
  phase: hb?.phase,
  note: hb?.note,
  heartbeatAt: hb?.at,
})

/** Re-examine every dispatched worker against the freshly-read board and rebuild
 *  engine.workers. For each worker:
 *   • already 'done' (promoted) → keep while its PTY lingers (so the UI shows the
 *     'done' dot); drop once it exits — that's when the slot truly frees. EXCEPT
 *     when its card is back in 'doing' (an EXTERNAL 差し戻し — Board API / UI drag,
 *     which never touches this in-memory roster): re-arm it (stage='running' +
 *     reworkAt=now) and fall through to the normal probe, so the worker's next
 *     FRESH completion sign re-promotes the card instead of it sinking forever.
 *   • its card vanished → keep counting it while ALIVE (don't free a slot for a
 *     still-running PTY), drop a dead orphan.
 *   • its card left 'doing' to review/done (us or a human) → treat as done.
 *   • its card is back in todo/blocked (a human pulled it) → don't fight it; keep
 *     while alive (reconcile re-moves a todo card), drop if dead.
 *   • its card is in 'doing' → PROBE (commits + heartbeat + liveness) and judge:
 *     promote doing→review when conservatively DONE; else, if the PTY EXITED with
 *     nothing to promote, recover the crash (tear down + re-home); else, if it is
 *     ALIVE but has gone SILENT (no heartbeat AND no PTY output for STALL_SILENCE_MS),
 *     try to un-stick it with an Enter nudge and, when nudges are spent, RECLAIM it
 *     through the same crash-recovery path; else update the stage and keep it.
 *  Pure-decision (classifyWorker / classifyStall) + guarded IO; never throws. `now`
 *  is injected (no clock here) so the stall escalation is unit-tested deterministically. */
const monitorWorkers = async (
  engine: ProjectEngine,
  deps: OrchestratorDeps,
  byId: Map<string, ProjectTask>,
  now: number,
): Promise<void> => {
  const next: OrchestratorWorker[] = []
  const sinceStart = (iso: string): number => {
    const t = Date.parse(iso)
    return Number.isFinite(t) ? now - t : Number.POSITIVE_INFINITY
  }

  // Recover a LOST worker — its `claude` PTY died/was killed (reason 'crash') OR it
  // stayed silent past every nudge (reason 'stall'). Tear down its worktree + PTY so
  // nothing zombies on disk (the gap the old monitor left: it freed the slot but
  // stranded the worktree AND left the card in 'doing' forever), and — when WE still
  // own its card (still in 'doing') — return it to the board ('todo' to retry,
  // 'blocked' to park; see recoveryColumn). A card a human already moved out of
  // 'doing', or deleted, is left to the human (its worktree is still cleaned).
  // Returns true iff the worker must be KEPT (the card move was KEPT/failed and will
  // be retried next pass — a dead/reclaimed PTY holds no live slot, it only carries
  // the pending retry). Never throws.
  const recoverLost = async (
    w: OrchestratorWorker,
    card: ProjectTask | undefined,
    probe: WorkerProbe,
    reason: WorkerRecoveryReason = 'crash',
    /** For 'integration-wait' ONLY: WHICH of the three shapes this stop is (see the
     *  ceiling check). One stop writes TWO journal lines — the ceiling's own line
     *  and this recovery line — and 「両方が同じ事実を言っていること」 is the
     *  requirement (02章 §5.6). Deriving the verb from `reason` alone broke it: the
     *  ceiling line said 「上限の原因は待ち時間であって作業ではない」 while this one
     *  still said 「差し戻し後の再作業で作業上限に到達」, one line below. Undefined
     *  keeps the re-worked wording (a caller that does not know cannot be one of the
     *  ceiling shapes). */
    shape?: 'rework' | 'capped-wait' | 'work',
  ): Promise<boolean> => {
    // The 'integration-wait' verb must describe what ACTUALLY happened, not what
    // the reason is named after. Two shapes reach it (02章 §5.6): 差し戻し後の
    // 再作業で予算を使い切った, and 統合待ちが控除上限を超えただけで再作業はして
    // いない. Writing 「統合待ちのまま」 — or narrating a re-work that never
    // happened — reproduces the 2026-07-18 misreading in a new shape, which is the
    // failure this whole reason exists to prevent.
    const verb =
      reason === 'stall'
        ? 'stalled — reclaimed'
        : reason === 'runaway'
          ? 'runaway (hit execution-time limit) — stopped'
          : reason === 'integration-wait'
            ? shape === 'capped-wait'
              ? '統合待ちが控除上限を超過 — 停止(暴走でも再作業超過でもない: ready 済みの成果がブランチにある)'
              : shape === 'work'
                ? '実作業が作業上限に到達 — 停止(待ち時間が原因ではない・暴走でもない: ready 済みの成果がブランチにある)'
                : '差し戻し後の再作業で作業上限に到達 — 停止(暴走ではない: ready 済みの成果がブランチにある)'
            : reason === 'rate-limit'
              ? 'quota-stopped — requeued'
              : reason === 'question'
                ? 'free-text question unanswered too long — parked'
                : 'lost'
    let teardown: {
      removed: boolean
      reason?: string
      /** Refused while a desk is still live there — retried, not given up on. */
      stillOccupied?: boolean
      wip?: WipCommitResult
      exitInfo?: { code: number | null; signal?: number }
    } = { removed: false }
    try {
      teardown = await deps.recoverWorker({
        projectPath: engine.path,
        worktree: w.worktree,
        terminalId: w.terminalId,
        // Carried so the teardown can actually STOP an SDK worker — its
        // terminalId is empty, so without this the kill is a silent no-op and
        // the worktree is removed under a running claude.
        ...(w.sdkSessionId ? { sdkSessionId: w.sdkSessionId } : {}),
        reason, // rides into the salvage commit's message (commitWipBeforeTeardown)
        // A kept RECOVERY move means an EARLIER pass already ran this very teardown
        // (recoverWorker runs before the Board write that got kept), so the PTY we
        // are about to inspect was killed by US — suppress the exit record rather
        // than attribute our own kill to the worker.
        //
        // ⚠ MUST be the intent, not `stuckMoves.has()` (2026-07-27 review): the map
        // has a SECOND writer — the promote path records intent 'review' when a
        // doing→review write is kept, and NO teardown ran there. Keying on mere
        // presence would drop the cause of death of a worker whose review move was
        // kept and which then genuinely died on its FIRST reclaim.
        alreadyTornDown: TEARDOWN_INTENTS.has(engine.stuckMoves.get(w.taskId)?.intent ?? ''),
      })
    } catch {
      /* reported via teardown.removed=false below */
    }
    // Set when we give up on a refused teardown: the card must be PARKED, not
    // requeued, because a live claude may still hold the old worktree.
    let forceBlocked = false
    // ── THE REFUSAL IS A "TRY AGAIN", NOT A "GIVE UP" (2026-08-04) ─────────
    // removeSwarmWorktree refuses while a desk is still live in the directory,
    // and its comment promises the caller retries. No caller did: the card was
    // re-homed and the worker dropped from engine.workers AND roster.json, so a
    // still-running claude was left in a worktree nobody owned. On the SDK pool
    // that also pins its slot forever — sweepClosedSessions never reaps a session
    // whose iterator has not returned — so every later worker silently falls back
    // to a PTY. Nothing retried: the orphan sweep skips a directory git still
    // lists as a worktree, and the janitor never touches worktree bodies.
    //
    // So: keep the worker and ask again next pass, up to a bound. The card is NOT
    // re-homed while we wait (it is still 'doing' and its worker still exists);
    // past the bound we fall through to the old behaviour and say so at 'error'
    // level, because a slot held forever is its own failure.
    if (teardown.stillOccupied === true) {
      const retries = (engine.teardownRetries ??= new Map())
      const tries = (retries.get(w.taskId)?.tries ?? 0) + 1
      retries.set(w.taskId, { tries, reason })
      if (tries <= MAX_TEARDOWN_RETRIES) {
        logLine(
          engine,
          'warn',
          `worker ${verb} — 撤収を保留(${tries}/${MAX_TEARDOWN_RETRIES}): ${w.branch} の作業場でまだ claude が動いています。次のパスでやり直します`,
          'cleanup',
        )
        return true // keep it in the roster; the next pass tears down again
      }
      logLine(
        engine,
        'error',
        `worker ${verb} — ${w.branch} の作業場で claude が ${tries} 回連続して止まりませんでした。` +
          `作業場を残したままワーカーを名簿から外し、カードは「保留」へ退避します。` +
          `Terminal タブでその作業場のセッションを閉じてください`,
        'cleanup',
      )
      // PARK IT, never requeue. The old claude may still be working in the old
      // worktree; a requeue would dispatch a SECOND worker on a fresh branch for
      // the same card — two claudes on one card, which is the twin class this
      // engine spends most of its guards preventing. Blocked is where a human
      // looks, and that is exactly what this state needs.
      forceBlocked = true
    }
    engine.teardownRetries?.delete(w.taskId)
    const keptNote = teardown.removed ? '' : ` · worktree kept (${teardown.reason ?? '?'})`
    // Surfaces the PTY's OWN exit code/signal for a 'crash' recovery — this is the
    // only place a dead worker's death cause is ever recorded (in-memory TerminalInfo
    // is gone once the session is swept), so without it "worker crashed" carries no
    // diagnosable trace of WHY (e.g. 137/SIGKILL ⇒ OOM-killed vs a clean non-zero exit).
    const exitNote =
      teardown.exitInfo !== undefined
        ? ` · exitCode=${teardown.exitInfo.code ?? 'null'}${teardown.exitInfo.signal !== undefined ? ` signal=${teardown.exitInfo.signal}` : ''} (${classifyWorkerExit(teardown.exitInfo.code, teardown.exitInfo.signal)})`
        : ''
    // SALVAGE SURFACED (2026-07-12 全損): the reclaimed worktree held uncommitted
    // work and it was committed to the worker's branch instead of being destroyed.
    // The commander MUST see this — a re-dispatch of the same card branches fresh,
    // so that commit is the only remaining trace of the work.
    const wipNote = teardown.wip?.committed ? ` · WIP保全 ${teardown.wip.reason ?? 'commit'}` : ''
    if (teardown.wip?.committed) {
      logLine(
        engine,
        'warn',
        `worker reclaimed with UNCOMMITTED work — auto-saved as a WIP commit (${teardown.wip.reason ?? 'commit'}) on ${w.branch}: 未検証のまま保全。統合前にレビューを (理由: ${reason})`,
      )
    }

    // Only re-home a card STILL in 'doing' (ours to move). A deleted card has
    // nothing to move; a human-moved one is the human's now — clean, don't fight.
    if (!card || columnOf(card) !== 'doing') {
      engine.recoveries.delete(w.taskId)
      clearKeptMove(engine, w.taskId) // card left 'doing' (human/deleted) — nothing stuck
      logLine(
        engine,
        'info',
        `worker ${verb} — slot freed: ${w.branch} (${shorten(w.taskTitle)})${keptNote}${wipNote}${exitNote}`,
        'routine',
      )
      return false
    }

    const requeues = engine.recoveries.get(w.taskId) ?? 0
    // COUNT THE SALVAGE COMMIT (2026-07-29). `probe` was taken BEFORE the
    // teardown, so it cannot know that the teardown just added a WIP commit to
    // this worker's branch. recoveryColumn's twin fix keys on exactly that number
    // — `commitsAhead > 0 ⇒ blocked` — because a card whose branch already holds
    // commits must NOT go back to `todo`, where the next dispatch mints a SECOND
    // worktree/branch for the same work and orphans the first (the twin class,
    // 0723). Feeding it the stale zero re-opened that door for precisely the
    // workers whose branches we had just written to. The salvage is only counted
    // when it landed on a real branch (`wip.branch`) — a detached-HEAD attempt is
    // reported as `failed` and adds nothing reachable.
    const salvaged = teardown.wip?.committed && teardown.wip.branch ? 1 : 0
    const probeForColumn = salvaged
      ? { ...probe, commitsAhead: (probe.commitsAhead ?? 0) + salvaged }
      : probe
    let col = forceBlocked
      ? ('blocked' as const)
      : recoveryColumn(probeForColumn, requeues, RECOVER_MAX_REQUEUE, reason)
    let moved = false
    try {
      // 'review' rides moveToReview, not recoverCard: it is a forward promotion of
      // a branch that HAS commits, and moveToReview is the seam that also stamps
      // the branch on the card (the durable handle the integration stage merges).
      moved =
        col === 'review'
          ? await deps.moveToReview(engine.path, w.taskId, w.branch)
          : await deps.recoverCard(engine.path, w.taskId, col)
    } catch {
      moved = false
    }
    // Board write kept — bump the stuck-move tracker. Past the retry budget,
    // ESCALATE a 'todo' requeue to 'blocked' (blocked退避): a card whose recovery
    // write keeps failing must NOT zombie in 'doing' ("dead なのに doing"), so we
    // park it for a human instead of gently requeueing it forever. (If the write
    // ITSELF keeps failing the card can't move at all — the 'move-stuck' anomaly
    // then surfaces it; see detectAnomalies.)
    //
    // 'integration-wait' is EXEMPT from that escalation: parking a ready worker's
    // card in the owner's column is precisely the harm this reason exists to
    // prevent, and a kept write is the engine's problem, not the owner's. It stays
    // in 'doing' and retries (the 'move-stuck' anomaly surfaces it) — never blocked.
    if (!moved) {
      // Record WHICH recovery is stuck. 'recover-review' is load-bearing, not
      // cosmetic: the next pass reads it back to retry this recovery AS ITSELF
      // (see the !alive branch in monitorWorkers). Without it the retry decays
      // into a plain 'crash' recovery, whose stale `ready` heartbeat rule parks
      // the card in 'blocked' — reintroducing the 2026-07-18 harm through the
      // back door whenever a Board write happens to fail.
      const intent = reason === 'integration-wait' ? 'recover-review' : 'recover'
      // Carry the SHAPE across the retry too, not just the intent. The retry
      // rebuilds this recovery from scratch on a later pass; with only the intent
      // restored it fell back to the default 「差し戻し後の再作業」 verb, so a
      // 'capped-wait' / 'work' stop logged 「再作業 0m」 and then contradicted
      // itself one line later (02章 §5.6 forbids exactly that).
      const attempts = recordKeptMove(engine, w.taskId, intent, w.branch, w.taskTitle, shape)
      if (attempts >= MOVE_STUCK_MAX_RETRIES && col !== 'blocked' && reason !== 'integration-wait') {
        col = 'blocked'
        try {
          moved = await deps.recoverCard(engine.path, w.taskId, 'blocked')
        } catch {
          moved = false
        }
      }
    }
    if (!moved) {
      // Still kept — KEEP the (dead) worker so the next pass retries the move;
      // until it lands the card stays in 'doing' (selectDispatch's column gate
      // skips it, so no re-dispatch). A dead worker holds no live slot. The
      // move-stuck anomaly now surfaces this for the owner (more than a warn).
      logLine(
        engine,
        'warn',
        // ${exitNote} MUST be here too, not only on the two terminal lines
        // (2026-07-27 review). This is the FIRST pass of a reclaim whose Board write
        // was kept, and it is the ONLY pass that still sees the worker's real exit:
        // every later pass is vetoed by `alreadyTornDown`, which cannot tell "we
        // killed a live PTY last pass" (stall — veto correct) from "we found an
        // already-dead one" (crash — the exit is the WORKER'S). Dropping the note
        // here loses a genuine crash's cause of death permanently, in precisely the
        // kept-write scenario that veto exists for.
        `worker ${verb} but card move kept (will retry): ${w.branch} (${shorten(w.taskTitle)})${exitNote}`,
      )
      return true
    }
    clearKeptMove(engine, w.taskId) // the recovery write landed — forget the stuck tracking
    if (col === 'review') {
      // The ready-worker recovery promote ('integration-wait') is ALSO the
      // engine carrying a card into review — record it in the landed ledger
      // like the ordinary promote. This path's journal line has no 'promote'
      // kind (it logs as a reclaim), so the in-memory KPI pairing misses it;
      // the durable ledger must not. Fail-open by contract.
      await recordPromoted(engine.path, { taskId: w.taskId, title: w.taskTitle, branch: w.branch })
    }
    // A 'rate-limit' requeue is ORTHOGONAL to the crash/stall retry budget: it is a
    // transient WAIT, not a failed attempt, so it must neither consume that budget
    // (else a real later crash would skip its retries) nor be capped by it (a
    // limited account self-heals — looping todo↔doing until it lifts is fine, no
    // work is lost). Only crash/stall (and the budget-driven cases) touch it.
    if (reason !== 'rate-limit') {
      if (col === 'todo') engine.recoveries.set(w.taskId, requeues + 1)
      // Parked ('blocked') — a human requeue starts fresh. Promoted ('review', the
      // integration-wait path) — the card moved FORWARD with work in hand, so it
      // clears its budget exactly like an ordinary promote does.
      else engine.recoveries.delete(w.taskId)
    }
    // warn level + structured kind: 'crash' for a dead PTY, 'stall' for a reclaimed
    // silent one; runaway / rate-limit / permission ride as uncategorized-but-shown
    // events (no UI chip exists for them yet — the message carries the reason). The
    // abnormal counterpart of a 'routine' slot-free, surfaced (not hidden) so the
    // owner sees the recovered worker + where its card went + WHY.
    logLine(
      engine,
      'warn',
      `worker ${verb} — card → ${col}: ${w.branch} (${shorten(w.taskTitle)})${keptNote}${wipNote}${exitNote}`,
      reason === 'stall' ? 'stall' : reason === 'crash' ? 'crash' : undefined,
    )
    return false
  }

  /** Is there ACTUALLY something delivered on this worker's branch — commits, or
   *  its own ready heartbeat? Corroborates the "card is in review" claim before it
   *  is recorded as `readyAt` (see the early-continue). Both reads are swallowed to
   *  the conservative answer: a transient git/FS failure returns false, which only
   *  DEFERS the stamp to the next pass — it can never mislabel a stop, because the
   *  ceiling reads `readyAt` and not these signals. Only called when the answer can
   *  still change something (a worker that already has `readyAt` is not re-probed),
   *  so this adds no per-pass IO for the common case of a card sitting in review. */
  const hasDeliverable = async (w: OrchestratorWorker): Promise<boolean> => {
    if (w.readyAt) return true // already recorded — never re-probe, never revoke
    try {
      // `null` (git could not answer) is NOT evidence — same as 0 here. This
      // read only DEFERS a `readyAt` stamp to the next pass, so "no proof yet"
      // is the harmless direction (unlike recoveryColumn, where it is not).
      if (((await deps.countCommitsAhead(engine.path, w.branch)) ?? 0) > 0) return true
    } catch {
      /* conservative: no evidence */
    }
    try {
      return (await deps.readHeartbeat(engine.path, w.branch))?.ready === true
    } catch {
      return false
    }
  }

  for (let w of engine.workers) {
    if (!engine.running) {
      next.push(w) // a stop mid-pass: keep the rest untouched
      continue
    }
    const alive = deps.isAlive(w)
    const card = byId.get(w.taskId)

    // ── A TEARDOWN ALREADY IN PROGRESS FINISHES ITSELF (2026-08-04) ─────────
    // This worker was reclaimed on an earlier pass and its worktree removal was
    // REFUSED (a desk is still live there), so it was kept on the roster to be
    // retried. Retry the SAME recovery and skip every detection arm below.
    //
    // Falling through instead re-ran the detectors against a worker we had
    // already decided about, and they re-fired their ONE-SHOT side effects,
    // because each arm clears its own trigger state before calling recoverLost:
    //   • exec-timeout pushes `engine.pendingFatal` BEFORE the recovery, and that
    //     is the edge lane — "fire each exactly once, then drain" — so one stop
    //     produced up to MAX_TEARDOWN_RETRIES+1 identical bells and OS toasts,
    //     and the later ones quoted 「rate-limit待ち 0分 / 統合待ち 0分」 because
    //     the spans had been deleted: contradictory numbers about one event.
    //   • the rate-limit arm (hold era, pre-0813) called endRateLimitHold
    //     first, so the next pass re-entered "first sighting" and called
    //     markRateLimited again — a real write into the quota cooling table —
    //     and restarted the grace clock. (The hold died 2026-08-13. The
    //     fail-fast quota arm still marks BEFORE recovering — a refused board
    //     write must not cost the cooling write, or dispatch relaunches into
    //     the wall — so a kept-move retry CAN re-mark the table next pass.
    //     Accepted: markRateLimited re-marking merely refreshes the same
    //     cooling window, and the kept-move case is the rare one.)
    //   • the question arm deletes questionWaits/questionRaised, so the retry
    //     waited another QUESTION_GRACE_MS.
    // The last two also meant "retry next pass" silently became "retry next grace
    // window" while the worker held a dispatch slot.
    const pendingTeardown = engine.teardownRetries?.get(w.taskId)
    if (pendingTeardown) {
      if (await recoverLost(w, card, { alive, commitsAhead: 0, heartbeat: null }, pendingTeardown.reason))
        next.push(w)
      continue
    }

    // 外部差し戻しの観測(Board API / UI ドラッグ): roster は 'done'(このカードは一度
    // review へ昇格済み)なのにカードが 'doing' に戻っている。エンジン自身の integrate
    // 差し戻しはその場で stage='running' + reworkAt を立て直すのでこのシェイプを残さない
    // — ここに来るのはエンジンの外(司令官の POST /api/project/tasks {rework} / UI の
    // review→doing ドラッグ)だけ。従来は直下の stage:'done' 早期 continue が先に効いて
    // 永久スキップされ、worker が直して ready を打ち直してもカードが doing に沈み続けた
    // (2026-07-13 実測: 55分放置しても昇格せず)。stage='running' + reworkAt=now(Board の
    // rework はカードに差し戻し時刻を記録しないので観測時刻)で再武装し、通常の監視へ
    // 落とす — 差し戻し前の古い readyToMerge:true では re-promote されず(下の freshSign
    // ガード)、reworkAt より新しい心拍が来て初めて再昇格する。
    if (w.stage === 'done' && card && columnOf(card) === 'doing') {
      // 統合待ちの終わり — BANK the idle span before the worker resumes working, so
      // the execution ceiling below judges WORK, not queue latency. Without this the
      // whole wait rides on as if it were work: on 2026-07-18 a worker ready at 04:18
      // was 差し戻し'd at 04:46 and stopped one pass later as "runaway 91m", its
      // worktree destroyed and its card parked in 'blocked'. (endIntegrationWait.)
      endIntegrationWait(engine, workerKey(w), now)
      w = { ...w, stage: 'running', reworkAt: new Date(now).toISOString() }
      logLine(
        engine,
        'info',
        `Board 側の差し戻し(review→doing)を観測 — worker を再作業中へ: ${w.branch} (${shorten(w.taskTitle)})`,
      )
      // …AND TELL THE WORKER. Re-arming above is bookkeeping the worker never
      // sees: a commander-initiated rework speaks to the worker itself, but this
      // branch fires precisely when the move came from OUTSIDE the engine — the
      // owner's UI drag — and then NOBODY had told the worker (2026-08-03,
      // measured: an SDK worker sat working toward its invalidated ready while
      // the owner's paste-task had no terminalId to land on and a restart was
      // refused by the occupancy guard BECAUSE the worker was alive). One turn
      // through the both-runtimes conduit closes it. Awaited (a rework is rare
      // and once-per-observation — this branch flips stage, so it cannot refire
      // next pass); a false/throw is a WARN, not a retry loop: the worker's
      // ceiling and nudge machinery still stand behind it, and the commander
      // can always speak by hand.
      const delivered = await (deps.deliverReworkNotice ?? deliverAnswerToWorker)(
        w,
        engine.path,
        `【差し戻し】このカードは Board で review→doing に戻されました。以前の ready は無効です。` +
          `カードの notes と差し戻し理由を Board API で読み直し、指摘に対応してコミットし、` +
          `完了したら改めて心拍 ready(bash ~/.claude/swarm-beat.sh done true)を打って停止してください。`,
      ).catch(() => false)
      logLine(
        engine,
        delivered ? 'info' : 'warn',
        delivered
          ? `差し戻しを worker の卓に伝えました: ${w.branch}`
          : `差し戻しを worker の卓に伝えられませんでした(卓が応答しない/書き込み不可) — worker は次の心拍・催促で拾われます: ${w.branch}`,
      )
    }

    // Already promoted, or the card already sits in review/done → terminal. Keep
    // showing 'done' while the PTY lingers; an exit is what frees the slot.
    //
    // "DELIVERED" IS A COLUMN FACT, NOT A WRITE RECEIPT (2026-07-18). The ledger
    // below (`readyAt` + the 統合待ち clock) is bound to WHERE THE CARD IS, not to
    // whose write moved it there. Stamping it only inside the engine's own promote
    // branch left the commander's route off the books entirely — and that route is
    // the COMMON one: og-manage instructs the commander to `move <id> review` as
    // soon as a worker reports READY, so the hand-move usually beats the promote
    // tick. Such a worker went stage:'done' with NO readyAt and NO wait clock, and
    // the next 差し戻し dropped it straight back into the original harm ("runaway
    // 91m" → worktree destroyed → card parked in 'blocked'). Binding it to the
    // column puts promote-moved and hand-moved cards on ONE ledger. (The 差し戻し
    // side above already observes external moves; only this BEGIN side was
    // asymmetric.) 'done' counts too: a card the commander advances straight past
    // review is no less delivered, and a later rework of it must not read as 暴走.
    const delivered = !!card && (columnOf(card) === 'review' || columnOf(card) === 'done')
    if (w.stage === 'done' || delivered) {
      if (alive) {
        // THE COLUMN IS A CLAIM, NOT A RECEIPT (2026-07-19). Anyone can drag a card
        // to 'review'; that says a human BELIEVES work was delivered. `readyAt` is
        // load-bearing in the other direction — it is the sole thing standing
        // between a worker and the 暴走 label — so stamping it on the claim alone
        // makes the ceiling FAIL OPEN: park an untouched card in review once, drag
        // it back, and that worker can never be called a 暴走 again. It would then
        // run for hours with zero commits, escape the 'blocked' park, burn an empty
        // branch into the card, and tell the owner 「統合可能な成果を一度出して
        // います」 — a flat untruth, which is the very harm this card exists to end.
        //
        // So corroborate the claim before recording it: SOMETHING must exist —
        // commits on the branch, or the worker's own ready heartbeat. This is a
        // NECESSARY condition, not a sufficient one; `commitsAhead` alone was tried
        // as a witness AT THE CEILING and rightly reverted (workers are told to
        // commit before declaring ready, so commits are the normal state of a
        // working worker — see the ceiling check). Requiring it HERE is safe in a
        // way that trusting it there was not, because a failed read merely defers
        // the stamp to the next pass instead of mislabelling a stop.
        const corroborated = delivered && (await hasDeliverable(w))
        if (corroborated) beginIntegrationWait(engine, workerKey(w), now)
        const readyAt = corroborated ? (w.readyAt ?? new Date(now).toISOString()) : w.readyAt
        next.push({ ...w, stage: 'done', readyAt })
      } else logLine(engine, 'info', `done worker closed — slot freed: ${shorten(w.taskTitle)}`, 'routine')
      continue
    }

    // Card deleted out from under the worker → keep counting a live orphan (don't
    // over-spawn against a running PTY); a dead one's worktree is torn down (no
    // card to re-home — recoverLost just cleans + frees the slot).
    if (!card) {
      if (alive) next.push(w)
      else if (await recoverLost(w, undefined, { alive, commitsAhead: 0, heartbeat: null })) next.push(w)
      continue
    }

    // A human pulled the card back to todo/blocked → don't promote; reconcile (a
    // todo card) re-homes it. Keep while alive; a dead one's worktree is torn down
    // (recoverLost leaves the human's column alone, just cleans + frees the slot).
    if (columnOf(card) !== 'doing') {
      if (alive) next.push(w)
      else if (await recoverLost(w, card, { alive, commitsAhead: 0, heartbeat: null })) next.push(w)
      continue
    }

    // The monitored state: card in 'doing'. Probe the completion signals.
    // `commitsAhead` keeps its numeric contract for the promote gate; whether the
    // count is UNKNOWN travels beside it, because the two consumers want opposite
    // fallbacks (see defaultCountCommitsAhead and recoveryColumn).
    let commitsAhead = 0
    let commitsUnknown = false
    let heartbeat: HeartbeatSign | null = null
    try {
      const counted = await deps.countCommitsAhead(engine.path, w.branch)
      if (counted === null) commitsUnknown = true
      else commitsAhead = counted
    } catch {
      // A THROW is also "could not answer" — the default never throws, but an
      // injected dep might, and reading that as "no work" is the destructive way.
      commitsUnknown = true
    }
    try {
      heartbeat = await deps.readHeartbeat(engine.path, w.branch)
    } catch {
      /* treat as null */
    }

    let { promote, stage } = classifyWorker(
      { alive, commitsAhead, commitsUnknown, heartbeat },
      sinceStart(w.startedAt) >= STARTUP_GRACE_MS,
    )

    // 差し戻し後の re-promote 抑制(re-promote race 対策): a worker the integrate stage just sent
    // review→doing carries `reworkAt`; its heartbeat FILE still says readyToMerge:true (the engine
    // can't clear it), so without this guard the very next pass would re-promote it on that STALE
    // sign — and the same-tip verify would skip-RED → 差し戻し again, burning the whole rework budget
    // by wall-clock (~30s) before the worker can possibly fix anything. Until the worker posts a
    // FRESH completion sign (a heartbeat strictly newer than the 差し戻し), DROP the promote and treat
    // it as ordinary in-flight work — falling THROUGH (deliberately not `continue`) so the
    // stall/runaway monitor below still watches it: a worker that hangs AFTER a 差し戻し must still be
    // nudged/reclaimed, never silently parked in doing forever. A worker that genuinely fixed +
    // re-reported beats anew → promote runs → its NEW tip is verified (green ⇒ land).
    if (promote && w.reworkAt) {
      const hbAtMs = heartbeat?.at ? Date.parse(heartbeat.at) : Number.NaN
      const reworkAtMs = Date.parse(w.reworkAt)
      const freshSign = Number.isFinite(hbAtMs) && Number.isFinite(reworkAtMs) && hbAtMs > reworkAtMs
      if (!freshSign) {
        promote = false
        stage = 'running' // re-working after a 差し戻し — not 'done'
      }
    }

    if (promote) {
      let moved = false
      try {
        moved = await deps.moveToReview(engine.path, w.taskId, w.branch)
      } catch {
        moved = false
      }
      if (moved) {
        logLine(engine, 'info', `promoted to review: ${shorten(w.taskTitle)} → ${w.branch}`, 'promote')
        // 着地台帳 (swarm-landed.json): the DURABLE twin of that promote line —
        // the journal ring dies with the process, the weekly landed KPI must
        // not. Awaited (one small JSON write) and fail-open by contract, so a
        // broken disk can never keep the promote (or the pass) from completing.
        await recordPromoted(engine.path, { taskId: w.taskId, title: w.taskTitle, branch: w.branch })
        // Consumption meter (card swarm-token): the done moment is the one point
        // the card's cost is complete, so record its one-line summary here. No
        // structured kind — the line has no metrics counter (classifyMetricEvent
        // maps it to null) and stays visible in the journal. Await keeps journal
        // order deterministic (a worker's JSONL is a few MB — tens of ms); every
        // failure path resolves null / is swallowed, so an unreadable JSONL can
        // never keep a promote (or the pass) from completing.
        if (deps.readConsumption) {
          try {
            const line = await deps.readConsumption({
              worktree: w.worktree,
              terminalId: w.terminalId,
              ...(w.sdkSessionId ? { sdkSessionId: w.sdkSessionId } : {}),
            })
            if (line) logLine(engine, 'info', `consumption: ${line} — ${shorten(w.taskTitle)}`)
          } catch {
            /* fail-safe: no consumption line, promote already landed */
          }
        }
        engine.recoveries.delete(w.taskId) // succeeded — drop any prior retry budget
        clearKeptMove(engine, w.taskId) // the review move landed — forget any stuck tracking
        // The worker is now READY and IDLE — start its 統合待ち clock so the wait for
        // the commander is credited back rather than charged to it as work, and mark
        // that it has DELIVERED (readyAt, set once) so the execution ceiling can never
        // label it a 暴走 or park its card in 'blocked'. (2026-07-18.)
        beginIntegrationWait(engine, workerKey(w), now)
        const readyAt = w.readyAt ?? new Date(now).toISOString()
        // Keep a lingering PTY as 'done' (UI shows it; its exit frees the slot);
        // a worker that already exited has nothing left to count. Clear reworkAt — the card
        // left doing for review, so the re-promote suppression is no longer relevant.
        if (alive) next.push(withHeartbeat({ ...w, stage: 'done', reworkAt: undefined, readyAt }, heartbeat))
      } else {
        // Board write kept — keep the worker (card still in 'doing') and retry next
        // pass; don't claim 'done' until the move lands. Track it so a worker that
        // FINISHED but can't advance (a "done worker stuck in doing") surfaces as a
        // 'move-stuck' anomaly past the budget instead of a silent warn loop.
        recordKeptMove(engine, w.taskId, 'review', w.branch, w.taskTitle)
        logLine(engine, 'warn', `review move kept (will retry): ${shorten(w.taskTitle)}`)
        // DELIVERY IS ESTABLISHED HERE EVEN THOUGH THE WRITE FAILED. We only reach
        // this branch with promote === true — the engine's own strongest statement
        // that this worker delivered (commits ahead + a heartbeat newer than any
        // 差し戻し). Withholding `readyAt` until the Board write lands repeats the
        // very mistake MF-1 fixed on the hand-move path: `countCommitsAhead` /
        // `readHeartbeat` failures are swallowed to 0/null, so ONE transient read
        // flips promote to false on a later pass and the worker then meets the
        // ceiling with no `readyAt` → labelled 暴走 → card parked in 'blocked'.
        // (Reproduced.) The wait clock stays closed: the card really is still in
        // 'doing', so this worker is not idle in 統合待ち and must keep being
        // charged for the time — only the "has EVER delivered" fact is recorded.
        next.push(
          withHeartbeat(
            { ...w, stage: 'running', readyAt: w.readyAt ?? new Date(now).toISOString() },
            heartbeat,
          ),
        )
      }
      continue
    }

    // Not done. A dead worker with nothing to promote is LOST — recover it: tear
    // its worktree/PTY down and return its card to the board ('todo' to retry,
    // 'blocked' to park) instead of stranding it in 'doing' as the old conservative
    // default did (a zombie card no worker was draining, plus a leaked worktree). A
    // crash still never FAKES progress — recoveryColumn sends a CRASH to todo or
    // blocked, never to review. ('review' is reachable there, but only for the
    // 'integration-wait' reason below, where the branch really does hold delivered
    // work — not from this path.)
    // recoverLost logs the recovery with the 'crash' kind so the owner sees the
    // fallen-over worker (not buried as 'routine') — the observability the anomaly
    // stage and the crash log give, now with the teardown + requeue that fixes it.
    if (!alive) {
      // A KEPT integration-wait recovery must retry as itself. Its PTY is already
      // gone (torn down when the ceiling fired), so without this it would arrive
      // here as an ordinary 'crash' — and recoveryColumn's "heartbeat ready ⇒
      // blocked" rule would park the card in the owner's column on the stale
      // pre-差し戻し heartbeat. Exactly the 2026-07-18 harm, one Board-write
      // failure away. (recordKeptMove stamps the intent; pruneStuckMoves drops it
      // the moment the card leaves 'doing'.)
      const pending = engine.stuckMoves.get(w.taskId)
      const pendingReason: WorkerRecoveryReason =
        pending?.intent === 'recover-review' ? 'integration-wait' : 'crash'
      // Restore the SHAPE as well. Passing only the reason left `shape` undefined,
      // which defaults to the 「差し戻し後の再作業」 verb — so a retried
      // 'capped-wait' / 'work' stop invented a re-work in its recovery line.
      if (
        await recoverLost(
          w,
          card,
          { alive, commitsAhead, commitsUnknown, heartbeat },
          pendingReason,
          pendingReason === 'integration-wait' ? pending?.shape : undefined,
        )
      )
        next.push(w)
      continue
    }

    // ── Card 4880e9c6: ALIVE, 'doing', not promoted — decide WHY it isn't
    // progressing. A RUNAWAY (overran the time ceiling) is stopped regardless of
    // liveness. Everything else is judged ONLY for a worker the stall detector
    // ALREADY considers SILENT: a worker still streaming output or beating is
    // plainly working and is NEVER touched, whatever text sits on its screen — the
    // load-bearing false-kill guard (a plan, a diff, or this very code mentioning a
    // limit/prompt can't trip it while output flows). For a silent worker we then
    // refine the ACTION by reading its screen: a rate-limit WAIT is held (not
    // nudged/reclaimed — that would throw away its committed work), a trust prompt
    // is auto-accepted, and anything else takes the existing nudge→reclaim path.
    const startedMs = Date.parse(w.startedAt)

    // (1) EXECUTION CEILING — working time since dispatch past MAX_EXEC_MS.
    // Checked FIRST and INDEPENDENT of liveness: a worker streaming output forever
    // (an infinite /order loop, a task too big) still overruns, and is the one case
    // a silence detector can never catch. Clear all per-worker bookkeeping so a
    // reclaimed terminalId never carries stale state into a future spawn.
    //
    // The clock is the WORKING clock: repay every span this worker demonstrably
    // was NOT working before comparing against the ceiling — 統合待ち (idle in
    // review, pending the commander; the 2026-07-18 "runaway 91m" teardown of a
    // ready worker). Charging non-work to the worker is the harm. (The
    // rate-limit hold credit died 2026-08-13 with the 20-minute hold itself —
    // a quota-stopped worker is requeued, not held against its budget.) See
    // MAX_EXEC_MS / executionCredit.
    //
    // Ending the 統合待ち here is DEFENSIVE and idempotent: the 差し戻し observation
    // above is the semantic seam, but if any transition were ever missed, a stale
    // stamp must not keep growing once the worker is back at work.
    endIntegrationWait(engine, workerKey(w), now)
    const { waitedMs, creditMs } = executionCredit(engine, workerKey(w))
    // The RAW wait, before the cap — captured here because the ceiling branch below
    // clears the ledger before it builds its message, and the honest version of
    // "why did this stop" needs both numbers: what was waited and what was forgiven.
    const rawWaitedMs = engine.integrationWaitMs?.get(workerKey(w)) ?? 0

    // ── THE CEILING JUDGES THE CURRENT ASSIGNMENT, NOT THE WORKER'S WHOLE LIFE ──
    // A 差し戻し is a NEW assignment: the commander looked at delivered work and
    // asked for more. Running the clock from `startedAt` across that boundary
    // charged the re-work for everything that came before it, so a worker
    // 差し戻し'd anywhere near its ceiling crossed it on the very pass that
    // OBSERVED the 差し戻し — the two lines land in the same tick, ~150ms apart.
    // 2026-07-20, twice: 「差し戻しを観測 — worker を再作業中へ」 immediately
    // followed by 「worked 478m ≥ 90m」 → stopped → worktree removed → card
    // 'blocked'. Zero minutes of re-work, and the card cannot even re-dispatch
    // itself afterwards (selectDispatch reads 'todo' only), so the 差し戻し ends
    // in a dead end rather than a fix.
    //
    // The 統合待ち credit could never have covered this. It changes the LABEL and
    // the card's destination, not the teardown, and it is in-memory + poll
    // observed — a restart, a blind spot, or (as on 0720) an engine running older
    // code leaves the ledger empty, which is the incident's 「0m credited back」.
    // The origin needs neither: `reworkAt` is stamped by the observation block
    // above, in THIS pass, from the card's own column move.
    //
    // GATED ON DELIVERY so it cannot fail open. Otherwise dragging a card through
    // review and back would buy a worker that has produced NOTHING a fresh 90m,
    // every time — the same "fail open" the readyAt corroboration exists to stop.
    // The witness is `readyAt`, or the worker's own ready heartbeat. NOT
    // `commitsAhead`: workers are told to commit before declaring ready, so
    // commits are the normal state of a WORKING worker (tried and reverted
    // 2026-07-19 — see the reason split below).
    //
    // RECORD the heartbeat witness, don't just read it. `readyAt` is the roster's
    // durable memory of "delivered once"; the heartbeat proving it is the worker's
    // own file and it does NOT stay ready — the worker rewrites it to false as
    // soon as it resumes on the 差し戻し (02章 §5.6). Reading without recording
    // would grant the budget on one pass and revoke it on the next, and with a 3s
    // tick that is not a fix at all — the worktree would die three seconds later.
    //
    // ONLY for a worker that IS re-working. The stamp is an input to the re-work
    // budget, so it is taken exactly where that budget applies. Stamping on the
    // heartbeat alone — every pass, for any worker — would hand the 暴走 exemption
    // to one that declared ready prematurely and then looped, which is the failure
    // mode the ceiling exists to catch. `reworkAt` means a human looked at this
    // worker's output and asked for more, and that is the corroboration.
    if (w.reworkAt && !w.readyAt && heartbeat?.ready === true)
      w = { ...w, readyAt: new Date(now).toISOString() }
    const reworkFromMs = w.readyAt && w.reworkAt ? Date.parse(w.reworkAt) : Number.NaN
    // `Math.max` keeps a clock that runs backwards (a fixture, an NTP step) from
    // moving the origin EARLIER and handing out more budget than dispatch did; an
    // unparseable startedAt stays unparseable, so isRunaway's finite/positive
    // guard still refuses to judge a clockless worker.
    const budgetFromMs =
      Number.isFinite(startedMs) && Number.isFinite(reworkFromMs) ? Math.max(startedMs, reworkFromMs) : startedMs
    // Credit only what the NEW origin does not already exclude. The 統合待ち bank
    // is closed by the 差し戻し by construction (endIntegrationWait runs there), so
    // every banked minute is pre-rework — subtracting it again would forgive the
    // same minutes twice and let a re-work run to 2× its budget.
    const budgetCreditMs = budgetFromMs === startedMs ? creditMs : 0
    if (isRunaway(budgetFromMs, now, MAX_EXEC_MS, budgetCreditMs)) {
      // A worker that has ALREADY reached ready is NOT a 暴走: it produced
      // integrable, committed work, so the failure mode this ceiling defends
      // against (a task too big, a loop that never lands anything) is disproven.
      // It is stopped all the same — the slot is real and the ceiling keeps its
      // teeth — but under its own reason, so the log says what actually happened
      // and its card goes to 'review' (the commander's queue) instead of the
      // owner's 'blocked' column. 2026-07-18: the mislabel cost the commander a
      // diagnosis cycle and the blocked park made its recovery plan impossible.
      // ONE witness only — `readyAt`. It is a POLL OBSERVATION, so it
      // exists only if the engine happened to be watching when this worker's card
      // passed through review, and it is NOT watching while stopped — so a worker
      // can deliver, be hand-moved to review, be 差し戻し'd and be back at work
      // entirely in the blind, then arrive here bare. That gap is REAL (measured)
      // and deliberately LEFT OPEN — see §5.6 「エンジン盲目区間の穴」. It is left
      // open because the obvious patch is worse than the hole:
      //
      // `commitsAhead > 0` was tried as a "durable witness" and REVERTED on
      // 2026-07-19. It looks like evidence of delivery and is not: workers are
      // instructed to commit BEFORE declaring ready (「完了ゲートに入る前に必ず WIP
      // コミット」 — it is in every /order dispatch), so commits-ahead is the
      // NORMAL state of a working worker, not a mark of completion. Keying on it
      // meant only a worker that had committed literally nothing could ever be
      // called a 暴走: the card-too-big worker that commits scaffolding at 10m and
      // then spins for 110m sailed into 'review' wearing 「暴走ではありません」,
      // and the owner-facing text asserted a 差し戻し that never happened. That
      // trades a rare false negative for a routine false positive and dissolves
      // the defense. `readyAt` stays the ONLY witness: the engine says a worker
      // delivered only when it SAW the delivery.
      const reason: WorkerRecoveryReason = w.readyAt ? 'integration-wait' : 'runaway'
      engine.nudges.delete(workerKey(w))
      engine.questionRaised?.delete(workerKey(w))
      engine.questionWaits?.delete(workerKey(w))
      engine.integrationWaitMs?.delete(workerKey(w))
      const ranMin = Math.floor((now - startedMs) / 60_000)
      const waitedMin = Math.floor(waitedMs / 60_000)
      // The CHARGED time — the number the ceiling actually compared, so 「worked
      // Xm ≥ 90m」 can never be a figure the check did not use. For a re-working
      // worker that is the time since the 差し戻し, not since dispatch; `ranMin`
      // above still reports the whole life, and the two differ on exactly the
      // workers whose budget was restarted.
      const workedMin = Math.floor((now - budgetFromMs - budgetCreditMs) / 60_000)
      const limitMin = Math.floor(MAX_EXEC_MS / 60_000)
      const capMin = Math.floor(WAIT_CREDIT_CAP_MS / 60_000)
      // What was forgiven, spelled out — an owner reading "stopped at the ceiling"
      // must be able to see WHY the numbers don't add up to wall-clock.
      // A re-work budget does not CREDIT the queue time — it excludes it by starting
      // the clock at the 差し戻し. Reporting it as 「credited back」 would name a
      // subtraction the judgement never performed, and on a long queue the forgiven
      // figure would dwarf the charged one and read as the reason for the stop.
      const creditNote =
        budgetFromMs === startedMs
          ? `alive ${ranMin}m; ${waitedMin}m 統合待ち credited back`
          : `alive ${ranMin}m; 計上は差し戻し以降のみ(統合待ち ${waitedMin}m は計上対象外)`
      // SAY ONLY WHAT ACTUALLY HAPPENED — the single rule this whole card exists to
      // enforce. A ready worker reaches this check in TWO very different ways, and
      // `readyAt` cannot tell them apart because it only means "delivered once":
      //
      //  (a) 差し戻され、実際に再作業して予算を使い切った.
      //  (b) 再作業していない. Either the card simply queued past the credit cap (a
      //      careful 63-hour weekend review is enough at the 8h default), or a KEPT
      //      promote stamped `readyAt` while the worker stayed 'running' and a later
      //      transient read dropped the promote. What pushed it over the ceiling was
      //      uncredited WAITING, not work.
      //
      // The discriminator is the RE-WORK DURATION, not `reworkAt`'s presence. In the
      // 63-hour case the commander DOES 差し戻し — the engine observes it, stamps
      // `reworkAt`, and tears the worker down in the SAME pass — so `reworkAt` is set
      // while the worker re-worked for zero minutes. Keying on the stamp would still
      // narrate "差し戻し後の再作業で上限に到達" about 55 hours of weekend queue time.
      //
      // (`readyAt` is stamped at THREE sites, and only two take the worker to
      // stage:'done' — the promote and the early-continue that sees the card already
      // in review/done. The third is the KEPT promote, which stamps while the worker
      // stays 'running' and its card never leaves 'doing'. An earlier comment here
      // claimed 'done' was the only route and 差し戻し the only way back out; the kept
      // promote falsifies both.)
      const reworkAtMs = w.reworkAt ? Date.parse(w.reworkAt) : Number.NaN
      const reworkedMs = Number.isFinite(reworkAtMs) ? Math.max(0, now - reworkAtMs) : 0
      const reworkedMin = Math.floor(reworkedMs / 60_000)
      const rawWaitedMin = Math.floor(Math.max(0, rawWaitedMs) / 60_000)
      const reworked = reworkedMs >= 60_000
      // "The ceiling came from WAITING" is only true if the wait actually LOST
      // something to the cap. Keying it on `rawWaited > 0` was wrong and not rarely
      // so: the tick is 3s, so a worker 差し戻し'd while already near the ceiling
      // crosses it within the first minute, lands in `reworkedMs < 60_000`, and
      // would announce 「上限の原因は待ち時間であって作業ではない」 after a 20-minute
      // wait against a 480-minute cap — nothing was truncated, and the 90 minutes
      // were real work. Only an OVER-CAP wait puts uncredited waiting on the clock.
      // …and it is only ASKABLE on the clock that actually spent the wait. A worker
      // judged from its 差し戻し never had the queue on its clock at all, so blaming
      // the queue there would be the same fiction in a new shape.
      //
      // In steady state that makes 'capped-wait' UNREACHABLE, and knowingly so: a
      // banked wait implies a 差し戻し (only a corroborated review card opens the
      // bank, and only that observation closes it), and the same observation stamps
      // `reworkAt`. The predicate is kept rather than deleted because the ledger is
      // engine state that outlives a module swap — a roster entry carried across a
      // self-update can hold a bank with no `reworkAt` — and because it is still the
      // honest test for 「the cap truncated something」 if that state appears.
      const capped = budgetFromMs === startedMs && rawWaitedMs > WAIT_CREDIT_CAP_MS
      // THE THREE HONEST SHAPES of an integration-wait stop. Everything the owner
      // and the commander read is chosen by this one value, so it must name the
      // actual cause rather than a proxy for it:
      //   'rework'      — 差し戻し後に実際に再作業して予算を使い切った
      //   'capped-wait' — 統合待ちが控除上限を超え、その超過分が計上されて上限に達した
      //   'work'        — 待ちは全額控除され再作業もしていない。上限に達したのは
      //                   純粋に実作業。kept promote(待ち 0 分・カードは doing の
      //                   まま)もここに入る — 待ちが記録されていない worker は、
      //                   定義上ずっと働いていたのだから。
      const shape: SwarmFatalNotification['execTimeoutShape'] = reworked
        ? 'rework'
        : capped
          ? 'capped-wait'
          : 'work'
      logLine(
        engine,
        'warn',
        reason !== 'integration-wait'
          ? `worker runaway — worked ${workedMin}m ≥ ${limitMin}m execution limit (${creditNote}): ${w.branch} (${shorten(w.taskTitle)})`
          : shape === 'rework'
            ? `worker over execution budget while RE-WORKING after 差し戻し — worked ${workedMin}m ≥ ${limitMin}m (${creditNote}). 暴走ではない(ready 済みの成果がブランチにある) — card → review: ${w.branch} (${shorten(w.taskTitle)})`
            : shape === 'capped-wait'
              ? `worker stopped after a LONG integration queue — waited ${rawWaitedMin}m, only ${capMin}m creditable, so charged time ${workedMin}m ≥ ${limitMin}m (${creditNote}). 再作業 ${reworkedMin}m — 上限の原因は待ち時間であって作業ではない・暴走でもない — card → review: ${w.branch} (${shorten(w.taskTitle)})`
              : `worker over execution budget doing REAL WORK — worked ${workedMin}m ≥ ${limitMin}m (${creditNote}; waited ${rawWaitedMin}m, fully credited). 再作業 ${reworkedMin}m — ready 済みなので暴走ではない — card → review: ${w.branch} (${shorten(w.taskTitle)})`,
      )
      // Escalation safety valve (exec-timeout): a worker overran the execution-time
      // ceiling and is being force-reclaimed — a human should know. Enqueue the EDGE
      // event; runEnginePass drains + pushes it exactly once after the pass settles.
      // The three cases need DIFFERENT words. A never-ready worker would just overrun
      // again on re-run (a human decides). One that was 差し戻し'd and blew the budget
      // re-working needs the commander to look at a branch whose tip is UNVERIFIED —
      // the re-work was cut off mid-flight and its remainder salvaged as a WIP commit,
      // so "統合してください" without that caveat invites landing a half-finished
      // 差し戻し. One that merely waited too long re-worked NOTHING: its tip is what it
      // was at ready, and the only thing that could have moved it is a WIP commit of
      // stray uncommitted changes (reported on its own log line when it happens).
      engine.pendingFatal.push({
        event: 'exec-timeout',
        // The flavor travels WITH the event: the overseer raises one S3 signal for
        // both, and the owner-facing question it builds must not offer "split it up
        // and retry" for a worker whose branch already holds delivered work (that
        // answer would ride into the card's next dispatch). See SwarmFatalNotification.
        execTimeoutKind: reason === 'integration-wait' ? 'integration-wait' : 'runaway',
        // …and WHICH of the three shapes it is, so every downstream surface tells
        // the same story. A boolean could not: it collapsed 'work' into 'capped-wait'
        // and the owner read 「順番待ちが長引いた」 about a worker that had waited
        // zero minutes and worked the whole time.
        execTimeoutShape: reason === 'integration-wait' ? shape : undefined,
        detail:
          reason !== 'integration-wait'
            ? `ワーカーが実行時間上限 ${limitMin}分 を超過（実作業 ${workedMin}分・通算 ${ranMin}分／うち統合待ち ${waitedMin}分は控除済み）→ 強制回収。未コミットの作業はブランチに WIP コミットで保全されます（未検証）。`
            : shape === 'rework'
              ? `一度 ready に到達したワーカーが、差し戻し後の再作業で作業上限 ${limitMin}分 に到達（実作業 ${workedMin}分・通算 ${ranMin}分／うち統合待ち ${waitedMin}分は控除済み）→ 停止。暴走ではありません（統合可能な成果を一度出しています）。カードは review へ戻します。ただし再作業は途中で打ち切られ、未コミット分は WIP コミットで保全されるだけなので、ブランチ ${w.branch} の先端は未検証です — そのまま統合せず、まず差分を確認してください。`
              : shape === 'capped-wait'
                ? `一度 ready に到達したワーカーが、統合待ちが長引いたため停止しました（統合待ち ${rawWaitedMin}分 のうち控除できるのは上限 ${capMin}分 まで。超過分が計上され、判定時間 ${workedMin}分 が上限 ${limitMin}分 に達しました／通算 ${ranMin}分）。上限に達した原因は待ち時間であって作業ではありません — このワーカーの再作業は ${reworkedMin}分 です。暴走でもありません。ブランチ ${w.branch} の先端は ready 到達時のままなので、そのまま統合を判断できます（停止時に未コミットの変更があった場合のみ WIP コミットが 1 つ乗ります — engine log の WIP 行で分かります）。カードは review に残ります。`
                : `一度 ready に到達したワーカーが、作業上限 ${limitMin}分 に到達したため停止しました（実作業 ${workedMin}分・通算 ${ranMin}分／統合待ち ${rawWaitedMin}分 は全額控除済み・再作業 ${reworkedMin}分）。待ち時間が原因ではありません — 上限に達したのは実作業です。暴走でもありません（統合可能な成果を一度出しています）。カードは review へ移します。ブランチ ${w.branch} の先端は打ち切り時点のもので未検証です — そのまま統合せず、まず差分を確認してください。`,
        projectPath: engine.path,
        taskId: card?.id,
        branch: w.branch,
        taskTitle: w.taskTitle,
        logHint:
          reason !== 'integration-wait'
            ? '司令塔の engine log を確認してください（worker runaway の警告行）。'
            : shape === 'rework'
              ? '司令塔の engine log を確認してください（worker over execution budget while RE-WORKING の警告行）。'
              : shape === 'capped-wait'
                ? '司令塔の engine log を確認してください（worker stopped after a LONG integration queue の警告行）。'
                : '司令塔の engine log を確認してください（worker over execution budget doing REAL WORK の警告行）。',
      })
      // Pass the SAME discriminator the ceiling line used, so the two journal lines
      // this one stop emits cannot disagree (02章 §5.6).
      if (
        await recoverLost(
          w,
          card,
          { alive, commitsAhead, commitsUnknown, heartbeat },
          reason,
          reason === 'integration-wait' ? shape : undefined,
        )
      )
        next.push(w)
      continue
    }

    // Compute the stall verdict UP FRONT: its `silentMs` GATES the rate-limit /
    // permission classification below (only a silent worker is a candidate), and
    // its `action` drives the normal path. A worker NOT yet silent yields action
    // 'none' with silentMs < STALL_SILENCE_MS, so it sails through every branch
    // untouched — exactly the "never interrupt a working worker" contract.
    let lastOut: number | null = null
    try {
      lastOut = deps.lastOutputAt(w)
    } catch {
      /* unknown → no output signal; heartbeat + startedAt still apply */
    }
    const hbMs = heartbeat?.at ? Date.parse(heartbeat.at) : Number.NaN

    // ── OUTPUT + QUOTA VERDICT (SDK-native since 2026-08-13) ──────────────────
    // The PTY era sampled a rendered screen behind a 45s lull gate, tracked how
    // long a limit notice HELD the screen (engine.limitScreen), clamped the
    // stall clock to that onset, and early-confirmed at-spawn rejections — all
    // workarounds for reading a repainting TUI picture. An SDK worker's recent
    // output is a cheap ring-buffer read and its quota verdict is the pool's
    // own event, so the whole scrape apparatus is gone: read the tail every
    // pass, ask the pool.
    let screen: string | null = null
    try {
      screen = deps.recentOutput(w)
    } catch {
      /* unknown → classifyOutput('normal') → ordinary stall handling below */
    }
    // The runtime's OWN quota verdict — the ONLY rate-limit trigger since the
    // wording matcher died with the PTY sensor layer. An SDK session parked on
    // the SDK's exported refusal vocabulary is quota-blocked even when its
    // sentence matches none of our old patterns ("You're out of usage credits…"
    // matched nothing, so the tier never cooled and dispatch kept launching
    // into it — overnight review 2026-08-04). A legacy PTY roster row's arm
    // reports constant false (its runtime is dead; it can only be torn down).
    let output: 'rate-limited' | 'question' | 'normal' = classifyOutput(screen, workerRuntimeKind(w))
    try {
      if (deps.quotaBlocked?.(w) ?? runtimeOf(w).quotaBlocked(w)) output = 'rate-limited'
    } catch {
      /* pool read failed → keep the text verdict */
    }
    const stallParams = {
      stallMs: STALL_SILENCE_MS,
      cooldownMs: STALL_NUDGE_COOLDOWN_MS,
      echoGuardMs: STALL_ECHO_GUARD_MS,
      maxNudges: STALL_MAX_NUDGES,
    }
    // The CHEAP verdict (heartbeat + PTY only). Kept as its own value because two
    // consumers want DIFFERENT questions answered:
    //   • the stall LADDER below asks "is this worker alive?" — every channel counts,
    //     so it reads the re-classified `stall`;
    //   • the permission-wait / question arms ask "is this worker sitting UNATTENDED at
    //     a prompt / waiting on the owner?" — a background task running elsewhere is no
    //     answer to that, so they read `cheapStall`. Folding the fourth channel into
    //     those arms (the first cut did) means a worker that hits a trust dialog, or
    //     asks the owner a question, while a `node serve.js` / watch loop sits unresolved
    //     in its transcript gets NEITHER the auto-accept nor the C3 escalation for the
    //     whole grace. Measured on this disk: 32 of 484 background tasks (~7%) never
    //     report back, so that is not a hypothetical.
    const cheapStall = classifyStall(
      {
        heartbeatAtMs: Number.isFinite(hbMs) ? hbMs : null,
        lastOutputAtMs: lastOut,
        startedAtMs: Number.isFinite(startedMs) ? startedMs : 0,
        nudge: engine.nudges.get(workerKey(w)),
      },
      now,
      stallParams,
    )
    let stall = cheapStall

    // ── THIRD LIVENESS CHANNEL — the worker analog of 7517e4b1 (2026-07-23) ──────
    // The cheap channels (heartbeat + PTY output) call this worker silent — but a
    // worker deep in ONE long turn running a Task() sub-agent (its OWN adversarial
    // self-review) freezes BOTH of them while its transcript / sub-agent files keep
    // growing in real time (measured on the desk 2026-07-22: a 39-min reviewer wrote
    // 229 incremental entries; the parent transcript FROZE the whole time). Re-judge
    // such a worker against those files so it is neither nudged (ESC would interrupt
    // the running review) nor reclaimed (teardown + re-home → the observed twin
    // dispatch + near-loss of in-flight work). The freshness can only ADD activity —
    // a genuinely-dead worker's files stop growing, so its mtime goes stale on the
    // same clock and it is still reclaimed. GATED behind the silence threshold so the
    // fs walk runs only for the handful of workers about to be acted on, never every
    // pass — and skipped for a rate-limited worker (silent BY DESIGN, no sub-agent).
    //
    // ── FOURTH LIVENESS CHANNEL — the background task (2026-07-27) ───────────────
    // The third channel covers a worker inside ONE LONG turn. It cannot cover the
    // OPPOSITE and far more common shape: a worker that started its completion gate
    // (`npm test`) as a BACKGROUND task, announced "I'll report when it finishes",
    // and correctly ENDED ITS TURN to wait for the notification. That worker beats
    // nothing (no phase change), paints nothing (the TUI is idle), and grows no file
    // (the turn is over) — all three channels freeze together for the 20+ minutes a
    // saturated full suite takes, and the monitor reclaimed it at ~16. Four healthy
    // workers died this way in one morning; their transcripts show the engine killing
    // the very test runs they were waiting on. The in-flight task IS the proof of
    // life, and it is right there in the transcript — see sessionBackgroundTaskAt for
    // the records, BG_TASK_GRACE_MS for the cap that keeps this a REPRIEVE and not an
    // exemption.
    //
    // Both file channels are resolved under the SAME gate and folded into ONE
    // re-classification: a genuinely dead worker grows no file AND has no task in
    // flight, so it still crosses the same threshold on the same clock and is still
    // reclaimed. Skipped for a rate-limited worker (silent BY DESIGN).
    if (
      stall.silentMs >= STALL_SILENCE_MS &&
      output !== 'rate-limited' &&
      w.sessionId &&
      w.worktree &&
      (deps.sessionAgentActivityAt || deps.sessionBackgroundTaskAt)
    ) {
      let agentAt: number | null = null
      let bgStartedAt: number | null = null
      try {
        agentAt = deps.sessionAgentActivityAt ? await deps.sessionAgentActivityAt(w.worktree, w.sessionId) : null
      } catch {
        agentAt = null // torn ~/.claude ⇒ no signal ⇒ keep the cheap verdict
      }
      try {
        bgStartedAt = deps.sessionBackgroundTaskAt ? await deps.sessionBackgroundTaskAt(w.worktree, w.sessionId) : null
      } catch {
        bgStartedAt = null // ditto — an unreadable transcript never RESCUES and never CONDEMNS
      }
      const bgAliveAt = backgroundTaskAliveAt(bgStartedAt, now, BG_TASK_GRACE_MS)
      if (agentAt !== null || bgAliveAt !== null) {
        stall = classifyStall(
          {
            heartbeatAtMs: Number.isFinite(hbMs) ? hbMs : null,
            lastOutputAtMs: lastOut,
            startedAtMs: Number.isFinite(startedMs) ? startedMs : 0,
            agentActivityAtMs: agentAt,
            bgTaskAliveAtMs: bgAliveAt,
            nudge: engine.nudges.get(workerKey(w)),
          },
          now,
          stallParams,
        )
      }
    }

    // QUOTA STOP (fail-fast, 2026-08-13 — replaces the PTY era's 20-minute
    // in-place HOLD). The pool's own verdict said this worker is parked on a
    // usage/quota wall; a parked SDK worker will not start a new turn by
    // itself, so waiting in place buys nothing. One debounce window separates
    // "parked on the wall" from "echoed wall-like text mid-work" (the verdict
    // decays on the next real event — see QUOTA_STOP_DEBOUNCE_MS), and then:
    // cool the LAUNCH TIER in the quota table (so dispatch drops a tier — or
    // parks when every tier is dry — instead of re-spawning into the same
    // wall), requeue the card to 'todo' (branch work preserved via the WIP
    // commit in teardown; recoveryColumn's rate-limit arm never burns the
    // retry budget), and free the worker. The retry pace is the cooling span:
    // when the tier warms (parsed reset time / A5 / RATE_LIMIT_GRACE_MS), the
    // card redispatches by itself — no human re-arm.
    if (output === 'rate-limited' && cheapStall.silentMs >= QUOTA_STOP_DEBOUNCE_MS) {
      engine.nudges.delete(workerKey(w))
      // QUOTA SENSOR (the one production write into swarmQuota's cooling
      // table): attribute this sighting to the tier the worker launched on.
      // Reset time resolves refusal text → A5 cache → RATE_LIMIT_GRACE_MS
      // (resolveCoolingUntil). A worker with no recorded/on-ladder model marks
      // nothing (never cool a tier by guess) — its card still requeues.
      const tier = MODEL_TIER_LADDER.find((t) => t === w.model)
      let cooling = ''
      if (tier) {
        const until = markRateLimited(tier, {
          ptyText: screen,
          a5ResetsAt: a5CoolingHint(),
          graceMs: RATE_LIMIT_GRACE_MS,
          now,
        })
        cooling = ` · tier ${tier} cooling until ${new Date(until).toISOString()}`
      }
      logLine(
        engine,
        'warn',
        `worker quota-stopped — cooling the tier and requeueing the card (fail-fast; retry rides the cooling clock)${cooling}: ${w.branch} (${shorten(w.taskTitle)})`,
      )
      if (await recoverLost(w, card, { alive, commitsAhead, commitsUnknown, heartbeat }, 'rate-limit')) next.push(w)
      continue
    }

    // Only an ALREADY-SILENT worker is judged for a question WAIT. This is the
    // false-kill fix: a productive worker that merely PRINTS question-like text
    // is still streaming output ⇒ not silent ⇒ never classified, never held.
    //
    // Gated on `cheapStall`, NOT the background-task-aware `stall`: this arm is
    // about an INTERVENTION the worker needs (put the question in front of the
    // owner), not about whether it is alive. A task running in the background
    // answers the liveness question and nothing else — muting the owner's
    // inbox behind it would be a new bug wearing that fix's clothes.
    //
    // The threshold is the SDK's short debounce (SDK_QUESTION_SILENCE_MS): a
    // 'question' classification already required the pool's own turn-ended
    // head, which is authoritative idleness — no 10-minute PTY-style proof
    // needed. (Only the SDK question detector exists since 2026-08-13; a
    // legacy PTY roster row can never classify 'question'. The PERMISSION-WAIT
    // arm that lived here died outright — the trust dialog is a TUI frame an
    // SDK session can never render.)
    if (output === 'question' && cheapStall.silentMs >= SDK_QUESTION_SILENCE_MS) {
      // FREE-TEXT QUESTION (C3) — silent because claude ASKED THE OWNER
      // something and idles at an empty input box (the state the A1 sandbox
      // leaves once permission menus are gone). Never nudge — a bare Enter is
      // pointless at an empty box and, on a misread frame, could take a menu
      // default. HOLD the slot so the owner's answer can W16-inject into the LIVE
      // worker (answerEscalation → injection), and raise the bare question to the
      // T3 escalations inbox — the §6 S4 THROTTLED degradation until C-core's
      // budgeted brain pass takes over (handleWorkerQuestion is C-core's library,
      // NOT called here: no LLM may burn outside C-core's budget/single-flight).
      // MF1: the old `heartbeat?.blocked ? null` suppression UNCONDITIONALLY deferred
      // a blocked worker's question to "S4 owns the raise" — but the OVERSEER S4
      // (swarmOverseer.ts) only exists when the overseer is ARMED, so with it OFF a
      // blocked worker's question was silently DROPPED. Fix: suppress here ONLY when
      // the overseer is enabled (then S4 raises it, from the heartbeat blockers). Do
      // NOT rely on receiptKey dedup across the two: S4's key is the heartbeat text,
      // this arm's is the TUI-scraped question — they differ, so raising in BOTH
      // would double-open the inbox. Overseer OFF ⇒ raise here (don't drop it).
      // MF2: BOUND the hold (below) — held past QUESTION_GRACE_MS ⇒ PARK in
      // 'blocked'. An unanswered real question, or a courtesy/rhetorical "?"
      // false-positive, must not squat the slot until the 90-min runaway ceiling.
      {
        engine.nudges.delete(workerKey(w))
        // Lazy backfill (beside ensureEngine's): a plain engine literal from an
        // older build / a test fixture must still get once-per-question raising.
        engine.questionRaised ??= new Map()
        engine.questionWaits ??= new Map()
        const q =
          heartbeat?.blocked && engine.overseer?.enabled
            ? null
            : detectWorkerFreeTextQuestion(workerRuntimeKind(w), screen)
        if (q && deps.raiseQuestion) {
          const receiptKey = defaultReceiptKey({
            projectPath: engine.path,
            taskId: card?.id,
            question: q.question,
          })
          if (engine.questionRaised.get(workerKey(w)) !== receiptKey) {
            engine.questionRaised.set(workerKey(w), receiptKey)
            try {
              await deps.raiseQuestion({
                projectPath: engine.path,
                question: q.question,
                // Runtime-neutral wording: an SDK worker HAS no 画面 — its
                // question comes off the session's own transcript. Saying
                // "screen" to the owner for that runtime was a small lie the
                // 0.11.52 acceptance put on an actual owner-facing card.
                context: `worker ${w.branch} (${w.taskTitle}) の claude が入力待ちで停止中に検出した質問。`,
                whyEscalated: 'policy',
                receiptKey,
                ...(card?.id ? { taskId: card.id } : {}),
                branch: w.branch,
                // The worker's FULL address, not just its terminalId. The record
                // is what the owner's answer is later delivered against, and an
                // SDK worker's terminalId is EMPTY — so a terminalId-only raise
                // produced an inbox entry that could never reach the worker that
                // asked (it fell through to the next-dispatch queue forever).
                // Same shape as every other handle-passing site in this file.
                ...(w.runtime ? { runtime: w.runtime } : {}),
                terminalId: w.terminalId,
                ...(w.sdkSessionId ? { sdkSessionId: w.sdkSessionId } : {}),
              })
              logLine(
                engine,
                'warn',
                `worker asked a free-text question — raised to the escalations inbox: ${w.branch} (${shorten(q.question)})`,
              )
            } catch (e) {
              // Raise failed (fs/notify hiccup) → forget the key so the next
              // pass retries; the hold itself is unaffected.
              engine.questionRaised?.delete(workerKey(w))
              logLine(engine, 'warn', `question raise failed (will retry next pass): ${errMsg(e)}`)
            }
          }
        }
        // MF2: BOUND the hold. Stamp on first sight; once held past
        // QUESTION_GRACE_MS, PARK in 'blocked' (recoverLost 'question') to free the
        // slot — the raised question persists in the escalations inbox, and
        // 'blocked' is the human lane (no auto-respawn re-asking). Mirrors the
        // rate-limit / permission grace arms.
        const qw = engine.questionWaits.get(workerKey(w))
        if (!qw) {
          engine.questionWaits.set(workerKey(w), { since: now })
        } else if (now - qw.since >= QUESTION_GRACE_MS) {
          engine.questionWaits.delete(workerKey(w))
          engine.questionRaised?.delete(workerKey(w))
          if (await recoverLost(w, card, { alive, commitsAhead, commitsUnknown, heartbeat }, 'question')) next.push(w)
          continue
        }
        next.push(withHeartbeat({ ...w, stage: 'running' }, heartbeat))
        continue
      }
    }

    // Reached here ⇒ NOT silent, OR silent without a question ⇒ no wait arm
    // applies. Drop any stale question-state (the worker recovered, or was
    // never in one) and take the ordinary STALL path: a silent worker is NUDGED
    // up to STALL_MAX_NUDGES then RECLAIMED (teardown + re-home) like a crash;
    // a still-active one (action 'none') is simply kept.
    engine.questionRaised?.delete(workerKey(w))
    engine.questionWaits?.delete(workerKey(w))
    if (stall.action === 'reclaim') {
      engine.nudges.delete(workerKey(w))
      // A silent worker is reclaimed like a crash: recoveryColumn (via recoverLost)
      // sends a bare hang to 'todo' (one retry) or 'blocked' (budget spent), never
      // to review — a stall NEVER fakes progress.
      if (await recoverLost(w, card, { alive, commitsAhead, commitsUnknown, heartbeat }, 'stall')) next.push(w)
      continue
    }
    if (stall.action === 'escalate') {
      // The cheap Enter-nudge budget is spent and the worker is STILL silent — try
      // the ESC+continue escalation exactly once (classifyStall's `escalated` gate)
      // before falling through to reclaim on the pass after this one.
      let sent = false
      try {
        sent = await deps.escalate(w, w.taskTitle)
      } catch {
        sent = false
      }
      engine.nudges.set(workerKey(w), { count: STALL_MAX_NUDGES, lastNudgeAt: now, escalated: true })
      logLine(
        engine,
        'warn',
        `worker stalled ${Math.floor(stall.silentMs / 60_000)}m — nudge budget spent, escalating (say: continue-or-report)` +
          `${sent ? '' : ' · not delivered'}: ${w.branch} (${shorten(w.taskTitle)})`,
        'stall',
      )
      next.push(withHeartbeat({ ...w, stage }, heartbeat))
      continue
    }
    if (stall.action === 'nudge') {
      let sent = false
      try {
        sent = deps.nudge(w)
      } catch {
        sent = false
      }
      const count = (engine.nudges.get(workerKey(w))?.count ?? 0) + 1
      engine.nudges.set(workerKey(w), { count, lastNudgeAt: now })
      logLine(
        engine,
        'warn',
        `worker stalled ${Math.floor(stall.silentMs / 60_000)}m — nudged (${count}/${STALL_MAX_NUDGES})` +
          `${sent ? '' : ' · not delivered'}: ${w.branch} (${shorten(w.taskTitle)})`,
        'stall',
      )
    } else if (stall.progressed && engine.nudges.has(workerKey(w))) {
      // Real progress since the nudge (a fresh heartbeat OR sustained output past
      // the echo guard) proves the Enter woke it — clear the budget so a LATER,
      // independent stall gets the full nudge allowance again.
      engine.nudges.delete(workerKey(w))
      logLine(engine, 'info', `worker recovered after nudge: ${w.branch} (${shorten(w.taskTitle)})`, 'routine')
    }
    next.push(withHeartbeat({ ...w, stage }, heartbeat))
  }

  // Forget recovery counters for cards that have left the retry cycle (promoted to
  // review / done / deleted). A card still in todo (awaiting its retry) or doing (a
  // retry in flight) KEEPS its counter — the budget must survive the
  // requeue→re-dispatch→re-crash cycle, else a reliably-crashing card would loop
  // forever with its counter reset to 0 each round. byId is the pass-start snapshot
  // (before this pass's recover moves), so a just-requeued card still reads 'doing'
  // here and correctly keeps its counter.
  for (const id of Array.from(engine.recoveries.keys())) {
    const c = byId.get(id)
    const col = c ? columnOf(c) : null
    if (col === null || col === 'done' || col === 'review') engine.recoveries.delete(id)
  }

  // Forget per-worker bookkeeping (nudge budget + rate-limit / permission-wait /
  // question-raised tracking) for workers no longer in the live set (reclaimed,
  // promoted-and-exited, crashed, runaway) — all keyed by terminalId, so a worker
  // that survives this pass keeps its state while a departed one's is dropped. This
  // catch-all is what GUARANTEES no map leaks an entry for the engine's lifetime,
  // regardless of the departure path (the eager per-branch deletes above are just
  // the fast path for the common cases). terminalId is unique per spawn, so a stale
  // entry would never be reused either — pruning here keeps every map bounded by the
  // LIVE worker count, not the all-time spawn count.
  const liveTerminalIds = new Set(next.map((w) => workerKey(w)))
  for (const id of Array.from(engine.nudges.keys())) {
    if (!liveTerminalIds.has(id)) engine.nudges.delete(id)
  }
  if (engine.integrationWaitSince) {
    for (const id of Array.from(engine.integrationWaitSince.keys())) {
      if (!liveTerminalIds.has(id)) engine.integrationWaitSince.delete(id)
    }
  }
  if (engine.integrationWaitMs) {
    for (const id of Array.from(engine.integrationWaitMs.keys())) {
      if (!liveTerminalIds.has(id)) engine.integrationWaitMs.delete(id)
    }
  }
  if (engine.questionRaised) {
    for (const id of Array.from(engine.questionRaised.keys())) {
      if (!liveTerminalIds.has(id)) engine.questionRaised.delete(id)
    }
  }
  if (engine.questionWaits) {
    for (const id of Array.from(engine.questionWaits.keys())) {
      if (!liveTerminalIds.has(id)) engine.questionWaits.delete(id)
    }
  }

  engine.workers = next
}

/** Tell a human that the swarm has no model left to run on. A `none-allowed` hold
 *  is the ONE park with no clock behind it: every tier is switched OFF in Settings,
 *  so waiting achieves nothing and the engine would otherwise sit silent forever.
 *  Raised on the ENTER edge only (the caller's `spawnBlockSig`), idempotent on its
 *  receiptKey while open, and best-effort — a failed raise clears the signature so
 *  the next pass retries, exactly like the worker-question raise. */
const raiseNoAllowedModelTier = async (
  engine: ProjectEngine,
  deps: OrchestratorDeps,
): Promise<void> => {
  if (!deps.raiseQuestion) return
  const question =
    'Swarm cannot launch: every model tier is switched OFF (Settings ▸ 使用可能モデル). Which tier should be re-enabled?'
  try {
    await deps.raiseQuestion({
      projectPath: engine.path,
      question,
      context:
        'すべてのモデル tier が使用可能モデル設定で OFF になっているため、worker / マネージャー / タスク窓口 / ' +
        'レビュアーのいずれも起動できず、dispatch を停止しています。cooling と違い期限で自然回復しません — ' +
        '最低1つの tier を ON に戻すまで swarm は動きません。',
      plainQuestion:
        'AIを動かすための「使えるモデル」の設定が、すべてオフになっています。どうしますか？\n' +
        'A: 設定画面（使用可能モデル）で、どれか1つ以上をオンに戻す（すぐに作業が再開できます）\n' +
        'B: このままにしておく（オンに戻すまで、すべての自動作業が止まったままです）',
      whyEscalated: 'policy',
      receiptKey: defaultReceiptKey({ projectPath: engine.path, question }),
    })
  } catch (e) {
    engine.spawnBlockSig = undefined // retry the raise on the next pass
    logLine(engine, 'warn', `no-model escalation failed (will retry next pass): ${errMsg(e)}`)
  }
}

// ── card 3: roster write-through (state-transition-gated) ────────────────────

/** Build one persisted roster row from a live worker. `workedMs` is the worker's
 *  WORKING time ON ITS CURRENT ASSIGNMENT — wall-clock from the SAME origin the
 *  execution ceiling measures ({@link monitorWorkers}'s `budgetFromMs`: the 差し戻し
 *  (`reworkAt`, corroborated by `readyAt`) when there is one, else the spawn) MINUS
 *  the banked idle credits that origin does not already exclude ({@link isRunaway}'s
 *  `idleMs`). Persisting it lets a card-4 resume restart the runaway clock from real
 *  accumulated work instead of zero. `tier` is the launch model alias; `card` (when
 *  the board is in hand) refreshes reworkCount. Pure (clock injected).
 *
 *  WHY THE ORIGIN MUST TRACK THE CEILING'S — the 2026-07-24 must-fix #2. The ledger
 *  is what a resume adopts as its `startedAt` ({@link resumeStartedAtMs}), and a
 *  resumed worker carries NO `reworkAt` (that stamp is engine memory, not roster
 *  state), so nothing downstream can move the origin a second time. A LIFETIME
 *  ledger therefore re-charges a RE-WORKING worker for everything before its
 *  差し戻し the moment the app restarts: a worker dispatched 200m ago and 差し戻し'd
 *  5m ago survives the ceiling for as long as the app stays up (§5.5(c)) and is then
 *  judged 暴走 on the FIRST monitor pass after a restart — worktree torn down, card
 *  parked in 'blocked'. That is the 2026-07-20 accident §5.5(c) closed, re-triggered
 *  by the restart instead of by the 差し戻し observation, and it is a destruction
 *  main does not have (main never resumes, so a surviving 'doing' card is left
 *  alone) — exactly what plan §5's "worst case = same as today" forbids.
 *
 *  PERSISTING `reworkAt` ITSELF would fix that direction and break the other one:
 *  an absolute re-work timestamp re-bills the app's DOWNTIME as execution time,
 *  which is the defect {@link resumeStartedAtMs} exists to prevent. The ledger is
 *  a DURATION for exactly that reason — it is the only shape that survives a
 *  restart without charging for it. */
const rosterEntryOf = (
  engine: ProjectEngine,
  w: OrchestratorWorker,
  now: number,
  card?: ProjectTask,
): RosterEntry => {
  const spawnAtMs = Date.parse(w.startedAt)
  const known = Number.isFinite(spawnAtMs) && spawnAtMs > 0
  const waitedMs = Math.max(0, engine.integrationWaitMs?.get(workerKey(w)) ?? 0)
  // The ceiling's origin, re-derived (monitorWorkers :5918-5924): a 差し戻し moves it,
  // and ONLY when delivery corroborates it (`readyAt` — the same anti-fail-open gate,
  // so a card walked through review buys no ledger reset either). `Math.max` keeps a
  // backwards clock from moving the origin EARLIER, matching the ceiling exactly.
  const reworkFromMs = w.readyAt && w.reworkAt ? Date.parse(w.reworkAt) : Number.NaN
  const budgetFromMs = known && Number.isFinite(reworkFromMs) ? Math.max(spawnAtMs, reworkFromMs) : spawnAtMs
  // Credit only what the NEW origin does not already exclude — the ceiling's own
  // split. The 統合待ち bank is closed BY the 差し戻し, so every banked minute is
  // pre-rework: subtracting it again would forgive the same minutes twice and let
  // a re-work bank a ledger that runs to 2× its budget.
  const idle = budgetFromMs === spawnAtMs ? waitedMs : 0
  return {
    sessionId: w.sessionId ?? '',
    taskId: w.taskId,
    branch: w.branch,
    worktree: w.worktree,
    tier: w.model ?? '',
    // `spawnAt` stays the ORIGINAL dispatch even when the origin moved: it is only
    // ever read as resumeStartedAtMs' clamp ceiling ("never claim more credit than
    // wall-clock"), and a re-work ledger is always ≤ that span by construction.
    spawnAt: known ? spawnAtMs : now,
    workedMs: known ? Math.max(0, now - budgetFromMs - idle) : 0,
    reworkCount: card?.reworkCount ?? w.reworkCount ?? 0,
  }
}

/** A stable fingerprint of what the roster WOULD persist, EXCLUDING the time-varying
 *  workedMs/spawnAt — so it changes iff the worker set, a stage, a rework/ready
 *  marker, or the rework count actually transitioned. Sorted by worktree so member
 *  order never matters. This is the "state-transition point" detector that keeps
 *  syncRoster off the per-tick write path. */
const rosterSignature = (workers: OrchestratorWorker[]): string =>
  JSON.stringify(
    workers
      .map((w) => [
        w.worktree,
        w.taskId,
        w.branch,
        w.sessionId ?? '',
        w.model ?? '',
        w.stage,
        w.reworkAt ?? '',
        w.readyAt ?? '',
        w.reworkCount ?? 0,
      ])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  )

/** Write-through the roster IFF a real transition changed it (signature guard). A
 *  no-op on an unchanged pass; on a change it persists the full set and records the
 *  new signature — but ONLY on a successful write, so a failed (fail-open) write is
 *  retried next pass instead of being masked by an updated signature. `byId`
 *  refreshes each worker's cached reworkCount from its card. Never throws. */
const syncRoster = async (
  engine: ProjectEngine,
  now: number,
  byId?: Map<string, ProjectTask>,
): Promise<void> => {
  if (byId) {
    for (const w of engine.workers) {
      const card = byId.get(w.taskId)
      if (card && typeof card.reworkCount === 'number') w.reworkCount = card.reworkCount
    }
  }
  const sig = rosterSignature(engine.workers)
  if (sig === engine.rosterSig) return
  // NEVER write an EMPTY roster from an engine that has not reconciled.
  //
  // This is a FULL OVERWRITE, and `rosterSig` starts undefined, so a brand-new
  // engine's very first pass always writes — `rosterSignature([])` is `"[]"`,
  // which differs from `undefined`. That is correct for an engine that came up
  // through resumeEngines (it reconciled first, so an empty in-memory roster
  // genuinely means "nobody survived"). But resumeEngines is the ONLY path that
  // reconciles: startOrchestrator (the owner pressing 自動運転 ON) and
  // maybeAutoStartDrain both kick a pass on a fresh, empty engine — and those are
  // reached exactly when resume was SKIPPED (desiredRunning:false at boot, the
  // crash-loop breaker suppressing resume — whose own notice tells the owner to
  // turn it on by hand — or a failed claude preflight). The first pass then
  // stamped `{"workers":[]}` over the roster of workers that are still alive on
  // disk, and with the memory gone nothing could ever adopt them: their cards sat
  // in `doing` forever beside live worktrees.
  //
  // So: an engine that never reconciled may only ADD to what is on disk, never
  // erase it. Rows it does not know about are carried through untouched; the next
  // real reconcile (the next boot resume) is what is allowed to prune them.
  const rows = engine.workers.map((w) => rosterEntryOf(engine, w, now, byId?.get(w.taskId)))
  let next = rows
  if (!engine.rosterReconciled) {
    const onDisk = await readRoster(engine.path).catch(() => [])
    const mine = new Set(rows.map((r) => r.worktree))
    const carried = onDisk.filter((r) => !mine.has(r.worktree))
    if (carried.length) next = [...rows, ...carried]
  }
  const ok = await writeRoster(engine.path, next)
  if (ok) engine.rosterSig = sig
}

// ── The drain pass (the heart — exported for the unit test) ──────────────────

/** A `doing` swarm card that NO counted worker owns, whose branch nevertheless
 *  holds delivered work → promote it to `review` so the commander is woken.
 *
 *  ⚠ THE HOLE THIS CLOSES, measured on a real stall (2026-08-27, QRmenu).
 *  Workers dispatched before an app restart finished afterwards, and the engine
 *  never noticed. The chain that wakes the commander is
 *      monitorWorkers (walks `engine.workers`) → promote doing→review
 *      → runIntegratePass reads the REVIEW column → a branch seen there for the
 *        first time is `freshlyReady` → managerNotice → the desk is woken
 *  — every link reads the review column or `engine.workers`, and a worker that
 *  failed boot ADOPTION is in neither. So the card sat in `doing` with a live
 *  worktree, a `readyToMerge` heartbeat, commits on its branch, and NOBODY to
 *  move it. `GET /api/swarm/workers` (roster ∪ heartbeat ∪ live desks) showed it
 *  ready:true while `GET /api/swarm/orchestrator` showed `workers:[]`.
 *
 *  It was ALREADY KNOWN and half-fixed: adoptResumeCandidates' 2026-08-13 catch
 *  says in so many words that a non-adopted candidate "is never pushed to
 *  engine.workers, the orphan-doing anomaly SKIPS it (its worktree still
 *  exists) … The card sat in 'doing' forever, silently" — and that fix was
 *  applied to the THROW path only. The two `continue` exits (no sessionId, an
 *  unproven transcript) still lead here, and so does any future one. This sweep
 *  is deliberately NOT a fourth patch on those exits: it is a card-rooted
 *  invariant that holds however the card was orphaned.
 *
 *  ⚠ WHY IT CANNOT STEAL A LIVE WORKER'S CARD. Three conditions, all required:
 *   · NO counted worker — a worker the engine is monitoring owns its own promote
 *     (and its own 差し戻し re-promote suppression); this only ever looks at
 *     cards nobody is driving.
 *   · `readyToMerge` on the heartbeat AND commits ahead — the worker's own
 *     hand-over sign plus real work on the branch. A worker mid-task has written
 *     neither.
 *   · `reworkCount` falsy — the ONE case where a ready heartbeat lies. The beat
 *     is STICKY (swarm-beat.sh never unsets readyToMerge), so a card sent back
 *     review→doing still reports ready while its worker re-works. A card that has
 *     never been sent back cannot be in that state, so restricting to
 *     reworkCount 0 excludes the ambiguity entirely rather than guessing at it.
 *     (`reworkAt`, the timestamp the live monitor compares against, is in-memory
 *     only — it does not survive the restart this sweep exists for, which is why
 *     the count is the discriminator here and not the clock.)
 *
 *  Read-then-write per card, never throws: a card that cannot be moved is left
 *  for the next pass (and the anomaly feed already names it). */
const promoteUnownedDelivered = async (
  engine: ProjectEngine,
  deps: OrchestratorDeps,
  tasks: readonly ProjectTask[],
): Promise<void> => {
  const countedIds = new Set(engine.workers.map((w) => w.taskId))
  for (const t of tasks) {
    if (columnOf(t) !== 'doing') continue
    if (countedIds.has(t.id)) continue
    if (t.abandoned === true) continue // 見送る means見送る — never re-offer it
    if (t.reworkCount) continue // sticky-ready ambiguity — see the header
    const branch = typeof t.branch === 'string' ? t.branch : ''
    if (!branch || !isSwarmBranch(branch)) continue
    let hb: HeartbeatSign | null = null
    try {
      hb = await deps.readHeartbeat(engine.path, branch)
    } catch {
      continue // no sign, no claim
    }
    if (!hb?.ready) continue
    let ahead = 0
    try {
      const counted = await deps.countCommitsAhead(engine.path, branch)
      // `null` = git could not answer. UNLIKE the roster's read (where unknown
      // must not retire an entry that may hold the only copy), unknown here must
      // not MOVE a card on a guess — the safe direction flips with the action.
      if (counted === null) continue
      ahead = counted
    } catch {
      continue
    }
    if (ahead <= 0) continue
    let moved = false
    try {
      moved = await deps.moveToReview(engine.path, t.id, branch)
    } catch {
      moved = false
    }
    if (moved) {
      logLine(
        engine,
        'warn',
        `worker 不在のまま完了していたカードを review へ回収しました(司令官に通知されます): ${shorten(t.title ?? '')} → ${branch}`,
        'promote',
      )
    }
  }
}

/** ONE pass. Idempotent-ish and side-effect-bounded:
 *   1. read the board (full card list),
 *   2. MONITOR (Card②): advance each dispatched worker's stage and, when one is
 *      conservatively judged DONE, move its card doing→review (+branch); prune
 *      finished/dead workers so their slots free,
 *   3. reconcile: retry a todo→doing move that failed on an earlier pass for a
 *      still-counted worker (so a transient board-write hiccup self-heals),
 *   4. fill open slots: pull the next queue-order todos that pass every dispatch
 *      gate (todo-only / not already in flight / not a content-duplicate / no
 *      declared-file conflict with active work — see selectDispatch), spawn a
 *      worker for each, then move its card todo→doing (+branch).
 *  Never throws — every external call is guarded and logged; a bad pass just
 *  yields to the next tick. `now` is injected (default Date.now()) so the monitor's
 *  stall escalation is driven deterministically by the unit test. */
export const runDispatchPass = async (
  engine: ProjectEngine,
  deps: OrchestratorDeps,
  now: number = Date.now(),
): Promise<void> => {
  if (!engine.running) return

  // 1. Read the full board — the monitor needs each worker's current column, and
  //    dispatch/reconcile need the todo queue. One read feeds all three.
  let tasks: ProjectTask[]
  try {
    tasks = await deps.fetchTasks(engine.path)
  } catch (e) {
    logLine(engine, 'warn', `board read failed: ${errMsg(e)}`)
    return
  }
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const todos = tasks.filter(isTodoCard)

  // 1b. 着地台帳 sweep: stamp landedAt on engine-promoted cards the Board now
  //     shows done (the commander's merge + markDone is a Board write the engine
  //     only ever OBSERVES — there is no land event to hook since 2026-07-15).
  //     Never throws by contract; one small readFile when nothing is pending.
  await sweepLanded(engine.path, tasks, new Date(now).toISOString())

  // 2. Monitor existing workers: advance stages, promote the done ones
  //    doing→review, recover crashed AND stalled ones, and prune dead/finished
  //    workers (freeing their slots).
  await monitorWorkers(engine, deps, byId, now)
  if (!engine.running) return // a stop during the (awaiting) monitor halts promptly

  // 2b. Collect the cards NO worker owns but whose branch already holds delivered
  //     work — the restart-orphan case monitorWorkers structurally cannot see
  //     (it walks engine.workers; these are in neither that list nor the review
  //     column). AFTER the monitor, so its prune has already settled which
  //     workers are still counted. See promoteUnownedDelivered's header.
  await promoteUnownedDelivered(engine, deps, tasks)
  if (!engine.running) return

  // 3. Reconcile: a counted worker whose card is STILL in todo means an earlier
  //    todo→doing move didn't land. Retry it so "起動した分だけ todo→doing へ移る"
  //    holds even across a transient board-write failure. (A worker that DIED with
  //    its card still in todo was pruned in step 2, so it's eligible for
  //    re-dispatch below instead — the correct recovery.)
  const countedIds = new Set(engine.workers.map((w) => w.taskId))
  for (const card of todos) {
    if (!countedIds.has(card.id)) continue
    const w = engine.workers.find((x) => x.taskId === card.id)
    try {
      if (await deps.moveToDoing(engine.path, card.id, w?.branch ?? '')) {
        logLine(engine, 'info', `column move reconciled: ${shorten(card.title ?? '')}`, 'routine')
      }
    } catch {
      /* keep retrying on later passes */
    }
  }

  // 3b. SPAWN PARK (card 0add9d30 — churn stop; extended with the owner's model
  // mask): when no tier is BOTH enabled and cooled-down, hold ALL new dispatch
  // instead of spawning a fresh worker into the same exhausted wall every tick.
  // Two kinds, one gate (swarmAllowedModels.spawnBlock):
  //   • all-cooling  — every ENABLED tier is cooling; park until the earliest
  //                    reset. Self-lifting, exactly as before (a tier the owner
  //                    disabled is no longer counted as headroom, so switching
  //                    fable OFF makes "opus+sonnet+haiku cooling" a full park).
  //   • none-allowed — the owner switched every tier OFF. There is NO reset to
  //                    wait for, so beyond the journal line the engine ESCALATES:
  //                    only a human re-enabling a tier can end this.
  // Existing workers (already counted, already running) and the monitor/reconcile
  // steps above are UNAFFECTED — this only gates step 4 below. A parked todo card
  // is simply left in 'todo' (no card mutation); the moment a tier is spawnable,
  // this returns null and step 4 resumes exactly where selectDispatch left it.
  // Autonomy OFF already returns before this point (top-of-function `if
  // (!engine.running) return`), so park never fires while the engine is off.
  // Logged (and escalated) only on the ENTER edge, keyed by `spawnBlockSig` — not
  // every 3s tick — so the journal stays legible.
  const block = spawnBlock(now, await getAllowedModelTiers())
  if (block) {
    const sig = block.kind === 'none-allowed' ? 'none-allowed' : `cooling:${block.until}`
    // `parkUntil` stays the COOLING deadline (what the dashboard reads): a
    // none-allowed hold has no deadline, so it clears rather than fakes one.
    engine.parkUntil = block.kind === 'all-cooling' ? block.until : undefined
    if (engine.spawnBlockSig !== sig) {
      engine.spawnBlockSig = sig
      logLine(engine, 'warn', describeSpawnBlock(block, 'holding new dispatch'), 'dispatch')
      if (block.kind === 'none-allowed') await raiseNoAllowedModelTier(engine, deps)
    }
    return
  }
  if (engine.spawnBlockSig != null) {
    engine.spawnBlockSig = undefined
    engine.parkUntil = undefined
    logLine(engine, 'info', 'quota park lifted — a tier is usable, resuming dispatch', 'dispatch')
  }

  // 4. Fill open slots with the next queue-order todos. A slot is occupied by any
  //    LIVE worker (a 'done' worker whose PTY still lingers still holds its slot —
  //    the integration stage frees it by tearing the worktree down); a dead
  //    worker kept only to retry a board write does not.
  const live = engine.workers.filter((w) => deps.isAlive(w)).length
  // selectDispatch owns ALL dispatch gates (column / id / content-dup / same-file
  // serialization), so it takes the FULL board, not just the todo slice: it needs
  // the doing-column cards to know which conflict surfaces are already claimed.
  // Run it UNCAPPED-to-MAX first to read the INDEPENDENT backlog (its gates fold
  // same-file / duplicate / dep-blocked todos out), then DYNAMICALLY scale the
  // target to that backlog instead of always filling to MAX (card ea369937).
  const dispatchable = selectDispatch(tasks, countedIds, ORCHESTRATOR_MAX_WORKERS)
  const target = computeTargetWorkers({
    liveWorkers: live,
    dispatchableTodos: dispatchable.length,
    // Token budget (card 68d8e00f): economy caps parallel workers low, optimize middling,
    // max keeps the historical band — each live worker is a full `claude`, so this is a lever.
    max: execModeMaxWorkers(await getExecutionMode(), ORCHESTRATOR_MAX_WORKERS),
  })
  // New spawns = how far below target we are. The engine only ever SPAWNS here; it
  // SHRINKS passively (target < live ⇒ 0 new ⇒ live workers retire as PTYs exit —
  // never killed to hit a lower target). Bounded by `target ≤ MAX`, so this can
  // never breach the concurrency ceiling (暴走防止).
  const slots = Math.max(0, target - live)
  // Surface the scale DECISION in the journal (条件4), but only when the target
  // CHANGES — not every 3s tick — so transitions are legible without churning the
  // ring buffer. 'routine' keeps it in the full log while the Key view stays focused
  // on dispatch/promote/integrate events.
  const scaleSig = String(target)
  if (scaleSig !== engine.lastScaleSig) {
    engine.lastScaleSig = scaleSig
    logLine(
      engine,
      'info',
      `scale: target ${target} worker(s) — ${live} live + ${dispatchable.length} independent todo(s) ready (band ${ORCHESTRATOR_MIN_WORKERS}–${ORCHESTRATOR_MAX_WORKERS})`,
      'routine',
    )
  }
  // SDK spawn-failure backoff (2026-08-13): while the hold is live, attempt NO
  // new spawns this pass — retrying a broken SDK environment every 3s only burns
  // worktree churn. Deliberately silent here (the hold was journalled + belled
  // when it was set); monitor/promote/reclaim above are untouched. The first
  // pass after `until` tries again; the first SUCCESS clears the hold.
  const heldSlots =
    engine.sdkSpawnHold && now < engine.sdkSpawnHold.until ? 0 : slots
  // Picking with cap `slots` is exactly the first `slots` of the MAX-capped run
  // (selectDispatch's greedy gate state is prefix-stable), so slice — one probe, no
  // redundant second pass.
  const picks = dispatchable.slice(0, heldSlots)

  // RESERVE EVERY pick BEFORE the FIRST spawn. Reserving inside the loop instead
  // (one card at a time) left picks[1..] unreserved for the whole of picks[0]'s
  // spawn — hundreds of ms — during which a manual dispatch
  // (POST /api/swarm/worker) reads isCardDispatchInFlight() === false, claims one
  // of them and spawns on it. The loop would then reach that card and spawn a TWIN
  // worker. The reservation is what the manual route asks about, so it has to cover
  // every card this pass intends to spawn, from before the first spawn starts.
  // Only ids WE added are released below — never another holder's reservation.
  const pending = (engine.pendingDispatch ??= new Set())
  const reserved = picks.filter((card) => !pending.has(card.id)).map((card) => card.id)
  for (const id of reserved) pending.add(id)

  try {
    for (const card of picks) {
      if (!engine.running) return // a stop mid-pass halts promptly (finally releases)
      // RE-CHECK THE QUOTA PARK GATE PER CARD (2026-07-29).
      //
      // `spawnBlock` is evaluated ONCE, at the top of the pass — but the state it
      // reads changes DURING this loop: the pre-launch probe cools a tier the
      // moment it finds a wall, and each spawn can hit a limit that cools the next
      // rung. So a pass that began with headroom could walk the whole ladder dry
      // on card 1 and still seat cards 2..N — up to the full worker cap — every one
      // of them into a wall, burning a session each. (resolveAvailableTierProbed
      // does not stop them: having probed every rung dry it falls back to the sync
      // walk, which returns a COOLING tier rather than null, and the spawn path
      // only refuses on null.) One cheap re-read per card closes it; the remaining
      // picks are simply left in `todo` for the next tick, which is what park means.
      // The pass's own `now`, not Date.now() — this module is clock-injected
      // throughout, and marks written during the pass are stamped relative to it.
      const midBlock = spawnBlock(now, await getAllowedModelTiers())
      if (midBlock) {
        logLine(
          engine,
          'info',
          `dispatch halted mid-pass — every model tier is now ${midBlock.kind === 'none-allowed' ? 'switched OFF' : 'cooling'}; remaining cards stay in todo`,
          'routine',
        )
        return
      }
      const title = card.title ?? ''
      const notes = typeof card.notes === 'string' ? card.notes : undefined
      // LEARNING LOOP (card fdf714ef): if this SAME card was previously 差し戻し /
      // rolled back, hand the recorded failure reason (reworkOrPark) to the fresh
      // worker's /order so it doesn't repeat the RED verify / must-fix. Read here,
      // CONSUMED (deleted) only after a successful spawn so a thrown spawn keeps it
      // for next pass — and so a later, unrelated dispatch of the same id can never
      // ride a stale reason.
      const priorFailure = engine.reworkReasons.get(card.id)

      // RE-VERIFY the card RIGHT BEFORE spawning it. The reservation above shuts the
      // manual route out from here on, but a claim that landed BEFORE we reserved
      // (the route's CAS moved it todo→doing while we were reading the board or
      // spawning an earlier pick) is only visible in the board. `picks` is a snapshot
      // taken before the first spawn; spawning off it unconditionally is what put a
      // second worker on an already-claimed card. A stale pick is skipped, not fatal.
      let fresh: ProjectTask | undefined
      try {
        fresh = (await deps.fetchTasks(engine.path)).find((t) => t.id === card.id)
      } catch (e) {
        logLine(engine, 'warn', `dispatch re-check failed, skipping: ${shorten(title)} — ${errMsg(e)}`, 'dispatch')
        continue
      }
      if (!fresh || !isTodoCard(fresh)) {
        logLine(
          engine,
          'warn',
          `dispatch skipped — card no longer todo (claimed elsewhere): ${shorten(title)}`,
          'dispatch',
        )
        continue
      }

      // ── GO BACK TO WHERE THIS CARD'S WORK ALREADY IS (2026-08-04) ────────
      // A worker reclaimed at a quota wall returns to 'todo' with `card.branch`
      // still set (the recover write only sets the column). Minting a fresh
      // worktree here made the todo→doing move stamp a NEW branch over it, and
      // the commits already paid for became reachable only through
      // `git branch --list` — orphaned, silently, every time the wall was hit.
      // Re-entering the same branch makes that stamp a write of the value it
      // already had.
      //
      // `null` covers both "no branch on the card" (the ordinary first dispatch)
      // and "could not be resolved" (branch gone, git refused) — either way we
      // fall through to a normal fresh dispatch, which is the pre-existing
      // behaviour and never worse than it.
      const reuse = await (deps.resolveReusableWork ?? defaultResolveReusableWork)(
        engine.path,
        card,
      ).catch(() => null)
      if (reuse) {
        logLine(
          engine,
          'info',
          `前回の作業場に戻ります: ${shorten(title)} — 途中まで進んだ内容はそのまま残っています(${reuse.branch})`,
          'dispatch',
        )
      }

      let spawn: SpawnSwarmWorkerResponse
      try {
        spawn = await deps.spawnWorker({
          projectPath: engine.path,
          title,
          notes,
          hint: title,
          priorFailure,
          ...(reuse ? { worktree: reuse.worktree } : {}),
        })
      } catch (e) {
        logLine(engine, 'error', `dispatch failed: ${shorten(title)} — ${errMsg(e)}`, 'dispatch')
        // SDK-only workers (2026-08-13): an environment that cannot start an SDK
        // session will not heal in 3 seconds — back off + tell the owner, and
        // stop burning worktree-rollback churn on every tick. Other spawn
        // failures (a transient git hiccup) keep the fast retry they always had.
        if (e instanceof SdkWorkerUnavailableError) {
          await holdSdkSpawn(engine, errMsg(e), now)
          break
        }
        continue
      }
      if (priorFailure) engine.reworkReasons.delete(card.id) // consumed — injected into this /order
      // Dispatch works again — retire any spawn-failure hold (self-recovery: the
      // owner fixed the cause, e.g. signed back in; nothing to re-arm by hand).
      if (engine.sdkSpawnHold) {
        engine.sdkSpawnHold = undefined
        logLine(engine, 'info', 'SDK spawn recovered — dispatch resumed', 'routine')
      }

      // Count it BEFORE the column move: the PTY is already live, so even if the
      // move fails the worker must stay counted (the dispatchedIds guard then
      // blocks a re-dispatch, and step 3 reconciles the move next pass). It enters
      // at stage 'starting' — the next monitor pass advances it.
      engine.workers.push({
        terminalId: spawn.terminalId,
        branch: spawn.branch,
        worktree: spawn.worktree,
        taskId: card.id,
        taskTitle: title,
        startedAt: new Date().toISOString(),
        stage: 'starting',
        // HOW it was launched. Absent ⇒ 'pty', so an older fake/caller that does
        // not report a runtime keeps meaning what it always meant. The handles
        // are mutually exclusive by invariant (workerRuntime.ts).
        ...(spawn.runtime === 'sdk' ? { runtime: 'sdk' as const } : {}),
        ...(spawn.sdkSessionId ? { sdkSessionId: spawn.sdkSessionId } : {}),
        // Launch tier, for the monitor's rate-limit sighting → cooling-table
        // attribution (absent from older fakes/callers — then nothing is marked).
        ...(spawn.model ? { model: spawn.model } : {}),
        ...(spawn.effort ? { effort: spawn.effort } : {}),
        // card 3 — capture the session UUID (for card 4's --resume) + carry the
        // card's current 差し戻し count into the roster. Both are persisted by the
        // end-of-pass syncRoster (this spawn changes the roster signature).
        ...(spawn.agentSessionId ? { sessionId: spawn.agentSessionId } : {}),
        reworkCount: fresh.reworkCount ?? 0,
      })
      // The dispatch line records WHETHER the learning-loop context was injected (有/無),
      // so a re-dispatch carrying the prior failure is visible in the engine log.
      logLine(
        engine,
        'info',
        `dispatch: ${shorten(title)} → ${spawn.branch}${priorFailure ? ' [再投入: 前回差し戻しの原因を /order に注入]' : ''}`,
        'dispatch',
      )

      try {
        if (!(await deps.moveToDoing(engine.path, card.id, spawn.branch))) {
          logLine(engine, 'warn', `column move kept (will retry): ${shorten(title)}`)
        }
      } catch (e) {
        logLine(engine, 'warn', `column move kept (will retry): ${shorten(title)} — ${errMsg(e)}`)
      }
    }
  } finally {
    // Release EVERY id this pass reserved, on every exit path — a normal finish, a
    // `return` when the engine stops mid-pass, or a throw. Once a card's move has
    // settled it reads `doing` on the board; if the move was KEPT the worker still
    // sits in engine.workers — either way the twin guard (isCardDispatchInFlight)
    // keeps holding it without the reservation. A card we skipped or whose spawn
    // threw goes back to being freely dispatchable, which is correct.
    for (const id of reserved) pending.delete(id)
  }

  // card 3 — WRITE-THROUGH the roster ONCE per pass, AFTER every mutation (monitor
  // reclaim/promote + this pass's spawns). The signature guard inside makes this a
  // no-op unless the worker set / a stage / a rework marker actually changed, so a
  // plain time-passing tick does no I/O (plan §3 "書くのは状態遷移点のみ"). Never
  // throws (fail-open). `byId` (this pass's board read) refreshes each worker's
  // reworkCount from its card.
  await syncRoster(engine, now, byId)
}

// ── The review-waiting clock's disk mirror (2026-08-14) ─────────────────────

/** A stable signature of the review-waiting set — what makes the mirror below a
 *  state-transition write. Sorted by branch so map insertion order (which follows the
 *  board's, and therefore wobbles) can never look like a change. */
const reviewWaitingSignature = (clock: ReadonlyMap<string, number>): string =>
  Array.from(clock.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([b, at]) => `${b}@${at}`)
    .join('|')

/** Engines whose dwell-clock mirror has already reported a disk fault. The warn is
 *  latched per engine because — unlike the owner-action intent writes, which happen once
 *  per click — this mirror runs on every clock CHANGE, and a permanently-unwritable
 *  project (an unregistered path, a torn home) would otherwise print the same line for
 *  the life of the process. Said once is diagnosis; said forever is noise that buries the
 *  next real line. WeakSet so a dropped engine is collected with it. */
const reviewWaitingPersistWarned = new WeakSet<ProjectEngine>()

/** Mirror `engine.reviewSeenAt` into `engine.json` so the NEXT boot resumes the dwell
 *  clock instead of restarting it (see {@link ProjectEngine.reviewSeenAt}'s ⚠ note).
 *
 *  FAIL-OPEN in both directions and never throws: `patchEngineIntent` swallows its own
 *  disk faults, and a `false` return is logged (once) and dropped. The in-memory clock is
 *  this process's truth; the file is a best-effort head start for the next one, so a bad
 *  disk must cost nothing but that head start. The signature is updated ONLY on a
 *  successful write, so a transient fault is retried on the next pass that moves the
 *  clock. */
const persistReviewWaiting = async (
  engine: ProjectEngine,
  clock: ReadonlyMap<string, number>,
): Promise<void> => {
  const sig = reviewWaitingSignature(clock)
  // `?? ''` — an engine that has never persisted and holds an EMPTY clock is already in
  // agreement with disk, so a project with nothing in review never writes at all.
  if ((engine.reviewSeenPersisted ?? '') === sig) return // nothing arrived, nothing left: no IO
  const ok = await patchEngineIntent(engine.path, {
    // An EMPTY object CLEARS the field (see EngineIntentWrite.reviewWaitingSince) — the
    // queue draining is exactly when the clock must stop, or a boot months later would
    // resume a dwell for branches that were integrated long ago.
    reviewWaitingSince: Object.fromEntries(clock),
  })
  if (ok) engine.reviewSeenPersisted = sig
  else if (!reviewWaitingPersistWarned.has(engine)) {
    reviewWaitingPersistWarned.add(engine)
    logLine(engine, 'warn', 'review dwell clock persist failed (disk) — in-memory clock unaffected')
  }
}

// ── The commander is up, and stuck (2026-08-14) ─────────────────────────────

/** Why the engine gave up on getting the commander's attention — the two dead ends
 *  the wake reflex used to end in, both of them silent:
 *    - `'ignored'`      — every poke landed in the desk and none was answered
 *                         (the nudge BUDGET is spent).
 *    - `'unaddressable'` — no poke could be WRITTEN at all, {@link MAX_MANAGER_NUDGES}
 *                         times running: the desk is live but the session store no
 *                         longer names it, so neither writer can address it. Not the
 *                         same fact, and the owner is told which one it is. */
type ManagerUnresponsiveCause = 'ignored' | 'unaddressable'

/** What the owner READS when the commander desk is up and stuck. Pure, so the wording is
 *  assertable without a pass — and owner-facing, so it is plain Japanese that names the
 *  situation and the two things the owner can actually do (CLAUDE.md's owner-facing text
 *  rule; the same voice as the other swarm notification `detail`s in this file). */
export const managerUnresponsiveDetail = (input: {
  cause: ManagerUnresponsiveCause
  /** How long the OLDEST waiting card has been in review, ms. */
  waitedMs: number
  /** How many swarm cards are waiting to be integrated. */
  waiting: number
}): string =>
  `司令官の卓は動いていますが、統合が ${Math.round(input.waitedMs / 60_000)} 分止まっています` +
  `(統合待ち ${input.waiting} 件・` +
  (input.cause === 'ignored'
    ? `声かけ ${MAX_MANAGER_NUDGES} 回に応答なし`
    : `${MAX_MANAGER_NUDGES} 回続けて声をかけられませんでした`) +
  ')。司令官に「マージ」と声をかけるか、司令官を再起動してください'

/** THE ESCALATION for a commander desk that is present but not integrating — the bell the
 *  two dead ends above never rang, plus the one recovery attempt that is safe to make
 *  unattended.
 *
 *  WHY IT EXISTS (docs/commander/03-integration-review.md §7-9/§7-10, landed 2026-08-14).
 *  Both dead ends ended in a single engine log line and then silence forever: the spent
 *  nudge budget (「N 回の声かけに応答しません」) and the un-addressable desk (「声をかけら
 *  れません」). The reasoning was sound as far as it went — a wedged desk IS a human
 *  matter, and 'manager-unrevivable' would be a lie here because a desk plainly exists
 *  (03章 §2.3 完了条件3) — but "a human matter" was implemented as "tell no human". The
 *  field bug: engine ON, two cards sat in review, the SDK desk alive and idle, the engine
 *  gave up nudging and said nothing. §7-10 recorded this as a REGRESSION in reachability
 *  (the pre-2026-07-18 code did reach the owner, under the wrong label) and deferred the
 *  fix to a later card for want of a display surface. This is that card; the display
 *  surface (union → sanitizer → FATAL_EVENT_LABEL → en/ja) is wired with it.
 *
 *  THREE GATES, and each one is load-bearing:
 *    1. `waitedPastStall` — the work must have waited past
 *       {@link MANAGER_INTEGRATION_STALL_MS}. The budget alone is not evidence of a
 *       STALL: a desk can ignore three pokes inside half an hour while the queue is
 *       perfectly fresh. Deliberately the raw DWELL, not the `stalled` verdict, which
 *       also demands delivery evidence and reads false when no channel says anything —
 *       fail-open is right for deciding whether to ESC a desk, and wrong for deciding
 *       whether to tell the owner about work that is provably sitting still.
 *    2. ONE BELL PER EPISODE — `unresponsiveFatalFired`, cleared only where the reflex
 *       is disarmed (queue drained / desk seen working). A batch that never drains must
 *       not turn into a notification every pass.
 *    3. SDK-ONLY RECYCLE — see {@link IntegrationDeps.managerDeskRuntime}.
 *
 *  ORDER MATTERS: the recycle is attempted FIRST and its failure is swallowed, because
 *  the notification must not depend on the recovery succeeding — a teardown that throws
 *  is precisely the case where the owner most needs to hear about it. Never throws. */
const escalateUnresponsiveManager = async (
  engine: ProjectEngine,
  deps: IntegrationDeps,
  rs: NonNullable<ProjectEngine['managerResume']>,
  ctx: {
    cause: ManagerUnresponsiveCause
    /** Has the oldest waiting card sat past {@link MANAGER_INTEGRATION_STALL_MS}? */
    waitedPastStall: boolean
    waitedMs: number
    waiting: number
    branch?: string
    taskTitle?: string
  },
): Promise<void> => {
  if (!ctx.waitedPastStall) return
  if (rs.unresponsiveFatalFired) return
  // Latch BEFORE the awaits below: passes cannot overlap (integrateInFlight), but a
  // one-shot whose latch lands after an await is a one-shot only by luck.
  rs.unresponsiveFatalFired = true

  // RECYCLE (item 2) — an SDK desk that will not answer is worth restarting, because the
  // engine's absent arm already knows how to seat a fresh one and `spawnSwarmManager`
  // resumes the same conversation. A PTY desk is NOT: it is a terminal in the owner's own
  // cwd, possibly one they started and are reading. Once per episode either way.
  if (!rs.deskRecycled && deps.managerDeskRuntime && deps.recycleManagerDesk) {
    try {
      const runtime = await deps.managerDeskRuntime(engine.path)
      if (runtime === 'sdk') {
        rs.deskRecycled = true // charged on the ATTEMPT — a throwing teardown must not retry
        const closed = await deps.recycleManagerDesk(engine.path)
        logLine(
          engine,
          'warn',
          closed
            ? `司令官の卓(SDK)が応答しないため一度閉じました — 次のパスで新しい卓を起動します(統合待ち ${ctx.waiting} 件)`
            : `司令官の卓(SDK)を閉じられませんでした — 手動で司令官を再起動してください(統合待ち ${ctx.waiting} 件)`,
          'integrate',
        )
      }
    } catch (e) {
      // Swallowed on purpose (see the header): the bell below is the point.
      logLine(engine, 'warn', `司令官の卓の再起動に失敗しました: ${errMsg(e)}`, 'integrate')
    }
  }

  // THE BELL (item 1) — best-effort, never awaited, internal-catch: the same fatal-notify
  // contract every other escalation in this file follows.
  deps.notify?.({
    event: 'manager-unresponsive',
    projectPath: engine.path,
    ...(ctx.branch ? { branch: ctx.branch } : {}),
    ...(ctx.taskTitle ? { taskTitle: ctx.taskTitle } : {}),
    detail: managerUnresponsiveDetail({ cause: ctx.cause, waitedMs: ctx.waitedMs, waiting: ctx.waiting }),
    logHint: 'Swarm タブ → マネージャー / engine log の integrate 行',
  })
}

// ── The integration pass (Card③ — review → done, the riskiest stage) ─────────

/** ONE integration pass. Throttled to INTEGRATE_TICK_MS inside the loop. In
 *  TWO halves — BOTH unconditional while the engine is running (the auto-wake
 *  toggle was RETIRED 2026-07-16; engine ON = the wake reflex is armed, see the
 *  Part-B comment below):
 *   A. Classify every review-column swarm card's readiness against the trunk,
 *      READ-ONLY (no git mutation), and publish it on engine.reviews — the
 *      "統合可" display the owner sees.
 *   B. Keep the commander alive to integrate: when review cards are waiting and
 *      the commander desk is absent/hung, WAKE it (spawnSwarmManager, batched) —
 *      the engine itself never merges.
 *  Honors the global stop: it bails the moment engine.running flips false
 *  between the slow awaits. Never throws — guarded + logged.
 *
 *  CONCURRENCY (integrate-beside-the-tick): driven by {@link kickIntegratePass},
 *  fire-and-forget, so this pass OVERLAPS dispatch/monitor ticks instead of
 *  starving them behind its multi-minute verify/panel awaits. Its board/worker
 *  WRITE sections take the engine critical section (see runExclusive); the slow
 *  awaits deliberately don't. `integrateInFlight` bars two of these from ever
 *  overlapping each other. */
export const runIntegratePass = async (
  engine: ProjectEngine,
  deps: IntegrationDeps,
  // Injected for deterministic tests of the RESURRECTION reflex's time-based state
  // machine (stale window / boot grace). Production passes the wall clock.
  now: number = Date.now(),
): Promise<void> => {
  if (!engine.running) return
  // Throttle: skip ticks until INTEGRATE_TICK_MS has passed (the loop still
  // ticks every TICK_MS for dispatch). lastIntegrateAt starts at 0 so the first
  // pass after start runs immediately.
  if (now - engine.lastIntegrateAt < INTEGRATE_TICK_MS) return
  engine.lastIntegrateAt = now

  const target = await deps.prepareTarget(engine.path)

  let reviews: ProjectTask[]
  try {
    reviews = await deps.fetchReview(engine.path)
  } catch (e) {
    logLine(engine, 'warn', `review read failed: ${errMsg(e)}`)
    return
  }
  // Only the swarm's OWN branches are ever a subject — the hard ownership line.
  //
  // …and NEVER a card the owner said to drop (`abandoned`). This is where
  // 「B: この作業は見送る（できあがった分も取り込みません）」 actually takes effect:
  // everything downstream of `swarmCards` is the machinery that gets the work
  // INTEGRATED — the readiness snapshot the pane shows, the 「統合してください」
  // notice typed into the commander's desk, and the resurrection reflex that
  // keeps a desk alive because work is waiting. Answering used to record the
  // owner's words and change none of it, so the commander went on to merge the
  // branch the owner had just declined — onto the trunk, irreversibly.
  const swarmCards = reviews.filter(
    (c): c is ProjectTask & { branch: string } =>
      typeof c.branch === 'string' && isSwarmBranch(c.branch) && c.abandoned !== true,
  )

  // Forget conflict + verify-fail + review-fail memos for branches no longer in
  // review (card moved/finished) — a fresh attempt should re-classify cleanly.
  const present = new Set(swarmCards.map((c) => c.branch))
  for (const b of Array.from(engine.conflictedBranches)) {
    if (!present.has(b)) engine.conflictedBranches.delete(b)
  }
  for (const b of Array.from(engine.verifyFailed.keys())) {
    if (!present.has(b)) engine.verifyFailed.delete(b)
  }
  for (const b of Array.from(engine.reviewFailed.keys())) {
    if (!present.has(b)) engine.reviewFailed.delete(b)
  }
  for (const b of Array.from(engine.reviewDeferred.keys())) {
    if (!present.has(b)) engine.reviewDeferred.delete(b)
  }
  for (const b of Array.from(engine.highRiskHolds.keys())) {
    if (!present.has(b)) engine.highRiskHolds.delete(b)
  }
  // The OUTCOME clock (2026-07-22): stamp每 branch the first time it is SEEN waiting in
  // review, and drop it the moment it leaves — on the same `present` sweep, so "the queue
  // moved" and "the clock resets" are the same event and cannot drift apart. Kept here
  // (not in the manager block below) because it must run on EVERY pass, including the ones
  // where the desk reads healthy: the clock has to have been ticking before it is read.
  const reviewSeenAt = (engine.reviewSeenAt ??= new Map()) // lazy backfill (older build / test literal)
  for (const b of Array.from(reviewSeenAt.keys())) {
    if (!present.has(b)) reviewSeenAt.delete(b)
  }
  // THE COMPLETION EVENT (2026-07-27). A branch appearing here for the FIRST time is
  // precisely "a worker just became ready" — the instant the engine has always had and
  // never used. Everything downstream read the review column as a STATE ("something is
  // piled up, is the desk hung?") and so could only ever react slowly and suspiciously;
  // this reads it as an EVENT and hands it to the notice channel below.
  const freshlyReady: string[] = []
  for (const c of swarmCards) {
    if (!reviewSeenAt.has(c.branch)) {
      reviewSeenAt.set(c.branch, now)
      freshlyReady.push(c.branch)
    }
  }
  // MIRROR THE CLOCK TO DISK (2026-08-14) — the prune and the stamp above are the only
  // two events that change it, so this is the one place the mirror can be written from.
  // A state-transition write, not a per-pass one: the signature guard makes an ordinary
  // tick (nothing arrived, nothing left) touch no disk at all, the same rule syncRoster
  // follows. Fail-open and non-fatal — `persistReviewWaiting` never throws, and a mirror
  // that cannot be written costs only the NEXT boot's head start.
  await persistReviewWaiting(engine, reviewSeenAt)
  // A notice can sit undelivered for a while (the desk may be mid-turn), so prune it on
  // the SAME `present` sweep as the clock above: a branch the commander has meanwhile
  // integrated must not still be announced as news. If nothing it names survives, the
  // notice has nothing left to say — anything else still in review was announced by its
  // own notice when it arrived — so drop it rather than deliver a report about branches
  // that are gone.
  if (engine.managerNotice) {
    const live = engine.managerNotice.branches.filter((b) => present.has(b))
    engine.managerNotice = live.length > 0 ? { ...engine.managerNotice, branches: live } : null
  }
  // ONE SLOT, newest wins (see ProjectEngine.managerNotice). A fresh arrival while an
  // earlier notice is still undeliverable REPLACES it rather than queueing behind it:
  // the message is "go look at review", so the newer one says everything the older did.
  if (freshlyReady.length > 0) {
    engine.managerNotice = { branches: freshlyReady, queuedAt: now }
  }

  // A. Read-only readiness for the dashboard (both switch positions).
  const readiness: OrchestratorReview[] = []
  for (const card of swarmCards) {
    let status: OrchestratorReviewStatus
    if (engine.conflictedBranches.has(card.branch)) status = 'conflict'
    else if (!target) status = 'unknown'
    else status = await deps.classify(engine.path, card.branch, target)
    readiness.push({ taskId: card.id, branch: card.branch, taskTitle: card.title ?? '', status })
  }
  engine.reviews = readiness

  // ── B. MANAGER-ONLY INTEGRATION + RESURRECTION (2026-07-15) — "keep the
  //       commander alive to integrate" ──
  //
  //  The engine NO LONGER integrates. Everything that used to live here — the
  //  high-risk force-hold gate, the verify (tsc/lint/safety/test) gate, the
  //  adversarial LENS panel + its majority vote, the cross-process integration lock,
  //  the FF / rebase push that moved the trunk, the review→done move, the worktree
  //  teardown, and the reworkOrPark / delegateConflict 差し戻し machinery — is GONE.
  //  Integration is the COMMANDER's job ALONE now: its own heavyweight review +
  //  manual FF push (skills/og-manage §「マージ」). The safety nets that used to live
  //  here — the fail-closed 0-vote ban and the high-risk force-hold — now live only
  //  in that manual-merge flow (完了条件4; the engine-side copies are retired, not
  //  double-managed — docs/commander/03-integration-review.md).
  //
  //  WHY (the 2026-07-15 incident): auto-integrate FF-pushed a hole-y branch onto main
  //  OVER the commander's concurrent review→doing 差し戻し — two integrators racing on
  //  one trunk. And its budget-bounded lens majority (4 votes clean) had missed an
  //  auth camelCase hole that the commander's heavyweight reviewer caught. Taking the
  //  engine out of the merge business entirely makes that race STRUCTURALLY impossible
  //  (a mechanism, not a rule) and guarantees the engine's lens result can no longer
  //  move main by ANY route (完了条件1+3 — fixed in tests).
  //
  //  BUT making integration manager-only means the swarm STALLS if the commander stops
  //  — and it does stop (opus flooded by a big diff: context overflow / API error /
  //  hang — the owner's actual complaint). So the engine keeps a RESUSCITATION reflex
  //  (card B, 完了条件1-6): with work WAITING it reads the desk's PRESENCE
  //  (managerPresence: absent / idle / active) and responds in kind — spawn only when
  //  there is NO desk, nudge a live-but-quiet one, leave a working one alone. The
  //  engine only WAKES — it never integrates on the commander's behalf (完了条件6, reflex
  //  ≠ judgment). A desk that cannot be RAISED escalates instead of looping (完了条件5).
  //
  //  2026-07-18 CORRECTION: that probe used to be a single bit — live PTY AND a fresh
  //  heartbeat — and the AND was a trap. The commander beats only while doing heavy
  //  integration work, so a healthy desk (talking with the owner, or just booted and
  //  running 「状況」) goes silent past the window and read as HUNG. The engine then
  //  "resuscitated" a desk that was alive and working, three times, and finally fired a
  //  FALSE 'manager-unrevivable' fatal — while piling up orphaned idle desks, because a
  //  session held by a live PTY cannot be --resume'd so each spawn opened a new one.
  //  Presence now folds in evidence the PTY itself emits (paint + transcript growth),
  //  and only 'absent' may spawn (完了条件1-3).
  //
  //  ALWAYS ARMED while the engine runs (2026-07-16): the separate auto-wake toggle
  //  (the old `autoMerge` flag + POST /api/swarm/orchestrator/automerge) was RETIRED —
  //  with it OFF, ready work sat unattended in review (observed in production), and
  //  since waking moves nothing on the trunk there is no half-way autonomy worth
  //  keeping. Engine ON = the wake reflex is on; engine OFF (or an app restart, which
  //  always relaunches OFF) stops it. Merge CONSENT stays per-card: the [hold] title
  //  prefix and the commander's high-risk force-hold (HIGH_RISK_PATHS) gate what
  //  actually lands. A hand-driven desk stays safe either way: managerPresence reports
  //  any desk with a live PTY as present ('active' or at worst 'idle'), and only
  //  'absent' can spawn — so the reflex can never tear down or duplicate the owner's
  //  own desk; worst case it wakes one the owner would have started themselves.

  const rs = (engine.managerResume ??= { attempts: 0, lastWakeAt: 0, fatalFired: false })

  // No integrable work → the commander isn't needed. DISARM the reflex fully (a later
  // batch starts a clean episode) and stop — we never resuscitate a desk with no work.
  if (swarmCards.length === 0) {
    rs.attempts = 0
    rs.lastWakeAt = 0
    rs.fatalFired = false
    rs.nudges = 0
    rs.lastNudgeAt = 0
    rs.unresponsiveLogged = false
    // The stall episode ends with the batch it was measured against (2026-07-22): the
    // one-shot explain-line and the one-shot budget re-arm both belong to THIS waiting
    // batch, so a later one starts with a full voice. (`engine.reviewSeenAt` needs no
    // reset here — the `present` sweep above already emptied it.)
    rs.stallLogged = false
    rs.nudgeRearmed = false
    // The 2026-08-14 pair belongs to the waiting batch too — the bell says 「統合待ちが N
    // 件あるのに司令官が動いていない」, which is a claim about THIS batch. A drained queue
    // ends the episode, so the next one may ring again (and may recycle a desk once).
    // ⚠ Deliberately NOT reset by a respawn: a fresh desk INSIDE the same batch is still
    // the same stuck integration, and re-arming there would let a wedged desk be torn
    // down and re-belled on every budget cycle — the loop `deskRecycled` exists to stop.
    rs.unresponsiveFatalFired = false
    rs.deskRecycled = false
    // "Fully" has to include `lastWakeSpawned` too (card add3af4c, 2026-07-22 sibling
    // fix): it is the transient-vs-permanent bit the give-up ratchet reads (below), so
    // a stale `true` carried out of THIS episode into the next one would make a fresh
    // episode's very first give-up read as "a desk spawned and died" even before this
    // episode's own wake ever ran — misjudging a NEW episode on a PREVIOUS one's
    // outcome, exactly the class of bug `provenSinceWake`'s reset comment above
    // already warns about. Absent (the reset value) reads as "spawned" (the
    // conservative default — see the field's own doc comment), so this can only ever
    // make a later give-up MORE cautious, never less.
    rs.lastWakeSpawned = undefined
    // "Fully" has to include this one. (Reachability note, measured 2026-07-19: the
    // end-to-end false fatal is NOT reproducible through this leak alone, because this
    // same block zeroes `attempts`, so the refund the stale `false` blocks is a no-op, and
    // any later spawn re-sets the flag itself. It is fixed as an INVARIANT, not a live
    // exploit — the coupling that makes it harmless today is incidental.) `provenSinceWake` is a verdict about THE DESK WE
    // LAST SPAWNED, so carrying a `false` into the next episode judges a new batch on a
    // previous desk's reputation — and it does real harm, not just bookkeeping: the desk
    // can finish an entire integration without the engine ever happening to SAMPLE it as
    // 'active' (the probe runs on a 15s tick; a batch can drain between two of them), and
    // then the next batch finds `provenSinceWake===false` with `lastWakeAt` cleared, so
    // neither the boot grace nor the idle refund applies. `attempts` would climb straight
    // to a `manager-unrevivable` fatal against a desk that is alive and answering — the
    // EXACT harm this whole card exists to remove. Restore the default ("nothing spawned,
    // so nothing to prove" ⇒ treated as proven, which is also what protects a desk the
    // owner started by hand).
    rs.provenSinceWake = true
    // Nothing is waiting, so there is nothing to tell anyone. Drop a notice that never
    // found a quiet moment rather than delivering stale news at the next one: the cards
    // it names have already been integrated or moved on.
    engine.managerNotice = null
    return
  }

  // ── C. THE NOTICE (2026-07-27) — tell the commander, at once, without breaking it ────
  //
  //  Deliberately BEFORE the presence probe and OUTSIDE every gate below, because the
  //  desk this most needs to reach is the HEALTHY one. The resurrection machinery that
  //  follows is an accident-recovery reflex: it fires only on a desk it suspects of
  //  hanging, and a commander that is awake and between turns is the case it is most
  //  careful never to touch (`presence === 'active' && !stalled` returns immediately).
  //  That is correct for a reflex that ESCs its way in, and it is why routine news
  //  routed through it took 38m33s to arrive on 2026-07-27. Routine news gets its own
  //  road; the reflex keeps its four gates untouched.
  //
  //  Retried EVERY pass while queued, which is what makes B ("生成中でも失われない")
  //  true: refusals are cheap (an in-memory screen read, no disk) and the retry cadence
  //  is INTEGRATE_TICK_MS, so the notice lands on the first tick after the desk goes
  //  quiet. Not throttled and given no budget of its own — it does not need one, because
  //  it cannot do harm: it writes only to a desk that {@link noticeDeliverable} says has
  //  nothing in flight, nothing half-typed and no chooser open, and it is raised only by
  //  a real arrival.
  if (engine.managerNotice && deps.notifyManagerReady) {
    const pending = engine.managerNotice
    // `total` is read HERE, not at queue time: the queue may have waited out a long
    // generation, and the number the commander is asked to act on has to be the number
    // that is actually waiting now.
    const total = swarmCards.length
    const delivered = await deps
      .notifyManagerReady(engine.path, { branches: pending.branches, total })
      .catch(() => false)
    if (!engine.running) return // owner stopped the engine during the write
    if (delivered) {
      engine.managerNotice = null
      // A SELF-WRITE instant, not a budget — the presence probe below must discount the
      // repaint our own keystrokes cause (see managerResume.lastNoticeAt).
      rs.lastNoticeAt = now
      logLine(
        engine,
        'info',
        `worker 完了を司令官の卓に通知しました(統合待ち ${total} 件・${Math.round((now - pending.queuedAt) / 1000)}秒で到達)`,
        'integrate',
      )
    }
  }

  // Work IS waiting. Ask what the desk actually IS — present? engaged? gone? — rather
  // than the old single "responding y/n" bit. Slow await, but no trunk mutation follows.
  // Discount the echo of ANYTHING WE OURSELVES WROTE into that PTY (see
  // defaultManagerPresence's `echoUntil`). BOTH writes count, and for the same reason:
  //   - the nudge — else the poke refunds its own budget and a wedged desk is poked forever;
  //   - the SPAWN — `launchClaude` writes the launch command into the fresh PTY
  //     (claudeTerminal.ts), and the login shell echoes it back within milliseconds. That
  //     echo alone satisfies "painted recently", so a desk that boots and then dies without
  //     ever doing work still reads 'active' on the very next tick, which zeroes `attempts`
  //     — and a desk that flaps (spawn → echo → die → spawn) can then NEVER reach
  //     MAX_MANAGER_RESUME_ATTEMPTS. That silently retires the infinite-resurrection guard
  //     for exactly the cases it exists for (context overflow / API error / boot-crash:
  //     measured 72 spawns in 6h with zero escalation), turning the 2026-07-18 fix's
  //     failure mode from "false fatal" into "silent token burn".
  //   - the NOTICE (2026-07-27) — the third writer, and subject to the identical trap:
  //     its line makes the TUI repaint immediately, and since a notice fires on every
  //     worker completion it would keep stamping "alive" onto a desk that is wedged,
  //     refunding the nudge budget on a fixed cadence and quietly retiring the
  //     resuscitation guard. Being harmless to the DESK does not make it honest
  //     EVIDENCE about the desk.
  // Guarding only the nudge was asymmetric: the trap is identical on all three writes, so
  // the cutoff is the LATEST of them. Real work paints well past the guard and still counts.
  const lastSelfWriteAt = Math.max(rs.lastNudgeAt ?? 0, rs.lastWakeAt ?? 0, rs.lastNoticeAt ?? 0)
  const presence = await deps.managerPresence(
    engine.path,
    now,
    lastSelfWriteAt > 0 ? lastSelfWriteAt + STALL_ECHO_GUARD_MS : 0,
  )
  if (!engine.running) return // owner stopped the engine during the probe

  // A desk that PAINTS is a desk that came up. Record that before anything else branches:
  // it is a verdict about the desk we last SPAWNED (did the resurrection take?), and it is
  // true whether or not integration is moving. Hoisted out of the healthy branch below so
  // the stall path cannot accidentally withhold the refund and let `attempts` climb toward
  // a false 'manager-unrevivable' against a desk that is demonstrably up (2026-07-22 nit).
  if (presence === 'active') rs.provenSinceWake = true

  // ── IS ANYTHING COMING OUT OF IT? (2026-07-22 — the 80-minute blind spot) ────────────
  // `presence` answered "is a desk alive?", and for a session that speaks one turn and
  // STOPS that is not the same question as "is the integration progressing?". Ask the
  // second one separately, against evidence only real work produces — heartbeat, session
  // transcript, sub-agent transcripts (defaultManagerDeliveryAt). Cheap by construction:
  // the dwell half is in-memory and gates the read, so an ordinary tick touches no disk.
  // See {@link MANAGER_INTEGRATION_STALL_MS} for the measured incident and the margins.
  // Oldest first-sight wins. Folded rather than `Math.min(...spread)` — the spread would
  // put one argument per waiting card on the stack, which is fine at board scale and a
  // RangeError at no scale anyone should have to reason about.
  let waitingSince: number | null = null
  for (const at of Array.from(reviewSeenAt.values())) {
    if (waitingSince === null || at < waitingSince) waitingSince = at
  }
  // The DWELL alone — how long the oldest waiting card has sat — separated out because
  // two different rules read it. `stalled` (below) ANDs it with delivery evidence and
  // fails OPEN when no channel says anything, which is right for deciding whether to ESC
  // a desk. The unresponsive ESCALATION reads the raw dwell instead: by the time it is
  // consulted the engine has already spent its whole poke budget on this desk, so the
  // question is no longer "dare we interrupt it" but "has this work provably sat still
  // long enough to be worth the owner's attention" — and a missing delivery channel must
  // not answer that one with silence.
  const waitedMs = waitingSince === null ? 0 : now - waitingSince
  const waitedPastStall = waitingSince !== null && waitedMs >= MANAGER_INTEGRATION_STALL_MS
  let stalled = false
  if (waitedPastStall) {
    const deliveryAt = await (deps.managerDeliveryAt ?? defaultManagerDeliveryAt)(engine.path)
    if (!engine.running) return // owner stopped the engine during the read
    stalled = managerIntegrationStalled({ waitingSinceMs: waitingSince, deliveryAtMs: deliveryAt, now })
  }

  if (presence === 'active' && !stalled) {
    // Healthy desk on the job → both budgets disarmed (a future silence starts fresh).
    // ('active' also proves the last resurrection took — the launch echo cannot fake it
    // once discounted above — but that is now recorded on the hoisted `provenSinceWake`
    // line, because it is equally true of an 'active' desk whose queue has stalled.)
    rs.attempts = 0
    rs.fatalFired = false
    rs.nudges = 0
    rs.unresponsiveLogged = false
    // A desk seen working also ends the stall episode: the next silence gets the full
    // voice back (explain-line + a fresh re-arm), exactly as it does for `nudges`.
    rs.stallLogged = false
    rs.nudgeRearmed = false
    // …and the two 2026-08-14 latches, for the same reason and on the same rule: the
    // episode is the WAITING BATCH, and a desk demonstrably back at work ends it. A
    // later wedge gets its own bell and its own one recycle, rather than inheriting a
    // spent one and going silent again.
    rs.unresponsiveFatalFired = false
    rs.deskRecycled = false
    return
  }

  // A desk IS up but nothing says it is engaging with the waiting work (2026-07-18).
  // NEVER spawn here. Spawning a twin was the old behaviour and it was wrong twice over:
  // resolveSwarmSession refuses to `--resume` a session a live PTY still holds, so the
  // "resurrection" opened an AMNESIAC second desk, overwrote the persisted session id,
  // and orphaned the working one — 16 idle desks and a duplicate-dispatcher hazard on
  // one trunk (the 2026-07-15 concurrent-integration incident's shape). The desk exists;
  // the right move is to get ITS attention, at zero token cost and with no new session.
  //
  // …OR the desk PAINTS but is not delivering: `stalled` (2026-07-22) routes a
  // demonstrably-not-integrating `'active'` desk down this exact same path. Only the
  // NUDGE gate changes, and the poke it may produce is the same bounded, throttled one a
  // quiet desk gets.
  //
  // `presence === 'active' && stalled`, NOT a bare `|| stalled`: a stall is a statement
  // about the WORK, and it goes true for an 'absent' desk too (nothing is integrating
  // because there is no desk). Letting it capture 'absent' here would divert the
  // resurrection path into a nudge at a PTY that does not exist — no spawn, no
  // 'manager-unrevivable' — i.e. it would disable RECOVERY in exactly the situation this
  // card exists to fix. The spawn condition is untouched, on purpose (カード スコープ外).
  if (presence === 'idle' || (presence === 'active' && stalled)) {
    // Say WHY an alive-looking desk is being poked, once per episode — otherwise the log
    // reads as the engine contradicting its own 「無音」 wording (the desk is painting).
    if (presence === 'active' && !rs.stallLogged) {
      rs.stallLogged = true
      logLine(
        engine,
        'warn',
        `司令官の卓は描画しているが統合が進んでいません(統合の心拍が ${Math.round(MANAGER_INTEGRATION_STALL_MS / 60_000)} 分以上ない・` +
          `統合待ち ${swarmCards.length} 件が ${Math.round((now - (waitingSince ?? now)) / 60_000)} 分滞留)— 声かけに切り替えます`,
        'integrate',
      )
    }
    // BOOT GRACE — a desk we JUST raised is allowed to be quiet while it starts up, and
    // must not be touched at all until it has had its chance (完了条件2).
    //
    // Without this the three pieces of the 2026-07-18 work compose into a new bug that
    // fires on EVERY resurrection: the spawn's own launch echo is discounted for
    // STALL_ECHO_GUARD_MS (30s), so a booting desk reads 'idle'; the spawn clears
    // `lastNudgeAt`, so the nudge throttle below is disarmed; and the poke now leads with
    // ESC. Net effect at the very first tick after a wake (INTEGRATE_TICK_MS = 15s): the
    // freshly resurrected commander gets an ESC through the middle of the `/og-manage`
    // prompt it was launched with, plus an unrelated instruction. The absent branch has
    // always had this grace (:「直前 wake から grace 未満なら return」) — it belongs here
    // too, because "wait for a desk to finish booting" is the same requirement whether the
    // desk is not visible yet or visible but still starting.
    //
    // Deliberately SEPARATE from the `lastNudgeAt` throttle below: that one paces repeat
    // pokes at a desk that is up, this one protects a desk that is not up YET. Merging
    // them was exactly the mistake — the spawn resets lastNudgeAt, so the throttle cannot
    // express "just spawned".
    if (rs.lastWakeAt > 0 && now - rs.lastWakeAt < MANAGER_RESUME_GRACE_MS) return

    // The commander CAN be started — it is started. So the unrevivable budget is not
    // merely untouched here, it is RESET: 'manager-unrevivable' means "no desk can be
    // raised", and a live desk falsifies that outright (完了条件3).
    //
    // …UNLESS the desk we last spawned has never once been seen working. A PTY that only
    // exists does not falsify "cannot be raised": `launchClaude` writes the launch line
    // into the fresh PTY, so a boot that dies on arrival still leaves a live shell behind,
    // and resetting on that would retire the give-up guard for the very cases it exists
    // for (a flapping desk: spawn → die → spawn, forever, silently). Keep the budget
    // accruing until something proves the resurrection took (完了条件3+5 together).
    if (rs.provenSinceWake !== false) {
      rs.attempts = 0
      rs.fatalFired = false
    }
    let nudges = rs.nudges ?? 0
    const lastNudgeAt = rs.lastNudgeAt ?? 0
    // RE-ARM ONCE (2026-07-22). "Budget spent" is a verdict about the desk, but the
    // episode only ends when review DRAINS — so on a batch that never drains the engine
    // went mute for the rest of the batch's life, which is the same observable silence
    // this card exists to remove. Give back ONE round, and only on the strongest evidence
    // available: work still stuck AND still no beat AND a full hour since the last poke.
    // Bounded to one re-arm per episode (≤6 pokes per batch) so a card deliberately parked
    // awaiting the owner is not poked forever. Falls through to the normal path below, so
    // the throttle and the log line stay exactly as they are.
    if (
      nudges >= MAX_MANAGER_NUDGES &&
      stalled &&
      !rs.nudgeRearmed &&
      lastNudgeAt > 0 &&
      now - lastNudgeAt >= MANAGER_NUDGE_REARM_MS
    ) {
      rs.nudgeRearmed = true
      rs.nudges = 0
      nudges = 0
    }
    if (nudges >= MAX_MANAGER_NUDGES) {
      // Budget spent. The nudges were PROBES, not just reminders: a healthy claude
      // answers a submitted prompt with output, which would have read as 'active'. A
      // desk that ignored all of them across the full interval is genuinely not
      // processing input — say so ONCE, in the log the commander docs tell readers to
      // grep, then go quiet (poking a wedged TUI forever helps no one).
      //
      // Still NOT 'manager-unrevivable': that event means "no desk can be raised", which
      // is false here (完了条件3). It IS a bell now — its OWN event, 'manager-unresponsive'
      // (2026-08-14). The 2026-07-18 note that stood here ("minting a new fatal event
      // would pull in the client allowlist + label + i18n surface this card does not
      // own") was an honest scoping decision that then sat unfinished for four weeks,
      // and 03章 §7-10 recorded the cost: this exact state reaches the owner as NOTHING.
      // The display surface is wired with this change.
      //
      // The bell waits on the SAME evidence as the log line — one full interval since the
      // last poke, so nudge #3 gets its window to answer — plus the dwell gate inside
      // escalateUnresponsiveManager.
      const answered = lastNudgeAt > 0 && now - lastNudgeAt >= MANAGER_NUDGE_INTERVAL_MS
      if (!rs.unresponsiveLogged && answered) {
        rs.unresponsiveLogged = true
        logLine(
          engine,
          'warn',
          `司令官の卓は起動しているが ${nudges} 回の声かけに応答しません — 卓が固まっている可能性。` +
            `Swarm タブ → マネージャーで手動確認を(統合待ち ${swarmCards.length} 件)`,
          'integrate',
        )
      }
      if (answered) {
        await escalateUnresponsiveManager(engine, deps, rs, {
          cause: 'ignored',
          waitedPastStall,
          waitedMs,
          waiting: swarmCards.length,
          ...(swarmCards[0]?.branch ? { branch: swarmCards[0].branch } : {}),
          ...(swarmCards[0]?.title ? { taskTitle: swarmCards[0].title } : {}),
        })
      }
      return
    }
    if (lastNudgeAt > 0 && now - lastNudgeAt < MANAGER_NUDGE_INTERVAL_MS) return
    const poked = await deps.nudgeManager(engine.path)
    // The THROTTLE is charged either way — a failed write must not turn into a
    // hot loop. The BUDGET is charged only when something was actually typed.
    //
    // Charging it before the stop check is deliberate for a SUCCESSFUL poke: the
    // keystrokes are already in the desk's PTY, so bailing out un-counted would
    // let a later pass poke again with the throttle disarmed.
    //
    // ⚠ BUT AN UN-SENT POKE MUST NOT COST A TURN (2026-08-04, adversarial review).
    // `nudgeManager` returns false without writing a byte when the session store
    // no longer names the live desk — a state that heals only through the spawn
    // path, so it persists. Three phantom pokes then burnt the whole budget and
    // the engine fell into its permanent-mute branch having never addressed the
    // commander at all: integration stopped, one warn line, no bell.
    rs.lastNudgeAt = now
    if (poked) rs.nudges = nudges + 1
    else {
      rs.unaddressable = (rs.unaddressable ?? 0) + 1
      // Say it ONCE per episode, and say the TRUE thing: this is not "the desk
      // ignored us", it is "we could not reach the desk".
      if (!rs.unaddressableLogged && rs.unaddressable >= MAX_MANAGER_NUDGES) {
        rs.unaddressableLogged = true
        logLine(
          engine,
          'error',
          `司令官の卓に声をかけられません(${rs.unaddressable}回連続で書き込みに失敗) — ` +
            `卓は動いているのに宛先が分からない状態です。Swarm タブ → マネージャーを開き直すと復旧します。` +
            `統合待ち ${swarmCards.length} 件`,
          'integrate',
        )
      }
    }
    if (!engine.running) return
    logLine(
      engine,
      'info',
      `司令官の卓は起動しているが無音 — 蘇生せず声をかけました(${rs.nudges}/${MAX_MANAGER_NUDGES}回目` +
        `${poked ? '' : '・PTY への書き込みに失敗'})。統合待ち ${swarmCards.length} 件`,
      'integrate',
    )
    // …and the SECOND dead end gets the same bell (2026-08-14). This arm never reaches
    // the budget branch above — an un-sent poke deliberately costs no turn — so without
    // its own escalation the un-addressable desk stays exactly as mute as it was: an
    // 'error' log line and nothing else, forever. Same event, different `cause`, because
    // 「宛先が分からない」 and 「応答しない」 send the owner to different places.
    if (!poked && (rs.unaddressable ?? 0) >= MAX_MANAGER_NUDGES) {
      await escalateUnresponsiveManager(engine, deps, rs, {
        cause: 'unaddressable',
        waitedPastStall,
        waitedMs,
        waiting: swarmCards.length,
        ...(swarmCards[0]?.branch ? { branch: swarmCards[0].branch } : {}),
        ...(swarmCards[0]?.title ? { taskTitle: swarmCards[0].title } : {}),
      })
    }
    return
  }

  // presence === 'absent' — no desk at all. THIS is the resurrection path (and the only
  // one that may fire 'manager-unrevivable'). Give a freshly-woken one time to boot and
  // register its session before judging again (else the boot gap double-spawns).
  if (rs.lastWakeAt > 0 && now - rs.lastWakeAt < MANAGER_RESUME_GRACE_MS) return

  // Grace elapsed and still not responding → the last wake didn't take (or first sighting).
  // INFINITE-RESURRECTION GUARD (完了条件5): after MAX consecutive attempts, STOP reviving a
  // desk that keeps dying (permanent quota wall / boot-crash) and escalate to the owner
  // ONCE — burning tokens in a detect→spawn→die loop helps no one. `attempts` resets the
  // moment the desk is seen healthy again (above) or work drains (no card waiting).
  if (rs.attempts >= MAX_MANAGER_RESUME_ATTEMPTS) {
    if (!rs.fatalFired) {
      rs.fatalFired = true
      logLine(
        engine,
        'error',
        `マネージャーが ${rs.attempts} 回連続で蘇生に失敗 — 統合が止まっています。手動でマネージャー卓を確認してください` +
          `(Swarm タブ → マネージャー)。統合待ち ${swarmCards.length} 件`,
        'integrate',
      )
      // Best-effort escalation (bell + OS toast) — never awaited, internal-catch so a
      // notification fault can't disturb the pass (mirrors the fatal-notify contract).
      deps.notify?.({
        event: 'manager-unrevivable',
        projectPath: engine.path,
        branch: swarmCards[0]?.branch,
        taskTitle: swarmCards[0]?.title || undefined,
        detail: `マネージャーが ${rs.attempts} 回連続で落ちています(統合待ち ${swarmCards.length} 件)。手動で確認を`,
        logHint: 'Swarm タブ → マネージャー / engine log の integrate 行',
      })
    }
    // GIVE UP THE LOOP, NOT RECOVERY (完了条件2, 2026-07-20). Returning here forever is
    // what stalled integration: a TRANSIENT cause never resets `attempts` because the desk
    // stays absent and work keeps waiting — the two reset conditions can't fire.
    //
    // But "transient" has to be earned, or re-arming resurrects a dead boot forever (the
    // 'flapping desk' the give-up guard exists to stop). The discriminator is the LAST
    // wake's outcome: `lastWakeSpawned === false` means no desk was ever seated — every
    // allowed tier was cooling/masked — which is a QUOTA WALL, and quota walls LIFT (or the
    // owner re-enables a tier). Re-arming THAT costs nothing: the next wake still finds no
    // tier and spawns nothing (woke=false), it just keeps checking until one frees up. A
    // desk that actually SPAWNED and died (lastWakeSpawned===true / undefined) is treated
    // as permanent and left given-up — retrying it would burn a real desk each cycle.
    //
    // After the backoff, re-arm ONE cycle (fall through). `fatalFired` stays SET: the owner
    // is alerted once per episode, not every cycle — only a desk that actually comes up
    // ('active'/'idle') clears it.
    //
    // `lastWakeSpawned === false` alone misses the case this ratchet exists to close
    // (2026-07-22, sibling of the reset above): when 3+ allowed tiers are all
    // exhausted-but-spawnable, the LAST wake's probe can still pass (a tier that is
    // allowed and briefly reads not-cooling), so `spawnSwarmManager` does not throw and
    // `wakeManager` returns `true` — `lastWakeSpawned` latches PERMANENT even though the
    // desk it seated died on arrival for the exact same quota reason
    // (watchDeskForDeathOnArrival, swarmManager.ts) that a `false` would have. The woke
    // bit alone cannot tell "the probe found nothing to try" apart from "the probe found
    // something, tried it, and quota killed it anyway" — both are the SAME root cause
    // (every allowed tier is exhausted right now), so both must re-arm.
    //
    // `spawnBlock` is the ONE gate this file already trusts to answer "is any allowed
    // tier usable right now" (§3b above, dispatch's own park gate) — reading it here
    // folds that SAME live signal into the give-up decision instead of trusting a bit
    // that was only ever a snapshot of the PROBE, not the OUTCOME. `kind: 'all-cooling'`
    // is a quota wall (lifts on its own); `kind: 'none-allowed'` is the owner's own
    // switch (lifts the moment they flip it back on) — re-arming costs nothing in either
    // case, per the same reasoning as the `lastWakeSpawned === false` leg. A desk that
    // died for a NON-quota reason (a real boot-crash bug) leaves at least one allowed
    // tier un-cooled, so `spawnBlock` reads `null` and this stays latched, exactly as
    // before.
    const transientWall = rs.lastWakeSpawned === false || spawnBlock(now, await getAllowedModelTiers()) != null
    if (!(transientWall && rs.lastWakeAt > 0 && now - rs.lastWakeAt >= MANAGER_UNREVIVABLE_RETRY_MS))
      return
    rs.attempts = 0
    logLine(
      engine,
      'warn',
      `マネージャー蘇生を再試行します — 使えるモデル tier が無いまま ${Math.round((now - rs.lastWakeAt) / 60_000)} 分経過` +
        `(quota 壁が明けていれば回復する・統合待ち ${swarmCards.length} 件)`,
      'integrate',
    )
    // …fall through to the resuscitate block below.
  }

  // RESUSCITATE (完了条件2+3): wake/resume the commander for the whole batch at once
  // (token-thrifty). spawnSwarmManager resumes the days-long integration conversation and
  // — on a quota wall — drops the model one tier (完了条件4, inside wakeManager). Count the
  // attempt whether or not the spawn itself succeeded (woke=false ⇒ no usable tier; that
  // is a failed resurrection too, and drives the guard above toward escalation). Record
  // the wake time so the grace throttles the next attempt.
  const woke = await deps.wakeManager(
    engine.path,
    swarmCards.map((c) => ({ branch: c.branch, title: c.title ?? '' })),
  )
  rs.lastWakeAt = now
  rs.attempts += 1
  // Remember whether a desk was actually seated — the transient-vs-permanent bit the
  // give-up re-arm reads (完了条件2). false ⇒ no usable tier (a quota wall: retryable at
  // zero cost); true ⇒ a desk spawned (a boot-crash if it then dies: not re-armed).
  rs.lastWakeSpawned = woke
  // A SPAWN STARTS A NEW DESK, SO IT STARTS A NEW NUDGE BUDGET. The nudge counters
  // describe one particular desk's refusal to answer; carrying them onto its successor
  // would silently disarm the poke reflex for a desk that never ignored anything. Usually
  // the successor paints while booting and reads 'active' (which clears these anyway), but
  // that self-heal is a coincidence of timing, not a guarantee: an integrate pass can hold
  // the lane for ~20m (verify + adversarial panel), and past MANAGER_HEARTBEAT_STALE_MS the
  // boot paint has aged out — the next probe then sees a fresh desk as 'idle' with a spent
  // budget and, with `unresponsiveLogged` also inherited, stalls integration in SILENCE.
  // Reset explicitly so the invariant holds on cadence rather than on luck.
  rs.nudges = 0
  rs.lastNudgeAt = 0
  rs.unresponsiveLogged = false
  // This desk has proved NOTHING yet — it must be seen 'active' before its existence is
  // allowed to refund the give-up budget (see provenSinceWake).
  rs.provenSinceWake = false
  const names = swarmCards.map((c) => c.branch)
  logLine(
    engine,
    woke ? 'info' : 'warn',
    (rs.attempts === 1
      ? 'worker ready — マネージャーを起こしました'
      : `マネージャーが応答しないため蘇生しました(${rs.attempts}回目)`) +
      (woke ? '' : '(使えるモデル tier が無く spawn 保留 — 次 pass で再試行)') +
      `(統合判断はマネージャー・engine は統合しない): ` +
      `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` 他${names.length - 5}件` : ''}`,
    'integrate',
  )
}

/** Fire the integrate pass BESIDE the tick — never awaited by {@link runEnginePass}.
 *
 *  WHY (the monitor-starvation leg of the 21-minute quota-detection lag,
 *  measured 2026-07-09): the integrate pass verifies each candidate branch with
 *  an inline tsc + vitest run (minutes) and can then await a diff-scaled
 *  adversarial-review panel (up to ~20m). While runEnginePass awaited all of
 *  that, `passInFlight` stayed set and EVERY 3s tick bailed — no dispatch, no
 *  integrate, and above all NO MONITOR: a worker that hit its model limit
 *  mid-verify wasn't looked at until the vitest run finished (auto-integrate ON
 *  at 15:23:09 pushed an otherwise-due rate-limit sighting to 15:29:39). Same
 *  starvation shape the self-supply scan had (see kickSelfSupplyPass) — same
 *  cure: run it beside the tick.
 *
 *  Safety: `integrateInFlight` is check-and-set SYNCHRONOUSLY here and cleared
 *  in `finally`, so integrate passes never overlap EACH OTHER (the per-pass
 *  INTEGRATE_TICK_MS throttle inside runIntegratePass keeps its own cadence);
 *  and every board/worker WRITE section inside the pass (reworkOrPark /
 *  delegateConflict / the integrated-land block) takes the engine critical
 *  section, so those mutations still serialize against the monitor and the
 *  owner's control plane. The slow verify/panel awaits stay OUTSIDE the lock —
 *  an owner stop/resolve click never queues behind them. */
export const kickIntegratePass = (
  engine: ProjectEngine,
  deps: IntegrationDeps,
): void => {
  if (engine.integrateInFlight) return
  engine.integrateInFlight = true
  void runIntegratePass(engine, deps)
    .catch((e) => logLine(engine, 'warn', `integrate pass errored — ${errMsg(e)}`))
    .finally(() => {
      engine.integrateInFlight = false
    })
}

// ── Anomaly detection (条件2 — surface state drift the loop can't self-heal) ──

/** A counted, alive worker silent THIS long is flagged 'worker-stale'. 30 min
 *  matches the /order skill's "30分以上無音だと詰まりかも" guidance the human
 *  commander already uses, so the engine and the humans agree on "stuck". */
export const STALE_HEARTBEAT_MS = 30 * 60_000

/** Detect inconsistencies between the engine's worker set, the Board, and the
 *  on-disk worktrees — READ-ONLY (never moves a card / kills a PTY / touches a
 *  tree); it only reports, so the owner notices drift the autonomy loop can't
 *  silently fix. The IO (worktree existence) is injected so it's unit-tested with
 *  fakes; `now` is passed in (no clock here) for deterministic staleness.
 *  Three independent checks — see {@link OrchestratorAnomalyKind}:
 *   • worktree-missing — a counted+alive worker whose worktree dir is gone.
 *   • worker-stale     — a counted+alive, NON-done worker SILENT on BOTH liveness
 *                        channels (no heartbeat AND no PTY output, falling back to
 *                        its dispatch time) longer than the threshold. Uses the
 *                        same activity notion the stall monitor acts on
 *                        (lastActivityMs), so this read-only backstop never
 *                        contradicts the engine's own liveness view — a worker the
 *                        engine considers active (streaming output) is never flagged
 *                        stale here. By the time it would fire, the stall monitor
 *                        has usually already nudged/reclaimed it; it remains as the
 *                        display backstop for a worker whose reclaim couldn't land.
 *   • orphan-doing     — a 'doing' card with a `swarm/*` branch that NO counted
 *                        worker drains AND whose worktree is gone (its worker
 *                        vanished but the card never advanced). A doing card whose
 *                        worktree still EXISTS is skipped — a MANUAL worker (which
 *                        the engine doesn't count) still owns it, so it is never a
 *                        false orphan.
 *   • no-heartbeat     — a counted+alive, NON-done worker that has NEVER beaten a
 *                        heartbeat ≥30 min after dispatch, REGARDLESS of PTY
 *                        output. Complements worker-stale, whose output channel
 *                        deliberately clears it: a dark-but-ACTIVE worker (the
 *                        2e7beb2 bypass shape) never trips stale, so this is the
 *                        flag that surfaces it.
 *  (Plus the tracker-fed checks below: move-stuck / rework-exhausted /
 *  review-panel-failed — read from engine state maps, same read-only rule.) */
export const detectAnomalies = async (
  engine: ProjectEngine,
  tasks: readonly ProjectTask[],
  deps: OrchestratorDeps & AnomalyDeps,
  now: number,
): Promise<OrchestratorAnomaly[]> => {
  const out: OrchestratorAnomaly[] = []
  const liveWorkers = engine.workers.filter((w) => deps.isAlive(w))
  const countedTaskIds = new Set(engine.workers.map((w) => w.taskId))

  // Worker-rooted checks: each counted+alive worker's worktree + heartbeat age.
  for (const w of liveWorkers) {
    let treeExists = true
    try {
      treeExists = await deps.worktreeExists(engine.path, w.branch)
    } catch {
      treeExists = false
    }
    if (!treeExists) {
      // The vanished tree is the bigger signal — report it and don't ALSO flag
      // the same worker stale (one anomaly per worker is enough to act on).
      out.push({ kind: 'worktree-missing', ref: w.branch, branch: w.branch, taskTitle: w.taskTitle })
      continue
    }
    // A promoted ('done') worker lingering its PTY is FINISHED, not stuck — never
    // stale. Only an actively-working worker can be hung.
    if (w.stage === 'done') continue
    // A worker the monitor is HOLDING because it is rate/usage-limited or waiting
    // on a startup permission prompt is silent BY DESIGN, not hung — it is being
    // managed (held / auto-accepted / about to requeue), so flagging it 'worker-
    // stale' ("no heartbeat for N min", i.e. likely hung) would be misleading
    // noise. Skip it here; its dedicated log line already says why it is paused.
    // (Card 4880e9c6 — keep the anomaly view honest about WAIT vs HANG.)
    // (The pre-0813 skip for held workers — engine.rateLimited /
    // engine.permissionWaits — is gone with the holds themselves: a
    // quota-stopped worker is requeued within ~a minute, so there is no
    // long-lived held state left to suppress anomalies for.)
    // Silence across BOTH channels (heartbeat + PTY output) — the same activity
    // notion the stall monitor uses, so a worker streaming output (alive to the
    // engine) is never falsely flagged stale here.
    let lastOut: number | null = null
    try {
      lastOut = deps.lastOutputAt(w)
    } catch {
      lastOut = null
    }
    let since = lastActivityMs({ heartbeatAt: w.heartbeatAt, lastOutputAt: lastOut, startedAt: w.startedAt })
    // The SAME third channel the stall monitor gained (2026-07-23): before flagging a
    // worker stale, fold in its transcript / sub-agent file mtime so a worker deep in
    // a Task() sub-agent — silent on BOTH cheap channels but its files still growing —
    // is not falsely reported here either. This is the invariant the block header
    // promises: the read-only view must never contradict the engine's own liveness
    // verdict. Gated behind the cheap staleness so the fs walk runs only for a worker
    // already about to be flagged, never for every alive worker every pass.
    if (
      since > 0 &&
      now - since >= STALE_HEARTBEAT_MS &&
      w.sessionId &&
      w.worktree &&
      (deps.sessionAgentActivityAt || deps.sessionBackgroundTaskAt)
    ) {
      try {
        const agentAt = deps.sessionAgentActivityAt ? await deps.sessionAgentActivityAt(w.worktree, w.sessionId) : null
        if (agentAt !== null) since = Math.max(since, agentAt)
      } catch {
        /* torn ~/.claude ⇒ no extra signal ⇒ keep the cheap `since` */
      }
      // And the SAME fourth channel the stall monitor gained (2026-07-27): a worker
      // waiting on a background completion gate is silent on all three cheap channels
      // by design, so without this the read-only view would report it 'worker-stale'
      // and contradict the engine — the exact invariant this block promises.
      try {
        const bgStartedAt = deps.sessionBackgroundTaskAt
          ? await deps.sessionBackgroundTaskAt(w.worktree, w.sessionId)
          : null
        const bgAliveAt = backgroundTaskAliveAt(bgStartedAt, now, BG_TASK_GRACE_MS)
        if (bgAliveAt !== null) since = Math.max(since, bgAliveAt)
      } catch {
        /* ditto */
      }
    }
    if (since > 0 && now - since >= STALE_HEARTBEAT_MS) {
      out.push({
        kind: 'worker-stale',
        ref: w.branch,
        branch: w.branch,
        taskTitle: w.taskTitle,
        staleMinutes: Math.floor((now - since) / 60_000),
      })
      continue // one anomaly per worker — total silence subsumes never-beat
    }
    // no-heartbeat — the 2e7beb2 shape: a worker whose PTY output keeps it off
    // the stale check (streaming = alive to the engine) but which has NEVER
    // beaten a heartbeat since dispatch. Not hung — a PROTOCOL violation: it is
    // running full speed while invisible to the commander's heartbeat view (the
    // 2e7beb2 worker pushed main exactly like this, zero beats end to end). The
    // guard's blanket push ban is the hard stop; this read-only flag is the
    // observability, so a dark-but-active worker is surfaced within 30 min
    // instead of at integration time. Only a MISSING heartbeatAt counts — one
    // recorded beat (however old) means the protocol was followed and staleness
    // is the stall monitor's / worker-stale's business, not this flag's.
    const startedMs = w.startedAt ? Date.parse(w.startedAt) : Number.NaN
    if (!w.heartbeatAt && Number.isFinite(startedMs) && now - startedMs >= STALE_HEARTBEAT_MS) {
      out.push({
        kind: 'no-heartbeat',
        ref: w.branch,
        branch: w.branch,
        taskTitle: w.taskTitle,
        staleMinutes: Math.floor((now - startedMs) / 60_000),
      })
    }
  }

  // Card-rooted check: a 'doing' swarm-branch card with no counted worker AND no
  // worktree on disk → its worker vanished but the card stayed in 'doing'.
  for (const t of tasks) {
    if (columnOf(t) !== 'doing') continue
    if (countedTaskIds.has(t.id)) continue // a counted worker drains it — fine
    const branch = typeof t.branch === 'string' ? t.branch : ''
    if (!branch || !isSwarmBranch(branch)) continue
    let treeExists = true
    try {
      treeExists = await deps.worktreeExists(engine.path, branch)
    } catch {
      treeExists = false
    }
    if (!treeExists) {
      out.push({ kind: 'orphan-doing', ref: t.id, branch, taskTitle: t.title ?? '' })
    } else if (!(await (deps.deskOccupies ?? (async () => true))(engine.path, branch).catch(() => true))) {
      // …and the SIBLING case, which was the silent one (2026-08-27). A card in
      // 'doing' that no counted worker drains, whose worktree is STILL THERE, is
      // a worker the engine has lost track of — boot adoption declined it, or a
      // desk died where the tree survived. It advances on its own exactly as
      // little as an orphan-doing does, but it fell through this `if` and was
      // reported nowhere: `GET /api/swarm/workers` (roster ∪ heartbeat ∪ live
      // desks) still listed it while `GET /api/swarm/orchestrator` showed
      // `workers:[]`, and the two views disagreed in silence for hours.
      //
      // The DELIVERED half of this population is recovered automatically now
      // (promoteUnownedDelivered moves it to review, which wakes the commander),
      // so what reaches this row is the genuinely ambiguous remainder: no
      // hand-over sign, or a card that has been sent back before, or a branch git
      // could not read. Those need a human — which is what an anomaly is for.
      out.push({ kind: 'unowned-doing', ref: t.id, branch, taskTitle: t.title ?? '' })
    }
  }

  // Move-stuck check (anti-zombie): a card whose Board COLUMN MOVE has been KEPT
  // past the retry budget — the work happened but the card couldn't follow it
  // ("done なのに review" / a finished/dead worker stuck in 'doing'). The move
  // sites maintain engine.stuckMoves (bumped on each kept write, cleared the moment
  // it lands); here we only SURFACE the ones past the threshold so the owner can
  // move them by hand (the engine keeps retrying, and has already escalated a lost
  // worker's recovery to 'blocked'). Read-only, like the rest of detection.
  for (const [taskId, sm] of Array.from(engine.stuckMoves)) {
    if (sm.attempts < MOVE_STUCK_MAX_RETRIES) continue
    out.push({
      kind: 'move-stuck',
      ref: taskId,
      branch: sm.branch,
      taskTitle: sm.taskTitle,
      intent: sm.intent,
      attempts: sm.attempts,
    })
  }

  // Rework-exhausted check: a card whose 差し戻し(rework)budget is spent — it bounced
  // review→doing more than MAX_REWORKS times and the loop guard PARKED it in 'blocked'
  // (engine.reworks keeps the over-budget count until the card reaches todo|done).
  // Surface the parked ones so the owner sees a card the autonomy loop gave up
  // auto-fixing (mirrors swarm-board.sh's "上限超過→blocked→ユーザーに報告して判断を仰ぐ").
  const byIdRework = new Map(tasks.map((t) => [t.id, t]))
  for (const [taskId, count] of Array.from(engine.reworks)) {
    if (count <= MAX_REWORKS) continue
    const card = byIdRework.get(taskId)
    if (!card || columnOf(card) !== 'blocked') continue
    out.push({
      kind: 'rework-exhausted',
      ref: taskId,
      branch: typeof card.branch === 'string' ? card.branch : undefined,
      taskTitle: card.title ?? '',
      attempts: count,
    })
  }

  // Review-panel-failed check (fail-closed review, 2026-07-14): a review card whose
  // adversarial panel hit the defer cap — it could not produce ONE decisive verdict
  // (0 must-fix/clean votes, or no majority) even after its retry, so integration is
  // withheld and runIntegratePass's defer-exhausted memo stops re-spawning the panel.
  // NOT the worker's fault (no rework burned; the card stays in 'review', never
  // 'blocked') — a human must look, or a new commit (fresh tip) re-arms the panel.
  // Read from engine.reviewDeferred (branch-keyed), surfaced card-rooted like
  // 'rework-exhausted', and only while the card still sits in 'review' (the memo is
  // pruned when the branch leaves review, but this pass's board read may be fresher
  // than the last integrate pass's).
  const byBranch = new Map<string, ProjectTask>()
  for (const t of tasks) {
    if (typeof t.branch === 'string' && t.branch) byBranch.set(t.branch, t)
  }
  for (const [branch, memo] of Array.from(engine.reviewDeferred)) {
    if (memo.count < MAX_REVIEW_DEFERS) continue
    const card = byBranch.get(branch)
    if (!card || columnOf(card) !== 'review') continue
    out.push({
      kind: 'review-panel-failed',
      ref: card.id,
      branch,
      taskTitle: card.title ?? '',
      attempts: memo.count,
    })
  }

  // High-risk force-hold check (2026-07-15): a review card whose branch touches
  // release/CI/signing/dependency/secrets-grade paths (HIGH_RISK_PATHS) — the
  // integrate pass withheld auto-merge BY DESIGN and stamped engine.highRiskHolds;
  // here we only SURFACE the standing hold so the owner actually notices the card
  // waiting for a manual merge (the hold is not a fault, but silence would strand
  // it in review forever). Card-rooted like 'review-panel-failed', and only while
  // the card still sits in 'review' (a landed/reworked card's memo is pruned by
  // the integrate pass, but this pass's board read may be fresher).
  for (const [branch, hold] of Array.from(engine.highRiskHolds)) {
    const card = byBranch.get(branch)
    if (!card || columnOf(card) !== 'review') continue
    out.push({
      kind: 'high-risk-hold',
      ref: card.id,
      branch,
      taskTitle: card.title ?? '',
      files: hold.files,
    })
  }

  // ── The two LEVEL-TRIGGERED failures (2026-08-04) ────────────────────────
  // `all-workers-down` and `manager-unrevivable` are published as one-shot
  // NOTIFICATIONS: fireFatalNotifications dedups on `engine.notified` until the
  // condition clears, and the manager one latches on `managerResume.fatalFired`
  // until a desk actually comes back. That was survivable while the feed showed
  // every notification forever — and became a hole the moment the owner could
  // dismiss a row: one click on a STANDING failure and the pane returns to
  // "nothing needs you" while integration is still dead. (Found by adversarial
  // review the same night the dismissal shipped.)
  //
  // An anomaly is the right carrier because it is re-derived from live state on
  // EVERY pass: dismissing the historical notification cannot hide it, and it
  // disappears by itself the moment the condition actually clears. The
  // notification stays as the one-shot wake-up (bell + OS toast); this is the
  // "still true right now" line beside it.
  const liveNow = engine.workers.filter((w) => deps.isAlive(w))
  // `engine.workers.length > 0` is load-bearing: it means WE dispatched workers
  // and every one of them is now dead. With an empty roster the same board looks
  // identical to a card a MANUAL worker owns — the engine never counts those, and
  // the orphan-doing arm above already refuses to call that a fault ("never a
  // false orphan"). This row follows the same rule rather than inventing a
  // second, louder answer to the same ambiguity.
  // Same mid-teardown exemption as the notification arm (see fireFatalNotifications):
  // a worker kept on the roster for a teardown retry is not a worker that died.
  if (
    engine.running &&
    engine.workers.length > 0 &&
    liveNow.length === 0 &&
    (engine.teardownRetries?.size ?? 0) === 0
  ) {
    // Same condition as the notification arm — engine running, nothing alive,
    // yet swarm cards still sitting in 'doing' (i.e. work is hanging, not done).
    const hanging = tasks.filter(
      (t) => columnOf(t) === 'doing' && isSwarmBranch(typeof t.branch === 'string' ? t.branch : ''),
    )
    // …but say it ONCE. 'orphan-doing' already names a hanging card individually
    // (it fires when the worktree is gone too); adding a second row for the same
    // cards would make the feed repeat itself, and a feed that repeats itself is
    // one the owner skims. This row is for the case orphan-doing CANNOT see: the
    // worktrees are all still there, so nothing is orphaned per-card, yet every
    // worker process is gone.
    const alreadyNamed = new Set(out.filter((a) => a.kind === 'orphan-doing').map((a) => a.ref))
    if (hanging.some((t) => !alreadyNamed.has(t.id))) {
      out.push({
        kind: 'all-workers-down',
        ref: 'engine',
        attempts: hanging.length, // how many cards are hanging (display-only)
      })
    }
  }
  if (engine.managerResume?.fatalFired) {
    // Latched: the commander desk failed to come back MAX times in a row, so
    // integration is stopped. `fatalFired` is cleared only when a desk is seen
    // healthy again or review drains — i.e. exactly while the problem is live.
    out.push({ kind: 'manager-unrevivable', ref: 'manager', attempts: engine.managerResume.attempts })
  }

  return out
}

/** Drop stuck-move entries whose card has LEFT the stuck situation — the move
 *  finally landed (a human moved it / the engine's retry succeeded) or the card
 *  was deleted — so the tracker never surfaces a now-resolved zombie. A COLUMN
 *  rule (not a per-pass touched-set), so it is immune to the integration
 *  throttle (a 'done' entry isn't wrongly pruned on the 4-of-5 ticks the
 *  integrate pass skips):
 *    - 'done'               valid only while the card is still in 'review'.
 *    - 'review' / 'recover' / 'recover-review' valid only while the card is still
 *      in 'doing'. ('recover-review' is the ready-worker retry — its card is also
 *      still in 'doing' until the move to review lands, so it shares the rule.)
 *  A vanished (deleted) card is always pruned. Pure state mutation — no IO.
 *  Exported for the unit test (driven with a plain engine + board snapshot). */
export const pruneStuckMoves = (engine: ProjectEngine, tasks: readonly ProjectTask[]): void => {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const [taskId, sm] of Array.from(engine.stuckMoves)) {
    const card = byId.get(taskId)
    const col = card ? columnOf(card) : null
    const valid = sm.intent === 'done' ? col === 'review' : col === 'doing'
    if (!valid) engine.stuckMoves.delete(taskId)
  }
}

/** Drop rework counters whose card reached a SUCCESS column ('done') or vanished —
 *  a completion resets the 差し戻し budget. A card still mid-cycle (doing | review)
 *  or PARKED ('blocked', where the over-budget count feeds the 'rework-exhausted'
 *  anomaly) KEEPS its counter. CRUCIALLY 'todo' is NOT pruned here: the engine's OWN
 *  dead-worker rework re-queues a card to 'todo' (recoverCard('todo')) and the counter
 *  MUST survive that re-dispatch, else the cap never bites and a worker that keeps
 *  dying loops forever (review→todo→dispatch→review→…) — the exact infinite-bounce the
 *  guard exists to stop, and the reason the counter is keyed by taskId (stable across
 *  the fresh branch a re-dispatch mints). A human's DELIBERATE re-queue clears the
 *  counter at its own site (resolveOrchestratorReview / stopOrchestratorWorker), so a
 *  hand-driven fresh start still resets it. Pure state mutation — no IO. Exported for
 *  the unit test. */
export const pruneReworks = (engine: ProjectEngine, tasks: readonly ProjectTask[]): void => {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  for (const taskId of Array.from(engine.reworks.keys())) {
    const card = byId.get(taskId)
    const col = card ? columnOf(card) : null
    if (col === null || col === 'done') engine.reworks.delete(taskId)
  }
  // LEARNING LOOP memo (card fdf714ef) shares reworks' lifecycle: drop the failure
  // reason for a card that FINISHED ('done') or vanished, so a stale reason never
  // lingers. A still-cycling card KEEPS it — 'todo' so a pending re-dispatch can
  // still inject it (it is otherwise consumed at dispatch), 'doing'/'review' so a
  // crash→requeue→re-dispatch still carries it. Mirrors the reworks prune exactly.
  for (const taskId of Array.from(engine.reworkReasons.keys())) {
    const card = byId.get(taskId)
    const col = card ? columnOf(card) : null
    if (col === null || col === 'done') engine.reworkReasons.delete(taskId)
  }
  // The conflict-委譲 budget (card 012a2848) shares reworks' lifecycle: drop it for a
  // card that FINISHED ('done') or vanished so a stale conflict count never lingers; a
  // still-cycling card (todo/doing/review) KEEPS it so the loop guard survives the hop.
  for (const taskId of Array.from(engine.conflictReworks.keys())) {
    const card = byId.get(taskId)
    const col = card ? columnOf(card) : null
    if (col === null || col === 'done') engine.conflictReworks.delete(taskId)
  }
}

// ── Escalation safety valve (条件: 致命イベント→人へプッシュ通知) ─────────────────
//
// The unmanned loop runs while nobody watches; when something FATAL happens — one
// the loop cannot self-heal — a human must be woken. fireFatalNotifications is the
// SINGLE choke point (called at the end of every runEnginePass) that turns those
// few cases into a push (in-app bell + OS toast via deps.notify). It is
// deliberately NARROW so it never becomes noise (条件4: a normal dispatch/merge
// never notifies):
//
//   • EDGE events (engine.pendingFatal) — one-shot occurrences enqueued at their
//     site (today: 'exec-timeout', a worker reclaimed for overrunning MAX_EXEC_MS).
//     Fired once, then drained.
//   • STATE-derived events — re-derivable each pass, so deduped on the RISING EDGE
//     via engine.notified: fire ONCE when the condition appears, forget it the
//     moment it clears (a genuine recurrence re-fires, a persisting one never
//     spams). Three cases:
//       – 'rework-exhausted'  — a card parked in 'blocked' past its rework budget
//         (read from this pass's anomalies).
//       – 'review-panel-failed' — a review card frozen because the adversarial
//         panel stayed indecisive past its retry budget (fail-closed review,
//         2026-07-14; read from this pass's anomalies).
//       – 'all-workers-down'  — running, ZERO live workers, yet 'doing' swarm work
//         remains (every worker crashed/stalled and the loop stalled).
//
// Pure of IO beyond the injected, best-effort `deps.notify` (each call try/caught),
// so it can never disturb the pass. `tasks` is null when this pass's board read
// failed — then only the EDGE queue drains (state can't be safely re-derived).
// Exported for the unit test (drives it with a fake notify — no real notification IO).
export const fireFatalNotifications = (
  engine: ProjectEngine,
  tasks: readonly ProjectTask[] | null,
  // Only the two seams it actually uses (so the unit test needn't build the whole
  // dep set) — runEnginePass's full deps satisfy this. `notify` is optional.
  deps: Pick<OrchestratorDeps, 'isAlive'> & Pick<AnomalyDeps, 'notify'>,
  _now: number,
): void => {
  const notify = deps.notify
  const push = (n: SwarmFatalNotification): void => {
    if (!notify) return
    try {
      notify(n)
    } catch {
      /* a single notification fault must never break the pass */
    }
  }

  // 1. EDGE events — fire each exactly once, then drain (no dedup needed).
  if (engine.pendingFatal.length > 0) {
    const queued = engine.pendingFatal.splice(0, engine.pendingFatal.length)
    for (const n of queued) push(n)
  }

  // 2. STATE-derived events — only with a fresh board (else keep last dedup state).
  if (!tasks) return
  const current = new Map<string, SwarmFatalNotification>()

  // 2a. rework-exhausted — straight from this pass's anomalies.
  for (const a of engine.anomalies) {
    if (a.kind !== 'rework-exhausted') continue
    current.set(`rework-exhausted:${a.ref}`, {
      event: 'rework-exhausted',
      detail: `差し戻し上限を超過し 'blocked' に退避しました（review→doing を ${a.attempts ?? '?'} 回バウンス）。`,
      projectPath: engine.path,
      taskId: a.ref,
      branch: a.branch,
      taskTitle: a.taskTitle,
      logHint: "Board の 'blocked' 列のカードを確認し、手動で対応してください。",
    })
  }

  // 2b. review-panel-failed — straight from this pass's anomalies (fail-closed
  // review, 2026-07-14): the panel exhausted its retry without ONE decisive vote,
  // the card is frozen in 'review' un-merged, and further panels are skipped —
  // exactly the "自動では進めない・人間へ橋渡し" shape that must wake someone.
  for (const a of engine.anomalies) {
    if (a.kind !== 'review-panel-failed') continue
    current.set(`review-panel-failed:${a.ref}`, {
      event: 'review-panel-failed',
      detail: `敵対レビューのパネルが ${a.attempts ?? '?'} 回連続で決着せず(decisive 0票/過半数未達)、統合を保留して review に凍結しました(worker の差し戻しカウントは消費しません)。`,
      projectPath: engine.path,
      taskId: a.ref,
      branch: a.branch,
      taskTitle: a.taskTitle,
      logHint:
        'commander の reviews(棄権内訳 abstainSummary)と engine log を確認してください。新しいコミットが積まれると再レビューが自動再開します。',
    })
  }

  // 2b'. high-risk-hold — straight from this pass's anomalies (force-hold,
  // 2026-07-15): the branch touches release/CI/signing/dependency/secrets-grade
  // paths, so auto-merge is withheld BY DESIGN and only a human's manual merge
  // can land the card. Not a fault — but without a hand-off it would sit in
  // review silently forever; exactly one notification per standing hold
  // (rising edge), re-fired only if the hold clears and genuinely recurs.
  for (const a of engine.anomalies) {
    if (a.kind !== 'high-risk-hold') continue
    const files = a.files ?? []
    const shown = files.slice(0, 3).join(', ') + (files.length > 3 ? ` 他${files.length - 3}件` : '')
    current.set(`high-risk-hold:${a.ref}`, {
      event: 'high-risk-hold',
      detail: `高リスクパス(リリース/CI/署名/依存/secrets 系)に触れるため自動統合を保留しました: ${shown}`,
      projectPath: engine.path,
      taskId: a.ref,
      branch: a.branch,
      taskTitle: a.taskTitle,
      logHint:
        '差分を確認し、問題なければ手動統合(マネージャーの「マージ」)で取り込んでください。エンジンはこのカードを自動では統合しません。',
    })
  }

  // 2c. all-workers-down — running, zero live workers, yet 'doing' swarm work left.
  const liveWorkers = engine.workers.filter((w) => deps.isAlive(w))
  // ⚠ NOT WHILE THE ENGINE IS MID-TEARDOWN (2026-08-04). recoverLost now KEEPS a
  // dead worker on the roster while a refused teardown is retried, deliberately
  // leaving its card in 'doing' — which for a single-worker engine is exactly
  // "running, nothing alive, work hanging". Without this the engine would ring
  // the bell + OS toast (and, with the overseer armed, raise an owner-facing
  // question) about a transient it is in the middle of resolving by itself, a
  // few seconds before it clears. The alarm is for workers that DIED, not for
  // ones we are still putting away.
  const tearingDown = (engine.teardownRetries?.size ?? 0) > 0
  if (engine.running && liveWorkers.length === 0 && !tearingDown) {
    const doing = tasks.filter(
      (t) => columnOf(t) === 'doing' && isSwarmBranch(typeof t.branch === 'string' ? t.branch : ''),
    )
    if (doing.length > 0) {
      current.set('all-workers-down', {
        event: 'all-workers-down',
        detail: `稼働中のワーカーが0になりました（doing ${doing.length}件が宙吊り — 全ワーカーが crash/stall で停止）。`,
        projectPath: engine.path,
        logHint: '司令塔ペインの engine log と Board の doing 列を確認してください。',
      })
    }
  }

  // Fire NEWLY-appeared conditions; forget cleared ones so a recurrence re-fires.
  for (const [key, n] of Array.from(current)) {
    if (engine.notified.has(key)) continue
    engine.notified.add(key)
    push(n)
  }
  for (const key of Array.from(engine.notified)) {
    if (!current.has(key)) engine.notified.delete(key)
  }
}

/** ONE full engine tick: dispatch, then (still running) integrate, then detect
 *  state inconsistencies. The stages share the engine + journal but are
 *  independently guarded/tested; anomaly detection is read-only and fully
 *  guarded, so a probe failure never breaks the tick.
 *
 *  RE-ENTRANCY GUARD (twin-dispatch defense): a pass NEVER overlaps another. The
 *  setTimeout chain already serializes scheduled passes, but a stop→start inside a
 *  slow pass's await window can leave a stale kick still running when a fresh one
 *  fires — two passes would then read the SAME pre-spawn worker set and dispatch
 *  the same card twice. `passInFlight` is check-and-set SYNCHRONOUSLY here (before
 *  the first await), so the second entrant bails immediately. It always clears in
 *  `finally`, so a throwing pass can't wedge the engine. */
export const runEnginePass = async (
  engine: ProjectEngine,
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps & SelfSupplyPassDeps,
): Promise<void> => {
  if (engine.passInFlight) return
  engine.passInFlight = true
  try {
    // The dispatch pass (monitor → promote → recover → fill) shares the board + worker
    // state with the owner's stop/resolve control plane; take the per-engine critical
    // section so a control op can't interleave with the monitor's await window and have
    // its card-park silently overwritten by a stale pass-start snapshot (see
    // runExclusive). passInFlight still bars a SECOND pass from queueing here (it bails,
    // it doesn't wait), so only control ops ever share this lock with a pass.
    await runExclusive(engine, () => runDispatchPass(engine, deps))
    // Integrate runs BESIDE the tick (fire-and-forget), NOT awaited: its per-card
    // verify (tsc+vitest, minutes) and diff-scaled review panel (up to ~20m) used
    // to hold passInFlight for their whole duration, so every 3s tick bailed and
    // the MONITOR was starved — a worker rate-limited mid-verify went unseen until
    // the vitest run finished (the measured 21-minute quota-detection lag's third
    // leg). kickIntegratePass owns the re-entrancy guard (integrateInFlight) and
    // the .catch; its write sections take the engine critical section themselves.
    if (engine.running) kickIntegratePass(engine, deps)
    if (engine.running) {
      let tasks: ProjectTask[] | null = null
      try {
        tasks = await deps.fetchTasks(engine.path)
        // Prune resolved stuck-moves BEFORE detection reads them, so a zombie that
        // a human (or a recovered write) already fixed never surfaces as an anomaly.
        pruneStuckMoves(engine, tasks)
        // Same for rework counters: a card a human re-queued (todo) or that landed
        // (done) drops its 差し戻し budget before detection reads it for the anomaly.
        pruneReworks(engine, tasks)
        engine.anomalies = await detectAnomalies(engine, tasks, deps, Date.now())
      } catch {
        // A transient board read isn't itself an anomaly to surface — keep the last
        // snapshot; the next pass refreshes it. (tasks stays null → state-derived
        // escalation is skipped this pass, but EDGE events still drain below.)
      }
      // Escalation safety valve — the SINGLE choke point, run at the END of the pass
      // and fully guarded, so a notification fault can never disturb dispatch /
      // integrate / detect (and a NORMAL pass with no fatal event notifies nothing).
      try {
        fireFatalNotifications(engine, tasks, deps, Date.now())
      } catch {
        /* belt-and-suspenders: never let escalation break a pass */
      }
      // OVERSEER (EPIC C / C-core): the autonomous proxy-you BRAINSTEM rides this tick
      // (never its own driver — K1). Reads the just-computed anomalies / notified / the
      // `tasks` snapshot (M3 — no 3rd board read) / worker heartbeats + a cached usage %,
      // and on rising edges wakes the proxy brain FIRE-AND-FORGET (never awaits it — D2)
      // or raises to the human. No-op unless the owner armed it (default OFF — D1). Placed
      // AFTER fireFatalNotifications so it reads the FRESH `notified` set (S2). NEVER throws.
      await runOverseerPass(
        engine,
        tasks,
        (level, message) => logLine(engine, level, message, 'routine'),
        defaultOverseerDeps({ isAlive: deps.isAlive, readHeartbeat: deps.readHeartbeat }),
      ).catch((e) => logLine(engine, 'warn', `overseer: pass errored — ${errMsg(e)}`))
    }
    // SELF-SUPPLY (card b3fbbfba): the engine proposes its OWN improvement cards
    // into todo. A SEPARATE stage from anomaly detection above — it READS the
    // just-computed engine.anomalies (plus its own tsc/lint/test/TODO scanners)
    // but never touches detectAnomalies. No-op unless armed (default OFF); then
    // throttled + capped + owner-approval-gated. NEVER throws into the tick.
    //
    // FIRE-AND-FORGET, never awaited: an armed scan spawns tsc + eslint + vitest
    // sequentially (up to ~8 minutes), and `passInFlight` is held for this whole
    // body — so awaiting it froze dispatch AND the monitor (stall / runaway / crash
    // detection) and integrate for the length of the scan. The scan now runs beside
    // the tick; kickSelfSupplyPass owns the re-entrancy guard (one scan at a time)
    // and the `.catch` that keeps a fault in the journal.
    if (engine.running) {
      kickSelfSupplyPass(
        engine,
        (level, message) => logLine(engine, level, message, 'routine'),
        deps.selfSupplyDeps,
        undefined,
        // Persist the daily counter after a pass that proposed cards, so a
        // restart cannot hand self-supply a fresh budget (guard 3).
        () => persistEngineIntent(engine, engine.path),
      )
    }
  } finally {
    engine.passInFlight = false
  }
}

// ── Scheduling (the setTimeout chain) ────────────────────────────────────────

/** Schedule the next pass — but only while running AND only for the CURRENT start
 *  epoch. The chain (vs setInterval) guarantees no pass overlaps itself: the next
 *  is armed in the `.finally` of the current one, after it fully settles. The
 *  `gen` it captures is the start epoch that owns this chain; a stop→start bumps
 *  the engine's generation, so a STALE chain (an older kick whose `.finally` runs
 *  after the restart) sees `gen !== engine.generation` and stops instead of arming
 *  a SECOND timer beside the fresh chain — no duplicate-chain double-ticking. */
const scheduleNext = (
  engine: ProjectEngine,
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps,
  gen: number,
): void => {
  if (!engine.running || gen !== engine.generation) return
  engine.timer = setTimeout(() => {
    void runEnginePass(engine, deps)
      .catch(() => {
        /* runEnginePass's stages are internally guarded; belt-and-suspenders */
      })
      .finally(() => scheduleNext(engine, deps, gen))
  }, TICK_MS)
}

// ── Public control plane (called by the owner-gated routes) ──────────────────

/** Turn the autonomous drain ON for a project (idempotent). Preflights `claude`
 *  so the owner gets an immediate "can't spawn" signal rather than a silently
 *  idle engine; throws ClaudeNotReadyError-shaped errors the route maps to 503.
 *  Kicks one pass immediately, then schedules the chain. */
export class ClaudeNotReadyError extends Error {
  body: { error: string; claudeMissing?: true; claudeLoggedOut?: true }
  constructor(body: { error: string; claudeMissing?: true; claudeLoggedOut?: true }) {
    super(body.error)
    this.name = 'ClaudeNotReadyError'
    this.body = body
  }
}

export const startOrchestrator = async (
  projectPath: string,
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  // Preflight up front (parity with POST /api/swarm/worker): refuse to start an
  // engine that can't spawn anything, with the same machine-readable 503 body.
  const pre = await claudeRunPreflight()
  if (!pre.ok) throw new ClaudeNotReadyError(pre.body)

  const key = await canonicalize(projectPath)
  const engine = getOrCreateEngine(key)
  // Owner re-engaged autonomy — clear any prior explicit-pause so the engine runs now
  // AND so a later natural idle can auto-restart it again (maybeAutoStartDrain). The
  // INVERSE of stopOrchestrator's manualStop=true; the two toggles are the consent.
  engine.manualStop = false
  // ...and clear its PERSISTED half too: an explicit ON always outranks the durable
  // "stopped by hand" record, so the pause never outlives the owner's consent.
  await forgetSwarmManualStop(key)
  // Persist the owner's intent as a REMINDER marker (Settings.swarmAutonomyOn) —
  // historically this was "never auto-resume, just remind", but since card 2
  // (docs/ENGINE_PERSISTENCE_PLAN.md — see the `persistEngineIntent` call ~20
  // lines below) a restart of THIS project now DOES auto-resume on its own via
  // `engine.json`'s `desiredRunning`. The two markers now do different jobs:
  // this one (`swarmAutonomyOn`) is a lightweight legacy reminder the Swarm UI
  // can still read before any per-project engine exists; `engine.json` is the
  // one `resumeEngines()` actually acts on. Idempotent; cleared by
  // stopOrchestrator (explicit OFF / dismiss).
  await rememberSwarmAutonomy(key)
  // Read the LAST persisted intent ONCE, here — before the pass kick below, and
  // before the write at the bottom. Two callers need it (selfSupply backfill,
  // card 2b's overseer record) and the position is load-bearing twice over:
  //   · it must not sit AFTER the fire-and-forget `runEnginePass` kick — every await
  //     there is time the kicked pass gets to stamp `lastIntegrateAt` /
  //     `reviewSeenAt` before this function returns, which is exactly the
  //     restart-drops-the-dwell-clock contract its own test pins (2026-07-22);
  //   · reading it ONCE keeps the write below a single `writeEngineIntent`, so this
  //     path costs no more disk than it did before card 2b.
  const priorIntent = await readEngineIntent(projectPath)
  if (!engine.running) {
    // nit fix (2nd rework): backfill selfSupply from the LAST persisted intent
    // before we (below) write a fresh full snapshot back out. Without this, an
    // owner who manually presses ON after a SUPPRESSED boot resume (crash-loop
    // breaker held it off, or preflight failed at boot) gets a FRESH in-memory
    // engine whose selfSupply defaults to false — and the very act of turning
    // the drain ON would then silently overwrite a persisted selfSupply:true
    // with false, losing it for good even after the transient problem clears.
    // Only ever raises false→true (never clobbers an explicit false — including
    // one the owner set deliberately this session, which was already written
    // back to disk by setSelfSupply and would round-trip to the same value).
    if (!engine.selfSupply.enabled && priorIntent.selfSupply) engine.selfSupply.enabled = true
    engine.running = true
    // An explicit engine (re)start is the owner's hand on the machine: clear a
    // standing SDK spawn hold so the first fill attempts immediately instead of
    // sitting out the remainder of a rung (up to 15m) armed before the owner
    // fixed the cause. Wrong at most once — a still-broken machine re-arms on
    // that first attempt. (Adversarial review 2026-08-13.)
    engine.sdkSpawnHold = undefined
    // Reset the integration throttle so the first pass after a (re)start refreshes
    // the readiness display immediately — without this, a stop→start within
    // INTEGRATE_TICK_MS would leave the "統合可" snapshot stale for up to 15s.
    engine.lastIntegrateAt = 0
    // …and DROP the review dwell clock: time the engine was OFF must not count as
    // 「統合待ち」 (2026-07-22 差し戻し). The clock feeds the stall check, and the very
    // first pass after a start runs immediately (lastIntegrateAt = 0 above) — so a stamp
    // left over from before the stop would arrive already past the window and fire an ESC
    // at a live desk ~15 seconds after the owner turned the engine back on. The owner
    // stops the engine precisely to work at that desk by hand, which is exactly the
    // session a stray poke would break. Re-stamped on the next pass, so the wait simply
    // restarts from "when the engine could first see it".
    engine.reviewSeenAt?.clear()
    // …and with it any notice queued before the stop. Clearing `reviewSeenAt` re-arms
    // every waiting branch as "freshly ready", so the first pass raises a CURRENT notice
    // anyway; keeping the old one would only risk naming branches that moved while the
    // engine was off. (Same reasoning, same line: the stop/start boundary is where stale
    // in-memory beliefs about the review queue are dropped.)
    engine.managerNotice = null
    // …and the COMMANDER RESURRECTION state, for the same reason (2026-08-04).
    // `managerResume` is created once per engine object and survived stop→start,
    // so its two latches outlived the problem they described:
    //   • `fatalFired` is what the new 'manager-unrevivable' anomaly reads, and
    //     that anomaly is re-derived every pass — so an owner who stopped the
    //     engine, opened the commander desk by hand, fixed it and started again
    //     saw 「司令官の卓が戻りません · 統合が止まっています」 from the FIRST tick,
    //     about a desk that was up. (Only the integrate pass clears the latch,
    //     and it is fire-and-forget + throttled, so the false claim can stand for
    //     minutes.)
    //   • `attempts` at the ceiling makes the reflex give up before it spawns
    //     even once in the new epoch.
    // A stop/start is exactly where stale beliefs about the desk are dropped —
    // the same rule the three lines above follow. The nudge budget goes with it.
    //
    // ⚠ FIXED AS AN INVARIANT, NOT AS A REPRODUCED FAILURE (same wording as the
    // sibling reset block in the integrate pass, for the same honest reason). I
    // could not get a unit fixture to hold the latch across the start: the
    // integrate pass the start kicks clears the whole revive block by itself
    // whenever nothing is waiting, and the review list it judges that on comes
    // from `fetchReview`, not from the board. A guard that stays green with this
    // line deleted is worth nothing, so none was left behind — the reasoning
    // above is the record. Reproducing it needs the pass to see work waiting AND
    // the desk absent, which is an integration-level fixture.
    engine.managerResume = undefined
    // New start epoch — supersedes any stale chain still settling from a prior
    // start (whose `.finally` will see the bumped generation and not re-arm).
    const gen = (engine.generation += 1)
    logLine(engine, 'info', 'autonomous drain ON')
    // Kick immediately so the queue starts draining without waiting a full tick,
    // then arm the chain. runEnginePass's re-entrancy guard makes this kick safe
    // even if a stale pass is still in-flight (the kick bails, no twin-dispatch).
    void runEnginePass(engine, deps)
      .catch(() => {})
      .finally(() => scheduleNext(engine, deps, gen))
  }
  // The owner touched the power switch — whatever this engine's `running` now is,
  // it is THEIR state, not a restored one. Clear the boot-resume marker so the UI's
  // "restored from last session" notice can't outlive the fact it reports (card 2b).
  engine.autonomyResumed = false
  // card 2 — persist `desiredRunning:true` so a restart's resumeEngines() can
  // bring this project back up with no owner action (docs/ENGINE_PERSISTENCE_PLAN.md
  // §4). Fire-and-forget-safe (patchEngineIntent never throws) but awaited so a
  // caller that immediately restarts the process still sees the write land.
  //
  // card 2b — `overseer` is carried over from the value read above instead of being
  // derived from THIS engine's in-memory `.enabled` (what persistEngineIntent does).
  // On a fresh post-restart engine that flag is false, so the old full write ERASED
  // the disk record the one-click restore banner reads — in the exact path where it
  // matters most (a boot whose resume was suppressed by the crash-loop breaker or
  // preflight: the owner sees both banners and presses 再開 first). Turning autonomy
  // ON says nothing about the overseer; it is a SEPARATE toggle the owner arms on its
  // own, and the only site that legitimately clears its intent is the explicit OFF
  // (stopOrchestrator's D1 asymmetry). resumeEngines still never reads the field, so
  // preserving it changes NO resume behaviour — only whether the banner survives long
  // enough to be pressed. The OR keeps the record honest in the idempotent-ON case
  // (already armed ⇒ true even if a prior write had been lost to a disk fault).
  const rememberedOverseer = engine.overseer.enabled || priorIntent.overseer
  const persisted = await writeEngineIntent(projectPath, {
    desiredRunning: engine.running,
    selfSupply: engine.selfSupply.enabled,
    overseer: rememberedOverseer,
  })
  if (!persisted) {
    logLine(engine, 'warn', 'engine intent persist failed (disk) — in-memory state unaffected')
  }
  // autonomyRemembered:true — the marker was just written above (harmless while
  // running, since the UI shows the reminder only while !running); manualStopPersisted:
  // false — the record was just cleared above; overseerRemembered — the value just
  // written, i.e. the record this call deliberately PRESERVED rather than derived.
  return stateOf(engine, deps.isAlive, [], true, false, rememberedOverseer)
}

/** Turn the autonomous drain OFF (idempotent). Cancels the pending pass and
 *  stops scheduling — but LEAVES already-dispatched workers running (the manual
 *  control plane owns their teardown) and keeps the worker set + journal so the
 *  state read stays meaningful and a later restart re-counts them. */
export const stopOrchestrator = async (
  projectPath: string,
  deps: OrchestratorDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  // Clear the persisted reminder FIRST — an explicit OFF (or a "dismiss" of the
  // restart reminder) must forget the owner's intent even when store.engines has
  // no entry for this key yet (the common case right after a relaunch: the engine
  // is in-memory and gone, but Settings.swarmAutonomyOn still carries the marker).
  await forgetSwarmAutonomy(key)
  // Persist the "stopped by hand" record — ALSO before the engine-existence check,
  // so the fact survives a restart (fresh process, no engine yet) and stays
  // machine-readable from outside (the 0707 twin-dispatch root cause). A record,
  // never an auto-resume: its only engine-side reader (maybeAutoStartDrain) uses it
  // to SUPPRESS an auto-start, nothing ever runs because of it.
  await rememberSwarmManualStop(key)
  const engine = store.engines.get(key)
  if (!engine) {
    // card 2 — persist `desiredRunning:false` even with no in-memory engine (the
    // common post-relaunch case: no engine exists yet, but engine.json from a
    // PRIOR process might still say true). Without this write, a relaunch right
    // after this OFF would still see the stale desiredRunning:true and resume.
    await writeEngineIntent(projectPath, { desiredRunning: false, selfSupply: false, overseer: false })
    // overseerRemembered / autonomyResumed stay false via emptyState() — the write
    // above just cleared the overseer intent (D1: an explicit OFF forgets it), and
    // there is no engine to have been resumed.
    return { ...emptyState(), manualStop: true, manualStopPersisted: true }
  }
  // Owner EXPLICITLY paused — mark it so maybeAutoStartDrain won't auto-restart the
  // engine on the next poll's idle-slot + todo (so OFF genuinely halts new dispatch,
  // 条件2). Set even on an idempotent OFF (already stopped) so the pause intent sticks
  // until a manual ON clears it. A DEFAULT-off engine (never paused) still auto-drains.
  engine.manualStop = true
  // OVERSEER ASYMMETRY (D1): an explicit autonomy OFF also DISARMS the overseer — the
  // most-dangerous stage never survives a stop (unlike selfSupply, which is
  // temporarily inert while stopped but re-arms on the next start). Combined with
  // in-memory OFF-on-restart (K2), this is why an auto-drain re-ignition can NEVER wake
  // the overseer: `enabled` only becomes true through the owner POST, and both an
  // explicit OFF (here) and a restart have already dropped it false. Abort any brain in
  // flight so it does not linger past the OFF.
  if (engine.overseer) {
    engine.overseer.enabled = false
    engine.overseer.brainAbort?.abort()
  }
  if (engine.running) {
    engine.running = false
    if (engine.timer) {
      clearTimeout(engine.timer)
      engine.timer = null
    }
    logLine(engine, 'info', 'autonomous drain OFF')
  }
  // The owner touched the power switch — clear the boot-resume marker (card 2b),
  // same reasoning as startOrchestrator: this state is theirs now.
  engine.autonomyResumed = false
  // card 2 — persist `desiredRunning:false` (engine.overseer/selfSupply reflect
  // the OFF above too, overseer forced false by the D1 asymmetry).
  await persistEngineIntent(engine, projectPath)
  // autonomyRemembered:false — the marker was just cleared above; manualStopPersisted:
  // true — the record was just written above; overseerRemembered:false — the D1
  // asymmetry above disarmed the overseer and the write mirrored that to disk, so
  // there is deliberately nothing left to restore.
  return stateOf(engine, deps.isAlive, [], false, true, false)
}

// ── Auto-start (card cf545637 — todo 自動 drain / "idle worker + todo" デッドロック根治) ──

/** Auto-start the autonomous drain when there is dispatchable todo work AND a free
 *  worker slot, even though the owner never toggled Autonomy ON. This is the root fix
 *  for the "worker idle while todos remain" deadlock: a STOPPED engine schedules no
 *  ticks (scheduleNext bails while !running), so a card added to todo with the toggle
 *  OFF would otherwise sit forever beside idle capacity. The Swarm surface's DRAIN-TICK
 *  (useSwarmEngine POSTs /api/swarm/orchestrator/drain-tick → {@link drainTickOrchestrator}
 *  on its poll cadence) drives this, so MANAGING the Swarm surface wakes a needed engine
 *  without a manual ON press. The read-only GET /api/swarm/orchestrator (which the
 *  display-only Board worker-map ALSO polls) NEVER triggers it — a pure state read must
 *  not spawn `claude` workers (that GET-with-side-effect was a review MUST_FIX).
 *
 *  Fires ONLY when ALL hold — so it never fights the existing flows (条件2/3):
 *    • the engine is NOT already running (a running engine refills idle slots every
 *      tick already; re-driving it would risk a twin dispatch), and not mid-pass,
 *    • the owner has NOT explicitly paused it (manualStop — a manual OFF sets it, a
 *      manual ON clears it; this is what makes OFF genuinely halt new dispatch, 条件2.
 *      A DEFAULT-off engine, never paused, auto-drains — that is 条件1),
 *    • ≥1 todo card passes EVERY dispatch gate right now (selectDispatch — a duplicate
 *      / same-file / dep-blocked / unapproved-self-supply todo never trips it), AND
 *    • ≥1 slot is free (live workers < the dynamic target) — so it can NEVER spawn past
 *      ORCHESTRATOR_MAX_WORKERS, exactly like runDispatchPass (暴走防止 / 条件3).
 *  An EMPTY (or fully-claimed) todo queue, or a full worker set, is a no-op — so OFF
 *  with nothing dispatchable (or no capacity) stays OFF and the toggle keeps meaning.
 *  Because the gate is "idle slot + todo", a stop/resolve that parks a card in
 *  'blocked' (stopOrchestratorWorker / resolveOrchestratorReview) is NOT re-grabbed —
 *  only a 'todo' card is, which is exactly the requeue those flows intend (条件2).
 *
 *  When it fires it engages the engine with the SAME state the manual ON toggle sets
 *  (running=true + a fresh generation + the integration throttle reset), drains the
 *  first batch INLINE so the queue starts moving within this call, then arms the normal
 *  tick chain — so the full lifecycle (monitor → promote → integrate) runs and the
 *  auto-dispatched worker is never orphaned. PREFLIGHTS `claude` (deps.preflight — injected,
 *  default claudeRunPreflight) right before engaging: a missing / logged-out CLI returns
 *  false WITHOUT flipping running, so the unattended background sweep can't spin a
 *  spawn-fail retry storm across EVERY project (design note 4). A final re-check after the
 *  preflight await preserves the twin-dispatch guard. Returns whether it auto-started. Never
 *  throws — a board-read blip yields no auto-start this round (the next sweep / poll
 *  retries). `now` is injected for deterministic tests. */
export const maybeAutoStartDrain = async (
  engine: ProjectEngine,
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps,
  now: number = Date.now(),
): Promise<boolean> => {
  // No auto-start when: already draining / mid-pass (the running loop owns refills — don't
  // double-drive), OR the owner explicitly paused (manualStop — OFF must stick, 条件2).
  if (engine.running || engine.passInFlight || engine.manualStop) return false
  // The PERSISTED half of the owner's pause (Settings.swarmManualStop): the in-memory
  // flag dies with the process, so without this check a restart would let the opt-in
  // AUTODRAIN sweep re-ignite an engine the owner deliberately stopped by hand. An
  // explicit ON (startOrchestrator) clears the record, so consent always re-opens it.
  if (await isSwarmManualStopPersisted(engine.path)) return false
  let tasks: ProjectTask[]
  try {
    tasks = await deps.fetchTasks(engine.path)
  } catch {
    return false // a board blip is not the moment to auto-start; the next poll retries
  }
  // Re-check after the await — a concurrent poll (or a manual toggle) may have changed
  // the engine in the meantime.
  if (engine.running || engine.passInFlight || engine.manualStop) return false
  // The SAME idle-capacity + independent-backlog math runDispatchPass uses, so the
  // auto-start decision agrees exactly with what a running pass would dispatch.
  const live = engine.workers.filter((w) => deps.isAlive(w)).length
  const countedIds = new Set(engine.workers.map((w) => w.taskId))
  const dispatchable = selectDispatch(tasks, countedIds, ORCHESTRATOR_MAX_WORKERS)
  const target = computeTargetWorkers({
    liveWorkers: live,
    dispatchableTodos: dispatchable.length,
    // Token budget (card 68d8e00f): economy caps parallel workers low, optimize middling,
    // max keeps the historical band — each live worker is a full `claude`, so this is a lever.
    max: execModeMaxWorkers(await getExecutionMode(), ORCHESTRATOR_MAX_WORKERS),
  })
  const slots = Math.max(0, target - live)
  if (dispatchable.length === 0 || slots === 0) return false

  // PREFLIGHT `claude` BEFORE engaging — a missing / logged-out CLI must NOT flip running
  // to true, else the engine's chain would retry a failing spawn forever (design note 4 /
  // the unattended background sweep would do this for EVERY project, every tick). Injected
  // (deps.preflight) so it's hermetic in tests; absent ⇒ skipped (back-compat for the
  // dispatch unit tests). Silent on a not-ready result — the sweep retries next tick, and
  // the manual ON button surfaces the 503 for an owner who is watching.
  if (deps.preflight && !(await deps.preflight()).ok) return false
  // FINAL re-check AFTER the preflight await, then COMMIT synchronously (no await between
  // this re-check and engine.running=true) — a concurrent caller that engaged the engine
  // during our preflight await is caught here, preserving the twin-dispatch guard.
  if (engine.running || engine.passInFlight || engine.manualStop) return false

  // Conditions met — engage the engine. These three mutations ARE the manual ON toggle's
  // loop-half (startOrchestrator), set SYNCHRONOUSLY here (no await before this commit since
  // the re-check) so a concurrent caller's re-check above bails before a twin dispatch.
  engine.running = true
  engine.lastIntegrateAt = 0
  const gen = (engine.generation += 1)
  logLine(
    engine,
    'info',
    `autonomous drain auto-started — ${dispatchable.length} independent todo(s) ready, ${slots} slot(s) free`,
  )
  // Drain the first batch inline so the queue starts moving within this call (the poll
  // returns the post-dispatch state; the unit test asserts the dispatch), then arm the
  // chain for the monitor/promote/integrate passes that follow. HOLD passInFlight across
  // the inline dispatch (mirrors runEnginePass's twin-dispatch guard): runDispatchPass
  // does NOT set it, so without this a manual stop→start injected during a slow spawn
  // would kick a SECOND pass that reads the same pre-spawn worker set and dispatches the
  // same card twice. The chain's runEnginePass then bails on passInFlight; clearing it in
  // `finally` guarantees a throwing dispatch can't wedge the engine.
  engine.passInFlight = true
  try {
    // Same control-plane serialization as runEnginePass — this auto-start inline
    // dispatch IS a dispatch pass (its monitor walks any lingering workers), so take
    // the per-engine critical section to stay mutually exclusive with a concurrent
    // stop/resolve (see runExclusive).
    await runExclusive(engine, () => runDispatchPass(engine, deps, now))
  } finally {
    engine.passInFlight = false
  }
  scheduleNext(engine, deps, gen)
  return true
}

/** Stop ONE engine-owned worker by its PTY id (the owner clicked "stop"): tear
 *  down its worktree + kill its `claude` PTY, park its card in 'blocked' so the
 *  running engine does NOT immediately re-dispatch the very card the owner just
 *  halted (the human/commander requeues it when ready), and free its slot.
 *  Idempotent — an unknown id (already gone, or a manual-spawn worker the engine
 *  never owned) is a no-op returning the current state. The engine acts ONLY on
 *  its OWN workers; a manual worker is the manual control plane's to stop (POST
 *  /api/swarm/worktree/remove). Works whether the engine is running or stopped. */
/** Stop ONE engine worker, addressed by its RUNTIME-AGNOSTIC key
 *  ({@link workerKey}: the terminalId of a PTY worker, the sdkSessionId of an SDK
 *  one). The parameter kept its old name for the wire, but matching on
 *  `x.terminalId` was a live defect once a second runtime existed: EVERY SDK
 *  worker records `terminalId: ''` by the identity invariant, so an id of `''`
 *  matched the FIRST of them and the drop below then filtered out ALL of them —
 *  the engine forgetting every SDK worker at once while their claude processes
 *  kept running. Keying on workerKey makes the address unique per worker again. */
export const stopOrchestratorWorker = async (
  projectPath: string,
  terminalId: string,
  deps: OrchestratorDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  const engine = store.engines.get(key)
  if (!engine) return emptyState()
  // Run UNDER the per-engine critical section: the worker lookup + teardown + card
  // park + worker drop is a read→decide→write transaction on the SAME state a
  // dispatch pass's monitor reads from a stale pass-start snapshot. Without the lock a
  // stop landing in the monitor's await window parks the card in 'blocked' only for
  // the still-looping monitor to overwrite it back to todo/review (the owner's halt
  // undone); serializing makes the monitor see this drop + park, and this stop see the
  // monitor's, never a half-updated mix (see runExclusive).
  return runExclusive(engine, async () => {
    // keyOf, not `x.terminalId`: a runtime-agnostic address (see the doc above).
    // An empty id can never match — it is the SDK worker's terminalId, and
    // matching it would target an arbitrary worker.
    const keyOf = (x: WorkerHandle): string => {
      try {
        return workerKey(x)
      } catch {
        return '' // malformed handle — unaddressable, never matched
      }
    }
    const w = terminalId ? engine.workers.find((x) => keyOf(x) === terminalId) : undefined
    if (!w) return stateOf(engine, deps.isAlive) // unknown / already gone — idempotent
    const stopKey = keyOf(w)

    // Tear the worktree + PTY down FIRST (the zombie-eradication — idempotent, and
    // the critical guarantee). Best-effort: a failure is logged, never blocks the stop.
    let teardown: { removed: boolean; reason?: string; wip?: WipCommitResult } = { removed: false }
    try {
      // 'stopped' — an OWNER stop. Its uncommitted work is salvaged onto the branch
      // like any other teardown: the owner stopped the worker, not the work.
      teardown = await deps.recoverWorker({
        projectPath: key,
        worktree: w.worktree,
        terminalId,
        ...(w.sdkSessionId ? { sdkSessionId: w.sdkSessionId } : {}),
        reason: 'stopped',
      })
    } catch {
      /* reported via teardown.removed=false below */
    }

    // Park the card in 'blocked' if WE still own it (still in 'doing'). A USER stop
    // is a deliberate halt — 'blocked' (not 'todo') stops the running engine from
    // re-grabbing it on the very next tick. A card a human already moved / deleted
    // is left as-is.
    let parked: 'blocked' | 'kept' | 'untouched' = 'untouched'
    try {
      const card = (await deps.fetchTasks(key)).find((t) => t.id === w.taskId)
      if (card && columnOf(card) === 'doing') {
        parked = (await deps.recoverCard(key, w.taskId, 'blocked')) ? 'blocked' : 'kept'
      }
    } catch {
      /* best-effort — the worker is still dropped below */
    }

    engine.recoveries.delete(w.taskId)
    engine.reworks.delete(w.taskId) // owner halted this worker — drop its 差し戻し budget too
    engine.conflictReworks.delete(w.taskId) // ...and its conflict-委譲 budget (card 012a2848)
    // Drop THIS worker only. Filtering on `x.terminalId !== terminalId` dropped
    // every SDK worker at once (they all carry the empty terminalId).
    engine.workers = engine.workers.filter((x) => keyOf(x) !== stopKey)
    // card 3 — teardown drops the worker's roster entry (completion condition ③).
    // AWAITED (a quick fail-open write, never throws) so the removal is observable
    // the instant the stop returns. Should it be lost, the worker is already gone
    // from engine.workers, so a still-running engine's next syncRoster sees the
    // changed signature and re-derives clean anyway.
    await removeRosterEntry(key, w.worktree)
    const note = parked === 'blocked' ? 'card → blocked' : parked === 'kept' ? 'card move kept' : 'card left as-is'
    logLine(
      engine,
      'info',
      `worker stopped by owner — ${note}: ${w.branch} (${shorten(w.taskTitle)})` +
        (teardown.removed ? '' : ` · worktree kept (${teardown.reason ?? '?'})`),
    )
    return stateOf(engine, deps.isAlive)
  })
}

/** Resolve a STUCK review card on the owner's command — the human resolution path
 *  for a card the engine can NOT auto-land (a real rebase conflict, or one that
 *  keeps failing verification), so it never sits in review forever. Moves the card
 *  OUT of review into a human-actionable column, clears its conflict flag + the
 *  engine's conflict/verify memos, tears down any leftover worker (keeping the
 *  branch), and drops it from the readiness snapshot:
 *    - target 'blocked' — PARK it: the owner takes the branch over by hand (resolve
 *      the conflict in a terminal, then move the card to done / back to review).
 *    - target 'todo'    — REQUEUE it: dropping the stale worker frees the card to be
 *      re-dispatched, so a fresh worker re-attempts the goal off the current trunk
 *      (the old branch is left for reference — branch names are unique per spawn).
 *  Idempotent: a card NOT currently in review (already resolved / moved / deleted)
 *  is a no-op returning the current state. Best-effort writes (a kept move leaves
 *  the card in review — the owner retries); never throws. Owner-gated at the route.
 *  Works whether the engine is running or stopped. */
/** The outcome of {@link abandonCardIntegration}. */
export type AbandonIntegrationResult =
  | { ok: true; alreadyParked?: true }
  | { ok: false; reason: 'card-missing' | 'not-in-review' | 'write-failed' }

/**
 * 「B: この作業は見送る（できあがった分も取り込みません）」 — execute the owner's
 * decision that this card's work must NOT be integrated.
 *
 * A THIN LAYER over {@link resolveOrchestratorReview}(…, 'blocked'), deliberately:
 * that function already moves the card out of review, tears down any worker
 * still counted for the branch (with the both-pools occupancy check), rewrites
 * the roster in one pass and clears every memo. Re-implementing 8/10 of it beside
 * it is exactly the duplicate-seam class this repo keeps paying for. What this
 * adds is the ONE thing that makes the decision stick: the standing `abandoned`
 * flag the publish path reads (see the `swarmCards` filter).
 *
 * ORDER IS DELIBERATE. Park first, then stamp. If the stamp fails, the card is
 * already out of review — and a card that is not in review is never published,
 * so a half-completed abandon fails to the SAFE side. The reverse order would
 * leave a flagged card sitting in review, where nothing reads the flag.
 *
 * ⚠ The branch and its commits are KEPT. 「見送る」 means "do not integrate this",
 * not "destroy it": the owner can change their mind, and the way back is to move
 * the card out of 保留 (which clears the flag at the board route).
 */
export const abandonCardIntegration = async (
  projectPath: string,
  taskId: string,
  deps: OrchestratorDeps & IntegrationDeps = defaultDeps(),
): Promise<AbandonIntegrationResult> => {
  let card: ProjectTask | undefined
  try {
    card = (await deps.fetchTasks(projectPath)).find((t) => t.id === taskId)
  } catch {
    return { ok: false, reason: 'card-missing' }
  }
  if (!card) return { ok: false, reason: 'card-missing' }

  // Already parked (a second answer, a retry, or the owner moved it by hand):
  // there is nothing to un-review, but the flag may still be missing — stamp it
  // and report the idempotent case rather than fail for a decision already taken.
  const inReview = columnOf(card) === 'review'
  if (inReview) await resolveOrchestratorReview(projectPath, taskId, 'blocked', deps)

  const stamped = await (deps.markAbandoned ?? defaultMarkAbandoned)(projectPath, taskId)
  if (!stamped) return { ok: false, reason: 'write-failed' }
  return inReview ? { ok: true } : { ok: true, alreadyParked: true }
}

export const resolveOrchestratorReview = async (
  projectPath: string,
  taskId: string,
  target: 'blocked' | 'todo',
  deps: OrchestratorDeps & IntegrationDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  const engine = store.engines.get(key)
  if (!engine) return emptyState()

  // Run UNDER the per-engine critical section: this read-fresh → move-out → teardown →
  // clear-memos transaction shares the board + worker + reviews state with a dispatch
  // pass's monitor (which promotes doing→review off a stale snapshot). Serializing
  // keeps the owner's deliberate resolve from being interleaved-and-undone, and keeps
  // it from racing the monitor's worker bookkeeping (see runExclusive). (The slow
  // integrate pass is NOT in this section — a resolve racing an in-flight integrate of
  // the SAME review card is a separate, far narrower pre-existing window; see runExclusive.)
  return runExclusive(engine, async () => {
    // Act ONLY on a card actually in review (idempotent otherwise). Read fresh — the
    // engine.reviews snapshot can lag a pass behind the board.
    let card: ProjectTask | undefined
    try {
      card = (await deps.fetchTasks(key)).find((t) => t.id === taskId)
    } catch {
      return stateOf(engine, deps.isAlive)
    }
    if (!card || columnOf(card) !== 'review') return stateOf(engine, deps.isAlive)
    const branch = typeof card.branch === 'string' ? card.branch : ''

    // Move the card OUT of review FIRST — the critical, must-succeed step (it must
    // not sit in review forever). A KEPT move changes NOTHING: the worker + memos
    // stay intact and the owner simply retries, so a board-write blip never leaves
    // the card half-resolved.
    let moved = false
    try {
      moved = await deps.recoverCard(key, taskId, target)
    } catch {
      moved = false
    }
    if (!moved) {
      logLine(engine, 'warn', `review resolve kept (will retry): ${shorten(card.title ?? '')} → ${target}`)
      return stateOf(engine, deps.isAlive)
    }

    // Moved — tear down any worker still counted for this branch: its promoted 'done'
    // PTY may linger and its worktree is stale scratch (cleanup never ran — we didn't
    // integrate). Keeps the BRANCH (the human / next worker may want its commits) and
    // — for a 'todo' requeue — frees the card to be re-dispatched (its id leaves the
    // counted set, so selectDispatch's id gate no longer skips it).
    const owned = branch ? engine.workers.filter((w) => w.branch === branch) : []
    // Did any of them refuse to let go? A worktree that still holds a LIVE desk
    // means the old claude is still running in it (see removeSwarmWorktree).
    let stillOccupied = false
    for (const w of owned) {
      try {
        const res = await deps.recoverWorker({
          projectPath: key,
          worktree: w.worktree,
          terminalId: w.terminalId,
          ...(w.sdkSessionId ? { sdkSessionId: w.sdkSessionId } : {}),
          reason: 'stopped', // salvage any uncommitted work onto the branch first
        })
        if (res.stillOccupied === true) stillOccupied = true
      } catch {
        /* best-effort teardown — the card already left review, which is the point */
      }
    }
    // ⚠ A REQUEUE ON TOP OF A LIVE WORKER IS A TWIN (2026-08-04). The card is
    // moved out of review BEFORE the teardown (that move is the must-succeed
    // step), so by the time we learn the old desk would not stop, a 'todo' card
    // is already sitting in the dispatch queue — and the next pass spawns a
    // SECOND claude on a FRESH branch for the same card while the first one is
    // still writing in the old worktree. That is the recorded field failure
    // ("差し戻しが生きている worker を見落として同じ作業場に2本目を立てる"), and it
    // is precisely what the engine's own recovery path refuses to do. Correct the
    // move: park it instead, where a human decides.
    if (stillOccupied && target === 'todo') {
      const parked = await deps
        .recoverCard(key, taskId, 'blocked')
        .catch(() => false)
      logLine(
        engine,
        'warn',
        `差し戻しを保留に変更: ${shorten(card.title ?? '')} — 前の担当の作業場でまだ claude が動いているため、` +
          `いま順番待ちに戻すと同じカードに2人目が立ちます。` +
          (parked ? '' : '(カードの移動に失敗 — 次のパスで再試行します)'),
        'cleanup',
      )
    }
    if (owned.length) {
      engine.workers = engine.workers.filter((w) => !owned.includes(w))
      // card 3 — drop every torn-down worker's roster entry in ONE read-modify-write
      // (completion condition ③); per-worktree removeRosterEntry calls would race the
      // file (each reads the full set, drops one, writes — the last write wins).
      const gone = new Set(owned.map((w) => w.worktree))
      await writeRoster(key, (await readRoster(key)).filter((e) => !gone.has(e.worktree)))
    }

    // Clear EVERY engine memo tied to this branch so a re-attempt re-classifies clean:
    // the persistent conflict stamp (reliable CLEAR), the in-memory conflict + verify
    // memos, the readiness snapshot row, and any recovery / stuck-move tracking.
    if (branch) {
      engine.conflictedBranches.delete(branch)
      engine.verifyFailed.delete(branch)
    }
    if (card.integrationConflict) {
      try {
        await deps.markConflict(key, taskId, false)
      } catch {
        /* best-effort — the card already left review; a kept clear is only cosmetic */
      }
    }
    engine.reviews = engine.reviews.filter((r) => r.taskId !== taskId)
    engine.recoveries.delete(taskId)
    engine.reworks.delete(taskId) // owner's deliberate resolve = fresh 差し戻し budget
    engine.conflictReworks.delete(taskId) // ...and a fresh conflict-委譲 budget (card 012a2848)
    clearKeptMove(engine, taskId)
    logLine(
      engine,
      'info',
      `review resolved by owner — card → ${target}: ${branch || '(no branch)'} (${shorten(card.title ?? '')})`,
      'integrate',
    )
    return stateOf(engine, deps.isAlive)
  })
}

/** Current engine state for a project (never started ⇒ a stopped empty state). */
/** DISPLAY-ONLY commander status ({@link SwarmManagerPresence}). PURE — no I/O,
 *  no clock: it is handed the two facts {@link getOrchestratorState} has already
 *  read, so publishing it costs nothing on the 5-second poll.
 *
 *  ⚠ WHY NOT `defaultManagerPresence` (the engine's reflex judgement):
 *   • it stats transcripts under ~/.claude — this GET is polled per project by
 *     both the Swarm pane and the Board worker map;
 *   • it falls to 'absent' on ANY exception, which is the right direction for
 *     "should I wake the desk?" and the wrong one for a sentence the owner
 *     reads: one transient read failure would announce the commander is gone;
 *   • its echo discount exists so our own keystrokes don't look like life —
 *     a concept with no meaning in a status line.
 *
 *  THE ORDER IS THE FIX: desk-existence outranks the heartbeat. A heartbeat is
 *  fresh for ten minutes after it is written, and the defect this replaces was
 *  exactly a desk that beat once and then died — the pane kept saying it was
 *  working, unattended, on the screen that decides whether the owner looks. */
export const managerPresenceForDisplay = (input: {
  /** A live commander desk exists in EITHER pool (stopping ones excluded). */
  deskLive: boolean
  /** The heartbeat file was written inside its freshness window. */
  beatFresh: boolean
}): SwarmManagerPresence => {
  if (!input.deskLive) return 'missing'
  return input.beatFresh ? 'working' : 'quiet'
}

export const getOrchestratorState = async (
  projectPath: string,
  deps: OrchestratorDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  // The persisted "autonomy was on last session" reminder. Read BEFORE the engine
  // lookup so it surfaces even when no engine exists yet this session — which is
  // exactly the state right after a relaunch (engine in-memory ⇒ gone), the moment
  // the reminder matters most. The engine always relaunches OFF; this flag is what
  // lets the UI offer a one-click resume instead of silently auto-running.
  const remembered = await isSwarmAutonomyRemembered(key)
  // The persisted "stopped by hand" record — read the same way (pure read, K8) so a
  // deliberate pause stays machine-readable even after a restart wiped the in-memory
  // engine (the 0707 twin-dispatch root cause: this state was invisible from outside).
  const stopped = await isSwarmManualStopPersisted(key)
  // The commander's own heartbeat (display-only presence line, same pure-read
  // discipline). Read INDEPENDENTLY of the engine: a human-opened commander desk
  // beats into the same file whether or not an engine exists this session, so the
  // presence line must not go dark just because the engine store is empty.
  const manager = await readManagerHeartbeatInfo(projectPath)
  // card 2b — the RAW persisted overseer intent (engine.json). Read on the SAME pure-read
  // discipline as the two markers above, and BEFORE the engine lookup for the same reason:
  // right after a restart there is no in-memory engine, and that is precisely when the
  // one-click restore banner has to appear. This is a REMINDER read only — the boot path
  // (resumeEngines) still never reads this field back to arm the overseer, because a
  // restart is the one kill switch layer with no substitute (OVERSEER_DESIGN.md K2 /
  // L9-③). readEngineIntent never throws (fail-quiet-to-OFF ⇒ no banner on a bad disk).
  const overseerIntent = (await readEngineIntent(projectPath)).overseer
  // The desks ACTUALLY live right now — both-pools reads, still pure/idempotent
  // (this GET's K8 no-mutate contract). This is the handle the UI needs to ADOPT
  // an engine-woken desk: the heartbeat above carries phase/note but NO id, so
  // after an app restart the pane pinned to its dead pre-restart id forever
  // while the sidebar said the commander was working (0803 owner report).
  // ⚠ `.stopping` desks are EXCLUDED here and only here: they still exist for
  // the singleton guard (a twin must not spawn on top of an unwinding desk) but
  // they must never be ADOPTED — publishing one made the pane re-attach to the
  // desk the owner had just stopped, so 停止 never stuck on a wedged session
  // (overnight review 2026-08-03). Occupancy and adoption are different
  // questions about the same desk; this is the line where they part.
  const managerDeskFull = listManagerDesks(key).find((d) => !d.stopping) ?? null
  const managerDesk = managerDeskFull
    ? {
        runtime: managerDeskFull.runtime,
        handleId: managerDeskFull.handleId,
        agentSessionId: managerDeskFull.agentSessionId,
      }
    : null
  // ⚠ RE-CONFIRM AGAINST THE PROCESS TABLE, exactly as listManagerDesks does
  // for the commander (cycle-3 finding: the supply desk had neither that check
  // nor a `stopping` notion). The pool's `finishedAt` is stamped by an
  // ASYNCHRONOUS onExit, so for a moment after a kill the desk is still listed
  // — and the pane, being told a live handle, re-adopts the desk the owner just
  // stopped. Same shape as the commander's stop-does-not-stick, one pool over.
  const supplyLive =
    listLiveDesksIn(key, SUPPLY_DESK_LABEL).find((d) => isTerminalProcessAlive(d.id)) ?? null
  const supplyDesk = supplyLive
    ? {
        runtime: 'pty' as const,
        handleId: supplyLive.id,
        agentSessionId: supplyLive.agentSessionId ?? null,
      }
    : null
  // DISPLAY presence — from the two facts this GET already holds. See the type's
  // note for why the engine's own ManagerPresence reflex is NOT reused here.
  const managerPresence = managerPresenceForDisplay({
    deskLive: managerDeskFull !== null,
    beatFresh: manager?.fresh === true,
  })
  const engine = store.engines.get(key)
  if (!engine) {
    return {
      ...emptyState(),
      autonomyRemembered: remembered,
      manualStop: stopped,
      manualStopPersisted: stopped,
      overseerRemembered: overseerIntent,
      manager,
      managerDesk,
      managerPresence,
      supplyDesk,
    }
  }
  // Read the Board cards for the lead-time KPI (read-only — never mutates). A
  // board blip just yields an empty lead time this poll; the counter-based rates
  // are unaffected (they don't need the cards).
  let tasks: ProjectTask[] = []
  try {
    tasks = await deps.fetchTasks(projectPath)
  } catch {
    tasks = []
  }
  return {
    ...stateOf(engine, deps.isAlive, tasks, remembered, stopped, overseerIntent),
    manager,
    managerDesk,
    managerPresence,
    supplyDesk,
  }
}

/** The Swarm surface's DRAIN-TICK (POST /api/swarm/orchestrator/drain-tick): return the
 *  engine state. DEFAULT OFF (card eadb25e6 — release blocker): it NO LONGER auto-starts a
 *  stopped engine — the old cf545637 "Swarm pane mounted ⇒ auto-drain" behaviour is
 *  REVERSED, because a pane restored on app launch made the project spin up workers with no
 *  fresh consent. Autonomy is now opt-in (Autonomy ON → startOrchestrator, or the env-gated
 *  global loop). Kept as a SEPARATE endpoint from the read-only {@link getOrchestratorState}
 *  ON PURPOSE — the GET that BOTH the Swarm hook and the display-only Board worker-map poll
 *  must stay IDEMPOTENT. Uses getOrCreateEngine (not store.get) so a never-started project
 *  reads identically to emptyState(). Owner-gated at the route. */
export const drainTickOrchestrator = async (
  projectPath: string,
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  const engine = getOrCreateEngine(key)
  // DEFAULT OFF (card eadb25e6 — release blocker): the drain-tick NO LONGER auto-starts a
  // stopped engine. Merely MOUNTING the Swarm pane — including a pane RESTORED on app launch
  // (App.tsx view-restore) — must NOT spin up workers. The engine store is in-memory, so a
  // relaunch is always a fresh (running:false, manualStop:false) engine; auto-starting off
  // that state is exactly the "launch ⇒ everything runs" bug. Autonomy is STRICT opt-in now:
  // the owner presses "Autonomy ON" (POST /orchestrator/start → startOrchestrator). An
  // already-running engine drives itself via its scheduled chain, so this tick is a pure
  // idempotent state read. (maybeAutoStartDrain still backs the global background loop, which
  // is itself opt-in behind OPENGROUND_SWARM_AUTODRAIN=1.)
  // Same pure read as getOrchestratorState: surface the persisted "stopped by hand"
  // record so the Swarm hook's poll agrees with the GET (this tick answers the same UI).
  return stateOf(engine, deps.isAlive, [], false, await isSwarmManualStopPersisted(key))
}

// ── Auto-drain background loop (card cf545637 — UI-INDEPENDENT server-side tick) ──
// The drain-tick above only fires while the Swarm pane is mounted (useSwarmEngine), so a
// todo added with NO swarm UI open (or none at all — headless) would not drain. This loop
// is the COMPLETE deadlock fix: a slow server-side sweep that auto-starts ANY registered
// project's stopped engine sitting on a todo backlog. It reuses maybeAutoStartDrain's
// cap / manualStop / preflight / twin-dispatch guards verbatim, so it can neither
// over-spawn, override an explicit OFF, nor double-drive an already-running engine.

/** List the registered projects' paths for the background sweep. Reads the registry
 *  (settings.projects); a read fault yields an empty sweep (best-effort). */
const defaultListProjectPaths = async (): Promise<string[]> => {
  const { projects } = await getSettings()
  return (projects ?? []).map((p) => p.path)
}

// ── Boot resume (card 2, docs/ENGINE_PERSISTENCE_PLAN.md §4) ──────────────────

/** The `startedAt` (epoch ms) a RESUMED worker is adopted with — i.e. where its
 *  execution-time budget starts counting. `now - workedMs`, clamped to the real span
 *  since dispatch. Pure (clock injected).
 *
 *  WHY NOT THE ORIGINAL `spawnAt` (the 2026-07-24 must-fix): {@link isRunaway}
 *  measures MAX_EXEC_MS from `startedAt`, and the credits that repay idleness
 *  (`rateLimitHeldMs` / `integrationWaitMs`) are IN-MEMORY — empty after a restart.
 *  Anchoring at the raw spawnAt therefore bills the app's DOWNTIME as execution time:
 *  a worker dispatched at 20:00 that worked 20m before the app was closed overnight
 *  and resumed at 08:00 is "12h20m old" ⇒ 暴走 on its FIRST monitor pass ⇒ worktree
 *  torn down, card parked in blocked. That is a destruction main does not have (main
 *  never resumes, so a surviving `doing` card is simply left alone), which is exactly
 *  what plan §5's "worst case = same as today" forbids.
 *
 *  The clamp keeps BOTH directions honest:
 *   - carrying `workedMs` (card 3's ledger — {@link rosterEntryOf}, wall-clock minus
 *     banked idle) forward means a restart never resets the clock to zero and hands
 *     out an unbounded fresh budget; a worker that has really burned its budget is
 *     still judged 暴走 on the first pass.
 *   - bounding it by the elapsed span since dispatch means a corrupt/inflated ledger
 *     can never claim MORE credit than wall-clock reality; at worst the anchor is the
 *     original spawnAt (never older).
 *   - a 0/absent ledger (a roster row predating card 3) yields `now` — a fresh budget,
 *     the same one the crash reclaim this resume replaces would have given.
 *
 *  The accounting closes on the next syncRoster: rosterEntryOf re-derives
 *  `spawnAt = startedAt` and `workedMs = now2 - budgetFrom - idle` from this very
 *  anchor — and a resumed worker has no `reworkAt`, so its `budgetFrom` IS this
 *  anchor. That is also why the ledger it reads is per-assignment and not lifetime
 *  ({@link rosterEntryOf}'s 2nd must-fix note): the origin can only move once, on the
 *  live side, so whatever the ledger says is what the resumed budget becomes. */
export const resumeStartedAtMs = (entry: RosterEntry, now: number): number => {
  const elapsed = now - (entry.spawnAt || now)
  return now - Math.max(0, Math.min(entry.workedMs, elapsed))
}

/** card 4 (ENGINE_PERSISTENCE_PLAN §5) — turn a boot roster reconcile's
 *  `resumeCandidates` (the in-progress workers whose worktree + card survived the
 *  restart) into LIVE, adopted engine workers by `--resume`-respawning each PROVEN
 *  one. Called by {@link resumeEngines} AFTER reconcile and BEFORE runEnginePass —
 *  and that ORDER is the whole point (b745aeb3 nit#1 / investigation ed1b93af):
 *
 *   - runEnginePass ends with syncRoster(), which write-throughs engine.workers to
 *     roster.json. If engine.workers were still EMPTY there it would clobber the
 *     candidates reconcile just persisted back to `[]` — the resume target would not
 *     survive one tick. Adopting FIRST means the first syncRoster writes the resumed
 *     workers, not an empty set.
 *   - the dispatch pass excludes cards already owned by a worker in engine.workers
 *     (countedIds → selectDispatch). Adopting FIRST is therefore also what stops a
 *     fresh worker being TWIN-spawned onto a card a surviving worktree still owns.
 *
 *  For each candidate: PROVE the transcript is loadable (`prove` — missing / empty /
 *  orphan-fresh mtime ⇒ skip, the card falls to the EXISTING crash reclaim), then
 *  respawn via `deps.spawnWorker` with the RESTART worktree + resumeSessionId (which
 *  routes through the SAME claudeRunPreflight + ensureGuardWiring gates — no new
 *  bypass). On success push an OrchestratorWorker anchored by {@link resumeStartedAtMs}
 *  — at ACCUMULATED WORK, so the runaway clock keeps counting across the restart
 *  instead of resetting to zero (plan §3 — a resumed worker is never handed a fresh
 *  unbounded budget) WITHOUT billing the app's downtime as work. A candidate
 *  with no sessionId, a failed proof, or a thrown spawn is left to crash reclaim
 *  ("worst case = same as today", plan §5). Never throws — one bad candidate never
 *  aborts the others. */
const adoptResumeCandidates = async (
  engine: ProjectEngine,
  reconciled: RosterReconcileResult | void,
  deps: OrchestratorDeps,
  prove: (worktree: string, sessionId: string) => Promise<boolean>,
  now: number,
): Promise<void> => {
  const candidates = reconciled?.resumeCandidates ?? []
  if (!candidates.length) return
  // One tolerant board read for the display titles / remote-control names — the
  // resume prompt (WORKER_RESUME_INJECTION) carries no goal, so a missing title only
  // degrades display, never correctness.
  let titleById = new Map<string, string>()
  try {
    titleById = new Map((await deps.fetchTasks(engine.path)).map((t) => [t.id, t.title ?? '']))
  } catch {
    /* titles stay empty — display-only */
  }
  let resumed = 0
  for (const entry of candidates) {
    // No captured session id ⇒ can't `--resume` (a roster row predating card 3, or a
    // lost id) → leave it to crash reclaim.
    if (!entry.sessionId) continue
    let ok = false
    try {
      ok = await prove(entry.worktree, entry.sessionId)
    } catch {
      ok = false // a proof fault fails-open to fallback
    }
    if (!ok) {
      logLine(
        engine,
        'info',
        `resume declined (transcript unproven) → reclaim: ${shorten(titleById.get(entry.taskId) || entry.branch)}`,
        'routine',
      )
      continue
    }
    const title = titleById.get(entry.taskId) ?? ''
    let spawn: SpawnSwarmWorkerResponse
    try {
      spawn = await deps.spawnWorker({
        projectPath: engine.path,
        title,
        hint: title,
        worktree: entry.worktree,
        resumeSessionId: entry.sessionId,
      })
    } catch (e) {
      // FAIL-FAST FOLLOW-THROUGH (2026-08-13, adversarial review). This catch
      // used to say "the card falls to the existing crash reclaim" — which was
      // false: a non-adopted candidate is never pushed to engine.workers, the
      // orphan-doing anomaly SKIPS it (its worktree still exists), and the
      // first syncRoster wipes its roster row. The card sat in 'doing' forever,
      // silently. In the fallback era this catch was nearly unreachable (spawn
      // degraded to a PTY instead of throwing); SDK-only made it the NORMAL
      // outcome of the exact upgrade scenario this path exists for — an update
      // restart on a machine whose CLI is signed out fails EVERY candidate.
      //
      // So the card goes back to 'todo': the ordinary dispatch path owns the
      // retry, and that path carries the hold ladder + worker-spawn-failed
      // bell + auto-recovery. The committed work stays on the branch (a resume
      // worktree is never rolled back); the fresh dispatch will mint a new
      // branch over the card — the same accepted trade as the quota requeue
      // (recoveryColumn's KNOWN GAP note), and the commander can still adopt
      // the old branch by hand.
      logLine(engine, 'warn', `resume spawn failed → requeue to todo: ${shorten(title || entry.branch)} — ${errMsg(e)}`, 'dispatch')
      try {
        await deps.recoverCard(engine.path, entry.taskId, 'todo')
      } catch {
        /* board write refused — the move-stuck machinery is the surface for that */
      }
      if (e instanceof SdkWorkerUnavailableError) {
        // Machine-level: every later candidate fails the same way. Arm the
        // dispatch hold NOW (bell + backoff — the fill stage would otherwise
        // only learn this on its first spawn attempt) and requeue the rest
        // without burning a spawn per row.
        await holdSdkSpawn(engine, errMsg(e), now)
        for (const rest of candidates.slice(candidates.indexOf(entry) + 1)) {
          if (!rest.sessionId) continue
          logLine(
            engine,
            'warn',
            `resume skipped (SDK unavailable) → requeue to todo: ${shorten(titleById.get(rest.taskId) || rest.branch)}`,
            'dispatch',
          )
          try {
            await deps.recoverCard(engine.path, rest.taskId, 'todo')
          } catch {
            /* same best-effort rule as above */
          }
        }
        break
      }
      continue
    }
    engine.workers.push({
      terminalId: spawn.terminalId,
      branch: spawn.branch,
      worktree: spawn.worktree,
      taskId: entry.taskId,
      taskTitle: title,
      // Anchor the runaway clock at ACCUMULATED WORK — `now - workedMs` — NOT at the
      // original dispatch. See {@link resumeStartedAtMs} for why the difference is a
      // torn-down worktree.
      startedAt: new Date(resumeStartedAtMs(entry, now)).toISOString(),
      stage: 'starting',
      ...(spawn.runtime === 'sdk' ? { runtime: 'sdk' as const } : {}),
      ...(spawn.sdkSessionId ? { sdkSessionId: spawn.sdkSessionId } : {}),
      ...(spawn.model ? { model: spawn.model } : {}),
      ...(spawn.effort ? { effort: spawn.effort } : {}),
      ...(spawn.agentSessionId ? { sessionId: spawn.agentSessionId } : {}),
      reworkCount: entry.reworkCount,
    })
    resumed += 1
    logLine(engine, 'info', `worker resumed (--resume): ${shorten(title || entry.branch)} → ${spawn.branch}`, 'dispatch')
  }
  if (resumed) {
    logLine(engine, 'info', `${resumed} worker(s) resumed across restart (conversation restored)`, 'routine')
  }
}

/**
 * Called ONCE at server boot (server/index.ts): re-hydrate every registered
 * project whose swarm engine was EXPLICITLY running before this restart
 * (`desiredRunning` in that project's `engine.json`, written by
 * {@link startOrchestrator} / {@link stopOrchestrator} / {@link setSelfSupply}).
 * This is the reversal of the "restart ⇒ autonomy always OFF" default
 * documented in 00-INDEX §2.1 — see the plan's §2 for why that default's
 * original justification (an unattended engine could FF main) no longer holds
 * (2026-07-15 manager-only integration closed that path structurally).
 *
 * Guardrails, in order:
 *   1. CRASH-LOOP BREAKER (§4-2) — record this boot in the global ring FIRST
 *      (so even a suppressed boot counts toward the window), then check: if
 *      THIS APP VERSION has booted {@link isCrashLoopTripped}'s threshold+
 *      times within its window, refuse to resume ANY project this boot and
 *      fire ONE fatal notification. A version bump resets the window (a real
 *      release only — an in-app self-update cutover does NOT bump the version
 *      and its restarts DO count, on purpose: a cutover looping is itself a
 *      crash-loop symptom, not something to exempt). {@link recordEngineBoot}
 *      is DELIBERATELY fail-CLOSED (unlike every other write in this card): if
 *      the boot ring itself couldn't be persisted, that is ALSO treated as
 *      tripped — a breaker that can silently stop recording must never degrade
 *      to "never trips" (see its own comment for why this is the one exception
 *      to the plan's fail-open write rule).
 *   2. Per project: `desiredRunning` must be true, AND
 *      {@link isSwarmManualStopPersisted} must be false — the owner's explicit
 *      pause is SUPREMACY over any auto-resume, exactly like every other
 *      manualStop consumer in this file.
 *   3. `claudeRunPreflight()` must pass — a project that can't spawn right now
 *      (claude missing/logged out) just doesn't resume THIS boot; it is not a
 *      fatal condition (the owner can always press ON by hand once fixed).
 * Before any of the above can dispatch, this function also AWAITS the quota
 * cooling table's hydration (`ensureCoolingTableLoaded`) — memoized with
 * server/index.ts's own boot-time kick, so normally a no-op wait — so a
 * resumed project's first post-boot spawn can never race ahead of "which
 * tiers were cooling before the restart" (card cf545637).
 *
 * Overseer note: `intent.overseer` is intentionally NOT read here — see the
 * comment in {@link setOverseer}. Only `desiredRunning` (the drain) and
 * `selfSupply` are honored on resume.
 *
 * Worker resume (cards 3+4): the persisted roster is reconciled against reality
 * (worktree / git / heartbeat / Board — reconcileRoster), and each surviving
 * IN-PROGRESS worker whose transcript is PROVABLY loadable is `--resume`-respawned
 * into the SAME worktree and adopted into engine.workers BEFORE the first pass
 * ({@link adoptResumeCandidates}). Anything that can't be proven — a vanished
 * worktree, a delivered/lost card, a missing/empty/orphan-fresh transcript, a
 * refused spawn — FALLS BACK to the existing crash/reclaim machinery (a resumed
 * engine's monitor pass sees the Board disagreeing with its in-memory worker set
 * and reconciles normally), so a worker is always "worst case = same as today"
 * (plan §5).
 *
 * Every failure mode here is FAIL-QUIET-TO-OFF per project (a corrupt
 * engine.json, a canonicalize throw, a preflight exception) — this function
 * must NEVER throw and NEVER block/crash server boot; a project simply doesn't
 * resume if anything about it can't be read cleanly.
 */
export const resumeEngines = async (
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = defaultDeps(),
  opts?: {
    now?: number
    listProjectPaths?: () => Promise<string[]>
    appVersion?: string
    /** card 3 — the boot roster reconcile, injectable so the freeze test can prove
     *  dispatch waits on it. Defaults to the real {@link reconcileRoster} wired to
     *  `deps`. resumeEngines AWAITS it before kicking runEnginePass — that await IS
     *  the spawn freeze (plan §4-3c). card 4 CONSUMES its `resumeCandidates` (below).
     *  `void` return ⇒ no candidates (card 2/3 injections + the freeze test). */
    reconcileRoster?: (projectPath: string) => Promise<RosterReconcileResult | void>
    /** card 4 (ENGINE_PERSISTENCE_PLAN §5) — the transcript-loadable proof for a
     *  resume candidate, injectable so the resume-wiring test drives the
     *  proven/fallback branches without a real ~/.claude JSONL. Defaults to the
     *  SHARED {@link proveTranscriptLoadable} with the SIGKILL-orphan mtime window
     *  ON. `true` ⇒ `--resume`; `false` ⇒ fall back to crash reclaim. */
    proveResumable?: (worktree: string, sessionId: string) => Promise<boolean>
    /** DI for tests: the supply-desk boot resume (default spawnSwarmSupply).
     *  Injectable so the resume test proves the supplyDesired flag actually
     *  spawns — and that its ABSENCE spawns nothing — without a real claude. */
    spawnSupply?: (o: { projectPath: string }) => Promise<unknown>
    /** DI for tests: the COMMANDER-desk boot resume (default spawnSwarmManager).
     *  Same shape and same reason as {@link spawnSupply}. */
    spawnManager?: (o: { projectPath: string }) => Promise<unknown>
  },
): Promise<{ resumed: string[]; suppressed: boolean }> => {
  const now = opts?.now ?? Date.now()
  const appVersion = opts?.appVersion ?? APP_VERSION
  // card 3 — reconcile-first probe set (built from deps so the module stays
  // decoupled). readHeartbeat → a bare `ready` boolean; a gone/unreadable worktree
  // is `false`. Overridable via opts for the freeze test.
  const reconcile =
    opts?.reconcileRoster ??
    ((projectPath: string): Promise<RosterReconcileResult> => {
      const reconcileDeps: RosterReconcileDeps = {
        fetchTasks: deps.fetchTasks,
        countCommitsAhead: deps.countCommitsAhead,
        heartbeatReady: async (p, branch) =>
          (await deps.readHeartbeat(p, branch).catch(() => null))?.ready === true,
        worktreeExists: rosterWorktreeExists,
      }
      return reconcileRoster(projectPath, reconcileDeps)
    })
  // card 4 — the transcript proof gate for a resume candidate. Default = the shared
  // probe with the SIGKILL-orphan mtime window ON (a transcript touched within it is
  // presumed still-being-written by an orphaned claude, so fall back). Injectable.
  const prove =
    opts?.proveResumable ??
    ((worktree: string, sessionId: string): Promise<boolean> =>
      proveTranscriptLoadable(worktree, sessionId, {
        now,
        orphanWindowMs: ORPHAN_MTIME_WINDOW_MS,
      }).then((p) => p.loadable))
  const { items, persisted } = await recordEngineBoot(appVersion, now)
  if (!persisted) {
    // FAIL-CLOSED (see recordEngineBoot's comment): the breaker's own memory
    // couldn't reach disk, so this boot is treated as tripped — resuming
    // unattended workers while the ONE safety valve against a resume-and-crash
    // loop can't count anything would be exactly backwards.
    await createSwarmFatalNotification({
      event: 'engine-resume-suppressed',
      detail:
        '起動履歴を保存できなかったため(ディスク書き込み失敗)、安全のため swarm の自動再開を見送りました(手動でオンにできます)。',
    }).catch(() => {})
    return { resumed: [], suppressed: true }
  }
  if (isCrashLoopTripped(items, appVersion, now)) {
    const recent = items.filter((r) => r.appVersion === appVersion && now - r.at <= 10 * 60 * 1000)
    await createSwarmFatalNotification({
      event: 'engine-resume-suppressed',
      detail: `同じバージョンで短時間に${recent.length}回起動したため、念のため swarm の自動再開を見送りました。アプリを開き直しただけの場合は問題ありません — 手動でオンにできます。`,
    }).catch(() => {})
    return { resumed: [], suppressed: true }
  }

  // Wait for the quota cooling table to hydrate from disk BEFORE any dispatch
  // can fire (memoized — server/index.ts already kicked this off at boot, so
  // this is normally just awaiting that same in-flight promise, one file read
  // for the whole process). Without this ordering guarantee a resumed
  // project's very first post-boot spawn could race the hydration and land on
  // a tier that was actually cooling before the restart (card cf545637's
  // "burn a session re-learning what was already known" symptom, reopened at
  // exactly the new resume-on-boot path this card adds).
  await ensureCoolingTableLoaded(now)

  const listProjectPaths = opts?.listProjectPaths ?? defaultListProjectPaths
  let paths: string[] = []
  try {
    paths = await listProjectPaths()
  } catch {
    return { resumed: [], suppressed: false }
  }

  const resumed: string[] = []
  for (const projectPath of paths) {
    try {
      const key = await canonicalize(projectPath)
      const intent = await readEngineIntent(projectPath)
      // SUPPLY DESK RESUME (2026-08-03, owner request: 「補給官も毎回再起動から
      // はじまるのでめんどくさい」). Independent of the ENGINE's desiredRunning —
      // the supply desk is the owner's phone window and can be up with autonomy
      // off. spawnSwarmSupply resumes the persisted conversation by default, so
      // the desk comes back with its memory; the flag is set by the spawn route
      // and cleared ONLY by the explicit stop route, so a desk the owner closed
      // stays closed. Fail-quiet: a supply that cannot come back (claude not
      // ready, spawn fault) must never block the engine resume below.
      if (intent.supplyDesired) {
        try {
          const pre = await claudeRunPreflight()
          if (pre.ok) await (opts?.spawnSupply ?? spawnSwarmSupply)({ projectPath })
        } catch {
          /* resume is best-effort; the owner can relaunch from the tab */
        }
      }
      // COMMANDER DESK RESUME (2026-08-26) — the twin of the supply block above,
      // and the fix for the orphaned-commander incident.
      //
      // THE INCIDENT. An OPEN GROUND update restarted the app while a worker was
      // running. Everything came back except the commander: the engine resumed
      // (`desiredRunning`), the worker roster reconciled, the supply desk
      // relaunched — but the commander is a `claude` desk this server owns, so
      // the restart killed it and NOTHING brought it back. `managerPresence`
      // stayed 'missing' with `manager.updatedAt` frozen at 08:58:27Z against a
      // boot at 09:07:58Z, while the orphaned worker ran on and FINISHED. Nobody
      // integrates finished work without a commander, so the board looked like it
      // was moving while the trunk stood still — the worst kind of stop, the kind
      // that looks like progress. A restart is usually an UPDATE, i.e. exactly the
      // moment work is most likely to be in flight.
      //
      // INDEPENDENT of `desiredRunning` (hence: before the continue below), for
      // the same reason supply's is — a commander can be up with autonomy OFF,
      // which is the owner talking to it. It is NOT gated on the manual-stop
      // record either: that record is the ENGINE's pause, and pausing autonomy has
      // never meant closing the desk. The flag's own stop route is the only thing
      // that clears it.
      //
      // CANNOT DUPLICATE A DESK: spawnSwarmManager's singleton guard adopts any
      // live commander in the project instead of launching a second one, so a
      // resume that races anything (a fast owner, a double boot) returns the desk
      // that already exists.
      //
      // ⚠ NOT SILENT when it cannot come back — the deliberate difference from
      // supply, and the 2026-08-04 lesson from the branch below applied here: a
      // supply desk that fails to relaunch is a window the owner will notice is
      // missing, while a commander that fails to relaunch is INVISIBLE and leaves
      // exactly the stall this whole block exists to end. Same event as the three
      // engine-resume branches, once per project per boot.
      if (intent.managerDesired) {
        try {
          const pre = await claudeRunPreflight()
          if (pre.ok) {
            await (opts?.spawnManager ?? spawnSwarmManager)({ projectPath })
          } else {
            await createSwarmFatalNotification({
              event: 'engine-resume-suppressed',
              projectPath,
              detail:
                'claude をすぐに使えなかったため、司令官の卓を復帰できませんでした' +
                `(${pre.body?.error ?? '理由不明'})。worker が動いていても、完了分を統合する司令官がいない状態です — Swarm タブから司令官を立て直してください。`,
            }).catch(() => {})
          }
        } catch (e) {
          await createSwarmFatalNotification({
            event: 'engine-resume-suppressed',
            projectPath,
            detail:
              `司令官の卓を復帰できませんでした(${e instanceof Error ? e.message : String(e)})。` +
              'worker が動いていても、完了分を統合する司令官がいない状態です — Swarm タブから司令官を立て直してください。',
          }).catch(() => {})
        }
      }
      if (!intent.desiredRunning) continue
      if (await isSwarmManualStopPersisted(key)) continue // supremacy — never override an explicit pause
      const pre = await claudeRunPreflight()
      if (!pre.ok) {
        // ⚠ NOT SILENT (2026-08-04, adversarial review). This branch used to
        // `continue` with no notification, no journal line, and no retry — and
        // it is BEFORE getOrCreateEngine, so there was no engine log to write
        // to either. The owner closed the app with autonomy ON, `claude`
        // happened not to be ready for a moment at the next launch (a
        // Finder-launched .app still resolving its login-shell PATH, a re-auth,
        // a CLI upgrade), and the swarm stayed off for the whole session while
        // they believed it was running. The two sibling branches above (disk
        // fault, crash-loop breaker) both raise this same event; this one is
        // the likeliest of the three and was the only mute one.
        // Once per project per boot — the loop visits each path once.
        await createSwarmFatalNotification({
          event: 'engine-resume-suppressed',
          projectPath,
          detail:
            'claude をすぐに使えなかったため、このプロジェクトの swarm 自動再開を見送りました' +
            `(${pre.body?.error ?? '理由不明'})。Swarm タブから手動でオンにできます。`,
        }).catch(() => {})
        continue
      }
      const engine = getOrCreateEngine(key)
      if (engine.running) continue // already running (defensive — fresh boot never hits this)
      engine.manualStop = false
      engine.selfSupply.enabled = intent.selfSupply
      if (intent.selfSupply) engine.selfSupply.lastScanAt = 0
      // Restore the daily budget ALREADY SPENT (see EngineIntent). Without this a
      // restart handed self-supply a fresh cap; the day-key check inside the pass
      // still rolls it over when the UTC day actually changed, so restoring a
      // stale key is harmless.
      if (intent.selfSupplyDayKey) engine.selfSupply.dayKey = intent.selfSupplyDayKey
      if (typeof intent.selfSupplyDayCount === 'number') {
        engine.selfSupply.dayCount = intent.selfSupplyDayCount
      }
      // SEED THE REVIEW DWELL CLOCK (2026-08-14) — the whole point of persisting it.
      // Without this every restart re-stamped each waiting branch as "arrived just now",
      // so the 40-minute stall window restarted from zero on every launch: three releases
      // in one day rewound it three times and a commander that had stopped integrating
      // was never once judged stalled (nor, therefore, was the owner told). Deliberately
      // HERE and not in startOrchestrator: this path is "the engine was meant to be
      // running the whole time, bring it back", so the wait genuinely continued across
      // the restart; an explicit owner ON is the opposite claim and still clears the
      // clock on purpose (time the engine was OFF is not 統合待ち).
      //
      // Fail-open by construction: readEngineIntent already degraded an absent/torn/
      // hand-edited field to `undefined`, which lands here as "no clock" — i.e. exactly
      // today's behaviour. This can only ever make the engine notice a stall SOONER.
      // A stale entry for a branch that has since left review is pruned by the first
      // pass's own `present` sweep, so a long-dead branch cannot hold the clock back.
      if (intent.reviewWaitingSince) {
        const seeded = new Map(Object.entries(intent.reviewWaitingSince))
        engine.reviewSeenAt = seeded
        // Record the mirror as already-current so the first pass writes only if the set
        // actually changed (it usually has — the sweep prunes what drained while off).
        engine.reviewSeenPersisted = reviewWaitingSignature(seeded)
      }
      engine.running = true
      // card 2b — mark this as a RESTORED engine (not an owner ON this session), so
      // the Swarm UI can say so. Card 2 made the old `!running` restart reminder
      // unreachable for a resumed project; this is what puts the fact back on screen.
      // Display only — nothing in the engine branches on it. Either power-switch
      // action clears it.
      engine.autonomyResumed = true
      engine.lastIntegrateAt = 0
      // card 3 — RECONCILE-FIRST, SPAWN FROZEN (plan §4-3c): classify the persisted
      // roster against reality (worktree / git / heartbeat / Board) and prune it
      // BEFORE runEnginePass is kicked. The `await` is the freeze — the dispatch
      // pass (the only thing that spawns) cannot start until reconcile resolves, so
      // a resumed project never races a fresh worker onto a card a surviving
      // worktree still owns. Never throws (condition ④: a corrupt roster degrades to
      // "no roster memory" and the boot proceeds).
      const reconciled = await reconcile(key)
      // From here this engine's in-memory roster IS the reconciled truth, so
      // syncRoster may overwrite the file wholesale (including with an empty set).
      engine.rosterReconciled = true
      // RE-READ THE OWNER'S STOP SWITCH (2026-07-29). The checks at the top of
      // this iteration — manual-stop, preflight — were taken BEFORE the reconcile,
      // and the reconcile is not instant: it stats worktrees, shells out to git per
      // entry, and reads the Board over loopback. Seconds to minutes. An owner who
      // opens the app and immediately switches 自動運転 OFF lands inside that window,
      // and this loop went on to adopt-and-respawn `claude` PTYs into an engine the
      // owner had just stopped. Worse than merely ignoring the switch: `scheduleNext`
      // DOES honour `running`, so the chain never starts — the freshly spawned
      // workers run with NOBODY monitoring them (no stall detection, no runaway
      // clock, no reclaim). Checking again here costs one file read.
      if (await isSwarmManualStopPersisted(key)) {
        engine.running = false
        engine.generation += 1 // any in-flight scheduleNext from this boot is void
        logLine(engine, 'info', 'boot resume aborted — owner stopped autonomy during reconcile')
        continue
      }
      // card 4 — ADOPT the surviving in-progress workers: `--resume`-respawn each
      // PROVEN one into engine.workers BEFORE runEnginePass is kicked. This ordering
      // is load-bearing (see adoptResumeCandidates' header): the pass ends with
      // syncRoster, which would otherwise write an EMPTY engine.workers over the
      // roster reconcile just persisted; and the pass's dispatch would twin-spawn a
      // still-live worker's card unless that card is already counted (its worker in
      // engine.workers). Awaited ⇒ this adoption is inside the spawn freeze too.
      await adoptResumeCandidates(engine, reconciled, deps, prove, now)
      const gen = (engine.generation += 1)
      logLine(engine, 'info', `engine resumed at boot (v${appVersion})`)
      void runEnginePass(engine, deps)
        .catch(() => {})
        .finally(() => scheduleNext(engine, deps, gen))
      resumed.push(key)
    } catch {
      // fail-quiet-to-OFF — this project's engine just doesn't resume; server
      // boot (and every OTHER project's resume) must never be affected.
    }
  }

  if (resumed.length) {
    await createSwarmInfoNotification({
      event: 'engine-resumed',
      detail: `再起動後、${resumed.length}件のプロジェクトで自動運転を再開しました。`,
    }).catch(() => {})
  }
  return { resumed, suppressed: false }
}

/** ONE server-side AUTO-DRAIN sweep: walk the registered projects and
 *  {@link maybeAutoStartDrain} each, so a todo backlog drains on an idle slot even with NO
 *  UI open. An already-running engine is driven by its own chain and is a fast no-op here
 *  (the running guard fires BEFORE any board read); a manually-paused one (manualStop) is
 *  respected; the per-project cap bounds parallelism; a not-ready `claude` is skipped
 *  (preflight) so a missing CLI can't spin a retry storm across every project. Best-effort
 *  per project — one vanished / locked path never aborts the rest of the sweep; never
 *  throws. Returns how many engines it auto-started this sweep. `listProjectPaths` + `deps`
 *  are injected for hermetic tests (no real registry, no real spawn). */
export const runAutoDrainScan = async (
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = defaultDeps(),
  listProjectPaths: () => Promise<string[]> = defaultListProjectPaths,
  now: number = Date.now(),
): Promise<number> => {
  let paths: string[]
  try {
    paths = await listProjectPaths()
  } catch {
    return 0 // a registry read blip — nothing to sweep this round
  }
  let started = 0
  for (const path of paths) {
    try {
      const engine = getOrCreateEngine(await canonicalize(path))
      if (await maybeAutoStartDrain(engine, deps, now)) started += 1
    } catch {
      /* best-effort — a vanished / locked project never aborts the rest of the sweep */
    }
  }
  return started
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_swarm_autodrain_timer: ReturnType<typeof setInterval> | null | undefined
}

/** Whether the UI-INDEPENDENT boot-time auto-drain loop ({@link startAutoDrainLoop})
 *  may arm. **STRICT OPT-IN — default OFF** (release blocker eadb25e6): merely
 *  launching the app must NEVER auto-spawn workers across every registered project.
 *  ONLY an explicit `OPENGROUND_SWARM_AUTODRAIN=1` enables the global loop; unset /
 *  '0' / 'true' / anything-but-'1' ⇒ false ⇒ a fresh install or a plain relaunch
 *  stays completely idle until the owner turns a SINGLE project's drain on from the
 *  Swarm UI. This is the one process-wide, role-INDEPENDENT spawn switch, so the gate
 *  is a pure exported predicate with a regression test pinning "unset ⇒ off" (the
 *  single line whose default protects every non-owner user). server/index.ts is the
 *  only caller. */
export const bootAutoDrainEnabled = (
  env: NodeJS.ProcessEnv = process.env,
): boolean => env.OPENGROUND_SWARM_AUTODRAIN === '1'

/** Start the UI-INDEPENDENT auto-drain background loop: a slow sweep
 *  ({@link runAutoDrainScan}) every {@link AUTO_DRAIN_SCAN_MS} so a todo backlog drains
 *  with NO UI open. Wired ONCE at server boot (server/index.ts), so it NEVER runs in unit
 *  tests (which mount the Hono app, not the entry). Idempotent + reload-safe: the timer
 *  lives on globalThis, and a re-eval (tsx watch) CLEARS the old one before arming a fresh
 *  closure rather than stacking a second loop. `unref`'d so the loop alone never keeps the
 *  process alive (the HTTP listener already does). The first sweep is one interval AFTER
 *  boot, so the server is already listening for the loopback board reads. */
export const startAutoDrainLoop = (
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = defaultDeps(),
  intervalMs: number = AUTO_DRAIN_SCAN_MS,
): void => {
  if (globalThis.__openground_swarm_autodrain_timer) {
    clearInterval(globalThis.__openground_swarm_autodrain_timer)
  }
  const timer = setInterval(() => {
    void runAutoDrainScan(deps).catch(() => {})
  }, intervalMs)
  // Don't let the sweep loop alone hold the process open (the HTTP listener already does).
  ;(timer as { unref?: () => void }).unref?.()
  globalThis.__openground_swarm_autodrain_timer = timer
}

/** Stop the auto-drain background loop (shutdown / test cleanup). Idempotent. */
export const stopAutoDrainLoop = (): void => {
  if (globalThis.__openground_swarm_autodrain_timer) {
    clearInterval(globalThis.__openground_swarm_autodrain_timer)
    globalThis.__openground_swarm_autodrain_timer = null
  }
}

// (setAutoMerge — the separate auto-wake-the-commander toggle — was RETIRED
// 2026-07-16: the wake reflex is always armed while the engine runs. See the
// Part-B comment in runIntegratePass.)

/** Arm / disarm SELF-SUPPLY (card b3fbbfba), idempotent. The owner-gated switch
 *  for the engine proposing its OWN improvement cards. A SEPARATE switch from the
 *  drain (start/stop) — default OFF, in-memory only (a restart re-arms OFF,
 *  fail-safe). It only takes effect while the engine is `running`; arming it
 *  zeroes the scan throttle so the next tick scans promptly. Proposed cards are
 *  STILL owner-approval-gated before any dispatch — arming this only lets the
 *  engine FILL todo, never auto-run what it proposed. */
export const setSelfSupply = async (
  projectPath: string,
  enabled: boolean,
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  const engine = getOrCreateEngine(key)
  if (engine.selfSupply.enabled !== enabled) {
    engine.selfSupply.enabled = enabled
    logLine(engine, 'info', enabled ? 'self-supply ON' : 'self-supply OFF')
    if (enabled) engine.selfSupply.lastScanAt = 0 // scan on the next tick
    // card 2 — write-through so a restart's resumeEngines() re-arms self-supply
    // alongside the drain (plan §2: proposed cards stay owner-approval-gated
    // before any dispatch, so re-arming the SCAN is low-risk). PATCH only this
    // field (not a full persistEngineIntent derived from engine.running) — a
    // toggle can fire while `running` is false for a reason that has nothing to
    // do with the owner's desiredRunning intent (a suppressed boot resume, a
    // preflight failure this session), and a full write would silently stamp
    // that unrelated false over a `desiredRunning:true` the owner never touched.
    await patchEngineIntent(projectPath, { selfSupply: enabled })
  }
  return stateOf(engine, deps.isAlive)
}

/** Arm / disarm the OVERSEER (EPIC C / C-core), idempotent — the owner-gated THIRD
 *  toggle (D1). SEPARATE from the drain (start/stop) and selfSupply;
 *  default OFF, in-memory ONLY (a restart re-arms OFF — K2). It only ACTS while the
 *  engine is `running` (the brainstem is a stage of the running tick). Unlike the
 *  other switches, an explicit autonomy OFF (stopOrchestrator) CLEARS it — so it is
 *  the one toggle the owner must re-arm every session (never auto-resumed, no
 *  persisted reminder — D1). Disarming aborts any brain in flight. */
export const setOverseer = async (
  projectPath: string,
  enabled: boolean,
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  const engine = getOrCreateEngine(key)
  // ARMING requires a RUNNING engine (§5:243 "autonomy ON 中の engine にのみ有効").
  // Refusing here — not merely dimming the UI — is what STRUCTURALLY closes the D1/K1
  // gap: without it an owner could arm a fresh STOPPED engine, and a later auto-drain
  // re-ignition (maybeAutoStartDrain, opt-in) would activate that pre-armed overseer on
  // the next tick — the overseer riding a machine-driven restart, exactly the asymmetry
  // D1 forbids. With this gate `enabled` can only become true WHILE running, and both an
  // explicit autonomy OFF (stopOrchestrator) and a restart drop it — so an auto-drain
  // can never find a pre-armed engine. DISARMING (enabled:false) is always allowed.
  if (enabled && !engine.running) {
    logLine(engine, 'warn', 'overseer arm ignored — autonomy is OFF (turn the engine ON first)')
    // The arm was REFUSED, so the persisted reminder is untouched — report it as it
    // still stands on disk (card 2b) instead of blanking the restore banner on a
    // refusal. Fail-quiet: an unreadable engine.json just means no banner.
    return stateOf(engine, deps.isAlive, [], false, false, (await readEngineIntent(projectPath)).overseer)
  }
  if (engine.overseer.enabled !== enabled) {
    engine.overseer.enabled = enabled
    logLine(engine, 'info', enabled ? 'overseer ON' : 'overseer OFF')
    if (!enabled) engine.overseer.brainAbort?.abort() // stop a brain mid-flight
    // card 2 — written to engine.json for observability/schema completeness, but
    // resumeEngines() deliberately does NOT read this field back to auto-arm the
    // overseer (see resumeEngines' comment): the D1 gate above ("must be armed
    // WHILE running, never by a machine-driven restart") is an explicit safety
    // invariant this session chose to KEEP rather than override — the plan
    // (docs/ENGINE_PERSISTENCE_PLAN.md §2) flags overseer auto-resume as an
    // OPEN [hold] question for the owner, not a settled default. If the owner
    // decides otherwise, wiring resumeEngines to also honor this field is a
    // small follow-up, not a redesign. PATCH only this field — see setSelfSupply's
    // comment for why a full engine.running-derived write would be wrong here too
    // (this gate requires engine.running to ARM, but DISARM is always allowed and
    // can equally fire while running is false for an unrelated reason).
    await patchEngineIntent(projectPath, { overseer: enabled })
  }
  // overseerRemembered mirrors what the disk now says. Reported unconditionally (not
  // only inside the `changed` branch): an IDEMPOTENT arm still leaves a true record,
  // and an idempotent disarm still leaves a false one.
  return stateOf(engine, deps.isAlive, [], false, false, enabled)
}

/** card 2b — DISMISS the overseer restore reminder: forget the persisted
 *  `overseer:true` in this project's engine.json, WITHOUT touching any arm state.
 *  The [×] on the one-click restore banner (OVERSEER_DESIGN.md:161's visible
 *  surface) — "I saw it, don't ask again".
 *
 *  WHY THIS IS ITS OWN ACTION and not `setOverseer(path, false)` — the d1d6d704
 *  MUST-FIX, verbatim, one toggle over: while the banner is up the overseer is by
 *  definition NOT armed (`engine.overseer.enabled === false`), so setOverseer(false)
 *  would find `enabled !== enabled` FALSE, skip its whole body — including the
 *  `patchEngineIntent` — and change nothing at all. The disk would still say
 *  `overseer:true`, the next poll would re-surface the banner, and [×] would be a
 *  no-op the owner could press forever. This function writes the field directly, so
 *  the dismissal is a real, observable state change.
 *
 *  Deliberately does NOT touch: `engine.overseer.enabled` (already false — and
 *  disarming is not what [×] means), `desiredRunning` / `selfSupply` (patch touches
 *  only its own field — a running engine must keep running when the owner declines
 *  a banner), and the arm CONDITIONS (this card adds a display, never a new way in).
 *  Idempotent and safe with no in-memory engine (the common post-restart case):
 *  the write path is disk-only. FAIL-OPEN like every other intent write. */
export const dismissOverseerReminder = async (
  projectPath: string,
  deps: OrchestratorDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  await patchEngineIntent(projectPath, { overseer: false })
  const engine = store.engines.get(key)
  // No engine this session (right after a restart — the case the banner exists for):
  // report the same shape getOrchestratorState would, minus the reminder just cleared.
  if (!engine) {
    const stopped = await isSwarmManualStopPersisted(key)
    return {
      ...emptyState(),
      autonomyRemembered: await isSwarmAutonomyRemembered(key),
      manualStop: stopped,
      manualStopPersisted: stopped,
    }
  }
  logLine(engine, 'info', 'overseer restore reminder dismissed by owner')
  return stateOf(engine, deps.isAlive, [], false, false, false)
}

// ── Test seam ────────────────────────────────────────────────────────────────

/** Drop all engine state — for hermetic route/engine tests (mirrors
 *  __resetMigrationCacheForTests). Cancels any pending timers first. */
export const __resetOrchestratorForTests = (): void => {
  store.engines.forEach((e) => {
    if (e.timer) clearTimeout(e.timer)
    // STOP the engine before dropping it from the map — otherwise a fire-and-forget
    // runEnginePass still IN FLIGHT when a test ends re-arms scheduleNext in its
    // `.finally` (the closure holds this same engine object, whose `running` stays
    // true and whose `generation` still matches), leaving a self-perpetuating tick
    // timer that is no longer in `store.engines` for any later reset to clear. Those
    // zombie chains fire runEnginePass every TICK_MS for the rest of the vitest
    // worker's life, congesting the event loop of every SUBSEQUENT test (which made
    // the reconcile-first freeze test's timing flaky — 2026-07-23). Flipping
    // `running` false AND bumping `generation` makes that trailing scheduleNext a
    // no-op (it guards on both), so the chain dies after its current in-flight pass.
    e.running = false
    e.generation += 1
  })
  store.engines.clear()
}

/** Seed an engine directly into the store, keyed by its own `path` — for hermetic
 *  control-plane tests (stopOrchestratorWorker) that need a populated engine
 *  without driving the real start chain (claude preflight + spawn). The caller
 *  sets `path` to a canonicalized key so the lookup (canonicalize(projectPath))
 *  hits it. Test-only. */
export const __seedEngineForTests = (engine: ProjectEngine): void => {
  store.engines.set(engine.path, engine)
}
