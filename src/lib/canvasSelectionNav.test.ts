import { describe, it, expect } from 'vitest'
import { siblingId, firstChildId, parentId } from './canvasSelectionNav'
import type { CanvasElement } from './types'

const el = (over: Partial<CanvasElement> & { id: string }): CanvasElement => ({
  type: 'sticky',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

// f frame ─ a, b, hiddenX, c(comment) children; top-level: f, t
const els = [
  el({ id: 'f', type: 'frame' }),
  el({ id: 'a', parentId: 'f' }),
  el({ id: 'hiddenX', parentId: 'f', hidden: true }),
  el({ id: 'b', parentId: 'f' }),
  el({ id: 'pin', type: 'comment', parentId: 'f' }),
  el({ id: 't', type: 'text' }),
]

describe('siblingId (Tab / ⇧Tab)', () => {
  it('cycles forward and backward among visible non-comment siblings', () => {
    expect(siblingId(els, 'a', 1)).toBe('b')
    expect(siblingId(els, 'b', 1)).toBe('a') // wraps, skipping hidden + comment
    expect(siblingId(els, 'a', -1)).toBe('b')
  })
  it('walks top-level siblings too, and returns null for an only child', () => {
    expect(siblingId(els, 'f', 1)).toBe('t')
    expect(siblingId([el({ id: 'solo' })], 'solo', 1)).toBeNull()
  })
})

describe('firstChildId (Enter)', () => {
  it('returns the first visible child, null for a leaf', () => {
    expect(firstChildId(els, 'f')).toBe('a')
    expect(firstChildId(els, 't')).toBeNull()
  })
})

describe('parentId (⇧Enter)', () => {
  it('returns the container, null at top level', () => {
    expect(parentId(els, 'a')).toBe('f')
    expect(parentId(els, 'f')).toBeNull()
  })
  it('skips group ancestors (selection units, not objects)', () => {
    const grouped = [
      el({ id: 'frame', type: 'frame' }),
      el({ id: 'g', type: 'group', parentId: 'frame' }),
      el({ id: 'm', parentId: 'g' }),
    ]
    expect(parentId(grouped, 'm')).toBe('frame')
  })
})
