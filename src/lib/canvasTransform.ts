// Pure helpers shared by the Selection Inspector, the on-canvas resize handle,
// and the element views for the TRANSFORM properties of canvas elements
// (round 4): per-object W/H size, OPACITY, and frame CORNER RADIUS. Mirrors the
// round-1/2/3 split (`canvasTextStyle.ts`, `canvasFillStyle.ts`): the panel +
// handle that *edit* these and the views that *render* them agree on the same
// defaults and the same clamp rules. Keeping the logic out of the React
// components keeps it unit-testable in the `node` vitest env.
//
// All new fields are OPTIONAL and backward-compatible:
//   - `opacity?`      — 0..1 multiplier on the element's rendered container.
//                       Omitted = 1 (fully opaque) = the legacy look.
//   - `cornerRadius?` — px radius for a frame's body corners (and any future
//                       rounded-rect type). Omitted = the legacy frame radius
//                       (4px, the old `rounded-[4px]`), so saved frames look
//                       identical.
// Size (`width` / `height`) already exist on CanvasElement; this module only
// adds the *clamp + aspect-ratio* helpers the inspector and the Shift-resize
// drag share, so an empty W/H field or a proportional drag never persists a
// degenerate (zero / negative / NaN) box.

import type { CanvasElement } from './types'

// ── Opacity ──
// The default a container renders with when `opacity` is unset.
export const DEFAULT_OPACITY = 1
// Inputs are surfaced as 0..100 (%) in the inspector; the stored field is the
// 0..1 CSS multiplier. The floor is 0 (Figma lets you fully hide an object).
export const MIN_OPACITY = 0
export const MAX_OPACITY = 1

/** Clamp an arbitrary 0..1 opacity to the allowed band. NaN / non-finite input
 *  (e.g. a cleared field) falls back to fully opaque rather than 0, so an empty
 *  input never silently hides the element. Rounds to 2 decimals so the stored
 *  value stays tidy (1% slider steps round-trip cleanly). */
export function clampOpacity(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_OPACITY
  const clamped = Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, n))
  return Math.round(clamped * 100) / 100
}

/** Convert a 0..100 percent (from the inspector's slider / number field) to the
 *  stored 0..1 opacity, clamped. NaN → default (opaque). */
export function opacityFromPercent(percent: number): number {
  if (!Number.isFinite(percent)) return DEFAULT_OPACITY
  return clampOpacity(percent / 100)
}

/** Resolve the effective opacity for any element, folding in the default. */
export function resolveOpacity(el: CanvasElement): number {
  return clampOpacity(el.opacity ?? DEFAULT_OPACITY)
}

// ── Corner radius (frame, and any future rounded-rect type) ──
// The legacy frame body used Tailwind `rounded-[4px]`; encode that so a frame
// with no `cornerRadius` resolves to exactly the historical look.
export const DEFAULT_FRAME_CORNER_RADIUS = 4
export const MIN_CORNER_RADIUS = 0
// Ceiling stops a stray keystroke ballooning the radius past any frame's half
// size into a degenerate pill; the view additionally clamps to half the
// smaller side at render time (see clampRadiusToBox).
export const MAX_CORNER_RADIUS = 200

/** Clamp an arbitrary corner radius to the allowed band, rounding to a whole
 *  px. NaN / non-finite input (a cleared field) falls back to the default
 *  frame radius rather than the ceiling, mirroring `clampStrokeWidth`. */
export function clampCornerRadius(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FRAME_CORNER_RADIUS
  return Math.min(MAX_CORNER_RADIUS, Math.max(MIN_CORNER_RADIUS, Math.round(n)))
}

/** Resolve the effective corner radius for a FRAME, folding in the default so a
 *  legacy frame (no `cornerRadius`) renders at the historical 4px. */
export function resolveFrameCornerRadius(el: CanvasElement): number {
  return clampCornerRadius(el.cornerRadius ?? DEFAULT_FRAME_CORNER_RADIUS)
}

/** Clamp a radius so it never exceeds half the smaller side of the box — past
 *  that a CSS border-radius just caps at the pill shape, but clamping keeps the
 *  stored intent and the rendered look in agreement (and avoids odd overflow
 *  with a stroke). Used by the frame view at render time, where w/h are known. */
export function clampRadiusToBox(radius: number, w: number, h: number): number {
  const cap = Math.max(0, Math.floor(Math.min(w, h) / 2))
  return Math.min(radius, cap)
}

// ── Size (per-object resize) ──
// Floors keep a resized element from collapsing to an unusable sliver. Kept in
// sync with the on-canvas handle's RESIZE_MIN_W / RESIZE_MIN_H so the inspector
// W/H inputs and the drag-resize agree on the smallest allowed box.
export const RESIZE_MIN_W = 130
export const RESIZE_MIN_H = 96
// Ceiling stops a stray keystroke in the W/H field drawing a multi-thousand-px
// slab that can't be panned back into view.
export const RESIZE_MAX = 8000

/** Clamp a width to the width band (min width floor). NaN / non-finite input (a
 *  cleared field) falls back to the provided `fallback` (the element's current
 *  size) rather than the floor, so an empty input never collapses the box. */
export function clampWidth(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.min(RESIZE_MAX, Math.max(RESIZE_MIN_W, Math.round(n)))
}

/** Clamp a height to the height band (min height floor). */
export function clampHeight(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback
  return Math.min(RESIZE_MAX, Math.max(RESIZE_MIN_H, Math.round(n)))
}

/** Lock a candidate (w, h) to the original aspect ratio for a proportional
 *  (Shift-held) resize. Picks whichever axis the user dragged further (relative
 *  to the original size) as the driver, then derives the other axis from the
 *  original ratio, so dragging mostly-horizontally scales by width and
 *  mostly-vertically scales by height — matching Figma's corner-drag feel.
 *  `ow`/`oh` are the original (pre-drag) dimensions; both must be > 0. */
export function lockAspectRatio(
  candidateW: number,
  candidateH: number,
  ow: number,
  oh: number,
): { width: number; height: number } {
  if (ow <= 0 || oh <= 0) return { width: candidateW, height: candidateH }
  const ratio = ow / oh
  // Relative growth on each axis; the axis that moved more (proportionally)
  // drives the scale so the box tracks the dominant drag direction.
  const scaleW = candidateW / ow
  const scaleH = candidateH / oh
  if (scaleW >= scaleH) {
    return { width: candidateW, height: candidateW / ratio }
  }
  return { width: candidateH * ratio, height: candidateH }
}
