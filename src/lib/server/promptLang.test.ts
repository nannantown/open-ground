import { describe, it, expect } from 'vitest'
import { pick, langOf, languageDirective } from './promptLang'

describe('promptLang', () => {
  describe('langOf', () => {
    it('resolves ja only when Settings.language is exactly "ja"', () => {
      expect(langOf({ language: 'ja' })).toBe('ja')
    })
    it('defaults to en for unset/anything else (English-first)', () => {
      expect(langOf({})).toBe('en')
      expect(langOf({ language: 'en' })).toBe('en')
      // @ts-expect-error — defensive: an unexpected value must still fall back to en, never throw.
      expect(langOf({ language: 'fr' })).toBe('en')
    })
  })

  describe('pick', () => {
    it('selects the en/ja variant by lang', () => {
      expect(pick('en', { en: 'a', ja: 'b' })).toBe('a')
      expect(pick('ja', { en: 'a', ja: 'b' })).toBe('b')
    })
  })

  describe('languageDirective', () => {
    it('en variant is written in English and names the language', () => {
      const d = languageDirective('en')
      expect(d).toMatch(/English/)
      expect(d).not.toMatch(/[぀-ヿ一-鿿]/) // no kana/kanji
    })
    it('ja variant is written in Japanese', () => {
      const d = languageDirective('ja')
      expect(d).toMatch(/日本語/)
    })
    it('is a single line (delivery contract: the whole prompt is one slash-command argument)', () => {
      expect(languageDirective('en')).not.toContain('\n')
      expect(languageDirective('ja')).not.toContain('\n')
    })
    it('en and ja variants differ', () => {
      expect(languageDirective('en')).not.toBe(languageDirective('ja'))
    })
  })
})
