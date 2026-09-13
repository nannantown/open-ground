import { describe, it, expect } from 'vitest'
import {
  anchoredPopoverBox,
  POPOVER_GAP,
  POPOVER_MARGIN,
  POPOVER_MIN_HEIGHT,
} from './anchoredPopover'

// The placement half of the 2026-09-13 "残りのトークン数が見切れる" report. The
// other half is escaping the project panel's stacking context (a body portal —
// guarded in UsageHud.popover.test.tsx); this is the geometry, which is where a
// popover can still be cut off even when it paints on top of everything.

const VIEW = { width: 1440, height: 900 }

describe('anchoredPopoverBox', () => {
  it('opens just below the trigger, right-aligned to it', () => {
    const box = anchoredPopoverBox({ right: 1200, bottom: 60 }, VIEW, { width: 264 })
    expect(box.top).toBe(60 + POPOVER_GAP)
    // right offset = viewport width − trigger's right edge, so the popover's
    // right edge lines up with the trigger's.
    expect(box.right).toBe(1440 - 1200)
  })

  it('never touches the right edge when the trigger is flush against it', () => {
    // A trigger at the very edge (or, through rounding, a hair past it) must not
    // produce a 0 or negative offset — the popover would be clipped by the window.
    expect(anchoredPopoverBox({ right: 1440, bottom: 40 }, VIEW).right).toBe(POPOVER_MARGIN)
    expect(anchoredPopoverBox({ right: 1443, bottom: 40 }, VIEW).right).toBe(POPOVER_MARGIN)
  })

  it('never pushes its LEFT side off screen when the trigger is near the left edge', () => {
    // Right-alignment to a left-side trigger means a huge right offset; without
    // the width clamp the popover's own left edge lands at a negative x.
    const box = anchoredPopoverBox({ right: 100, bottom: 40 }, VIEW, { width: 264 })
    // Its left edge must stay on screen: left = width − right − popoverWidth.
    const leftEdge = VIEW.width - box.right - 264
    expect(leftEdge).toBeGreaterThanOrEqual(0)
    expect(box.right).toBe(VIEW.width - 264 - POPOVER_MARGIN)
  })

  it('caps the height to what is left below the trigger — the cut-off itself', () => {
    // 900 tall viewport, trigger bottom at 700 ⇒ 900 − 706 − 8 = 186px of room.
    // A taller popover must scroll inside that, not run past the bottom.
    const box = anchoredPopoverBox({ right: 1200, bottom: 700 }, VIEW, { width: 264 })
    expect(box.maxHeight).toBe(VIEW.height - (700 + POPOVER_GAP) - POPOVER_MARGIN)
    expect(box.top + box.maxHeight).toBeLessThanOrEqual(VIEW.height)
  })

  it('keeps a usable minimum height on a very short viewport', () => {
    // Collapsing to a 12px sliver would be worse than overflowing: the scroll
    // container keeps every row reachable, an invisible popover does not.
    const box = anchoredPopoverBox({ right: 500, bottom: 380 }, { width: 700, height: 400 })
    expect(box.maxHeight).toBe(POPOVER_MIN_HEIGHT)
  })

  it('accepts a DOMRect as-is (the caller passes getBoundingClientRect())', () => {
    const rect = { x: 900, y: 20, width: 300, height: 40, top: 20, left: 900, right: 1200, bottom: 60 }
    const box = anchoredPopoverBox(rect, VIEW, { width: 264 })
    expect(box).toEqual(anchoredPopoverBox({ right: 1200, bottom: 60 }, VIEW, { width: 264 }))
  })

  it('honours overridden gap / margin / minHeight', () => {
    const box = anchoredPopoverBox({ right: 1200, bottom: 60 }, VIEW, {
      width: 264,
      gap: 20,
      margin: 30,
      minHeight: 500,
    })
    expect(box.top).toBe(80)
    expect(anchoredPopoverBox({ right: 1440, bottom: 60 }, VIEW, { margin: 30 }).right).toBe(30)
    expect(
      anchoredPopoverBox({ right: 500, bottom: 380 }, { width: 700, height: 400 }, { minHeight: 500 })
        .maxHeight,
    ).toBe(500)
  })
})
