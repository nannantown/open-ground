import { useLayoutEffect, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react'

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

/** Space kept between the character and what stepped out from under it. */
const GAP = 8
/** A box gives up at most this share of itself. Past it the character sits too
 *  far into the box for padding on that side to make sensible room — and a room
 *  bigger than the box would grow the box itself (its content cannot shrink
 *  below 0, CSS box-sizing), so the next measure would return a bigger room. */
const MAX_SHARE = 1 / 3

export interface ClearanceOptions {
  /** The side tried first — a row that ends in its buttons (`right`), a
   *  floating cluster that steps up (`bottom`); the other side is next. Unset =
   *  a pane whose content reflows: the side that costs less first. A side is
   *  taken while it costs a third of the box at most; past both, no room. */
  side?: 'right' | 'bottom'
  /** The box's own padding (px). The character has to reach past it — over
   *  the content — before the box makes room. */
  inset?: number
  /** The box is as tall as what is in it — a row at the foot of a seat, a
   *  floating pair — so room under its content grows the box and lifts the
   *  content above the character instead of crushing it: that side costs it
   *  nothing. It is measured with its room taken away: measured with it, the
   *  character stays inside the grown box, and dragging the character carries
   *  the box along. Not for a box that scrolls (taking the room away moves its
   *  scroll position). */
  grows?: boolean
}
export interface AssistantRoom {
  side: 'right' | 'bottom'
  /** Padding for that side, measured from the box's outer edge. */
  px: number
}

/** The padding `box` (a viewport rect) needs so nothing in it sits under the
 *  character at `at` — null when the two do not meet, or when neither side can
 *  make the room for a third of the box at most. */
export const assistantClearance = (box: DOMRect, at: AssistantSpot | null, vw: number, vh: number, o: ClearanceOptions = {}): AssistantRoom | null => {
  if (!at) return null
  const inset = o.inset ?? 0
  const left = vw - at.right - ASSISTANT_SIZE
  const top = vh - at.bottom - ASSISTANT_SIZE
  const c = { left: box.left + inset, top: box.top + inset, right: box.right - inset, bottom: box.bottom - inset }
  if (!(left < c.right && left + ASSISTANT_SIZE > c.left && top < c.bottom && top + ASSISTANT_SIZE > c.top)) return null
  const right: AssistantRoom = { side: 'right', px: Math.ceil(box.right - left) + GAP }
  const bottom: AssistantRoom = { side: 'bottom', px: Math.ceil(box.bottom - top) + GAP }
  // What each side costs: the share of the content it takes away.
  const share = (taken: number, size: number) => (size > 0 ? taken / size : Infinity)
  const sides = [
    { room: right, cost: share(c.right - left + GAP, c.right - c.left) },
    { room: bottom, cost: o.grows ? 0 : share(c.bottom - top + GAP, c.bottom - c.top) },
  ]
  if (o.side === 'bottom' || (!o.side && sides[1].cost < sides[0].cost)) sides.reverse()
  return sides.find((s) => s.cost <= MAX_SHARE)?.room ?? null
}

/** The padding `ref`'s box needs right now, as a style for that same box:
 *  re-measured when the character moves, the window resizes, a box around it
 *  scrolls (the seat row scrolls sideways, carrying its boxes along) or the box (or
 *  its parent) changes size. The room must not feed the next measurement: a
 *  box sized from outside (a pane, a scrolling feed, the icon rail) keeps its
 *  rect while its room stays inside it, which MAX_SHARE sees to; a box sized
 *  by its content grows with its room — pass `grows`, and it is measured
 *  without it.
 *  `deps`: whatever remounts the box.
 *  ponytail: a box that slides with none of those — a middle seat pushed
 *  along while the border two seats away is dragged — keeps its old room until
 *  one happens. Share one ResizeObserver across every box if that ever shows. */
export const useAssistantClearance = (ref: RefObject<HTMLElement | null>, o: ClearanceOptions = {}, deps: readonly unknown[] = []): CSSProperties | undefined => {
  const at = useAssistantSpot()
  const [room, setRoom] = useState<AssistantRoom | null>(null)
  const { side, inset, grows } = o
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !at) return setRoom(null)
    const measure = () => {
      const { paddingRight, paddingBottom } = el.style
      if (grows) {
        el.style.paddingRight = ''
        el.style.paddingBottom = ''
      }
      const box = el.getBoundingClientRect()
      if (grows) {
        el.style.paddingRight = paddingRight
        el.style.paddingBottom = paddingBottom
      }
      const next = assistantClearance(box, at, window.innerWidth, window.innerHeight, { side, inset, grows })
      setRoom((was) => (was?.side === next?.side && was?.px === next?.px ? was : next))
    }
    // Only a box around this one carries it along — not the box's own content
    // or a sibling (a terminal streaming output scrolls all the time).
    const onScroll = (e: Event) => {
      if (e.target !== el && e.target instanceof Node && e.target.contains(el)) measure()
    }
    measure()
    window.addEventListener('resize', measure)
    // (capture: a scroll does not bubble up from the box that scrolled)
    window.addEventListener('scroll', onScroll, true)
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    ro?.observe(el)
    if (el.parentElement) ro?.observe(el.parentElement)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', onScroll, true)
      ro?.disconnect()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at, side, inset, grows, ...deps])
  if (!room) return undefined
  return room.side === 'right' ? { paddingRight: room.px } : { paddingBottom: room.px }
}
