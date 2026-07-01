// @vitest-environment jsdom
//
// useJoinDeepLink integration test. The hook subscribes the renderer to
// `openground://join?code=…` deep links from the Electron bridge, over two
// paths: WARM (onDeepLink callback while running) and COLD (getInitialDeepLink,
// drained once at launch). Its fragile bits — no-op without the bridge, the
// StrictMode-safe one-shot ref so the cold buffer is never double-drained or
// lost, and warm-listener cleanup — were untested. This pins them.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { useJoinDeepLink } from './useJoinDeepLink'

interface Bridge {
  onDeepLink?: (cb: (url: string) => void) => (() => void) | void
  getInitialDeepLink?: () => Promise<string | null>
}
const setBridge = (b: Bridge | undefined) => {
  ;(window as unknown as { openground?: Bridge }).openground = b
}

afterEach(() => {
  setBridge(undefined)
  vi.restoreAllMocks()
})

describe('useJoinDeepLink', () => {
  it('is a safe no-op in a plain browser with no Electron bridge', () => {
    setBridge(undefined)
    const onJoin = vi.fn()
    expect(() => renderHook(() => useJoinDeepLink(onJoin))).not.toThrow()
    expect(onJoin).not.toHaveBeenCalled()
  })

  it('delivers a WARM deep link to the callback as a parsed code', () => {
    let emit: (url: string) => void = () => {}
    setBridge({
      onDeepLink: (cb) => {
        emit = cb
        return () => {}
      },
      getInitialDeepLink: () => Promise.resolve(null),
    })
    const onJoin = vi.fn()
    renderHook(() => useJoinDeepLink(onJoin))

    act(() => emit('openground://join?code=WARM123'))
    expect(onJoin).toHaveBeenCalledWith('WARM123')
  })

  it('ignores a non-join deep link', () => {
    let emit: (url: string) => void = () => {}
    setBridge({
      onDeepLink: (cb) => {
        emit = cb
        return () => {}
      },
      getInitialDeepLink: () => Promise.resolve(null),
    })
    const onJoin = vi.fn()
    renderHook(() => useJoinDeepLink(onJoin))

    act(() => emit('openground://settings?code=NOPE'))
    expect(onJoin).not.toHaveBeenCalled()
  })

  it('drains a COLD-start deep link exactly once', async () => {
    const getInitial = vi.fn().mockResolvedValue('openground://join?code=COLD456')
    setBridge({ onDeepLink: () => () => {}, getInitialDeepLink: getInitial })
    const onJoin = vi.fn()

    renderHook(() => useJoinDeepLink(onJoin))
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith('COLD456'))
    expect(getInitial).toHaveBeenCalledTimes(1)
  })

  it('fetches the cold-start link only ONCE under StrictMode double-invoke', async () => {
    const getInitial = vi.fn().mockResolvedValue(null)
    setBridge({ onDeepLink: () => () => {}, getInitialDeepLink: getInitial })

    // StrictMode runs mount → cleanup → mount on the same instance; the ref
    // guard must keep the one-shot cold fetch at exactly one call.
    renderHook(() => useJoinDeepLink(vi.fn()), { wrapper: StrictMode })
    await waitFor(() => expect(getInitial).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 10))
    expect(getInitial).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes the warm listener on unmount', () => {
    const off = vi.fn()
    setBridge({ onDeepLink: () => off, getInitialDeepLink: () => Promise.resolve(null) })

    const { unmount } = renderHook(() => useJoinDeepLink(vi.fn()))
    unmount()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
