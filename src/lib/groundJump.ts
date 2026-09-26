// Ground project search + "fly to the card" geometry (owner ask 2026-09-26:
// 「フォルダが多いと探すのが大変。検索したら、そこに画面が移動するように」).
// Pure so the ⌘K palette's matching and App's camera move are testable
// without a DOM. The palette itself is ProjectJumpPalette.tsx.

import type { ProjectMeta } from '@/lib/types'

// Card geometry mirrors lib/layout.ts (CARD_W × CARD_H).
const CARD_W = 256
const CARD_H = 132

/** Below this zoom a card's name is too small to read; a jump zooms in to it. */
export const READABLE_ZOOM = 1

const norm = (s: string) => s.normalize('NFKC').toLowerCase()

// Forgiving subsequence match over the NAME — every char of the query must
// appear in order. Adjacent and prefix matches score better (lower).
const fuzzyScore = (name: string, q: string): number | null => {
  const hay = norm(name)
  const needle = norm(q)
  let hi = 0
  let score = 0
  let lastIdx = -2
  for (const c of needle) {
    const found = hay.indexOf(c, hi)
    if (found < 0) return null
    score += found - hi
    if (found === lastIdx + 1) score -= 4
    if (found === 0) score -= 6
    lastIdx = found
    hi = found + c.length
  }
  return score
}

/** Projects the palette lists for `query`. Name hits (fuzzy) rank above
 *  description hits (plain substring — fuzzy over a sentence matches almost
 *  anything). Empty query: recently opened first, then the scanner's order. */
export const matchProjects = (
  projects: ProjectMeta[],
  query: string,
  recentIds: readonly string[] = [],
  limit = 12,
): ProjectMeta[] => {
  const q = query.trim()
  if (!q) {
    const rank = (p: ProjectMeta) => {
      const i = recentIds.indexOf(p.id)
      return i < 0 ? Infinity : i
    }
    // Array.prototype.sort is stable, so non-recents keep their given order.
    return [...projects].sort((a, b) => rank(a) - rank(b)).slice(0, limit)
  }
  const nq = norm(q)
  const scored: { p: ProjectMeta; s: number }[] = []
  for (const p of projects) {
    const s = fuzzyScore(p.name, q)
    if (s !== null) {
      scored.push({ p, s })
      continue
    }
    const at = p.description ? norm(p.description).indexOf(nq) : -1
    if (at >= 0) scored.push({ p, s: 10_000 + at })
  }
  scored.sort((a, b) => a.s - b.s)
  return scored.slice(0, limit).map((x) => x.p)
}

export interface Viewport {
  x: number
  y: number
  zoom: number
}

/** Where the camera ends after jumping to a card at `pos`: the card centred
 *  on screen, zoomed in to at least READABLE_ZOOM (never zoomed OUT — a user
 *  already closer than that keeps their scale). */
export const jumpViewport = (
  pos: { x: number; y: number },
  screen: { w: number; h: number },
  zoom: number,
): Viewport => {
  const z = Math.max(zoom, READABLE_ZOOM)
  return {
    zoom: z,
    x: screen.w / 2 - (pos.x + CARD_W / 2) * z,
    y: screen.h / 2 - (pos.y + CARD_H / 2) * z,
  }
}

/** Camera at progress t∈[0,1] between two viewports. Interpolates the WORLD
 *  point at screen centre (and zoom geometrically) rather than raw x/y, so the
 *  target stays on a straight path instead of swinging off-screen mid-zoom. */
export const viewportAt = (
  from: Viewport,
  to: Viewport,
  t: number,
  screen: { w: number; h: number },
): Viewport => {
  const cx = screen.w / 2
  const cy = screen.h / 2
  const c0 = { x: (cx - from.x) / from.zoom, y: (cy - from.y) / from.zoom }
  const c1 = { x: (cx - to.x) / to.zoom, y: (cy - to.y) / to.zoom }
  const zoom = from.zoom * Math.pow(to.zoom / from.zoom, t)
  const wx = c0.x + (c1.x - c0.x) * t
  const wy = c0.y + (c1.y - c0.y) * t
  return { zoom, x: cx - wx * zoom, y: cy - wy * zoom }
}

// Recently opened projects (most recent first), per machine.
const RECENT_KEY = 'og.ground.recentProjects'
const RECENT_MAX = 8

export const readRecentProjects = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export const recordRecentProject = (id: string) => {
  try {
    const next = [id, ...readRecentProjects().filter((x) => x !== id)].slice(0, RECENT_MAX)
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* storage unavailable — recents just won't persist */
  }
}
