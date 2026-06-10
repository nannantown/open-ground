// src/lib/auth/AuthContext.tsx — the SINGLE client-side seam for the app login.
//
// This hook is intentionally the one place the rest of the app asks "who is
// signed in?". A future billing / entitlement check will read from HERE (and
// from the /api/auth/* routes + the Session type) — DO NOT build any billing or
// premium gating now; login is optional and gates nothing today. See
// docs/BILLING_PLAN.md.
//
// FLOW (server-side PKCE on the loopback Hono origin — see server/routes/auth.ts):
//  1. signIn(provider) → GET /api/auth/start → { url }.
//  2. Open `url` in the user's REAL browser: window.openground.openExternal(url)
//     under Electron (validated allow-list in main.js), else window.open in a
//     plain dev browser.
//  3. Poll GET /api/auth/session AND re-check when the window regains focus /
//     visibility (the user returns from the browser after authorizing). Stop on
//     a user or after a timeout.
//  4. The browser tab hits /api/auth/callback (server exchanges + persists), so
//     the next /session poll returns the user. Tokens never reach this client.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api } from '@/lib/api-client'
import { useT } from '@/i18n/I18nContext'
import type {
  AuthProvider as OAuthProvider,
  AuthUser,
  AuthSessionResponse,
} from '@/lib/types'

export type AuthStatus = 'loading' | 'signed-out' | 'signed-in'

interface AuthContextValue {
  user: AuthUser | null
  status: AuthStatus
  /** True while a sign-in round-trip is in flight (provider clicked → browser
   *  open → polling for the session). Drives the modal's disabled/spinner state
   *  so the buttons can't be re-clicked into a second browser tab + poll. */
  signingIn: boolean
  /** Last sign-in error to surface to the user (e.g. couldn't open the browser),
   *  or null. Cleared when a new sign-in starts. */
  authError: string | null
  signIn: (provider: OAuthProvider) => Promise<void>
  signOut: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

// How long to keep polling after opening the browser before giving up (the user
// may have abandoned the flow). The focus/visibility listeners catch the common
// "authorized, came back" case faster than the poll interval.
const POLL_INTERVAL_MS = 2_000
const POLL_TIMEOUT_MS = 3 * 60 * 1000

// Minimal shape for the optional Electron bridge (electron/preload.js). We
// feature-detect it; in a plain dev browser it's absent and we fall back to
// window.open.
interface OpenGroundBridge {
  openExternal?: (url: string) => Promise<unknown>
}
const bridge = (): OpenGroundBridge | undefined =>
  (window as unknown as { openground?: OpenGroundBridge }).openground

// Returns true if the browser was (best-effort) launched, false if we know it
// failed. Under Electron we await the IPC handler: main.js returns false when
// the URL fails its allow-list, and it can throw — both mean "didn't open", so
// signIn can surface an error instead of silently polling for 3 minutes.
const openInBrowser = async (url: string): Promise<boolean> => {
  const og = bridge()
  if (og?.openExternal) {
    try {
      const r = await og.openExternal(url)
      return r !== false
    } catch {
      return false
    }
  }
  // Dev browser: a new tab. noopener so the OAuth page can't reach back. With
  // noopener window.open returns null even on success, so we can't detect a
  // popup block here — assume success in the dev path.
  try {
    window.open(url, '_blank', 'noopener')
    return true
  } catch {
    return false
  }
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useT()
  const [user, setUser] = useState<AuthUser | null>(null)
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [signingIn, setSigningIn] = useState(false)
  const [authError, setAuthError] = useState<string | null>(null)
  // Active poll timer + deadline, so signIn can start polling and any session
  // appearance (or timeout) can stop it. Refs (not state) so the focus listener
  // closure always sees the latest without re-subscribing.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const pollDeadline = useRef(0)
  // The user clicked a provider at least once this session. Used by the focus
  // listener to recover a sign-in that completed AFTER the poll window expired
  // (auth took >3min), without spamming /session on every focus when the user
  // never tried to sign in.
  const attemptedSignIn = useRef(false)
  // Mirror of `status` for the focus listener closure (avoids re-subscribing).
  const statusRef = useRef<AuthStatus>('loading')
  useEffect(() => {
    statusRef.current = status
  }, [status])

  // Fetch the current session once. Returns the user (or null). Best-effort: a
  // 503 (unconfigured) or network error resolves to signed-out.
  const fetchSession = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const res = await api.api.auth.session.$get()
      if (!res.ok) return null
      const data = (await res.json()) as AuthSessionResponse
      return data.user ?? null
    } catch {
      return null
    }
  }, [])

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearInterval(pollTimer.current)
      pollTimer.current = null
    }
    pollDeadline.current = 0
    // Whether the poll ended by success, timeout, or sign-out, we're no longer
    // actively signing in — re-enable the provider buttons.
    setSigningIn(false)
  }, [])

  const refresh = useCallback(async () => {
    const u = await fetchSession()
    setUser(u)
    setStatus(u ? 'signed-in' : 'signed-out')
    if (u) stopPolling()
  }, [fetchSession, stopPolling])

  // Poll until a user appears or the deadline passes. Idempotent — calling it
  // again just resets the deadline (a second signIn extends the window).
  const startPolling = useCallback(() => {
    pollDeadline.current = Date.now() + POLL_TIMEOUT_MS
    if (pollTimer.current) return
    pollTimer.current = setInterval(async () => {
      if (Date.now() > pollDeadline.current) {
        stopPolling()
        return
      }
      const u = await fetchSession()
      if (u) {
        setUser(u)
        setStatus('signed-in')
        stopPolling()
      }
    }, POLL_INTERVAL_MS)
  }, [fetchSession, stopPolling])

  // Initial session probe on mount.
  useEffect(() => {
    void refresh()
    return stopPolling
  }, [refresh, stopPolling])

  // When the user returns from the external browser, the window regains focus /
  // becomes visible — re-check immediately so the signed-in UI snaps in without
  // waiting for the next poll tick. Only re-checks while a poll is in flight.
  useEffect(() => {
    const recheck = () => {
      // Poll in flight → re-check now (fast path for "came back from browser").
      if (pollTimer.current) {
        void refresh()
        return
      }
      // Poll already expired (auth took longer than the window) but the user did
      // attempt sign-in and still isn't signed in → one cheap re-check on focus.
      if (attemptedSignIn.current && statusRef.current !== 'signed-in') {
        void refresh()
      }
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recheck()
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  const signIn = useCallback(
    async (provider: OAuthProvider) => {
      setAuthError(null)
      setSigningIn(true)
      attemptedSignIn.current = true
      const fail = (msg: string) => {
        setAuthError(msg)
        setSigningIn(false)
      }
      try {
        const res = await api.api.auth.start.$get({ query: { provider } })
        if (!res.ok) return fail(t('auth.error.start'))
        const data = (await res.json()) as { url?: string }
        if (!data.url) return fail(t('auth.error.start'))
        const opened = await openInBrowser(data.url)
        if (!opened) {
          return fail(t('auth.error.openBrowser'))
        }
        // signingIn stays true; stopPolling (on success / timeout) clears it.
        startPolling()
      } catch {
        fail(t('auth.error.start'))
      }
    },
    [startPolling, t],
  )

  const signOut = useCallback(async () => {
    try {
      await api.api.auth.signout.$post()
    } catch {
      // Even if the request fails, clear locally — the server route is
      // best-effort too, and the next session probe will reconcile.
    }
    stopPolling()
    attemptedSignIn.current = false
    setAuthError(null)
    setUser(null)
    setStatus('signed-out')
  }, [stopPolling])

  return (
    <AuthContext.Provider
      value={{ user, status, signingIn, authError, signIn, signOut, refresh }}
    >
      {children}
    </AuthContext.Provider>
  )
}

// The single seam. Throws if used outside AuthProvider so a missing wrap is a
// loud dev error, not a silent signed-out state.
export const useAuth = (): AuthContextValue => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
