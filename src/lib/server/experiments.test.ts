import { describe, it, expect } from 'vitest'
import { computeExperiments } from '@/lib/server/experiments'

// The security-critical pure resolver: an experiment gate is open ONLY for the
// owner WITH the settings toggle on. `eligible` is owner-alone (reveals the
// toggle UI); each flag is owner && the toggle. The non-owner cases are the
// guarantee that the whole feature stays invisible in the shipped build.

describe('computeExperiments', () => {
  it('owner + swarm toggle on → eligible, swarm open', () => {
    expect(computeExperiments('owner', { experiments: { swarm: true } })).toEqual({
      eligible: true,
      flags: { swarm: true },
    })
  })

  it('owner without the toggle → eligible, but swarm stays closed', () => {
    for (const settings of [{}, { experiments: {} }, { experiments: { swarm: false } }]) {
      expect(computeExperiments('owner', settings)).toEqual({
        eligible: true,
        flags: { swarm: false },
      })
    }
  })

  it('a non-owner can NEVER open the gate — even with a forged settings flag', () => {
    for (const role of ['tester', 'none'] as const) {
      expect(computeExperiments(role, { experiments: { swarm: true } })).toEqual({
        eligible: false,
        flags: { swarm: false },
      })
    }
  })
})
