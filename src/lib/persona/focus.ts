// focus.ts — when pointing at a line in the list has to move the camera.
//
// THE RULE, AND IT IS THE WHOLE FILE: the camera moves ONLY when the point
// being pointed at is not already on screen. Recentring on every hover would
// swing the body under the owner's hand as they run down a list of two hundred
// rows, which is motion sickness, not a binding. At the default view the whole
// figure is in frame, so the common case is that NOTHING happens — the point
// simply lights up where it already was, and the owner's eye does the travel.
//
// Pure, and separated from PersonaFigure for the reason the rest of that file's
// geometry already is: a decision drawn onto a canvas cannot be observed in
// jsdom, so a rule that lives in the renderer is a rule that never gets a test.

export interface FocusView {
  /** Host size in CSS px. */
  w: number
  h: number
}

export interface FocusCam {
  x: number
  y: number
  s: number
}

/** Layout-space position of a point (figure space already multiplied out). */
export interface FocusPoint {
  x: number
  y: number
}

/** How much of each edge counts as "not really visible". A point 4px inside the
 *  frame is technically on screen and practically invisible — it sits under the
 *  probe panel, the recentre chip, or the owner's own scrollbar. */
const EDGE = 0.14

/** Where a layout-space point lands on screen, given the camera. The same
 *  transform the draw loop uses; kept here so the two cannot drift. */
export const screenPos = (p: FocusPoint, cam: FocusCam, view: FocusView): FocusPoint => ({
  x: (p.x - cam.x) * cam.s + view.w / 2,
  y: (p.y - cam.y) * cam.s + view.h / 2,
})

export const pointInView = (p: FocusPoint, cam: FocusCam, view: FocusView): boolean => {
  const s = screenPos(p, cam, view)
  return (
    s.x >= view.w * EDGE &&
    s.x <= view.w * (1 - EDGE) &&
    s.y >= view.h * EDGE &&
    s.y <= view.h * (1 - EDGE)
  )
}

/** The camera target that brings `p` into view, or NULL when it already is.
 *
 *  ⚠ NULL IS THE POINT OF THE SIGNATURE. Returning "the camera you already
 *  have" would let a caller assign it every hover and re-run the easing, which
 *  looks identical to a jitter; an absent answer cannot be assigned by mistake.
 *
 *  The scale is CARRIED, never changed: zoom is the owner's setting, and a
 *  hover is not a request to rescale their view of themselves. */
export const cameraForPoint = (
  p: FocusPoint,
  cam: FocusCam,
  view: FocusView,
): FocusCam | null => (pointInView(p, cam, view) ? null : { x: p.x, y: p.y, s: cam.s })
