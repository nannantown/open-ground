// Align & distribute (Figma-parity) for a multi-selection on the Canvas.
//
// Pure geometry: given the selected items' boxes and an operation, return each
// item's NEW top-left position. Align needs ≥2 items; distribute needs ≥3.
// Side-effect-free + framework-free so it unit-tests in isolation (mirrors
// canvasTransform.ts / canvasAlign callers apply the result through the undoable
// patch path).
//
// Two reference modes: alignElements aligns the selection RELATIVE TO ITSELF
// (the group's own bounding edges — needs ≥2 items), while alignElementsToBox
// aligns against an EXTERNAL reference rectangle (typically the parent frame,
// Figma-style) — so a single child can be centred inside its frame, and
// distribute spreads the items across the box's full span instead of between
// the extreme items.

export type AlignOp =
  | 'left'
  | 'hcenter'
  | 'right'
  | 'top'
  | 'vmiddle'
  | 'bottom'
  | 'hdistribute'
  | 'vdistribute'

export interface AlignItem {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface AlignResult {
  id: string
  x: number
  y: number
}

const minBy = (items: AlignItem[], f: (i: AlignItem) => number) =>
  items.reduce((m, i) => Math.min(m, f(i)), Infinity)
const maxBy = (items: AlignItem[], f: (i: AlignItem) => number) =>
  items.reduce((m, i) => Math.max(m, f(i)), -Infinity)

/** Compute new top-left positions for `items` under `op`. Returns one entry per
 *  input item (positions rounded to whole px). Returns [] when there aren't
 *  enough items for the op (align needs ≥2, distribute needs ≥3). The axis the
 *  op doesn't touch is preserved. */
export function alignElements(items: AlignItem[], op: AlignOp): AlignResult[] {
  const need = op === 'hdistribute' || op === 'vdistribute' ? 3 : 2
  if (items.length < need) return []

  const r = (n: number) => Math.round(n)
  const keep = (it: AlignItem): AlignResult => ({ id: it.id, x: r(it.x), y: r(it.y) })

  switch (op) {
    case 'left': {
      const left = minBy(items, (i) => i.x)
      return items.map((it) => ({ id: it.id, x: r(left), y: r(it.y) }))
    }
    case 'right': {
      const right = maxBy(items, (i) => i.x + i.w)
      return items.map((it) => ({ id: it.id, x: r(right - it.w), y: r(it.y) }))
    }
    case 'hcenter': {
      const c = (minBy(items, (i) => i.x) + maxBy(items, (i) => i.x + i.w)) / 2
      return items.map((it) => ({ id: it.id, x: r(c - it.w / 2), y: r(it.y) }))
    }
    case 'top': {
      const top = minBy(items, (i) => i.y)
      return items.map((it) => ({ id: it.id, x: r(it.x), y: r(top) }))
    }
    case 'bottom': {
      const bottom = maxBy(items, (i) => i.y + i.h)
      return items.map((it) => ({ id: it.id, x: r(it.x), y: r(bottom - it.h) }))
    }
    case 'vmiddle': {
      const c = (minBy(items, (i) => i.y) + maxBy(items, (i) => i.y + i.h)) / 2
      return items.map((it) => ({ id: it.id, x: r(it.x), y: r(c - it.h / 2) }))
    }
    case 'hdistribute': {
      // Equal GAPS between left→right edges; the extreme items stay put.
      const sorted = [...items].sort((a, b) => a.x - b.x)
      const span = (sorted[sorted.length - 1].x + sorted[sorted.length - 1].w) - sorted[0].x
      const sumW = sorted.reduce((s, i) => s + i.w, 0)
      const gap = (span - sumW) / (sorted.length - 1)
      const out = new Map<string, AlignResult>()
      let cursor = sorted[0].x
      for (const it of sorted) {
        out.set(it.id, { id: it.id, x: r(cursor), y: r(it.y) })
        cursor += it.w + gap
      }
      return items.map((it) => out.get(it.id) ?? keep(it))
    }
    case 'vdistribute': {
      const sorted = [...items].sort((a, b) => a.y - b.y)
      const span = (sorted[sorted.length - 1].y + sorted[sorted.length - 1].h) - sorted[0].y
      const sumH = sorted.reduce((s, i) => s + i.h, 0)
      const gap = (span - sumH) / (sorted.length - 1)
      const out = new Map<string, AlignResult>()
      let cursor = sorted[0].y
      for (const it of sorted) {
        out.set(it.id, { id: it.id, x: r(it.x), y: r(cursor) })
        cursor += it.h + gap
      }
      return items.map((it) => out.get(it.id) ?? keep(it))
    }
    default:
      return []
  }
}

/** Reference rectangle for alignElementsToBox — typically the parent frame. */
export interface AlignBox {
  x: number
  y: number
  w: number
  h: number
}

/** Compute new top-left positions for `items` aligned against an external
 *  `box` (parent frame) instead of the selection's own bounds. Align ops work
 *  from a SINGLE item (Figma: centre one child in its frame); distribute needs
 *  ≥2 and spreads the items across the box's full span — first item's left on
 *  box.x, last item's right on box.x+box.w, equal gaps between (the gap simply
 *  goes negative when the items don't fit; they still land in order). Same
 *  contract as alignElements otherwise: one entry per input item, positions
 *  rounded to whole px, the untouched axis preserved. */
export function alignElementsToBox(items: AlignItem[], box: AlignBox, op: AlignOp): AlignResult[] {
  const need = op === 'hdistribute' || op === 'vdistribute' ? 2 : 1
  if (items.length < need) return []

  const r = (n: number) => Math.round(n)
  const keep = (it: AlignItem): AlignResult => ({ id: it.id, x: r(it.x), y: r(it.y) })

  switch (op) {
    case 'left':
      return items.map((it) => ({ id: it.id, x: r(box.x), y: r(it.y) }))
    case 'right':
      return items.map((it) => ({ id: it.id, x: r(box.x + box.w - it.w), y: r(it.y) }))
    case 'hcenter': {
      const c = box.x + box.w / 2
      return items.map((it) => ({ id: it.id, x: r(c - it.w / 2), y: r(it.y) }))
    }
    case 'top':
      return items.map((it) => ({ id: it.id, x: r(it.x), y: r(box.y) }))
    case 'bottom':
      return items.map((it) => ({ id: it.id, x: r(it.x), y: r(box.y + box.h - it.h) }))
    case 'vmiddle': {
      const c = box.y + box.h / 2
      return items.map((it) => ({ id: it.id, x: r(it.x), y: r(c - it.h / 2) }))
    }
    case 'hdistribute': {
      // Equal GAPS across the box's full width: first left edge on box.x,
      // last right edge on box.x+box.w.
      const sorted = [...items].sort((a, b) => a.x - b.x)
      const sumW = sorted.reduce((s, i) => s + i.w, 0)
      const gap = (box.w - sumW) / (sorted.length - 1)
      const out = new Map<string, AlignResult>()
      let cursor = box.x
      for (const it of sorted) {
        out.set(it.id, { id: it.id, x: r(cursor), y: r(it.y) })
        cursor += it.w + gap
      }
      return items.map((it) => out.get(it.id) ?? keep(it))
    }
    case 'vdistribute': {
      const sorted = [...items].sort((a, b) => a.y - b.y)
      const sumH = sorted.reduce((s, i) => s + i.h, 0)
      const gap = (box.h - sumH) / (sorted.length - 1)
      const out = new Map<string, AlignResult>()
      let cursor = box.y
      for (const it of sorted) {
        out.set(it.id, { id: it.id, x: r(it.x), y: r(cursor) })
        cursor += it.h + gap
      }
      return items.map((it) => out.get(it.id) ?? keep(it))
    }
    default:
      return []
  }
}
