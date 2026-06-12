// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import type { CanvasElement } from '@/lib/types'

// i18n is mocked to the identity (t(key) → key), matching NewProjectModal.test —
// so titles/labels in queries below are the raw 'canvas.*' keys.
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { LayersPanel } from './LayersPanel'

type PanelProps = React.ComponentProps<typeof LayersPanel>

// Minimal element factory.
const el = (over: Partial<CanvasElement> & { id: string; type: CanvasElement['type'] }) =>
  ({ x: 0, y: 0, text: '', ...over }) as CanvasElement

const handlers = () => ({
  onSelect: vi.fn(),
  onMove: vi.fn(),
  onToggleHidden: vi.fn(),
  onToggleLocked: vi.fn(),
  onRename: vi.fn(),
  onReorder: vi.fn(),
})

// A group 'g' owning 'a' + 'b', plus a top-level note. Array is back→front; the
// panel renders front-at-top so order is: g, b, a, note.
const grouped = (): CanvasElement[] => [
  el({ id: 'note', type: 'sticky', name: 'Note' }),
  el({ id: 'g', type: 'group', name: 'Group' }),
  el({ id: 'a', type: 'sticky', name: 'A', parentId: 'g' }),
  el({ id: 'b', type: 'sticky', name: 'B', parentId: 'g' }),
]

let scrollSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  // jsdom doesn't implement pointer capture / scrollIntoView; stub so the
  // panel's calls are no-ops (scrollSpy doubles as the reveal assertion).
  Element.prototype.setPointerCapture = () => {}
  Element.prototype.releasePointerCapture = () => {}
  scrollSpy = vi.fn()
  Element.prototype.scrollIntoView = scrollSpy as unknown as typeof Element.prototype.scrollIntoView
})

const renderPanel = (
  els: CanvasElement[],
  selectedIds: string[] = [],
  extra: Partial<PanelProps> = {},
) => {
  const h = handlers()
  const props = { elements: els, selectedIds, ...h, ...extra } as PanelProps
  const r = render(<LayersPanel {...props} />)
  const rerenderWith = (over: Partial<PanelProps>) =>
    r.rerender(<LayersPanel {...{ ...props, ...over }} />)
  return { ...r, h, rerenderWith }
}

const rowById = (rows: HTMLElement[], id: string) =>
  rows.find((r) => r.getAttribute('data-layer-row') === id)!

// Pointer click = press + release in place (below the drag threshold).
const clickRow = (row: HTMLElement, init: Record<string, unknown> = {}) => {
  fireEvent.pointerDown(row, { button: 0, pointerId: 1, clientX: 10, clientY: 10, ...init })
  fireEvent.pointerUp(row, { pointerId: 1 })
}

const rect24 = () =>
  ({
    top: 0,
    bottom: 24,
    height: 24,
    left: 0,
    right: 240,
    width: 240,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect

// Press a row, travel past the drag threshold to `clientY` over `targetLi`
// (its <li data-layer-id> hit-test node), WITHOUT releasing.
const dragOver = (fromRow: HTMLElement, targetLi: HTMLElement, clientY: number) => {
  targetLi.getBoundingClientRect = rect24
  document.elementFromPoint = vi.fn(() => targetLi) as unknown as typeof document.elementFromPoint
  fireEvent.pointerDown(fromRow, { button: 0, pointerId: 1, clientX: 10, clientY: 100 })
  fireEvent.pointerMove(fromRow, { pointerId: 1, clientX: 10, clientY })
}

const dragTo = (fromRow: HTMLElement, targetLi: HTMLElement, clientY: number) => {
  dragOver(fromRow, targetLi, clientY)
  fireEvent.pointerUp(fromRow, { pointerId: 1 })
}

describe('LayersPanel — tree + expand/collapse', () => {
  it('lists every element as a treeitem, nesting children under an expanded group', () => {
    const { getAllByRole } = renderPanel(grouped())
    const rows = getAllByRole('treeitem')
    expect(rows).toHaveLength(4)
    // The group row exposes aria-expanded; leaves don't.
    const groupRow = rowById(rows, 'g')
    expect(groupRow.getAttribute('aria-expanded')).toBe('true')
    expect(groupRow.getAttribute('role')).toBe('treeitem')
  })

  it('collapsing a group hides its children', () => {
    const { getByTitle, getAllByRole } = renderPanel(grouped())
    // Only the group row has a twisty (title = collapse when expanded).
    fireEvent.click(getByTitle('canvas.collapse'))
    const rows = getAllByRole('treeitem')
    expect(rows).toHaveLength(2) // group + note; a/b hidden
    expect(rowById(rows, 'g').getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the empty state when there are no elements', () => {
    const { getByText, queryByPlaceholderText } = renderPanel([])
    expect(getByText('canvas.noElementsYet')).toBeTruthy()
    // no dead search field with nothing to search
    expect(queryByPlaceholderText('canvas.searchLayers')).toBeNull()
  })

  it('a layout frame shows its stacking direction as the type icon', () => {
    const layout = { gap: 8, padding: 8, align: 'start' as const }
    const r = renderPanel([el({ id: 'lf', type: 'frame', layout: { ...layout, mode: 'row' } })])
    expect(r.container.querySelector('.lucide-arrow-right')).toBeTruthy()
    r.rerenderWith({
      elements: [el({ id: 'lf', type: 'frame', layout: { ...layout, mode: 'column' } })],
    })
    expect(r.container.querySelector('.lucide-arrow-down')).toBeTruthy()
  })

  it('a hidden element dims its label', () => {
    const { getByTitle } = renderPanel([el({ id: 'x', type: 'sticky', name: 'X', hidden: true })])
    expect(getByTitle('X').classList.contains('opacity-50')).toBe(true)
  })
})

describe('LayersPanel — keyboard a11y', () => {
  it('Enter on a focused row selects it', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    fireEvent.keyDown(rowById(getAllByRole('treeitem'), 'note'), { key: 'Enter' })
    expect(h.onSelect).toHaveBeenCalledWith('note', false)
  })

  it('Enter with a modifier selects additively', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    fireEvent.keyDown(rowById(getAllByRole('treeitem'), 'note'), { key: 'Enter', shiftKey: true })
    expect(h.onSelect).toHaveBeenCalledWith('note', true)
  })

  it('Alt+ArrowDown nudges z within the sibling group; a front-most sibling is a no-op', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    const rows = getAllByRole('treeitem')
    // 'g' is the front-most ROOT → Alt+ArrowUp must NOT move (canMoveLayer).
    fireEvent.keyDown(rowById(rows, 'g'), { key: 'ArrowUp', altKey: true })
    expect(h.onMove).not.toHaveBeenCalled()
    // 'b' is the front-most CHILD → up is a no-op, down moves.
    fireEvent.keyDown(rowById(rows, 'b'), { key: 'ArrowUp', altKey: true })
    expect(h.onMove).not.toHaveBeenCalled()
    fireEvent.keyDown(rowById(rows, 'b'), { key: 'ArrowDown', altKey: true })
    expect(h.onMove).toHaveBeenCalledWith('b', 'down')
  })

  it('ArrowDown moves the selection to the next visible row (Figma)', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    fireEvent.keyDown(rowById(getAllByRole('treeitem'), 'g'), { key: 'ArrowDown' })
    expect(h.onSelect).toHaveBeenCalledWith('b', false)
  })

  it('ArrowUp at the top row is a no-op', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    fireEvent.keyDown(rowById(getAllByRole('treeitem'), 'g'), { key: 'ArrowUp' })
    expect(h.onSelect).not.toHaveBeenCalled()
  })

  it('⇧ArrowDown extends the range from the anchor via onSelectIds', () => {
    const onSelectIds = vi.fn()
    const { getAllByRole } = renderPanel(grouped(), [], { onSelectIds })
    const g = rowById(getAllByRole('treeitem'), 'g')
    clickRow(g) // plain click sets the anchor
    fireEvent.keyDown(g, { key: 'ArrowDown', shiftKey: true })
    expect(onSelectIds).toHaveBeenCalledWith(['g', 'b'])
  })

  it('⇧ArrowDown without onSelectIds degrades to the legacy additive select', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    fireEvent.keyDown(rowById(getAllByRole('treeitem'), 'g'), {
      key: 'ArrowDown',
      shiftKey: true,
    })
    expect(h.onSelect).toHaveBeenCalledWith('b', true)
  })

  it('ArrowLeft collapses an expanded container', () => {
    const { getAllByRole } = renderPanel(grouped())
    fireEvent.keyDown(rowById(getAllByRole('treeitem'), 'g'), { key: 'ArrowLeft' })
    expect(rowById(getAllByRole('treeitem'), 'g').getAttribute('aria-expanded')).toBe('false')
  })

  it('ArrowLeft on a leaf selects its parent', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    fireEvent.keyDown(rowById(getAllByRole('treeitem'), 'a'), { key: 'ArrowLeft' })
    expect(h.onSelect).toHaveBeenCalledWith('g', false)
  })

  it('ArrowRight expands a collapsed container, then steps to the first child', () => {
    const { getAllByRole, getByTitle, h } = renderPanel(grouped())
    fireEvent.click(getByTitle('canvas.collapse'))
    const g = rowById(getAllByRole('treeitem'), 'g')
    fireEvent.keyDown(g, { key: 'ArrowRight' })
    expect(rowById(getAllByRole('treeitem'), 'g').getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(rowById(getAllByRole('treeitem'), 'g'), { key: 'ArrowRight' })
    expect(h.onSelect).toHaveBeenCalledWith('b', false) // first child
  })

  it('F2 opens an inline rename input', () => {
    const { getAllByRole, container } = renderPanel(grouped())
    fireEvent.keyDown(rowById(getAllByRole('treeitem'), 'note'), { key: 'F2' })
    expect(container.querySelector('input:not([placeholder])')).toBeTruthy()
  })
})

describe('LayersPanel — click selection model', () => {
  it('a plain click replaces the selection', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    clickRow(rowById(getAllByRole('treeitem'), 'note'))
    expect(h.onSelect).toHaveBeenCalledWith('note', false)
  })

  it('⇧click selects the visible range from the anchor via onSelectIds', () => {
    const onSelectIds = vi.fn()
    const { getAllByRole } = renderPanel(grouped(), [], { onSelectIds })
    const rows = getAllByRole('treeitem')
    clickRow(rowById(rows, 'g')) // anchor
    clickRow(rowById(rows, 'a'), { shiftKey: true })
    expect(onSelectIds).toHaveBeenCalledWith(['g', 'b', 'a'])
  })

  it('⌘click toggles membership via onSelectIds', () => {
    const onSelectIds = vi.fn()
    const { getAllByRole } = renderPanel(grouped(), ['note'], { onSelectIds })
    const rows = getAllByRole('treeitem')
    clickRow(rowById(rows, 'note'), { metaKey: true })
    expect(onSelectIds).toHaveBeenCalledWith([]) // deselected
    clickRow(rowById(rows, 'a'), { metaKey: true })
    expect(onSelectIds).toHaveBeenCalledWith(['note', 'a'])
  })

  it('⇧click without onSelectIds degrades to the legacy additive select', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    clickRow(rowById(getAllByRole('treeitem'), 'a'), { shiftKey: true })
    expect(h.onSelect).toHaveBeenCalledWith('a', true)
  })
})

describe('LayersPanel — inline rename', () => {
  const openRename = (els: CanvasElement[]) => {
    const r = renderPanel(els)
    const note = rowById(r.getAllByRole('treeitem'), 'note')
    fireEvent.keyDown(note, { key: 'F2' })
    const input = r.container.querySelector('input:not([placeholder])') as HTMLInputElement
    return { ...r, input }
  }

  it('Enter commits the new name via onRename', () => {
    const { input, h } = openRename(grouped())
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false })
    expect(h.onRename).toHaveBeenCalledWith('note', 'Renamed')
  })

  it('Enter DURING IME composition does not commit (guards Japanese input)', () => {
    const { input, h } = openRename(grouped())
    fireEvent.change(input, { target: { value: '日本語' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(h.onRename).not.toHaveBeenCalled()
  })

  it('Escape cancels without renaming', () => {
    const { input, h, container } = openRename(grouped())
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Escape', isComposing: false })
    expect(h.onRename).not.toHaveBeenCalled()
    expect(container.querySelector('input:not([placeholder])')).toBeNull() // input closed
  })
})

describe('LayersPanel — row controls', () => {
  it('the lock button toggles the element lock', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    const note = rowById(getAllByRole('treeitem'), 'note')
    fireEvent.click(within(note).getByTitle('canvas.lock'))
    expect(h.onToggleLocked).toHaveBeenCalledWith('note')
  })

  it('the hide button toggles visibility', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    const note = rowById(getAllByRole('treeitem'), 'note')
    fireEvent.click(within(note).getByTitle('canvas.hide'))
    expect(h.onToggleHidden).toHaveBeenCalledWith('note')
  })

  it('a locked element shows the unlock control + stays discoverable', () => {
    const els = [el({ id: 'x', type: 'sticky', name: 'X', locked: true })]
    const { getByTitle, h } = renderPanel(els)
    fireEvent.click(getByTitle('canvas.unlock'))
    expect(h.onToggleLocked).toHaveBeenCalledWith('x')
  })

  it('z-nudge buttons enable/disable per sibling group, not per row index', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    const rows = getAllByRole('treeitem')
    // 'b' is the front-most child: up disabled, down enabled.
    const b = rowById(rows, 'b')
    expect(within(b).getByTitle('canvas.bringForward')).toBeDisabled()
    fireEvent.click(within(b).getByTitle('canvas.sendBackward'))
    expect(h.onMove).toHaveBeenCalledWith('b', 'down')
    // 'a' is the back-most child: down disabled, up enabled.
    const a = rowById(rows, 'a')
    expect(within(a).getByTitle('canvas.sendBackward')).toBeDisabled()
    fireEvent.click(within(a).getByTitle('canvas.bringForward'))
    expect(h.onMove).toHaveBeenCalledWith('a', 'up')
  })
})

describe('LayersPanel — drag reorder + INTO drop', () => {
  // x behind f (array back→front) → panel rows: f, x.
  const frameAndSticky = (): CanvasElement[] => [
    el({ id: 'x', type: 'sticky', name: 'X' }),
    el({ id: 'f', type: 'frame', name: 'F' }),
  ]
  const liById = (container: HTMLElement, id: string) =>
    container.querySelector(`[data-layer-id="${id}"]`) as HTMLElement

  it('the row middle band drops INTO a container (with an accent ring while hovering)', () => {
    const { container, getAllByRole, h } = renderPanel(frameAndSticky())
    const x = rowById(getAllByRole('treeitem'), 'x')
    dragOver(x, liById(container, 'f'), 12) // middle of a 24px row
    expect(rowById(getAllByRole('treeitem'), 'f').classList.contains('ring-accent')).toBe(true)
    fireEvent.pointerUp(x, { pointerId: 1 })
    expect(h.onReorder).toHaveBeenCalledWith('x', 'f', 'into')
  })

  it('the top band drops above', () => {
    const { container, getAllByRole, h } = renderPanel(frameAndSticky())
    dragTo(rowById(getAllByRole('treeitem'), 'x'), liById(container, 'f'), 3)
    expect(h.onReorder).toHaveBeenCalledWith('x', 'f', 'above')
  })

  it('the bottom band drops below', () => {
    const { container, getAllByRole, h } = renderPanel(frameAndSticky())
    dragTo(rowById(getAllByRole('treeitem'), 'x'), liById(container, 'f'), 21)
    expect(h.onReorder).toHaveBeenCalledWith('x', 'f', 'below')
  })

  it('the middle band falls back to above/below when the target cannot contain the type', () => {
    // a mock owns only text — a sticky dropped on its middle lands next to it.
    const els = [el({ id: 's', type: 'sticky', name: 'S' }), el({ id: 'm', type: 'mock' })]
    const { container, getAllByRole, h } = renderPanel(els)
    dragTo(rowById(getAllByRole('treeitem'), 's'), liById(container, 'm'), 12)
    expect(h.onReorder).toHaveBeenCalledWith('s', 'm', 'below')
  })

  it('rows inside the dragged subtree are never drop targets', () => {
    const els = [el({ id: 'f', type: 'frame' }), el({ id: 'c', type: 'sticky', parentId: 'f' })]
    const { container, getAllByRole, h } = renderPanel(els)
    dragTo(rowById(getAllByRole('treeitem'), 'f'), liById(container, 'c'), 12)
    expect(h.onReorder).not.toHaveBeenCalled()
  })
})

describe('LayersPanel — search', () => {
  it('filters to matches + their ancestors, auto-expanded', () => {
    const { getByPlaceholderText, getAllByRole, queryByTitle } = renderPanel(grouped())
    fireEvent.change(getByPlaceholderText('canvas.searchLayers'), { target: { value: 'A' } })
    const rows = getAllByRole('treeitem')
    expect(rows.map((r) => r.getAttribute('data-layer-row'))).toEqual(['g', 'a'])
    expect(rowById(rows, 'g').getAttribute('aria-expanded')).toBe('true')
    // the twisty is hidden while the filter owns the expansion
    expect(queryByTitle('canvas.collapse')).toBeNull()
  })

  it('shows the no-match hint', () => {
    const { getByPlaceholderText, getByText } = renderPanel(grouped())
    fireEvent.change(getByPlaceholderText('canvas.searchLayers'), { target: { value: 'zzz' } })
    expect(getByText('canvas.noSearchResults')).toBeTruthy()
  })

  it('Esc clears the query', () => {
    const { getByPlaceholderText, getAllByRole } = renderPanel(grouped())
    const input = getByPlaceholderText('canvas.searchLayers')
    fireEvent.change(input, { target: { value: 'A' } })
    expect(getAllByRole('treeitem')).toHaveLength(2)
    fireEvent.keyDown(input, { key: 'Escape', isComposing: false })
    expect(getAllByRole('treeitem')).toHaveLength(4)
  })

  it('dragging is disabled while a query is active (click still selects)', () => {
    const { container, getByPlaceholderText, getAllByRole, h } = renderPanel(grouped())
    // 'sticky' matches note/a/b by TYPE, keeping multiple rows visible.
    fireEvent.change(getByPlaceholderText('canvas.searchLayers'), {
      target: { value: 'sticky' },
    })
    const note = rowById(getAllByRole('treeitem'), 'note')
    dragTo(note, container.querySelector('[data-layer-id="b"]') as HTMLElement, 12)
    expect(h.onReorder).not.toHaveBeenCalled()
    expect(h.onSelect).toHaveBeenCalledWith('note', false) // release = click
  })
})

describe('LayersPanel — reveal + hover sync', () => {
  it('a canvas-side selection expands its ancestors and scrolls the row into view', () => {
    const r = renderPanel(grouped())
    fireEvent.click(r.getByTitle('canvas.collapse')) // collapse 'g'
    expect(r.getAllByRole('treeitem')).toHaveLength(2)
    r.rerenderWith({ selectedIds: ['a'] })
    // ancestor auto-expanded so the selected row is visible again
    expect(r.getAllByRole('treeitem')).toHaveLength(4)
    expect(scrollSpy).toHaveBeenCalled()
  })

  it('row hover reports the element to onHoverElement; leave reports null', () => {
    const onHoverElement = vi.fn()
    const { getAllByRole } = renderPanel(grouped(), [], { onHoverElement })
    const note = rowById(getAllByRole('treeitem'), 'note')
    fireEvent.pointerOver(note)
    expect(onHoverElement).toHaveBeenCalledWith('note')
    fireEvent.pointerOut(note)
    expect(onHoverElement).toHaveBeenCalledWith(null)
  })

  it('hoveredElementId highlights the matching row', () => {
    const { getAllByRole } = renderPanel(grouped(), [], { hoveredElementId: 'note' })
    expect(rowById(getAllByRole('treeitem'), 'note').classList.contains('bg-bg-inset')).toBe(
      true,
    )
  })
})
