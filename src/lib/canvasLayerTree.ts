// Layers-panel tree model (Figma-style hierarchy list).
//
// The canvas element array is z-order *back→front*. The Layers panel shows the
// front-most element at the TOP and nests children (via `parentId`) under their
// container, so this module translates the flat z-order array into a
// depth-annotated, front-at-top row list — and, in the other direction, moves an
// element (with its whole subtree) to a new spot in that list while keeping the
// z-order array the single source of truth.
//
// Pure + side-effect-free so it unit-tests in isolation (mirrors
// canvasContainment.ts / canvasIntegrity.ts).

import type { CanvasElement } from './types'
import { CONTAINER_TYPES, canContain, descendantIds } from './canvasContainment'

export interface LayerRow {
  el: CanvasElement
  /** Nesting depth along the parentId chain (0 = top level). Drives indent. */
  depth: number
  /** True when this element owns at least one child (shows a twisty). */
  hasChildren: boolean
}

/** True when `el` is a real, present child: it carries a `parentId` that points
 *  at an element which (a) exists and (b) is a container type allowed to own it.
 *  A dangling / illegal parentId makes the element a top-level row instead. */
const isLiveChild = (el: CanvasElement, byId: Map<string, CanvasElement>): boolean => {
  if (!el.parentId) return false
  const parent = byId.get(el.parentId)
  return !!parent && CONTAINER_TYPES.has(parent.type) && canContain(parent.type, el.type)
}

/** Build the front-at-top, depth-annotated row list for the Layers panel.
 *
 *  Siblings at every level are shown front-most first (the array is back→front,
 *  so each sibling group is reversed). A container's children are emitted right
 *  under it, but only when `isExpanded(id)` returns true. Cycle-safe: each
 *  element is emitted at most once. */
export const buildLayerRows = (
  els: CanvasElement[],
  isExpanded: (id: string) => boolean,
): LayerRow[] => {
  const byId = new Map(els.map((e) => [e.id, e]))
  // children, in z-order (back→front) — reversed at emit time for front-at-top.
  const childrenOf = new Map<string, CanvasElement[]>()
  const roots: CanvasElement[] = []
  for (const el of els) {
    if (isLiveChild(el, byId)) {
      const list = childrenOf.get(el.parentId!)
      if (list) list.push(el)
      else childrenOf.set(el.parentId!, [el])
    } else {
      roots.push(el)
    }
  }

  const out: LayerRow[] = []
  const seen = new Set<string>()
  const walk = (siblings: CanvasElement[], depth: number) => {
    // Reverse a *copy* so we render front-most first without mutating state.
    for (let i = siblings.length - 1; i >= 0; i--) {
      const el = siblings[i]
      if (seen.has(el.id)) continue
      seen.add(el.id)
      const kids = childrenOf.get(el.id)
      out.push({ el, depth, hasChildren: !!kids?.length })
      if (kids?.length && isExpanded(el.id)) walk(kids, depth + 1)
    }
  }
  walk(roots, 0)
  // Safety net for pure parentId cycles (a→b→a): such elements are never roots
  // and never reachable from a root, so the walk can't emit them and they'd
  // silently vanish with no way to recover them. Surface only the genuinely
  // UNREACHABLE ones as top-level rows — NOT elements merely hidden under a
  // collapsed container (those are reachable and correctly omitted).
  const reachable = new Set<string>()
  const stack = roots.map((r) => r.id)
  while (stack.length) {
    const id = stack.pop()!
    if (reachable.has(id)) continue
    reachable.add(id)
    for (const kid of childrenOf.get(id) ?? []) stack.push(kid.id)
  }
  if (reachable.size < els.length) {
    for (const el of els) {
      if (reachable.has(el.id) || seen.has(el.id)) continue
      seen.add(el.id)
      out.push({ el, depth: 0, hasChildren: !!childrenOf.get(el.id)?.length })
    }
  }
  return out
}

/** Move `dragId` (and its whole subtree) so that in the panel it lands directly
 *  `place` ('above' = more toward front / 'below' = more toward back) the
 *  `targetId` row, adopting the target's level (parentId).
 *
 *  Returns a new element array, or the original reference unchanged for any
 *  no-op (same element, target inside the dragged subtree, or nothing moved).
 *  Reparenting is gated by {@link canContain}: if the target's container can't
 *  legally own the dragged element, it drops to the top level instead, still
 *  positioned next to the target in z-order. */
export const reorderLayer = (
  els: CanvasElement[],
  dragId: string,
  targetId: string,
  place: 'above' | 'below',
): CanvasElement[] => {
  if (dragId === targetId) return els
  const byId = new Map(els.map((e) => [e.id, e]))
  const drag = byId.get(dragId)
  const target = byId.get(targetId)
  if (!drag || !target) return els

  // Can't drop a container into its own subtree.
  const subtree = descendantIds(els, dragId)
  if (subtree.has(targetId)) return els

  // The contiguous block to move = the dragged element + its descendants, kept
  // in their existing relative z-order.
  const block = els.filter((e) => e.id === dragId || subtree.has(e.id))
  const blockIds = new Set(block.map((e) => e.id))

  // Decide the dragged element's new parent: the target's level, but only if
  // that container may legally own it; otherwise the dragged element goes to the
  // top level. (Descendants keep their own parentId — they travel with it.)
  let newParentId = target.parentId
  if (newParentId) {
    const newParent = byId.get(newParentId)
    if (!newParent || !canContain(newParent.type, drag.type)) newParentId = undefined
  }
  const reparented = block.map((e) =>
    e.id === dragId ? withParent(e, newParentId) : e,
  )

  const rest = els.filter((e) => !blockIds.has(e.id))
  const targetIdx = rest.findIndex((e) => e.id === targetId)
  if (targetIdx < 0) return els
  // Panel front-at-top: array end = front. "above" the target (more front) =
  // AFTER it in the array; "below" (more back) = BEFORE it.
  const insertAt = place === 'above' ? targetIdx + 1 : targetIdx
  const next = [...rest.slice(0, insertAt), ...reparented, ...rest.slice(insertAt)]
  return next
}

const withParent = (el: CanvasElement, parentId: string | undefined): CanvasElement => {
  if ((el.parentId ?? undefined) === parentId) return el
  if (parentId === undefined) {
    const { parentId: _drop, ...rest } = el
    return rest as CanvasElement
  }
  return { ...el, parentId }
}
