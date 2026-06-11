import { describe, it, expect } from 'vitest'
import { descriptionForLang, detectDescriptionLang } from './descriptionLang'

describe('detectDescriptionLang', () => {
  it('kana means Japanese', () => {
    expect(detectDescriptionLang('Claude Code を束ねるアプリ')).toBe('ja')
    expect(detectDescriptionLang('カタカナのみ')).toBe('ja')
  })

  it('no kana means English (kanji alone is not Japanese)', () => {
    expect(detectDescriptionLang('A cockpit for Claude Code.')).toBe('en')
    expect(detectDescriptionLang('Tokyo 東京 office dashboard')).toBe('en')
  })
})

describe('descriptionForLang', () => {
  const d = {
    description: 'legacy single',
    descriptionJa: '日本語の説明',
    descriptionEn: 'English description',
  }

  it('picks the matching language from the generated pair', () => {
    expect(descriptionForLang(d, 'ja')).toBe('日本語の説明')
    expect(descriptionForLang(d, 'en')).toBe('English description')
  })

  it('falls back to the legacy field only when its language matches the UI', () => {
    expect(descriptionForLang({ description: '日本語だけの旧データ' }, 'ja')).toBe(
      '日本語だけの旧データ',
    )
    expect(descriptionForLang({ description: 'English-only legacy' }, 'en')).toBe(
      'English-only legacy',
    )
  })

  it('HIDES a legacy description whose language mismatches the UI', () => {
    // The user reads it as a glitch ("English UI, Japanese blurb?") — render
    // as no-description-yet so the generate button shows instead.
    expect(descriptionForLang({ description: '日本語だけの旧データ' }, 'en')).toBe('')
    expect(descriptionForLang({ description: 'English-only legacy' }, 'ja')).toBe('')
  })

  it('falls back per-side (one language of the pair missing)', () => {
    expect(
      descriptionForLang({ description: '日本語の旧説明', descriptionEn: 'EN only' }, 'ja'),
    ).toBe('日本語の旧説明')
    expect(
      descriptionForLang({ description: '日本語の旧説明', descriptionEn: 'EN only' }, 'en'),
    ).toBe('EN only')
  })

  it('treats an empty-string side as missing', () => {
    expect(descriptionForLang({ description: '日本語の旧説明', descriptionJa: '' }, 'ja')).toBe(
      '日本語の旧説明',
    )
  })

  it('returns empty for an empty description', () => {
    expect(descriptionForLang({ description: '' }, 'ja')).toBe('')
  })
})
