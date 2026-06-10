// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCanvasHistory } from './useCanvasHistory'
import type { CanvasState } from './types'

// undo/redo for the canvas document (card positions + free elements). The hook
// debounces edits into steps, but undo()/redo() flush any pending edit first,
// so we can drive the whole cycle synchronously without faking timers.

const mk = (positions: CanvasState['positions']): CanvasState =>
  ({ positions, elements: [], viewport: { x: 0, y: 0, scale: 1 } } as unknown as CanvasState)

describe('useCanvasHistory', () => {
  it('undo restores the previous positions; redo re-applies the newer ones', () => {
    const apply = vi.fn<(c: CanvasState) => void>()
    const c0 = mk({ a: { x: 0, y: 0 } } as never)
    const c1 = mk({ a: { x: 10, y: 10 } } as never)

    const { result, rerender } = renderHook(
      ({ canvas }) => useCanvasHistory(canvas, apply),
      { initialProps: { canvas: c0 } },
    )

    // An edit lands: positions object is replaced (reference inequality is the
    // hook's "this is a real edit, not a pan/zoom" signal).
    rerender({ canvas: c1 })

    act(() => result.current.undo())
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][0].positions).toBe(c0.positions)

    act(() => result.current.redo())
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply.mock.calls[1][0].positions).toBe(c1.positions)
  })

  it('undo with no history is a no-op (never calls applyCanvas)', () => {
    const apply = vi.fn<(c: CanvasState) => void>()
    const { result } = renderHook(() => useCanvasHistory(mk({} as never), apply))
    act(() => result.current.undo())
    act(() => result.current.redo())
    expect(apply).not.toHaveBeenCalled()
  })

  it('a pan/zoom (same positions+elements refs) produces no undo step', () => {
    const apply = vi.fn<(c: CanvasState) => void>()
    const positions = { a: { x: 0, y: 0 } } as never
    const elements = [] as CanvasState['elements']
    const base = { positions, elements, viewport: { x: 0, y: 0, scale: 1 } } as unknown as CanvasState
    // Same positions/elements object refs, only the viewport changed.
    const panned = { positions, elements, viewport: { x: 99, y: 99, scale: 2 } } as unknown as CanvasState

    const { result, rerender } = renderHook(
      ({ canvas }) => useCanvasHistory(canvas, apply),
      { initialProps: { canvas: base } },
    )
    rerender({ canvas: panned })
    act(() => result.current.undo())
    // Nothing to undo — the viewport change is intentionally not a history step.
    expect(apply).not.toHaveBeenCalled()
  })
})
