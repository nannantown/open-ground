// The per-project "Module" (tab) ids — a.k.a. "Grounds" in product copy.
// Plain (no React) so pure modules like persistView can validate against it
// without pulling in the icon-bearing registry. The icon/label metadata
// lives in src/components/canvas/moduleRegistry.tsx, keyed by these ids.

export type ModuleId =
  | 'terminal'
  | 'canvas'
  | 'board'

export const MODULE_IDS: readonly ModuleId[] = [
  'terminal',
  'canvas',
  'board',
]
