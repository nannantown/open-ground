// Comment-anchor integrity helpers.
//
// A `comment` element may carry an `anchorId` pointing at the element it was
// dropped on top of (a mock, frame, sticky, …). When that anchor element is
// deleted, the comment keeps a now-meaningless `anchorId` — a *dangling*
// reference. It silently degrades the Run prompt (no source/context footer is
// attached) and survives reloads/clones, so we scrub it at the two moments a
// reference can go stale:
//
//   1. on the client, whenever elements are removed (Delete key, context-menu
//      delete, cut) — see `clearDanglingAnchors`;
//   2. on the server, when an inbound `CANVAS_ADD: {type:"comment", anchorId}`
//      names an element that doesn't exist in the target Canvas — the write
//      path drops the unresolvable `anchorId` before persisting.
//
// Both call sites share the same rule: a comment's `anchorId` is kept only if
// some element in the surviving set actually has that id.

import type { CanvasElement } from './types'
import { clearDanglingParents } from './canvasContainment'

/** Return `els` with every comment's `anchorId` dropped when no element in the
 *  same set carries that id. Returns the original array reference unchanged
 *  when nothing was dangling, so callers can cheaply skip a no-op write. */
export const clearDanglingAnchors = (els: CanvasElement[]): CanvasElement[] => {
  const ids = new Set(els.map((e) => e.id))
  let changed = false
  const next = els.map((el) => {
    if (el.type === 'comment' && el.anchorId && !ids.has(el.anchorId)) {
      changed = true
      const { anchorId: _drop, ...rest } = el
      return rest as CanvasElement
    }
    return el
  })
  return changed ? next : els
}

/** Remove the elements named by `ids`, then scrub references the removal would
 *  strand: comment anchors (clearDanglingAnchors) and frame/design parent ids
 *  (clearDanglingParents). This is THE deletion path — the Delete/Backspace key,
 *  the context-menu delete, and Cut all funnel through it so none of them leave
 *  a dangling `anchorId`/`parentId` behind. Returns the original array reference
 *  unchanged when nothing matched, so callers can skip a no-op write. */
export const removeElements = (
  els: CanvasElement[],
  ids: Iterable<string>,
): CanvasElement[] => {
  const drop = ids instanceof Set ? ids : new Set(ids)
  const remaining = els.filter((el) => !drop.has(el.id))
  if (remaining.length === els.length) return els
  return clearDanglingParents(clearDanglingAnchors(remaining))
}
