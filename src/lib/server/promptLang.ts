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

/** Short instruction appended to a swarm role's (worker/manager/supply)
 *  launch prompt so its USER-FACING output — conversational chat replies,
 *  heartbeat `blocker` questions, escalation/plainQuestion text, status
 *  reports — follows Settings.language. `lang` is a REQUIRED parameter on
 *  every builder that composes a launch prompt (buildOrderInjection/
 *  workerLaunchOpts, managerLaunchOpts, supplyLaunchOpts, sdkWorkerLaunchPlan,
 *  sdkManagerLaunchPlan) — deliberately, not an opt-in: a production call site
 *  that forgets to thread a resolved `lang` through fails `tsc`, not silently
 *  ships an unconnected desk (2026-08-13 rework — an adversarial mutation pass
 *  found 3 of 5 spawn paths kept every test green with the wiring removed
 *  while `lang` was merely optional). Does NOT claim anything about the text
 *  ABOVE it in the prompt (that varies by role — worker's is a long Japanese
 *  rule block, manager/supply's fresh launch is just `/og-manage`/`/supply`),
 *  only about what the reader should write in return.
 *
 *  DELIBERATELY EXCLUDES commit messages / PR descriptions (2026-08-13,
 *  2nd rework round): the repo's CLAUDE.md「## Language policy」(owner
 *  decision, same date) states new work — INCLUDING commit messages —
 *  defaults to English, and its own exception list is exactly the four
 *  surfaces this directive covers (conversational replies / escalation
 *  questions·plainQuestion / UI copy / notification detail) — commit/PR text
 *  is explicitly NOT one of them. A `ja` directive that also claimed commit
 *  messages would contradict CLAUDE.md on every `ja`-language spawn, so this
 *  directive's scope is kept to the same four surfaces CLAUDE.md carves out,
 *  and commit/PR language is left entirely to CLAUDE.md's own policy. */
export const languageDirective = (lang: PromptLang): string =>
  pick(lang, {
    en: ' [Reply language] Everything you write for a human to read — chat replies, escalation/blocker questions, status reports — must be in English.',
    ja: ' 【返答言語】人間向けに書く文章(チャットの返答、エスカレーション/blocker の質問文、状況報告)は必ず日本語で書くこと。',
  })
