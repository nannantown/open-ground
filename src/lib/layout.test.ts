import { describe, it, expect } from 'vitest'
import { autoLayout } from './layout'

describe('autoLayout', () => {
  it('keeps the original four-column grid for a new workspace', () => {
    expect(autoLayout(['a', 'b', 'c', 'd', 'e'].map(id => ({ id })), {})).toEqual({
      a: { x: 80, y: 80 }, b: { x: 364, y: 80 }, c: { x: 648, y: 80 },
      d: { x: 932, y: 80 }, e: { x: 80, y: 240 },
    })
  })

  it('does not put a new card on a saved card that was dragged into its grid slot', () => {
    const existing = { a: { x: 364, y: 80 } }
    const positions = autoLayout([{ id: 'a' }, { id: 'b' }], existing)
    expect(positions.a).toEqual(existing.a)
    expect(Math.abs(positions.a.x - positions.b.x) >= 284 || Math.abs(positions.a.y - positions.b.y) >= 160).toBe(true)
    expect(existing).toEqual({ a: { x: 364, y: 80 } })
  })

  it('checks saved geometry and every newly placed card, while ignoring removed cards', () => {
    const projects = Array.from({ length: 24 }, (_, i) => ({ id: String(i) }))
    const saved = { '0': { x: 350, y: 100 }, '1': { x: 500, y: 310 }, removed: { x: 80, y: 80 } }
    const positions = autoLayout(projects, saved)
    for (const p of projects.slice(2)) {
      for (const other of projects.filter(o => o.id !== p.id)) {
        const a = positions[p.id], b = positions[other.id]
        expect(Math.abs(a.x - b.x) >= 284 || Math.abs(a.y - b.y) >= 160).toBe(true)
      }
    }
    expect(autoLayout(projects, positions)).toEqual(positions)
    expect(positions.removed).toEqual(saved.removed)
  })
})
