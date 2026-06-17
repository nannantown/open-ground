// Recent colours (Figma's swatch history) — a small most-recently-used list of
// real colours the user has applied, surfaced under the inspector's Fill swatch
// for one-click reuse. Persisted in localStorage so it survives reloads; a
// single-user local tool, so a global list (not per-canvas) matches how the
// user actually reaches for "that colour I just used".
//
// The pure list transform (nextRecents) lives here, unit-tested in isolation;
// the localStorage read/write are thin browser-guarded wrappers around it.

import { formatColor, parseColor } from './canvasColor'
import { isNoFill } from './canvasFillStyle'

export const MAX_RECENT_COLORS = 8
const STORAGE_KEY = 'og:recent-colors'

/** Normalise a colour to a stable canonical hex so '#FFF', '#ffffff' and
 *  'rgb(255,255,255)' don't all sit in the list as separate entries. Returns
 *  null for anything that isn't a real, opaque-or-alpha colour worth
 *  remembering (no-fill / unparseable / named / gradient). */
function canonical(color: string): string | null {
  if (isNoFill(color)) return null
  const c = parseColor(color)
  return c ? formatColor(c) : null
}

/** Pure: prepend `color` to the recents (canonicalised), drop any duplicate,
 *  cap at MAX_RECENT_COLORS. A colour not worth remembering leaves the list
 *  unchanged. Order is most-recent-first. */
export function nextRecents(list: string[], color: string): string[] {
  const key = canonical(color)
  if (!key) return list
  const rest = list.filter((c) => c.toLowerCase() !== key.toLowerCase())
  return [key, ...rest].slice(0, MAX_RECENT_COLORS)
}

/** Read the persisted recents (most-recent-first). Empty when unavailable or
 *  malformed — never throws. */
export function getRecentColors(): string[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((c): c is string => typeof c === 'string').slice(0, MAX_RECENT_COLORS)
  } catch {
    return []
  }
}

/** Remember `color`, returning the new list (so a caller can drive React state
 *  off the return). Persists best-effort; a storage failure is swallowed. */
export function pushRecentColor(color: string): string[] {
  const next = nextRecents(getRecentColors(), color)
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* quota / disabled — recents are a convenience, never fatal */
    }
  }
  return next
}
