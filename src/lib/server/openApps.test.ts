import { describe, it, expect } from 'vitest'
import { normalizeOpenApps } from './openApps'

describe('normalizeOpenApps', () => {
  it('drops legacy string entries with an over-length name (>80 chars), matching object-shape behavior', () => {
    const longName = 'x'.repeat(10000)
    const fromString = normalizeOpenApps([longName])
    const fromObject = normalizeOpenApps([{ name: longName }])
    expect(fromString).toEqual([])
    expect(fromObject).toEqual([])
  })

  it('keeps legacy string entries within the length limit', () => {
    const name = 'My App'
    expect(normalizeOpenApps([name])).toEqual([{ name, mode: 'open' }])
  })

  it('keeps object entries within the length limit', () => {
    const name = 'My App'
    expect(normalizeOpenApps([{ name }])).toEqual([{ name, mode: 'open' }])
  })
})
