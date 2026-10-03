// End-to-end sealing of the phone link (docs/PHONE_LINK.md "Sealed frames").
// The relay routes and stores, but never reads: every content frame between
// the iPhone and this Mac travels as AES-256-GCM under a key that is only in
// the pairing code (never sent to the relay).
//
// Wire format of `box` = standard base64 of nonce(12) || ciphertext || tag(16)
// — exactly CryptoKit's `AES.GCM.SealedBox.combined`, so the phone does
// `AES.GCM.open(try AES.GCM.SealedBox(combined: data), using: key,
// authenticating: aad)`. The AAD names the direction, so a frame the Mac sent
// can never be passed back to the Mac as if the phone had said it.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'crypto'

export type SealDir = 'p2m' | 'm2p'
export const sealAad = (dir: SealDir): Buffer => Buffer.from(`og-phone-link/v2 ${dir}`, 'utf8')

const NONCE = 12
const TAG = 16

/** `key` = the 32-byte e2e key. `nonce` only for test vectors. */
export const seal = (key: Buffer, dir: SealDir, plain: unknown, nonce: Buffer = randomBytes(NONCE)): string => {
  const c = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG })
  c.setAAD(sealAad(dir))
  const ct = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()])
  return Buffer.concat([nonce, ct, c.getAuthTag()]).toString('base64')
}

/** The JSON object inside `box`, or null when it is not one this key sealed in
 *  this direction (forged, altered, the other direction, or not JSON). */
export const open = (key: Buffer, dir: SealDir, box: unknown): Record<string, unknown> | null => {
  if (typeof box !== 'string' || box.length > 96 * 1024) return null
  const raw = Buffer.from(box, 'base64')
  if (raw.length < NONCE + TAG) return null
  try {
    const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE), { authTagLength: TAG })
    d.setAAD(sealAad(dir))
    d.setAuthTag(raw.subarray(raw.length - TAG))
    const plain = Buffer.concat([d.update(raw.subarray(NONCE, raw.length - TAG)), d.final()]).toString('utf8')
    const v = JSON.parse(plain)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** The e2e key from its base64url form (the pairing code / phone-link.json), or null. */
export const e2eKeyOf = (s: unknown): Buffer | null => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(s)) return null
  const k = Buffer.from(s, 'base64url')
  return k.length === 32 ? k : null
}

/** A keyed, one-way tag of `s` (22 base64url chars): the same input gives the
 *  same tag, and without the e2e key it says nothing about `s`. Used for what
 *  must stay outside the seal but name something (the relay compares it). */
export const sealTag = (key: Buffer, label: string, s: string): string =>
  createHmac('sha256', tagKeyOf(key)).update(`og-phone-link/v2 ${label}|${s}`, 'utf8').digest('base64url').slice(0, 22)

/** The HMAC key, derived from the e2e key (HKDF-SHA256, RFC 5869): the AES-GCM
 *  key is never also used as an HMAC key — one key, one purpose (NIST SP 800-57
 *  Pt 1 Rev 5 §5.2). Mac-only: the phone never computes a tag. */
const tagKeyOf = (key: Buffer): Buffer => Buffer.from(hkdfSync('sha256', key, '', 'og-phone-link/v2 tag', 32))
