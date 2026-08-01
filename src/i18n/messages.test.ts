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

  // Messages render as PLAIN TEXT — no markdown pass anywhere. Writing `**bold**`
  // therefore puts literal asterisks on screen, which is exactly what shipped in
  // the runtime-switch hints until an isolated preview caught it (2026-07-31).
  // The eye that catches this is not always looking; a test always is.
  it('has no markdown emphasis — it would render as literal asterisks', () => {
    const offenders = (['en', 'ja'] as const).flatMap((lang) =>
      Object.entries(messages[lang])
        .filter(([, v]) => typeof v === 'string' && /\*\*\S/.test(v))
        .map(([k]) => `${lang}:${k}`),
    )
    expect(offenders).toEqual([])
  })

  // A `{placeholder}` only disappears if a caller passes that exact var. en and ja
  // are written separately, so one locale losing a placeholder the other keeps is
  // a live failure mode: the caller passes `count`, and the locale missing it
  // silently drops the number the sentence was built around.
  it('uses the same {placeholders} in both locales', () => {
    // Array.from, not spread: the repo's tsconfig has no downlevelIteration, so
    // spreading a RegExpStringIterator does not type-check.
    const varsOf = (s: string) => Array.from(s.matchAll(/\{(\w+)\}/g), (m) => m[1]).sort()
    const mismatched = Object.keys(messages.en)
      .filter((k) => {
        const en = messages.en[k]
        const ja = messages.ja[k]
        if (typeof en !== 'string' || typeof ja !== 'string') return false
        return JSON.stringify(varsOf(en)) !== JSON.stringify(varsOf(ja))
      })
      .map((k) => `${k} — en:[${varsOf(String(messages.en[k]))}] ja:[${varsOf(String(messages.ja[k]))}]`)
    expect(mismatched).toEqual([])
  })
})
