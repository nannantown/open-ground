// Pure, dependency-free graph model for the Persona tab's "synapse map" view
// (PersonaGraphView.tsx). Token-zero by design: every edge is a mechanical
// rule over fields already on ManualJudgment (tags / addedAt / correctsId) —
// no LLM, no semantic embedding, so viewing the graph costs nothing.
//
// Edge priority is deliberate: a `corrects` link is an explicit, authored fact
// (the owner said "this replaces that"), so it always wins. A shared `tag` is
// the next-strongest signal — the owner chose the same word twice. `date`
// proximity is the weakest (two notes written the same week may have nothing
// to do with each other), so it is only drawn between a pair that has NO
// stronger edge — otherwise a corpus with real tags/corrections turns into a
// solid grid of same-week lines that drowns out the meaningful ones.
import type { ManualJudgment } from './types'

export type PersonaGraphEdgeKind = 'corrects' | 'tag' | 'date'

export interface PersonaGraphEdge {
  source: string
  target: string
  kind: PersonaGraphEdgeKind
  /** Present only on kind === 'tag' — the shared tag that produced the edge. */
  tag?: string
}

export interface PersonaGraphPosition {
  id: string
  x: number
  y: number
}

// Two notes within this window are "around the same time" — wide enough to
// catch a note and its follow-up written a few days later, narrow enough that
// a corpus spanning months does not collapse into one dense date-cluster.
const DATE_WINDOW_MS = 72 * 60 * 60 * 1000

const pairKey = (a: string, b: string): string => (a < b ? `${a} ${b}` : `${b} ${a}`)

// A hard ceiling on rendered edges. Without one, a corpus with many untagged
// notes written in the same window is quadratic in the WORST case (60
// same-week, tag-less notes → 1770 date edges) — every one of those becomes
// an SVG <line> and a reconciled vnode on every pan. Corrections and tags are
// filled in first (they are the meaningful signal), so a capped corpus loses
// only the weakest edges first.
const MAX_EDGES = 600

export function buildPersonaGraphEdges(judgments: ManualJudgment[]): PersonaGraphEdge[] {
  const byId = new Map(judgments.map((j) => [j.id, j]))
  const edges: PersonaGraphEdge[] = []
  const strongPairs = new Set<string>()

  // 1. Corrections — explicit, always present when both ends exist.
  for (const j of judgments) {
    if (edges.length >= MAX_EDGES) return edges
    if (j.correctsId && byId.has(j.correctsId) && j.correctsId !== j.id) {
      edges.push({ source: j.id, target: j.correctsId, kind: 'corrects' })
      strongPairs.add(pairKey(j.id, j.correctsId))
    }
  }

  // 2. Shared tags — one edge per pair, first shared tag wins (a pair sharing
  // three tags does not need three parallel lines to make the point).
  outerTags: for (let i = 0; i < judgments.length; i++) {
    const a = judgments[i]
    if (!a.tags?.length) continue
    for (let k = i + 1; k < judgments.length; k++) {
      if (edges.length >= MAX_EDGES) break outerTags
      const b = judgments[k]
      if (!b.tags?.length) continue
      const key = pairKey(a.id, b.id)
      if (strongPairs.has(key)) continue
      const shared = a.tags.find((tag) => b.tags?.includes(tag))
      if (shared) {
        edges.push({ source: a.id, target: b.id, kind: 'tag', tag: shared })
        strongPairs.add(key)
      }
    }
  }

  // 3. Date proximity — only where nothing stronger already links the pair.
  outerDate: for (let i = 0; i < judgments.length; i++) {
    const a = judgments[i]
    const at = Date.parse(a.addedAt)
    if (Number.isNaN(at)) continue
    for (let k = i + 1; k < judgments.length; k++) {
      if (edges.length >= MAX_EDGES) break outerDate
      const b = judgments[k]
      const key = pairKey(a.id, b.id)
      if (strongPairs.has(key)) continue
      const bt = Date.parse(b.addedAt)
      if (Number.isNaN(bt)) continue
      if (Math.abs(at - bt) <= DATE_WINDOW_MS) {
        edges.push({ source: a.id, target: b.id, kind: 'date' })
        strongPairs.add(key)
      }
    }
  }

  return edges
}

// Deterministic force-directed layout: initial positions on a circle (so
// nodes never start stacked on top of one another — no randomness needed),
// then a fixed number of spring/repulsion passes. Same input always produces
// the same output, which keeps this testable and keeps re-renders from
// re-shuffling the map under the owner's cursor.
const ITERATIONS = 140
const REPULSION = 2600
const SPRING_LENGTH = 120
const SPRING_STRENGTH = 0.02
const CENTER_PULL = 0.01

export function layoutPersonaGraph(
  nodes: Array<{ id: string }>,
  edges: PersonaGraphEdge[],
  width = 800,
  height = 600,
): PersonaGraphPosition[] {
  const cx = width / 2
  const cy = height / 2
  if (nodes.length === 0) return []
  if (nodes.length === 1) return [{ id: nodes[0].id, x: cx, y: cy }]

  const radius = Math.min(width, height) * 0.32
  const pos = new Map<string, { x: number; y: number }>()
  nodes.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / nodes.length
    pos.set(n.id, { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
  })

  const ids = nodes.map((n) => n.id)
  const edgeList = edges.filter((e) => pos.has(e.source) && pos.has(e.target))

  for (let iter = 0; iter < ITERATIONS; iter++) {
    const force = new Map<string, { fx: number; fy: number }>()
    for (const id of ids) force.set(id, { fx: 0, fy: 0 })

    // Repulsion — every pair pushes apart (small N in practice, so O(n^2) is fine).
    for (let i = 0; i < ids.length; i++) {
      const a = pos.get(ids[i])!
      for (let k = i + 1; k < ids.length; k++) {
        const b = pos.get(ids[k])!
        let dx = a.x - b.x
        let dy = a.y - b.y
        let distSq = dx * dx + dy * dy
        if (distSq < 1) {
          distSq = 1
          dx = 1
          dy = 0
        }
        const dist = Math.sqrt(distSq)
        const rep = REPULSION / distSq
        const fx = (dx / dist) * rep
        const fy = (dy / dist) * rep
        const fa = force.get(ids[i])!
        const fb = force.get(ids[k])!
        fa.fx += fx
        fa.fy += fy
        fb.fx -= fx
        fb.fy -= fy
      }
    }

    // Springs — connected nodes pull toward SPRING_LENGTH apart.
    for (const e of edgeList) {
      const a = pos.get(e.source)!
      const b = pos.get(e.target)!
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1)
      const stretch = dist - SPRING_LENGTH
      const fx = (dx / dist) * stretch * SPRING_STRENGTH
      const fy = (dy / dist) * stretch * SPRING_STRENGTH
      const fa = force.get(e.source)!
      const fb = force.get(e.target)!
      fa.fx += fx
      fa.fy += fy
      fb.fx -= fx
      fb.fy -= fy
    }

    // Gentle centering pull so the whole map does not drift off-canvas.
    for (const id of ids) {
      const p = pos.get(id)!
      const f = force.get(id)!
      f.fx += (cx - p.x) * CENTER_PULL
      f.fy += (cy - p.y) * CENTER_PULL
    }

    for (const id of ids) {
      const p = pos.get(id)!
      const f = force.get(id)!
      p.x += f.fx
      p.y += f.fy
    }
  }

  return ids.map((id) => ({ id, ...pos.get(id)! }))
}

// --- Screen (CSS px) ↔ SVG user-space math ---------------------------------
//
// The <svg> is sized by CSS (100% of a fixed-height container) but its
// content lives in a fixed `viewBox="0 0 layoutWidth layoutHeight"` coordinate
// system, and the browser's own (implicit, preserveAspectRatio="xMidYMid
// meet" by default) scale-and-letterbox transform sits BETWEEN the two. A
// pan/zoom `translate(x y) scale(zoom)` applied to a <g> inside that SVG
// operates in the viewBox's user units, NOT in CSS pixels — so every
// pointer/wheel coordinate (which arrives in CSS px) must be converted
// through that same scale+letterbox before it is used as a delta or an
// anchor point, or the point under the cursor drifts as soon as the
// container's rendered size differs from the viewBox's aspect ratio (it
// always does here: a fluid-width, fixed-height container against a fixed
// viewBox almost never matches exactly).
export interface ScreenRect {
  left: number
  top: number
  width: number
  height: number
}

export interface ViewBoxScale {
  /** CSS px per one user unit. */
  scale: number
  /** Letterbox padding (CSS px) each axis carries beyond the scaled content. */
  offsetX: number
  offsetY: number
}

export function computeViewBoxScale(
  rect: ScreenRect,
  layoutWidth: number,
  layoutHeight: number,
): ViewBoxScale {
  const scale = rect.width > 0 && rect.height > 0
    ? Math.min(rect.width / layoutWidth, rect.height / layoutHeight)
    : 1
  return {
    scale,
    offsetX: (rect.width - layoutWidth * scale) / 2,
    offsetY: (rect.height - layoutHeight * scale) / 2,
  }
}

/** A CSS-px point relative to the container → the same point in SVG user units. */
export function screenPointToUserSpace(
  clientX: number,
  clientY: number,
  rect: ScreenRect,
  layoutWidth: number,
  layoutHeight: number,
): { x: number; y: number } {
  const { scale, offsetX, offsetY } = computeViewBoxScale(rect, layoutWidth, layoutHeight)
  return { x: (clientX - rect.left - offsetX) / scale, y: (clientY - rect.top - offsetY) / scale }
}

/** A CSS-px delta (e.g. a drag or wheel delta) → the same delta in user units. */
export function screenDeltaToUserSpace(
  dx: number,
  dy: number,
  rect: ScreenRect,
  layoutWidth: number,
  layoutHeight: number,
): { dx: number; dy: number } {
  const { scale } = computeViewBoxScale(rect, layoutWidth, layoutHeight)
  return { dx: dx / scale, dy: dy / scale }
}
