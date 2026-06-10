// Server-side language selection for prompts sent to the spawned Claude.
// OPEN GROUND is English-first, so the language is English unless the user has
// switched the UI to Japanese (persisted into Settings.language by the language
// toggle). Keep prompt text English-default with a Japanese variant selected here.
import { getSettings } from './store'
import type { Settings } from '../types'

export type PromptLang = 'en' | 'ja'

/** Pick the en/ja variant for a given language (English is the default/fallback). */
export const pick = <T>(lang: PromptLang, variants: { en: T; ja: T }): T =>
  lang === 'ja' ? variants.ja : variants.en

/** Resolve the active prompt language from already-loaded settings. */
export const langOf = (settings: Pick<Settings, 'language'>): PromptLang =>
  settings.language === 'ja' ? 'ja' : 'en'

/** Resolve the active prompt language, loading settings if the caller doesn't
 *  already have them. Defaults to English when unset. */
export const getPromptLang = async (): Promise<PromptLang> =>
  langOf(await getSettings())
