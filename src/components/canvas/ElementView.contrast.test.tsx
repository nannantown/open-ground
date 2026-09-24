// @vitest-environment jsdom
//
// Guard for the 2026-09-24 owner report: on the dark theme, pale stickies
// carried pale (theme-ink) text and an uncoloured heading was dark-on-dark.
// The glyph colour must be derived from what is painted BEHIND it — the
// sticky's fill, or the canvas ground (+ parent frame fills) for a text — and
// clear WCAG AA 4.5:1 in both themes. These tests read the colour the RENDER
// actually asks for, so reverting ElementView to `text-ink` / a fixed default
// turns them red (not just the pure helpers).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render } from '@testing-library/react'
import type { CanvasElement } from '@/lib/types'
import type { ThemeName } from '@/lib/theme'
import { ElementView } from './ElementView'
import { DEFAULT_TEXT_COLOR } from '@/lib/canvasTextStyle'
import {
  AA_TEXT_CONTRAST,
  CANVAS_BACKDROP,
  backdropFor,
  contrastRatio,
  flattenOver,
  lowContrastRatio,
  parseColor,
  readableTextOn,
} from '@/lib/canvasContrast'

class ROStub {
  disconnect = vi.fn()
  constructor(public cb: () => void) {}
  observe() {}
  unobserve() {}
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ROStub)
})

const THEMES: ThemeName[] = ['light', 'dark']
// The sticky swatch row + the fills the reported canvas (bc78500d) uses.
const STICKY_FILLS = ['#ECD79A', '#F4B8A8', '#CDE0B8', '#B8D4E0', '#E0C7E8', '#F8F4E8', '#2A1F1A', '#3A6B8C']

// The glyph colour the render resolved for the node holding `text`: the
// nearest inline `color` up the tree. A Tailwind text-colour class on the way
// (e.g. the old `text-ink`) would override it, so that fails the test too.
const renderedColor = (container: HTMLElement, text: string): string => {
  const node = Array.from(container.querySelectorAll<HTMLElement>('*')).find(
    (n) => n.childNodes.length > 0 && Array.from(n.childNodes).some((c) => c.nodeType === 3 && c.textContent === text),
  )
  expect(node, `node with "${text}"`).toBeTruthy()
  for (let n: HTMLElement | null = node!; n && n !== container; n = n.parentElement) {
    expect(n.className).not.toMatch(/(^|\s)text-(ink|ink-[a-z]+)(\/\d+)?(\s|$)/)
    if (n.style.color) return n.style.color
  }
  throw new Error('no inline text colour on the render path')
}

const renderEl = (element: CanvasElement, backdrop: string | null) =>
  render(
    <ElementView
      element={element}
      selected={false}
      editing={false}
      onPointerDown={() => {}}
      onChangeText={() => {}}
      onEditDone={() => {}}
      backdrop={backdrop}
    />,
  ).container

describe('canvas backdrop mirrors the palettes', () => {
  it('CANVAS_BACKDROP equals --og-bg of each palette in globals.css', () => {
    const css = readFileSync(resolve(__dirname, '../../app/globals.css'), 'utf8')
    const bgOf = (block: string) => {
      const start = css.indexOf(block)
      const m = /--og-bg:\s*(\d+)\s+(\d+)\s+(\d+)/.exec(css.slice(start, css.indexOf('}', start)))!
      return [Number(m[1]), Number(m[2]), Number(m[3])]
    }
    expect(parseColor(CANVAS_BACKDROP.light)!.slice(0, 3)).toEqual(bgOf(':root {'))
    expect(parseColor(CANVAS_BACKDROP.dark)!.slice(0, 3)).toEqual(bgOf("html[data-theme='dark'] {"))
  })
})

describe('sticky text reads on its own fill (both themes)', () => {
  for (const theme of THEMES)
    for (const fill of STICKY_FILLS)
      it(`${theme}: ${fill}`, () => {
        const backdrop = CANVAS_BACKDROP[theme]
        const c = renderEl({ id: 's', type: 'sticky', x: 0, y: 0, text: 'memo', color: fill }, backdrop)
        const ratio = contrastRatio(renderedColor(c, 'memo'), flattenOver(fill, backdrop))!
        expect(ratio).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
      })
})

describe('text element with no colour reads on what is behind it (both themes)', () => {
  const frame = (fill?: string): CanvasElement => ({ id: 'f', type: 'frame', x: 0, y: 0, width: 400, height: 300, text: 'F', fill })
  const cases: [string, CanvasElement[]][] = [
    ['bare canvas', []],
    ['default paper-wash frame', [frame()]],
    ['white artboard', [frame('#FFFFFF')]],
    ['dark frame', [frame('#1B2A3A')]],
    ['half-transparent dark frame', [frame('rgba(20, 20, 20, 0.5)')]],
  ]
  for (const theme of THEMES)
    for (const [label, parents] of cases)
      it(`${theme}: ${label}`, () => {
        const el: CanvasElement = { id: 't', type: 'text', x: 10, y: 10, text: 'Heading', parentId: parents[0]?.id }
        const backdrop = backdropFor(el, new Map([...parents, el].map((e) => [e.id, e])), theme)
        const c = renderEl(el, backdrop)
        expect(contrastRatio(renderedColor(c, 'Heading'), backdrop!)!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
      })
})

// Review 2026-09-24: generated text stopped carrying an explicit colour, so the
// auto colour must see gradient / hsl frame fills and the SHAPE under the text
// (e.g. a red button on a white artboard) — each measured 1.10 / 1.10 / 2.70:1.
describe('text on gradient / hsl / shape backdrops reads (both themes)', () => {
  const frame = (fill: string): CanvasElement => ({ id: 'f', type: 'frame', x: 0, y: 0, width: 400, height: 300, text: 'F', fill })
  const button: CanvasElement = { id: 'b', type: 'shape', x: 40, y: 40, width: 160, height: 48, fill: '#B23A2C', parentId: 'f', text: '' }
  // The last column is what the text is judged against: the paint itself (a gradient: its LIGHTER stop, the worst case for light text; the hsl as rgb), never our own backdrop estimate.
  const cases: [string, CanvasElement[], Partial<CanvasElement>, string][] = [
    ['gradient frame', [frame('linear-gradient(135deg, #1B2A3A 0%, #2E4A6B 100%)')], { x: 10, y: 10 }, '#2E4A6B'],
    ['hsl frame', [frame('hsl(215 36% 17%)')], { x: 10, y: 10 }, 'rgb(28, 41, 59)'],
    // LIGHT hsl fills: a double-divided % read every hsl as near-black, which only a light fill exposes.
    ['very light hsl frame', [frame('hsl(0 0% 90%)')], { x: 10, y: 10 }, 'rgb(230, 230, 230)'],
    ['light hsl frame (legacy commas)', [frame('hsl(48, 60%, 92%)')], { x: 10, y: 10 }, 'rgb(247, 242, 222)'],
    ['red button shape on a white artboard', [frame('#FFFFFF'), button], { x: 60, y: 50, width: 120, height: 28 }, '#B23A2C'],
  ]
  for (const theme of THEMES)
    for (const [label, under, pos, ref] of cases)
      it(`${theme}: ${label}`, () => {
        const el = { id: 't', type: 'text', x: 0, y: 0, text: 'Label', parentId: 'f', ...pos } as CanvasElement
        const backdrop = backdropFor(el, new Map([...under, el].map((e) => [e.id, e])), theme)
        const c = renderEl(el, backdrop)
        expect(contrastRatio(renderedColor(c, 'Label'), ref)!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
      })
})

// Review 2 (2026-09-24): a label over a mock / screen page or an image must not
// fall through to the dark canvas (cream on a white page = 1.10:1). A page is
// its own colour; an image cannot be judged → the fixed default ink, as before.
// Review 3 (2026-09-24): frames are drawn beneath every other element, and
// parentId is only set when a text sits FULLY inside — so a frame dragged under
// an existing label, a label straddling a frame edge, or a canvas saved before
// nesting existed left cream text on a white frame at night (1.10:1).
describe('text over a frame that is not its parent (both themes)', () => {
  const white = { id: 'w', type: 'frame', x: 0, y: 0, width: 400, height: 300, text: 'W', fill: '#FFFFFF' } as CanvasElement
  const label = (x: number, y: number) => ({ id: 't', type: 'text', x, y, width: 120, height: 24, text: 'Label' }) as CanvasElement
  const judge = (els: CanvasElement[], el: CanvasElement, theme: ThemeName) =>
    renderedColor(renderEl(el, backdropFor(el, new Map(els.map((e) => [e.id, e])), theme)), 'Label')
  for (const theme of THEMES) {
    it(`${theme}: label inside a white frame, no parentId, frame listed first`, () => {
      const t = label(20, 20)
      expect(contrastRatio(judge([white, t], t, theme), '#FFFFFF')!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
    })
    it(`${theme}: frame listed AFTER the label (dragged under it) still counts`, () => {
      const t = label(20, 20)
      expect(contrastRatio(judge([t, white], t, theme), '#FFFFFF')!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
    })
    it(`${theme}: label straddling the frame edge`, () => {
      const t = label(340, 20)
      expect(contrastRatio(judge([white, t], t, theme), '#FFFFFF')!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
    })
    it(`${theme}: nested frames stack by depth, not array order`, () => {
      // Inner dark frame is listed BEFORE its white container; paint order is
      // still container → inner, so the label sits on the dark inner fill.
      const inner = { id: 'i', type: 'frame', x: 10, y: 10, width: 200, height: 100, text: 'I', fill: '#1B2A3A', parentId: 'w' } as CanvasElement
      const t = label(20, 20)
      expect(contrastRatio(judge([inner, white, t], t, theme), '#1B2A3A')!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
    })
  }
})

describe('text over mock / screen / image (both themes)', () => {
  const box = { x: 0, y: 0, width: 400, height: 300, text: '' }
  const label = { id: 't', type: 'text', x: 20, y: 20, width: 120, height: 24, text: 'Label' } as CanvasElement
  const judge = (under: CanvasElement[], el: CanvasElement, theme: ThemeName) => {
    const backdrop = backdropFor(el, new Map([...under, el].map((e) => [e.id, e])), theme)
    return renderedColor(renderEl(el, backdrop), 'Label')
  }
  const pages: [string, CanvasElement, string][] = [
    ['light mock (default)', { id: 'm', type: 'mock', ...box } as CanvasElement, '#FFFFFF'],
    ['dark mock', { id: 'm', type: 'mock', theme: 'dark', ...box } as CanvasElement, '#0B0C0E'],
    ['light screen', { id: 'm', type: 'screen', ...box } as CanvasElement, '#F8F4E8'],
  ]
  for (const theme of THEMES) {
    for (const [name, page, ref] of pages) {
      it(`${theme}: overlapping ${name}`, () => {
        expect(contrastRatio(judge([page], label, theme), ref)!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
      })
      it(`${theme}: inside ${name} (parent)`, () => {
        expect(contrastRatio(judge([page], { ...label, parentId: 'm' }, theme), ref)!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
      })
    }
    it(`${theme}: over an image element → default ink`, () => {
      const img = { id: 'i', type: 'image', ...box } as CanvasElement
      expect(parseColor(judge([img], label, theme))!.slice(0, 3)).toEqual(parseColor(DEFAULT_TEXT_COLOR)!.slice(0, 3))
    })
    it(`${theme}: inside an image-filled frame → default ink`, () => {
      const f = { id: 'f', type: 'frame', fillImageId: 'a1', ...box } as CanvasElement
      expect(parseColor(judge([f], { ...label, parentId: 'f' }, theme))!.slice(0, 3)).toEqual(parseColor(DEFAULT_TEXT_COLOR)!.slice(0, 3))
    })
    it(`${theme}: a hidden shape does not count`, () => {
      const hidden = { id: 's', type: 'shape', fill: '#000000', hidden: true, ...box } as CanvasElement
      const byId = new Map([hidden, label].map((e) => [e.id, e]))
      expect(backdropFor(label, byId, theme)).toBe(backdropFor(label, new Map([[label.id, label]]), theme))
      const viaGroup = { ...hidden, hidden: false }
      expect(backdropFor(label, new Map([viaGroup, label].map((e) => [e.id, e])), theme, new Set(['s']))).toBe(
        backdropFor(label, new Map([[label.id, label]]), theme),
      )
    })
  }
})

describe('explicit text colour: respected, but flagged when unreadable', () => {
  it('renders the explicit colour as-is', () => {
    const c = renderEl({ id: 't', type: 'text', x: 0, y: 0, text: 'Brand', textColor: '#2A1F1A' }, CANVAS_BACKDROP.dark)
    expect(parseColor(renderedColor(c, 'Brand'))!.slice(0, 3)).toEqual([42, 31, 26])
  })
  it('lowContrastRatio flags dark-on-dark and passes readable pairs', () => {
    expect(lowContrastRatio('#2A1F1A', CANVAS_BACKDROP.dark)).not.toBeNull()
    expect(lowContrastRatio('#F8F4E8', CANVAS_BACKDROP.light)).not.toBeNull()
    expect(lowContrastRatio('#2A1F1A', CANVAS_BACKDROP.light)).toBeNull()
    expect(lowContrastRatio(undefined, CANVAS_BACKDROP.dark)).toBeNull()
    // The inspector passes both themes' backdrops: fine in light, unreadable at night → flagged.
    expect(lowContrastRatio('#2A1F1A', CANVAS_BACKDROP.light, CANVAS_BACKDROP.dark)).not.toBeNull()
  })
  it('readableTextOn clears AA even on a mid-tone fill', () => {
    for (const bg of ['#777777', '#808080', '#E0442E', '#3A6B8C'])
      expect(contrastRatio(readableTextOn(bg), bg)!).toBeGreaterThanOrEqual(AA_TEXT_CONTRAST)
  })
})
