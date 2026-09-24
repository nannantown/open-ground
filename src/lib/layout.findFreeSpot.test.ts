import { describe, expect, it } from 'vitest'
import { findFreeSpot } from './layout'

const overlaps = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.abs(a.x - b.x) < 256 && Math.abs(a.y - b.y) < 160

describe('findFreeSpot', () => {
  it('uses the centre when nothing is there', () => {
    expect(findFreeSpot([], { x: 10, y: 20 })).toEqual({ x: 10, y: 20 })
  })

  it('never lands on top of an existing card, even in a dense cluster', () => {
    const occupied = []
    for (let i = -2; i <= 2; i++)
      for (let j = -2; j <= 2; j++) occupied.push({ x: i * 200 + 7, y: j * 120 + 3 })
    const spot = findFreeSpot(occupied, { x: 0, y: 0 })
    for (const o of occupied) expect(overlaps(spot, o)).toBe(false)
  })

  it('picks the nearest free slot, not a far one', () => {
    const spot = findFreeSpot([{ x: 0, y: 0 }], { x: 0, y: 0 })
    expect(Math.abs(spot.x) + Math.abs(spot.y)).toBeLessThan(500)
  })
})
