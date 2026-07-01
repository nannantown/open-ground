// @vitest-environment jsdom
//
// ⌘C/⌘X/⌘V on the canvas must preventDefault ONLY when the in-canvas element
// clipboard actually consumes the keystroke. That suppression is the whole fix
// for the ⌘V double-paste: without it the browser ALSO runs its native paste,
// which InfiniteCanvas' document `paste` listener turns into an OS-image insert
// — so one ⌘V fired BOTH an element paste and an image insert. The mirror
// requirement: an EMPTY in-canvas clipboard must NOT preventDefault, so ⌘V
// still falls through to that native image-paste path. jsdom doesn't model the
// keydown→paste default action, so we assert the mechanism directly: the
// keydown's own defaultPrevented flag. (InfiniteCanvas + heavy children are
// stubbed — only CanvasWorkspace's clipboard keymap is under test.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { CanvasElement, CanvasFile } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

// Capture the surface's onSelect so a test can drive selection without a real
// pointer pipeline (same approach as CanvasWorkspace.dock.test).
let onSelect: ((id: string | null, additive?: boolean) => void) | undefined
vi.mock('./InfiniteCanvas', () => ({
  InfiniteCanvas: (props: {
    onSelect: (id: string | null, additive?: boolean) => void
  }) => {
    onSelect = props.onSelect
    return <div data-testid="surface" />
  },
}))
vi.mock('./ToolPalette', () => ({ ToolPalette: () => null }))
vi.mock('./SelectionInspector', () => ({ SelectionInspector: () => null }))
vi.mock('./LayersPanel', () => ({ LayersPanel: () => null }))

import { CanvasWorkspace } from './CanvasWorkspace'

const makeCanvas = (elements: CanvasElement[]): CanvasFile => ({
  id: 'c1',
  name: 'Canvas 1',
  rev: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  elements,
  chats: [],
  activeChatId: null,
  sidebarOpen: false,
  sidebarWidth: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
})

const textEl = (id: string): CanvasElement =>
  ({ id, type: 'text', x: 0, y: 0, text: 'hi' }) as CanvasElement

const renderWorkspace = (elements: CanvasElement[]) => {
  const onChange = vi.fn()
  render(
    <CanvasWorkspace
      projectPath="/tmp/proj"
      canvas={makeCanvas(elements)}
      onChange={onChange}
      onInspectorOpenChange={vi.fn()}
    />,
  )
  return { onChange }
}

// Dispatch a ⌘<key> keydown on window (where CanvasWorkspace listens) and report
// whether a handler called preventDefault — `cancelable` makes that observable
// through the event's own defaultPrevented flag.
const fireMeta = (key: string): boolean => {
  const ev = new KeyboardEvent('keydown', {
    key,
    metaKey: true,
    cancelable: true,
    bubbles: true,
  })
  act(() => {
    window.dispatchEvent(ev)
  })
  return ev.defaultPrevented
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    ),
  )
})

afterEach(() => {
  cleanup()
  onSelect = undefined
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('CanvasWorkspace — clipboard keys preventDefault only when consumed', () => {
  it('⌘V with a populated clipboard preventDefaults — the native paste (image insert) is suppressed, so one ⌘V = one paste', () => {
    const { onChange } = renderWorkspace([textEl('t1')])
    act(() => onSelect!('t1'))
    expect(fireMeta('c')).toBe(true) // copy the selection into the in-canvas clipboard
    onChange.mockClear()
    expect(fireMeta('v')).toBe(true) // paste consumes the keystroke …
    expect(onChange).toHaveBeenCalled() // … and the element paste really happened
  })

  it('⌘V with an EMPTY clipboard does NOT preventDefault — the native image-paste path stays open', () => {
    renderWorkspace([textEl('t1')])
    // Nothing copied → pasteClipboard is a no-op → the keystroke falls through
    // to the browser so InfiniteCanvas' document `paste` listener can insert an
    // OS-clipboard image instead.
    expect(fireMeta('v')).toBe(false)
  })

  it('⌘C preventDefaults with a selection and falls through with none', () => {
    renderWorkspace([textEl('t1')])
    expect(fireMeta('c')).toBe(false) // empty selection → native copy left alone
    act(() => onSelect!('t1'))
    expect(fireMeta('c')).toBe(true)
  })

  it('⌘X preventDefaults with a selection and falls through with none', () => {
    const { onChange } = renderWorkspace([textEl('t1')])
    expect(fireMeta('x')).toBe(false) // empty selection → native cut left alone
    act(() => onSelect!('t1'))
    onChange.mockClear()
    expect(fireMeta('x')).toBe(true)
    expect(onChange).toHaveBeenCalled() // cut removed the element
  })
})
