// swarmAllowedModels — the swarm's model-POLICY layer: which tiers the owner has
// permanently switched ON/OFF ("使用可能モデル", Settings.swarmAllowedModels).
//
// WHY A SECOND LAYER (this is not the cooling table).
// swarmQuota is a SENSOR: it learns "fable answered with a limit notice" and
// cools that tier for a guessed window. Two properties make it unable to carry
// the owner's knowledge:
//   • it lives on globalThis — a restart / self-update forgets it, and the dry
//     tier springs back to life;
//   • it expires on its own — a `claude` limit notice rarely names the reset, so
//     the engine falls back to a flat 20-minute grace, un-cools, dispatches into
//     the same wall, and loops (observed 2026-07-09: three workers seated on
//     "You've reached your Fable 5 limit." for 21m30s, then again 20m later).
// When the owner already KNOWS "fable is spent until next week", there was no way
// to tell the engine. This module is that channel: a persisted, expiry-free hard
// mask. The two layers are INDEPENDENT and both fail-closed — a tier is spawnable
// only when it is allowed AND not cooling. Lifting a cool never re-enables a
// disallowed tier, and allowing a tier never shortens its cooling.
//
// DESIGN — pure, clock-injected, no fs:
//   • Every predicate takes `now` (epoch ms) and an explicit `allowed` map, so a
//     unit test drives them with a fake clock and no settings file (mirrors
//     swarmQuota's discipline).
//   • The only mutable state is a globalThis mirror of the persisted map, so the
//     sync callers (resolveAvailableTier and the spawn paths it feeds) can read
//     the policy without threading an await through every launch site. store.ts
//     refreshes it on EVERY settings read — it is a cache of settings.json, never
//     a second source of truth. Callers that can await MUST pass the freshly-read
//     map (store.getAllowedModelTiers()); the mirror is the backstop.
//   • No import of swarmOrchestrator / store (they import this) — one-way dep on
//     swarmQuota + the shared types.

import {
  SWARM_MODEL_TIERS,
  DEFAULT_SWARM_ALLOWED_MODELS,
  type SwarmAllowedModels,
} from '../types'
import { MODEL_TIER_LADDER, isTierCooling, coolingSnapshot, type ModelTier } from './swarmQuota'

/** Narrow an untrusted value (settings.json / a request body) to a full mask.
 *  FAIL-OPEN PER KEY, on purpose: only an explicit `false` disables a tier, so a
 *  missing key, a typo'd key, or a hand-corrupted file degrades to "usable"
 *  rather than silently retiring a model the owner never turned off. (An all-OFF
 *  map is a legitimate parse — it is rejected at the WRITE boundary, see
 *  store.setUserSettings — so a hand-edited settings.json still parks the swarm
 *  loudly instead of being quietly rewritten.) */
export const normalizeAllowedModels = (v: unknown): SwarmAllowedModels => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    return { ...DEFAULT_SWARM_ALLOWED_MODELS }
  }
  const src = v as Record<string, unknown>
  const out = { ...DEFAULT_SWARM_ALLOWED_MODELS }
  for (const tier of SWARM_MODEL_TIERS) out[tier] = src[tier] !== false
  return out
}

/** At least one tier is switched ON. An all-OFF mask can only ever park the
 *  swarm, so the settings route refuses to persist one and the UI blocks it. */
export const anyTierAllowed = (allowed: SwarmAllowedModels): boolean =>
  SWARM_MODEL_TIERS.some((t) => allowed[t])

// ── globalThis mirror of the persisted mask (see the file head) ───────────────
interface AllowedModelsState {
  allowed: SwarmAllowedModels
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_swarm_allowed_models: AllowedModelsState | undefined
}

const state: AllowedModelsState =
  globalThis.__openground_swarm_allowed_models ??
  (globalThis.__openground_swarm_allowed_models = { allowed: { ...DEFAULT_SWARM_ALLOWED_MODELS } })

/** Refresh the mirror from the persisted settings (store.ts calls this on every
 *  settings read). Normalized on the way in, so the mirror is always a full map. */
export const setAllowedModelTiersCache = (v: unknown): SwarmAllowedModels => {
  state.allowed = normalizeAllowedModels(v)
  return state.allowed
}

/** The last-known mask, for the SYNC readers (resolveAvailableTier's default).
 *  A never-refreshed mirror reads as all-usable — the same "no switch set" state
 *  a fresh install has. */
export const allowedModelTiers = (): SwarmAllowedModels => state.allowed

/** Is `tier` switched ON? (Policy only — say nothing about cooling.) */
export const isTierAllowed = (
  tier: ModelTier,
  allowed: SwarmAllowedModels = state.allowed,
): boolean => allowed[tier]

/** Both gates: the tier is switched ON *and* has quota headroom right now. This
 *  is the ONE predicate every launch-tier walk uses — allowed and cooling can
 *  each veto a tier on their own. */
export const isTierSpawnable = (
  tier: ModelTier,
  now: number,
  allowed: SwarmAllowedModels = state.allowed,
): boolean => isTierAllowed(tier, allowed) && !isTierCooling(tier, now)

/** The best tier that is allowed AND not cooling, or null when the swarm has no
 *  tier to spawn on at all. Walks the ladder best→cheapest, so "fable is OFF"
 *  simply starts the walk at opus. */
export const highestSpawnableTier = (
  now: number,
  allowed: SwarmAllowedModels = state.allowed,
): ModelTier | null => MODEL_TIER_LADDER.find((t) => isTierSpawnable(t, now, allowed)) ?? null

/** The best tier the owner allows, IGNORING cooling — the tier a resolver falls
 *  back to when every allowed tier is dry (the engine parks; picking a model is
 *  not where the wait is decided). Null iff every tier is switched OFF. */
export const highestAllowedTier = (
  allowed: SwarmAllowedModels = state.allowed,
): ModelTier | null => MODEL_TIER_LADDER.find((t) => isTierAllowed(t, allowed)) ?? null

/** Why no `claude` may spawn right now.
 *  - `none-allowed`: the owner switched every tier OFF. NO reset time exists —
 *    this never heals on its own, so the engine must tell a human (escalation).
 *  - `all-cooling`: every ALLOWED tier is cooling; `until` is the earliest reset
 *    among them (the disallowed tiers are simply not candidates, so switching
 *    fable OFF makes "opus+sonnet+haiku cooling" a full park). */
export type SpawnBlock = { kind: 'none-allowed' } | { kind: 'all-cooling'; until: number }

/** The engine's spawn gate: null ⇒ at least one tier is spawnable, go. Non-null
 *  ⇒ hold (park / defer) and do not launch a `claude`.
 *
 *  This GENERALIZES swarmQuota.allCoolingUntil over the allowed subset — that
 *  function stays exactly as it was (the quota route's contract is unchanged);
 *  the engine simply stops counting tiers the owner has retired as headroom. */
export const spawnBlock = (
  now: number,
  allowed: SwarmAllowedModels = state.allowed,
): SpawnBlock | null => {
  if (highestSpawnableTier(now, allowed)) return null
  if (!anyTierAllowed(allowed)) return { kind: 'none-allowed' }
  // Every allowed tier is cooling — the earliest of their resets is when the
  // swarm may move again (a disallowed tier's reset is irrelevant: it stays off).
  // `until` is read through swarmQuota's read-only snapshot (same lazy expiry as
  // isTierCooling), never by reaching into its table.
  const untils = coolingSnapshot(now)
    .filter((row) => isTierAllowed(row.tier, allowed) && row.until != null)
    .map((row) => row.until as number)
  // `untils` is non-empty here: no allowed tier was spawnable, and a cooling tier
  // always carries a future `until`. Guard anyway rather than emit Infinity.
  return { kind: 'all-cooling', until: untils.length ? Math.min(...untils) : now }
}

/** Thrown when a swarm role is asked to spawn while NO tier is allowed. Every
 *  `claude` spawn path (worker / manager / supply / overseer brain / reviewer
 *  panel) fails on this rather than falling back to a switched-OFF tier — the
 *  whole point of the hard mask (fail-CLOSED: no model ⇒ no spawn). */
export class NoAllowedModelTierError extends Error {
  constructor() {
    super(
      'no model tier is enabled — every tier is switched OFF in Settings (使用可能モデル). ' +
        'Enable at least one tier before launching a swarm role.',
    )
    this.name = 'NoAllowedModelTierError'
  }
}

/** Test-only: restore the mirror to "every tier usable". The mirror lives on
 *  globalThis (shared across a process), so a suite must reset it between cases. */
export const __resetAllowedModelsForTest = (): void => {
  state.allowed = { ...DEFAULT_SWARM_ALLOWED_MODELS }
}
