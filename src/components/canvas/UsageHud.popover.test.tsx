// @vitest-environment jsdom
//
// ⚠ THE BUG THIS PINS (owner, 2026-09-13). In the project detail screen the
// usage popover ("残りのトークン数などを見ようとすると、見切れてしまいます") was cut
// off. It opened as `absolute … z-30` INSIDE the project panel, and the Board's
// supply dock (BoardSupplyDock, also z-30 and later in the DOM) painted over it,
// so everything below the dock's top edge was invisible.
//
// The project panel is ONE stacking context, so no z-index inside it could have
// won. The fix is to LEAVE it: a body portal at z-overlay-modal (the scale is
// documented in tailwind.config.ts), plus a viewport-clamped max-height so the
// 7-day breakdown ends in a scroll rather than off the bottom of the screen.
//
// These assertions are deliberately about WHERE the node lives and WHAT it is
// allowed to be, not "it renders": a popover rendered in the wrong parent looks
// perfectly fine in a test that only queries by text.
//
// MUTATIONS that turn this red: put the popover back inside the trigger's
// subtree (drop the portal); drop z-overlay-modal / `fixed`; drop the maxHeight
// clamp; drop the popRef arm of the outside-click check (the popover then closes
// on its own first click).
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({
    t: (k: string, vars?: Record<string, string | number>) =>
      vars ? `${k} ${Object.entries(vars).map(([n, v]) => `${n}=${v}`).join(' ')}` : k,
    lang: 'en',
    setLang: () => {},
    toggleLang: () => {},
  }),
}))

import { UsageHud } from './UsageHud'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const USAGE = {
  windowHours: 5,
  windowStart: null,
  nextResetAt: null,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1000 },
  messageCount: 0,
  byModel: {},
  currentModel: 'claude-fable-5-1',
  cli: {
    session: { pct: 23, resetsAt: '3:50 pm' },
    weekAll: { pct: 25, resetsAt: '1:00 pm (Mon)' },
    capturedAt: '2026-09-13T00:00:00.000Z',
    status: 'ok',
  },
}

const installFetch = () =>
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      const body = url.includes('/api/usage/breakdown')
        ? { days: 7, total: 0, scannedAt: null, rows: [] }
        : USAGE
      return { ok: true, json: async () => body } as unknown as Response
    }),
  )

/** Open the popover and hand back the trigger + the popover node. */
const openPopover = async () => {
  installFetch()
  const { container } = render(<UsageHud />)
  const trigger = await waitFor(() => {
    const b = container.querySelector('button')
    if (!b) throw new Error('no trigger')
    return b
  })
  fireEvent.click(trigger)
  // The heading only exists inside the popover.
  const heading = await screen.findByText('misc.usage.heading')
  const popover = heading.closest('div[style]')
  if (!popover) throw new Error('popover element not found')
  return { container, trigger, popover: popover as HTMLElement }
}

describe('UsageHud popover — it must escape the project panel, not sit inside it', () => {
  it('is portaled OUT of the trigger\'s subtree (so no sibling can paint over it)', async () => {
    const { container, popover } = await openPopover()
    // The crux. Inside `container` it is inside the project panel's stacking
    // context, where BoardSupplyDock covered it; outside, it cannot be.
    expect(container.contains(popover)).toBe(false)
    expect(document.body.contains(popover)).toBe(true)
  })

  it('is positioned FIXED at the app-modal layer, not absolute at a local z', async () => {
    const { popover } = await openPopover()
    const cls = popover.className
    expect(cls).toContain('fixed')
    expect(cls).toContain('z-overlay-modal')
    // The exact spellings that lost to the dock.
    expect(cls).not.toContain('absolute')
    expect(cls).not.toMatch(/(^|\s)z-30(\s|$)/)
  })

  it('is capped to the viewport and scrolls inside — the "cut off" itself', async () => {
    const { popover } = await openPopover()
    // A concrete pixel budget, not just "has some max-height": the popover's
    // bottom must land inside the window.
    const top = parseFloat(popover.style.top)
    const maxHeight = parseFloat(popover.style.maxHeight)
    expect(Number.isFinite(top)).toBe(true)
    expect(Number.isFinite(maxHeight)).toBe(true)
    expect(top + maxHeight).toBeLessThanOrEqual(window.innerHeight)
    expect(popover.className).toContain('overflow-y-auto')
    // Right-aligned via `right`, so it cannot spill past the right edge.
    expect(parseFloat(popover.style.right)).toBeGreaterThanOrEqual(0)
  })

  it('a click INSIDE the portaled popover does not dismiss it', async () => {
    // The regression a portal introduces: the outside-click check used to test
    // only the trigger's subtree, which the popover has now left — so its own
    // first click would read as "outside" and close it.
    const { popover } = await openPopover()
    fireEvent.mouseDown(popover)
    expect(screen.queryByText('misc.usage.heading')).not.toBeNull()
    // …while a click on the page really does close it.
    fireEvent.mouseDown(document.body)
    await waitFor(() => expect(screen.queryByText('misc.usage.heading')).toBeNull())
  })

  it('closes on Escape, and leaves nothing behind in the body', async () => {
    const { popover } = await openPopover()
    expect(document.body.contains(popover)).toBe(true)
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    fireEvent(document, escape)
    await waitFor(() => expect(screen.queryByText('misc.usage.heading')).toBeNull())
    expect(document.body.contains(popover)).toBe(false)
    expect(escape.defaultPrevented).toBe(true)
  })

  it('does not dismiss during IME composition', async () => {
    const { popover } = await openPopover()
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true })
    expect(document.body.contains(popover)).toBe(true)
  })
})
