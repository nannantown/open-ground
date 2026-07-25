import { describe, it, expect } from 'vitest'
import { contextFillPct, contextLevel, FOOTNOTE_OVER_LEFT_PCT } from './contextGauge'
import { USAGE_WARN_PCT } from './usageThresholds'

describe('contextFillPct — "% free" → "% full"', () => {
  it('inverts the reading', () => {
    expect(contextFillPct(100)).toBe(0)
    expect(contextFillPct(81)).toBe(19)
    expect(contextFillPct(0)).toBe(100)
  })

  it('clamps out-of-range readings so the bar cannot overflow', () => {
    expect(contextFillPct(140)).toBe(0)
    expect(contextFillPct(-20)).toBe(100)
  })

  it('rounds to a whole percent', () => {
    expect(contextFillPct(80.4)).toBe(20)
  })
})

describe('contextLevel — JSONL scale (free space in the 200k window)', () => {
  it('is idle with no reading — never a false green', () => {
    expect(contextLevel(null, 'jsonl')).toBe('idle')
    expect(contextLevel(undefined, 'jsonl')).toBe('idle')
    expect(contextLevel(Number.NaN, 'jsonl')).toBe('idle')
  })

  it('is green while there is room', () => {
    expect(contextLevel(81, 'jsonl')).toBe('ok')
    expect(contextLevel(21, 'jsonl')).toBe('ok')
  })

  it('turns amber at the shared quota boundary (80% full = 20% left)', () => {
    expect(contextLevel(100 - USAGE_WARN_PCT, 'jsonl')).toBe('warn')
    expect(contextLevel(5, 'jsonl')).toBe('warn')
  })

  it('turns red only when the window is full', () => {
    expect(contextLevel(0, 'jsonl')).toBe('over')
  })

  it('defaults to the JSONL scale when no source is given (pre-source servers)', () => {
    expect(contextLevel(81)).toBe('ok')
    expect(contextLevel(10)).toBe('warn')
  })
})

describe('contextLevel — footnote scale (distance to auto-compact)', () => {
  // The hand-off from the card-2 integration review: the same number means
  // something else here. 40 from JSONL is comfortable; 40 from the footnote
  // means auto-compact is in sight — claude only paints it near the threshold.
  it('never reads green, however comfortable the number looks', () => {
    expect(contextLevel(40, 'footnote')).toBe('warn')
    expect(contextLevel(81, 'footnote')).toBe('warn')
    // Same input, opposite verdict on the other scale — the polarity guard.
    expect(contextLevel(81, 'jsonl')).toBe('ok')
  })

  it('turns red once the threshold is close', () => {
    expect(contextLevel(FOOTNOTE_OVER_LEFT_PCT, 'footnote')).toBe('over')
    expect(contextLevel(3, 'footnote')).toBe('over')
    expect(contextLevel(FOOTNOTE_OVER_LEFT_PCT + 1, 'footnote')).toBe('warn')
  })

  it('is still idle with no reading', () => {
    expect(contextLevel(null, 'footnote')).toBe('idle')
  })
})
