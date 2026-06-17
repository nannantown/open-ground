import { describe, it, expect } from 'vitest'
import { nextRecents, MAX_RECENT_COLORS } from './recentColors'

describe('nextRecents', () => {
  it('prepends a new colour (canonicalised to #rrggbb)', () => {
    expect(nextRecents([], '#ff0000')).toEqual(['#ff0000'])
    expect(nextRecents([], 'rgb(255,0,0)')).toEqual(['#ff0000'])
    expect(nextRecents([], '#F00')).toEqual(['#ff0000'])
  })
  it('moves an existing colour to the front instead of duplicating', () => {
    expect(nextRecents(['#111111', '#222222'], '#222222')).toEqual(['#222222', '#111111'])
  })
  it('dedupes case-insensitively and across equivalent syntaxes', () => {
    expect(nextRecents(['#aabbcc'], 'rgb(170,187,204)')).toEqual(['#aabbcc'])
    expect(nextRecents(['#aabbcc'], '#AABBCC')).toEqual(['#aabbcc'])
  })
  it('preserves alpha as #rrggbbaa', () => {
    expect(nextRecents([], 'rgba(255,0,0,0.5)')).toEqual(['#ff000080'])
  })
  it('caps the list at MAX_RECENT_COLORS, dropping the oldest', () => {
    const start = Array.from({ length: MAX_RECENT_COLORS }, (_, i) =>
      `#0000${(i + 10).toString(16).padStart(2, '0')}`,
    )
    const out = nextRecents(start, '#ffffff')
    expect(out).toHaveLength(MAX_RECENT_COLORS)
    expect(out[0]).toBe('#ffffff')
    expect(out).not.toContain(start[start.length - 1]) // oldest dropped
  })
  it('ignores a no-fill / transparent colour (not worth remembering)', () => {
    expect(nextRecents(['#111111'], 'transparent')).toEqual(['#111111'])
    expect(nextRecents(['#111111'], 'rgba(0,0,0,0)')).toEqual(['#111111'])
    expect(nextRecents(['#111111'], '#00000000')).toEqual(['#111111'])
  })
  it('ignores an unparseable / named / gradient colour', () => {
    expect(nextRecents(['#111111'], 'rebeccapurple')).toEqual(['#111111'])
    expect(nextRecents(['#111111'], 'linear-gradient(#fff,#000)')).toEqual(['#111111'])
    expect(nextRecents([], '')).toEqual([])
  })
})
