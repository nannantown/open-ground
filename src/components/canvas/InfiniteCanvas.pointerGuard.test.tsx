// @vitest-environment jsdom
//
// Primary-button gate on the canvas press handlers. Every gesture-starting
// pointer-down (element / card / shared-card / frame / bare-viewport) must
// ignore non-primary buttons (right = 2, middle = 1) so a right- or
// middle-click only ever opens the context menu — it never moves an element,
// starts a marquee, or (via the press→pointer-up double-click path) flips a
// text into edit mode. The chrome (resize/rotate) handler already had this
// gate; these tests pin it for the rest. ResizeObserver is stubbed because
// jsdom ships none (same pattern as ElementView.measure.test).
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

const textEl = (id: string): CanvasElement =>
  ({ id, type: 'text', x: 0, y: 0, text: 'hi' }) as CanvasElement

const makeCanvas = (elements: CanvasElement[]): CanvasState => ({
  positions: {},
  viewport: { x: 0, y: 0, zoom: 1 },
  elements,
})

// The positioning wrapper carries data-element-id; ElementView's root (its
// single child) is where onElementPointerDown is actually wired, so a press has
// to land there — firing on the wrapper would never reach the handler.
const elRoot = (container: HTMLElement, id: string): Element =>
  container.querySelector(`[data-element-id="${id}"]`)!.firstElementChild!

const renderCanvas = (over: { selectedIds?: string[]; elements?: CanvasElement[] } = {}) => {
  const onSelect = vi.fn()
  const onCanvasChange = vi.fn()
  const onSelectIds = vi.fn()
  const onEditingIdChange = vi.fn()
  const { container } = render(
    <InfiniteCanvas
      projects={[]}
      canvas={makeCanvas(over.elements ?? [textEl('t1')])}
      onCanvasChange={onCanvasChange}
      selectedIds={over.selectedIds ?? []}
      onSelect={onSelect}
      onSelectIds={onSelectIds}
      editingId={null}
      onEditingIdChange={onEditingIdChange}
      tool="select"
      onToolChange={vi.fn()}
      frameVariant="design"
    />,
  )
  return { onSelect, onCanvasChange, onSelectIds, container }
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ROStub)
})

describe('InfiniteCanvas — non-primary pointer buttons start no gesture', () => {
  it('left-click on an element selects it (the gesture-starting baseline)', () => {
    const { onSelect, container } = renderCanvas()
    const el = elRoot(container, 't1')
    fireEvent.pointerDown(el, { button: 0, clientX: 10, clientY: 10, pointerId: 1 })
    // Figma selects on pointer-DOWN — proof a real press started here.
    expect(onSelect).toHaveBeenCalledWith('t1', false)
  })

  it('right-click (button 2) on an element selects nothing / starts no move', () => {
    const { onSelect, onCanvasChange, container } = renderCanvas()
    const el = elRoot(container, 't1')
    fireEvent.pointerDown(el, { button: 2, clientX: 10, clientY: 10, pointerId: 1 })
    expect(onSelect).not.toHaveBeenCalled()
    expect(onCanvasChange).not.toHaveBeenCalled()
  })

  it('middle-click (button 1) on an element selects nothing / starts no move', () => {
    const { onSelect, onCanvasChange, container } = renderCanvas()
    const el = elRoot(container, 't1')
    fireEvent.pointerDown(el, { button: 1, clientX: 10, clientY: 10, pointerId: 1 })
    expect(onSelect).not.toHaveBeenCalled()
    expect(onCanvasChange).not.toHaveBeenCalled()
  })

  it('left-click on empty canvas clears the selection (marquee-click baseline)', () => {
    const { onSelect, container } = renderCanvas()
    const viewport = container.firstChild as HTMLElement
    fireEvent.pointerDown(viewport, { button: 0, clientX: 500, clientY: 500, pointerId: 1 })
    fireEvent.pointerUp(viewport, { button: 0, clientX: 500, clientY: 500, pointerId: 1 })
    expect(onSelect).toHaveBeenCalledWith(null)
  })

  it('right-click on empty canvas does NOT clear the selection (no marquee)', () => {
    const { onSelect, container } = renderCanvas()
    const viewport = container.firstChild as HTMLElement
    fireEvent.pointerDown(viewport, { button: 2, clientX: 500, clientY: 500, pointerId: 1 })
    fireEvent.pointerUp(viewport, { button: 2, clientX: 500, clientY: 500, pointerId: 1 })
    expect(onSelect).not.toHaveBeenCalled()
  })
})
