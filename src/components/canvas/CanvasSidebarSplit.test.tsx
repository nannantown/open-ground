// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k }) }))

import {
  CanvasSidebarSplit,
  canvasSidebarKey,
  loadCanvasSidebar,
  PAGES_MIN_H,
  SPLIT_DEFAULT,
} from './CanvasSidebarSplit'

const P = '/tmp/proj-a'

const mount = (path = P) =>
  render(
    <CanvasSidebarSplit
      projectPath={path}
      layersHostRef={() => {}}
      pages={(collapsed, onToggle) => (
        <button type="button" aria-expanded={!collapsed} onClick={onToggle}>
          pages-toggle
        </button>
      )}
    />,
  )

// jsdom has no layout: give the sidebar and the Pages slot real heights.
const sizeOf = (el: Element, h: number) =>
  Object.defineProperty(el, el.getAttribute('data-testid') ? 'offsetHeight' : 'clientHeight', {
    configurable: true,
    value: h,
  })

beforeEach(() => localStorage.clear())

describe('CanvasSidebarSplit', () => {
  it('Layers folds from its header chevron, and Pages then takes the full height', () => {
    const r = mount()
    const layers = r.getByText('canvas.layers').closest('button')!
    const slot = r.getByTestId('canvas-pages-slot')
    expect(r.getByRole('separator')).toBeTruthy()
    expect(slot.style.flex).toBe(`0 1 ${SPLIT_DEFAULT * 100}%`)
    fireEvent.click(layers)
    expect(layers.getAttribute('aria-expanded')).toBe('false')
    expect(r.queryByRole('separator')).toBeNull()
    expect(slot.className).toContain('flex-1')
    expect(slot.style.flex).toBe('')
  })

  it('folding Pages hands the height to Layers and removes the drag border', () => {
    const r = mount()
    fireEvent.click(r.getByText('pages-toggle'))
    expect(r.queryByRole('separator')).toBeNull()
    expect(r.getByTestId('canvas-pages-slot').className).toContain('shrink-0')
  })

  it('dragging the border changes the split, clamped to the minimum, and it is saved', () => {
    const r = mount()
    const sep = r.getByRole('separator')
    sizeOf(sep.parentElement!, 1000)
    sizeOf(r.getByTestId('canvas-pages-slot'), 300)
    fireEvent.pointerDown(sep, { button: 0, clientY: 300, pointerId: 1 })
    fireEvent.pointerMove(sep, { buttons: 1, clientY: 500, pointerId: 1 })
    fireEvent.pointerUp(sep, { clientY: 500, pointerId: 1 })
    expect(r.getByTestId('canvas-pages-slot').style.flex).toBe('0 1 50%')
    expect(loadCanvasSidebar(P).split).toBe(0.5)
    fireEvent.pointerDown(sep, { button: 0, clientY: 500, pointerId: 1 })
    fireEvent.pointerMove(sep, { buttons: 1, clientY: -900, pointerId: 1 })
    fireEvent.pointerUp(sep, { pointerId: 1 })
    expect(loadCanvasSidebar(P).split).toBe(PAGES_MIN_H / 1000)
  })

  it('fold state and split come back on the next mount, per project', () => {
    localStorage.setItem(canvasSidebarKey(P), JSON.stringify({ split: 0.6, pagesOpen: true, layersOpen: false }))
    const a = mount()
    expect(a.getByText('canvas.layers').closest('button')!.getAttribute('aria-expanded')).toBe('false')
    a.unmount()
    localStorage.setItem(canvasSidebarKey(P), JSON.stringify({ split: 0.6, pagesOpen: true, layersOpen: true }))
    expect(mount().getByTestId('canvas-pages-slot').style.flex).toBe('0 1 60%')
  })

  it('switching project (same mounted component) shows the new project state and never writes the old one into it', () => {
    const B = '/tmp/proj-b'
    localStorage.setItem(canvasSidebarKey(B), JSON.stringify({ split: 0.6, pagesOpen: true, layersOpen: true }))
    const el = (path: string) => (
      <CanvasSidebarSplit projectPath={path} layersHostRef={() => {}} pages={() => null} />
    )
    const r = render(el(P))
    fireEvent.click(r.getByText('canvas.layers').closest('button')!)
    expect(loadCanvasSidebar(P).layersOpen).toBe(false)
    r.rerender(el(B))
    const layers = r.getByText('canvas.layers').closest('button')!
    expect(layers.getAttribute('aria-expanded')).toBe('true')
    expect(r.getByTestId('canvas-pages-slot').style.flex).toBe('0 1 60%')
    // The first toggle in B writes B's own state, not A's leftovers.
    fireEvent.click(r.getByText('canvas.layers').closest('button')!)
    expect(loadCanvasSidebar(B)).toEqual({ split: 0.6, pagesOpen: true, layersOpen: false })
  })

  it('a toggle writes through so a restart sees it', () => {
    const r = mount()
    fireEvent.click(r.getByText('canvas.layers').closest('button')!)
    expect(loadCanvasSidebar(P).layersOpen).toBe(false)
    expect(loadCanvasSidebar('/tmp/other').layersOpen).toBe(true)
  })
})
