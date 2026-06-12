import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import {
  buildLayerRows,
  filterLayerRows,
  reorderLayer,
  canMoveLayer,
  moveLayerOne,
  layerAncestors,
} from './canvasLayerTree'

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

describe('reorderLayer — into', () => {
  it('drops into a container as its FRONT-MOST child (after the whole subtree)', () => {
    const els = [el('x', 'sticky'), el('f', 'frame'), el('c1', 'sticky', 'f')]
    const next = reorderLayer(els, 'x', 'f', 'into')
    expect(next.map((e) => e.id)).toEqual(['f', 'c1', 'x'])
    expect(next.find((e) => e.id === 'x')!.parentId).toBe('f')
  })

  it('drops into an EMPTY container', () => {
    const els = [el('x', 'sticky'), el('f', 'frame')]
    const next = reorderLayer(els, 'x', 'f', 'into')
    expect(next.map((e) => e.id)).toEqual(['f', 'x'])
    expect(next.find((e) => e.id === 'x')!.parentId).toBe('f')
  })

  it('moves a container WITH its subtree into another container', () => {
    const els = [el('g', 'frame'), el('c', 'sticky', 'g'), el('f', 'frame')]
    const next = reorderLayer(els, 'g', 'f', 'into')
    expect(next.map((e) => e.id)).toEqual(['f', 'g', 'c'])
    expect(next.find((e) => e.id === 'g')!.parentId).toBe('f')
    expect(next.find((e) => e.id === 'c')!.parentId).toBe('g') // child travels
  })

  it('re-dropping an existing child into its parent moves it to the front', () => {
    const els = [el('f', 'frame'), el('a', 'sticky', 'f'), el('b', 'sticky', 'f')]
    const next = reorderLayer(els, 'a', 'f', 'into')
    expect(next.map((e) => e.id)).toEqual(['f', 'b', 'a'])
    expect(next.find((e) => e.id === 'a')!.parentId).toBe('f')
  })

  it('is a no-op when the target cannot own the dragged type', () => {
    // a mock owns only text — dropping a sticky INTO it must change nothing.
    const els = [el('s', 'sticky'), el('m', 'mock')]
    expect(reorderLayer(els, 's', 'm', 'into')).toBe(els)
  })

  it('refuses to drop a container into its own descendant', () => {
    const els = [el('f', 'frame'), el('g', 'frame', 'f')]
    expect(reorderLayer(els, 'f', 'g', 'into')).toBe(els)
  })
})

describe('filterLayerRows', () => {
  const tree = (): CanvasElement[] => [
    { ...el('note', 'sticky'), name: 'Note' } as CanvasElement,
    { ...el('f', 'frame'), name: 'Hero' } as CanvasElement,
    { ...el('a', 'sticky', 'f'), name: 'Alpha' } as CanvasElement,
    { ...el('b', 'sticky', 'f'), name: 'Beta' } as CanvasElement,
  ]
  const fullRows = () => buildLayerRows(tree(), () => true)

  it('keeps matches AND their ancestor chain, reporting the ancestors as expanded', () => {
    const { rows, expandedIds } = filterLayerRows(fullRows(), 'alpha', (e) => e.name ?? '')
    expect(ids(rows)).toEqual(['f', 'a'])
    expect(expandedIds.has('f')).toBe(true)
    expect(expandedIds.has('a')).toBe(false)
  })

  it('matches the element TYPE as well as the label', () => {
    const { rows } = filterLayerRows(fullRows(), 'frame', (e) => e.name ?? '')
    expect(ids(rows)).toEqual(['f'])
  })

  it('a matching container does not drag its non-matching children along', () => {
    const { rows, expandedIds } = filterLayerRows(fullRows(), 'hero', (e) => e.name ?? '')
    expect(ids(rows)).toEqual(['f'])
    expect(expandedIds.size).toBe(0)
  })

  it('is case-insensitive and trims the query', () => {
    const { rows } = filterLayerRows(fullRows(), '  BETA ', (e) => e.name ?? '')
    expect(ids(rows)).toEqual(['f', 'b'])
  })

  it('an empty query returns the rows unchanged', () => {
    const rows = fullRows()
    const out = filterLayerRows(rows, '   ')
    expect(out.rows).toBe(rows)
    expect(out.expandedIds.size).toBe(0)
  })

  it('no match → no rows', () => {
    const { rows } = filterLayerRows(fullRows(), 'zzz', (e) => e.name ?? '')
    expect(rows).toEqual([])
  })

  it('default matcher falls back to the custom name, then the first content line', () => {
    const els = [
      { ...el('n', 'sticky'), text: 'hello\nworld' } as CanvasElement,
      { ...el('m', 'sticky'), name: 'Tagged', text: '' } as CanvasElement,
    ]
    const rows = buildLayerRows(els, () => true)
    expect(ids(filterLayerRows(rows, 'hello').rows)).toEqual(['n'])
    expect(ids(filterLayerRows(rows, 'tagged').rows)).toEqual(['m'])
  })
})

describe('canMoveLayer / moveLayerOne', () => {
  // [f(c1,c2), x] — roots f,x; children c1,c2. Panel: x, f, c2, c1.
  const nested = (): CanvasElement[] => [
    el('f', 'frame'),
    el('c1', 'sticky', 'f'),
    el('c2', 'sticky', 'f'),
    el('x', 'sticky'),
  ]

  it('judges headroom inside the SIBLING group, not by visible-row index', () => {
    const els = nested()
    // c2 is the front-most CHILD even though its row index isn't 0.
    expect(canMoveLayer(els, 'c2', 'up')).toBe(false)
    expect(canMoveLayer(els, 'c2', 'down')).toBe(true)
    expect(canMoveLayer(els, 'c1', 'up')).toBe(true)
    expect(canMoveLayer(els, 'c1', 'down')).toBe(false)
    // x is the front-most ROOT (array end).
    expect(canMoveLayer(els, 'x', 'up')).toBe(false)
    expect(canMoveLayer(els, 'x', 'down')).toBe(true)
    expect(canMoveLayer(els, 'f', 'up')).toBe(true)
    expect(canMoveLayer(els, 'f', 'down')).toBe(false)
  })

  it('moves one sibling step within a container', () => {
    const next = moveLayerOne(nested(), 'c1', 'up')
    expect(next.map((e) => e.id)).toEqual(['f', 'c2', 'c1', 'x'])
  })

  it('steps a root over a container\'s WHOLE subtree (the old swap bug)', () => {
    // The buggy adjacent swap would interleave x with f's children instead.
    const next = moveLayerOne(nested(), 'x', 'down')
    expect(next.map((e) => e.id)).toEqual(['x', 'f', 'c1', 'c2'])
  })

  it('moves a container with its subtree as one block', () => {
    const next = moveLayerOne(nested(), 'f', 'up')
    expect(next.map((e) => e.id)).toEqual(['x', 'f', 'c1', 'c2'])
    // children keep their membership
    expect(next.find((e) => e.id === 'c1')!.parentId).toBe('f')
  })

  it('never crosses the parent boundary (no-op at the scope edge)', () => {
    const els = nested()
    expect(moveLayerOne(els, 'c2', 'up')).toBe(els)
    expect(moveLayerOne(els, 'c1', 'down')).toBe(els)
    expect(moveLayerOne(els, 'x', 'up')).toBe(els)
  })

  it('treats a dangling parentId as a top-level sibling', () => {
    const els = [el('a', 'sticky'), el('d', 'sticky', 'ghost')]
    expect(canMoveLayer(els, 'd', 'down')).toBe(true)
    expect(moveLayerOne(els, 'd', 'down').map((e) => e.id)).toEqual(['d', 'a'])
  })

  it('unknown id → false / no-op', () => {
    const els = nested()
    expect(canMoveLayer(els, 'nope', 'up')).toBe(false)
    expect(moveLayerOne(els, 'nope', 'up')).toBe(els)
  })
})

describe('layerAncestors', () => {
  it('returns the live ancestor chain nearest-first', () => {
    const els = [el('f', 'frame'), el('g', 'frame', 'f'), el('c', 'sticky', 'g')]
    expect(layerAncestors(els, 'c')).toEqual(['g', 'f'])
    expect(layerAncestors(els, 'f')).toEqual([])
  })

  it('a dangling / illegal parentId ends the chain', () => {
    expect(layerAncestors([el('c', 'sticky', 'ghost')], 'c')).toEqual([])
    // a sticky can't live in a mock → not a live child → no ancestors
    const illegal = [el('m', 'mock'), el('s', 'sticky', 'm')]
    expect(layerAncestors(illegal, 's')).toEqual([])
  })

  it('is cycle-safe', () => {
    const a = el('a', 'frame', 'b')
    const b = el('b', 'frame', 'a')
    expect(() => layerAncestors([a, b], 'a')).not.toThrow()
  })
})
