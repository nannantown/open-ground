import { describe, it, expect } from 'vitest'
import {
  applyAutoLayout,
  elementFootprint,
  addAutoLayout,
  removeAutoLayout,
  AUTO_LAYOUT_DEFAULTS,
} from './canvasAutoLayout'
import type { CanvasElement, FrameLayout } from './types'

// Minimal element factory — only the fields the engine reads.
const el = (over: Partial<CanvasElement> & { id: string }): CanvasElement => ({
  type: 'sticky',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

const layout = (over: Partial<FrameLayout> = {}): FrameLayout => ({
  mode: 'row',
  gap: 10,
  padding: 20,
  align: 'start',
  ...over,
})

const byId = (els: CanvasElement[], id: string) => els.find((e) => e.id === id)!

describe('elementFootprint', () => {
  it('prefers explicit width/height', () => {
    expect(elementFootprint(el({ id: 'a', width: 50, height: 60 }))).toEqual({ w: 50, h: 60 })
  })
  it('falls back to per-type defaults (mirrors InfiniteCanvas.tsx)', () => {
    expect(elementFootprint(el({ id: 'a', type: 'text' }))).toEqual({ w: 300, h: 44 })
    expect(elementFootprint(el({ id: 'a', type: 'sticky' }))).toEqual({ w: 208, h: 208 })
    expect(elementFootprint(el({ id: 'a', type: 'frame' }))).toEqual({ w: 400, h: 280 })
    expect(elementFootprint(el({ id: 'a', type: 'mock' }))).toEqual({ w: 420, h: 320 })
    expect(elementFootprint(el({ id: 'a', type: 'shape' }))).toEqual({ w: 100, h: 100 })
  })
})

describe('applyAutoLayout — row / column stacking', () => {
  // Frame at (100, 100), 500×300, two sized children parented to it.
  const base = (l: FrameLayout): CanvasElement[] => [
    el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: l }),
    el({ id: 'a', parentId: 'f', x: 110, y: 110, width: 80, height: 40 }),
    el({ id: 'b', parentId: 'f', x: 300, y: 110, width: 60, height: 100 }),
  ]

  it('row: packs children left→right from x+padding with gap, cross at y+padding', () => {
    const r = applyAutoLayout(base(layout()))
    // a: x = 100+20 = 120; b: x = 120+80+10 = 210. Both y = 100+20 = 120.
    expect(byId(r, 'a')).toMatchObject({ x: 120, y: 120 })
    expect(byId(r, 'b')).toMatchObject({ x: 210, y: 120 })
    // the frame itself never moves or resizes
    expect(byId(r, 'f')).toMatchObject({ x: 100, y: 100, width: 500, height: 300 })
  })

  it('column: packs children top→bottom, sorted by current y', () => {
    // b sits above a → b stacks first.
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 300, height: 600, layout: layout({ mode: 'column', gap: 8, padding: 16 }) }),
      el({ id: 'a', parentId: 'f', x: 50, y: 400, width: 80, height: 40 }),
      el({ id: 'b', parentId: 'f', x: 50, y: 30, width: 60, height: 100 }),
    ]
    const r = applyAutoLayout(els)
    // b: y = 16; a: y = 16+100+8 = 124. Both x = 16.
    expect(byId(r, 'b')).toMatchObject({ x: 16, y: 16 })
    expect(byId(r, 'a')).toMatchObject({ x: 16, y: 124 })
  })

  it('cross-axis align: center and end (rounded to whole px)', () => {
    // row, frame h=300, padding 20 → inner = 260, crossStart = 120.
    const center = applyAutoLayout(base(layout({ align: 'center' })))
    // a (h40): 120 + (260-40)/2 = 230; b (h100): 120 + 80 = 200.
    expect(byId(center, 'a').y).toBe(230)
    expect(byId(center, 'b').y).toBe(200)
    const end = applyAutoLayout(base(layout({ align: 'end' })))
    // a: 120 + 260 - 40 = 340; b: 120 + 260 - 100 = 280.
    expect(byId(end, 'a').y).toBe(340)
    expect(byId(end, 'b').y).toBe(280)
  })

  it('reorders by current main-axis coordinate — dragging a child past a sibling swaps slots', () => {
    const r1 = applyAutoLayout(base(layout()))
    // Drag a (first slot) to the right of b, then re-apply: order flips.
    const dragged = r1.map((e) => (e.id === 'a' ? { ...e, x: 999 } : e))
    const r2 = applyAutoLayout(dragged)
    expect(byId(r2, 'b').x).toBe(120) // b now takes the first slot
    expect(byId(r2, 'a').x).toBe(190) // 120 + 60 + 10
  })

  it('uses footprint defaults for un-sized children and allows overflow past the frame edge', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 300, height: 100, layout: layout({ gap: 0, padding: 0 }) }),
      el({ id: 'a', type: 'sticky', parentId: 'f', x: 5, y: 5 }), // 208×208 default
      el({ id: 'b', type: 'sticky', parentId: 'f', x: 250, y: 5 }),
    ]
    const r = applyAutoLayout(els)
    expect(byId(r, 'a')).toMatchObject({ x: 0, y: 0 })
    expect(byId(r, 'b')).toMatchObject({ x: 208, y: 0 }) // overflows the 300px frame — allowed
  })
})

describe('applyAutoLayout — nesting', () => {
  // Outer column frame owns an inner row frame; the inner frame owns a sticky
  // ('leaf') and also has a free-form grandchild ('free') that must ride along.
  const nested = (): CanvasElement[] => [
    el({ id: 'outer', type: 'frame', x: 0, y: 0, width: 600, height: 800, layout: layout({ mode: 'column', gap: 10, padding: 20 }) }),
    el({ id: 'top', parentId: 'outer', x: 30, y: 30, width: 100, height: 50 }),
    el({ id: 'inner', type: 'frame', parentId: 'outer', x: 30, y: 200, width: 400, height: 200, layout: layout({ mode: 'row', gap: 5, padding: 10 }) }),
    el({ id: 'leaf', parentId: 'inner', x: 40, y: 210, width: 60, height: 60 }),
    el({ id: 'free', parentId: 'leaf', x: 45, y: 215, width: 10, height: 10 }),
  ]

  it('parent lays out the child frame first, then the child frame lays out its own children', () => {
    const r = applyAutoLayout(nested())
    // outer column: top → (20, 20); inner → (20, 20+50+10 = 80).
    expect(byId(r, 'top')).toMatchObject({ x: 20, y: 20 })
    expect(byId(r, 'inner')).toMatchObject({ x: 20, y: 80 })
    // inner row at its MOVED position: leaf → (20+10, 80+10) = (30, 90).
    expect(byId(r, 'leaf')).toMatchObject({ x: 30, y: 90 })
  })

  it('rigid-moves descendants of a moved child frame by the same delta', () => {
    const r = applyAutoLayout(nested())
    // 'free' is parented to 'leaf' (no layout on leaf) — it keeps its offset
    // from leaf: it started at leaf+(5,5) and must end at leaf+(5,5).
    const leaf = byId(r, 'leaf')
    expect(byId(r, 'free')).toMatchObject({ x: leaf.x + 5, y: leaf.y + 5 })
  })
})

describe('applyAutoLayout — invariants', () => {
  it('leaves frames without layout (and their children) untouched', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 300, height: 300 }),
      el({ id: 'a', parentId: 'f', x: 37, y: 91, width: 50, height: 50 }),
    ]
    expect(applyAutoLayout(els)).toBe(els) // no layout frames → input by reference
  })

  it('is idempotent — applying twice equals applying once', () => {
    const once = applyAutoLayout([
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout({ align: 'center' }) }),
      el({ id: 'a', parentId: 'f', x: 110, y: 110, width: 80, height: 40 }),
      el({ id: 'b', parentId: 'f', x: 300, y: 110, width: 60, height: 100 }),
    ])
    expect(applyAutoLayout(once)).toEqual(once)
  })

  it('returns the input array by reference when already laid out (no-op detection)', () => {
    const once = applyAutoLayout([
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
      el({ id: 'a', parentId: 'f', x: 5, y: 5, width: 80, height: 40 }),
    ])
    const twice = applyAutoLayout(once)
    expect(twice).toBe(once)
    // and only moved elements get new objects on the first pass
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
      el({ id: 'a', parentId: 'f', x: 20, y: 20, width: 80, height: 40 }), // already in slot 1
      el({ id: 'b', parentId: 'f', x: 200, y: 200, width: 60, height: 60 }),
    ]
    const r = applyAutoLayout(els)
    expect(byId(r, 'a')).toBe(els[1]) // untouched element keeps identity
    expect(byId(r, 'b')).not.toBe(els[2])
  })
})

describe('addAutoLayout (⇧A)', () => {
  let n = 0
  const mkId = () => `gen${++n}`

  it('enables in place on a single plain frame, inferring direction from its children', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 600, height: 200 }),
      el({ id: 'a', x: 20, y: 20, width: 100, height: 100, parentId: 'f' }),
      el({ id: 'b', x: 300, y: 30, width: 100, height: 100, parentId: 'f' }),
    ]
    const res = addAutoLayout(els, ['f'], mkId)!
    expect(res.selectId).toBe('f')
    expect(res.elements).toHaveLength(3) // no wrapper created
    expect(byId(res.elements, 'f').layout).toEqual({ mode: 'row', ...AUTO_LAYOUT_DEFAULTS })
  })

  it('wraps loose elements in a new auto-layout frame sized to the bbox + padding', () => {
    const els = [
      el({ id: 'a', x: 100, y: 100, width: 100, height: 100 }),
      el({ id: 'b', x: 100, y: 300, width: 100, height: 100 }),
    ]
    const res = addAutoLayout(els, ['a', 'b'], mkId)!
    const frame = byId(res.elements, res.selectId)
    expect(frame.type).toBe('frame')
    expect(frame.layout?.mode).toBe('column') // taller spread than wide
    const pad = AUTO_LAYOUT_DEFAULTS.padding
    expect({ x: frame.x, y: frame.y, w: frame.width, h: frame.height }).toEqual({
      x: 100 - pad,
      y: 100 - pad,
      w: 100 + pad * 2,
      h: 300 + pad * 2,
    })
    expect(byId(res.elements, 'a').parentId).toBe(frame.id)
    expect(byId(res.elements, 'b').parentId).toBe(frame.id)
  })

  it('wraps an ALREADY auto-layout frame instead of toggling it (Figma ⇧A)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 200, height: 200, layout: layout() }),
    ]
    const res = addAutoLayout(els, ['f'], mkId)!
    expect(res.selectId).not.toBe('f')
    expect(byId(res.elements, 'f').parentId).toBe(res.selectId)
    expect(byId(res.elements, res.selectId).layout).toBeDefined()
  })

  it('re-parents only the selection top-level: a selected child of a selected frame rides along', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 200, height: 200, layout: layout() }),
      el({ id: 'a', x: 20, y: 20, width: 50, height: 50, parentId: 'f' }),
    ]
    const res = addAutoLayout(els, ['f', 'a'], mkId)!
    expect(byId(res.elements, 'a').parentId).toBe('f') // untouched
    expect(byId(res.elements, 'f').parentId).toBe(res.selectId)
  })

  it('the wrapper inherits the members’ common parent', () => {
    const els = [
      el({ id: 'outer', type: 'frame', x: 0, y: 0, width: 800, height: 800 }),
      el({ id: 'a', x: 50, y: 50, width: 100, height: 100, parentId: 'outer' }),
      el({ id: 'b', x: 200, y: 50, width: 100, height: 100, parentId: 'outer' }),
    ]
    const res = addAutoLayout(els, ['a', 'b'], mkId)!
    expect(byId(res.elements, res.selectId).parentId).toBe('outer')
  })

  it('returns null for empty / comment-only selections', () => {
    const els = [el({ id: 'c', type: 'comment', x: 0, y: 0 })]
    expect(addAutoLayout(els, ['c'], mkId)).toBeNull()
    expect(addAutoLayout(els, ['missing'], mkId)).toBeNull()
  })
})

describe('removeAutoLayout (⌥⇧A)', () => {
  it('strips layout from selected layout frames, keeping positions', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 200, height: 200, layout: layout() }),
      el({ id: 'a', x: 20, y: 20, parentId: 'f' }),
    ]
    const res = removeAutoLayout(els, ['f'])!
    expect(byId(res, 'f').layout).toBeUndefined()
    expect(byId(res, 'a')).toBe(els[1]) // children untouched
  })

  it('returns null when the selection holds no layout frame', () => {
    const els = [el({ id: 'f', type: 'frame', x: 0, y: 0 })]
    expect(removeAutoLayout(els, ['f'])).toBeNull()
  })
})
