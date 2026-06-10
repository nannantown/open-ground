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
  DEFAULT_OPACITY,
  DEFAULT_FRAME_CORNER_RADIUS,
  MIN_CORNER_RADIUS,
  MAX_CORNER_RADIUS,
  RESIZE_MIN_W,
  RESIZE_MIN_H,
  RESIZE_MAX,
} from './canvasTransform'

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
