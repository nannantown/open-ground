// @vitest-environment jsdom
//
// UsageHud request-CANCELLATION integration test. UsageHud polls /api/usage and
// keeps an AbortController so an in-flight request is dropped when (a) a newer
// fetch supersedes it (poll / manual refresh) and (b) the component unmounts.
// That abort wiring was previously untested; this pins it. (The modern app has
// no batch "runner" — its cancellation surfaces are these AbortController teardowns
// and the Canvas AI job cancel, which is covered elsewhere.)
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'

// Render UsageHud in isolation — echo translation keys so we don't need the
// I18nProvider (same pattern as Toolbar.test.tsx).
vi.mock('@/i18n/I18nContext', () => ({
  useT: () => ({ t: (k: string) => k, lang: 'en', setLang: () => {}, toggleLang: () => {} }),
}))

import { UsageHud } from './UsageHud'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// A fetch that never settles, recording each call's AbortSignal so we can prove
// the component aborts it. Returning a forever-pending promise keeps every
// request "in flight", so the ONLY thing that can flip a signal to aborted is
// UsageHud's own teardown — exactly what we're testing.
function installPendingFetch() {
  const signals: AbortSignal[] = []
  const calls: string[] = []
  const fetchMock = vi.fn((url: unknown, init?: RequestInit) => {
    calls.push(String(url))
    if (init?.signal) signals.push(init.signal)
    return new Promise<Response>(() => {})
  })
  vi.stubGlobal('fetch', fetchMock)
  return { signals, calls, fetchMock }
}

describe('UsageHud — request cancellation', () => {
  it('aborts the in-flight /api/usage request when unmounted', () => {
    const { signals } = installPendingFetch()

    const { unmount } = render(<UsageHud />)
    // Mount kicked off exactly one request, still live (not aborted).
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(false)

    unmount()
    // The effect cleanup calls aborter.current?.abort().
    expect(signals[0].aborted).toBe(true)
  })

  it('aborts the previous request when a manual refresh starts a new one', async () => {
    const { signals, calls } = installPendingFetch()

    render(<UsageHud />)
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(false)

    // Open the popover (the refresh button lives inside it), then refresh.
    fireEvent.click(screen.getByLabelText('misc.usage.heading'))
    await act(async () => {
      fireEvent.click(screen.getByText('misc.usage.refresh'))
    })

    // A second request started; it aborted the first as it began.
    expect(signals).toHaveLength(2)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    // The manual refresh bypasses the server cache (?refresh=1).
    expect(calls[1]).toContain('refresh=1')
  })
})
