import { describe, it, expect } from 'vitest'
import { decideCrashResponse, BACKOFF_DELAYS_MS, CRASH_WINDOW_MS } from '../../electron/crashRespawn'

// Tests for the pure crash-loop-breaker decision (electron/main.js §6 supervisor,
// docs/ENGINE_PERSISTENCE_PLAN.md card 5). No Electron import needed — the same
// DI split electron/selfUpdate.test.ts already uses — so the backoff/window math
// is exercised directly, without forking a real child process.

const T0 = 1_700_000_000_000 // arbitrary fixed epoch ms

describe('decideCrashResponse', () => {
  it('respawns on the 1st/2nd/3rd crash within the 10-minute window with 2s/4s/8s backoff', () => {
    let timestamps: number[] = []

    const first = decideCrashResponse({ timestamps, now: T0, isQuitting: false, isSwitching: false })
    expect(first.action).toBe('respawn')
    expect(first.delayMs).toBe(BACKOFF_DELAYS_MS[0])
    timestamps = first.timestamps!

    const second = decideCrashResponse({ timestamps, now: T0 + 1_000, isQuitting: false, isSwitching: false })
    expect(second.action).toBe('respawn')
    expect(second.delayMs).toBe(BACKOFF_DELAYS_MS[1])
    timestamps = second.timestamps!

    const third = decideCrashResponse({ timestamps, now: T0 + 2_000, isQuitting: false, isSwitching: false })
    expect(third.action).toBe('respawn')
    expect(third.delayMs).toBe(BACKOFF_DELAYS_MS[2])
  })

  it('goes fatal on the 4th crash inside the same 10-minute window', () => {
    let timestamps: number[] = []
    let now = T0
    for (let i = 0; i < 3; i++) {
      const decision = decideCrashResponse({ timestamps, now, isQuitting: false, isSwitching: false })
      expect(decision.action).toBe('respawn')
      timestamps = decision.timestamps!
      now += 1_000
    }

    const fourth = decideCrashResponse({ timestamps, now, isQuitting: false, isSwitching: false })
    expect(fourth.action).toBe('fatal')
  })

  it('prunes crashes outside the 10-minute window, so an old crash does not count toward the limit', () => {
    // Two crashes long ago (outside the window by the time of `now`) plus the
    // current one should still be respawn #1, not #3.
    const timestamps = [T0, T0 + 1_000]
    const now = T0 + CRASH_WINDOW_MS + 60_000

    const decision = decideCrashResponse({ timestamps, now, isQuitting: false, isSwitching: false })
    expect(decision.action).toBe('respawn')
    expect(decision.delayMs).toBe(BACKOFF_DELAYS_MS[0])
    expect(decision.timestamps).toEqual([now])
  })

  it('skips (does nothing) during a deliberate app quit', () => {
    const decision = decideCrashResponse({ timestamps: [], now: T0, isQuitting: true, isSwitching: false })
    expect(decision.action).toBe('skip')
  })

  it('skips (does nothing) during a self-update cutover (isSwitching)', () => {
    const decision = decideCrashResponse({ timestamps: [], now: T0, isQuitting: false, isSwitching: true })
    expect(decision.action).toBe('skip')
  })
})
