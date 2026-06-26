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
import { readFile, stat, symlink } from 'fs/promises'
import { join, resolve, dirname, basename } from 'path'
import { createHash, randomUUID } from 'crypto'
import { canonicalize } from './canonicalize'
import { openGroundHome } from './paths'
import { getTerminal, getTerminalScreen, killTerminal, writeInput } from './terminal'
import { claudeRunPreflight } from './claudePreflight'
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
  SwarmOrchestratorState,
} from '../types'

const execFile = promisify(execFileCb)

// ── Tunables ────────────────────────────────────────────────────────────────

/** Concurrency ceiling — the engine never has more live workers of its own than
 *  this. Mirrors the Swarm UI's MAX_WORKERS (SwarmModule.tsx); the two are
 *  independent counters (the UI's is per-client localStorage), but the engine is
 *  the only autonomous driver, so in practice this is THE cap when it's ON. */
export const ORCHESTRATOR_MAX_WORKERS = 6

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

/** RUNAWAY CEILING — the HARD wall-clock cap on one worker's lifetime, measured
 *  from dispatch. A worker still alive past this is a 暴走 (a task too big, an
 *  infinite /order loop, a wedge the silence detector can't see because it keeps
 *  emitting output): the engine STOPS it (teardown + re-home to 'blocked') and
 *  logs why, regardless of liveness — this is the one check that fires on a busy
 *  worker, not just a silent one. Generous by default (a real /order round —
 *  audit→implement→verify→integrate — legitimately runs long; the whole point of
 *  the swarm is heavy, unhurried work), so it never guillotines productive work;
 *  it only catches the genuinely-unbounded. Adjustable via env. NOTE: it counts
 *  wall-clock INCLUDING any rate-limit waits — kept simple on purpose; the band
 *  is wide enough that a normal worker that paused for a limit still finishes
 *  well under it. Min 10m guards against an env typo bricking every worker. */
export const MAX_EXEC_MS = envMinutesMs('OPENGROUND_SWARM_MAX_EXEC_MIN', 90, 10, 600)

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

/** PERMISSION-WAIT GRACE — how long after auto-accepting a startup permission /
 *  trust prompt the engine waits for the worker to move on before parking it in
 *  'blocked'. Workers launch with permissionMode:'bypass'
 *  (--dangerously-skip-permissions), so a prompt should NEVER appear; this is the
 *  backstop for when one slips through anyway (a `claude` that ignored bypass, an
 *  unexpected first-run dialog). Short — once Enter accepts the (default-Yes)
 *  trust dialog the worker proceeds within seconds; still stuck after this means
 *  bypass is genuinely broken and a human is needed. */
export const PERMISSION_WAIT_GRACE_MS = 2 * 60_000

// ── Pure helpers (exported, unit-tested without a server) ────────────────────

/** A Board card sitting in the `todo` column — mirrors BoardTab's columnOf
 *  (undefined boardColumn folds to 'done' when done, else 'todo'). */
export const isTodoCard = (t: ProjectTask): boolean =>
  (t.boardColumn ?? (t.done ? 'done' : 'todo')) === 'todo'

/** A Board card sitting in the `review` column — the integration stage's input.
 *  (An undefined column never folds to 'review', so the explicit check suffices.) */
export const isReviewCard = (t: ProjectTask): boolean => t.boardColumn === 'review'

const cmpCreatedAt = (a: ProjectTask, b: ProjectTask): number =>
  (a.createdAt ?? '').localeCompare(b.createdAt ?? '')

/** Queue order = how the Board renders the todo column, so the engine pulls what
 *  the owner sees at the top first: cards with an explicit boardOrder ascending
 *  (the drag priority), THEN un-ordered cards oldest-createdAt first ("古い順").
 *  Matches ProjectTask.boardOrder's documented contract ("Undefined sorts after
 *  ordered cards by createdAt"). Pure + total (stable tiebreak). */
export const sortTodos = (todos: readonly ProjectTask[]): ProjectTask[] =>
  [...todos].sort((a, b) => {
    const ao = a.boardOrder
    const bo = b.boardOrder
    if (ao != null && bo != null) return ao !== bo ? ao - bo : cmpCreatedAt(a, b)
    if (ao != null) return -1 // an ordered card precedes an un-ordered one
    if (bo != null) return 1
    return cmpCreatedAt(a, b)
  })

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

/** The next cards to dispatch this pass. Queue order (sortTodos), gated by FIVE
 *  independent rules so the engine never starts unsafe parallel work:
 *    ① COLUMN  — only `todo` cards are ever candidates. blocked / doing / review /
 *       done are filtered out here (the gate lives in this function, not just the
 *       caller, so it holds even if a mixed list is passed in).
 *    ② ID      — a card already in flight (its id in `dispatchedIds`, i.e. a
 *       counted worker) is skipped — no re-dispatch of the same card.
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

const shorten = (s: string, n = 60): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat || '(untitled)'
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

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
  /** Commits the worker's branch carries AHEAD of trunk (origin/main). 0 ⇒ no
   *  integrable work yet (a freshly-branched or empty-handed worker). */
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
export type WorkerRecoveryReason = 'crash' | 'stall' | 'runaway' | 'rate-limit' | 'permission'

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
  if (reason === 'runaway' || reason === 'permission') return 'blocked'
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
 *    • silent, nudges spent, cooldown elapsed ⇒ 'reclaim' (tear down + re-home).
 *
 *  ECHO HANDLING (the load-bearing subtlety): a bare Enter makes a `claude` TUI
 *  repaint, stamping PTY output. So output landing within `echoGuardMs` AFTER our
 *  own nudge is DISCOUNTED — it counts as life for NEITHER the silence gate NOR
 *  the recovery signal. Otherwise the nudge's own echo would keep a wedged worker
 *  looking "alive" (dodging reclaim) and would falsely reset its budget.
 *
 *  `progressed` = REAL recovery since the last nudge, by EITHER channel: a fresh
 *  heartbeat (an echo can't write one — /order phases do), OR sustained output PAST
 *  the echo guard (a one-shot repaint can't). Both are needed because heartbeats
 *  are SPARSE (only at phase boundaries): a worker the nudge genuinely revived
 *  often resumes streaming output for many minutes before it next beats, and that
 *  real progress MUST clear the budget — else its next, independent stall would
 *  reclaim with zero nudges. The caller clears the nudge counter when `progressed`. */
export const classifyStall = (
  input: {
    /** Heartbeat epoch ms, or null if it never beat. */
    heartbeatAtMs: number | null
    /** PTY last-output epoch ms, or null if none. */
    lastOutputAtMs: number | null
    /** Dispatch epoch ms — the activity floor (a just-spawned worker isn't silent). */
    startedAtMs: number
    /** Prior nudge bookkeeping, or undefined if never nudged. */
    nudge: { count: number; lastNudgeAt: number } | undefined
  },
  now: number,
  p: StallParams,
): { action: 'none' | 'nudge' | 'reclaim'; progressed: boolean; silentMs: number } => {
  const count = input.nudge?.count ?? 0
  const lastNudgeAt = input.nudge?.lastNudgeAt ?? 0

  // Discount the Enter echo: output within echoGuardMs after our nudge is the TUI
  // repaint, not life. Kept output is either pre-nudge or sustained past the guard.
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
  // Real recovery since the nudge — a fresh heartbeat OR real (post-echo-guard)
  // output strictly after it. Either clears the budget; an echo can fake neither.
  const progressed =
    count > 0 &&
    ((input.heartbeatAtMs !== null && input.heartbeatAtMs > lastNudgeAt) ||
      (realOutput !== null && realOutput > lastNudgeAt))

  if (silentMs < p.stallMs) return { action: 'none', progressed, silentMs } // alive
  if (count > 0) {
    if (progressed) return { action: 'none', progressed: true, silentMs } // recovered; re-stall handled fresh next pass
    if (now - lastNudgeAt < p.cooldownMs) return { action: 'none', progressed: false, silentMs } // give the nudge time
    if (count >= p.maxNudges) return { action: 'reclaim', progressed: false, silentMs } // nudges spent, still silent
  }
  return { action: 'nudge', progressed: false, silentMs }
}

/** Strip ANSI/CSI escape sequences and collapse whitespace, lowercased — so the
 *  output classifier below matches against the clean text a human reads, immune
 *  to the cursor-addressing a `claude` TUI interleaves (and to a raw-buffer
 *  fallback that still carries escapes). Pure. */
const normalizeScreen = (s: string): string =>
  s
    // CSI / OSC / single-char escapes — enough to clear the sequences claude emits.
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\][^]*(?:|\\)/g, '')
    .replace(/[@-Z\\-_]/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()

/** High-precision markers that a worker's `claude` is WAITING on a rate / usage /
 *  quota / overload limit — a legitimate pause, NOT a hang. Matched against the
 *  normalized screen text. Deliberately tuned to claude's RUNTIME messages
 *  ("usage limit reached", an API overload error, a backoff "retrying in 30s"),
 *  which a worker editing source would not reproduce verbatim — so a worker
 *  literally writing rate-limit CODE is rarely misread. The residual risk is a
 *  FALSE POSITIVE (extra grace for a worker that isn't really limited), the SAFE
 *  direction: it never kills, and the runaway ceiling still backstops a worker
 *  that genuinely never progresses. A false NEGATIVE would be the dangerous one
 *  (reclaiming a real waiter) — hence the bias toward catching the limit. */
export const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /usage limit/, // "claude usage limit reached", "approaching your usage limit"
  /limit (?:will )?reset/, // "your limit will reset at 3pm", "limit resets in…"
  /\boverloaded_error\b/,
  /\brate_limit_error\b/,
  /api error[^.]{0,40}\b(?:429|500|503|529|overloaded)\b/,
  /\b(?:429|529)\b[^.]{0,40}\boverloaded\b/,
  /too many requests/,
  /retrying in \d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes)\b/,
]

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

/** Classify a worker's current screen into WHY it might not be progressing:
 *    • 'permission-wait' — a startup trust/permission dialog is blocking it.
 *    • 'rate-limited'    — it is waiting on a usage/quota/overload limit.
 *    • 'normal'          — neither; ordinary work (the silence-based stall path
 *                          then applies if it has also gone quiet).
 *  Permission is checked first: at boot it blocks ALL progress and is the more
 *  urgent unblock. PURE (the only input is the text) — the TIMING gates (startup
 *  window, grace clocks) live in the monitor, so this stays trivially testable.
 *  A null/empty screen ⇒ 'normal' (no signal — never invent a wait). */
export const classifyOutput = (
  screen: string | null,
): 'rate-limited' | 'permission-wait' | 'normal' => {
  if (!screen) return 'normal'
  const text = normalizeScreen(screen)
  if (!text) return 'normal'
  if (PERMISSION_PROMPT_PATTERNS.some((re) => re.test(text))) return 'permission-wait'
  if (RATE_LIMIT_PATTERNS.some((re) => re.test(text))) return 'rate-limited'
  return 'normal'
}

/** Has a worker blown the hard execution ceiling — a 暴走 to stop? True iff its
 *  dispatch time is known (finite, > 0) and `maxExecMs` has elapsed since. The
 *  finite/positive guard is load-bearing: a worker with an unparseable / missing
 *  startedAt is NEVER judged runaway (no false kill on a clockless fixture). Pure
 *  (clock injected). */
export const isRunaway = (startedAtMs: number, now: number, maxExecMs: number): boolean =>
  Number.isFinite(startedAtMs) && startedAtMs > 0 && now - startedAtMs >= maxExecMs

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
  /** Auto-integration armed (Card③) — a SEPARATE switch from `running`, default
   *  OFF. Only ever acts while `running` (turning the engine off = global stop). */
  autoMerge: boolean
  /** True while a pass is mid-flight — the re-entrancy guard that GUARANTEES no two
   *  passes ever overlap (twin-dispatch defense). The setTimeout chain already
   *  serializes the SCHEDULED passes, but a stop→start within a slow pass's await
   *  window (or any future second driver) could otherwise run two passes at once,
   *  both reading the same pre-spawn worker set and dispatching the same card
   *  twice. runEnginePass check-and-sets this synchronously at entry, so the second
   *  pass bails before it can spawn. In-memory only. */
  passInFlight: boolean
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
  /** Wall-clock (ms) of the last integration pass — the INTEGRATE_TICK_MS gate. */
  lastIntegrateAt: number
  /** How many times each card (taskId) has been RE-QUEUED after a lost worker —
   *  the {@link recoveryColumn} retry budget. Bumped on a 'todo' requeue, reset
   *  when the card is parked in 'blocked' (so a human requeue starts fresh) or
   *  succeeds/leaves the retry cycle. In-memory only. */
  recoveries: Map<string, number>
  /** Cards whose Board COLUMN MOVE is stuck (kept pass after pass) — keyed by
   *  taskId. The anti-zombie tracker: bumped on every kept move, cleared when the
   *  move lands, escalated to 'blocked' (recovery) / surfaced as a 'move-stuck'
   *  anomaly once past {@link MOVE_STUCK_MAX_RETRIES}. See {@link StuckMove}.
   *  Pruned by board column (pruneStuckMoves) the moment a card leaves the stuck
   *  situation, so a resolved zombie never lingers. In-memory only. */
  stuckMoves: Map<string, StuckMove>
  /** Per-worker (keyed by terminalId) Enter-nudge bookkeeping for STALL recovery:
   *  how many times we've nudged this silent-but-alive worker and when last.
   *  Bumped on each nudge, cleared on real recovery (a post-nudge heartbeat) or
   *  when the worker leaves the live set (reclaimed / promoted-and-exited). Keyed
   *  by terminalId — not taskId — so a re-dispatched card's fresh worker gets a
   *  fresh budget. In-memory only. (Card stall self-healing.) */
  nudges: Map<string, { count: number; lastNudgeAt: number }>
  /** Per-worker (keyed by terminalId) RATE-LIMIT bookkeeping: when we first saw
   *  this worker waiting on a usage/quota/overload limit (`since`, epoch ms). Set
   *  the pass its screen first reads as rate-limited, cleared the moment its
   *  screen reads normal again (it resumed) or it leaves the live set. Drives the
   *  "hold, don't nudge, requeue only after RATE_LIMIT_GRACE_MS" path — NOT the
   *  stall clock. In-memory only. (Card 4880e9c6 — 進まない分類.) */
  rateLimited: Map<string, { since: number }>
  /** Per-worker (keyed by terminalId) PERMISSION-WAIT bookkeeping for a startup
   *  trust/permission prompt that slipped past bypass: `since` (epoch ms first
   *  seen) and whether the auto-accept Enter was delivered. Set on first sight in
   *  the startup window, cleared when the screen reads normal or the worker leaves
   *  the live set. Drives the auto-accept → park-if-persists path. In-memory only.
   *  (Card 4880e9c6.) */
  permissionWaits: Map<string, { since: number; accepted: boolean }>
  /** Drain/dispatch/integrate journal (ring buffer, oldest-first). */
  log: OrchestratorLogLine[]
  /** State inconsistencies detected on the latest pass (read-only — see
   *  detectAnomalies). Rebuilt every pass; surfaced verbatim by the state API. */
  anomalies: OrchestratorAnomaly[]
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
      autoMerge: false,
      passInFlight: false,
      generation: 0,
      timer: null,
      workers: [],
      reviews: [],
      conflictedBranches: new Set(),
      verifyFailed: new Map(),
      lastIntegrateAt: 0,
      recoveries: new Map(),
      stuckMoves: new Map(),
      nudges: new Map(),
      rateLimited: new Map(),
      permissionWaits: new Map(),
      log: [],
      anomalies: [],
    }
    store.engines.set(key, engine)
  } else {
    // Defensive backfill: an engine persisted on globalThis by an EARLIER build
    // (a `tsx watch` reload across the commit that added stage ③) predates the
    // integration fields, so a bare `engine.conflictedBranches.has(...)` would
    // throw. Materialize any missing field once on retrieval. Harmless in prod
    // (forked fresh each boot); it only ever fires on a dev hot-reload.
    engine.autoMerge ??= false
    engine.passInFlight ??= false
    engine.generation ??= 0
    engine.reviews ??= []
    engine.conflictedBranches ??= new Set()
    engine.verifyFailed ??= new Map()
    engine.lastIntegrateAt ??= 0
    engine.anomalies ??= []
    engine.recoveries ??= new Map()
    engine.stuckMoves ??= new Map()
    engine.nudges ??= new Map()
    engine.rateLimited ??= new Map()
    engine.permissionWaits ??= new Map()
  }
  return engine
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

const emptyState = (): SwarmOrchestratorState => ({
  running: false,
  autoMerge: false,
  workers: [],
  reviews: [],
  log: [],
  anomalies: [],
  maxWorkers: ORCHESTRATOR_MAX_WORKERS,
})

/** Public state snapshot. Reports only *live* workers (a dead PTY is filtered
 *  out without mutating engine.workers — the pass with its slot-freed log is the
 *  authoritative pruner) so the count the UI shows matches the cap math. */
const stateOf = (engine: ProjectEngine, isAlive: (id: string) => boolean): SwarmOrchestratorState => ({
  running: engine.running,
  autoMerge: engine.autoMerge,
  workers: engine.workers.filter((w) => isAlive(w.terminalId)),
  reviews: [...engine.reviews],
  log: [...engine.log],
  anomalies: [...engine.anomalies],
  maxWorkers: ORCHESTRATOR_MAX_WORKERS,
})

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
  /** Spawn one isolated worker for a goal (worktree + claude PTY + /order). */
  spawnWorker: (opts: {
    projectPath: string
    title: string
    notes?: string
    hint?: string
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
   *  {removed:false, reason} on failure (logged; never throws into the loop). */
  recoverWorker: (opts: {
    projectPath: string
    worktree: string
    terminalId: string
  }) => Promise<{ removed: boolean; reason?: string }>
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
  /** The worker PTY's CURRENT visible screen as plain text (the headless `claude`
   *  TUI frame), or null when unknown. Read-only. The orchestrator classifies it
   *  (classifyOutput) to tell WHY a non-promoting worker isn't progressing — a
   *  usage/rate-limit WAIT or a startup permission prompt — rather than treating
   *  every quiet worker as a stall. (Card 4880e9c6 — 進まない分類.) */
  recentOutput: (terminalId: string) => string | null
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
   *  when the branch's tip equals it, return `skipped` without running the check. */
  verify: (
    projectPath: string,
    branch: string,
    target: string,
    opts?: { skipIfTip?: string },
  ) => Promise<{ ok: boolean; tip: string | null; reason?: string; skipped?: boolean }>
  /** Land one branch on the trunk (FF / rebase / conflict). Never forces. */
  integrate: (projectPath: string, branch: string, target: string) => Promise<IntegrateOutcome>
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

/** Trunk refs a `swarm/*` branch is measured against, most- to least-preferred
 *  (mirrors swarmWorker's base preference — workers branch off origin/main). */
const COMMIT_BASE_PREFERENCE = ['origin/main', 'main'] as const

/** Count commits the worker's branch carries ahead of trunk. Uses the shared
 *  repo + branch ref (not the worktree path), so it still works after the
 *  worktree is removed. 0 when no trunk ref resolves or the branch is gone
 *  (conservative — no provable work ⇒ no promotion). */
const defaultCountCommitsAhead = async (projectPath: string, branch: string): Promise<number> => {
  if (!branch) return 0
  for (const base of COMMIT_BASE_PREFERENCE) {
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

/** Tear down a lost/stopped worker's worktree + PTY. Kills the PTY by id FIRST
 *  (covers the symlinked-home cwd-miss that removeSwarmWorktree's by-cwd kill can
 *  drop), then force-removes the worktree (which also kills any PTY by cwd and is
 *  idempotent — already-gone reads as removed). Branch is intentionally KEPT (see
 *  the dep doc). Never throws — a failure is reported for the log. */
const defaultRecoverWorker = async (opts: {
  projectPath: string
  worktree: string
  terminalId: string
}): Promise<{ removed: boolean; reason?: string }> => {
  try {
    killTerminal(opts.terminalId)
  } catch {
    /* already dead / absent — the worktree teardown below is what matters */
  }
  if (!opts.worktree) return { removed: false, reason: 'no worktree path on record' }
  try {
    return await removeSwarmWorktree(opts.projectPath, opts.worktree, { force: true })
  } catch (e) {
    return { removed: false, reason: errMsg(e) }
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

/** The worker PTY's current visible screen (headless `claude` TUI frame), or null
 *  — the source classifyOutput inspects to spot a rate-limit wait / permission
 *  prompt. Read-only (terminal.ts reconstructs the frame without touching the PTY). */
const defaultRecentOutput = (terminalId: string): string | null => getTerminalScreen(terminalId)

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

/** Build the real `verify` dep from a {@link VerifyCheck}. The worktree mechanics
 *  are identical for any check, so they live here once and the test drives the
 *  WHOLE real path (tip-resolve → rebase → symlink → check → teardown) with a fake
 *  verdict. The verified tree is the branch REBASED ONTO THE TRUNK — what
 *  `integrate` actually pushes — so a branch that compiled against an older trunk
 *  but breaks against the current one is caught. A non-FF / conflicting /
 *  unbuildable case never FALSE-blocks (returns ok:true with a reason); a real
 *  rebase conflict is deferred to `integrate` (which stamps it). */
export const makeVerify =
  (check: VerifyCheck): IntegrationDeps['verify'] =>
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
    if (!(await check.applicable(projectPath))) {
      return { ok: true, tip, reason: 'no typecheck configured' } // can't verify ⇒ don't block
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
      // Symlink node_modules from the MAIN checkout (complete + correct) so tsc
      // resolves types reliably — a fresh worktree has none, and a swarm worktree's
      // own node_modules can be incomplete.
      try {
        await symlink(join(projectPath, 'node_modules'), join(dir, 'node_modules'))
      } catch {
        /* best-effort; if it fails the check below reports the real breakage */
      }
      const r = await check.run(dir)
      return { ok: r.ok, tip, reason: r.ok ? undefined : r.output }
    } finally {
      await gitOut(projectPath, ['worktree', 'remove', '--force', dir])
      await gitOut(projectPath, ['worktree', 'prune'])
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
  recentOutput: defaultRecentOutput,
  fetchReview: defaultFetchReview,
  prepareTarget: defaultPrepareTarget,
  classify: classifyBranch,
  verify: makeVerify(tscCheck),
  integrate: defaultIntegrate,
  moveToDone: defaultMoveToDone,
  markConflict: defaultMarkConflict,
  cleanup: defaultCleanup,
  killPty: killTerminal,
  worktreeExists: defaultWorktreeExists,
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
 *     'done' dot); drop once it exits — that's when the slot truly frees.
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
              : 'lost'
    let teardown: { removed: boolean; reason?: string } = { removed: false }
    try {
      teardown = await deps.recoverWorker({
        projectPath: engine.path,
        worktree: w.worktree,
        terminalId: w.terminalId,
      })
    } catch {
      /* reported via teardown.removed=false below */
    }
    const keptNote = teardown.removed ? '' : ` · worktree kept (${teardown.reason ?? '?'})`

    // Only re-home a card STILL in 'doing' (ours to move). A deleted card has
    // nothing to move; a human-moved one is the human's now — clean, don't fight.
    if (!card || columnOf(card) !== 'doing') {
      engine.recoveries.delete(w.taskId)
      clearKeptMove(engine, w.taskId) // card left 'doing' (human/deleted) — nothing stuck
      logLine(
        engine,
        'info',
        `worker ${verb} — slot freed: ${w.branch} (${shorten(w.taskTitle)})${keptNote}`,
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
      `worker ${verb} — card → ${col}: ${w.branch} (${shorten(w.taskTitle)})${keptNote}`,
      reason === 'stall' ? 'stall' : reason === 'crash' ? 'crash' : undefined,
    )
    return false
  }

  for (const w of engine.workers) {
    if (!engine.running) {
      next.push(w) // a stop mid-pass: keep the rest untouched
      continue
    }
    const alive = deps.isAlive(w.terminalId)
    const card = byId.get(w.taskId)

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

    const { promote, stage } = classifyWorker(
      { alive, commitsAhead, heartbeat },
      sinceStart(w.startedAt) >= STARTUP_GRACE_MS,
    )

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
        // a worker that already exited has nothing left to count.
        if (alive) next.push(withHeartbeat({ ...w, stage: 'done' }, heartbeat))
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
    if (isRunaway(startedMs, now, MAX_EXEC_MS)) {
      engine.nudges.delete(w.terminalId)
      engine.rateLimited.delete(w.terminalId)
      engine.permissionWaits.delete(w.terminalId)
      logLine(
        engine,
        'warn',
        `worker runaway — alive ${Math.floor((now - startedMs) / 60_000)}m ≥ ${Math.floor(MAX_EXEC_MS / 60_000)}m execution limit: ${w.branch} (${shorten(w.taskTitle)})`,
      )
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
    const stall = classifyStall(
      {
        heartbeatAtMs: Number.isFinite(hbMs) ? hbMs : null,
        lastOutputAtMs: lastOut,
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

    // Only an ALREADY-SILENT worker (the stall detector's own threshold) is judged
    // for a rate-limit / permission WAIT. This is the false-kill fix: a productive
    // worker that merely PRINTS limit-/prompt-like text (a plan, a diff, this very
    // code) is still streaming output ⇒ silentMs < STALL_SILENCE_MS ⇒ not silent ⇒
    // never classified, never Enter-nudged, never reclaimed. Reading the screen only
    // when silent also avoids a per-pass TUI scrape for every busy worker.
    if (stall.silentMs >= STALL_SILENCE_MS) {
      let screen: string | null = null
      try {
        screen = deps.recentOutput(w.terminalId)
      } catch {
        /* unknown → classifyOutput('normal') → ordinary stall handling below */
      }
      const output = classifyOutput(screen)

      // RATE-LIMIT WAIT — silent because it is waiting on a usage/quota/overload
      // limit, NOT wedged. Enter can't lift a limit and reclaiming throws away
      // committed work + re-dispatches into the same wall, so the engine does
      // NEITHER: it HOLDS the worker (dropping any stall-nudge budget) and only
      // requeues to 'todo' once STILL limited past RATE_LIMIT_GRACE_MS (slot
      // recovery; the branch keeps its commits, a later attempt retries when the
      // limit resets). `since` is stamped once and persists across passes.
      if (output === 'rate-limited') {
        engine.permissionWaits.delete(w.terminalId)
        engine.nudges.delete(w.terminalId)
        const rl = engine.rateLimited.get(w.terminalId)
        if (!rl) {
          engine.rateLimited.set(w.terminalId, { since: now })
          logLine(
            engine,
            'warn',
            `worker rate/usage-limited — holding (no nudge; requeue after ${Math.floor(RATE_LIMIT_GRACE_MS / 60_000)}m): ${w.branch} (${shorten(w.taskTitle)})`,
          )
        } else if (now - rl.since >= RATE_LIMIT_GRACE_MS) {
          engine.rateLimited.delete(w.terminalId)
          if (await recoverLost(w, card, { alive, commitsAhead, heartbeat }, 'rate-limit')) next.push(w)
          continue
        }
        next.push(withHeartbeat({ ...w, stage: 'running' }, heartbeat))
        continue
      }

      // PERMISSION-WAIT — silent at a trust/permission prompt that slipped past
      // bypass (--dangerously-skip-permissions should suppress every prompt; this
      // is the backstop). AUTO-ACCEPT once (Enter takes the trust dialog's default
      // 'Yes'); still prompting past PERMISSION_WAIT_GRACE_MS ⇒ bypass is genuinely
      // broken → park in 'blocked' (NOT 'todo' — a retry hits the same broken bypass
      // and loops). commitsAhead===0 gate: a worker that already produced integrable
      // work is not stuck at a boot dialog, so it takes the ordinary stall path.
      if (output === 'permission-wait' && commitsAhead === 0) {
        engine.rateLimited.delete(w.terminalId)
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
    }

    // Reached here ⇒ NOT silent, OR silent with a 'normal' screen ⇒ neither a
    // rate-limit nor a permission wait applies. Drop any stale waiting-state (the
    // worker recovered, or was never in one) and take the ordinary STALL path: a
    // silent worker is NUDGED (Enter) up to STALL_MAX_NUDGES then RECLAIMED
    // (teardown + re-home) like a crash; a still-active one (action 'none') is
    // simply kept. Unchanged from the pre-card stall self-healing (c9fe657).
    engine.rateLimited.delete(w.terminalId)
    engine.permissionWaits.delete(w.terminalId)
    if (stall.action === 'reclaim') {
      engine.nudges.delete(w.terminalId)
      // A silent worker is reclaimed like a crash: recoveryColumn (via recoverLost)
      // sends a bare hang to 'todo' (one retry) or 'blocked' (budget spent), never
      // to review — a stall NEVER fakes progress.
      if (await recoverLost(w, card, { alive, commitsAhead, heartbeat }, 'stall')) next.push(w)
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

  // Forget per-worker bookkeeping (nudge budget + rate-limit / permission-wait
  // tracking) for workers no longer in the live set (reclaimed, promoted-and-
  // exited, crashed) — all keyed by terminalId, so a worker that survives this
  // pass keeps its state while a departed one's is dropped. Prevents a stale entry
  // from ever outliving its worker (and from leaking onto a future spawn's id).
  const liveTerminalIds = new Set(next.map((w) => w.terminalId))
  for (const id of Array.from(engine.nudges.keys())) {
    if (!liveTerminalIds.has(id)) engine.nudges.delete(id)
  }
  for (const id of Array.from(engine.rateLimited.keys())) {
    if (!liveTerminalIds.has(id)) engine.rateLimited.delete(id)
  }
  for (const id of Array.from(engine.permissionWaits.keys())) {
    if (!liveTerminalIds.has(id)) engine.permissionWaits.delete(id)
  }

  engine.workers = next
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

  // 4. Fill open slots with the next queue-order todos. A slot is occupied by any
  //    LIVE worker (a 'done' worker whose PTY still lingers still holds its slot —
  //    the integration stage frees it by tearing the worktree down); a dead
  //    worker kept only to retry a board write does not.
  const slots = ORCHESTRATOR_MAX_WORKERS - engine.workers.filter((w) => deps.isAlive(w.terminalId)).length
  // selectDispatch owns ALL dispatch gates (column / id / content-dup / same-file
  // serialization), so it takes the FULL board, not just the todo slice: it needs
  // the doing-column cards to know which conflict surfaces are already claimed.
  const picks = selectDispatch(tasks, countedIds, slots)
  for (const card of picks) {
    if (!engine.running) return // a stop mid-pass halts promptly
    const title = card.title ?? ''
    const notes = typeof card.notes === 'string' ? card.notes : undefined

    let spawn: SpawnSwarmWorkerResponse
    try {
      spawn = await deps.spawnWorker({ projectPath: engine.path, title, notes, hint: title })
    } catch (e) {
      logLine(engine, 'error', `dispatch failed: ${shorten(title)} — ${errMsg(e)}`, 'dispatch')
      continue
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
    })
    logLine(engine, 'info', `dispatch: ${shorten(title)} → ${spawn.branch}`, 'dispatch')

    try {
      if (!(await deps.moveToDoing(engine.path, card.id, spawn.branch))) {
        logLine(engine, 'warn', `column move kept (will retry): ${shorten(title)}`)
      }
    } catch (e) {
      logLine(engine, 'warn', `column move kept (will retry): ${shorten(title)} — ${errMsg(e)}`)
    }
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
 *  re-checks autoMerge) between cards. Never throws — guarded + logged. */
export const runIntegratePass = async (
  engine: ProjectEngine,
  deps: IntegrationDeps,
): Promise<void> => {
  if (!engine.running) return
  // Throttle: skip ticks until INTEGRATE_TICK_MS has passed (the loop still
  // ticks every TICK_MS for dispatch). lastIntegrateAt starts at 0 so the first
  // pass after start (or after arming auto-integrate) runs immediately.
  const now = Date.now()
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

  // Forget conflict + verify-fail memos for branches no longer in review (card
  // moved/finished) — a fresh attempt at that branch should re-classify cleanly.
  const present = new Set(swarmCards.map((c) => c.branch))
  for (const b of Array.from(engine.conflictedBranches)) {
    if (!present.has(b)) engine.conflictedBranches.delete(b)
  }
  for (const b of Array.from(engine.verifyFailed.keys())) {
    if (!present.has(b)) engine.verifyFailed.delete(b)
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

  // B. Act only when armed (and a trunk exists to land on).
  if (!engine.autoMerge) return
  if (!target) {
    logLine(engine, 'warn', 'auto-integrate: no remote trunk to land on — leaving cards in review')
    return
  }

  for (const card of swarmCards) {
    if (!engine.running || !engine.autoMerge) return // global stop / disarm mid-pass

    // A branch already known to conflict: only retry once it has become a clean
    // fast-forward (a human rebased / the trunk moved), else skip the rebase.
    if (engine.conflictedBranches.has(card.branch)) {
      if ((await deps.classify(engine.path, card.branch, target)) !== 'ff') {
        // Still conflicted — re-apply the Board stamp if it's missing (self-heals
        // a stamp write that was kept on the pass that first hit the conflict),
        // WITHOUT re-running the rebase that already failed.
        if (!card.integrationConflict) await deps.markConflict(engine.path, card.id, true)
        continue
      }
      engine.conflictedBranches.delete(card.branch)
      // Clear the persistent stamp, and reflect a SUCCESSFUL clear in the local
      // snapshot so the land-path backstop below skips a redundant re-clear. A KEPT
      // clear leaves the snapshot stamped → the backstop still fixes it on land.
      if (await deps.markConflict(engine.path, card.id, false)) card.integrationConflict = false
    }

    // VERIFICATION GATE — never let the engine auto-merge code that doesn't even
    // type-check. Verify the to-be-landed tree (branch rebased onto trunk); a RED
    // result keeps the card in review (NOT merged) and logs the reason. Memoized
    // by tip so a persistently-red branch isn't re-tsc'd every pass — but a new
    // commit (different tip ⇒ a fix) re-verifies and can land.
    const knownBadTip = engine.verifyFailed.get(card.branch)
    let verdict: Awaited<ReturnType<IntegrationDeps['verify']>>
    try {
      verdict = await deps.verify(
        engine.path,
        card.branch,
        target,
        knownBadTip ? { skipIfTip: knownBadTip } : undefined,
      )
    } catch (e) {
      // An ERRORED verify is not a green light: defer (leave in review, retry next
      // pass) rather than fall through to integrate unverified.
      logLine(engine, 'warn', `verification errored (deferring): ${card.branch} — ${errMsg(e)}`)
      continue
    }
    if (!verdict.ok) {
      if (verdict.tip) engine.verifyFailed.set(card.branch, verdict.tip)
      // Surface "needs a human" on the dashboard (the same dot a merge conflict
      // gets — both mean "auto-merge can't take it from here").
      const r = engine.reviews.find((x) => x.taskId === card.id)
      if (r) r.status = 'conflict'
      // Log the first time we see this red tip (a `skipped` re-check stays quiet so
      // a stuck-red branch doesn't flood the journal every pass).
      if (!verdict.skipped) {
        logLine(
          engine,
          'error',
          `verification failed — not merging: ${card.branch} (${shorten(card.title ?? '')}) — ${verdict.reason ?? 'check not green'}`,
        )
      }
      continue // leave the card in review; do NOT integrate unverified work
    }
    // Verified green (or nothing to verify) — a previously-red branch was fixed.
    engine.verifyFailed.delete(card.branch)

    let outcome: IntegrateOutcome
    try {
      outcome = await deps.integrate(engine.path, card.branch, target)
    } catch (e) {
      logLine(engine, 'warn', `integration deferred: ${card.branch} — ${errMsg(e)}`)
      continue
    }

    if (outcome.status === 'integrated') {
      // Move the card FIRST; only sweep the worktree+branch once it is recorded
      // done, so a failed board write self-heals next pass (re-integrate sees the
      // branch already merged → integrated → retry the move) instead of stranding
      // a landed card in review with its branch already deleted.
      if (await deps.moveToDone(engine.path, card.id)) {
        const cl = await deps.cleanup(engine.path, card.branch)
        engine.conflictedBranches.delete(card.branch)
        clearKeptMove(engine, card.id) // the done move landed — forget any stuck tracking
        // Reliable flag CLEAR — the BACKSTOP for two cases the became-ff clear above
        // can miss: (a) the stamp survived a server restart that lost the in-memory
        // memo (so that block never ran), and (b) that block's markConflict(false)
        // was itself KEPT (then the snapshot stays stamped). Only fires for a still-
        // stamped card — the happy path and an already-cleared became-ff card write
        // nothing — so a "done but flagged conflict" zombie can never survive a land.
        if (card.integrationConflict) {
          try {
            await deps.markConflict(engine.path, card.id, false)
          } catch {
            /* best-effort — the card is already done; a kept clear is only cosmetic */
          }
        }
        // Drop the just-landed card from the readiness snapshot so the dashboard
        // doesn't show it as still-in-review until the next pass re-reads.
        engine.reviews = engine.reviews.filter((r) => r.taskId !== card.id)
        // Tear the just-landed worker down: kill its lingering `claude` PTY by id
        // (the common case — a `claude` TUI does NOT exit when /order finishes, so
        // the promoted worker sits in engine.workers as 'done' with its PTY alive)
        // and drop it from the live set so its slot frees IMMEDIATELY. cleanup()
        // already removed the worktree + killed any PTY by cwd; this by-id kill
        // closes the symlinked-home cwd-miss gap and means no zombie PTY/slot ever
        // outlives an integration. Branch names are unique per worker → matches ≤1.
        const landed = engine.workers.filter((w) => w.branch === card.branch)
        for (const w of landed) {
          try {
            deps.killPty(w.terminalId)
          } catch {
            /* best-effort — a dead/absent PTY is fine; the monitor would prune it anyway */
          }
        }
        if (landed.length > 0) {
          engine.workers = engine.workers.filter((w) => w.branch !== card.branch)
        }
        logLine(
          engine,
          'info',
          `integrated (${outcome.mode}): ${shorten(card.title ?? '')} → ${target}` +
            (cl.removed ? '' : ` · worktree kept (${cl.reason ?? '?'})`),
          'integrate',
        )
        // A kept worktree after a successful land is a potential zombie — call it
        // out as its own 'cleanup' warning so it isn't lost inside the (info)
        // integrate line. The commits are already on the trunk, so this is just a
        // leftover scratch tree the owner can clear by hand.
        if (!cl.removed) {
          logLine(
            engine,
            'warn',
            `worktree teardown kept — clear by hand: ${card.branch} (${cl.reason ?? '?'})`,
            'cleanup',
          )
        }
      } else {
        // Landed on the trunk but the review→done move was KEPT — the work is safe
        // (commits are on the trunk) yet the card is stuck in review ("done なのに
        // review"). Track it: a persistently-kept done-move surfaces as a
        // 'move-stuck' anomaly so a human moves it, instead of an endless warn loop.
        recordKeptMove(engine, card.id, 'done', card.branch, card.title ?? '')
        logLine(engine, 'warn', `landed on ${target} but column move kept (will retry): ${shorten(card.title ?? '')}`)
      }
    } else if (outcome.status === 'conflict') {
      engine.conflictedBranches.add(card.branch)
      // Stamp the card (the persistent Board mark). The in-memory memo above
      // already prevents re-rebase churn, so a kept stamp write isn't fatal —
      // but log it: the owner would otherwise see no on-board "needs manual
      // integration" flag. (The readiness snapshot below still shows it.)
      let stamped = false
      try {
        stamped = await deps.markConflict(engine.path, card.id, true)
      } catch {
        /* logged just below */
      }
      // Reflect the freshly-discovered conflict in the readiness snapshot now
      // (half A classified it before the attempt revealed the conflict).
      const r = engine.reviews.find((x) => x.taskId === card.id)
      if (r) r.status = 'conflict'
      // Name WHERE it conflicts (the unmerged files swarmIntegrate captured) so the
      // human resolving it knows what to open — capped so the log line stays legible.
      const files = outcome.files ?? []
      const filesNote = files.length
        ? ` · conflicts in: ${files.slice(0, 6).join(', ')}${files.length > 6 ? ` (+${files.length - 6})` : ''}`
        : ''
      logLine(
        engine,
        'error',
        `conflict — manual integration needed: ${card.branch} (${shorten(card.title ?? '')})` +
          filesNote +
          (stamped ? '' : ' · card stamp kept (will re-stamp next pass)'),
        'conflict',
      )
    } else if (outcome.status === 'error') {
      // Transient (push rejected by a moved trunk, network…) — retry next pass.
      logLine(engine, 'warn', `integration deferred: ${card.branch} — ${outcome.reason}`)
    }
    // 'skipped' (no trunk handled above; non-swarm filtered out) → silent.
  }
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
 *                        false orphan. */
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
  deps: OrchestratorDeps & IntegrationDeps & AnomalyDeps,
): Promise<void> => {
  if (engine.passInFlight) return
  engine.passInFlight = true
  try {
    await runDispatchPass(engine, deps)
    if (engine.running) await runIntegratePass(engine, deps)
    if (engine.running) {
      try {
        const tasks = await deps.fetchTasks(engine.path)
        // Prune resolved stuck-moves BEFORE detection reads them, so a zombie that
        // a human (or a recovered write) already fixed never surfaces as an anomaly.
        pruneStuckMoves(engine, tasks)
        engine.anomalies = await detectAnomalies(engine, tasks, deps, Date.now())
      } catch {
        // A transient board read isn't itself an anomaly to surface — keep the last
        // snapshot; the next pass refreshes it.
      }
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
  return stateOf(engine, deps.isAlive)
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
  const engine = store.engines.get(key)
  if (!engine) return emptyState()
  if (engine.running) {
    engine.running = false
    if (engine.timer) {
      clearTimeout(engine.timer)
      engine.timer = null
    }
    logLine(engine, 'info', 'autonomous drain OFF')
  }
  return stateOf(engine, deps.isAlive)
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
  const w = engine.workers.find((x) => x.terminalId === terminalId)
  if (!w) return stateOf(engine, deps.isAlive) // unknown / already gone — idempotent

  // Tear the worktree + PTY down FIRST (the zombie-eradication — idempotent, and
  // the critical guarantee). Best-effort: a failure is logged, never blocks the stop.
  let teardown: { removed: boolean; reason?: string } = { removed: false }
  try {
    teardown = await deps.recoverWorker({ projectPath: key, worktree: w.worktree, terminalId })
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
  engine.workers = engine.workers.filter((x) => x.terminalId !== terminalId)
  const note = parked === 'blocked' ? 'card → blocked' : parked === 'kept' ? 'card move kept' : 'card left as-is'
  logLine(
    engine,
    'info',
    `worker stopped by owner — ${note}: ${w.branch} (${shorten(w.taskTitle)})` +
      (teardown.removed ? '' : ` · worktree kept (${teardown.reason ?? '?'})`),
  )
  return stateOf(engine, deps.isAlive)
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
      await deps.recoverWorker({ projectPath: key, worktree: w.worktree, terminalId: w.terminalId })
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
  clearKeptMove(engine, taskId)
  logLine(
    engine,
    'info',
    `review resolved by owner — card → ${target}: ${branch || '(no branch)'} (${shorten(card.title ?? '')})`,
    'integrate',
  )
  return stateOf(engine, deps.isAlive)
}

/** Current engine state for a project (never started ⇒ a stopped empty state). */
export const getOrchestratorState = async (
  projectPath: string,
  deps: OrchestratorDeps = defaultDeps(),
): Promise<SwarmOrchestratorState> => {
  const key = await canonicalize(projectPath)
  const engine = store.engines.get(key)
  return engine ? stateOf(engine, deps.isAlive) : emptyState()
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
