// server/routes/auth.ts — Hono sub-router for the OPTIONAL app login.
//
// WHY A SERVER-SIDE OAUTH FLOW (not a browser → Supabase implicit grant):
// OPEN GROUND is a loopback Electron app, and Hono owns the fixed port 47776 in
// BOTH dev and prod (in dev Vite :5174 proxies /api → :47776). That single fact
// dissolves the usual dev/prod redirect-origin split: the OAuth redirect URI is
// ALWAYS http://127.0.0.1:47776/api/auth/callback. We run the full
// authorization-code + PKCE exchange HERE so the Supabase anon key and the
// resulting tokens never enter the client bundle — same posture as the feedback
// proxy. The login is entirely optional and gates nothing today; it is the seam
// a future billing/entitlement check will read (see docs/BILLING_PLAN.md).
//
// IMPORTANT BOUNDARY: the session this route persists is the APP's account, NOT
// the Claude CLI subscription token. See src/lib/server/authStore.ts.
//
// GRACEFUL DEGRADE: when SUPABASE_URL / SUPABASE_ANON_KEY are unset (the default
// public build), GET /api/auth/config reports { enabled: false } so the UI hides
// its entry, and every other auth route returns 503 "auth not configured".
//
// NO @supabase/supabase-js — plain fetch to the Supabase Auth REST API, node
// crypto for PKCE. Method-chaining style (new Hono().get(...).post(...)) so
// hc<AppType> recovers the JSON routes (config/start/session/signout). The
// callback returns a redirect/HTML and isn't an hc target — the SPA never calls
// it directly (the browser does, via Supabase's 302).

import { Hono } from 'hono'
import { randomBytes, createHash } from 'node:crypto'
import {
  readSession,
  writeSession,
  clearSession,
  type StoredSession,
} from '@/lib/server/authStore'
import type { AuthProvider, AuthUser, AuthSessionResponse } from '@/lib/types'

// The OAuth redirect URI — the same loopback Hono origin in dev and prod. This
// MUST be registered in the Supabase dashboard's URL Configuration (see
// docs/AUTH_SETUP.md). It is intentionally a constant, not derived from the
// request host, so it can't drift between environments.
const REDIRECT_URI = 'http://127.0.0.1:47776/api/auth/callback'

// --- Env-driven configuration (read lazily, per request) -------------------
// Same vars the feedback proxy uses — NO new secret. Read per request (not at
// module load) so the operator can set the env + restart without a code change,
// and so tests can flip them with vi.stubEnv between cases.
interface AuthConfig {
  url: string
  anonKey: string
}

const readAuthConfig = (): AuthConfig | null => {
  const url = process.env.SUPABASE_URL?.trim()
  const anonKey = process.env.SUPABASE_ANON_KEY?.trim()
  if (!url || !anonKey) return null
  return { url: url.replace(/\/+$/, ''), anonKey }
}

// --- PKCE helpers -----------------------------------------------------------
// base64url-encode raw bytes (no padding) — the form OAuth/PKCE expects.
const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

const makeVerifier = (): string => base64url(randomBytes(32))
const challengeFor = (verifier: string): string =>
  base64url(createHash('sha256').update(verifier).digest())
// --- Pending PKCE verifier (single in-flight login) -------------------------
// Supabase GoTrue manages its OWN OAuth `state` for the provider round-trip; a
// client-supplied `state` on /authorize triggers a "bad_oauth_state" rejection.
// So we do NOT send one (this matches supabase-js's own PKCE authorize URL) and
// instead hold the PKCE verifier server-side for the single login in flight.
// The verifier IS the security binding (PKCE): GoTrue ties the returned auth
// code to our code_challenge, the callback is loopback-only, and take() is
// single-use — so a remote/replayed callback can't forge a usable code. Stored
// on a globalThis singleton (mirroring __openground_runner) so it survives
// `tsx watch` reloads between /start and /callback. ~10 min TTL.
interface PendingAuth {
  verifier: string
  provider: AuthProvider
  ts: number
}

const PENDING_TTL_MS = 10 * 60 * 1000

declare global {
  // eslint-disable-next-line no-var
  var __openground_auth: { current: PendingAuth | null } | undefined
}

const pendingRef: { current: PendingAuth | null } =
  globalThis.__openground_auth ?? (globalThis.__openground_auth = { current: null })

const setPending = (p: PendingAuth): void => {
  pendingRef.current = p
}

// Read-and-clear (single-use). Returns null if absent or older than the TTL.
const takePending = (): PendingAuth | null => {
  const p = pendingRef.current
  pendingRef.current = null
  if (!p || p.ts < Date.now() - PENDING_TTL_MS) return null
  return p
}

// --- Supabase token-endpoint helpers ---------------------------------------
// Shapes are loose — we read only the fields we persist and tolerate the rest.
interface TokenResponse {
  access_token?: string
  refresh_token?: string
  expires_in?: number
  expires_at?: number
  user?: SupabaseUser
}

interface SupabaseUser {
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
const toAuthUser = (u: SupabaseUser, fallbackProvider: AuthProvider): AuthUser => {
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
const expiryFrom = (t: TokenResponse): number => {
  if (typeof t.expires_at === 'number') return t.expires_at * 1000
  if (typeof t.expires_in === 'number') return Date.now() + t.expires_in * 1000
  return Date.now() + 60 * 60 * 1000
}

// POST a token-endpoint grant. Returns the parsed body on 2xx, else null (the
// caller decides the user-facing outcome). Never throws into the route.
const postToken = async (
  config: AuthConfig,
  grantType: 'pkce' | 'refresh_token',
  body: Record<string, string>,
): Promise<TokenResponse | null> => {
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

// Tiny self-contained HTML for the callback window. No external assets (the
// browser tab is short-lived and may have no network to our origin's assets).
const callbackPage = (ok: boolean, message: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OPEN GROUND</title>
<style>
  body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;
    background:#0a0a0a;color:#fff;font:14px/1.6 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
  .card{text-align:center;max-width:360px;padding:32px}
  h1{font-size:18px;margin:0 0 8px;font-weight:600}
  p{margin:0;color:rgba(255,255,255,0.6)}
  .dot{color:${ok ? '#30D158' : '#FF453A'}}
</style></head>
<body><div class="card">
  <h1><span class="dot">●</span> ${ok ? 'Signed in' : 'Sign-in failed'}</h1>
  <p>${message}</p>
</div>
<script>setTimeout(function(){ try { window.close(); } catch (e) {} }, 1200);</script>
</body></html>`

export const authRoutes = new Hono()
  // --- GET /api/auth/config -------------------------------------------------
  // Gates the UI exactly like feedback/config. Reports only a boolean — never
  // echoes the URL or key.
  .get('/api/auth/config', (c) => {
    return c.json({ enabled: readAuthConfig() !== null })
  })

  // --- GET /api/auth/start --------------------------------------------------
  // Begin a login. Generates a PKCE pair, stashes the verifier server-side, and
  // returns the Supabase authorize URL for the SPA to open in the real browser.
  // 503 when unconfigured; 400 on an unknown provider.
  .get('/api/auth/start', (c) => {
    const config = readAuthConfig()
    if (!config) return c.json({ error: 'auth not configured' }, 503)

    const provider = c.req.query('provider')
    if (provider !== 'google' && provider !== 'github') {
      return c.json({ error: 'unsupported provider' }, 400)
    }

    const verifier = makeVerifier()
    const challenge = challengeFor(verifier)
    setPending({ verifier, provider, ts: Date.now() })

    // NO `state` param — GoTrue generates + validates its own OAuth state; a
    // client-supplied one causes "bad_oauth_state". This matches supabase-js.
    const url = new URL(`${config.url}/auth/v1/authorize`)
    url.searchParams.set('provider', provider)
    url.searchParams.set('redirect_to', REDIRECT_URI)
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')

    return c.json({ url: url.toString() })
  })

  // --- GET /api/auth/callback -----------------------------------------------
  // The provider → Supabase → 302 lands HERE in the user's browser (with ?code=
  // for the PKCE flow). We take the single in-flight verifier (read-and-clear),
  // exchange the code for tokens via PKCE, and persist the session. Responds with
  // a tiny HTML page (not JSON): this is a browser navigation, not an hc call.
  // Errors render the same page with a failure message so the user isn't dropped
  // on a blank tab.
  .get('/api/auth/callback', async (c) => {
    const config = readAuthConfig()
    if (!config) return c.html(callbackPage(false, 'Login is not configured.'), 503)

    const code = c.req.query('code')
    const errParam = c.req.query('error_description') || c.req.query('error')

    if (errParam) {
      return c.html(callbackPage(false, String(errParam)))
    }
    if (!code) {
      return c.html(callbackPage(false, 'Missing authorization code.'), 400)
    }

    // Single in-flight verifier, read-and-cleared (single-use → guards replay).
    // GoTrue binds the auth code to our code_challenge (PKCE), so the verifier is
    // the security binding; absent/expired = reject.
    const entry = takePending()
    if (!entry) {
      return c.html(callbackPage(false, 'This sign-in link has expired. Please try again.'), 400)
    }

    const token = await postToken(config, 'pkce', {
      auth_code: code,
      code_verifier: entry.verifier,
    })
    if (!token?.access_token || !token.refresh_token || !token.user?.id) {
      return c.html(callbackPage(false, 'Could not complete sign-in. Please try again.'), 502)
    }

    const session: StoredSession = {
      user: toAuthUser(token.user, entry.provider),
      expiresAt: expiryFrom(token),
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
    }
    await writeSession(session)

    return c.html(callbackPage(true, 'You can return to OPEN GROUND.'))
  })

  // --- GET /api/auth/session ------------------------------------------------
  // The SPA's source of truth for "who is signed in". Reads auth.json; if the
  // access token is expired (with a small skew), refreshes via the refresh-token
  // grant and PERSISTS the rotated refresh token (Supabase rotates it) before
  // returning. Returns { user } or { user: null } — NEVER any token. When
  // unconfigured this is a 200 { user: null } (a read query → "nobody is signed
  // in"), NOT a 503 — so the SPA's mount-time poll produces no console error on
  // the credential-free public build. The action routes (start/callback/signout)
  // still 503 when unconfigured.
  .get('/api/auth/session', async (c) => {
    const config = readAuthConfig()
    if (!config) return c.json<AuthSessionResponse>({ user: null })

    const stored = await readSession()
    if (!stored) return c.json<AuthSessionResponse>({ user: null })

    // 60s skew so we refresh just before a request would fail.
    if (stored.expiresAt - 60_000 > Date.now()) {
      return c.json<AuthSessionResponse>({ user: stored.user })
    }

    // Expired (or about to): refresh. On failure we clear the session and report
    // signed-out rather than serving a dead one.
    const token = await postToken(config, 'refresh_token', {
      refresh_token: stored.refreshToken,
    })
    if (!token?.access_token || !token.refresh_token) {
      await clearSession()
      return c.json<AuthSessionResponse>({ user: null })
    }

    const refreshed: StoredSession = {
      // Prefer the refreshed user object when present; else keep the stored one.
      user: token.user?.id ? toAuthUser(token.user, stored.user.provider) : stored.user,
      expiresAt: expiryFrom(token),
      accessToken: token.access_token,
      refreshToken: token.refresh_token, // rotated — persist the new one.
    }
    await writeSession(refreshed)
    return c.json<AuthSessionResponse>({ user: refreshed.user })
  })

  // --- POST /api/auth/signout -----------------------------------------------
  // Delete auth.json (best-effort) and ask Supabase to revoke the token (also
  // best-effort — a failed remote logout must not block local sign-out). Always
  // returns { ok: true } so the UI can clear unconditionally.
  .post('/api/auth/signout', async (c) => {
    const config = readAuthConfig()
    if (!config) return c.json({ error: 'auth not configured' }, 503)

    const stored = await readSession()
    if (stored) {
      try {
        await fetch(`${config.url}/auth/v1/logout`, {
          method: 'POST',
          headers: {
            apikey: config.anonKey,
            Authorization: `Bearer ${stored.accessToken}`,
          },
          signal: AbortSignal.timeout(5_000),
        })
      } catch {
        // Remote revoke is best-effort; the local clear below is what matters.
      }
    }
    await clearSession()
    return c.json({ ok: true })
  })
