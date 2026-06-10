import { describe, it, expect } from 'vitest'
import {
  extractDescription,
  extractMarkerPair,
  buildDescribePrompt,
  DESC_MARKER,
  DESC_MARKER_EN,
  DESC_MARKER_JA,
} from './generateDescription'

describe('extractDescription', () => {
  it('pulls the description out of an OPENGROUND_DESC marker line', () => {
    const transcript = [
      '▶ session started · claude-opus',
      'READMEを確認しています。',
      'package.json を読みました。',
      `${DESC_MARKER} ローカルで動く Claude Code のコックピット。プロジェクトをカードで一覧し実行できる。`,
    ].join('\n')
    expect(extractDescription(transcript)).toBe(
      'ローカルで動く Claude Code のコックピット。プロジェクトをカードで一覧し実行できる。',
    )
  })

  it('picks the LAST marker when several appear (echoed instruction)', () => {
    const transcript = [
      `${DESC_MARKER} <ここに説明>`, // an echo of the instruction
      'いろいろ調べています…',
      `${DESC_MARKER} 実際の説明です。`,
    ].join('\n')
    expect(extractDescription(transcript)).toBe('実際の説明です。')
  })

  it('strips ANSI escape sequences from the marker text', () => {
    const transcript = `${DESC_MARKER} \x1b[1m太字の\x1b[0m説明文。`
    expect(extractDescription(transcript)).toBe('太字の説明文。')
  })

  it('handles the marker appearing mid-line (prefixed by other text)', () => {
    const transcript = `最終行: ${DESC_MARKER} 末尾の説明。`
    expect(extractDescription(transcript)).toBe('末尾の説明。')
  })

  it('caps an over-long description at 300 chars', () => {
    const long = 'あ'.repeat(500)
    const out = extractDescription(`${DESC_MARKER} ${long}`)
    expect(out).not.toBeNull()
    expect(out!.length).toBe(300)
  })

  it('falls back to the last non-empty line when no marker is present', () => {
    const transcript = [
      'README を読みました。',
      '',
      'これはタスク管理ツールです。',
      '   ',
    ].join('\n')
    expect(extractDescription(transcript)).toBe('これはタスク管理ツールです。')
  })

  it('caps the fallback line at 300 chars too', () => {
    const out = extractDescription('い'.repeat(400))
    expect(out!.length).toBe(300)
  })

  it('returns null when the transcript is empty / whitespace-only', () => {
    expect(extractDescription('')).toBeNull()
    expect(extractDescription('   \n  \n')).toBeNull()
  })

  it('ignores an empty marker (no text after it) and falls back', () => {
    const transcript = [
      'これは CLI ツールです。',
      `${DESC_MARKER}   `, // marker with only whitespace after it
    ].join('\n')
    // The marker line has no usable text → fallback to last non-empty line,
    // which (after stripping the empty marker) is the prose above it.
    expect(extractDescription(transcript)).toBe('これは CLI ツールです。')
  })
})

describe('buildDescribePrompt', () => {
  it('forbids edits and demands BOTH language markers + .openground rule', async () => {
    const p = await buildDescribePrompt()
    expect(p).toContain(DESC_MARKER_EN)
    expect(p).toContain(DESC_MARKER_JA)
    expect(p).toContain('.openground/')
    expect(p).toMatch(/edit|create|delete/)
  })
})

describe('extractMarkerPair', () => {
  it('pulls both language lines independently', () => {
    const transcript = [
      'exploring…',
      `${DESC_MARKER_EN} A local cockpit for Claude Code.`,
      `${DESC_MARKER_JA} ローカルで動く Claude Code のコックピット。`,
    ].join('\n')
    expect(extractMarkerPair(transcript)).toEqual({
      en: 'A local cockpit for Claude Code.',
      ja: 'ローカルで動く Claude Code のコックピット。',
    })
  })

  it('returns null per missing side (mid-stream poll)', () => {
    const transcript = `${DESC_MARKER_EN} English landed first.`
    expect(extractMarkerPair(transcript)).toEqual({
      en: 'English landed first.',
      ja: null,
    })
  })

  it('the legacy untagged marker never bleeds into the tagged lookups', () => {
    const transcript = `${DESC_MARKER} 旧形式のひとこと説明。`
    expect(extractMarkerPair(transcript)).toEqual({ en: null, ja: null })
    expect(extractDescription(transcript)).toBe('旧形式のひとこと説明。')
  })
})
