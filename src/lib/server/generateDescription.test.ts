import { describe, it, expect } from 'vitest'
import {
  extractDescMarker,
  extractMarkerPair,
  buildDescribePrompt,
  DESC_MARKER_EN,
  DESC_MARKER_JA,
  DESC_END,
  MAX_DESC_LEN,
} from './generateDescription'

const pairOutput = [
  'some TUI noise',
  `${DESC_MARKER_EN} A local cockpit for Claude Code. ${DESC_END}`,
  `${DESC_MARKER_JA} Claude Code のローカルコックピット。 ${DESC_END}`,
].join('\n')

describe('extractDescMarker (PTY stream)', () => {
  it('pulls the text between marker and end token', () => {
    expect(extractDescMarker(pairOutput, DESC_MARKER_EN)).toBe(
      'A local cockpit for Claude Code.',
    )
    expect(extractDescMarker(pairOutput, DESC_MARKER_JA)).toBe(
      'Claude Code のローカルコックピット。',
    )
  })

  it('requires the end token — a bare marker line is mid-stream, not an answer', () => {
    expect(extractDescMarker(`${DESC_MARKER_EN} partial text`, DESC_MARKER_EN)).toBeNull()
  })

  it("skips the prompt's own echoed placeholder (contains '<')", () => {
    const echoed = [
      `${DESC_MARKER_EN} <ONE short sentence in English — what the project is> ${DESC_END}`,
      `${DESC_MARKER_EN} The real answer. ${DESC_END}`,
    ].join('\n')
    expect(extractDescMarker(echoed, DESC_MARKER_EN)).toBe('The real answer.')
    // Echo only — nothing usable.
    expect(
      extractDescMarker(`${DESC_MARKER_EN} <placeholder> ${DESC_END}`, DESC_MARKER_EN),
    ).toBeNull()
  })

  it('takes the LAST pair when the TUI repaints the line several times', () => {
    const repainted = [
      `${DESC_MARKER_EN} stale paint ${DESC_END}`,
      `${DESC_MARKER_EN} final paint ${DESC_END}`,
    ].join('\n')
    expect(extractDescMarker(repainted, DESC_MARKER_EN)).toBe('final paint')
  })

  it('strips ANSI sequences and collapses a PTY line-wrap to one space', () => {
    const wrapped = `${DESC_MARKER_EN} \x1b[1mBold\x1b[0m start\n   wrapped tail ${DESC_END}`
    expect(extractDescMarker(wrapped, DESC_MARKER_EN)).toBe('Bold start wrapped tail')
  })

  it('treats TUI cursor moves (CSI n C / CUP) as word gaps', () => {
    // Real-world failure: the TUI positioned words with cursor moves instead
    // of spaces and the answer came back as "ClaudeCodemissioncontrol".
    const fwd = `${DESC_MARKER_EN} Claude\x1b[2CCode\x1b[1Cmission ${DESC_END}`
    expect(extractDescMarker(fwd, DESC_MARKER_EN)).toBe('Claude Code mission')
    const cup = `${DESC_MARKER_EN} Local\x1b[3;42Hmission\x1b[3;50Hcontrol ${DESC_END}`
    expect(extractDescMarker(cup, DESC_MARKER_EN)).toBe('Local mission control')
  })

  it('SGR (style) sequences delete WITHOUT injecting a word gap', () => {
    const midWord = `${DESC_MARKER_EN} re\x1b[1md\x1b[0m apple ${DESC_END}`
    expect(extractDescMarker(midWord, DESC_MARKER_EN)).toBe('red apple')
  })

  it('caps runaway text at MAX_DESC_LEN', () => {
    const long = 'x'.repeat(MAX_DESC_LEN + 100)
    expect(extractDescMarker(`${DESC_MARKER_EN} ${long} ${DESC_END}`, DESC_MARKER_EN)).toHaveLength(
      MAX_DESC_LEN,
    )
  })
})

describe('extractMarkerPair', () => {
  it('returns both languages when both landed', () => {
    expect(extractMarkerPair(pairOutput)).toEqual({
      en: 'A local cockpit for Claude Code.',
      ja: 'Claude Code のローカルコックピット。',
    })
  })

  it('returns null for the missing side', () => {
    const enOnly = `${DESC_MARKER_EN} English only. ${DESC_END}`
    expect(extractMarkerPair(enOnly)).toEqual({ en: 'English only.', ja: null })
    expect(extractMarkerPair('no markers at all')).toEqual({ en: null, ja: null })
  })

  it('the language-tagged markers never cross-match each other', () => {
    const jaOnly = `${DESC_MARKER_JA} 日本語のみ。 ${DESC_END}`
    expect(extractMarkerPair(jaOnly).en).toBeNull()
  })
})

describe('buildDescribePrompt', () => {
  it('contains both marker lines with the end token and the read-only rules', () => {
    const p = buildDescribePrompt()
    expect(p).toContain(DESC_MARKER_EN)
    expect(p).toContain(DESC_MARKER_JA)
    expect(p).toContain(DESC_END)
    expect(p).toContain('.openground/')
    expect(p).toMatch(/read-only/i)
  })
})
