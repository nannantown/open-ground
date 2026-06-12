import { describe, it, expect } from 'vitest'
import { effectiveTabOrder, moveTab, preserveCustomTabs } from '@/lib/modules/tabOrder'
import { customTabId, type ModuleId } from '@/lib/modules/ids'

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

// ─── Custom tabs (docs/CUSTOM_TABS_PLAN.md) ─────────────────────────────────
// The same reconciliation drives the widened row that mixes built-ins with
// `custom:<uuid>` ids — ProjectPanel passes [...builtins, ...customTabId(...)]
// as the enabled set. These cases pin the behaviors the tab UI depends on.

describe('effectiveTabOrder with custom tab ids', () => {
  const CUSTOM_A = customTabId('aaaaaaaa-0000-4000-8000-000000000001')
  const CUSTOM_B = customTabId('bbbbbbbb-0000-4000-8000-000000000002')
  const ALL = [...DEFAULT, CUSTOM_A, CUSTOM_B]

  it('appends new custom tabs after the built-ins when nothing is saved', () => {
    expect(effectiveTabOrder(undefined, ALL)).toEqual(ALL)
  })

  it('honours a saved order that interleaves custom and built-in tabs', () => {
    const saved = [CUSTOM_B, 'board', CUSTOM_A, 'terminal', 'canvas']
    expect(effectiveTabOrder(saved, ALL)).toEqual(saved)
  })

  it('drops a deleted custom module from the saved order', () => {
    const gone = customTabId('cccccccc-0000-4000-8000-000000000003')
    const saved = ['board', gone, CUSTOM_A, 'canvas', 'terminal', CUSTOM_B]
    expect(effectiveTabOrder(saved, ALL)).toEqual([
      'board',
      CUSTOM_A,
      'canvas',
      'terminal',
      CUSTOM_B,
    ])
  })

  it('appends a newly created custom tab missing from the saved order', () => {
    const saved = ['terminal', 'board', 'canvas']
    expect(effectiveTabOrder(saved, ALL)).toEqual([
      'terminal',
      'board',
      'canvas',
      CUSTOM_A,
      CUSTOM_B,
    ])
  })

  it('moveTab reorders a custom tab like any other id', () => {
    const order = effectiveTabOrder(undefined, ALL)
    // Drag the last custom tab to the front.
    expect(moveTab(order, order.length - 1, 0)).toEqual([
      CUSTOM_B,
      'board',
      'canvas',
      'terminal',
      CUSTOM_A,
    ])
  })
})

describe('preserveCustomTabs', () => {
  // A drag performed before the custom-module list has loaded reorders the
  // builtin-only row; persisting it verbatim would scrub the saved `custom:*`
  // ids (and their dragged positions). These cases pin the re-insertion.
  const CUSTOM_A = customTabId('aaaaaaaa-0000-4000-8000-000000000001')
  const CUSTOM_B = customTabId('bbbbbbbb-0000-4000-8000-000000000002')

  it('re-inserts a missing custom id after its surviving predecessor', () => {
    const saved = ['terminal', CUSTOM_A, 'board', 'canvas']
    // The user dragged canvas to the front of the builtin-only row.
    const reordered = ['canvas', 'terminal', 'board']
    expect(preserveCustomTabs(saved, reordered)).toEqual([
      'canvas',
      'terminal',
      CUSTOM_A,
      'board',
    ])
  })

  it('keeps adjacent custom tabs in their saved relative order', () => {
    const saved = ['terminal', CUSTOM_A, CUSTOM_B, 'board', 'canvas']
    const reordered = ['board', 'terminal', 'canvas']
    expect(preserveCustomTabs(saved, reordered)).toEqual([
      'board',
      'terminal',
      CUSTOM_A,
      CUSTOM_B,
      'canvas',
    ])
  })

  it('keeps a head-of-row custom tab at the head', () => {
    const saved = [CUSTOM_A, 'board', 'canvas', 'terminal']
    const reordered = ['terminal', 'board', 'canvas']
    expect(preserveCustomTabs(saved, reordered)).toEqual([
      CUSTOM_A,
      'terminal',
      'board',
      'canvas',
    ])
  })

  it('never duplicates a custom id already present in the row', () => {
    const saved = ['board', CUSTOM_A, 'canvas', 'terminal']
    const reordered = [CUSTOM_A, 'board', 'canvas', 'terminal']
    expect(preserveCustomTabs(saved, reordered)).toEqual(reordered)
  })

  it('never resurrects a dropped builtin (only custom ids are preserved)', () => {
    // 'goals' is a retired builtin lingering in an old saved order — the
    // reconciler dropped it on purpose, so the merge must not bring it back.
    const saved = ['board', 'goals', CUSTOM_A, 'canvas', 'terminal']
    const reordered = ['canvas', 'board', 'terminal']
    expect(preserveCustomTabs(saved, reordered)).toEqual([
      'canvas',
      'board',
      CUSTOM_A,
      'terminal',
    ])
  })

  it('is a no-op for an undefined or custom-free saved order', () => {
    const reordered = ['canvas', 'board', 'terminal']
    expect(preserveCustomTabs(undefined, reordered)).toEqual(reordered)
    expect(preserveCustomTabs(['terminal', 'board'], reordered)).toEqual(reordered)
  })
})
