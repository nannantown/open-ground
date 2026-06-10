import type { Lang } from '@/i18n/messages'

// Pick the description matching the UI language, falling back to the legacy
// single-string field (hand-written or pre-bilingual data). Shared by the
// panel (client, lang from I18nContext) and scan.ts (server, lang from
// settings.language) so the card and the panel always agree.
export const descriptionForLang = (
  d: { description: string; descriptionJa?: string; descriptionEn?: string },
  lang: Lang,
): string => (lang === 'ja' ? d.descriptionJa : d.descriptionEn) || d.description
