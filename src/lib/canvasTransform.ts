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

// ── Per-corner radius (Figma's independent corners) ──
/** The four corner radii (TL, TR, BR, BL) for a frame / rect, each folding in
 *  its per-corner override → the uniform `cornerRadius` → the default, then
 *  clamped to the sane band. A frame/rect with no per-corner fields resolves to
 *  four equal radii (the uniform legacy look). */
export interface CornerRadii {
  tl: number
  tr: number
  br: number
  bl: number
}
export function resolveCornerRadii(el: CanvasElement): CornerRadii {
  const base = el.cornerRadius ?? DEFAULT_FRAME_CORNER_RADIUS
  return {
    tl: clampCornerRadius(el.cornerRadiusTopLeft ?? base),
    tr: clampCornerRadius(el.cornerRadiusTopRight ?? base),
    br: clampCornerRadius(el.cornerRadiusBottomRight ?? base),
    bl: clampCornerRadius(el.cornerRadiusBottomLeft ?? base),
  }
}

/** True when all four corners are equal — the uniform case, where the inspector
 *  shows one radius field rather than the 2×2 per-corner grid. */
export function cornerRadiiAreUniform(r: CornerRadii): boolean {
  return r.tl === r.tr && r.tr === r.br && r.br === r.bl
}

/** CSS `border-radius` for the four corners, each capped to half the smaller
 *  side (so a big radius degrades to a pill rather than overflowing the box). */
export function cornerRadiusCss(el: CanvasElement, w: number, h: number): string {
  const r = resolveCornerRadii(el)
  const c = (n: number) => clampRadiusToBox(n, w, h)
  return `${c(r.tl)}px ${c(r.tr)}px ${c(r.br)}px ${c(r.bl)}px`
}

// ── Stroke-alignment overlay geometry ──
// center / outside strokes can't be a plain border (a border is always inside a
// border-box element), so they're painted by an absolutely-positioned overlay
// div grown OUTWARD from the body — half a stroke-width for center, a full width
// for outside — with the stroke as its border. The corner radii grow by the
// same amount so the overlay stays concentric with the body. Returns null for
// 'inside' (no overlay — the body's own border is used) or a non-positive width.
export interface StrokeOverlayBox {
  left: number
  top: number
  width: number
  height: number
  borderRadius: string
}
export function strokeOverlayBox(
  el: CanvasElement,
  w: number,
  h: number,
  strokeWidth: number,
  align: 'inside' | 'center' | 'outside',
): StrokeOverlayBox | null {
  if (align === 'inside' || strokeWidth <= 0) return null
  const grow = align === 'center' ? strokeWidth / 2 : strokeWidth
  const ow = w + grow * 2
  const oh = h + grow * 2
  const r = resolveCornerRadii(el)
  // Each corner grows by `grow` to stay concentric, then caps to the overlay box.
  const c = (n: number) => clampRadiusToBox(n + grow, ow, oh)
  return {
    left: -grow,
    top: -grow,
    width: ow,
    height: oh,
    borderRadius: `${c(r.tl)}px ${c(r.tr)}px ${c(r.br)}px ${c(r.bl)}px`,
  }
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

// ── 8-handle selection chrome ──
// Figma-style selection: 4 corner + 4 edge-midpoint resize handles, plus an
// invisible rotate zone OUTSIDE each corner. All hit-testing is pure geometry
// (the canvas renders only the 4 corner squares), so the same functions drive
// the hover cursor, the pointer-down routing, and the drag math.
export type ResizeHandle = 'tl' | 'tr' | 'br' | 'bl' | 't' | 'r' | 'b' | 'l'

export const RESIZE_HANDLES: readonly ResizeHandle[] = [
  'tl',
  'tr',
  'br',
  'bl',
  't',
  'r',
  'b',
  'l',
]
export const CORNER_HANDLES: readonly ('tl' | 'tr' | 'br' | 'bl')[] = ['tl', 'tr', 'br', 'bl']

// Hit thresholds in SCREEN px (callers pass zoom; the functions divide so the
// grab feel is constant at any zoom): corner grab radius, edge band half-width,
// and the outer radius of the per-corner rotate annulus.
export const HANDLE_CORNER_PX = 7
export const HANDLE_EDGE_PX = 5
export const ROTATE_ZONE_PX = 26

// Which box sides a handle moves: sx/sy ∈ {-1, 0, +1} (left/none/right,
// top/none/bottom). The opposite side is the resize anchor.
const HANDLE_SIGNS: Record<ResizeHandle, { sx: -1 | 0 | 1; sy: -1 | 0 | 1 }> = {
  tl: { sx: -1, sy: -1 },
  t: { sx: 0, sy: -1 },
  tr: { sx: 1, sy: -1 },
  l: { sx: -1, sy: 0 },
  r: { sx: 1, sy: 0 },
  bl: { sx: -1, sy: 1 },
  b: { sx: 0, sy: 1 },
  br: { sx: 1, sy: 1 },
}

/** Map a world point into the box's LOCAL frame (origin = box centre, axes =
 *  the box's own, i.e. rotated back by -deg). */
function toLocal(box: Box, deg: number, p: { x: number; y: number }) {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const dx = p.x - (box.x + box.w / 2)
  const dy = p.y - (box.y + box.h / 2)
  return { x: cos * dx + sin * dy, y: -sin * dx + cos * dy }
}

/** World positions of all 8 resize handles (4 corners + 4 edge midpoints) for
 *  a box rotated `rotationDeg` about its centre. */
export function handlePoints(
  box: Box,
  rotationDeg: number,
): Record<ResizeHandle, { x: number; y: number }> {
  const r = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const out = {} as Record<ResizeHandle, { x: number; y: number }>
  for (const h of RESIZE_HANDLES) {
    const { sx, sy } = HANDLE_SIGNS[h]
    const lx = (sx * box.w) / 2
    const ly = (sy * box.h) / 2
    out[h] = { x: cx + cos * lx - sin * ly, y: cy + sin * lx + cos * ly }
  }
  return out
}

/** Effective hit thresholds, capped so the zones never swallow a small
 *  ON-SCREEN box: at far zoom-out the screen-fixed bands would otherwise cover
 *  the whole body and make body-drag impossible (every press resizes). The cap
 *  keeps at least the middle half of the smaller side band-free — Figma
 *  degrades the same way. */
const handleThresholds = (box: Box, zoom: number) => {
  const minSidePx = Math.min(box.w, box.h) * zoom
  return {
    cornerR: Math.min(HANDLE_CORNER_PX, minSidePx / 4) / zoom,
    band: Math.min(HANDLE_EDGE_PX, minSidePx / 4) / zoom,
  }
}

/** Hit-test the 8 resize handles at a world `point`. Corners hit within a
 *  HANDLE_CORNER_PX/zoom radius and WIN over edges; edges hit within a
 *  ±HANDLE_EDGE_PX/zoom band along the (rotated) edge, bounded to the edge's
 *  span. Both thresholds cap to a quarter of the box's on-screen smaller side
 *  (see handleThresholds). Returns null when nothing is grabbed. */
export function hitHandle(
  box: Box,
  rotationDeg: number,
  point: { x: number; y: number },
  zoom: number,
): ResizeHandle | null {
  const { cornerR, band } = handleThresholds(box, zoom)
  const pts = handlePoints(box, rotationDeg)
  let best: ResizeHandle | null = null
  let bestD = Infinity
  for (const h of CORNER_HANDLES) {
    const d = Math.hypot(point.x - pts[h].x, point.y - pts[h].y)
    if (d <= cornerR && d < bestD) {
      best = h
      bestD = d
    }
  }
  if (best) return best
  const l = toLocal(box, rotationDeg, point)
  const hw = box.w / 2
  const hh = box.h / 2
  // Fixed order keeps the (tiny-box) band-overlap case deterministic.
  if (Math.abs(l.y + hh) <= band && Math.abs(l.x) <= hw) return 't'
  if (Math.abs(l.x - hw) <= band && Math.abs(l.y) <= hh) return 'r'
  if (Math.abs(l.y - hh) <= band && Math.abs(l.x) <= hw) return 'b'
  if (Math.abs(l.x + hw) <= band && Math.abs(l.y) <= hh) return 'l'
  return null
}

/** True when a world point lies inside (or on the border of) the rotated box. */
export function pointInRotatedBox(
  box: Box,
  rotationDeg: number,
  point: { x: number; y: number },
): boolean {
  const l = toLocal(box, rotationDeg, point)
  return Math.abs(l.x) <= box.w / 2 && Math.abs(l.y) <= box.h / 2
}

/** Hit-test the rotate zone: the annulus OUTSIDE each corner — corner distance
 *  in screen px within (HANDLE_CORNER_PX, ROTATE_ZONE_PX], no resize handle
 *  hit, and the point outside the rotated rect (so a body press still moves).
 *  Returns the nearest qualifying corner, or null. */
export function hitRotateZone(
  box: Box,
  rotationDeg: number,
  point: { x: number; y: number },
  zoom: number,
): 'tl' | 'tr' | 'br' | 'bl' | null {
  if (hitHandle(box, rotationDeg, point, zoom)) return null
  if (pointInRotatedBox(box, rotationDeg, point)) return null
  // Inner bound follows the (possibly capped) corner radius so the annulus
  // starts where the handle ends, whatever the box's on-screen size.
  const inner = handleThresholds(box, zoom).cornerR
  const outer = ROTATE_ZONE_PX / zoom
  const pts = handlePoints(box, rotationDeg)
  let best: 'tl' | 'tr' | 'br' | 'bl' | null = null
  let bestD = Infinity
  for (const h of CORNER_HANDLES) {
    const d = Math.hypot(point.x - pts[h].x, point.y - pts[h].y)
    if (d > inner && d <= outer && d < bestD) {
      best = h
      bestD = d
    }
  }
  return best
}

export interface ResizeFromHandleOpts {
  minW: number
  minH: number
  /** ⇧ — lock to the original w:h ratio (corner: dominant axis drives; edge:
   *  the dragged axis drives, the other follows, centred on its own axis). */
  aspect?: boolean
  /** ⌥ — anchor at the box CENTRE instead of the opposite side/corner. */
  fromCenter?: boolean
  /** Pointer-minus-handle offset captured at press, so the grab doesn't jump. */
  grabOffset?: { x: number; y: number }
}

/** Resize a (possibly rotated) box by dragging any of its 8 handles to a world
 *  point, keeping the opposite side/corner (or, with `fromCenter`, the centre)
 *  anchored in world space — matching how Figma resizes a rotated object.
 *
 *  An element renders as its axis-aligned box rotated about its CENTRE, so the
 *  math runs in the box's local frame: the pointer maps to new local extents
 *  for the dragged side(s), the anchored side(s) stay put, and the new centre
 *  is rotated back out. Floors clamp each axis (no flip past the anchor); with
 *  `aspect` the floors bump BOTH axes proportionally so the ratio holds. */
export function resizeFromHandle(
  box: Box,
  rotationDeg: number,
  handle: ResizeHandle,
  pointerWorld: { x: number; y: number },
  opts: ResizeFromHandleOpts,
): { x: number; y: number; width: number; height: number } {
  const { sx, sy } = HANDLE_SIGNS[handle]
  const fromCenter = !!opts.fromCenter
  const r = (rotationDeg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const l = toLocal(box, rotationDeg, {
    x: pointerWorld.x - (opts.grabOffset?.x ?? 0),
    y: pointerWorld.y - (opts.grabOffset?.y ?? 0),
  })
  // Raw size each dragged axis would take (may be negative — floored below).
  // Anchored at the opposite side: size = pointer minus that side; from the
  // centre: the half-extent under the pointer doubles.
  let candW = sx === 0 ? box.w : fromCenter ? 2 * sx * l.x : sx * l.x + box.w / 2
  let candH = sy === 0 ? box.h : fromCenter ? 2 * sy * l.y : sy * l.y + box.h / 2
  let w: number
  let h: number
  if (opts.aspect && box.w > 0 && box.h > 0) {
    if (sx !== 0 && sy !== 0) {
      // Corner: the proportionally-dominant axis drives (same as lockAspectRatio).
      const locked = lockAspectRatio(Math.max(0, candW), Math.max(0, candH), box.w, box.h)
      candW = locked.width
      candH = locked.height
    } else if (sx !== 0) {
      candW = Math.max(0, candW)
      candH = (candW * box.h) / box.w
    } else {
      candH = Math.max(0, candH)
      candW = (candH * box.w) / box.h
    }
    // Enforce the floors PROPORTIONALLY: scale BOTH axes by the same factor so
    // the locked ratio survives (independent Math.max would distort it).
    const bump = Math.max(
      candW > 0 ? opts.minW / candW : 1,
      candH > 0 ? opts.minH / candH : 1,
      1,
    )
    // Final Math.max guards a degenerate (zero) locked axis.
    w = Math.max(opts.minW, candW * bump)
    h = Math.max(opts.minH, candH * bump)
  } else {
    w = Math.max(opts.minW, candW)
    h = Math.max(opts.minH, candH)
  }
  // New centre in the ORIGINAL local frame: an anchored axis keeps its fixed
  // side, an undragged or centre-anchored axis stays centred — then rotate out.
  const mx = fromCenter || sx === 0 ? 0 : sx > 0 ? w / 2 - box.w / 2 : box.w / 2 - w / 2
  const my = fromCenter || sy === 0 ? 0 : sy > 0 ? h / 2 - box.h / 2 : box.h / 2 - h / 2
  const ncx = cx + cos * mx - sin * my
  const ncy = cy + sin * mx + cos * my
  return { x: ncx - w / 2, y: ncy - h / 2, width: w, height: h }
}

/** The world point `resizeFromHandle` keeps fixed for a given handle — the
 *  opposite corner / edge-centre (per axis: an undragged axis is centred), or
 *  the box centre with `fromCenter`. For an UNROTATED box only (the group-bbox
 *  scale path); a rotated single element anchors inside resizeFromHandle. */
export function resizeAnchor(
  box: Box,
  handle: ResizeHandle,
  fromCenter?: boolean,
): { x: number; y: number } {
  const { sx, sy } = HANDLE_SIGNS[handle]
  return {
    x: fromCenter || sx === 0 ? box.x + box.w / 2 : sx > 0 ? box.x : box.x + box.w,
    y: fromCenter || sy === 0 ? box.y + box.h / 2 : sy > 0 ? box.y : box.y + box.h,
  }
}

/** CSS resize cursor for a handle on an element rotated `rotationDeg`: the
 *  handle's outward direction plus the rotation, snapped to the nearest 45°
 *  bucket (ew / nwse / ns / nesw — the four double-arrow cursors). */
export function cursorForHandle(handle: ResizeHandle, rotationDeg: number): string {
  // Outward direction of each handle in screen degrees (0 = east, clockwise
  // positive — screen y points down).
  const base: Record<ResizeHandle, number> = {
    r: 0,
    br: 45,
    b: 90,
    bl: 135,
    l: 180,
    tl: 225,
    t: 270,
    tr: 315,
  }
  const a = (((base[handle] + rotationDeg) % 360) + 360) % 360
  const bucket = Math.round(a / 45) % 4
  return (['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'] as const)[bucket]
}

/** Resize a (possibly rotated) box by dragging its BOTTOM-RIGHT corner —
 *  the legacy single-handle entry point, now a thin delegation to
 *  `resizeFromHandle('br')` (identical math: opposite corner anchored,
 *  `lockAspect` = the proportional Shift-drag). */
export function resizeRotatedBR(
  box: Box,
  deg: number,
  pointer: { x: number; y: number },
  opts: { minW: number; minH: number; lockAspect?: boolean },
): Box {
  const r = resizeFromHandle(box, deg, 'br', pointer, {
    minW: opts.minW,
    minH: opts.minH,
    aspect: opts.lockAspect,
  })
  return { x: r.x, y: r.y, w: r.width, h: r.height }
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
