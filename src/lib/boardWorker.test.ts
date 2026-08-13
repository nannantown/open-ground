import { describe, it, expect } from 'vitest'
import { deriveManagerTone, deriveWorkerActivity } from './boardWorker'

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
