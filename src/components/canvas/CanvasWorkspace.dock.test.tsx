// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import type { CanvasElement, CanvasFile } from '@/lib/types'

// Figma-style right dock auto-collapse: the shell (ProjectCanvas) collapses the
// right inspector dock — widening the canvas — when nothing is selected, and
// restores it on selection. CanvasWorkspace owns the selection, so it drives
// that openness up to the shell via onInspectorOpenChange. This suite pins the
// signal: closed on an empty selection, open on a real (non-comment) selection,
// closed again when cleared. The width animation + canvas widening itself is a
// CSS concern verified in the running app, not here.

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

// Capture the surface's onSelect so a test can drive selection directly,
// without a real pointer pipeline. Heavy / portalled children are stubbed so
// only the dock signal is exercised. (LayersPanel is stubbed too, so the only
// onSelect captured is the InfiniteCanvas surface's.)
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

const textEl = (id: string) =>
  ({ id, type: 'text', x: 0, y: 0, text: 'hi' }) as CanvasElement
const commentEl = (id: string) =>
  ({ id, type: 'comment', x: 0, y: 0 }) as CanvasElement

const renderWorkspace = (
  elements: CanvasElement[],
  onInspectorOpenChange = vi.fn(),
) => ({
  onInspectorOpenChange,
  ...render(
    <CanvasWorkspace
      projectPath="/tmp/proj"
      canvas={makeCanvas(elements)}
      onChange={vi.fn()}
      onInspectorOpenChange={onInspectorOpenChange}
    />,
  ),
})

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

describe('CanvasWorkspace — right dock auto-collapse signal', () => {
  it('reports closed on mount with an empty selection', () => {
    const { onInspectorOpenChange } = renderWorkspace([textEl('el1')])
    expect(onInspectorOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('opens on selection and closes again when the selection is cleared', () => {
    const { onInspectorOpenChange } = renderWorkspace([textEl('el1')])
    expect(onSelect).toBeTypeOf('function')

    act(() => onSelect!('el1'))
    expect(onInspectorOpenChange).toHaveBeenLastCalledWith(true)

    act(() => onSelect!(null))
    expect(onInspectorOpenChange).toHaveBeenLastCalledWith(false)
  })

  it('stays closed for a comment-only selection (comments live in their own pin popover)', () => {
    const { onInspectorOpenChange } = renderWorkspace([commentEl('cm1')])
    onInspectorOpenChange.mockClear()
    act(() => onSelect!('cm1'))
    // The comment is excluded from the inspector, so the dock never opens.
    expect(onInspectorOpenChange).not.toHaveBeenCalledWith(true)
  })
})
