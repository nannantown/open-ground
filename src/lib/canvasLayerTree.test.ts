import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import { buildLayerRows, reorderLayer } from './canvasLayerTree'

// Minimal element factory — only the fields the tree logic reads.
const el = (
  id: string,
  type: CanvasElement['type'],
  parentId?: string,
): CanvasElement =>
  ({ id, type, x: 0, y: 0, text: '', parentId } as unknown as CanvasElement)

const ids = (rows: { el: CanvasElement }[]) => rows.map((r) => r.el.id)

describe('buildLayerRows', () => {
  it('lists top-level elements front-at-top (array is back→front)', () => {
    const els = [el('a', 'sticky'), el('b', 'sticky'), el('c', 'sticky')]
    const rows = buildLayerRows(els, () => false)
    expect(ids(rows)).toEqual(['c', 'b', 'a'])
    expect(rows.every((r) => r.depth === 0)).toBe(true)
  })

  it('nests children under an expanded container', () => {
    const els = [el('f', 'frame'), el('c1', 'sticky', 'f'), el('c2', 'sticky', 'f')]
    const rows = buildLayerRows(els, () => true)
    // Frame first (only root), then its children front-at-top: c2, c1.
    expect(ids(rows)).toEqual(['f', 'c2', 'c1'])
    expect(rows[0]).toMatchObject({ depth: 0, hasChildren: true })
    expect(rows[1].depth).toBe(1)
    expect(rows[2].depth).toBe(1)
  })

  it('hides children of a collapsed container', () => {
    const els = [el('f', 'frame'), el('c1', 'sticky', 'f')]
    const rows = buildLayerRows(els, () => false)
    expect(ids(rows)).toEqual(['f'])
    expect(rows[0].hasChildren).toBe(true)
  })

  it('treats a dangling / illegal parentId as a top-level row', () => {
    // parent 'ghost' does not exist → 'c' is a root.
    const danglers = [el('c', 'sticky', 'ghost')]
    expect(ids(buildLayerRows(danglers, () => true))).toEqual(['c'])
    // a sticky can't be owned by a mock (canContain(mock, sticky) === false).
    const illegal = [el('m', 'mock'), el('s', 'sticky', 'm')]
    const rows = buildLayerRows(illegal, () => true)
    expect(ids(rows)).toEqual(['s', 'm']) // both top-level, front-at-top
    expect(rows.every((r) => r.depth === 0)).toBe(true)
  })

  it('is cycle-safe AND still lists every element trapped in a cycle', () => {
    const a = el('a', 'frame', 'b')
    const b = el('b', 'frame', 'a')
    let rows: ReturnType<typeof buildLayerRows> = []
    expect(() => {
      rows = buildLayerRows([a, b], () => true)
    }).not.toThrow()
    // Neither is a root (each is the other's valid child), so they'd vanish
    // without the safety net — assert both still appear.
    expect(ids(rows).sort()).toEqual(['a', 'b'])
  })
})

describe('reorderLayer', () => {
  it('moves an element above a target (more toward front)', () => {
    const els = [el('a', 'sticky'), el('b', 'sticky'), el('c', 'sticky')]
    // Drop 'a' above 'c' in the panel → 'a' becomes front-most (array end).
    const next = reorderLayer(els, 'a', 'c', 'above')
    expect(next.map((e) => e.id)).toEqual(['b', 'c', 'a'])
  })

  it('moves an element below a target (more toward back)', () => {
    const els = [el('a', 'sticky'), el('b', 'sticky'), el('c', 'sticky')]
    // Drop 'c' below 'a' in the panel → 'c' lands behind 'a' (array start).
    const next = reorderLayer(els, 'c', 'a', 'below')
    expect(next.map((e) => e.id)).toEqual(['c', 'a', 'b'])
  })

  it('adopts the target level (parentId) when dropping next to a child', () => {
    const els = [el('f', 'frame'), el('c1', 'sticky', 'f'), el('x', 'sticky')]
    const next = reorderLayer(els, 'x', 'c1', 'above')
    const x = next.find((e) => e.id === 'x')!
    expect(x.parentId).toBe('f')
  })

  it('drops to top level when the target container cannot own the dragged type', () => {
    // target 'tx' lives in a mock (legal: text in mock). Dragging a sticky next
    // to it can't join the mock, so the sticky stays top-level.
    const els = [el('m', 'mock'), el('tx', 'text', 'm'), el('s', 'sticky')]
    const next = reorderLayer(els, 's', 'tx', 'above')
    const s = next.find((e) => e.id === 's')!
    expect(s.parentId).toBeUndefined()
  })

  it('moves a container with its whole subtree as a contiguous block', () => {
    const els = [
      el('z', 'sticky'),
      el('f', 'frame'),
      el('c1', 'sticky', 'f'),
      el('c2', 'sticky', 'f'),
    ]
    // Drop the frame below 'z' → frame + its two children move together.
    const next = reorderLayer(els, 'f', 'z', 'below')
    expect(next.map((e) => e.id)).toEqual(['f', 'c1', 'c2', 'z'])
  })

  it('refuses to drop a container into its own subtree', () => {
    const els = [el('f', 'frame'), el('c1', 'sticky', 'f')]
    expect(reorderLayer(els, 'f', 'c1', 'above')).toBe(els)
  })

  it('is a no-op on self-drop', () => {
    const els = [el('a', 'sticky'), el('b', 'sticky')]
    expect(reorderLayer(els, 'a', 'a', 'above')).toBe(els)
  })
})
