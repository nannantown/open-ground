import type { CanvasState } from './types'

const CARD_W = 256
const CARD_H = 132
const GAP = 28
const PER_ROW = 4
const ORIGIN_X = 80
const ORIGIN_Y = 80

// Grid-fill: gives every card that lacks a saved position a slot, so new
// folders show up on the canvas without overlapping existing cards. Takes only
// `{ id }` (not full ProjectMeta) so the Ground can lay out owned cards AND
// folder-less shared cards (keyed by collabProjectId) through one call.
export const autoLayout = (
  projects: readonly { id: string }[],
  existing: Record<string, { x: number; y: number }>,
): Record<string, { x: number; y: number }> => {
  const positions = { ...existing }
  const missing = projects.filter((p) => !positions[p.id])
  if (missing.length === 0) return positions
  const placed = Object.keys(positions).filter((id) =>
    projects.some((p) => p.id === id),
  ).length
  missing.forEach((p, i) => {
    const idx = placed + i
    positions[p.id] = {
      x: ORIGIN_X + (idx % PER_ROW) * (CARD_W + GAP),
      y: ORIGIN_Y + Math.floor(idx / PER_ROW) * (CARD_H + GAP),
    }
  })
  return positions
}

// The label of the grouping frame a project card sits inside — a card belongs
// to a frame when its centre falls within the frame bounds (the same test the
// canvas uses to drag a frame's contents). This is the project's "category":
// the panel reads it off the canvas instead of a hand-typed field. Null when
// the card sits in no named frame; when frames overlap, the topmost wins.
export const frameLabelFor = (
  projectId: string,
  canvas: CanvasState,
): string | null => {
  const pos = canvas.positions[projectId]
  if (!pos) return null
  const cx = pos.x + CARD_W / 2
  const cy = pos.y + CARD_H / 2
  let label: string | null = null
  for (const el of canvas.elements) {
    if (el.type !== 'frame') continue
    const fw = el.width ?? 0
    const fh = el.height ?? 0
    const inside = cx >= el.x && cx <= el.x + fw && cy >= el.y && cy <= el.y + fh
    if (inside) {
      const text = el.text.trim()
      if (text) label = text
    }
  }
  return label
}


// Where a freshly created/imported card lands when the user backs out of
// click-to-place (Esc): the grid slot nearest `center` (the card's top-left if
// it sat in the middle of the view) whose box clears every other card by a
// gap. Rings outward on a card-sized grid, so the answer is always on screen
// when the view has room. `occupied` are other cards' top-left corners.
// ponytail: fixed 160px box height — real cards grow with long descriptions;
// measure DOM heights if tall cards start touching.
export const findFreeSpot = (
  occupied: readonly { x: number; y: number }[],
  center: { x: number; y: number },
): { x: number; y: number } => {
  const H = 160
  const stepX = CARD_W + GAP
  const stepY = H + GAP
  const free = (x: number, y: number) =>
    occupied.every((o) => Math.abs(o.x - x) >= stepX || Math.abs(o.y - y) >= stepY)
  for (let r = 0; r < 60; r++) {
    const ring: { x: number; y: number; d: number }[] = []
    for (let i = -r; i <= r; i++)
      for (let j = -r; j <= r; j++)
        if (Math.max(Math.abs(i), Math.abs(j)) === r)
          ring.push({ x: center.x + i * stepX, y: center.y + j * stepY, d: i * i + j * j })
    ring.sort((a, b) => a.d - b.d)
    const hit = ring.find((c) => free(c.x, c.y))
    if (hit) return { x: hit.x, y: hit.y }
  }
  return center
}
