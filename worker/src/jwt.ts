// Supabase JWT verification for the zero-config collab Worker auth layer.
//
// The v2 (server-mints) model has the owner's Hono server verify the caller's
// Supabase session and mint the HMAC ticket. ZERO-CONFIG moves that into the
// Worker: a member presents their Supabase access token (a JWT) directly to the
// Worker's /ticket route, so collaboration works without the owner's machine
// running. This module is step (1): prove the JWT was issued by THIS project's
// Supabase and is unexpired, returning the caller's identity (sub + email).
//
// HOW: Supabase signs access tokens with an ASYMMETRIC key (the "JWT signing
// keys" feature — ES256 / ECC P-256 by default, RS256 also supported) and
// publishes the PUBLIC keys as a JWKS at
//   {SUPABASE_URL}/auth/v1/.well-known/jwks.json
// We fetch the JWKS, pick the key whose `kid` matches the token header, import it
// with crypto.subtle, and verify the signature over `header.payload`. Then we
// check exp/iss/aud/sub. Because the JWKS is fetched from OUR SUPABASE_URL, only
// tokens signed by OUR project verify — iss/aud are defence-in-depth on top.
//
// HARD RULE (same as ticket.ts): Web Crypto ONLY (crypto.subtle). The node
// `crypto` module is unavailable in the Workers runtime — never import it.

import { base64urlToBytes, base64urlToString } from './b64url'

const enc = new TextEncoder()

/** The verified caller identity lifted from the token's claims. */
export interface VerifiedJwt {
  /** auth uid — the Supabase user id (JWT `sub`). */
  sub: string
  /** the user's email claim, if present (used to match email-seeded members). */
  email?: string
}

/** The Worker env fields this module reads. SUPABASE_ANON_KEY is sent as the
 *  `apikey` on the JWKS fetch (Supabase's API gateway requires it on /auth/v1). */
export interface JwtEnv {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
}

/** Strip trailing slashes so `${url}/auth/v1...` and the iss check are stable. */
const normalizeUrl = (u: string): string => u.replace(/\/+$/, '')

// ── JWKS cache ───────────────────────────────────────────────────────────────
// Module-level so it survives across requests within a Worker/DO instance. Keyed
// by the SUPABASE_URL it was fetched for; refetched when stale OR when a token's
// kid is absent (handles key rotation). Imported CryptoKeys are cached by kid.

interface JwksCache {
  url: string
  at: number
  keys: Map<string, CryptoKey>
}
let jwksCache: JwksCache | null = null
const JWKS_TTL_MS = 10 * 60 * 1000

interface Jwk {
  kid?: string
  kty?: string
  alg?: string
  crv?: string
  [k: string]: unknown
}

/** Import one JWK as a verify-only CryptoKey. Supports the two algorithms
 *  Supabase uses for asymmetric signing: ES256 (EC P-256) and RS256 (RSA).
 *  Returns null for anything else / a malformed key (never throws). */
const importJwk = async (jwk: Jwk): Promise<CryptoKey | null> => {
  try {
    if (jwk.kty === 'RSA') {
      return await crypto.subtle.importKey(
        'jwk',
        jwk as JsonWebKey,
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      )
    }
    if (jwk.kty === 'EC' && jwk.crv === 'P-256') {
      return await crypto.subtle.importKey(
        'jwk',
        jwk as JsonWebKey,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify'],
      )
    }
  } catch {
    /* fall through to null */
  }
  return null
}

/** Fetch + parse the JWKS, importing every usable key into a kid→CryptoKey map.
 *  Returns an empty map on any network/parse failure (the caller then 401s). */
const fetchJwks = async (env: JwtEnv, baseUrl: string): Promise<Map<string, CryptoKey>> => {
  const keys = new Map<string, CryptoKey>()
  let res: Response
  try {
    res = await fetch(`${baseUrl}/auth/v1/.well-known/jwks.json`, {
      headers: env.SUPABASE_ANON_KEY ? { apikey: env.SUPABASE_ANON_KEY } : {},
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return keys
  }
  if (!res.ok) return keys
  let body: { keys?: Jwk[] }
  try {
    body = (await res.json()) as { keys?: Jwk[] }
  } catch {
    return keys
  }
  if (!Array.isArray(body.keys)) return keys
  for (const jwk of body.keys) {
    if (!jwk || typeof jwk.kid !== 'string' || !jwk.kid) continue
    const key = await importJwk(jwk)
    if (key) keys.set(jwk.kid, key)
  }
  return keys
}

/** Resolve the verify key for `kid`, using the cache when fresh and refetching on
 *  a miss (rotation) or staleness. null when the key can't be found. */
const getKey = async (
  env: JwtEnv,
  baseUrl: string,
  kid: string,
  now: number,
): Promise<CryptoKey | null> => {
  if (jwksCache && jwksCache.url === baseUrl && jwksCache.at > now - JWKS_TTL_MS) {
    const cached = jwksCache.keys.get(kid)
    if (cached) return cached
    // Fresh cache but unknown kid → a key may have rotated in; fall through to
    // a single refetch.
  }
  const keys = await fetchJwks(env, baseUrl)
  if (keys.size > 0) jwksCache = { url: baseUrl, at: now, keys }
  return keys.get(kid) ?? null
}

/** Verify the JWS signature for the given alg. The ES256 signature is the raw
 *  R||S (IEEE P1363) form crypto.subtle expects; RS256 is the PKCS#1 v1.5 form. */
const verifySig = async (
  alg: string,
  key: CryptoKey,
  sig: Uint8Array,
  data: Uint8Array,
): Promise<boolean> => {
  try {
    if (alg === 'RS256') {
      return await crypto.subtle.verify(
        { name: 'RSASSA-PKCS1-v1_5' },
        key,
        sig as BufferSource,
        data as BufferSource,
      )
    }
    if (alg === 'ES256') {
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        key,
        sig as BufferSource,
        data as BufferSource,
      )
    }
  } catch {
    /* fall through to false */
  }
  return false
}

interface JwtHeader {
  alg?: string
  kid?: string
  typ?: string
}
interface JwtPayload {
  sub?: string
  email?: string
  exp?: number
  nbf?: number
  iss?: string
  aud?: string | string[]
}

/**
 * Verify a Supabase access token (JWT) and return the caller's identity, or null
 * for ANY failure (bad shape, unknown/none alg, missing key, bad signature,
 * expired, wrong issuer/audience, missing sub) — never throws.
 *
 * @param token  the raw `header.payload.signature` JWT
 * @param env    SUPABASE_URL (required) + SUPABASE_ANON_KEY (apikey for JWKS)
 * @param now    epoch-ms clock (injectable for tests; defaults to Date.now())
 */
export async function verifySupabaseJwt(
  token: string | null | undefined,
  env: JwtEnv,
  now: number = Date.now(),
): Promise<VerifiedJwt | null> {
  if (!token || typeof token !== 'string') return null
  if (!env.SUPABASE_URL) return null
  const baseUrl = normalizeUrl(env.SUPABASE_URL)

  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headB64, payloadB64, sigB64] = parts
  if (!headB64 || !payloadB64 || !sigB64) return null

  // Header — decide the algorithm BEFORE any crypto. Reject 'none' and symmetric
  // algorithms (HS256): we hold no shared JWT secret, so only asymmetric verify
  // is sound; accepting 'none'/HS* would be a classic JWT bypass.
  const headStr = base64urlToString(headB64)
  if (!headStr) return null
  let header: JwtHeader
  try {
    header = JSON.parse(headStr) as JwtHeader
  } catch {
    return null
  }
  const alg = header.alg
  if (alg !== 'RS256' && alg !== 'ES256') return null
  if (typeof header.kid !== 'string' || !header.kid) return null

  const key = await getKey(env, baseUrl, header.kid, now)
  if (!key) return null

  const sig = base64urlToBytes(sigB64)
  if (!sig) return null
  const ok = await verifySig(alg, key, sig, enc.encode(`${headB64}.${payloadB64}`))
  if (!ok) return null

  // Claims — parsed only AFTER the signature checks out.
  const payloadStr = base64urlToString(payloadB64)
  if (!payloadStr) return null
  let payload: JwtPayload
  try {
    payload = JSON.parse(payloadStr) as JwtPayload
  } catch {
    return null
  }

  // exp / nbf are epoch SECONDS in a JWT (NOT ms like our HMAC ticket).
  if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null
  if (payload.exp * 1000 <= now) return null
  if (
    typeof payload.nbf === 'number' &&
    Number.isFinite(payload.nbf) &&
    payload.nbf * 1000 > now
  ) {
    return null
  }

  // iss must be exactly this project's auth issuer.
  if (payload.iss !== `${baseUrl}/auth/v1`) return null

  // aud must include the 'authenticated' audience (string or array form).
  const aud = payload.aud
  const audOk = aud === 'authenticated' || (Array.isArray(aud) && aud.includes('authenticated'))
  if (!audOk) return null

  if (typeof payload.sub !== 'string' || !payload.sub) return null

  const email =
    typeof payload.email === 'string' && payload.email ? payload.email : undefined
  return { sub: payload.sub, email }
}
