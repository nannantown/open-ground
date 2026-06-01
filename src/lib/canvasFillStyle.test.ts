import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import {
  clampStrokeWidth,
  resolveStickyFill,
  resolveFrameStyle,
  DEFAULT_STICKY_FILL,
  DEFAULT_FRAME_FILL,
  DEFAULT_FRAME_STROKE_COLOR,
  DEFAULT_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  MAX_STROKE_WIDTH,
} from './canvasFillStyle'

const sticky = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 's1',
  type: 'sticky',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

const frame = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 'f1',
  type: 'frame',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

describe('clampStrokeWidth', () => {
  it('rounds and keeps in-band values', () => {
    expect(clampStrokeWidth(2.4)).toBe(2)
    expect(clampStrokeWidth(8)).toBe(8)
  })
  it('allows a zero-width stroke (no border) at the floor', () => {
    expect(clampStrokeWidth(0)).toBe(MIN_STROKE_WIDTH)
    expect(clampStrokeWidth(-5)).toBe(MIN_STROKE_WIDTH)
  })
  it('clamps above the ceiling', () => {
    expect(clampStrokeWidth(9999)).toBe(MAX_STROKE_WIDTH)
  })
  it('falls back to the default on non-finite input (NaN / Infinity)', () => {
    // A cleared number field yields NaN; both snap to the default rather than
    // the floor, so an empty input never silently zeroes the border.
    expect(clampStrokeWidth(NaN)).toBe(DEFAULT_STROKE_WIDTH)
    expect(clampStrokeWidth(Infinity)).toBe(DEFAULT_STROKE_WIDTH)
  })
})

describe('resolveStickyFill', () => {
  it('falls back to the default for a legacy sticky with no colour', () => {
    expect(resolveStickyFill(sticky())).toBe(DEFAULT_STICKY_FILL)
  })
  it('reuses the existing `color` field (no separate sticky-fill field)', () => {
    expect(resolveStickyFill(sticky({ color: '#F4B8A8' }))).toBe('#F4B8A8')
  })
})

describe('resolveFrameStyle', () => {
  it('falls back to the legacy look for a frame with no fill/stroke', () => {
    expect(resolveFrameStyle(frame())).toEqual({
      fill: DEFAULT_FRAME_FILL,
      strokeColor: DEFAULT_FRAME_STROKE_COLOR,
      strokeWidth: DEFAULT_STROKE_WIDTH,
    })
  })
  it('uses the element fields when present', () => {
    const el = frame({ fill: '#ffffff', strokeColor: '#000000', strokeWidth: 4 })
    expect(resolveFrameStyle(el)).toEqual({
      fill: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 4,
    })
  })
  it('resolves each field independently (no all-or-nothing coupling)', () => {
    // A frame that only set `fill` must still get the stroke defaults — a
    // canvas mid-migration shouldn't lose its border.
    const el = frame({ fill: '#eeeeee' })
    const r = resolveFrameStyle(el)
    expect(r.fill).toBe('#eeeeee')
    expect(r.strokeColor).toBe(DEFAULT_FRAME_STROKE_COLOR)
    expect(r.strokeWidth).toBe(DEFAULT_STROKE_WIDTH)
  })
  it('honours an explicit zero stroke width (no border)', () => {
    expect(resolveFrameStyle(frame({ strokeWidth: 0 })).strokeWidth).toBe(0)
  })
})
