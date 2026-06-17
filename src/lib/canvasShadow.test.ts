import { describe, it, expect } from 'vitest'
import type { CanvasElement, CanvasShadow } from './types'
import {
  shadowsCss,
  clampShadow,
  DEFAULT_SHADOW,
  MAX_SHADOW_BLUR,
  MAX_SHADOW_OFFSET,
} from './canvasShadow'

const frame = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 'f1',
  type: 'frame',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

const shadow = (over: Partial<CanvasShadow> = {}): CanvasShadow => ({ ...DEFAULT_SHADOW, ...over })

describe('shadowsCss', () => {
  it('is undefined for an element with no shadows (legacy untouched)', () => {
    expect(shadowsCss(frame())).toBeUndefined()
    expect(shadowsCss(frame({ shadows: [] }))).toBeUndefined()
  })
  it('renders a drop shadow as a plain box-shadow layer', () => {
    expect(shadowsCss(frame({ shadows: [shadow({ x: 0, y: 4, blur: 12, spread: 0, color: '#00000040' })] }))).toBe(
      '0px 4px 12px 0px #00000040',
    )
  })
  it('prefixes an inner shadow with inset', () => {
    expect(shadowsCss(frame({ shadows: [shadow({ type: 'inner', x: 1, y: 2, blur: 3, spread: 4, color: '#000' })] }))).toBe(
      'inset 1px 2px 3px 4px #000',
    )
  })
  it('joins multiple shadows in array order', () => {
    const css = shadowsCss(
      frame({
        shadows: [
          shadow({ x: 0, y: 2, blur: 4, spread: 0, color: '#111' }),
          shadow({ type: 'inner', x: 0, y: 0, blur: 6, spread: 1, color: '#222' }),
        ],
      }),
    )
    expect(css).toBe('0px 2px 4px 0px #111, inset 0px 0px 6px 1px #222')
  })
  it('clamps absurd values into the allowed band', () => {
    const css = shadowsCss(frame({ shadows: [shadow({ x: 9999, y: -9999, blur: 9999, spread: 0, color: '#000' })] }))
    expect(css).toBe(`${MAX_SHADOW_OFFSET}px ${-MAX_SHADOW_OFFSET}px ${MAX_SHADOW_BLUR}px 0px #000`)
  })
})

describe('clampShadow', () => {
  it('rounds + clamps numbers and normalises an unknown type to drop', () => {
    const c = clampShadow({ type: 'weird' as never, x: 2.6, y: -3.2, blur: -5, spread: 4.9, color: '#abc' })
    expect(c).toEqual({ type: 'drop', x: 3, y: -3, blur: 0, spread: 5, color: '#abc' })
  })
  it('falls back to 0 on non-finite numbers and keeps a default colour', () => {
    const c = clampShadow({ type: 'inner', x: NaN, y: Infinity, blur: NaN, spread: NaN, color: '' })
    expect(c).toEqual({ type: 'inner', x: 0, y: 0, blur: 0, spread: 0, color: DEFAULT_SHADOW.color })
  })
})
