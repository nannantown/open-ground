import { describe, it, expect } from 'vitest'
import { unionBounds, resizeGroup, type GResizeItem } from './canvasGroupResize'

describe('unionBounds', () => {
  it('spans all items', () => {
    const b = unionBounds([
      { x: 0, y: 0, w: 100, h: 50 },
      { x: 200, y: 100, w: 40, h: 60 },
    ])
    expect(b).toEqual({ x: 0, y: 0, w: 240, h: 160 })
  })
  it('returns null when empty', () => {
    expect(unionBounds([])).toBeNull()
  })
})

describe('resizeGroup', () => {
  const items: GResizeItem[] = [
    { id: 'a', x: 0, y: 0, w: 100, h: 100, sizable: true },
    { id: 'b', x: 200, y: 200, w: 100, h: 100, sizable: true },
  ]
  const anchor = { x: 0, y: 0 }

  it('scales positions AND sizes of sizable items about the anchor', () => {
    const r = resizeGroup(items, anchor, 2, 2)
    expect(r.find((u) => u.id === 'a')).toEqual({ id: 'a', x: 0, y: 0, w: 200, h: 200 })
    // b moves 2× from anchor and doubles in size
    expect(r.find((u) => u.id === 'b')).toEqual({ id: 'b', x: 400, y: 400, w: 200, h: 200 })
  })

  it('keeps the anchor element pinned at 1× from origin', () => {
    const r = resizeGroup(items, anchor, 0.5, 0.5)
    expect(r.find((u) => u.id === 'a')).toEqual({ id: 'a', x: 0, y: 0, w: 50, h: 50 })
    expect(r.find((u) => u.id === 'b')).toEqual({ id: 'b', x: 100, y: 100, w: 50, h: 50 })
  })

  it('repositions non-sizable items but leaves their size untouched', () => {
    const mixed: GResizeItem[] = [
      { id: 'box', x: 0, y: 0, w: 100, h: 100, sizable: true },
      { id: 'txt', x: 200, y: 0, w: 300, h: 44, sizable: false },
    ]
    const r = resizeGroup(mixed, anchor, 2, 2)
    const txt = r.find((u) => u.id === 'txt')!
    expect(txt.x).toBe(400) // position scaled
    expect(txt.y).toBe(0)
    expect(txt.w).toBeUndefined() // size NOT scaled
    expect(txt.h).toBeUndefined()
  })

  it('scales about a non-zero anchor', () => {
    const r = resizeGroup(
      [{ id: 'a', x: 100, y: 100, w: 50, h: 50, sizable: true }],
      { x: 100, y: 100 },
      2,
      2,
    )
    // anchored item stays at the anchor, grows in place
    expect(r[0]).toEqual({ id: 'a', x: 100, y: 100, w: 100, h: 100 })
  })

  it('never lets a sizable dimension round to 0', () => {
    const r = resizeGroup([{ id: 'a', x: 0, y: 0, w: 10, h: 10, sizable: true }], anchor, 0.01, 0.01)
    expect(r[0].w).toBeGreaterThanOrEqual(1)
    expect(r[0].h).toBeGreaterThanOrEqual(1)
  })
})
