import { describe, it, expect } from 'vitest'
import { managerPresenceForDisplay } from './swarmOrchestrator'

// THE DEFECT THIS EXISTS FOR (measured 2026-08-04). The Swarm pane derived
// 「マネージャーが動いています」 from the heartbeat's freshness ALONE — and `fresh`
// only means the heartbeat FILE was written inside its ten-minute window. A
// commander that beat once and then died (context overflow, an owner stop, a
// crash) kept the pane saying it was working, and its tooltip kept saying
// 「1件あたり数分かかるのが普通です」 — i.e. "wait, don't look" — for ten more
// minutes, on an unattended run, on the one screen that decides whether the owner
// intervenes.
//
// The fix is an ORDER: desk-existence outranks the heartbeat. This file pins that
// order. Mutation that turns it red: swap the two `if`s in
// managerPresenceForDisplay, or drop the `deskLive` guard.
describe('managerPresenceForDisplay — a desk that is gone is never "working"', () => {
  it('MEASURED: fresh heartbeat + no live desk ⇒ missing', () => {
    expect(managerPresenceForDisplay({ deskLive: false, beatFresh: true })).toBe('missing')
  })

  it('no desk and no heartbeat ⇒ missing', () => {
    expect(managerPresenceForDisplay({ deskLive: false, beatFresh: false })).toBe('missing')
  })

  it('a live desk with a fresh heartbeat ⇒ working', () => {
    expect(managerPresenceForDisplay({ deskLive: true, beatFresh: true })).toBe('working')
  })

  it('a live desk with no fresh heartbeat ⇒ quiet, not missing', () => {
    // The other direction: a seated commander with nothing to report must not be
    // announced as absent — that would send the owner to open a second desk.
    expect(managerPresenceForDisplay({ deskLive: true, beatFresh: false })).toBe('quiet')
  })
})
