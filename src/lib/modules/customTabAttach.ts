// Per-project custom-tab attachment (docs/CUSTOM_TABS_PLAN.md — "Per-project
// attachment & the '+' picker").
//
// The module library (~/.openground/custom-modules/) is USER-level; which
// modules surface in a given project's tab row is the per-project list
// `ProjectData.customTabs` (bare module uuids, personal state like tabOrder).
// These two helpers are the single client-side seam that mutates that list:
//
//   - attach: append the id once (idempotent — re-attaching is a no-op);
//   - detach: drop the id AND scrub its `custom:<id>` entry from tabOrder so
//     a later re-attach lands at the row's end instead of resurrecting a
//     stale dragged position.
//
// Pure (no React) so they unit-test under the node vitest environment.

import { customTabId } from '@/lib/modules/ids'

/** Attached-module list with `moduleId` appended (once). Always returns a new
 *  array — callers hand it straight to persist(). */
export function attachCustomTab(
  attached: readonly string[] | undefined,
  moduleId: string,
): string[] {
  const list = attached ?? []
  return list.includes(moduleId) ? [...list] : [...list, moduleId]
}

/** The `customTabs` + `tabOrder` pair after detaching `moduleId` from a
 *  project. tabOrder keeps its undefined-ness (a project that never reordered
 *  its tabs must not suddenly persist an explicit order). */
export function detachCustomTab(
  data: { customTabs?: readonly string[]; tabOrder?: readonly string[] },
  moduleId: string,
): { customTabs: string[]; tabOrder?: string[] } {
  const tab = customTabId(moduleId)
  return {
    customTabs: (data.customTabs ?? []).filter(id => id !== moduleId),
    tabOrder: data.tabOrder?.filter(id => id !== tab),
  }
}
