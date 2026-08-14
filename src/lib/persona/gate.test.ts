import { describe, it, expect } from 'vitest'
import { PERSONA_EXPERIMENTS, isPersonaOpen } from './gate'
import type { ExperimentFlags } from '@/lib/types'

// The Persona surface moved out of the per-project tab row and onto Ground
// (docs/MAP.md §11 / src/components/canvas/PersonaPanel.tsx), so its visibility
// is no longer decided by moduleRegistry's module gate. This is the whole rule
// now, and it must keep the tab's ANY-OF semantics: persona OR swarm.

const ALL_CLOSED: ExperimentFlags = { swarm: false, sandbox: false, persona: false }
const flags = (open: Partial<ExperimentFlags> = {}): ExperimentFlags => ({
  ...ALL_CLOSED,
  ...open,
})

describe('isPersonaOpen — the Ground entry gate', () => {
  it('is CLOSED by default — the shipped / signed-out / non-owner state', () => {
    expect(isPersonaOpen(ALL_CLOSED)).toBe(false)
  })

  it('fails closed when the flags have not arrived yet', () => {
    // App renders before GET /api/experiments resolves; an absent gate must hide
    // the entry rather than flash it and take it away.
    expect(isPersonaOpen(undefined)).toBe(false)
    expect(isPersonaOpen(null)).toBe(false)
  })

  it('opens on its own flag', () => {
    expect(isPersonaOpen(flags({ persona: true }))).toBe(true)
  })

  it('opens on swarm too — the ride-along the tab had', () => {
    // The people running a swarm are the people whose stand-in judges for them;
    // this is the case that must not be lost in the move to Ground.
    expect(isPersonaOpen(flags({ swarm: true }))).toBe(true)
  })

  it('is not opened by an unrelated experiment', () => {
    // sandbox changes how claude spawns; it reveals no surface.
    expect(isPersonaOpen(flags({ sandbox: true }))).toBe(false)
  })

  it('counts only a literal true, never a truthy value off the wire', () => {
    expect(isPersonaOpen({ ...ALL_CLOSED, persona: 1 as unknown as boolean })).toBe(false)
  })

  it('lists both ways in', () => {
    expect([...PERSONA_EXPERIMENTS].sort()).toEqual(['persona', 'swarm'])
  })
})
