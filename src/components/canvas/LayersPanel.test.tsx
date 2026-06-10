// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import type { CanvasElement } from '@/lib/types'

// i18n is mocked to the identity (t(key) → key), matching NewProjectModal.test —
// so titles/labels in queries below are the raw 'canvas.*' keys.
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import { LayersPanel } from './LayersPanel'

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
  onClose: vi.fn(),
})

// A group 'g' owning 'a' + 'b', plus a top-level note. Array is back→front; the
// panel renders front-at-top so order is: g, b, a, note.
const grouped = (): CanvasElement[] => [
  el({ id: 'note', type: 'sticky', name: 'Note' }),
  el({ id: 'g', type: 'group', name: 'Group' }),
  el({ id: 'a', type: 'sticky', name: 'A', parentId: 'g' }),
  el({ id: 'b', type: 'sticky', name: 'B', parentId: 'g' }),
]

beforeEach(() => {
  // jsdom doesn't implement pointer capture; stub so onRowPointerDown's call is a no-op.
  if (!(Element.prototype as { setPointerCapture?: unknown }).setPointerCapture) {
    Element.prototype.setPointerCapture = () => {}
    Element.prototype.releasePointerCapture = () => {}
  }
})

const renderPanel = (els: CanvasElement[], selectedIds: string[] = []) => {
  const h = handlers()
  const r = render(<LayersPanel elements={els} selectedIds={selectedIds} {...h} />)
  return { ...r, h }
}

describe('LayersPanel — tree + expand/collapse', () => {
  it('lists every element as a treeitem, nesting children under an expanded group', () => {
    const { getAllByRole } = renderPanel(grouped())
    const rows = getAllByRole('treeitem')
    expect(rows).toHaveLength(4)
    // The group row exposes aria-expanded; leaves don't.
    const groupRow = rows.find((r) => r.getAttribute('data-layer-row') === 'g')!
    expect(groupRow.getAttribute('aria-expanded')).toBe('true')
    expect(groupRow.getAttribute('role')).toBe('treeitem')
  })

  it('collapsing a group hides its children', () => {
    const { getByTitle, getAllByRole } = renderPanel(grouped())
    // Only the group row has a twisty (title = collapse when expanded).
    fireEvent.click(getByTitle('canvas.collapse'))
    const rows = getAllByRole('treeitem')
    expect(rows).toHaveLength(2) // group + note; a/b hidden
    const groupRow = rows.find((r) => r.getAttribute('data-layer-row') === 'g')!
    expect(groupRow.getAttribute('aria-expanded')).toBe('false')
  })

  it('shows the empty state when there are no elements', () => {
    const { getByText } = renderPanel([])
    expect(getByText('canvas.noElementsYet')).toBeTruthy()
  })
})

describe('LayersPanel — keyboard a11y', () => {
  const rowById = (rows: HTMLElement[], id: string) =>
    rows.find((r) => r.getAttribute('data-layer-row') === id)!

  it('Enter on a focused row selects it', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    const note = rowById(getAllByRole('treeitem'), 'note')
    fireEvent.keyDown(note, { key: 'Enter' })
    expect(h.onSelect).toHaveBeenCalledWith('note', false)
  })

  it('Enter with a modifier selects additively', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    const note = rowById(getAllByRole('treeitem'), 'note')
    fireEvent.keyDown(note, { key: 'Enter', shiftKey: true })
    expect(h.onSelect).toHaveBeenCalledWith('note', true)
  })

  it('Alt+ArrowDown reorders a middle row down; Alt+ArrowUp on the front row is a no-op', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    const rows = getAllByRole('treeitem')
    // rows[0] is front-most (atFront) → Alt+ArrowUp must NOT move.
    fireEvent.keyDown(rows[0], { key: 'ArrowUp', altKey: true })
    expect(h.onMove).not.toHaveBeenCalled()
    // rows[1] is neither front nor back → Alt+ArrowDown moves it down.
    const midId = rows[1].getAttribute('data-layer-row')!
    fireEvent.keyDown(rows[1], { key: 'ArrowDown', altKey: true })
    expect(h.onMove).toHaveBeenCalledWith(midId, 'down')
  })

  it('F2 opens an inline rename input', () => {
    const { getAllByRole, container } = renderPanel(grouped())
    const note = rowById(getAllByRole('treeitem'), 'note')
    fireEvent.keyDown(note, { key: 'F2' })
    expect(container.querySelector('input')).toBeTruthy()
  })
})

describe('LayersPanel — inline rename', () => {
  const openRename = (els: CanvasElement[]) => {
    const r = renderPanel(els)
    const note = r.getAllByRole('treeitem').find((x) => x.getAttribute('data-layer-row') === 'note')!
    fireEvent.keyDown(note, { key: 'F2' })
    const input = r.container.querySelector('input') as HTMLInputElement
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
    expect(container.querySelector('input')).toBeNull() // input closed
  })
})

describe('LayersPanel — row controls', () => {
  const rowById = (rows: HTMLElement[], id: string) =>
    rows.find((r) => r.getAttribute('data-layer-row') === id)!

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

  it('the up/down z-order buttons call onMove', () => {
    const { getAllByRole, h } = renderPanel(grouped())
    const rows = getAllByRole('treeitem')
    // a middle row has both controls enabled
    const mid = rows[1]
    const midId = mid.getAttribute('data-layer-row')!
    fireEvent.click(within(mid).getByTitle('canvas.bringForward'))
    expect(h.onMove).toHaveBeenCalledWith(midId, 'up')
    fireEvent.click(within(mid).getByTitle('canvas.sendBackward'))
    expect(h.onMove).toHaveBeenCalledWith(midId, 'down')
  })
})
