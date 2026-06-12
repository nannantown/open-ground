import { describe, it, expect } from 'vitest'
import type { CanvasElement } from './types'
import {
  groupElements,
  ungroupElements,
  topGroupId,
  groupLeafIds,
  expandSelectionForElement,
  hasGroupAncestorFlag,
  withGroupAncestors,
  groupCascadeSets,
  dissolveFrames,
} from './canvasGroup'

const el = (
  id: string,
  type: CanvasElement['type'],
  parentId?: string,
  x = 0,
  y = 0,
): CanvasElement =>
  ({ id, type, x, y, width: 10, height: 10, text: '', parentId } as unknown as CanvasElement)

const bounds = (e: CanvasElement) => ({
  x: e.x,
  y: e.y,
  w: (e as { width?: number }).width ?? 10,
  h: (e as { height?: number }).height ?? 10,
})

let n = 0
const makeId = () => `g${++n}`

describe('groupElements', () => {
  it('wraps ≥2 selected elements under a new group with their parentId', () => {
    n = 0
    const els = [el('a', 'sticky', undefined, 0, 0), el('b', 'sticky', undefined, 20, 20)]
    const r = groupElements(els, ['a', 'b'], makeId, bounds)!
    expect(r).not.toBeNull()
    expect(r.groupId).toBe('g1')
    expect(r.memberIds.sort()).toEqual(['a', 'b'])
    const group = r.elements.find((e) => e.id === 'g1')!
    expect(group.type).toBe('group')
    // bbox spans both members (0,0)..(30,30)
    expect(group.x).toBe(0)
    expect(group.y).toBe(0)
    expect(group.width).toBe(30)
    expect(group.height).toBe(30)
    expect(r.elements.find((e) => e.id === 'a')!.parentId).toBe('g1')
    expect(r.elements.find((e) => e.id === 'b')!.parentId).toBe('g1')
  })

  it('is a no-op with fewer than 2 top-level members', () => {
    const els = [el('a', 'sticky')]
    expect(groupElements(els, ['a'], makeId, bounds)).toBeNull()
  })

  it('groups only the top-level element when a parent and its child are both selected', () => {
    n = 0
    const els = [el('f', 'frame'), el('c', 'sticky', 'f'), el('s', 'sticky')]
    const r = groupElements(els, ['f', 'c', 's'], makeId, bounds)!
    // 'c' is a child of selected 'f' → not a direct group member; f + s are.
    expect(r.memberIds.sort()).toEqual(['f', 's'])
    expect(r.elements.find((e) => e.id === 'c')!.parentId).toBe('f')
    expect(r.elements.find((e) => e.id === 'f')!.parentId).toBe('g1')
  })

  it('nests the group in the members common parent', () => {
    n = 0
    const els = [el('f', 'frame'), el('a', 'sticky', 'f'), el('b', 'sticky', 'f')]
    const r = groupElements(els, ['a', 'b'], makeId, bounds)!
    expect(r.elements.find((e) => e.id === 'g1')!.parentId).toBe('f')
  })
})

describe('ungroupElements', () => {
  it('dissolves the group of a selected member and frees its children', () => {
    const els = [el('g', 'group'), el('a', 'sticky', 'g'), el('b', 'sticky', 'g')]
    const r = ungroupElements(els, ['a'])!
    expect(r.elements.find((e) => e.id === 'g')).toBeUndefined()
    expect(r.elements.find((e) => e.id === 'a')!.parentId).toBeUndefined()
    expect(r.freedIds.sort()).toEqual(['a', 'b'])
  })

  it('dissolves a directly-selected group element', () => {
    const els = [el('g', 'group'), el('a', 'sticky', 'g')]
    const r = ungroupElements(els, ['g'])!
    expect(r.elements.find((e) => e.id === 'g')).toBeUndefined()
    expect(r.elements.find((e) => e.id === 'a')!.parentId).toBeUndefined()
  })

  it('hands children to the grandparent so an outer group survives', () => {
    // outer group 'go' contains inner group 'gi' contains 'a'.
    const els = [el('go', 'group'), el('gi', 'group', 'go'), el('a', 'sticky', 'gi')]
    const r = ungroupElements(els, ['gi'])!
    expect(r.elements.find((e) => e.id === 'gi')).toBeUndefined()
    expect(r.elements.find((e) => e.id === 'go')).toBeDefined()
    expect(r.elements.find((e) => e.id === 'a')!.parentId).toBe('go')
  })

  it('frees children to top level when an outer + inner group are dissolved together', () => {
    // go ⊃ gi ⊃ a. Selecting both groups must NOT rehome 'a' onto 'go' (also
    // removed) — it should land at top level.
    const els = [el('go', 'group'), el('gi', 'group', 'go'), el('a', 'sticky', 'gi')]
    const r = ungroupElements(els, ['go', 'gi'])!
    expect(r.elements.find((e) => e.id === 'go')).toBeUndefined()
    expect(r.elements.find((e) => e.id === 'gi')).toBeUndefined()
    expect(r.elements.find((e) => e.id === 'a')!.parentId).toBeUndefined()
  })

  it('is a no-op when nothing selected is a group', () => {
    const els = [el('a', 'sticky')]
    expect(ungroupElements(els, ['a'])).toBeNull()
  })

  it('frees a child to top level when dissolved groups form a parentId cycle', () => {
    // Defensive: gi.parent=go, go.parent=gi (both dissolved). The child must not
    // be rehomed onto a removed group.
    const els = [
      el('go', 'group', 'gi'),
      el('gi', 'group', 'go'),
      el('a', 'sticky', 'gi'),
    ]
    const r = ungroupElements(els, ['go', 'gi'])!
    expect(r.elements.find((e) => e.id === 'a')!.parentId).toBeUndefined()
  })
})

describe('groupCascadeSets', () => {
  const f = (id: string, type: CanvasElement['type'], parentId: string | undefined, flag?: 'hidden' | 'locked') =>
    ({ id, type, x: 0, y: 0, text: '', parentId, ...(flag ? { [flag]: true } : {}) } as unknown as CanvasElement)

  it('marks every descendant of a hidden / locked group', () => {
    const els = [
      f('g', 'group', undefined, 'hidden'),
      f('fr', 'frame', 'g'),
      f('a', 'sticky', 'fr'),
      f('b', 'sticky', 'g'),
      f('out', 'sticky', undefined),
    ]
    const { hiddenViaGroup, lockedViaGroup } = groupCascadeSets(els)
    expect(Array.from(hiddenViaGroup).sort()).toEqual(['a', 'b', 'fr'])
    expect(hiddenViaGroup.has('out')).toBe(false)
    expect(hiddenViaGroup.has('g')).toBe(false) // the group itself isn't a member
    expect(lockedViaGroup.size).toBe(0)
  })

  it('is cycle-safe', () => {
    const els = [f('x', 'group', 'y', 'locked'), f('y', 'group', 'x')]
    expect(() => groupCascadeSets(els)).not.toThrow()
  })
})

describe('hasGroupAncestorFlag', () => {
  const flagged = (id: string, type: CanvasElement['type'], parentId: string | undefined, f: 'hidden' | 'locked') =>
    ({ id, type, x: 0, y: 0, text: '', parentId, [f]: true } as unknown as CanvasElement)

  it('is true when a group ancestor carries the flag', () => {
    const els = [flagged('g', 'group', undefined, 'hidden'), el('a', 'sticky', 'g')]
    expect(hasGroupAncestorFlag(els, 'a', 'hidden')).toBe(true)
    expect(hasGroupAncestorFlag(els, 'a', 'locked')).toBe(false)
  })

  it('only counts GROUP ancestors, not frames', () => {
    const els = [flagged('f', 'frame', undefined, 'hidden'), el('a', 'sticky', 'f')]
    expect(hasGroupAncestorFlag(els, 'a', 'hidden')).toBe(false)
  })

  it('walks through nested groups and is cycle-safe', () => {
    const els = [
      flagged('go', 'group', undefined, 'locked'),
      el('gi', 'group', 'go'),
      el('a', 'sticky', 'gi'),
    ]
    expect(hasGroupAncestorFlag(els, 'a', 'locked')).toBe(true)
    const cyc = [el('x', 'group', 'y'), el('y', 'group', 'x')]
    expect(() => hasGroupAncestorFlag(cyc, 'x', 'hidden')).not.toThrow()
  })
})

describe('topGroupId / groupLeafIds / expandSelectionForElement', () => {
  it('finds the top-most group ancestor', () => {
    const els = [el('go', 'group'), el('gi', 'group', 'go'), el('a', 'sticky', 'gi')]
    expect(topGroupId(els, 'a')).toBe('go')
    expect(topGroupId(els, 'gi')).toBe('go')
    expect(topGroupId(els, 'go')).toBeUndefined()
  })

  it('collects the non-group leaves of a group (through nested frames)', () => {
    const els = [
      el('g', 'group'),
      el('f', 'frame', 'g'),
      el('a', 'sticky', 'f'),
      el('b', 'sticky', 'g'),
    ]
    // leaves = frame + its child + sibling sticky (frame counts as a leaf — it
    // has a position to move — and we still descend into it).
    expect(groupLeafIds(els, 'g').sort()).toEqual(['a', 'b', 'f'])
  })

  it('expands a member click to its whole group', () => {
    const els = [el('g', 'group'), el('a', 'sticky', 'g'), el('b', 'sticky', 'g')]
    expect(expandSelectionForElement(els, 'a').sort()).toEqual(['a', 'b'])
    // ungrouped element selects only itself
    const flat = [el('x', 'sticky')]
    expect(expandSelectionForElement(flat, 'x')).toEqual(['x'])
  })

  it('expands a group-element click to its members', () => {
    const els = [el('g', 'group'), el('a', 'sticky', 'g')]
    expect(expandSelectionForElement(els, 'g')).toEqual(['a'])
  })
})

describe('withGroupAncestors', () => {
  it('adds the group element when ALL its members are selected', () => {
    const els = [el('g', 'group'), el('a', 'sticky', 'g'), el('b', 'sticky', 'g')]
    expect(withGroupAncestors(els, ['a', 'b']).sort()).toEqual(['a', 'b', 'g'])
  })

  it('does NOT add the group for a partial member selection', () => {
    const els = [el('g', 'group'), el('a', 'sticky', 'g'), el('b', 'sticky', 'g')]
    expect(withGroupAncestors(els, ['a']).sort()).toEqual(['a'])
  })

  it('adds both nested groups when the whole outer group is selected', () => {
    const els = [
      el('go', 'group'),
      el('gi', 'group', 'go'),
      el('a', 'sticky', 'gi'),
      el('b', 'sticky', 'go'),
    ]
    // outer leaves = {a, b, gi-children...}; groupLeafIds('go') = [a, b] (+ gi is
    // a group, descended into). Selecting both leaves pulls in gi and go.
    expect(withGroupAncestors(els, ['a', 'b']).sort()).toEqual(['a', 'b', 'gi', 'go'])
  })

  it('does not add frame ancestors', () => {
    const els = [el('f', 'frame'), el('a', 'sticky', 'f')]
    expect(withGroupAncestors(els, ['a'])).toEqual(['a'])
  })
})

describe('dissolveFrames (⌘⇧G on frames)', () => {
  const f = (id: string, over: Partial<CanvasElement> = {}): CanvasElement => ({
    id,
    type: 'frame',
    x: 0,
    y: 0,
    text: '',
    ...over,
  })
  const s = (id: string, over: Partial<CanvasElement> = {}): CanvasElement => ({
    id,
    type: 'sticky',
    x: 0,
    y: 0,
    text: '',
    ...over,
  })

  it('removes the selected frame and rehomes its children to the frame parent', () => {
    const els = [f('outer'), f('inner', { parentId: 'outer', layout: { mode: 'row', gap: 1, padding: 2, align: 'start' } }), s('a', { parentId: 'inner' })]
    const res = dissolveFrames(els, ['inner'])!
    expect(res.elements.find((e) => e.id === 'inner')).toBeUndefined()
    expect(res.elements.find((e) => e.id === 'a')!.parentId).toBe('outer')
    expect(res.freedIds).toEqual(['a'])
  })

  it('a top-level frame frees its children to top level (parentId dropped)', () => {
    const res = dissolveFrames([f('fr'), s('a', { parentId: 'fr' })], ['fr'])!
    expect(res.elements.find((e) => e.id === 'a')!.parentId).toBeUndefined()
  })

  it('dissolving nested frames together skips the also-dissolved ancestor', () => {
    const els = [f('outer'), f('inner', { parentId: 'outer' }), s('a', { parentId: 'inner' })]
    const res = dissolveFrames(els, ['outer', 'inner'])!
    expect(res.elements).toHaveLength(1)
    expect(res.elements[0].parentId).toBeUndefined()
  })

  it('a selected non-frame never dissolves its frame; no frame → null', () => {
    const els = [f('fr'), s('a', { parentId: 'fr' })]
    expect(dissolveFrames(els, ['a'])).toBeNull()
    expect(dissolveFrames(els, [])).toBeNull()
  })
})
