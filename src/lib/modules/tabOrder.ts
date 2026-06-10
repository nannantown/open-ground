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

import { type ModuleId } from '@/lib/modules/ids'

export function effectiveTabOrder(
  saved: readonly string[] | undefined,
  enabledIds: readonly ModuleId[],
): ModuleId[] {
  const enabledSet = new Set<string>(enabledIds)
  const seen = new Set<ModuleId>()
  const out: ModuleId[] = []
  for (const id of saved ?? []) {
    if (enabledSet.has(id) && !seen.has(id as ModuleId)) {
      seen.add(id as ModuleId)
      out.push(id as ModuleId)
    }
  }
  for (const id of enabledIds) {
    if (!seen.has(id)) out.push(id)
  }
  return out
}

// Apply a drag from `fromIndex` to `toIndex` over an order array, returning a new
// array. `toIndex` is the destination slot in the *original* array's index space
// (the same convention the existing task-list reorder uses). Out-of-range or
// no-op moves return a copy unchanged.
export function moveTab(
  order: readonly ModuleId[],
  fromIndex: number,
  toIndex: number,
): ModuleId[] {
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
