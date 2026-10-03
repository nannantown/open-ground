// The assistant splits the app icon's carved ring into pieces along radial
// lines (RING_CUTS). A line that crosses ring MATERIAL shows as a hairline seam
// at rest and splits the ring open where the icon is solid when it breathes.
// So every cut must run, from the centre hole to past the rim, only through
// cut-out area: the hole or one of the notches. Checked geometrically here —
// the notch shapes are flattened to polygons (arcs and curves sampled finely).
import { describe, it, expect } from 'vitest'
import { OG_SHARDS, OG_SHARD_CENTROIDS } from '@/components/canvas/openGroundShards'
import {
  OG_NOTCH_SCALE,
  OG_NOTCH_SHARDS,
  OG_RING_CX,
  OG_RING_CY,
  OG_RING_INNER,
  OG_RING_OUTER,
} from '@/components/canvas/OpenGroundMark'
import { RING_CUTS } from './AssistantMark'

type P = [number, number]

/** SVG path data → one polygon (the shards are single closed subpaths). */
const flatten = (d: string): P[] => {
  const tokens = d.match(/[A-Za-z]|-?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) ?? []
  const pts: P[] = []
  let i = 0
  let cmd = ''
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  const n = () => Number(tokens[i++])
  const N = 24 // samples per curve/arc
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++]
    const rel = cmd === cmd.toLowerCase()
    const C = cmd.toUpperCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    if (C === 'Z') {
      x = sx
      y = sy
      continue
    }
    if (C === 'M') {
      x = ox + n()
      y = oy + n()
      sx = x
      sy = y
      pts.push([x, y])
      cmd = rel ? 'l' : 'L'
    } else if (C === 'L') {
      x = ox + n()
      y = oy + n()
      pts.push([x, y])
    } else if (C === 'H') {
      x = ox + n()
      pts.push([x, y])
    } else if (C === 'V') {
      y = oy + n()
      pts.push([x, y])
    } else if (C === 'C' || C === 'Q') {
      const c = C === 'C' ? [ox + n(), oy + n(), ox + n(), oy + n()] : [ox + n(), oy + n()]
      const ex = ox + n()
      const ey = oy + n()
      for (let k = 1; k <= N; k++) {
        const t = k / N
        const u = 1 - t
        pts.push(
          C === 'C'
            ? [u * u * u * x + 3 * u * u * t * c[0] + 3 * u * t * t * c[2] + t * t * t * ex, u * u * u * y + 3 * u * u * t * c[1] + 3 * u * t * t * c[3] + t * t * t * ey]
            : [u * u * x + 2 * u * t * c[0] + t * t * ex, u * u * y + 2 * u * t * c[1] + t * t * ey],
        )
      }
      x = ex
      y = ey
    } else if (C === 'A') {
      // Endpoint → centre parameterisation (SVG 1.1 implementation notes F.6.5).
      let rx = Math.abs(n())
      let ry = Math.abs(n())
      const phi = (n() * Math.PI) / 180
      const large = n()
      const sweep = n()
      const ex = ox + n()
      const ey = oy + n()
      const cos = Math.cos(phi)
      const sin = Math.sin(phi)
      const dx = (x - ex) / 2
      const dy = (y - ey) / 2
      const x1 = cos * dx + sin * dy
      const y1 = -sin * dx + cos * dy
      const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
      if (lam > 1) {
        rx *= Math.sqrt(lam)
        ry *= Math.sqrt(lam)
      }
      const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
      const den = rx * rx * y1 * y1 + ry * ry * x1 * x1
      const co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num / den))
      const cx1 = (co * rx * y1) / ry
      const cy1 = (-co * ry * x1) / rx
      const cx = cos * cx1 - sin * cy1 + (x + ex) / 2
      const cy = sin * cx1 + cos * cy1 + (y + ey) / 2
      const ang = (ux: number, uy: number) => Math.atan2(uy, ux)
      const t1 = ang((x1 - cx1) / rx, (y1 - cy1) / ry)
      let dt = ang((-x1 - cx1) / rx, (-y1 - cy1) / ry) - t1
      if (sweep && dt < 0) dt += 2 * Math.PI
      if (!sweep && dt > 0) dt -= 2 * Math.PI
      for (let k = 1; k <= N; k++) {
        const t = t1 + (dt * k) / N
        pts.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos])
      }
      x = ex
      y = ey
    } else {
      throw new Error(`unsupported path command ${cmd}`)
    }
  }
  return pts
}

const inside = ([px, py]: P, poly: P[]) => {
  let hit = false
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a]
    const [xb, yb] = poly[b]
    if (ya > py !== yb > py && px < ((xb - xa) * (py - ya)) / (yb - ya) + xa) hit = !hit
  }
  return hit
}

/** The 8 notches exactly as CarvedRingMask places them (scaled about their centres). */
const NOTCHES = OG_NOTCH_SHARDS.map((i) => {
  const [mx, my] = OG_SHARD_CENTROIDS[i]
  return flatten(OG_SHARDS[i]).map(([px, py]): P => [mx + (px - mx) * OG_NOTCH_SCALE, my + (py - my) * OG_NOTCH_SCALE])
})

/** Radii along a cut that land on ring material (neither hole nor notch). */
const solidAlong = (deg: number) => {
  const out: number[] = []
  for (let r = OG_RING_INNER; r <= OG_RING_OUTER + 1; r += 0.25) {
    const a = (deg * Math.PI) / 180
    const p: P = [OG_RING_CX + r * Math.cos(a), OG_RING_CY + r * Math.sin(a)]
    if (r > OG_RING_INNER && !NOTCHES.some((poly) => inside(p, poly))) out.push(r)
  }
  return out
}

describe('the assistant ring is split only through cut-out area', () => {
  it('the flattened notches are where the browser draws them (sanity)', () => {
    // Measured in Chromium (isPointInFill): the 12 o'clock notch covers
    // -94.2°…-74.2° at r = 81 and does not reach r = 49.
    const a = (deg: number, r: number): P => [OG_RING_CX + r * Math.cos((deg * Math.PI) / 180), OG_RING_CY + r * Math.sin((deg * Math.PI) / 180)]
    expect(NOTCHES.some((poly) => inside(a(-85, 81), poly))).toBe(true)
    expect(NOTCHES.some((poly) => inside(a(-97, 81), poly))).toBe(false)
    expect(NOTCHES.some((poly) => inside(a(-85, 49), poly))).toBe(false)
  })

  it.each(RING_CUTS.map((c) => [c]))('the cut at %s° crosses no ring material, hole to rim', (deg) => {
    expect(solidAlong(deg)).toEqual([])
  })
})
