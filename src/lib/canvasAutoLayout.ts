// Auto layout (Figma-style) for frames on the project Canvas.
//
// A `frame` element carrying a `layout` (see `FrameLayout` in types.ts) stacks
// its DIRECT children (parentId === frame.id) along the main axis ('row' →
// left→right, 'column' → top→bottom), with `gap` px between them, `padding` px
// inset from the frame's edges, and cross-axis `align` (start/center/end)
// inside the padded box. Everything stays in WORLD coordinates — children's
// x/y are absolute, never frame-relative — matching the rest of the canvas.
//
// Order is derived from the children's CURRENT main-axis positions (ties keep
// array order), so dragging a child past a sibling and re-running the engine
// snaps it into its new slot — that *is* the reorder gesture.
//
// The frame's own size is never touched (no hug-contents): children that don't
// fit simply overflow past the frame's edge, exactly like a Figma frame with
// clipping off.
//
// Pure geometry, side-effect-free + framework-free (mirrors canvasAlign.ts /
// canvasContainment.ts) so it unit-tests in isolation; callers apply the
// result through the normal elements mutation path.

import type { CanvasElement, FrameLayout } from './types'
import { containmentDepth, descendantIds } from './canvasContainment'

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

/** Re-stack the direct children of every layout-carrying frame in `elements`.
 *
 *  - Children are ordered by their current main-axis coordinate (row → x,
 *    column → y; ties keep array order), then packed from
 *    frame main-start + padding with `gap` between footprints. Cross axis
 *    follows `align` inside the padded frame box. Positions are rounded to
 *    whole px.
 *  - Frames are processed parents-first (ascending `parentId` chain depth), so
 *    a nested layout frame is first MOVED by its parent's layout, then lays
 *    out its own children at the moved position.
 *  - When a child frame moves, its whole `parentId` subtree (descendantIds)
 *    rides along rigidly by the same delta — free-form grandchildren are never
 *    left behind.
 *  - The frame's own size is never changed (no hug); overflow is allowed.
 *
 *  IDEMPOTENT: applying the result a second time yields the same positions
 *  (the main-axis sort of already-stacked children reproduces their order).
 *  Returns the INPUT ARRAY by reference when nothing moved, so callers can
 *  detect a no-op via identity; otherwise a new array where only the moved
 *  elements are new objects. */
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

  for (const frame of layoutFrames) {
    const layout = frame.layout!
    const row = layout.mode === 'row'
    const fpos = posOf(frame.id)
    const fsize = elementFootprint(frame)
    // Cross-axis interior (padding deducted on both sides) the children are
    // aligned within; may go negative for a tiny frame — alignment still
    // computes, the child just overflows.
    const inner = (row ? fsize.h : fsize.w) - layout.padding * 2
    const crossStart = (row ? fpos.y : fpos.x) + layout.padding

    // Direct children, ordered by current main-axis coordinate (stable sort →
    // ties keep array order). Sorting on the LIVE position is what turns a
    // drag-past-a-sibling into a reorder on the next apply.
    const children = elements
      .filter((e) => e.parentId === frame.id)
      .sort((a, b) => (row ? posOf(a.id).x - posOf(b.id).x : posOf(a.id).y - posOf(b.id).y))

    let cursor = (row ? fpos.x : fpos.y) + layout.padding
    for (const child of children) {
      const foot = elementFootprint(child)
      const main = foot[row ? 'w' : 'h']
      const cross = foot[row ? 'h' : 'w']
      const crossPos =
        layout.align === 'center'
          ? crossStart + (inner - cross) / 2
          : layout.align === 'end'
            ? crossStart + inner - cross
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
      cursor += main + layout.gap
    }
  }

  // Materialise: new objects only for elements that actually moved; untouched
  // input array by reference when nothing did.
  let changed = false
  const next = elements.map((el) => {
    const p = pos.get(el.id)
    if (!p || (p.x === el.x && p.y === el.y)) return el
    changed = true
    return { ...el, x: p.x, y: p.y }
  })
  return changed ? next : elements
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
      elements: elements.map((el) => (el.id === frame.id ? { ...el, layout } : el)),
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
  return { elements: next, selectId: frameId }
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
