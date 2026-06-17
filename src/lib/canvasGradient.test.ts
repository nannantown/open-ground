import { describe, it, expect } from 'vitest'
import {
  isGradient,
  parseGradient,
  formatGradient,
  defaultGradient,
  type Gradient,
} from './canvasGradient'

describe('isGradient', () => {
  it('detects linear / radial gradients, case-insensitively', () => {
    expect(isGradient('linear-gradient(180deg, #000, #fff)')).toBe(true)
    expect(isGradient('RADIAL-GRADIENT(circle, #000, #fff)')).toBe(true)
  })
  it('rejects solid colours and junk', () => {
    expect(isGradient('#ff0000')).toBe(false)
    expect(isGradient('rgba(0,0,0,0.5)')).toBe(false)
    expect(isGradient('transparent')).toBe(false)
    expect(isGradient(null)).toBe(false)
  })
})

describe('parseGradient / formatGradient round-trip', () => {
  it('round-trips a canonical linear gradient', () => {
    const css = 'linear-gradient(90deg, #ff0000 0%, #0000ff 100%)'
    const g = parseGradient(css)!
    expect(g.type).toBe('linear')
    expect(g.angle).toBe(90)
    expect(g.stops).toEqual([
      { color: '#ff0000', pos: 0 },
      { color: '#0000ff', pos: 1 },
    ])
    expect(formatGradient(g)).toBe(css)
  })
  it('round-trips a radial gradient', () => {
    const g = parseGradient('radial-gradient(circle, #000000 0%, #ffffff 100%)')!
    expect(g.type).toBe('radial')
    expect(formatGradient(g)).toBe('radial-gradient(circle, #000000 0%, #ffffff 100%)')
  })
  it('preserves alpha stops as #rrggbbaa', () => {
    const g = parseGradient('linear-gradient(0deg, #ff000080 0%, #00ff00 100%)')!
    expect(g.stops[0].color).toBe('#ff000080')
  })
  it('parses rgb()/rgba() stops (paren-aware split) without breaking on commas', () => {
    const g = parseGradient('linear-gradient(45deg, rgb(255, 0, 0) 0%, rgba(0,0,255,0.5) 100%)')!
    expect(g.stops).toHaveLength(2)
    expect(g.stops[0].color).toBe('#ff0000')
    expect(g.stops[1].color).toBe('#0000ff80')
  })
  it('spreads bare (position-less) stops evenly and sorts them', () => {
    const g = parseGradient('linear-gradient(180deg, #000000, #888888, #ffffff)')!
    expect(g.stops.map((s) => s.pos)).toEqual([0, 0.5, 1])
  })
  it('maps "to right" direction to 90deg', () => {
    expect(parseGradient('linear-gradient(to right, #000 0%, #fff 100%)')!.angle).toBe(90)
  })
  it('defaults a directionless linear gradient to 180deg', () => {
    expect(parseGradient('linear-gradient(#000000 0%, #ffffff 100%)')!.angle).toBe(180)
  })
  it('normalises the angle into [0,360)', () => {
    expect(parseGradient('linear-gradient(-90deg, #000 0%, #fff 100%)')!.angle).toBe(270)
  })
  it('sorts stops by position on format', () => {
    const g: Gradient = {
      type: 'linear',
      angle: 0,
      stops: [
        { color: '#ffffff', pos: 1 },
        { color: '#000000', pos: 0 },
      ],
    }
    expect(formatGradient(g)).toBe('linear-gradient(0deg, #000000 0%, #ffffff 100%)')
  })
  it('returns null for non-gradients and undecodable stops', () => {
    expect(parseGradient('#ff0000')).toBeNull()
    expect(parseGradient('linear-gradient(90deg, not-a-color 0%, #fff 100%)')).toBeNull()
  })
})

describe('defaultGradient', () => {
  it('seeds the first stop from the base colour, second stop white', () => {
    const g = defaultGradient('#3366ff')
    expect(g.type).toBe('linear')
    expect(g.stops[0]).toEqual({ color: '#3366ff', pos: 0 })
    expect(g.stops[1]).toEqual({ color: '#ffffff', pos: 1 })
    expect(formatGradient(g)).toContain('#3366ff 0%')
  })
  it('drops alpha from the base colour seed (opaque first stop)', () => {
    expect(defaultGradient('#3366ff80').stops[0].color).toBe('#3366ff')
  })
  it('can seed a radial gradient', () => {
    expect(defaultGradient('#000000', 'radial').type).toBe('radial')
  })
})
