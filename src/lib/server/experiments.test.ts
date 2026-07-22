import { describe, it, expect } from 'vitest'
import { computeExperiments } from '@/lib/server/experiments'
import type { ExperimentFlags } from '@/lib/types'

// The security-critical pure resolver: an experiment gate is open ONLY for the
// owner WITH the settings toggle on. `eligible` is owner-alone (reveals the
// toggle UI); each flag is owner && the toggle. The non-owner cases are the
// guarantee that the whole feature stays invisible in the shipped build.

// Every expected `flags` is built by overriding this, so the assertions stay
// EXHAUSTIVE (a new ExperimentId that resolves open by mistake fails a test)
// without every literal needing a hand edit when one is added.
const ALL_CLOSED: ExperimentFlags = { swarm: false, sandbox: false, persona: false }
const open = (o: Partial<ExperimentFlags> = {}): ExperimentFlags => ({ ...ALL_CLOSED, ...o })

describe('computeExperiments', () => {
  it('owner + all toggles on → eligible, all flags open', () => {
    expect(
      computeExperiments('owner', {
        experiments: { swarm: true, sandbox: true, persona: true },
      }),
    ).toEqual({
      eligible: true,
      flags: open({ swarm: true, sandbox: true, persona: true }),
    })
  })

  it('owner toggles each experiment INDEPENDENTLY', () => {
    expect(computeExperiments('owner', { experiments: { swarm: true } })).toEqual({
      eligible: true,
      flags: open({ swarm: true }),
    })
    expect(computeExperiments('owner', { experiments: { sandbox: true } })).toEqual({
      eligible: true,
      flags: open({ sandbox: true }),
    })
    expect(computeExperiments('owner', { experiments: { persona: true } })).toEqual({
      eligible: true,
      flags: open({ persona: true }),
    })
  })

  it('owner without toggles → eligible, but every flag stays closed', () => {
    for (const settings of [
      {},
      { experiments: {} },
      { experiments: { swarm: false, sandbox: false, persona: false } },
    ]) {
      expect(computeExperiments('owner', settings)).toEqual({
        eligible: true,
        flags: ALL_CLOSED,
      })
    }
  })

  it('a non-owner can NEVER open a gate — even with forged settings flags', () => {
    for (const role of ['tester', 'none'] as const) {
      expect(
        computeExperiments(role, {
          experiments: { swarm: true, sandbox: true, persona: true },
        }),
      ).toEqual({
        eligible: false,
        flags: ALL_CLOSED,
      })
    }
  })
})

// The server-local swarm unlock (swarmGate.ts, 業務モード = login disabled):
// opens the swarm flag alone, with no role and no experiments toggle. It must
// never widen `eligible` (the experiments toggle UI stays owner-only) nor any
// other experiment — sandbox and persona keep requiring owner && toggle.
describe('computeExperiments — swarm local owner unlock', () => {
  it('signed out + unlock → swarm opens; eligible and every other flag stay closed', () => {
    expect(computeExperiments('none', {}, { swarmLocalOwner: true })).toEqual({
      eligible: false,
      flags: open({ swarm: true }),
    })
  })

  it('the unlock does NOT leak to sandbox — even with a forged sandbox toggle', () => {
    expect(
      computeExperiments('none', { experiments: { sandbox: true } }, { swarmLocalOwner: true }),
    ).toEqual({
      eligible: false,
      flags: open({ swarm: true }),
    })
  })

  // The Persona tab reads the owner's PERSONAL corpus, so it is deliberately
  // NOT reachable through the control-plane convenience unlock: a machine
  // running login-disabled gets the swarm surface, never the persona one.
  it('the unlock does NOT leak to persona — even with a forged persona toggle', () => {
    expect(
      computeExperiments('none', { experiments: { persona: true } }, { swarmLocalOwner: true }),
    ).toEqual({
      eligible: false,
      flags: open({ swarm: true }),
    })
  })

  it('unlock false/absent changes nothing (the locked default)', () => {
    for (const opts of [undefined, {}, { swarmLocalOwner: false }]) {
      expect(computeExperiments('none', {}, opts)).toEqual({
        eligible: false,
        flags: ALL_CLOSED,
      })
    }
  })

  it('owner + unlock → swarm open even without the experiments toggle', () => {
    expect(computeExperiments('owner', {}, { swarmLocalOwner: true })).toEqual({
      eligible: true,
      flags: open({ swarm: true }),
    })
  })
})
