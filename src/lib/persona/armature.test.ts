import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  ARMATURE,
  ARMATURE_SEED,
  buildArmaturePoints,
  makeRandom,
  nearestPoint,
  segDist,
  type ArmaturePoint,
} from './armature'
import { PERSONA_REGIONS } from './regions'
import type { PersonaRegion } from '../types'

// The figure's geometry, measured without a pixel.
//
// This file exists because the version it replaces could not be measured at
// all: the old silhouette was an alpha mask read back out of a 2D canvas, and
// jsdom has no 2D context — `buildField` returned null in every test, so every
// rule about where a note sits on the body was guarded by nothing. The armature
// is pure, so all of it is checkable here.
//
// WHAT IS WORTH PINNING, and what is not. The exact coordinate of point 731 is
// not a design decision and pinning it would make every future tweak a test
// edit. What IS a decision: the halo stays off the body, the same body comes
// back every mount, and a miss is answered as a miss rather than rounded to the
// nearest region. Those three are what the tests below hold.

/** A pointer radius as it actually reaches this module: PICK_RADIUS (22 screen
 *  px, PersonaFigure) divided by the figure's height in px. 720 is the figure on
 *  a 900px-tall panel — `Math.min(h * 0.80, w * 0.62)`. */
const PICK = 22 / 720

const region = (points: readonly ArmaturePoint[], r: PersonaRegion) =>
  points.filter((p) => p.region === r)

describe('the armature is a figure, not four clouds', () => {
  it('samples every region, with the halo the sparsest', () => {
    const pts = buildArmaturePoints()
    const counts = new Map<PersonaRegion, number>()
    for (const p of pts) counts.set(p.region, (counts.get(p.region) ?? 0) + 1)
    // Every region carries points, or a whole part of the person is missing
    // from the mirror and nothing says so.
    for (const r of PERSONA_REGIONS) expect(counts.get(r), r).toBeGreaterThan(0)
    // The body is where you are; the ring around it is thinner on purpose.
    expect(counts.get('people')!).toBeLessThan(counts.get('chest')!)
  })

  it('stands inside the frame: crown at the top, soles at the bottom', () => {
    const pts = buildArmaturePoints()
    for (const p of pts) {
      expect(Number.isFinite(p.x), `x of ${JSON.stringify(p)}`).toBe(true)
      expect(Number.isFinite(p.y), `y of ${JSON.stringify(p)}`).toBe(true)
    }
    const body = pts.filter((p) => p.region !== 'people')
    const ys = body.map((p) => p.y)
    // The head starts at the crown and the feet end at the soles — the figure
    // fills its own space rather than floating in the middle of it.
    expect(Math.min(...ys)).toBeLessThan(0.02)
    expect(Math.max(...ys)).toBeGreaterThan(0.98)
    // Nothing on the BODY reaches as wide as the halo's ring.
    const bodyWidest = Math.max(...body.map((p) => Math.abs(p.x)))
    const haloWidest = Math.max(...region(pts, 'people').map((p) => Math.abs(p.x)))
    expect(bodyWidest).toBeLessThan(haloWidest)
  })

  it('the head sits above the shoulders and the legs below the hips', () => {
    // Not decoration: the seating rule puts 「考え方」 in the head and
    // 「続けかた」 in the legs, so a figure whose parts are in the wrong order
    // would light the wrong place for a true reading.
    const pts = buildArmaturePoints()
    const headTop = Math.min(...region(pts, 'head').map((p) => p.y))
    const legsTop = Math.min(...region(pts, 'legs').map((p) => p.y))
    const chestTop = Math.min(...region(pts, 'chest').map((p) => p.y))
    expect(headTop).toBeLessThan(chestTop)
    expect(chestTop).toBeLessThan(legsTop)
    expect(legsTop).toBeGreaterThanOrEqual(ARMATURE.hipY - 0.06)
  })
})

describe('the halo is AROUND the figure, never on it', () => {
  // MUTATION GUARD (R2 #1). Deleting the keep-clear `continue` in
  // buildArmaturePoints reds this test and nothing else: the ring collapses
  // through the silhouette and the pointer starts answering 「人との関わり」
  // over the owner's own chest — a claim about other people, made out of
  // material that never mentioned them.
  it('never enters the body', () => {
    const pts = buildArmaturePoints()
    const inside = region(pts, 'people').filter(
      (p) => Math.abs(p.x) < 0.115 && p.y > 0.05 && p.y < 0.99,
    )
    expect(inside, `${inside.length} halo points landed on the body`).toEqual([])
  })

  it('stays within the drawable frame', () => {
    for (const p of region(buildArmaturePoints(), 'people')) {
      expect(p.y).toBeGreaterThanOrEqual(-0.02)
      expect(p.y).toBeLessThanOrEqual(1.06)
    }
  })
})

describe('the body is the same body every mount', () => {
  // MUTATION GUARD (R2 #2). Swapping the LCG for `Math.random()` reds both
  // assertions. A figure that reshuffles itself on every open is not a mirror:
  // the owner would watch their own notes move, and no screenshot of this
  // surface could ever be compared with another.
  it('returns an identical field for the same seed', () => {
    expect(buildArmaturePoints()).toEqual(buildArmaturePoints())
    expect(buildArmaturePoints(ARMATURE_SEED)).toEqual(buildArmaturePoints())
  })

  it('matches the pinned field byte for byte', () => {
    // The pin is a hash rather than 1946 literals: it fails loudly on any
    // change to the sampler, and re-pinning is a deliberate one-line act.
    const sha = createHash('sha256')
      .update(JSON.stringify(buildArmaturePoints()))
      .digest('hex')
    expect(sha).toBe('34acc3f1a8abbea04d62460dd2add2e5d9fd57e492764343d4937d592087ed0b')
  })

  it('a different seed is a different body (the seed is really the input)', () => {
    expect(buildArmaturePoints(1)).not.toEqual(buildArmaturePoints())
  })

  it('makeRandom is a stream, not a constant', () => {
    const a = makeRandom(ARMATURE_SEED)
    const b = makeRandom(ARMATURE_SEED)
    const first = [a(), a(), a(), a()]
    expect(first).toEqual([b(), b(), b(), b()])
    expect(new Set(first).size).toBe(4)
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('the hit test is the silhouette, not a box', () => {
  it('segDist measures to the segment, clamped at both ends', () => {
    // Beside the middle of the segment: the perpendicular distance.
    expect(segDist(0, 1, 0, 0, 0, 2)).toBeCloseTo(0, 10)
    expect(segDist(0.5, 1, 0, 0, 0, 2)).toBeCloseTo(0.5, 10)
    // Past the end: the distance to the ENDPOINT, which is what rounds a limb
    // off instead of leaving a rectangle's corner sticking out.
    expect(segDist(0, 3, 0, 0, 0, 2)).toBeCloseTo(1, 10)
  })

  // MUTATION GUARD (R2 #3). Replacing `nearestPoint` with a bounding-box test
  // over each region's extent reds this: (0, 0.85) sits inside the legs' box
  // (x ∈ [-0.082, 0.084], y ∈ [0.411, 1.011]) and in the air between the two
  // legs. A box answers 「続けかた」 for a spot the owner is visibly not
  // pointing at.
  it('pointing between the legs hits nothing, not `legs`', () => {
    const pts = buildArmaturePoints()
    const legs = region(pts, 'legs')
    const box = {
      x0: Math.min(...legs.map((p) => p.x)),
      x1: Math.max(...legs.map((p) => p.x)),
      y0: Math.min(...legs.map((p) => p.y)),
      y1: Math.max(...legs.map((p) => p.y)),
    }
    // The probe point is genuinely inside the box a box-test would use…
    expect(0).toBeGreaterThan(box.x0)
    expect(0).toBeLessThan(box.x1)
    expect(0.85).toBeGreaterThan(box.y0)
    expect(0.85).toBeLessThan(box.y1)
    // …and the answer is still "nothing here".
    expect(nearestPoint(pts, 0, 0.85, PICK)).toBeNull()
  })

  it('pointing AT a leg hits `legs` at the same radius', () => {
    // The companion to the miss: a radius that answers null everywhere would
    // pass the test above while making the figure unpointable.
    const hit = nearestPoint(buildArmaturePoints(), -ARMATURE.knee, 0.85, PICK)
    expect(hit?.region).toBe('legs')
  })

  it('answers the NEAREST point, not the first one it finds', () => {
    const pts: ArmaturePoint[] = [
      { x: 0.05, y: 0, region: 'chest' },
      { x: 0.01, y: 0, region: 'head' },
      { x: 0.09, y: 0, region: 'legs' },
    ]
    expect(nearestPoint(pts, 0, 0, 1)?.region).toBe('head')
  })

  it('a radius of zero is a miss, not the closest point', () => {
    expect(nearestPoint(buildArmaturePoints(), 0, 0.07, 0)).toBeNull()
  })
})
