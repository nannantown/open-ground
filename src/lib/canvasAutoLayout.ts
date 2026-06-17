// Auto layout (Figma-style) for frames on the project Canvas.
//
// A `frame` element carrying a `layout` (see `FrameLayout` in types.ts) stacks
// its DIRECT children (parentId === frame.id, not hidden, not a comment pin)
// along the main axis ('row' → left→right, 'column' → top→bottom), with `gap`
// px between them, per-side padding inset from the frame's edges, main-axis
// `justify` and cross-axis `align` inside the padded box. Everything stays in
// WORLD coordinates — children's x/y are absolute, never frame-relative —
// matching the rest of the canvas.
//
// Flow order IS the array order (= z / layer order), exactly like Figma.
// Reordering is a gesture-side concern: callers splice the elements array
// (see layoutInsertionIndex) and re-apply; the engine never re-sorts. Files
// saved by the old position-sorting engine are converged on read via
// normalizeLayoutOrder.
//
// Frame sizing follows `primarySizing` / `counterSizing`: 'fixed' (default)
// keeps the stored size and lets children overflow past the frame's edge,
// exactly like a Figma frame with clipping off; 'hug' resizes the frame to
// its content (anchored at x/y — growth goes toward main-end/cross-end). On a
// fixed axis, `fillMain` / `fillCross` children stretch into the leftover
// interior; on a hug axis they keep their natural size (Figma does the same).
//
// Pure geometry, side-effect-free + framework-free (mirrors canvasAlign.ts /
// canvasContainment.ts) so it unit-tests in isolation; callers apply the
// result through the normal elements mutation path.

import type { CanvasElement, FrameLayout } from './types'
import { containmentDepth, descendantIds, rectInside, canContain } from './canvasContainment'
import { elementBounds } from './canvasBounds'

// Default footprints for un-sized elements — keep in sync with the render-time
// constants in src/components/canvas/InfiniteCanvas.tsx (TEXT_W/TEXT_H,
// STICKY_DEFAULT, MOCK_DEFAULT_W/MOCK_DEFAULT_H).
const TEXT_W = 300
const TEXT_H = 44
const STICKY_DEFAULT = 208
const FRAME_DEFAULT_W = 400
const FRAME_DEFAULT_H = 280
const MOCK_DEFAULT_W = 420
const MOCK_DEFAULT_H = 320
const FALLBACK_SIZE = 100

/** The box an element occupies for layout purposes: its explicit
 *  `width`/`height` when present, else the type's default render size (see the
 *  constants above, sourced from InfiniteCanvas.tsx). */
export const elementFootprint = (el: CanvasElement): { w: number; h: number } => {
  if (el.width !== undefined && el.height !== undefined)
    return { w: el.width, h: el.height }
  switch (el.type) {
    case 'text':
      return { w: el.width ?? TEXT_W, h: el.height ?? TEXT_H }
    case 'sticky':
      return { w: el.width ?? STICKY_DEFAULT, h: el.height ?? STICKY_DEFAULT }
    case 'frame':
      return { w: el.width ?? FRAME_DEFAULT_W, h: el.height ?? FRAME_DEFAULT_H }
    case 'mock':
      return { w: el.width ?? MOCK_DEFAULT_W, h: el.height ?? MOCK_DEFAULT_H }
    default:
      return { w: el.width ?? FALLBACK_SIZE, h: el.height ?? FALLBACK_SIZE }
  }
}

/** Per-side padding, with the legacy single `padding` as the fallback for any
 *  side left unset. */
export const resolvedPadding = (
  layout: FrameLayout,
): { top: number; right: number; bottom: number; left: number } => ({
  top: layout.paddingTop ?? layout.padding,
  right: layout.paddingRight ?? layout.padding,
  bottom: layout.paddingBottom ?? layout.padding,
  left: layout.paddingLeft ?? layout.padding,
})

/** The children a layout frame manages, in ARRAY (z) order: direct members
 *  that are visible and not comment pins. Hidden children and comments keep
 *  their free positions and occupy no slot (Figma-style). */
const layoutChildren = (elements: CanvasElement[], frameId: string): CanvasElement[] =>
  elements.filter((e) => e.parentId === frameId && !e.hidden && e.type !== 'comment')

/** True when `el` is a layout frame that HUGS the given world axis. A hug
 *  frame's size on that axis is content-derived, so a parent's fill must not
 *  stretch it there (Figma: hug wins; also keeps the engine idempotent). */
const hugsAxis = (el: CanvasElement, axis: 'x' | 'y'): boolean => {
  if (el.type !== 'frame' || !el.layout) return false
  const primaryIsX = el.layout.mode === 'row'
  const sizing =
    (axis === 'x') === primaryIsX ? el.layout.primarySizing : el.layout.counterSizing
  return sizing === 'hug'
}

/** Re-stack the direct children of every layout-carrying frame in `elements`.
 *
 *  - Children flow in ARRAY ORDER (= z order, like Figma); hidden children and
 *    comment pins are skipped and their positions left untouched. The packed
 *    block starts at main-start padding and is shifted by `justify` ('center' /
 *    'end'); 'space-between' ignores `gap` and spreads the leftover evenly
 *    between consecutive children (one child centres; negative leftover packs
 *    at start = overflow). Cross axis follows `align` inside the padded box.
 *    Positions are rounded to whole px.
 *  - 'hug' sizing (per axis) resizes the FRAME to its content — main: Σ child
 *    sizes + gaps + main padding; cross: max child size + cross padding; no
 *    children: just the padding. The frame's x/y never move (growth goes
 *    toward main-end/cross-end). Hug sizes are computed deepest-first so a hug
 *    frame inside a hug frame converges in ONE apply.
 *  - `fillMain` children share the leftover main-axis interior equally and
 *    `fillCross` children stretch to the cross-axis interior (both floored to
 *    whole px, min 1px) — only while the frame's axis is 'fixed'; on a hug
 *    axis a fill child keeps its natural size. The engine writes the computed
 *    width/height into the result.
 *  - Frames are processed parents-first (ascending `parentId` chain depth), so
 *    a nested layout frame is first MOVED — and, when it fills, RESIZED — by
 *    its parent's layout, then lays out its own children at the moved position
 *    with the new size (working position + size maps).
 *  - When a child frame moves, its whole `parentId` subtree (descendantIds)
 *    rides along rigidly by the same delta — free-form grandchildren are never
 *    left behind.
 *
 *  IDEMPOTENT: applying the result a second time yields the same positions and
 *  sizes. Returns the INPUT ARRAY by reference when nothing moved or resized,
 *  so callers can detect a no-op via identity; otherwise a new array where
 *  only the changed elements are new objects. */
export function applyAutoLayout(elements: CanvasElement[]): CanvasElement[] {
  const byId = new Map(elements.map((e) => [e.id, e]))
  // Parents-first: a nested layout frame must be moved by its parent before it
  // positions its own children.
  const layoutFrames = elements
    .filter((e) => e.type === 'frame' && e.layout)
    .sort((a, b) => containmentDepth(byId, a.id) - containmentDepth(byId, b.id))
  if (layoutFrames.length === 0) return elements

  // Working positions — written as frames are processed, read back so a later
  // (deeper) frame sees where its parent's pass put it and its children.
  const pos = new Map<string, { x: number; y: number }>()
  const posOf = (id: string): { x: number; y: number } => {
    const moved = pos.get(id)
    if (moved) return moved
    const el = byId.get(id)!
    return { x: el.x, y: el.y }
  }
  // Working sizes — per axis, so only engine-computed axes (hug frames, fill
  // children) ever materialise; un-touched axes keep their footprint default.
  const size = new Map<string, { w?: number; h?: number }>()
  const widthOf = (el: CanvasElement): number => size.get(el.id)?.w ?? elementFootprint(el).w
  const heightOf = (el: CanvasElement): number => size.get(el.id)?.h ?? elementFootprint(el).h
  const setSize = (id: string, axis: 'w' | 'h', v: number) =>
    size.set(id, { ...size.get(id), [axis]: v })

  // Pass 1 — hug sizing, DEEPEST-FIRST, so an outer hug frame sums its inner
  // hug frame's already-hugged size and a single apply is a fixed point. On a
  // hug axis fill children count at their natural (working) size.
  for (let i = layoutFrames.length - 1; i >= 0; i--) {
    const frame = layoutFrames[i]
    const layout = frame.layout!
    const row = layout.mode === 'row'
    const pad = resolvedPadding(layout)
    const children = layoutChildren(elements, frame.id)
    const n = children.length
    if (layout.primarySizing === 'hug') {
      const sum = children.reduce((acc, c) => acc + (row ? widthOf(c) : heightOf(c)), 0)
      const main =
        sum + layout.gap * Math.max(0, n - 1) + (row ? pad.left + pad.right : pad.top + pad.bottom)
      setSize(frame.id, row ? 'w' : 'h', Math.round(main))
    }
    if (layout.counterSizing === 'hug') {
      const maxCross = children.reduce(
        (acc, c) => Math.max(acc, row ? heightOf(c) : widthOf(c)),
        0,
      )
      const cross = maxCross + (row ? pad.top + pad.bottom : pad.left + pad.right)
      setSize(frame.id, row ? 'h' : 'w', Math.round(cross))
    }
  }

  // Pass 2 — positions + fill sizes, parents-first.
  for (const frame of layoutFrames) {
    const layout = frame.layout!
    const row = layout.mode === 'row'
    const pad = resolvedPadding(layout)
    const fpos = posOf(frame.id)
    const fMain = row ? widthOf(frame) : heightOf(frame)
    const fCross = row ? heightOf(frame) : widthOf(frame)
    const padMainStart = row ? pad.left : pad.top
    const padMainEnd = row ? pad.right : pad.bottom
    const padCrossStart = row ? pad.top : pad.left
    const padCrossEnd = row ? pad.bottom : pad.right
    // Interiors (padding deducted on both sides); may go negative for a tiny
    // frame — the math still computes, children just overflow.
    const innerMain = fMain - padMainStart - padMainEnd
    const innerCross = fCross - padCrossStart - padCrossEnd
    const mainStart = (row ? fpos.x : fpos.y) + padMainStart
    const crossStart = (row ? fpos.y : fpos.x) + padCrossStart

    const children = layoutChildren(elements, frame.id)
    const n = children.length
    if (n === 0) continue
    const justify = layout.justify ?? 'start'
    const spaceBetween = justify === 'space-between'
    const mainHug = layout.primarySizing === 'hug'
    const crossHug = layout.counterSizing === 'hug'
    const mainAxis: 'x' | 'y' = row ? 'x' : 'y'
    const crossAxis: 'x' | 'y' = row ? 'y' : 'x'

    // Fill applies only while the frame's axis is fixed, and never to a child
    // frame that hugs that same axis itself.
    const fillsMain = (c: CanvasElement) => !mainHug && !!c.fillMain && !hugsAxis(c, mainAxis)
    const fillsCross = (c: CanvasElement) => !crossHug && !!c.fillCross && !hugsAxis(c, crossAxis)
    const gapSum = spaceBetween ? 0 : layout.gap * (n - 1)
    const fillCount = children.filter(fillsMain).length
    let fillMainSize = 0
    if (fillCount > 0) {
      // Equal share of the interior left after fixed children + gaps; fill
      // sizes are recomputed fresh each apply (a fill child's stored size
      // never feeds back), keeping the engine idempotent.
      const fixedSum = children.reduce(
        (acc, c) => (fillsMain(c) ? acc : acc + (row ? widthOf(c) : heightOf(c))),
        0,
      )
      fillMainSize = Math.max(1, Math.floor((innerMain - fixedSum - gapSum) / fillCount))
    }
    const fillCrossSize = Math.max(1, Math.floor(innerCross))
    const mainSizeOf = (c: CanvasElement): number =>
      fillsMain(c) ? fillMainSize : row ? widthOf(c) : heightOf(c)
    const crossSizeOf = (c: CanvasElement): number =>
      fillsCross(c) ? fillCrossSize : row ? heightOf(c) : widthOf(c)

    // Justify: where the packed block starts and what rides between children.
    const contentMain = children.reduce((acc, c) => acc + mainSizeOf(c), 0)
    let cursor = mainStart
    let spacing = layout.gap
    if (spaceBetween) {
      const leftover = innerMain - contentMain
      if (n === 1) {
        cursor += leftover / 2 // a single space-between child centres (Figma)
      } else {
        spacing = Math.max(0, leftover / (n - 1)) // negative → packed at start
      }
    } else {
      const leftover = innerMain - (contentMain + gapSum)
      cursor += justify === 'center' ? leftover / 2 : justify === 'end' ? leftover : 0
    }

    for (const child of children) {
      const main = mainSizeOf(child)
      const cross = crossSizeOf(child)
      const crossPos =
        layout.align === 'center'
          ? crossStart + (innerCross - cross) / 2
          : layout.align === 'end'
            ? crossStart + innerCross - cross
            : crossStart
      const nx = Math.round(row ? cursor : crossPos)
      const ny = Math.round(row ? crossPos : cursor)
      const cur = posOf(child.id)
      const dx = nx - cur.x
      const dy = ny - cur.y
      if (dx !== 0 || dy !== 0) {
        pos.set(child.id, { x: nx, y: ny })
        // Rigid-move the child's whole subtree by the same delta so free-form
        // grandchildren travel with their (possibly layout-)frame.
        descendantIds(elements, child.id).forEach((id) => {
          const p = posOf(id)
          pos.set(id, { x: p.x + dx, y: p.y + dy })
        })
      }
      if (fillsMain(child)) setSize(child.id, row ? 'w' : 'h', main)
      if (fillsCross(child)) setSize(child.id, row ? 'h' : 'w', cross)
      cursor += main + spacing
    }
  }

  // Materialise: new objects only for elements whose position or size actually
  // changed; untouched input array by reference when nothing did.
  let changed = false
  const next = elements.map((el) => {
    const p = pos.get(el.id)
    const s = size.get(el.id)
    const x = p?.x ?? el.x
    const y = p?.y ?? el.y
    const w = s?.w ?? el.width
    const h = s?.h ?? el.height
    if (x === el.x && y === el.y && w === el.width && h === el.height) return el
    changed = true
    const out: CanvasElement = { ...el, x, y }
    if (w !== undefined) out.width = w
    if (h !== undefined) out.height = h
    return out
  })
  return changed ? next : elements
}

/** Re-order each layout frame's direct children IN THE ARRAY to match their
 *  current main-axis positions (stable — ties keep array order), touching only
 *  the index slots that child set already occupies, so the z interleaving with
 *  everything else is preserved. Only the layout-managed children (visible,
 *  non-comment) take part: for a file saved by the position-sorting engine
 *  this makes array order = visual order, so the array-order engine reproduces
 *  the same picture; for a file the v2 engine wrote, positions already follow
 *  array order and this is a no-op (a hidden child parked at a stale position
 *  is never re-shuffled away from where the user filed it in the Layers
 *  panel). IDEMPOTENT; returns the input array by reference when nothing
 *  changed.
 *
 *  Consistency gate: when the stored positions already equal what the engine
 *  produces from the array AS-IS, the file is engine-consistent and is left
 *  untouched — even if positions aren't monotone in array order (overlapping
 *  flow children, e.g. a hand-written negative gap). Without the gate such a
 *  file would re-sort on every load and re-pack differently on the next edit,
 *  flip-flopping forever. Legacy position-sorted files fail the gate exactly
 *  when their array order disagrees with the picture, which is when the sort
 *  is needed. */
export function normalizeLayoutOrder(elements: CanvasElement[]): CanvasElement[] {
  const frames = elements.filter((e) => e.type === 'frame' && e.layout)
  if (frames.length === 0) return elements
  if (applyAutoLayout(elements) === elements) return elements
  const next = [...elements]
  let changed = false
  for (const frame of frames) {
    const row = frame.layout!.mode === 'row'
    // Index slots this frame's managed children occupy (disjoint across
    // frames — an element has one parentId — so frames permute independently).
    const idx: number[] = []
    for (let i = 0; i < next.length; i++) {
      const e = next[i]
      if (e.parentId === frame.id && !e.hidden && e.type !== 'comment') idx.push(i)
    }
    if (idx.length < 2) continue
    const sorted = idx.map((i) => next[i]).sort((a, b) => (row ? a.x - b.x : a.y - b.y))
    sorted.forEach((el, k) => {
      if (next[idx[k]] !== el) {
        next[idx[k]] = el
        changed = true
      }
    })
  }
  return changed ? next : elements
}

/** Where a drop at world `point` inserts among `frameId`'s visible layout
 *  children: an index 0..n INTO THAT CHILD LIST (array order, hidden/comment
 *  excluded), decided by comparing the point against each child's main-axis
 *  midpoint — before the first midpoint → 0, past the last → n. Callers remap
 *  the child-list index to an elements-array splice position. */
export function layoutInsertionIndex(
  elements: CanvasElement[],
  frameId: string,
  point: { x: number; y: number },
): number {
  const frame = elements.find((e) => e.id === frameId)
  const row = frame?.layout?.mode === 'row'
  const children = layoutChildren(elements, frameId)
  const p = row ? point.x : point.y
  for (let i = 0; i < children.length; i++) {
    const c = children[i]
    const foot = elementFootprint(c)
    const mid = row ? c.x + foot.w / 2 : c.y + foot.h / 2
    if (p < mid) return i
  }
  return children.length
}

/** The deepest visible, unlocked LAYOUT frame whose box contains `point` —
 *  pointer-based membership, like Figma: the element under the cursor belongs
 *  to the layout frame the cursor is over, even if its rect overhangs.
 *  `excludeId` removes that element AND its whole subtree from the candidates
 *  (a dragged frame can't join itself or its own descendant). A later (higher
 *  z) frame wins a same-depth tie, matching what the user sees on top. */
export function layoutFrameAt(
  elements: CanvasElement[],
  point: { x: number; y: number },
  excludeId?: string,
  childType?: CanvasElement['type'],
): CanvasElement | null {
  const desc = excludeId ? descendantIds(elements, excludeId) : null
  const byId = new Map(elements.map((e) => [e.id, e]))
  let best: CanvasElement | null = null
  let bestDepth = -1
  for (const f of elements) {
    if (f.type !== 'frame' || !f.layout || f.hidden || f.locked) continue
    if (f.id === excludeId || desc?.has(f.id)) continue
    const b = elementBounds(f)
    if (!b) continue
    if (point.x < b.x || point.x > b.x + b.w || point.y < b.y || point.y > b.y + b.h)
      continue
    const depth = containmentDepth(byId, f.id)
    if (depth >= bestDepth) {
      bestDepth = depth
      best = f
    }
  }
  // Deeper-container veto: when a container INSIDE the frame (a mock/screen
  // design, a plain card frame) sits under the point and can hold this child
  // type, IT owns the drop — flow insertion must not steal from it (Figma
  // targets the deepest insertable container; a text typed onto a mock inside
  // an auto-layout rail stays a mock annotation). Hidden containers can't
  // claim; a deeper LAYOUT frame can't occur here (best is the deepest one).
  if (best && childType) {
    const inside = descendantIds(elements, best.id)
    for (const c of elements) {
      if (!inside.has(c.id)) continue
      if (c.id === excludeId || desc?.has(c.id)) continue
      if (c.hidden || c.type === 'group') continue
      if (!canContain(c.type, childType)) continue
      const b = elementBounds(c)
      if (!b) continue
      if (point.x >= b.x && point.x <= b.x + b.w && point.y >= b.y && point.y <= b.y + b.h)
        return null
    }
  }
  return best
}

/** Splice `child` into `arr` so it lands at flow `slot` among `frameId`'s
 *  visible layout children (array order): before the slot-th managed child, or
 *  appended at the array end past the last (equivalent for flow, frontmost in
 *  z). `arr` must not already contain `child`. */
const spliceAtLayoutSlot = (
  arr: CanvasElement[],
  frameId: string,
  child: CanvasElement,
  slot: number,
): CanvasElement[] => {
  const visible = arr.filter(
    (e) => e.parentId === frameId && !e.hidden && e.type !== 'comment',
  )
  const next = [...arr]
  const anchor = slot < visible.length ? next.indexOf(visible[slot]) : -1
  if (anchor === -1) next.push(child)
  else next.splice(anchor, 0, child)
  return next
}

/** Add a FRESH element (`el` must not be in `elements` yet) the layout-aware
 *  way: when `point` sits on a layout frame, the element joins that frame's
 *  flow — `parentId` set, spliced at the slot under the point (Figma: create /
 *  paste / drop INTO an auto-layout frame inserts into the flow) — otherwise
 *  it is plainly appended, untouched. Callers run the result through
 *  applyAutoLayout to do the actual stacking.
 *
 *  Excluded from flow insertion (plain append, frameId null):
 *  - comment pins — never layout children;
 *  - a frame whose own box CONTAINS the target frame — that reads as wrapping
 *    (the draw-around-content gesture), not as inserting into it. */
export function insertIntoLayoutAtPoint(
  elements: CanvasElement[],
  el: CanvasElement,
  point: { x: number; y: number },
): { elements: CanvasElement[]; frameId: string | null } {
  const append = { elements: [...elements, el], frameId: null }
  if (el.type === 'comment') return append
  const frame = layoutFrameAt(elements, point, el.id, el.type)
  if (!frame) return append
  if (el.type === 'frame') {
    const fb = elementBounds(frame)
    const eb = elementBounds(el)
    if (fb && eb && rectInside(fb, eb)) return append
  }
  const child = { ...el, parentId: frame.id }
  const slot = layoutInsertionIndex(elements, frame.id, point)
  return { elements: spliceAtLayoutSlot(elements, frame.id, child, slot), frameId: frame.id }
}

/** Where a single-element drag currently over `point` would land: the layout
 *  frame under the pointer + the insertion slot among its OTHER children.
 *  Null when the pointer is over no layout frame (or the dragged element
 *  can't take part in a flow). Cheap — runs every pointer-move; callers
 *  rebuild the full preview only when this changes. */
export function layoutDropSlot(
  elements: CanvasElement[],
  draggedId: string,
  point: { x: number; y: number },
): { frameId: string; slot: number } | null {
  const dragged = elements.find((e) => e.id === draggedId)
  if (!dragged || dragged.type === 'comment' || dragged.hidden || dragged.locked)
    return null
  const frame = layoutFrameAt(elements, point, draggedId, dragged.type)
  if (!frame) return null
  const without = elements.filter((e) => e.id !== draggedId)
  return { frameId: frame.id, slot: layoutInsertionIndex(without, frame.id, point) }
}

/** Live drop preview for a single-element drag over a layout frame: where the
 *  release would splice the element, what the canvas should show meanwhile.
 *  Pure — element data is never written; the caller renders `bar` and applies
 *  `shifts` as TRANSIENT css translations, and the existing release path does
 *  the real commit. */
export interface LayoutDropPreview {
  frameId: string
  /** Insertion slot among the frame's visible children (0..n). */
  slot: number
  /** The insertion indicator, perpendicular to the frame's main axis — a
   *  vertical line (`axis:'x'`) at world x `pos` spanning y `from`→`to` for a
   *  row frame, horizontal (`axis:'y'`) for a column. It marks the centre of
   *  the hole the dodging siblings open (= where the element will land); the
   *  span is the frame's padded interior on the cross axis. */
  bar: { axis: 'x' | 'y'; pos: number; from: number; to: number }
  /** Per-element translation for every OTHER element the drop would move —
   *  the dodging siblings and their riding subtrees (the dragged element and
   *  its own subtree are excluded; they follow the pointer). */
  shifts: Map<string, { dx: number; dy: number }>
  /** The frame's outline AFTER the simulated drop, when it differs from the
   *  current one (a hug axis growing to absorb the newcomer) — the caller
   *  draws it as a dashed preview so a bar past the current edge reads as
   *  "the frame will grow here", not as an insertion into empty space. */
  frameBox?: { x: number; y: number; w: number; h: number }
}

/** Compute the drop preview: simulate the release (remove the dragged element,
 *  splice it at the slot under `point` with the frame as parent, apply the
 *  engine) and diff the result against the CURRENT positions. Engine-computed
 *  sizes (a fill child growing, a hug frame resizing) are not previewable by
 *  translation and are left to the real commit. Null when `point` is over no
 *  layout frame. */
export function layoutDropPreview(
  elements: CanvasElement[],
  draggedId: string,
  point: { x: number; y: number },
): LayoutDropPreview | null {
  const at = layoutDropSlot(elements, draggedId, point)
  if (!at) return null
  const dragged = elements.find((e) => e.id === draggedId)!
  const frame = elements.find((e) => e.id === at.frameId)!
  const without = elements.filter((e) => e.id !== draggedId)
  const child =
    dragged.parentId === frame.id ? dragged : { ...dragged, parentId: frame.id }
  const sim = spliceAtLayoutSlot(without, frame.id, child, at.slot)
  const laid = applyAutoLayout(sim)

  const skip = descendantIds(elements, draggedId) // fresh set — safe to extend
  skip.add(draggedId)
  const origin = new Map(elements.map((e) => [e.id, e]))
  const shifts = new Map<string, { dx: number; dy: number }>()
  for (const e of laid) {
    if (skip.has(e.id)) continue
    const o = origin.get(e.id)
    if (!o) continue
    const dx = e.x - o.x
    const dy = e.y - o.y
    if (dx !== 0 || dy !== 0) shifts.set(e.id, { dx, dy })
  }

  const laidFrame = laid.find((e) => e.id === frame.id)!
  const laidDragged = laid.find((e) => e.id === draggedId)!
  const row = frame.layout!.mode === 'row'
  const pad = resolvedPadding(frame.layout!)
  const ff = elementFootprint(laidFrame)
  const df = elementFootprint(laidDragged)
  const a = row ? laidFrame.y + pad.top : laidFrame.x + pad.left
  const b = row ? laidFrame.y + ff.h - pad.bottom : laidFrame.x + ff.w - pad.right
  const cf = elementFootprint(frame)
  const grew =
    laidFrame.x !== frame.x || laidFrame.y !== frame.y || ff.w !== cf.w || ff.h !== cf.h
  return {
    frameId: frame.id,
    slot: at.slot,
    bar: {
      axis: row ? 'x' : 'y',
      pos: row ? laidDragged.x + df.w / 2 : laidDragged.y + df.h / 2,
      from: Math.min(a, b),
      to: Math.max(a, b),
    },
    shifts,
    ...(grew ? { frameBox: { x: laidFrame.x, y: laidFrame.y, w: ff.w, h: ff.h } } : {}),
  }
}

/** applyAutoLayout for a LIVE resize drag (run on every pointer-move so a
 *  layout frame's children re-pack while the box is still moving — Figma).
 *  When the resized element is a layout frame whose HUG axis the user is
 *  actively changing (vs the press-time box `pressBox`), that axis is treated
 *  as fixed for the ENGINE INPUT only — otherwise the engine would snap the
 *  frame straight back to its hug size mid-drag — while the STORED layout
 *  keeps its hug flags: the release path owns the permanent hug→fixed flip.
 *  Reference no-op (returns `elements`) when nothing needs to move, so a
 *  non-layout resize costs nothing. */
export function applyAutoLayoutDuringResize(
  elements: CanvasElement[],
  id: string,
  pressBox: { w: number; h: number },
): CanvasElement[] {
  const el = elements.find((e) => e.id === id)
  if (!el) return elements
  let input = elements
  if (el.type === 'frame' && el.layout) {
    const row = el.layout.mode === 'row'
    const wChanged = (el.width ?? pressBox.w) !== pressBox.w
    const hChanged = (el.height ?? pressBox.h) !== pressBox.h
    const dropPrimary = el.layout.primarySizing === 'hug' && (row ? wChanged : hChanged)
    const dropCounter = el.layout.counterSizing === 'hug' && (row ? hChanged : wChanged)
    if (dropPrimary || dropCounter) {
      const layout = { ...el.layout }
      if (dropPrimary) delete layout.primarySizing
      if (dropCounter) delete layout.counterSizing
      input = elements.map((e) => (e.id === id ? { ...e, layout } : e))
    }
  }
  const laid = applyAutoLayout(input)
  if (laid === input) return elements // nothing moved — keep the caller's array
  if (input === elements) return laid
  // The hug release above was for the engine's eyes only — put the stored
  // layout back so the flip isn't persisted before the release path decides.
  return laid.map((e) => (e.id === id ? { ...e, layout: el.layout } : e))
}

// ── ⇧A / ⌥⇧A — the Figma auto-layout shortcut ────────────────────────────────

/** Knobs a fresh auto layout starts with — the single source for ⇧A and the
 *  inspector's mode toggle (SelectionInspector imports these). The gap/padding
 *  echo the Ground tidy grid's rhythm (TIDY_GAP/TIDY_PAD). */
export const AUTO_LAYOUT_DEFAULTS: Omit<FrameLayout, 'mode'> = {
  gap: 20,
  padding: 24,
  align: 'start',
}

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const boxOf = (el: CanvasElement): Box => ({
  x: el.x,
  y: el.y,
  ...elementFootprint(el),
})

/** Figma's direction heuristic: boxes whose centres spread wider than tall
 *  read as a row, else a column (also the fallback for 0–1 boxes). */
export function inferLayoutMode(boxes: Box[]): FrameLayout['mode'] {
  if (boxes.length < 2) return 'column'
  const xs = boxes.map((b) => b.x + b.w / 2)
  const ys = boxes.map((b) => b.y + b.h / 2)
  const spreadX = Math.max(...xs) - Math.min(...xs)
  const spreadY = Math.max(...ys) - Math.min(...ys)
  return spreadX > spreadY ? 'row' : 'column'
}

/** ⇧A — add auto layout to the selection, Figma-style:
 *  - exactly one PLAIN frame selected → that frame becomes an auto-layout
 *    frame in place (direction inferred from its direct children's spread);
 *  - anything else — loose elements, several frames, or a frame that already
 *    has auto layout — → WRAP the selection in a fresh auto-layout frame
 *    sized to the selection bbox plus padding. Only the selection's top-level
 *    members re-parent onto the new frame (an id whose ancestor is also
 *    selected rides along inside it); the new frame inherits the members'
 *    common parent when they share one.
 *  Comments (pins) and groups (invisible containers) can't take layout and
 *  are dropped from the selection first. Callers pre-filter locked ids and
 *  run the result through applyAutoLayout to do the actual stacking.
 *  Since flow order is array order, the result is passed through
 *  normalizeLayoutOrder — the new layout frame's children flow in their
 *  current visual order, exactly like Figma's ⇧A.
 *  Returns null when nothing in the selection can take auto layout. */
export function addAutoLayout(
  elements: CanvasElement[],
  ids: string[],
  mkId: () => string,
): { elements: CanvasElement[]; selectId: string } | null {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const targets = ids
    .map((id) => byId.get(id))
    .filter(
      (el): el is CanvasElement =>
        !!el && el.type !== 'comment' && el.type !== 'group',
    )
  if (targets.length === 0) return null

  // Single plain frame → enable in place.
  if (targets.length === 1 && targets[0].type === 'frame' && !targets[0].layout) {
    const frame = targets[0]
    const children = elements.filter((e) => e.parentId === frame.id)
    const layout: FrameLayout = {
      mode: inferLayoutMode(children.map(boxOf)),
      ...AUTO_LAYOUT_DEFAULTS,
    }
    return {
      elements: normalizeLayoutOrder(
        elements.map((el) => (el.id === frame.id ? { ...el, layout } : el)),
      ),
      selectId: frame.id,
    }
  }

  // Wrap: only the selection's TOP-LEVEL members re-parent — a target whose
  // ancestor is also a target stays glued to that ancestor.
  const idSet = new Set(targets.map((t) => t.id))
  const tops = targets.filter((t) => {
    for (let p = t.parentId; p; p = byId.get(p)?.parentId) {
      if (idSet.has(p)) return false
    }
    return true
  })
  const boxes = tops.map(boxOf)
  const x1 = Math.min(...boxes.map((b) => b.x))
  const y1 = Math.min(...boxes.map((b) => b.y))
  const x2 = Math.max(...boxes.map((b) => b.x + b.w))
  const y2 = Math.max(...boxes.map((b) => b.y + b.h))
  const pad = AUTO_LAYOUT_DEFAULTS.padding
  const frameId = mkId()
  // The wrapper joins the members' container when they all share one (and it
  // isn't being wrapped itself) — so wrapping inside a frame nests correctly.
  const commonParent =
    tops.every((t) => t.parentId === tops[0].parentId) &&
    tops[0].parentId &&
    !idSet.has(tops[0].parentId)
      ? tops[0].parentId
      : undefined
  const frame: CanvasElement = {
    id: frameId,
    type: 'frame',
    x: Math.round(x1 - pad),
    y: Math.round(y1 - pad),
    width: Math.round(x2 - x1 + pad * 2),
    height: Math.round(y2 - y1 + pad * 2),
    text: '',
    // Figma parity: a wrap-in-auto-layout frame is a GROUPING container, not a
    // drawn artboard, so it ships TRANSPARENT + borderless — the wrapped content
    // shows through and the wrapper only reads as a selection/hover outline.
    // (A frame DRAWN with the frame tool gets an explicit white fill instead;
    // see InfiniteCanvas's draw-commit handler.) Explicit values, because the
    // render fallback for an absent `fill` is the legacy paper wash.
    fill: 'transparent',
    strokeWidth: 0,
    layout: { mode: inferLayoutMode(boxes), ...AUTO_LAYOUT_DEFAULTS },
    ...(commonParent ? { parentId: commonParent } : {}),
  }
  const topIds = new Set(tops.map((t) => t.id))
  const reparented = elements.map((el) =>
    topIds.has(el.id) ? { ...el, parentId: frameId } : el,
  )
  // Insert the wrapper where its first member sat so layer order stays stable
  // (frames paint depth-sorted anyway; this keeps the Layers panel sane).
  const firstIdx = reparented.findIndex((el) => topIds.has(el.id))
  const next = [...reparented]
  next.splice(firstIdx, 0, frame)
  return { elements: normalizeLayoutOrder(next), selectId: frameId }
}

/** ⌥⇧A — strip auto layout from every selected frame that has it. Children
 *  keep their current (already laid out) positions — removing the layout just
 *  stops managing them. Returns null when the selection holds no layout
 *  frame. */
export function removeAutoLayout(
  elements: CanvasElement[],
  ids: string[],
): CanvasElement[] | null {
  const idSet = new Set(ids)
  let hit = false
  const next = elements.map((el) => {
    if (!idSet.has(el.id) || el.type !== 'frame' || !el.layout) return el
    hit = true
    const { layout: _layout, ...rest } = el
    return rest
  })
  return hit ? next : null
}
