import { describe, it, expect } from 'vitest'
import {
  MAX_PANE_TITLE_LEN,
  isDefaultSlotLabel,
  paneHeaderTitle,
  paneTooltip,
  sanitizePaneTitle,
} from './paneTitle'

describe('sanitizePaneTitle', () => {
  it('trims surrounding whitespace', () => {
    expect(sanitizePaneTitle('  fix login bug  ')).toBe('fix login bug')
  })

  it('returns null for empty / whitespace-only titles (keep previous)', () => {
    expect(sanitizePaneTitle('')).toBeNull()
    expect(sanitizePaneTitle('   ')).toBeNull()
    expect(sanitizePaneTitle('\t\n')).toBeNull()
  })

  it('caps overlong titles at MAX_PANE_TITLE_LEN', () => {
    const long = 'x'.repeat(MAX_PANE_TITLE_LEN + 50)
    const out = sanitizePaneTitle(long)
    expect(out).toHaveLength(MAX_PANE_TITLE_LEN)
    expect(out).toBe('x'.repeat(MAX_PANE_TITLE_LEN))
  })

  it('never leaves a lone surrogate when the cap splits an emoji', () => {
    // 199 ASCII chars, then an emoji (2 UTF-16 units) straddling the cut at
    // code unit 200, then padding past the cap.
    const long = 'x'.repeat(MAX_PANE_TITLE_LEN - 1) + '😀' + 'y'.repeat(10)
    const out = sanitizePaneTitle(long)!
    // The half-emoji is dropped, not kept as a lone surrogate.
    expect(out).toBe('x'.repeat(MAX_PANE_TITLE_LEN - 1))
    // A lone surrogate would make this throw (URIError: malformed).
    expect(() => encodeURIComponent(out)).not.toThrow()
  })

  it('keeps an emoji that fits entirely under the cap', () => {
    const long = '😀' + 'x'.repeat(MAX_PANE_TITLE_LEN + 10)
    const out = sanitizePaneTitle(long)!
    expect(out.startsWith('😀')).toBe(true)
    expect(out).toHaveLength(MAX_PANE_TITLE_LEN)
    expect(() => encodeURIComponent(out)).not.toThrow()
  })

  it('passes a normal title through unchanged', () => {
    expect(sanitizePaneTitle('claude — summarising tests')).toBe(
      'claude — summarising tests',
    )
  })
})

describe('isDefaultSlotLabel', () => {
  it('matches auto-generated "Terminal N" labels only', () => {
    expect(isDefaultSlotLabel('Terminal 1')).toBe(true)
    expect(isDefaultSlotLabel('Terminal 42')).toBe(true)
    expect(isDefaultSlotLabel('my server')).toBe(false)
    expect(isDefaultSlotLabel('Terminal')).toBe(false)
    expect(isDefaultSlotLabel('Terminal 1x')).toBe(false)
  })
})

describe('paneHeaderTitle', () => {
  it('prefers the OSC title over an auto-generated label', () => {
    expect(paneHeaderTitle('topic summary', 'Terminal 2')).toBe('topic summary')
  })

  it('a user rename always wins over the OSC title', () => {
    expect(paneHeaderTitle('topic summary', 'my server')).toBe('my server')
  })

  it('falls back to the label when no OSC title arrived', () => {
    expect(paneHeaderTitle(undefined, 'Terminal 2')).toBe('Terminal 2')
  })

  it('falls back to the label for empty / whitespace OSC titles', () => {
    expect(paneHeaderTitle('', 'Terminal 2')).toBe('Terminal 2')
    expect(paneHeaderTitle('  ', 'Terminal 2')).toBe('Terminal 2')
  })
})

describe('paneTooltip', () => {
  it('shows both lines when OSC title and label differ', () => {
    expect(paneTooltip('topic', 'Terminal 1')).toBe('topic\nTerminal 1')
  })

  it('dedupes when they are identical', () => {
    expect(paneTooltip('Terminal 1', 'Terminal 1')).toBe('Terminal 1')
  })

  it('shows just the label when no OSC title arrived', () => {
    expect(paneTooltip(undefined, 'Terminal 1')).toBe('Terminal 1')
  })
})
