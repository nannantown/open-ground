// canvasTextSizing.ts — the single source of truth for Figma-parity text
// resize modes. Pure + framework-free so every rule unit-tests in isolation;
// both the renderer (ElementView) and the interaction layer
// (InfiniteCanvas / SelectionInspector) import THESE helpers rather than
// re-deriving the mode logic. See docs/CANVAS_TEXT_SIZING_PLAN.md.
//
// THE THREE MODES (Figma's textAutoResize):
//   auto-width  — box hugs content on BOTH axes; no wrap; typing widens it,
//                 an explicit newline adds height. width/height are MEASURED.
//   auto-height — width is AUTHORITATIVE (user-dragged); text wraps within it;
//                 height is the measured wrapped height.
//   fixed       — width AND height authoritative; text wraps, overflow clipped;
//                 vertical alignment positions the glyphs in the box.
//
// "Authoritative" = the user owns it (a drag / inspector field); "measured" =
// ElementView's ResizeObserver writes it back (quantised, idempotent). Per
// mode, `textMeasurePatch` decides which axes a measurement is allowed to
// overwrite, so a measured write never clobbers a user-set width/height.

import type { CanvasElement } from './types'
import { TEXT_W, TEXT_H } from './canvasBounds'

export type TextSizing = 'auto-width' | 'auto-height' | 'fixed'
export type TextVAlign = 'top' | 'middle' | 'bottom'

/** The three modes in inspector order (auto-width is the default / leftmost). */
export const TEXT_SIZING_MODES: readonly TextSizing[] = [
  'auto-width',
  'auto-height',
  'fixed',
]

/** Resolve the mode, defaulting a legacy/new text (undefined) to auto-width. */
export const textSizingOf = (
  el: Pick<CanvasElement, 'textSizing'>,
): TextSizing => el.textSizing ?? 'auto-width'

/** Resolve the vertical alignment (fixed mode only), defaulting to top. */
export const textVAlignOf = (
  el: Pick<CanvasElement, 'textVerticalAlign'>,
): TextVAlign => el.textVerticalAlign ?? 'top'

/** Is the WIDTH content-measured (true) or user-authoritative (false)? Only
 *  auto-width measures its width. */
export const measuresWidth = (mode: TextSizing): boolean => mode === 'auto-width'

/** Is the HEIGHT content-measured? Both auto modes measure height; fixed does
 *  not (its height is user-set, overflow clipped). */
export const measuresHeight = (mode: TextSizing): boolean => mode !== 'fixed'

/** The box used by bounds / selection / hit-test / snapping. Reads the
 *  persisted footprint (measured for autos, user-set for fixed) with the
 *  legacy 300×44 only as the pre-first-measure fallback. */
export const textBox = (
  el: Pick<CanvasElement, 'width' | 'height'>,
): { w: number; h: number } => ({
  w: el.width ?? TEXT_W,
  h: el.height ?? TEXT_H,
})

// Quantise UP to a 2px grid: cross-machine font rasterisation rarely differs by
// more than a px, so a quantised footprint stays stable across teammates'
// machines in git-shared mode (no width/height churn ping-pong). Mirrors the
// original textFootprintPatch quantum.
const q2 = (n: number): number => Math.ceil(n / 2) * 2

/** The width/height patch a measured render should persist, per mode, or null
 *  when nothing should be written:
 *  - fixed → null (neither axis is measured);
 *  - a non-positive measurement (unmounted / not laid out yet) → null;
 *  - only the MEASURED axes for the mode are eligible (measuresWidth /
 *    measuresHeight) so a measurement can never overwrite a user-set value;
 *  - a sub-quantum no-op on every eligible axis → null (stops the observer
 *    ping-ponging with the engine's own writes).
 *  Supersedes the old `textFootprintPatch` (which only ever handled the
 *  auto-width-equivalent both-axes case for layout-managed text). */
export const textMeasurePatch = (
  el: Pick<CanvasElement, 'width' | 'height' | 'textSizing'>,
  w: number,
  h: number,
): { width?: number; height?: number } | null => {
  const mode = textSizingOf(el)
  if (mode === 'fixed') return null
  if (w <= 0 || h <= 0) return null
  const out: { width?: number; height?: number } = {}
  if (measuresWidth(mode)) {
    const nw = q2(w)
    if (nw !== el.width) out.width = nw
  }
  if (measuresHeight(mode)) {
    const nh = q2(h)
    if (nh !== el.height) out.height = nh
  }
  if (out.width === undefined && out.height === undefined) return null
  return out
}

/** Fields to set when the inspector switches a text to `to`, keeping the box
 *  visually put at switch time. `measured` is the element's CURRENT rendered
 *  box (so a fresh switch from auto-width freezes the right width). Always
 *  seeds width/height so there's no flash to the 300×44 fallback; the next
 *  measure then corrects the measured axes.
 *   - → auto-width : both axes seeded, both immediately re-measured to content;
 *   - → auto-height: width frozen authoritative, height stays measured;
 *   - → fixed      : both axes frozen authoritative. */
export const convertSizing = (
  el: Pick<CanvasElement, 'width' | 'height' | 'textSizing'>,
  to: TextSizing,
  measured: { w: number; h: number },
): { textSizing: TextSizing; width: number; height: number } => {
  const w = el.width ?? measured.w
  const h = el.height ?? measured.h
  return { textSizing: to, width: w, height: h }
}

/** Which kind of resize handle the user grabbed. */
export type ResizeHandle = 'horizontal' | 'vertical' | 'corner'

/** Figma's resize-drag → mode transition. Dragging the WIDTH of an auto text
 *  promotes it to a wrapping mode; dragging the HEIGHT (or a corner) fixes it:
 *   - horizontal on auto-width  → auto-height (width becomes authoritative);
 *   - horizontal on auto-height → stays auto-height, new width;
 *   - horizontal on fixed       → stays fixed, new width;
 *   - vertical / corner (any)   → fixed (both axes authoritative).
 *  The caller passes the dragged-to box (`w`,`h` already clamped to a sane
 *  minimum); this returns only the mode + the axes that mode makes
 *  authoritative. */
export const resizeOutcome = (
  mode: TextSizing,
  handle: ResizeHandle,
  w: number,
  h: number,
): { textSizing: TextSizing; width: number; height?: number } => {
  if (handle === 'horizontal') {
    if (mode === 'fixed') return { textSizing: 'fixed', width: w, height: h }
    return { textSizing: 'auto-height', width: w }
  }
  // vertical or corner → both axes fixed
  return { textSizing: 'fixed', width: w, height: h }
}
