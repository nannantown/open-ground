import { describe, it, expect } from 'vitest'
import { computeSnap, type SnapBox } from './canvasSnap'

const box = (x: number, y: number, w = 100, h = 100): SnapBox => ({ x, y, w, h })

describe('computeSnap', () => {
  it('snaps the left edge to a target left edge within threshold', () => {
    // moving left=3, target left=0 → delta -3 (≤6)
    const r = computeSnap(box(3, 200), [box(0, 0)], 6)
    expect(r.dx).toBe(-3)
    expect(r.dy).toBe(0)
    expect(r.guides.some((g) => g.axis === 'x' && g.pos === 0)).toBe(true)
  })

  it('does not snap when outside the threshold', () => {
    const r = computeSnap(box(20, 200), [box(0, 0)], 6)
    expect(r).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('snaps centers (horizontal + vertical) and emits both guides', () => {
    const target = box(0, 0) // center (50, 50)
    const moving = box(4, -4) // center (54, 46) → dx = 50-54 = -4, dy = 50-46 = +4
    const out = computeSnap(moving, [target], 6)
    expect(out.dx).toBe(-4)
    expect(out.dy).toBe(4)
    expect(out.guides.filter((g) => g.axis === 'x').length).toBe(1)
    expect(out.guides.filter((g) => g.axis === 'y').length).toBe(1)
  })

  it('picks the CLOSEST candidate edge', () => {
    // moving left=5. targets: one left at 0 (delta -5), one right edge at 8 (delta +3).
    // closest is +3 → snaps right-edge-of-target? here target B right=8 vs moving left=5.
    const r = computeSnap(box(5, 500), [box(-100, 0, 100), box(8, 0, 100)], 6)
    // target B left=8 (delta +3) is closest to moving left=5
    expect(r.dx).toBe(3)
  })

  it('returns no guides when there are no targets', () => {
    expect(computeSnap(box(0, 0), [], 6)).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('guide span covers both the moving box and the aligned target', () => {
    // moving (0,300) snaps left to target (0,0); vertical guide should span y 0..400
    const r = computeSnap(box(0, 300), [box(0, 0)], 6)
    const g = r.guides.find((x) => x.axis === 'x')!
    expect(g.from).toBe(0)
    expect(g.to).toBe(400) // target top 0 → moving bottom 400
  })
})
