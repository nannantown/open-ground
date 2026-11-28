// usageWindows — the latest STRUCTURED reading of each subscription usage
// window, fed by the Agent SDK's `rate_limit_event` (AUTONOMY-SPEC R-D2 design,
// R-C1 (1)). No new sensor and no text pattern (PLATFORM-GAP-LEDGER rule 1): it
// consumes a stable SDK message type the pool already distils.
//
// WHAT THE EVENT REALLY CARRIES (measured 2026-11-28 in the CLI bundled with
// claude-agent-sdk 0.3.220 — docs/commander/04-quota-models.md §5.10):
//   • It is emitted only when the CLI's limit state CHANGES (deep-equal), not
//     per request. `status` is always there; `resetsAt` (epoch SECONDS) and
//     `rateLimitType` (the representative window) usually are.
//   • `utilization` (a 0–1 fraction) rides ONLY `allowed_warning` events: the
//     server's surpassed-threshold header, or the CLI's own early warnings
//     (5-hour ≥ 0.9 inside the first 72% of the window; 7-day ≥ 0.25/0.5/0.75
//     at ≤ 15/35/60%). A plain `allowed` or `rejected` event has none.
// So below ~90% of the 5-hour window the event almost never states a share,
// and a `/usage` scrape is the reading most of the time; the 30-minute
// freshness rule (swarmBudget.USAGE_FRESH_MS) decides which one counts.
//
// SCRAPES ARE RECORDED HERE, NOT READ FROM THE DISPLAY CACHE. claudeUsageCli
// wipes its display cache 30 s after any transcript write — exactly while
// workers run — so a gate reading that cache answered `usage-unknown` most of
// the time. Every successful scrape (fetchClaudeUsageCli) is written here with
// its own capture time instead (recordUsageScrape); invalidating the display
// cache no longer erases what the gate knows.
//
// The in-memory table is the authority (sync reads); the file
// `~/.openground/usage-windows.json`, beside the cooling table, is a mirror
// written after each change and read once per process (same shape of rules as
// swarmQuota: never write before the disk was seen; a live reading beats an
// older one from disk). Fail-safe: an unreadable file boots empty.

import { readFile } from 'fs/promises'
import { join } from 'path'
import { atomicWriteJson } from './atomicWrite'
import { ensureOpenGroundHome, openGroundHome } from './paths'
import { parseResetLabel } from './swarmQuota'
import {
  USAGE_FRESH_MS,
  USAGE_REFRESH_AFTER_MS,
  USAGE_REFRESH_BACKOFF_MS,
  USAGE_REFRESH_BACKOFF_MAX_MS,
  type BudgetReading,
  type BudgetWindows,
} from './swarmBudget'
import type { SdkEvent } from './sdkEvents'
import type { CliUsage, CliUsageSlot } from './claudeUsageCli'

type RateLimitEvent = Extract<SdkEvent, { kind: 'rate_limit' }>

export interface UsageWindowReading extends BudgetReading {
  /** The SDK's status for this window: 'allowed' | 'allowed_warning' | 'rejected'. */
  status: string
}

/** Keyed by the SDK's `rateLimitType` ('five_hour', 'seven_day', 'seven_day_opus', …). */
export type UsageWindows = Record<string, UsageWindowReading>

export const usageWindowsFile = (): string => join(openGroundHome(), 'usage-windows.json')

const clampPct = (v: number): number => Math.max(0, Math.min(100, Math.round(v)))

/** Epoch seconds → ms. Kept tolerant of a future ms value (> year 33658 in s). */
const toMs = (t: number | null): number | null => (t == null ? null : t < 1e12 ? t * 1000 : t)

/** One event onto the table (PURE). A share is stored when the event states
 *  one (0–1 → 0–100) or when the window refused (= spent). A status-only event
 *  in the SAME window (same reset) keeps the last measured share and its age —
 *  usage only grows inside a window; a new window starts unknown. */
export const applyRateLimitEvent = (windows: UsageWindows, ev: RateLimitEvent, now: number): UsageWindows => {
  if (!ev.limitType || ev.limitType === 'unknown') return windows
  const prev = windows[ev.limitType]
  const resetsAt = toMs(ev.resetsAt)
  const measured = ev.utilization != null ? clampPct(ev.utilization * 100) : ev.status === 'rejected' ? 100 : null
  const keep = measured == null && prev != null && prev.usedPct != null && prev.status !== 'rejected' && prev.resetsAt === resetsAt
  return {
    ...windows,
    [ev.limitType]: { usedPct: keep ? prev.usedPct : measured, resetsAt, at: keep ? prev.at : now, status: ev.status },
  }
}

// ── The table (globalThis — survives tsx watch reloads) ─────────────────────

type ScrapeWindows = Partial<Record<'five_hour' | 'seven_day', UsageWindowReading>>

interface State {
  windows: UsageWindows
  /** The last successful /usage scrape, per window (session → five_hour,
   *  week-all → seven_day), at its capture time. */
  scraped?: ScrapeWindows
  /** The engine's scrape requests (claimUsageRefresh). In-memory only. */
  refresh?: { lastAttemptAt: number; nextAt: number; failures: number }
  loaded?: Promise<void>
  persist?: Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_usage_windows: State | undefined
}

const state: State = (globalThis.__openground_usage_windows ??= { windows: {} })

const isReading = (v: unknown): v is UsageWindowReading => {
  const r = v as Partial<UsageWindowReading> | null
  return (
    !!r &&
    typeof r.at === 'number' &&
    Number.isFinite(r.at) &&
    typeof r.status === 'string' &&
    (r.usedPct === null || (typeof r.usedPct === 'number' && Number.isFinite(r.usedPct))) &&
    (r.resetsAt === null || (typeof r.resetsAt === 'number' && Number.isFinite(r.resetsAt)))
  )
}

const hydrate = async (): Promise<void> => {
  let raw: string
  try {
    await ensureOpenGroundHome()
    raw = await readFile(usageWindowsFile(), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') console.warn(`[openground:usage-windows] unreadable — starting empty: ${String(e)}`)
    return
  }
  try {
    const file = JSON.parse(raw) as { windows?: unknown; scraped?: unknown }
    const windows = file?.windows
    if (!windows || typeof windows !== 'object' || Array.isArray(windows)) throw new Error('expected {"windows": {...}}')
    for (const [type, r] of Object.entries(windows as Record<string, unknown>)) {
      if (!isReading(r)) continue
      const live = state.windows[type]
      if (!live || live.at < r.at) state.windows[type] = r // a live reading is newer than the disk
    }
    const scraped = file.scraped && typeof file.scraped === 'object' ? (file.scraped as Record<string, unknown>) : {}
    for (const type of ['five_hour', 'seven_day'] as const) {
      const r = scraped[type]
      if (!isReading(r)) continue
      const live = state.scraped?.[type]
      if (!live || live.at < r.at) state.scraped = { ...state.scraped, [type]: r }
    }
  } catch (e) {
    console.warn(`[openground:usage-windows] corrupt — starting empty: ${String(e)}`)
  }
}

/** Read the mirror into the table, once per process. */
export const ensureUsageWindowsLoaded = (): Promise<void> => (state.loaded ??= hydrate())

const schedulePersist = (): Promise<void> => {
  const run = (state.persist ?? Promise.resolve())
    .then(ensureUsageWindowsLoaded) // never write a table that has not seen the disk
    .then(() => atomicWriteJson(usageWindowsFile(), { windows: state.windows, scraped: state.scraped ?? {} }))
    .catch((e: unknown) => console.warn(`[openground:usage-windows] not persisted: ${String(e)}`))
  state.persist = run
  return run
}

export const flushUsageWindowsPersist = async (): Promise<void> => {
  await (state.persist ?? Promise.resolve())
}

/** The pool's forwarding seam: every SDK session's `rate_limit` event lands here. */
export const recordRateLimitEvent = (ev: RateLimitEvent, now: number = Date.now()): void => {
  const next = applyRateLimitEvent(state.windows, ev, now)
  if (next === state.windows) return
  state.windows = next
  void schedulePersist()
}

export const usageWindowsSnapshot = (): UsageWindows => ({ ...state.windows })

/** The windows that bind EVERY model: the 5-hour session and the weekly allowance. */
export const ACCOUNT_WINDOWS: readonly string[] = ['five_hour', 'seven_day']

/** The per-model weekly window that binds only one tier, by the CLI's own limit
 *  names (2.1.332, see swarmRateLimitText ALL_MODEL_WINDOW): seven_day_opus
 *  "Opus limit", seven_day_sonnet "Sonnet limit", seven_day_overage_included
 *  "Fable 5 limit". `overage` (credits) binds no one tier and cools nothing here. */
const TIER_WINDOW: Readonly<Record<string, string>> = {
  opus: 'seven_day_opus',
  sonnet: 'seven_day_sonnet',
  fable: 'seven_day_overage_included',
}

/** The reset instant of the wall a session just met, from the structured event:
 *  the latest reset among windows refused within {@link USAGE_FRESH_MS} that
 *  have not reset yet (every wall must lift), or null when the sessions saw no
 *  such event — then the caller's text chain decides, as before.
 *
 *  Only windows that bind the one asking count: the account-wide two, plus
 *  `tier`'s own per-model week when a tier is named. The table holds every
 *  window ANY session reported, and a per-model week binds only its model —
 *  read globally, an opus weekly wall made a 5-hour refusal cool every tier and
 *  pause the commander for four days (review 2026-11-28 B-M1). */
export const rejectedUntil = (now: number, tier?: string): number | null => {
  const binding = tier && TIER_WINDOW[tier] ? [...ACCOUNT_WINDOWS, TIER_WINDOW[tier]] : ACCOUNT_WINDOWS
  let until: number | null = null
  for (const type of binding) {
    const r = state.windows[type]
    if (!r || r.status !== 'rejected' || r.resetsAt == null || r.resetsAt <= now || now - r.at >= USAGE_FRESH_MS) continue
    until = Math.max(until ?? r.resetsAt, r.resetsAt)
  }
  return until
}

/** The reset a session's OWN refusal event states (epoch ms), or null when the
 *  event is not a refusal. sdkSession keeps it per session: the wall that
 *  refused a desk is the one its own event named, whatever window that is. */
export const rejectedResetOf = (ev: RateLimitEvent): number | null => (ev.status === 'rejected' ? toMs(ev.resetsAt) : null)

/** A `/usage` slot as a reading: measured at `at`, its reset label read
 *  relative to THAT instant (not now — a passed label must not roll to tomorrow)
 *  and as FRESH text: the screen was rendered at `at`, so a bare clock already
 *  past then ("2:50am" at 22:00) is tomorrow's (review B-N2 — read as stale it
 *  was null and the hold lifted at capture + 30 min). */
const fromUsage = (slot: CliUsageSlot | null | undefined, at: number): UsageWindowReading | undefined =>
  slot && Number.isFinite(slot.pct)
    ? { usedPct: clampPct(slot.pct), resetsAt: parseResetLabel(slot.resetsAt, at, true), at, status: 'usage-scrape' }
    : undefined

/** Record a SUCCESSFUL /usage scrape (called by claudeUsageCli.fetchClaudeUsageCli
 *  wherever it caches one). No capture time ⇒ nothing recorded. */
export const recordUsageScrape = (usage: CliUsage): void => {
  const at = usage.capturedAt ? Date.parse(usage.capturedAt) : NaN
  if (!Number.isFinite(at)) return
  const five_hour = fromUsage(usage.session, at)
  const seven_day = fromUsage(usage.weekAll, at)
  if (!five_hour && !seven_day) return
  state.scraped = { ...state.scraped, ...(five_hour ? { five_hour } : {}), ...(seven_day ? { seven_day } : {}) }
  void schedulePersist()
}

const fresh = (r: UsageWindowReading | undefined, now: number): r is UsageWindowReading =>
  !!r && r.usedPct != null && now - r.at < USAGE_FRESH_MS && (r.resetsAt == null || r.resetsAt > now)

/** The two windows the budget gate reads: the structured event when it is
 *  fresh, else the last recorded /usage scrape (the gate applies the freshness
 *  rule to its capture time). */
export const budgetReadings = (
  now: number,
): BudgetWindows & { five_hour?: BudgetReading & { source: 'event' | 'usage' }; seven_day?: BudgetReading & { source: 'event' | 'usage' } } => {
  const pick = (type: 'five_hour' | 'seven_day') => {
    const ev = state.windows[type]
    if (fresh(ev, now)) return { usedPct: ev.usedPct, resetsAt: ev.resetsAt, at: ev.at, source: 'event' as const }
    const sc = state.scraped?.[type]
    return sc ? { usedPct: sc.usedPct, resetsAt: sc.resetsAt, at: sc.at, source: 'usage' as const } : undefined
  }
  const five_hour = pick('five_hour')
  const seven_day = pick('seven_day')
  return { ...(five_hour ? { five_hour } : {}), ...(seven_day ? { seven_day } : {}) }
}

/** When the newest reading of the two gate windows was measured, or null. */
const newestReadingAt = (): number | null => {
  let at: number | null = null
  for (const r of [state.windows.five_hour, state.windows.seven_day, state.scraped?.five_hour, state.scraped?.seven_day]) {
    if (r && r.usedPct != null) at = Math.max(at ?? r.at, r.at)
  }
  return at
}

/** May the engine (which has a card to start) ask for a /usage scrape now?
 *  Yes when the newest reading is {@link USAGE_REFRESH_AFTER_MS} old or more,
 *  and — if the previous request produced no newer reading (a failed scrape, or
 *  a display cache that served an unchanged result) — its backoff has passed.
 *  Claiming records the attempt, so the caller fires exactly one detached
 *  refresh per claim. Global, not per project: there is one CLI. */
export const claimUsageRefresh = (now: number): boolean => {
  const newest = newestReadingAt()
  if (newest != null && now - newest < USAGE_REFRESH_AFTER_MS) return false
  const r = state.refresh
  const lastLanded = !r || (newest != null && newest >= r.lastAttemptAt)
  if (!lastLanded && now < r.nextAt) return false
  const failures = lastLanded ? 0 : r.failures + 1
  state.refresh = {
    lastAttemptAt: now,
    nextAt: now + Math.min(USAGE_REFRESH_BACKOFF_MS * 2 ** failures, USAGE_REFRESH_BACKOFF_MAX_MS),
    failures,
  }
  return true
}

/** Test-only: an empty table that counts as loaded (no disk read). */
export const __resetUsageWindowsForTest = (): void => {
  state.windows = {}
  state.scraped = undefined
  state.refresh = undefined
  state.loaded = Promise.resolve()
}

/** Test-only: drop what a process death drops; the next load re-reads the file. */
export const __simulateUsageWindowsRestartForTest = async (): Promise<void> => {
  await flushUsageWindowsPersist()
  state.windows = {}
  state.scraped = undefined
  state.loaded = undefined
  state.persist = undefined
}
