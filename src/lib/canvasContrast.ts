// Readable text on the Canvas (owner report 2026-09-24: pale stickies carried
// pale text in the dark theme, and an uncoloured heading was dark-on-dark).
//
// Root cause: a sticky's text followed the THEME ink (`text-ink`, cream at
// night) and a text element's default was a fixed dark ink — both chosen with
// no regard to what is actually painted behind the glyphs. This module picks
// the text colour FROM the backdrop instead: the sticky's own fill, or for a
// text element the canvas ground with every parent frame fill and every shape /
// sticky lying under it composited on top.
// Pure (node-testable); the views and the inspector share it.

import type { CanvasElement } from './types'
import type { ThemeName } from './theme'
import { parseColor as parseHexRgb } from './canvasColor'
import { parseGradient } from './canvasGradient'
import { resolveFrameStyle, resolveStickyFill } from './canvasFillStyle'
import { resolveShapeStyle } from './canvasShape'
import { resolveOpacity } from './canvasTransform'
import { DEFAULT_TEXT_COLOR, resolveTextStyle } from './canvasTextStyle'
import { textBox, textSizingOf, textVAlignOf } from './canvasTextSizing'
import { containmentDepth } from './canvasContainment'

type RGB = [number, number, number]
type RGBA = [number, number, number, number]

/** WCAG 2.x AA for normal-size text. */
export const AA_TEXT_CONTRAST = 4.5

/** The canvas ground per theme — the `--og-bg` channel of each palette in
 *  src/app/globals.css (pinned equal by ElementView.contrast.test.tsx). */
export const CANVAS_BACKDROP: Record<ThemeName, string> = {
  light: '#F2EDDE',
  dark: '#2A1F1A',
}

// The two auto text colours: the paper palette's ink and card cream. Fixed
// values, not theme tokens — they are chosen per BACKDROP, not per theme.
export const AUTO_DARK_TEXT = '#2A1F1A'
export const AUTO_LIGHT_TEXT = '#F8F4E8'

// ponytail: only the CSS basic colour keywords; a rarer name reads as
// "unknown" (skipped) — add the full CSS table if names ever show up in data.
const NAMED: Record<string, RGB> = {
  black: [0, 0, 0], silver: [192, 192, 192], gray: [128, 128, 128], grey: [128, 128, 128],
  white: [255, 255, 255], maroon: [128, 0, 0], red: [255, 0, 0], purple: [128, 0, 128],
  fuchsia: [255, 0, 255], green: [0, 128, 0], lime: [0, 255, 0], olive: [128, 128, 0],
  yellow: [255, 255, 0], navy: [0, 0, 128], blue: [0, 0, 255], teal: [0, 128, 128],
  aqua: [0, 255, 255], orange: [255, 165, 0],
}

// hsl alpha: '50%' or '0.5'.
const alphaNum = (s: string) => (s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s))

function parseHsl(s: string): RGBA | null {
  const m = /^hsla?\(([^)]+)\)$/.exec(s)
  if (!m) return null
  const p = m[1].split(/[\s,/]+/).filter(Boolean)
  if (p.length < 3) return null
  const h = (((parseFloat(p[0]) % 360) + 360) % 360) / 360
  // Saturation / lightness are percentages whether written '36%' or (modern) '36'.
  const sat = parseFloat(p[1]) / 100
  const l = parseFloat(p[2]) / 100
  const a = p[3] === undefined ? 1 : alphaNum(p[3])
  if (![h, sat, l, a].every(Number.isFinite)) return null
  const q = l < 0.5 ? l * (1 + sat) : l + sat - l * sat
  const pp = 2 * l - q
  const ch = (t: number) => {
    t = (t + 1) % 1
    const v = t < 1 / 6 ? pp + (q - pp) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? pp + (q - pp) * (2 / 3 - t) * 6 : pp
    return v * 255
  }
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3), Math.min(1, Math.max(0, a))]
}

/** Parse a CSS paint to one representative RGBA: hex / rgb() (via
 *  canvasColor), hsl(), basic colour names, and linear/radial gradients (the
 *  mean of their stops). Anything else (images, var(), rare names) → null —
 *  callers treat it as "unknown". */
export function parseColor(input: string | undefined | null): RGBA | null {
  if (!input) return null
  const s = input.trim().toLowerCase()
  const c = parseHexRgb(s)
  if (c) return [c.r, c.g, c.b, c.a]
  if (NAMED[s]) return [...NAMED[s], 1]
  const hsl = parseHsl(s)
  if (hsl) return hsl
  const g = parseGradient(s)
  const stops = g?.stops.map((st) => parseColor(st.color)).filter((x): x is RGBA => !!x) ?? []
  if (!stops.length) return null
  return [0, 1, 2, 3].map((i) => stops.reduce((t, st) => t + st[i], 0) / stops.length) as RGBA
}

/** Paint `top` (with its alpha, scaled by `opacity`) over an opaque `under`. */
function over(top: RGBA, under: RGB, opacity = 1): RGB {
  const a = top[3] * opacity
  return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)) as RGB
}

const toHex = (c: RGB): string =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()

const luminance = (c: RGB): number => {
  const [r, g, b] = c
    .map((v) => v / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two colours. A translucent `fg` is composited over
 *  `bg` first; `bg` is treated as opaque. Unparseable input → null. */
export function contrastRatio(fg: string, bg: string): number | null {
  const b = parseColor(bg)
  const f = parseColor(fg)
  if (!b || !f) return null
  const base: RGB = [b[0], b[1], b[2]]
  const [hi, lo] = [luminance(over(f, base)), luminance(base)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** The text colour that reads on `bg`: the paper ink or the cream, whichever
 *  contrasts more — and if neither clears AA (a mid-tone fill), pure black or
 *  white, one of which always clears 4.5:1. */
export function readableTextOn(bg: string): string {
  const pick = (a: string, b: string) =>
    (contrastRatio(a, bg) ?? 0) >= (contrastRatio(b, bg) ?? 0) ? a : b
  const soft = pick(AUTO_DARK_TEXT, AUTO_LIGHT_TEXT)
  if ((contrastRatio(soft, bg) ?? 0) >= AA_TEXT_CONTRAST) return soft
  return pick('#000000', '#FFFFFF')
}

/** Flatten `fill` over the opaque `backdrop` → an opaque hex. An unparseable
 *  fill counts as transparent (the backdrop shows). */
export function flattenOver(fill: string | undefined, backdrop: string): string {
  const b = parseColor(backdrop) ?? parseColor(CANVAS_BACKDROP.light)!
  const f = parseColor(fill)
  const base: RGB = [b[0], b[1], b[2]]
  return toHex(f ? over(f, base) : base)
}

// The page colour a mock / screen iframe paints (mockSrcdoc.ts / screenSrcdoc.ts
// body CSS). 'auto' follows the OS, not the app theme → unknown.
const PAGE: Record<'mock' | 'screen', Record<'light' | 'dark', string>> = {
  mock: { light: '#FFFFFF', dark: '#0B0C0E' },
  screen: { light: '#F8F4E8', dark: '#0B0C0E' },
}

const UNKNOWN = Symbol('unknown')

// The paint an element lays down behind whatever sits on it: a colour, nothing
// (undefined — a group, a comment), or UNKNOWN — an image, an image fill, an
// auto-theme page, a paint we cannot parse. We never guess past UNKNOWN.
function paintOf(el: CanvasElement): string | undefined | typeof UNKNOWN {
  if (el.fillImageId || el.type === 'image') return UNKNOWN
  if (el.type === 'mock' || el.type === 'screen') {
    const t = el.theme ?? 'light'
    return t === 'auto' ? UNKNOWN : PAGE[el.type][t]
  }
  const fill =
    el.type === 'frame' ? resolveFrameStyle(el).fill
    : el.type === 'shape' ? resolveShapeStyle(el).fill
    : el.type === 'sticky' ? resolveStickyFill(el)
    : undefined
  return fill !== undefined && !parseColor(fill) ? UNKNOWN : fill
}

// Where a text's ink actually is: the centre of its ESTIMATED glyph run. A
// text box is often wider than its glyphs, and text is left-aligned by default:
//  - "any overlap" flipped a label to cream when only the box's empty right
//    edge grazed a dark frame (1.06:1, review 4);
//  - the box centre missed the mirror case — a short label at the left of a
//    wide box whose glyphs are all on a frame the box centre is off (1.10:1,
//    review 5).
// Run: align (left/center/right) + vertical align (fixed mode) within the
// padded box; width = longest line's chars × fontSize, capped at the box.
// ponytail: estimate, not layout — CJK/full-width counts 1em, the rest 0.55em,
// wrapping by whole-line width, not word breaks (capped at the box); measure the DOM if it misjudges.
const PAD_X = 6 // ElementView TEXT_PAD px-1.5
const PAD_Y = 2 // py-0.5
function glyphCentre(el: CanvasElement): [number, number] {
  const { w, h } = textBox(el)
  const { fontSize, textAlign, lineHeight } = resolveTextStyle(el)
  const lineEms = (el.text ?? '').split('\n').map((l) => Array.from(l).reduce((s, c) => s + (c.codePointAt(0)! >= 0x2e80 ? 1 : 0.55), 0))
  const ems = lineEms.reduce((a, b) => Math.max(a, b), 0) // no spread: huge texts overflow the arg list
  const innerW = Math.max(w - 2 * PAD_X, 0)
  const innerH = Math.max(h - 2 * PAD_Y, 0)
  const gw = Math.min(ems * fontSize, innerW)
  // Soft wrapping: each line takes ceil(width / innerW) rows (review 6 — an
  // auto-height paragraph judged by its first row only turned cream).
  const rows = lineEms.reduce((s, e) => s + Math.max(1, innerW > 0 ? Math.ceil((e * fontSize) / innerW) : 1), 0)
  const gh = Math.min(rows * fontSize * lineHeight, innerH)
  // auto-width hugs its glyphs and draws them from x (align has no room to act)
  const align = textSizingOf(el) === 'auto-width' ? 'left' : textAlign
  const slackX = align === 'center' ? (innerW - gw) / 2 : align === 'right' ? innerW - gw : 0
  const v = textSizingOf(el) === 'fixed' ? textVAlignOf(el) : 'top'
  const slackY = v === 'middle' ? (innerH - gh) / 2 : v === 'bottom' ? innerH - gh : 0
  return [el.x + PAD_X + slackX + gw / 2, el.y + PAD_Y + slackY + gh / 2]
}

// Is point (cx, cy) inside b's box?
const contains = (b: CanvasElement, cx: number, cy: number): boolean =>
  b.width !== undefined &&
  b.height !== undefined &&
  cx >= b.x && cx < b.x + b.width && cy >= b.y && cy < b.y + b.height

// Uniform bucket grid over boxes, so a text only tests the layers near its
// centre (the resolver reruns on every drag frame; a full scan per text was
// 115–200 ms at 1500 elements). Values are positions in `boxes`, ascending.
const CELL = 512
const MAX_CELLS = 1024 // a box spanning more cells goes to `wide` (always tested)
const cellKey = (gx: number, gy: number) => `${gx},${gy}`
function gridOf(boxes: readonly CanvasElement[]) {
  const cells = new Map<string, number[]>()
  const wide: number[] = []
  boxes.forEach((b, n) => {
    if (b.width === undefined || b.height === undefined) return
    const x0 = Math.floor(b.x / CELL), x1 = Math.floor((b.x + b.width) / CELL)
    const y0 = Math.floor(b.y / CELL), y1 = Math.floor((b.y + b.height) / CELL)
    if (!((x1 - x0 + 1) * (y1 - y0 + 1) <= MAX_CELLS)) return void wide.push(n) // also catches NaN
    for (let gx = x0; gx <= x1; gx++)
      for (let gy = y0; gy <= y1; gy++) {
        const k = cellKey(gx, gy)
        const list = cells.get(k)
        if (list) list.push(n)
        else cells.set(k, [n])
      }
  })
  return (cx: number, cy: number): number[] => {
    const c = cells.get(cellKey(Math.floor(cx / CELL), Math.floor(cy / CELL))) ?? []
    return wide.length ? [...c, ...wide].sort((a, b) => a - b) : c
  }
}

const UNDER_TEXT = new Set<CanvasElement['type']>(['shape', 'sticky', 'mock', 'screen', 'image'])

/** Build a per-canvas resolver of "the opaque colour actually painted behind
 *  an element", sharing the element order and frame depths across calls.
 *  Stack, bottom to top — the same order InfiniteCanvas paints:
 *   1. the theme's canvas ground;
 *   2. FRAMES — every ancestor frame and, for a text, every frame holding its glyph
 *      centre (glyphCentre; parent or not: frames are drawn beneath all other elements),
 *      shallowest nesting first (containmentDepth), array order within a depth;
 *   3. other ancestors, and — for a text — every shape / sticky / mock /
 *      screen / image drawn before it that holds its glyph centre, in array order.
 *  Alpha and element opacity are honoured. Yields null when the top of the
 *  stack cannot be judged (image, auto-theme page, unparseable paint): the
 *  caller then falls back to the fixed default ink. */
export function makeBackdropResolver(
  elements: readonly CanvasElement[],
  theme: ThemeName,
  hiddenViaGroup?: ReadonlySet<string>,
): (el: CanvasElement) => string | null {
  const byId = new Map(elements.map((e) => [e.id, e]))
  const indexOf = new Map(elements.map((e, i) => [e.id, i]))
  const shown = (u: CanvasElement) => !u.hidden && !hiddenViaGroup?.has(u.id)
  // Only SHOWN frames, for the depth too — InfiniteCanvas sorts its visible
  // frames the same way, so a hidden container doesn't deepen its children.
  const frameById = new Map(elements.filter((e) => e.type === 'frame' && shown(e)).map((e) => [e.id, e]))
  const frames = Array.from(frameById.values())
    .map((f, i) => ({ f, i, d: containmentDepth(frameById, f.id) }))
    .sort((a, b) => a.d - b.d || a.i - b.i)
    .map((x) => x.f)
  const framePos = new Map(frames.map((f, p) => [f.id, p]))
  const framesNear = gridOf(frames)
  // Shown layers a text can sit on, in array (= z) order.
  const under = elements.filter((u) => u.type !== 'frame' && shown(u) && UNDER_TEXT.has(u.type))
  const underNear = gridOf(under)
  return (el) => {
    const ancestors = new Set<string>()
    for (let p = el.parentId ? byId.get(el.parentId) : undefined; p && !ancestors.has(p.id) && p.id !== el.id; p = p.parentId ? byId.get(p.parentId) : undefined)
      ancestors.add(p.id)
    const isText = el.type === 'text'
    const fp = new Set<number>()
    const rest: CanvasElement[] = []
    for (const id of Array.from(ancestors)) {
      const u = byId.get(id)!
      if (framePos.has(id)) fp.add(framePos.get(id)!)
      else if (u.type !== 'frame' && shown(u)) rest.push(u)
    }
    if (isText) {
      const [cx, cy] = glyphCentre(el)
      for (const p of framesNear(cx, cy)) if (contains(frames[p], cx, cy)) fp.add(p)
      const at = indexOf.get(el.id) ?? elements.length
      for (const n of underNear(cx, cy)) {
        const u = under[n]
        if (indexOf.get(u.id)! >= at) break // only what precedes `el` is under it
        if (!ancestors.has(u.id) && contains(u, cx, cy)) rest.push(u)
      }
    }
    rest.sort((a, b) => indexOf.get(a.id)! - indexOf.get(b.id)!)
    const chain = Array.from(fp).sort((a, b) => a - b).map((p) => frames[p])
    chain.push(...rest)
    return paintStack(chain, theme)
  }
}

/** One-off form of makeBackdropResolver (the inspector, tests). */
export function backdropFor(
  el: CanvasElement,
  byId: ReadonlyMap<string, CanvasElement>,
  theme: ThemeName,
  hiddenViaGroup?: ReadonlySet<string>,
): string | null {
  return makeBackdropResolver(Array.from(byId.values()), theme, hiddenViaGroup)(el)
}

function paintStack(chain: readonly CanvasElement[], theme: ThemeName): string | null {
  const g = parseColor(CANVAS_BACKDROP[theme])!
  let c: RGB | null = [g[0], g[1], g[2]]
  for (const layer of chain) {
    const paint = paintOf(layer)
    if (paint === undefined) continue
    const fill = paint === UNKNOWN ? null : parseColor(paint)
    const opacity = resolveOpacity(layer)
    if (!fill) c = null
    else if (c) c = over(fill, c, opacity)
    else if (fill[3] * opacity >= 1) c = [fill[0], fill[1], fill[2]] // an opaque layer re-establishes it
  }
  return c && toHex(c)
}

/** Text colour for a sticky: auto from its (flattened) fill. */
export function stickyTextColor(fill: string, backdrop: string): string {
  return readableTextOn(flattenOver(fill, backdrop))
}

/** Text colour for a text element: an explicit `textColor` is respected;
 *  otherwise auto from the backdrop — or, when the backdrop cannot be judged
 *  (null), the fixed default ink it always had. */
export function textElementColor(el: CanvasElement, backdrop: string | null): string {
  return el.textColor ?? (backdrop ? readableTextOn(backdrop) : DEFAULT_TEXT_COLOR)
}

/** The worst contrast ratio of an EXPLICIT text colour against its backdrops
 *  (one per theme) when it falls below AA — the inspector's warning.
 *  null = fine / auto / unknown. */
export function lowContrastRatio(textColor: string | undefined, ...backdrops: (string | null)[]): number | null {
  if (!textColor) return null
  const rs = backdrops.map((b) => (b ? contrastRatio(textColor, b) : null)).filter((r): r is number => r !== null)
  const r = rs.length ? Math.min(...rs) : null
  return r !== null && r < AA_TEXT_CONTRAST ? r : null
}
