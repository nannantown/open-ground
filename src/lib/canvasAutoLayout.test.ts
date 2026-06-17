import { describe, it, expect } from 'vitest'
import {
  applyAutoLayout,
  applyAutoLayoutDuringResize,
  elementFootprint,
  resolvedPadding,
  normalizeLayoutOrder,
  layoutInsertionIndex,
  layoutFrameAt,
  layoutDropSlot,
  layoutDropPreview,
  insertIntoLayoutAtPoint,
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

describe('resolvedPadding', () => {
  it('falls back every side to the legacy single padding', () => {
    expect(resolvedPadding(layout())).toEqual({ top: 20, right: 20, bottom: 20, left: 20 })
  })
  it('per-side values override only their own side (0 is a valid override)', () => {
    expect(resolvedPadding(layout({ paddingLeft: 4, paddingTop: 6 }))).toEqual({
      top: 6,
      right: 20,
      bottom: 20,
      left: 4,
    })
    expect(resolvedPadding(layout({ paddingRight: 0, paddingBottom: 0 }))).toEqual({
      top: 20,
      right: 0,
      bottom: 0,
      left: 20,
    })
  })
})

describe('applyAutoLayout — row / column stacking (array order)', () => {
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
    // the frame itself never moves or resizes (both axes default to 'fixed')
    expect(byId(r, 'f')).toMatchObject({ x: 100, y: 100, width: 500, height: 300 })
  })

  it('column: packs children top→bottom in ARRAY order, ignoring current positions', () => {
    // b sits above a on canvas, but a comes first in the array → a stacks first.
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 300, height: 600, layout: layout({ mode: 'column', gap: 8, padding: 16 }) }),
      el({ id: 'a', parentId: 'f', x: 50, y: 400, width: 80, height: 40 }),
      el({ id: 'b', parentId: 'f', x: 50, y: 30, width: 60, height: 100 }),
    ]
    const r = applyAutoLayout(els)
    // a: y = 16; b: y = 16+40+8 = 64. Both x = 16.
    expect(byId(r, 'a')).toMatchObject({ x: 16, y: 16 })
    expect(byId(r, 'b')).toMatchObject({ x: 16, y: 64 })
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

  it('dragging a child does NOT reorder — it snaps back to its array slot', () => {
    const r1 = applyAutoLayout(base(layout()))
    const dragged = r1.map((e) => (e.id === 'a' ? { ...e, x: 999 } : e))
    const r2 = applyAutoLayout(dragged)
    expect(byId(r2, 'a').x).toBe(120) // array slot 0 — position is not the order
    expect(byId(r2, 'b').x).toBe(210)
  })

  it('splicing the array reorders (the gesture-side contract)', () => {
    const els = base(layout())
    const spliced = [els[0], els[2], els[1]] // b now precedes a
    const r = applyAutoLayout(spliced)
    expect(byId(r, 'b').x).toBe(120)
    expect(byId(r, 'a').x).toBe(190) // 120 + 60 + 10
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

describe('applyAutoLayout — per-side padding', () => {
  it('packs from paddingLeft/paddingTop, other sides falling back to padding', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout({ paddingLeft: 4, paddingTop: 6 }) }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
    ]
    expect(byId(applyAutoLayout(els), 'a')).toMatchObject({ x: 104, y: 106 })
  })
  it('align end measures against the cross-end side (paddingBottom)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout({ align: 'end', paddingTop: 6, paddingBottom: 30 }) }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
    ]
    // crossStart = 106, innerCross = 300-6-30 = 264 → y = 106 + 264 - 40 = 330.
    expect(byId(applyAutoLayout(els), 'a').y).toBe(330)
  })
})

describe('applyAutoLayout — justify (main axis)', () => {
  // innerMain = 500 - 40 = 460; children 80 + 60, gap 10 → content 150.
  const base = (l: FrameLayout): CanvasElement[] => [
    el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: l }),
    el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
    el({ id: 'b', parentId: 'f', x: 0, y: 0, width: 60, height: 100 }),
  ]

  it('center shifts the packed block by half the leftover', () => {
    const r = applyAutoLayout(base(layout({ justify: 'center' })))
    // leftover = 460 - 150 = 310 → a x = 120 + 155 = 275; b = 275+80+10 = 365.
    expect(byId(r, 'a').x).toBe(275)
    expect(byId(r, 'b').x).toBe(365)
  })

  it('end packs against main-end padding', () => {
    const r = applyAutoLayout(base(layout({ justify: 'end' })))
    expect(byId(r, 'a').x).toBe(430) // 120 + 310
    expect(byId(r, 'b').x).toBe(520) // ends at 580 = frame right - padding
  })

  it('space-between ignores gap and splits the leftover into (n-1) equal spacings', () => {
    const r = applyAutoLayout(base(layout({ justify: 'space-between' })))
    // leftover = 460 - 140 = 320 (gap ignored) → a at start, b flush at end.
    expect(byId(r, 'a').x).toBe(120)
    expect(byId(r, 'b').x).toBe(520) // 120 + 80 + 320; right edge 580
  })

  it('space-between with a single child centres it', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout({ justify: 'space-between' }) }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
    ]
    // 120 + (460 - 80)/2 = 310.
    expect(byId(applyAutoLayout(els), 'a').x).toBe(310)
  })

  it('space-between with negative leftover packs at start with spacing 0 (overflow)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 160, height: 300, layout: layout({ justify: 'space-between' }) }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
      el({ id: 'b', parentId: 'f', x: 0, y: 0, width: 60, height: 100 }),
    ]
    const r = applyAutoLayout(els)
    expect(byId(r, 'a').x).toBe(120)
    expect(byId(r, 'b').x).toBe(200) // 120 + 80 + 0 — overflows the frame
  })
})

describe('applyAutoLayout — hidden / comment children take no slot', () => {
  it('a hidden child keeps its position and the visible siblings close the gap', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
      el({ id: 'h', parentId: 'f', x: 777, y: 777, width: 50, height: 50, hidden: true }),
      el({ id: 'b', parentId: 'f', x: 0, y: 0, width: 60, height: 100 }),
    ]
    const r = applyAutoLayout(els)
    expect(byId(r, 'a')).toMatchObject({ x: 20, y: 20 })
    expect(byId(r, 'b')).toMatchObject({ x: 110, y: 20 }) // 20+80+10 — h occupies no slot
    expect(byId(r, 'h')).toBe(els[2]) // untouched, by reference
  })
  it('comment pins are not layout children', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
      el({ id: 'c', type: 'comment', parentId: 'f', x: 5, y: 5 }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
    ]
    const r = applyAutoLayout(els)
    expect(byId(r, 'a')).toMatchObject({ x: 20, y: 20 })
    expect(byId(r, 'c')).toBe(els[1])
  })
})

describe('applyAutoLayout — hug sizing', () => {
  const kids = () => [
    el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
    el({ id: 'b', parentId: 'f', x: 0, y: 0, width: 60, height: 100 }),
  ]

  it('primarySizing hug: frame main = Σ children + gaps + main padding; x/y anchored', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout({ primarySizing: 'hug' }) }),
      ...kids(),
    ]
    const r = applyAutoLayout(els)
    // 80 + 60 + 10 + 20*2 = 190; height (fixed axis) untouched.
    expect(byId(r, 'f')).toMatchObject({ x: 100, y: 100, width: 190, height: 300 })
    expect(byId(r, 'a').x).toBe(120)
    expect(byId(r, 'b').x).toBe(210)
  })

  it('counterSizing hug: frame cross = max child + cross padding', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout({ counterSizing: 'hug' }) }),
      ...kids(),
    ]
    expect(byId(applyAutoLayout(els), 'f')).toMatchObject({ width: 500, height: 140 }) // 100 + 20*2
  })

  it('a hug axis with no children shrinks to the padding sum', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout({ primarySizing: 'hug', counterSizing: 'hug', paddingLeft: 4 }) }),
    ]
    expect(byId(applyAutoLayout(els), 'f')).toMatchObject({ width: 24, height: 40 })
  })

  it('fill children count at their natural size on a hug axis (Figma)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout({ primarySizing: 'hug' }) }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
      el({ id: 'b', parentId: 'f', x: 0, y: 0, width: 60, height: 100, fillMain: true }),
    ]
    const r = applyAutoLayout(els)
    expect(byId(r, 'f').width).toBe(190)
    expect(byId(r, 'b').width).toBe(60) // not stretched
  })

  it('nested hug converges in ONE apply (inner hugs first, outer sums the hugged size)', () => {
    const els = [
      el({ id: 'outer', type: 'frame', x: 0, y: 0, width: 300, height: 999, layout: layout({ mode: 'column', gap: 5, padding: 10, primarySizing: 'hug' }) }),
      el({ id: 'top', parentId: 'outer', x: 0, y: 0, width: 100, height: 20 }),
      el({ id: 'inner', type: 'frame', parentId: 'outer', x: 0, y: 0, width: 100, height: 999, layout: layout({ mode: 'column', gap: 4, padding: 8, primarySizing: 'hug' }) }),
      el({ id: 'leaf', parentId: 'inner', x: 0, y: 0, width: 50, height: 30 }),
    ]
    const once = applyAutoLayout(els)
    expect(byId(once, 'inner').height).toBe(46) // 30 + 8*2
    expect(byId(once, 'outer').height).toBe(91) // 20 + 46 + 5 + 10*2 — not the stale 999
    expect(byId(once, 'leaf')).toMatchObject({ x: 18, y: 43 })
    expect(applyAutoLayout(once)).toBe(once) // fixed point after a single apply
  })
})

describe('applyAutoLayout — fill children (frame axis fixed)', () => {
  it('fillMain takes the leftover main interior (engine writes the size)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout() }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
      el({ id: 'b', parentId: 'f', x: 0, y: 0, width: 60, height: 100, fillMain: true }),
    ]
    const r = applyAutoLayout(els)
    // 460 - 80 - 10 = 370; cross size untouched.
    expect(byId(r, 'b')).toMatchObject({ x: 210, width: 370, height: 100 })
    expect(byId(r, 'a').width).toBe(80)
  })

  it('several fillMain children split the leftover equally (floored to whole px)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout() }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40, fillMain: true }),
      el({ id: 'b', parentId: 'f', x: 0, y: 0, width: 60, height: 100, fillMain: true }),
    ]
    const r = applyAutoLayout(els)
    expect(byId(r, 'a')).toMatchObject({ x: 120, width: 225 }) // floor((460-10)/2)
    expect(byId(r, 'b')).toMatchObject({ x: 355, width: 225 }) // 120 + 225 + 10
  })

  it('fillCross stretches to the padded cross interior (align becomes moot)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout({ align: 'center' }) }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40, fillCross: true }),
    ]
    expect(byId(applyAutoLayout(els), 'a')).toMatchObject({ y: 120, height: 260 })
  })

  it('fill never collapses below 1px (overflowing frame)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 60, height: 300, layout: layout() }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40 }),
      el({ id: 'b', parentId: 'f', x: 0, y: 0, width: 60, height: 100, fillMain: true }),
    ]
    expect(byId(applyAutoLayout(els), 'b').width).toBe(1)
  })

  it('a child frame hugging that axis is not stretched (hug wins over fill)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
      el({ id: 'inner', type: 'frame', parentId: 'f', x: 0, y: 0, width: 400, height: 100, fillMain: true, layout: layout({ gap: 4, padding: 8, primarySizing: 'hug' }) }),
      el({ id: 'leaf', parentId: 'inner', x: 0, y: 0, width: 50, height: 30 }),
    ]
    expect(byId(applyAutoLayout(els), 'inner').width).toBe(66) // 50 + 8*2 — hug, not 460
  })

  it('a nested frame resized by fill lays out its own children at the NEW size', () => {
    const els = [
      el({ id: 'outer', type: 'frame', x: 0, y: 0, width: 600, height: 300, layout: layout({ gap: 0, padding: 0 }) }),
      el({ id: 'inner', type: 'frame', parentId: 'outer', x: 0, y: 0, width: 100, height: 300, fillMain: true, layout: layout({ mode: 'column', gap: 0, padding: 0, align: 'center' }) }),
      el({ id: 'c', parentId: 'inner', x: 0, y: 0, width: 100, height: 50 }),
    ]
    const r = applyAutoLayout(els)
    expect(byId(r, 'inner').width).toBe(600)
    expect(byId(r, 'c').x).toBe(250) // centred in the new 600px interior, not the old 100px
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

  it('is idempotent across the v2 features combined', () => {
    const once = applyAutoLayout([
      el({ id: 'f', type: 'frame', x: 100, y: 100, width: 500, height: 300, layout: layout({ align: 'center', justify: 'center', counterSizing: 'hug', paddingLeft: 4 }) }),
      el({ id: 'a', parentId: 'f', x: 110, y: 110, width: 80, height: 40 }),
      el({ id: 'b', parentId: 'f', x: 300, y: 110, width: 60, height: 100, fillMain: true }),
      el({ id: 'h', parentId: 'f', x: 7, y: 7, width: 9, height: 9, hidden: true }),
    ])
    expect(applyAutoLayout(once)).toEqual(once)
    expect(applyAutoLayout(once)).toBe(once)
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

  it('already-hugged frames and already-filled children are a reference no-op', () => {
    const els = applyAutoLayout([
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout({ counterSizing: 'hug' }) }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 80, height: 40, fillMain: true }),
    ])
    expect(applyAutoLayout(els)).toBe(els)
  })
})

describe('normalizeLayoutOrder', () => {
  it('re-orders a layout frame’s children in the array to match main-axis positions, keeping their index slots', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
      el({ id: 'b', parentId: 'f', x: 300, y: 20, width: 60, height: 60 }),
      el({ id: 'x', x: 900, y: 900 }), // unrelated — must keep its index (z interleaving)
      el({ id: 'a', parentId: 'f', x: 100, y: 20, width: 60, height: 60 }),
    ]
    const r = normalizeLayoutOrder(els)
    expect(r.map((e) => e.id)).toEqual(['f', 'a', 'x', 'b'])
    expect(byId(r, 'a')).toBe(els[3]) // a pure permutation — same objects
  })

  it('column frames sort by y', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 300, height: 600, layout: layout({ mode: 'column' }) }),
      el({ id: 'b', parentId: 'f', x: 16, y: 200, width: 60, height: 60 }),
      el({ id: 'a', parentId: 'f', x: 16, y: 16, width: 60, height: 60 }),
    ]
    expect(normalizeLayoutOrder(els).map((e) => e.id)).toEqual(['f', 'a', 'b'])
  })

  it('leaves an engine-consistent file alone even when positions are not monotone (negative gap) — no load/edit flip-flop', () => {
    // Hand-written negative gap: array order a,b but b packs BEFORE a's right
    // edge — positions are exactly what the engine produces from this array,
    // so the consistency gate must skip the sort (a position sort would swap
    // a/b, the next apply would re-pack the swapped order, and the file would
    // flip-flop on every load→edit→save cycle, forever).
    const base = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 300, height: 100, layout: layout({ gap: -20, padding: 20 }) }),
      el({ id: 'a', parentId: 'f', x: 0, y: 0, width: 30, height: 30 }),
      el({ id: 'b', parentId: 'f', x: 0, y: 0, width: 30, height: 30 }),
    ]
    const laid = applyAutoLayout(base)
    // sanity: the negative gap makes b overlap into a (non-monotone layout)
    expect(byId(laid, 'b').x).toBeLessThan(byId(laid, 'a').x + 30)
    expect(normalizeLayoutOrder(laid)).toBe(laid)
    // …and the engine agrees it is a fixed point (stable across sessions).
    expect(applyAutoLayout(laid)).toBe(laid)
  })

  it('hidden children and comments keep their array position (only flow members sort)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
      el({ id: 'h', parentId: 'f', x: 999, y: 0, width: 9, height: 9, hidden: true }),
      el({ id: 'b', parentId: 'f', x: 300, y: 20, width: 60, height: 60 }),
      el({ id: 'a', parentId: 'f', x: 100, y: 20, width: 60, height: 60 }),
    ]
    expect(normalizeLayoutOrder(els).map((e) => e.id)).toEqual(['f', 'h', 'a', 'b'])
  })

  it('is idempotent and a reference no-op when already ordered (ties keep array order)', () => {
    const ordered = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
      el({ id: 'a', parentId: 'f', x: 100, y: 20, width: 60, height: 60 }),
      el({ id: 'tie', parentId: 'f', x: 100, y: 20, width: 60, height: 60 }), // same x — stays after a
      el({ id: 'b', parentId: 'f', x: 300, y: 20, width: 60, height: 60 }),
    ]
    expect(normalizeLayoutOrder(ordered)).toBe(ordered)
    const shuffled = [ordered[0], ordered[3], ordered[1], ordered[2]]
    const once = normalizeLayoutOrder(shuffled)
    expect(once.map((e) => e.id)).toEqual(['f', 'a', 'tie', 'b'])
    expect(normalizeLayoutOrder(once)).toBe(once)
  })

  it('leaves non-layout frames alone', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300 }),
      el({ id: 'b', parentId: 'f', x: 300, y: 20 }),
      el({ id: 'a', parentId: 'f', x: 100, y: 20 }),
    ]
    expect(normalizeLayoutOrder(els)).toBe(els)
  })
})

describe('layoutInsertionIndex', () => {
  const rowEls = [
    el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
    el({ id: 'a', parentId: 'f', x: 20, y: 20, width: 80, height: 40 }), // mid x = 60
    el({ id: 'b', parentId: 'f', x: 110, y: 20, width: 60, height: 100 }), // mid x = 140
  ]

  it('row: before the first midpoint → 0, between midpoints → 1, past the last → n', () => {
    expect(layoutInsertionIndex(rowEls, 'f', { x: 30, y: 50 })).toBe(0)
    expect(layoutInsertionIndex(rowEls, 'f', { x: 100, y: 50 })).toBe(1)
    expect(layoutInsertionIndex(rowEls, 'f', { x: 400, y: 50 })).toBe(2)
  })

  it('column: compares y midpoints', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 300, height: 600, layout: layout({ mode: 'column' }) }),
      el({ id: 'a', parentId: 'f', x: 16, y: 16, width: 60, height: 40 }), // mid y = 36
      el({ id: 'b', parentId: 'f', x: 16, y: 70, width: 60, height: 100 }), // mid y = 120
    ]
    expect(layoutInsertionIndex(els, 'f', { x: 30, y: 10 })).toBe(0)
    expect(layoutInsertionIndex(els, 'f', { x: 30, y: 80 })).toBe(1)
    expect(layoutInsertionIndex(els, 'f', { x: 30, y: 500 })).toBe(2)
  })

  it('an empty frame → 0', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 300, layout: layout() }),
    ]
    expect(layoutInsertionIndex(els, 'f', { x: 250, y: 150 })).toBe(0)
  })

  it('hidden / comment children do not count as slots', () => {
    const els = [
      ...rowEls,
      el({ id: 'h', parentId: 'f', x: 0, y: 0, width: 10, height: 10, hidden: true }),
      el({ id: 'c', type: 'comment', parentId: 'f', x: 0, y: 0 }),
    ]
    expect(layoutInsertionIndex(els, 'f', { x: 400, y: 50 })).toBe(2)
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

  it('the wrap frame is TRANSPARENT + borderless — a grouping container, not a drawn artboard (Figma)', () => {
    const els = [
      el({ id: 'a', x: 100, y: 100, width: 100, height: 100 }),
      el({ id: 'b', x: 100, y: 300, width: 100, height: 100 }),
    ]
    const res = addAutoLayout(els, ['a', 'b'], mkId)!
    const frame = byId(res.elements, res.selectId)
    expect(frame.fill).toBe('transparent')
    expect(frame.strokeWidth).toBe(0)
  })

  it('enabling auto-layout IN PLACE leaves an existing frame fill untouched', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 600, height: 200, fill: '#ffffff' }),
      el({ id: 'a', x: 20, y: 20, width: 100, height: 100, parentId: 'f' }),
    ]
    const res = addAutoLayout(els, ['f'], mkId)!
    expect(res.selectId).toBe('f')
    expect(byId(res.elements, 'f').fill).toBe('#ffffff') // not cleared / overwritten
  })

  it('normalises the wrapped members into visual order (flow = array order)', () => {
    // b precedes a in the array but a sits left of b — Figma's ⇧A keeps the
    // picture, so the array must come out a-then-b.
    const els = [
      el({ id: 'b', x: 300, y: 0, width: 100, height: 100 }),
      el({ id: 'a', x: 100, y: 0, width: 100, height: 100 }),
    ]
    const res = addAutoLayout(els, ['a', 'b'], mkId)!
    expect(byId(res.elements, res.selectId).layout?.mode).toBe('row')
    const order = res.elements.map((e) => e.id)
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'))
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

// ── Drag/create interaction helpers (plan D wave 2) ──────────────────────────

// A settled row frame: padding 20, gap 10, three 50×50 children laid at
// x = 20 / 80 / 140 (midpoints 45 / 105 / 165), cross interior y 20..70.
const settledRow = (): CanvasElement[] => [
  el({ id: 'f', type: 'frame', x: 0, y: 0, width: 400, height: 90, layout: layout() }),
  el({ id: 'a', x: 20, y: 20, width: 50, height: 50, parentId: 'f' }),
  el({ id: 'b', x: 80, y: 20, width: 50, height: 50, parentId: 'f' }),
  el({ id: 'c', x: 140, y: 20, width: 50, height: 50, parentId: 'f' }),
]

describe('layoutFrameAt', () => {
  it('hits the layout frame whose box contains the point; misses outside', () => {
    const els = settledRow()
    expect(layoutFrameAt(els, { x: 200, y: 45 })?.id).toBe('f')
    expect(layoutFrameAt(els, { x: 500, y: 45 })).toBeNull()
  })

  it('ignores plain frames, hidden and locked layout frames', () => {
    const plain = [el({ id: 'p', type: 'frame', x: 0, y: 0, width: 400, height: 90 })]
    expect(layoutFrameAt(plain, { x: 10, y: 10 })).toBeNull()
    const els = settledRow()
    expect(layoutFrameAt(
      els.map((e) => (e.id === 'f' ? { ...e, hidden: true } : e)),
      { x: 200, y: 45 },
    )).toBeNull()
    expect(layoutFrameAt(
      els.map((e) => (e.id === 'f' ? { ...e, locked: true } : e)),
      { x: 200, y: 45 },
    )).toBeNull()
  })

  it('prefers the deepest nested layout frame under the point', () => {
    const els = [
      el({ id: 'o', type: 'frame', x: 0, y: 0, width: 400, height: 300, layout: layout({ mode: 'column' }) }),
      el({ id: 'i', type: 'frame', x: 40, y: 40, width: 200, height: 100, layout: layout(), parentId: 'o' }),
    ]
    expect(layoutFrameAt(els, { x: 100, y: 80 })?.id).toBe('i')
    expect(layoutFrameAt(els, { x: 300, y: 250 })?.id).toBe('o')
  })

  it('excludeId drops that frame AND its subtree from the candidates', () => {
    const els = [
      el({ id: 'o', type: 'frame', x: 0, y: 0, width: 400, height: 300, layout: layout({ mode: 'column' }) }),
      el({ id: 'i', type: 'frame', x: 40, y: 40, width: 200, height: 100, layout: layout(), parentId: 'o' }),
    ]
    expect(layoutFrameAt(els, { x: 100, y: 80 }, 'i')?.id).toBe('o')
    // Excluding the OUTER frame also excludes the nested one (its descendant).
    expect(layoutFrameAt(els, { x: 100, y: 80 }, 'o')).toBeNull()
  })
})

describe('insertIntoLayoutAtPoint', () => {
  it('a deeper plain container under the point VETOES the flow insert (mock annotation / card frame)', () => {
    // AL frame F wraps a mock M (a generated design). Typing Text on M must
    // stay an M annotation — the flow must not steal it (Figma targets the
    // deepest insertable container). Reviewed regression: the AL ancestor
    // used to clobber the resolved parentId across all five create paths.
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 400, text: '', layout: layout({ mode: 'column', gap: 10, padding: 10 }) }),
      el({ id: 'm', type: 'mock', parentId: 'f', x: 10, y: 10, width: 420, height: 320 }),
    ]
    const note = el({ id: 't', type: 'text', parentId: 'm', x: 100, y: 100 })
    const r = insertIntoLayoutAtPoint(els, note, { x: 100, y: 100 })
    expect(r.frameId).toBeNull()
    expect(r.elements.find((e) => e.id === 't')!.parentId).toBe('m')

    // A plain card frame inside the AL rail vetoes the same way for a shape…
    const els2 = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 500, height: 400, text: '', layout: layout({ mode: 'column', gap: 10, padding: 10 }) }),
      el({ id: 'p', type: 'frame', parentId: 'f', x: 10, y: 10, width: 300, height: 200, text: '' }),
    ]
    const shape = el({ id: 's', type: 'shape', x: 50, y: 50, width: 40, height: 40 })
    const r2 = insertIntoLayoutAtPoint(els2, shape, { x: 60, y: 60 })
    expect(r2.frameId).toBeNull()
    // …but a child type the deeper container CANNOT hold still flow-inserts
    // (a sticky over the mock joins the rail — mocks only hold text).
    const sticky = el({ id: 'k', type: 'sticky', x: 100, y: 100, width: 80, height: 80 })
    const r3 = insertIntoLayoutAtPoint(els, sticky, { x: 100, y: 100 })
    expect(r3.frameId).toBe('f')
  })

  it('on a layout frame: parents the element and splices it at the slot under the point', () => {
    const els = settledRow()
    const n = el({ id: 'n', x: 999, y: 999, width: 50, height: 50 })
    const res = insertIntoLayoutAtPoint(els, n, { x: 70, y: 45 }) // between a/b midpoints → slot 1
    expect(res.frameId).toBe('f')
    const inserted = byId(res.elements, 'n')
    expect(inserted.parentId).toBe('f')
    const idx = (id: string) => res.elements.findIndex((e) => e.id === id)
    expect(idx('a')).toBeLessThan(idx('n'))
    expect(idx('n')).toBeLessThan(idx('b'))
    // The engine then flows it into the slot.
    const laid = applyAutoLayout(res.elements)
    expect(byId(laid, 'n')).toMatchObject({ x: 80, y: 20 })
    expect(byId(laid, 'b')).toMatchObject({ x: 140 })
    expect(byId(laid, 'c')).toMatchObject({ x: 200 })
  })

  it('past the last midpoint: appends at the array end (last slot)', () => {
    const els = settledRow()
    const res = insertIntoLayoutAtPoint(els, el({ id: 'n', x: 0, y: 0, width: 50, height: 50 }), { x: 380, y: 45 })
    expect(res.frameId).toBe('f')
    expect(res.elements[res.elements.length - 1].id).toBe('n')
  })

  it('off-frame / comments: plain append, untouched (frameId null)', () => {
    const els = settledRow()
    const free = el({ id: 'n', x: 600, y: 600 })
    const off = insertIntoLayoutAtPoint(els, free, { x: 600, y: 600 })
    expect(off.frameId).toBeNull()
    expect(off.elements[off.elements.length - 1]).toBe(free)
    const pin = el({ id: 'pin', type: 'comment', x: 200, y: 45 })
    const com = insertIntoLayoutAtPoint(els, pin, { x: 200, y: 45 })
    expect(com.frameId).toBeNull()
    expect(byId(com.elements, 'pin').parentId).toBeUndefined()
  })

  it('a frame nests into the flow — but a frame that CONTAINS the target reads as wrapping (append)', () => {
    const els = settledRow()
    const nested = el({ id: 'n', type: 'frame', x: 60, y: 30, width: 50, height: 50 })
    expect(insertIntoLayoutAtPoint(els, nested, { x: 70, y: 45 }).frameId).toBe('f')
    const wrapper = el({ id: 'w', type: 'frame', x: -20, y: -20, width: 600, height: 200 })
    const res = insertIntoLayoutAtPoint(els, wrapper, { x: 200, y: 45 })
    expect(res.frameId).toBeNull()
    expect(byId(res.elements, 'w').parentId).toBeUndefined()
  })
})

describe('layoutDropSlot / layoutDropPreview', () => {
  it('reports the frame + slot under the pointer; null off-frame or for a comment', () => {
    const els = [...settledRow(), el({ id: 'n', x: 600, y: 600, width: 50, height: 50 })]
    expect(layoutDropSlot(els, 'n', { x: 70, y: 45 })).toEqual({ frameId: 'f', slot: 1 })
    expect(layoutDropSlot(els, 'n', { x: 30, y: 45 })).toEqual({ frameId: 'f', slot: 0 })
    expect(layoutDropSlot(els, 'n', { x: 380, y: 45 })).toEqual({ frameId: 'f', slot: 3 })
    expect(layoutDropSlot(els, 'n', { x: 600, y: 600 })).toBeNull()
    const withPin = [...settledRow(), el({ id: 'pin', type: 'comment', x: 0, y: 0 })]
    expect(layoutDropSlot(withPin, 'pin', { x: 70, y: 45 })).toBeNull()
  })

  it('drag-in: siblings after the slot dodge by the dragged footprint + gap; bar marks the hole', () => {
    const els = [...settledRow(), el({ id: 'n', x: 600, y: 600, width: 50, height: 50 })]
    const p = layoutDropPreview(els, 'n', { x: 70, y: 45 })!
    expect(p.frameId).toBe('f')
    expect(p.slot).toBe(1)
    // b and c make room (50 + 10 gap); a stays; the dragged element is the
    // pointer's job, never shifted.
    expect(p.shifts.get('b')).toEqual({ dx: 60, dy: 0 })
    expect(p.shifts.get('c')).toEqual({ dx: 60, dy: 0 })
    expect(p.shifts.has('a')).toBe(false)
    expect(p.shifts.has('n')).toBe(false)
    // Row frame → vertical bar at the hole's centre, spanning the padded
    // cross interior.
    expect(p.bar).toEqual({ axis: 'x', pos: 105, from: 20, to: 70 })
  })

  it('reorder within the frame: earlier siblings close the gap (negative dodge)', () => {
    const els = settledRow()
    const p = layoutDropPreview(els, 'a', { x: 380, y: 45 })! // a → last slot
    expect(p.slot).toBe(2)
    expect(p.shifts.get('b')).toEqual({ dx: -60, dy: 0 })
    expect(p.shifts.get('c')).toEqual({ dx: -60, dy: 0 })
    expect(p.shifts.has('a')).toBe(false)
    // a's new slot is where c ends today: 140 + 50 → bar at its centre.
    expect(p.bar.pos).toBe(165)
  })

  it('dropping at the element’s own slot is a no-shift preview (bar only)', () => {
    const els = settledRow()
    const p = layoutDropPreview(els, 'b', { x: 105, y: 45 })!
    expect(p.shifts.size).toBe(0)
    expect(p.bar).toEqual({ axis: 'x', pos: 105, from: 20, to: 70 })
  })

  it('column frames produce a horizontal bar (axis y)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 90, height: 400, layout: layout({ mode: 'column' }) }),
      el({ id: 'a', x: 20, y: 20, width: 50, height: 50, parentId: 'f' }),
      el({ id: 'n', x: 600, y: 600, width: 50, height: 50 }),
    ]
    const p = layoutDropPreview(els, 'n', { x: 45, y: 10 })! // before a → slot 0
    expect(p.bar.axis).toBe('y')
    expect(p.bar).toMatchObject({ pos: 45, from: 20, to: 70 })
    expect(p.shifts.get('a')).toEqual({ dx: 0, dy: 60 })
  })

  it('the dragged element’s own subtree never dodges (it rides the pointer)', () => {
    const els = [
      ...settledRow(),
      el({ id: 'g', type: 'frame', x: 600, y: 600, width: 50, height: 50 }),
      el({ id: 'g1', x: 610, y: 610, width: 10, height: 10, parentId: 'g' }),
    ]
    const p = layoutDropPreview(els, 'g', { x: 30, y: 45 })! // slot 0
    expect(p.shifts.has('g')).toBe(false)
    expect(p.shifts.has('g1')).toBe(false)
    expect(p.shifts.get('a')).toEqual({ dx: 60, dy: 0 })
  })

  it('never mutates the input elements', () => {
    const els = settledRow()
    const before = els.map((e) => ({ ...e }))
    layoutDropPreview(els, 'a', { x: 380, y: 45 })
    expect(els).toEqual(before)
  })
})

describe('applyAutoLayoutDuringResize', () => {
  it('re-packs children live while a fixed frame resizes (align center follows)', () => {
    const els = [
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 400, height: 90, layout: layout({ align: 'center' }) }),
      el({ id: 'a', x: 20, y: 30, width: 50, height: 30, parentId: 'f' }),
    ]
    // Shrink the frame to height 70 mid-drag: the centred child re-centres NOW.
    const resized = els.map((e) => (e.id === 'f' ? { ...e, height: 70 } : e))
    const live = applyAutoLayoutDuringResize(resized, 'f', { w: 400, h: 90 })
    expect(byId(live, 'a').y).toBe(20) // 20 + (30 − 30) / 2
    expect(byId(live, 'f').height).toBe(70)
  })

  it('a hug axis being actively resized does NOT snap back — but the stored layout keeps hug', () => {
    const els = applyAutoLayout([
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 90, height: 90, layout: layout({ primarySizing: 'hug' }) }),
      el({ id: 'a', x: 0, y: 0, width: 50, height: 50, parentId: 'f' }),
    ])
    expect(byId(els, 'f').width).toBe(90) // hugged: 50 + 2×20
    const resized = els.map((e) => (e.id === 'f' ? { ...e, width: 150 } : e))
    // Plain engine would snap straight back to the hug size…
    expect(byId(applyAutoLayout(resized), 'f').width).toBe(90)
    // …the live-resize wrapper holds the user's size and keeps hug stored.
    const live = applyAutoLayoutDuringResize(resized, 'f', { w: 90, h: 90 })
    expect(byId(live, 'f').width).toBe(150)
    expect(byId(live, 'f').layout?.primarySizing).toBe('hug')
  })

  it('an untouched hug axis still hugs during the drag', () => {
    const els = applyAutoLayout([
      el({ id: 'f', type: 'frame', x: 0, y: 0, width: 90, height: 90, layout: layout({ counterSizing: 'hug' }) }),
      el({ id: 'a', x: 0, y: 0, width: 50, height: 50, parentId: 'f' }),
    ])
    // Drag the main axis only — the cross axis keeps hugging its content.
    const resized = els.map((e) => (e.id === 'f' ? { ...e, width: 200 } : e))
    const live = applyAutoLayoutDuringResize(resized, 'f', { w: 90, h: 90 })
    expect(byId(live, 'f').width).toBe(200)
    expect(byId(live, 'f').height).toBe(90) // 50 + 2×20, still hug
  })

  it('a child resize re-flows its siblings live (and fill recomputes)', () => {
    const els = settledRow()
    const resized = els.map((e) => (e.id === 'a' ? { ...e, width: 80 } : e))
    const live = applyAutoLayoutDuringResize(resized, 'a', { w: 50, h: 50 })
    expect(byId(live, 'b').x).toBe(110) // 20 + 80 + 10
    expect(byId(live, 'c').x).toBe(170)
  })

  it('reference no-op for a non-layout resize', () => {
    const els = [el({ id: 's', x: 0, y: 0, width: 50, height: 50 })]
    const resized = els.map((e) => (e.id === 's' ? { ...e, width: 80 } : e))
    expect(applyAutoLayoutDuringResize(resized, 's', { w: 50, h: 50 })).toBe(resized)
  })
})
