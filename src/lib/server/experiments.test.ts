import { describe, it, expect } from 'vitest'
import { computeExperiments } from '@/lib/server/experiments'
import type { ExperimentFlags, ExperimentsResponse } from '@/lib/types'

// The security-critical pure resolver: an experiment gate is open ONLY for the
// owner WITH the settings toggle on. `eligible` is owner-alone (reveals the
// toggle UI); each flag is owner && the toggle. The non-owner cases are the
// guarantee that the whole feature stays invisible in the shipped build.
//
// ONE exception, `swarm` alone: the server-local unlock (業務モード) and the
// PUBLIC macOS opt-in (Settings.swarmOptIn, all users) each open the swarm flag
// without the owner role. Neither may widen `eligible` or reach sandbox/persona.

// Every expected `flags` is built by overriding this, so the assertions stay
// EXHAUSTIVE (a new ExperimentId that resolves open by mistake fails a test)
// without every literal needing a hand edit when one is added.
const ALL_CLOSED: ExperimentFlags = { swarm: false, sandbox: false, persona: false }
const open = (o: Partial<ExperimentFlags> = {}): ExperimentFlags => ({ ...ALL_CLOSED, ...o })

// Full expected response builder — includes the swarmOptIn block (default all
// false) so `.toEqual` stays an exact-shape assertion after the field was added.
const res = (
  eligible: boolean,
  flags: ExperimentFlags,
  swarmOptIn: { available: boolean; enabled: boolean } = { available: false, enabled: false },
): ExperimentsResponse => ({ eligible, flags, swarmOptIn })

describe('computeExperiments', () => {
  it('owner + all toggles on → eligible, all flags open', () => {
    expect(
      computeExperiments('owner', {
        experiments: { swarm: true, sandbox: true, persona: true },
      }),
    ).toEqual(res(true, open({ swarm: true, sandbox: true, persona: true })))
  })

  it('owner toggles each experiment INDEPENDENTLY', () => {
    expect(computeExperiments('owner', { experiments: { swarm: true } })).toEqual(
      res(true, open({ swarm: true })),
    )
    expect(computeExperiments('owner', { experiments: { sandbox: true } })).toEqual(
      res(true, open({ sandbox: true })),
    )
    expect(computeExperiments('owner', { experiments: { persona: true } })).toEqual(
      res(true, open({ persona: true })),
    )
  })

  it('owner without toggles → eligible, but every flag stays closed', () => {
    for (const settings of [
      {},
      { experiments: {} },
      { experiments: { swarm: false, sandbox: false, persona: false } },
    ]) {
      expect(computeExperiments('owner', settings)).toEqual(res(true, ALL_CLOSED))
    }
  })

  it('a non-owner can NEVER open a gate — even with forged settings flags', () => {
    for (const role of ['tester', 'none'] as const) {
      expect(
        computeExperiments(role, {
          experiments: { swarm: true, sandbox: true, persona: true },
        }),
      ).toEqual(res(false, ALL_CLOSED))
    }
  })
})

// The server-local swarm unlock (swarmGate.ts, 業務モード = login disabled):
// opens the swarm flag alone, with no role and no experiments toggle. It must
// never widen `eligible` (the experiments toggle UI stays owner-only) nor any
// other experiment — sandbox and persona keep requiring owner && toggle.
describe('computeExperiments — swarm local owner unlock', () => {
  it('signed out + unlock → swarm opens; eligible and every other flag stay closed', () => {
    expect(computeExperiments('none', {}, { swarmLocalOwner: true })).toEqual(
      res(false, open({ swarm: true })),
    )
  })

  it('the unlock does NOT leak to sandbox — even with a forged sandbox toggle', () => {
    expect(
      computeExperiments('none', { experiments: { sandbox: true } }, { swarmLocalOwner: true }),
    ).toEqual(res(false, open({ swarm: true })))
  })

  // The Persona tab reads the owner's PERSONAL corpus, so it is deliberately
  // NOT reachable through the control-plane convenience unlock: a machine
  // running login-disabled gets the swarm surface, never the persona one.
  it('the unlock does NOT leak to persona — even with a forged persona toggle', () => {
    expect(
      computeExperiments('none', { experiments: { persona: true } }, { swarmLocalOwner: true }),
    ).toEqual(res(false, open({ swarm: true })))
  })

  it('unlock false/absent changes nothing (the locked default)', () => {
    for (const opts of [undefined, {}, { swarmLocalOwner: false }]) {
      expect(computeExperiments('none', {}, opts)).toEqual(res(false, ALL_CLOSED))
    }
  })

  it('owner + unlock → swarm open even without the experiments toggle', () => {
    expect(computeExperiments('owner', {}, { swarmLocalOwner: true })).toEqual(
      res(true, open({ swarm: true })),
    )
  })
})

// The PUBLIC swarm opt-in (Settings.swarmOptIn, ALL users, macOS only). Resolved
// upstream (isSwarmOptInEnabled) and passed in as `swarmOptInEnabled`; the
// availability (macOS) rides `swarmOptInAvailable` and only drives the toggle's
// visibility, never the gate. Like the local unlock: opens ONLY swarm, never
// `eligible`, sandbox, or persona.
describe('computeExperiments — public swarm opt-in', () => {
  it('non-owner + opt-in enabled → swarm opens; eligible + sandbox + persona stay closed', () => {
    expect(
      computeExperiments('none', {}, { swarmOptInEnabled: true, swarmOptInAvailable: true }),
    ).toEqual(res(false, open({ swarm: true }), { available: true, enabled: true }))
  })

  it('⚠ opt-in NEVER leaks to sandbox or persona — even with forged toggles', () => {
    expect(
      computeExperiments(
        'none',
        { experiments: { sandbox: true, persona: true } },
        { swarmOptInEnabled: true, swarmOptInAvailable: true },
      ),
    ).toEqual(res(false, open({ swarm: true }), { available: true, enabled: true }))
  })

  it('available but not enabled → swarm closed; the toggle is merely offered', () => {
    expect(
      computeExperiments('none', {}, { swarmOptInEnabled: false, swarmOptInAvailable: true }),
    ).toEqual(res(false, ALL_CLOSED, { available: true, enabled: false }))
  })

  it('⚠ enabled but NOT available (non-macOS) does not reach here — enabled is the resolved gate', () => {
    // isSwarmOptInEnabled ANDs macOS in upstream, so a non-macOS machine passes
    // swarmOptInEnabled:false. This pins that a false resolved gate keeps swarm shut
    // regardless of what `available` says.
    expect(
      computeExperiments('none', {}, { swarmOptInEnabled: false, swarmOptInAvailable: false }),
    ).toEqual(res(false, ALL_CLOSED, { available: false, enabled: false }))
  })

  it('owner keeps their own path — opt-in is additive, both resolve swarm open', () => {
    expect(
      computeExperiments(
        'owner',
        { experiments: { swarm: true } },
        { swarmOptInEnabled: true, swarmOptInAvailable: true },
      ),
    ).toEqual(res(true, open({ swarm: true }), { available: true, enabled: true }))
  })
})
