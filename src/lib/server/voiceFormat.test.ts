import { describe, it, expect } from 'vitest'
import {
  buildVoicePrompt,
  extractVoiceFormatted,
  VOICE_MARKER,
  VOICE_END,
} from './voiceFormat'

// Marker-PAIR contract for the voice-transcript cleanup, scraped from the raw
// PTY stream (claude ≥2.1.169 writes no one-off session JSONL): the cleaned
// text is everything between `OPENGROUND_VOICE:` and `::OG_VOICE_END::`, last
// pair wins, MULTI-LINE text is preserved, and the prompt's own echoed
// `<the cleaned text>` placeholder never matches (candidates containing '<'
// are rejected). Pure-function tests only — no claude PTY is spawned.

const pair = (text: string) => `${VOICE_MARKER}\n${text}\n${VOICE_END}`

describe('extractVoiceFormatted', () => {
  it('takes the text between the marker pair, trimmed', () => {
    expect(extractVoiceFormatted(`noise\n${pair('ログイン画面のバグを直して。')}\n`)).toBe(
      'ログイン画面のバグを直して。',
    )
  })

  it('preserves newlines between the markers, trimming each line', () => {
    expect(extractVoiceFormatted(pair('First sentence.   \n  Second sentence.'))).toBe(
      'First sentence.\nSecond sentence.',
    )
  })

  it('survives TUI junk glued onto the same raw line', () => {
    expect(
      extractVoiceFormatted(
        `⏺${VOICE_MARKER} Fix the login flow. ${VOICE_END}✻ Processing… (2s · thinking)`,
      ),
    ).toBe('Fix the login flow.')
  })

  it('rejects the echoed prompt placeholder; a later real pair still wins', () => {
    const echoed = `❯ ${VOICE_MARKER}\n<the cleaned text>\n${VOICE_END}`
    expect(extractVoiceFormatted(echoed)).toBeNull()
    expect(extractVoiceFormatted(`${echoed}\n…\n${pair('Real text.')}`)).toBe('Real text.')
  })

  it('last pair wins when the TUI repaints the answer', () => {
    expect(extractVoiceFormatted(`${pair('first draft')}\nredraw\n${pair('final text')}`)).toBe(
      'final text',
    )
  })

  it('returns null without the END token (mid-stream) or without any marker', () => {
    expect(extractVoiceFormatted(`${VOICE_MARKER} still strea`)).toBeNull()
    expect(extractVoiceFormatted('Sure! Here is the cleaned text: Fix the login.')).toBeNull()
    expect(extractVoiceFormatted('')).toBeNull()
  })

  it('strips ANSI/OSC noise around and inside the pair', () => {
    expect(
      extractVoiceFormatted(`\x1b[32m${pair('Fix login.')}\x1b[0m\x1b]0;title\x07`),
    ).toBe('Fix login.')
    expect(
      extractVoiceFormatted(pair('\x1b[1m音声入力\x1b[0mを整形する。')),
    ).toBe('音声入力を整形する。')
  })

  it('drops \\r and other control chars but keeps the line structure', () => {
    expect(extractVoiceFormatted(pair('line one.\r\nline\x07 two.'))).toBe(
      'line one.\nline two.',
    )
  })
})

describe('buildVoicePrompt', () => {
  it('embeds the raw text and the marker-pair contract', () => {
    const p = buildVoicePrompt('fix the loggin flow', { language: 'en' })
    expect(p).toContain('fix the loggin flow')
    expect(p).toContain(VOICE_MARKER)
    expect(p).toContain(VOICE_END)
    expect(p).toContain('Do NOT add meaning')
  })

  it('states the output language from opts', () => {
    expect(buildVoicePrompt('x', { language: 'ja' })).toContain('Japanese')
    expect(buildVoicePrompt('x', { language: 'en' })).toContain('English')
  })

  it('mentions the project name only when given', () => {
    expect(buildVoicePrompt('x', { language: 'ja', projectName: 'OPEN GROUND' })).toContain(
      '"OPEN GROUND" project',
    )
    expect(buildVoicePrompt('x', { language: 'ja' })).not.toContain('project —')
  })

  it('caps over-long raw input at 8000 chars instead of shipping it whole', () => {
    const p = buildVoicePrompt('y'.repeat(20_000), { language: 'en' })
    expect(p.length).toBeLessThan(10_000)
  })
})
