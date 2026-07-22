// Unified per-project module descriptor (docs/CUSTOM_TABS_PLAN.md — the
// "everything is a module" model).
//
// The tab row holds two KINDS of module that the UI treats uniformly:
//   - 'native'    — built-in modules compiled into the binary (Terminal /
//                   Canvas / Board: the pre-installed default set). They carry
//                   no source/framework and never touch disk or Supabase.
//   - 'sandboxed' — user-built custom tabs (`custom:<uuid>`), rendered from
//                   their source inside a sandboxed iframe (CustomModuleView).
//
// A ModuleDescriptor is the single metadata currency both kinds flow through
// (the tab row already renders either via TabDef in moduleRegistry.tsx). It is
// DERIVED, never persisted: native descriptors come from the static MODULES
// registry (moduleRegistry.nativeDescriptors), sandboxed ones from the fetched
// CustomModuleDef list. The PERSISTENCE layer stays split on purpose — a native
// has no CustomModuleDef and never publishes — so validateProjectPath, the
// iframe sandbox and the Supabase glue are all untouched in shape.
//
// Pure (no React) so it unit-tests under the node vitest environment; native
// labels/icons live in the registry, which builds its own native descriptors.

import { customTabId } from '@/lib/modules/ids'
import type { CustomModuleDef } from '@/lib/types'

export type ModuleKind = 'native' | 'sandboxed'

export interface ModuleDescriptor {
  /** Tab-row id: a ModuleId ('terminal'|'canvas'|'board') for natives, a
   *  `custom:<uuid>` id for sandboxed. This is what tabOrder / Ctrl+Tab /
   *  persistView already key on, so the row treats both kinds identically. */
  id: string
  kind: ModuleKind
  label: string
  /** native only — i18n key for a TRANSLATED name (see TabDef.labelKey in
   *  moduleRegistry). Set on natives whose name is localised product copy; a
   *  sandboxed module's label is user-authored, so it never has one. */
  labelKey?: string
  /** sandboxed only — the on-disk def (source/framework/origin/remoteId…). */
  def?: CustomModuleDef
}

/** Descriptor for one user-built custom module. */
export const sandboxedDescriptor = (def: CustomModuleDef): ModuleDescriptor => ({
  id: customTabId(def.id),
  kind: 'sandboxed',
  label: def.label,
  def,
})

/** Descriptors for a list of custom modules, preserving the input order. */
export const descriptorsFor = (
  modules: readonly CustomModuleDef[],
): ModuleDescriptor[] => modules.map(sandboxedDescriptor)
