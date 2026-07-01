import { describe, it, expect } from 'vitest'
import { usageLevel, USAGE_WARN_PCT, USAGE_OVER_PCT } from './usageThresholds'

// The budget gauge's whole point is the colour transition: green → amber at
// 80%, amber → red at 100% ("80%で黄・100%で赤"). This pins the exact
// boundaries so a refactor can't silently move them (the old HUD turned red at
// 95, which this spec deliberately changes to 100).
describe('usageLevel — budget gauge thresholds', () => {
  it('null / undefined / non-finite → idle (no reading yet)', () => {
    expect(usageLevel(null)).toBe('idle')
    expect(usageLevel(undefined)).toBe('idle')
    expect(usageLevel(NaN)).toBe('idle')
    // Number.isFinite(Infinity) === false, so it falls into the idle branch too
    // rather than being mistaken for "way over the cap".
    expect(usageLevel(Infinity)).toBe('idle')
  })

  it('below 80 → ok (green)', () => {
    expect(usageLevel(0)).toBe('ok')
    expect(usageLevel(1)).toBe('ok')
    expect(usageLevel(79)).toBe('ok')
    expect(usageLevel(79.99)).toBe('ok')
  })

  it('80 up to (but not including) 100 → warn (amber)', () => {
    expect(usageLevel(80)).toBe('warn')
    expect(usageLevel(90)).toBe('warn')
    // 95 was red under the old HUD; the spec moves the red line to 100.
    expect(usageLevel(95)).toBe('warn')
    expect(usageLevel(99.99)).toBe('warn')
  })

  it('100 and above → over (red)', () => {
    expect(usageLevel(100)).toBe('over')
    expect(usageLevel(101)).toBe('over')
    expect(usageLevel(150)).toBe('over')
  })

  it('exposes the spec boundaries as constants', () => {
    expect(USAGE_WARN_PCT).toBe(80)
    expect(USAGE_OVER_PCT).toBe(100)
  })
})
