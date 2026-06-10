// Shared element bounding-box resolver. The per-type default W/H here mirror the
// constants used by the InfiniteCanvas render/`fullBounds` and the inspector's
// SIZE_DEFAULTS, so a legacy element saved without explicit width/height resolves
// to the same box everywhere. Pure + side-effect-free (unit-testable).
//
// `group` is intentionally NOT sized — a group is an invisible container with no
// box of its own (its bounds, if ever needed, derive from its members), so it
// returns null and callers (e.g. align) skip it.

import type { CanvasElement } from './types'
import { SHAPE_DEFAULT_W, SHAPE_DEFAULT_H } from './canvasShape'

export const STICKY_DEFAULT = 208
export const MOCK_DEFAULT_W = 420
export const MOCK_DEFAULT_H = 320
export const SCREEN_DEFAULT_W = 1280
export const SCREEN_DEFAULT_H = 800
export const COMMENT_W = 28
export const COMMENT_H = 28
export const TEXT_W = 300
export const TEXT_H = 44
export const FRAME_DEFAULT_W = 400
export const FRAME_DEFAULT_H = 280

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

/** The rendered size (w, h) of an element, folding in the per-type default for a
 *  legacy element with no explicit width/height. Returns null for `group` (no
 *  box of its own). */
export function elementSize(el: CanvasElement): { w: number; h: number } | null {
  switch (el.type) {
    case 'group':
      return null
    case 'text':
      return { w: TEXT_W, h: TEXT_H }
    case 'comment':
      return { w: COMMENT_W, h: COMMENT_H }
    case 'sticky':
      return { w: el.width ?? STICKY_DEFAULT, h: el.height ?? STICKY_DEFAULT }
    case 'mock':
      return { w: el.width ?? MOCK_DEFAULT_W, h: el.height ?? MOCK_DEFAULT_H }
    case 'screen':
      return { w: el.width ?? SCREEN_DEFAULT_W, h: el.height ?? SCREEN_DEFAULT_H }
    case 'shape':
      return { w: el.width ?? SHAPE_DEFAULT_W, h: el.height ?? SHAPE_DEFAULT_H }
    case 'frame':
      return { w: el.width ?? FRAME_DEFAULT_W, h: el.height ?? FRAME_DEFAULT_H }
    case 'image':
      return { w: el.width ?? STICKY_DEFAULT, h: el.height ?? STICKY_DEFAULT }
    default:
      return { w: el.width ?? STICKY_DEFAULT, h: el.height ?? STICKY_DEFAULT }
  }
}

/** Full axis-aligned bounding box (top-left + size), or null for a group. */
export function elementBounds(el: CanvasElement): Bounds | null {
  const size = elementSize(el)
  if (!size) return null
  return { x: el.x, y: el.y, w: size.w, h: size.h }
}
