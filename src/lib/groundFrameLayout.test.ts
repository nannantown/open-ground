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

  it('keeps reading order and stacks the small boxes beside the tall one', () => {
    const r = tidyLayout(frame, boxes, G)
    // todo (top-left) first; 'b' shares its row band; 'c' follows and, the row
    // being full, stacks under 'b' rather than dropping under todo. 'a' would
    // hang below todo there, so it opens the next row.
    const left = frame.x + G.pad
    const top = frame.y + G.header + G.pad
    const col = left + 881 + G.gap
    expect(r.positions.get('todo')).toEqual({ x: left, y: top })
    expect(r.positions.get('b')).toEqual({ x: col, y: top })
    expect(r.positions.get('c')).toEqual({ x: col, y: top + 170 + G.gap })
    expect(r.positions.get('a')).toEqual({ x: left, y: top + 424 + G.gap })
  })

  it('a child frame wider than the parent still fits (usable width grows)', () => {
    const r = tidyLayout({ x: 0, y: 0, w: 300 }, [{ id: 'f', x: 0, y: 0, w: 900, h: 200 }], G)
    expect(r.width).toBe(900 + G.pad * 2)
  })
})

// Packing density: the boxes' own area over the area of the rectangle that
// hugs them. 1 = no empty space at all.
const density = (out: LayoutBox[]) => {
  const w = Math.max(...out.map((b) => b.x + b.w)) - Math.min(...out.map((b) => b.x))
  const h = Math.max(...out.map((b) => b.y + b.h)) - Math.min(...out.map((b) => b.y))
  return out.reduce((s, b) => s + b.w * b.h, 0) / (w * h)
}

describe('tidyLayout — boxes of different sizes pack without big gaps (owner 0.11.149)', () => {
  // "MyProjects" holds the child frame "Todo" (4 cards) and two loose cards
  // already stacked to Todo's right. Tidy used to flow rows, so AIResearch
  // dropped under Todo and left a hole under kickstand.
  const mine = { x: 0, y: 0, w: 1250 }
  const scene: LayoutBox[] = [
    { id: 'todo', x: 24, y: 60, w: 881, h: 424 },
    { id: 'kickstand', x: 930, y: 62, w: 256, h: 170 },
    { id: 'ai', x: 932, y: 255, w: 256, h: 150 },
  ]

  it('stacks kickstand and AIResearch beside Todo, zero overlap, ≤10% empty', () => {
    const r = tidyLayout(mine, scene, G)
    const out = placed(scene, r.positions)
    for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++)
        expect(overlaps(out[i], out[j]), `${out[i].id} × ${out[j].id}`).toBe(false)
    const [todo, kick, ai] = out
    expect(kick.x).toBe(todo.x + todo.w + G.gap)
    expect(ai.x).toBe(kick.x)
    expect(ai.y).toBe(kick.y + kick.h + G.gap)
    // Nothing hangs below Todo: the frame is exactly Todo's height + chrome.
    expect(r.height).toBe(G.header + G.pad * 2 + 424)
    expect(r.width).toBe(G.pad * 2 + 881 + G.gap + 256)
    // The guard's number: wasted area inside the packing's bounding box.
    expect(density(out)).toBeGreaterThanOrEqual(0.9)
  })

  it("the owner's real sizes (Todo 856×308, ~102-tall cards, frame 1180 wide) stack too", () => {
    const s: LayoutBox[] = [
      { id: 'todo', x: 64, y: 35, w: 856, h: 308 },
      { id: 'kickstand', x: 940, y: 36, w: 256, h: 102 },
      { id: 'ai', x: 64, y: 363, w: 256, h: 102 }, // where the old tidy dropped it
    ]
    const r = tidyLayout({ x: 40, y: -25, w: 1180 }, s, G)
    const [todo, kick, ai] = placed(s, r.positions)
    expect(kick.x).toBe(todo.x + 856 + G.gap)
    expect(ai).toMatchObject({ x: kick.x, y: kick.y + 102 + G.gap })
    expect(r.height).toBe(G.header + G.pad * 2 + 308)
    expect(density([todo, kick, ai])).toBeGreaterThanOrEqual(0.9)
  })

  it('ceiling: a child frame too short for two stacked cards gets no overhanging stack', () => {
    const s: LayoutBox[] = [
      { id: 'todo', x: 24, y: 60, w: 1132, h: 234 },
      { id: 'kickstand', x: 1176, y: 60, w: 256, h: 150 },
      { id: 'ai', x: 1176, y: 230, w: 256, h: 150 },
    ]
    const r = tidyLayout({ x: 0, y: 0, w: 1460 }, s, G)
    expect(r.positions.get('ai')).toEqual({ x: G.pad, y: G.header + G.pad + 234 + G.gap })
  })

  it('is stable with fractional sizes: tidy → tidy moves nothing (Todo 700 + k·0.37)', () => {
    // World coords are never rounded (a drag moves by delta/zoom), so the
    // hugged frame width pad*2 + right edge can come back a hair under the
    // contents after the float round trip. Tidy must not wrap on that.
    for (let k = 0; k < 400; k++) {
      const w = 700 + k * 0.37
      const s: LayoutBox[] = [
        { id: 'todo', x: 64.49, y: 35.19, w, h: 308 },
        { id: 'kickstand', x: 64.49 + w + 20, y: 36, w: 256, h: 102 },
        { id: 'ai', x: 64.49, y: 363, w: 256, h: 102 },
      ]
      const fr = { x: 40.49002837613898, y: -24.806328908255693, w: 1180 }
      const r1 = tidyLayout(fr, s, G)
      const r2 = tidyLayout({ ...fr, w: r1.width }, placed(s, r1.positions), G)
      expect(r2, `Todo width ${w}`).toEqual(r1)
    }
  })

  it('stacks the same when the tall box is a float hair short (228 − 3e-14 vs 96 + 20 + 112)', () => {
    // rowH is a child frame's height re-measured from unrounded world coords,
    // so on the second tidy an exact fit can read ~3e-14 short.
    const run = (h: number) => {
      const s: LayoutBox[] = [
        { id: 'tall', x: 0, y: 0, w: 600, h },
        { id: 'c1', x: 700, y: 0, w: 256, h: 96 },
        { id: 'c2', x: 700, y: 200, w: 256, h: 112 },
      ]
      const fr = { x: 0, y: 0, w: G.pad * 2 + 600 + G.gap + 256 }
      const r1 = tidyLayout(fr, s, G)
      const r2 = tidyLayout({ ...fr, w: r1.width }, placed(s, r1.positions), G)
      expect(r2, `h=${h}: second tidy moved something`).toEqual(r1)
      return r1
    }
    const exact = run(228)
    const hair = run(228 - 3e-14)
    const top = G.header + G.pad
    expect(exact.positions.get('c2')).toEqual({ x: G.pad + 600 + G.gap, y: top + 96 + G.gap })
    expect(hair.positions.get('c2')).toEqual(exact.positions.get('c2'))
  })

  it('is stable: tidying the tidied frame (now hugging its contents) moves nothing', () => {
    const r1 = tidyLayout(mine, scene, G)
    const moved = placed(scene, r1.positions)
    const r2 = tidyLayout({ ...mine, w: r1.width }, moved, G)
    expect(r2.positions).toEqual(r1.positions)
    expect([r2.width, r2.height]).toEqual([r1.width, r1.height])
  })
})

describe('tidyLayout — same-size cards keep the old grid exactly', () => {
  // The row flow tidy shipped with before stacking, verbatim.
  const rowFlow = (fr: { x: number; y: number; w: number }, ordered: LayoutBox[]) => {
    const positions = new Map<string, { x: number; y: number }>()
    const usableW = Math.max(fr.w - G.pad * 2, ...ordered.map((b) => b.w))
    let cx = 0
    let cy = 0
    let rowH = 0
    let maxRight = 0
    for (const b of ordered) {
      if (cx > 0 && cx + b.w > usableW) {
        cy += rowH + G.gap
        cx = 0
        rowH = 0
      }
      positions.set(b.id, { x: fr.x + G.pad + cx, y: fr.y + G.header + G.pad + cy })
      cx += b.w + G.gap
      rowH = Math.max(rowH, b.h)
      maxRight = Math.max(maxRight, cx - G.gap)
    }
    return { positions, width: G.pad * 2 + maxRight, height: G.header + G.pad * 2 + cy + rowH }
  }

  it.each([1, 2, 3, 5, 7, 9, 12])('%i cards, several frame widths', (n) => {
    for (const fw of [200, 304, 600, 856, 900, 1321, 3000]) {
      // Already in reading order, scattered enough to need tidying.
      const cards = Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        x: 10 + (i % 4) * 300 + (i % 3) * 7,
        y: 50 + Math.floor(i / 4) * 400,
        w: 256,
        h: 140,
      }))
      const fr = { x: 40, y: -25, w: fw }
      expect(tidyLayout(fr, cards, G), `n=${n} w=${fw}`).toEqual(rowFlow(fr, cards))
    }
  })

  it('card-only frames with real, varying card heights (100–200) keep the old rows too', () => {
    const rnd = seeded(7)
    for (let run = 0; run < 300; run++) {
      const n = 1 + Math.floor(rnd() * 12)
      const cards = Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        x: (i % 4) * 300,
        y: Math.floor(i / 4) * 400,
        w: 256,
        h: 100 + Math.floor(rnd() * 101),
      }))
      const fr = { x: 0, y: 0, w: 300 + Math.floor(rnd() * 1400) }
      expect(tidyLayout(fr, cards, G), `run ${run}`).toEqual(rowFlow(fr, cards))
    }
  })
})

// Deterministic PRNG (mulberry32) so a fuzz failure reproduces.
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('tidyLayout — fuzz: cards mixed with child frames of any size', () => {
  // Neighbours are apart by at least the gap on one axis (so never overlap).
  const apart = (a: LayoutBox, b: LayoutBox) =>
    a.x + a.w + G.gap <= b.x ||
    b.x + b.w + G.gap <= a.x ||
    a.y + a.h + G.gap <= b.y ||
    b.y + b.h + G.gap <= a.y

  it('never overlaps, keeps the gap, fits the frame, and a second tidy moves nothing', () => {
    const rnd = seeded(42)
    for (let run = 0; run < 2000; run++) {
      const n = 1 + Math.floor(rnd() * 10)
      const boxes: LayoutBox[] = Array.from({ length: n }, (_, i) => {
        const frameBox = rnd() < 0.3
        return {
          id: `b${i}`,
          x: Math.floor(rnd() * 1500),
          y: Math.floor(rnd() * 1200),
          w: frameBox ? 200 + Math.floor(rnd() * 900) : 256,
          h: frameBox ? 150 + Math.floor(rnd() * 600) : 100 + Math.floor(rnd() * 101),
        }
      })
      const fr = { x: 0, y: 0, w: 300 + Math.floor(rnd() * 1600) }
      const r1 = tidyLayout(fr, boxes, G)
      const out = placed(boxes, r1.positions)
      for (let i = 0; i < out.length; i++) {
        const b = out[i]
        expect(b.x + b.w, `run ${run}`).toBeLessThanOrEqual(fr.x + r1.width - G.pad)
        expect(b.y + b.h, `run ${run}`).toBeLessThanOrEqual(fr.y + r1.height - G.pad)
        for (let j = i + 1; j < out.length; j++)
          expect(apart(b, out[j]), `run ${run}: ${b.id} × ${out[j].id}`).toBe(true)
      }
      const r2 = tidyLayout({ ...fr, w: r1.width }, out, G)
      expect(r2, `run ${run}: second tidy moved something`).toEqual(r1)
    }
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

  // Owner 2026-09-26: the frame body reads as a block a shade off the grid —
  // lighter on the dark ground, deeper on the light one.
  const lum = (c: number[]) => c[0] + c[1] + c[2]
  const bgOf = (block: string) => /--og-bg:\s*(\d+)\s+(\d+)\s+(\d+)/.exec(block)!.slice(1).map(Number)
  it('dark wash lifts the dark ground, light wash deepens the light one', () => {
    expect(lum(wash(dark))).toBeGreaterThan(lum(bgOf(dark)))
    expect(lum(wash(css))).toBeLessThan(lum(bgOf(css)))
  })
  it('the wash stays faint so frames never outshine their cards', () => {
    for (const block of [css, dark]) {
      const a = Number(/--og-frame-wash-alpha:\s*([\d.]+)/.exec(block)![1])
      expect(a).toBeGreaterThan(0)
      expect(a).toBeLessThanOrEqual(0.08)
    }
  })
})
