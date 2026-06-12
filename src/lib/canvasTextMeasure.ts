// Measured-text reflow for auto layout (Figma parity, plan D).
//
// A `text` element renders auto-width (the box hugs its content), but the
// layout ENGINE reads its footprint from `width`/`height` — so a text that
// grew past the 300×44 default would overlap its flow siblings. For texts
// managed by a layout frame, ElementView observes the rendered box
// (ResizeObserver, offset px) and the canvas persists it through this
// decision so the flow's footprint always matches the real text.
//
// Pure + framework-free so the write-or-not rule unit-tests in isolation.

import type { CanvasElement } from './types'

/** The width/height patch a measured text box should persist, or null when
 *  nothing should be written:
 *  - a non-positive measurement (the node is unmounted / not laid out yet)
 *    never writes;
 *  - sizes quantise UP to a 2px grid — cross-machine font rasterisation
 *    rarely differs by more than a px, so the quantised footprint is stable
 *    across teammates' machines in git-shared mode (no churn ping-pong);
 *  - a change below the quantum on BOTH axes is noise, not a reflow —
 *    skipping it is the guard that keeps the observer from ping-ponging with
 *    the engine's own writes.
 *  When it does write, both axes are written together so the stored footprint
 *  can't go half-stale. */
export function textFootprintPatch(
  el: Pick<CanvasElement, 'width' | 'height'>,
  w: number,
  h: number,
): { width: number; height: number } | null {
  if (w <= 0 || h <= 0) return null
  const width = Math.ceil(w / 2) * 2
  const height = Math.ceil(h / 2) * 2
  if (width === el.width && height === el.height) return null
  return { width, height }
}

/** True when `id` is a text element whose footprint is layout-managed — its
 *  parent is a frame carrying auto layout. Only these texts persist their
 *  measured render size; a free text never writes one (its box stays purely
 *  content-derived, as before). */
export function isLayoutManagedText(elements: CanvasElement[], id: string): boolean {
  const el = elements.find((e) => e.id === id)
  // Locked elements are immune to every mutation (house rule) — including
  // this implicit one.
  if (!el || el.type !== 'text' || !el.parentId || el.locked) return false
  const parent = elements.find((e) => e.id === el.parentId)
  return parent?.type === 'frame' && !!parent.layout
}
