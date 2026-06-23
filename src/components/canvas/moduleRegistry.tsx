import type { ReactNode } from 'react'
import { Terminal, Palette, Columns3, Puzzle, Network } from 'lucide-react'
import { customTabId, type ModuleId } from '@/lib/modules/ids'
import type { ModuleDescriptor } from '@/lib/modules/descriptor'
import type { ExperimentId, ExperimentFlags } from '@/lib/types'

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
  /** Owner-only experiment gate. When set, the module is HIDDEN from EVERY
   *  surface — tab row, "+" picker, Ctrl+Tab cycle, render branch — unless this
   *  experiment's gate is OPEN for the current user (owner + the settings
   *  toggle, resolved server-side; see {@link ModuleGate} and ExperimentId in
   *  types). Absent ⇒ an always-on default module. A gated module never appears
   *  in release notes or the in-app manual (both hand-written, never derived
   *  from this registry). */
  experiment?: ExperimentId
}

/** Which owner-only experiments are currently OPEN for this user. Built from the
 *  resolved /api/experiments flags via {@link gateFromFlags}. The EMPTY set (the
 *  default below) hides every experimental module — exactly the shipped,
 *  signed-out, and non-owner state, so visibility fails closed. */
export interface ModuleGate {
  openExperiments: ReadonlySet<ExperimentId>
}

/** The safe default gate: no experiment open ⇒ experimental modules stay
 *  invisible. Every visibility helper defaults to this so a caller that forgets
 *  to thread the gate (and every existing pre-experiment call site / test)
 *  fails CLOSED — the experimental module is hidden, never accidentally shown. */
const NO_EXPERIMENTS: ModuleGate = { openExperiments: new Set() }

/** Build a {@link ModuleGate} from resolved experiment flags: an experiment is
 *  in the open set only when its flag is true. (The flags are already
 *  owner-ANDed server-side, so a non-owner's flags are all false ⇒ empty set.) */
export const gateFromFlags = (flags: ExperimentFlags): ModuleGate => ({
  openExperiments: new Set(
    (Object.keys(flags) as ExperimentId[]).filter((id) => flags[id]),
  ),
})

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
  // Owner-only experiment (hidden by default). `experiment: 'swarm'` keeps it
  // out of every visible surface until the swarm gate is open (owner + the
  // settings toggle). Listed last so, when shown, it sits after the always-on
  // defaults in registry order.
  { id: 'swarm', label: 'Swarm', icon: <Network size={10} strokeWidth={2.25} />, kind: 'native', default: true, experiment: 'swarm' },
]

// Whether a module is visible GLOBALLY for this user. A plain default module is
// always enabled; an `experiment`-gated one is enabled ONLY when that experiment
// is in the open set. The gate defaults to NO_EXPERIMENTS so callers that don't
// pass one (and every pre-experiment call site / test) see only the always-on
// defaults — experimental modules fail CLOSED. (Per-PROJECT hiding is a separate
// concept — ProjectData.disabledModules — applied where the tab row is computed,
// not here, so the global registry stays project-agnostic.)
export const isModuleEnabled = (
  m: ModuleDef,
  gate: ModuleGate = NO_EXPERIMENTS,
): boolean => (m.experiment ? gate.openExperiments.has(m.experiment) : true)

export const enabledModules = (gate: ModuleGate = NO_EXPERIMENTS): ModuleDef[] =>
  MODULES.filter((m) => isModuleEnabled(m, gate))

// Native descriptors for the currently-visible default set — the unified
// metadata currency the tab row and the "+" picker share with sandboxed custom
// tabs (see src/lib/modules/descriptor.ts). Gated experiments are filtered out
// the same way as in the tab row, so a hidden module never leaks into the "+"
// picker either. Per-project hiding (ProjectData.disabledModules) is applied by
// the caller.
export const nativeDescriptors = (
  gate: ModuleGate = NO_EXPERIMENTS,
): ModuleDescriptor[] =>
  enabledModules(gate).map((m) => ({ id: m.id, kind: m.kind, label: m.label }))

// Takes any string (not just ModuleId): callers validate persisted /
// drag-saved ids whose static type is already `string` in the custom-tabs
// world. A `custom:<uuid>` id is by construction never a built-in.
export const isModuleIdEnabled = (id: string): boolean =>
  MODULES.some(x => x.id === id)
