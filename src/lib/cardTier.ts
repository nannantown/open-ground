// Board card DIFFICULTY tier — the estimator + the safety floor, in ONE pure
// module both layers import (2026-09-18). The server (swarmLaunch.ts
// desiredModelEffort, server/routes/swarm.ts) uses it to pick a worker's
// model/effort; the Board drawer uses the SAME function to show what a card will
// ACTUALLY run at — so the picker can never claim "軽微" while the engine runs
// the card at 設計. No React, no server deps (swarmLaunch.ts pulls node-pty and
// cannot be imported by the client). The tier → (model, effort) table is NOT
// here: model names stay server-side in swarmLaunch.ts TIER_MODEL_EFFORT.

import { TASK_TIERS, asTaskTier, type TaskTier } from './types'

/** The card fields the worker's tier is read from. `tier` is the supply
 *  officer's (or the owner's) explicit difficulty call; title/notes feed the
 *  keyword estimator and the safety floor. */
export type TierCard = { title?: string; notes?: string; tier?: TaskTier }

// Signals that a card is high-stakes → never run it cheaply. Safety + architecture +
// release-blocking work, in EN and JA. Since 2026-09-18 this is a FLOOR (a card
// that matches never runs below `design`), not a promotion to the top tier.
const HEAVY_SIGNALS =
  /(\bsandbox\b|\bguard\b|\bauth\b|認証|\bdelete\b|削除|\bbilling\b|課金|\bsecurity\b|セキュリティ|\bMAJOR\b|release[\s-]?block|リリースブロッカ|\bSPIKE\b|\bmigration\b|マイグレ|敵対レビュー|サンドボックス)/i
// Signals that a card is low-stakes → the lightest worker is plenty (chores, copy,
// follow-ups).
const LIGHT_SIGNALS =
  /(\[minor\]|\[follow[\s-]?up\]|\btypo\b|\brename\b|文言|\bcomment\b|コメント|\bnit\b|\bcleanup\b|\blint\b|\bdoc\b|\bcopy\b)/i

/** The tier a card that trips the safety keywords can never run below. */
export const SAFETY_FLOOR_TIER: TaskTier = 'design'

const tierRank = (t: TaskTier): number => TASK_TIERS.indexOf(t)

const cardText = (card: { title?: string; notes?: string }): string =>
  `${card.title ?? ''}\n${card.notes ?? ''}`

/** Does this text trip the safety keywords (auth / 削除 / billing / migration …)? */
export const tripsSafetyFloor = (text: string): boolean => HEAVY_SIGNALS.test(text)

/** Raise `tier` to the safety floor when `text` trips the safety keywords. An
 *  absent tier on such text becomes the floor too (never "let the estimator
 *  decide" on a dangerous card). Used where the text that decides the floor is
 *  NOT the text the worker is handed — e.g. the Board route, where the client's
 *  live notes replace the stored ones: the STORED card must still floor it. */
export const applySafetyFloor = (tier: TaskTier | undefined, text: string): TaskTier | undefined => {
  if (!tripsSafetyFloor(text)) return tier
  return tier && tierRank(tier) >= tierRank(SAFETY_FLOOR_TIER) ? tier : SAFETY_FLOOR_TIER
}

/** The difficulty tier a worker for this card runs at. Purely STATIC — judging
 *  difficulty with another `claude` call would itself burn the budget this exists
 *  to save; the judgment belongs to the supply officer, who reads the code and
 *  writes `card.tier`.
 *
 *  1. An explicit, valid `card.tier` wins (junk is ignored, like an absent tier).
 *  2. Otherwise the keyword estimator: a light signal (typo / rename / copy …) on
 *     a SHORT card → `touch`; anything else → `standard` (the safe middle).
 *  3. The SAFETY FLOOR applies to both: a card whose title/notes trip a safety
 *     keyword never resolves below `design`, whatever the supply officer wrote —
 *     a dangerous card must not run cheaply because of one mistaken label.
 *
 *  ⚠ There is deliberately NO length rule. `text.length > 1200 ⇒ top tier` used
 *  to live in the old classifier, and the supply skill asks for detailed
 *  completion conditions — so the more carefully a card was written, the more
 *  expensive it ran. A long brief is not a hard task. (The `< 400` guard on
 *  `touch` stays: it only ever makes a card MORE capable, never less.) */
export const resolveCardTier = (card: TierCard): TaskTier => {
  const text = cardText(card)
  const written = asTaskTier(card.tier)
  const base: TaskTier =
    written ?? (LIGHT_SIGNALS.test(text) && text.length < 400 ? 'touch' : 'standard')
  return applySafetyFloor(base, text) ?? base
}

/** Why a card's effective tier differs from what is stored — for the drawer.
 *  `floored` = the safety floor raised it; `estimated` = no tier stored, the
 *  estimator picked it; `null` = the stored tier is what runs. */
export const cardTierSource = (card: TierCard): 'floored' | 'estimated' | null => {
  const written = asTaskTier(card.tier)
  const effective = resolveCardTier(card)
  if (written && effective !== written) return 'floored'
  if (!written) return tripsSafetyFloor(cardText(card)) ? 'floored' : 'estimated'
  return null
}
