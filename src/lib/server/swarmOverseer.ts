// swarmOverseer — the autonomous OVERSEER's BRAINSTEM (脳幹) pass: the "ignition"
// that binds the shipped C1 inbox / C2 proxy-you brain / C4 reversibility gate into
// one budgeted, edge-triggered watcher riding the engine's own 3s tick
// (OVERSEER_DESIGN §5/§6/§10 C-core). It NEVER spawns its own driver (K1): it is a
// stage of runEnginePass, like self-supply. Unlike self-supply — which is FIRED and
// left to run beside the tick because its scanners spawn tsc/lint/vitest for minutes
// (kickSelfSupplyPass) — this pass is cheap, pure logic, so the tick still awaits it.
//
// WHAT IT IS (three layers, this file is the BRAINSTEM):
//   • 脳幹 (here) — a PURE-logic periodic pass. It READS already-computed engine
//     state (anomalies / notified / the tick's tasks snapshot / worker heartbeats /
//     a cached usage %) and, via a table of thresholds (OVERSEER_THRESHOLDS), decides
//     "do nothing / wake the brain / raise to the human". It calls NO model itself.
//   • 大脳 (swarmOverseerBrain.ts, C2) — an episodic one-off `claude` woken ONLY on a
//     free-text worker question (S4). FIRE-AND-FORGET: the pass NEVER awaits it (D2) —
//     awaiting one 5-min brain call would freeze the 3s tick chain (dispatch / stall /
//     runaway detection) for the whole budget. The detached result lands in the
//     in-memory mailbox (OverseerRuntime.brainResults) and the NEXT pass routes it.
//   • 記憶 (you-corpus, B1) — the brain's grounding; the owner's answer is written back
//     by C1's answerEscalation, never by this file (§8 invariant 6).
//
// WHY IT IS SAFE (the whole point of its shape — it can only READ, RAISE, or ASK):
//   1. OFF BY DEFAULT + in-memory (K2) — engine.overseer.enabled starts false, only
//      the owner-gated setOverseer flips it, a restart re-arms OFF. It is the THIRD
//      toggle (D1), asymmetric to selfSupply: an explicit autonomy OFF
//      (stopOrchestrator) CLEARS it, and an auto-drain re-ignition NEVER sets it
//      (enabled only ever becomes true through the owner POST). So the most-dangerous
//      stage never rides along on a machine-driven restart.
//   2. NO GIT / NO DISPATCH — it never merges (the engine's integrateBranch owns that)
//      and never spawns a worker (supply cards go through the Board's approval gate).
//      Its only outward effects are: append an escalation (idempotent on receiptKey),
//      inject a proxy answer into a LIVE worker PTY through the C1/W16 helper (a reply
//      to a question, not a command), and fire info-grade bell/OS toasts (edge-deduped).
//   3. BUDGET (L7) — the brain is throttled (≥10min between calls), day-capped (24/UTC
//      day, HALVED on a usage warn), single-flight (one PTY at a time), and 5-min
//      timed-out. A usage OVER (S9) THROTTLES it entirely (S4 degrades to a bare raise).
//   4. FAIL-CLOSED (K6/C4) — the brain answers ONLY reversible, grounded questions;
//      irreversible / unknown / thin-corpus routes to the human. The gate is
//      reversibility, not confidence (all enforced inside answerAsOwner / C4).
//
// EDGE DISCIPLINE (§6): every signal fires on the RISING edge only — dedup is the
// overseer's own responsibility (swarmNotifications does not dedup). `seen` maps a
// signalKey → a fingerprint (sha / card id / count); a signal re-fires only when the
// fingerprint MOVES. `watch` measures dwell (S5/S7/S11's "30min / 6h continuous").
// Both are pruned each pass against the live condition set (pruneStuckMoves discipline),
// so a resolved condition drops its tracking and a genuine recurrence re-fires. seen
// and watch are in-memory — a restart / re-ON resets them (a persisting anomaly
// re-fires, absorbed by the T3 receiptKey idempotency and per-Tier budgets — §6).

import type { ProjectTask, OrchestratorAnomaly, OrchestratorReview } from '../types'
import type { SwarmInfoNotification, SwarmFatalNotification, EscalationStatus } from '../types'
// TYPE-ONLY import from the orchestrator (erased at compile time) so there is NO
// runtime import cycle: the orchestrator imports runOverseerPass (a value) from here;
// this file must never import a VALUE back. The readHeartbeat/isAlive VALUES the pass
// needs are handed in through OverseerDeps (the orchestrator already owns them).
import type { HeartbeatSign } from './swarmOrchestrator'
import { workerKey, workerRuntimeKind, type WorkerHandle } from './workerRuntime'
import {
  answerAsOwner as realAnswerAsOwner,
  makeOverseerBrain,
  OVERSEER_BRAIN_TIMEOUT_MS,
  type OwnerQuestion,
  type OwnerAnswer,
} from './swarmOverseerBrain'
import { buildUnclassifiedRoutingPlainQuestion } from './swarmDecisionRouting'
import {
  openEscalation as realOpenEscalation,
  defaultReceiptKey,
  injectAnswerIntoWorker,
  defaultCanInjectInto,
  deliverAnswerToWorker,
  buildAnswerInjection,
  listEscalations as realListEscalations,
  listEscalationReceiptKeys,
  type OpenEscalationInput,
} from './swarmEscalations'
import type { Escalation, EscalationView } from '../types'
import { usageLevel } from '../usageThresholds'
import { peekCachedUsage, refreshUsageCacheDetached } from './claudeUsageCli'
import { runSwarmJanitor } from './swarmJanitor'
import { createSwarmInfoNotification, listSwarmNotifications } from './swarmNotifications'
import { resolveSwarmModelEffortProbed } from './swarmLaunch'
import { getSettings, getAllowedModelTiers } from './store'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── Threshold table (§6 正典 — ONE place; tests reference these, never re-literalise) ──

/** The overseer's tunable constants — the single source the pass AND its tests read
 *  (SWARM_LAUNCH_MODEL-style one-place discipline). Durations reuse the existing
 *  STALL/QUIET/usage lockstep where the design pins them (10min/30min/80-100), plus
 *  the new overseer values (30min dwell, 6h re-notify, 24/day, 5min brain timeout). */
export interface OverseerThresholds {
  /** Minimum wall-clock between brain (大脳) calls — the throttle (L7). */
  brainMinIntervalMs: number
  /** Max brain calls per UTC day (headline runaway cap); HALVED on a usage warn (S8). */
  brainMaxPerDay: number
  /** One brain call's hard timeout (= REVIEW_TIMEOUT_MS — D4). */
  brainTimeoutMs: number
  /** S5 — a card dwelling in `blocked` this long is surfaced to the owner. */
  blockedStuckMs: number
  /** S7 — mergeable review cards piling up this long fire an info notice. */
  reviewIdleMs: number
  /** S11 — an OPEN inbox record unanswered this long is re-notified once (never
   *  auto-progressed — fail-closed). */
  inboxStaleMs: number
  /** M8 — the usage sub-cycle: peek every pass, refresh (detached) at most this often. */
  usagePollMs: number
  /** M11 — the escalations/fatals sub-cycle (inbox staleness + edge-fatal file read). */
  escalationsPollMs: number
  /** S3/S10 — how far back the durable fatal store is considered "recent". Fatals
   *  older than this NEVER open an escalation, no matter how often the overseer is
   *  re-armed — the store itself keeps up to 50 records with no expiry
   *  (SWARM_NOTIFICATIONS_CAP), so without this window a re-arm would replay
   *  week-old exec-timeouts of long-dead workers as "new". */
  fatalWindowMs: number
  /** W6 — how often OBSERVING fires the residual-cleanup janitor (T0'). */
  janitorMs: number
  /** M8 — cap on the exponential backoff after a usage refresh keeps missing. */
  usageBackoffMaxMs: number
  /** Watchdog slack past brainTimeoutMs after which a still-in-flight brain is
   *  force-released (defense-in-depth: a settle-path hang must not pin single-flight
   *  forever and silence S4). */
  brainStuckSlackMs: number
}

export const OVERSEER_THRESHOLDS: OverseerThresholds = {
  brainMinIntervalMs: 10 * 60_000, // 10min (OVERSEER_BRAIN_MIN_INTERVAL_MS)
  brainMaxPerDay: 24, // OVERSEER_MAX_BRAIN_PER_DAY (UTC roll)
  brainTimeoutMs: OVERSEER_BRAIN_TIMEOUT_MS, // 5min
  blockedStuckMs: 30 * 60_000, // 30min (lockstep with QUIET/STALL band)
  reviewIdleMs: 30 * 60_000, // 30min
  inboxStaleMs: 6 * 60 * 60_000, // 6h
  usagePollMs: 60_000, // 60s
  escalationsPollMs: 60_000, // 60s
  fatalWindowMs: 24 * 60 * 60_000, // 24h — only fatals this fresh may open an escalation
  janitorMs: 15 * 60_000, // 15min
  usageBackoffMaxMs: 15 * 60_000, // 15min
  brainStuckSlackMs: 60_000, // 1min past the 5min timeout
}

/** The signal → Tier map (§6 表), as DATA so the pass is table-driven and the table
 *  is the single legible spec. Detection logic per row differs (anomaly / fatal /
 *  heartbeat / usage / dwell), but the id → tier → note mapping lives here so a
 *  reader (and the log) can name every fire. S6 (todo 枯渇→次タスク起草) is
 *  DELIBERATELY ABSENT — §11 Q4 removed it from C-core's scope (goal generation is
 *  the highest-risk runaway; a later card owns it). */
export type OverseerSignalId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S7' | 'S8' | 'S9' | 'S10' | 'S11'
export type OverseerTier = 'T0prime' | 'T1' | 'T3' | 'THROTTLED'

export interface OverseerSignalSpec {
  id: OverseerSignalId
  tier: OverseerTier
  /** One-line description of the edge + action (mirrors the §6 table row). */
  note: string
}

export const OVERSEER_SIGNALS: readonly OverseerSignalSpec[] = [
  { id: 'S1', tier: 'T3', note: 'rework-exhausted (anomaly) → raise to the inbox' },
  { id: 'S2', tier: 'T3', note: 'all-workers-down (fatal) → raise to the inbox' },
  { id: 'S3', tier: 'T3', note: 'exec-timeout (fatal) → raise to the inbox' },
  { id: 'S4', tier: 'T1', note: 'worker free-text question (heartbeat blockers) → proxy brain / escalate' },
  { id: 'S5', tier: 'T3', note: 'blocked-column card dwelt 30min → raise to the inbox' },
  { id: 'S7', tier: 'T0prime', note: 'mergeable review cards idle 30min → info notice' },
  { id: 'S8', tier: 'T0prime', note: 'usage warn (80%) → halve the brain day cap' },
  { id: 'S9', tier: 'THROTTLED', note: 'usage over (100%) → THROTTLE the brain, S4 degrades to a bare raise' },
  { id: 'S10', tier: 'T3', note: 'selfUpdate rollback / canary-failed (fatal) → raise to the inbox' },
  { id: 'S11', tier: 'T0prime', note: 'inbox open record unanswered 6h → re-notify once' },
] as const

// ── Runtime (§5 — in-memory, lives on ProjectEngine; a restart resets it → OFF) ──

/** One brain call's outcome, parked in the mailbox by the fire-and-forget chain and
 *  drained + routed by the NEXT pass (D2). Carries the worker coordinates so the
 *  drain can inject the answer (T1) or open an escalation (T3) for the right worker. */
export interface OverseerBrainResult {
  signalKey: string
  question: string
  context: string
  taskId?: string
  branch?: string
  /** The blocked worker's HANDLE, carried whole (pty ⇔ terminalId,
   *  sdk ⇔ sdkSessionId — workerRuntime.ts's identity invariant).
   *
   *  It used to be `terminalId` alone, which is EMPTY for an SDK worker: the
   *  drain below then had nothing to address, so a proxy answer for such a worker
   *  could never be delivered — it was reported as "injection failed" and thrown
   *  back at the owner every single time, for a worker that was sitting right
   *  there waiting for it. Keep the whole handle; the conduit branches, not this
   *  record. */
  runtime?: 'pty' | 'sdk'
  terminalId?: string
  sdkSessionId?: string
  /** null when the detached chain itself threw (answerAsOwner never throws, but the
   *  chain is guarded belt-and-suspenders) → treated as an insufficient-info escalate. */
  answer: OwnerAnswer | null
}

/** Per-engine overseer state (§5). In-memory ONLY — held on the ProjectEngine, which
 *  lives on globalThis; a server restart resets it, which also re-arms `enabled` OFF
 *  (fail-safe, K2). watch/seen reset on restart too, so dwell timers restart from zero
 *  (a firing that's LATER = the safe direction — §5). */
export interface OverseerRuntime {
  /** Armed? Default OFF — only the owner-gated setOverseer flips it true; an explicit
   *  autonomy OFF (stopOrchestrator) or a restart drops it false (D1). */
  enabled: boolean
  /** The single-flight guard: true while ONE brain PTY is in flight (D2). */
  assessInFlight: boolean
  /** Aborts the in-flight brain (owner OFF / teardown). The brain runner kills its PTY
   *  on abort (makeOverseerBrain). Present only while assessInFlight. */
  brainAbort?: AbortController
  /** The in-flight brain call's mailbox coordinates (present only while
   *  assessInFlight). The watchdog needs them: a NEVER-SETTLING flight runs no
   *  .then/.finally, so nothing would land in the mailbox for it — while its S4
   *  `seen` fingerprint stays set, reading the SAME question as "already handled"
   *  forever. On a force-release the watchdog synthesizes `{...brainInFlight,
   *  answer:null}` into the mailbox so the question still fail-closes to the owner. */
  brainInFlight?: Omit<OverseerBrainResult, 'answer'>
  /** Fire-and-forget brain results awaiting routing next pass (the mailbox). */
  brainResults: OverseerBrainResult[]
  /** Edge dedup: signalKey → fingerprint. A signal re-fires only when the fp moves. */
  seen: Map<string, string>
  /** Dwell measurement: watchKey → { since, fp }. For S5/S7/S11's "continuous for N". */
  watch: Map<string, { since: number; fp: string }>
  /** Wall-clock of the last brain call — the throttle gate. */
  lastBrainAt: number
  /** Brain calls so far in `dayKey` — the day cap gate. */
  brainCallsToday: number
  /** UTC day ('YYYY-MM-DD') the count above is for — rolled at the first pass of a new day. */
  dayKey: string
  /** M8 sub-cycle: last usage peek/refresh time. */
  lastUsageAt: number
  /** M8: don't re-fire a detached refresh before this (exponential backoff on misses). */
  usageBackoffUntil: number
  /** M11 sub-cycle: last escalations/fatals read time. */
  lastEscalationsAt: number
  /** T3 throttle: last inbox raise time (receiptKey carries the real idempotency — §8). */
  lastEscalateAt: number
  /** W6 sub-cycle: last janitor run time. */
  lastJanitorAt: number
  /** A janitor sweep is running RIGHT NOW, beside the tick that fired it. The
   *  sweep is fire-and-forget (it used to be awaited INSIDE the pass — see the
   *  call site), so a later tick could otherwise start a second one on top of
   *  the first: two concurrent `git worktree remove` / branch deletes over the
   *  same repo. Check-and-set SYNCHRONOUSLY before the first await, cleared in
   *  `finally` — the same shape as the engine's own `passInFlight`. In-memory
   *  only; a restart clears it, which is correct (nothing is sweeping). */
  janitorInFlight?: boolean
  /** S9 edge memory: true while THROTTLED, so entering fires the T3' notice ONCE and
   *  recovery is silent (§5). */
  throttled: boolean
}

export const initOverseerRuntime = (): OverseerRuntime => ({
  enabled: false,
  assessInFlight: false,
  brainResults: [],
  seen: new Map(),
  watch: new Map(),
  lastBrainAt: 0,
  brainCallsToday: 0,
  dayKey: '',
  lastUsageAt: 0,
  usageBackoffUntil: 0,
  lastEscalationsAt: 0,
  lastEscalateAt: 0,
  lastJanitorAt: 0,
  throttled: false,
})

// ── The engine surface the pass reads (structural subset — no back-import cycle) ──

/** The minimal ProjectEngine surface the overseer pass reads — a structural subset,
 *  so this module needs no VALUE import from swarmOrchestrator (avoids a cycle,
 *  mirrors SelfSupplyEngine). ProjectEngine satisfies it. */
export interface OverseerEngine {
  path: string
  running: boolean
  anomalies: readonly OrchestratorAnomaly[]
  /** Fatal rising-edge dedup set the engine maintains — durable while a state fatal
   *  (rework-exhausted:* / all-workers-down) is active (fireFatalNotifications). */
  notified: ReadonlySet<string>
  /** Live + recently-dispatched workers (the overseer filters by isAlive).
   *
   *  A {@link WorkerHandle}, not a bare terminalId: an SDK worker carries its id
   *  in `sdkSessionId` and an EMPTY `terminalId`, so anything here that keys or
   *  addresses on `terminalId` silently collapses every SDK worker into one (see
   *  the S4 signal key below). `terminalId` stays optional for that reason —
   *  {@link import('../types').OrchestratorWorker} satisfies this either way. */
  workers: readonly (WorkerHandle & { branch: string; taskId: string; taskTitle: string })[]
  /** Review-column integration readiness (for S7). */
  reviews: readonly OrchestratorReview[]
  overseer: OverseerRuntime
}

// ── Injectable dependencies (defaulted in prod; faked in tests) ───────────────────

/** A sink for the engine journal — wired to logLine by the orchestrator hook,
 *  collected by an array in tests. */
export type OverseerLog = (level: 'info' | 'warn', message: string) => void
const NOOP_LOG: OverseerLog = () => {}

/** One durable fatal paired with its notification-store append time. The
 *  createdAt is the OCCURRENCE's identity: the payload ({@link SwarmFatalNotification})
 *  itself carries no timestamp, and the same card can legitimately fail twice —
 *  each append gets its own createdAt, so keying on it makes every real
 *  occurrence raise exactly once while a re-read of the same stored record
 *  never raises twice. */
export interface TimedSwarmFatal {
  fatal: SwarmFatalNotification
  /** Epoch ms the notification store appended this record. */
  createdAt: number
}

export interface OverseerDeps {
  now: () => number
  /** From the orchestrator's own deps (it already reads these each pass). */
  isAlive: (w: WorkerHandle) => boolean
  readHeartbeat: (projectPath: string, branch: string) => Promise<HeartbeatSign | null>
  /** C2 — proxy-you brain. Resolves answer|escalate; NEVER throws. `signal` aborts it
   *  on owner OFF / teardown. */
  answerAsOwner: (q: OwnerQuestion, signal?: AbortSignal) => Promise<OwnerAnswer>
  /** C1 T3 — append an escalation (idempotent on receiptKey). */
  openEscalation: (input: OpenEscalationInput) => Promise<{ escalation: Escalation; deduped: boolean }>
  /** W16 targeting guard — may we type an answer into this live PTY? (fail-closed) */
  canInjectInto: (terminalId: string, projectPath: string) => Promise<boolean>
  /** W16 — inject a proxy answer into a live worker PTY (bracketed paste + CR). */
  injectAnswer: (terminalId: string, text: string) => Promise<boolean>
  /** T1 — deliver a proxy answer to a live worker on EITHER runtime (guard +
   *  delivery in one call; see swarmEscalations.deliverAnswerToWorker).
   *
   *  OPTIONAL, and the two PTY-shaped deps above are kept beside it ON PURPOSE:
   *  they are the only knobs a PTY-worker test needs, and every existing dep
   *  literal supplies exactly those. When this is absent the drain composes them
   *  for a PTY target — byte-identical to before — and uses the real conduit for
   *  an SDK target, which has no PTY equivalent to compose. */
  deliverAnswer?: (target: WorkerHandle, projectPath: string, text: string) => Promise<boolean>
  /** T0'/S7/S9/S11 — info-grade bell + OS toast. */
  notifyInfo: (n: SwarmInfoNotification) => Promise<unknown>
  /** M8 — cached-only usage %, or null (miss/stale/idle). NEVER scrapes. */
  peekUsagePct: () => number | null
  /** M8 — fire a background usage refresh (never awaited). */
  refreshUsage: () => void
  /** M11/S11 — the escalations inbox (open-record staleness). TOLERANT read
   *  (failure ≈ empty) — fine for the info-grade reminder, NOT for the S3/S10
   *  receipt check below. */
  listEscalations: (opts?: { projectPath?: string; status?: EscalationStatus }) => Promise<EscalationView[]>
  /** S3/S10 persistent-receipt check — every receiptKey ever persisted for the
   *  project, any status. The contract is STRICT: only ENOENT reads as an empty
   *  set; a corrupt/unreadable ledger must THROW (never fold to empty) so the
   *  caller can DEFER raising — a tolerant empty here silently re-posts
   *  dismissed fatals (the original bug's second half). */
  listReceiptKeys: (projectPath: string) => Promise<ReadonlySet<string>>
  /** M6 — recent fatal notifications (exec-timeout S3 / rollback+canary S10; the
   *  edge fatals fireFatalNotifications already drained from pendingFatal).
   *  RECENT is a contract, not a name: only records appended at/after `sinceMs`
   *  may be returned (the durable store never expires its cap-50 records, so an
   *  unwindowed read replays week-old fatals forever — the S3 re-post bug). */
  recentFatals: (sinceMs: number) => Promise<TimedSwarmFatal[]>
  /** W6 T0' — the residual-cleanup janitor. force/deleteRemote are NEVER passed from
   *  the autonomous loop (user-explicit only — swarmJanitor's own contract). */
  runJanitor: (projectPath: string) => Promise<unknown>
}

/** Build the REAL dependency set. `io` (readHeartbeat / isAlive) comes from the
 *  orchestrator's own deps; everything else is the shipped C1/C2/C4/usage/janitor
 *  wiring. The brain runner is built per-call at the mode-resolved overseer tier
 *  (resolveSwarmModelEffort(mode, 'overseer') — manager-grade, D4). */
export const defaultOverseerDeps = (io: {
  isAlive: (w: WorkerHandle) => boolean
  readHeartbeat: (projectPath: string, branch: string) => Promise<HeartbeatSign | null>
}): OverseerDeps => ({
  now: () => Date.now(),
  isAlive: io.isAlive,
  readHeartbeat: io.readHeartbeat,
  answerAsOwner: async (q, signal) => {
    const mode = await getSettings()
      .then((s) => s.executionMode ?? 'optimize')
      .catch(() => 'optimize' as const)
    // Null ⇒ every tier switched OFF. Pass nothing and let makeOverseerBrain's own
    // spawn-time mask check throw — the runner failing CLOSED is exactly how the
    // brain already handles "cannot launch safely" (答えは出さず owner へ escalate),
    // so there is no second refusal path to keep in sync.
    // PROBED (2026-07-13): the cerebrum is a spawn path like any other — an
    // UNKNOWN tier gets one collapsed pre-launch probe (swarmTierProbe) so the
    // brain is never seated on a tier-local wall /usage cannot show.
    const me = await resolveSwarmModelEffortProbed(mode, 'overseer', undefined, Date.now(), await getAllowedModelTiers())
    return realAnswerAsOwner(q, {
      runBrain: makeOverseerBrain({ model: me?.model, effort: me?.effort }),
      signal,
    })
  },
  openEscalation: realOpenEscalation,
  canInjectInto: (terminalId, projectPath) => defaultCanInjectInto(terminalId, projectPath),
  injectAnswer: (terminalId, text) => injectAnswerIntoWorker(terminalId, text),
  deliverAnswer: (target, projectPath, text) => deliverAnswerToWorker(target, projectPath, text),
  notifyInfo: (n) => createSwarmInfoNotification(n),
  peekUsagePct: () => {
    const u = peekCachedUsage()
    if (!u) return null
    // The MORE-CONSTRAINING of session/weekly wins (throttle on whichever cap is
    // nearer). null slots (only one parsed) are ignored; both null → null → 'idle'.
    const pcts = [u.session?.pct, u.weekAll?.pct].filter(
      (p): p is number => typeof p === 'number' && Number.isFinite(p),
    )
    return pcts.length ? Math.max(...pcts) : null
  },
  refreshUsage: refreshUsageCacheDetached,
  listEscalations: realListEscalations,
  listReceiptKeys: listEscalationReceiptKeys,
  recentFatals: async (sinceMs) => {
    const all = await listSwarmNotifications().catch(() => [])
    // A record with no createdAt cannot prove it is recent — treat it as old
    // (excluded). Every store append stamps createdAt, so this only guards
    // hand-edited/legacy rows.
    return all.flatMap((n) =>
      n.kind === 'swarm-fatal' && n.swarmFatal && (n.createdAt ?? 0) >= sinceMs
        ? [{ fatal: n.swarmFatal, createdAt: n.createdAt ?? 0 }]
        : [],
    )
  },
  runJanitor: (projectPath) => runSwarmJanitor(projectPath), // NO force / deleteRemote
})

// ── Pure helpers ─────────────────────────────────────────────────────────────────

const dayKeyOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** Does a heartbeat blocker read as a free-text QUESTION for the proxy (vs a
 *  mechanical "waiting on X" blocker)? A question mark, or a JA/EN interrogative
 *  cue. Best-effort — the brain + C4 make the real judgment downstream; this only
 *  keeps non-questions from burning brain budget. */
export const looksLikeQuestion = (text: string): boolean => {
  const t = text.trim()
  if (!t) return false
  if (/[?？]/.test(t)) return true
  return /(ですか|でしょうか|ますか|のか|どうすれ|どうし|どちら|いずれ|which|should i|how should|what should|shall i|do you want|which one)/i.test(
    t,
  )
}

const shorten = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max)}…` : s)

// ── Budget (L7) ───────────────────────────────────────────────────────────────

/** Roll the per-UTC-day brain counter at the first pass of a new day. */
const rollDay = (ov: OverseerRuntime, now: number): void => {
  const dk = dayKeyOf(now)
  if (ov.dayKey !== dk) {
    ov.dayKey = dk
    ov.brainCallsToday = 0
  }
}

/** The brain's day cap for `now` — HALVED on a usage warn (S8, §6). */
const brainDayCap = (config: OverseerThresholds, usageWarn: boolean): number =>
  usageWarn ? Math.floor(config.brainMaxPerDay / 2) : config.brainMaxPerDay

/** May a brain call fire this pass? Throttle + day cap + single-flight (L7). Returns
 *  the reason it's blocked (for the "skipped: budget" log — never fail-quiet, §6). */
const brainBudget = (
  ov: OverseerRuntime,
  now: number,
  config: OverseerThresholds,
  usageWarn: boolean,
): { ok: true } | { ok: false; reason: string } => {
  if (ov.assessInFlight) return { ok: false, reason: 'brain already in flight (single-flight)' }
  if (now - ov.lastBrainAt < config.brainMinIntervalMs)
    return { ok: false, reason: `throttled (<${Math.round(config.brainMinIntervalMs / 60_000)}min since last)` }
  const cap = brainDayCap(config, usageWarn)
  if (ov.brainCallsToday >= cap) return { ok: false, reason: `day cap ${cap} reached` }
  return { ok: true }
}

// ── T3 helper (raise to the inbox; idempotent on receiptKey — §8) ────────────────

const raiseToInbox = async (
  deps: OverseerDeps,
  now: number,
  ov: OverseerRuntime,
  input: {
    projectPath: string
    question: string
    context: string
    /** 平易文 (①決めること ②選択肢 ③各選択の影響) — the overseer's OWN template
     *  raises (S1/S2/S3/S5/S10) supply it; the S4 worker-question raises mostly
     *  don't (their question text is worker-authored, already-plain per the /order
     *  worker rules — there is no template to render it from). The ONE exception is
     *  the S4 ABSTENTION lane: "the corpus doesn't ground this" means the area is
     *  not on the owner's involvement map, and THAT has a template — the routing
     *  question (swarmDecisionRouting.buildUnclassifiedRoutingPlainQuestion). */
    plainQuestion?: string
    whyEscalated: OpenEscalationInput['whyEscalated']
    receiptKey: string
    taskId?: string
    branch?: string
    /** The blocked worker's ADDRESS, carried WHOLE — never `terminalId` alone.
     *
     *  ⚠ This took `terminalId?: string` and passed only that to
     *  {@link OpenEscalationInput}, which is the one-pool bug in its inbox form:
     *  an SDK worker's terminalId is the EMPTY STRING (workerRuntime.ts's
     *  identity invariant), so every S4 raise for one produced a record with NO
     *  address. `addressOf` then stored nothing, `deliverAnswer` had nothing to
     *  rebuild, and the owner's answer fell to the next-dispatch queue — reported
     *  as delivered while the worker sat waiting. Nothing logged, nothing threw.
     *
     *  Every caller below already HOLDS the whole handle (the mailbox record's
     *  `runtime`/`sdkSessionId`, or the roster worker itself) — the field it
     *  could not express was the only thing missing. Spread a
     *  {@link WorkerHandle}; do not pick one id out of it. */
    target?: WorkerHandle
    proxyDraft?: OpenEscalationInput['proxyDraft']
  },
): Promise<boolean> => {
  try {
    await deps.openEscalation({
      projectPath: input.projectPath,
      question: input.question,
      context: input.context,
      ...(input.plainQuestion ? { plainQuestion: input.plainQuestion } : {}),
      whyEscalated: input.whyEscalated,
      receiptKey: input.receiptKey,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      // The WHOLE address (runtime + the single handle it names). `runtime` is
      // what tells openEscalation's `addressOf` which id is the real one; passing
      // an id without it makes an SDK record un-deliverable, and passing the
      // (empty) terminalId of an SDK worker names nobody at all.
      ...(input.target?.runtime ? { runtime: input.target.runtime } : {}),
      ...(input.target?.terminalId ? { terminalId: input.target.terminalId } : {}),
      ...(input.target?.sdkSessionId ? { sdkSessionId: input.target.sdkSessionId } : {}),
      ...(input.proxyDraft ? { proxyDraft: input.proxyDraft } : {}),
    })
    ov.lastEscalateAt = now
    return true
  } catch {
    // fs/notify hiccup — leave `seen` UNSET (caller only sets it on success) so the
    // next pass retries. The receiptKey keeps a later retry idempotent.
    return false
  }
}

// ── The pass (§5 D2 — engine tick 相乗り, never throws, NEVER awaits the brain) ──

export interface OverseerOutcome {
  /** False when the pass short-circuited (disarmed) before observing. */
  ran: boolean
  /** Signal ids that fired an action this pass (for tests + the log). */
  fired: OverseerSignalId[]
  /** True while a brain PTY is in flight after this pass (fire-and-forget). */
  assessInFlight: boolean
  /** True while THROTTLED after this pass. */
  throttled: boolean
}

/** ONE overseer pass. No-op (ran:false) when disarmed. When armed: drains the brain
 *  mailbox from prior passes, evaluates the usage throttle, then walks the §6 signal
 *  table over already-computed state (anomalies / notified / the tick's `tasks`
 *  snapshot / worker heartbeats / cached usage), raising / asking / notifying on
 *  rising edges only. The brain is launched FIRE-AND-FORGET (never awaited — D2) so
 *  the 3s tick chain is never blocked. NEVER throws into the tick (fully guarded).
 *
 *  `tasks` is the tick's already-fetched Board snapshot (M3 — the overseer never does
 *  a 3rd full board read); null when THIS pass's board read failed (then task-derived
 *  signals S5/S7 skip, mirroring fireFatalNotifications). */
export const runOverseerPass = async (
  engine: OverseerEngine,
  tasks: readonly ProjectTask[] | null,
  log: OverseerLog = NOOP_LOG,
  deps: OverseerDeps,
  config: OverseerThresholds = OVERSEER_THRESHOLDS,
): Promise<OverseerOutcome> => {
  const ov = engine.overseer
  if (!ov.enabled) return { ran: false, fired: [], assessInFlight: false, throttled: false } // OFF guard (D1)

  const now = deps.now()
  const fired: OverseerSignalId[] = []
  // Keys active THIS pass — used to prune seen/watch for resolved conditions so a
  // genuine recurrence re-fires (pruneStuckMoves discipline).
  const activeSeen = new Set<string>()
  const activeWatch = new Set<string>()

  try {
    rollDay(ov, now)

    // WATCHDOG (defense-in-depth): a brain that outlives its own 5-min deadline + slack
    // — e.g. a settle-path hang the runner's timeout didn't cover (a config read that
    // never returns before runBrain, an aborted PTY that never emits 'exit') — must not
    // pin the single-flight forever and SILENCE every future S4 (fail-to-silence). Force
    // the abort + release so the next question can wake a fresh brain. lastBrainAt is the
    // launch time; a live in-flight brain settles well within the deadline via its own
    // finally, so this only ever fires on a genuine hang.
    if (ov.assessInFlight && now - ov.lastBrainAt > config.brainTimeoutMs + config.brainStuckSlackMs) {
      ov.brainAbort?.abort()
      // A hung flight may NEVER settle — its .then/.finally never run, so no result
      // will ever land in the mailbox, while its S4 `seen` fingerprint stays set and
      // reads the SAME question as "already handled" forever (a silent drop, not just
      // a stuck flight). Synthesize the null result HERE so this pass's drain below
      // still routes the question to the owner (insufficient-info escalation). A
      // LATE stale settle pushing a second result is harmless: the escalate side is
      // receiptKey-idempotent, and a late real answer reaching the worker is a gain.
      if (ov.brainInFlight) {
        ov.brainResults.push({ ...ov.brainInFlight, answer: null })
        ov.brainInFlight = undefined
      }
      ov.assessInFlight = false
      ov.brainAbort = undefined
      log('warn', 'overseer: brain exceeded timeout+slack — force-released the single-flight')
    }

    // 0. Drain the brain mailbox FIRST — route each prior fire-and-forget result.
    await drainBrainResults(engine, ov, log, deps, now)

    // 1. Usage throttle (S9) + warn (S8), from the CACHED % only (M8). Peek every
    //    pass; refresh (detached) at most once per sub-cycle when the cache misses.
    if (now - ov.lastUsageAt >= config.usagePollMs) {
      ov.lastUsageAt = now
      if (deps.peekUsagePct() === null && now >= ov.usageBackoffUntil) {
        deps.refreshUsage()
        ov.usageBackoffUntil = now + Math.min(config.usagePollMs * 2, config.usageBackoffMaxMs)
      }
    }
    const pct = deps.peekUsagePct()
    const level = usageLevel(pct) // null/idle when unread — does NOT throttle (§5)
    const usageWarn = level === 'warn'
    const nowThrottled = level === 'over'
    if (nowThrottled && !ov.throttled) {
      // S9 rising edge: one T3' info notice on ENTER. Recovery (<100) is silent.
      fired.push('S9')
      await deps
        .notifyInfo({
          event: 'overseer-throttled',
          detail: '監督が使用量上限(≥100%)で縮退中 — 判断系を止め、質問は素のまま受信箱へ直行します。',
          projectPath: engine.path,
        })
        .catch(() => {})
      log('warn', 'overseer: THROTTLED — usage at/over cap; brain paused, S4 degrades to a bare raise')
    }
    ov.throttled = nowThrottled

    // The M6/M11 sub-cycle (fatal-store + inbox reads share ONE 60s cadence, decided
    // ONCE here so the two reads never race each other's timer). First pass always runs
    // (lastEscalationsAt === 0). The in-pass, zero-cost S1/S2 reads run EVERY pass.
    const doSubcycle = ov.lastEscalationsAt === 0 || now - ov.lastEscalationsAt >= config.escalationsPollMs
    if (doSubcycle) ov.lastEscalationsAt = now

    // 2. Fatal-derived escalations. S1 (anomalies) / S2 (notified) are in-pass every
    //    tick; S3/S10 (edge fatals drained from pendingFatal) re-read the durable fatal
    //    store on the sub-cycle. All raise to the inbox (T3) on the rising edge.
    await detectStateAnomalies(engine, ov, log, deps, now, fired, activeSeen)
    if (doSubcycle) await detectEdgeFatals(engine, ov, log, deps, now, config, fired, activeSeen)

    // 3. Worker free-text questions (S4) — the brain-ignition path (T1) or, when
    //    THROTTLED, a bare raise (T3 direct).
    await detectWorkerQuestions(engine, ov, log, deps, now, config, usageWarn, fired, activeSeen)

    // 4. Dwell signals over the tick's task snapshot (S5 blocked / S7 review-idle).
    if (tasks) {
      await detectBlockedDwell(engine, ov, tasks, log, deps, now, config, fired, activeSeen, activeWatch)
      await detectReviewIdle(engine, ov, tasks, log, deps, now, config, fired, activeSeen, activeWatch)
    } else {
      // Board read FAILED this pass (tasks null) — the dwell detectors did NOT run,
      // so the absence of S5/S7 keys from activeSeen/activeWatch means "not
      // re-evaluated", NOT "resolved". Retain their tracking so the every-pass prune
      // can't reset a dwell clock or let an already-raised S5 re-ask 30min after a
      // transient blip (the same detector-didn't-run principle as the S3/S10/S11
      // sub-cycle keys below).
      for (const k of Array.from(ov.seen.keys())) if (k.startsWith('S5:') || k.startsWith('S7:')) activeSeen.add(k)
      for (const k of Array.from(ov.watch.keys())) if (k.startsWith('S5:') || k.startsWith('S7:')) activeWatch.add(k)
    }

    // 5. Inbox staleness (S11) — re-notify an open record unanswered past 6h (T0';
    //    NEVER auto-progresses — fail-closed). Same sub-cycle as the fatal read.
    if (doSubcycle) await detectInboxStale(engine, ov, log, deps, now, config, fired, activeSeen)

    // 6. Janitor (W6, T0') — low-frequency residual cleanup while OBSERVING.
    //
    // OFF-TICK (2026-07-29). This used to be `await`ed here, inside the overseer
    // pass, which itself runs inside runEnginePass while `passInFlight` is held.
    // The sweep is a `git fetch` (60s timeout) plus a git spawn per local and
    // remote swarm branch — tens of seconds to minutes on a busy repo — and for
    // that whole time EVERY 3s tick bailed on passInFlight: no monitor, so no
    // stall detection, no crash detection, no runaway clock, no quota sighting.
    // The engine went blind exactly while the overseer was meant to be watching.
    // integrate (kickIntegratePass) and self-supply (kickSelfSupplyPass) were
    // moved off the tick for this same reason; the janitor was the one left.
    //
    // Fired and forgotten instead, with a synchronous in-flight guard so a later
    // tick cannot stack a second sweep on the same repo. `lastJanitorAt` is
    // stamped BEFORE the spawn (not after it completes) so the 15-minute cadence
    // measures start-to-start and a slow sweep cannot compress the next interval.
    // NOTE this keeps the overseer's K1 invariant intact: it still has no driver
    // of its own — the tick decides WHEN, it just no longer waits for the result.
    if (!ov.janitorInFlight && now - ov.lastJanitorAt >= config.janitorMs) {
      ov.lastJanitorAt = now
      ov.janitorInFlight = true
      void deps
        .runJanitor(engine.path)
        .catch((e) => log('warn', `overseer: janitor errored — ${errMsg(e)}`))
        .finally(() => {
          ov.janitorInFlight = false
        })
    }

    // Prune seen/watch for conditions no longer active — so a resolved condition drops
    // its dedup and a genuine recurrence re-fires (§6). Never prune keys touched by an
    // IN-FLIGHT brain (its signalKey stays in seen until the mailbox drains). Sub-cycle
    // detectors (S3/S10/S11) only re-register their keys on a sub-cycle pass, so their
    // keys are prunable ONLY when the sub-cycle actually ran this pass (doSubcycle).
    pruneTracking(ov, activeSeen, activeWatch, doSubcycle)
  } catch (e) {
    // NEVER throw into the tick — a bug here must not disturb dispatch / integrate.
    log('warn', `overseer: pass errored — ${errMsg(e)}`)
  }

  return { ran: true, fired, assessInFlight: ov.assessInFlight, throttled: ov.throttled }
}

// ── Mailbox drain (route each fire-and-forget brain result — T1 inject / T3 raise) ──

/** The worker HANDLE a mailbox entry addresses, rebuilt for the conduit. */
const targetOf = (r: OverseerBrainResult): WorkerHandle => ({
  ...(r.runtime ? { runtime: r.runtime } : {}),
  ...(r.terminalId ? { terminalId: r.terminalId } : {}),
  ...(r.sdkSessionId ? { sdkSessionId: r.sdkSessionId } : {}),
})

/** Deliver a proxy answer to the worker, on whatever runtime carries it.
 *
 *  ONE branch, in ONE place, and only because the injected PTY deps have no SDK
 *  counterpart to compose (see {@link OverseerDeps.deliverAnswer}). Never throws
 *  — a delivery failure must fall through to the inbox, not abort the drain. */
const deliverProxyAnswer = async (
  deps: OverseerDeps,
  projectPath: string,
  target: WorkerHandle,
  text: string,
): Promise<boolean> => {
  if (deps.deliverAnswer) return deps.deliverAnswer(target, projectPath, text).catch(() => false)
  if (workerRuntimeKind(target) === 'sdk') {
    return deliverAnswerToWorker(target, projectPath, text).catch(() => false)
  }
  const id = target.terminalId
  if (!id) return false
  if (!(await deps.canInjectInto(id, projectPath).catch(() => false))) return false
  return deps.injectAnswer(id, text).catch(() => false)
}

const drainBrainResults = async (
  engine: OverseerEngine,
  ov: OverseerRuntime,
  log: OverseerLog,
  deps: OverseerDeps,
  now: number,
): Promise<void> => {
  if (ov.brainResults.length === 0) return
  const results = ov.brainResults.splice(0, ov.brainResults.length)
  for (const r of results) {
    const ans = r.answer
    // A confident, reversible, grounded answer → inject it into the LIVE worker (T1).
    // NOT written to you-corpus (only the OWNER's answer is — §8 invariant 6).
    if (ans && ans.kind === 'answer') {
      const ok = await deliverProxyAnswer(
        deps,
        engine.path,
        targetOf(r),
        buildAnswerInjection(r.question, ans.text),
      )
      if (ok) {
        log('info', `overseer: proxy answered a worker question (${ans.confidence}) — injected: ${shorten(r.question)}`)
        continue
      }
      // Worker gone / injection failed → fall through to the inbox so the answer isn't
      // lost (the owner can re-deliver it; it rides the next-dispatch conduit via C1).
      await raiseToInbox(deps, now, ov, {
        projectPath: engine.path,
        question: r.question,
        context: `${r.context}\n\n(proxy が回答済みだが worker への配達に失敗 — 本人が届け直してください。)`,
        whyEscalated: 'insufficient-info',
        receiptKey: defaultReceiptKey({ projectPath: engine.path, taskId: r.taskId, question: r.question }),
        taskId: r.taskId,
        branch: r.branch,
        // The SAME handle `deliverProxyAnswer` just tried, not the id it happens
        // to carry: this record exists BECAUSE delivery failed, so it is the
        // owner's only remaining route back to that exact worker.
        target: targetOf(r),
        proxyDraft: { answer: ans.text, confidence: ans.confidence, isAbstention: false },
      })
      log('warn', `overseer: proxy answer could not be injected — raised to the inbox: ${shorten(r.question)}`)
      continue
    }

    // Escalate (irreversible / insufficient-info / no answer) → the inbox (T3), with
    // the proxy's draft when it produced one (abstention flag set for calibrated "thin").
    const why = ans && ans.kind === 'escalate' ? ans.why : 'insufficient-info'
    const reason = ans && ans.kind === 'escalate' ? ans.reason : 'proxy brain produced no answer'
    // UNCLASSIFIED lane (2026-07-18 owner design): the brain READ the corpus and
    // judged it doesn't ground this — i.e. the area is not on the owner's
    // 「関与の観測地図」. Rather than forwarding a question the owner may not even
    // want to own, lead with the ONE routing question ("is this yours to decide?");
    // their answer flows to you-corpus through the existing answer path and grows
    // the map.
    //
    // GATED ON `abstained`, NOT ON `why` — load-bearing. 'insufficient-info' is
    // ALSO what the FAILURE paths report: brain crash/timeout (incl. every model
    // tier off / quota park), an unparseable verdict, and the watchdog's synthesized
    // null result above. On those the corpus was never consulted, so the routing
    // question would (a) assert a finding nobody made and promise a silence
    // (「次から…なるべく止めないようにします」) the failure lane cannot honour, and worse
    // (b) invite blanket delegation ("まかせる") for a question whose
    // REVERSIBILITY nothing has judged — the keyword pre-gate is best-effort by
    // design, so a paraphrased irreversible action is caught only by the brain's own
    // ESCALATE, which is exactly what is missing when the brain is down. Those raise
    // bare, keeping the worker's own question as the owner's primary text.
    // 'irreversible'/'policy' are not wrapped either: both are already correctly
    // addressed, so asking who owns them would be noise.
    // ONE source for both surfaces below. `why` cannot stand in for either: it is
    // 'insufficient-info' on the failure paths too (see the note above).
    const abstained = ans?.kind === 'escalate' && !!ans.abstained
    const plainQuestion = abstained
      ? buildUnclassifiedRoutingPlainQuestion(r.question)
      : undefined
    await raiseToInbox(deps, now, ov, {
      projectPath: engine.path,
      question: r.question,
      context: `${r.context}\n\n(監督の proxy 判断: ${reason})`,
      ...(plainQuestion ? { plainQuestion } : {}),
      whyEscalated: why,
      receiptKey: defaultReceiptKey({ projectPath: engine.path, taskId: r.taskId, question: r.question }),
      taskId: r.taskId,
      branch: r.branch,
      // Whole handle — the owner's answer to THIS record is delivered through
      // the record's persisted address (swarmEscalations.deliverAnswer).
      target: targetOf(r),
      // Same `abstained` gate, for the same reason the plainQuestion uses it: keyed
      // on `why` this read TRUE for a crashed / unparseable / timed-out brain, so the
      // UI labelled a FAILURE as a considered abstention ("コーパスが薄い") and swapped
      // the real reason for that generic line. Keyed on `abstained`, a failure now
      // renders its own `reason` — "proxy brain failed: …" — which is the truth and
      // the thing the owner needs to act on. (Pre-existing on origin/main; the
      // `abstained` flag this branch added is what makes the fix a one-liner.)
      proxyDraft: { answer: reason, confidence: 'low', isAbstention: abstained },
    })
    log('info', `overseer: proxy escalated a worker question (${why}) → inbox: ${shorten(r.question)}`)
  }
}

// ── S4 — worker free-text questions (the brain-ignition path) ────────────────────

const detectWorkerQuestions = async (
  engine: OverseerEngine,
  ov: OverseerRuntime,
  log: OverseerLog,
  deps: OverseerDeps,
  now: number,
  config: OverseerThresholds,
  usageWarn: boolean,
  fired: OverseerSignalId[],
  activeSeen: Set<string>,
): Promise<void> => {
  const live = engine.workers.filter((w) => deps.isAlive(w))
  for (const w of live) {
    const hb = await deps.readHeartbeat(engine.path, w.branch).catch(() => null)
    if (!hb?.blocked) continue
    const blockerText = (hb.blockers ?? hb.note ?? '').trim()
    if (!blockerText || !looksLikeQuestion(blockerText)) continue

    // ⚠ `workerKey`, NEVER `w.terminalId`. Every SDK worker's terminalId is the
    // EMPTY STRING (pty ⇔ terminalId, sdk ⇔ sdkSessionId), so `S4:${terminalId}`
    // gave the WHOLE SDK FLEET one shared slot in `seen` — and a dedup map with
    // one slot per fleet dedups nothing. Two blocked workers overwrite each
    // other's fingerprint on every pass, so both questions re-fire on every pass:
    // in the brain lane that re-charges the 大脳's 24/day cap and lets the two
    // steal the single-flight from each other indefinitely (a THIRD blocked
    // worker is never reached), and in the THROTTLED lane it re-raises both
    // questions every tick. The receiptKey keeps the inbox itself from growing,
    // which is exactly why nothing about this is visible from the owner's side.
    // The engine's other per-worker maps (nudges, rateLimited, questionWaits…)
    // moved to workerKey for this reason; this table did not follow.
    //
    // A malformed handle THROWS there by design (a shared "" key is worse than a
    // loud failure), and this loop sits inside the pass's try — so an unaddressable
    // worker would take the WHOLE pass down, skipping S5/S7/S11 and the prune. Skip
    // that worker instead: it is the only one affected, and it is now named in the log.
    let signalKey: string
    try {
      signalKey = `S4:${workerKey(w)}`
    } catch (e) {
      log('warn', `overseer: S4 skipped — unaddressable worker on ${w.branch}: ${errMsg(e)}`)
      continue
    }
    const fp = defaultReceiptKey({ projectPath: engine.path, taskId: w.taskId, question: blockerText })
    activeSeen.add(signalKey)
    if (ov.seen.get(signalKey) === fp) continue // already handled THIS exact question

    const context = `worker ${w.branch}（${w.taskTitle}）が blocked で自分では判断できない質問を心拍に記録。`

    // THROTTLED (S9): the brain is paused — send the BARE question straight to the
    // inbox (proxyDraft-less). The枠-starved moment is when a human is MOST needed;
    // don't leave a silent gap (§5 / §6 S4).
    if (ov.throttled) {
      const ok = await raiseToInbox(deps, now, ov, {
        projectPath: engine.path,
        question: blockerText,
        context: `${context}\n\n(監督が使用量上限で縮退中のため proxy 判断を経由せず直行。)`,
        whyEscalated: 'policy',
        receiptKey: fp,
        taskId: w.taskId,
        branch: w.branch,
        // The roster worker IS a WorkerHandle — hand it over whole. This lane is
        // the S9-degraded one, i.e. the moment the owner is MOST needed, and it
        // used to pass `w.terminalId` (empty for every SDK worker), so the bare
        // question landed in the inbox with nowhere to send the reply.
        target: w,
      })
      if (ok) {
        ov.seen.set(signalKey, fp)
        fired.push('S4')
        log('warn', `overseer: S4 (THROTTLED) — bare question → inbox: ${w.branch} (${shorten(blockerText)})`)
      }
      continue
    }

    // Normal: the budgeted, single-flight, fire-and-forget brain (T1).
    const budget = brainBudget(ov, now, config, usageWarn)
    if (!budget.ok) {
      log('info', `overseer: S4 skipped — ${budget.reason}: ${w.branch} (${shorten(blockerText)})`)
      continue // NOT marked seen → re-evaluated next pass when budget frees
    }

    // Mark seen + charge the budget NOW so a slow brain doesn't relaunch next pass.
    ov.seen.set(signalKey, fp)
    ov.assessInFlight = true
    ov.lastBrainAt = now
    ov.brainCallsToday += 1
    fired.push('S4')
    const controller = new AbortController()
    ov.brainAbort = controller
    // The WHOLE handle rides to the mailbox — the drain has to be able to address
    // this worker on its own runtime hours later (see OverseerBrainResult).
    const coords = {
      taskId: w.taskId,
      branch: w.branch,
      ...(w.runtime ? { runtime: w.runtime } : {}),
      ...(w.terminalId ? { terminalId: w.terminalId } : {}),
      ...(w.sdkSessionId ? { sdkSessionId: w.sdkSessionId } : {}),
    }
    // Park the mailbox coordinates for the watchdog: only IT can deliver this
    // question if the flight never settles (see the force-release above).
    ov.brainInFlight = { signalKey, question: blockerText, context, ...coords }
    log('info', `overseer: S4 → waking the proxy brain for a worker question: ${w.branch} (${shorten(blockerText)})`)
    // FIRE-AND-FORGET (D2): NEVER awaited. The result lands in the mailbox for the
    // next pass to route. answerAsOwner never throws, but guard the chain anyway.
    void deps
      .answerAsOwner({ question: blockerText, context, projectPath: engine.path }, controller.signal)
      .then((answer) => {
        ov.brainResults.push({ signalKey, question: blockerText, context, answer, ...coords })
      })
      .catch((e) => {
        ov.brainResults.push({
          signalKey,
          question: blockerText,
          context,
          answer: null,
          ...coords,
        })
        log('warn', `overseer: proxy brain chain errored — ${errMsg(e)}`)
      })
      .finally(() => {
        // Release the single-flight ONLY while this flight still owns it. After a
        // watchdog force-release a NEW brain may already be in flight (a fresh
        // controller): this STALE settle must not clobber its assessInFlight /
        // brainAbort — that would both let a THIRD brain launch (double budget)
        // and orphan the new brain's abort handle. The owner-OFF teardown only
        // calls brainAbort.abort() (never reassigns it), so ownership still reads
        // true there and the normal release proceeds.
        if (ov.brainAbort === controller) {
          ov.assessInFlight = false
          ov.brainAbort = undefined
          ov.brainInFlight = undefined
        }
      })
    // ONE brain per pass (single-flight) — stop scanning; other blocked workers wait.
    return
  }
}

// ── S1/S2 — state-derived escalations (T3), in-pass every tick (zero-cost) ───────
//
// ADDRESSING AUDIT (2026-07-18, the WHO-decides card). Every TEMPLATE raise below
// — S1, S2, S3, S10, S5, plus the orchestrator's no-model raise — was re-read
// against the owner's 「関与の観測地図」 (swarmDecisionRouting.ts). FINDING: NONE
// needed changing. Each one asks what to DO WITH THE WORK (retry / split / give
// up / resume / put back) or flips a standing policy switch (the allowed-model
// mask) — both squarely in the areas the owner is observed to decide (進め方の戦略
// / 恒久境界). None asks them to pick an implementation, an algorithm, a library,
// or any engineering trade-off. The routing rules therefore constrain the two
// lanes whose text is NOT template-authored — the worker's own questions
// (WORKER_ORDER_RULES) and the proxy brain's verdict (the brain prompt) — while
// these templates stand as written. Keep it that way: a new template raise must
// name an owner-domain choice, not delegate a technical decision.

const detectStateAnomalies = async (
  engine: OverseerEngine,
  ov: OverseerRuntime,
  log: OverseerLog,
  deps: OverseerDeps,
  now: number,
  fired: OverseerSignalId[],
  activeSeen: Set<string>,
): Promise<void> => {
  // S1 rework-exhausted — straight off this pass's anomalies (durable, zero-cost).
  for (const a of engine.anomalies) {
    if (a.kind !== 'rework-exhausted') continue
    const signalKey = `S1:${a.ref}`
    const fp = `rework:${a.attempts ?? '?'}`
    activeSeen.add(signalKey)
    if (ov.seen.get(signalKey) === fp) continue
    const who = a.taskTitle ? `"${a.taskTitle}"` : a.ref
    const ok = await raiseToInbox(deps, now, ov, {
      projectPath: engine.path,
      question: `差し戻し上限を超えて blocked 入りしたカード ${who} をどうしますか？（設計見直し / 諦めて放置 / 分割して再依頼）`,
      context: `review→doing の差し戻しが ${a.attempts ?? '?'} 回で上限超過し 'blocked' に退避。本人の方針判断が要ります。`,
      plainQuestion:
        `${who} の作業をAIに${a.attempts ?? '数'}回やり直させましたが、検査に合格しませんでした。この作業をどうするか決めてください。\n` +
        'A: 頼み方や作業の分け方を見直して、もう一度やらせる（やり方を変えて再挑戦します）\n' +
        'B: この作業はいったん諦めて保留のままにする（ほかの作業はそのまま続きます）',
      whyEscalated: 'policy',
      receiptKey: `S1:${engine.path}:${a.ref}:${a.attempts ?? 0}`,
      taskId: a.ref,
      branch: a.branch,
    })
    if (ok) {
      ov.seen.set(signalKey, fp)
      fired.push('S1')
      log('warn', `overseer: S1 rework-exhausted → inbox: ${who}`)
    }
  }

  // S2 all-workers-down — the engine's own durable rising-edge flag (notified),
  // set by fireFatalNotifications this pass. A LEVEL signal there; the overseer's
  // `seen` gives it the once-per-episode edge.
  if (engine.notified.has('all-workers-down')) {
    const signalKey = 'S2:all-workers-down'
    const fp = '1'
    activeSeen.add(signalKey)
    if (ov.seen.get(signalKey) !== fp) {
      const ok = await raiseToInbox(deps, now, ov, {
        projectPath: engine.path,
        question: '全ワーカーが停止し doing が宙吊りです。どう復旧しますか？（原因を調べて再依頼 / 一旦停止）',
        context: '稼働中のワーカーが0になり doing のカードが進みません（全員 crash/stall）。auto-drain で復旧しない場合は本人判断が要ります。',
        plainQuestion:
          '作業していたAIが全員止まってしまい、やりかけの仕事が宙に浮いています。どうしますか？\n' +
          'A: もう一度AIを動かして、続きをやらせる（これまでの成果は残っています）\n' +
          'B: いったんこのまま止めておく（あとで再開できます。データは消えません）',
        whyEscalated: 'policy',
        receiptKey: `S2:${engine.path}:all-workers-down`,
      })
      if (ok) {
        ov.seen.set(signalKey, fp)
        fired.push('S2')
        log('warn', 'overseer: S2 all-workers-down → inbox')
      }
    }
  }
}

// ── S3/S10 — edge fatals (T3), re-read from the durable store on the sub-cycle ────

const detectEdgeFatals = async (
  engine: OverseerEngine,
  ov: OverseerRuntime,
  log: OverseerLog,
  deps: OverseerDeps,
  now: number,
  config: OverseerThresholds,
  fired: OverseerSignalId[],
  activeSeen: Set<string>,
): Promise<void> => {
  // S3 exec-timeout / S10 rollback+canary-failed — EDGE fatals fireFatalNotifications
  // already drained from pendingFatal, so re-read them from the durable notification
  // store (M6), WINDOWED to fatalWindowMs: the store never expires its records, so an
  // unwindowed read would replay every stored fatal as "new" on each re-arm/restart
  // (ov.seen is in-memory — a restart resets it; the window + the persistent receipt
  // check below are what make that reset safe).
  const windowStart = now - config.fatalWindowMs
  let fatals: TimedSwarmFatal[]
  try {
    fatals = await deps.recentFatals(windowStart)
  } catch {
    // Fatal-store read FAILED — indistinguishable from 'no fatals' if we let the
    // every-pass prune drop S3/S10 keys, so a transient blip would re-raise an
    // already-answered fatal on recovery. Retain existing S3/S10 keys this pass so
    // only a SUCCESSFUL read can conclude a fatal cleared (MF1 read-failure guard).
    for (const k of Array.from(ov.seen.keys())) if (k.startsWith('S3:') || k.startsWith('S10:')) activeSeen.add(k)
    return
  }
  const canon = engine.path
  // The occurrence key is id:event:ref:createdAt. createdAt (the store's append
  // time) is the occurrence's identity: the same card failing again later is a NEW
  // record with a NEW createdAt (raises once), while re-reading the SAME record —
  // every sub-cycle, or after a restart — keeps the same key (never re-raises).
  // It also subsumes the old detail-in-key churn fix (two same-ref records now
  // differ by createdAt, each getting its own 1-shot slot) without detail's
  // unbounded length leaking into the 512-char receiptKey clamp.
  interface FatalCandidate {
    id: OverseerSignalId
    f: SwarmFatalNotification
    ref: string
    signalKey: string
    receiptKey: string
  }
  const fresh: FatalCandidate[] = []
  const fp = '1' // 1-shot: the key already encodes the occurrence; raise once until pruned
  for (const { fatal: f, createdAt } of fatals) {
    // Defense-in-depth: re-enforce the window locally so an out-of-contract
    // recentFatals (or a stale test fake) can never act past it.
    if (createdAt < windowStart) continue
    if (f.projectPath && f.projectPath !== canon) continue
    let id: OverseerSignalId | null = null
    if (f.event === 'exec-timeout') id = 'S3'
    else if (f.event === 'rollback' || f.event === 'canary-failed') id = 'S10'
    if (!id) continue
    const ref = f.taskId ?? f.branch ?? f.event
    const signalKey = `${id}:${f.event}:${ref}:${createdAt}`
    activeSeen.add(signalKey)
    if (ov.seen.get(signalKey) === fp) continue
    fresh.push({ id, f, ref, signalKey, receiptKey: `${id}:${canon}:${ref}:${createdAt}` })
  }
  if (fresh.length === 0) return

  // PERSISTENT receipt check: ov.seen alone cannot survive a restart/re-arm, but the
  // escalation a raise created does. A record with the same receiptKey — whatever its
  // status: open (dedup would no-op anyway), answered, or DISMISSED — proves this
  // occurrence already reached the owner; dismissing it must stick forever, not just
  // until the next restart (the "dismiss doesn't stop the re-post" half of the bug).
  // The dep is the STRICT reader (listEscalationReceiptKeys), NOT the tolerant
  // listEscalations: the tolerant read folds a corrupt/unreadable ledger into [],
  // which this catch can never see — the guard would be fail-open in the real wiring.
  let receipted: ReadonlySet<string>
  try {
    receipted = await deps.listReceiptKeys(canon)
  } catch {
    // Receipt ledger unreadable/corrupt — raising blind could re-post a dismissed
    // fatal (the exact bug). Skip raising this sub-cycle; seen stays unset for the
    // fresh keys, so the next sub-cycle re-evaluates them once the ledger reads again.
    return
  }

  for (const c of fresh) {
    if (receipted.has(c.receiptKey)) {
      // Already receipted on disk — mark seen so later sub-cycles skip the ledger
      // read for this occurrence, and raise nothing.
      ov.seen.set(c.signalKey, fp)
      continue
    }
    const ok = await raiseToInbox(deps, now, ov, {
      projectPath: engine.path,
      // S3 carries TWO different situations under one event, and they need opposite
      // questions (2026-07-18). A never-ready worker really is a "split it up or
      // drop it" decision. A worker that had ALREADY delivered is NOT: its branch
      // holds integrable work, its card is back in 'review', and the judgement is
      // the commander's. Offering "split it up and retry" there is not merely noise
      // — an answered escalation whose worker is gone is queued into the card's NEXT
      // dispatch as a directive, so that answer would order a fresh worker to redo
      // finished work. The owner's only real call is whether to abandon it.
      question:
        c.id === 'S3'
          ? c.f.execTimeoutKind === 'integration-wait'
            ? c.f.execTimeoutShape === 'capped-wait'
              ? `カード "${c.f.taskTitle ?? c.ref}" は ready 到達後、統合待ちが控除上限を超えて長引いたため停止しました（再作業はしていません）。成果はブランチに残り、カードは review にあります（統合の可否は司令官が判断します）。この作業自体を見送りますか？`
              : c.f.execTimeoutShape === 'work'
                ? `カード "${c.f.taskTitle ?? c.ref}" は ready 到達後、実作業が作業上限に達して停止しました（待ち時間が原因ではありません）。成果はブランチに残り、カードは review にあります（統合の可否は司令官が判断します）。この作業自体を見送りますか？`
                : `カード "${c.f.taskTitle ?? c.ref}" は一度 ready に到達した後、差し戻し後の再作業で作業上限に達して停止しました。成果はブランチに残り、カードは review にあります（統合の可否は司令官が判断します）。この作業自体を見送りますか？`
            : `カード "${c.f.taskTitle ?? c.ref}" が実行時間上限を超えました。分割して再依頼しますか、それとも見送りますか？`
          : `エンジン自己入替が失敗し旧版で動作中です（${c.f.event}）。どう対応しますか？`,
      context: c.f.detail,
      plainQuestion:
        c.id === 'S3'
          ? c.f.execTimeoutKind === 'integration-wait'
            ? c.f.execTimeoutShape === 'capped-wait'
              ? // 手直しはしていない。順番待ちが長かっただけ、と正確に言う。
                `「${c.f.taskTitle ?? c.ref}」はできあがったあと、取り込みの順番待ちが長引いたので、いったん担当を降ろしました。手直しはしていません（時間を使い切った原因は待ち時間で、失敗でもありません）。できあがった分はそのまま残っていて、取り込むかどうかは担当（司令官）が中身を見て決めます。あなたが決めることは基本ありません。\n` +
                'A: このまま任せる（担当が中身を確認して取り込みます）\n' +
                'B: この作業は見送る（できあがった分も取り込みません）'
              : c.f.execTimeoutShape === 'work'
                ? // 待ちでも手直しでもなく、純粋に作業時間を使い切った。順番待ちの
                  // せいにすると事実に反する(このワーカーはずっと働いていた)。
                  `「${c.f.taskTitle ?? c.ref}」はできあがったあとも作業を続け、持ち時間を使い切ったので、いったん担当を降ろしました。順番待ちのせいではありません。できあがった分は残っていて、取り込むかどうかは担当（司令官）が中身を見て決めます。あなたが決めることは基本ありません。\n` +
                  'A: このまま任せる（担当が中身を確認して取り込みます）\n' +
                  'B: この作業は見送る（残っている分も取り込みません）'
                : `「${c.f.taskTitle ?? c.ref}」は一度できあがったのですが、その後の手直しが持ち時間を使い切って途中で止まりました。できあがった分は残っていて、取り込むかどうかは担当（司令官）が中身を見て決めます。あなたが決めることは基本ありません。\n` +
                  'A: このまま任せる（担当が中身を確認して取り込みます）\n' +
                  'B: この作業は見送る（残っている分も取り込みません）'
            : `「${c.f.taskTitle ?? c.ref}」の作業が持ち時間を使い切ったため、途中で打ち切られました。書きかけの成果は保存されています。どうしますか？\n` +
              'A: 作業を小さく分けて、もう一度やらせる（持ち時間内に終わりやすくなります）\n' +
              'B: この作業は見送る（今回の変更は取り込まれません）'
          : 'このアプリ自身を新しい版に入れ替えようとして失敗したため、自動で元の版に戻して動いています。故障ではありませんが、直近の改善分は反映されていません。どうしますか？\n' +
            'A: 入れ替えに失敗した原因の調査を、新しい作業としてAIに頼む\n' +
            'B: このまま様子を見る（次に入れ替えが成功するまで、今の版のまま動き続けます）',
      whyEscalated: 'policy',
      receiptKey: c.receiptKey,
      taskId: c.f.taskId,
      branch: c.f.branch,
    })
    if (ok) {
      ov.seen.set(c.signalKey, fp)
      fired.push(c.id)
      log('warn', `overseer: ${c.id} ${c.f.event} → inbox: ${shorten(c.f.detail)}`)
    }
  }
}

// ── S5 — blocked-column dwell (T3 after a continuous 30min) ──────────────────────

const columnOf = (t: ProjectTask): string => t.boardColumn ?? (t.done ? 'done' : 'todo')

const detectBlockedDwell = async (
  engine: OverseerEngine,
  ov: OverseerRuntime,
  tasks: readonly ProjectTask[],
  log: OverseerLog,
  deps: OverseerDeps,
  now: number,
  config: OverseerThresholds,
  fired: OverseerSignalId[],
  activeSeen: Set<string>,
  activeWatch: Set<string>,
): Promise<void> => {
  for (const t of tasks) {
    if (columnOf(t) !== 'blocked') continue
    // The daily fuel report's proposal cards SIT in blocked by design (it is the
    // human-judgment lane — see dailyFuelReport.ts). They are not waiting on a
    // dependency, so S5's question 「依存は解けましたか？」 is meaningless for
    // them, and the report already told the owner when it filed one. Firing here
    // would be a second nag, worded for a situation the card is not in.
    if (t.fuelProposalKey) continue
    const watchKey = `S5:${t.id}`
    activeWatch.add(watchKey)
    const prev = ov.watch.get(watchKey)
    if (!prev) {
      ov.watch.set(watchKey, { since: now, fp: t.id })
      continue // start the dwell clock; do not fire yet
    }
    if (now - prev.since < config.blockedStuckMs) continue // still dwelling
    const signalKey = `S5:${t.id}`
    const fp = `blocked:${prev.since}`
    activeSeen.add(signalKey)
    if (ov.seen.get(signalKey) === fp) continue
    // T3 (weak form): raise to the inbox — blocked is a HUMAN-judgment column; the
    // overseer never moves it back itself (§6 S5). Set `seen` only on a successful raise.
    const ok = await raiseToInbox(deps, now, ov, {
      projectPath: engine.path,
      question: `カード "${t.title ?? t.id}" が blocked のまま30分以上滞留しています。依存は解けましたか？（todo へ戻す / このまま保留）`,
      context: 'blocked 列で長く止まっているカード。列移動は本人の判断です（監督は自動で動かしません）。',
      plainQuestion:
        `「${t.title ?? t.id}」の作業が「保留」の置き場に入ったまま、30分以上動いていません。保留にした理由（何かの順番待ちなど）がもう解決していれば、戻すと作業が再開されます。どうしますか？\n` +
        'A: 順番待ちの列に戻して、作業を再開させる\n' +
        'B: このまま保留にしておく（勝手に動かすことはありません）',
      whyEscalated: 'policy',
      receiptKey: `S5:${engine.path}:${t.id}`,
      taskId: t.id,
    })
    if (ok) {
      ov.seen.set(signalKey, fp)
      fired.push('S5')
      log('info', `overseer: S5 blocked-dwell 30min → inbox: ${shorten(t.title ?? t.id)}`)
    }
  }
}

// ── S7 — mergeable review cards idle (T0' info after 30min) ──────────────────────

const detectReviewIdle = async (
  engine: OverseerEngine,
  ov: OverseerRuntime,
  tasks: readonly ProjectTask[],
  log: OverseerLog,
  deps: OverseerDeps,
  now: number,
  config: OverseerThresholds,
  fired: OverseerSignalId[],
  activeSeen: Set<string>,
  activeWatch: Set<string>,
): Promise<void> => {
  // Mergeable = a review card whose branch is fast-forwardable now (engine.reviews).
  const mergeable = engine.reviews.filter((r) => r.status === 'ff')
  const watchKey = 'S7:review-idle'
  if (mergeable.length === 0) {
    // cleared — nothing dwelling; prune happens via activeWatch omission
    return
  }
  activeWatch.add(watchKey)
  const prev = ov.watch.get(watchKey)
  if (!prev) {
    ov.watch.set(watchKey, { since: now, fp: String(mergeable.length) })
    return
  }
  if (now - prev.since < config.reviewIdleMs) return
  const signalKey = 'S7:review-idle'
  const fp = `since:${prev.since}`
  activeSeen.add(signalKey)
  if (ov.seen.get(signalKey) === fp) return
  ov.seen.set(signalKey, fp)
  fired.push('S7')
  // T0' — info notice ONLY (never the inbox — §6 S7). Landing is the commander's.
  await deps
    .notifyInfo({
      event: 'review-idle',
      detail: `統合可能な review カードが ${mergeable.length} 件、30分以上溜まっています。`,
      projectPath: engine.path,
    })
    .catch(() => {})
  log('info', `overseer: S7 review-idle 30min → info notice (${mergeable.length} mergeable)`)
}

// ── S11 — inbox open-record staleness (T0' re-notify after 6h; NEVER auto-progress) ──

const detectInboxStale = async (
  engine: OverseerEngine,
  ov: OverseerRuntime,
  log: OverseerLog,
  deps: OverseerDeps,
  now: number,
  config: OverseerThresholds,
  fired: OverseerSignalId[],
  activeSeen: Set<string>,
): Promise<void> => {
  let open: EscalationView[]
  try {
    open = await deps.listEscalations({ projectPath: engine.path, status: 'open' })
  } catch {
    // Inbox read FAILED — indistinguishable from 'all resolved' if we let the
    // every-pass prune drop S11 keys, so a transient blip would re-notify inside the
    // SAME 6h bucket (MF1's duplicate-notification class). Retain existing S11 keys
    // this pass so only a SUCCESSFUL read can conclude a record resolved.
    for (const k of Array.from(ov.seen.keys())) if (k.startsWith('S11:')) activeSeen.add(k)
    return
  }
  for (const e of open) {
    const created = Date.parse(e.createdAt)
    if (!Number.isFinite(created) || now - created < config.inboxStaleMs) continue
    // Fingerprint = escalation id + 6h bucket, so it re-notifies at most once per 6h
    // window and NEVER auto-progresses (fail-closed — K6 / §8 invariant 1).
    const bucket = Math.floor((now - created) / config.inboxStaleMs)
    const signalKey = `S11:${e.id}`
    const fp = `bucket:${bucket}`
    activeSeen.add(signalKey)
    if (ov.seen.get(signalKey) === fp) continue
    ov.seen.set(signalKey, fp)
    fired.push('S11')
    await deps
      .notifyInfo({
        event: 'escalation-reminder',
        detail: `受信箱の未回答が ${Math.round((now - created) / 3_600_000)} 時間放置されています。`,
        projectPath: engine.path,
        escalationId: e.id,
      })
      .catch(() => {})
    log('info', `overseer: S11 inbox-stale re-notify → ${e.id}`)
  }
}

// ── Prune seen/watch for resolved conditions (recurrence re-fires — §6) ──────────

/** seen-keys owned by the M11 SUB-CYCLE detectors (S3/S10 edge fatals, S11 inbox
 *  staleness). They re-register into activeSeen only on a sub-cycle pass (~60s),
 *  while prune runs EVERY pass (~3s) — so on a non-subcycle pass their absence from
 *  activeSeen means "detector didn't run", NOT "condition resolved". Deleting them
 *  there broke the S11 6h-bucket dedup and re-notified the owner every sub-cycle. */
const SUBCYCLE_SEEN_RE = /^(?:S3|S10|S11):/

const pruneTracking = (
  ov: OverseerRuntime,
  activeSeen: Set<string>,
  activeWatch: Set<string>,
  subcycleRan: boolean,
): void => {
  for (const k of Array.from(ov.seen.keys())) {
    // Keep an in-flight brain's S4 key until the mailbox drains it (its worker may
    // not read as blocked between the raise and the answer landing).
    if (activeSeen.has(k)) continue
    // Sub-cycle keys survive a pass whose sub-cycle detectors never ran — only a
    // pass that actually re-evaluated them may conclude the condition resolved.
    if (!subcycleRan && SUBCYCLE_SEEN_RE.test(k)) continue
    ov.seen.delete(k)
  }
  for (const k of Array.from(ov.watch.keys())) {
    if (activeWatch.has(k)) continue
    ov.watch.delete(k)
  }
}
