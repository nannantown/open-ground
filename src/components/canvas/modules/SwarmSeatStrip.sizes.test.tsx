// @vitest-environment jsdom
//
// Seat widths (owner 2026-09-26): the border in front of a seat sizes the seat
// on its LEFT — a drag past SEAT_DRAG_SLOP px sets its width, a press that
// moves less opens that seat up big (the others drop to their minimum) and
// pressing again puts the row back. The nameplate does the same for its own
// seat, except on its buttons. Widths and the wide seat are remembered per
// project.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'

vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {}, toggleLang: () => {} }),
}))

import { SEAT_DRAG_SLOP, SeatSizeContext, SizedSeat, swarmSeatSizesKey, useSeatSizes } from './SwarmSeatStrip'
import { SwarmSeatHeader } from './SwarmSeatHeader'

const A = { flex: '1 0 360px', minWidth: 360 }
const B = { flex: '1 0 280px', minWidth: 280 }

/** A row like SwarmModule's: `seats` = the open seats (openOrder), 'a' first
 *  (the president — never folds), the rest may come and go. */
const Row = ({ id = 'p1', seats = ['a', 'b'] }: { id?: string; seats?: string[] }) => {
  const sizes = useSeatSizes(id)
  return (
    <SeatSizeContext.Provider value={{ ...sizes, order: seats }}>
      <div>
        {seats.map((k, i) =>
          k === 'a' ? (
            <SizedSeat key={k} seatKey="a" style={A}>
              <SwarmSeatHeader role="supply" sprite={null} statusLabel="idle">
                <button type="button">stop</button>
              </SwarmSeatHeader>
            </SizedSeat>
          ) : (
            <SizedSeat key={k} seatKey={k} prevKey={seats[i - 1]} style={B}>
              {k}
            </SizedSeat>
          ),
        )}
      </div>
    </SeatSizeContext.Provider>
  )
}
/** No blank gap at the right end: some seat in the row still grows. */
const rowFills = (seats: string[]) => seats.some((k) => seat(k).style.flex.startsWith('1 '))

const seat = (k: string) => document.querySelector(`[data-seat-key="${k}"]`) as HTMLElement
const border = () => screen.getByRole('separator')
const saved = (id = 'p1') => JSON.parse(localStorage.getItem(swarmSeatSizesKey(id)) ?? 'null')
const gesture = (el: Element, dx: number) => {
  fireEvent.pointerDown(el, { button: 0, clientX: 500, pointerId: 1 })
  fireEvent.pointerMove(el, { clientX: 500 + dx, pointerId: 1, buttons: 1 })
  fireEvent.pointerUp(el, { clientX: 500 + dx, pointerId: 1 })
}

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('seat widths', () => {
  it('only seats after the first get a border, and it belongs to the seat on its left', () => {
    render(<Row />)
    expect(screen.getAllByRole('separator')).toHaveLength(1)
    expect(border().getAttribute('data-seat-border')).toBe('a')
  })

  it('a press on the border that moves less than the slop widens the left seat; again puts it back', () => {
    render(<Row />)
    gesture(border(), SEAT_DRAG_SLOP - 1)
    expect(seat('a').style.flex).toBe('1 0 360px')
    expect(seat('b').style.flex).toBe('0 0 280px')
    expect(saved()).toEqual({ w: {}, wide: 'a' })
    gesture(border(), 0)
    expect(seat('a').style.flex).toBe('1 0 360px')
    expect(seat('b').style.flex).toBe('1 0 280px')
    expect(saved().wide).toBeUndefined()
  })

  it('a drag past the slop sets the left seat width, never below its minimum, and saves it', () => {
    render(<Row />)
    // jsdom has no layout: the seat measures as its minimum (360).
    gesture(border(), 100)
    expect(seat('a').style.flex).toBe('0 0 460px')
    expect(seat('a').getAttribute('data-seat-wide')).toBeNull()
    expect(saved()).toEqual({ w: { a: 460 } })
    gesture(border(), -400)
    expect(seat('a').style.flex).toBe('0 0 360px')
  })

  it('a drag clears the wide seat', () => {
    render(<Row />)
    gesture(border(), 0)
    expect(saved().wide).toBe('a')
    gesture(border(), 50)
    expect(saved()).toEqual({ w: { a: 410 } })
    expect(seat('b').style.flex).toBe('1 0 280px')
  })

  it('the nameplate widens its own seat, but not from its buttons', () => {
    render(<Row />)
    fireEvent.click(screen.getByRole('button', { name: 'stop' }))
    expect(saved()).toBeNull()
    fireEvent.click(screen.getByText('idle'))
    expect(seat('a').getAttribute('data-seat-wide')).toBe('true')
    fireEvent.click(screen.getByText('idle'))
    expect(seat('a').getAttribute('data-seat-wide')).toBeNull()
  })

  it('widths and the wide seat are remembered per project', () => {
    render(<Row />)
    gesture(border(), 40)
    cleanup()
    render(<Row />)
    expect(seat('a').style.flex).toBe('0 0 400px')
    cleanup()
    render(<Row id="p2" />)
    expect(seat('a').style.flex).toBe('1 0 360px')
  })

  // 差し戻し 2026-09-26 must-fix 1: a worker's seat widened, then folded with
  // its own chevron (or the worker finished and left the roster) — its saved
  // wide mark must not keep shrinking every other seat to its minimum.
  it('a wide mark whose seat left the row no longer narrows the others', () => {
    const { rerender } = render(<Row seats={['a', 'b', 'w']} />)
    // A press on the border after 'b' widens 'b'.
    gesture(document.querySelector('[data-seat-border="b"]')!, 0)
    expect(saved().wide).toBe('b')
    expect(seat('a').style.flex).toBe('0 0 360px')
    rerender(<Row seats={['a', 'w']} />) // 'b' folded
    expect(seat('a').style.flex).toBe('1 0 360px')
    expect(seat('w').style.flex).toBe('1 0 280px')
    expect(rowFills(['a', 'w'])).toBe(true)
    // …and after a restart, with the mark still on disk.
    cleanup()
    render(<Row seats={['a']} />)
    expect(seat('a').style.flex).toBe('1 0 360px')
  })

  // must-fix 2: a width dragged while the seat had a border on its right stays
  // fixed after it became the last (or only) seat — nothing could undo it.
  it('the last seat ignores its saved width and grows', () => {
    const { rerender } = render(<Row seats={['a', 'm']} />)
    gesture(border(), 40) // a: 360 → 400
    expect(seat('a').style.flex).toBe('0 0 400px')
    rerender(<Row seats={['a']} />) // the manager folded
    expect(seat('a').style.flex).toBe('1 0 360px')
    expect(rowFills(['a'])).toBe(true)
    rerender(<Row seats={['a', 'm']} />) // back: the width returns
    expect(seat('a').style.flex).toBe('0 0 400px')
    expect(rowFills(['a', 'm'])).toBe(true)
  })

  it('the keyboard can size and widen it too', () => {
    render(<Row />)
    fireEvent.keyDown(border(), { key: 'ArrowRight' })
    expect(seat('a').style.flex).toBe('0 0 384px')
    fireEvent.keyDown(border(), { key: 'Enter' })
    expect(seat('a').style.flex).toBe('1 0 360px')
  })
})
