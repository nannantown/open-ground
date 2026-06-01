// Pure helpers shared by the Selection Inspector, the shape view, and the
// click-drag creation path for the SHAPE element type (round 5): a plain
// axis-aligned rectangle or ellipse. Mirrors the round-3/4 split
// (`canvasFillStyle.ts`, `canvasTransform.ts`): the panel that *edits* a shape
// and the view that *renders* it agree on the same defaults. Keeping the logic
// out of the React components keeps it unit-testable in the `node` vitest env.
//
// A shape carries NO new geometry beyond the existing `width` / `height` — it is
// a plain rect, so the existing axis-aligned hit-testing (fullBounds /
// topElementAt / marquee) covers it unchanged. It CONSUMES the existing optional
// fill / strokeColor / strokeWidth / cornerRadius / opacity fields:
//   - fill / stroke           → via resolveShapeStyle (built on the same
//                               clamp/default rules as the frame style).
//   - cornerRadius            → rect only; an ellipse rounds to 50% and ignores
//                               the radius entirely.
//   - opacity                 → via resolveOpacity (canvasTransform.ts).
//
// All shape fields are OPTIONAL and backward-compatible: a shape saved without
// `shapeKind` is a rectangle (the default primitive), and one saved without
// fill/stroke gets the built-in shape defaults below.

import type { CanvasElement } from './types'

// ── Shape kind ──
// The default primitive a `shape` draws when `shapeKind` is unset.
export type ShapeKind = 'rect' | 'ellipse'
export const DEFAULT_SHAPE_KIND: ShapeKind = 'rect'

/** Resolve the effective primitive for a shape, folding in the default so a
 *  shape saved without `shapeKind` renders as a rectangle. Anything other than
 *  the two known kinds also snaps to the default, so a stray value can't draw a
 *  third, unhandled primitive. */
export function resolveShapeKind(el: CanvasElement): ShapeKind {
  return el.shapeKind === 'ellipse' ? 'ellipse' : DEFAULT_SHAPE_KIND
}

// ── Shape default size (click-drag creation + inspector W/H fallback) ──
// The box a plain click (no drag) drops, and the size a legacy shape with no
// explicit width/height falls back to. Kept in sync with SHAPE_DEFAULT_W/H in
// the views / inspector so the rendered box and the W/H readout agree.
export const SHAPE_DEFAULT_W = 160
export const SHAPE_DEFAULT_H = 120

// ── Shape fill + stroke ──
// A fresh shape reads with an obvious filled body + thin border so it's visible
// the instant it's drawn (unlike a frame, whose body is a faint paper wash). A
// legacy shape with no fill/stroke fields resolves to these.
export const DEFAULT_SHAPE_FILL = '#D9CDA8'
export const DEFAULT_SHAPE_STROKE_COLOR = '#8C7B52'
export const DEFAULT_SHAPE_STROKE_WIDTH = 1

/** Resolve the effective fill + stroke for a SHAPE, folding in the shape
 *  defaults for any field the element doesn't carry. Used by the shape view so
 *  a shape with no fill/stroke fields renders with the visible default look,
 *  and by the inspector so its Fill/Stroke controls open on the real value. */
export function resolveShapeStyle(el: CanvasElement): {
  fill: string
  strokeColor: string
  strokeWidth: number
} {
  return {
    fill: el.fill ?? DEFAULT_SHAPE_FILL,
    strokeColor: el.strokeColor ?? DEFAULT_SHAPE_STROKE_COLOR,
    strokeWidth: el.strokeWidth ?? DEFAULT_SHAPE_STROKE_WIDTH,
  }
}

// ── Click-drag → rect, with Figma modifier keys ──
// Pure geometry for the shape / frame / rect / ellipse draw gesture. The
// component reads the live modifier set on every pointer-move (and on
// keydown/keyup of the modifier keys) and asks this helper for the in-progress
// box, so the preview rect and the committed element always size identically.
//
// Modifiers (matching Figma, evaluated continuously — not latched at press):
//   - SHIFT       → constrain to a 1:1 square. Both extents become the LARGER
//                   of |dx| / |dy| (the dominant axis), still growing toward the
//                   dragged quadrant from the anchor.
//   - ALT/OPTION  → draw from CENTER: the anchor is the box's centre and it
//                   grows symmetrically, so the half-extents are |dx| / |dy|
//                   and the full box is 2|dx| × 2|dy| centred on the anchor.
//   - SHIFT+ALT   → both compose: a centred square whose half-extent tracks the
//                   dominant axis.
//   - offset      → SPACE-to-reposition-while-drawing: the component freezes the
//                   size and translates the whole in-progress box by the pointer
//                   delta accumulated since Space was pressed. Passing that delta
//                   here shifts both the anchor and the pointer equally, so the
//                   box keeps its size and just moves.
export interface DrawModifiers {
  /** Constrain to a square / 1:1 (Shift). */
  shift?: boolean
  /** Grow symmetrically from the anchor as the centre (Alt / Option). */
  alt?: boolean
  /** Translate the whole box by this world-space delta (Space-reposition). */
  offset?: { x: number; y: number }
}

export interface DrawRect {
  x: number
  y: number
  w: number
  h: number
}

/** Compute the in-progress draw rect from the press anchor `A`, the current
 *  pointer `P`, and the live modifier set. Always returns a normalised box
 *  (non-negative w/h, top-left origin) in the same world space as the inputs. */
export function drawRectFromDrag(
  A: { x: number; y: number },
  P: { x: number; y: number },
  mods: DrawModifiers = {},
): DrawRect {
  const off = mods.offset ?? { x: 0, y: 0 }
  // Space-reposition: shift both endpoints equally so the size is frozen and the
  // box just translates.
  const ax = A.x + off.x
  const ay = A.y + off.y
  const px = P.x + off.x
  const py = P.y + off.y

  let dx = px - ax
  let dy = py - ay

  if (mods.shift) {
    // Square: both extents become the dominant one, keeping the drag quadrant.
    const m = Math.max(Math.abs(dx), Math.abs(dy))
    // A zero axis (pure-horizontal / pure-vertical drag) still squares toward
    // the positive side rather than collapsing.
    const sx = dx < 0 ? -1 : 1
    const sy = dy < 0 ? -1 : 1
    dx = m * sx
    dy = m * sy
  }

  if (mods.alt) {
    // From centre: the anchor is the middle, half-extents are |dx| / |dy|.
    const hw = Math.abs(dx)
    const hh = Math.abs(dy)
    return { x: ax - hw, y: ay - hh, w: hw * 2, h: hh * 2 }
  }

  // Default / Shift-only: box from the anchor to anchor+delta, normalised.
  return {
    x: Math.min(ax, ax + dx),
    y: Math.min(ay, ay + dy),
    w: Math.abs(dx),
    h: Math.abs(dy),
  }
}
