import { useEffect, useState } from 'react'
import { api } from '@/lib/api-client'

// Shape mirrors the server's ClaudeConnection (src/lib/server/claudeConnection.ts,
// surfaced by GET /api/claude-connection). Kept inline (not in lib/types.ts)
// because it's a small UI-only status payload, not part of the persisted
// client/server data contract.
export interface ClaudeConnection {
  /** The `claude` CLI is present and runnable on this machine. */
  installed: boolean
  /** Signed in to a Claude subscription (only meaningful when installed). */
  loggedIn: boolean
  /** Subscription tier (pro/max/team/enterprise), if any. */
  plan: string | null
  /** Account email, if signed in. */
  email: string | null
  /** Human-readable one-liner for tooltips / settings. */
  message: string
}

// Passive, cross-platform "is the user's Claude connected?" status. OPEN GROUND
// is subscription-only — it drives the user's `claude` CLI, never an API key —
// and `claude auth status` answers both halves at once: is the CLI runnable
// (installed) AND is the user signed in (loggedIn). This hook just REFLECTS
// that; it never gates anything.
//
// `enabled` lets callers skip the check until a panel actually opens (avoids a
// spawn on every mount). `nonce` re-runs the check when bumped (e.g. a Settings
// "Re-check" button). Additionally, while NOT connected the hook auto re-checks
// whenever the window regains focus — so a user who installs / signs in to
// `claude` in their own terminal and switches back sees the status clear itself,
// with no app restart. (claude owns its own auth; OPEN GROUND only reflects it.)
export const useClaudeConnection = (
  enabled: boolean,
  nonce = 0,
): ClaudeConnection | null => {
  const [conn, setConn] = useState<ClaudeConnection | null>(null)
  // Bumped on window focus while not yet connected (see below). Kept separate
  // from the caller's `nonce` so a focus re-check and an explicit re-check don't
  // clobber one another.
  const [focusNonce, setFocusNonce] = useState(0)

  // Auto re-check on focus ONLY while not connected (or not yet checked). Once
  // connected this unsubscribes — we never re-check a settled positive, so it
  // costs nothing in the normal case.
  const connected = conn !== null && conn.installed && conn.loggedIn
  useEffect(() => {
    if (!enabled || connected) return
    const recheck = () => {
      if (document.visibilityState === 'visible') setFocusNonce((n) => n + 1)
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [enabled, connected])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // We do NOT reset to null on a re-fetch — keeping the last value avoids a
    // flicker each time the status re-runs on focus. The initial value is
    // already null (useState).
    ;(async () => {
      try {
        // An explicit re-check (nonce) or a focus-driven re-check bypasses the
        // server's short cache so "I just connected it" reflects fast.
        const force = nonce > 0 || focusNonce > 0
        const res = await api.api['claude-connection'].$get(
          force ? { query: { force: '1' } } : {},
          { init: { cache: 'no-store' } },
        )
        const data = (await res.json()) as ClaudeConnection
        if (!cancelled) setConn(data)
      } catch {
        // Server unreachable — treat as "unknown" (null), not "disconnected", so
        // we don't cry wolf when it's our own fetch that failed.
        if (!cancelled) setConn(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, nonce, focusNonce])

  return conn
}
