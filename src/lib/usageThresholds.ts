// Shared thresholds for the Claude-usage budget gauge (the Ground toolbar's
// UsageHud). The gauge runs green up to WARN, turns amber at WARN, and red at
// OVER — matching the supply-officer spec "80%で黄・100%で赤". Kept as a pure,
// presentation-agnostic module so the component and its tests agree on the exact
// boundaries; the HUD maps the returned level → Tailwind tone classes
// (moss / ochre / accent) itself.
export const USAGE_WARN_PCT = 80
export const USAGE_OVER_PCT = 100

export type UsageLevel = 'idle' | 'ok' | 'warn' | 'over'

/**
 * Classify a usage percentage into a severity level.
 *
 * - `null` / `undefined` / non-finite (e.g. NaN) → `'idle'` — no reading yet,
 *   so the gauge shows a neutral track rather than a false "0% = green".
 * - `>= 100` → `'over'`  (red)    — at or past the cap.
 * - `>= 80`  → `'warn'`  (amber)  — approaching the cap.
 * - otherwise → `'ok'`   (green).  Negative values (shouldn't happen) clamp to ok.
 */
export const usageLevel = (pct: number | null | undefined): UsageLevel => {
  if (pct == null || !Number.isFinite(pct)) return 'idle'
  if (pct >= USAGE_OVER_PCT) return 'over'
  if (pct >= USAGE_WARN_PCT) return 'warn'
  return 'ok'
}
