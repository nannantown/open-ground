import { describe, it, expect } from 'vitest'
import { pickReleaseNotesLang } from './releaseNotesLang'

const BILINGUAL = `### English
- Faster terminal.
- Bug fixes.

### 日本語
- ターミナルを高速化。
- バグ修正。
`

describe('pickReleaseNotesLang', () => {
  it('returns only the requested section of a bilingual body', () => {
    expect(pickReleaseNotesLang(BILINGUAL, 'en')).toBe('- Faster terminal.\n- Bug fixes.')
    expect(pickReleaseNotesLang(BILINGUAL, 'ja')).toBe('- ターミナルを高速化。\n- バグ修正。')
  })

  it('handles the sections in either order', () => {
    const flipped = `### 日本語\nJA本文\n\n### English\nEN body\n`
    expect(pickReleaseNotesLang(flipped, 'en')).toBe('EN body')
    expect(pickReleaseNotesLang(flipped, 'ja')).toBe('JA本文')
  })

  it('returns the whole body when only one language heading exists', () => {
    const single = `### English\nEN only notes\n`
    expect(pickReleaseNotesLang(single, 'ja')).toBe(single.trim())
  })

  it('returns plain (heading-less) bodies untouched', () => {
    expect(pickReleaseNotesLang('Just some notes.', 'ja')).toBe('Just some notes.')
    expect(pickReleaseNotesLang('', 'en')).toBe('')
  })
})
