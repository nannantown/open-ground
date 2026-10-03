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
// One room per pairing = one room per user. Who may CREATE a room is gated by
// `mayCreateRoom` in phoneRelay.ts (today: the app key every OPEN GROUND build
// carries; at App Store launch: a subscription check — the one swap point).

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

/** The header a Mac sends the app key in (only room creation needs it). */
export const PHONE_RELAY_APP_KEY_HEADER = 'X-OG-App-Key'

/** The room-side Mac check: first Mac registers, any other Mac key is refused. */
export const macAllowed = (registered: string | undefined, hash: string): boolean =>
  registered === undefined || registered === hash

/**
 * Who gets into a room, decided inside it. A room exists once a Mac registered
 * its key; only a Mac allowed to create rooms (`mayCreate`) can make one. A
 * phone can never make one — so nothing at all is stored for a stranger's key.
 * A phone at a room that does not exist (not yet created) is
 * told `absent` — retry later — never `refuse`: the app takes a 401 as "unlinked"
 * and forgets the pairing, while the Mac will make the room again on return.
 */
export const admission = (
  role: PhoneRelayRole,
  registered: string | undefined,
  hash: string,
  mayCreate: boolean,
): 'create' | 'enter' | 'absent' | 'refuse' => {
  if (registered === undefined) return role === 'phone' ? 'absent' : mayCreate ? 'create' : 'refuse'
  return role === 'phone' || macAllowed(registered, hash) ? 'enter' : 'refuse'
}

/**
 * Every limit of the relay, in ONE place (docs/PHONE_LINK.md "Security model").
 * The Worker var `RELAY_LIMITS` may override any of them — only the local test
 * does (short expiries); production runs on these.
 */
export const RELAY_LIMITS = {
  /** A stored event is erased this long after its `at` (when the line was
   *  said, never later than when it was stored), heard or not. The sweep takes
   *  events due within the next sweepSlack together, so it is never late. */
  eventTtlS: 7 * 24 * 3600,
  /** A room nobody connected to for this long is emptied (all but its Mac key hash and newest event position). */
  roomIdleS: 30 * 24 * 3600,
  /** Phone sockets one room holds at once (a phone that switched networks may
   *  leave a dead one behind for a while). */
  phonesMax: 5,
  /** A phone socket that has not pinged for this long is dead (the app pings
   *  every 40 s) and is closed to make room for a new one. */
  phoneStaleS: 90,
  /** New connections per room per minute, both ends together. */
  connectsPerMin: 60,
  /** Mac frames that write here (event / projects / push-ready) per room per
   *  minute; over it the Mac's socket is closed (4029) after that frame. It
   *  redials and resumes from the newest stored event. */
  macFramesPerMin: 120,
  /** Phone frames per room per minute, counted apart so a Mac catching up never
   *  cuts the phone off; over it the phone is closed (4029) after that frame. */
  phoneFramesPerMin: 120,
}
export type RelayLimits = typeof RELAY_LIMITS

/** RELAY_LIMITS with the valid (positive number) overrides applied. */
export const relayLimits = (override: unknown): RelayLimits => {
  const out = { ...RELAY_LIMITS }
  if (typeof override === 'string') {
    try {
      override = JSON.parse(override)
    } catch {
      return out
    }
  }
  if (override && typeof override === 'object') {
    for (const k of Object.keys(out) as (keyof RelayLimits)[]) {
      const v = (override as Record<string, unknown>)[k]
      if (typeof v === 'number' && v > 0) out[k] = v
    }
  }
  return out
}

/** A fixed one-minute window counter (per room, in memory: it restarts when the
 *  room sleeps — a sleeping room is not being flooded). True = within limit. */
export class MinuteCounter {
  private start = 0
  private n = 0
  hit(now: number, limit: number): boolean {
    if (now - this.start >= 60_000) {
      this.start = now
      this.n = 0
    }
    return ++this.n <= limit
  }
}

/** When the room's alarm must next fire: the oldest stored event's expiry or
 *  the idle deadline, whichever comes first. */
export const nextSweep = (usedAt: number, oldestEventAt: number | undefined, lim: RelayLimits): number =>
  Math.min(usedAt + lim.roomIdleS * 1000, oldestEventAt === undefined ? Infinity : oldestEventAt + lim.eventTtlS * 1000)

/** How far ahead of its deadline the sweep takes an event, so events expiring
 *  one by one cost one alarm an hour, not one each (never late: early only). */
export const sweepSlackMs = (lim: RelayLimits): number => Math.min(3_600_000, (lim.eventTtlS * 1000) / 24)

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

/** Where a Push to Talk push for the phone goes (docs/PHONE_LINK.md "Waking the
 *  phone"): its ephemeral APNs token, which APNs host, and the `apns-topic`. */
export interface PushTarget {
  token: string
  env: 'development' | 'production'
  topic: string
}
/** A phone `push-token` frame's target: null = "forget it" (`token: null`),
 *  undefined = not a valid frame. Checked tightly: the token goes into the APNs
 *  request path. */
export const asPushTarget = (f: Record<string, unknown>): PushTarget | null | undefined => {
  if (f.token === null) return null
  const { token, env, topic } = f
  return typeof token === 'string' &&
    /^[0-9a-f]{16,200}$/i.test(token) &&
    (env === 'development' || env === 'production') &&
    typeof topic === 'string' &&
    /^[A-Za-z0-9.-]{1,180}\.voip-ptt$/.test(topic)
    ? { token: token.toLowerCase(), env, topic }
    : undefined
}
