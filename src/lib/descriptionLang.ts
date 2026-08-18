import type { Lang } from '@/i18n/messages'

// Pick the description matching the UI language. Preference order:
// 1. The generated language pair (descriptionJa / descriptionEn) — exact.
// 2. The legacy single-string field when its detected language matches.
// 3. ANY surviving text — the other pair side, then the legacy string
//    regardless of language.
//
// ⚠ RULE 3 IS THE OWNER'S, 2026-08-18: 「気がついたら生成した説明が消えている」.
// The first cut BLANKED a language mismatch ("reads as a glitch") — and then
// two real losses fed it: descriptions generated 2026-06-10〜08-03 lost their
// pair on every save (ProjectDataSchema didn't know the fields yet and zod
// stripped them), and the field-level recovery read dropped the pair from any
// file with one type flaw (measured on the prod build, projectData.test.ts).
// Each time, the surviving single-language text was then HIDDEN by this very
// rule — a wrong-language description reads odd; a vanished one reads as data
// loss, which is exactly what the owner reported. Show what survives; the
// generate button still appears when there is truly nothing.
//
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
  if (legacy && detectDescriptionLang(legacy) === lang) return legacy
  // Nothing in the UI language — any surviving text beats a blank (rule 3).
  const other = lang === 'ja' ? d.descriptionEn : d.descriptionJa
  return other || legacy || ''
}
