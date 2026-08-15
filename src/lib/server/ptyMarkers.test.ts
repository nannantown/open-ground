// ptyMarkers — the extraction every marker-scraped `claude` run depends on.
//
// This file is a STRING function on purpose, so everything the real PTY does to
// an answer can be reproduced here exactly: the repaints, the mid-word style
// escapes, the cursor moves standing in for spaces, the prompt echoing its own
// placeholders back. Each case below is a shape that was OBSERVED live, not one
// that was imagined.

import { describe, it, expect } from 'vitest'
import { extractMarkerSpan, extractMarkerSpans, stripPtyAnsi } from './ptyMarkers'

const M = 'OPENGROUND_PERSONA_KEPT:'
const E = '::OG_PERSONA_END::'
const opts = { maxLen: 200, maxCount: 3 }

/** One finished marker line, as it lands in the buffer. */
const paint = (body: string): string => `${M} ${body} ${E}\r\n`

describe('extractMarkerSpans — the repaint problem', () => {
  it('ONE sentence painted five times is ONE result, not five', () => {
    // ⚠ THE FAILURE THIS EXISTS FOR. The claude TUI repaints its output, so a
    // finished line sits in the buffer several times over. Downstream this feeds
    // an APPEND-ONLY corpus: five identical rows cannot be un-written, and they
    // silently quintuple the weight of one sentence.
    const raw = paint('head|I decide fast and revisit later').repeat(5)
    expect(extractMarkerSpans(raw, M, E, opts)).toEqual([
      'head|I decide fast and revisit later',
    ])
  })

  it('counts DISTINCT spans against the cap, not paints', () => {
    // Capping before de-duplicating is the subtle half, and the repeated line
    // has to be the NEWEST one for the test to see it: the scan runs backward,
    // so three repaints of the LAST line fill maxCount=3 and the two real lines
    // ahead of it are never reached.
    const raw =
      paint('chest|two') + paint('arms|three') + paint('head|one').repeat(3)
    expect(extractMarkerSpans(raw, M, E, { ...opts, maxCount: 3 })).toEqual([
      'chest|two',
      'arms|three',
      'head|one',
    ])
  })

  it('treats two paints that WRAPPED DIFFERENTLY as the same line', () => {
    // Why the comparison happens after cleaning rather than on the raw slice:
    // the TUI re-wraps when it repaints, so the two paints of one sentence are
    // never byte-identical in the buffer — only after the whitespace collapse.
    const raw =
      `${M} head|a sentence long enough\r\n   to wrap ${E}\r\n` +
      `${M} head|a sentence   long enough to wrap ${E}\r\n`
    expect(extractMarkerSpans(raw, M, E, opts)).toEqual([
      'head|a sentence long enough to wrap',
    ])
  })

  it('keeps genuinely different lines, in the order they were emitted', () => {
    const raw = paint('head|first') + paint('chest|second')
    expect(extractMarkerSpans(raw, M, E, opts)).toEqual(['head|first', 'chest|second'])
  })

  it('when the model overruns the cap it is the LAST lines that survive', () => {
    // They follow its own final thinking, so they are the ones worth keeping.
    const raw = ['a', 'b', 'c', 'd'].map((k) => paint(`head|${k}`)).join('')
    expect(extractMarkerSpans(raw, M, E, { ...opts, maxCount: 2 })).toEqual([
      'head|c',
      'head|d',
    ])
  })

  it('discards the prompt echoing its own placeholder', () => {
    // The prompt rides the PTY too, so `KEPT: <region>|<sentence> END` is in the
    // buffer before the model has answered anything. A run that produced nothing
    // must read as nothing, never as the placeholder.
    const raw = `${M} <region>|<one sentence> ${E}\r\n`
    expect(extractMarkerSpans(raw, M, E, opts)).toEqual([])
    expect(extractMarkerSpan(raw, M, E, { maxLen: 200 })).toBeNull()
  })

  it('a rejected paint does not end the scan', () => {
    // The echo is printed AFTER nothing and the real answer arrives later, but
    // the reverse also happens; either way one unusable candidate must not make
    // a real one unreachable.
    const raw = paint('head|the real one') + `${M} <region>|<one sentence> ${E}\r\n`
    expect(extractMarkerSpans(raw, M, E, opts)).toEqual(['head|the real one'])
  })

  it('maxCount 0 reads nothing at all', () => {
    expect(extractMarkerSpans(paint('head|x'), M, E, { ...opts, maxCount: 0 })).toEqual([])
  })
})

describe('stripPtyAnsi — style deletes, positioning becomes a gap', () => {
  it('a mid-word style escape leaves the word intact', () => {
    expect(stripPtyAnsi('re\x1b[1md\x1b[0m apple')).toBe('red apple')
  })

  it('a cursor move becomes a SPACE, so words do not fuse', () => {
    // "ClaudeCodemissioncontrol" was observed live when these were deleted.
    expect(stripPtyAnsi('Claude\x1b[5CCode')).toBe('Claude Code')
  })

  it('a window-title write disappears with its terminator', () => {
    expect(stripPtyAnsi('\x1b]0;some title\x07after')).toBe('after')
  })
})
