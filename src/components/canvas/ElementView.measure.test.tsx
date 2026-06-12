// @vitest-environment jsdom
//
// The measured-text wiring in ElementView: a text element handed `onMeasure`
// observes its rendered root with a ResizeObserver and reports offset sizes.
// jsdom ships no ResizeObserver, so — like the setPointerCapture stubs in the
// other canvas tests — the observer is stubbed and driven by hand.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { CanvasElement } from '@/lib/types'
import { ElementView } from './ElementView'

class ROStub {
  static instances: ROStub[] = []
  target: Element | null = null
  disconnect = vi.fn()
  constructor(public cb: () => void) {
    ROStub.instances.push(this)
  }
  observe(el: Element) {
    this.target = el
    this.cb() // the real API fires once on observe with the initial size
  }
  unobserve() {}
}

const textEl = (over: Partial<CanvasElement> = {}): CanvasElement => ({
  id: 't1',
  type: 'text',
  x: 0,
  y: 0,
  text: 'hello',
  ...over,
})

const renderText = (props: Partial<React.ComponentProps<typeof ElementView>> = {}) =>
  render(
    <ElementView
      element={textEl()}
      selected={false}
      editing={false}
      onPointerDown={() => {}}
      onChangeText={() => {}}
      onEditDone={() => {}}
      {...props}
    />,
  )

beforeEach(() => {
  ROStub.instances = []
  vi.stubGlobal('ResizeObserver', ROStub)
})

describe('ElementView text measurement', () => {
  it('observes the rendered text box and reports its offset size', () => {
    const onMeasure = vi.fn()
    renderText({ onMeasure })
    expect(ROStub.instances).toHaveLength(1)
    const ro = ROStub.instances[0]
    expect(ro.target).not.toBeNull()
    // jsdom lays nothing out (offset* = 0) — give the node a real size.
    Object.defineProperty(ro.target!, 'offsetWidth', { value: 123, configurable: true })
    Object.defineProperty(ro.target!, 'offsetHeight', { value: 45, configurable: true })
    ro.cb()
    expect(onMeasure).toHaveBeenLastCalledWith(123, 45)
  })

  it('does not observe without onMeasure (free texts) and disconnects on unmount', () => {
    const free = renderText()
    expect(ROStub.instances).toHaveLength(0)
    free.unmount()

    const onMeasure = vi.fn()
    const managed = renderText({ onMeasure })
    expect(ROStub.instances).toHaveLength(1)
    managed.unmount()
    expect(ROStub.instances[0].disconnect).toHaveBeenCalled()
  })

  it('re-attaches when the editor opens, so the editing wrapper stays observed', () => {
    const onMeasure = vi.fn()
    const view = renderText({ onMeasure })
    view.rerender(
      <ElementView
        element={textEl()}
        selected={false}
        editing={true}
        onPointerDown={() => {}}
        onChangeText={() => {}}
        onEditDone={() => {}}
        onMeasure={onMeasure}
      />,
    )
    // The idle observer was torn down and a fresh one attached to whatever
    // root the editing branch rendered (React may reuse the DOM node — the
    // re-subscription is about following the CURRENT ref, not node identity).
    expect(ROStub.instances).toHaveLength(2)
    expect(ROStub.instances[0].disconnect).toHaveBeenCalled()
    expect(ROStub.instances[1].target).not.toBeNull()
  })
})
