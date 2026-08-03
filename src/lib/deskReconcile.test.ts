// The desk-adoption decision — the pure heart of the 0803 dead-screen fix.
//
// Proven RED against mutations (2026-08-03):
//   • adopt branch removed (always keep on a live desk) → 3 red
//   • storedDead requirement dropped from 'clear' → 1 red
//   • busy guard dropped → 1 red
//   • undefined treated as null (old-server back-compat broken) → 1 red

import { describe, it, expect } from 'vitest'
import { reconcileDesk, type StoredDeskRecord } from './deskReconcile'

const NOW = () => Date.parse('2026-08-03T12:00:00Z')

const deadPty: StoredDeskRecord = {
  terminalId: 'pty-old-1',
  runtime: 'pty',
  agentSessionId: 'conv-1',
  startedAt: '2026-08-02T00:00:00Z',
}

describe('reconcileDesk', () => {
  it('ADOPTS the engine-woken desk over a dead pre-restart record — the zero-click reconnect', () => {
    const v = reconcileDesk(deadPty, { runtime: 'sdk', handleId: 'sdk-new-1', agentSessionId: 'conv-2' }, {
      busy: false,
      storedDead: true,
      now: NOW,
    })
    expect(v.kind).toBe('adopt')
    if (v.kind === 'adopt') {
      expect(v.record.runtime).toBe('sdk')
      expect(v.record.sdkSessionId).toBe('sdk-new-1')
      expect(v.record.terminalId).toBe('') // the identity invariant
      expect(v.record.agentSessionId).toBe('conv-2')
    }
  })

  it('ADOPTS a live desk even from an empty slate (no stored record)', () => {
    const v = reconcileDesk(null, { runtime: 'pty', handleId: 'pty-new-9', agentSessionId: null }, {
      busy: false,
      storedDead: false,
      now: NOW,
    })
    expect(v.kind).toBe('adopt')
    if (v.kind === 'adopt') expect(v.record.terminalId).toBe('pty-new-9')
  })

  it('KEEPS a record already pointing at the live desk (no churn on every poll)', () => {
    const v = reconcileDesk(deadPty, { runtime: 'pty', handleId: 'pty-old-1', agentSessionId: 'conv-1' }, {
      busy: false,
      storedDead: false,
      now: NOW,
    })
    expect(v.kind).toBe('keep')
  })

  it('CLEARS a confirmed-dead record when the server says no desk — the honest CTA instead of the dead screen', () => {
    expect(reconcileDesk(deadPty, null, { busy: false, storedDead: true, now: NOW }).kind).toBe('clear')
  })

  it("does NOT clear a record the client still believes alive — the server read can lag a spawn", () => {
    expect(reconcileDesk(deadPty, null, { busy: false, storedDead: false, now: NOW }).kind).toBe('keep')
  })

  it('never fights an owner action in flight (busy ⇒ keep, whatever the server says)', () => {
    expect(
      reconcileDesk(deadPty, { runtime: 'sdk', handleId: 'sdk-new-1', agentSessionId: null }, {
        busy: true,
        storedDead: true,
        now: NOW,
      }).kind,
    ).toBe('keep')
  })

  it('an OLD server (field absent = undefined) changes nothing — back-compat', () => {
    expect(reconcileDesk(deadPty, undefined, { busy: false, storedDead: true, now: NOW }).kind).toBe('keep')
  })

  it('sdk adoption with a null conversation id degrades to an empty string, not undefined', () => {
    const v = reconcileDesk(null, { runtime: 'sdk', handleId: 's1', agentSessionId: null }, {
      busy: false,
      storedDead: false,
      now: NOW,
    })
    if (v.kind === 'adopt') expect(v.record.agentSessionId).toBe('')
    expect(v.kind).toBe('adopt')
  })
})
