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

  it('shows surviving text even across a language mismatch — never blank over something', () => {
    // Owner, 2026-08-18: 「気がついたら生成した説明が消えている」. The first cut
    // blanked a mismatched legacy string — and every real pair-loss (the
    // 2026-06〜08 schema-strip window, the recovery-read drop) then rendered
    // as VANISHED data instead of wrong-language data. A wrong-language line
    // reads odd; a disappeared one reads as loss. Show what survives.
    expect(descriptionForLang({ description: '日本語だけの旧データ' }, 'en')).toBe(
      '日本語だけの旧データ',
    )
    expect(descriptionForLang({ description: 'English-only legacy' }, 'ja')).toBe(
      'English-only legacy',
    )
    // …and a one-sided PAIR shows its surviving side under the other UI too.
    expect(descriptionForLang({ description: '', descriptionEn: 'EN only' }, 'ja')).toBe('EN only')
    expect(descriptionForLang({ description: '', descriptionJa: '日本語のみ' }, 'en')).toBe(
      '日本語のみ',
    )
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
