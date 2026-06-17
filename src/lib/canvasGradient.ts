// Gradient fills — parse / format the CSS gradient string the `fill` field holds
// when a frame/shape uses a gradient. The element views already render `fill`
// via CSS `background`, so a `linear-gradient(...)` / `radial-gradient(...)`
// string paints with no view change; this module is the editable model behind
// the inspector's gradient editor (type + angle + colour stops).
//
// We EMIT a canonical form (hex stops, explicit deg / `circle`), so a gradient
// we wrote always round-trips. parseGradient is paren-aware (so rgb()/rgba()
// stops survive) and returns null for anything it can't decompose — the editor
// then seeds a fresh gradient rather than crashing.

import { parseColor, formatColor } from './canvasColor'

export interface GradientStop {
  /** CSS colour (canonical: #rrggbb / #rrggbbaa). */
  color: string
  /** 0..1 along the gradient line. */
  pos: number
}
export interface Gradient {
  type: 'linear' | 'radial'
  /** Degrees, linear only (CSS angle, 0 = up, 90 = right). Ignored for radial. */
  angle: number
  stops: GradientStop[]
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/** True when a fill string is a gradient we manage. */
export function isGradient(css: string | null | undefined): boolean {
  if (!css) return false
  const v = css.trim().toLowerCase()
  return v.startsWith('linear-gradient(') || v.startsWith('radial-gradient(')
}

/** Split a comma-separated argument list while respecting nested parentheses,
 *  so `rgb(1, 2, 3) 50%, #000 100%` splits into two stops, not four. */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

/** Parse one "color pos%" stop. Position is optional; missing → NaN (the caller
 *  spreads such stops evenly). Returns null if the colour can't be parsed. */
function parseStop(token: string): { color: string; pos: number } | null {
  // The position, if present, is the last whitespace-separated token AND ends
  // with % or is a bare number. Everything before it is the colour.
  const m = /^(.*?)(?:\s+(-?\d*\.?\d+)%?)?$/.exec(token.trim())
  if (!m) return null
  const colorPart = (m[1] || token).trim()
  const c = parseColor(colorPart)
  if (!c) return null
  const pos = m[2] !== undefined ? clamp01(parseFloat(m[2]) / 100) : NaN
  return { color: formatColor(c), pos }
}

/** Parse a CSS gradient string into the editable model, or null if it isn't a
 *  linear/radial gradient with ≥1 parseable colour stop. */
export function parseGradient(css: string | null | undefined): Gradient | null {
  if (!isGradient(css)) return null
  const raw = css!.trim()
  const type: 'linear' | 'radial' = raw.toLowerCase().startsWith('radial') ? 'radial' : 'linear'
  const open = raw.indexOf('(')
  const close = raw.lastIndexOf(')')
  if (open < 0 || close <= open) return null
  const args = splitTopLevel(raw.slice(open + 1, close))
  if (args.length === 0) return null

  let angle = 180 // CSS default for linear is "to bottom" = 180deg
  let stopArgs = args
  // A leading angle / direction / shape arg (no colour) is consumed as config.
  const first = args[0].toLowerCase()
  const angleDeg = /^(-?\d*\.?\d+)deg$/.exec(first)
  if (type === 'linear' && (angleDeg || first.startsWith('to ') || first.endsWith('turn'))) {
    if (angleDeg) angle = ((parseFloat(angleDeg[1]) % 360) + 360) % 360
    else if (first.endsWith('turn')) angle = (((parseFloat(first) * 360) % 360) + 360) % 360
    else angle = directionToAngle(first)
    stopArgs = args.slice(1)
  } else if (type === 'radial' && !parseColor(args[0].split(/\s+/)[0])) {
    // radial shape/size/position prelude (e.g. "circle", "circle at center")
    stopArgs = args.slice(1)
  }

  const parsed = stopArgs.map(parseStop)
  if (parsed.some((p) => p === null)) return null
  const stops = parsed as { color: string; pos: number }[]
  if (stops.length === 0) return null
  return { type, angle, stops: spreadStops(stops) }
}

/** Fill in any missing stop positions by spreading them evenly across the line,
 *  then sort by position — so a hand-authored gradient with bare colours still
 *  edits sensibly. */
function spreadStops(stops: { color: string; pos: number }[]): GradientStop[] {
  const n = stops.length
  const out = stops.map((s, i) => ({
    color: s.color,
    pos: Number.isFinite(s.pos) ? clamp01(s.pos) : n === 1 ? 0 : i / (n - 1),
  }))
  return out.sort((a, b) => a.pos - b.pos)
}

function directionToAngle(dir: string): number {
  // Minimal "to X" → degrees map (the common cases).
  const d = dir.replace(/^to\s+/, '').trim()
  const map: Record<string, number> = {
    top: 0,
    'top right': 45,
    right: 90,
    'bottom right': 135,
    bottom: 180,
    'bottom left': 225,
    left: 270,
    'top left': 315,
  }
  return map[d] ?? 180
}

/** Emit the canonical CSS for a gradient: hex stops, explicit deg / circle. */
export function formatGradient(g: Gradient): string {
  const stops = [...g.stops]
    .sort((a, b) => a.pos - b.pos)
    .map((s) => `${s.color} ${Math.round(clamp01(s.pos) * 100)}%`)
    .join(', ')
  if (g.type === 'radial') return `radial-gradient(circle, ${stops})`
  const angle = ((Math.round(g.angle) % 360) + 360) % 360
  return `linear-gradient(${angle}deg, ${stops})`
}

/** A fresh two-stop gradient seeded from a base colour (used when switching a
 *  solid fill to a gradient — the first stop keeps the current colour). */
export function defaultGradient(baseColor: string, type: 'linear' | 'radial' = 'linear'): Gradient {
  const c = parseColor(baseColor)
  const base = c ? formatColor({ ...c, a: 1 }) : '#ffffff'
  return {
    type,
    angle: 180,
    stops: [
      { color: base, pos: 0 },
      { color: '#ffffff', pos: 1 }, // base → white; opaque so the stop swatch can edit it
    ],
  }
}
