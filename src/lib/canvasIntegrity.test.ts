import { describe, it, expect } from 'vitest'
import { clearDanglingAnchors, removeElements } from './canvasIntegrity'
import type { CanvasElement } from './types'

const el = (over: Partial<CanvasElement>): CanvasElement => ({
  id: 'x',
  type: 'text',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

describe('clearDanglingAnchors', () => {
  it('keeps a comment whose anchor still exists', () => {
    const els = [
      el({ id: 'mock1', type: 'mock', text: '<div/>' }),
      el({ id: 'c1', type: 'comment', text: 'fix this', anchorId: 'mock1' }),
    ]
    const out = clearDanglingAnchors(els)
    expect(out).toBe(els) // no change → same reference
    expect(out[1].anchorId).toBe('mock1')
  })

  it('drops anchorId when the anchor element is gone', () => {
    const els = [
      el({ id: 'c1', type: 'comment', text: 'fix this', anchorId: 'mock1' }),
    ]
    const out = clearDanglingAnchors(els)
    expect(out).not.toBe(els) // changed → new array
    expect(out[0].anchorId).toBeUndefined()
    expect('anchorId' in out[0]).toBe(false)
    // The rest of the comment is preserved.
    expect(out[0].text).toBe('fix this')
    expect(out[0].id).toBe('c1')
  })

  it('only scrubs comment elements, never others', () => {
    // A non-comment element carrying a stray anchorId (shouldn't happen, but be
    // safe) is left untouched — anchorId is a comment-only concept.
    const els = [el({ id: 't1', type: 'text', anchorId: 'gone' })]
    const out = clearDanglingAnchors(els)
    expect(out).toBe(els)
    expect(out[0].anchorId).toBe('gone')
  })

  it('handles a comment with no anchorId', () => {
    const els = [el({ id: 'c1', type: 'comment', text: 'free-floating note' })]
    expect(clearDanglingAnchors(els)).toBe(els)
  })

  it('scrubs only the dangling comments, keeps the resolvable ones', () => {
    const els = [
      el({ id: 'mock1', type: 'mock', text: '<div/>' }),
      el({ id: 'live', type: 'comment', text: 'a', anchorId: 'mock1' }),
      el({ id: 'dead', type: 'comment', text: 'b', anchorId: 'mock-gone' }),
    ]
    const out = clearDanglingAnchors(els)
    expect(out).not.toBe(els)
    expect(out.find((e) => e.id === 'live')!.anchorId).toBe('mock1')
    expect(out.find((e) => e.id === 'dead')!.anchorId).toBeUndefined()
  })

  it('is a no-op on an empty array', () => {
    const els: CanvasElement[] = []
    expect(clearDanglingAnchors(els)).toBe(els)
  })
})

// removeElements is THE shared deletion path: Delete/Backspace, context-menu
// delete, and Cut (⌘X) all funnel through it, so a cut can't strand a comment
// anchor or a frame/design parentId. These cases mirror the cut scenario.
describe('removeElements', () => {
  it('drops the named elements', () => {
    const els = [
      el({ id: 'a' }),
      el({ id: 'b' }),
      el({ id: 'c' }),
    ]
    const out = removeElements(els, ['b'])
    expect(out.map((e) => e.id)).toEqual(['a', 'c'])
  })

  it('accepts a Set of ids as well as an array', () => {
    const els = [el({ id: 'a' }), el({ id: 'b' })]
    const out = removeElements(els, new Set(['a', 'b']))
    expect(out).toEqual([])
  })

  it('scrubs a comment anchor stranded by cutting its anchor element', () => {
    // Cutting the mock removes it; the comment that pointed at it must not keep
    // a dangling anchorId.
    const els = [
      el({ id: 'mock1', type: 'mock', text: '<div/>' }),
      el({ id: 'c1', type: 'comment', text: 'fix this', anchorId: 'mock1' }),
    ]
    const out = removeElements(els, ['mock1'])
    expect(out.map((e) => e.id)).toEqual(['c1'])
    expect(out[0].anchorId).toBeUndefined()
    expect('anchorId' in out[0]).toBe(false)
  })

  it('scrubs a frame parentId stranded by cutting the frame', () => {
    // Cutting the frame removes it; a child left behind must not keep a dangling
    // parentId pointing at the now-gone frame.
    const els = [
      el({ id: 'f1', type: 'frame', width: 200, height: 200 }),
      el({ id: 't1', type: 'text', parentId: 'f1' }),
    ]
    const out = removeElements(els, ['f1'])
    expect(out.map((e) => e.id)).toEqual(['t1'])
    expect(out[0].parentId).toBeUndefined()
    expect('parentId' in out[0]).toBe(false)
  })

  it('keeps anchors/parents that survive the cut', () => {
    // Cutting only the comment leaves the mock + a sibling whose references are
    // all still live — nothing should be scrubbed.
    const els = [
      el({ id: 'f1', type: 'frame', width: 200, height: 200 }),
      el({ id: 'mock1', type: 'mock', text: '<div/>' }),
      el({ id: 't1', type: 'text', parentId: 'f1' }),
      el({ id: 'c1', type: 'comment', text: 'note', anchorId: 'mock1' }),
    ]
    const out = removeElements(els, ['c1'])
    expect(out.map((e) => e.id)).toEqual(['f1', 'mock1', 't1'])
    expect(out.find((e) => e.id === 't1')!.parentId).toBe('f1')
  })

  it('returns the same reference when no id matched (no-op write)', () => {
    const els = [el({ id: 'a' }), el({ id: 'b' })]
    expect(removeElements(els, ['nope'])).toBe(els)
  })

  it('returns the same reference on an empty id set', () => {
    const els = [el({ id: 'a' })]
    expect(removeElements(els, [])).toBe(els)
  })

  it('prunes a group left empty after its members are deleted', () => {
    const els = [
      el({ id: 'g', type: 'group' }),
      el({ id: 'a', type: 'sticky', parentId: 'g' }),
      el({ id: 'b', type: 'sticky', parentId: 'g' }),
    ]
    const out = removeElements(els, ['a', 'b'])
    // members gone AND the now-childless group is pruned, not left as a ghost.
    expect(out.map((e) => e.id)).toEqual([])
  })

  it('keeps a group that still has a surviving member', () => {
    const els = [
      el({ id: 'g', type: 'group' }),
      el({ id: 'a', type: 'sticky', parentId: 'g' }),
      el({ id: 'b', type: 'sticky', parentId: 'g' }),
    ]
    const out = removeElements(els, ['a'])
    expect(out.find((e) => e.id === 'g')).toBeDefined()
    expect(out.find((e) => e.id === 'b')).toBeDefined()
  })

  it('prunes nested groups to a fixed point', () => {
    const els = [
      el({ id: 'go', type: 'group' }),
      el({ id: 'gi', type: 'group', parentId: 'go' }),
      el({ id: 'a', type: 'sticky', parentId: 'gi' }),
    ]
    // delete the only leaf → inner group empties → outer group empties too.
    const out = removeElements(els, ['a'])
    expect(out.map((e) => e.id)).toEqual([])
  })
})
