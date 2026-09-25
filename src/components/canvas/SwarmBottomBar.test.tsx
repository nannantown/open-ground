// @vitest-environment jsdom
//
// The Swarm bottom bar (owner decision 2026-09-24): folded by default, opens
// upward, and its height is dragged and remembered PER PROJECT.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ProjectMeta } from '@/lib/types'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {}, toggleLang: () => {} }),
}))
// The bar's own job is fold / height; SwarmModule's folded rendering is pinned
// in SwarmModule.seats.test.tsx.
vi.mock('@/components/canvas/modules/SwarmModule', () => ({
  SwarmModule: ({ collapsed, onToggleCollapsed }: { collapsed: boolean; onToggleCollapsed: () => void }) => (
    <button type="button" onClick={onToggleCollapsed}>
      {collapsed ? 'folded' : 'open'}
    </button>
  ),
}))

import { SwarmBottomBar, SWARM_BAR_DEFAULT_H, swarmBarKey } from './SwarmBottomBar'

const project = (id: string) => ({ id, name: id, path: `/tmp/${id}` }) as ProjectMeta
const bar = () => screen.getByTestId('swarm-bottom-bar')

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('SwarmBottomBar', () => {
  it('starts folded — one strip, no height, no drag handle', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    expect(screen.getByText('folded')).toBeTruthy()
    expect(bar().style.height).toBe('')
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('opens upward to the height saved for THIS project', () => {
    localStorage.setItem(swarmBarKey('p1'), JSON.stringify({ h: 420 }))
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(screen.getByText('folded'))
    expect(screen.getByText('open')).toBeTruthy()
    expect(bar().style.height).toBe('420px')
    cleanup()
    render(<SwarmBottomBar project={project('p2')} />)
    fireEvent.click(screen.getByText('folded'))
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H}px`)
  })

  it('a drag on the top edge resizes and is saved for next time', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(screen.getByText('folded'))
    const handle = screen.getByRole('separator')
    handle.setPointerCapture = () => {}
    handle.hasPointerCapture = () => false
    // jsdom has no layout: offsetHeight is 0, so the drag starts from state.
    Object.defineProperty(bar(), 'offsetHeight', { configurable: true, get: () => parseInt(bar().style.height, 10) })
    fireEvent.pointerDown(handle, { button: 0, clientY: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 400, pointerId: 1, buttons: 1 })
    fireEvent.pointerUp(handle, { clientY: 400, pointerId: 1 })
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 100}px`)
    expect(JSON.parse(localStorage.getItem(swarmBarKey('p1'))!)).toEqual({ h: SWARM_BAR_DEFAULT_H + 100, open: true })
    // After the drag, merely hovering the handle must not resize.
    fireEvent.pointerMove(handle, { clientY: 200, pointerId: 1, buttons: 0 })
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 100}px`)
  })

  it('a drag whose button-up was never heard ends on the next buttonless move', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(screen.getByText('folded'))
    const handle = screen.getByRole('separator')
    handle.setPointerCapture = () => {}
    handle.hasPointerCapture = () => false
    Object.defineProperty(bar(), 'offsetHeight', { configurable: true, get: () => parseInt(bar().style.height, 10) })
    fireEvent.pointerDown(handle, { button: 0, clientY: 500, pointerId: 1 })
    fireEvent.pointerMove(handle, { clientY: 450, pointerId: 1, buttons: 1 })
    // No pointerup: the capture was lost. The next move has no button held.
    fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1, buttons: 0 })
    fireEvent.pointerMove(handle, { clientY: 50, pointerId: 1, buttons: 0 })
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 50}px`)
  })

  it('the keyboard can resize it too, and never below the floor', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(screen.getByText('folded'))
    const handle = screen.getByRole('separator')
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 24}px`)
    for (let i = 0; i < 40; i++) fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(parseInt(bar().style.height, 10)).toBeGreaterThanOrEqual(180)
    expect(JSON.parse(localStorage.getItem(swarmBarKey('p1'))!).h).toBe(parseInt(bar().style.height, 10))
  })

  it('remembers open / folded per project across a re-entry (owner decision 2026-09-25)', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(screen.getByText('folded'))
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
    // Back to Ground (unmount), then into the same project again.
    cleanup()
    render(<SwarmBottomBar project={project('p1')} />)
    expect(screen.getByText('open')).toBeTruthy()
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 24}px`)
    // Another project, never opened, still starts folded.
    cleanup()
    render(<SwarmBottomBar project={project('p2')} />)
    expect(screen.getByText('folded')).toBeTruthy()
    // Fold p1, leave, come back: folded, and its height is kept.
    cleanup()
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(screen.getByText('open'))
    cleanup()
    render(<SwarmBottomBar project={project('p1')} />)
    expect(screen.getByText('folded')).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(swarmBarKey('p1'))!)).toEqual({ h: SWARM_BAR_DEFAULT_H + 24, open: false })
  })

  it('folding again keeps the height for the next open', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(screen.getByText('folded'))
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
    fireEvent.click(screen.getByText('open'))
    expect(bar().style.height).toBe('')
    fireEvent.click(screen.getByText('folded'))
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 24}px`)
  })
})

// 差し戻し 2026-09-24 (must-fix 2): the folded strip said 「判断待ち 4」-style
// counts of Swarm questions while the Board's blocked column is ALSO titled
// 「判断待ち」 and counts something else — the owner saw "4 waiting" and
// "nothing waiting" at once. No count on the strip may reuse a Board column
// name, in either language.
describe('the strip never borrows a Board column name', () => {
  it('questions / reviews wording differs from every board.col.* label', async () => {
    const { messages } = await vi.importActual<typeof import('@/i18n/messages')>('@/i18n/messages')
    for (const lang of ['en', 'ja'] as const) {
      const m = messages[lang]
      const columns = Object.entries(m)
        .filter(([k]) => /^board\.col\.[a-z]+$/.test(k))
        .map(([, v]) => v.toLowerCase())
      expect(columns.length).toBeGreaterThan(3)
      for (const key of ['projectPanel.swarm.bar.questions', 'projectPanel.swarm.bar.reviews']) {
        const words = m[key].replace('{count}', '').trim().toLowerCase()
        for (const col of columns) expect(words.includes(col) || col.includes(words), `${lang} ${key} vs ${col}`).toBe(false)
      }
    }
  })
})

// 差し戻し 2026-09-24 (must-fix 3): no negative-margin hack in the bar's
// layout — alignment comes from padding (CLAUDE global rule).
describe('no negative margins in the bar', () => {
  it('SwarmBottomBar and SwarmModule carry no -m* utility', async () => {
    const fs = await import('node:fs')
    for (const f of ['src/components/canvas/SwarmBottomBar.tsx', 'src/components/canvas/modules/SwarmModule.tsx']) {
      const src = fs.readFileSync(f, 'utf8')
      expect(src.match(/[\s'"`]-m[trblxyse]?-[\w.[\]]+/g) ?? [], f).toEqual([])
    }
  })
})
