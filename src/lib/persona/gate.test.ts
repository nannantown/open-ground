import { describe, it, expect } from 'vitest'
import { PERSONA_EXPERIMENTS, isPersonaOpen } from './gate'
import type { ExperimentFlags } from '@/lib/types'

// The Persona surface moved out of the per-project tab row and onto Ground
// (docs/MAP.md §11 / src/components/canvas/PersonaPanel.tsx), so its visibility
// is no longer decided by moduleRegistry's module gate. The rule (2026-08-20,
// persona promoted to a public beta): it opens on the `persona` flag ALONE. The
// old any-of with `swarm` was dropped — swarm no longer rides into the personal
// corpus screen (the coupling now lives owner-scoped inside the server flag,
// experiments.ts). See gate.ts's header.

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

  it('⚠ does NOT open on swarm — the decoupling that fixed the 0.11.94 leak', () => {
    // A swarm opt-in user's flags.swarm is true; before the fix the any-of gate
    // opened the personal corpus screen for them. The gate now reads persona
    // alone, so a swarm flag never reaches this surface.
    expect(isPersonaOpen(flags({ swarm: true }))).toBe(false)
  })

  it('is not opened by an unrelated experiment', () => {
    // sandbox changes how claude spawns; it reveals no surface.
    expect(isPersonaOpen(flags({ sandbox: true }))).toBe(false)
  })

  it('counts only a literal true, never a truthy value off the wire', () => {
    expect(isPersonaOpen({ ...ALL_CLOSED, persona: 1 as unknown as boolean })).toBe(false)
  })

  it('lists exactly one way in — persona alone', () => {
    expect([...PERSONA_EXPERIMENTS]).toEqual(['persona'])
  })
})
