// The pure difficulty-tier module shared by the engine and the Board drawer.
// resolveCardTier's table/floor behaviour is pinned in swarmLaunch.test.ts (the
// server re-exports it); this file pins the two helpers the other callers rely
// on: applySafetyFloor (the Board route floors on the STORED card) and
// cardTierSource (the drawer's "実際は: …" line).
import { describe, it, expect } from 'vitest'
import { applySafetyFloor, cardTierSource, resolveCardTier } from './cardTier'

describe('applySafetyFloor — raise-only, driven by the text it is given', () => {
  it('raises touch / standard / absent to design when the text trips a safety word', () => {
    expect(applySafetyFloor('touch', 'refresh the auth token')).toBe('design')
    expect(applySafetyFloor('standard', '古い行を削除')).toBe('design')
    expect(applySafetyFloor(undefined, 'billing page copy')).toBe('design')
  })

  it('never lowers: design / ultra pass through, and safe text changes nothing', () => {
    expect(applySafetyFloor('design', 'auth')).toBe('design')
    expect(applySafetyFloor('ultra', 'auth')).toBe('ultra')
    expect(applySafetyFloor('touch', 'fix a typo')).toBe('touch')
    expect(applySafetyFloor(undefined, 'fix a typo')).toBeUndefined()
  })
})

describe('cardTierSource — why the drawer shows an effective tier', () => {
  it('floored: a written tier the floor raised, or an unwritten dangerous card', () => {
    const c = { title: '認証まわりのトークン更新', tier: 'touch' as const }
    expect(cardTierSource(c)).toBe('floored')
    expect(resolveCardTier(c)).toBe('design')
    expect(cardTierSource({ title: 'drop rows', notes: 'migration' })).toBe('floored')
  })

  it('estimated: nothing written, nothing dangerous', () => {
    expect(cardTierSource({ title: 'add a button' })).toBe('estimated')
    expect(resolveCardTier({ title: 'add a button' })).toBe('standard')
  })

  it('null: the written tier is exactly what runs', () => {
    expect(cardTierSource({ title: 'add a button', tier: 'touch' })).toBeNull()
    expect(cardTierSource({ title: 'auth rewrite', tier: 'ultra' })).toBeNull()
  })
})
