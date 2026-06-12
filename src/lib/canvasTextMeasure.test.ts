import { describe, it, expect } from 'vitest'
import { textFootprintPatch, isLayoutManagedText } from './canvasTextMeasure'
import type { CanvasElement, FrameLayout } from './types'

const el = (over: Partial<CanvasElement> & { id: string }): CanvasElement => ({
  type: 'text',
  x: 0,
  y: 0,
  text: '',
  ...over,
})

const layout: FrameLayout = { mode: 'row', gap: 10, padding: 20, align: 'start' }

describe('textFootprintPatch', () => {
  it('writes the measurement quantised UP to a 2px grid when no size is stored yet', () => {
    // ceil-to-2px keeps the footprint stable across machines whose font
    // rasterisation differs by <2px (git-shared churn guard).
    expect(textFootprintPatch({}, 120.4, 30.6)).toEqual({ width: 122, height: 32 })
    expect(textFootprintPatch({}, 120, 30)).toEqual({ width: 120, height: 30 })
  })

  it('writes when either axis crosses a 2px-quantum boundary — both axes together', () => {
    expect(textFootprintPatch({ width: 120, height: 32 }, 150, 31)).toEqual({
      width: 150,
      height: 32,
    })
    expect(textFootprintPatch({ width: 120, height: 32 }, 120, 45)).toEqual({
      width: 120,
      height: 46,
    })
  })

  it('skips noise inside the quantum and equal sizes (the anti-ping-pong / cross-machine guard)', () => {
    expect(textFootprintPatch({ width: 120, height: 32 }, 120, 32)).toBeNull()
    expect(textFootprintPatch({ width: 120, height: 32 }, 119.2, 31.1)).toBeNull()
    expect(textFootprintPatch({ width: 120, height: 32 }, 118.4, 30.4)).toBeNull()
  })

  it('never writes a zero / negative measurement (unmounted or un-laid-out node)', () => {
    expect(textFootprintPatch({}, 0, 0)).toBeNull()
    expect(textFootprintPatch({ width: 120, height: 31 }, 0, 31)).toBeNull()
    expect(textFootprintPatch({}, -3, 10)).toBeNull()
  })
})

describe('isLayoutManagedText', () => {
  const frame = el({ id: 'f', type: 'frame', width: 400, height: 90, layout })
  const plain = el({ id: 'p', type: 'frame', width: 400, height: 90 })

  it('true only for a text whose parent frame carries auto layout', () => {
    const els = [frame, plain, el({ id: 't', parentId: 'f' })]
    expect(isLayoutManagedText(els, 't')).toBe(true)
  })

  it('false for free texts, plain-frame children, non-texts, locked texts and missing ids', () => {
    const els = [
      frame,
      plain,
      el({ id: 'free' }),
      el({ id: 'inPlain', parentId: 'p' }),
      el({ id: 's', type: 'sticky', parentId: 'f' }),
      el({ id: 'lk', parentId: 'f', locked: true }),
    ]
    expect(isLayoutManagedText(els, 'free')).toBe(false)
    expect(isLayoutManagedText(els, 'inPlain')).toBe(false)
    expect(isLayoutManagedText(els, 's')).toBe(false)
    // Locked = immune to every mutation, including this implicit one.
    expect(isLayoutManagedText(els, 'lk')).toBe(false)
    expect(isLayoutManagedText(els, 'nope')).toBe(false)
  })
})
