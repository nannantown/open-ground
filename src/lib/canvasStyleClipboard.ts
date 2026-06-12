// Style copy / paste (Figma ⌥⌘C / ⌥⌘V) — carry an element's LOOK onto others
// without touching geometry or content.
//
// pickStyle lifts the raw optional style fields off an element (raw, not
// resolved-with-defaults — pasting from a legacy element with no explicit
// fill must not stamp the default everywhere). applyStyle writes back only
// the fields that mean something on the TARGET's type, so pasting a frame's
// style onto a text doesn't sprinkle dead fields into the JSON.
//
// Pure + side-effect-free (mirrors canvasAlign.ts) so it unit-tests in
// isolation.

import type { CanvasElement } from './types'

/** The portable style subset — every optional cosmetic field the canvas
 *  elements share. */
export type CopiedStyle = Partial<
  Pick<
    CanvasElement,
    | 'fill'
    | 'strokeColor'
    | 'strokeWidth'
    | 'cornerRadius'
    | 'opacity'
    | 'color'
    | 'textColor'
    | 'fontSize'
    | 'fontFamily'
    | 'fontWeight'
    | 'textAlign'
    | 'lineHeight'
  >
>

const STYLE_FIELDS = [
  'fill',
  'strokeColor',
  'strokeWidth',
  'cornerRadius',
  'opacity',
  'color',
  'textColor',
  'fontSize',
  'fontFamily',
  'fontWeight',
  'textAlign',
  'lineHeight',
] as const

/** Which copied fields may land on which element type. Geometry-ish types
 *  (mock / screen / image) only take opacity — their look is their content. */
const FIELDS_BY_TYPE: Partial<Record<CanvasElement['type'], readonly (typeof STYLE_FIELDS)[number][]>> = {
  text: ['textColor', 'fontSize', 'fontFamily', 'fontWeight', 'textAlign', 'lineHeight', 'opacity'],
  sticky: ['color', 'opacity'],
  frame: ['fill', 'strokeColor', 'strokeWidth', 'cornerRadius', 'opacity'],
  shape: ['fill', 'strokeColor', 'strokeWidth', 'cornerRadius', 'opacity'],
  mock: ['opacity'],
  screen: ['opacity'],
  image: ['opacity'],
}

/** Lift the explicitly-set style fields off an element. Returns null when the
 *  element carries none (nothing worth pasting). */
export function pickStyle(el: CanvasElement): CopiedStyle | null {
  const out: CopiedStyle = {}
  let any = false
  for (const f of STYLE_FIELDS) {
    const v = el[f]
    if (v !== undefined) {
      ;(out as Record<string, unknown>)[f] = v
      any = true
    }
  }
  return any ? out : null
}

/** Stamp the copied style onto an element — only the fields valid for its
 *  type, only those present in the copy. Returns the SAME element reference
 *  when nothing applies, so callers can cheaply detect a no-op. */
export function applyStyle(el: CanvasElement, style: CopiedStyle): CanvasElement {
  const allowed = FIELDS_BY_TYPE[el.type]
  if (!allowed) return el
  let next: CanvasElement | null = null
  for (const f of allowed) {
    const v = style[f]
    if (v === undefined || el[f] === v) continue
    if (!next) next = { ...el }
    ;(next as unknown as Record<string, unknown>)[f] = v
  }
  return next ?? el
}
