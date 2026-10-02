// Guard for the phone relay's key check (worker/src/phoneRelayAuth.ts), kept in
// the app suite so it runs with every `npm test`. The live end-to-end version is
// worker/test/phoneRelay.local.mjs (real workerd, real sockets).
import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { alreadyStored, asCursor, macAllowed, parseRoomPath, tokenHashFor } from '../../../worker/src/phoneRelayAuth'

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
