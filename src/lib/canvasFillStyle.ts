// Pure helpers shared by the Selection Inspector and the element views for the
// FILL + STROKE properties of NON-text elements (round 3), mirroring the
// round-1/2 `canvasTextStyle.ts` split: the panel that *edits* fill/stroke and
// the views that *render* it agree on the same defaults and the same clamp
// rules. Keeping this out of the React components keeps it unit-testable in the
// `node` vitest env.
//
// Field-naming care (round-3 contract):
//   - STICKY background reuses the long-standing `color` field — round 3 does
//     NOT introduce a second sticky-fill field. The inspector's sticky Fill
//     control writes `color`, exactly like the on-canvas swatch row, so the two
//     stay in lock-step and no legacy sticky changes meaning.
//   - FRAME (and any future bordered/filled non-text type) uses the new
//     OPTIONAL `fill` / `strokeColor` / `strokeWidth` fields. All optional and
//     backward-compatible: a canvas saved before round 3 omits them and the
//     views fall back to the exact legacy look (`bg-bg/35` body, `line-strong`
//     1px border), so previously-saved Canvases load and render identically.

import type { CanvasElement } from './types'

// ── Sticky fill ──
// The default a sticky renders with when its `color` field is unset. Must stay
// byte-identical to `DEFAULT_STICKY_COLOR` in ElementView so the inspector
// swatch, the on-canvas swatch row, and the idle render all agree.
export const DEFAULT_STICKY_FILL = '#ECD79A'

// ── Frame fill + stroke ──
// `bg-bg` is the `#F2EDDE` paper token; the legacy frame body rendered it at
// 35% alpha (`bg-bg/35`). Encode that as an explicit rgba so a frame with no
// `fill` set resolves to exactly the historical look.
export const DEFAULT_FRAME_FILL = 'rgba(242, 237, 222, 0.35)'
// The legacy unselected frame border was the `line-strong` token (`#B8A988`),
// 1px wide. A frame with no `strokeColor` / `strokeWidth` resolves to these.
export const DEFAULT_FRAME_STROKE_COLOR = '#B8A988'
export const DEFAULT_STROKE_WIDTH = 1

// Guard rails for the stroke-width number input. 0 = no border (allowed, Figma
// lets you zero a stroke); the ceiling stops a stray keystroke drawing an
// absurd slab that swallows the frame.
export const MIN_STROKE_WIDTH = 0
export const MAX_STROKE_WIDTH = 40

/** Clamp an arbitrary number to the allowed stroke-width band, rounding to a
 *  whole px. NaN / non-finite input (e.g. a cleared field) falls back to the
 *  default width rather than the ceiling, mirroring `clampFontSize`, so an
 *  empty input never persists a garbage width. */
export function clampStrokeWidth(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_STROKE_WIDTH
  return Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, Math.round(n)))
}

// ── Stroke style (Figma: solid / dashed / dotted) ──
// Optional + backward-compatible: an element with no `strokeStyle` resolves to
// 'solid' (the legacy CSS `borderStyle:'solid'` every view hard-coded before).
export type StrokeStyle = 'solid' | 'dashed' | 'dotted'
export const STROKE_STYLES: StrokeStyle[] = ['solid', 'dashed', 'dotted']
export const DEFAULT_STROKE_STYLE: StrokeStyle = 'solid'

/** Resolve a stroke style, snapping any unknown value (or none) to 'solid' so a
 *  stray field can't ask CSS for an unhandled border-style. */
export function resolveStrokeStyle(el: CanvasElement): StrokeStyle {
  return el.strokeStyle && STROKE_STYLES.includes(el.strokeStyle) ? el.strokeStyle : DEFAULT_STROKE_STYLE
}

// ── Stroke alignment (Figma: inside / center / outside) ──
// 'inside' is the legacy look (a border-box border, drawn inside the rect), so
// it stays the default and existing elements are untouched.
export type StrokeAlign = 'inside' | 'center' | 'outside'
export const STROKE_ALIGNS: StrokeAlign[] = ['inside', 'center', 'outside']
export const DEFAULT_STROKE_ALIGN: StrokeAlign = 'inside'

/** Resolve stroke alignment, snapping unknown/none to 'inside' (the legacy
 *  border render). */
export function resolveStrokeAlign(el: CanvasElement): StrokeAlign {
  return el.strokeAlign && STROKE_ALIGNS.includes(el.strokeAlign) ? el.strokeAlign : DEFAULT_STROKE_ALIGN
}

/** The border width a view should paint, given the stroke colour, the resolved
 *  width, and whether the element is selected. A no-fill (transparent) stroke
 *  collapses to 0 px so a "removed" border occupies no box space (Figma's true
 *  no-stroke) — but a SELECTED element keeps ≥1 px as the selection affordance
 *  (the accent ring is painted over whatever stroke the user set). */
export function renderStrokeWidth(strokeColor: string, strokeWidth: number, selected: boolean): number {
  if (selected) return Math.max(strokeWidth, 1)
  return isNoFill(strokeColor) ? 0 : strokeWidth
}

// ── No-fill / transparent ──
// Figma lets any fill (or stroke) be removed → "no fill". Our fill model is a
// single CSS-colour string, so "no fill" is the explicit sentinel below rather
// than an absent field: an ABSENT `fill` resolves to the DEFAULT_* colour via
// the `?? ` in resolveFrameStyle/resolveShapeStyle, NOT to transparent. The
// sentinel is plain CSS `transparent`, so the element views paint it as no fill
// with zero render changes, and the `?? DEFAULT` resolvers pass it through
// untouched (it isn't nullish). Persisted verbatim — canvasData does no schema
// coercion — so it survives save / load.
export const NO_FILL = 'transparent'

/** True when a colour string represents "no fill": the explicit sentinel, CSS
 *  `none`, or any rgb()/rgba()/hsl()/hsla()/#rrggbbaa with a fully-zero alpha.
 *  Drives the inspector's checkerboard swatch + the fill on/off toggle state. A
 *  null / empty value (multi-select "Mixed" / unset) is NOT treated as no-fill.
 *  Handles BOTH the legacy comma syntax (`rgba(0,0,0,0)`) AND modern space /
 *  slash syntax with optional `%` alpha (`rgb(0 0 0 / 0)`, `rgba(0,0,0,0%)`),
 *  since the AI canvas generator and hand-typed values can use either. */
export function isNoFill(value: string | null | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  if (v === 'transparent' || v === 'none') return true
  const fn = /^(?:rgba?|hsla?)\((.*)\)$/.exec(v)
  if (fn) {
    const body = fn[1]
    // Modern syntax puts alpha after a `/`; legacy syntax makes it the 4th
    // comma arg. A 3-arg (rgb/hsl, no alpha) value is opaque → a fill.
    let alpha: string | undefined
    if (body.includes('/')) alpha = body.slice(body.indexOf('/') + 1)
    else {
      const parts = body.split(',')
      alpha = parts.length >= 4 ? parts[parts.length - 1] : undefined
    }
    // Zero alpha: 0, 0.0, .0, 0% (any number of leading/trailing zeros).
    return alpha !== undefined && /^0*\.?0+%?$/.test(alpha.trim())
  }
  // #rrggbbaa / #rgba with a zero alpha byte.
  if (/^#[0-9a-f]{6}00$/.test(v)) return true
  if (/^#[0-9a-f]{3}0$/.test(v)) return true
  return false
}

/** Resolve the effective fill for a STICKY element. Reuses the existing `color`
 *  field (never a new field) so the inspector and the swatch row drive the same
 *  value. Legacy stickies with no `color` get the built-in default. */
export function resolveStickyFill(el: CanvasElement): string {
  return el.color ?? DEFAULT_STICKY_FILL
}

/** Resolve the effective fill + stroke for a FRAME (or any bordered non-text
 *  element), folding in the defaults for any field the element doesn't carry.
 *  Used by the frame view so a legacy frame (no fill/stroke fields) renders
 *  exactly as it did before round 3. */
export function resolveFrameStyle(el: CanvasElement): {
  fill: string
  strokeColor: string
  strokeWidth: number
} {
  return {
    fill: el.fill ?? DEFAULT_FRAME_FILL,
    strokeColor: el.strokeColor ?? DEFAULT_FRAME_STROKE_COLOR,
    strokeWidth: el.strokeWidth ?? DEFAULT_STROKE_WIDTH,
  }
}
