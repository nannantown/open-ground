import { describe, it, expect, beforeEach } from 'vitest'
import {
  normalizeAllowedModels,
  anyTierAllowed,
  isTierAllowed,
  isTierSpawnable,
  highestSpawnableTier,
  highestAllowedTier,
  spawnBlock,
  allowedModelTiers,
  setAllowedModelTiersCache,
  __resetAllowedModelsForTest,
} from './swarmAllowedModels'
import { markCoolingUntil, __resetQuotaForTest, MODEL_TIER_LADDER } from './swarmQuota'
import { resolveAvailableTier } from './swarmLaunch'
import {
  DEFAULT_SWARM_ALLOWED_MODELS,
  SWARM_MODEL_TIERS,
  effectiveAllowedTier,
  type SwarmAllowedModels,
} from '../types'

// Both the cooling table and the allowed-models mirror are process-wide
// globalThis singletons — reset BOTH before every case so the suite is
// order-independent (same discipline as swarmLaunch.test.ts).
beforeEach(() => {
  __resetQuotaForTest()
  __resetAllowedModelsForTest()
})

const NOW = 1_700_000_000_000
const HOUR = 3_600_000

/** A mask with exactly the named tiers switched OFF. */
const off = (...tiers: readonly (keyof SwarmAllowedModels)[]): SwarmAllowedModels => {
  const m = { ...DEFAULT_SWARM_ALLOWED_MODELS }
  for (const t of tiers) m[t] = false
  return m
}
const ALL_OFF = off('fable', 'opus', 'sonnet', 'haiku')

describe('normalizeAllowedModels (fail-OPEN per key — only an explicit false disables)', () => {
  it('an absent / non-object value reads as every tier usable', () => {
    for (const v of [undefined, null, 'oops', 42, ['fable']]) {
      expect(normalizeAllowedModels(v)).toEqual(DEFAULT_SWARM_ALLOWED_MODELS)
    }
  })

  it('a PARTIAL map fills the missing tiers in as usable', () => {
    expect(normalizeAllowedModels({ fable: false })).toEqual({
      fable: false,
      opus: true,
      sonnet: true,
      haiku: true,
    })
  })

  it('only `false` disables — a truthy/garbage value never retires a model', () => {
    const m = normalizeAllowedModels({ fable: 0, opus: 'no', sonnet: null, haiku: undefined })
    expect(m).toEqual(DEFAULT_SWARM_ALLOWED_MODELS)
  })

  it('unknown keys are dropped (the mask is exactly the ladder)', () => {
    expect(Object.keys(normalizeAllowedModels({ gpt: false })).sort()).toEqual(
      [...SWARM_MODEL_TIERS].sort(),
    )
  })

  it('an all-OFF map PARSES (the write boundary rejects it, not the parser)', () => {
    const m = normalizeAllowedModels(ALL_OFF)
    expect(m).toEqual(ALL_OFF)
    expect(anyTierAllowed(m)).toBe(false)
  })
})

describe('the two vetoes are independent (allowed ∧ ¬cooling)', () => {
  it('a switched-OFF tier is not spawnable even with full headroom', () => {
    const a = off('fable')
    expect(isTierAllowed('fable', a)).toBe(false)
    expect(isTierSpawnable('fable', NOW, a)).toBe(false)
    expect(isTierSpawnable('opus', NOW, a)).toBe(true)
  })

  it('a cooling tier is not spawnable even when switched ON', () => {
    markCoolingUntil('fable', NOW + HOUR)
    expect(isTierAllowed('fable', DEFAULT_SWARM_ALLOWED_MODELS)).toBe(true)
    expect(isTierSpawnable('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS)).toBe(false)
  })

  it('allowed does NOT override cooling: re-enabling a tier never shortens its cool', () => {
    markCoolingUntil('fable', NOW + HOUR)
    // Switch fable OFF then back ON — the cool is untouched.
    expect(isTierSpawnable('fable', NOW, off('fable'))).toBe(false)
    expect(isTierSpawnable('fable', NOW, DEFAULT_SWARM_ALLOWED_MODELS)).toBe(false)
    expect(isTierSpawnable('fable', NOW + HOUR + 1, DEFAULT_SWARM_ALLOWED_MODELS)).toBe(true)
  })

  it('cooling does NOT override allowed: a cool expiring never re-enables an OFF tier', () => {
    markCoolingUntil('fable', NOW + HOUR)
    expect(isTierSpawnable('fable', NOW + HOUR + 1, off('fable'))).toBe(false)
  })
})

describe('highestSpawnableTier / highestAllowedTier', () => {
  it('skips switched-OFF tiers as if they were not on the ladder', () => {
    expect(highestSpawnableTier(NOW, off('fable'))).toBe('opus')
    expect(highestSpawnableTier(NOW, off('fable', 'opus'))).toBe('sonnet')
  })

  it('skips cooling tiers too, and both together', () => {
    markCoolingUntil('opus', NOW + HOUR)
    expect(highestSpawnableTier(NOW, off('fable'))).toBe('sonnet')
  })

  it('null when nothing is spawnable', () => {
    expect(highestSpawnableTier(NOW, ALL_OFF)).toBeNull()
    for (const t of MODEL_TIER_LADDER) markCoolingUntil(t, NOW + HOUR)
    expect(highestSpawnableTier(NOW, DEFAULT_SWARM_ALLOWED_MODELS)).toBeNull()
  })

  it('highestAllowedTier ignores cooling (it is the policy answer, not the sensor)', () => {
    for (const t of MODEL_TIER_LADDER) markCoolingUntil(t, NOW + HOUR)
    expect(highestAllowedTier(off('fable'))).toBe('opus')
    expect(highestAllowedTier(ALL_OFF)).toBeNull()
  })
})

describe('spawnBlock (the ONE gate both actuators consult)', () => {
  it('null while any tier is enabled AND has headroom', () => {
    expect(spawnBlock(NOW, DEFAULT_SWARM_ALLOWED_MODELS)).toBeNull()
    markCoolingUntil('fable', NOW + HOUR)
    expect(spawnBlock(NOW, off('opus'))).toBeNull() // sonnet still fine
  })

  it("every tier switched OFF ⇒ 'none-allowed' (no reset — a human must act)", () => {
    expect(spawnBlock(NOW, ALL_OFF)).toEqual({ kind: 'none-allowed' })
  })

  it("'none-allowed' wins over cooling (nothing to wait for)", () => {
    for (const t of MODEL_TIER_LADDER) markCoolingUntil(t, NOW + HOUR)
    expect(spawnBlock(NOW, ALL_OFF)).toEqual({ kind: 'none-allowed' })
  })

  it('every ENABLED tier cooling ⇒ park until the earliest of THEIR resets', () => {
    // fable is switched off; its (irrelevant) reset is the earliest of all four.
    markCoolingUntil('fable', NOW + 60_000)
    markCoolingUntil('opus', NOW + 5 * 60_000)
    markCoolingUntil('sonnet', NOW + 9 * 60_000)
    markCoolingUntil('haiku', NOW + 7 * 60_000)
    expect(spawnBlock(NOW, off('fable'))).toEqual({
      kind: 'all-cooling',
      until: NOW + 5 * 60_000, // opus — the earliest among the ENABLED tiers
    })
  })

  it('a disabled tier is not counted as headroom (fable OFF ⇒ the other three dry = a full park)', () => {
    for (const t of ['opus', 'sonnet', 'haiku'] as const) markCoolingUntil(t, NOW + HOUR)
    // Cooling alone would say "fable is free" — the mask says otherwise.
    expect(spawnBlock(NOW, DEFAULT_SWARM_ALLOWED_MODELS)).toBeNull()
    expect(spawnBlock(NOW, off('fable'))).toEqual({ kind: 'all-cooling', until: NOW + HOUR })
  })

  it('the park LIFTS on its own once an enabled tier resets', () => {
    markCoolingUntil('opus', NOW + HOUR)
    markCoolingUntil('sonnet', NOW + HOUR)
    markCoolingUntil('haiku', NOW + HOUR)
    expect(spawnBlock(NOW, off('fable'))).not.toBeNull()
    expect(spawnBlock(NOW + HOUR + 1, off('fable'))).toBeNull()
  })

  it("a 'none-allowed' hold never lifts with time (the whole point of the hard mask)", () => {
    expect(spawnBlock(NOW + 365 * 24 * HOUR, ALL_OFF)).toEqual({ kind: 'none-allowed' })
  })
})

describe('the globalThis mirror (what the synchronous resolvers fall back on)', () => {
  it('defaults to every tier usable until a settings read refreshes it', () => {
    expect(allowedModelTiers()).toEqual(DEFAULT_SWARM_ALLOWED_MODELS)
  })

  it('setAllowedModelTiersCache normalizes and becomes the default argument', () => {
    setAllowedModelTiersCache({ fable: false })
    expect(allowedModelTiers()).toEqual(off('fable'))
    // The resolver, called WITHOUT an explicit mask, honors the mirror.
    expect(resolveAvailableTier('fable', NOW)).toBe('opus')
  })
})

describe('effectiveAllowedTier (UI copy) tracks resolveAvailableTier (server)', () => {
  // The Settings menu must name the model a mode will ACTUALLY launch on. It runs
  // the mask-only walk (cooling is transient and has no place in a policy screen);
  // the server runs the same walk with "not cooling" ANDed in. With an EMPTY
  // cooling table the two must agree for every (desired, mask) pair — this is the
  // anti-drift pin. A masked-out `desired` must never come back from either.
  const MASKS: SwarmAllowedModels[] = [
    DEFAULT_SWARM_ALLOWED_MODELS,
    off('fable'),
    off('fable', 'opus'),
    off('sonnet'),
    off('sonnet', 'haiku'),
    off('opus', 'haiku'),
    off('fable', 'opus', 'sonnet'),
  ]

  it('agrees on every (desired tier × mask) pair when nothing is cooling', () => {
    for (const mask of MASKS) {
      for (const desired of SWARM_MODEL_TIERS) {
        const ui = effectiveAllowedTier(desired, mask)
        expect(resolveAvailableTier(desired, NOW, mask)).toBe(ui)
        expect(ui).not.toBeNull()
        expect(mask[ui as keyof SwarmAllowedModels]).toBe(true) // never a disabled tier
      }
    }
  })

  it('both return null when every tier is off', () => {
    expect(effectiveAllowedTier('fable', ALL_OFF)).toBeNull()
    expect(resolveAvailableTier('fable', NOW, ALL_OFF)).toBeNull()
  })
})
