// src/lib/server/supabaseAuth.ts — shared Supabase Auth primitives.
//
// Extracted from server/routes/auth.ts so non-route code (the custom-tab role
// resolver) can talk to the same Auth REST API without duplicating the env
// handling or token-grant plumbing. Routes stay thin adapters; everything here
// is plain logic with no Hono imports.
//
// BOUNDARY REMINDER: this is the OPTIONAL app account (Supabase Auth) — never
// the Claude CLI subscription token (see authStore.ts).

import {
  readSession,
  writeSession,
  type StoredSession,
} from './authStore'
import { isLockdownEnabledSync } from './lockdown'
import type { AuthProvider, AuthUser } from '../types'

// --- Env-driven configuration (read lazily, per call) -----------------------
// Same vars the feedback proxy uses — NO new secret. Read per call (not at
// module load) so the operator can set the env + restart without a code change,
// and so tests can flip them with vi.stubEnv between cases.
export interface AuthConfig {
  url: string
  anonKey: string
}

export const readAuthConfig = (): AuthConfig | null => {
  const url = process.env.SUPABASE_URL?.trim()
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim()
  if (!url || !anonKey) return null
  return { url: url.replace(/\/+$/, ''), anonKey }
}

// --- Supabase token-endpoint helpers ----------------------------------------
// Shapes are loose — we read only the fields we persist and tolerate the rest.
export interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  expires_at?: number
  user?: SupabaseUser
}

export interface SupabaseUser {
  id?: string
  email?: string
  app_metadata?: { provider?: string }
  user_metadata?: {
    full_name?: string
    name?: string
    user_name?: string
    avatar_url?: string
    picture?: string
  }
}

// Map a Supabase user object to our public, client-safe AuthUser. Providers
// label the same concepts differently (Google: full_name/picture; GitHub:
// user_name/avatar_url), so we coalesce. `provider` falls back to the verifier's
// provider when Supabase doesn't echo app_metadata.provider.
export const toAuthUser = (u: SupabaseUser, fallbackProvider: AuthProvider): AuthUser => {
  const meta = u.user_metadata ?? {}
  const provider = (u.app_metadata?.provider as AuthProvider) || fallbackProvider
  return {
    id: u.id ?? '',
    email: u.email,
    name: meta.full_name || meta.name || meta.user_name,
    avatarUrl: meta.avatar_url || meta.picture,
    provider,
  }
}

// Compute an epoch-ms expiry from whichever field Supabase returned. expires_at
// is epoch SECONDS; expires_in is a relative seconds count. Default to a short
// window so a missing value triggers a refresh rather than trusting forever.
export const expiryFrom = (t: TokenResponse): number => {
  if (typeof t.expires_at === 'number') return t.expires_at * 1000
  if (typeof t.expires_in === 'number') return Date.now() + t.expires_in * 1000
  return Date.now() + 60 * 60 * 1000
}

// POST a token-endpoint grant. Returns the parsed body on 2xx, else null (the
// caller decides the user-facing outcome). Never throws into the caller.
export const postToken = async (
  config: AuthConfig,
  grantType: 'pkce' | 'refresh_token',
  body: Record<string, string>,
): Promise<TokenResponse | null> => {
  // Work mode (lockdown): no token grant of ANY kind leaves the machine. Every
  // caller already handles null as "grant failed" — under lockdown that reads
  // as signed-out, which is exactly the UI the routes report. (Belt to the
  // route gates' braces; the fetch floor below both would refuse the URL too.)
  if (isLockdownEnabledSync()) return null
  try {
    const res = await fetch(
      `${config.url}/auth/v1/token?grant_type=${grantType}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: config.anonKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error(`[openground:auth] token ${grantType} ${res.status}: ${detail}`)
      return null
    }
    return (await res.json()) as TokenResponse
  } catch (e) {
    console.error(
      '[openground:auth] token request failed',
      e instanceof Error ? e.message : e,
    )
    return null
  }
}

// A still-valid session (access token + its epoch-ms expiry) for the signed-in
// app account, refreshing (and persisting the rotated refresh token) when the
// stored one is expired or about to be. Returns null when signed out,
// unconfigured, or the refresh fails. Unlike GET /api/auth/session this NEVER
// clears the stored session on failure — a transient network error during a
// background check must not sign the user out; the session route decides that.
export const getFreshSession = async (): Promise<{
  accessToken: string
  expiresAt: number
} | null> => {
  // Work mode (lockdown): report "no session" WITHOUT reading or refreshing.
  // This single early-return is what keeps every Supabase REST caller
  // (projectMembers, collabInvites, roles) off the network — they all gate on
  // this token. The stored session is untouched, so lockdown-off restores it.
  if (isLockdownEnabledSync()) return null
  const config = readAuthConfig()
  if (!config) return null
  const stored = await readSession()
  if (!stored) return null
  // 60s skew so we refresh just before a request would fail.
  if (stored.expiresAt - 60_000 > Date.now()) {
    return { accessToken: stored.accessToken, expiresAt: stored.expiresAt }
  }
  const token = await postToken(config, 'refresh_token', {
    refresh_token: stored.refreshToken,
  })
  if (!token?.access_token || !token.refresh_token) return null
  const refreshed: StoredSession = {
    user: token.user?.id ? toAuthUser(token.user, stored.user.provider) : stored.user,
    expiresAt: expiryFrom(token),
    accessToken: token.access_token,
    refreshToken: token.refresh_token, // rotated — persist the new one.
  }
  await writeSession(refreshed)
  return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt }
}

// Back-compat helper: just the access token (used by the custom-tab role
// resolver and any caller that doesn't need the expiry).
export const getFreshAccessToken = async (): Promise<string | null> =>
  (await getFreshSession())?.accessToken ?? null

// Public Realtime config for the loopback SPA: the Supabase URL + a PUBLIC key
// (the modern publishable key when SUPABASE_PUBLISHABLE_KEY is set, else the
// anon key — both are public by design). null when unconfigured, so the collab
// UI stays hidden on the credential-free build. NEVER a secret.
export interface RealtimePublicConfig {
  url: string
  publishableKey: string
}

export const readRealtimeConfig = (): RealtimePublicConfig | null => {
  const base = readAuthConfig()
  if (!base) return null
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim() || base.anonKey
  return { url: base.url, publishableKey }
}
