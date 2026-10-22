import { useSyncExternalStore } from 'react'

// The floating assistant's window owns the keys typed inside it. The app's own
// CAPTURE-phase Esc handlers (Board drawer, Canvas tool/selection, placement
// ghost) run before the window's listener — it subscribes only once the window
// opens, i.e. later — so each of them must step aside for a key that comes
// from inside the window. One test, here, so they cannot drift apart (and so
// none of them has to import the whole FloatingAssistant for an attribute).

/** Marks the assistant's talk window (FloatingAssistant). */
export const ASSISTANT_WINDOW_ATTR = 'data-og-assistant'

/** True when a key/pointer target sits inside the assistant's window. */
export const isInAssistantWindow = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(`[${ASSISTANT_WINDOW_ATTR}]`) !== null

/** The character's diameter, and its spot until the owner drags it
 *  (FloatingAssistant). Here so a pane can keep clear of it without importing
 *  the whole component. */
export const ASSISTANT_SIZE = 50
export const ASSISTANT_DEFAULT_POS = { right: 20, bottom: 18 }

export interface AssistantSpot {
  right: number
  bottom: number
}
/** Where the character sits right now (px from the window's right / bottom
 *  edge), or null while it is not on screen. FloatingAssistant publishes it;
 *  a control row reads it to keep its last button out from under the
 *  character — the character floats and the layout never moves for it, so the
 *  row makes the room itself. */
let spot: AssistantSpot | null = null
const listeners = new Set<() => void>()
export const publishAssistantSpot = (next: AssistantSpot | null) => {
  if (next === spot || (next && spot && next.right === spot.right && next.bottom === spot.bottom)) return
  spot = next
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
export const useAssistantSpot = () => useSyncExternalStore(subscribe, () => spot, () => null)

/** Right padding `row` (a viewport rect) needs so nothing in it sits under the
 *  character at `at` — 0 when the two do not meet. */
export const assistantClearance = (row: DOMRect, at: AssistantSpot | null, vw: number, vh: number): number => {
  if (!at) return 0
  const left = vw - at.right - ASSISTANT_SIZE
  const top = vh - at.bottom - ASSISTANT_SIZE
  const meets = left < row.right && left + ASSISTANT_SIZE > row.left && top < row.bottom && top + ASSISTANT_SIZE > row.top
  return meets ? Math.ceil(row.right - left) + 8 : 0
}
