// Figma-style ROTATE cursor — a curved double-headed arrow wrapping the corner
// the pointer hovers, served as an SVG data-URI CSS cursor. `angleDeg` is the
// outward direction from the element's centre to that corner in screen degrees
// (0 = east, clockwise positive — screen y points down), element rotation
// already folded in by the caller. Quantised to 16 headings and cached so a
// mousemove storm never rebuilds the string. Colours are the design tokens
// (ink #2A1F1A on a bg-card #F8F4E8 halo) so the glyph reads on any content.

const BUCKETS = 16
const STEP = 360 / BUCKETS
// Glyph geometry (24×24 viewBox, hotspot at the centre 12,12): an arc of
// radius ARC_R spanning ±ARC_HALF_DEG around the heading, an arrowhead at
// each end pointing along the arc's tangent.
const ARC_R = 6.5
const ARC_HALF_DEG = 50
const HEAD_LEN = 4
const HEAD_HALF_W = 2.4

const cache = new Map<number, string>()

/** CSS cursor string (`url("data:image/svg+xml,…") 12 12, grab`) for the
 *  rotate zone at heading `angleDeg`. */
export function rotateCursor(angleDeg: number): string {
  const a = ((angleDeg % 360) + 360) % 360
  const bucket = Math.round(a / STEP) % BUCKETS
  let cur = cache.get(bucket)
  if (cur === undefined) {
    cur = `url("data:image/svg+xml,${encodeURIComponent(rotateSvg(bucket * STEP))}") 12 12, grab`
    cache.set(bucket, cur)
  }
  return cur
}

const f = (n: number) => String(Math.round(n * 100) / 100)

/** Point on the glyph circle (centre 12,12) at `deg` screen degrees. */
const pt = (deg: number, radius: number) => {
  const r = (deg * Math.PI) / 180
  return { x: 12 + radius * Math.cos(r), y: 12 + radius * Math.sin(r) }
}

/** Arrowhead triangle at the arc end `endDeg`, pointing tangentially in `dir`
 *  (+1 = increasing angle / clockwise on screen, -1 = the other end). */
const headPoints = (endDeg: number, dir: 1 | -1): string => {
  const base = pt(endDeg, ARC_R)
  const t = (endDeg * Math.PI) / 180
  // Unit tangent in `dir`, unit radial (outward) for the head's base width.
  const tx = -Math.sin(t) * dir
  const ty = Math.cos(t) * dir
  const nx = Math.cos(t)
  const ny = Math.sin(t)
  const tip = { x: base.x + tx * HEAD_LEN, y: base.y + ty * HEAD_LEN }
  const b1 = { x: base.x + nx * HEAD_HALF_W, y: base.y + ny * HEAD_HALF_W }
  const b2 = { x: base.x - nx * HEAD_HALF_W, y: base.y - ny * HEAD_HALF_W }
  return `${f(tip.x)},${f(tip.y)} ${f(b1.x)},${f(b1.y)} ${f(b2.x)},${f(b2.y)}`
}

function rotateSvg(angleDeg: number): string {
  const s = pt(angleDeg - ARC_HALF_DEG, ARC_R)
  const e = pt(angleDeg + ARC_HALF_DEG, ARC_R)
  // Sweep clockwise (increasing screen angle) from start to end; the span is
  // under 180° so large-arc stays 0.
  const arc = `M${f(s.x)} ${f(s.y)} A${f(ARC_R)} ${f(ARC_R)} 0 0 1 ${f(e.x)} ${f(e.y)}`
  const headA = headPoints(angleDeg - ARC_HALF_DEG, -1)
  const headB = headPoints(angleDeg + ARC_HALF_DEG, 1)
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    // Halo pass: the same shapes stroked wide in the paper colour, so the dark
    // glyph stays visible over dark canvas content.
    `<path d="${arc}" fill="none" stroke="#F8F4E8" stroke-width="5" stroke-linecap="round"/>` +
    `<polygon points="${headA}" fill="#F8F4E8" stroke="#F8F4E8" stroke-width="3" stroke-linejoin="round"/>` +
    `<polygon points="${headB}" fill="#F8F4E8" stroke="#F8F4E8" stroke-width="3" stroke-linejoin="round"/>` +
    // Ink pass: the actual arrow.
    `<path d="${arc}" fill="none" stroke="#2A1F1A" stroke-width="2" stroke-linecap="round"/>` +
    `<polygon points="${headA}" fill="#2A1F1A"/>` +
    `<polygon points="${headB}" fill="#2A1F1A"/>` +
    '</svg>'
  )
}
