import { describe, expect, it } from 'vitest'
import type { ProjectMeta } from '@/lib/types'
import { jumpViewport, matchProjects, READABLE_ZOOM, viewportAt } from '@/lib/groundJump'

const proj = (id: string, name: string, description = ''): ProjectMeta =>
  ({ id, name, description, path: `/p/${id}`, openTaskCount: 0 }) as unknown as ProjectMeta

const projects = [
  proj('a', 'alpha-site', 'Marketing landing page'),
  proj('b', 'beta-tool', '家計簿アプリの試作'),
  proj('c', 'gamma'),
]

describe('matchProjects', () => {
  it('finds a project by a word in its description (Japanese too)', () => {
    expect(matchProjects(projects, '家計簿').map((p) => p.id)).toEqual(['b'])
    expect(matchProjects(projects, 'landing').map((p) => p.id)).toEqual(['a'])
  })

  it('ranks a name hit above a description hit', () => {
    const list = [proj('d', 'docs', 'about gamma'), proj('c', 'gamma')]
    expect(matchProjects(list, 'gamma').map((p) => p.id)).toEqual(['c', 'd'])
  })

  it('empty query lists recently opened projects first', () => {
    expect(matchProjects(projects, '', ['c', 'b']).map((p) => p.id)).toEqual(['c', 'b', 'a'])
  })
})

describe('jumpViewport', () => {
  const screen = { w: 1000, h: 800 }

  it('centres the card on screen and zooms in to a readable scale', () => {
    const pos = { x: 5000, y: -3000 }
    const vp = jumpViewport(pos, screen, 0.2)
    expect(vp.zoom).toBe(READABLE_ZOOM)
    // The card's centre (pos + half of 256×132) lands at the screen centre.
    expect(vp.x + (pos.x + 128) * vp.zoom).toBeCloseTo(screen.w / 2)
    expect(vp.y + (pos.y + 66) * vp.zoom).toBeCloseTo(screen.h / 2)
  })

  it('never zooms out a user who is already closer', () => {
    expect(jumpViewport({ x: 0, y: 0 }, screen, 2).zoom).toBe(2)
  })

  it('the flight starts where the camera is and ends on the target', () => {
    const from = { x: 10, y: 20, zoom: 0.3 }
    const to = jumpViewport({ x: 900, y: 400 }, screen, from.zoom)
    const a = viewportAt(from, to, 0, screen)
    const b = viewportAt(from, to, 1, screen)
    expect([a.x, a.y, a.zoom].map((n) => +n.toFixed(6))).toEqual([from.x, from.y, from.zoom])
    expect([b.x, b.y, b.zoom].map((n) => +n.toFixed(6))).toEqual([to.x, to.y, to.zoom].map((n) => +n.toFixed(6)))
  })
})
