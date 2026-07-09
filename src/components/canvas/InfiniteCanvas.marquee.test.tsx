// @vitest-environment jsdom
//
// Marquee selection must hit-test every element type against its REAL
// bounding box (fullBounds — the single source of truth for per-type
// footprints). Regression pin for audit 856daefb: the marquee branch used a
// hand-rolled per-type ternary with no screen/image cases, so both fell
// through to the 300×44 text fallback — a marquee over e.g. the right half
// of a 1280×800 screen selected nothing, while grazing its top-left corner
// did. ResizeObserver is stubbed because jsdom ships none (same pattern as
// InfiniteCanvas.pointerGuard.test).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import type { CanvasElement, CanvasState } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { InfiniteCanvas } from './InfiniteCanvas'

class ROStub {
  disconnect = vi.fn()
  constructor(public cb: () => void) {}
  observe() {}
  unobserve() {}
}

const el = (
  id: string,
  type: CanvasElement['type'],
  over: Partial<CanvasElement> = {},
): CanvasElement => ({ id, type, x: 0, y: 0, text: '', ...over }) as CanvasElement

const makeCanvas = (elements: CanvasElement[]): CanvasState => ({
  positions: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  elements,
})

const renderCanvas = (elements: CanvasElement[]) => {
  const onSelectIds = vi.fn()
  const { container } = render(
    <InfiniteCanvas
      projects={[]}
      canvas={makeCanvas(elements)}
      onCanvasChange={vi.fn()}
      selectedIds={[]}
      onSelect={vi.fn()}
      onSelectIds={onSelectIds}
      editingId={null}
      onEditingIdChange={vi.fn()}
      tool="select"
      onToolChange={vi.fn()}
      frameVariant="design"
    />,
  )
  return { onSelectIds, container }
}

// Drag a select-tool marquee on the bare viewport from (x1,y1) to (x2,y2).
// jsdom's getBoundingClientRect is all-zero and the viewport sits at
// {x:0, y:0, zoom:1}, so client coords ARE world coords.
const dragMarquee = (
  container: HTMLElement,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
) => {
  const viewport = container.firstChild as HTMLElement
  fireEvent.pointerDown(viewport, { button: 0, clientX: x1, clientY: y1, pointerId: 1 })
  fireEvent.pointerMove(viewport, { clientX: x2, clientY: y2, pointerId: 1 })
  fireEvent.pointerUp(viewport, { button: 0, clientX: x2, clientY: y2, pointerId: 1 })
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ROStub)
})

describe('InfiniteCanvas — marquee hit-tests real element bounds (audit 856daefb)', () => {
  it('selects a screen from a marquee beyond its top-left 300×44 (default 1280×800)', () => {
    const { onSelectIds, container } = renderCanvas([el('s1', 'screen')])
    // Well outside the old 300×44 fallback, well inside the real 1280×800.
    dragMarquee(container, 600, 300, 900, 500)
    expect(onSelectIds).toHaveBeenCalledWith(['s1'])
  })

  it('selects an image from a marquee beyond 300×44 but inside its stored size', () => {
    const { onSelectIds, container } = renderCanvas([
      el('i1', 'image', { width: 480, height: 360 }),
    ])
    dragMarquee(container, 350, 100, 450, 200)
    expect(onSelectIds).toHaveBeenCalledWith(['i1'])
  })

  it('sizeless image falls back to its 208×208 default box', () => {
    const { onSelectIds, container } = renderCanvas([el('i1', 'image')])
    // y ∈ [60,120] is below the old 44px fallback but inside 208.
    dragMarquee(container, 100, 60, 150, 120)
    expect(onSelectIds).toHaveBeenCalledWith(['i1'])
  })

  it('does NOT select a screen from a marquee entirely outside its bounds', () => {
    const { onSelectIds, container } = renderCanvas([el('s1', 'screen')])
    dragMarquee(container, 1300, 850, 1400, 900)
    expect(onSelectIds).toHaveBeenCalledWith([])
  })

  it('sticky and text keep their existing boxes (208×208 / 300×44 fallback)', () => {
    const { onSelectIds, container } = renderCanvas([
      el('st1', 'sticky'),
      el('t1', 'text', { x: 400, text: 'hi' }),
    ])
    // One marquee crossing the sticky's lower half and the text's box.
    dragMarquee(container, 150, 10, 450, 30)
    expect(onSelectIds).toHaveBeenCalledWith(['st1', 't1'])
  })
})
