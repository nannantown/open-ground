// Per-project native-module enable state (docs/CUSTOM_TABS_PLAN.md — the
// "everything is a module" model).
//
// The built-in modules (Terminal / Canvas / Board) ship in the binary as the
// pre-installed default set: they can't be uninstalled, but a project may HIDE
// one from its tab row. That hidden set is `ProjectData.disabledModules` —
// PERSONAL per-project state exactly like tabOrder / customTabs (stays central
// in git-shared mode, sanitised on read, unknown ids ignored).
//
// These two helpers are the native counterpart of attach/detachCustomTab: the
// single client-side seam that mutates disabledModules. Pure (no React) so they
// unit-test under the node vitest environment.
//
// NOTE on tabOrder: unlike detachCustomTab (which scrubs the detached id so a
// re-attach lands at the row's end), disabling a native does NOT touch tabOrder.
// A native is only HIDDEN, not removed — keeping its saved drag position means
// re-enabling restores it where the user had it. effectiveTabOrder already drops
// a disabled id from the rendered order, so the lingering entry is inert.

import type { ModuleId } from '@/lib/modules/ids'

/** disabledModules with `moduleId` added once (idempotent). Always a new array —
 *  callers hand it straight to persist(). */
export function disableNativeModule(
  disabled: readonly string[] | undefined,
  moduleId: ModuleId,
): string[] {
  const list = disabled ?? []
  return list.includes(moduleId) ? [...list] : [...list, moduleId]
}

/** disabledModules with `moduleId` removed. Always a new array. */
export function enableNativeModule(
  disabled: readonly string[] | undefined,
  moduleId: ModuleId,
): string[] {
  return (disabled ?? []).filter((id) => id !== moduleId)
}
