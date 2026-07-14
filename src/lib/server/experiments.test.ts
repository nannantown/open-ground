import { describe, it, expect } from 'vitest'
import { computeExperiments } from '@/lib/server/experiments'

// The security-critical pure resolver: an experiment gate is open ONLY for the
// owner WITH the settings toggle on. `eligible` is owner-alone (reveals the
// toggle UI); each flag is owner && the toggle. The non-owner cases are the
// guarantee that the whole feature stays invisible in the shipped build.

describe('computeExperiments', () => {
  it('owner + both toggles on → eligible, both flags open', () => {
    expect(
      computeExperiments('owner', { experiments: { swarm: true, sandbox: true } }),
    ).toEqual({
      eligible: true,
      flags: { swarm: true, sandbox: true },
    })
  })

  it('owner toggles each experiment INDEPENDENTLY', () => {
    expect(computeExperiments('owner', { experiments: { swarm: true } })).toEqual({
      eligible: true,
      flags: { swarm: true, sandbox: false },
    })
    expect(computeExperiments('owner', { experiments: { sandbox: true } })).toEqual({
      eligible: true,
      flags: { swarm: false, sandbox: true },
    })
  })

  it('owner without toggles → eligible, but every flag stays closed', () => {
    for (const settings of [{}, { experiments: {} }, { experiments: { swarm: false, sandbox: false } }]) {
      expect(computeExperiments('owner', settings)).toEqual({
        eligible: true,
        flags: { swarm: false, sandbox: false },
      })
    }
  })

  it('a non-owner can NEVER open a gate — even with forged settings flags', () => {
    for (const role of ['tester', 'none'] as const) {
      expect(
        computeExperiments(role, { experiments: { swarm: true, sandbox: true } }),
      ).toEqual({
        eligible: false,
        flags: { swarm: false, sandbox: false },
      })
    }
  })
})

// The server-local swarm unlock (swarmGate.ts, 業務モード = login disabled):
// opens the swarm flag alone, with no role and no experiments toggle. It must
// never widen `eligible` (the experiments toggle UI stays owner-only) nor any
// other experiment — sandbox keeps requiring owner && toggle.
describe('computeExperiments — swarm local owner unlock', () => {
  it('signed out + unlock → swarm opens; eligible and sandbox stay closed', () => {
    expect(computeExperiments('none', {}, { swarmLocalOwner: true })).toEqual({
      eligible: false,
      flags: { swarm: true, sandbox: false },
    })
  })

  it('the unlock does NOT leak to sandbox — even with a forged sandbox toggle', () => {
    expect(
      computeExperiments('none', { experiments: { sandbox: true } }, { swarmLocalOwner: true }),
    ).toEqual({
      eligible: false,
      flags: { swarm: true, sandbox: false },
    })
  })

  it('unlock false/absent changes nothing (the locked default)', () => {
    for (const opts of [undefined, {}, { swarmLocalOwner: false }]) {
      expect(computeExperiments('none', {}, opts)).toEqual({
        eligible: false,
        flags: { swarm: false, sandbox: false },
      })
    }
  })

  it('owner + unlock → swarm open even without the experiments toggle', () => {
    expect(computeExperiments('owner', {}, { swarmLocalOwner: true })).toEqual({
      eligible: true,
      flags: { swarm: true, sandbox: false },
    })
  })
})
