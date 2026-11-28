// swarmBudget — may automatic work START one more worker for this card, given
// how much of the subscription is already used? (AUTONOMY-SPEC R-D1 / R-D2.)
//
// Pure and clock-injected; the readings come from usageWindows.ts. It decides
// only STARTS of automatic work (the engine's dispatch pass): a worker already
// running is never in its input, and the owner's own presses (Board Run,
// talking to the president) never reach it.
//
// Three hold kinds, checked strongest first:
//   • weekly-reserve  — the week is at or above 100 − ownerReservePct.
//   • weekly-pace     — pace 'even' only: the week is above the even line
//                       (elapsed share × 100 + PACE_BURST_PCT). Off under 'free'.
//   • window-headroom — the 5-hour window is at or above the card's start ceiling.
// No fresh reading of a window ⇒ that window holds nothing, and the verdict
// carries `usage-unknown` (today's behaviour, now said out loud).
//
// Leaf module (cardTier + types only): store.ts and usageWindows.ts import it.

import { resolveCardTier, type TierCard } from '../cardTier'
import type { SwarmBudgetPolicy, TaskTier } from '../types'

/** Start ceilings for the 5-hour window, by the card's effective tier: a card
 *  that will spend more must find more room left. */
export const TIER_START_CEILING_PCT: Readonly<Record<TaskTier, number>> = {
  touch: 90,
  standard: 80,
  design: 70,
  ultra: 60,
}

/** How far ahead of an even weekly spend the 'even' pace lets the week run. */
export const PACE_BURST_PCT = 15

/** A reading older than this is not a reading (the `/usage` cache's TTL too).
 *
 *  Why 30 minutes is acceptable for a START ceiling, and why a tighter cutoff
 *  would not be safer: a reading only gets older, and inside one window usage
 *  only rises — so any reading of the current window is a LOWER bound of the
 *  share used now. A lower bound at or above the ceiling holds correctly at
 *  any age. One below it may understate by however much was spent since; but
 *  dropping it gives `usage-unknown`, which also allows — the same answer. A
 *  shorter cutoff can therefore only remove correct holds, never add safety.
 *  The cutoff exists to bound how long a hold rests on one reading (a provider
 *  reset earlier than stated, §1.2 of the spec, would otherwise hold until the
 *  stated reset). */
export const USAGE_FRESH_MS = 30 * 60_000

/** With a card waiting, the engine asks for a /usage scrape once the newest
 *  reading is this old. Every reading is a lower bound of now (usage only rises
 *  inside a window), so its age bounds how much a start can be under-judged:
 *  5 minutes of spend is small against the 10 points between start ceilings.
 *  A scrape costs one PTY `claude` for ~9 s and, in essential-traffic mode, no
 *  inference (claudeUsageCli.drive); the HUD's 60 s poll usually keeps readings
 *  fresher than this anyway, so the engine scrapes only when nobody else does —
 *  at most 12 times an hour, and only while a card waits. */
export const USAGE_REFRESH_AFTER_MS = 5 * 60_000

/** After an engine-requested scrape, the next one waits this long; each
 *  request that produced no newer reading doubles the wait (a broken CLI must
 *  not spawn every 3 s pass), up to {@link USAGE_REFRESH_BACKOFF_MAX_MS}. */
export const USAGE_REFRESH_BACKOFF_MS = 5 * 60_000
export const USAGE_REFRESH_BACKOFF_MAX_MS = 30 * 60_000

export const WEEK_MS = 7 * 24 * 3_600_000

/** The owner's decision of 2026-11-28 (AUTONOMY-SPEC §7-2 = B). */
export const DEFAULT_SWARM_BUDGET: SwarmBudgetPolicy = { pace: 'free', ownerReservePct: 10 }

/** A reserve above this would park automatic work for most of every week. */
export const MAX_OWNER_RESERVE_PCT = 50

const isPace = (v: unknown): v is SwarmBudgetPolicy['pace'] => v === 'even' || v === 'free'
const isReserve = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_OWNER_RESERVE_PCT

/** Stored value → policy; a missing or junk field takes its default. */
export const normalizeSwarmBudget = (raw: unknown): SwarmBudgetPolicy => {
  const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  return {
    pace: isPace(r.pace) ? r.pace : DEFAULT_SWARM_BUDGET.pace,
    ownerReservePct: isReserve(r.ownerReservePct) ? Math.round(r.ownerReservePct) : DEFAULT_SWARM_BUDGET.ownerReservePct,
  }
}

/** A request patch → the policy to store over `current`, or null to refuse it
 *  (a non-object, or any field present and invalid). */
export const mergeSwarmBudgetPatch = (current: unknown, patch: unknown): SwarmBudgetPolicy | null => {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return null
  const p = patch as Record<string, unknown>
  if ('pace' in p && !isPace(p.pace)) return null
  if ('ownerReservePct' in p && !isReserve(p.ownerReservePct)) return null
  return normalizeSwarmBudget({ ...normalizeSwarmBudget(current), ...p })
}

/** One window's reading. `usedPct` 0–100 or null (status known, share not). */
export interface BudgetReading {
  usedPct: number | null
  /** Epoch ms the window resets, or null when unknown. */
  resetsAt: number | null
  /** Epoch ms the share was measured. */
  at: number
}

export interface BudgetWindows {
  five_hour?: BudgetReading
  seven_day?: BudgetReading
}

export type BudgetHoldKind = 'window-headroom' | 'weekly-pace' | 'weekly-reserve'

export type BudgetVerdict =
  | { allow: true; note?: 'usage-unknown' }
  | { allow: false; kind: BudgetHoldKind; until: number; usedPct: number; linePct: number }

/** The reading, if it is one: a share, younger than {@link USAGE_FRESH_MS}, of
 *  a window that has not reset yet. */
const usable = (r: BudgetReading | undefined, now: number): (BudgetReading & { usedPct: number }) | null =>
  r && r.usedPct != null && now - r.at < USAGE_FRESH_MS && (r.resetsAt == null || r.resetsAt > now)
    ? (r as BudgetReading & { usedPct: number })
    : null

/** When a hold on this reading lifts by itself: the window's reset, or — when
 *  that is unknown — the moment the reading goes stale. */
const liftOf = (r: BudgetReading): number => r.resetsAt ?? r.at + USAGE_FRESH_MS

/** The owner's weekly reserve alone: the week at or above 100 − ownerReservePct.
 *  The one budget hold that also waits the commander's automatic wake for
 *  finished work (R-D2 — swarmOrchestrator.runIntegratePass). */
export const weeklyReserveHold = (
  windows: BudgetWindows,
  now: number,
  policy: SwarmBudgetPolicy,
): Extract<BudgetVerdict, { allow: false }> | null => {
  const week = usable(windows.seven_day, now)
  const reserveLine = 100 - policy.ownerReservePct
  return week && week.usedPct >= reserveLine
    ? { allow: false, kind: 'weekly-reserve', until: liftOf(week), usedPct: week.usedPct, linePct: reserveLine }
    : null
}

export const budgetGate = (
  windows: BudgetWindows,
  now: number,
  policy: SwarmBudgetPolicy,
  card: TierCard,
): BudgetVerdict => {
  const week = usable(windows.seven_day, now)
  const win = usable(windows.five_hour, now)

  const reserve = weeklyReserveHold(windows, now, policy)
  if (reserve) return reserve
  if (week) {
    if (policy.pace === 'even' && week.resetsAt != null) {
      const start = week.resetsAt - WEEK_MS
      // Compared in time, not in percent: "the line reaches the used share" is
      // an instant, and computing it once keeps both sides of the boundary exact.
      const lineReachesUsed = start + ((week.usedPct - PACE_BURST_PCT) / 100) * WEEK_MS
      if (now < lineReachesUsed) {
        const linePct = ((now - start) / WEEK_MS) * 100 + PACE_BURST_PCT
        return { allow: false, kind: 'weekly-pace', until: lineReachesUsed, usedPct: week.usedPct, linePct }
      }
    }
  }

  if (win) {
    const ceiling = TIER_START_CEILING_PCT[resolveCardTier(card)]
    if (win.usedPct >= ceiling) {
      return { allow: false, kind: 'window-headroom', until: liftOf(win), usedPct: win.usedPct, linePct: ceiling }
    }
  }

  return week && win ? { allow: true } : { allow: true, note: 'usage-unknown' }
}
