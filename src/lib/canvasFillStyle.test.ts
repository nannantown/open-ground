import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import {
  clampStrokeWidth,
  resolveStickyFill,
  resolveFrameStyle,
  isNoFill,
  NO_FILL,
  resolveStrokeStyle,
  renderStrokeWidth,
  resolveStrokeAlign,
  DEFAULT_STROKE_STYLE,
  DEFAULT_STROKE_ALIGN,
  DEFAULT_STICKY_FILL,
  DEFAULT_FRAME_FILL,
  DEFAULT_FRAME_STROKE_COLOR,
  DEFAULT_STROKE_WIDTH,
  MIN_STROKE_WIDTH,
  MAX_STROKE_WIDTH,
  initialDrawnFrameFill,
  DRAWN_ARTBOARD_FILL,
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
  it('keeps an EXPLICIT transparent fill instead of substituting the default', () => {
    // The crux of the no-fill feature: `?? DEFAULT` only fires for an ABSENT
    // fill; an explicit `transparent` must survive so the body paints empty.
    expect(resolveFrameStyle(frame({ fill: NO_FILL })).fill).toBe(NO_FILL)
  })
})

describe('resolveStrokeStyle', () => {
  it('defaults to solid when unset', () => {
    expect(resolveStrokeStyle(frame())).toBe(DEFAULT_STROKE_STYLE)
    expect(resolveStrokeStyle(frame())).toBe('solid')
  })
  it('honours a valid style', () => {
    expect(resolveStrokeStyle(frame({ strokeStyle: 'dashed' }))).toBe('dashed')
    expect(resolveStrokeStyle(frame({ strokeStyle: 'dotted' }))).toBe('dotted')
  })
  it('snaps an unknown value back to solid', () => {
    // a stray persisted value must never reach CSS as an unhandled border-style
    expect(resolveStrokeStyle(frame({ strokeStyle: 'groovy' as never }))).toBe('solid')
  })
})

describe('resolveStrokeAlign', () => {
  it('defaults to inside (the legacy border render)', () => {
    expect(resolveStrokeAlign(frame())).toBe(DEFAULT_STROKE_ALIGN)
    expect(resolveStrokeAlign(frame())).toBe('inside')
  })
  it('honours a valid alignment', () => {
    expect(resolveStrokeAlign(frame({ strokeAlign: 'center' }))).toBe('center')
    expect(resolveStrokeAlign(frame({ strokeAlign: 'outside' }))).toBe('outside')
  })
  it('snaps an unknown value to inside', () => {
    expect(resolveStrokeAlign(frame({ strokeAlign: 'sideways' as never }))).toBe('inside')
  })
})

describe('renderStrokeWidth', () => {
  it('honours the resolved width for a normal coloured stroke', () => {
    expect(renderStrokeWidth('#000000', 3, false)).toBe(3)
  })
  it('collapses a no-fill (transparent) stroke to 0 — a removed border takes no space', () => {
    expect(renderStrokeWidth('transparent', 4, false)).toBe(0)
    expect(renderStrokeWidth('rgba(0,0,0,0)', 4, false)).toBe(0)
  })
  it('keeps ≥1px while selected even for a no-fill stroke (selection affordance)', () => {
    expect(renderStrokeWidth('transparent', 0, true)).toBe(1)
    expect(renderStrokeWidth('#000000', 6, true)).toBe(6)
  })
})

describe('isNoFill', () => {
  it('treats the explicit sentinel + CSS none as no-fill (trim + case-insensitive)', () => {
    expect(isNoFill(NO_FILL)).toBe(true)
    expect(isNoFill('transparent')).toBe(true)
    expect(isNoFill('none')).toBe(true)
    expect(isNoFill('  Transparent ')).toBe(true)
  })
  it('treats a zero-alpha rgba()/hsla() as no-fill (legacy comma syntax)', () => {
    expect(isNoFill('rgba(0,0,0,0)')).toBe(true)
    expect(isNoFill('rgba(255, 255, 255, 0)')).toBe(true)
    expect(isNoFill('rgba(10,20,30,0.0)')).toBe(true)
    expect(isNoFill('rgba(0,0,0,.0)')).toBe(true)
    expect(isNoFill('hsla(120, 50%, 50%, 0)')).toBe(true)
  })
  it('treats a zero-alpha colour in MODERN space/slash + % syntax as no-fill', () => {
    // The AI canvas generator + hand-typed values can use these; the legacy
    // comma-only regex missed them (a genuinely invisible fill would have read
    // as a real colour). Note the inner 0% in hsl are S/L, not alpha.
    expect(isNoFill('rgb(0 0 0 / 0)')).toBe(true)
    expect(isNoFill('rgba(0 0 0 / 0)')).toBe(true)
    expect(isNoFill('rgb(0 0 0 / 0%)')).toBe(true)
    expect(isNoFill('rgba(0,0,0,0%)')).toBe(true)
    expect(isNoFill('hsl(0 0% 0% / 0)')).toBe(true)
  })
  it('keeps a NON-zero alpha in modern syntax a fill', () => {
    expect(isNoFill('rgb(0 0 0 / 50%)')).toBe(false)
    expect(isNoFill('rgba(0 0 0 / 0.5)')).toBe(false)
    expect(isNoFill('hsl(0 0% 0%)')).toBe(false) // no alpha → opaque
  })
  it('treats a zero-alpha hex (#rrggbb00 / #rgb0) as no-fill', () => {
    expect(isNoFill('#00000000')).toBe(true)
    expect(isNoFill('#FFFFFF00')).toBe(true)
    expect(isNoFill('#0000')).toBe(true)
  })
  it('treats a real / partially-transparent colour as a fill', () => {
    expect(isNoFill('#ffffff')).toBe(false)
    expect(isNoFill('#000')).toBe(false)
    expect(isNoFill('rgb(0,0,0)')).toBe(false)
    expect(isNoFill('rgba(0,0,0,1)')).toBe(false)
    expect(isNoFill('rgba(0,0,0,0.5)')).toBe(false)
    expect(isNoFill('#00000080')).toBe(false) // 50% alpha is still a fill
  })
  it('does NOT treat null / undefined / empty (Mixed / unset) as no-fill', () => {
    expect(isNoFill(null)).toBe(false)
    expect(isNoFill(undefined)).toBe(false)
    expect(isNoFill('')).toBe(false)
  })
})

describe('initialDrawnFrameFill', () => {
  it('gives a DESIGN-canvas drawn frame an explicit white artboard fill', () => {
    // Figma parity: a design-canvas frame is an artboard, so it must read white
    // against the paper canvas rather than the near-invisible paper wash.
    expect(initialDrawnFrameFill('design')).toBe(DRAWN_ARTBOARD_FILL)
    expect(initialDrawnFrameFill('design')).toBe('#FFFFFF')
  })
  it('leaves a GROUND-canvas drawn frame fill UNSET (regression card 587cc625)', () => {
    // A Ground portfolio frame is a grouping box, not an artboard. Returning
    // undefined keeps `fill` off the new element so resolveFrameStyle falls back
    // to DEFAULT_FRAME_FILL and the background grid shows through — matching
    // legacy Ground frames. A white fill here was the white-interior regression.
    expect(initialDrawnFrameFill('ground')).toBeUndefined()
  })
  it('round-trips through resolveFrameStyle: ground → paper wash, design → white', () => {
    // The end-to-end contract the draw-commit handler relies on: a frame built
    // with the variant's initial fill resolves to the right body colour. An
    // absent (ground) fill must land on the paper wash, an explicit (design)
    // white must survive.
    const groundFill = initialDrawnFrameFill('ground')
    const designFill = initialDrawnFrameFill('design')
    expect(resolveFrameStyle(frame({ fill: groundFill })).fill).toBe(DEFAULT_FRAME_FILL)
    expect(resolveFrameStyle(frame({ fill: designFill })).fill).toBe(DRAWN_ARTBOARD_FILL)
  })
})
