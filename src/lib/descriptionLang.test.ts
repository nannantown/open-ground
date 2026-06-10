import { describe, it, expect } from 'vitest'
import { descriptionForLang } from './descriptionLang'

describe('descriptionForLang', () => {
  const d = {
    description: 'legacy single',
    descriptionJa: '日本語の説明',
    descriptionEn: 'English description',
  }

  it('picks the matching language', () => {
    expect(descriptionForLang(d, 'ja')).toBe('日本語の説明')
    expect(descriptionForLang(d, 'en')).toBe('English description')
  })

  it('falls back to the legacy field when the pair is absent', () => {
    expect(descriptionForLang({ description: 'only this' }, 'ja')).toBe('only this')
    expect(descriptionForLang({ description: 'only this' }, 'en')).toBe('only this')
  })

  it('falls back per-side (one language missing)', () => {
    expect(
      descriptionForLang({ description: 'fallback', descriptionEn: 'EN only' }, 'ja'),
    ).toBe('fallback')
    expect(
      descriptionForLang({ description: 'fallback', descriptionEn: 'EN only' }, 'en'),
    ).toBe('EN only')
  })

  it('treats an empty-string side as missing', () => {
    expect(
      descriptionForLang({ description: 'fallback', descriptionJa: '' }, 'ja'),
    ).toBe('fallback')
  })
})
