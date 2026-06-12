import { describe, it, expect } from 'vitest'
import { cloneSubset } from './canvasClone'
import type { CanvasElement } from './types'

const el = (over: Partial<CanvasElement> & { id: string }): CanvasElement => ({
  type: 'sticky',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

describe('cloneSubset', () => {
  let n = 0
  const mkId = () => `c${++n}`

  it('clones the subset with fresh ids, preserving order and positions', () => {
    const els = [el({ id: 'a', x: 10 }), el({ id: 'b', x: 20 }), el({ id: 'z' })]
    const res = cloneSubset(els, new Set(['a', 'b']), mkId)!
    expect(res.clones.map((c) => c.x)).toEqual([10, 20])
    expect(res.clones.map((c) => c.id)).toEqual([
      res.idMap.get('a'),
      res.idMap.get('b'),
    ])
    expect(res.clones[0].id).not.toBe('a')
  })

  it('remaps parentId inside the set, keeps it when the parent stays outside', () => {
    const els = [
      el({ id: 'f', type: 'frame' }),
      el({ id: 'child', parentId: 'f' }),
      el({ id: 'outside', parentId: 'elsewhere' }),
    ]
    const both = cloneSubset(els, new Set(['f', 'child']), mkId)!
    expect(both.clones[1].parentId).toBe(both.idMap.get('f'))
    const childOnly = cloneSubset(els, new Set(['child']), mkId)!
    expect(childOnly.clones[0].parentId).toBe('f') // clone stays in the frame
  })

  it('remaps anchorId inside the set and drops a dangling one', () => {
    const els = [
      el({ id: 'm', type: 'mock' }),
      el({ id: 'pin', type: 'comment', anchorId: 'm' }),
    ]
    const both = cloneSubset(els, new Set(['m', 'pin']), mkId)!
    expect(both.clones[1].anchorId).toBe(both.idMap.get('m'))
    const pinOnly = cloneSubset(els, new Set(['pin']), mkId)!
    expect(pinOnly.clones[0].anchorId).toBeUndefined()
  })

  it('returns null for an empty match', () => {
    expect(cloneSubset([el({ id: 'a' })], new Set(['nope']), mkId)).toBeNull()
  })
})
