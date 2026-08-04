// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { bellDataGates } from '@/App'

// GUARD for a defect found in the 5th adversarial cycle (2026-08-04): the
// お知らせ bell's three server reads had drifted into inconsistent gates.
//
// The read-state load (GET /api/notifications → the set of already-seen ids)
// sat INSIDE the collab-gated invite effect. Collab is feature-gated OFF by
// default, so on a normal build that fetch never ran: `readNotifIds` was empty
// at every launch. Fatal swarm notifications, whose own poll is auth-only,
// still filled the bell — so every fatal the owner had already read came back
// as unread on the badge after each restart, forever. Nothing threw, nothing
// logged; the only symptom was a badge that would not stay cleared.
//
// The fix is the shared `bellDataGates` the three effects now consume, and the
// invariant below is what makes a future drift LOUD instead of silent: any
// build that can SHOW a notification must also load which ones were seen.
describe('bellDataGates — read-state must cover every row-producing source', () => {
  const combos = [
    { signedIn: false, collabEnabled: false },
    { signedIn: false, collabEnabled: true },
    { signedIn: true, collabEnabled: false },
    { signedIn: true, collabEnabled: true },
  ]

  it('never lets a source produce rows the read-state load cannot cover', () => {
    for (const c of combos) {
      const g = bellDataGates(c)
      const producesRows = g.invites || g.swarmFatals
      expect(
        !producesRows || g.readState,
        `bellDataGates(${JSON.stringify(c)}) would show notifications (invites=${g.invites}, ` +
          `swarmFatals=${g.swarmFatals}) while readState=${g.readState}: the badge would count ` +
          `already-read rows as unread on every launch`,
      ).toBe(true)
    }
  })

  it('THE BUG CASE: signed in with collab OFF still loads the read-state', () => {
    // This exact combination is the default build. It is the one that was broken.
    const g = bellDataGates({ signedIn: true, collabEnabled: false })
    expect(g.readState).toBe(true)
    expect(g.swarmFatals).toBe(true) // fatal swarm alerts reach the bell here…
    expect(g.invites).toBe(false) // …while collab invites correctly do not.
  })

  it('reads nothing at all when signed out', () => {
    expect(bellDataGates({ signedIn: false, collabEnabled: true })).toEqual({
      readState: false,
      invites: false,
      swarmFatals: false,
    })
  })
})
