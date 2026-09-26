// @vitest-environment jsdom
//
// Ground frame tidy / fit / wash, driven through the real InfiniteCanvas +
// FrameView wiring (the pure geometry lives in groundFrameLayout.test.ts).
// Scene = the owner's nesting: an outer frame holding a child frame, a
// PARENTLESS grandchild frame inside that child (legacy data), a parentless
// sticky and a card inside the grandchild, plus loose cards in the outer frame
// — one of them overlapping the child frame. jsdom lays nothing out, so card
// heights fall back to CARD_H (140) and client coords are world coords.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { CanvasElement, CanvasState, ProjectMeta } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

// Counts carriedBy/frameDirectChildren work (descendantIds) to prove a pan
// does not recompute the frame action state.
const containment = vi.hoisted(() => ({ descendantCalls: 0 }))
vi.mock('@/lib/canvasContainment', async (orig) => {
  const m = await orig<typeof import('@/lib/canvasContainment')>()
  return {
    ...m,
    descendantIds: (...a: Parameters<typeof m.descendantIds>) => {
      containment.descendantCalls++
      return m.descendantIds(...a)
    },
  }
})

import { InfiniteCanvas } from './InfiniteCanvas'
import { groundFrameStroke } from './FrameView'

class ROStub {
  disconnect = vi.fn()
  constructor(public cb: () => void) {}
  observe() {}
  unobserve() {}
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ROStub)
})

const CARD_W = 256
const CARD_H = 140
const G = { header: 36, pad: 24, gap: 20 }

const frame = (id: string, x: number, y: number, w: number, h: number, over: Partial<CanvasElement> = {}) =>
  ({ id, type: 'frame', text: id, x, y, width: w, height: h, ...over }) as CanvasElement

const project = (id: string): ProjectMeta => ({
  id,
  name: id,
  path: `/tmp/${id}`,
  description: '',
  lastModified: '2026-09-26T00:00:00Z',
  hasGit: false,
  openTaskCount: 0,
  totalTaskCount: 0,
})

const scene = (over: { outer?: Partial<CanvasElement> } = {}): CanvasState => ({
  viewport: { x: 0, y: 0, zoom: 1 },
  positions: {
    g1: { x: 70, y: 160 }, // inside the grandchild frame
    d1: { x: 450, y: 300 }, // outer's own card, overlapping the child frame
    d2: { x: 900, y: 80 }, // outer's own card
  },
  elements: [
    frame('Outer', 0, 0, 1400, 700, over.outer),
    frame('Child', 40, 60, 500, 400, { parentId: 'Outer' }),
    frame('Grand', 60, 120, 300, 250), // parentless: joins Child by geometry
    { id: 'Note', type: 'sticky', text: '', x: 280, y: 320, width: 60, height: 40 } as CanvasElement,
  ],
})

const renderScene = (canvas: CanvasState) => {
  const onCanvasChange = vi.fn()
  const projects = Object.keys(canvas.positions).map(project)
  const view = (cv: CanvasState) => (
    <InfiniteCanvas
      projects={projects}
      canvas={cv}
      onCanvasChange={onCanvasChange}
      selectedIds={[]}
      onSelect={vi.fn()}
      onSelectIds={vi.fn()}
      editingId={null}
      onEditingIdChange={vi.fn()}
      tool="select"
      onToolChange={vi.fn()}
      frameVariant="ground"
    />
  )
  const utils = render(view(canvas))
  const rerenderWith = (cv: CanvasState) => utils.rerender(view(cv))
  // The header action of the frame labelled `label`.
  const action = (label: string, key: 'tidyTooltip' | 'fitTooltip') => {
    const span = Array.from(utils.container.querySelectorAll('span')).find(
      (s) => s.textContent === label,
    )!
    return span.parentElement!.querySelector(
      `button[aria-label="canvasEl.frame.${key}"]`,
    ) as HTMLButtonElement
  }
  const lastState = () => onCanvasChange.mock.calls.at(-1)?.[0] as CanvasState | undefined
  return { ...utils, action, lastState, onCanvasChange, rerenderWith }
}

type Rect = { x: number; y: number; w: number; h: number }
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const elRect = (s: CanvasState, id: string): Rect => {
  const e = s.elements.find((x) => x.id === id)!
  return { x: e.x, y: e.y, w: e.width!, h: e.height! }
}
const cardRect = (s: CanvasState, id: string): Rect => ({ ...s.positions[id], w: CARD_W, h: CARD_H })

describe('Ground frame tidy (through InfiniteCanvas)', () => {
  it('moves the child frame with EVERYTHING it carries, by one offset, with zero overlap', () => {
    const before = scene()
    const { action, lastState } = renderScene(before)
    fireEvent.click(action('Outer', 'tidyTooltip'))
    const after = lastState()
    expect(after, 'tidy wrote nothing').toBeDefined()
    const s = after!

    // Child, parentless Grand, parentless Note and the card inside Grand all
    // shift by the same amount.
    const dx = elRect(s, 'Child').x - 40
    const dy = elRect(s, 'Child').y - 60
    expect(dx !== 0 || dy !== 0, 'the child frame did not move').toBe(true)
    for (const id of ['Grand', 'Note']) {
      const b = before.elements.find((e) => e.id === id)!
      const a = s.elements.find((e) => e.id === id)!
      expect({ id, dx: a.x - b.x, dy: a.y - b.y }).toEqual({ id, dx, dy })
    }
    expect(s.positions.g1).toEqual({ x: 70 + dx, y: 160 + dy })

    // The outer frame's direct items don't overlap each other.
    const items = [elRect(s, 'Child'), cardRect(s, 'd1'), cardRect(s, 'd2')]
    for (let i = 0; i < items.length; i++)
      for (let j = i + 1; j < items.length; j++)
        expect(overlaps(items[i], items[j]), `items ${i} × ${j}`).toBe(false)
    // Loose cards were repositioned (positions written).
    expect(s.positions.d1).not.toEqual(before.positions.d1)
  })

  it('does nothing when the frame is locked (button disabled)', () => {
    const { action, onCanvasChange } = renderScene(scene({ outer: { locked: true } }))
    expect(action('Outer', 'tidyTooltip').disabled).toBe(true)
    expect(action('Outer', 'fitTooltip').disabled).toBe(true)
    fireEvent.click(action('Outer', 'tidyTooltip'))
    fireEvent.click(action('Outer', 'fitTooltip'))
    expect(onCanvasChange).not.toHaveBeenCalled()
  })
})

describe('Ground frame tidy: the owner 0.11.149 layout', () => {
  // "MyProjects" (too tall) holds child frame "Todo" with 4 cards, plus
  // kickstand and AIResearch loose, stacked to Todo's right.
  const owner = (): CanvasState => ({
    viewport: { x: 0, y: 0, zoom: 1 },
    positions: {
      t1: { x: 48, y: 120 },
      t2: { x: 324, y: 120 },
      t3: { x: 600, y: 120 },
      t4: { x: 48, y: 300 },
      kickstand: { x: 930, y: 62 },
      ai: { x: 932, y: 230 },
    },
    elements: [
      frame('MyProjects', 0, 0, 1250, 1100),
      frame('Todo', 24, 60, 881, 424, { parentId: 'MyProjects' }),
    ],
  })

  it('stacks kickstand + AIResearch beside Todo and the frame hugs them', () => {
    const { action, lastState } = renderScene(owner())
    fireEvent.click(action('MyProjects', 'tidyTooltip'))
    const s = lastState()!
    const todo = elRect(s, 'Todo')
    const kick = cardRect(s, 'kickstand')
    const ai = cardRect(s, 'ai')
    expect(kick.x).toBe(todo.x + todo.w + G.gap)
    expect(ai.x).toBe(kick.x)
    expect(ai.y).toBe(kick.y + CARD_H + G.gap)
    expect(ai.y + ai.h).toBeLessThanOrEqual(todo.y + todo.h)
    // The outer frame shrinks to its contents + margin (was 1250×1100).
    const outer = elRect(s, 'MyProjects')
    expect(outer).toEqual({
      x: 0,
      y: 0,
      w: kick.x + CARD_W + G.pad,
      h: todo.y + todo.h + G.pad,
    })
  })
})

describe('Ground frame tidy: shrinking stops at what tidy leaves in place', () => {
  it('a group of stickies owned by the frame (parentId) stays inside it', () => {
    const cv: CanvasState = {
      viewport: { x: 0, y: 0, zoom: 1 },
      positions: { p1: { x: 40, y: 80 }, p2: { x: 400, y: 80 } },
      elements: [
        frame('F', 0, 0, 1200, 900),
        { id: 'G', type: 'group', x: 900, y: 700, parentId: 'F' } as CanvasElement,
        { id: 's1', type: 'sticky', text: '', x: 900, y: 700, width: 100, height: 80, parentId: 'G' } as CanvasElement,
        { id: 's2', type: 'sticky', text: '', x: 1020, y: 700, width: 100, height: 80, parentId: 'G' } as CanvasElement,
      ],
    }
    const { action, lastState } = renderScene(cv)
    fireEvent.click(action('F', 'tidyTooltip'))
    const f = elRect(lastState()!, 'F')
    expect(f.x + f.w).toBeGreaterThanOrEqual(1120 + G.pad)
    expect(f.y + f.h).toBeGreaterThanOrEqual(780 + G.pad)
  })
})

describe('Ground frame tidy: nested edge cases', () => {
  const shiftOf = (b: CanvasState, a: CanvasState, id: string) => {
    const x = b.elements.find((e) => e.id === id)!
    const y = a.elements.find((e) => e.id === id)!
    return { dx: y.x - x.x, dy: y.y - x.y }
  }
  const cardShift = (b: CanvasState, a: CanvasState, id: string) => ({
    dx: a.positions[id].x - b.positions[id].x,
    dy: a.positions[id].y - b.positions[id].y,
  })

  it('A: a card in the overhang of a grandchild (parentId=child) past the child edge moves with the child', () => {
    const before: CanvasState = {
      viewport: { x: 0, y: 0, zoom: 1 },
      positions: {
        a1: { x: 460, y: 150 }, // centre (588, 220): in Grand's overhang, outside Child
        d2: { x: 900, y: 400 },
      },
      elements: [
        frame('Outer', 0, 0, 1400, 700),
        frame('Child', 40, 60, 400, 300, { parentId: 'Outer' }),
        frame('Grand', 300, 100, 300, 200, { parentId: 'Child' }),
      ],
    }
    const { action, lastState } = renderScene(before)
    fireEvent.click(action('Outer', 'tidyTooltip'))
    const s = lastState()!
    const d = shiftOf(before, s, 'Child')
    expect(d.dx !== 0 || d.dy !== 0, 'the child frame did not move').toBe(true)
    expect(shiftOf(before, s, 'Grand')).toEqual(d)
    expect(cardShift(before, s, 'a1'), 'card left behind').toEqual(d)
  })

  it('B: a card in a frame owned by the outer frame but lying inside the child stays with that frame', () => {
    const before: CanvasState = {
      viewport: { x: 0, y: 0, zoom: 1 },
      positions: {
        x1: { x: 72, y: 125 }, // centre (200, 195): inside X (and inside Child's rect)
      },
      elements: [
        frame('Outer', 0, 0, 1400, 700),
        frame('Child', 40, 60, 500, 400, { parentId: 'Outer' }),
        frame('X', 100, 120, 200, 150, { parentId: 'Outer' }),
      ],
    }
    const { action, lastState } = renderScene(before)
    fireEvent.click(action('Outer', 'tidyTooltip'))
    const s = lastState()!
    const dChild = shiftOf(before, s, 'Child')
    const dX = shiftOf(before, s, 'X')
    expect(dX, 'scene must move X and Child differently').not.toEqual(dChild)
    expect(cardShift(before, s, 'x1'), 'card taken by the wrong frame').toEqual(dX)
  })

  it('a pan does not recompute the frame action state', () => {
    const before = scene()
    const { rerenderWith, action } = renderScene(before)
    expect(action('Outer', 'tidyTooltip')).toBeTruthy()
    containment.descendantCalls = 0
    for (let i = 1; i <= 5; i++)
      rerenderWith({ ...before, viewport: { x: i * 10, y: i * 5, zoom: 1 } })
    expect(containment.descendantCalls).toBe(0)
    // ...but a content change does.
    rerenderWith({ ...before, elements: [...before.elements] })
    expect(containment.descendantCalls).toBeGreaterThan(0)
  })
})

describe('Ground frame fit (through InfiniteCanvas)', () => {
  it('snaps the frame to its contents bounding box + margin, contents unmoved', () => {
    const before = scene()
    const { action, lastState } = renderScene(before)
    fireEvent.click(action('Outer', 'fitTooltip'))
    const s = lastState()!
    // Contents: Child 40..540 × 60..460 (Grand, Note, g1 inside it),
    // d1 450..706 × 300..440, d2 900..1156 × 80..220.
    expect(elRect(s, 'Outer')).toEqual({
      x: 40 - G.pad,
      y: 60 - G.header - G.pad,
      w: 1156 - 40 + G.pad * 2,
      h: 460 - 60 + G.header + G.pad * 2,
    })
    expect(s.positions).toEqual(before.positions)
    for (const id of ['Child', 'Grand', 'Note'])
      expect(elRect(s, id)).toEqual(elRect(before, id))
  })
})

describe('Ground frame wash', () => {
  const bg = (fill: string | undefined) => {
    const { container } = renderScene(scene({ outer: { fill } }))
    const span = Array.from(container.querySelectorAll('span')).find((x) => x.textContent === 'Outer')!
    return (span.closest('.pointer-events-none') as HTMLElement).getAttribute('style') ?? ''
  }
  it.each([undefined, '#FFFFFF', 'rgba(242, 237, 222, 0.35)'])('fill %s paints the themed wash', (fill) => {
    expect(bg(fill)).toContain('--og-frame-wash')
  })
  it('an explicitly picked colour is honoured', () => {
    expect(bg('#336699')).not.toContain('--og-frame-wash')
  })
})

describe('Ground frame stroke', () => {
  it('the default stroke is the quiet themed line, firmer only on hover', () => {
    for (const s of [undefined, '#B8A988', '#b8a988']) {
      expect(groundFrameStroke(s, false)).toBe('rgb(var(--og-frame-line))')
      expect(groundFrameStroke(s, true)).toBe('rgb(var(--og-frame-line-hover))')
    }
  })
  it('a picked stroke is honoured, hovered or not', () => {
    expect(groundFrameStroke('#336699', false)).toBe('#336699')
    expect(groundFrameStroke('#336699', true)).toBe('#336699')
  })
})
