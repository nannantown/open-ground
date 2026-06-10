import { describe, it, expect } from 'vitest'
import { effectiveTabOrder, moveTab } from '@/lib/modules/tabOrder'
import { type ModuleId } from '@/lib/modules/ids'

// The default core registry order used across these tests.
const DEFAULT: ModuleId[] = ['board', 'canvas', 'terminal']

describe('effectiveTabOrder', () => {
  it('returns the registry default order when nothing is saved', () => {
    expect(effectiveTabOrder(undefined, DEFAULT)).toEqual(DEFAULT)
    expect(effectiveTabOrder([], DEFAULT)).toEqual(DEFAULT)
  })

  it('honours a fully-specified saved order', () => {
    const saved = ['terminal', 'canvas', 'board']
    expect(effectiveTabOrder(saved, DEFAULT)).toEqual([
      'terminal',
      'canvas',
      'board',
    ])
  })

  it('drops unknown / retired ids (e.g. the removed "goals" / "doc" Grounds)', () => {
    const saved = ['board', 'links', 'goals', 'doc', 'canvas', 'terminal']
    expect(effectiveTabOrder(saved, DEFAULT)).toEqual([
      'board',
      'canvas',
      'terminal',
    ])
  })

  it('appends enabled modules missing from the saved order, in registry order', () => {
    // Saved only knows about one tab; the rest must come back at the end.
    const saved = ['terminal']
    expect(effectiveTabOrder(saved, DEFAULT)).toEqual([
      'terminal',
      'board',
      'canvas',
    ])
  })

  it('dedupes repeated ids in the saved order', () => {
    const saved = ['canvas', 'canvas', 'board', 'board']
    expect(effectiveTabOrder(saved, DEFAULT)).toEqual([
      'canvas',
      'board',
      'terminal',
    ])
  })
})

describe('moveTab', () => {
  it('moves an item forward (drop after a later slot)', () => {
    // drag index 0 (board) to slot 2 → lands between canvas and terminal
    expect(moveTab(DEFAULT, 0, 2)).toEqual(['canvas', 'board', 'terminal'])
  })

  it('moves an item to the very end', () => {
    expect(moveTab(DEFAULT, 0, 3)).toEqual(['canvas', 'terminal', 'board'])
  })

  it('moves an item backward (drop before an earlier slot)', () => {
    // drag index 2 (terminal) to slot 0 → before board
    expect(moveTab(DEFAULT, 2, 0)).toEqual(['terminal', 'board', 'canvas'])
  })

  it('is a no-op when dropped onto its own slot', () => {
    expect(moveTab(DEFAULT, 1, 1)).toEqual(DEFAULT)
    expect(moveTab(DEFAULT, 1, 2)).toEqual(DEFAULT)
  })

  it('returns an unchanged copy for out-of-range indices', () => {
    expect(moveTab(DEFAULT, -1, 2)).toEqual(DEFAULT)
    expect(moveTab(DEFAULT, 9, 2)).toEqual(DEFAULT)
  })
})
