import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  __resetPlaybackForTest,
  clearPlayback,
  getPlaybackSnapshot,
  isPlaybackMessage,
  reportPlayback,
  subscribePlayback,
} from './playbackStore'

beforeEach(() => {
  __resetPlaybackForTest()
})

describe('isPlaybackMessage', () => {
  it('accepts a well-formed payload', () => {
    expect(
      isPlaybackMessage({
        type: 'og-playback',
        playing: true,
        title: 'Song A',
        projectName: 'NENE',
        app: 'nene-songs',
      }),
    ).toBe(true)
    // Optional fields may be absent or null.
    expect(isPlaybackMessage({ type: 'og-playback', playing: false })).toBe(true)
    expect(
      isPlaybackMessage({ type: 'og-playback', playing: true, title: null }),
    ).toBe(true)
  })

  it('rejects malformed payloads', () => {
    expect(isPlaybackMessage(null)).toBe(false)
    expect(isPlaybackMessage('og-playback')).toBe(false)
    expect(isPlaybackMessage({ type: 'og-playback' })).toBe(false)
    expect(isPlaybackMessage({ type: 'og-playback', playing: 'yes' })).toBe(false)
    expect(isPlaybackMessage({ type: 'other', playing: true })).toBe(false)
    expect(
      isPlaybackMessage({ type: 'og-playback', playing: true, title: 42 }),
    ).toBe(false)
    expect(
      isPlaybackMessage({ type: 'og-playback', playing: true, projectName: {} }),
    ).toBe(false)
  })
})

describe('reportPlayback / clearPlayback', () => {
  it('tracks playing modules and drops them on playing:false', () => {
    reportPlayback('m1', {
      type: 'og-playback',
      playing: true,
      title: 'A',
      projectName: 'NENE',
    })
    expect(getPlaybackSnapshot().get('m1')).toEqual({
      title: 'A',
      projectName: 'NENE',
    })

    reportPlayback('m1', { type: 'og-playback', playing: false })
    expect(getPlaybackSnapshot().has('m1')).toBe(false)
  })

  it('keeps snapshot identity across pure heartbeats, changes it on transitions', () => {
    reportPlayback('m1', {
      type: 'og-playback',
      playing: true,
      title: 'A',
      projectName: 'NENE',
    })
    const snap1 = getPlaybackSnapshot()
    // Heartbeat: same semantic content → identical snapshot object.
    reportPlayback('m1', {
      type: 'og-playback',
      playing: true,
      title: 'A',
      projectName: 'NENE',
    })
    expect(getPlaybackSnapshot()).toBe(snap1)
    // Track change → new snapshot.
    reportPlayback('m1', {
      type: 'og-playback',
      playing: true,
      title: 'B',
      projectName: 'NENE',
    })
    expect(getPlaybackSnapshot()).not.toBe(snap1)
    expect(getPlaybackSnapshot().get('m1')?.title).toBe('B')
  })

  it('notifies subscribers on transitions but not on heartbeats', () => {
    const fn = vi.fn()
    const unsub = subscribePlayback(fn)
    reportPlayback('m1', { type: 'og-playback', playing: true, title: 'A' })
    expect(fn).toHaveBeenCalledTimes(1)
    reportPlayback('m1', { type: 'og-playback', playing: true, title: 'A' })
    expect(fn).toHaveBeenCalledTimes(1)
    clearPlayback('m1')
    expect(fn).toHaveBeenCalledTimes(2)
    // Clearing an absent entry is a no-op notification-wise.
    clearPlayback('m1')
    expect(fn).toHaveBeenCalledTimes(2)
    unsub()
  })
})

describe('stale sweep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('drops a playing entry whose heartbeat went stale (only while subscribed)', () => {
    const unsub = subscribePlayback(() => {})
    reportPlayback('m1', { type: 'og-playback', playing: true, title: 'A' })
    // Fresh beats keep it alive across sweeps.
    vi.advanceTimersByTime(10_000)
    reportPlayback('m1', { type: 'og-playback', playing: true, title: 'A' })
    vi.advanceTimersByTime(10_000)
    expect(getPlaybackSnapshot().has('m1')).toBe(true)
    // No beats for > STALE_MS (15s) → swept on the next 5s tick.
    vi.advanceTimersByTime(20_000)
    expect(getPlaybackSnapshot().has('m1')).toBe(false)
    unsub()
  })
})
