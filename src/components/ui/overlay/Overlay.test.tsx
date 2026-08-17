// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { Overlay } from './Overlay'
import { OVERLAY_PLACEMENT, type OverlayPlacement } from './layers'

// 「モーダル外をタップすると閉じる」 — the rule the owner asked for on 2026-08-17,
// with 「全部」 attached to it. It lives in the shell precisely so it cannot be
// present on some surfaces and missing on others, and these are the three things
// that would quietly take it away again:
//
//   1. someone re-adds a placement allow-list (the old code excluded `fill` and
//      `scroll`, so two whole families of surface had no backdrop dismiss);
//   2. someone moves it back to `click`, which fires on the nearest common
//      ancestor of press and release — so selecting text inside a card and
//      letting go over the veil would destroy the surface mid-drag;
//   3. someone drops the target check for a bubble handler, which dismisses from
//      the inside unless every child cooperates by stopping propagation.
//
// Each of the three has its own test below. None of them asserts that a handler
// exists — they all press somewhere and count closes.

const backdrop = () => document.querySelector('[data-esc-overlay]')!

describe('Overlay — a press on the backdrop closes it', () => {
  it('closes when the press LANDS on the backdrop', () => {
    const onClose = vi.fn()
    render(
      <Overlay onClose={onClose}>
        <div data-testid="card">inside</div>
      </Overlay>,
    )
    fireEvent.mouseDown(backdrop())
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does NOT close when the press lands inside — without the child cooperating', () => {
    // The child here stops nothing. Under a bubble handler this press would
    // reach the root and dismiss; under the target check it cannot.
    const onClose = vi.fn()
    const { getByTestId } = render(
      <Overlay onClose={onClose}>
        <div data-testid="card">inside</div>
      </Overlay>,
    )
    fireEvent.mouseDown(getByTestId('card'))
    expect(onClose).not.toHaveBeenCalled()
  })

  it('⚠ A DRAG OUT OF THE CARD IS NOT A DISMISS', () => {
    // Press inside, release on the veil: the browser delivers the `click` to the
    // nearest common ancestor, which IS the overlay root. A click-based dismiss
    // therefore fires here — and takes the surface (and whatever was typed into
    // it) away in the middle of a text selection. Pressing on mousedown is what
    // makes the difference, so the test performs the whole gesture.
    const onClose = vi.fn()
    const { getByTestId } = render(
      <Overlay onClose={onClose}>
        <div data-testid="card">inside</div>
      </Overlay>,
    )
    fireEvent.mouseDown(getByTestId('card'))
    fireEvent.mouseUp(backdrop())
    fireEvent.click(backdrop())
    expect(onClose).not.toHaveBeenCalled()
  })

  it('EVERY placement closes — there is no exception list', () => {
    // The old implementation opted `fill` and `scroll` out, because the bubble
    // handler needed children to stop propagation and only DialogCard did. If a
    // placement ever goes quiet again, this is where it shows.
    for (const placement of Object.keys(OVERLAY_PLACEMENT) as OverlayPlacement[]) {
      const onClose = vi.fn()
      const { unmount } = render(
        <Overlay placement={placement} onClose={onClose}>
          <div>inside</div>
        </Overlay>,
      )
      fireEvent.mouseDown(backdrop())
      expect(onClose, `placement=${placement}`).toHaveBeenCalledTimes(1)
      unmount()
    }
  })

  it('closeOnBackdrop={false} is the one way out, and it still leaves Esc', () => {
    const onClose = vi.fn()
    render(
      <Overlay onClose={onClose} closeOnBackdrop={false}>
        <div>inside</div>
      </Overlay>,
    )
    fireEvent.mouseDown(backdrop())
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('the onMouseDown passthrough still runs — on the backdrop and inside alike', () => {
    // Two surfaces wire their own root mousedown; folding the dismiss into that
    // slot must not eat theirs.
    const onMouseDown = vi.fn()
    const { getByTestId } = render(
      <Overlay onClose={vi.fn()} onMouseDown={onMouseDown}>
        <div data-testid="card">inside</div>
      </Overlay>,
    )
    fireEvent.mouseDown(getByTestId('card'))
    fireEvent.mouseDown(backdrop())
    expect(onMouseDown).toHaveBeenCalledTimes(2)
  })
})
