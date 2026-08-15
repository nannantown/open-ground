import { describe, it, expect } from 'vitest'
import {
  WORKER_NOTE_STALE_MS,
  deriveHeartbeatFreshness,
  deriveManagerTone,
  deriveWorkerActivity,
} from './boardWorker'

describe('deriveWorkerActivity', () => {
  it('a live working PTY → working (the band scans)', () => {
    expect(deriveWorkerActivity('running', 'working')).toBe('working')
    // live beacon wins even mid-boot — a starting worker already emitting output
    // is genuinely working.
    expect(deriveWorkerActivity('starting', 'working')).toBe('working')
  })

  it('a live waiting PTY → waiting (steady, no scan)', () => {
    expect(deriveWorkerActivity('running', 'waiting')).toBe('waiting')
    expect(deriveWorkerActivity('starting', 'waiting')).toBe('waiting')
  })

  it('stage done wins outright — never scans, even with a live working beacon', () => {
    expect(deriveWorkerActivity('done', 'working')).toBe('done')
    expect(deriveWorkerActivity('done', undefined)).toBe('done')
  })

  it('booting with no live signal yet → starting (steady grey)', () => {
    expect(deriveWorkerActivity('starting', undefined)).toBe('starting')
  })

  it('条件④: a running worker that lost its PTY → waiting, NOT a phantom working scan', () => {
    // No live beacon for a non-starting worker means the PTY is gone / idle and
    // the engine will reclaim it next pass — the band must fall to steady so it
    // stops the moment the worker stops, never keeps scanning on a dead PTY.
    expect(deriveWorkerActivity('running', undefined)).toBe('waiting')
    // An older engine that doesn't report a stage folds to running → same rule.
    expect(deriveWorkerActivity(undefined, undefined)).toBe('waiting')
  })
})

describe('deriveManagerTone', () => {
  it('a conflict outranks presence — the one state needing the owner wins the lamp', () => {
    expect(deriveManagerTone('working', 'conflict')).toBe('alert')
    expect(deriveManagerTone('quiet', 'conflict')).toBe('alert')
    expect(deriveManagerTone('missing', 'conflict')).toBe('alert')
    expect(deriveManagerTone('unknown', 'conflict')).toBe('alert')
  })

  it('otherwise the lamp tracks the commander (working=moss, quiet=ochre)', () => {
    expect(deriveManagerTone('working', 'ff')).toBe('working')
    expect(deriveManagerTone('working', 'rebase')).toBe('working')
    expect(deriveManagerTone('quiet', 'ff')).toBe('waiting')
    expect(deriveManagerTone('quiet', 'unknown')).toBe('waiting')
  })

  it('gone or unsaid → off (grey) for every non-conflict readiness', () => {
    expect(deriveManagerTone('missing', 'ff')).toBe('off')
    expect(deriveManagerTone('missing', 'rebase')).toBe('off')
    expect(deriveManagerTone('unknown', 'ff')).toBe('off')
    expect(deriveManagerTone('unknown', 'unknown')).toBe('off')
  })
})

// A worker's note is the WHAT half of "who is on this card and what are they
// doing". It is only true as of its heartbeat, so the card must be able to say
// three different things — and the third one is the one that is easy to get
// wrong: when we cannot date the note at all, we say nothing about it.
describe('deriveHeartbeatFreshness', () => {
  const now = Date.parse('2026-08-15T12:00:00.000Z')
  const ago = (ms: number) => new Date(now - ms).toISOString()

  it('a recent beat is fresh — the note describes NOW', () => {
    expect(deriveHeartbeatFreshness(ago(0), now)).toBe('fresh')
    expect(deriveHeartbeatFreshness(ago(5 * 60_000), now)).toBe('fresh')
    // The instant before the window closes is still fresh (the boundary is
    // inclusive on the stale side).
    expect(deriveHeartbeatFreshness(ago(WORKER_NOTE_STALE_MS - 1), now)).toBe('fresh')
  })

  it('a beat past the window is stale — the note describes the PAST', () => {
    expect(deriveHeartbeatFreshness(ago(WORKER_NOTE_STALE_MS), now)).toBe('stale')
    expect(deriveHeartbeatFreshness(ago(30 * 60_000), now)).toBe('stale')
  })

  it('no beat time we can read → none: we cannot date it, so we claim nothing', () => {
    // The honest third state. Folding either of these to 'fresh' would print an
    // undatable note as a statement about now; folding them to 'stale' would
    // claim we know it is old. We know neither.
    expect(deriveHeartbeatFreshness(undefined, now)).toBe('none')
    expect(deriveHeartbeatFreshness('', now)).toBe('none')
    expect(deriveHeartbeatFreshness('not a timestamp', now)).toBe('none')
  })

  it('a beat from the future (clock skew) is fresh, never stale', () => {
    // The engine clock and the browser clock are different clocks. A negative
    // age is not evidence that a worker went quiet.
    expect(deriveHeartbeatFreshness(new Date(now + 60_000).toISOString(), now)).toBe('fresh')
  })
})
