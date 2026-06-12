import { describe, it, expect } from 'vitest'
import { alignElements, alignElementsToBox, type AlignBox, type AlignItem } from './canvasAlign'

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

// Parent-frame rectangle used as the external reference for the box variant.
const box: AlignBox = { x: 100, y: 200, w: 400, h: 300 }

describe('alignElementsToBox — align (≥1, Figma: single child in its frame)', () => {
  it('hcenter centres a single item on the box mid-x, preserving y', () => {
    // box centre-x = 300 → x = 300 - 50 = 250
    const r = alignElementsToBox([items[0]], box, 'hcenter')
    expect(r).toEqual([{ id: 'a', x: 250, y: 0 }])
  })
  it('vmiddle centres a single item on the box mid-y, preserving x', () => {
    // box centre-y = 350 → y = 350 - 20 = 330
    const r = alignElementsToBox([items[0]], box, 'vmiddle')
    expect(r).toEqual([{ id: 'a', x: 0, y: 330 }])
  })
  it('right puts a single item flush with the box right edge (500)', () => {
    const r = alignElementsToBox([items[0]], box, 'right')
    expect(r).toEqual([{ id: 'a', x: 400, y: 0 }]) // 500-100
  })
  it('bottom puts a single item flush with the box bottom edge (500)', () => {
    const r = alignElementsToBox([items[0]], box, 'bottom')
    expect(r).toEqual([{ id: 'a', x: 0, y: 460 }]) // 500-40
  })
  it('left / top snap every item to the same box edge', () => {
    const l = alignElementsToBox(items, box, 'left')
    expect(l.every((e) => e.x === 100)).toBe(true)
    const t = alignElementsToBox(items, box, 'top')
    expect(t.every((e) => e.y === 200)).toBe(true)
  })
  it('multi-item right aligns every right edge to box.x + box.w', () => {
    const r = alignElementsToBox(items, box, 'right')
    expect(byId(r, 'a').x).toBe(400) // 500-100
    expect(byId(r, 'b').x).toBe(440) // 500-60
    expect(byId(r, 'c').x).toBe(460) // 500-40
    // y is preserved
    expect(byId(r, 'b').y).toBe(100)
  })
})

describe('alignElementsToBox — distribute (≥2, full box span)', () => {
  it('hdistribute spans the full box width with equal gaps', () => {
    // sorted by x: a(w100), b(w60), c(w40). box.w=400, sumW=200, gap=100.
    // a@100; b@100+100+100=300; c@300+60+100=460 (right edge 500 = box right).
    const r = alignElementsToBox(items, box, 'hdistribute')
    expect(byId(r, 'a').x).toBe(100)
    expect(byId(r, 'b').x).toBe(300)
    expect(byId(r, 'c').x).toBe(460)
    // y is preserved
    expect(byId(r, 'b').y).toBe(100)
  })
  it('vdistribute spans the full box height with equal gaps', () => {
    // sorted by y: a(h40), c(h20), b(h80). box.h=300, sumH=140, gap=80.
    // a@200; c@200+40+80=320; b@320+20+80=420 (bottom edge 500 = box bottom).
    const r = alignElementsToBox(items, box, 'vdistribute')
    expect(byId(r, 'a').y).toBe(200)
    expect(byId(r, 'c').y).toBe(320)
    expect(byId(r, 'b').y).toBe(420)
  })
  it('keeps items in order even when they overflow the box width', () => {
    // Two 100-wide items in a 150-wide box: gap = (150-200)/1 = -50 — they
    // overlap but stay left-to-right and pin to the box edges.
    const tight: AlignBox = { x: 0, y: 0, w: 150, h: 100 }
    const two: AlignItem[] = [
      { id: 'p', x: 5, y: 0, w: 100, h: 10 },
      { id: 'q', x: 30, y: 0, w: 100, h: 10 },
    ]
    const r = alignElementsToBox(two, tight, 'hdistribute')
    expect(byId(r, 'p').x).toBe(0)
    expect(byId(r, 'q').x).toBe(50) // right edge 150 = box right
  })
  it('returns [] for a single item', () => {
    expect(alignElementsToBox([items[0]], box, 'hdistribute')).toEqual([])
    expect(alignElementsToBox([items[0]], box, 'vdistribute')).toEqual([])
  })
  it('returns [] for an empty selection on any op', () => {
    expect(alignElementsToBox([], box, 'hcenter')).toEqual([])
  })
})
