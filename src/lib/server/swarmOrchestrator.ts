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
import { readFile, stat, lstat, symlink, unlink, mkdir } from 'fs/promises'
import { join, resolve, dirname, basename } from 'path'
import { createHash, randomUUID } from 'crypto'
import { canonicalize } from './canonicalize'
import { atomicWriteJson } from './atomicWrite'
// The fork-pool group reaper. It lives in a leaf module (not here) because
// swarmSelfSupply — which this module imports — needs the same reaper for its
// vitest/eslint scanners, and a back-import would close a cycle. Re-exported
// below so existing importers of `runGateProcess` keep their path.
import { runGateProcess } from './gateProcess'
import { openGroundHome } from './paths'
import { getTerminal, getTerminalScreen, killTerminal, subscribeTerminal, writeInput } from './terminal'
import { claudeRunPreflight } from './claudePreflight'
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
import { removeClaudeFolderTrust } from './claudeTrust'
import { SWARM_LAUNCH_MODEL, execModeMaxWorkers, resolveAvailableTierProbed } from './swarmLaunch'
// The limit-wording detector, extracted to swarmRateLimitText.ts (2026-07-13) so
// the pre-launch tier probe shares it — see the re-export further down.
import { normalizeScreen, matchesRateLimit, endsInRateLimit } from './swarmRateLimitText'
// [Quota] the engine is BOTH sides of the quota loop now: the rate-limit
// sighting in monitorWorkers is the swarm's SENSOR (markRateLimited — the one
// production write into the cooling table, attributing the sighting to the tier
// the worker launched on), and runDispatchPass / the reviewer panel are the
// ACTUATORS (the spawnBlock park gate). MODEL_TIER_LADDER narrows the recorded
// launch model to a known tier; an off-ladder / unrecorded model holds the
// worker exactly as before but marks nothing (never poison a tier by guess).
import { markRateLimited, isModelTier, MODEL_TIER_LADDER } from './swarmQuota'
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
} from './swarmWorker'
import { centralWorktreesDir } from './paths'
import { projectUUIDFromPath } from './projectDataPath'
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
import { detectFreeTextQuestion } from './swarmQuestions'
import {
  defaultReceiptKey,
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
  SwarmOrchestratorState,
  SwarmFatalNotification,
} from '../types'
import { createSwarmFatalNotification, createSwarmInfoNotification } from './swarmNotifications'
// Manager-only integration (2026-07-15): the engine no longer merges — it WAKES the
// commander when a worker is ready. These are the seams the default wake dep uses.
import { spawnSwarmManager } from './swarmManager'
import { readSwarmSessions } from './swarmSessions'
import { isClaudeSessionLive } from './terminal'
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
 *  回直すチャンス、3 度目の must-fix で blocked + 'rework-exhausted' anomaly)。差し戻し
 *  自体は autoMerge が armed のときだけ起きる(統合パスの問題分岐に乗るため)— OFF 時は
 *  従来どおり read-only classify のみで、カードは review に留まる。 */
export const MAX_REWORKS = 2

/** 統合 conflict → worker rebase 委譲 の往復上限(card 012a2848)。統合時に rebase 競合した
 *  カードを「自分のブランチを rebase して解消しろ」と worker へ差し戻してよい回数。司令塔が
 *  手でやっている "conflict は担当 worker に rebase 委譲" の自動化で、{@link MAX_REWORKS}
 *  (verify/レビュー差し戻し)とは別カウンタ — conflict は worker のコード品質ではなく「trunk が
 *  動いた」結果なので独立予算で数え、混ぜて早すぎる park を招かない。これを超えたら 'blocked'
 *  へ退避(conflict stamp を残す)、worker が解けない競合を無限に投げ返すループを断つ。conflict は
 *  trunk の動き次第で複数回起こりうるので既定は MAX_REWORKS より気持ち多めの 3。委譲自体は
 *  autoMerge が armed のとき(統合パス)だけ起きる — OFF 時は read-only classify のみで不変。 */
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
 *  IT COUNTS *WORKING* TIME, NOT RAW WALL-CLOCK: the time a worker sat frozen on
 *  a rate-limit hold is CREDITED BACK (engine.rateLimitHeldMs — see
 *  {@link rateLimitHoldCredit} / {@link isRunaway}). It used to count wall-clock
 *  INCLUDING quota waits, on the assumption that "the band is wide enough" — and
 *  on 2026-07-12 that assumption broke in the field: a worker waited 20m on a
 *  limit, then worked 84m (104m wall-clock), was judged runaway at 90m, and was
 *  torn down with 15 uncommitted files (47KB) still in its worktree. A quota wait
 *  is not the worker's doing and must not spend its budget. (The other half of
 *  that fix is {@link commitWipBeforeTeardown} — no reclaim, for ANY reason, may
 *  destroy uncommitted work again.) */
export const MAX_EXEC_MS = envMinutesMs('OPENGROUND_SWARM_MAX_EXEC_MIN', 90, 10, 600)

/** CEILING on the rate-limit credit one worker may subtract from its execution
 *  clock. Without it, a worker cycling limit → work → limit → … could defer the
 *  runaway check forever and the 暴走 defense would have no teeth at all. With it,
 *  a worker's ABSOLUTE wall-clock lifetime is bounded by MAX_EXEC_MS + this (180m
 *  at the defaults) however long it spent waiting — the runaway ceiling stays a
 *  real ceiling while an honest quota wait is still forgiven. Tied to MAX_EXEC_MS
 *  on purpose (one knob to retune, not two). */
export const HOLD_CREDIT_CAP_MS = MAX_EXEC_MS

/** RATE-LIMIT GRACE — how long a worker WAITING on a usage / quota / overload
 *  limit is HELD before its card is requeued to 'todo' (slot recovery). A
 *  rate-limited worker is NOT a stall: Enter won't lift the limit and reclaiming
 *  it throws away committed work + re-dispatches into the SAME wall, so the
 *  engine never nudges it and never reclaims it on the (much shorter) silence
 *  clock. It just waits — the worker's own `claude` resumes when the limit
 *  resets. Only if it is STILL limited this long does the engine free the slot
 *  and requeue (the work already on its branch is preserved; a later attempt
 *  retries once the limit has cleared). Kept under STALE_HEARTBEAT_MS so a
 *  legitimately-waiting worker is requeued before it would be mislabelled
 *  "hung". Adjustable via env. */
export const RATE_LIMIT_GRACE_MS = Math.min(
  envMinutesMs('OPENGROUND_SWARM_RATE_LIMIT_GRACE_MIN', 20, 2, 360),
  // CLAMP strictly under the runaway ceiling so a transient waiter is requeued
  // ('todo') before the runaway path could ever park it ('blocked') — robust even
  // if an operator inverts the two env knobs (the reviewer's band-inversion footgun).
  MAX_EXEC_MS - 60_000,
)

/** QUOTA-DETECTION FAST PATH (the 21-minute detection lag, 2026-07-09): three
 *  workers hit "You've reached your Fable 5 limit." FOUR SECONDS after spawn, yet
 *  the tier only cooled 21m30s later — the sighting sat behind (a) the 10-min
 *  silence gate (built for HUNG workers, blind to instantly-rejected ones) and
 *  (b) lastOutputAt counting a decorative TUI repaint (a "Plugin updated" toast)
 *  as activity, pushing the gate back 6m40s per repaint. The three constants
 *  below drive the fix in monitorWorkers: sample the screen after a SHORT output
 *  lull, track how long a rate-limit notice has HELD the screen in real time
 *  (engine.limitScreen), clamp the stall clock to that onset so chrome repaints
 *  can't reset it, and confirm an at-spawn rejection without waiting the full
 *  stall gate. */

/** How long the PTY output must lull before the monitor samples a worker's
 *  screen for a rate-limit notice. Far under STALL_SILENCE_MS — the whole point
 *  — but long enough that a BUSY worker (output streaming) is never scraped
 *  each pass (the per-pass-TUI-scrape cost the silence gate was protecting
 *  against). A worker whose screen is already being tracked (engine.limitScreen
 *  / engine.rateLimited) is re-sampled every pass regardless, so a lifted limit
 *  is noticed promptly. */
export const RATE_LIMIT_SCRAPE_QUIET_MS = 45_000

/** How soon after dispatch a rate-limit notice must FIRST be sighted for the
 *  early confirmation below to apply — "the worker walked into the wall at
 *  spawn". An instantly-rejected worker shows the notice within seconds (plus
 *  one scrape-quiet window before the monitor samples); a worker that did real
 *  work first shows it minutes later and takes the ordinary (clamped) stall
 *  gate instead. This onset window is what keeps the early path away from a
 *  worker merely EDITING rate-limit wording (this very file's fixtures): that
 *  happens deep into a session, never in the first two minutes. */
export const RATE_LIMIT_EARLY_ONSET_MS = 2 * 60_000

/** How long the at-spawn notice must HOLD the screen before the early path
 *  confirms rate-limited (with zero commits and no heartbeat since the notice).
 *  Short — the card's contract is sighting-to-cooling under two minutes
 *  (scrape-quiet + this + a tick ≈ 95s) — but enough that one transient frame
 *  (a flash mid-boot) never cools a healthy tier. */
export const RATE_LIMIT_EARLY_CONFIRM_MS = 45_000

/** PERMISSION-WAIT GRACE — how long after auto-accepting a startup permission /
 *  trust prompt the engine waits for the worker to move on before parking it in
 *  'blocked'. Workers launch with permissionMode:'bypass'
 *  (--dangerously-skip-permissions), so a prompt should NEVER appear; this is the
 *  backstop for when one slips through anyway (a `claude` that ignored bypass, an
 *  unexpected first-run dialog). Short — once Enter accepts the (default-Yes)
 *  trust dialog the worker proceeds within seconds; still stuck after this means
 *  bypass is genuinely broken and a human is needed. */
export const PERMISSION_WAIT_GRACE_MS = 2 * 60_000

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
  return {
    leadTime: computeLeadTimeStats(input.tasks, input.log),
    conflictRate: ratio(c.conflicted, c.integrated + c.conflicted),
    reworkRate: ratio(c.reworked, c.reworked + c.integrated),
    workerSuccessRate: ratio(c.integrated, c.dispatched),
    counts: {
      dispatched: c.dispatched,
      integrated: c.integrated,
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
  /** The worker's heartbeat sign, or null if it never wrote one. */
  heartbeat: HeartbeatSign | null
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
 *  'runaway' = blew the execution-time ceiling; 'rate-limit' = waited on a
 *  usage/quota limit past its grace; 'permission' = a startup prompt bypass
 *  couldn't clear. (Card 4880e9c6.) */
export type WorkerRecoveryReason = 'crash' | 'stall' | 'runaway' | 'rate-limit' | 'permission' | 'question'

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
 *    • 'runaway' / 'permission' ⇒ 'blocked' — a human is needed: a task that blows
 *      the time ceiling would just overrun again on retry, and a prompt bypass
 *      can't clear means the environment is wrong. Park, don't loop.
 *  Otherwise (crash / stall — a possibly-transient failure) the heartbeat + retry
 *  budget decide, exactly as before:
 *    • heartbeat `ready` ⇒ 'blocked' — it DECLARED itself done yet has nothing
 *      integrable; re-running a finished task is wrong, a human checks why.
 *    • heartbeat `blocked` ⇒ 'blocked' — it reported a real blocker; a human
 *      unblocks it (auto-retry would just hit the same wall).
 *    • retry budget spent (`requeues >= maxRequeues`) ⇒ 'blocked' — a card that
 *      reliably kills its worker escalates instead of spinning forever.
 *    • otherwise (a BARE crash/kill: dead, no completion/blocker sign, budget
 *      left) ⇒ 'todo' — a transient failure gets one more autonomous attempt.
 *  Pure (no IO, no clock). */
export const recoveryColumn = (
  probe: WorkerProbe,
  requeues: number,
  maxRequeues: number,
  reason: WorkerRecoveryReason = 'crash',
): 'todo' | 'blocked' => {
  if (reason === 'rate-limit') return 'todo'
  if (reason === 'runaway' || reason === 'permission' || reason === 'question') return 'blocked'
  if (probe.heartbeat?.ready === true) return 'blocked'
  if (probe.heartbeat?.blocked === true) return 'blocked'
  if (requeues >= maxRequeues) return 'blocked'
  return 'todo'
}

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
}): number => {
  const cands: number[] = []
  const hb = a.heartbeatAt ? Date.parse(a.heartbeatAt) : Number.NaN
  if (Number.isFinite(hb)) cands.push(hb)
  if (typeof a.lastOutputAt === 'number' && Number.isFinite(a.lastOutputAt)) cands.push(a.lastOutputAt)
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
  const activity = Math.max(
    input.heartbeatAtMs ?? Number.NEGATIVE_INFINITY,
    realOutput ?? Number.NEGATIVE_INFINITY,
    input.startedAtMs,
  )
  const silentMs = Math.max(0, now - activity)
  // Real recovery since the nudge/escalate — a fresh heartbeat OR real
  // (post-echo-guard) output strictly after it. Either clears the budget; an echo
  // can fake neither.
  const progressed =
    count > 0 &&
    ((input.heartbeatAtMs !== null && input.heartbeatAtMs > lastNudgeAt) ||
      (realOutput !== null && realOutput > lastNudgeAt))

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


/** Markers of a permission / trust prompt blocking a worker. DELIBERATELY NARROW
 *  — only `claude`'s literal directory-trust dialog phrasing, which a worker's
 *  ordinary output (planning lists like "1. Yes, proceed…", a "press Enter to
 *  continue" aside, or source/diff text) does NOT reproduce verbatim. The earlier
 *  loose option-line / "press enter" patterns matched normal claude output and
 *  were dropped (they risked the exact false KILL this card forbids). Consulted
 *  only for an already-SILENT worker (see the monitor), so even this exact phrase
 *  appearing in code is harmless: a streaming worker is never classified. */
export const PERMISSION_PROMPT_PATTERNS: readonly RegExp[] = [
  /do you trust the files in this (?:folder|directory)/,
  /do you want to (?:proceed|trust|allow) .{0,40}\?/, // claude's trust/allow confirmation line
]

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

/** Classify a worker's current screen into WHY it might not be progressing:
 *    • 'permission-wait' — a startup trust/permission dialog is blocking it.
 *    • 'rate-limited'    — it is waiting on a usage/quota/overload limit.
 *    • 'question'        — claude asked a FREE-TEXT question and idles at an
 *                          empty input box awaiting the owner (C3; detector in
 *                          swarmQuestions.ts — menu frames stay the permission
 *                          arm's business, so this can never shadow them).
 *    • 'normal'          — none of those; ordinary work (the silence-based
 *                          stall path then applies if it has also gone quiet).
 *  Permission is checked first: at boot it blocks ALL progress and is the more
 *  urgent unblock. The question check runs LAST so both existing arms keep
 *  exactly their pre-C3 precedence, and on the RAW screen (its signature is
 *  row-structural — normalizeScreen would flatten it away). PURE (the only
 *  input is the text) — the TIMING gates (startup window, grace clocks) live
 *  in the monitor, so this stays trivially testable.
 *  A null/empty screen ⇒ 'normal' (no signal — never invent a wait). */
export const classifyOutput = (
  screen: string | null,
): 'rate-limited' | 'permission-wait' | 'question' | 'normal' => {
  if (!screen) return 'normal'
  const text = normalizeScreen(screen)
  if (!text) return 'normal'
  if (PERMISSION_PROMPT_PATTERNS.some((re) => re.test(text))) return 'permission-wait'
  if (matchesRateLimit(text)) return 'rate-limited'
  if (detectFreeTextQuestion(screen)) return 'question'
  return 'normal'
}

/** Has a worker blown the hard execution ceiling — a 暴走 to stop? Judged on its
 *  WORKING time: wall-clock since dispatch MINUS `heldMs`, the time it sat frozen
 *  on a rate-limit hold (see {@link rateLimitHoldCredit}). A quota wait is not
 *  work and must never spend the worker's budget — the 2026-07-12 loss (20m of
 *  limit + 84m of real work = 104m ⇒ reclaimed at the 90m ceiling, taking 15
 *  uncommitted files with it) is exactly what this subtraction closes.
 *
 *  True iff its dispatch time is known (finite, > 0) and `maxExecMs` of WORKING
 *  time has elapsed. The finite/positive guard is load-bearing: a worker with an
 *  unparseable / missing startedAt is NEVER judged runaway (no false kill on a
 *  clockless fixture). `heldMs` defaults to 0 — a worker that never waited on a
 *  limit is judged byte-for-byte as before — and a negative / non-finite credit
 *  is floored to 0 (a corrupt ledger can only ever make the check STRICTER, never
 *  grant infinite life). Pure (clock injected). */
export const isRunaway = (
  startedAtMs: number,
  now: number,
  maxExecMs: number,
  heldMs = 0,
): boolean => {
  const credit = Number.isFinite(heldMs) ? Math.max(0, heldMs) : 0
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
  intent: 'review' | 'done' | 'recover'
  attempts: number
  branch: string
  taskTitle: string
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
  /** AUTO-WAKE-THE-COMMANDER armed (Card③) — a SEPARATE switch from `running`,
   *  default OFF. Only ever acts while `running` (turning the engine off = global
   *  stop).
   *
   *  MEANING CHANGED 2026-07-15 (manager-only integration): this flag NO LONGER
   *  makes the engine merge. The engine never verifies / lens-reviews / FF-pushes /
   *  lands a branch anymore — integration is the commander's job alone. When armed,
   *  a ready worker (review-column card) instead WAKES the commander desk
   *  (spawnSwarmManager) so a human-in-the-loop heavyweight review + manual merge
   *  decides. This closes the 2026-07-15 incident (autoMerge FF-pushed a hole-y
   *  branch onto main OVER the commander's concurrent 差し戻し): with the engine out
   *  of the merge business, the two can never race on the trunk (structural, not a
   *  rule). The field/endpoint name is KEPT (`autoMerge` / POST
   *  /api/swarm/orchestrator/automerge) only for API + persistence stability across
   *  the redesign — its OBSERVABLE meaning and every UI label are now "auto-wake the
   *  commander". See docs/commander/03-integration-review.md. */
  autoMerge: boolean
  /** True while a pass is mid-flight — the re-entrancy guard that GUARANTEES no two
   *  passes ever overlap (twin-dispatch defense). The setTimeout chain already
   *  serializes the SCHEDULED passes, but a stop→start within a slow pass's await
   *  window (or any future second driver) could otherwise run two passes at once,
   *  both reading the same pre-spawn worker set and dispatching the same card
   *  twice. runEnginePass check-and-sets this synchronously at entry, so the second
   *  pass bails before it can spawn. In-memory only. */
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
   *  Optional (absent ⇒ zero, lazy-init) for older-build / test-literal backfill. In-memory
   *  only — a restart re-arms autoMerge OFF anyway, so the reflex starts disarmed. */
  managerResume?: { attempts: number; lastWakeAt: number; fatalFired: boolean }
  /** How many times each card (taskId) has been RE-QUEUED after a lost worker —
   *  the {@link recoveryColumn} retry budget. Bumped on a 'todo' requeue, reset
   *  when the card is parked in 'blocked' (so a human requeue starts fresh) or
   *  succeeds/leaves the retry cycle. In-memory only. */
  recoveries: Map<string, number>
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
  /** Per-worker (keyed by terminalId) RATE-LIMIT bookkeeping: when we first saw
   *  this worker waiting on a usage/quota/overload limit (`since`, epoch ms). Set
   *  the pass its screen first reads as rate-limited, cleared the moment its
   *  screen reads normal again (it resumed) or it leaves the live set. Drives the
   *  "hold, don't nudge, requeue only after RATE_LIMIT_GRACE_MS" path — NOT the
   *  stall clock. In-memory only. (Card 4880e9c6 — 進まない分類.)
   *
   *  `holdSince` is the epoch ms this hold ACTUALLY began — the limit notice's
   *  onset (engine.limitScreen), which precedes `since` by however long the
   *  confirmation gates took (up to STALL_SILENCE_MS). `since` still drives the
   *  RATE_LIMIT_GRACE_MS requeue clock (unchanged); `holdSince` drives the
   *  execution-time CREDIT ({@link rateLimitHoldCredit}) so the worker is repaid
   *  for the whole wait, not just its confirmed tail. Optional: an engine literal
   *  from an older build / a test fixture falls back to `since`. */
  rateLimited: Map<string, { since: number; holdSince?: number }>
  /** Per-worker (keyed by terminalId) BANKED rate-limit hold, in ms: the total
   *  time this worker has already spent frozen on (now-ended) rate-limit holds.
   *  Credited back to its execution clock so a quota wait never spends the
   *  MAX_EXEC_MS budget (the 2026-07-12 loss). Added to on every hold RELEASE
   *  ({@link endRateLimitHold} — the single seam that clears engine.rateLimited),
   *  read with any in-flight hold by {@link rateLimitHoldCredit}, dropped when the
   *  worker leaves the live set. Optional (older-build backfill). In-memory
   *  only. */
  rateLimitHeldMs?: Map<string, number>
  /** Per-worker (keyed by terminalId) LIMIT-SCREEN clock (quota-detection fast
   *  path): the epoch ms a rate-limit notice was FIRST sighted holding this
   *  worker's screen. Unlike `rateLimited.since` (stamped only once the worker
   *  is CONFIRMED limited) this tracks the raw sighting, so the monitor can
   *  (a) measure how long the notice has held the screen in REAL time — immune
   *  to decorative TUI repaints (toasts) resetting lastOutputAt — and (b)
   *  confirm an at-spawn rejection early (RATE_LIMIT_EARLY_*). Set when a
   *  sampled screen reads rate-limited, cleared the moment a sampled screen
   *  reads anything else (the notice scrolled away ⇒ real work resumed) or the
   *  worker leaves the live set. Optional (older-build backfill). In-memory
   *  only. */
  limitScreen?: Map<string, number>
  /** Per-worker (keyed by terminalId) PERMISSION-WAIT bookkeeping for a startup
   *  trust/permission prompt that slipped past bypass: `since` (epoch ms first
   *  seen) and whether the auto-accept Enter was delivered. Set on first sight in
   *  the startup window, cleared when the screen reads normal or the worker leaves
   *  the live set. Drives the auto-accept → park-if-persists path. In-memory only.
   *  (Card 4880e9c6.) */
  permissionWaits: Map<string, { since: number; accepted: boolean }>
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
   *  re-arms OFF — K2). ASYMMETRIC to autoMerge/selfSupply: an explicit autonomy OFF
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
      autoMerge: false,
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
      reworks: new Map(),
      reworkReasons: new Map(),
      conflictReworks: new Map(),
      stuckMoves: new Map(),
      nudges: new Map(),
      rateLimited: new Map(),
      rateLimitHeldMs: new Map(),
      permissionWaits: new Map(),
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
    engine.autoMerge ??= false
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
    engine.rateLimited ??= new Map()
    engine.rateLimitHeldMs ??= new Map()
    engine.limitScreen ??= new Map()
    engine.integrateInFlight ??= false
    engine.permissionWaits ??= new Map()
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
export const recordEscalationAnswerForNextDispatch = async (
  projectPath: string,
  taskId: string,
  line: string,
): Promise<void> => {
  // Control bytes → space FIRST (so the segment can never contain
  // REWORK_REASON_SEP), then whitespace-fold + clamp.
  const text = line.replace(SLOT_CONTROL_BYTES, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000)
  if (!text) return
  const engine = getOrCreateEngine(await canonicalize(projectPath))
  const marked = text.includes(ESCALATION_ANSWER_MARKER)
    ? text
    : `${ESCALATION_ANSWER_MARKER} ${text}`
  await runExclusive(engine, async () => {
    const existing = engine.reworkReasons.get(taskId)
    // A re-delivery retry re-records the SAME answer — don't stack duplicates.
    if (existing?.split(REWORK_REASON_SEP).includes(marked)) return
    engine.reworkReasons.set(
      taskId,
      existing ? `${existing}${REWORK_REASON_SEP}${marked}` : marked,
    )
  })
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
  engine.log.push({ at: new Date().toISOString(), level, message, ...(kind ? { kind } : {}) })
  if (engine.log.length > MAX_LOG_LINES) {
    engine.log.splice(0, engine.log.length - MAX_LOG_LINES)
  }
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
): number => {
  const prev = engine.stuckMoves.get(taskId)
  const attempts = (prev && prev.intent === intent ? prev.attempts : 0) + 1
  engine.stuckMoves.set(taskId, { intent, attempts, branch, taskTitle })
  return attempts
}

/** A move for `taskId` LANDED (or the card left the stuck situation) — forget any
 *  stuck-move tracking so it never surfaces a now-resolved zombie. Idempotent. */
const clearKeptMove = (engine: ProjectEngine, taskId: string): void => {
  engine.stuckMoves.delete(taskId)
}

// ── Rate-limit hold ledger (the execution clock's credit side) ────────────────
// A worker frozen on a usage/quota limit is not WORKING, so that time must not
// spend its MAX_EXEC_MS budget (the 2026-07-12 loss: 20m limit + 84m work = 104m
// ⇒ runaway at 90m, 15 uncommitted files destroyed with the worktree). The engine
// therefore banks every hold it observes and subtracts the total from the runaway
// check. Two functions own the whole ledger: END a hold (banking its span) and
// READ the credit (banked + any hold still in flight).

/** END a worker's rate-limit hold, BANKING its span into the execution-time
 *  credit ledger. THE single seam that clears `engine.rateLimited` on a live
 *  worker — clearing the map directly would silently drop the credit and re-open
 *  the 2026-07-12 hole, so route every release through here.
 *
 *  The span is measured from `holdSince` (the limit notice's onset) when present,
 *  else `since` (the confirmed-hold stamp) — an older-build / fixture entry
 *  without `holdSince` still banks its confirmed tail rather than nothing.
 *  Idempotent: a worker not on hold banks nothing. A clock that runs backwards
 *  (a fixture, an NTP step) banks 0, never a negative credit. */
const endRateLimitHold = (engine: ProjectEngine, terminalId: string, now: number): void => {
  const rl = engine.rateLimited.get(terminalId)
  engine.rateLimited.delete(terminalId)
  if (!rl) return
  const from = rl.holdSince ?? rl.since
  const held = Number.isFinite(from) ? Math.max(0, now - from) : 0
  if (held <= 0) return
  engine.rateLimitHeldMs ??= new Map() // lazy backfill (older-build engine / test literal)
  engine.rateLimitHeldMs.set(terminalId, (engine.rateLimitHeldMs.get(terminalId) ?? 0) + held)
}

/** How much rate-limit hold to CREDIT BACK to this worker's execution clock:
 *  everything banked by {@link endRateLimitHold} PLUS any hold still IN FLIGHT
 *  (a worker frozen right now is being repaid in real time — it must not cross
 *  the ceiling while it sits there waiting). Capped at {@link HOLD_CREDIT_CAP_MS}
 *  so a limit↔work cycle can't defer the runaway check forever: the absolute
 *  wall-clock lifetime of any worker stays bounded by MAX_EXEC_MS + the cap. */
const rateLimitHoldCredit = (engine: ProjectEngine, terminalId: string, now: number): number => {
  const banked = engine.rateLimitHeldMs?.get(terminalId) ?? 0
  const rl = engine.rateLimited.get(terminalId)
  const from = rl ? (rl.holdSince ?? rl.since) : null
  const live = from !== null && Number.isFinite(from) ? Math.max(0, now - from) : 0
  const total = (Number.isFinite(banked) ? Math.max(0, banked) : 0) + live
  return Math.min(total, HOLD_CREDIT_CAP_MS)
}

const emptyState = (): SwarmOrchestratorState => ({
  running: false,
  manualStop: false,
  manualStopPersisted: false,
  autoMerge: false,
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
  isAlive: (id: string) => boolean,
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
): SwarmOrchestratorState => {
  // Resolve the live worker set ONCE — both the reported `workers` array and the
  // consumption snapshot (activeWorkers / activeRunMs) read from it.
  const live = engine.workers.filter((w) => isAlive(w.terminalId))
  const counters = engine.metrics ?? emptyMetricsCounters()
  return {
    running: engine.running,
    // The OR of the in-memory flag and the persisted record, so "stopped by hand"
    // reads true across a restart (fresh engine ⇒ flag false, record still true).
    manualStop: engine.manualStop === true || manualStopPersisted,
    manualStopPersisted,
    autoMerge: engine.autoMerge,
    selfSupply: engine.selfSupply.enabled,
    overseer: engine.overseer.enabled,
    workers: live,
    reviews: [...engine.reviews],
    log: [...engine.log],
    anomalies: [...engine.anomalies],
    maxWorkers: ORCHESTRATOR_MAX_WORKERS,
    kpis: computeSwarmKpis({ counters, tasks, log: engine.log }),
    consumption: computeSwarmConsumption({ liveWorkers: live, counters, limit: DISPATCH_BUDGET }),
    autonomyRemembered,
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
  }) => Promise<SpawnSwarmWorkerResponse>
  /** Is this worker's PTY still alive? (A freed slot ⇒ refill.) */
  isAlive: (terminalId: string) => boolean
  /** Commits the worker's `swarm/*` branch carries ahead of trunk — the
   *  "branch is ready" signal. 0 on any failure (conservative: no proof of
   *  work ⇒ no promotion). Probed from the shared repo by branch ref, so it
   *  works whether or not the worktree still exists. (Card②) */
  countCommitsAhead: (projectPath: string, branch: string) => Promise<number>
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
  }) => Promise<{ removed: boolean; reason?: string; wip?: WipCommitResult }>
  /** Epoch ms of the worker PTY's last output chunk (terminal.ts stamps it on
   *  every onData), or null when unknown / it has produced none yet. The SECOND
   *  liveness channel beside the heartbeat: a worker streaming tokens is alive even
   *  between heartbeats, so a stall requires BOTH to fall silent. (Stall detection.) */
  lastOutputAt: (terminalId: string) => number | null
  /** NUDGE a silent worker: send a bare Enter (CR) to its PTY to submit a prompt
   *  left unsent / un-stick a waiting TUI — the cheap first recovery before a
   *  reclaim. Returns false when the PTY is gone. Workers run permissionMode:
   *  'bypass' (no permission menus), so a stray Enter cannot approve anything.
   *  (Stall recovery.) */
  nudge: (terminalId: string) => boolean
  /** ESCALATE a worker that stayed silent past the whole nudge budget: ESC
   *  (interrupt) then, after a short settle, a one-line continue instruction
   *  naming `taskTitle` — tried exactly ONCE (see {@link classifyStall}) before a
   *  still-silent worker is reclaimed. Returns false when the PTY is gone or
   *  either write failed. (Stall recovery escalation, 2026-07.) */
  escalate: (terminalId: string, taskTitle: string) => Promise<boolean>
  /** The worker PTY's CURRENT visible screen as plain text (the headless `claude`
   *  TUI frame), or null when unknown. Read-only. The orchestrator classifies it
   *  (classifyOutput) to tell WHY a non-promoting worker isn't progressing — a
   *  usage/rate-limit WAIT or a startup permission prompt — rather than treating
   *  every quiet worker as a stall. (Card 4880e9c6 — 進まない分類.) */
  recentOutput: (terminalId: string) => string | null
  /** Raise a worker's FREE-TEXT question to the escalations inbox (C3). Until
   *  C-core lands its budgeted brain pass, this is the §6 S4 THROTTLED
   *  degradation: the bare question goes straight to T3 — openEscalation is
   *  LLM-free and receiptKey-idempotent, and the owner's answer re-enters the
   *  worker through answerEscalation → injectAnswerIntoWorker (W16). OPTIONAL:
   *  absent ⇒ the question arm only HOLDS the worker (no raise) — existing
   *  fake-deps tests keep compiling/behaving. Default (defaultDeps):
   *  openEscalation. */
  raiseQuestion?: (input: OpenEscalationInput) => Promise<unknown>
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
  /** Kill a just-landed worker's `claude` PTY by terminal id (post-integration
   *  teardown). cleanup() already kills any PTY by cwd; this is the by-id
   *  belt-and-suspenders for the symlinked-home edge case a cwd match can miss,
   *  and it lets the engine free the slot IMMEDIATELY (no waiting for the next
   *  monitor pass to notice the PTY died). Default: killTerminal. */
  killPty: (terminalId: string) => void
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
  isAlive: (terminalId: string) => boolean
  /** Tear down a worker's worktree + PTY (KEEPS its branch) — used to clean up a
   *  parked / re-dispatched worker on 差し戻し. Uncommitted work is salvaged onto the
   *  branch first (see OrchestratorDeps.recoverWorker — same dep, same contract). */
  recoverWorker: (opts: {
    projectPath: string
    worktree: string
    terminalId: string
    reason?: TeardownReason
  }) => Promise<{ removed: boolean; reason?: string; wip?: WipCommitResult }>
  /** Tell a LIVE worker (over its PTY) WHY its card was sent back and to fix it
   *  IN PLACE — one line written to its terminal so a review→doing 差し戻し actually
   *  restarts work instead of leaving an idle (post-done) worker untouched.
   *  best-effort (a no-op when the session is gone). Default: defaultInstructRework. */
  instructRework: (terminalId: string, message: string) => void
  // ── MANAGER-ONLY INTEGRATION + RESURRECTION (2026-07-15) — the engine WAKES the
  //    commander when a worker is ready instead of merging itself, and RE-wakes it if
  //    it dies/hangs (card B). These seams replace the verify→lens→FF-push→land
  //    machinery on the armed path (完了条件1+2+3) and add the resuscitation reflex. ──
  /** Is the project's commander (manager) desk up AND RESPONDING? — the guard that stops
   *  the engine spawning a SECOND commander PTY when a healthy one is present (二重起動
   *  防止, 完了条件2) AND the trigger that resuscitates a stopped one (完了条件2+3).
   *  Folds TWO signals (2026-07-15 card B): a LIVE PTY on the persisted manager session
   *  (catches a dead process) AND a FRESH manager heartbeat (catches a HUNG one — PTY
   *  alive but silent past {@link MANAGER_HEARTBEAT_STALE_MS}). `now` is the pass clock
   *  (injected for deterministic staleness). MUST NOT throw — an unreadable session store
   *  ⇒ false (absent), so the safe default is to resuscitate rather than stall integration.
   *  Default: {@link defaultIsManagerActive}. */
  isManagerActive: (projectPath: string, now: number) => Promise<boolean>
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
  column: 'doing' | 'review',
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

/** "Is the commander desk up AND responding?" ({@link IntegrationDeps.isManagerActive}).
 *  Two signals ANDed (完了条件2 — detect process death AND hang):
 *    1. a LIVE PTY on the persisted manager session (swarmSessions + isClaudeSessionLive)
 *       — catches a DEAD process (PTY gone), and
 *    2. a FRESH manager heartbeat — catches a HUNG one (PTY alive but silent past the
 *       stale window). Fail-open on a never-written beat (see isManagerHeartbeatFresh).
 *  NEVER throws: an unreadable session store (unregistered path, torn home) ⇒ false, so
 *  the engine resuscitates a fresh desk rather than silently stall integration. */
const defaultIsManagerActive = async (projectPath: string, now: number): Promise<boolean> => {
  try {
    const rec = (await readSwarmSessions(projectPath)).manager
    if (!rec || !isClaudeSessionLive(rec.sessionId)) return false // dead / absent PTY
    return isManagerHeartbeatFresh(await readManagerHeartbeatAt(projectPath), now) // hung?
  } catch {
    return false
  }
}

/** WAKE the commander ({@link IntegrationDeps.wakeManager}): spawn/resume its PTY
 *  (spawnSwarmManager — resumes the days-long integration conversation, else fresh)
 *  and post ONE info notification naming the waiting review branches. The spawned
 *  `/og-manage` reads the Board and finds the review cards itself; the notification
 *  is the durable, human-facing record. NEVER throws — a NoAllowedModelTierError
 *  (every tier OFF/cooling) or any spawn fault ⇒ false, so the engine retries the
 *  wake next pass instead of marking the branches handed-off. */
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
    detail: `review に ${n} 件の統合待ち — 司令官を起こしました。統合を判断してください (${list})`,
  }).catch(() => {})
  return true
}

// --- git + heartbeat probes (the monitor's read-only signals) ----------------

const GIT_OPTS = {
  timeout: 15_000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
}

/** Run git in `cwd`; trimmed stdout, or null on any failure (no git, not a repo,
 *  bad ref, …). */
const gitOut = async (cwd: string, args: string[]): Promise<string | null> => {
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
 *  already resolves the trunk. 0 when no trunk ref resolves or the branch is gone
 *  (conservative — no provable work ⇒ no promotion). */
const defaultCountCommitsAhead = async (projectPath: string, branch: string): Promise<number> => {
  if (!branch) return 0
  for (const base of await commitBasePreference(projectPath)) {
    if ((await gitOut(projectPath, ['rev-parse', '--verify', '--quiet', base])) === null) continue
    const out = await gitOut(projectPath, ['rev-list', '--count', `${base}..${branch}`])
    if (out === null) return 0 // branch ref missing / git error ⇒ no proof of work
    const n = Number.parseInt(out, 10)
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  return 0
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
  const commonDir = await gitOut(projectPath, ['rev-parse', '--git-common-dir'])
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
}): Promise<SpawnSwarmWorkerResponse> => {
  const pre = await claudeRunPreflight()
  if (!pre.ok) throw new Error(pre.body.error || 'claude not ready')
  return spawnSwarmWorker(opts)
}

const isWorkerAlive = (terminalId: string): boolean => {
  const info = getTerminal(terminalId)
  // A session lingers ~30s after exit with finishedAt set (terminal.ts) so the
  // client can drain the buffer; an exited-but-lingering PTY is NOT a live slot.
  return !!info && !info.finishedAt
}

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

/** The outcome of the pre-teardown WIP commit ({@link commitWipBeforeTeardown}). */
export interface WipCommitResult {
  /** A WIP commit LANDED on the worker's branch (there was work to save). */
  committed: boolean
  /** There WAS (or might have been) uncommitted work and we could NOT commit it.
   *  The caller must then KEEP the worktree: it holds the only copy left. */
  failed?: boolean
  /** Detail for the log (short sha on success, the git failure otherwise). */
  reason?: string
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

  const sha = await gitOut(worktree, ['rev-parse', '--short', 'HEAD'])
  return { committed: true, reason: sha ?? undefined }
}

/** Tear down a lost/stopped worker's worktree + PTY. Kills the PTY by id FIRST
 *  (covers the symlinked-home cwd-miss that removeSwarmWorktree's by-cwd kill can
 *  drop), then — CRITICALLY — commits any uncommitted work to the worker's branch
 *  ({@link commitWipBeforeTeardown}) before force-removing the worktree (which
 *  also kills any PTY by cwd and is idempotent — already-gone reads as removed).
 *  If that salvage commit FAILS the worktree is KEPT, not destroyed: the work in
 *  it is unrecoverable, a leftover worktree is not. Branch is intentionally KEPT
 *  (see the dep doc). Never throws — a failure is reported for the log. */
const defaultRecoverWorker = async (opts: {
  projectPath: string
  worktree: string
  terminalId: string
  reason?: TeardownReason
}): Promise<{ removed: boolean; reason?: string; wip?: WipCommitResult }> => {
  try {
    killTerminal(opts.terminalId)
  } catch {
    /* already dead / absent — the worktree teardown below is what matters */
  }
  if (!opts.worktree) return { removed: false, reason: 'no worktree path on record' }
  // Kill FIRST, then salvage: a dead PTY can't keep writing into the tree we are
  // about to snapshot.
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
    }
  }
  try {
    const res = await removeSwarmWorktree(opts.projectPath, opts.worktree, { force: true })
    return { ...res, wip }
  } catch (e) {
    return { removed: false, reason: errMsg(e), wip }
  }
}

/** The worker PTY's last-output epoch (terminal.ts tracks it per session), or null
 *  when the PTY is unknown / has produced no output yet. The stall monitor's
 *  second liveness channel. */
const defaultLastOutputAt = (terminalId: string): number | null =>
  getTerminal(terminalId)?.lastOutputAt ?? null

/** Send a bare Enter (CR) to a worker's PTY — the stall nudge. writeInput returns
 *  false when the session is gone/finished (nothing to wake). */
const defaultNudge = (terminalId: string): boolean => writeInput(terminalId, '\r')

// Control bytes that must never reach the raw PTY write below: taskTitle is
// card-derived and attacker-reachable in git-shared mode (a teammate writes the
// card JSON) — the same threat pastePrompt.ts's ESC strip closes for the paste
// conduit. This write is NOT bracketed-paste (it auto-submits with a trailing
// CR), so an embedded ESC/CSI here is MORE dangerous, not less: it would reach
// `claude`'s TUI as a raw, auto-submitted control sequence. \s already folds any
// embedded \r/\n into a single space below, so only ESC/C0/C1 need stripping here.
// eslint-disable-next-line no-control-regex
const ESCALATE_CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g

/** ESC + continue-instruction — the stall ESCALATION tried once after the cheap
 *  Enter-nudge budget is spent and the worker is STILL silent. A bare Enter can't
 *  cancel a request `claude` is already mid-generation on; our OWN ESC (chr 27)
 *  interrupts it, and — after {@link STALL_ESCALATE_DELAY_MS} lets that settle —
 *  a short instruction (naming the card so the worker knows which goal to
 *  resume) submits with a trailing CR, mirroring the manually-verified field
 *  recovery (2026-07-02: 3 of 4 wedged Fable/max workers recovered immediately
 *  via this exact sequence). Runs over the raw PTY write path (terminal.ts), NOT
 *  pastePrompt's bracketed-paste conduit, so this function's OWN ESC byte is
 *  never itself stripped by that unrelated sanitizer — but `taskTitle` (untrusted
 *  card data) IS stripped of control bytes here before it reaches the PTY (see
 *  {@link ESCALATE_CONTROL_BYTES}). Returns true only when BOTH writes landed on
 *  a live PTY; `sleep` is DI'd (default: real timer) so a unit test can skip the
 *  real delay. */
export const defaultEscalate = async (
  terminalId: string,
  taskTitle: string,
  deps?: { write?: typeof writeInput; sleep?: (ms: number) => Promise<void> },
): Promise<boolean> => {
  const write = deps?.write ?? writeInput
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  if (!write(terminalId, '\x1b')) return false
  await sleep(STALL_ESCALATE_DELAY_MS)
  const safeTitle = taskTitle.replace(ESCALATE_CONTROL_BYTES, '').replace(/\s+/g, ' ').trim()
  const line = `続けてください。${safeTitle} のゴールを続行。完了条件: 実装+テスト緑+コミット。`
  return write(terminalId, `${line}\r`)
}

/** The worker PTY's current visible screen (headless `claude` TUI frame), or null
 *  — the source classifyOutput inspects to spot a rate-limit wait / permission
 *  prompt. Read-only (terminal.ts reconstructs the frame without touching the PTY). */
const defaultRecentOutput = (terminalId: string): string | null => getTerminalScreen(terminalId)

/** Send a LIVE worker a one-line 差し戻し instruction over its PTY (the rework
 *  conduit's "fix in place" message): collapse the reason to a SINGLE line (a raw
 *  newline would submit the half-typed prompt early) and write it with a trailing
 *  CR so the worker's `claude` takes it as its next turn. best-effort — writeInput
 *  is a no-op when the session is gone/finished, and workers run permissionMode
 *  'bypass' so a stray line can't approve anything. */
const defaultInstructRework = (terminalId: string, message: string): void => {
  const line = message.replace(/\s+/g, ' ').trim()
  if (line) writeInput(terminalId, `${line}\r`)
}

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
      await execFile(tscBin, ['--noEmit'], {
        cwd: worktreeDir,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env },
      })
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
 *  file would never trip the gate. */
const SWARM_CODE_PATHS: readonly RegExp[] = [
  /^src\/lib\/server\/swarm[^/]*\.ts$/,
  /^server\/routes\/swarm\.ts$/,
  /^server\/routes\/project\.ts$/,
  /^server\/routes\/__tests__\/swarmSafety[^/]*$/,
  /^src\/components\/canvas\/modules\/Swarm[^/]*$/,
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

/** The swarm safety regression suite (the A1 net, card 8d778645). Running these two
 *  files green proves the swarm's self-protection invariants (A–D) still hold. */
export const SWARM_SAFETY_TESTS: readonly string[] = [
  'src/lib/server/swarmSafety.test.ts',
  'server/routes/__tests__/swarmSafety.routes.test.ts',
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
 *  merge. The suite re-pins OPENGROUND_HOME to a tmp dir itself (src/test/setup-home.ts
 *  runs as a vitest setupFile before any test module loads), so it never touches the
 *  user's real ~/.openground even though the engine runs with the real home in its
 *  env. A missing vitest binary (project not installed) is RED — an unverified swarm
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
      await runGateProcess(vitestBin, ['run', ...SWARM_SAFETY_TESTS], {
        cwd: worktreeDir,
        timeout: 240_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env },
      })
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
 *  {@link lintCheck}. Covers eslintrc (legacy — what OPEN GROUND uses: .eslintrc.json) and
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
      await runGateProcess(eslintBin, ['.', '--ext', '.ts,.tsx'], {
        cwd: worktreeDir,
        timeout: 180_000,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env },
      })
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
 *  ANY test (not just the swarm-safety subset B2 gated on) cannot auto-merge. The suite
 *  re-pins OPENGROUND_HOME to a tmp dir itself (src/test/setup-home.ts runs as a vitest
 *  setupFile before any test module loads), so it never touches the user's real
 *  ~/.openground even though the engine runs with the real home in env — exactly like
 *  swarmSafetyCheck. `applicable` is a HAS-TESTS test (a vitest/vite config present); `run`
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
      await runGateProcess(vitestBin, ['run'], {
        cwd: worktreeDir,
        timeout: 600_000,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env },
      })
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
// SUBSCRIPTION-ONLY (read claudeTerminal.ts top comment): every reviewer is a real
// interactive PTY (launchClaude), so it bills the user's Claude subscription pool,
// NEVER the programmatic credit pool — `claude -p` is FORBIDDEN here (same contract
// as the workers / generateDescription).

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
    await gitOut(projectPath, ['worktree', 'remove', '--force', dir])
    await gitOut(projectPath, ['worktree', 'prune'])
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
  try {
    await execFile('git', ['branch', '-D', branch], {
      cwd: projectPath,
      timeout: 30_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
  } catch {
    /* branch already gone / never existed — the worktree teardown is what matters */
  }
  return { removed: true }
}

/** The real, wired dep set. Exported so the live-git integration test can build
 *  on the REAL classify / integrate / cleanup / commit-count probes (overriding
 *  only the board + spawn + liveness seams with in-memory fakes) — so the engine's
 *  risky git path is exercised against a real repo, not only the unit fakes. */
export const defaultDeps = (): OrchestratorDeps & IntegrationDeps & AnomalyDeps => ({
  fetchTasks: defaultFetchTasks,
  moveToDoing: defaultMoveToDoing,
  moveToReview: defaultMoveToReview,
  spawnWorker: defaultSpawnWorker,
  isAlive: isWorkerAlive,
  countCommitsAhead: defaultCountCommitsAhead,
  readHeartbeat: defaultReadHeartbeat,
  recoverCard: defaultRecoverCard,
  recoverWorker: defaultRecoverWorker,
  lastOutputAt: defaultLastOutputAt,
  nudge: defaultNudge,
  escalate: defaultEscalate,
  recentOutput: defaultRecentOutput,
  raiseQuestion: openEscalation,
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
  killPty: killTerminal,
  instructRework: defaultInstructRework,
  // Manager-only integration (2026-07-15): the engine wakes the commander instead
  // of merging. isManagerActive gates the double-launch; wakeManager spawns the desk.
  isManagerActive: defaultIsManagerActive,
  wakeManager: defaultWakeManager,
  worktreeExists: defaultWorktreeExists,
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
  ): Promise<boolean> => {
    const verb =
      reason === 'stall'
        ? 'stalled — reclaimed'
        : reason === 'runaway'
          ? 'runaway (hit execution-time limit) — stopped'
          : reason === 'rate-limit'
            ? 'rate/usage-limited too long — requeued'
            : reason === 'permission'
              ? 'permission/trust prompt unresolved — parked'
              : reason === 'question'
                ? 'free-text question unanswered too long — parked'
                : 'lost'
    let teardown: { removed: boolean; reason?: string; wip?: WipCommitResult } = { removed: false }
    try {
      teardown = await deps.recoverWorker({
        projectPath: engine.path,
        worktree: w.worktree,
        terminalId: w.terminalId,
        reason, // rides into the salvage commit's message (commitWipBeforeTeardown)
      })
    } catch {
      /* reported via teardown.removed=false below */
    }
    const keptNote = teardown.removed ? '' : ` · worktree kept (${teardown.reason ?? '?'})`
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
        `worker ${verb} — slot freed: ${w.branch} (${shorten(w.taskTitle)})${keptNote}${wipNote}`,
        'routine',
      )
      return false
    }

    const requeues = engine.recoveries.get(w.taskId) ?? 0
    let col = recoveryColumn(probe, requeues, RECOVER_MAX_REQUEUE, reason)
    let moved = false
    try {
      moved = await deps.recoverCard(engine.path, w.taskId, col)
    } catch {
      moved = false
    }
    // Board write kept — bump the stuck-move tracker. Past the retry budget,
    // ESCALATE a 'todo' requeue to 'blocked' (blocked退避): a card whose recovery
    // write keeps failing must NOT zombie in 'doing' ("dead なのに doing"), so we
    // park it for a human instead of gently requeueing it forever. (If the write
    // ITSELF keeps failing the card can't move at all — the 'move-stuck' anomaly
    // then surfaces it; see detectAnomalies.)
    if (!moved) {
      const attempts = recordKeptMove(engine, w.taskId, 'recover', w.branch, w.taskTitle)
      if (attempts >= MOVE_STUCK_MAX_RETRIES && col !== 'blocked') {
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
        `worker ${verb} but card move kept (will retry): ${w.branch} (${shorten(w.taskTitle)})`,
      )
      return true
    }
    clearKeptMove(engine, w.taskId) // the recovery write landed — forget the stuck tracking
    // A 'rate-limit' requeue is ORTHOGONAL to the crash/stall retry budget: it is a
    // transient WAIT, not a failed attempt, so it must neither consume that budget
    // (else a real later crash would skip its retries) nor be capped by it (a
    // limited account self-heals — looping todo↔doing until it lifts is fine, no
    // work is lost). Only crash/stall (and the budget-driven cases) touch it.
    if (reason !== 'rate-limit') {
      if (col === 'todo') engine.recoveries.set(w.taskId, requeues + 1)
      else engine.recoveries.delete(w.taskId) // parked — a human requeue starts fresh
    }
    // warn level + structured kind: 'crash' for a dead PTY, 'stall' for a reclaimed
    // silent one; runaway / rate-limit / permission ride as uncategorized-but-shown
    // events (no UI chip exists for them yet — the message carries the reason). The
    // abnormal counterpart of a 'routine' slot-free, surfaced (not hidden) so the
    // owner sees the recovered worker + where its card went + WHY.
    logLine(
      engine,
      'warn',
      `worker ${verb} — card → ${col}: ${w.branch} (${shorten(w.taskTitle)})${keptNote}${wipNote}`,
      reason === 'stall' ? 'stall' : reason === 'crash' ? 'crash' : undefined,
    )
    return false
  }

  for (let w of engine.workers) {
    if (!engine.running) {
      next.push(w) // a stop mid-pass: keep the rest untouched
      continue
    }
    const alive = deps.isAlive(w.terminalId)
    const card = byId.get(w.taskId)

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
      w = { ...w, stage: 'running', reworkAt: new Date(now).toISOString() }
      logLine(
        engine,
        'info',
        `Board 側の差し戻し(review→doing)を観測 — worker を再作業中へ: ${w.branch} (${shorten(w.taskTitle)})`,
      )
    }

    // Already promoted, or the card already sits in review/done → terminal. Keep
    // showing 'done' while the PTY lingers; an exit is what frees the slot.
    if (w.stage === 'done' || (card && (columnOf(card) === 'review' || columnOf(card) === 'done'))) {
      if (alive) next.push({ ...w, stage: 'done' })
      else logLine(engine, 'info', `done worker closed — slot freed: ${shorten(w.taskTitle)}`, 'routine')
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
    let commitsAhead = 0
    let heartbeat: HeartbeatSign | null = null
    try {
      commitsAhead = await deps.countCommitsAhead(engine.path, w.branch)
    } catch {
      /* treat as 0 — conservative */
    }
    try {
      heartbeat = await deps.readHeartbeat(engine.path, w.branch)
    } catch {
      /* treat as null */
    }

    let { promote, stage } = classifyWorker(
      { alive, commitsAhead, heartbeat },
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
        engine.recoveries.delete(w.taskId) // succeeded — drop any prior retry budget
        clearKeptMove(engine, w.taskId) // the review move landed — forget any stuck tracking
        // Keep a lingering PTY as 'done' (UI shows it; its exit frees the slot);
        // a worker that already exited has nothing left to count. Clear reworkAt — the card
        // left doing for review, so the re-promote suppression is no longer relevant.
        if (alive) next.push(withHeartbeat({ ...w, stage: 'done', reworkAt: undefined }, heartbeat))
      } else {
        // Board write kept — keep the worker (card still in 'doing') and retry next
        // pass; don't claim 'done' until the move lands. Track it so a worker that
        // FINISHED but can't advance (a "done worker stuck in doing") surfaces as a
        // 'move-stuck' anomaly past the budget instead of a silent warn loop.
        recordKeptMove(engine, w.taskId, 'review', w.branch, w.taskTitle)
        logLine(engine, 'warn', `review move kept (will retry): ${shorten(w.taskTitle)}`)
        next.push(withHeartbeat({ ...w, stage: 'running' }, heartbeat))
      }
      continue
    }

    // Not done. A dead worker with nothing to promote is LOST — recover it: tear
    // its worktree/PTY down and return its card to the board ('todo' to retry,
    // 'blocked' to park) instead of stranding it in 'doing' as the old conservative
    // default did (a zombie card no worker was draining, plus a leaked worktree). A
    // crash still never FAKES progress — recoveryColumn never promotes to review.
    // recoverLost logs the recovery with the 'crash' kind so the owner sees the
    // fallen-over worker (not buried as 'routine') — the observability the anomaly
    // stage and the crash log give, now with the teardown + requeue that fixes it.
    if (!alive) {
      if (await recoverLost(w, card, { alive, commitsAhead, heartbeat })) next.push(w)
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

    // (1) RUNAWAY — wall-clock since dispatch past MAX_EXEC_MS. Checked FIRST and
    // INDEPENDENT of liveness: a worker streaming output forever (an infinite
    // /order loop, a task too big) still overruns, and is the one case a silence
    // detector can never catch. Stop it (teardown + → 'blocked': a re-run would
    // just overrun again, so a human looks). Clear all per-worker bookkeeping so a
    // reclaimed terminalId never carries stale state into a future spawn.
    // The runaway clock is the WORKING clock: repay every rate-limit hold this
    // worker sat through (banked + any still in flight, capped at
    // HOLD_CREDIT_CAP_MS) before comparing against the ceiling. A quota wait is
    // not 暴走 — charging it to the worker is what destroyed 47KB of finished work
    // on 2026-07-12 (see MAX_EXEC_MS / rateLimitHoldCredit).
    const heldMs = rateLimitHoldCredit(engine, w.terminalId, now)
    if (isRunaway(startedMs, now, MAX_EXEC_MS, heldMs)) {
      engine.nudges.delete(w.terminalId)
      engine.rateLimited.delete(w.terminalId)
      engine.rateLimitHeldMs?.delete(w.terminalId)
      engine.limitScreen?.delete(w.terminalId)
      engine.permissionWaits.delete(w.terminalId)
      engine.questionRaised?.delete(w.terminalId)
      engine.questionWaits?.delete(w.terminalId)
      const ranMin = Math.floor((now - startedMs) / 60_000)
      const heldMin = Math.floor(heldMs / 60_000)
      const workedMin = Math.floor((now - startedMs - heldMs) / 60_000)
      const limitMin = Math.floor(MAX_EXEC_MS / 60_000)
      logLine(
        engine,
        'warn',
        `worker runaway — worked ${workedMin}m ≥ ${limitMin}m execution limit (alive ${ranMin}m; ${heldMin}m of rate-limit hold credited back): ${w.branch} (${shorten(w.taskTitle)})`,
      )
      // Escalation safety valve (exec-timeout): a worker overran the execution-time
      // ceiling and is being force-reclaimed/parked — a human should know (a re-run
      // would just overrun again). Enqueue the EDGE event; runEnginePass drains +
      // pushes it exactly once after the pass settles.
      engine.pendingFatal.push({
        event: 'exec-timeout',
        detail: `ワーカーが実行時間上限 ${limitMin}分 を超過（実作業 ${workedMin}分・通算 ${ranMin}分／うち rate-limit 待ち ${heldMin}分は控除済み）→ 強制回収。未コミットの作業はブランチに WIP コミットで保全されます（未検証）。`,
        projectPath: engine.path,
        taskId: card?.id,
        branch: w.branch,
        taskTitle: w.taskTitle,
        logHint: '司令塔の engine log を確認してください（worker runaway の警告行）。',
      })
      if (await recoverLost(w, card, { alive, commitsAhead, heartbeat }, 'runaway')) next.push(w)
      continue
    }

    // Compute the stall verdict UP FRONT: its `silentMs` GATES the rate-limit /
    // permission classification below (only a silent worker is a candidate), and
    // its `action` drives the normal path. A worker NOT yet silent yields action
    // 'none' with silentMs < STALL_SILENCE_MS, so it sails through every branch
    // untouched — exactly the "never interrupt a working worker" contract.
    let lastOut: number | null = null
    try {
      lastOut = deps.lastOutputAt(w.terminalId)
    } catch {
      /* unknown → no output signal; heartbeat + startedAt still apply */
    }
    const hbMs = heartbeat?.at ? Date.parse(heartbeat.at) : Number.NaN

    // ── LIMIT-SCREEN CLOCK (quota-detection fast path — the 21-minute lag fix) ──
    // Sample the screen once the PTY output has merely LULLED (45s), not only
    // after the full 10-min silence gate, and remember WHEN a rate-limit notice
    // first appeared (engine.limitScreen). Two properties fall out:
    //  • Decorative repaints can't defer detection: while the notice HOLDS the
    //    screen, later PTY output (a "Plugin updated" toast, a status-line
    //    repaint) is chrome ON the limit screen, not work — so the stall clock
    //    below is clamped to the notice's onset. If real work resumes, either a
    //    heartbeat lands (activity by the other channel) or new output scrolls
    //    the notice off screen (a sampled screen reads normal ⇒ clock cleared).
    //  • An at-spawn rejection is confirmed in ~1.5 min (the early path below)
    //    instead of 10+, so the tier cools while its slots can still be re-aimed.
    // A busy worker (output flowing, nothing tracked) is still never scraped —
    // the lull gate keeps the per-pass TUI-scrape cost where it was; a tracked
    // worker is re-sampled every pass so a lifted limit is noticed promptly.
    engine.limitScreen ??= new Map() // lazy backfill (older-build engine / test literal)
    const outQuietMs =
      now - Math.max(lastOut ?? Number.NEGATIVE_INFINITY, Number.isFinite(startedMs) ? startedMs : 0)
    const sampleScreen =
      outQuietMs >= RATE_LIMIT_SCRAPE_QUIET_MS ||
      engine.limitScreen.has(w.terminalId) ||
      engine.rateLimited.has(w.terminalId)
    let screen: string | null = null
    if (sampleScreen) {
      try {
        screen = deps.recentOutput(w.terminalId)
      } catch {
        /* unknown → classifyOutput('normal') → ordinary stall handling below */
      }
    }
    const output = classifyOutput(screen)
    if (sampleScreen) {
      if (output === 'rate-limited') {
        if (!engine.limitScreen.has(w.terminalId)) engine.limitScreen.set(w.terminalId, now)
      } else {
        engine.limitScreen.delete(w.terminalId)
      }
    }
    const limitSince = engine.limitScreen.get(w.terminalId) ?? null

    // Clamp the stall clock's output channel to the notice's onset: output that
    // lands WHILE the limit notice holds the screen is a decorative repaint, not
    // activity (the measured failure: one toast pushed detection back 6m40s).
    // Heartbeats are NOT clamped — a worker that beats is working, whatever its
    // screen shows, and stays out of every branch below via silentMs.
    const stallLastOut = limitSince !== null && lastOut !== null && lastOut > limitSince ? limitSince : lastOut
    const stall = classifyStall(
      {
        heartbeatAtMs: Number.isFinite(hbMs) ? hbMs : null,
        lastOutputAtMs: stallLastOut,
        startedAtMs: Number.isFinite(startedMs) ? startedMs : 0,
        nudge: engine.nudges.get(w.terminalId),
      },
      now,
      {
        stallMs: STALL_SILENCE_MS,
        cooldownMs: STALL_NUDGE_COOLDOWN_MS,
        echoGuardMs: STALL_ECHO_GUARD_MS,
        maxNudges: STALL_MAX_NUDGES,
      },
    )

    // EARLY CONFIRMATION — a worker REJECTED AT SPAWN (the 2026-07-09 shape:
    // "You've reached your Fable 5 limit." four seconds in) must not wait out the
    // 10-min silence gate built for hung workers. Confirm rate-limited once the
    // notice (a) appeared within the spawn onset window, (b) has held the screen
    // for the confirm window, (c) with zero commits and (d) no heartbeat since
    // the notice — i.e. the worker demonstrably never started working. A worker
    // merely EDITING limit wording fails (a): that happens minutes into a
    // session, past the onset window, and takes the ordinary clamped gate.
    const earlyLimitConfirmed =
      limitSince !== null &&
      Number.isFinite(startedMs) &&
      limitSince - startedMs <= RATE_LIMIT_EARLY_ONSET_MS &&
      now - limitSince >= RATE_LIMIT_EARLY_CONFIRM_MS &&
      commitsAhead === 0 &&
      (!Number.isFinite(hbMs) || hbMs <= limitSince)

    // RATE-LIMIT WAIT — waiting on a usage/quota/overload limit, NOT wedged.
    // Enter can't lift a limit and reclaiming throws away committed work +
    // re-dispatches into the same wall, so the engine does NEITHER: it HOLDS the
    // worker (dropping any stall-nudge budget) and only requeues to 'todo' once
    // STILL limited past RATE_LIMIT_GRACE_MS (slot recovery; the branch keeps
    // its commits, a later attempt retries when the limit resets). `since` is
    // stamped once and persists across passes. Entered by EITHER gate:
    //  • the ordinary stall gate (silentMs ≥ STALL_SILENCE_MS) — silentMs is
    //    computed on the CLAMPED output channel, so a limit screen that a toast
    //    keeps "refreshing" still crosses it in real time; or
    //  • the early at-spawn confirmation (earlyLimitConfirmed) — an instantly-
    //    rejected worker is confirmed in ~1.5 min, not 10+.
    // The false-kill contract holds: a productive worker that merely PRINTS
    // limit-like text is streaming output ⇒ not silent, and (past the onset
    // window / with commits or heartbeats) not early-confirmed ⇒ never enters;
    // once its screen stops reading rate-limited the clamp dissolves with the
    // clock, and the hold clears below the moment a sampled screen reads normal.
    if (output === 'rate-limited' && (stall.silentMs >= STALL_SILENCE_MS || earlyLimitConfirmed)) {
      engine.permissionWaits.delete(w.terminalId)
      engine.nudges.delete(w.terminalId)
      const rl = engine.rateLimited.get(w.terminalId)
      if (!rl) {
        // `since` — the CONFIRMED-hold stamp: drives the RATE_LIMIT_GRACE_MS
        // requeue clock (unchanged).
        // `holdSince` — when the limit notice ACTUALLY took the screen: the hold
        // BEGAN there, and the execution-time credit must repay the whole wait,
        // not just its confirmed tail (confirmation can take up to
        // STALL_SILENCE_MS). Falls back to `now` when the screen clock is unset.
        engine.rateLimited.set(w.terminalId, { since: now, holdSince: limitSince ?? now })
        // QUOTA SENSOR (the one production write into swarmQuota's cooling
        // table): attribute this sighting to the tier the worker launched on,
        // so dispatch drops a tier — or parks when every tier is dry — instead
        // of re-spawning into the same wall. Reset time resolves worker screen
        // → A5 cache → RATE_LIMIT_GRACE_MS (resolveCoolingUntil). A worker
        // with no recorded/on-ladder model is held exactly as before — it
        // marks nothing (never cool a tier by guess).
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
          `worker rate/usage-limited — holding (no nudge; requeue after ${Math.floor(RATE_LIMIT_GRACE_MS / 60_000)}m)${cooling}: ${w.branch} (${shorten(w.taskTitle)})`,
        )
      } else if (now - rl.since >= RATE_LIMIT_GRACE_MS && outQuietMs >= RATE_LIMIT_SCRAPE_QUIET_MS) {
        // Requeue only while the RAW output channel is also quiet: a worker whose
        // screen still shows the (scrolled-back) notice but is ACTIVELY streaming
        // again is plainly working — never reclaim it on a stale sighting. The
        // decorative-toast case stays covered: one repaint delays the requeue by
        // at most one scrape-quiet window, it can't cancel it.
        endRateLimitHold(engine, w.terminalId, now)
        if (await recoverLost(w, card, { alive, commitsAhead, heartbeat }, 'rate-limit')) next.push(w)
        continue
      }
      next.push(withHeartbeat({ ...w, stage: 'running' }, heartbeat))
      continue
    }

    // Only an ALREADY-SILENT worker (the stall detector's own threshold) is judged
    // for a permission / question WAIT. This is the false-kill fix: a productive
    // worker that merely PRINTS prompt-like text (a plan, a diff, this very code)
    // is still streaming output ⇒ silentMs < STALL_SILENCE_MS ⇒ not silent ⇒
    // never classified, never Enter-nudged, never reclaimed. (`screen`/`output`
    // were sampled above — a worker this silent always crossed the scrape-quiet
    // lull, so the sample is never missing here.)
    if (stall.silentMs >= STALL_SILENCE_MS) {
      // PERMISSION-WAIT — silent at a trust/permission prompt that slipped past
      // bypass (--dangerously-skip-permissions should suppress every prompt; this
      // is the backstop). AUTO-ACCEPT once (Enter takes the trust dialog's default
      // 'Yes'); still prompting past PERMISSION_WAIT_GRACE_MS ⇒ bypass is genuinely
      // broken → park in 'blocked' (NOT 'todo' — a retry hits the same broken bypass
      // and loops). commitsAhead===0 gate: a worker that already produced integrable
      // work is not stuck at a boot dialog, so it takes the ordinary stall path.
      if (output === 'permission-wait' && commitsAhead === 0) {
        endRateLimitHold(engine, w.terminalId, now) // hold (if any) ended — bank it
        engine.nudges.delete(w.terminalId)
        const pw = engine.permissionWaits.get(w.terminalId)
        if (!pw) {
          let sent = false
          try {
            sent = deps.nudge(w.terminalId)
          } catch {
            sent = false
          }
          engine.permissionWaits.set(w.terminalId, { since: now, accepted: sent })
          logLine(
            engine,
            'warn',
            `worker permission/trust prompt — auto-accepted (Enter)${sent ? '' : ' · not delivered'}: ${w.branch} (${shorten(w.taskTitle)})`,
          )
        } else if (now - pw.since >= PERMISSION_WAIT_GRACE_MS) {
          engine.permissionWaits.delete(w.terminalId)
          if (await recoverLost(w, card, { alive, commitsAhead, heartbeat }, 'permission')) next.push(w)
          continue
        }
        next.push(withHeartbeat({ ...w, stage: 'running' }, heartbeat))
        continue
      }

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
      if (output === 'question') {
        endRateLimitHold(engine, w.terminalId, now) // hold (if any) ended — bank it
        engine.permissionWaits.delete(w.terminalId)
        engine.nudges.delete(w.terminalId)
        // Lazy backfill (beside ensureEngine's): a plain engine literal from an
        // older build / a test fixture must still get once-per-question raising.
        engine.questionRaised ??= new Map()
        engine.questionWaits ??= new Map()
        const q = heartbeat?.blocked && engine.overseer?.enabled ? null : detectFreeTextQuestion(screen)
        if (q && deps.raiseQuestion) {
          const receiptKey = defaultReceiptKey({
            projectPath: engine.path,
            taskId: card?.id,
            question: q.question,
          })
          if (engine.questionRaised.get(w.terminalId) !== receiptKey) {
            engine.questionRaised.set(w.terminalId, receiptKey)
            try {
              await deps.raiseQuestion({
                projectPath: engine.path,
                question: q.question,
                context: `worker ${w.branch} (${w.taskTitle}) の claude が入力待ちで停止中に画面から検出した質問。`,
                whyEscalated: 'policy',
                receiptKey,
                ...(card?.id ? { taskId: card.id } : {}),
                branch: w.branch,
                terminalId: w.terminalId,
              })
              logLine(
                engine,
                'warn',
                `worker asked a free-text question — raised to the escalations inbox: ${w.branch} (${shorten(q.question)})`,
              )
            } catch (e) {
              // Raise failed (fs/notify hiccup) → forget the key so the next
              // pass retries; the hold itself is unaffected.
              engine.questionRaised?.delete(w.terminalId)
              logLine(engine, 'warn', `question raise failed (will retry next pass): ${errMsg(e)}`)
            }
          }
        }
        // MF2: BOUND the hold. Stamp on first sight; once held past
        // QUESTION_GRACE_MS, PARK in 'blocked' (recoverLost 'question') to free the
        // slot — the raised question persists in the escalations inbox, and
        // 'blocked' is the human lane (no auto-respawn re-asking). Mirrors the
        // rate-limit / permission grace arms.
        const qw = engine.questionWaits.get(w.terminalId)
        if (!qw) {
          engine.questionWaits.set(w.terminalId, { since: now })
        } else if (now - qw.since >= QUESTION_GRACE_MS) {
          engine.questionWaits.delete(w.terminalId)
          engine.questionRaised?.delete(w.terminalId)
          if (await recoverLost(w, card, { alive, commitsAhead, heartbeat }, 'question')) next.push(w)
          continue
        }
        next.push(withHeartbeat({ ...w, stage: 'running' }, heartbeat))
        continue
      }
    }

    // Reached here ⇒ NOT silent, OR silent with a 'normal' screen ⇒ neither a
    // rate-limit nor a permission wait applies. Drop any stale waiting-state (the
    // worker recovered, or was never in one) and take the ordinary STALL path: a
    // silent worker is NUDGED (Enter) up to STALL_MAX_NUDGES then RECLAIMED
    // (teardown + re-home) like a crash; a still-active one (action 'none') is
    // simply kept. Unchanged from the pre-card stall self-healing (c9fe657).
    // The worker's screen reads NORMAL (or it never stopped working) ⇒ any
    // rate-limit hold it was in has ENDED. Bank that span into the execution-time
    // credit ledger — THIS is the release path a worker takes when a quota wait
    // lifts and it resumes, and the one whose span the runaway check must repay
    // (2026-07-12: 20m of wait charged to a worker that then worked 84m).
    endRateLimitHold(engine, w.terminalId, now)
    engine.permissionWaits.delete(w.terminalId)
    engine.questionRaised?.delete(w.terminalId)
    engine.questionWaits?.delete(w.terminalId)
    if (stall.action === 'reclaim') {
      engine.nudges.delete(w.terminalId)
      // A silent worker is reclaimed like a crash: recoveryColumn (via recoverLost)
      // sends a bare hang to 'todo' (one retry) or 'blocked' (budget spent), never
      // to review — a stall NEVER fakes progress.
      if (await recoverLost(w, card, { alive, commitsAhead, heartbeat }, 'stall')) next.push(w)
      continue
    }
    if (stall.action === 'escalate') {
      // The cheap Enter-nudge budget is spent and the worker is STILL silent — try
      // the ESC+continue escalation exactly once (classifyStall's `escalated` gate)
      // before falling through to reclaim on the pass after this one.
      let sent = false
      try {
        sent = await deps.escalate(w.terminalId, w.taskTitle)
      } catch {
        sent = false
      }
      engine.nudges.set(w.terminalId, { count: STALL_MAX_NUDGES, lastNudgeAt: now, escalated: true })
      logLine(
        engine,
        'warn',
        `worker stalled ${Math.floor(stall.silentMs / 60_000)}m — nudge budget spent, escalating (ESC+continue)` +
          `${sent ? '' : ' · not delivered'}: ${w.branch} (${shorten(w.taskTitle)})`,
        'stall',
      )
      next.push(withHeartbeat({ ...w, stage }, heartbeat))
      continue
    }
    if (stall.action === 'nudge') {
      let sent = false
      try {
        sent = deps.nudge(w.terminalId)
      } catch {
        sent = false
      }
      const count = (engine.nudges.get(w.terminalId)?.count ?? 0) + 1
      engine.nudges.set(w.terminalId, { count, lastNudgeAt: now })
      logLine(
        engine,
        'warn',
        `worker stalled ${Math.floor(stall.silentMs / 60_000)}m — nudged (Enter ${count}/${STALL_MAX_NUDGES})` +
          `${sent ? '' : ' · not delivered'}: ${w.branch} (${shorten(w.taskTitle)})`,
        'stall',
      )
    } else if (stall.progressed && engine.nudges.has(w.terminalId)) {
      // Real progress since the nudge (a fresh heartbeat OR sustained output past
      // the echo guard) proves the Enter woke it — clear the budget so a LATER,
      // independent stall gets the full nudge allowance again.
      engine.nudges.delete(w.terminalId)
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
  const liveTerminalIds = new Set(next.map((w) => w.terminalId))
  for (const id of Array.from(engine.nudges.keys())) {
    if (!liveTerminalIds.has(id)) engine.nudges.delete(id)
  }
  // A terminalId that left the live set is GONE (reclaimed / exited) — drop its
  // hold state outright. Deleting rather than banking is correct here: there is no
  // execution clock left to credit, and terminalIds are never reused.
  for (const id of Array.from(engine.rateLimited.keys())) {
    if (!liveTerminalIds.has(id)) engine.rateLimited.delete(id)
  }
  if (engine.rateLimitHeldMs) {
    for (const id of Array.from(engine.rateLimitHeldMs.keys())) {
      if (!liveTerminalIds.has(id)) engine.rateLimitHeldMs.delete(id)
    }
  }
  if (engine.limitScreen) {
    for (const id of Array.from(engine.limitScreen.keys())) {
      if (!liveTerminalIds.has(id)) engine.limitScreen.delete(id)
    }
  }
  for (const id of Array.from(engine.permissionWaits.keys())) {
    if (!liveTerminalIds.has(id)) engine.permissionWaits.delete(id)
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
        'すべてのモデル tier が使用可能モデル設定で OFF になっているため、worker / 司令官 / 補給官 / ' +
        'レビュアーのいずれも起動できず、dispatch を停止しています。cooling と違い期限で自然回復しません — ' +
        '最低1つの tier を ON に戻すまで swarm は動きません。',
      whyEscalated: 'policy',
      receiptKey: defaultReceiptKey({ projectPath: engine.path, question }),
    })
  } catch (e) {
    engine.spawnBlockSig = undefined // retry the raise on the next pass
    logLine(engine, 'warn', `no-model escalation failed (will retry next pass): ${errMsg(e)}`)
  }
}

// ── The drain pass (the heart — exported for the unit test) ──────────────────

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

  // 2. Monitor existing workers: advance stages, promote the done ones
  //    doing→review, recover crashed AND stalled ones, and prune dead/finished
  //    workers (freeing their slots).
  await monitorWorkers(engine, deps, byId, now)
  if (!engine.running) return // a stop during the (awaiting) monitor halts promptly

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
  const live = engine.workers.filter((w) => deps.isAlive(w.terminalId)).length
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
  // Picking with cap `slots` is exactly the first `slots` of the MAX-capped run
  // (selectDispatch's greedy gate state is prefix-stable), so slice — one probe, no
  // redundant second pass.
  const picks = dispatchable.slice(0, slots)

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

      let spawn: SpawnSwarmWorkerResponse
      try {
        spawn = await deps.spawnWorker({ projectPath: engine.path, title, notes, hint: title, priorFailure })
      } catch (e) {
        logLine(engine, 'error', `dispatch failed: ${shorten(title)} — ${errMsg(e)}`, 'dispatch')
        continue
      }
      if (priorFailure) engine.reworkReasons.delete(card.id) // consumed — injected into this /order

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
        // Launch tier, for the monitor's rate-limit sighting → cooling-table
        // attribution (absent from older fakes/callers — then nothing is marked).
        ...(spawn.model ? { model: spawn.model } : {}),
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
}

// ── The integration pass (Card③ — review → done, the riskiest stage) ─────────

/** ONE integration pass. Throttled to INTEGRATE_TICK_MS inside the loop. In
 *  TWO halves:
 *   A. ALWAYS (while running) — classify every review-column swarm card's
 *      readiness against the trunk, READ-ONLY (no git mutation), and publish it
 *      on engine.reviews. This is the "統合可" display the owner sees whether or
 *      not auto-integrate is armed.
 *   B. ONLY when autoMerge is armed — land the fast-forwardable / cleanly-
 *      rebasable ones on the trunk, move each review→done, and tear its worktree
 *      + branch down. A real rebase CONFLICT is aborted (never auto-resolved),
 *      the card is stamped + left in review, and the branch is remembered so it
 *      isn't re-rebased every pass until it becomes fast-forwardable or leaves
 *      review.
 *  Honors the global stop: it bails the moment engine.running flips false (and
 *  re-checks autoMerge) between cards. Never throws — guarded + logged.
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
  // pass after start (or after arming auto-integrate) runs immediately.
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
  const swarmCards = reviews.filter(
    (c): c is ProjectTask & { branch: string } =>
      typeof c.branch === 'string' && isSwarmBranch(c.branch),
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

  // ── B. MANAGER-ONLY INTEGRATION + RESURRECTION (2026-07-15) — armed = "keep the
  //       commander alive to integrate" ──
  //
  //  The engine NO LONGER integrates. Everything that used to live here — the
  //  high-risk force-hold gate, the verify (tsc/lint/safety/test) gate, the
  //  adversarial LENS panel + its majority vote, the cross-process integration lock,
  //  the FF / rebase push that moved the trunk, the review→done move, the worktree
  //  teardown, and the reworkOrPark / delegateConflict 差し戻し machinery — is GONE
  //  from the armed path. Integration is the COMMANDER's job ALONE now: its own
  //  heavyweight review + manual FF push (skills/og-manage §「マージ」). The safety
  //  nets that used to live here — the fail-closed 0-vote ban and the high-risk
  //  force-hold — now live only in that manual-merge flow (完了条件4; the engine-side
  //  copies are retired, not double-managed — docs/commander/03-integration-review.md).
  //
  //  WHY (the 2026-07-15 incident): autoMerge FF-pushed a hole-y branch onto main
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
  //  (card B, 完了条件1-6): with work WAITING, it checks the desk is up AND responding
  //  (isManagerActive = live PTY + fresh heartbeat), and re-wakes a dead/hung one. The
  //  engine only WAKES — it never integrates on the commander's behalf (完了条件6, reflex
  //  ≠ judgment). A desk that keeps dying escalates instead of looping (完了条件5).
  //
  //  This reflex runs ONLY on the armed path: with autoMerge OFF the human drives the
  //  desk by hand, so an idle-waiting commander is NORMAL and must never be torn down.
  //  Read-only Part A above already published the「統合可」readiness the owner sees
  //  either way.
  if (!engine.autoMerge) return

  const rs = (engine.managerResume ??= { attempts: 0, lastWakeAt: 0, fatalFired: false })

  // No integrable work → the commander isn't needed. DISARM the reflex fully (a later
  // batch starts a clean episode) and stop — we never resuscitate a desk with no work.
  if (swarmCards.length === 0) {
    rs.attempts = 0
    rs.lastWakeAt = 0
    rs.fatalFired = false
    return
  }

  // Work IS waiting. In autopilot the commander must be up AND responding to land it.
  // isManagerActive folds in the heartbeat (card B): a live PTY silent past the stale
  // window reads as HUNG, not present. Slow await, but no trunk mutation follows.
  const active = await deps.isManagerActive(engine.path, now)
  if (!engine.running || !engine.autoMerge) return // owner stop/disarm during the probe
  if (active) {
    // Healthy desk on the job → reflex disarmed (a future silence starts fresh).
    rs.attempts = 0
    rs.fatalFired = false
    return
  }

  // Desk ABSENT (dead PTY) or HUNG (stale heartbeat). Give a freshly-woken one time to
  // boot + emit its first beat before judging again (else the boot gap double-spawns).
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
        `司令官が ${rs.attempts} 回連続で蘇生に失敗 — 統合が止まっています。手動で司令官卓を確認してください` +
          `(Swarm タブ → 司令官)。統合待ち ${swarmCards.length} 件`,
        'integrate',
      )
      // Best-effort escalation (bell + OS toast) — never awaited, internal-catch so a
      // notification fault can't disturb the pass (mirrors the fatal-notify contract).
      deps.notify?.({
        event: 'manager-unrevivable',
        projectPath: engine.path,
        branch: swarmCards[0]?.branch,
        taskTitle: swarmCards[0]?.title || undefined,
        detail: `司令官が ${rs.attempts} 回連続で落ちています(統合待ち ${swarmCards.length} 件)。手動で確認を`,
        logHint: 'Swarm タブ → 司令官 / engine log の integrate 行',
      })
    }
    return
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
  const names = swarmCards.map((c) => c.branch)
  logLine(
    engine,
    woke ? 'info' : 'warn',
    (rs.attempts === 1
      ? 'worker ready — 司令官を起こしました'
      : `司令官が応答しないため蘇生しました(${rs.attempts}回目)`) +
      (woke ? '' : '(使えるモデル tier が無く spawn 保留 — 次 pass で再試行)') +
      `(統合判断は司令官・engine は統合しない): ` +
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
  const liveWorkers = engine.workers.filter((w) => deps.isAlive(w.terminalId))
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
    if (engine.rateLimited.has(w.terminalId) || engine.permissionWaits.has(w.terminalId)) continue
    // Silence across BOTH channels (heartbeat + PTY output) — the same activity
    // notion the stall monitor uses, so a worker streaming output (alive to the
    // engine) is never falsely flagged stale here.
    let lastOut: number | null = null
    try {
      lastOut = deps.lastOutputAt(w.terminalId)
    } catch {
      lastOut = null
    }
    const since = lastActivityMs({ heartbeatAt: w.heartbeatAt, lastOutputAt: lastOut, startedAt: w.startedAt })
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

  return out
}

/** Drop stuck-move entries whose card has LEFT the stuck situation — the move
 *  finally landed (a human moved it / the engine's retry succeeded) or the card
 *  was deleted — so the tracker never surfaces a now-resolved zombie. A COLUMN
 *  rule (not a per-pass touched-set), so it is immune to the integration
 *  throttle (a 'done' entry isn't wrongly pruned on the 4-of-5 ticks the
 *  integrate pass skips):
 *    - 'done'               valid only while the card is still in 'review'.
 *    - 'review' / 'recover' valid only while the card is still in 'doing'.
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
        '差分を確認し、問題なければ手動統合(司令官の「マージ」)で取り込んでください。エンジンはこのカードを自動では統合しません。',
    })
  }

  // 2c. all-workers-down — running, zero live workers, yet 'doing' swarm work left.
  const liveWorkers = engine.workers.filter((w) => deps.isAlive(w.terminalId))
  if (engine.running && liveWorkers.length === 0) {
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
  // Persist the owner's intent so a restart can REMIND (never auto-resume): the
  // engine above is in-memory and always relaunches OFF, but Settings.swarmAutonomyOn
  // survives, and next launch the Swarm UI reads it to offer a one-click resume.
  // Idempotent; cleared by stopOrchestrator (explicit OFF / dismiss).
  await rememberSwarmAutonomy(key)
  if (!engine.running) {
    engine.running = true
    // Reset the integration throttle so the first pass after a (re)start refreshes
    // the readiness display immediately — without this, a stop→start within
    // INTEGRATE_TICK_MS would leave the "統合可" snapshot stale for up to 15s.
    engine.lastIntegrateAt = 0
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
  // autonomyRemembered:true — the marker was just written above (harmless while
  // running, since the UI shows the reminder only while !running); manualStopPersisted:
  // false — the record was just cleared above.
  return stateOf(engine, deps.isAlive, [], true, false)
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
  if (!engine) return { ...emptyState(), manualStop: true, manualStopPersisted: true }
  // Owner EXPLICITLY paused — mark it so maybeAutoStartDrain won't auto-restart the
  // engine on the next poll's idle-slot + todo (so OFF genuinely halts new dispatch,
  // 条件2). Set even on an idempotent OFF (already stopped) so the pause intent sticks
  // until a manual ON clears it. A DEFAULT-off engine (never paused) still auto-drains.
  engine.manualStop = true
  // OVERSEER ASYMMETRY (D1): an explicit autonomy OFF also DISARMS the overseer — the
  // most-dangerous stage never survives a stop (unlike autoMerge/selfSupply, which are
  // temporarily inert while stopped but re-arm on the next start). Combined with
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
  // autonomyRemembered:false — the marker was just cleared above; manualStopPersisted:
  // true — the record was just written above.
  return stateOf(engine, deps.isAlive, [], false, true)
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
  const live = engine.workers.filter((w) => deps.isAlive(w.terminalId)).length
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
    const w = engine.workers.find((x) => x.terminalId === terminalId)
    if (!w) return stateOf(engine, deps.isAlive) // unknown / already gone — idempotent

    // Tear the worktree + PTY down FIRST (the zombie-eradication — idempotent, and
    // the critical guarantee). Best-effort: a failure is logged, never blocks the stop.
    let teardown: { removed: boolean; reason?: string; wip?: WipCommitResult } = { removed: false }
    try {
      // 'stopped' — an OWNER stop. Its uncommitted work is salvaged onto the branch
      // like any other teardown: the owner stopped the worker, not the work.
      teardown = await deps.recoverWorker({ projectPath: key, worktree: w.worktree, terminalId, reason: 'stopped' })
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
    engine.workers = engine.workers.filter((x) => x.terminalId !== terminalId)
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
    for (const w of owned) {
      try {
        await deps.recoverWorker({
          projectPath: key,
          worktree: w.worktree,
          terminalId: w.terminalId,
          reason: 'stopped', // salvage any uncommitted work onto the branch first
        })
      } catch {
        /* best-effort teardown — the card already left review, which is the point */
      }
    }
    if (owned.length) engine.workers = engine.workers.filter((w) => !owned.includes(w))

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
  const engine = store.engines.get(key)
  if (!engine) {
    return { ...emptyState(), autonomyRemembered: remembered, manualStop: stopped, manualStopPersisted: stopped }
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
  return stateOf(engine, deps.isAlive, tasks, remembered, stopped)
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

/** Arm / disarm auto-integration (Card③), idempotent. A SEPARATE switch from the
 *  drain (start/stop) — default OFF. It only ever takes effect while the engine
 *  is `running` (the drain ON), so flipping it ON while the engine is stopped
 *  records the intent but integrates nothing until the engine is started — and
 *  stopping the engine (the global stop) halts integration too. Arming it resets
 *  the integration throttle so the next tick acts promptly. */
export const setAutoMerge = async (
  projectPath: string,
  enabled: boolean,
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  const engine = getOrCreateEngine(key)
  if (engine.autoMerge !== enabled) {
    engine.autoMerge = enabled
    logLine(engine, 'info', enabled ? 'auto-integrate ON' : 'auto-integrate OFF')
    if (enabled) engine.lastIntegrateAt = 0 // act on the next tick, not 15s later
  }
  return stateOf(engine, deps.isAlive)
}

/** Arm / disarm SELF-SUPPLY (card b3fbbfba), idempotent. The owner-gated switch
 *  for the engine proposing its OWN improvement cards. A SEPARATE switch from the
 *  drain (start/stop) and from auto-integration — default OFF, in-memory only (a
 *  restart re-arms OFF, fail-safe). Like autoMerge it only takes effect while the
 *  engine is `running`; arming it zeroes the scan throttle so the next tick scans
 *  promptly. Proposed cards are STILL owner-approval-gated before any dispatch —
 *  arming this only lets the engine FILL todo, never auto-run what it proposed. */
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
  }
  return stateOf(engine, deps.isAlive)
}

/** Arm / disarm the OVERSEER (EPIC C / C-core), idempotent — the owner-gated THIRD
 *  toggle (D1). SEPARATE from the drain (start/stop), autoMerge, and selfSupply;
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
    return stateOf(engine, deps.isAlive)
  }
  if (engine.overseer.enabled !== enabled) {
    engine.overseer.enabled = enabled
    logLine(engine, 'info', enabled ? 'overseer ON' : 'overseer OFF')
    if (!enabled) engine.overseer.brainAbort?.abort() // stop a brain mid-flight
  }
  return stateOf(engine, deps.isAlive)
}

// ── Test seam ────────────────────────────────────────────────────────────────

/** Drop all engine state — for hermetic route/engine tests (mirrors
 *  __resetMigrationCacheForTests). Cancels any pending timers first. */
export const __resetOrchestratorForTests = (): void => {
  store.engines.forEach((e) => {
    if (e.timer) clearTimeout(e.timer)
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
