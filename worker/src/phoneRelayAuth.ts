// Who may open which end of a phone-link room (docs/PHONE_LINK.md). Pure — no
// Workers types — so the app's vitest suite guards it too
// (src/lib/server/phoneRelayAuth.test.ts).
//
// A ROOM is named by sha256(phoneKey) in lowercase hex. So:
//   - the phone proves itself by presenting the key whose hash IS the room —
//     nothing about the phone is stored anywhere;
//   - the Mac presents its own, different key; the room remembers the hash of
//     the first Mac key it sees (the Mac connects right after it creates the
//     pair, when only the Mac knows the room name) and refuses any other.
// One room per pairing = one room per user, so per-user App Store accounts need
// no shared secret here; gating who may CREATE a room (a subscription check)
// is the extension point, in front of `roomRequest`.

export type PhoneRelayRole = 'mac' | 'phone'

/** The header that carries a key. Not `Authorization`: Apple lists it as a
 *  reserved header URLSession may drop on a WebSocket upgrade. */
export const PHONE_RELAY_TOKEN_HEADER = 'X-OG-Token'

const PATH = /^\/v1\/([0-9a-f]{64})\/(mac|phone)$/

export const sha256Hex = async (s: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** A room path, or null when the path is not one. */
export const parseRoomPath = (pathname: string): { room: string; role: PhoneRelayRole } | null => {
  const m = PATH.exec(pathname)
  return m ? { room: m[1], role: m[2] as PhoneRelayRole } : null
}

/**
 * The Worker-side check, before anything reaches the room: the hash of the
 * presented key, or null (refuse). A phone key must hash to the room; a Mac key
 * must NOT (else the phone key could claim the Mac end of a fresh room) — the
 * room itself then compares the Mac hash with the one it registered.
 */
export const tokenHashFor = async (
  role: PhoneRelayRole,
  room: string,
  token: string | null,
): Promise<string | null> => {
  if (!token || token.length < 32 || token.length > 256) return null
  const hash = await sha256Hex(token)
  if (role === 'phone' ? hash !== room : hash === room) return null
  return hash
}

/** The room-side Mac check: first Mac registers, any other Mac key is refused. */
export const macAllowed = (registered: string | undefined, hash: string): boolean =>
  registered === undefined || registered === hash

/** Where an event sits in the Mac's transcript: file, line start, index in line. */
export interface Cursor {
  f: string
  o: number
  i: number
}
export const asCursor = (v: unknown): Cursor | null => {
  const c = v as Partial<Cursor> | null
  return c && typeof c.f === 'string' && c.f.length <= 200 && Number.isSafeInteger(c.o) && Number.isSafeInteger(c.i)
    ? { f: c.f, o: c.o as number, i: c.i as number }
    : null
}
/** `c` was already stored (same file, not after the last stored position). */
export const alreadyStored = (last: Cursor | null | undefined, c: Cursor): boolean =>
  !!last && last.f === c.f && (c.o < last.o || (c.o === last.o && c.i <= last.i))
