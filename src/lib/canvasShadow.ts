// Shadow effects (Figma drop / inner shadow) for frames + shapes. Stored as the
// optional `shadows: CanvasShadow[]` field and rendered as a single CSS
// box-shadow string (one comma-separated layer per shadow; an inner shadow gets
// `inset`). Pure + unit-tested, mirroring the other canvas* style helpers.

import type { CanvasElement, CanvasShadow } from './types'

// Guard rails for the numeric shadow fields. Offsets may be negative; blur and
// spread are non-negative (a negative CSS blur is invalid; negative spread is
// valid but rare and we keep the UI simple). The band stops a stray keystroke
// painting an absurd slab.
export const MIN_SHADOW_OFFSET = -100
export const MAX_SHADOW_OFFSET = 100
export const MAX_SHADOW_BLUR = 100
export const MAX_SHADOW_SPREAD = 100

const clampOffset = (n: number): number =>
  Math.min(MAX_SHADOW_OFFSET, Math.max(MIN_SHADOW_OFFSET, Math.round(n)))
const clampBlur = (n: number): number => Math.min(MAX_SHADOW_BLUR, Math.max(0, Math.round(n)))
const clampSpread = (n: number): number =>
  Math.min(MAX_SHADOW_SPREAD, Math.max(-MAX_SHADOW_SPREAD, Math.round(n)))

/** A sensible new drop shadow (a soft card shadow). */
export const DEFAULT_SHADOW: CanvasShadow = {
  type: 'drop',
  x: 0,
  y: 4,
  blur: 12,
  spread: 0,
  color: '#00000040', // black at 25%
}

/** Clamp one shadow's numbers to the allowed bands (non-finite → 0 / default),
 *  leaving type + colour untouched. */
export function clampShadow(s: CanvasShadow): CanvasShadow {
  const num = (n: number, clamp: (n: number) => number) => (Number.isFinite(n) ? clamp(n) : 0)
  return {
    type: s.type === 'inner' ? 'inner' : 'drop',
    x: num(s.x, clampOffset),
    y: num(s.y, clampOffset),
    blur: num(s.blur, clampBlur),
    spread: num(s.spread, clampSpread),
    color: s.color || DEFAULT_SHADOW.color,
  }
}

/** The CSS `box-shadow` for an element's shadows, or undefined when it has none
 *  (so the view omits the property and a legacy element is untouched). Each
 *  shadow becomes one layer; an inner shadow is prefixed `inset`. Painted in
 *  array order — CSS paints the FIRST layer on top, matching Figma's top-to-
 *  bottom effect list. */
export function shadowsCss(el: CanvasElement): string | undefined {
  const shadows = el.shadows
  if (!shadows || shadows.length === 0) return undefined
  const layers = shadows.map((s) => {
    const c = clampShadow(s)
    const inset = c.type === 'inner' ? 'inset ' : ''
    return `${inset}${c.x}px ${c.y}px ${c.blur}px ${c.spread}px ${c.color}`
  })
  return layers.join(', ')
}
