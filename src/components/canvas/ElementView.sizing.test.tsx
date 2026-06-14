// @vitest-environment jsdom
//
// ElementView's three Figma-parity text sizing modes (see canvasTextSizing.ts +
// docs/CANVAS_TEXT_SIZING_PLAN.md). These assert the RENDER SHAPE per mode — the
// wrap behaviour, whether the width is pinned, and (for fixed) the clip +
// vertical-align — both idle and while editing, so the box can't silently lose
// its mode contract. Layout itself is jsdom-inert (it lays nothing out); we test
// the CSS the component asks for, not computed geometry. ResizeObserver is
// stubbed because jsdom ships none — same pattern as ElementView.measure.test.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { CanvasElement } from '@/lib/types'
import { ElementView } from './ElementView'

class ROStub {
  disconnect = vi.fn()
  constructor(public cb: () => void) {}
  observe() {}
  unobserve() {}
}

const textEl = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 't1',
  type: 'text',
  x: 0,
  y: 0,
  text: 'hello world',
  ...over,
})

// Render a text element and hand back its outer box (the first child of the
// render container — the element ElementView roots the text branch on).
const renderText = (
  over: Partial<CanvasElement>,
  editing = false,
): HTMLElement => {
  const { container } = render(
    <ElementView
      element={textEl(over)}
      selected={false}
      editing={editing}
      onPointerDown={() => {}}
      onChangeText={() => {}}
      onEditDone={() => {}}
    />,
  )
  return container.firstChild as HTMLElement
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ROStub)
})

describe('ElementView text sizing — auto-width (default / legacy)', () => {
  it('idle: hugs content (inline-block, no wrap, no pinned width)', () => {
    const box = renderText({}) // undefined textSizing → auto-width
    expect(box).toHaveClass('inline-block')
    expect(box).toHaveClass('whitespace-pre')
    expect(box.className).not.toContain('whitespace-pre-wrap')
    // No authoritative width is pinned — the box is content-sized.
    expect(box.style.width).toBe('')
  })

  it('idle: an explicit auto-width is identical (no width pinned, no wrap)', () => {
    const box = renderText({ textSizing: 'auto-width', width: 180 })
    expect(box).toHaveClass('inline-block')
    expect(box).toHaveClass('whitespace-pre')
    // auto-width measures BOTH axes — its width is never authoritative, so even
    // a persisted width must NOT pin the box (it would stop hugging content).
    expect(box.style.width).toBe('')
  })

  it('editing: textarea does not wrap (wrap="off")', () => {
    const box = renderText({ textSizing: 'auto-width' }, true)
    const ta = box.querySelector('textarea')!
    expect(ta).not.toBeNull()
    expect(ta.getAttribute('wrap')).toBe('off')
  })
})

describe('ElementView text sizing — auto-height (pinned width, wraps)', () => {
  it('idle: pins the width and wraps (block, pre-wrap)', () => {
    const box = renderText({ textSizing: 'auto-height', width: 220 })
    expect(box).toHaveClass('block')
    expect(box.className).not.toContain('inline-block')
    expect(box).toHaveClass('whitespace-pre-wrap')
    // The user-dragged width is authoritative → pinned on the box.
    expect(box.style.width).toBe('220px')
    // Height is content-measured, never pinned.
    expect(box.style.height).toBe('')
  })

  it('idle: falls back to the legacy width before a drag seeds one', () => {
    const box = renderText({ textSizing: 'auto-height' }) // no width yet
    expect(box.style.width).toBe('300px') // TEXT_W pre-measure fallback
  })

  it('editing: textarea wraps (wrap="soft") and the sizer pins+wraps at the width', () => {
    const box = renderText({ textSizing: 'auto-height', width: 220 }, true)
    // The wrapper pins the authoritative width so the box can't jump on edit.
    expect(box.style.width).toBe('220px')
    const ta = box.querySelector('textarea')!
    expect(ta.getAttribute('wrap')).toBe('soft')
    // The invisible sizer wraps at the same width (aria-hidden, pre-wrap).
    const sizer = box.querySelector('[aria-hidden]')!
    expect(sizer).toHaveClass('whitespace-pre-wrap')
  })
})

describe('ElementView text sizing — fixed (pinned box, clipped, vertical align)', () => {
  it('idle: pins both axes and clips overflow', () => {
    const box = renderText({ textSizing: 'fixed', width: 240, height: 120 })
    expect(box).toHaveClass('overflow-hidden')
    expect(box).toHaveClass('whitespace-pre-wrap')
    expect(box.style.width).toBe('240px')
    expect(box.style.height).toBe('120px')
  })

  it('idle: vertical align maps to justify-content (top/middle/bottom)', () => {
    const top = renderText({ textSizing: 'fixed', width: 240, height: 120 })
    // top is the default (undefined textVerticalAlign).
    expect(top.style.justifyContent).toBe('flex-start')

    const middle = renderText({
      textSizing: 'fixed',
      width: 240,
      height: 120,
      textVerticalAlign: 'middle',
    })
    expect(middle.style.justifyContent).toBe('center')

    const bottom = renderText({
      textSizing: 'fixed',
      width: 240,
      height: 120,
      textVerticalAlign: 'bottom',
    })
    expect(bottom.style.justifyContent).toBe('flex-end')
  })

  it('editing: the box keeps its fixed size and the textarea clips + wraps', () => {
    const box = renderText(
      { textSizing: 'fixed', width: 240, height: 120, textVerticalAlign: 'middle' },
      true,
    )
    // The authoritative box stays put while editing.
    expect(box.style.width).toBe('240px')
    expect(box.style.height).toBe('120px')
    const ta = box.querySelector('textarea')!
    expect(ta.getAttribute('wrap')).toBe('soft')
    expect(ta).toHaveClass('overflow-hidden')
    expect(ta).toHaveClass('whitespace-pre-wrap')
  })
})

describe('ElementView text sizing — measurement wiring is mode-agnostic', () => {
  it('reports the rendered box via onMeasure for every mode (fixed included)', () => {
    // Drive the stubbed observer by hand: ElementView attaches it to the text
    // box when onMeasure is set, regardless of mode (the per-mode null patch is
    // the parent's concern — ElementView still reports the raw offsets).
    for (const textSizing of ['auto-width', 'auto-height', 'fixed'] as const) {
      let fire: (() => void) | null = null
      class Capturing {
        disconnect = vi.fn()
        constructor(public cb: () => void) {
          fire = cb
        }
        observe(el: Element) {
          Object.defineProperty(el, 'offsetWidth', { value: 240, configurable: true })
          Object.defineProperty(el, 'offsetHeight', { value: 96, configurable: true })
          this.cb()
        }
        unobserve() {}
      }
      vi.stubGlobal('ResizeObserver', Capturing)
      const onMeasure = vi.fn()
      render(
        <ElementView
          element={textEl({ textSizing, width: 240, height: 120 })}
          selected={false}
          editing={false}
          onPointerDown={() => {}}
          onChangeText={() => {}}
          onEditDone={() => {}}
          onMeasure={onMeasure}
        />,
      )
      expect(fire).not.toBeNull()
      expect(onMeasure).toHaveBeenLastCalledWith(240, 96)
    }
  })
})
