// Per-project tab ("Ground") order normalisation.
//
// A project may persist a custom left-to-right tab order in
// `ProjectData.tabOrder` (the drag-to-reorder result). That stored list can
// drift from the live module registry: a module may have been removed (e.g. the
// retired "Links" Ground), a new one added, or an entry could be a stale/unknown
// id. `effectiveTabOrder` reconciles the saved order against the set of
// currently-enabled module ids so the UI always renders a complete, valid order:
//
//   1. take the saved ids that are still enabled, in their saved sequence
//      (dropping unknown / disabled / duplicate ids);
//   2. append any enabled module missing from the saved list, in registry order
//      (so a newly-added Ground shows up at the end rather than vanishing).
//
// No saved order (undefined / empty) → the registry default order verbatim.
//
// Pure (no React / no registry import) so it unit-tests under the node vitest
// environment; the caller passes the live enabled-id list from the registry.

import { MODULE_IDS, isCustomTabId, type ModuleId } from '@/lib/modules/ids'

// Generic over the id type so the same reconciliation serves the built-in
// ModuleId row and the widened row that includes `custom:<uuid>` tab ids
// (docs/CUSTOM_TABS_PLAN.md). Defaults to ModuleId so existing callers and
// tests are unchanged.
export function effectiveTabOrder<T extends string = ModuleId>(
  saved: readonly string[] | undefined,
  enabledIds: readonly T[],
): T[] {
  const enabledSet = new Set<string>(enabledIds)
  const seen = new Set<T>()
  const out: T[] = []
  for (const id of saved ?? []) {
    if (enabledSet.has(id) && !seen.has(id as T)) {
      seen.add(id as T)
      out.push(id as T)
    }
  }
  for (const id of enabledIds) {
    if (!seen.has(id)) out.push(id)
  }
  return out
}

// Preserve saved but hidden tabs when reordering the visible projection. Role
// changes, disabled modules and a loading library are not deletions. Missing
// known IDs stay next to their saved predecessor; truly retired native IDs do
// not return. Explicit detach still removes its ID through detachCustomTab.
export function preserveHiddenTabs<T extends string>(
  saved: readonly string[] | undefined,
  reordered: readonly T[],
): T[] {
  const out: T[] = [...reordered]
  const savedIds = saved ?? []
  savedIds.forEach((id, idx) => {
    if ((!isCustomTabId(id) && !MODULE_IDS.includes(id as ModuleId)) || out.includes(id as T)) return
    let insertAt = 0
    for (let i = idx - 1; i >= 0; i--) {
      const at = out.indexOf(savedIds[i] as T)
      if (at !== -1) {
        insertAt = at + 1
        break
      }
    }
    out.splice(insertAt, 0, id as T)
  })
  return out
}

// Apply a drag from `fromIndex` to `toIndex` over an order array, returning a new
// array. `toIndex` is the destination slot in the *original* array's index space
// (the same convention the existing task-list reorder uses). Out-of-range or
// no-op moves return a copy unchanged.
export function moveTab<T extends string = ModuleId>(
  order: readonly T[],
  fromIndex: number,
  toIndex: number,
): T[] {
  const next = [...order]
  if (
    fromIndex < 0 ||
    fromIndex >= next.length ||
    toIndex < 0 ||
    toIndex > next.length
  ) {
    return next
  }
  const [moved] = next.splice(fromIndex, 1)
  // Removing the dragged item shifts every later index left by one, so a drop
  // slot that sat after the source must be decremented to land where intended.
  const dest = toIndex > fromIndex ? toIndex - 1 : toIndex
  next.splice(dest, 0, moved)
  return next
}
