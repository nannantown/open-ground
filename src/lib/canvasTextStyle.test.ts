import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import {
  applyElementPatch,
  clampFontSize,
  clampLineHeight,
  resolveTextStyle,
  DEFAULT_TEXT_FONT_SIZE,
  DEFAULT_TEXT_COLOR,
  DEFAULT_TEXT_FONT_WEIGHT,
  DEFAULT_TEXT_ALIGN,
  DEFAULT_LINE_HEIGHT,
  FONT_DISPLAY_STACK,
  MIN_TEXT_FONT_SIZE,
  MAX_TEXT_FONT_SIZE,
  MIN_LINE_HEIGHT,
  MAX_LINE_HEIGHT,
} from './canvasTextStyle'

const text = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 't1',
  type: 'text',
  x: 0,
  y: 0,
  text: 'hi',
  ...over,
})

describe('clampFontSize', () => {
  it('rounds and keeps in-band values', () => {
    expect(clampFontSize(18.4)).toBe(18)
    expect(clampFontSize(24)).toBe(24)
  })
  it('clamps below the floor and above the ceiling', () => {
    expect(clampFontSize(1)).toBe(MIN_TEXT_FONT_SIZE)
    expect(clampFontSize(9999)).toBe(MAX_TEXT_FONT_SIZE)
  })
  it('falls back to the default on non-finite input (NaN / Infinity)', () => {
    // A blank number input yields NaN; Infinity is also non-finite. Both are
    // treated as "no valid value" and snap to the default rather than the
    // ceiling, so a cleared field never persists a garbage size.
    expect(clampFontSize(NaN)).toBe(DEFAULT_TEXT_FONT_SIZE)
    expect(clampFontSize(Infinity)).toBe(DEFAULT_TEXT_FONT_SIZE)
  })
})

describe('clampLineHeight', () => {
  it('keeps in-band values and rounds to 2 decimals', () => {
    expect(clampLineHeight(1.5)).toBe(1.5)
    expect(clampLineHeight(1.234)).toBe(1.23)
  })
  it('clamps below the floor and above the ceiling', () => {
    expect(clampLineHeight(0.1)).toBe(MIN_LINE_HEIGHT)
    expect(clampLineHeight(99)).toBe(MAX_LINE_HEIGHT)
  })
  it('falls back to the default on non-finite input (NaN / Infinity)', () => {
    // A cleared number field yields NaN; both snap to the default rather than
    // the ceiling, so an empty input never persists a garbage line-height.
    expect(clampLineHeight(NaN)).toBe(DEFAULT_LINE_HEIGHT)
    expect(clampLineHeight(Infinity)).toBe(DEFAULT_LINE_HEIGHT)
  })
})

describe('resolveTextStyle', () => {
  it('falls back to defaults for a legacy element with no typography', () => {
    expect(resolveTextStyle(text())).toEqual({
      fontSize: DEFAULT_TEXT_FONT_SIZE,
      fontFamily: FONT_DISPLAY_STACK,
      color: DEFAULT_TEXT_COLOR,
      fontWeight: DEFAULT_TEXT_FONT_WEIGHT,
      textAlign: DEFAULT_TEXT_ALIGN,
      lineHeight: DEFAULT_LINE_HEIGHT,
    })
  })
  it('uses the element fields when present', () => {
    const el = text({
      fontSize: 32,
      fontFamily: 'Mono',
      textColor: '#ff0000',
      fontWeight: 700,
      textAlign: 'center',
      lineHeight: 2,
    })
    expect(resolveTextStyle(el)).toEqual({
      fontSize: 32,
      fontFamily: 'Mono',
      color: '#ff0000',
      fontWeight: 700,
      textAlign: 'center',
      lineHeight: 2,
    })
  })
  it('resolves round-2 fields independently of round-1 fields', () => {
    // A canvas saved after round 1 (size/family/colour only) must still get
    // the round-2 defaults for the new fields — no all-or-nothing coupling.
    const el = text({ fontSize: 24 })
    const r = resolveTextStyle(el)
    expect(r.fontSize).toBe(24)
    expect(r.fontWeight).toBe(DEFAULT_TEXT_FONT_WEIGHT)
    expect(r.textAlign).toBe(DEFAULT_TEXT_ALIGN)
    expect(r.lineHeight).toBe(DEFAULT_LINE_HEIGHT)
  })
})

describe('applyElementPatch', () => {
  it('patches only the matching element and returns a new array', () => {
    const a = text({ id: 'a' })
    const b = text({ id: 'b' })
    const next = applyElementPatch([a, b], 'a', { fontSize: 40 })
    expect(next).not.toBe([a, b])
    expect(next[0]).toEqual({ ...a, fontSize: 40 })
    expect(next[0]).not.toBe(a) // matched element is a fresh reference
    expect(next[1]).toBe(b) // untouched element keeps its identity
  })
  it('returns the original array reference when nothing matched', () => {
    const els = [text({ id: 'a' })]
    expect(applyElementPatch(els, 'missing', { fontSize: 40 })).toBe(els)
  })
  it('carries the round-2 typography fields through the patch', () => {
    const a = text({ id: 'a' })
    const next = applyElementPatch([a], 'a', {
      fontWeight: 700,
      textAlign: 'right',
      lineHeight: 1.6,
    })
    expect(next[0]).toMatchObject({ fontWeight: 700, textAlign: 'right', lineHeight: 1.6 })
  })
})
