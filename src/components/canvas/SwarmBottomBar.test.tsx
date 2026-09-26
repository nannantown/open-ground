// @vitest-environment jsdom
//
// The Swarm bottom bar (owner decision 2026-09-24): folded by default, opens
// upward, and its height is dragged and remembered PER PROJECT. Since
// 2026-09-26 the WHOLE header row is the handle: a press that moves less than
// SWARM_BAR_DRAG_SLOP px opens / folds, past it the press is a drag that
// resizes (and the click after it is swallowed); presses on the controls
// inside the row (the on/off switch) neither toggle nor drag.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import type { ProjectMeta } from '@/lib/types'
import type { SwarmBarHandle } from './SwarmBottomBar'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {}, toggleLang: () => {} }),
}))
// The bar's own job is fold / height. SwarmModule's header row is modelled the
// way SwarmModule wires it: barHandle spread on the row, the row's click
// toggles unless it landed on a control, the named toggle button inside.
vi.mock('@/components/canvas/modules/SwarmModule', () => ({
  SwarmModule: ({
    collapsed,
    onToggleCollapsed,
    barHandle,
  }: {
    collapsed: boolean
    onToggleCollapsed: () => void
    barHandle: SwarmBarHandle
  }) => (
    <div
      data-testid="hdr"
      {...barHandle}
      onClick={(e) => {
        if ((e.target as Element).closest('[role="switch"]')) return
        onToggleCollapsed()
      }}
    >
      <button type="button" data-testid="swarm-bar-toggle">
        {collapsed ? 'folded' : 'open'}
      </button>
      <button type="button" role="switch" aria-checked={false}>
        power
      </button>
    </div>
  ),
}))

import { SwarmBottomBar, SWARM_BAR_DEFAULT_H, SWARM_BAR_DRAG_SLOP, swarmBarKey } from './SwarmBottomBar'

const project = (id: string) => ({ id, name: id, path: `/tmp/${id}` }) as ProjectMeta
const bar = () => screen.getByTestId('swarm-bottom-bar')
const hdr = () => screen.getByTestId('hdr')
const toggle = () => screen.getByTestId('swarm-bar-toggle')
const saved = (id = 'p1') => JSON.parse(localStorage.getItem(swarmBarKey(id)) ?? 'null')
const press = (el: Element, y: number) => fireEvent.pointerDown(el, { button: 0, clientY: y, pointerId: 1 })
const move = (el: Element, y: number, buttons = 1) => fireEvent.pointerMove(el, { clientY: y, pointerId: 1, buttons })
const release = (el: Element, y: number) => fireEvent.pointerUp(el, { clientY: y, pointerId: 1 })
/** A whole gesture the way a browser sends it: down, moves, up, then click. */
const gesture = (el: Element, from: number, to: number) => {
  press(el, from)
  move(el, (from + to) / 2)
  move(el, to)
  release(el, to)
  fireEvent.click(el)
}
const nextTick = () => new Promise((r) => setTimeout(r, 0))

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('SwarmBottomBar', () => {
  it('starts folded — one strip, no height, no separate drag strip', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    expect(screen.getByText('folded')).toBeTruthy()
    expect(bar().style.height).toBe('')
    expect(screen.queryByRole('separator')).toBeNull()
  })

  it('opens upward to the height saved for THIS project', () => {
    localStorage.setItem(swarmBarKey('p1'), JSON.stringify({ h: 420 }))
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(toggle())
    expect(screen.getByText('open')).toBeTruthy()
    expect(bar().style.height).toBe('420px')
    cleanup()
    render(<SwarmBottomBar project={project('p2')} />)
    fireEvent.click(toggle())
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H}px`)
  })

  it('a press that moves less than the slop is a click: it opens, and folds again', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    const jitter = SWARM_BAR_DRAG_SLOP - 1
    gesture(toggle(), 500, 500 - jitter)
    expect(screen.getByText('open')).toBeTruthy()
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H}px`)
    gesture(hdr(), 500, 500 + jitter)
    expect(screen.getByText('folded')).toBeTruthy()
    expect(saved()).toEqual({ open: false })
  })

  it('dragging anywhere on the open row resizes, is saved, and the click after it does not fold', async () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(toggle())
    gesture(toggle(), 500, 400)
    expect(screen.getByText('open')).toBeTruthy()
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 100}px`)
    expect(saved()).toEqual({ h: SWARM_BAR_DEFAULT_H + 100, open: true })
    // After the drag, merely hovering the row must not resize.
    move(hdr(), 200, 0)
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 100}px`)
    // …and the next plain press is a click again.
    await nextTick()
    fireEvent.click(toggle())
    expect(screen.getByText('folded')).toBeTruthy()
  })

  it('dragging the folded row upward opens it at the dragged height', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    // jsdom has no layout: the folded row measures 0 px tall.
    gesture(hdr(), 600, 300)
    expect(screen.getByText('open')).toBeTruthy()
    expect(bar().style.height).toBe('300px')
    expect(saved()).toEqual({ h: 300, open: true })
  })

  it('dragging the open bar down past half the floor folds it and keeps its height', async () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(toggle())
    gesture(hdr(), 100, 100 + SWARM_BAR_DEFAULT_H - 40)
    expect(screen.getByText('folded')).toBeTruthy()
    expect(saved()).toEqual({ open: false })
    await nextTick()
    fireEvent.click(toggle())
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H}px`)
  })

  it('a press on a control inside the row (the on/off switch) neither drags nor toggles', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    gesture(screen.getByRole('switch'), 600, 200)
    expect(screen.getByText('folded')).toBeTruthy()
    expect(bar().style.height).toBe('')
    expect(saved()).toBeNull()
  })

  it('a drag whose button-up was never heard ends on the next buttonless move', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(toggle())
    press(hdr(), 500)
    move(hdr(), 450)
    // No pointerup: the capture was lost. The next move has no button held.
    move(hdr(), 100, 0)
    move(hdr(), 50, 0)
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 50}px`)
    expect(saved().h).toBe(SWARM_BAR_DEFAULT_H + 50)
  })

  it('the keyboard can resize it too (arrows on the toggle), and never below the floor', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(toggle())
    fireEvent.keyDown(toggle(), { key: 'ArrowUp' })
    expect(bar().style.height).toBe(`${SWARM_BAR_DEFAULT_H + 24}px`)
    for (let i = 0; i < 40; i++) fireEvent.keyDown(toggle(), { key: 'ArrowDown' })
    expect(parseInt(bar().style.height, 10)).toBeGreaterThanOrEqual(180)
    expect(saved().h).toBe(parseInt(bar().style.height, 10))
  })

  it('remembers open / folded per project across a re-entry (owner decision 2026-09-25)', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(toggle())
    fireEvent.keyDown(toggle(), { key: 'ArrowUp' })
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
    fireEvent.click(toggle())
    cleanup()
    render(<SwarmBottomBar project={project('p1')} />)
    expect(screen.getByText('folded')).toBeTruthy()
    expect(saved()).toEqual({ h: SWARM_BAR_DEFAULT_H + 24, open: false })
  })

  it('folding again keeps the height for the next open', () => {
    render(<SwarmBottomBar project={project('p1')} />)
    fireEvent.click(toggle())
    fireEvent.keyDown(toggle(), { key: 'ArrowUp' })
    fireEvent.click(toggle())
    expect(bar().style.height).toBe('')
    fireEvent.click(toggle())
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

describe('SwarmBottomBar — looking at the president seat clears the Ground marks (2026-09-26)', () => {
  const seenCalls = (f: ReturnType<typeof vi.fn>) =>
    f.mock.calls.filter((c) => String(c[0]).includes('/api/ground/seen'))

  it('folded never stamps; opening stamps; folding again stamps once more', () => {
    const f = vi.fn(() => Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', f)
    try {
      render(<SwarmBottomBar project={project('p1')} />)
      expect(seenCalls(f)).toHaveLength(0)
      fireEvent.click(toggle())
      expect(seenCalls(f)).toHaveLength(1)
      expect(JSON.parse(String((seenCalls(f)[0][1] as RequestInit).body))).toEqual({ path: '/tmp/p1' })
      fireEvent.click(toggle())
      expect(seenCalls(f)).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('opening by dragging the folded row up stamps once, not once per move', () => {
    const f = vi.fn(() => Promise.resolve(new Response('{}')))
    vi.stubGlobal('fetch', f)
    try {
      render(<SwarmBottomBar project={project('p1')} />)
      press(hdr(), 600)
      for (let y = 590; y >= 250; y -= 20) move(hdr(), y)
      release(hdr(), 250)
      fireEvent.click(hdr())
      expect(screen.getByText('open')).toBeTruthy()
      expect(seenCalls(f)).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
