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
