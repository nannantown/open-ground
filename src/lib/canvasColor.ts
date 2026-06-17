// Pure colour parsing / formatting for the inspector's colour controls. Our
// fill model is a single CSS-colour STRING (see canvasFillStyle.ts), so a
// Figma-style per-fill OPACITY is expressed by folding alpha INTO that string
// as #rrggbbaa (or kept as #rrggbb at full opacity). These helpers are the one
// place that parses a colour to channels and writes alpha back, so the swatch,
// the hex field, the opacity field and the eyedropper all agree. Kept out of
// the React component so it is unit-testable in the `node` vitest env.
//
// Scope: handles hex (#rgb / #rgba / #rrggbb / #rrggbbaa) and functional
// rgb()/rgba() in BOTH legacy comma and modern space/slash syntax, with numeric
// or `%` alpha. Named colours / hsl() / gradients are intentionally NOT parsed
// (parseColor returns null) — the opacity control then leaves the value alone
// rather than guessing, and the swatch falls back the same way it always has.

export interface RGBA {
  /** 0–255 */ r: number
  /** 0–255 */ g: number
  /** 0–255 */ b: number
  /** 0–1 */ a: number
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))
const clamp255 = (n: number): number => Math.min(255, Math.max(0, Math.round(n)))
const hexByte = (h: string, i: number): number => parseInt(h.slice(i, i + 2), 16)
const dupNibble = (c: string): number => parseInt(c + c, 16)

function parseAlpha(s: string): number {
  const t = s.trim()
  if (t === '') return 1
  const n = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t)
  return Number.isFinite(n) ? clamp01(n) : 1
}

/** Parse a CSS colour string to RGBA channels, or null if it isn't a hex /
 *  rgb() / rgba() value we can decompose (named colours, hsl, gradients). */
export function parseColor(input: string | null | undefined): RGBA | null {
  if (!input) return null
  const v = input.trim().toLowerCase()
  if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)
  if (hex) {
    const h = hex[1]
    if (h.length === 3) return { r: dupNibble(h[0]), g: dupNibble(h[1]), b: dupNibble(h[2]), a: 1 }
    if (h.length === 4)
      return { r: dupNibble(h[0]), g: dupNibble(h[1]), b: dupNibble(h[2]), a: dupNibble(h[3]) / 255 }
    if (h.length === 6) return { r: hexByte(h, 0), g: hexByte(h, 2), b: hexByte(h, 4), a: 1 }
    if (h.length === 8)
      return { r: hexByte(h, 0), g: hexByte(h, 2), b: hexByte(h, 4), a: hexByte(h, 6) / 255 }
    return null // 5/7-digit hex is invalid CSS
  }
  const fn = /^rgba?\((.*)\)$/.exec(v)
  if (fn) {
    const body = fn[1]
    let rgbPart: string
    let alphaPart: string | undefined
    if (body.includes('/')) {
      const [l, r] = body.split('/')
      rgbPart = l
      alphaPart = r
    } else {
      const parts = body.split(',')
      rgbPart = parts.slice(0, 3).join(' ')
      alphaPart = parts.length >= 4 ? parts[parts.length - 1] : undefined
    }
    const nums = rgbPart.trim().split(/[\s,]+/).filter(Boolean).map(Number)
    if (nums.length < 3 || nums.some((n) => !Number.isFinite(n))) return null
    return {
      r: clamp255(nums[0]),
      g: clamp255(nums[1]),
      b: clamp255(nums[2]),
      a: alphaPart !== undefined ? parseAlpha(alphaPart) : 1,
    }
  }
  return null
}

/** The alpha (0–1) of a colour string; 1 when fully opaque or unparseable. */
export function alphaOf(input: string | null | undefined): number {
  return parseColor(input)?.a ?? 1
}

/** Format channels as `#rrggbb` (alpha ≥ 1) or `#rrggbbaa` (alpha < 1). */
export function formatColor(c: RGBA): string {
  const h2 = (n: number) => clamp255(n).toString(16).padStart(2, '0')
  const base = `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`
  if (c.a >= 1) return base
  return `${base}${Math.round(clamp01(c.a) * 255).toString(16).padStart(2, '0')}`
}

/** Return `input` with its alpha replaced by `a` (0–1), as `#rrggbb(aa)`.
 *  Leaves the value unchanged if it can't be parsed (named / hsl / gradient),
 *  so the opacity control is a no-op rather than corrupting an exotic colour. */
export function withAlpha(input: string | null | undefined, a: number): string {
  const c = parseColor(input)
  if (!c) return input ?? ''
  return formatColor({ ...c, a: clamp01(a) })
}

/** Whether the opacity control can act on this colour (i.e. we can parse it). */
export function hasParsableColor(input: string | null | undefined): boolean {
  return parseColor(input) !== null
}
