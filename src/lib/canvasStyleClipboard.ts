// Style copy / paste (Figma ⌥⌘C / ⌥⌘V) — carry an element's LOOK onto others
// without touching geometry or content.
//
// pickStyle lifts the raw optional style fields off an element (raw, not
// resolved-with-defaults). applyStyle then REPLACES the target's look with the
// copy (Figma's "Paste properties" is a full replace, not a merge): for every
// field valid on the TARGET's type it writes the copy's value, and CLEARS
// (→ undefined, i.e. back to the type default) any such field the copy didn't
// carry. So pasting a uniform-corner / solid-stroke source onto a target with a
// stray per-corner radius or a dashed border resets those — the pasted element
// matches the source exactly, with no residue. Fields invalid for the target
// type are never touched (pasting a frame's style onto a text adds no dead
// fields). The source's OWN default-look fields (absent in the copy) therefore
// reset the target to default too — that's "make it look like this one".
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
    | 'strokeStyle'
    | 'strokeAlign'
    | 'cornerRadius'
    | 'cornerRadiusTopLeft'
    | 'cornerRadiusTopRight'
    | 'cornerRadiusBottomRight'
    | 'cornerRadiusBottomLeft'
    | 'shadows'
    | 'fillImageId'
    | 'fillImageMode'
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
  'strokeStyle',
  'strokeAlign',
  'cornerRadius',
  'cornerRadiusTopLeft',
  'cornerRadiusTopRight',
  'cornerRadiusBottomRight',
  'cornerRadiusBottomLeft',
  'shadows',
  'fillImageId',
  'fillImageMode',
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
  frame: ['fill', 'strokeColor', 'strokeWidth', 'strokeStyle', 'strokeAlign', 'cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomRight', 'cornerRadiusBottomLeft', 'shadows', 'fillImageId', 'fillImageMode', 'opacity'],
  shape: ['fill', 'strokeColor', 'strokeWidth', 'strokeStyle', 'strokeAlign', 'cornerRadius', 'cornerRadiusTopLeft', 'cornerRadiusTopRight', 'cornerRadiusBottomRight', 'cornerRadiusBottomLeft', 'shadows', 'fillImageId', 'fillImageMode', 'opacity'],
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

/** Replace the target's LOOK with the copied style — for every field valid on
 *  its type, write the copy's value, or CLEAR it (→ undefined) when the copy
 *  didn't carry it, so the result matches the source with no leftover overrides
 *  (Figma "Paste properties"). Fields invalid for the type are left untouched.
 *  Returns the SAME element reference when nothing changes, so callers can
 *  cheaply detect a no-op. */
export function applyStyle(el: CanvasElement, style: CopiedStyle): CanvasElement {
  const allowed = FIELDS_BY_TYPE[el.type]
  if (!allowed) return el
  let next: CanvasElement | null = null
  for (const f of allowed) {
    const v = style[f] // undefined ⇒ the copy didn't set it ⇒ clear on target
    if (el[f] === v) continue // already matches (incl. both undefined)
    if (!next) next = { ...el }
    if (v === undefined) delete (next as unknown as Record<string, unknown>)[f]
    // Array/object style fields (e.g. `shadows`) are CLONED per target so two
    // elements pasted from one copy never share — and later mutate — the same
    // object. (Scalars copy by value.)
    else (next as unknown as Record<string, unknown>)[f] = cloneStyleValue(v)
  }
  return next ?? el
}

function cloneStyleValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? { ...x } : x))
  return v
}
