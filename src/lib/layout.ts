import type { CanvasState, ProjectMeta } from './types'

const CARD_W = 256
const CARD_H = 132
const GAP = 28
const PER_ROW = 4
const ORIGIN_X = 80
const ORIGIN_Y = 80

// Grid-fill: gives every project that lacks a saved position a slot, so new
// folders show up on the canvas without overlapping existing cards.
export const autoLayout = (
  projects: ProjectMeta[],
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

