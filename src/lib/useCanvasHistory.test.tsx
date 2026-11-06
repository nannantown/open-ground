// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useCanvasHistory } from './useCanvasHistory'
import type { CanvasState } from './types'
import { createAutomationFrame, isAutomationAllowed, setFrameAutomation } from './automationFrame'

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

describe('useCanvasHistory — automation identity and server revision', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does not crash or invent a history edit when a malformed persisted V2 list is loaded', () => {
    const apply = vi.fn<(c: CanvasState) => void>()
    const damaged = { positions: {}, elements: [], viewport: { x: 0, y: 0, zoom: 1 },
      automation: { version: 2, revision: 4, enabled: true, frameIds: null } } as unknown as CanvasState
    const { result } = renderHook(() => useCanvasHistory(damaged, apply))
    act(() => result.current.undo())
    expect(apply).not.toHaveBeenCalled()
  })

  it('undoes the first normal-frame toggle to V2 all-OFF and redoes it using the latest ACK revision', () => {
    const apply = vi.fn<(c: CanvasState) => void>()
    const ordinary: CanvasState = { positions: {}, elements: [{ id: 'normal', type: 'frame', text: 'Normal', x: 0, y: 0 }], viewport: { x: 0, y: 0, zoom: 1 } }
    const on = setFrameAutomation(ordinary, 'normal', true); on.automation!.revision = 3
    const { result, rerender } = renderHook(({ canvas }) => useCanvasHistory(canvas, apply), { initialProps: { canvas: ordinary } })
    rerender({ canvas: on })
    act(() => result.current.undo())
    const off = apply.mock.lastCall![0]
    expect(off.automation).toEqual({ version: 2, revision: 3, enabled: true, frameIds: [] })
    rerender({ canvas: { ...off, automation: { ...off.automation!, revision: 4 } } })
    act(() => result.current.redo())
    expect(apply.mock.lastCall![0].automation).toEqual({ version: 2, revision: 4, enabled: true, frameIds: ['normal'] })
  })

  it('normalizes an older V1 history step into current V2 without rewinding its server revision', () => {
    const apply = vi.fn<(c: CanvasState) => void>()
    const original = createAutomationFrame({ positions: {}, elements: [], viewport: { x: 0, y: 0, zoom: 1 } }, 'first', 'First')
    original.automation!.revision = 2
    const multi = { ...original, automation: { version: 2, revision: 7, enabled: true, frameIds: ['first', 'second'] },
      elements: original.elements.map(({ groundRole: _role, ...element }) => element) } as unknown as CanvasState
    const { result, rerender } = renderHook(({ canvas }) => useCanvasHistory(canvas, apply), { initialProps: { canvas: original } })
    rerender({ canvas: multi })
    act(() => result.current.undo())
    const undone = apply.mock.lastCall![0]
    expect(undone.automation).toEqual({ version: 2, revision: 7, enabled: true, frameIds: ['first'] })
    expect(undone.elements.every(element => !element.groundRole)).toBe(true)
    rerender({ canvas: { ...undone, automation: { ...undone.automation!, revision: 8 } } })
    act(() => result.current.redo())
    expect(apply.mock.lastCall![0].automation).toEqual({ version: 2, revision: 8, enabled: true, frameIds: ['first', 'second'] })
  })

  it('restores the designated ID together with its frame through create/delete/recreate and undo/redo', () => {
    const apply = vi.fn<(c: CanvasState) => void>()
    const legacy: CanvasState = { positions: {}, elements: [], viewport: { x: 0, y: 0, zoom: 1 } }
    const first = createAutomationFrame(legacy, 'frame-1', '自動運用')
    first.automation!.revision = 1
    const removed: CanvasState = { ...first, elements: [], automation: { ...first.automation!, revision: 2 } }
    const second = createAutomationFrame(removed, 'frame-2', '自動運用')
    second.automation!.revision = 3
    const { result, rerender } = renderHook(({ canvas }) => useCanvasHistory(canvas, apply), { initialProps: { canvas: legacy } })
    const settle = (canvas: CanvasState) => { rerender({ canvas }); act(() => { vi.advanceTimersByTime(450) }) }
    for (const canvas of [first, removed, second]) settle(canvas)
    act(() => result.current.undo())
    expect(apply.mock.lastCall![0].automation).toEqual({ version: 1, enabled: true, frameId: 'frame-1', revision: 3 })
    rerender({ canvas: apply.mock.lastCall![0] })
    act(() => result.current.undo())
    const restored = apply.mock.lastCall![0]
    expect(restored.elements.find(element => element.groundRole === 'automation')?.id).toBe('frame-1')
    expect(restored.automation?.frameId).toBe('frame-1')
    expect(restored.automation?.revision).toBe(3)
    // A subsequent server ACK must not replace the redo step or rewind its CAS.
    rerender({ canvas: { ...restored, automation: { ...restored.automation!, revision: 9 } } })
    act(() => result.current.redo())
    expect(apply.mock.lastCall![0].elements).toHaveLength(0)
    expect(apply.mock.lastCall![0].automation).toMatchObject({ frameId: 'frame-1', revision: 9 })
    rerender({ canvas: apply.mock.lastCall![0] })
    act(() => result.current.redo())
    expect(apply.mock.lastCall![0].elements.find(element => element.groundRole === 'automation')?.id).toBe('frame-2')
    expect(apply.mock.lastCall![0].automation).toMatchObject({ frameId: 'frame-2', revision: 9 })
  })

  it('undoing the first opt-in leaves an explicit empty allowlist and can redo the creation', () => {
    const apply = vi.fn<(c: CanvasState) => void>()
    const legacy: CanvasState = { positions: { project: { x: 0, y: 0 } }, elements: [], viewport: { x: 0, y: 0, zoom: 1 } }
    const created = createAutomationFrame(legacy, 'frame-1', '自動運用')
    created.automation!.revision = 4
    const { result, rerender } = renderHook(({ canvas }) => useCanvasHistory(canvas, apply), { initialProps: { canvas: legacy } })
    rerender({ canvas: created })
    act(() => result.current.undo())
    const undone = apply.mock.lastCall![0]
    expect(undone.automation).toEqual({ version: 1, revision: 4, enabled: true, frameId: null })
    expect(undone.elements).toHaveLength(0)
    expect(isAutomationAllowed(undone, 'project')).toBe(false)
    rerender({ canvas: undone })
    act(() => result.current.redo())
    expect(apply.mock.lastCall![0].automation).toMatchObject({ frameId: 'frame-1', revision: 4 })
    expect(apply.mock.lastCall![0].elements[0].groundRole).toBe('automation')
  })

  it('ignores revision-only acknowledgements but records a real configuration change', () => {
    const apply = vi.fn<(c: CanvasState) => void>()
    const base = createAutomationFrame({ positions: {}, elements: [], viewport: { x: 0, y: 0, zoom: 1 } }, 'frame-1', '自動運用')
    base.automation!.revision = 5
    const { result, rerender } = renderHook(({ canvas }) => useCanvasHistory(canvas, apply), { initialProps: { canvas: base } })
    const acknowledged: CanvasState = { ...base, automation: { ...base.automation!, revision: 11 } }
    rerender({ canvas: acknowledged })
    act(() => { vi.advanceTimersByTime(450); result.current.undo() })
    expect(apply).not.toHaveBeenCalled()
    rerender({ canvas: { ...acknowledged, automation: { version: 1, frameId: 'frame-1', enabled: false, revision: 12 } } })
    act(() => result.current.undo())
    expect(apply.mock.lastCall![0].automation).toEqual({ version: 1, revision: 12, enabled: true, frameId: 'frame-1' })
  })
})
