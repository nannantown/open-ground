// base64url helpers for the collab Worker — Web-standard only (atob/btoa,
// TextEncoder/TextDecoder), NO node `crypto`/`Buffer`, so they run in the Workers
// request path. Shared by the JWT verifier (decode) and the ticket minter
// (encode). The existing ticket VERIFIER (ticket.ts) keeps its own inlined decode
// untouched; this module backs the NEW zero-config code only.
//
// Dialect: RFC 4648 §5 base64url, NO padding (the JWS/JWT and our HMAC ticket all
// strip '='). Decoding tolerates missing padding and rejects any out-of-alphabet
// input (incl. standard '+' '/' '=') rather than silently mangling it.

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Raw bytes → base64url (no padding). Inputs here are tiny (≤ a few hundred
 *  bytes: a JSON payload or a 32-byte HMAC), so the per-char string build is fine. */
export const bytesToBase64url = (bytes: Uint8Array): string => {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** UTF-8 string → base64url (no padding). */
export const utf8ToBase64url = (s: string): string => bytesToBase64url(enc.encode(s))

/** base64url → bytes. Returns null on any malformed input (never throws). */
export const base64urlToBytes = (b64url: string): Uint8Array | null => {
  if (typeof b64url !== 'string' || b64url.length === 0) return null
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

/** base64url → UTF-8 string. Returns null on malformed input (never throws). */
export const base64urlToString = (b64url: string): string | null => {
  const bytes = base64urlToBytes(b64url)
  if (!bytes) return null
  try {
    return dec.decode(bytes)
  } catch {
    return null
  }
}
