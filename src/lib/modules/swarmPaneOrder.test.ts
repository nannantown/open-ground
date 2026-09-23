import { describe, it, expect } from 'vitest'
import { effectiveTabOrder, moveTab } from '@/lib/modules/tabOrder'
import { SWARM_PANE_IDS, type SwarmPaneId } from '@/lib/types'

// The Swarm sub-tab strip REUSES the per-project tab-row helpers (effectiveTabOrder
// / moveTab) over the canonical pane-id list SWARM_PANE_IDS — no bespoke helper.
// These pin the swarm-specific behaviours the acceptance conditions name:
//   条件3  existing users (nothing saved) keep the shipped order, supply first;
//   条件1  a drag reorders a pane (moveTab);
//   条件2/3 a saved order is honoured and its FIRST id becomes the default tab;
//   and a stale/garbage saved order can never strand a pane (reconcile).

const DEFAULT = [...SWARM_PANE_IDS]

describe('swarm pane order derivation', () => {
  it('defaults to the shipped order (supply first) when nothing is saved — existing users unchanged (条件3/5)', () => {
    const order = effectiveTabOrder<SwarmPaneId>(undefined, SWARM_PANE_IDS)
    expect(order).toEqual(['supply', 'manager', 'workers'])
    // The FIRST id is the tab that opens by default.
    expect(order[0]).toBe('supply')
  })

  it('honours a fully-specified saved order and opens its first tab (条件2/3)', () => {
    const saved = ['manager', 'supply', 'workers']
    const order = effectiveTabOrder<SwarmPaneId>(saved, SWARM_PANE_IDS)
    expect(order).toEqual(saved)
    // Reordering the front changes which tab opens next time.
    expect(order[0]).toBe('manager')
  })

  it('moveTab drags a pane to the front, changing the default open tab (条件1/3)', () => {
    // Drag "workers" (index 2) to the very front.
    const next = moveTab(DEFAULT, 2, 0)
    expect(next).toEqual(['workers', 'supply', 'manager'])
    expect(next[0]).toBe('workers')
  })

  it('moveTab reorders in the middle without disturbing the rest', () => {
    // Drag "workers" (index 2) to slot 1 (before "manager").
    expect(moveTab(DEFAULT, 2, 1)).toEqual(['supply', 'workers', 'manager'])
  })

  it('reconciles a stale saved order: drops unknown ids, appends missing panes in canonical order', () => {
    // Retired ids ("flow", and "overseer" — the 監督 tab, removed 2026-09-23)
    // linger in an old saved order and must be dropped; "workers" predates the
    // saved order here — it must come back, never be stranded.
    const saved = ['manager', 'flow', 'overseer', 'supply']
    expect(effectiveTabOrder<SwarmPaneId>(saved, SWARM_PANE_IDS)).toEqual(['manager', 'supply', 'workers'])
  })

  it('dedupes a corrupted saved order', () => {
    const saved = ['workers', 'workers', 'supply']
    expect(effectiveTabOrder<SwarmPaneId>(saved, SWARM_PANE_IDS)).toEqual([
      'workers',
      'supply',
      'manager',
    ])
  })
})
