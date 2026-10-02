// Waking the owner's iPhone with a Push to Talk push (docs/PHONE_LINK.md
// "Waking the phone"). The Mac sends the push itself: APNs speaks only HTTP/2,
// and the relay (a Cloudflare Worker) makes HTTP/1.1 subrequests.
//
// The APNs key (.p8) is the owner's, entered once in Settings → iPhone. It is
// stored in ~/.openground/phone-push-key.json (0600) and never leaves this Mac:
// no route returns it, nothing logs it. It survives unpair / re-pair (it is the
// owner's Apple key, not part of a pairing); the phone's push token does not.
import { createHash, createPrivateKey, sign, type KeyObject } from 'crypto'
import { readFile } from 'fs/promises'
import http2 from 'http2'
import { join } from 'path'
import { atomicWriteJson } from './atomicWrite'
import { openGroundHome } from './paths'
import { isLockdownEnabledSync } from './lockdown'
import type { PushTarget } from '../../../worker/src/phoneRelayAuth'

export interface PushKey {
  v: 1
  /** 10-character Key ID shown next to the key on developer.apple.com. */
  keyId: string
  /** 10-character Team ID (Membership details). */
  teamId: string
  /** The .p8 file's text (PKCS#8 PEM, EC P-256). */
  p8: string
}

const keyFile = (): string => join(openGroundHome(), 'phone-push-key.json')
const APPLE_ID = /^[A-Z0-9]{10}$/

/** The parsed private key, or null when it is not an APNs (EC P-256) key. */
const privateKey = (p8: string): KeyObject | null => {
  try {
    const k = createPrivateKey(p8)
    return k.asymmetricKeyType === 'ec' && k.asymmetricKeyDetails?.namedCurve === 'prime256v1' ? k : null
  } catch {
    return null
  }
}

export const readPushKey = async (): Promise<PushKey | null> => {
  try {
    const k = JSON.parse(await readFile(keyFile(), 'utf8')) as PushKey
    return k?.v === 1 && APPLE_ID.test(k.keyId) && APPLE_ID.test(k.teamId) && privateKey(k.p8) ? k : null
  } catch {
    return null
  }
}

export type PushKeyRefusal = 'bad-key' | 'bad-key-id' | 'bad-team-id'

/** Check and save the owner's APNs key (replaces any earlier one). */
export const savePushKey = async (input: { p8?: unknown; keyId?: unknown; teamId?: unknown }): Promise<{ ok: true } | { error: PushKeyRefusal }> => {
  const keyId = typeof input.keyId === 'string' ? input.keyId.trim().toUpperCase() : ''
  const teamId = typeof input.teamId === 'string' ? input.teamId.trim().toUpperCase() : ''
  const p8 = typeof input.p8 === 'string' ? input.p8.trim() : ''
  if (!APPLE_ID.test(keyId)) return { error: 'bad-key-id' }
  if (!APPLE_ID.test(teamId)) return { error: 'bad-team-id' }
  if (p8.length > 4096 || !privateKey(p8)) return { error: 'bad-key' }
  await atomicWriteJson(keyFile(), { v: 1, keyId, teamId, p8 } satisfies PushKey, { mode: 0o600 })
  return { ok: true }
}

// ── provider token (JWT) ────────────────────────────────────────────────────

/** Apple: refresh no more than once every 20 min and no less than once every 60. */
export const JWT_REFRESH_MS = 30 * 60_000
/** Apple's floor between two new provider tokens (429 TooManyProviderTokenUpdates). */
export const JWT_MIN_AGE_MS = 20 * 60_000

declare global {
  // Survives tsx-watch reloads: a new token per reload risks Apple's
  // TooManyProviderTokenUpdates.
  // eslint-disable-next-line no-var
  var __openground_apns_jwt: { id: string; token: string; at: number } | undefined
}

const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')

/** ES256 provider token for `key`: the same one until JWT_REFRESH_MS old. */
export const providerToken = (key: PushKey, now = Date.now()): string => {
  // The key text is part of the identity: a corrected .p8 under the same IDs
  // must not keep signing with the old one.
  const id = `${key.teamId}.${key.keyId}.${key.p8}`
  const jwtCache = globalThis.__openground_apns_jwt
  if (jwtCache && jwtCache.id === id && now - jwtCache.at < JWT_REFRESH_MS) return jwtCache.token
  const input = `${b64({ alg: 'ES256', kid: key.keyId })}.${b64({ iss: key.teamId, iat: Math.floor(now / 1000) })}`
  // JWS wants the raw r||s signature, not DER.
  const sig = sign('sha256', Buffer.from(input), { key: privateKey(key.p8)!, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  globalThis.__openground_apns_jwt = { id, token: `${input}.${sig}`, at: now }
  return globalThis.__openground_apns_jwt.token
}

/** Drop the cached provider token: the next push signs a new one. */
export const dropProviderToken = (): void => {
  globalThis.__openground_apns_jwt = undefined
}

/** Apple called our provider token expired: sign a new one next time — but only
 *  if the cached one is old enough to renew (20 min). A younger one coming back
 *  expired means the Mac's clock is off; signing again would not help and would
 *  break Apple's rate rule. */
export const renewStaleProviderToken = (now = Date.now()): void => {
  const c = globalThis.__openground_apns_jwt
  if (c && now - c.at >= JWT_MIN_AGE_MS) dropProviderToken()
}

// ── the request ─────────────────────────────────────────────────────────────

export const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  development: 'https://api.sandbox.push.apple.com',
} as const

export interface PushResult {
  status: number
  /** APNs `reason` (e.g. BadDeviceToken, Unregistered), when it gave one. */
  reason?: string
}

/** The token is dead for good: forget it (the phone sends a new one when it joins again). */
export const pushTokenGone = (r: PushResult): boolean => r.status === 410 || (r.status === 400 && r.reason === 'BadDeviceToken')

/** Refusals that are the iPhone app's (its token / topic), not the key's.
 *  TopicDisallowed is the key's: a topic-specific key that does not cover the app. */
const APP_REFUSALS = ['DeviceTokenNotForTopic', 'BadTopic']
export const refusalIsTheApp = (reason: string): boolean => APP_REFUSALS.includes(reason)

/** Our provider token is too old: make a new one and try again (Apple:
 *  "generate a new provider token") — the key and the phone are fine. */
export const providerTokenExpired = (r: PushResult): boolean => r.status === 403 && r.reason === 'ExpiredProviderToken'

/** Apple will refuse this key + token again, every time (a wrong / revoked key,
 *  a key for the other environment, a token for another app): stop trying until
 *  one of them changes. */
export const pushRefusedForGood = (r: PushResult): boolean =>
  (r.status === 403 && !providerTokenExpired(r)) || (r.status === 400 && (refusalIsTheApp(r.reason ?? '') || r.reason === 'TopicDisallowed'))

/** Worth one more try a little later: no answer (network, timeout), 429, 5xx.
 *  Work mode is not — it holds until switched off, and then nothing is owed. */
export const pushTransient = (r: PushResult): boolean =>
  r.status === 0 ? r.reason !== 'lockdown' : r.status === 429 || r.status >= 500

/** Which key a refusal was for — without keeping the key itself anywhere else. */
export const pushKeyFingerprint = (key: PushKey): string =>
  createHash('sha256').update(`${key.teamId}.${key.keyId}.${key.p8.trim()}`).digest('hex').slice(0, 32)

/** One `pushtotalk` push. `origin` overrides the APNs host (tests). The body
 *  carries nothing readable: the phone fetches the words over the relay. */
export const sendPushToTalk = (key: PushKey, target: PushTarget, origin: string = APNS_HOSTS[target.env]): Promise<PushResult> =>
  new Promise((resolve) => {
    // Work mode refuses every non-Anthropic host. lockdown.ts guards fetch, and
    // http2 bypasses fetch: this is the check right at the connect.
    if (isLockdownEnabledSync()) return resolve({ status: 0, reason: 'lockdown' })
    // ponytail: one HTTP/2 connection per push (at most one per PUSH_GAP_MS); keep a session open if pushes get frequent.
    const session = http2.connect(origin)
    let settled = false
    const done = (r: PushResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      session.destroy()
      resolve(r)
    }
    const timer = setTimeout(() => done({ status: 0, reason: 'timeout' }), 10_000)
    session.on('error', () => done({ status: 0, reason: 'connect' }))
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${target.token}`,
      authorization: `bearer ${providerToken(key)}`,
      'apns-push-type': 'pushtotalk',
      'apns-topic': target.topic,
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
    })
    let status = 0
    let body = ''
    req.setEncoding('utf8')
    req.on('response', (h) => (status = Number(h[':status']) || 0))
    req.on('data', (c: string) => (body += c))
    req.on('end', () => {
      let reason: string | undefined
      try {
        reason = (JSON.parse(body) as { reason?: string }).reason
      } catch {
        /* 200 has no body */
      }
      done({ status, ...(reason ? { reason } : {}) })
    })
    req.on('error', () => done({ status: 0, reason: 'request' }))
    req.end(JSON.stringify({ aps: {} }))
  })
