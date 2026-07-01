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
