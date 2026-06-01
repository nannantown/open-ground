// Persist "where the user is" across a page reload.
//
// Today a reload always drops the user back on the top Ground canvas: the open
// project (App's `selectedIds`) and the project panel's active tab
// (ProjectPanel's `view`) both live in volatile React state. This module saves
// that location to localStorage and restores it on mount, mirroring the
// per-path localStorage pattern already used for terminal slots / sidebar width.
//
// Scope note: the *active Canvas within the Canvas tab* (Chrome-style tabs) is
// already persisted server-side in `.openground/canvases-index.json`
// (`index.activeId`), so reopening the project + Canvas tab restores it for
// free. We only persist the open-project id and the panel tab here.
//
// The functions take an injectable `Storage` so the pure save/restore logic is
// unit-testable under the default `node` (no-`window`) vitest environment.

import { migrateLs } from '@/lib/lsMigrate'

/** The set of panel tabs we persist. Mirrors ProjectPanel's `PanelView`. */
export type PersistedPanelTab = 'overview' | 'tasks' | 'terminal' | 'canvas' | 'board' | 'goals'

const PANEL_TABS: readonly PersistedPanelTab[] = [
  'overview',
  'tasks',
  'terminal',
  'canvas',
  'board',
  'goals',
]

export interface PersistedView {
  /** SHA1 project id of the open project (App's `selectedIds[0]`). */
  projectId?: string
  /** The project panel's active tab. */
  panelTab?: PersistedPanelTab
}

export const VIEW_KEY = 'openground.view'
const LEGACY_VIEW_KEY = 'hove.view'

/** Best-effort access to the browser store; null in SSR / locked-down contexts. */
function defaultStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * Parse a raw JSON string into a PersistedView, dropping anything that doesn't
 * match the expected shape. Returns `{}` for missing / malformed / hostile
 * input so callers always get a safe object to read from.
 */
export function parsePersistedView(raw: string | null | undefined): PersistedView {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const obj = parsed as Record<string, unknown>
  const out: PersistedView = {}
  if (typeof obj.projectId === 'string' && obj.projectId.length > 0) {
    out.projectId = obj.projectId
  }
  if (
    typeof obj.panelTab === 'string' &&
    (PANEL_TABS as readonly string[]).includes(obj.panelTab)
  ) {
    out.panelTab = obj.panelTab as PersistedPanelTab
  }
  return out
}

/** Read the persisted view. Falls back to `{}` (→ Ground) on any failure. */
export function loadPersistedView(storage: Storage | null = defaultStorage()): PersistedView {
  if (!storage) return {}
  try {
    migrateLs(LEGACY_VIEW_KEY, VIEW_KEY)
  } catch {
    // migrateLs already swallows its own errors; guard the no-window path too.
  }
  try {
    return parsePersistedView(storage.getItem(VIEW_KEY))
  } catch {
    return {}
  }
}

/**
 * Merge `patch` into the stored view and write it back. Passing `projectId:
 * undefined` (or `panelTab: undefined`) clears that field — e.g. closing the
 * panel / returning to Ground clears `projectId`. Storing an empty object
 * removes the key entirely.
 */
export function savePersistedView(
  patch: PersistedView,
  storage: Storage | null = defaultStorage(),
): void {
  if (!storage) return
  try {
    const current = parsePersistedView(storage.getItem(VIEW_KEY))
    const next: PersistedView = { ...current }
    if ('projectId' in patch) {
      if (patch.projectId) next.projectId = patch.projectId
      else delete next.projectId
    }
    if ('panelTab' in patch) {
      if (patch.panelTab) next.panelTab = patch.panelTab
      else delete next.panelTab
    }
    if (!next.projectId && !next.panelTab) {
      storage.removeItem(VIEW_KEY)
      return
    }
    storage.setItem(VIEW_KEY, JSON.stringify(next))
  } catch {
    // Private-mode / quota-exhausted localStorage throws — not worth surfacing.
  }
}
