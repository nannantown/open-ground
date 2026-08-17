import { describe, it, expect } from 'vitest'
import { cameraForPoint, pointInView, screenPos } from './focus'

// When pointing at a line in the list has to move the camera — and, mostly,
// when it must NOT. See the module header: recentring on every hover is motion
// sickness, not a binding.

const VIEW = { w: 1000, h: 800 }
/** The default camera: centred on the field, unzoomed. */
const HOME = { x: 500, y: 400, s: 1 }

describe('screenPos — the same transform the draw loop uses', () => {
  it('puts the camera centre in the middle of the frame', () => {
    expect(screenPos({ x: 500, y: 400 }, HOME, VIEW)).toEqual({ x: 500, y: 400 })
  })

  it('scales around the camera, not around the origin', () => {
    // At 2× a point 100px right of the camera sits 200px right of centre.
    expect(screenPos({ x: 600, y: 400 }, { x: 500, y: 400, s: 2 }, VIEW)).toEqual({
      x: 700,
      y: 400,
    })
  })
})

describe('cameraForPoint — the camera moves only when it has to', () => {
  it('⚠ RETURNS NULL for a point already on screen', () => {
    // The common case by far: at the default view the whole figure is in frame,
    // so hovering a row must light a point and move NOTHING. A caller that got
    // a camera back here would re-run the easing on every row and read as jitter.
    expect(cameraForPoint({ x: 500, y: 400 }, HOME, VIEW)).toBeNull()
    expect(cameraForPoint({ x: 300, y: 250 }, HOME, VIEW)).toBeNull()
  })

  it('centres a point that is off screen', () => {
    // Panned far away: the point the owner is pointing at is nowhere in frame.
    const cam = { x: 2000, y: 400, s: 1 }
    expect(cameraForPoint({ x: 500, y: 400 }, cam, VIEW)).toEqual({ x: 500, y: 400, s: 1 })
  })

  it('⚠ CARRIES THE SCALE — a hover never rescales the owner’s view', () => {
    const cam = { x: 2000, y: 400, s: 2.4 }
    expect(cameraForPoint({ x: 500, y: 400 }, cam, VIEW)?.s).toBe(2.4)
  })

  it('counts the edge margin as not visible', () => {
    // 5px inside the frame is technically on screen and practically under the
    // probe panel / the recentre chip. `pointInView` is where that judgement
    // lives, so assert it directly as well as through the camera.
    const nearEdge = { x: 5, y: 400 }
    expect(pointInView(nearEdge, HOME, VIEW)).toBe(false)
    expect(cameraForPoint(nearEdge, HOME, VIEW)).not.toBeNull()
    // …and a point comfortably inside is inside.
    expect(pointInView({ x: 500, y: 400 }, HOME, VIEW)).toBe(true)
  })

  it('sees a point pushed off screen BY ZOOM, not only by panning', () => {
    // At 2.6× a point 300px from the camera is 780px from centre — outside a
    // 1000px frame. Zoom alone is enough to lose it.
    const cam = { x: 500, y: 400, s: 2.6 }
    expect(cameraForPoint({ x: 800, y: 400 }, cam, VIEW)).toEqual({ x: 800, y: 400, s: 2.6 })
  })
})
