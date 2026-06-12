import { describe, it, expect } from 'vitest'
import {
  MODULE_IDS,
  customTabId,
  customModuleIdFromTab,
  isCustomTabId,
} from '@/lib/modules/ids'

// The `custom:<uuid>` tab-id helpers are the single encode/decode seam between
// the stored custom-module ids (bare uuids) and the tab system's string ids
// (docs/CUSTOM_TABS_PLAN.md). These tests pin the round-trip and that the
// prefix can never collide with a built-in ModuleId.

describe('customTabId / customModuleIdFromTab', () => {
  it('round-trips a module uuid', () => {
    const uuid = 'a3f1c2d4-5678-4abc-9def-0123456789ab'
    const tab = customTabId(uuid)
    expect(tab).toBe(`custom:${uuid}`)
    expect(customModuleIdFromTab(tab)).toBe(uuid)
  })

  it('never produces a built-in module id', () => {
    for (const id of MODULE_IDS) {
      expect(isCustomTabId(id)).toBe(false)
      expect(customTabId(id)).not.toBe(id)
    }
  })
})

describe('isCustomTabId', () => {
  it('accepts prefixed non-empty ids', () => {
    expect(isCustomTabId('custom:abc')).toBe(true)
    expect(isCustomTabId(customTabId('x'))).toBe(true)
  })

  it('rejects the bare prefix, built-ins and arbitrary strings', () => {
    expect(isCustomTabId('custom:')).toBe(false)
    expect(isCustomTabId('custom')).toBe(false)
    expect(isCustomTabId('board')).toBe(false)
    expect(isCustomTabId('')).toBe(false)
    expect(isCustomTabId('Custom:abc')).toBe(false) // case-sensitive prefix
  })
})
