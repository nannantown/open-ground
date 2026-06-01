// Pure helpers shared by the Selection Inspector and the text element view, so
// the panel that *edits* text typography and the view that *renders* it agree
// on the same defaults and the same font catalogue. Keeping this logic out of
// the React components means it is unit-testable in the `node` vitest env.

import type { CanvasElement } from './types'

/** Built-in text defaults — what a text element renders with when none of the
 *  optional typography fields are set (i.e. every Canvas saved before round 1).
 *  `FONT_DISPLAY_STACK` mirrors the `font-display` Tailwind token (Fraunces
 *  serif) so the legacy look is preserved byte-for-byte. */
export const DEFAULT_TEXT_FONT_SIZE = 18
export const FONT_DISPLAY_STACK =
  'var(--font-fraunces), "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, "Noto Sans JP", ui-serif, Georgia, serif'
/** Default glyph colour — the `ink` design token (#2A1F1A). */
export const DEFAULT_TEXT_COLOR = '#2A1F1A'
/** Default font-weight — 400 (normal). The Bold toggle flips between this and
 *  `BOLD_FONT_WEIGHT`. */
export const DEFAULT_TEXT_FONT_WEIGHT = 400
export const BOLD_FONT_WEIGHT = 700
/** Default horizontal alignment — left, matching the legacy text render. */
export const DEFAULT_TEXT_ALIGN: TextAlign = 'left'
/** Default unitless line-height. Mirrors Tailwind's `leading-snug` (1.375),
 *  which is what the text view rendered with before round 2, so legacy canvases
 *  stay metrically identical. */
export const DEFAULT_LINE_HEIGHT = 1.375

export type TextAlign = 'left' | 'center' | 'right'
/** The alignment options offered by the inspector's segmented control. */
export const TEXT_ALIGN_OPTIONS: TextAlign[] = ['left', 'center', 'right']

// Guard rails for the font-size number input so a stray keystroke can't make
// text invisibly small or absurdly large (which would also blow out the
// auto-width sizer).
export const MIN_TEXT_FONT_SIZE = 6
export const MAX_TEXT_FONT_SIZE = 200

// Guard rails for the unitless line-height input. A line-height below 0.5 makes
// stacked lines overlap (and the auto-width sizer mis-measures height); above 4
// is well past any reasonable display use.
export const MIN_LINE_HEIGHT = 0.5
export const MAX_LINE_HEIGHT = 4

/** The font-family catalogue offered by the inspector's select. `value` is the
 *  CSS font-family stack actually stored on the element + applied at render;
 *  `label` is the human name shown in the dropdown. The first entry is the
 *  product default (the Fraunces display serif) so "no explicit fontFamily"
 *  and "the default option" resolve to the same rendered glyphs. */
export interface FontOption {
  label: string
  value: string
}
export const FONT_OPTIONS: FontOption[] = [
  { label: 'Display (Fraunces)', value: FONT_DISPLAY_STACK },
  {
    label: 'Sans',
    value:
      'var(--font-instrument-sans), "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, "Noto Sans JP", ui-sans-serif, system-ui, sans-serif',
  },
  {
    label: '日本語ゴシック',
    value:
      '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", Meiryo, "Noto Sans JP", sans-serif',
  },
  { label: 'System UI', value: 'system-ui, -apple-system, sans-serif' },
  { label: 'Serif', value: 'Georgia, Cambria, "Times New Roman", serif' },
  {
    label: 'Mono',
    value:
      'var(--font-jetbrains-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
  },
]

/** Clamp an arbitrary number to the allowed font-size band, rounding to a whole
 *  px. NaN / non-finite input falls back to the default size so the input never
 *  persists garbage. */
export function clampFontSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_TEXT_FONT_SIZE
  return Math.min(MAX_TEXT_FONT_SIZE, Math.max(MIN_TEXT_FONT_SIZE, Math.round(n)))
}

/** Clamp an arbitrary number to the allowed (unitless) line-height band,
 *  rounding to 2 decimals so the stored/displayed value stays tidy. NaN /
 *  non-finite input (e.g. a cleared field) falls back to the default rather
 *  than the ceiling, mirroring `clampFontSize`. */
export function clampLineHeight(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_LINE_HEIGHT
  const clamped = Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, n))
  return Math.round(clamped * 100) / 100
}

/** Resolve the effective typography for rendering a text element, folding in
 *  the defaults for any field the element doesn't carry. Used by the text view
 *  so the editor box, the invisible auto-width sizer, and the idle render all
 *  share one source of truth (they MUST agree or the box mis-sizes). */
export function resolveTextStyle(el: CanvasElement): {
  fontSize: number
  fontFamily: string
  color: string
  fontWeight: number
  textAlign: TextAlign
  lineHeight: number
} {
  return {
    fontSize: el.fontSize ?? DEFAULT_TEXT_FONT_SIZE,
    fontFamily: el.fontFamily ?? FONT_DISPLAY_STACK,
    color: el.textColor ?? DEFAULT_TEXT_COLOR,
    fontWeight: el.fontWeight ?? DEFAULT_TEXT_FONT_WEIGHT,
    textAlign: el.textAlign ?? DEFAULT_TEXT_ALIGN,
    lineHeight: el.lineHeight ?? DEFAULT_LINE_HEIGHT,
  }
}

/** Immutably apply a partial typography patch to the element with `id` inside
 *  `els`, returning a NEW array (so React + the undo/redo baseline diff see a
 *  fresh reference). Other elements keep their identity. Returns the original
 *  array reference unchanged when no element matched, so a no-op edit skips a
 *  write/history entry. This is the single mutation the inspector funnels text
 *  edits through, on top of the existing `mutateElements` persistence path. */
export function applyElementPatch(
  els: CanvasElement[],
  id: string,
  patch: Partial<CanvasElement>,
): CanvasElement[] {
  let matched = false
  const next = els.map((el) => {
    if (el.id !== id) return el
    matched = true
    return { ...el, ...patch }
  })
  return matched ? next : els
}
