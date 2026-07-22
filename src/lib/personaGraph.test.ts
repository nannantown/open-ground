import { describe, it, expect } from 'vitest'
import {
  buildPersonaGraphEdges,
  computeViewBoxScale,
  layoutPersonaGraph,
  screenDeltaToUserSpace,
  screenPointToUserSpace,
  type ScreenRect,
} from './personaGraph'
import type { ManualJudgment } from './types'

const j = (over: Partial<ManualJudgment> = {}): ManualJudgment => ({
  id: 'j-1',
  text: 'note',
  addedAt: '2026-07-18T04:00:00.000Z',
  ...over,
})

describe('buildPersonaGraphEdges', () => {
  it('returns no edges for an empty or single-note corpus', () => {
    expect(buildPersonaGraphEdges([])).toEqual([])
    expect(buildPersonaGraphEdges([j()])).toEqual([])
  })

  it('links a correction to the note it replaces', () => {
    const edges = buildPersonaGraphEdges([
      j({ id: 'old', addedAt: '2026-01-01T00:00:00.000Z' }),
      j({ id: 'new', addedAt: '2026-06-01T00:00:00.000Z', correctsId: 'old' }),
    ])
    expect(edges).toEqual([{ source: 'new', target: 'old', kind: 'corrects' }])
  })

  it('ignores a correctsId that points at a note not in this list', () => {
    const edges = buildPersonaGraphEdges([j({ id: 'a', correctsId: 'missing' })])
    expect(edges).toEqual([])
  })

  it('links two notes that share a tag', () => {
    const edges = buildPersonaGraphEdges([
      j({ id: 'a', tags: ['pricing', 'risk'], addedAt: '2026-01-01T00:00:00.000Z' }),
      j({ id: 'b', tags: ['pricing'], addedAt: '2026-06-01T00:00:00.000Z' }),
    ])
    expect(edges).toEqual([{ source: 'a', target: 'b', kind: 'tag', tag: 'pricing' }])
  })

  it('does not link notes with no shared tag (and far enough apart to rule out a date edge)', () => {
    const edges = buildPersonaGraphEdges([
      j({ id: 'a', tags: ['pricing'], addedAt: '2026-01-01T00:00:00.000Z' }),
      j({ id: 'b', tags: ['hiring'], addedAt: '2026-06-01T00:00:00.000Z' }),
    ])
    expect(edges).toEqual([])
  })

  it('links two notes written close together when neither has a stronger link', () => {
    const edges = buildPersonaGraphEdges([
      j({ id: 'a', addedAt: '2026-07-18T04:00:00.000Z' }),
      j({ id: 'b', addedAt: '2026-07-19T10:00:00.000Z' }),
    ])
    expect(edges).toEqual([{ source: 'a', target: 'b', kind: 'date' }])
  })

  it('does NOT also draw a date edge for a pair already linked by tag or correction', () => {
    const edges = buildPersonaGraphEdges([
      j({ id: 'a', tags: ['pricing'], addedAt: '2026-07-18T04:00:00.000Z' }),
      j({ id: 'b', tags: ['pricing'], addedAt: '2026-07-18T05:00:00.000Z' }),
    ])
    expect(edges).toHaveLength(1)
    expect(edges[0].kind).toBe('tag')
  })

  it('leaves notes more than the date window apart unconnected', () => {
    const edges = buildPersonaGraphEdges([
      j({ id: 'a', addedAt: '2026-01-01T00:00:00.000Z' }),
      j({ id: 'b', addedAt: '2026-06-01T00:00:00.000Z' }),
    ])
    expect(edges).toEqual([])
  })

  it('skips an unparsable addedAt instead of throwing', () => {
    const edges = buildPersonaGraphEdges([
      j({ id: 'a', addedAt: 'not-a-date' }),
      j({ id: 'b', addedAt: '2026-07-18T04:00:00.000Z' }),
    ])
    expect(edges).toEqual([])
  })
})

describe('layoutPersonaGraph', () => {
  it('handles an empty node list without throwing', () => {
    expect(layoutPersonaGraph([], [])).toEqual([])
  })

  it('centers a single node', () => {
    const pos = layoutPersonaGraph([{ id: 'only' }], [], 800, 600)
    expect(pos).toEqual([{ id: 'only', x: 400, y: 300 }])
  })

  it('is deterministic — same input, same output', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const edges = [{ source: 'a', target: 'b', kind: 'tag' as const }]
    const first = layoutPersonaGraph(nodes, edges)
    const second = layoutPersonaGraph(nodes, edges)
    expect(second).toEqual(first)
  })

  it('places every node somewhere finite (no NaN/Infinity from a degenerate case)', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    const edges = [
      { source: 'a', target: 'b', kind: 'corrects' as const },
      { source: 'b', target: 'c', kind: 'tag' as const, tag: 'x' },
    ]
    const pos = layoutPersonaGraph(nodes, edges)
    expect(pos).toHaveLength(4)
    for (const p of pos) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
    }
  })

  it('pulls connected nodes closer together than two nodes with no edge at all', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    // a-b are linked; c floats free.
    const edges = [{ source: 'a', target: 'b', kind: 'tag' as const, tag: 'x' }]
    const pos = layoutPersonaGraph(nodes, edges)
    const byId = new Map(pos.map((p) => [p.id, p]))
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.hypot(p.x - q.x, p.y - q.y)
    const ab = dist(byId.get('a')!, byId.get('b')!)
    const ac = dist(byId.get('a')!, byId.get('c')!)
    expect(ab).toBeLessThan(ac)
  })
})

describe('buildPersonaGraphEdges — edge cap', () => {
  it('never returns more than the cap, even for a worst-case all-same-week corpus', () => {
    // 60 untagged, same-hour notes: every pair falls in the date window, which
    // is the exact quadratic worst case the cap exists for (60 choose 2 = 1770).
    const notes = Array.from({ length: 60 }, (_, i) =>
      j({ id: `n${i}`, addedAt: '2026-07-18T04:00:00.000Z' }),
    )
    const edges = buildPersonaGraphEdges(notes)
    expect(edges.length).toBeLessThanOrEqual(600)
    expect(edges.length).toBeGreaterThan(0)
  })
})

describe('computeViewBoxScale / screenPointToUserSpace / screenDeltaToUserSpace', () => {
  // A wider-than-viewBox container: viewBox is 900x620 (aspect ~1.4516), the
  // container is 900x360 (aspect 2.5) — width is the constrained-by axis is
  // HEIGHT here, so scale = 360/620, and the extra width becomes letterboxing
  // on the X axis.
  const rect: ScreenRect = { left: 100, top: 50, width: 900, height: 360 }

  it('computes the meet scale as the SMALLER of the two axis ratios', () => {
    const { scale } = computeViewBoxScale(rect, 900, 620)
    expect(scale).toBeCloseTo(360 / 620, 10)
  })

  it('centers the scaled content — offsetX absorbs the leftover width', () => {
    const { scale, offsetX, offsetY } = computeViewBoxScale(rect, 900, 620)
    expect(offsetY).toBeCloseTo(0, 10) // height is the constrained axis: no leftover there
    expect(offsetX).toBeCloseTo((900 - 900 * scale) / 2, 10)
    expect(offsetX).toBeGreaterThan(0)
  })

  it('falls back to scale=1 for a not-yet-measured (zero-size) rect instead of dividing by zero', () => {
    const zero: ScreenRect = { left: 0, top: 0, width: 0, height: 0 }
    const { scale } = computeViewBoxScale(zero, 900, 620)
    expect(scale).toBe(1)
  })

  it('maps a screen point through the letterbox + scale into user space', () => {
    const { scale, offsetX, offsetY } = computeViewBoxScale(rect, 900, 620)
    // A point exactly at the container's top-left corner.
    const p = screenPointToUserSpace(rect.left, rect.top, rect, 900, 620)
    expect(p.x).toBeCloseTo(-offsetX / scale, 10)
    expect(p.y).toBeCloseTo(-offsetY / scale, 10)
  })

  it('maps the visual center of the content back to the viewBox center', () => {
    const { scale, offsetX, offsetY } = computeViewBoxScale(rect, 900, 620)
    const centerScreenX = rect.left + offsetX + (900 * scale) / 2
    const centerScreenY = rect.top + offsetY + (620 * scale) / 2
    const p = screenPointToUserSpace(centerScreenX, centerScreenY, rect, 900, 620)
    expect(p.x).toBeCloseTo(450, 6)
    expect(p.y).toBeCloseTo(310, 6)
  })

  it('scales a CSS-px delta down to user-space units by the same factor', () => {
    const { scale } = computeViewBoxScale(rect, 900, 620)
    const { dx, dy } = screenDeltaToUserSpace(100, 50, rect, 900, 620)
    expect(dx).toBeCloseTo(100 / scale, 10)
    expect(dy).toBeCloseTo(50 / scale, 10)
    // The whole point of the fix: at this container's scale (< 1), a screen-px
    // drag must move MORE than 1:1 in user space, or the dragged point slips
    // behind the cursor.
    expect(Math.abs(dx)).toBeGreaterThan(100)
  })

  it('is a no-op (1:1) when the container exactly matches the viewBox aspect and size', () => {
    const exact: ScreenRect = { left: 0, top: 0, width: 900, height: 620 }
    const { scale, offsetX, offsetY } = computeViewBoxScale(exact, 900, 620)
    expect(scale).toBeCloseTo(1, 10)
    expect(offsetX).toBeCloseTo(0, 10)
    expect(offsetY).toBeCloseTo(0, 10)
    const { dx, dy } = screenDeltaToUserSpace(37, -12, exact, 900, 620)
    expect(dx).toBeCloseTo(37, 10)
    expect(dy).toBeCloseTo(-12, 10)
  })
})
