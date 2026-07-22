// The per-project "Module" (tab) ids — a.k.a. "Grounds" in product copy.
// Plain (no React) so pure modules like persistView can validate against it
// without pulling in the icon-bearing registry. The icon/label metadata
// lives in src/components/canvas/moduleRegistry.tsx, keyed by these ids.

export type ModuleId =
  | 'terminal'
  | 'canvas'
  | 'board'
  // Owner-only experiment modules (hidden by default; see `experiment` in
  // moduleRegistry + ExperimentId in types). KNOWN native ids so persistence
  // / tab-order code treats them like any other built-in — but the registry's
  // gate keeps them out of every visible surface until their experiment is
  // open. Listed here only so the type system knows they exist.
  | 'swarm'
  | 'persona'

export const MODULE_IDS: readonly ModuleId[] = [
  'terminal',
  'canvas',
  'board',
  'swarm',
  'persona',
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
