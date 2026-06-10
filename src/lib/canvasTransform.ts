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

// ── Rotation ──
/** Normalise a rotation (degrees) to the half-open range [-180, 180), rounded to
 *  whole degrees (180 and -180 are the same angle → canonicalised to -180). NaN /
 *  non-finite (e.g. a cleared inspector field) → 0, so a rotation is never
 *  persisted as NaN — which would poison the resize/rotate trig downstream.
 *  Shared by the inspector field and the on-canvas rotate drag so the stored
 *  convention is identical no matter which control last edited it. */
export function normalizeRotation(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  return Math.round((((deg % 360) + 540) % 360) - 180)
}

// ── Rotation-aware resize ──
export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Resize a (possibly rotated) box by dragging its BOTTOM-RIGHT corner to a new
 *  world point, keeping the opposite (top-left) corner anchored in world space —
 *  matching how Figma resizes a rotated object.
 *
 *  An element renders as its axis-aligned box rotated by `deg` about its CENTRE
 *  (`transform: rotate()` + `transform-origin: center`), so as w/h change the
 *  box's x/y must shift to keep the anchored corner from drifting. `pointer` is
 *  the target world position for the dragged corner (the caller subtracts the
 *  grab offset so there's no jump on grab). `minW`/`minH` floor the result;
 *  `lockAspect` locks it to the original w:h ratio (Shift-drag). For `deg === 0`
 *  this reduces to the classic top-left-anchored resize. */
export function resizeRotatedBR(
  box: Box,
  deg: number,
  pointer: { x: number; y: number },
  opts: { minW: number; minH: number; lockAspect?: boolean },
): Box {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  // Anchored (top-left local) corner in world space: C + R(r)·(-w/2, -h/2).
  const tlx = cx + cos * (-box.w / 2) - sin * (-box.h / 2)
  const tly = cy + sin * (-box.w / 2) + cos * (-box.h / 2)
  // Pointer relative to the anchor, rotated back into the box's local frame
  // (R(-r)) → the new local width/height.
  const dx = pointer.x - tlx
  const dy = pointer.y - tly
  let w = cos * dx + sin * dy
  let h = -sin * dx + cos * dy
  if (opts.lockAspect) {
    // Lock to the original ratio, then enforce the floors PROPORTIONALLY: if
    // either axis is below its min, scale BOTH up by the same factor so the
    // ratio is preserved (independent Math.max per axis would distort it).
    const locked = lockAspectRatio(Math.max(0, w), Math.max(0, h), box.w, box.h)
    const bump = Math.max(
      locked.width > 0 ? opts.minW / locked.width : 1,
      locked.height > 0 ? opts.minH / locked.height : 1,
      1,
    )
    // Final Math.max guards a degenerate (zero) locked axis.
    w = Math.max(opts.minW, locked.width * bump)
    h = Math.max(opts.minH, locked.height * bump)
  } else {
    w = Math.max(opts.minW, w)
    h = Math.max(opts.minH, h)
  }
  // New centre that keeps the anchored corner fixed: C = TL + R(r)·(w/2, h/2).
  const ncx = tlx + cos * (w / 2) - sin * (h / 2)
  const ncy = tly + sin * (w / 2) + cos * (h / 2)
  return { x: ncx - w / 2, y: ncy - h / 2, w, h }
}

/** World position of an element's BOTTOM-RIGHT visual corner — where the resize
 *  handle is drawn — for a box rotated `deg` about its centre. */
export function rotatedCornerBR(box: Box, deg: number): { x: number; y: number } {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  return {
    x: cx + cos * (box.w / 2) - sin * (box.h / 2),
    y: cy + sin * (box.w / 2) + cos * (box.h / 2),
  }
}
