// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement, useRef } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import {
  ASSISTANT_DEFAULT_POS,
  ASSISTANT_SIZE,
  assistantClearance,
  publishAssistantSpot,
  useAssistantClearance,
  type ClearanceOptions,
} from './assistantWindow'

// The character floats and the layout never moves for it, so whatever it
// covers makes its own room (owner 2026-11-20: it hid Claude Code's update
// notice and the end of the input box in a terminal). The real layout is
// measured in e2e/assistant-terminal-room.spec.ts; this pins the arithmetic.

const VW = 1280
const VH = 800
const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom }) as DOMRect
/** The character's own square for a spot. */
const charAt = (at: { right: number; bottom: number }) => ({ left: VW - at.right - ASSISTANT_SIZE, top: VH - at.bottom - ASSISTANT_SIZE })

describe('assistantClearance', () => {
  it('makes no room while the character is off screen or elsewhere', () => {
    const pane = box(0, 514, 1208, 800)
    expect(assistantClearance(pane, null, VW, VH)).toBeNull()
    // on the icon rail, right of the pane
    expect(assistantClearance(pane, ASSISTANT_DEFAULT_POS, VW, VH)).toBeNull()
  })

  it('a wide, short pane gives up columns, not rows — and ends 8px short of the character', () => {
    // the president's terminal in the team bar, the character on its corner
    const pane = box(0, 514, 1208, 800)
    const at = { right: 96, bottom: 18 }
    const room = assistantClearance(pane, at, VW, VH, { inset: 8 })
    expect(room).toEqual({ side: 'right', px: 1208 - charAt(at).left + 8 })
    expect(pane.right - room!.px).toBe(charAt(at).left - 8)
  })

  it('a pane the character covers along its bottom edge, far from its right edge, gives up rows', () => {
    const pane = box(0, 86, 1218, 761)
    const at = { right: 1100, bottom: 18 }
    expect(assistantClearance(pane, at, VW, VH, { inset: 8 })).toEqual({ side: 'bottom', px: 761 - charAt(at).top + 8 })
  })

  it('leaves the pane alone when the character only reaches its padding', () => {
    // the Terminal tab at the default spot: 8px into the pane's own 8px padding
    const pane = box(0, 86, 1218, 761)
    expect(assistantClearance(pane, ASSISTANT_DEFAULT_POS, VW, VH, { inset: 8 })).toBeNull()
    expect(assistantClearance(pane, ASSISTANT_DEFAULT_POS, VW, VH)).not.toBeNull()
  })

  it('leaves the pane alone when the character is parked in the middle of it', () => {
    const pane = box(0, 86, 1218, 761)
    expect(assistantClearance(pane, { right: 600, bottom: 350 }, VW, VH, { inset: 8 })).toBeNull()
  })

  // Until 2026-11-26 a fixed side was taken however much it cost, and this test
  // pinned that. With the character on a send box's LEFT end the room was the
  // whole box: the text field went to 0px and the send button slid under the
  // character (commander's review ab3-R1). The intent stays — a row ends in its
  // buttons, so the room comes off its right end — but only while that costs a
  // third of the box at most.
  it('a fixed side is taken while it costs a third of the box at most', () => {
    // a one-line input row, the character on its right end
    const row = box(0, 760, 1280, 800)
    const end = { right: 20, bottom: 18 }
    expect(assistantClearance(row, end, VW, VH, { side: 'right' })).toEqual({ side: 'right', px: 1280 - charAt(end).left + 8 })
    // over its left half: a row that grows lifts its words above the character…
    const half = { right: 700, bottom: 18 }
    expect(assistantClearance(row, half, VW, VH, { side: 'right', grows: true })).toEqual({ side: 'bottom', px: 800 - charAt(half).top + 8 })
    // …and a box that cannot grow makes no room (it would only crush itself)
    expect(assistantClearance(row, half, VW, VH, { side: 'right' })).toBeNull()
    // a floating pair of buttons steps up, whatever share of itself that is
    const pair = box(1197, 709, 1264, 745)
    expect(assistantClearance(pair, ASSISTANT_DEFAULT_POS, VW, VH, { side: 'bottom', grows: true })).toEqual({ side: 'bottom', px: 745 - charAt(ASSISTANT_DEFAULT_POS).top + 8 })
  })

  it("a send box with the character on its LEFT end keeps its text field whole — it lifts instead", () => {
    // review ab3-R1: the president's chat card in a 360px seat, 312×134, and the
    // owner's character dragged to the window's bottom-left corner
    const card = box(24, 650, 336, 784)
    const at = { right: VW - ASSISTANT_SIZE - 4, bottom: 12 }
    expect(assistantClearance(card, at, VW, VH, { side: 'right', grows: true })).toEqual({ side: 'bottom', px: 784 - charAt(at).top + 8 })
  })
})

describe('useAssistantClearance', () => {
  it('re-measures when a box around it scrolls — not for its own content or a neighbour streaming', () => {
    const row = document.createElement('div')
    const box = document.createElement('div')
    const content = document.createElement('div')
    const neighbour = document.createElement('div')
    box.append(content)
    row.append(box, neighbour)
    document.body.append(row)
    let measured = 0
    box.getBoundingClientRect = () => {
      measured++
      return box.ownerDocument.body.getBoundingClientRect()
    }
    act(() => publishAssistantSpot(ASSISTANT_DEFAULT_POS))
    const { unmount } = renderHook(() => useAssistantClearance({ current: box }))
    const before = measured
    // (scroll does not bubble: the hook hears it on the way down)
    act(() => [content, neighbour, box].forEach((el) => el.dispatchEvent(new Event('scroll'))))
    expect(measured).toBe(before)
    act(() => row.dispatchEvent(new Event('scroll')))
    expect(measured).toBe(before + 1)
    unmount()
    act(() => publishAssistantSpot(null))
    row.remove()
  })
})

// A box as big as what is in it grows with the room it is given. Measured WITH
// that room, the character stays inside the grown box as it is dragged, and
// the room keeps growing (commander 2026-11-24, the Canvas undo/redo pair:
// char.top 732 → pad 21, 432 → 321, 152 → 601 — carried over the zoom readout
// and off the canvas; a fresh mount at the same spot → no room).
describe('useAssistantClearance — a box that grows with its room', () => {
  afterEach(() => {
    cleanup()
    act(() => publishAssistantSpot(null))
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  const Box = ({ o }: { o: ClearanceOptions }) => {
    const ref = useRef<HTMLDivElement>(null)
    return createElement('div', { ref, style: useAssistantClearance(ref, o) })
  }
  /** Lay every box out with `geometry`, which reads the room it was given. */
  const layout = (geometry: (pad: { right: number; bottom: number }) => DOMRect) => {
    vi.stubGlobal('innerWidth', VW)
    vi.stubGlobal('innerHeight', VH)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return geometry({ right: parseFloat(this.style.paddingRight) || 0, bottom: parseFloat(this.style.paddingBottom) || 0 })
    })
  }
  /** The character at the right edge (its spot until dragged), top at `top`. */
  const moveTo = (top: number) => act(() => publishAssistantSpot({ right: ASSISTANT_DEFAULT_POS.right, bottom: VH - ASSISTANT_SIZE - top }))
  const mount = (o: ClearanceOptions) => render(createElement(Box, { o })).container.firstElementChild as HTMLElement
  /** Drag from `from` up to `to`, 4px a step, as a pointer does. */
  const drag = (from: number, to: number) => {
    for (let top = from; top >= to; top -= 4) moveTo(top)
    moveTo(to)
  }

  it('a pair pinned by its bottom-right corner steps up — and comes home once the character has gone up past it', () => {
    // the undo/redo pair: 67×36, its corner at (1264, 745)
    layout((pad) => box(1197, 745 - 36 - pad.bottom, 1264, 745))
    const o: ClearanceOptions = { side: 'bottom', grows: true }
    moveTo(732)
    const pair = mount(o)
    expect(pair.style.paddingBottom).toBe(`${745 - 732 + 8}px`)
    drag(732, 432)
    const freshAt432 = mount(o)
    expect(pair.style.paddingBottom).toBe(freshAt432.style.paddingBottom)
    expect(pair.style.paddingBottom).toBe('')
    drag(432, 152)
    expect(pair.style.paddingBottom).toBe(mount(o).style.paddingBottom)
    expect(pair.style.paddingBottom).toBe('')
  })

  it('a row along the foot that wraps onto a second line keeps no room once the character is above its one line', () => {
    // the worker seat's buttons: one 32px line, two once its room passes 60px
    layout((pad) => box(800, 800 - (pad.right > 60 ? 64 : 32), 1280, 800))
    const o: ClearanceOptions = { side: 'right', grows: true }
    moveTo(732)
    const row = mount(o)
    expect(row.style.paddingRight).toBe(`${1280 - (VW - ASSISTANT_DEFAULT_POS.right - ASSISTANT_SIZE) + 8}px`)
    // just above its one line (char 712–762), still beside where its second line would be
    drag(732, 712)
    expect(row.style.paddingRight).toBe(mount(o).style.paddingRight)
    expect(row.style.paddingRight).toBe('')
  })

  // A room bigger than the box it pads grows that box — its content cannot
  // shrink below 0 (CSS box-sizing: border-box) — so the next measure returns a
  // bigger room, on every move (review ab3-R1: the rail 268 → 1220px over 56px of
  // travel, its foot 800 → 1760; the chat card 310 → 530px, out of its seat).
  it('a scrolling column the character crosses keeps its height — the same room on every path', () => {
    // the icon rail, 72×264 from the bar's top (536) to the window's foot
    layout((pad) => box(1208, 536, 1280, 536 + Math.max(264, pad.bottom + 4)))
    const o: ClearanceOptions = { side: 'bottom' }
    const foot = (el: HTMLElement) => 536 + Math.max(264, (parseFloat(el.style.paddingBottom) || 0) + 4)
    moveTo(732)
    const rail = mount(o)
    expect(rail.style.paddingBottom).toBe(`${800 - 732 + 8}px`)
    // dragged up the right edge, across the rail's top edge
    drag(732, 520)
    expect(rail.style.paddingBottom).toBe(mount(o).style.paddingBottom)
    drag(520, 500)
    expect(rail.style.paddingBottom).toBe(mount(o).style.paddingBottom)
    expect(foot(rail)).toBe(800)
  })

  it('a send card the character is dragged along keeps its width, and lifts its words once the character is over its left end', () => {
    // the president's chat card in a 360px seat: 312×134, 16px above the
    // window's foot — taller with room under its words, wider only if a room
    // passes its width (its own padding and border are 18px)
    const card = { left: 24, top: 650, right: 336, bottom: 784 }
    layout((pad) => box(card.left, card.top - Math.max(0, pad.bottom - 12), card.left + Math.max(card.right - card.left, pad.right + 18), card.bottom))
    const o: ClearanceOptions = { side: 'right', grows: true }
    const at = (left: number) => ({ right: VW - ASSISTANT_SIZE - left, bottom: 12 })
    act(() => publishAssistantSpot(at(300)))
    const el = mount(o)
    // on its right end the room comes off its right side
    expect(el.style.paddingRight).toBe(`${card.right - 300 + 8}px`)
    // dragged along its foot to the window's left edge, 4px a step
    for (let left = 300; left >= 4; left -= 4) act(() => publishAssistantSpot(at(left)))
    // its words sit above the character at full width…
    expect(el.style.paddingRight).toBe('')
    expect(el.style.paddingBottom).toBe(`${card.bottom - (VH - 12 - ASSISTANT_SIZE) + 8}px`)
    // …just as on a card mounted with the character already there
    expect(el.style.cssText).toBe(mount(o).style.cssText)
  })
})
