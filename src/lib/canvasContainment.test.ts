import { describe, it, expect } from 'vitest'
import {
  rectInside,
  frameIdContaining,
  resolveParentId,
  resolveContainerId,
  canContain,
  clearDanglingParents,
  type Rect,
  type Container,
} from './canvasContainment'
import type { CanvasElement } from './types'

const el = (over: Partial<CanvasElement>): CanvasElement => ({
  id: 'x',
  type: 'text',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

const frame = (id: string, r: Rect) => ({ id, rect: r })

describe('rectInside', () => {
  it('true when the child sits fully inside the parent', () => {
    expect(rectInside({ x: 20, y: 20, w: 30, h: 30 }, { x: 0, y: 0, w: 100, h: 100 })).toBe(true)
  })

  it('true when edges touch (inclusive containment)', () => {
    expect(rectInside({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 100, h: 100 })).toBe(true)
  })

  it('false when the child pokes out on any side', () => {
    const parent = { x: 0, y: 0, w: 100, h: 100 }
    expect(rectInside({ x: -1, y: 10, w: 10, h: 10 }, parent)).toBe(false) // left
    expect(rectInside({ x: 95, y: 10, w: 10, h: 10 }, parent)).toBe(false) // right
    expect(rectInside({ x: 10, y: -1, w: 10, h: 10 }, parent)).toBe(false) // top
    expect(rectInside({ x: 10, y: 95, w: 10, h: 10 }, parent)).toBe(false) // bottom
  })

  it('false for a zero-area (un-sized) parent', () => {
    expect(rectInside({ x: 0, y: 0, w: 0, h: 0 }, { x: 0, y: 0, w: 0, h: 0 })).toBe(false)
  })
})

describe('frameIdContaining', () => {
  it('returns the frame that fully contains the rect', () => {
    const frames = [frame('f1', { x: 0, y: 0, w: 200, h: 200 })]
    expect(frameIdContaining({ x: 10, y: 10, w: 20, h: 20 }, frames)).toBe('f1')
  })

  it('returns undefined when no frame contains the rect', () => {
    const frames = [frame('f1', { x: 0, y: 0, w: 50, h: 50 })]
    expect(frameIdContaining({ x: 100, y: 100, w: 20, h: 20 }, frames)).toBeUndefined()
  })

  it('prefers the smallest containing frame when frames are nested', () => {
    const frames = [
      frame('outer', { x: 0, y: 0, w: 500, h: 500 }),
      frame('inner', { x: 50, y: 50, w: 100, h: 100 }),
    ]
    // A rect inside both → the more specific (smaller-area) inner frame wins.
    expect(frameIdContaining({ x: 60, y: 60, w: 10, h: 10 }, frames)).toBe('inner')
  })

  it('returns undefined for an empty frame list', () => {
    expect(frameIdContaining({ x: 0, y: 0, w: 10, h: 10 }, [])).toBeUndefined()
  })
})

describe('resolveParentId', () => {
  it('assigns the frame id when the moved element landed inside it', () => {
    const frames = [frame('f1', { x: 0, y: 0, w: 300, h: 300 })]
    expect(resolveParentId('sticky1', { x: 40, y: 40, w: 50, h: 50 }, frames)).toBe('f1')
  })

  it('clears parentage (undefined) when dragged out of every frame', () => {
    const frames = [frame('f1', { x: 0, y: 0, w: 100, h: 100 })]
    expect(resolveParentId('sticky1', { x: 500, y: 500, w: 50, h: 50 }, frames)).toBeUndefined()
  })

  it('never lets a frame become its own parent', () => {
    // A frame's own rect trivially "contains itself"; it must be excluded so a
    // frame can't parent itself.
    const frames = [frame('f1', { x: 0, y: 0, w: 300, h: 300 })]
    expect(resolveParentId('f1', { x: 0, y: 0, w: 300, h: 300 }, frames)).toBeUndefined()
  })
})

describe('clearDanglingParents', () => {
  it('keeps a parentId whose frame still exists', () => {
    const els = [
      el({ id: 'f1', type: 'frame', width: 200, height: 200 }),
      el({ id: 's1', type: 'sticky', parentId: 'f1' }),
    ]
    const out = clearDanglingParents(els)
    expect(out).toBe(els) // no change → same reference
    expect(out[1].parentId).toBe('f1')
  })

  it('drops parentId when the parent frame is gone', () => {
    const els = [el({ id: 's1', type: 'sticky', parentId: 'f-gone' })]
    const out = clearDanglingParents(els)
    expect(out).not.toBe(els)
    expect(out[0].parentId).toBeUndefined()
    expect('parentId' in out[0]).toBe(false)
  })

  it('drops parentId pointing at a non-container element', () => {
    // parentId must reference a container; a value pointing at a sticky is stale.
    const els = [
      el({ id: 's1', type: 'sticky' }),
      el({ id: 's2', type: 'sticky', parentId: 's1' }),
    ]
    const out = clearDanglingParents(els)
    expect(out).not.toBe(els)
    expect(out[1].parentId).toBeUndefined()
  })

  it('keeps a text child parented to a live mock (design annotation)', () => {
    const els = [
      el({ id: 'm1', type: 'mock', width: 420, height: 320 }),
      el({ id: 't1', type: 'text', parentId: 'm1' }),
    ]
    const out = clearDanglingParents(els)
    expect(out).toBe(els) // no change → same reference
    expect(out[1].parentId).toBe('m1')
  })

  it('keeps a text child parented to a live screen (design annotation)', () => {
    const els = [
      el({ id: 'sc1', type: 'screen', width: 1280, height: 800 }),
      el({ id: 't1', type: 'text', parentId: 'sc1' }),
    ]
    expect(clearDanglingParents(els)).toBe(els)
  })

  it('drops a non-text child that claims a design as parent', () => {
    // A design (mock/screen) may own only `text` annotations — a sticky pointing
    // at a mock is an illegal pairing and must be scrubbed.
    const els = [
      el({ id: 'm1', type: 'mock', width: 420, height: 320 }),
      el({ id: 's1', type: 'sticky', parentId: 'm1' }),
    ]
    const out = clearDanglingParents(els)
    expect(out).not.toBe(els)
    expect(out.find((e) => e.id === 's1')!.parentId).toBeUndefined()
  })

  it('drops a text child whose parent design was deleted', () => {
    const els = [el({ id: 't1', type: 'text', parentId: 'm-gone' })]
    const out = clearDanglingParents(els)
    expect(out).not.toBe(els)
    expect(out[0].parentId).toBeUndefined()
  })

  it('scrubs only the dangling children, keeps the resolvable ones', () => {
    const els = [
      el({ id: 'f1', type: 'frame', width: 200, height: 200 }),
      el({ id: 'live', type: 'sticky', parentId: 'f1' }),
      el({ id: 'dead', type: 'sticky', parentId: 'f-gone' }),
    ]
    const out = clearDanglingParents(els)
    expect(out).not.toBe(els)
    expect(out.find((e) => e.id === 'live')!.parentId).toBe('f1')
    expect(out.find((e) => e.id === 'dead')!.parentId).toBeUndefined()
  })

  it('is a no-op when nothing carries a parentId (backward-compat)', () => {
    const els = [
      el({ id: 'f1', type: 'frame', width: 200, height: 200 }),
      el({ id: 's1', type: 'sticky' }),
    ]
    expect(clearDanglingParents(els)).toBe(els)
  })
})

describe('canContain', () => {
  it('a frame owns any non-frame child', () => {
    for (const t of ['text', 'sticky', 'mock', 'screen', 'image', 'comment'] as const) {
      expect(canContain('frame', t)).toBe(true)
    }
  })

  it('a frame never owns another frame (no nested frames in this slice)', () => {
    expect(canContain('frame', 'frame')).toBe(false)
  })

  it('a design (mock/screen) owns only text annotations', () => {
    expect(canContain('mock', 'text')).toBe(true)
    expect(canContain('screen', 'text')).toBe(true)
    for (const t of ['sticky', 'mock', 'screen', 'image', 'frame', 'comment'] as const) {
      expect(canContain('mock', t)).toBe(false)
      expect(canContain('screen', t)).toBe(false)
    }
  })

  it('non-container types own nothing', () => {
    for (const c of ['text', 'sticky', 'image', 'comment'] as const) {
      expect(canContain(c, 'text')).toBe(false)
    }
  })
})

describe('resolveContainerId', () => {
  const container = (id: string, type: CanvasElement['type'], rect: Rect): Container => ({
    id,
    type,
    rect,
  })

  it('parents a text annotation to the design it was dropped on', () => {
    const containers = [container('m1', 'mock', { x: 0, y: 0, w: 420, h: 320 })]
    expect(
      resolveContainerId('t1', 'text', { x: 40, y: 40, w: 80, h: 24 }, containers),
    ).toBe('m1')
  })

  it('does NOT parent a sticky to a design (illegal pairing skipped)', () => {
    const containers = [container('m1', 'mock', { x: 0, y: 0, w: 420, h: 320 })]
    expect(
      resolveContainerId('s1', 'sticky', { x: 40, y: 40, w: 80, h: 24 }, containers),
    ).toBeUndefined()
  })

  it('still parents any child to a frame (frame stays general)', () => {
    const containers = [container('f1', 'frame', { x: 0, y: 0, w: 400, h: 400 })]
    expect(
      resolveContainerId('s1', 'sticky', { x: 40, y: 40, w: 80, h: 80 }, containers),
    ).toBe('f1')
  })

  it('prefers the design over the frame it sits inside (smallest wins)', () => {
    const containers = [
      container('f1', 'frame', { x: 0, y: 0, w: 1000, h: 1000 }),
      container('m1', 'mock', { x: 50, y: 50, w: 420, h: 320 }),
    ]
    // A text dropped inside a mock that itself sits in a frame anchors to the
    // mock — the most specific (smallest-area) eligible container.
    expect(
      resolveContainerId('t1', 'text', { x: 60, y: 60, w: 80, h: 24 }, containers),
    ).toBe('m1')
  })

  it('clears parentage when the text is outside every container', () => {
    const containers = [container('m1', 'mock', { x: 0, y: 0, w: 100, h: 100 })]
    expect(
      resolveContainerId('t1', 'text', { x: 500, y: 500, w: 80, h: 24 }, containers),
    ).toBeUndefined()
  })

  it('never lets a container become its own parent', () => {
    const containers = [container('m1', 'mock', { x: 0, y: 0, w: 420, h: 320 })]
    expect(
      resolveContainerId('m1', 'mock', { x: 0, y: 0, w: 420, h: 320 }, containers),
    ).toBeUndefined()
  })
})
