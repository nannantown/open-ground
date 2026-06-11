import type { Lang } from '@/i18n/messages'

// Pick the description matching the UI language. Preference order:
// 1. The generated language pair (descriptionJa / descriptionEn) — exact.
// 2. The legacy single-string field (hand-written or pre-bilingual data),
//    but ONLY when its detected language matches the UI language: a Japanese
//    blurb under an English UI (or vice versa) reads as a glitch, so a
//    mismatch renders as "no description yet" — the generate button shows
//    and one regeneration fills the proper pair.
// Kana is the discriminator: Japanese prose can't be written without it,
// and English never contains it. Kanji alone is deliberately NOT treated as
// Japanese (false positives on CJK names in English text).
// Shared by the panel (client, lang from I18nContext) and scan.ts (server,
// lang from settings.language) so the card and the panel always agree.

const HAS_KANA_RE = /[\u3040-\u30ff]/

/** 'ja' when the text contains kana, otherwise 'en'. Exported for tests. */
export const detectDescriptionLang = (text: string): Lang =>
  HAS_KANA_RE.test(text) ? 'ja' : 'en'

export const descriptionForLang = (
  d: { description: string; descriptionJa?: string; descriptionEn?: string },
  lang: Lang,
): string => {
  const exact = lang === 'ja' ? d.descriptionJa : d.descriptionEn
  if (exact) return exact
  const legacy = d.description
  if (!legacy) return ''
  return detectDescriptionLang(legacy) === lang ? legacy : ''
}
