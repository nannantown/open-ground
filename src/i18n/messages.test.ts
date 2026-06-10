import { describe, it, expect } from 'vitest'
import { messages } from './messages'

// Guards the core i18n invariant: English is the source of truth and every
// English key must have a Japanese counterpart (and vice-versa). A drift here
// means a string renders in the fallback language for one locale — the kind of
// bug that's invisible until someone switches languages. The namespaced stub
// files are filled independently, so this cross-check is the safety net.
describe('i18n message dictionary', () => {
  it('has identical key sets for en and ja', () => {
    const en = Object.keys(messages.en).sort()
    const ja = Object.keys(messages.ja).sort()
    const missingInJa = en.filter(k => !messages.ja[k])
    const missingInEn = ja.filter(k => !messages.en[k])
    expect({ missingInJa, missingInEn }).toEqual({ missingInJa: [], missingInEn: [] })
    expect(ja).toEqual(en)
  })

  it('has no empty translation values', () => {
    const empties = (['en', 'ja'] as const).flatMap(lang =>
      Object.entries(messages[lang])
        .filter(([, v]) => typeof v !== 'string' || v.length === 0)
        .map(([k]) => `${lang}:${k}`),
    )
    expect(empties).toEqual([])
  })

  it('has a non-trivial number of translated keys', () => {
    // Sanity floor so an accidental empty-merge regression is caught.
    expect(Object.keys(messages.en).length).toBeGreaterThan(150)
  })
})
