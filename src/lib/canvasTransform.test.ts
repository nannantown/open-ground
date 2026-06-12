import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import {
  clampOpacity,
  opacityFromPercent,
  resolveOpacity,
  clampCornerRadius,
  resolveFrameCornerRadius,
  clampRadiusToBox,
  clampWidth,
  clampHeight,
  lockAspectRatio,
  resizeRotatedBR,
  rotatedCornerBR,
  normalizeRotation,
  handlePoints,
  hitHandle,
  hitRotateZone,
  pointInRotatedBox,
  resizeFromHandle,
  resizeAnchor,
  cursorForHandle,
  RESIZE_HANDLES,
  CORNER_HANDLES,
  HANDLE_CORNER_PX,
  HANDLE_EDGE_PX,
  ROTATE_ZONE_PX,
  DEFAULT_OPACITY,
  DEFAULT_FRAME_CORNER_RADIUS,
  MIN_CORNER_RADIUS,
  MAX_CORNER_RADIUS,
  RESIZE_MIN_W,
  RESIZE_MIN_H,
  RESIZE_MAX,
  type ResizeHandle,
  type Box,
} from './canvasTransform'
import { rotateCursor } from './canvasCursors'

const frame = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 'f1',
  type: 'frame',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

const sticky = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 's1',
  type: 'sticky',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

describe('clampOpacity', () => {
  it('keeps in-band values, rounded to 2dp', () => {
    expect(clampOpacity(0.5)).toBe(0.5)
    expect(clampOpacity(0.337)).toBe(0.34)
  })
  it('clamps below 0 and above 1', () => {
    expect(clampOpacity(-0.2)).toBe(0)
    expect(clampOpacity(1.5)).toBe(1)
  })
  it('falls back to fully opaque on non-finite input', () => {
    expect(clampOpacity(NaN)).toBe(DEFAULT_OPACITY)
    expect(clampOpacity(Infinity)).toBe(DEFAULT_OPACITY)
  })
})

describe('opacityFromPercent', () => {
  it('maps 0..100% to 0..1', () => {
    expect(opacityFromPercent(0)).toBe(0)
    expect(opacityFromPercent(50)).toBe(0.5)
    expect(opacityFromPercent(100)).toBe(1)
  })
  it('clamps out-of-range percent', () => {
    expect(opacityFromPercent(150)).toBe(1)
    expect(opacityFromPercent(-30)).toBe(0)
  })
  it('falls back to opaque on a cleared (NaN) field', () => {
    expect(opacityFromPercent(NaN)).toBe(DEFAULT_OPACITY)
  })
})

describe('resolveOpacity', () => {
  it('defaults a legacy element with no opacity to fully opaque', () => {
    expect(resolveOpacity(sticky())).toBe(DEFAULT_OPACITY)
  })
  it('uses (and clamps) the stored field', () => {
    expect(resolveOpacity(sticky({ opacity: 0.4 }))).toBe(0.4)
    expect(resolveOpacity(sticky({ opacity: 2 }))).toBe(1)
  })
})

describe('clampCornerRadius', () => {
  it('rounds and keeps in-band values', () => {
    expect(clampCornerRadius(8.6)).toBe(9)
    expect(clampCornerRadius(0)).toBe(MIN_CORNER_RADIUS)
  })
  it('clamps above the ceiling and below the floor', () => {
    expect(clampCornerRadius(9999)).toBe(MAX_CORNER_RADIUS)
    expect(clampCornerRadius(-10)).toBe(MIN_CORNER_RADIUS)
  })
  it('falls back to the default frame radius on non-finite input', () => {
    expect(clampCornerRadius(NaN)).toBe(DEFAULT_FRAME_CORNER_RADIUS)
  })
})

describe('resolveFrameCornerRadius', () => {
  it('defaults a legacy frame to the historical 4px', () => {
    expect(resolveFrameCornerRadius(frame())).toBe(DEFAULT_FRAME_CORNER_RADIUS)
  })
  it('uses (and clamps) the stored field', () => {
    expect(resolveFrameCornerRadius(frame({ cornerRadius: 16 }))).toBe(16)
    expect(resolveFrameCornerRadius(frame({ cornerRadius: 99999 }))).toBe(MAX_CORNER_RADIUS)
  })
})

describe('clampRadiusToBox', () => {
  it('caps a radius at half the smaller side', () => {
    expect(clampRadiusToBox(100, 200, 80)).toBe(40) // half of 80
    expect(clampRadiusToBox(100, 60, 400)).toBe(30) // half of 60
  })
  it('leaves a small radius untouched', () => {
    expect(clampRadiusToBox(4, 400, 280)).toBe(4)
  })
  it('never goes negative for a degenerate box', () => {
    expect(clampRadiusToBox(10, 0, 0)).toBe(0)
  })
})

describe('clampWidth / clampHeight', () => {
  it('keeps in-band values, rounded', () => {
    expect(clampWidth(320.7, 208)).toBe(321)
    expect(clampHeight(150.2, 208)).toBe(150)
  })
  it('enforces the per-axis floor', () => {
    expect(clampWidth(10, 208)).toBe(RESIZE_MIN_W)
    expect(clampHeight(10, 208)).toBe(RESIZE_MIN_H)
  })
  it('enforces the ceiling', () => {
    expect(clampWidth(99999, 208)).toBe(RESIZE_MAX)
    expect(clampHeight(99999, 208)).toBe(RESIZE_MAX)
  })
  it('falls back to the current size on a cleared (NaN) field', () => {
    expect(clampWidth(NaN, 208)).toBe(208)
    expect(clampHeight(NaN, 333)).toBe(333)
  })
})

describe('lockAspectRatio', () => {
  it('drives by width when the horizontal drag dominates proportionally', () => {
    // 2:1 box. Candidate scales width ×2 (200→400) but height only ×1.1
    // (100→110), so width wins and height is derived: 400 / 2 = 200.
    const r = lockAspectRatio(400, 110, 200, 100)
    expect(r.width).toBe(400)
    expect(r.height).toBe(200)
  })
  it('drives by height when the vertical drag dominates proportionally', () => {
    // 2:1 box. Candidate scales height ×4 (100→400) but width only ×1.05
    // (200→210), so height wins and width is derived: 400 × 2 = 800.
    const r = lockAspectRatio(210, 400, 200, 100)
    expect(r.height).toBe(400)
    expect(r.width).toBe(800)
  })
  it('preserves a square ratio', () => {
    const r = lockAspectRatio(300, 260, 200, 200)
    expect(r.width).toBe(300)
    expect(r.height).toBe(300)
  })
  it('is a no-op for a degenerate original size', () => {
    const r = lockAspectRatio(100, 50, 0, 0)
    expect(r).toEqual({ width: 100, height: 50 })
  })
})

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

describe('normalizeRotation', () => {
  it('maps equivalent angles into [-180, 180) and 0/360 → 0', () => {
    expect(normalizeRotation(0)).toBe(0)
    expect(normalizeRotation(360)).toBe(0)
    expect(normalizeRotation(270)).toBe(-90)
    expect(normalizeRotation(-90)).toBe(-90)
    expect(normalizeRotation(450)).toBe(90)
    // 180 and -180 are the same visual angle → canonicalised to -180.
    expect(normalizeRotation(180)).toBe(-180)
    expect(normalizeRotation(-180)).toBe(-180)
  })
  it('returns 0 for NaN / non-finite (cleared field never persists NaN)', () => {
    expect(normalizeRotation(NaN)).toBe(0)
    expect(normalizeRotation(Infinity)).toBe(0)
  })
})

describe('rotatedCornerBR', () => {
  it('returns the plain bottom-right corner when unrotated', () => {
    expect(rotatedCornerBR({ x: 10, y: 20, w: 100, h: 40 }, 0)).toEqual({ x: 110, y: 60 })
  })
  it('rotates the corner about the centre', () => {
    // Square centred at origin, rotated 90°: BR (100,100) → (-100,100).
    const c = rotatedCornerBR({ x: -100, y: -100, w: 200, h: 200 }, 90)
    expect(near(c.x, -100)).toBe(true)
    expect(near(c.y, 100)).toBe(true)
  })
})

describe('resizeRotatedBR', () => {
  const opts = { minW: 0, minH: 0 }
  it('reduces to top-left-anchored resize when unrotated', () => {
    const r = resizeRotatedBR({ x: 10, y: 20, w: 100, h: 40 }, 0, { x: 160, y: 120 }, opts)
    expect(near(r.x, 10)).toBe(true)
    expect(near(r.y, 20)).toBe(true)
    expect(near(r.w, 150)).toBe(true)
    expect(near(r.h, 100)).toBe(true)
  })

  it('keeps the anchored (top-left) corner fixed in world space when rotated', () => {
    const box = { x: 0, y: 0, w: 100, h: 100 }
    const deg = 30
    const before = rotatedTL(box, deg)
    const r = resizeRotatedBR(box, deg, { x: 50, y: 200 }, opts)
    const after = rotatedTL(r, deg)
    expect(near(after.x, before.x, 1e-6)).toBe(true)
    expect(near(after.y, before.y, 1e-6)).toBe(true)
  })

  it('measures the new size along the box local axes', () => {
    // 90°-rotated unit-ish box: dragging the corner in world maps onto local
    // axes. Anchor stays put and w/h come out positive.
    const r = resizeRotatedBR({ x: 0, y: 0, w: 100, h: 100 }, 90, { x: -60, y: 140 }, opts)
    expect(r.w).toBeGreaterThan(0)
    expect(r.h).toBeGreaterThan(0)
  })

  it('honours the min floors', () => {
    const r = resizeRotatedBR({ x: 0, y: 0, w: 100, h: 100 }, 0, { x: 1, y: 1 }, {
      minW: 130,
      minH: 96,
    })
    expect(r.w).toBe(130)
    expect(r.h).toBe(96)
  })

  it('preserves the locked ratio even when a floor kicks in', () => {
    // 10:1 box (1000×100). Shrink hard so the locked height would fall below the
    // 96 floor; both axes must scale together so the 10:1 ratio is preserved.
    const r = resizeRotatedBR({ x: 0, y: 0, w: 1000, h: 100 }, 0, { x: 50, y: 5 }, {
      minW: 0,
      minH: 96,
      lockAspect: true,
    })
    expect(r.h).toBeGreaterThanOrEqual(96)
    expect(near(r.w / r.h, 10, 1e-3)).toBe(true)
  })
})

// The anchored corner = top-left local corner in world space (mirror of the
// helper's internal math), used to assert it doesn't drift.
function rotatedTL(box: { x: number; y: number; w: number; h: number }, deg: number) {
  const r = (deg * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  return {
    x: cx + cos * (-box.w / 2) - sin * (-box.h / 2),
    y: cy + sin * (-box.w / 2) + cos * (-box.h / 2),
  }
}

// ── 8-handle selection chrome ──

const ROTS = [0, 30, 45, 90, -90, 180]
const ZOOMS = [0.5, 1, 2]
const OPPOSITE: Record<ResizeHandle, ResizeHandle> = {
  tl: 'br',
  tr: 'bl',
  br: 'tl',
  bl: 'tr',
  t: 'b',
  r: 'l',
  b: 't',
  l: 'r',
}

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })

// A point `d` world px from `from` along the outward (from-centre) direction.
const outward = (b: Box, from: { x: number; y: number }, d: number) => {
  const c = center(b)
  const len = Math.hypot(from.x - c.x, from.y - c.y)
  return { x: from.x + ((from.x - c.x) / len) * d, y: from.y + ((from.y - c.y) / len) * d }
}

describe('handlePoints', () => {
  it('places the 8 handles on the unrotated box', () => {
    const pts = handlePoints({ x: 10, y: 20, w: 100, h: 40 }, 0)
    expect(pts.tl).toEqual({ x: 10, y: 20 })
    expect(pts.tr).toEqual({ x: 110, y: 20 })
    expect(pts.br).toEqual({ x: 110, y: 60 })
    expect(pts.bl).toEqual({ x: 10, y: 60 })
    expect(pts.t).toEqual({ x: 60, y: 20 })
    expect(pts.r).toEqual({ x: 110, y: 40 })
    expect(pts.b).toEqual({ x: 60, y: 60 })
    expect(pts.l).toEqual({ x: 10, y: 40 })
  })
  it('rotates every handle about the centre (90°: tl lands where tr was)', () => {
    const box = { x: -50, y: -50, w: 100, h: 100 }
    const p0 = handlePoints(box, 0)
    const p90 = handlePoints(box, 90)
    for (const [from, to] of [
      ['tl', 'tr'],
      ['tr', 'br'],
      ['br', 'bl'],
      ['bl', 'tl'],
      ['t', 'r'],
      ['r', 'b'],
      ['b', 'l'],
      ['l', 't'],
    ] as const) {
      expect(near(p90[from].x, p0[to].x)).toBe(true)
      expect(near(p90[from].y, p0[to].y)).toBe(true)
    }
  })
  it('matches rotatedCornerBR for the br corner at any angle', () => {
    const box = { x: 7, y: -3, w: 120, h: 80 }
    for (const deg of ROTS) {
      const c = rotatedCornerBR(box, deg)
      const p = handlePoints(box, deg).br
      expect(near(p.x, c.x)).toBe(true)
      expect(near(p.y, c.y)).toBe(true)
    }
  })
  it('keeps every handle equidistant from the centre across rotation', () => {
    const box = { x: 0, y: 0, w: 80, h: 60 }
    const c = center(box)
    const d0 = RESIZE_HANDLES.map((h) => {
      const p = handlePoints(box, 0)[h]
      return Math.hypot(p.x - c.x, p.y - c.y)
    })
    for (const deg of [30, 45, 180]) {
      const pts = handlePoints(box, deg)
      RESIZE_HANDLES.forEach((h, i) => {
        const p = pts[h]
        expect(near(Math.hypot(p.x - c.x, p.y - c.y), d0[i])).toBe(true)
      })
    }
  })
})

describe('hitHandle', () => {
  const box = { x: 40, y: -20, w: 120, h: 80 }
  it('hits each corner within the radius at every rotation × zoom', () => {
    for (const deg of ROTS) {
      const pts = handlePoints(box, deg)
      for (const zoom of ZOOMS) {
        for (const h of CORNER_HANDLES) {
          const p = outward(box, pts[h], 3 / zoom)
          expect(hitHandle(box, deg, p, zoom)).toBe(h)
        }
      }
    }
  })
  it('misses a corner just past the radius (outward diagonal → no edge band)', () => {
    for (const deg of ROTS) {
      const pts = handlePoints(box, deg)
      for (const zoom of ZOOMS) {
        for (const h of CORNER_HANDLES) {
          const p = outward(box, pts[h], (HANDLE_CORNER_PX + 1) / zoom)
          expect(hitHandle(box, deg, p, zoom)).toBeNull()
        }
      }
    }
  })
  it('hits each edge band on both sides of the edge at every rotation × zoom', () => {
    for (const deg of ROTS) {
      const pts = handlePoints(box, deg)
      for (const zoom of ZOOMS) {
        for (const h of ['t', 'r', 'b', 'l'] as const) {
          const just = (HANDLE_EDGE_PX - 1) / zoom
          expect(hitHandle(box, deg, outward(box, pts[h], just), zoom)).toBe(h)
          expect(hitHandle(box, deg, outward(box, pts[h], -just), zoom)).toBe(h)
        }
      }
    }
  })
  it('misses the edge band beyond ±HANDLE_EDGE_PX', () => {
    for (const zoom of ZOOMS) {
      const pts = handlePoints(box, 0)
      expect(hitHandle(box, 0, outward(box, pts.t, (HANDLE_EDGE_PX + 1) / zoom), zoom)).toBeNull()
    }
  })
  it('does not extend the edge band past the box span', () => {
    // On the top edge LINE but 20px past the tr corner — outside the span.
    expect(hitHandle(box, 0, { x: box.x + box.w + 20, y: box.y }, 1)).toBeNull()
  })
  it('prefers the corner where corner radius and edge band overlap', () => {
    // 5px from the br corner along the bottom edge: inside the b band AND the
    // corner radius — the corner wins.
    expect(hitHandle(box, 0, { x: box.x + box.w - 5, y: box.y + box.h }, 1)).toBe('br')
  })
  it('scales the hit radius with zoom (screen-px semantics)', () => {
    const p = { x: box.x + box.w + 10, y: box.y + box.h } // 10 world px off br
    expect(hitHandle(box, 0, p, 1)).toBeNull() // 10 screen px > 7
    expect(hitHandle(box, 0, p, 0.5)).toBe('br') // 5 screen px ≤ 7
    expect(hitHandle(box, 0, p, 2)).toBeNull() // 20 screen px
  })
})

describe('pointInRotatedBox', () => {
  const box = { x: 0, y: 0, w: 100, h: 40 }
  it('matches the axis-aligned rect when unrotated (border inclusive)', () => {
    expect(pointInRotatedBox(box, 0, { x: 50, y: 20 })).toBe(true)
    expect(pointInRotatedBox(box, 0, { x: 0, y: 0 })).toBe(true)
    expect(pointInRotatedBox(box, 0, { x: 100, y: 40 })).toBe(true)
    expect(pointInRotatedBox(box, 0, { x: 101, y: 20 })).toBe(false)
    expect(pointInRotatedBox(box, 0, { x: 50, y: -1 })).toBe(false)
  })
  it('tracks the rotated rect, not its AABB', () => {
    // 90°-rotated 100×40 box: the visual rect is 40 wide × 100 tall about the
    // centre (50,20). The old corner (0,0) is now OUTSIDE; (50,65) is inside.
    expect(pointInRotatedBox(box, 90, { x: 0, y: 0 })).toBe(false)
    expect(pointInRotatedBox(box, 90, { x: 50, y: 65 })).toBe(true)
    expect(pointInRotatedBox(box, 90, { x: 75, y: 20 })).toBe(false)
  })
})

describe('hitRotateZone', () => {
  const box = { x: 40, y: -20, w: 120, h: 80 }
  it('hits the annulus outside each corner at every rotation × zoom', () => {
    for (const deg of ROTS) {
      const pts = handlePoints(box, deg)
      for (const zoom of ZOOMS) {
        for (const h of CORNER_HANDLES) {
          const p = outward(box, pts[h], 16 / zoom)
          expect(hitRotateZone(box, deg, p, zoom)).toBe(h)
        }
      }
    }
  })
  it('honours the exact (7, 26] screen-px band', () => {
    // Axis-aligned offsets so the distances are fp-exact.
    const br = { x: box.x + box.w, y: box.y + box.h }
    const at = (d: number) => ({ x: br.x + d, y: br.y })
    expect(hitRotateZone(box, 0, at(HANDLE_CORNER_PX), 1)).toBeNull() // 7 — handle side, exclusive
    expect(hitRotateZone(box, 0, at(HANDLE_CORNER_PX + 1), 1)).toBe('br')
    expect(hitRotateZone(box, 0, at(ROTATE_ZONE_PX), 1)).toBe('br') // 26 — inclusive
    expect(hitRotateZone(box, 0, at(ROTATE_ZONE_PX + 1), 1)).toBeNull()
  })
  it('scales with zoom (world distance × zoom = screen px)', () => {
    const br = { x: box.x + box.w, y: box.y + box.h }
    // 13 world px = 26 screen px at zoom 2 (in) but 6.5 at zoom 0.5 (handle side).
    expect(hitRotateZone(box, 0, { x: br.x + 13, y: br.y }, 2)).toBe('br')
    expect(hitRotateZone(box, 0, { x: br.x + 13.5, y: br.y }, 2)).toBeNull()
    expect(hitRotateZone(box, 0, { x: br.x + 13, y: br.y }, 0.5)).toBeNull()
  })
  it('never hits over a resize handle', () => {
    const pts = handlePoints(box, 30)
    // 3px off the corner is inside the corner handle → zone must yield.
    expect(hitRotateZone(box, 30, outward(box, pts.br, 3), 1)).toBeNull()
    // 10px outside an edge midpoint is past the band but nowhere near a corner.
    expect(hitRotateZone(box, 30, outward(box, pts.t, 10), 1)).toBeNull()
  })
  it('never hits inside the rotated rect (body clicks keep moving the element)', () => {
    // 10px inside the br corner along the inward diagonal: within 26px of the
    // corner but inside the rect → null at any rotation.
    for (const deg of ROTS) {
      const pts = handlePoints(box, deg)
      const p = outward(box, pts.br, -10)
      expect(hitRotateZone(box, deg, p, 1)).toBeNull()
    }
  })
})

describe('resizeFromHandle', () => {
  const o = { minW: 0, minH: 0 }
  const box = { x: 10, y: 20, w: 100, h: 40 }

  it('br matches the legacy resizeRotatedBR (delegation stays exact)', () => {
    for (const deg of ROTS) {
      const pointer = { x: 200, y: 150 }
      const a = resizeRotatedBR(box, deg, pointer, { minW: 5, minH: 5 })
      const b = resizeFromHandle(box, deg, 'br', pointer, { minW: 5, minH: 5 })
      expect(near(a.x, b.x)).toBe(true)
      expect(near(a.y, b.y)).toBe(true)
      expect(near(a.w, b.width)).toBe(true)
      expect(near(a.h, b.height)).toBe(true)
    }
  })

  it('resizes each side/corner with the opposite anchored (unrotated)', () => {
    expect(resizeFromHandle(box, 0, 'r', { x: 160, y: 999 }, o)).toEqual({
      x: 10,
      y: 20,
      width: 150,
      height: 40,
    })
    expect(resizeFromHandle(box, 0, 'l', { x: 0, y: 0 }, o)).toEqual({
      x: 0,
      y: 20,
      width: 110,
      height: 40,
    })
    expect(resizeFromHandle(box, 0, 't', { x: 999, y: 0 }, o)).toEqual({
      x: 10,
      y: 0,
      width: 100,
      height: 60,
    })
    expect(resizeFromHandle(box, 0, 'b', { x: 0, y: 100 }, o)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 80,
    })
    expect(resizeFromHandle(box, 0, 'tl', { x: 0, y: 0 }, o)).toEqual({
      x: 0,
      y: 0,
      width: 110,
      height: 60,
    })
    expect(resizeFromHandle(box, 0, 'tr', { x: 160, y: 0 }, o)).toEqual({
      x: 10,
      y: 0,
      width: 150,
      height: 60,
    })
    expect(resizeFromHandle(box, 0, 'bl', { x: 0, y: 100 }, o)).toEqual({
      x: 0,
      y: 20,
      width: 110,
      height: 80,
    })
  })

  it('keeps the opposite handle fixed in world space for every handle × rotation', () => {
    const b = { x: 40, y: -20, w: 120, h: 80 }
    for (const deg of ROTS) {
      const pts = handlePoints(b, deg)
      for (const h of RESIZE_HANDLES) {
        const pointer = outward(b, pts[h], 37)
        const res = resizeFromHandle(b, deg, h, pointer, { minW: 1, minH: 1 })
        const next = { x: res.x, y: res.y, w: res.width, h: res.height }
        const before = pts[OPPOSITE[h]]
        const after = handlePoints(next, deg)[OPPOSITE[h]]
        expect(near(after.x, before.x)).toBe(true)
        expect(near(after.y, before.y)).toBe(true)
      }
    }
  })

  it('tracks the pointer with the dragged corner (no grab offset, rotated)', () => {
    const b = { x: 0, y: 0, w: 100, h: 100 }
    for (const deg of [30, 45, -90]) {
      const pointer = outward(b, handlePoints(b, deg).tr, 25)
      const res = resizeFromHandle(b, deg, 'tr', pointer, o)
      const trAfter = handlePoints({ x: res.x, y: res.y, w: res.width, h: res.height }, deg).tr
      expect(near(trAfter.x, pointer.x)).toBe(true)
      expect(near(trAfter.y, pointer.y)).toBe(true)
    }
  })

  it('moves only the dragged axis for edge handles (rotated)', () => {
    const b = { x: 0, y: 0, w: 100, h: 100 }
    const pointer = outward(b, handlePoints(b, 45).r, 20)
    const res = resizeFromHandle(b, 45, 'r', pointer, o)
    expect(near(res.width, 120)).toBe(true)
    expect(near(res.height, 100)).toBe(true)
  })

  it('subtracts the grab offset so the press point does not jump', () => {
    const grabOffset = { x: 4, y: -3 }
    const pointer = { x: 164, y: 117 }
    const withOffset = resizeFromHandle(box, 30, 'br', pointer, { ...o, grabOffset })
    const manual = resizeFromHandle(
      box,
      30,
      'br',
      { x: pointer.x - grabOffset.x, y: pointer.y - grabOffset.y },
      o,
    )
    expect(withOffset).toEqual(manual)
  })

  it('floors each axis against the anchored side (no flip past the anchor)', () => {
    const b = { x: 0, y: 0, w: 100, h: 50 }
    const res = resizeFromHandle(b, 0, 'l', { x: 200, y: 0 }, { minW: 30, minH: 0 })
    expect(res.width).toBe(30)
    expect(res.x).toBe(70) // right edge stays at 100
    expect(res.height).toBe(50)
  })

  it('aspect: a corner drag keeps the ratio, floors bump both axes', () => {
    const b = { x: 0, y: 0, w: 1000, h: 100 }
    const res = resizeFromHandle(b, 0, 'br', { x: 50, y: 5 }, {
      minW: 0,
      minH: 96,
      aspect: true,
    })
    expect(res.height).toBeGreaterThanOrEqual(96)
    expect(near(res.width / res.height, 10, 1e-3)).toBe(true)
  })

  it('aspect: an edge drag drives its axis and centres the other', () => {
    const b = { x: 0, y: 0, w: 200, h: 100 }
    const res = resizeFromHandle(b, 0, 'r', { x: 300, y: 0 }, { ...o, aspect: true })
    expect(near(res.width, 300)).toBe(true)
    expect(near(res.height, 150)).toBe(true)
    expect(near(res.x, 0)).toBe(true) // left edge anchored
    expect(near(res.y, -25)).toBe(true) // height grows about the y centre
  })

  it('aspect: a shrinking edge drag still drives its own axis', () => {
    const b = { x: 0, y: 0, w: 200, h: 100 }
    const res = resizeFromHandle(b, 0, 'r', { x: 100, y: 0 }, { ...o, aspect: true })
    expect(near(res.width, 100)).toBe(true)
    expect(near(res.height, 50)).toBe(true)
  })

  it('fromCenter: keeps the centre fixed for every handle × rotation', () => {
    const b = { x: 40, y: -20, w: 120, h: 80 }
    for (const deg of ROTS) {
      const pts = handlePoints(b, deg)
      for (const h of RESIZE_HANDLES) {
        const pointer = outward(b, pts[h], 23)
        const res = resizeFromHandle(b, deg, h, pointer, { minW: 1, minH: 1, fromCenter: true })
        expect(near(res.x + res.width / 2, 100)).toBe(true)
        expect(near(res.y + res.height / 2, 20)).toBe(true)
      }
    }
  })

  it('fromCenter: the dragged side doubles its travel (unrotated)', () => {
    const res = resizeFromHandle(box, 0, 'r', { x: 160, y: 40 }, { ...o, fromCenter: true })
    // centre x = 60; pointer 100 right of it → half-extent 100 → w 200.
    expect(res.width).toBe(200)
    expect(res.x).toBe(-40)
    expect(res.height).toBe(40)
  })

  it('composes aspect + fromCenter (ratio kept, centre fixed)', () => {
    const b = { x: 0, y: 0, w: 100, h: 100 }
    const res = resizeFromHandle(b, 0, 'br', { x: 110, y: 60 }, {
      ...o,
      aspect: true,
      fromCenter: true,
    })
    expect(near(res.width, 120)).toBe(true)
    expect(near(res.height, 120)).toBe(true)
    expect(near(res.x + res.width / 2, 50)).toBe(true)
    expect(near(res.y + res.height / 2, 50)).toBe(true)
  })
})

describe('resizeAnchor', () => {
  const box = { x: 10, y: 20, w: 100, h: 40 }
  it('returns the opposite corner for corner handles', () => {
    expect(resizeAnchor(box, 'br')).toEqual({ x: 10, y: 20 })
    expect(resizeAnchor(box, 'tl')).toEqual({ x: 110, y: 60 })
    expect(resizeAnchor(box, 'tr')).toEqual({ x: 10, y: 60 })
    expect(resizeAnchor(box, 'bl')).toEqual({ x: 110, y: 20 })
  })
  it('anchors the dragged axis opposite and centres the other for edges', () => {
    expect(resizeAnchor(box, 'r')).toEqual({ x: 10, y: 40 })
    expect(resizeAnchor(box, 'l')).toEqual({ x: 110, y: 40 })
    expect(resizeAnchor(box, 't')).toEqual({ x: 60, y: 60 })
    expect(resizeAnchor(box, 'b')).toEqual({ x: 60, y: 20 })
  })
  it('returns the centre with fromCenter', () => {
    expect(resizeAnchor(box, 'br', true)).toEqual({ x: 60, y: 40 })
    expect(resizeAnchor(box, 't', true)).toEqual({ x: 60, y: 40 })
  })
})

describe('cursorForHandle', () => {
  it('maps the unrotated handles to the four double-arrow cursors', () => {
    expect(cursorForHandle('r', 0)).toBe('ew-resize')
    expect(cursorForHandle('l', 0)).toBe('ew-resize')
    expect(cursorForHandle('t', 0)).toBe('ns-resize')
    expect(cursorForHandle('b', 0)).toBe('ns-resize')
    expect(cursorForHandle('br', 0)).toBe('nwse-resize')
    expect(cursorForHandle('tl', 0)).toBe('nwse-resize')
    expect(cursorForHandle('tr', 0)).toBe('nesw-resize')
    expect(cursorForHandle('bl', 0)).toBe('nesw-resize')
  })
  it('folds the element rotation into the bucket (45° → br points down)', () => {
    expect(cursorForHandle('br', 45)).toBe('ns-resize')
    expect(cursorForHandle('r', 45)).toBe('nwse-resize')
    expect(cursorForHandle('t', 45)).toBe('nesw-resize')
  })
  it('handles 90 / -90 / 180', () => {
    expect(cursorForHandle('br', 90)).toBe('nesw-resize')
    expect(cursorForHandle('t', 90)).toBe('ew-resize')
    expect(cursorForHandle('br', -90)).toBe('nesw-resize')
    expect(cursorForHandle('r', -90)).toBe('ns-resize')
    expect(cursorForHandle('br', 180)).toBe('nwse-resize')
    expect(cursorForHandle('l', 180)).toBe('ew-resize')
  })
  it('snaps in-between angles to the nearest 45° bucket', () => {
    expect(cursorForHandle('r', 20)).toBe('ew-resize') // 20 → bucket 0
    expect(cursorForHandle('r', 25)).toBe('nwse-resize') // 25 → bucket 1
    expect(cursorForHandle('r', -20)).toBe('ew-resize') // 340 → bucket 0 (wraps)
  })
})

describe('rotateCursor', () => {
  it('returns a data-URI cursor with a centred hotspot and grab fallback', () => {
    const c = rotateCursor(45)
    expect(c.startsWith('url("data:image/svg+xml,')).toBe(true)
    expect(c.endsWith('") 12 12, grab')).toBe(true)
    const svg = decodeURIComponent(c.slice('url("data:image/svg+xml,'.length, -'") 12 12, grab'.length))
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('<polygon') // the two arrowheads
  })
  it('caches per quantised heading (same bucket → identical string)', () => {
    expect(rotateCursor(45)).toBe(rotateCursor(45))
    expect(rotateCursor(0)).toBe(rotateCursor(10)) // 10° rounds into the 0 bucket
    expect(rotateCursor(0)).not.toBe(rotateCursor(12)) // 12° rounds to the next
  })
  it('wraps angles into one revolution', () => {
    expect(rotateCursor(360)).toBe(rotateCursor(0))
    expect(rotateCursor(-45)).toBe(rotateCursor(315))
    expect(rotateCursor(405)).toBe(rotateCursor(45))
  })
})
