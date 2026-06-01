// Pure helpers shared by the Selection Inspector and the element views for the
// FILL + STROKE properties of NON-text elements (round 3), mirroring the
// round-1/2 `canvasTextStyle.ts` split: the panel that *edits* fill/stroke and
// the views that *render* it agree on the same defaults and the same clamp
// rules. Keeping this out of the React components keeps it unit-testable in the
// `node` vitest env.
//
// Field-naming care (round-3 contract):
//   - STICKY background reuses the long-standing `color` field — round 3 does
//     NOT introduce a second sticky-fill field. The inspector's sticky Fill
//     control writes `color`, exactly like the on-canvas swatch row, so the two
//     stay in lock-step and no legacy sticky changes meaning.
//   - FRAME (and any future bordered/filled non-text type) uses the new
//     OPTIONAL `fill` / `strokeColor` / `strokeWidth` fields. All optional and
//     backward-compatible: a canvas saved before round 3 omits them and the
//     views fall back to the exact legacy look (`bg-bg/35` body, `line-strong`
//     1px border), so previously-saved Canvases load and render identically.

import type { CanvasElement } from './types'

// ── Sticky fill ──
// The default a sticky renders with when its `color` field is unset. Must stay
// byte-identical to `DEFAULT_STICKY_COLOR` in ElementView so the inspector
// swatch, the on-canvas swatch row, and the idle render all agree.
export const DEFAULT_STICKY_FILL = '#ECD79A'

// ── Frame fill + stroke ──
// `bg-bg` is the `#F2EDDE` paper token; the legacy frame body rendered it at
// 35% alpha (`bg-bg/35`). Encode that as an explicit rgba so a frame with no
// `fill` set resolves to exactly the historical look.
export const DEFAULT_FRAME_FILL = 'rgba(242, 237, 222, 0.35)'
// The legacy unselected frame border was the `line-strong` token (`#B8A988`),
// 1px wide. A frame with no `strokeColor` / `strokeWidth` resolves to these.
export const DEFAULT_FRAME_STROKE_COLOR = '#B8A988'
export const DEFAULT_STROKE_WIDTH = 1

// Guard rails for the stroke-width number input. 0 = no border (allowed, Figma
// lets you zero a stroke); the ceiling stops a stray keystroke drawing an
// absurd slab that swallows the frame.
export const MIN_STROKE_WIDTH = 0
export const MAX_STROKE_WIDTH = 40

/** Clamp an arbitrary number to the allowed stroke-width band, rounding to a
 *  whole px. NaN / non-finite input (e.g. a cleared field) falls back to the
 *  default width rather than the ceiling, mirroring `clampFontSize`, so an
 *  empty input never persists a garbage width. */
export function clampStrokeWidth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_STROKE_WIDTH
  return Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, Math.round(n)))
}

/** Resolve the effective fill for a STICKY element. Reuses the existing `color`
 *  field (never a new field) so the inspector and the swatch row drive the same
 *  value. Legacy stickies with no `color` get the built-in default. */
export function resolveStickyFill(el: CanvasElement): string {
  return el.color ?? DEFAULT_STICKY_FILL
}

/** Resolve the effective fill + stroke for a FRAME (or any bordered non-text
 *  element), folding in the defaults for any field the element doesn't carry.
 *  Used by the frame view so a legacy frame (no fill/stroke fields) renders
 *  exactly as it did before round 3. */
export function resolveFrameStyle(el: CanvasElement): {
  fill: string
  strokeColor: string
  strokeWidth: number
} {
  return {
    fill: el.fill ?? DEFAULT_FRAME_FILL,
    strokeColor: el.strokeColor ?? DEFAULT_FRAME_STROKE_COLOR,
    strokeWidth: el.strokeWidth ?? DEFAULT_STROKE_WIDTH,
  }
}
