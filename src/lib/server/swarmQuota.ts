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
//     classifyOutput discipline). The ONLY mutable state is the cooling table
//     on globalThis — nothing else is written.
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

import type { SwarmModelTier, SwarmQuotaTier } from '../types'

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
 *  fable === swarmLaunch.SWARM_LAUNCH_MODEL — the single top-tier constant. */
export const MODEL_TIER_LADDER: readonly ModelTier[] = ['fable', 'opus', 'sonnet', 'haiku']

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
// cache, so a dev reload doesn't silently forget which tiers are dry.
interface QuotaState {
  cooling: Map<ModelTier, number>
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_swarm_quota: QuotaState | undefined
}

const state: QuotaState =
  globalThis.__openground_swarm_quota ??
  (globalThis.__openground_swarm_quota = { cooling: new Map() })

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
    // Already past today ⇒ it means tomorrow's clock (parseCliReset's rule).
    if (d.getTime() <= now) d.setDate(d.getDate() + 1)
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

/** Low-level: mark `tier` cooling until an ALREADY-RESOLVED epoch ms. Use when
 *  the caller computed `until` itself; most callers want {@link markRateLimited}
 *  which resolves it from the PTY/A5/grace sources. A later mark for the same
 *  tier overwrites (the newest signal wins). */
export const markCoolingUntil = (tier: ModelTier, until: number): void => {
  state.cooling.set(tier, until)
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
  const until = resolveCoolingUntil(opts)
  state.cooling.set(tier, until)
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
 *  and the inverse of the manual cool. Absent tier ⇒ no-op (idempotent). */
export const clearCooling = (tier: ModelTier): void => {
  state.cooling.delete(tier)
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
 *  order-independent. Not used in production. */
export const __resetQuotaForTest = (): void => {
  state.cooling.clear()
}
