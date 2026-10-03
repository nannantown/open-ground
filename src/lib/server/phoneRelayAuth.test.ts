// Guard for the phone relay's key check (worker/src/phoneRelayAuth.ts), kept in
// the app suite so it runs with every `npm test`. The live end-to-end version is
// worker/test/phoneRelay.local.mjs (real workerd, real sockets).
import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { MinuteCounter, RELAY_LIMITS, admission, alreadyStored, asCursor, macAllowed, nextSweep, parseRoomPath, relayLimits, tokenHashFor } from '../../../worker/src/phoneRelayAuth'

const k = () => randomBytes(32).toString('base64url')
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('phone relay keys', () => {
  const phoneKey = k()
  const macKey = k()
  const room = sha(phoneKey)

  it('the phone opens its room only with the key whose hash names it', async () => {
    expect(await tokenHashFor('phone', room, phoneKey)).toBe(room)
    expect(await tokenHashFor('phone', room, k())).toBeNull()
    expect(await tokenHashFor('phone', room, null)).toBeNull()
    expect(await tokenHashFor('phone', room, '')).toBeNull()
  })

  it('the phone key can never act as the Mac', async () => {
    expect(await tokenHashFor('mac', room, phoneKey)).toBeNull()
  })

  it('the first Mac key registers; any other Mac key is refused', async () => {
    const h = await tokenHashFor('mac', room, macKey)
    expect(h).toBe(sha(macKey))
    expect(macAllowed(undefined, h!)).toBe(true)
    expect(macAllowed(h!, h!)).toBe(true)
    expect(macAllowed(h!, sha(k()))).toBe(false)
  })

  it('only a Mac allowed to create makes a room; a phone never does; a made room is entered with its keys', () => {
    const h = sha(macKey)
    expect(admission('mac', undefined, h, false)).toBe('refuse') // no app key: no room
    expect(admission('mac', undefined, h, true)).toBe('create')
    expect(admission('phone', undefined, room, true)).toBe('absent') // retry later, not "unlinked"
    expect(admission('mac', h, h, false)).toBe('enter') // paired before the gate: no app key needed
    expect(admission('mac', h, sha(k()), true)).toBe('refuse')
    expect(admission('phone', h, room, false)).toBe('enter')
  })

  it('the limits live in one place; only valid overrides apply; the sweep comes at the first deadline', () => {
    expect(RELAY_LIMITS).toMatchObject({ eventTtlS: 7 * 86400, roomIdleS: 30 * 86400, phonesMax: 5, macFramesPerMin: 120 })
    expect(relayLimits(undefined)).toEqual(RELAY_LIMITS)
    expect(relayLimits('{"eventTtlS":2,"phonesMax":-1}')).toEqual({ ...RELAY_LIMITS, eventTtlS: 2 })
    expect(relayLimits('not json')).toEqual(RELAY_LIMITS)
    const day = 86_400_000
    expect(nextSweep(0, undefined, RELAY_LIMITS)).toBe(30 * day)
    expect(nextSweep(0, 5 * day, RELAY_LIMITS)).toBe(12 * day)
    expect(nextSweep(0, 25 * day, RELAY_LIMITS)).toBe(30 * day)
  })

  it('the per-minute counter lets the limit through, then refuses until the minute turns', () => {
    const c = new MinuteCounter()
    expect([1, 2, 3].map(() => c.hit(1000, 2))).toEqual([true, true, false])
    expect(c.hit(61_000, 2)).toBe(true)
  })

  it('only /v1/<64 hex>/<mac|phone> is a room', () => {
    expect(parseRoomPath(`/v1/${room}/phone`)).toEqual({ room, role: 'phone' })
    expect(parseRoomPath(`/v1/${room}/admin`)).toBeNull()
    expect(parseRoomPath(`/v1/${room.toUpperCase()}/mac`)).toBeNull()
    expect(parseRoomPath(`/v1/${room}/mac/x`)).toBeNull()
  })
})

describe('phone relay resume positions', () => {
  it('reads only a well-formed position', () => {
    expect(asCursor({ f: 'p:s.jsonl', o: 10, i: 0 })).toEqual({ f: 'p:s.jsonl', o: 10, i: 0 })
    expect(asCursor(null)).toBeNull()
    expect(asCursor({ f: 'x', o: '10', i: 0 })).toBeNull()
    expect(asCursor({ f: 'x'.repeat(201), o: 1, i: 0 })).toBeNull()
  })
  it('drops a resend at or before the newest stored position of the same file, keeps the rest', () => {
    const last = { f: 'a', o: 100, i: 1 }
    expect(alreadyStored(last, { f: 'a', o: 50, i: 3 })).toBe(true)
    expect(alreadyStored(last, { f: 'a', o: 100, i: 1 })).toBe(true)
    expect(alreadyStored(last, { f: 'a', o: 100, i: 2 })).toBe(false)
    expect(alreadyStored(last, { f: 'a', o: 101, i: 0 })).toBe(false)
    expect(alreadyStored(last, { f: 'b', o: 0, i: 0 })).toBe(false)
    expect(alreadyStored(null, { f: 'a', o: 0, i: 0 })).toBe(false)
  })
})
