import type { ReactNode } from 'react'
import { Terminal, Palette, Columns3, Puzzle } from 'lucide-react'
import { customTabId, type ModuleId } from '@/lib/modules/ids'
import type { ModuleDescriptor } from '@/lib/modules/descriptor'

// ─── Module registry ──────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the per-project tabs ("Grounds"). Previously the
// tab set was declared four times (a PanelView union, the Ctrl+Tab order array,
// the ViewTabs render array, and persistView's PANEL_TABS). They now derive
// from this one list, so adding a tab is one entry here (+ its render branch in
// ProjectPanel) — the first step toward tabs as pluggable modules.

// One tab-row entry. Built-in modules (ModuleDef) and user-built custom tabs
// (`custom:<uuid>`, docs/CUSTOM_TABS_PLAN.md) share this shape — ViewTabs
// renders TabDefs without caring which kind it holds.
export interface TabDef {
  id: string
  label: string
  icon: ReactNode
}

export interface ModuleDef extends TabDef {
  id: ModuleId
  /** Built-ins are always 'native' — compiled React shipped in the binary, as
   *  opposed to 'sandboxed' custom tabs rendered from user source. */
  kind: 'native'
  /** Ships pre-installed as part of the default set. A native can be HIDDEN
   *  per project (ProjectData.disabledModules) but never uninstalled. */
  default: true
}

// Tab-row metadata for a custom module: label from the fetched def, fixed
// Puzzle icon (custom tabs don't carry their own iconography — yet).
export const customModuleTabDef = (m: { id: string; label: string }): TabDef => ({
  id: customTabId(m.id),
  label: m.label,
  icon: <Puzzle size={10} strokeWidth={2.25} />,
})

// Default order = the tab row's initial left-to-right order AND the Ctrl+Tab
// cycle order for a project with no saved per-project order. Per-project the
// user can drag tabs to reorder; that order persists in ProjectData.tabOrder
// and is normalised against this registry (see effectiveTabOrder).
// NOTE: the old 'tasks' (Chats) tab is intentionally GONE. Per-project work is
// driven from the Terminal (live `claude` PTY panes); there is no chat-thread
// tab. Legacy kind:'chat' data is preserved on disk but is no longer surfaced.
// The 'goals' (Tasks) and 'overview' tabs were removed outright in the
// terminal-only purge — every module in the registry is always enabled.
export const MODULES: ModuleDef[] = [
  { id: 'board', label: 'Board', icon: <Columns3 size={10} strokeWidth={2.25} />, kind: 'native', default: true },
  { id: 'canvas', label: 'Canvas', icon: <Palette size={10} strokeWidth={2.25} />, kind: 'native', default: true },
  { id: 'terminal', label: 'Terminal', icon: <Terminal size={10} strokeWidth={2.25} />, kind: 'native', default: true },
]

// All registered modules ship enabled GLOBALLY. The helpers survive as the seam
// a future per-Ground entitlement check would hook into. (Per-PROJECT hiding is
// a separate concept — ProjectData.disabledModules — applied where the tab row
// is computed, not here, so the global registry stays project-agnostic.)
export const isModuleEnabled = (_m: ModuleDef): boolean => true

export const enabledModules = (): ModuleDef[] => MODULES.filter(isModuleEnabled)

// Native descriptors for the pre-installed default set — the unified metadata
// currency the tab row and the "+" picker share with sandboxed custom tabs (see
// src/lib/modules/descriptor.ts). All registered natives; per-project hiding
// (ProjectData.disabledModules) is applied by the caller.
export const nativeDescriptors = (): ModuleDescriptor[] =>
  MODULES.map((m) => ({ id: m.id, kind: m.kind, label: m.label }))

// Takes any string (not just ModuleId): callers validate persisted /
// drag-saved ids whose static type is already `string` in the custom-tabs
// world. A `custom:<uuid>` id is by construction never a built-in.
export const isModuleIdEnabled = (id: string): boolean =>
  MODULES.some(x => x.id === id)
