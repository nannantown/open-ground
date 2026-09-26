// Deterministic monitoring: raise questions to the owner, report failures and
// usage limits, and run bounded cleanup. Never answer on the owner's behalf.

import type { ProjectTask, OrchestratorAnomaly, OrchestratorReview } from '../types'
import type { SwarmInfoNotification, SwarmFatalNotification, EscalationStatus } from '../types'
// TYPE-ONLY import from the orchestrator (erased at compile time) so there is NO
// runtime import cycle: the orchestrator imports runOverseerPass (a value) from here;
// this file must never import a VALUE back. The readHeartbeat/isAlive VALUES the pass
// needs are handed in through OverseerDeps (the orchestrator already owns them).
import type { HeartbeatSign } from './swarmOrchestrator'
import { workerKey, type WorkerHandle } from './workerRuntime'
import {
  openEscalation as realOpenEscalation,
  defaultReceiptKey,
  listEscalations as realListEscalations,
  listEscalationReceiptKeys,
  type OpenEscalationInput,
} from './swarmEscalations'
import type { Escalation, EscalationView } from '../types'
import { usageLevel } from '../usageThresholds'
import { peekCachedUsage, refreshUsageCacheDetached } from './claudeUsageCli'
import { runSwarmJanitor } from './swarmJanitor'
import { createSwarmInfoNotification, listSwarmNotifications } from './swarmNotifications'

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// ── Threshold table (§6 正典 — ONE place; tests reference these, never re-literalise) ──

/** The overseer's tunable constants — the single source the pass AND its tests read
 *  (SWARM_LAUNCH_MODEL-style one-place discipline). Durations reuse the existing
 *  STALL/QUIET/usage lockstep where the design pins them (10min/30min/80-100), plus
 *  the new overseer values (30min dwell and 6h re-notify). */
export interface OverseerThresholds {
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
}

export const OVERSEER_THRESHOLDS: OverseerThresholds = {
  blockedStuckMs: 30 * 60_000, // 30min (lockstep with QUIET/STALL band)
  reviewIdleMs: 30 * 60_000, // 30min
  inboxStaleMs: 6 * 60 * 60_000, // 6h
  usagePollMs: 60_000, // 60s
  escalationsPollMs: 60_000, // 60s
  fatalWindowMs: 24 * 60 * 60_000, // 24h — only fatals this fresh may open an escalation
  janitorMs: 15 * 60_000, // 15min
  usageBackoffMaxMs: 15 * 60_000,
}

/** The signal → Tier map (§6 表), as DATA so the pass is table-driven and the table
 *  is the single legible spec. Detection logic per row differs (anomaly / fatal /
 *  heartbeat / usage / dwell), but the id → tier → note mapping lives here so a
 *  reader (and the log) can name every fire. S6 (todo 枯渇→次タスク起草) is
 *  DELIBERATELY ABSENT — §11 Q4 removed it from C-core's scope (goal generation is
 *  the highest-risk runaway; a later card owns it). */
export type OverseerSignalId = 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S7' | 'S9' | 'S10' | 'S11'
export type OverseerTier = 'T0prime' | 'T3' | 'THROTTLED'

export interface OverseerSignalSpec {
  id: OverseerSignalId
  tier: OverseerTier
  /** One-line description of the edge + action (mirrors the §6 table row). */
  note: string
}

export const OVERSEER_SIGNALS: readonly OverseerSignalSpec[] = [
  { id: 'S1', tier: 'T3', note: 'rework-exhausted (anomaly): raise to the inbox' },
  { id: 'S2', tier: 'T3', note: 'all-workers-down (fatal): raise to the inbox' },
  { id: 'S3', tier: 'T3', note: 'exec-timeout (fatal): raise to the inbox' },
  { id: 'S4', tier: 'T3', note: 'worker free-text question: owner inbox' },
  { id: 'S5', tier: 'T3', note: 'blocked-column card dwelt 30min: raise to the inbox' },
  { id: 'S7', tier: 'T0prime', note: 'mergeable review cards idle 30min: info notice' },
  { id: 'S9', tier: 'THROTTLED', note: 'usage over (100%): notify; questions still reach the owner' },
  { id: 'S10', tier: 'T3', note: 'selfUpdate rollback / canary-failed (fatal): raise to the inbox' },
  { id: 'S11', tier: 'T0prime', note: 'inbox open record unanswered 6h: re-notify once' },
] as const

/** Per-engine overseer state (§5). In-memory ONLY — held on the ProjectEngine, which
 *  lives on globalThis; a server restart resets it, which also re-arms `enabled` OFF
 *  (fail-safe, K2). watch/seen reset on restart too, so dwell timers restart from zero
 *  (a firing that's LATER = the safe direction — §5). */
export interface OverseerRuntime {
  /** Armed? Default OFF — only the owner-gated setOverseer flips it true; an explicit
   *  autonomy OFF (stopOrchestrator) or a restart drops it false (D1). */
  enabled: boolean
  /** Edge dedup: signalKey → fingerprint. A signal re-fires only when the fp moves. */
  seen: Map<string, string>
  /** Dwell measurement: watchKey → { since, fp }. For S5/S7/S11's "continuous for N". */
  watch: Map<string, { since: number; fp: string }>
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
  seen: new Map(),
  watch: new Map(),
  lastUsageAt: 0,
  usageBackoffUntil: 0,
  lastEscalationsAt: 0,
  lastEscalateAt: 0,
  lastJanitorAt: 0,
  throttled: false,
})

// ── The engine surface the pass reads (structural subset — no back-import cycle) ──

/** The minimal ProjectEngine surface the overseer pass reads — a structural subset,
 *  so this module needs no VALUE import from swarmOrchestrator (avoids a cycle). ProjectEngine satisfies it. */
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
  /** C1 T3 — append an escalation (idempotent on receiptKey). */
  openEscalation: (input: OpenEscalationInput) => Promise<{ escalation: Escalation; deduped: boolean }>
  /** T0'/S7/S9/S11 — info-grade bell + OS toast. */
  notifyInfo: (n: SwarmInfoNotification) => Promise<unknown>
  /** M8 — cached-only usage %, or null (miss/stale/idle). NEVER scrapes. */
  peekUsagePct: () => number | null
  /** M8 — fire a background usage refresh (never awaited). */
  refreshUsage: () => void
  /** M11/S11 — the escalations inbox (open-record staleness). TOLERANT read
   *  (failure ≈ empty) — fine for the info-grade reminder, NOT for the S3/S10
   *  receipt check below. */
  listEscalations: (opts?: {
    projectPath?: string
    status?: EscalationStatus
    lane?: 'owner' | 'commander'
  }) => Promise<EscalationView[]>
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

/** Runtime monitoring dependencies. No model is invoked to answer questions. */
export const defaultOverseerDeps = (io: {
  isAlive: (w: WorkerHandle) => boolean
  readHeartbeat: (projectPath: string, branch: string) => Promise<HeartbeatSign | null>
}): OverseerDeps => ({
  now: () => Date.now(),
  isAlive: io.isAlive,
  readHeartbeat: io.readHeartbeat,
  openEscalation: realOpenEscalation,
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

/** Best-effort JA/EN question detection, distinct from a mechanical blocker. */
export const looksLikeQuestion = (text: string): boolean => {
  const t = text.trim()
  if (!t) return false
  if (/[?？]/.test(t)) return true
  return /(ですか|でしょうか|ますか|のか|どうすれ|どうし|どちら|いずれ|which|should i|how should|what should|shall i|do you want|which one)/i.test(
    t,
  )
}

const shorten = (s: string, max = 80): string => (s.length > max ? `${s.slice(0, max)}…` : s)

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
    /** A worker's own question → the commander lane first (commanderQuestions.ts). */
    askCommanderFirst?: boolean
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
      ...(input.askCommanderFirst ? { askCommanderFirst: true } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.branch ? { branch: input.branch } : {}),
      // The WHOLE address (runtime + the single handle it names). `runtime` is
      // what tells openEscalation's `addressOf` which id is the real one; passing
      // an id without it makes an SDK record un-deliverable, and passing the
      // (empty) terminalId of an SDK worker names nobody at all.
      ...(input.target?.runtime ? { runtime: input.target.runtime } : {}),
      ...(input.target?.terminalId ? { terminalId: input.target.terminalId } : {}),
      ...(input.target?.sdkSessionId ? { sdkSessionId: input.target.sdkSessionId } : {}),
    })
    ov.lastEscalateAt = now
    return true
  } catch {
    // fs/notify hiccup — leave `seen` UNSET (caller only sets it on success) so the
    // next pass retries. The receiptKey keeps a later retry idempotent.
    return false
  }
}

// The monitoring pass shares the engine tick and never throws into it.

export interface OverseerOutcome {
  /** False when the pass short-circuited (disarmed) before observing. */
  ran: boolean
  /** Signal ids that fired an action this pass (for tests + the log). */
  fired: OverseerSignalId[]
  /** True while THROTTLED after this pass. */
  throttled: boolean
}

/** Observe cached state and heartbeats, raising questions and notices on edges.
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
  if (!ov.enabled) return { ran: false, fired: [], throttled: false } // OFF guard (D1)

  const now = deps.now()
  const fired: OverseerSignalId[] = []
  // Keys active THIS pass — used to prune seen/watch for resolved conditions so a
  // genuine recurrence re-fires (pruneStuckMoves discipline).
  const activeSeen = new Set<string>()
  const activeWatch = new Set<string>()

  try {
    // 1. Usage limit notice (S9), from the CACHED % only (M8). Peek every
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
    const nowThrottled = level === 'over'
    if (nowThrottled && !ov.throttled) {
      // S9 rising edge: one T3' info notice on ENTER. Recovery (<100) is silent.
      fired.push('S9')
      await deps
        .notifyInfo({
          event: 'overseer-throttled',
          detail: '使用量が上限に達しています。確認が必要な質問は引き続き受信箱に届きます。',
          projectPath: engine.path,
        })
        .catch(() => {})
      log('warn', 'overseer: usage at/over cap; owner questions remain available')
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

    // 3. Worker questions: commander lane first, owner for boundaries — regardless of usage.
    await detectWorkerQuestions(engine, ov, log, deps, now, fired, activeSeen)

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
    // its dedup and a genuine recurrence re-fires (§6). Sub-cycle
    // detectors (S3/S10/S11) only re-register their keys on a sub-cycle pass, so their
    // keys are prunable ONLY when the sub-cycle actually ran this pass (doSubcycle).
    pruneTracking(ov, activeSeen, activeWatch, doSubcycle)
  } catch (e) {
    // NEVER throw into the tick — a bug here must not disturb dispatch / integrate.
    log('warn', `overseer: pass errored — ${errMsg(e)}`)
  }

  return { ran: true, fired, throttled: ov.throttled }
}

// S4: worker questions go to the commander first (commanderQuestions.ts); the
// owner hears only boundary questions, ones the commander hands on, and ones it
// does not settle within COMMANDER_ANSWER_WINDOW_MS.

const detectWorkerQuestions = async (
  engine: OverseerEngine,
  ov: OverseerRuntime,
  log: OverseerLog,
  deps: OverseerDeps,
  now: number,
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
    // other's fingerprint on every pass, so both questions re-fire on every pass.
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

    const ok = await raiseToInbox(deps, now, ov, {
      projectPath: engine.path,
      question: blockerText,
      context,
      whyEscalated: 'policy',
      receiptKey: fp,
      taskId: w.taskId,
      branch: w.branch,
      target: w,
      // Settled inside the company first — the commander answers or hands on
      // (owner decision 2026-09-23). Boundary questions still go straight to
      // the owner (openEscalation's needsOwnerDirectly).
      askCommanderFirst: true,
    })
    if (ok) {
      ov.seen.set(signalKey, fp)
      fired.push('S4')
      log('info', `overseer: S4 question → inbox (commander first): ${w.branch} (${shorten(blockerText)})`)
    }
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
      context: `review から doing への差し戻しが ${a.attempts ?? '?'} 回で上限超過し 'blocked' に退避。本人の方針判断が要ります。`,
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
      // Only the integration-wait shape offers 「できあがった分も取り込みません」.
      // The runaway branch of S3 says 「今回の変更は取り込まれません」 about a card
      // that recoveryColumn already parked in 'blocked' — it is not in review, so
      // there is nothing to withhold, and declaring the acting effect there would
      // freeze it for no reason.
      ...(c.id === 'S3' && c.f.execTimeoutKind === 'integration-wait'
        ? { declineEffect: 'drop-integration' as const }
        : {}),
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
    // Owner lane only: a commander-lane question is not the owner's to be reminded of.
    open = await deps.listEscalations({ projectPath: engine.path, status: 'open', lane: 'owner' })
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
        // Names the question: the president's desk retells this line, and since
        // the 監督 tab is gone (2026-09-23) there is no inbox screen to point at.
        detail: `答えを待っている質問が ${Math.round((now - created) / 3_600_000)} 時間そのままです: ${(e.plainQuestion || e.question || '').slice(0, 80)}`,
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
