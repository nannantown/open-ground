import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import {
  resolveShapeKind,
  resolveShapeStyle,
  drawRectFromDrag,
  DEFAULT_SHAPE_KIND,
  DEFAULT_SHAPE_FILL,
  DEFAULT_SHAPE_STROKE_COLOR,
  DEFAULT_SHAPE_STROKE_WIDTH,
} from './canvasShape'

const shape = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 'sh1',
  type: 'shape',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

describe('resolveShapeKind', () => {
  it('defaults to rect for a shape with no shapeKind', () => {
    expect(resolveShapeKind(shape())).toBe('rect')
    expect(DEFAULT_SHAPE_KIND).toBe('rect')
  })
  it('returns ellipse when explicitly set', () => {
    expect(resolveShapeKind(shape({ shapeKind: 'ellipse' }))).toBe('ellipse')
  })
  it('returns rect when explicitly set', () => {
    expect(resolveShapeKind(shape({ shapeKind: 'rect' }))).toBe('rect')
  })
  it('snaps an unknown/garbage kind back to the default rect', () => {
    // A stray value (e.g. from a future build or a hand-edited file) must not
    // draw an unhandled third primitive — it falls back to a rectangle.
    expect(resolveShapeKind(shape({ shapeKind: 'triangle' as never }))).toBe('rect')
  })
})

describe('resolveShapeStyle', () => {
  it('falls back to the shape defaults for a shape with no fill/stroke', () => {
    expect(resolveShapeStyle(shape())).toEqual({
      fill: DEFAULT_SHAPE_FILL,
      strokeColor: DEFAULT_SHAPE_STROKE_COLOR,
      strokeWidth: DEFAULT_SHAPE_STROKE_WIDTH,
    })
  })
  it('uses the element fields when present', () => {
    const el = shape({ fill: '#ffffff', strokeColor: '#000000', strokeWidth: 3 })
    expect(resolveShapeStyle(el)).toEqual({
      fill: '#ffffff',
      strokeColor: '#000000',
      strokeWidth: 3,
    })
  })
  it('resolves each field independently (no all-or-nothing coupling)', () => {
    const el = shape({ fill: '#eeeeee' })
    const r = resolveShapeStyle(el)
    expect(r.fill).toBe('#eeeeee')
    expect(r.strokeColor).toBe(DEFAULT_SHAPE_STROKE_COLOR)
    expect(r.strokeWidth).toBe(DEFAULT_SHAPE_STROKE_WIDTH)
  })
  it('honours an explicit zero stroke width (no border)', () => {
    expect(resolveShapeStyle(shape({ strokeWidth: 0 })).strokeWidth).toBe(0)
  })
})

describe('drawRectFromDrag', () => {
  const A = { x: 100, y: 100 }

  it('default drag → box from anchor to pointer (any quadrant)', () => {
    expect(drawRectFromDrag(A, { x: 160, y: 140 })).toEqual({ x: 100, y: 100, w: 60, h: 40 })
    // Up-left drag: the pointer is the opposite corner, box normalises.
    expect(drawRectFromDrag(A, { x: 70, y: 60 })).toEqual({ x: 70, y: 60, w: 30, h: 40 })
  })

  it('Shift → square sized to the dominant axis, in the drag quadrant', () => {
    // dx=60, dy=40 → square side = max = 60, growing down-right.
    expect(drawRectFromDrag(A, { x: 160, y: 140 }, { shift: true })).toEqual({
      x: 100,
      y: 100,
      w: 60,
      h: 60,
    })
    // Up-left drag: square still grows toward the dragged quadrant.
    // dx=-60, dy=-40 → side 60, both negative → origin (40,40).
    expect(drawRectFromDrag(A, { x: 40, y: 60 }, { shift: true })).toEqual({
      x: 40,
      y: 40,
      w: 60,
      h: 60,
    })
  })

  it('Shift squares even a pure-axis drag (no collapse)', () => {
    // Pure horizontal drag: dy=0 → side = |dx|, square grows downward (+y).
    expect(drawRectFromDrag(A, { x: 150, y: 100 }, { shift: true })).toEqual({
      x: 100,
      y: 100,
      w: 50,
      h: 50,
    })
  })

  it('Alt → draws from the centre, symmetric growth', () => {
    // half-extents = (60, 40) → full box 120×80 centred on the anchor.
    expect(drawRectFromDrag(A, { x: 160, y: 140 }, { alt: true })).toEqual({
      x: 40,
      y: 60,
      w: 120,
      h: 80,
    })
  })

  it('Shift+Alt → centred square sized to the dominant axis', () => {
    // dominant |d|=60 → half-extent 60 each way → 120×120 centred on anchor.
    expect(drawRectFromDrag(A, { x: 160, y: 140 }, { shift: true, alt: true })).toEqual({
      x: 40,
      y: 40,
      w: 120,
      h: 120,
    })
  })

  it('offset (Space-reposition) translates the box, keeping its size', () => {
    const base = drawRectFromDrag(A, { x: 160, y: 140 })
    const moved = drawRectFromDrag(A, { x: 160, y: 140 }, { offset: { x: 30, y: -20 } })
    expect(moved.w).toBe(base.w)
    expect(moved.h).toBe(base.h)
    expect(moved.x).toBe(base.x + 30)
    expect(moved.y).toBe(base.y - 20)
  })

  it('offset composes with Alt (centre shifts by the offset)', () => {
    const moved = drawRectFromDrag(A, { x: 160, y: 140 }, { alt: true, offset: { x: 10, y: 10 } })
    expect(moved).toEqual({ x: 50, y: 70, w: 120, h: 80 })
  })

  it('returns a non-negative, normalised box for a zero-length drag', () => {
    expect(drawRectFromDrag(A, A)).toEqual({ x: 100, y: 100, w: 0, h: 0 })
  })
})
