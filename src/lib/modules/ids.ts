// The per-project "Module" (tab) ids — a.k.a. "Grounds" in product copy.
// Plain (no React) so pure modules like persistView can validate against it
// without pulling in the icon-bearing registry. The icon/label metadata
// lives in src/components/canvas/moduleRegistry.tsx, keyed by these ids.

export type ModuleId =
  | 'terminal'
  | 'canvas'
  | 'board'
  | 'research'
  // Owner-only experiment module (hidden by default; see `experiments` in
  // moduleRegistry + ExperimentId in types). A KNOWN native id so persistence
  // / tab-order code treats it like any other built-in — but the registry's
  // gate keeps it out of every visible surface until its experiment is open.
  // Listed here only so the type system knows it exists.
  | 'swarm'

// RETIRED ids are simply absent from this list (e.g. 'persona', which left the
// tab row on 2026-08-14 for the Ground toolbar — see
// src/components/canvas/PersonaPanel.tsx). That absence is load-bearing rather
// than tidy-up: persistView validates the saved panel tab against MODULE_IDS,
// so a user whose last-open tab was a retired one has that value DROPPED on
// read and lands on the project's default tab — never on a blank panel with no
// matching row entry.
export const MODULE_IDS: readonly ModuleId[] = [
  'terminal',
  'canvas',
  'board',
  'research',
  'swarm',
]

// ─── Custom tabs (user-built modules) ───────────────────────────────────────
// A custom module stored under ~/.openground/custom-modules/<uuid>/ surfaces
// in the tab row under the id `custom:<uuid>` so it can never collide with a
// built-in ModuleId. The tab system (order persistence, Ctrl+Tab cycling,
// persistView) treats tab ids as plain strings; these helpers are the single
// place that encodes/decodes the prefix. See docs/CUSTOM_TABS_PLAN.md.

export type CustomTabId = `custom:${string}`

/** Any id that can appear in the per-project tab row. */
export type TabId = ModuleId | CustomTabId

const CUSTOM_PREFIX = 'custom:'

export const isCustomTabId = (id: string): id is CustomTabId =>
  id.startsWith(CUSTOM_PREFIX) && id.length > CUSTOM_PREFIX.length

/** Tab id for a stored custom module id (the bare uuid). */
export const customTabId = (moduleId: string): CustomTabId =>
  `${CUSTOM_PREFIX}${moduleId}`

/** Bare custom-module uuid from a `custom:<uuid>` tab id. */
export const customModuleIdFromTab = (id: CustomTabId): string =>
  id.slice(CUSTOM_PREFIX.length)
