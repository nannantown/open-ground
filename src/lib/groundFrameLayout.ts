// Ground frame "tidy" and "fit" geometry — pure, world px, no DOM.
//
// A Ground frame's direct contents are project cards (geometric membership)
// and child elements (persisted parentId, e.g. a nested frame). Both actions
// treat every direct item as ONE box: a nested frame is a box the size of the
// frame, and whatever sits inside it rides along untouched.

export interface LayoutBox {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface FrameGeometry {
  /** Height of the frame's label bar — content starts below it. */
  header: number
  /** Inset from the frame edge (below the header on top). */
  pad: number
  /** Space between neighbouring boxes. */
  gap: number
}

/** Tidy: flow the boxes into rows inside `frame`, in their current reading
 *  order (top-to-bottom, then left-to-right), so each barely moves. A row
 *  wraps when the next box would cross the frame's usable width (never
 *  narrower than the widest box). Rows are as tall as their tallest box, so no
 *  two boxes overlap. Returns each box's new top-left and the frame size the
 *  flow needs; the caller decides whether the frame may grow. */
export function tidyLayout(
  frame: { x: number; y: number; w: number },
  boxes: LayoutBox[],
  g: FrameGeometry,
): { positions: Map<string, { x: number; y: number }>; width: number; height: number } {
  const positions = new Map<string, { x: number; y: number }>()
  if (boxes.length === 0) return { positions, width: 0, height: 0 }

  // Reading order: a box joins the current row while its top is within half
  // the smallest box height of that row's first top; rows sort left-to-right.
  const tol = Math.min(...boxes.map((b) => b.h)) / 2
  const byTop = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  const readRows: LayoutBox[][] = []
  for (const b of byTop) {
    const row = readRows[readRows.length - 1]
    if (row && b.y - row[0].y <= tol) row.push(b)
    else readRows.push([b])
  }
  const ordered = readRows.flatMap((r) => r.sort((a, b) => a.x - b.x))

  const usableW = Math.max(frame.w - g.pad * 2, ...boxes.map((b) => b.w))
  let cx = 0
  let cy = 0
  let rowH = 0
  let maxRight = 0
  for (const b of ordered) {
    if (cx > 0 && cx + b.w > usableW) {
      cy += rowH + g.gap
      cx = 0
      rowH = 0
    }
    positions.set(b.id, { x: frame.x + g.pad + cx, y: frame.y + g.header + g.pad + cy })
    cx += b.w + g.gap
    rowH = Math.max(rowH, b.h)
    maxRight = Math.max(maxRight, cx - g.gap)
  }
  return {
    positions,
    width: g.pad * 2 + maxRight,
    height: g.header + g.pad * 2 + cy + rowH,
  }
}

/** Fit: the frame rectangle that hugs `boxes` with `pad` on every side (the
 *  label bar sits above the top pad). Contents stay where they are — only the
 *  frame moves/resizes, and it may grow as well as shrink. Null when empty. */
export function fitFrameRect(
  boxes: LayoutBox[],
  g: Pick<FrameGeometry, 'header' | 'pad'>,
): { x: number; y: number; w: number; h: number } | null {
  if (boxes.length === 0) return null
  const minX = Math.min(...boxes.map((b) => b.x))
  const minY = Math.min(...boxes.map((b) => b.y))
  const maxX = Math.max(...boxes.map((b) => b.x + b.w))
  const maxY = Math.max(...boxes.map((b) => b.y + b.h))
  return {
    x: minX - g.pad,
    y: minY - g.header - g.pad,
    w: maxX - minX + g.pad * 2,
    h: maxY - minY + g.header + g.pad * 2,
  }
}
