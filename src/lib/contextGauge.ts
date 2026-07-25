// contextGauge.ts — turn a pane's context-window reading (the beacon's
// `contextLeftPct` + `contextLeftSource`, card 2/5) into the gauge's fill and
// severity. Pure and presentation-agnostic: the component maps the level →
// tone classes itself, exactly like UsageHud does with usageThresholds.
//
// WHY A SEPARATE MODULE FROM usageThresholds: the quota HUD measures a
// *usage* percentage (big = bad); this gauge is fed "% still FREE" (small =
// bad). The green/amber/red boundaries are shared — we convert to fill
// (`100 - left`) and reuse `usageLevel` — but the two readings are inverse, so
// keeping the conversion in one named place stops the polarity from being
// re-derived (and eventually flipped) at each call site.
//
// THE TWO SCALES (the card-2 integration review's #1 hand-off): the beacon's
// number can come from either of two sources with DIFFERENT denominators —
//   • 'jsonl'    — the session's usage sum over the 200k window: `(1 - used/200k)*100`.
//                  Always available, and the value the gauge normally shows.
//   • 'footnote' — claude's own on-screen `Context left until auto-compact: N%`,
//                  which is the distance to the AUTO-COMPACT threshold (it fires
//                  before 200k), and which claude only paints NEAR that threshold.
// So the same 40 means "plenty of room" from JSONL and "auto-compact is close"
// from the footnote. Treating them on one scale would paint the alarm green.
// Here the footnote never reads green — its mere presence is the alarm — and
// the UI labels the two readings differently.
import { usageLevel, type UsageLevel } from './usageThresholds'

/** Which reading produced the pane's `contextLeftPct` (see the header note). */
export type ContextLeftSource = 'jsonl' | 'footnote'

/** Below this many "% left until auto-compact" the footnote reading goes red.
 *  Above it, it is still amber — the footnote only appears near the limit, so
 *  there is no green branch for this source. */
export const FOOTNOTE_OVER_LEFT_PCT = 10

/** How FULL the window is, from a "% still free" reading. Clamped to 0–100 so a
 *  stray out-of-range value can't overflow the bar. */
export const contextFillPct = (leftPct: number): number =>
  Math.max(0, Math.min(100, Math.round(100 - leftPct)))

/**
 * Severity of a pane's context reading.
 *
 * - `null` / `undefined` / non-finite → `'idle'` — no reading yet (no claude
 *   session, or its transcript hasn't been written). Neutral track, NOT a
 *   false "100% free = green".
 * - `'footnote'` source → `'over'` at or below {@link FOOTNOTE_OVER_LEFT_PCT},
 *   else `'warn'` — never green (the footnote IS the near-limit alarm).
 * - `'jsonl'` (default) → the shared quota boundaries applied to the FILL:
 *   amber from 80% full (20% left), red at 100% full (0 left).
 */
export const contextLevel = (
  leftPct: number | null | undefined,
  source?: ContextLeftSource | null,
): UsageLevel => {
  if (leftPct == null || !Number.isFinite(leftPct)) return 'idle'
  if (source === 'footnote') {
    return leftPct <= FOOTNOTE_OVER_LEFT_PCT ? 'over' : 'warn'
  }
  return usageLevel(contextFillPct(leftPct))
}

/** Longest `/compact` focus hint accepted. Generous for a sentence of guidance,
 *  short enough that a runaway paste can't be typed into the pane. Lives HERE,
 *  not in the server sender, so the input box can cap what it accepts with the
 *  very number the server enforces (that module pulls in the PTY pool and can
 *  never be imported by a component). */
export const MAX_SLASH_ARG = 200

/** What happened when the user pressed one of the escape-hatch buttons. Kept
 *  coarse on purpose — each maps to ONE plain-language line for the owner. */
export type ContextActionOutcome = 'ok' | 'busy' | 'gone' | 'error'

/** HTTP status from POST /api/terminal/:id/slash → outcome. The route answers
 *  409 while claude is mid-turn and 404 when the pane has already exited; every
 *  other failure (400 from a command this client shouldn't be able to send, 5xx,
 *  offline) is an undifferentiated 'error' — there is nothing different the
 *  owner would do about them. */
export const slashOutcome = (status: number): ContextActionOutcome => {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 409) return 'busy'
  if (status === 404) return 'gone'
  return 'error'
}
