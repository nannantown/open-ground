// Ticket verification for the OPEN GROUND collab Worker.
//
// WIRE FORMAT (shared with the Hono minter — keep byte-identical):
//   ticket = base64url(JSON{pid,scope,sub,role,exp}) + "." + base64url(HMAC_SHA256(secret, firstPart))
// where:
//   pid   = collabProjectId          (string)
//   scope = "board" | "canvas:<id>"  (string)
//   sub   = the member's user id     (string)
//   role  = "owner" | "member"       (string)
//   exp   = epoch MILLISECONDS       (number) — ~60s TTL
//
// ROOM = collabProjectId + ":" + scope  =  pid + ":" + scope
//
// The Worker verifier (this file):
//   1. recomputes the HMAC over the FIRST part and constant-time-compares it
//      to the supplied signature (crypto.subtle.verify);
//   2. checks exp is in the future;
//   3. checks pid + ":" + scope equals the requested room.
//
// HARD RULE: Web Crypto ONLY (crypto.subtle). The node `crypto` module is NOT
// available in the Workers runtime — never import it here.
//
// MINTING (zero-config): the same byte format is also MINTED here, by
// `mintTicket`, so the Worker's /ticket route can issue a ticket itself after it
// has verified a Supabase JWT + membership (see issueTicket.ts). This mirrors the
// Hono minter (server/routes/ticket.ts) byte-for-byte — JSON{pid,scope,sub,role,
// exp} → base64url → "." → base64url(HMAC) — so a ticket minted on EITHER side
// verifies on this Worker identically.

import { bytesToBase64url, utf8ToBase64url } from './b64url'

export interface TicketPayload {
  pid: string
  scope: string
  sub: string
  role: string
  exp: number
}

const enc = new TextEncoder()

/** RFC 4648 §5 base64url DECODE → bytes. Tolerates missing padding (the
 *  minter strips '='). Returns null on any malformed input rather than throw. */
const base64urlToBytes = (b64url: string): Uint8Array | null => {
  if (typeof b64url !== 'string' || b64url.length === 0) return null
  // Reject anything outside the base64url alphabet (incl. standard +/ and '=').
  if (!/^[A-Za-z0-9_-]+$/.test(b64url)) return null
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4
  if (pad === 1) return null // never a valid base64 length
  if (pad) b64 += '='.repeat(4 - pad)
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

const bytesToUtf8 = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

let keyCache: { secret: string; key: CryptoKey } | null = null

/** Import the HMAC-SHA256 verify key for `secret`, memoised (the secret is the
 *  same for the DO's whole lifetime, so we import once). */
const importKey = async (secret: string): Promise<CryptoKey> => {
  if (keyCache && keyCache.secret === secret) return keyCache.key
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  keyCache = { secret, key }
  return key
}

/**
 * Verify a collab ticket against `secret` for the expected `room`.
 *
 * Returns true ONLY when the signature is valid, the ticket has not expired,
 * and the ticket's pid+scope reconstruct exactly to `room`. Any structural
 * problem (missing part, bad base64url, non-JSON payload, missing field, wrong
 * type) returns false — never throws.
 *
 * @param token  the full "<payloadB64url>.<sigB64url>" ticket
 * @param secret OPENGROUND_COLLAB_TICKET_SECRET (shared with the minter)
 * @param room   collabProjectId + ":" + scope (the room being joined)
 * @param now    epoch-ms clock (injectable for tests; defaults to Date.now())
 */
export async function verifyTicket(
  token: string | null | undefined,
  secret: string,
  room: string,
  now: number = Date.now(),
): Promise<boolean> {
  return (await verifyTicketPayload(token, secret, room, now)) !== null
}

/**
 * Same checks as {@link verifyTicket}, but returns the decoded payload on
 * success (or null on any failure) so callers can read `role` / `sub`. Used by
 * the asset routes, which gate WRITE on `role === 'owner'`. Behaviourally
 * identical to verifyTicket for the boolean question — verifyTicket is now a
 * thin wrapper, so the WebSocket gate is unchanged.
 */
export async function verifyTicketPayload(
  token: string | null | undefined,
  secret: string,
  room: string,
  now: number = Date.now(),
): Promise<TicketPayload | null> {
  if (!token || typeof token !== 'string' || !secret) return null

  const dot = token.indexOf('.')
  // exactly one separator; both parts non-empty
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) return null

  const firstPart = token.slice(0, dot)
  const sigB64 = token.slice(dot + 1)

  const sig = base64urlToBytes(sigB64)
  if (!sig) return null

  let key: CryptoKey
  try {
    key = await importKey(secret)
  } catch {
    return null
  }

  // 1) Signature: HMAC is computed over the FIRST part's exact bytes (ASCII).
  let valid: boolean
  try {
    valid = await crypto.subtle.verify('HMAC', key, sig as BufferSource, enc.encode(firstPart))
  } catch {
    return null
  }
  if (!valid) return null

  // 2) Decode + parse the payload only AFTER the signature checks out.
  const payloadBytes = base64urlToBytes(firstPart)
  if (!payloadBytes) return null
  let payload: TicketPayload
  try {
    const parsed = JSON.parse(bytesToUtf8(payloadBytes)) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    payload = parsed as TicketPayload
  } catch {
    return null
  }

  if (
    typeof payload.pid !== 'string' ||
    typeof payload.scope !== 'string' ||
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp)
  ) {
    return null
  }

  // 3) Expiry (exp is epoch MILLISECONDS).
  if (payload.exp <= now) return null

  // 4) Bind the ticket to the requested room: pid + ":" + scope must match.
  if (`${payload.pid}:${payload.scope}` !== room) return null

  return payload
}

// ── Minting (zero-config issuance) ───────────────────────────────────────────

/** TTL of a minted ticket — matches the Hono minter's TICKET_TTL_MS. partysocket
 *  re-runs the client's ticket provider on every (re)connect, so a short window
 *  is safe and bounds replay. */
export const TICKET_TTL_MS = 60_000

/** The claims a caller supplies to mint (everything but `exp`, which defaults to
 *  now + TTL). Mirrors the Hono minter's input. */
export interface MintClaims {
  pid: string
  scope: string
  sub: string
  role: 'owner' | 'member'
  exp?: number
}

// HMAC SIGN key cache — distinct from the verify key cache above because the key
// usages differ ('sign' vs 'verify'); the secret is stable for the instance, so
// import once.
let signKeyCache: { secret: string; key: CryptoKey } | null = null
const importSignKey = async (secret: string): Promise<CryptoKey> => {
  if (signKeyCache && signKeyCache.secret === secret) return signKeyCache.key
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  signKeyCache = { secret, key }
  return key
}

/**
 * Mint a ticket for (pid, scope, sub, role), byte-identical to the Hono minter:
 *   head = base64url(utf8(JSON{pid,scope,sub,role,exp}))   exp = epoch MS
 *   sig  = base64url(HMAC_SHA256(secret, head))            over the head STRING
 *   token = head + "." + sig
 * `exp` defaults to now + TICKET_TTL_MS. Returns the token + its expiry. The
 * resulting token passes {@link verifyTicket} on this same Worker.
 */
export async function mintTicket(
  claims: MintClaims,
  secret: string,
  now: number = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const exp = claims.exp ?? now + TICKET_TTL_MS
  // Field order matches the Hono minter; order is irrelevant to verification
  // (the HMAC is over the encoded string), but we keep it identical for clarity.
  const payload: TicketPayload = {
    pid: claims.pid,
    scope: claims.scope,
    sub: claims.sub,
    role: claims.role,
    exp,
  }
  const head = utf8ToBase64url(JSON.stringify(payload))
  const key = await importSignKey(secret)
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(head))
  const sig = bytesToBase64url(new Uint8Array(sigBuf))
  return { token: `${head}.${sig}`, expiresAt: exp }
}
