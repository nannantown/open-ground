// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent, within } from '@testing-library/react'
import type { CanvasSummary } from '@/lib/types'

// i18n is mocked to the identity (t(key) → key), matching LayersPanel.test —
// so titles/labels in queries below are the raw 'canvas.*' keys.
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))
// PagesSection now renders the presence strip, which calls useAuth — stub it
// (this suite mounts PagesSection bare, with no AuthProvider, and tests the
// canvas list, not presence).
vi.mock('@/components/canvas/CollabPresence', () => ({
  CollabPresence: () => null,
  usePublishPresence: () => {},
}))

import { PagesSection } from './PagesSection'

const summaries = (...names: string[]): CanvasSummary[] =>
  names.map((name) => ({ id: name.toLowerCase(), name, updatedAt: '2026-06-12T00:00:00Z' }))

const handlers = () => ({
  onSelect: vi.fn(),
  onCreate: vi.fn(),
  onDelete: vi.fn(),
  onRename: vi.fn(),
  onReorder: vi.fn(),
})

const renderPages = (canvases: CanvasSummary[], activeId: string | null = canvases[0]?.id ?? null) => {
  const h = handlers()
  const r = render(<PagesSection canvases={canvases} activeId={activeId} {...h} />)
  return { ...r, h }
}

// HTML5 drag events need a dataTransfer stub in jsdom.
const dt = () => ({ dataTransfer: { effectAllowed: '', dropEffect: '' } })

describe('PagesSection — list + switching', () => {
  it('renders one row per Canvas and marks the active one aria-current="page"', () => {
    const { getAllByRole } = renderPages(summaries('Alpha', 'Beta'), 'beta')
    const items = getAllByRole('listitem')
    expect(items).toHaveLength(2)
    const beta = within(items[1]).getByText('Beta').closest('button')!
    expect(beta.getAttribute('aria-current')).toBe('page')
    const alpha = within(items[0]).getByText('Alpha').closest('button')!
    expect(alpha.getAttribute('aria-current')).toBeNull()
  })

  it('clicking a row selects that Canvas', () => {
    const { getByText, h } = renderPages(summaries('Alpha', 'Beta'), 'alpha')
    fireEvent.click(getByText('Beta'))
    expect(h.onSelect).toHaveBeenCalledWith('beta')
  })

  it('the + button creates a Canvas', () => {
    const { getByTitle, h } = renderPages(summaries('Alpha'))
    fireEvent.click(getByTitle('canvas.newCanvas'))
    expect(h.onCreate).toHaveBeenCalled()
  })

  it('the header toggle collapses and re-expands the list', () => {
    const { getByText, queryAllByRole } = renderPages(summaries('Alpha', 'Beta'))
    const toggle = getByText('canvas.pages').closest('button')!
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(queryAllByRole('listitem')).toHaveLength(0)
    fireEvent.click(toggle)
    expect(queryAllByRole('listitem')).toHaveLength(2)
  })
})

describe('PagesSection — inline rename', () => {
  const openRename = (active: string | null = 'alpha') => {
    const r = renderPages(summaries('Alpha', 'Beta'), active)
    fireEvent.doubleClick(r.getByText('Alpha'))
    const input = r.container.querySelector('input') as HTMLInputElement
    return { ...r, input }
  }

  it('double-click opens an input pre-filled with the current name', () => {
    const { input } = openRename()
    expect(input).toBeTruthy()
    expect(input.value).toBe('Alpha')
  })

  it('Enter commits the trimmed name via onRename', () => {
    const { input, h } = openRename()
    fireEvent.change(input, { target: { value: '  Renamed  ' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: false })
    expect(h.onRename).toHaveBeenCalledWith('alpha', 'Renamed')
  })

  it('Enter DURING IME composition does not commit (guards Japanese input)', () => {
    const { input, h, container } = openRename()
    fireEvent.change(input, { target: { value: '日本語' } })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(h.onRename).not.toHaveBeenCalled()
    expect(container.querySelector('input')).toBeTruthy() // still editing
  })

  it('Escape cancels without renaming', () => {
    const { input, h, container } = openRename()
    fireEvent.change(input, { target: { value: 'nope' } })
    fireEvent.keyDown(input, { key: 'Escape', isComposing: false })
    expect(h.onRename).not.toHaveBeenCalled()
    expect(container.querySelector('input')).toBeNull()
  })

  it('blur commits; an all-whitespace draft is dropped', () => {
    const a = openRename()
    fireEvent.change(a.input, { target: { value: 'ViaBlur' } })
    fireEvent.blur(a.input)
    expect(a.h.onRename).toHaveBeenCalledWith('alpha', 'ViaBlur')
    a.unmount()
    const b = openRename()
    fireEvent.change(b.input, { target: { value: '   ' } })
    fireEvent.keyDown(b.input, { key: 'Enter', isComposing: false })
    expect(b.h.onRename).not.toHaveBeenCalled()
  })
})

describe('PagesSection — delete (confirm, last-page guard)', () => {
  it('✕ arms an inline confirm; only the confirm click deletes', () => {
    const { getAllByTitle, getByText, h } = renderPages(summaries('Alpha', 'Beta'), 'alpha')
    fireEvent.click(getAllByTitle('canvas.deleteCanvas')[1])
    expect(h.onDelete).not.toHaveBeenCalled()
    fireEvent.click(getByText('canvas.deleteConfirm'))
    expect(h.onDelete).toHaveBeenCalledWith('beta')
  })

  it('right-clicking a row arms the same confirm', () => {
    const { getAllByRole, getByText, h } = renderPages(summaries('Alpha', 'Beta'), 'alpha')
    fireEvent.contextMenu(getAllByRole('listitem')[1])
    fireEvent.click(getByText('canvas.deleteConfirm'))
    expect(h.onDelete).toHaveBeenCalledWith('beta')
  })

  it('Escape disarms the confirm', () => {
    const { getAllByTitle, getByText, queryByText, h } = renderPages(
      summaries('Alpha', 'Beta'),
      'alpha',
    )
    fireEvent.click(getAllByTitle('canvas.deleteCanvas')[0])
    fireEvent.keyDown(getByText('canvas.deleteConfirm'), { key: 'Escape' })
    expect(queryByText('canvas.deleteConfirm')).toBeNull()
    expect(h.onDelete).not.toHaveBeenCalled()
  })

  it('the last remaining Canvas offers no delete control at all', () => {
    const { queryByTitle, getAllByRole, queryByText } = renderPages(summaries('Only'))
    expect(queryByTitle('canvas.deleteCanvas')).toBeNull()
    // Right-click must not arm a confirm either.
    fireEvent.contextMenu(getAllByRole('listitem')[0])
    expect(queryByText('canvas.deleteConfirm')).toBeNull()
  })
})

describe('PagesSection — drag reorder', () => {
  it('dropping a dragged row onto another emits the spliced order', () => {
    const { getAllByRole, h } = renderPages(summaries('A', 'B', 'C'), 'a')
    const rows = getAllByRole('listitem')
    fireEvent.dragStart(rows[0], dt())
    fireEvent.dragOver(rows[2], dt())
    fireEvent.drop(rows[2], dt())
    expect(h.onReorder).toHaveBeenCalledWith(['b', 'c', 'a'])
  })

  it('dropping a row onto itself reorders nothing', () => {
    const { getAllByRole, h } = renderPages(summaries('A', 'B'), 'a')
    const rows = getAllByRole('listitem')
    fireEvent.dragStart(rows[0], dt())
    fireEvent.drop(rows[0], dt())
    expect(h.onReorder).not.toHaveBeenCalled()
  })
})
