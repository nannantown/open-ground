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

/** Slack on tidy's fit checks, width and stack height (world px): far below anything visible, far above
 *  float round-off. */
const FIT_EPS = 1e-6

/** Tidy: pack the boxes inside `frame`, in their current reading order
 *  (top-to-bottom, then left-to-right), so each barely moves.
 *
 *  Rows (shelves) with stacking: a box goes to the right along the current
 *  row's top while it fits the usable width. When it doesn't, it stacks under
 *  the row's LAST column if it still fits inside the row's height (so small
 *  cards pile up beside a tall child frame instead of dropping under it);
 *  otherwise it opens a new row. Once a box has stacked, the row takes no more
 *  at its top, so the result reads back in the same order and a second tidy
 *  moves nothing.
 *
 *  Stacking never makes a row taller, so same-size cards come out exactly as
 *  the old row flow (two equal cards + gap never fit in one card's height).
 *  Cards of varying height stay in plain rows too unless one card is taller
 *  than two others plus the gap — then the short ones may stack beside it.
 *  Ceiling: a child frame shorter than two stacked cards gets no stack (the
 *  card drops to the next row). Free skyline / masonry packing was tried and
 *  rejected — with real (varying) card heights it scrambled reading order and
 *  flip-flopped on every press.
 *
 *  The usable width is the frame's (never narrower than the widest box).
 *  Returns each box's new top-left and the frame size that hugs the packing;
 *  no two boxes overlap and neighbours keep at least `g.gap` between them. */
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

  // + FIT_EPS: a frame that hugs its contents (w = pad*2 + right edge) can
  // come back a hair narrower than that edge after the float round trip —
  // world coords are never rounded — and must still fit what it hugs.
  const usableW = Math.max(frame.w - g.pad * 2, ...boxes.map((b) => b.w)) + FIT_EPS
  let maxRight = 0
  let maxBottom = 0
  const place = (b: LayoutBox, x: number, y: number) => {
    positions.set(b.id, { x: frame.x + g.pad + x, y: frame.y + g.header + g.pad + y })
    maxRight = Math.max(maxRight, x + b.w)
    maxBottom = Math.max(maxBottom, y + b.h)
  }
  let rowY = 0 // current row's top
  let rowH = 0 // its tallest box
  let cx = 0 // next free x at the row's top
  let stacked = false // a box was stacked: the row takes no more at its top
  let col = { x: 0, y: 0 } // last column: its left x and next free y (row-relative)
  for (const b of ordered) {
    if (!stacked && (cx === 0 || cx + b.w <= usableW)) {
      place(b, cx, rowY)
      col = { x: cx, y: b.h + g.gap }
      rowH = Math.max(rowH, b.h)
      cx += b.w + g.gap
    } else if (col.y + b.h <= rowH + FIT_EPS && col.x + b.w <= usableW) {
      // + FIT_EPS: rowH may be a child frame's height re-measured from
      // unrounded world coords, a hair short of an exact fit.
      place(b, col.x, rowY + col.y)
      col.y += b.h + g.gap
      cx = Math.max(cx, col.x + b.w + g.gap)
      stacked = true
    } else {
      rowY += rowH + g.gap
      place(b, 0, rowY)
      col = { x: 0, y: b.h + g.gap }
      rowH = b.h
      cx = b.w + g.gap
      stacked = false
    }
  }
  return {
    positions,
    width: g.pad * 2 + maxRight,
    height: g.header + g.pad * 2 + maxBottom,
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
