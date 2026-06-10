// Drag-time snapping + alignment guides (Figma-parity).
//
// While one element is dragged, its left/center/right (and top/center/bottom)
// edges snap to the matching edges of the other elements when within a small
// threshold, and a guide line is reported for each snapped axis. Pure geometry
// (no React / DOM) so it unit-tests in isolation; the caller applies `dx`/`dy`
// to the drag and renders `guides`.

export interface SnapBox {
  x: number
  y: number
  w: number
  h: number
}

/** A guide line to draw: a vertical line (`axis:'x'`) at `pos` spanning y from
 *  `from`→`to`, or a horizontal line (`axis:'y'`) at `pos` spanning x. */
export interface SnapGuide {
  axis: 'x' | 'y'
  pos: number
  from: number
  to: number
}

export interface SnapResult {
  dx: number
  dy: number
  guides: SnapGuide[]
}

const EPS = 0.5

// The three snap lines an axis offers: near edge, center, far edge.
const xEdges = (b: SnapBox) => [b.x, b.x + b.w / 2, b.x + b.w]
const yEdges = (b: SnapBox) => [b.y, b.y + b.h / 2, b.y + b.h]

/** Best snap offset for one axis: the closest (moving-edge → target-edge) pair
 *  within `threshold`. Returns the delta to add to the moving box and the target
 *  line it snapped to, or null when nothing is within range. */
function bestSnap(
  movingEdges: number[],
  targets: { edges: number[] }[],
  threshold: number,
): { delta: number; line: number } | null {
  let best: { delta: number; line: number; abs: number } | null = null
  for (const me of movingEdges) {
    for (const t of targets) {
      for (const te of t.edges) {
        const delta = te - me
        const abs = Math.abs(delta)
        if (abs <= threshold && (!best || abs < best.abs)) best = { delta, line: te, abs }
      }
    }
  }
  return best ? { delta: best.delta, line: best.line } : null
}

/** Compute the snap for `moving` against `targets`. `threshold` is in the same
 *  (world) units as the boxes. Snaps X and Y independently; returns the offset
 *  to apply plus one guide line per snapped axis (spanning the aligned boxes). */
export function computeSnap(
  moving: SnapBox,
  targets: SnapBox[],
  threshold: number,
): SnapResult {
  if (!targets.length) return { dx: 0, dy: 0, guides: [] }

  const tx = targets.map((t) => ({ box: t, edges: xEdges(t) }))
  const ty = targets.map((t) => ({ box: t, edges: yEdges(t) }))

  const sx = bestSnap(xEdges(moving), tx, threshold)
  const sy = bestSnap(yEdges(moving), ty, threshold)
  const dx = sx ? sx.delta : 0
  const dy = sy ? sy.delta : 0

  const finalBox: SnapBox = { ...moving, x: moving.x + dx, y: moving.y + dy }
  const guides: SnapGuide[] = []

  if (sx) {
    // Vertical guide at the snapped x, spanning the moving box + every target
    // sharing that x line.
    let from = finalBox.y
    let to = finalBox.y + finalBox.h
    for (const t of targets) {
      if (xEdges(t).some((e) => Math.abs(e - sx.line) < EPS)) {
        from = Math.min(from, t.y)
        to = Math.max(to, t.y + t.h)
      }
    }
    guides.push({ axis: 'x', pos: sx.line, from, to })
  }
  if (sy) {
    let from = finalBox.x
    let to = finalBox.x + finalBox.w
    for (const t of targets) {
      if (yEdges(t).some((e) => Math.abs(e - sy.line) < EPS)) {
        from = Math.min(from, t.x)
        to = Math.max(to, t.x + t.w)
      }
    }
    guides.push({ axis: 'y', pos: sy.line, from, to })
  }

  return { dx, dy, guides }
}
