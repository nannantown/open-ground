import { describe, it, expect } from 'vitest'
import { parseColor, alphaOf, formatColor, withAlpha, hasParsableColor } from './canvasColor'

describe('parseColor', () => {
  it('parses 6-digit hex (opaque)', () => {
    expect(parseColor('#ff8800')).toEqual({ r: 255, g: 136, b: 0, a: 1 })
  })
  it('parses 3-digit hex by nibble-doubling', () => {
    expect(parseColor('#f80')).toEqual({ r: 255, g: 136, b: 0, a: 1 })
  })
  it('parses 8-digit hex with alpha', () => {
    expect(parseColor('#ff880080')).toEqual({ r: 255, g: 136, b: 0, a: 128 / 255 })
  })
  it('parses 4-digit hex with alpha', () => {
    expect(parseColor('#f808')).toEqual({ r: 255, g: 136, b: 0, a: 0x88 / 255 })
  })
  it('parses rgb()/rgba() comma syntax', () => {
    expect(parseColor('rgb(255, 136, 0)')).toEqual({ r: 255, g: 136, b: 0, a: 1 })
    expect(parseColor('rgba(255,136,0,0.5)')).toEqual({ r: 255, g: 136, b: 0, a: 0.5 })
  })
  it('parses modern space/slash syntax with numeric or % alpha', () => {
    expect(parseColor('rgb(255 136 0 / 0.25)')).toEqual({ r: 255, g: 136, b: 0, a: 0.25 })
    expect(parseColor('rgb(255 136 0 / 50%)')).toEqual({ r: 255, g: 136, b: 0, a: 0.5 })
  })
  it('treats the transparent keyword as zero-alpha black', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })
  it('clamps out-of-range channels', () => {
    expect(parseColor('rgb(300, -20, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })
  it('returns null for unparseable colours (named / hsl / gradient / invalid hex)', () => {
    expect(parseColor('rebeccapurple')).toBeNull()
    expect(parseColor('hsl(200 50% 50%)')).toBeNull()
    expect(parseColor('linear-gradient(#fff,#000)')).toBeNull()
    expect(parseColor('#12345')).toBeNull()
    expect(parseColor('')).toBeNull()
    expect(parseColor(null)).toBeNull()
  })
})

describe('alphaOf', () => {
  it('reads alpha, defaulting to 1 for opaque / unparseable', () => {
    expect(alphaOf('#ff8800')).toBe(1)
    expect(alphaOf('#ff880000')).toBe(0)
    expect(alphaOf('rgba(0,0,0,0.4)')).toBe(0.4)
    expect(alphaOf('transparent')).toBe(0)
    expect(alphaOf('rebeccapurple')).toBe(1) // unparseable → assume opaque
    expect(alphaOf(null)).toBe(1)
  })
})

describe('formatColor', () => {
  it('drops alpha at full opacity', () => {
    expect(formatColor({ r: 255, g: 136, b: 0, a: 1 })).toBe('#ff8800')
  })
  it('appends an alpha byte below full opacity', () => {
    expect(formatColor({ r: 255, g: 136, b: 0, a: 128 / 255 })).toBe('#ff880080')
    expect(formatColor({ r: 0, g: 0, b: 0, a: 0 })).toBe('#00000000')
  })
})

describe('withAlpha', () => {
  it('round-trips: setting alpha then reading it back', () => {
    expect(withAlpha('#ff8800', 0.5)).toBe('#ff880080')
    expect(alphaOf(withAlpha('#123456', 0.25))).toBeCloseTo(0.25, 2)
  })
  it('returns #rrggbb (no alpha) at full opacity', () => {
    expect(withAlpha('#ff880080', 1)).toBe('#ff8800')
  })
  it('alpha 0 yields a zero-alpha hex (which isNoFill recognises)', () => {
    expect(withAlpha('#ff8800', 0)).toBe('#ff880000')
  })
  it('preserves RGB when only alpha changes (picker-keeps-opacity case)', () => {
    expect(withAlpha('rgba(10,20,30,0.9)', 0.3)).toBe('#0a141e4d')
  })
  it('leaves an unparseable colour untouched (no corruption)', () => {
    expect(withAlpha('rebeccapurple', 0.5)).toBe('rebeccapurple')
    expect(withAlpha('linear-gradient(#fff,#000)', 0.5)).toBe('linear-gradient(#fff,#000)')
  })
})

describe('hasParsableColor', () => {
  it('is true for hex/rgb(a), false for named/hsl/gradient/empty', () => {
    expect(hasParsableColor('#fff')).toBe(true)
    expect(hasParsableColor('rgba(0,0,0,0)')).toBe(true)
    expect(hasParsableColor('transparent')).toBe(true)
    expect(hasParsableColor('rebeccapurple')).toBe(false)
    expect(hasParsableColor('hsl(0 0% 0%)')).toBe(false)
    expect(hasParsableColor(null)).toBe(false)
  })
})
