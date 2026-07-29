// swarmQuota — the swarm's model-quota AWARENESS layer. Today the engine treats
// a rate-limited worker as a black box: it holds the slot for a fixed
// RATE_LIMIT_GRACE_MS, then requeues to 'todo' — blind to WHICH model tier is
// exhausted and WHEN it resets. That means a swarm can keep re-dispatching into
// the same wall (the top tier is dry) instead of dropping to a tier that still
// has headroom, and it waits a flat 20 min even when `claude` told us the exact
// reset time.
//
// This module is the pure, shared FOUNDATION that closes that gap (the [Quota]
// card set's Card 1 — Card 2/3 wire it into the engine/routes). It answers two
// questions with no side effects beyond a globalThis singleton:
//   • highestAvailableTier(now) — the best model NOT currently cooling.
//   • allCoolingUntil(now)      — if every tier is cooling, the earliest reset.
//
// DESIGN — why this file imports neither the engine nor the usage sensor:
//   • PURE / clock-injected. Every function takes `now` (epoch ms) rather than
//     calling Date.now(), so a fake clock makes cooling / expiry / cascade
//     deterministic in a unit test (mirrors swarmOrchestrator's isRunaway /
//     classifyOutput discipline). The reads stay SYNCHRONOUS, which is load-
//     bearing: the spawn-path resolver (swarmAllowedModels.isTierSpawnable) is
//     sync and is reached from places that cannot await. So the globalThis table
//     remains the authority for every read; its DISK MIRROR (swarmQuotaStore) is
//     written off to the side and only ever read once, at boot.
//   • PERSISTENT across processes (2026-07-13). The table used to be memory-only,
//     so every restart forgot which tiers were dry and re-learned it by BURNING a
//     session on the wall — and the app is restarted after every release. Now
//     every mutation mirrors to ~/.openground/swarm-quota.json and boot hydrates
//     from it. Fail-safe by construction: an unreadable / corrupt file boots with
//     NO cooling (exactly the old behaviour) plus one engine-log line — it never
//     blocks startup.
//   • No import of swarmOrchestrator. The engine will import THIS (Card 2/3);
//     importing it back would be a cycle. RATE_LIMIT_GRACE_MS is passed in as
//     `graceMs` instead (the caller forwards the engine's value), with a local
//     default that matches it so this module stands alone in tests.
//   • No import of claudeUsageCli (the "A5" usage sensor). The reset time from
//     A5's cached CliUsageSlot.resetsAt is passed in as `a5ResetsAt` (a plain
//     string the caller reads from the EXISTING sync cache — read path only, no
//     mutation, honoring K8). Keeping A5 out of this module is what keeps it
//     pure and free of the sensor's globalThis state / FS watcher.
//
// TIER LADDER — verified live against the CLI on 2026-07-06 (same discipline as
// swarmLaunch's SWARM_LAUNCH_MODEL comment): `claude --model <alias> -p …` was
// ACCEPTED for all of fable / opus / sonnet / haiku (a bogus alias returns
// "There's an issue with the selected model"; fable returned its usage-limit
// notice, which still proves the alias resolves). So all four stay in the
// ladder — none dropped. fable is the top tier (newest flagship, = swarmLaunch's
// SWARM_LAUNCH_MODEL); haiku is the cheapest floor.

import { SWARM_MODEL_TIERS, type SwarmModelTier, type SwarmQuotaTier } from '../types'
import { loadCoolingMarks, saveCoolingMarks, type CoolingMarks } from './swarmQuotaStore'

/** A model tier, by the CLI `--model` alias the swarm launches with. Ordered
 *  best → cheapest by {@link MODEL_TIER_LADDER}; the cooling table is keyed by
 *  these. Same string shape as swarmLaunch's model constants so a tier value can
 *  be handed straight to `--model`. Defined once in the shared client/server
 *  contract (`SwarmModelTier`) so the quota ROUTE's payload and this table can
 *  never drift apart; re-exported under the module's own name. */
export type ModelTier = SwarmModelTier

/** The tier ladder, best (index 0) → cheapest. highestAvailableTier walks this
 *  in order and returns the first tier that is not cooling, so "drop one tier"
 *  is just "the next entry". All four aliases are CLI-verified (see file head).
 *  fable === swarmLaunch.SWARM_LAUNCH_MODEL — the single top-tier constant.
 *  Aliases the shared `SWARM_MODEL_TIERS` (types.ts) so the ladder, the quota
 *  payload and the client's per-tier ON/OFF toggles cannot drift. */
export const MODEL_TIER_LADDER: readonly ModelTier[] = SWARM_MODEL_TIERS

/** Fallback cooling window when no concrete reset time is known — mirrors
 *  swarmOrchestrator.RATE_LIMIT_GRACE_MS (20 min). Duplicated as a local default
 *  (not imported) to avoid an engine→quota→engine import cycle; the engine
 *  passes its own RATE_LIMIT_GRACE_MS as `graceMs` at the call site, so the two
 *  agree in production while this module stays standalone for tests. */
export const DEFAULT_COOLING_GRACE_MS = 20 * 60_000

// ── Cooling table (globalThis singleton — survives tsx watch reloads) ─────────
//
// tier → reset epoch ms. A tier is "cooling" while its stored `until` is in the
// future; expiry is LAZY (a reader treats `until <= now` as available), so no
// timer is needed and a fake clock alone drives Done ② (auto-recovery). Kept on
// globalThis exactly like swarmOrchestrator's engine store and the usage-cli
// cache, so a dev reload doesn't silently forget which tiers are dry — and
// MIRRORED to disk (swarmQuotaStore), so neither does a full restart.
interface QuotaState {
  cooling: Map<ModelTier, number>
  /** Memoized boot hydration (the disk → table load). Lives beside the table on
   *  globalThis so a tsx-watch reload — which resets module scope but keeps the
   *  map — doesn't re-read the file and doesn't resurrect marks the live table
   *  has since dropped. `undefined` = never loaded (the next
   *  {@link ensureCoolingTableLoaded} does the read). */
  loaded?: Promise<void>
  /** Tail of the single-flight persist chain. Every mutation appends to it, so
   *  two writes can't interleave into a torn file and a caller can await the
   *  flush ({@link flushQuotaPersist}). Never rejects (faults are recorded in
   *  `lastPersistError` and logged inside the chain), so one failed save can't
   *  wedge every later one. */
  persist?: Promise<void>
  /** Why the LAST mirror write failed — null/absent when it landed. This is what
   *  makes a failed save VISIBLE: without it the persist chain's own catch would
   *  swallow an EISDIR/EACCES/ENOSPC and the manual-cool route would answer 200
   *  ("it is on disk") for a mark that is only in memory and dies at the next
   *  restart — the exact loop this whole module exists to close. */
  lastPersistError?: string | null
  /** Tiers a mutation has named since the table was last loaded. A load that
   *  lands AFTER a mutation must leave these alone — see persistence rule 2: the
   *  map alone cannot express "the owner just released this tier", so without a
   *  tombstone the hydration would read the released mark straight back in. */
  touched?: Set<ModelTier>
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_swarm_quota: QuotaState | undefined
}

const state: QuotaState =
  globalThis.__openground_swarm_quota ??
  (globalThis.__openground_swarm_quota = { cooling: new Map() })

// ── Persistence (the disk mirror — swarmQuotaStore) ──────────────────────────
//
// The table above stays the AUTHORITY: reads are sync and never touch the disk.
// The file is a mirror, written after each mutation and read once per process.
// Three rules make that safe, and they are the whole trick here:
//
//   1. A SAVE NEVER RUNS BEFORE THE TABLE HAS SEEN THE DISK. A write serialises
//      the WHOLE table, so writing before the load has landed would clobber every
//      tier the file holds and memory doesn't. The chain therefore awaits the load
//      — and if nobody kicked one, it kicks one itself ({@link loadedForWrite}),
//      so the rule holds by CONSTRUCTION rather than by caller discipline.
//   2. A LATE LOAD MUST NOT UNDO A MUTATION. Merging "in-memory wins" (a `has()`
//      check) is enough for a SET but NOT for a DELETE: a cleared tier is absent
//      from the map, which is indistinguishable from "never had it", so the
//      hydration would faithfully read the tier back out of the file and resurrect
//      the very mark the owner just released. {@link touched} closes that: any
//      tier a mutation has named is off-limits to a later load, whatever the map
//      says about it.
//   3. THE TABLE IS SERIALISED INSIDE THE CHAIN, not at call time, so what lands
//      on disk is always the newest state — never a stale snapshot captured before
//      an earlier write in the queue finished.

/** What the mirror did. Returned by {@link flushQuotaPersist} so a CALLER can
 *  tell the truth about durability: the manual-cool route promises "a 200 means
 *  it is on disk", and it can only keep that promise if a failed write is
 *  visible. (Not a client contract — the routes translate it into HTTP.) */
export interface QuotaPersistResult {
  /** True iff the table is mirrored on disk right now. */
  persisted: boolean
  /** Why the last mirror write failed; null when it succeeded. */
  error: string | null
}

/** The table as the file wants it. Verbatim — elapsed marks ride along and are
 *  dropped on LOAD, so the write path needs no clock (see swarmQuotaStore's
 *  header). Walks the LADDER rather than the Map (as every other reader here
 *  does), which bounds the file at 4 entries by construction and writes them in
 *  best→cheapest order — a table a human can read straight out of the JSON. */
const marksFromTable = (): CoolingMarks => {
  const marks: CoolingMarks = {}
  for (const tier of MODEL_TIER_LADDER) {
    const until = state.cooling.get(tier)
    if (until != null) marks[tier] = until
  }
  return marks
}

/** Record that a mutation has spoken for `tier`, so a load that lands afterwards
 *  leaves it alone (rule 2). Called by all three mutations, before they touch the
 *  map. */
const markTouched = (tier: ModelTier): void => {
  ;(state.touched ??= new Set()).add(tier)
}

/** The load a WRITE must wait behind (rule 1). Normally this is just the boot
 *  hydration, already kicked by server/index.ts and awaited by every quota route;
 *  `??=` covers the case where a mutation somehow gets in first (a future caller,
 *  a differently-wired entry point), so a write can never serialise a table that
 *  has never seen the disk.
 *
 *  Clock `0` — i.e. "load everything, drop nothing" — is deliberate and is NOT
 *  the boot semantics. This hydration exists only to stop the write CLOBBERING the
 *  file, not to interpret it, and picking a clock here would drag Date.now() into
 *  a module whose entire contract is clock injection (and would make a fake-clock
 *  test silently expire the very marks it seeded). Loading an elapsed mark is
 *  inert: every reader treats `until <= now` as available, and the write path
 *  already mirrors elapsed marks verbatim. The REAL boot path
 *  ({@link ensureCoolingTableLoaded}) passes the real clock and does drop them. */
const loadedForWrite = (): Promise<void> => (state.loaded ??= hydrateCoolingTable(0))

/** Queue a mirror write of the CURRENT table, and REMEMBER whether it landed.
 *  Fire-and-forget for the sync callers (the engine's sensor path can't await);
 *  awaitable via {@link flushQuotaPersist} for the routes and the tests.
 *
 *  A write fault is recorded, logged, and SWALLOWED — the promise never rejects,
 *  so one bad write can't wedge the chain and a cockpit never falls over because a
 *  ~100-byte cache file wouldn't write. The mark still stands in memory, so the
 *  engine keeps honouring it; only its survival across a restart is lost. That is
 *  the right trade for the engine's sensor path — but it is NOT good enough for
 *  the owner's manual cool, which explicitly promises durability, so the outcome
 *  is kept in `lastPersistError` for {@link flushQuotaPersist} to surface. */
const schedulePersist = (): Promise<void> => {
  const run = (state.persist ?? Promise.resolve())
    .then(loadedForWrite) // rule 1 — never write a table that hasn't seen the disk
    .then(() => saveCoolingMarks(marksFromTable())) // rule 3 — serialise here, not at call time
    .then(
      () => {
        // The file now mirrors the table WHOLE, so an earlier failure is moot.
        state.lastPersistError = null
      },
      (e: unknown) => {
        const detail = e instanceof Error ? e.message : String(e)
        state.lastPersistError = detail
        console.warn(
          `[openground:swarm-quota] failed to persist the cooling table — the marks stand in memory but will be FORGOTTEN on restart: ${detail}`,
        )
      },
    )
  state.persist = run
  return run
}

/** Await every queued mirror write and report whether the table is on disk.
 *
 *  This is what lets `POST /api/swarm/quota/cool` keep its promise: it answers 200
 *  only when this says `persisted`, and 500 otherwise — so a 200 from that route
 *  really does mean "quit the app right now and the mark is still there". Reports
 *  the outcome of the LAST write in the queue; since every write mirrors the whole
 *  table, the last one succeeding means the file is current (and, in the reverse
 *  direction, a failure is never hidden). Never rejects. */
export const flushQuotaPersist = async (): Promise<QuotaPersistResult> => {
  await (state.persist ?? Promise.resolve())
  const error = state.lastPersistError ?? null
  return { persisted: error == null, error }
}

/** Read the persisted marks into the table. Applies the SAME lazy expiry as
 *  {@link isTierCooling} — an elapsed mark (`until <= now`) is simply not loaded,
 *  so a week-old file can't resurrect a stale cooling. Two marks are left alone:
 *  a tier already IN the map (a live signal — a sighting, a manual cool — is newer
 *  than what the disk held), and a tier some mutation has TOUCHED (rule 2: an
 *  uncool empties the map entry, and without this the load would read it straight
 *  back in). Never throws — swarmQuotaStore's read is fail-safe and yields {} for
 *  an unreadable / corrupt file. */
const hydrateCoolingTable = async (now: number): Promise<void> => {
  const marks = await loadCoolingMarks()
  for (const [tier, until] of Object.entries(marks) as [ModelTier, number][]) {
    if (until <= now) continue // elapsed ⇒ available (lazy expiry, same as isTierCooling)
    if (state.cooling.has(tier)) continue // a live mark is newer than the disk
    if (state.touched?.has(tier)) continue // …and so is a live REMOVAL (rule 2)
    // NOT clamped here on purpose: this path's `now` is not guaranteed to be a
    // real wall clock (the write-triggered load has no clock of its own), so
    // clamping against it would corrupt legitimate stored marks. The clamp lives
    // where an inflated value is CREATED — resolveCoolingUntil — which is the only
    // place that can produce one. A mark written before that fix expires on its
    // own within a day; nothing keeps producing new ones.
    state.cooling.set(tier, until)
  }
}

/** Hydrate the table from disk, ONCE per process. Kicked at boot (server/index.ts)
 *  and awaited by the quota routes, so the first `GET /api/swarm/quota` after a
 *  restart reports the tiers that were dry BEFORE it — instead of reporting a
 *  clean slate and sending the next dispatch straight back into the wall (the
 *  "burn one session per restart to re-learn it" loop this closes). Memoized on
 *  the globalThis state, so the extra awaits cost one file read for the whole
 *  process. */
export const ensureCoolingTableLoaded = (now: number): Promise<void> =>
  (state.loaded ??= hydrateCoolingTable(now))

// ── Reset-time parsing (PURE, clock injected) ────────────────────────────────

const unitToMs = (unit: string): number => {
  const u = unit.toLowerCase()
  if (u.startsWith('h')) return 3_600_000 // hour(s), hr(s), h
  if (u.startsWith('m')) return 60_000 // minute(s), min(s), m
  return 1000 // second(s), sec(s), s
}

/** A reset-time LABEL → epoch ms, best-effort, with an injected `now` (PURE — no
 *  Date.now()). Handles the shapes a reset can arrive as, in order:
 *    1. relative   "in 30s" / "in 45 minutes"        → now + delta
 *    2. bare clock "3pm" / "12:30pm (Asia/Tokyo)"    → today, or tomorrow if
 *                                                       that clock already passed
 *    3. abs. date  "May 25 at 3pm (Asia/Tokyo)"      → Date.parse (TZ suffix and
 *                                                       " at " normalized away)
 *  Returns null when nothing parses, so a caller falls through to its next
 *  source. Ports UsageHud.parseCliReset (clocks 1+2 of it) but returns ms and
 *  takes the clock as an argument; the relative case (1) is added for `claude`'s
 *  inline "retrying in 30s" / "resets in N min" runtime wording. */
export const parseResetLabel = (
  label: string | null | undefined,
  now: number,
): number | null => {
  if (!label) return null
  const s = label.trim()
  if (!s) return null

  // (1) relative "in N unit"
  const rel = s.match(/\bin\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i)
  if (rel) {
    const n = Number(rel[1])
    if (Number.isFinite(n)) return now + n * unitToMs(rel[2])
  }

  // (2) bare clock — only when the label STARTS with the time (so an absolute
  // date like "May 25 at 3pm" is NOT misread as today's 3pm; it falls to (3)).
  const clock = s.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b/i)
  if (clock) {
    let hour = Number(clock[1])
    const min = clock[2] ? Number(clock[2]) : 0
    const meridiem = clock[3].toLowerCase()
    if (meridiem === 'pm' && hour !== 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    const d = new Date(now)
    d.setHours(hour, min, 0, 0)
    // ALREADY PAST TODAY ⇒ the SCREEN IS STALE, not "it means tomorrow" (2026-07-29).
    //
    // This used to roll forward a day, and that reading is what turned a
    // 20-minute cooling into a ~23-hour one. The screen text does not change when
    // the limit lifts — the worker's PTY still reads "resets at 3pm" at 3:10pm —
    // and every pass re-parses it against the CURRENT clock. So the same
    // unchanged frame yielded 20 minutes at 14:40 and tomorrow-3pm at 15:10, and
    // that figure was mirrored to disk: the tier stayed parked for a day across
    // restarts, the ladder walked past it, and the engine looked like it had
    // simply stopped dispatching, with nothing in any log saying why.
    //
    // A bare clock carries no date, so "a time that already passed today" is
    // indistinguishable from stale text — and stale is by far the likelier
    // reading of a LIVE screen. Returning null lets the resolver fall through to
    // its next source (A5, then the flat grace), which is the conservative answer:
    // worst case the engine retries early and re-learns the truth from a fresh
    // frame. A genuine future time today ("resets at 3pm" seen at 2pm) is
    // unaffected — that is the case this branch actually exists for.
    if (d.getTime() <= now) return null
    return d.getTime()
  }

  // (3) absolute date — drop a trailing "(Asia/Tokyo)" and collapse " at ".
  const trimmed = s.replace(/\s*\([^)]+\)\s*$/, '').replace(/\s+at\s+/, ' ')
  const ms = Date.parse(trimmed)
  return Number.isFinite(ms) ? ms : null
}

/** Pull a reset time out of a `claude` PTY screen ("limit resets…" / "usage
 *  limit reached… resets at 3pm" / "retrying in 30s") → epoch ms, or null. PURE
 *  (clock injected). It isolates the phrase near "resets"/"retrying" and hands
 *  the tail to {@link parseResetLabel}, so all the label-shape handling lives in
 *  one place. This is the FIRST, most-specific source for a cooling `until`
 *  (the worker's own screen), preferred over A5's cached figure. */
export const extractPtyResetUntil = (
  text: string | null | undefined,
  now: number,
): number | null => {
  if (!text) return null

  // Relative first — "resets in 5 minutes", "retrying in 30s".
  const rel = text.match(
    /\b(?:resets?|retry(?:ing)?)\s+in\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i,
  )
  if (rel) {
    const n = Number(rel[1])
    if (Number.isFinite(n)) return now + n * unitToMs(rel[2])
  }

  // Absolute — "limit (will) reset(s) (at) <time…>" up to sentence/line end.
  const abs = text.match(/\bresets?\s+(?:at\s+)?([^.\n\r]+)/i)
  if (abs) {
    const until = parseResetLabel(abs[1], now)
    if (until != null) return until
  }
  return null
}

/** Resolve the cooling `until` for a freshly rate-limited tier from the three
 *  sources, in priority order (PURE, clock injected):
 *    1. the worker's PTY wording ("limit resets…")     — most specific
 *    2. A5's cached usage reset time (`a5ResetsAt`)      — the sensor's figure
 *    3. now + graceMs                                    — flat fallback
 *  A parsed time that is already in the past is ignored (a stale "reset at 3pm"
 *  from earlier today is useless), so it falls through to the next source. */
export const resolveCoolingUntil = (opts: {
  ptyText?: string | null
  a5ResetsAt?: string | null
  graceMs?: number
  now: number
}): number => {
  const { ptyText, a5ResetsAt, graceMs = DEFAULT_COOLING_GRACE_MS, now } = opts

  const fromPty = extractPtyResetUntil(ptyText, now)
  if (fromPty != null && fromPty > now) return fromPty

  const fromA5 = parseResetLabel(a5ResetsAt, now)
  if (fromA5 != null && fromA5 > now) return fromA5

  return now + Math.max(0, graceMs)
}

// ── Cooling table mutations (the ONLY writes — all land on the globalThis map) ─
//
// There are exactly THREE of them (markCoolingUntil / markRateLimited /
// clearCooling) and every one mirrors to disk via schedulePersist(). If you add a
// fourth, mirror it too — a mutation that skips the mirror is a mark that dies at
// the next restart, silently, which is the whole bug this persistence closes.

/** Low-level: mark `tier` cooling until an ALREADY-RESOLVED epoch ms. Use when
 *  the caller computed `until` itself; most callers want {@link markRateLimited}
 *  which resolves it from the PTY/A5/grace sources. A later mark for the same
 *  tier overwrites (the newest signal wins). Mirrored to disk. */
export const markCoolingUntil = (tier: ModelTier, until: number): void => {
  markTouched(tier)
  state.cooling.set(tier, until)
  void schedulePersist()
}

/** Mark the tier a rate-limited worker was running on as cooling, resolving the
 *  reset `until` from the PTY wording / A5 cache / grace (see
 *  {@link resolveCoolingUntil}). Returns the chosen `until` so the caller can
 *  log/schedule off it.
 *
 *  CASCADE is emergent, not special-cased here: when the top tier is cooling the
 *  engine drops to {@link highestAvailableTier}; if THAT tier's worker is also
 *  rate-limited, the engine calls this again for it, and so on — each tier marks
 *  itself, and the ladder walk naturally settles on the first tier with
 *  headroom. So fable→opus→sonnet cooling "propagates downward" with no extra
 *  logic (see the cascade test). */
export const markRateLimited = (
  tier: ModelTier,
  opts: {
    ptyText?: string | null
    a5ResetsAt?: string | null
    graceMs?: number
    now: number
  },
): number => {
  const resolved = resolveCoolingUntil(opts)
  // NEVER PUSH AN EXISTING DEADLINE LATER (2026-07-29).
  //
  // Every pass re-resolves from the worker's CURRENT screen, and a bare clock
  // label ("resets at 3pm") is re-interpreted against the clock each time —
  // parseResetLabel's rule being "if that time already passed today, it means
  // tomorrow". So the same unchanged screen, read once at 14:40 and again at
  // 15:10, yields 20 minutes and then ~23 HOURS. The later figure is mirrored to
  // disk, so the tier stays parked for a day across restarts, the ladder walks
  // past it, and the engine looks like it simply stopped dispatching — with
  // nothing in any log saying why.
  //
  // While a mark is still in the future, keep the EARLIER deadline. Erring early
  // costs one retry that re-learns the truth from a fresh screen; erring late
  // costs a day of a tier nobody can use. An elapsed mark is not extended either
  // — it is simply replaced, which is how a genuine second rate-limit still cools.
  const existing = state.cooling.get(tier)
  const until = existing != null && existing > opts.now ? Math.min(existing, resolved) : resolved
  markTouched(tier)
  state.cooling.set(tier, until)
  void schedulePersist()
  return until
}

/** Longest a tier may be cooled BY HAND (7 days). The manual-cooling route
 *  (`POST /api/swarm/quota/cool`) exists so the owner can steer a swarm away
 *  from a dry tier without stopping the engine — a packaged `.app` can't be
 *  source-patched — but an unbounded `until` would silently retire a tier for
 *  good. A week is longer than any real reset window (the weekly quota) and
 *  short enough that a forgotten cool self-heals. */
export const MAX_MANUAL_COOLING_MS = 7 * 24 * 3_600_000

/** Undo a cooling mark: `tier` is available again immediately. The owner's
 *  escape hatch when a mark was wrong (a transient 5xx read as exhaustion) —
 *  and the inverse of the manual cool. Absent tier ⇒ no-op (idempotent).
 *
 *  Mirrored to disk, and that direction matters as much as the cooling one: an
 *  uncool must also SURVIVE the restart, or the boot hydration would faithfully
 *  reload the very mark the owner just released. */
export const clearCooling = (tier: ModelTier): void => {
  markTouched(tier) // …so a load landing later cannot read the released mark back in
  state.cooling.delete(tier)
  void schedulePersist()
}

/** Narrow an untrusted string (a request body) to a ladder tier. The routes'
 *  fail-closed guard: an unknown alias is rejected, never cooled by guess. */
export const isModelTier = (v: unknown): v is ModelTier =>
  typeof v === 'string' && (MODEL_TIER_LADDER as readonly string[]).includes(v)

// ── Pure read API (Done ①–③) — reads the table, never mutates it ─────────────

/** True iff `tier` is cooling at `now` — it has a stored reset time still in the
 *  future. A missing entry or an elapsed one (`until <= now`) is available. This
 *  is the LAZY expiry that gives Done ② (auto-recovery) for free: advance the
 *  clock past `until` and the tier is available again, no timer, no cleanup. */
export const isTierCooling = (tier: ModelTier, now: number): boolean => {
  const until = state.cooling.get(tier)
  return until != null && until > now
}

/** The highest (best) tier that is NOT cooling at `now`, or null if every tier
 *  is cooling. Walks the ladder best→cheapest and returns the first available —
 *  so fable cooling ⇒ 'opus', fable+opus cooling ⇒ 'sonnet' (Done ①). */
export const highestAvailableTier = (now: number): ModelTier | null => {
  for (const tier of MODEL_TIER_LADDER) {
    if (!isTierCooling(tier, now)) return tier
  }
  return null
}

/** If EVERY tier is cooling at `now`, the earliest reset time among them (when
 *  the swarm can first resume, on whichever tier frees up first). If even one
 *  tier is available, null — there is no global wait, just launch on that tier
 *  (Done ③). */
export const allCoolingUntil = (now: number): number | null => {
  let earliest: number | null = null
  for (const tier of MODEL_TIER_LADDER) {
    const until = state.cooling.get(tier)
    if (until == null || until <= now) return null // this tier is available
    if (earliest == null || until < earliest) earliest = until
  }
  return earliest
}

/** The whole ladder's cooling state at `now`, best→cheapest — what the quota
 *  route hands the owner so they can SEE which tiers are dry and until when.
 *  Honors the same lazy expiry as {@link isTierCooling}: an elapsed mark reads
 *  as available (`cooling:false`, `until:null`), so a stale row can never look
 *  like a live one. Read-only. */
export const coolingSnapshot = (now: number): SwarmQuotaTier[] =>
  MODEL_TIER_LADDER.map((tier) => {
    const stored = state.cooling.get(tier)
    const cooling = stored != null && stored > now
    return { tier, cooling, until: cooling ? stored : null }
  })

/** Test-only: clear the cooling table. The table lives on globalThis (shared
 *  across a process), so a unit suite must reset it between cases to stay
 *  order-independent. Not used in production.
 *
 *  It also NEUTRALISES hydration (marks the load as already-done-and-empty) and
 *  drops the persist chain. Both matter now that a file exists: without it, a
 *  case that cooled a tier would leave `swarm-quota.json` behind in the suite's
 *  shared tmp HOME, and the NEXT case's route call would faithfully hydrate that
 *  mark back in — a green suite silently leaking cooling across cases. Stays
 *  SYNCHRONOUS (26 call sites use it bare in beforeEach/afterEach) and touches no
 *  disk, so it can never race a test's own file setup. Use
 *  {@link __simulateRestartForTest} when you WANT the file to be re-read. */
export const __resetQuotaForTest = (): void => {
  state.cooling.clear()
  state.loaded = Promise.resolve() // "already loaded, nothing in it" ⇒ no disk read
  state.lastPersistError = null
  state.touched = undefined
  // The persist CHAIN is deliberately KEPT. Most callers mutate without awaiting
  // the mirror write (the engine's sensor path can't), so a case can end with a
  // save still in flight — and that save serialises the table INSIDE the chain,
  // i.e. AFTER this clear, so it lands as an empty file some milliseconds later.
  // Dropping the chain here would orphan that write: unawaitable, and free to
  // stomp on a file the NEXT case has just seeded (a load-dependent flake — the
  // kind that passes on a quiet box and fails on a busy one). Holding the tail
  // keeps it drainable: a suite that touches the file awaits flushQuotaPersist()
  // first and knows the disk has gone quiet.
}

/** Test-only: simulate a PROCESS RESTART. Drops exactly what process death drops
 *  — the globalThis table and the memoized load — and leaves the FILE alone, so
 *  the next {@link ensureCoolingTableLoaded} does a REAL read. That is the boot
 *  path under test: cool a tier, restart, and the mark must still be there.
 *
 *  Drains the mirror first (hence async). A real crash could of course lose an
 *  in-flight write, but reproducing THAT here would only buy a nondeterministic
 *  test; what we assert is the promise the module actually makes — "what was
 *  saved is still there after a restart" — so the disk is quiesced before the
 *  table is dropped. Not used in production. */
export const __simulateRestartForTest = async (): Promise<void> => {
  await flushQuotaPersist()
  state.cooling.clear()
  state.loaded = undefined // ⇒ the next ensureCoolingTableLoaded() re-reads the file
  state.persist = undefined
  state.lastPersistError = null
  state.touched = undefined // a new process has touched nothing yet
}
