// Containment / nesting helpers (Figma-style "drag something INTO a container").
//
// A child element may carry a `parentId` pointing at the *container* element it
// lives inside. Membership is decided by RECT CONTAINMENT: an element belongs to
// a container when the element's bounding box sits fully inside the container's
// box. When it's dragged out of every container, the `parentId` is cleared.
//
// Two kinds of container exist:
//   - a `frame` can own ANY non-frame child (the original Slice-1 behaviour);
//   - a `mock` / `screen` ("a design") can own a `text` child — this is the
//     "annotation text on top of a generated design" feature: the label sits on
//     the design and travels with it when the design is dragged.
// `CONTAINER_TYPES` / `canContain` encode that rule in one place.
//
// This is the *persisted* successor to the old runtime centre-point grouping
// (InfiniteCanvas captured "items inside the frame" at drag-start and forgot
// them on drop). Driving membership off `parentId` means:
//   - moving a container moves its children (parentId === container.id) and that
//     persists across a reload;
//   - a child dropped into / out of a container keeps its true membership.
//
// These functions are deliberately geometry-only and side-effect-free so they
// can be unit-tested in isolation, mirroring canvasIntegrity.ts.

import type { CanvasElement } from './types'

/** Element types that may own children via `parentId`. A `frame` groups any
 *  non-frame element; a `mock`/`screen` anchors `text` annotations on top of a
 *  rendered design. */
export const CONTAINER_TYPES: ReadonlySet<CanvasElement['type']> = new Set<
  CanvasElement['type']
>(['frame', 'mock', 'screen'])

/** True when an element of `containerType` is allowed to own a child of
 *  `childType`. Frames own anything that isn't itself a frame; a design
 *  (mock/screen) owns only `text` annotations. */
export const canContain = (
  containerType: CanvasElement['type'],
  childType: CanvasElement['type'],
): boolean => {
  if (containerType === 'frame') return childType !== 'frame'
  if (containerType === 'mock' || containerType === 'screen') return childType === 'text'
  return false
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** True when `child` sits fully inside `parent` (edges may touch). Zero-area
 *  parents (an un-sized frame) never contain anything. */
export const rectInside = (child: Rect, parent: Rect): boolean => {
  if (parent.w <= 0 || parent.h <= 0) return false
  return (
    child.x >= parent.x &&
    child.y >= parent.y &&
    child.x + child.w <= parent.x + parent.w &&
    child.y + child.h <= parent.y + parent.h
  )
}

/** The id of the frame that should own `rect`, or `undefined` when no frame
 *  fully contains it. When several frames contain the rect (nested frames),
 *  the smallest-area frame wins so the most specific container takes the child
 *  — matching how the user perceives "the box I dropped it in". */
export const frameIdContaining = (
  rect: Rect,
  frames: { id: string; rect: Rect }[],
): string | undefined => {
  let best: { id: string; area: number } | undefined
  for (const f of frames) {
    if (!rectInside(rect, f.rect)) continue
    const area = f.rect.w * f.rect.h
    if (!best || area < best.area) best = { id: f.id, area }
  }
  return best?.id
}

/** Decide the membership for a just-moved element.
 *
 *  Returns the frame id the element now belongs to, or `undefined` when it is
 *  outside every frame. `selfId` is excluded from the candidate frames so a
 *  frame can never become its own parent. Callers compare the result against
 *  the element's current `parentId` to know whether a write is needed.
 */
export const resolveParentId = (
  selfId: string,
  rect: Rect,
  frames: { id: string; rect: Rect }[],
): string | undefined => {
  const candidates = frames.filter((f) => f.id !== selfId)
  return frameIdContaining(rect, candidates)
}

/** A candidate container for {@link resolveContainerId}: a frame OR a design
 *  (mock/screen), tagged with its `type` so the parenting rule (`canContain`)
 *  can be applied per child. */
export interface Container {
  id: string
  type: CanvasElement['type']
  rect: Rect
}

/** Decide the membership for a just-moved element, allowing both frames and
 *  designs (mock/screen) as containers.
 *
 *  Returns the container id the element now belongs to, or `undefined` when it
 *  is outside every eligible container. Only containers that (a) aren't `selfId`
 *  and (b) `canContain(childType)` are considered; the smallest such container
 *  wins so the most specific box (e.g. a design dropped inside a frame) takes
 *  the child. This generalises {@link resolveParentId}, which only ever
 *  considered frames.
 */
export const resolveContainerId = (
  selfId: string,
  childType: CanvasElement['type'],
  rect: Rect,
  containers: Container[],
): string | undefined => {
  const eligible = containers.filter(
    (c) => c.id !== selfId && canContain(c.type, childType),
  )
  return frameIdContaining(rect, eligible)
}

/** Return `els` with every `parentId` dropped when it no longer points at a
 *  live, *eligible* container in the same set — i.e. the parent was deleted, is
 *  not a container type (frame/mock/screen), or can't legally own this child
 *  (e.g. a sticky claiming a mock as parent, or a non-text child claiming a
 *  design). A dangling parentId is inert — the child just renders in place — but
 *  it's a stale reference, so we scrub it at the same moments comment anchors are
 *  scrubbed (clearDanglingAnchors). Returns the original array reference
 *  unchanged when nothing was dangling so callers can skip a no-op write. */
export const clearDanglingParents = (
  els: CanvasElement[],
): CanvasElement[] => {
  const containerType = new Map(
    els.filter((e) => CONTAINER_TYPES.has(e.type)).map((e) => [e.id, e.type]),
  )
  let changed = false
  const next = els.map((el) => {
    if (!el.parentId) return el
    const pType = containerType.get(el.parentId)
    if (pType && canContain(pType, el.type)) return el
    changed = true
    const { parentId: _drop, ...rest } = el
    return rest as CanvasElement
  })
  return changed ? next : els
}
