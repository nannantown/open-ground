import { describe, it, expect } from 'vitest'
import {
  TEXT_HANDLES,
  handleKind,
  textResizeMin,
  collapseSizingTarget,
  textCreateSpec,
} from './InfiniteCanvas'
import { resizeOutcome, type TextSizing } from '@/lib/canvasTextSizing'
import type { CanvasElement } from '@/lib/types'

// Track B's text creation + resize WIRING (the small pure decisions the
// InfiniteCanvas gesture handlers route through). The heavy mode math lives in
// canvasTextSizing (its own spec); these tests pin the glue: which drag width
// makes which sizing mode, how a grabbed handle classifies, the per-mode handle
// sets, and the resize-handle double-click collapse — plus the COMPOSITION with
// resizeOutcome that the pointer-up handler actually performs.

const text = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 't',
  type: 'text',
  x: 0,
  y: 0,
  text: 'hi',
  ...over,
})

describe('textCreateSpec — text-tool creation gesture (click vs box-drag)', () => {
  it('a plain click (null width) → auto-width: no explicit width, sizing undefined', () => {
    // Undefined sizing is the auto-width default — a content-hugging text.
    expect(textCreateSpec(null)).toEqual({})
  })
  it('a too-small drag (< 24px) collapses to a click → auto-width', () => {
    expect(textCreateSpec(10)).toEqual({})
    expect(textCreateSpec(23.9)).toEqual({})
  })
  it('a real box-drag (≥ 24px) → auto-height the drag width wide (rounded, floored)', () => {
    expect(textCreateSpec(240)).toEqual({ textSizing: 'auto-height', width: 240 })
    expect(textCreateSpec(180.4)).toEqual({ textSizing: 'auto-height', width: 180 })
    // Exactly at the floor still creates a box (not a click).
    expect(textCreateSpec(24)).toEqual({ textSizing: 'auto-height', width: 24 })
  })
})

describe('handleKind — grabbed handle → resizeOutcome transition class', () => {
  it('side L/R handles are horizontal (re-width)', () => {
    expect(handleKind('l')).toBe('horizontal')
    expect(handleKind('r')).toBe('horizontal')
  })
  it('top/bottom handles are vertical (→ fixed)', () => {
    expect(handleKind('t')).toBe('vertical')
    expect(handleKind('b')).toBe('vertical')
  })
  it('the four corners classify as corner (→ fixed)', () => {
    for (const h of ['tl', 'tr', 'br', 'bl'] as const) expect(handleKind(h)).toBe('corner')
  })
})

describe('TEXT_HANDLES — which grips each mode exposes (Figma parity)', () => {
  it('auto-width shows only the two side handles', () => {
    expect(Array.from(TEXT_HANDLES['auto-width']).sort()).toEqual(['l', 'r'])
  })
  it('auto-height shows sides + the four corners (no top/bottom)', () => {
    expect(Array.from(TEXT_HANDLES['auto-height']).sort()).toEqual(
      ['bl', 'br', 'l', 'r', 'tl', 'tr'].sort(),
    )
    expect(TEXT_HANDLES['auto-height'].has('t')).toBe(false)
    expect(TEXT_HANDLES['auto-height'].has('b')).toBe(false)
  })
  it('fixed shows all eight handles', () => {
    expect(TEXT_HANDLES.fixed.size).toBe(8)
  })
})

describe('resize wiring — grabbed handle composes with resizeOutcome', () => {
  // The pointer-up handler computes resizeOutcome(mode, handleKind(handle), w, h)
  // for the dragged box. These cases mirror the exact compositions per mode.
  it('dragging an auto-width text by a side handle promotes it to auto-height', () => {
    expect(resizeOutcome('auto-width', handleKind('r'), 260, 44)).toEqual({
      textSizing: 'auto-height',
      width: 260,
    })
  })
  it('dragging an auto-height text by a side handle keeps it auto-height, new width', () => {
    expect(resizeOutcome('auto-height', handleKind('l'), 300, 80)).toEqual({
      textSizing: 'auto-height',
      width: 300,
    })
  })
  it('dragging any text by a corner fixes both axes', () => {
    expect(resizeOutcome('auto-width', handleKind('br'), 260, 120)).toEqual({
      textSizing: 'fixed',
      width: 260,
      height: 120,
    })
  })
  it('dragging a fixed text by a top/bottom handle keeps it fixed with new height', () => {
    expect(resizeOutcome('fixed', handleKind('b'), 260, 200)).toEqual({
      textSizing: 'fixed',
      width: 260,
      height: 200,
    })
  })
})

describe('collapseSizingTarget — resize-handle double-click hugs one step', () => {
  it('fixed → auto-height, auto-height → auto-width, auto-width → null (no-op)', () => {
    expect(collapseSizingTarget('fixed')).toBe('auto-height')
    expect(collapseSizingTarget('auto-height')).toBe('auto-width')
    expect(collapseSizingTarget('auto-width')).toBeNull()
  })
  it('maps each mode in order: [auto-width, auto-height, fixed] → [null, auto-width, auto-height]', () => {
    const seen = (['auto-width', 'auto-height', 'fixed'] as TextSizing[]).map(
      collapseSizingTarget,
    )
    expect(seen).toEqual([null, 'auto-width', 'auto-height'])
  })
})

describe('textResizeMin — the resize floor scales with font metrics', () => {
  it('width always floors at 24px', () => {
    expect(textResizeMin(text()).w).toBe(24)
    expect(textResizeMin(text({ fontSize: 96 })).w).toBe(24)
  })
  it('height floors at one rendered line (ceil(fontSize × lineHeight))', () => {
    // Default 18px × 1.375 line-height → 25 (24.75 ceils to 25).
    expect(textResizeMin(text()).h).toBe(Math.ceil(18 * 1.375))
    // A big font lifts the height floor.
    expect(textResizeMin(text({ fontSize: 40, lineHeight: 1.5 })).h).toBe(60)
  })
  it('a tiny font never lets the height floor drop below the 24px width floor', () => {
    // 6px × 0.5 = 3 → clamped up to 24.
    expect(textResizeMin(text({ fontSize: 6, lineHeight: 0.5 })).h).toBe(24)
  })
})
