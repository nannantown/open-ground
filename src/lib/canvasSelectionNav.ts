// Keyboard selection navigation (Figma Enter / ⇧Enter / Tab / ⇧Tab).
//
// The tree is the persisted parentId graph: siblings share a parentId
// (undefined = top level), order is ARRAY order — the canvas's z-order —
// matching how Figma's Tab walks the layer list. Groups are invisible
// selection units and comments are pins, so neither participates; hidden
// elements are skipped (you can't see what you'd select).
//
// Pure + side-effect-free (mirrors canvasGroup.ts) so it unit-tests in
// isolation; the caller turns the returned id into a selection.

import type { CanvasElement } from './types'

const navigable = (el: CanvasElement): boolean =>
  !el.hidden && el.type !== 'group' && el.type !== 'comment'

/** The navigable elements sharing `el`'s parent (including `el`), array
 *  order. */
const siblingsOf = (els: CanvasElement[], el: CanvasElement): CanvasElement[] =>
  els.filter((e) => navigable(e) && e.parentId === el.parentId)

/** Tab / ⇧Tab: the next (+1) / previous (-1) sibling, wrapping around.
 *  Returns null when the id is unknown / not navigable / an only child. */
export function siblingId(
  els: CanvasElement[],
  id: string,
  dir: 1 | -1,
): string | null {
  const el = els.find((e) => e.id === id)
  if (!el || !navigable(el)) return null
  const sibs = siblingsOf(els, el)
  if (sibs.length < 2) return null
  const i = sibs.findIndex((e) => e.id === id)
  return sibs[(i + dir + sibs.length) % sibs.length].id
}

/** Enter: drill into the selection — the first navigable child (array order),
 *  or null when the element owns none (the caller falls back to editing the
 *  element's text, Figma's Enter-on-a-leaf). */
export function firstChildId(els: CanvasElement[], id: string): string | null {
  const child = els.find((e) => navigable(e) && e.parentId === id)
  return child?.id ?? null
}

/** ⇧Enter: step out to the parent container. Skips group ancestors (they are
 *  selection units, not navigable objects) and returns null at top level. */
export function parentId(els: CanvasElement[], id: string): string | null {
  const byId = new Map(els.map((e) => [e.id, e]))
  let p = byId.get(id)?.parentId
  const seen = new Set([id])
  while (p && !seen.has(p)) {
    const el = byId.get(p)
    if (!el) return null
    if (el.type !== 'group') return el.id
    seen.add(p)
    p = el.parentId
  }
  return null
}
