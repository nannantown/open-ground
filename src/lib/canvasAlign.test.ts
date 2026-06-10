import { describe, it, expect } from 'vitest'
import { alignElements, type AlignItem } from './canvasAlign'

// Three boxes of different sizes at different positions.
const items: AlignItem[] = [
  { id: 'a', x: 0, y: 0, w: 100, h: 40 },
  { id: 'b', x: 50, y: 100, w: 60, h: 80 },
  { id: 'c', x: 200, y: 30, w: 40, h: 20 },
]
const byId = (r: { id: string; x: number; y: number }[], id: string) => r.find((e) => e.id === id)!

describe('alignElements — align (≥2)', () => {
  it('left aligns all x to the min left edge', () => {
    const r = alignElements(items, 'left')
    expect(r.every((e) => e.x === 0)).toBe(true)
    // y is preserved
    expect(byId(r, 'b').y).toBe(100)
  })
  it('right aligns all right edges to the max right edge (240)', () => {
    const r = alignElements(items, 'right')
    expect(byId(r, 'a').x).toBe(140) // 240-100
    expect(byId(r, 'b').x).toBe(180) // 240-60
    expect(byId(r, 'c').x).toBe(200) // 240-40
  })
  it('hcenter centres every box on the group mid-x', () => {
    // group spans x:0..240 → centre 120; each x = 120 - w/2
    const r = alignElements(items, 'hcenter')
    expect(byId(r, 'a').x).toBe(70) // 120-50
    expect(byId(r, 'b').x).toBe(90) // 120-30
    expect(byId(r, 'c').x).toBe(100) // 120-20
  })
  it('top / bottom / vmiddle work on the Y axis', () => {
    expect(alignElements(items, 'top').every((e) => e.y === 0)).toBe(true)
    // group spans y:0..180 → bottom edge 180
    const b = alignElements(items, 'bottom')
    expect(byId(b, 'a').y).toBe(140) // 180-40
    // middle: centre 90; a.y = 90-20 = 70
    const m = alignElements(items, 'vmiddle')
    expect(byId(m, 'a').y).toBe(70)
  })
  it('returns [] for fewer than 2 items', () => {
    expect(alignElements([items[0]], 'left')).toEqual([])
  })
})

describe('alignElements — distribute (≥3)', () => {
  it('hdistribute equalises the horizontal gaps, keeping the extremes', () => {
    // sorted by x: a(0,w100), b(50,w60), c(200,w40). span=240, sumW=200, gap=20.
    // a stays at 0; b at 0+100+20=120; c at 120+60+20=200 (last ends at its right).
    const r = alignElements(items, 'hdistribute')
    expect(byId(r, 'a').x).toBe(0)
    expect(byId(r, 'b').x).toBe(120)
    expect(byId(r, 'c').x).toBe(200)
    // the gap a.right→b.left == b.right→c.left
    const a = byId(r, 'a')
    const b = byId(r, 'b')
    const c = byId(r, 'c')
    expect(b.x - (a.x + 100)).toBe(c.x - (b.x + 60))
  })
  it('vdistribute equalises vertical gaps', () => {
    // sorted by y: a(0,h40), c(30,h20), b(100,h80). span=180, sumH=140, gap=20.
    // a@0; c@0+40+20=60; b@60+20+20=100.
    const r = alignElements(items, 'vdistribute')
    expect(byId(r, 'a').y).toBe(0)
    expect(byId(r, 'c').y).toBe(60)
    expect(byId(r, 'b').y).toBe(100)
  })
  it('returns [] for fewer than 3 items', () => {
    expect(alignElements([items[0], items[1]], 'hdistribute')).toEqual([])
  })
  it('preserves input order in the result (not sorted order)', () => {
    const r = alignElements(items, 'hdistribute')
    expect(r.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})
