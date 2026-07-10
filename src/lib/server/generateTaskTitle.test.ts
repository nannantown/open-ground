import { describe, it, expect } from 'vitest'
import {
  buildTitlePrompt,
  extractTitle,
  MAX_TITLE_LEN,
  TITLE_MARKER,
  TITLE_END,
} from './generateTaskTitle'

// Marker-PAIR contract for the haiku auto-title, scraped from the raw PTY
// stream (claude ≥2.1.169 writes no one-off session JSONL): the title is the
// text between `OPENGROUND_TITLE:` and `::OG_END::`, last pair wins, no prose
// fallback, and the prompt's own echoed `<the title>` placeholder never
// matches (candidates containing '<' are rejected).

const pair = (title: string) => `${TITLE_MARKER} ${title} ${TITLE_END}`

describe('extractTitle', () => {
  it('takes the text between the marker pair, trimmed', () => {
    expect(extractTitle(`noise\n${pair('Account settings page を実装')}\n`)).toBe(
      'Account settings page を実装',
    )
  })

  it('survives TUI junk glued onto the same raw line', () => {
    expect(
      extractTitle(`⏺${TITLE_MARKER} Fix login flow ${TITLE_END}✻ Processing… (2s · thinking)`),
    ).toBe('Fix login flow')
  })

  it('rejects the echoed prompt placeholder; a later real pair still wins', () => {
    const echoed = `❯ Output exactly: ${TITLE_MARKER} <the title> ${TITLE_END}`
    expect(extractTitle(echoed)).toBeNull()
    expect(extractTitle(`${echoed}\n…\n${pair('Real title')}`)).toBe('Real title')
  })

  it('last pair wins when the TUI repaints the answer', () => {
    expect(extractTitle(`${pair('first')}\nredraw\n${pair('second')}`)).toBe('second')
  })

  it('returns null without the END token (mid-stream) or without any marker', () => {
    expect(extractTitle(`${TITLE_MARKER} still strea`)).toBeNull()
    expect(extractTitle('Sure! A good title would be: Fix the login flow')).toBeNull()
    expect(extractTitle('')).toBeNull()
  })

  it('collapses a column-boundary line wrap inside the title', () => {
    expect(extractTitle(`${TITLE_MARKER} Fix the\n   login flow ${TITLE_END}`)).toBe(
      'Fix the login flow',
    )
  })

  it('strips wrapping quotes (ASCII and Japanese) and ANSI/OSC noise', () => {
    expect(extractTitle(pair('"Fix login"'))).toBe('Fix login')
    expect(extractTitle(pair('「ログイン修正」'))).toBe('ログイン修正')
    expect(extractTitle(`\x1b[32m${pair('Fix login')}\x1b[0m\x1b]0;title\x07`)).toBe('Fix login')
  })

  it(`caps the title at ${MAX_TITLE_LEN} chars`, () => {
    expect(extractTitle(pair('x'.repeat(200)))).toHaveLength(MAX_TITLE_LEN)
  })
})

describe('buildTitlePrompt', () => {
  it('embeds the content and the marker-pair contract', () => {
    const p = buildTitlePrompt('Create a new sub route under account.')
    expect(p).toContain('Create a new sub route under account.')
    expect(p).toContain(`${TITLE_MARKER} <the title> ${TITLE_END}`)
    expect(p).toContain('Same language')
  })

  // extractTitle rejects every candidate containing '<', so the prompt must ban
  // angle brackets or a legitimate title is silently dropped. Same contract as
  // buildDescribePrompt — keep both halves in sync.
  it('forbids angle brackets in the answer — the other half of the extractor guard', () => {
    expect(buildTitlePrompt('x')).toMatch(/no angle brackets/i)
  })

  it('caps over-long content instead of shipping it whole', () => {
    const p = buildTitlePrompt('y'.repeat(10_000))
    expect(p.length).toBeLessThan(4_000)
  })
})
