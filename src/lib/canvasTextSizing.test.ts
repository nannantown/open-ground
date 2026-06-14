import { describe, it, expect } from 'vitest'
import {
  textSizingOf,
  textVAlignOf,
  measuresWidth,
  measuresHeight,
  textBox,
  textMeasurePatch,
  convertSizing,
  resizeOutcome,
} from './canvasTextSizing'
import { TEXT_W, TEXT_H } from './canvasBounds'

// The pure mode contract (docs/CANVAS_TEXT_SIZING_PLAN.md). Both the renderer
// and the interaction layer build on these, so the invariants here ARE the
// shared spec: which axes a measurement may overwrite, how a mode-switch keeps
// the box put, and the Figma resize-drag → mode transitions.

describe('defaults (legacy / new text)', () => {
  it('undefined sizing → auto-width, undefined valign → top', () => {
    expect(textSizingOf({})).toBe('auto-width')
    expect(textVAlignOf({})).toBe('top')
  })
  it('explicit values pass through', () => {
    expect(textSizingOf({ textSizing: 'fixed' })).toBe('fixed')
    expect(textVAlignOf({ textVerticalAlign: 'middle' })).toBe('middle')
  })
})

describe('measured axes per mode', () => {
  it('auto-width measures both axes', () => {
    expect(measuresWidth('auto-width')).toBe(true)
    expect(measuresHeight('auto-width')).toBe(true)
  })
  it('auto-height measures height only', () => {
    expect(measuresWidth('auto-height')).toBe(false)
    expect(measuresHeight('auto-height')).toBe(true)
  })
  it('fixed measures neither', () => {
    expect(measuresWidth('fixed')).toBe(false)
    expect(measuresHeight('fixed')).toBe(false)
  })
})

describe('textBox (bounds / selection / hit-test source)', () => {
  it('reads persisted footprint', () => {
    expect(textBox({ width: 120, height: 22 })).toEqual({ w: 120, h: 22 })
  })
  it('falls back to the 300×44 default only when unmeasured', () => {
    expect(textBox({})).toEqual({ w: TEXT_W, h: TEXT_H })
    expect(textBox({ width: 80 })).toEqual({ w: 80, h: TEXT_H })
  })
})

describe('textMeasurePatch (which axes a measurement may overwrite)', () => {
  it('auto-width writes BOTH axes, quantised up to 2px', () => {
    expect(textMeasurePatch({ textSizing: 'auto-width' }, 61, 21)).toEqual({
      width: 62,
      height: 22,
    })
  })
  it('auto-height writes HEIGHT only — never clobbers the user-set width', () => {
    const patch = textMeasurePatch(
      { textSizing: 'auto-height', width: 200, height: 40 },
      999, // a measured width is ignored in auto-height
      58,
    )
    expect(patch).toEqual({ height: 58 })
  })
  it('fixed writes nothing', () => {
    expect(textMeasurePatch({ textSizing: 'fixed', width: 200, height: 80 }, 50, 20)).toBeNull()
  })
  it('a zero / negative readout (unmounted) writes nothing', () => {
    expect(textMeasurePatch({ textSizing: 'auto-width' }, 0, 20)).toBeNull()
    expect(textMeasurePatch({ textSizing: 'auto-width' }, 30, -1)).toBeNull()
  })
  it('a sub-quantum no-op on every eligible axis writes nothing', () => {
    // Already 62×22; a 61×21 readout quantises back to the same → no write.
    expect(
      textMeasurePatch({ textSizing: 'auto-width', width: 62, height: 22 }, 61, 21),
    ).toBeNull()
  })
  it('writes only the axis that actually moved', () => {
    expect(
      textMeasurePatch({ textSizing: 'auto-width', width: 62, height: 22 }, 61, 40),
    ).toEqual({ height: 40 })
  })
})

describe('convertSizing (inspector mode switch keeps the box put)', () => {
  const measured = { w: 140, h: 30 }
  it('→ auto-height freezes the current width', () => {
    expect(convertSizing({ textSizing: 'auto-width' }, 'auto-height', measured)).toEqual({
      textSizing: 'auto-height',
      width: 140,
      height: 30,
    })
  })
  it('→ fixed freezes both axes', () => {
    expect(
      convertSizing({ textSizing: 'auto-height', width: 200, height: 60 }, 'fixed', measured),
    ).toEqual({ textSizing: 'fixed', width: 200, height: 60 })
  })
  it('→ auto-width seeds from the current box (re-measured immediately after)', () => {
    expect(
      convertSizing({ textSizing: 'fixed', width: 200, height: 60 }, 'auto-width', measured),
    ).toEqual({ textSizing: 'auto-width', width: 200, height: 60 })
  })
  it('uses the measured box when the element has no explicit size yet', () => {
    expect(convertSizing({ textSizing: 'auto-width' }, 'fixed', measured)).toEqual({
      textSizing: 'fixed',
      width: 140,
      height: 30,
    })
  })
})

describe('resizeOutcome (Figma resize-drag → mode transition)', () => {
  it('horizontal drag on auto-width → auto-height (width authoritative)', () => {
    expect(resizeOutcome('auto-width', 'horizontal', 250, 40)).toEqual({
      textSizing: 'auto-height',
      width: 250,
    })
  })
  it('horizontal drag on auto-height → stays auto-height with the new width', () => {
    expect(resizeOutcome('auto-height', 'horizontal', 300, 40)).toEqual({
      textSizing: 'auto-height',
      width: 300,
    })
  })
  it('horizontal drag on fixed → stays fixed with the new width', () => {
    expect(resizeOutcome('fixed', 'horizontal', 300, 90)).toEqual({
      textSizing: 'fixed',
      width: 300,
      height: 90,
    })
  })
  it('vertical or corner drag → fixed (both axes authoritative), any mode', () => {
    expect(resizeOutcome('auto-width', 'vertical', 250, 80)).toEqual({
      textSizing: 'fixed',
      width: 250,
      height: 80,
    })
    expect(resizeOutcome('auto-height', 'corner', 250, 80)).toEqual({
      textSizing: 'fixed',
      width: 250,
      height: 80,
    })
  })
})
