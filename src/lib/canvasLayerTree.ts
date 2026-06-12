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

/** Where a dragged layer lands relative to the target row: next to it
 *  ('above' = more toward front / 'below' = more toward back) or INSIDE it
 *  ('into' — the target becomes the parent). */
export type LayerDropPlace = 'above' | 'below' | 'into'

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
 *  `place` the `targetId` row: 'above' (more toward front) / 'below' (more
 *  toward back) adopt the target's level (parentId); 'into' makes the target
 *  itself the parent, inserting at the head of its child list (= front-most).
 *
 *  Returns a new element array, or the original reference unchanged for any
 *  no-op (same element, target inside the dragged subtree, an 'into' drop the
 *  target may not legally own, or nothing moved). For 'above'/'below',
 *  reparenting is gated by {@link canContain}: if the target's container can't
 *  legally own the dragged element, it drops to the top level instead, still
 *  positioned next to the target in z-order. */
export const reorderLayer = (
  els: CanvasElement[],
  dragId: string,
  targetId: string,
  place: LayerDropPlace,
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

  if (place === 'into') {
    // Only a container that may legally own the dragged type accepts an INTO
    // drop (the panel never offers an illegal one — this is the pure guard).
    if (!canContain(target.type, drag.type)) return els
    const reparented = block.map((e) =>
      e.id === dragId ? withParent(e, targetId) : e,
    )
    const rest = els.filter((e) => !blockIds.has(e.id))
    // Insert after the container's whole remaining subtree so the dropped
    // element renders in front of everything already inside — i.e. it becomes
    // the FRONT-MOST child = the head of the panel's child list.
    const targetSubtree = descendantIds(els, targetId)
    let end = -1
    rest.forEach((e, i) => {
      if (e.id === targetId || targetSubtree.has(e.id)) end = i
    })
    if (end < 0) return els
    return [...rest.slice(0, end + 1), ...reparented, ...rest.slice(end + 1)]
  }

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

export interface LayerFilterResult {
  /** The surviving rows, in their original order: every match plus every
   *  ancestor a match needs to stay visually rooted. */
  rows: LayerRow[]
  /** Containers that must render expanded because a DESCENDANT matched —
   *  the panel's twisty/aria state while a query is active. */
  expandedIds: Set<string>
}

/** Match text when the caller doesn't inject the app's display-label fn:
 *  custom layer name, else first non-empty content line. (The type always
 *  matches separately, so an unnamed empty element is still findable.) */
const defaultLayerText = (el: CanvasElement): string => {
  if (el.name?.trim()) return el.name
  const line = el.text
    ?.split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return line ?? ''
}

/** Filter the Layers list by a search query (name OR element type,
 *  case-insensitive substring). A matching row keeps its whole ancestor chain
 *  so the tree context stays readable; children of a matching container that
 *  don't themselves match are dropped (Figma behaviour).
 *
 *  `rows` must be built FULLY EXPANDED (`buildLayerRows(els, () => true)`) so
 *  matches inside collapsed containers are found — the returned `expandedIds`
 *  is the expansion state the panel renders during the query. An empty /
 *  whitespace query returns `rows` unchanged. */
export const filterLayerRows = (
  rows: LayerRow[],
  query: string,
  labelOf: (el: CanvasElement) => string = defaultLayerText,
): LayerFilterResult => {
  const q = query.trim().toLowerCase()
  if (!q) return { rows, expandedIds: new Set() }
  const matches = (row: LayerRow) =>
    labelOf(row.el).toLowerCase().includes(q) ||
    row.el.type.toLowerCase().includes(q)
  const keep = new Set<string>()
  const expandedIds = new Set<string>()
  // Rows are DFS order, so the live ancestor chain is the depth-ascending
  // stack of rows above the current one.
  const ancestors: LayerRow[] = []
  for (const row of rows) {
    while (ancestors.length && ancestors[ancestors.length - 1].depth >= row.depth) {
      ancestors.pop()
    }
    if (matches(row)) {
      keep.add(row.el.id)
      for (const anc of ancestors) {
        keep.add(anc.el.id)
        expandedIds.add(anc.el.id)
      }
    }
    ancestors.push(row)
  }
  return { rows: rows.filter((r) => keep.has(r.el.id)), expandedIds }
}

/** The array-ordered (back→front) sibling list `id` belongs to — its live
 *  parent's children, or the top-level roots — exactly the grouping
 *  buildLayerRows nests by. Null when `id` isn't in `els`. */
const siblingScope = (
  els: CanvasElement[],
  id: string,
): { siblings: CanvasElement[]; index: number } | null => {
  const byId = new Map(els.map((e) => [e.id, e]))
  const el = byId.get(id)
  if (!el) return null
  const live = isLiveChild(el, byId)
  const siblings = els.filter((e) =>
    isLiveChild(e, byId) ? live && e.parentId === el.parentId : !live,
  )
  const index = siblings.findIndex((e) => e.id === id)
  return index < 0 ? null : { siblings, index }
}

/** True when `id` can take a one-step z-nudge `dir` ('up' = toward front)
 *  WITHIN ITS OWN SIBLING GROUP. This is the panel's enabled/disabled
 *  predicate — judged on the array + parent scope, never on visible-row
 *  indexes (a nested child's row index says nothing about its z headroom). */
export const canMoveLayer = (
  els: CanvasElement[],
  id: string,
  dir: 'up' | 'down',
): boolean => {
  const scope = siblingScope(els, id)
  if (!scope) return false
  return dir === 'up' ? scope.index < scope.siblings.length - 1 : scope.index > 0
}

/** Move `id` (with its whole subtree) one sibling step in z-order: 'up' =
 *  toward front, 'down' = toward back, never leaving its parent scope. The
 *  block lands on the far side of the neighbouring sibling's WHOLE subtree, so
 *  stepping over a container means stepping over its children too. Returns the
 *  original reference unchanged when the move is impossible. */
export const moveLayerOne = (
  els: CanvasElement[],
  id: string,
  dir: 'up' | 'down',
): CanvasElement[] => {
  const scope = siblingScope(els, id)
  if (!scope) return els
  const neighbor = scope.siblings[dir === 'up' ? scope.index + 1 : scope.index - 1]
  if (!neighbor) return els
  const subtree = descendantIds(els, id)
  const blockIds = new Set(subtree)
  blockIds.add(id)
  const block = els.filter((e) => blockIds.has(e.id))
  const rest = els.filter((e) => !blockIds.has(e.id))
  const neighborSubtree = descendantIds(els, neighbor.id)
  let lo = -1
  let hi = -1
  rest.forEach((e, i) => {
    if (e.id === neighbor.id || neighborSubtree.has(e.id)) {
      if (lo < 0) lo = i
      hi = i
    }
  })
  if (hi < 0) return els
  const insertAt = dir === 'up' ? hi + 1 : lo
  return [...rest.slice(0, insertAt), ...block, ...rest.slice(insertAt)]
}

/** Nearest-first chain of LIVE ancestor containers above `id` — the rows the
 *  panel must expand to reveal it. A dangling/illegal parentId ends the chain
 *  (such an element is a top-level row). Cycle-safe. */
export const layerAncestors = (els: CanvasElement[], id: string): string[] => {
  const byId = new Map(els.map((e) => [e.id, e]))
  const out: string[] = []
  const seen = new Set<string>([id])
  let cur = byId.get(id)
  while (cur && isLiveChild(cur, byId)) {
    const parent = byId.get(cur.parentId!)!
    if (seen.has(parent.id)) break
    out.push(parent.id)
    seen.add(parent.id)
    cur = parent
  }
  return out
}
