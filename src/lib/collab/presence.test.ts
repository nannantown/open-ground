import { describe, it, expect } from 'vitest'
import { peersFromAwareness } from './RealtimeContext'
import type { AwarenessLike } from './provider'

// A fake Awareness with a fixed local clientID + a getStates() map — enough to
// exercise the pure projection without a real Y.Doc / WebSocket. (A real
// y-protocols Awareness satisfies this same shape.)
const fakeAwareness = (
  clientID: number,
  states: Array<[number, Record<string, unknown>]>,
): AwarenessLike => ({
  clientID,
  getStates: () => new Map(states),
  setLocalState: () => {},
  on: () => {},
  off: () => {},
})

describe('peersFromAwareness (u15 presence projection)', () => {
  it('excludes self (the local clientID)', () => {
    const aw = fakeAwareness(1, [
      [1, { name: 'me', color: '#000' }],
      [2, { name: 'koki', color: '#f00' }],
    ])
    const peers = peersFromAwareness(aw)
    expect(peers).toEqual([{ clientId: 2, name: 'koki', color: '#f00' }])
  })

  it('drops entries with no usable name (connecting {} / non-string / missing)', () => {
    const aw = fakeAwareness(9, [
      [2, {}], // peer mid-connect, no identity published yet
      [3, { name: 42, color: '#f00' }], // non-string name
      [4, { color: '#0f0' }], // name missing
      [5, { name: 'real', color: '#00f' }],
    ])
    expect(peersFromAwareness(aw).map((p) => p.name)).toEqual(['real'])
  })

  it('defaults color to #888888 when the peer omits/misformats it', () => {
    const aw = fakeAwareness(9, [[2, { name: 'nocolor' }]])
    expect(peersFromAwareness(aw)).toEqual([
      { clientId: 2, name: 'nocolor', color: '#888888' },
    ])
  })

  it('returns [] when alone (only self) or when there are no states', () => {
    expect(
      peersFromAwareness(fakeAwareness(1, [[1, { name: 'me', color: '#000' }]])),
    ).toEqual([])
    expect(peersFromAwareness(fakeAwareness(1, []))).toEqual([])
  })

  it('keeps every valid peer, in iteration order', () => {
    const aw = fakeAwareness(1, [
      [2, { name: 'a', color: '#111' }],
      [3, { name: 'b', color: '#222' }],
      [4, { name: 'c', color: '#333' }],
    ])
    expect(peersFromAwareness(aw).map((p) => p.name)).toEqual(['a', 'b', 'c'])
  })

  it('carries the full email when a peer publishes one (tooltip uses it)', () => {
    const aw = fakeAwareness(1, [
      [2, { name: 'op', color: '#f00', email: 'opengroundcoffee@gmail.com' }],
    ])
    expect(peersFromAwareness(aw)).toEqual([
      { clientId: 2, name: 'op', color: '#f00', email: 'opengroundcoffee@gmail.com' },
    ])
  })

  it('omits email for older peers that publish only a name (back-compat)', () => {
    const peer = peersFromAwareness(fakeAwareness(1, [[2, { name: 'koki', color: '#f00' }]]))[0]
    expect(peer).toEqual({ clientId: 2, name: 'koki', color: '#f00' })
    expect(peer.email).toBeUndefined()
  })

  it('drops a non-string email (keeps the peer, no email field)', () => {
    const peer = peersFromAwareness(
      fakeAwareness(1, [[2, { name: 'koki', color: '#f00', email: 42 }]]),
    )[0]
    expect(peer.email).toBeUndefined()
  })
})
