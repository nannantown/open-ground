// Multi-selection group resize (Figma-parity): scale a whole selection from its
// bounding box's top-left anchor. Each element's position is scaled relative to
// the anchor; a resizable element's width/height scale too (text/comment have no
// resizable box, so they only reposition). Pure geometry — the caller computes
// scaleX/scaleY from the bbox handle drag and applies the result through the
// undoable patch path.

export interface GResizeItem {
  id: string
  x: number
  y: number
  w: number
  h: number
  /** Whether this element type carries a resizable width/height (sticky, frame,
   *  mock, shape, image, screen). Text/comment reposition but keep their size. */
  sizable: boolean
}

export interface GResizeUpdate {
  id: string
  x: number
  y: number
  /** Present only for sizable items. */
  w?: number
  h?: number
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The union bounding box of the items (top-left + size), or null when empty. */
export function unionBounds(items: { x: number; y: number; w: number; h: number }[]): Rect | null {
  if (!items.length) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const it of items) {
    minX = Math.min(minX, it.x)
    minY = Math.min(minY, it.y)
    maxX = Math.max(maxX, it.x + it.w)
    maxY = Math.max(maxY, it.y + it.h)
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** Scale every item about `anchor` (the bbox top-left) by `scaleX`/`scaleY`.
 *  Positions always scale; width/height scale only for sizable items. Results
 *  are rounded to whole px. */
export function resizeGroup(
  items: GResizeItem[],
  anchor: { x: number; y: number },
  scaleX: number,
  scaleY: number,
): GResizeUpdate[] {
  const r = Math.round
  return items.map((it) => {
    const x = r(anchor.x + (it.x - anchor.x) * scaleX)
    const y = r(anchor.y + (it.y - anchor.y) * scaleY)
    if (!it.sizable) return { id: it.id, x, y }
    return { id: it.id, x, y, w: Math.max(1, r(it.w * scaleX)), h: Math.max(1, r(it.h * scaleY)) }
  })
}
