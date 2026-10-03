// @vitest-environment jsdom
// The floating assistant's window owns the keys typed inside it. The app's own
// CAPTURE-phase Esc handlers subscribe before the window's (it subscribes when
// it opens), so each must step aside for a key from inside the window — or one
// Esc does two things: the talk closes AND the canvas tool flips / the
// placement is cancelled underneath. (The Board drawer: BoardModule.esc.test #7.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { createRef } from 'react'
import type { CanvasElement, CanvasState } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { InfiniteCanvas } from '@/components/canvas/InfiniteCanvas'
import { PlacementGhost } from '@/components/canvas/PlacementGhost'
import { ASSISTANT_WINDOW_ATTR } from './assistantWindow'

class ROStub {
  disconnect = vi.fn()
  constructor(public cb: () => void) {}
  observe() {}
  unobserve() {}
}

const canvas: CanvasState = { positions: {}, viewport: { x: 0, y: 0, zoom: 1 }, elements: [] }

/** A stand-in for the open talk window with a focused button inside it. */
const talkWindow = () => {
  const win = document.createElement('section')
  win.setAttribute(ASSISTANT_WINDOW_ATTR, '')
  const send = document.createElement('button')
  win.appendChild(send)
  document.body.appendChild(win)
  send.focus()
  return send
}

beforeEach(() => vi.stubGlobal('ResizeObserver', ROStub))
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('Esc from inside the assistant window reaches nothing underneath', () => {
  const renderCanvas = () => {
    const onToolChange = vi.fn()
    render(
      <InfiniteCanvas
        projects={[]}
        canvas={canvas}
        onCanvasChange={vi.fn()}
        selectedIds={[]}
        onSelect={vi.fn()}
        onSelectIds={vi.fn()}
        editingId={null}
        onEditingIdChange={vi.fn()}
        tool="rect"
        onToolChange={onToolChange}
        frameVariant="design"
      />,
    )
    return onToolChange
  }

  it('Canvas: the tool stays (but Esc elsewhere still leaves the tool)', () => {
    const onToolChange = renderCanvas()
    fireEvent.keyDown(talkWindow(), { key: 'Escape' })
    expect(onToolChange).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onToolChange).toHaveBeenCalledWith('select')
  })

  it('PlacementGhost: the placement stays (but Esc elsewhere still cancels it)', () => {
    const onCancel = vi.fn()
    render(<PlacementGhost name="p" zoom={1} groundRef={createRef()} onPlace={vi.fn()} onCancel={onCancel} />)
    fireEvent.keyDown(talkWindow(), { key: 'Escape' })
    expect(onCancel).not.toHaveBeenCalled()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

describe('other canvas keys from inside the assistant window leave the canvas alone', () => {
  const withSelection = () => {
    const onCanvasChange = vi.fn()
    render(
      <InfiniteCanvas
        projects={[]}
        canvas={{ ...canvas, elements: [{ id: 't1', type: 'text', x: 0, y: 0, text: 'hi' } as CanvasElement] }}
        onCanvasChange={onCanvasChange}
        selectedIds={['t1']}
        onSelect={vi.fn()}
        onSelectIds={vi.fn()}
        editingId={null}
        onEditingIdChange={vi.fn()}
        tool="select"
        onToolChange={vi.fn()}
        frameVariant="design"
      />,
    )
    return onCanvasChange
  }

  it.each(['Delete', 'ArrowRight'])('%s on a window button changes nothing (but does on the canvas)', (key) => {
    const onCanvasChange = withSelection()
    const send = talkWindow()
    fireEvent.keyDown(send, { key })
    expect(onCanvasChange).not.toHaveBeenCalled()
    send.blur()
    fireEvent.keyDown(document.body, { key })
    expect(onCanvasChange).toHaveBeenCalled()
  })
})
