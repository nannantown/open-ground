import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { tidyLayout, fitFrameRect, type LayoutBox } from './groundFrameLayout'

const G = { header: 36, pad: 24, gap: 20 }

const overlaps = (a: LayoutBox, b: LayoutBox) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

const placed = (boxes: LayoutBox[], pos: Map<string, { x: number; y: number }>) =>
  boxes.map((b) => ({ ...b, ...pos.get(b.id)! }))

// The owner's layout: "MyProjects" holding a big "Todo" child frame plus loose
// project cards (256 wide), some of them sitting right where Todo is.
const frame = { x: 40, y: -25, w: 1321 }
const boxes: LayoutBox[] = [
  { id: 'todo', x: 83, y: 57, w: 881, h: 424 },
  { id: 'a', x: 100, y: 520, w: 256, h: 150 },
  { id: 'b', x: 1000, y: 60, w: 256, h: 170 },
  { id: 'c', x: 500, y: 300, w: 256, h: 150 },
]

describe('tidyLayout — child frames tidy as equals with cards', () => {
  it('places every box, none overlapping, all inside the grown frame', () => {
    const r = tidyLayout(frame, boxes, G)
    const out = placed(boxes, r.positions)
    expect(out).toHaveLength(boxes.length)
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        expect(overlaps(out[i], out[j]), `${out[i].id} × ${out[j].id}`).toBe(false)
    const w = Math.max(frame.w, r.width)
    for (const b of out) {
      expect(b.x).toBeGreaterThanOrEqual(frame.x + G.pad)
      expect(b.y).toBeGreaterThanOrEqual(frame.y + G.header + G.pad)
      expect(b.x + b.w).toBeLessThanOrEqual(frame.x + w - G.pad)
      expect(b.y + b.h).toBeLessThanOrEqual(frame.y + r.height - G.pad)
    }
  })

  it('keeps reading order and wraps when a row is full', () => {
    const r = tidyLayout(frame, boxes, G)
    // todo (top-left) first; 'b' shares its row band; 'a' and 'c' follow.
    expect(r.positions.get('todo')).toEqual({ x: frame.x + G.pad, y: frame.y + G.header + G.pad })
    const b = r.positions.get('b')!
    expect(b.x).toBe(frame.x + G.pad + 881 + G.gap)
    expect(r.positions.get('a')!.y).toBeGreaterThanOrEqual(frame.y + G.header + G.pad + 424 + G.gap)
  })

  it('a child frame wider than the parent still fits (usable width grows)', () => {
    const r = tidyLayout({ x: 0, y: 0, w: 300 }, [{ id: 'f', x: 0, y: 0, w: 900, h: 200 }], G)
    expect(r.width).toBe(900 + G.pad * 2)
  })
})

describe('fitFrameRect — frame = contents bounding box + margin', () => {
  it('hugs the union of contents with pad on every side and the header on top', () => {
    const r = fitFrameRect(boxes, G)!
    // union: x 83..1256, y 57..670
    expect(r).toEqual({
      x: 83 - G.pad,
      y: 57 - G.header - G.pad,
      w: 1256 - 83 + G.pad * 2,
      h: 670 - 57 + G.header + G.pad * 2,
    })
  })

  it('returns null for an empty frame', () => {
    expect(fitFrameRect([], G)).toBeNull()
  })
})

describe('Ground frame wash is themed', () => {
  const css = readFileSync(new URL('../app/globals.css', import.meta.url), 'utf8')
  const wash = (block: string) =>
    /--og-frame-wash:\s*(\d+)\s+(\d+)\s+(\d+)/.exec(block)!.slice(1).map(Number)
  const dark = css.slice(css.indexOf("html[data-theme='dark']"))

  it('dark wash is darker than the dark ground (no glowing frames)', () => {
    const bg = /--og-bg:\s*(\d+)\s+(\d+)\s+(\d+)/.exec(dark)!.slice(1).map(Number)
    const lum = (c: number[]) => c[0] + c[1] + c[2]
    expect(lum(wash(dark))).toBeLessThan(lum(bg))
  })
})
