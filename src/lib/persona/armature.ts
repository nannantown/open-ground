// armature.ts — WHERE THE FIGURE'S POINTS SIT, as pure geometry.
//
// The persona figure is a person drawn out of the things known about the owner.
// Before this module it was an alpha mask: a silhouette painted into an
// offscreen canvas and read back pixel by pixel. That had two costs, and the
// second one is why this file exists.
//
//   1. It read as FOUR CLOUDS rather than a person (owner, 2026-08-15). A mask
//      gives density, not structure — no shoulders, no limbs, no taper.
//   2. It was UNTESTABLE. `getContext('2d')` returns null in jsdom, so
//      `buildField` returned null there and every rule about where a note sits
//      on the body was measured by nothing at all.
//
// So the shape is now an ARMATURE — a 7.5-head standing figure sampled as
// points from capsules, a tapered torso and an ellipse head, plus a loose ring
// of "people" beyond the outline. Pure: no canvas, no DOM, no clock, no
// `Math.random`. Every rule below is measurable without rendering a pixel
// (armature.test.ts), which is the point.
//
// FIGURE SPACE. All coordinates here are `x` centred on 0 and `y` from 0 (crown)
// to 1 (soles). The renderer alone knows how many pixels that is; nothing in
// this file may learn.
//
// THE HALO IS NOT ON THE BODY. `people` is drawn as a ring AROUND the figure
// with an explicit keep-clear over the silhouette, because relationships are not
// a part of you — they are what stands around you (this is also the thing that
// makes 恋愛相談 answerable on this screen at all). The keep-clear is load
// bearing, not styling: a halo point inside the body would be picked as
// 「人との関わり」 while the owner is pointing at their own chest.
//
// DETERMINISTIC ON PURPOSE. The sampler is an LCG seeded with ARMATURE_SEED, so
// the same body comes back on every mount, on every machine, in every test.
// `Math.random()` here would reshuffle the figure each time the screen is
// opened, and a body that rearranges itself is not a mirror of anything.

import type { PersonaRegion } from '../types'

/** One sampled point of the figure, in FIGURE SPACE (see the header). */
export interface ArmaturePoint {
  x: number
  y: number
  region: PersonaRegion
}

/** The proportions of the figure. A 7.5-head standing figure, front on, arms
 *  hanging a little away from the body. Taken verbatim from the approved mock —
 *  these numbers ARE the design, so they are named here once rather than spread
 *  through the sampler calls. */
export const ARMATURE = {
  crown: 0.0,
  chin: 0.133,
  shoulderY: 0.205,
  waistY: 0.33,
  hipY: 0.47,
  kneeY: 0.72,
  ankleY: 0.955,
  sole: 1.0,
  headRx: 0.048,
  headRy: 0.07,
  shoulderX: 0.108,
  waistX: 0.062,
  hipX: 0.088,
  elbow: { x: 0.14, y: 0.345 },
  wrist: { x: 0.152, y: 0.485 },
  hipJoint: 0.046,
  knee: 0.055,
  ankle: 0.056,
} as const

/** The one seed the figure is built from. A date, so it is obvious that the
 *  value carries no meaning beyond "fixed". */
export const ARMATURE_SEED = 20260815

/** A 32-bit LCG. Small, exactly reproducible across engines (every operation is
 *  integer, so there is no float drift to argue about), and — unlike
 *  `Math.random` — seedable, which is the whole requirement. */
export const makeRandom = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Distance from (px,py) to the segment ab. This is what gives a limb an even,
 *  rounded thickness instead of a rectangle with hard ends. */
export const segDist = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number => {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

interface Pt {
  x: number
  y: number
}

/** Sample `n` points inside a capsule a→b whose radius tapers r0→r1 along it.
 *  Rejection sampling inside the bounding box; `guard` bounds the loop so a
 *  degenerate capsule cannot hang the caller. */
export const capsule = (
  out: ArmaturePoint[],
  region: PersonaRegion,
  a: Pt,
  b: Pt,
  r0: number,
  r1: number,
  n: number,
  rnd: () => number,
): void => {
  const rMax = Math.max(r0, r1)
  const minX = Math.min(a.x, b.x) - rMax
  const maxX = Math.max(a.x, b.x) + rMax
  const minY = Math.min(a.y, b.y) - rMax
  const maxY = Math.max(a.y, b.y) + rMax
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let left = n
  let guard = 0
  while (left > 0 && guard++ < n * 80) {
    const x = minX + rnd() * (maxX - minX)
    const y = minY + rnd() * (maxY - minY)
    let t = l2 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    if (segDist(x, y, a.x, a.y, b.x, b.y) <= r0 + (r1 - r0) * t) {
      out.push({ x, y, region })
      left--
    }
  }
}

/** The torso is a TAPER, not a capsule: shoulders wide, waist in, hips out. That
 *  one silhouette is most of what makes the field read as a person rather than a
 *  column of dots. */
export const torso = (
  out: ArmaturePoint[],
  region: PersonaRegion,
  y0: number,
  y1: number,
  n: number,
  rnd: () => number,
): void => {
  const half = (y: number): number => {
    if (y <= ARMATURE.shoulderY) {
      const t = (y - ARMATURE.chin) / (ARMATURE.shoulderY - ARMATURE.chin)
      return 0.03 + (ARMATURE.shoulderX - 0.03) * Math.min(1, Math.max(0, t))
    }
    if (y <= ARMATURE.waistY) {
      const t = (y - ARMATURE.shoulderY) / (ARMATURE.waistY - ARMATURE.shoulderY)
      return ARMATURE.shoulderX + (ARMATURE.waistX - ARMATURE.shoulderX) * t
    }
    const t = (y - ARMATURE.waistY) / (ARMATURE.hipY - ARMATURE.waistY)
    return ARMATURE.waistX + (ARMATURE.hipX - ARMATURE.waistX) * Math.min(1, t)
  }
  let left = n
  let guard = 0
  while (left > 0 && guard++ < n * 40) {
    const y = y0 + rnd() * (y1 - y0)
    out.push({ x: (rnd() * 2 - 1) * half(y), y, region })
    left--
  }
}

/** Sample `n` points inside an ellipse. Rejection inside the unit disc so the
 *  points are evenly spread rather than piled at the centre. */
export const ellipse = (
  out: ArmaturePoint[],
  region: PersonaRegion,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  n: number,
  rnd: () => number,
): void => {
  let left = n
  while (left > 0) {
    let x = 0
    let y = 0
    do {
      x = rnd() * 2 - 1
      y = rnd() * 2 - 1
    } while (x * x + y * y > 1)
    out.push({ x: cx + x * rx, y: cy + y * ry, region })
    left--
  }
}

/** How far a halo point must stay from the mid-line while it is beside the body.
 *  Wider than the widest body part at that height (the shoulders, 0.108) would
 *  push the ring off screen; narrower would let it sit ON the figure. */
const HALO_KEEP_CLEAR_X = 0.115
const HALO_KEEP_CLEAR_Y0 = 0.05
const HALO_KEEP_CLEAR_Y1 = 0.99

/** THE FIGURE. Sampled in a fixed order from one seeded stream, so the returned
 *  array is byte-for-byte the same for a given seed — see the header. */
export const buildArmaturePoints = (seed: number = ARMATURE_SEED): ArmaturePoint[] => {
  const rnd = makeRandom(seed)
  const A = ARMATURE
  const o: ArmaturePoint[] = []

  ellipse(o, 'head', 0, A.crown + A.headRy, A.headRx, A.headRy, 150, rnd)
  capsule(o, 'head', { x: 0, y: A.chin }, { x: 0, y: A.shoulderY - 0.02 }, 0.021, 0.026, 34, rnd)
  torso(o, 'chest', A.chin + 0.03, A.hipY, 420, rnd)

  for (const s of [-1, 1]) {
    capsule(
      o,
      'arms',
      { x: s * A.shoulderX * 0.92, y: A.shoulderY + 0.01 },
      { x: s * A.elbow.x, y: A.elbow.y },
      0.028,
      0.022,
      105,
      rnd,
    )
    capsule(
      o,
      'arms',
      { x: s * A.elbow.x, y: A.elbow.y },
      { x: s * A.wrist.x, y: A.wrist.y },
      0.022,
      0.015,
      90,
      rnd,
    )
    ellipse(o, 'arms', s * A.wrist.x, A.wrist.y + 0.028, 0.019, 0.028, 34, rnd)
  }

  for (const s of [-1, 1]) {
    capsule(
      o,
      'legs',
      { x: s * A.hipJoint, y: A.hipY - 0.02 },
      { x: s * A.knee, y: A.kneeY },
      0.04,
      0.026,
      175,
      rnd,
    )
    capsule(
      o,
      'legs',
      { x: s * A.knee, y: A.kneeY },
      { x: s * A.ankle, y: A.ankleY },
      0.026,
      0.015,
      140,
      rnd,
    )
    capsule(
      o,
      'legs',
      { x: s * A.ankle, y: A.ankleY },
      { x: s * (A.ankle + 0.012), y: A.sole },
      0.015,
      0.013,
      22,
      rnd,
    )
  }

  // The field of people: a loose ring beyond the silhouette, sparser and cooler
  // than the body, so it reads as "around you" rather than "of you". The two
  // `continue`s are the contract, not a tidy-up — see the header.
  let left = 210
  let guard = 0
  while (left > 0 && guard++ < 210 * 60) {
    const a = rnd() * 6.283
    const r = 0.2 + rnd() * 0.16
    const x = Math.cos(a) * r * 1.25
    const y = 0.42 + Math.sin(a) * r * 1.05
    if (Math.abs(x) < HALO_KEEP_CLEAR_X && y > HALO_KEEP_CLEAR_Y0 && y < HALO_KEEP_CLEAR_Y1) continue
    if (y < -0.02 || y > 1.06) continue
    o.push({ x, y, region: 'people' })
    left--
  }

  return o
}

/** The point nearest (fx,fy), or null when the nearest one is further than
 *  `maxDist`. All in FIGURE SPACE.
 *
 *  NEAREST POINT, NEVER A BOX. The silhouette IS the shape: a bounding-box test
 *  over each region's extent would answer 「続けかた」 for a spot between the
 *  legs, or 「やり方」 for the air an arm hangs beside — naming a region the
 *  owner is demonstrably not pointing at. A miss is a real answer here, and the
 *  probe is built to say 「何もありません」 rather than round to the nearest
 *  claim. */
export const nearestPoint = <P extends ArmaturePoint>(
  points: readonly P[],
  fx: number,
  fy: number,
  maxDist: number,
): P | null => {
  let best: P | null = null
  let bd = maxDist * maxDist
  for (const p of points) {
    const dx = p.x - fx
    const dy = p.y - fy
    const d = dx * dx + dy * dy
    if (d < bd) {
      bd = d
      best = p
    }
  }
  return best
}
