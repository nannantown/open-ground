import { useEffect, useState } from 'react'
import { api } from '@/lib/api-client'

// Shape mirrors the server's ClaudeProbe (server/routes/misc.ts). Kept inline
// (not in lib/types.ts) because it's a small UI-only readiness payload, not
// part of the persisted client/server data contract.
export interface ClaudeProbe {
  installed: boolean
  version: string | null
  message: string
}

// Lightweight readiness check for the local `claude` CLI. OPEN GROUND is
// subscription-only — it spawns the user's `claude` CLI, never an API key — so
// a missing CLI means every run fails with a bare "command not found". This
// hook surfaces that *before* a run so Settings / the empty-state can warn.
//
// `enabled` lets callers skip the probe until a panel actually opens (avoids a
// spawn on every mount). `nonce` re-runs the probe when bumped (e.g. a Settings
// "re-check" button). Additionally, while the CLI is reported missing the hook
// auto re-checks whenever the window regains focus — so a user who installs
// `claude` in their own terminal and switches back sees the "not found" state
// clear itself, with no app restart. (claude owns its own auth; OPEN GROUND
// only detects presence and never manages the login.)
export const useClaudeProbe = (enabled: boolean, nonce = 0): ClaudeProbe | null => {
  const [probe, setProbe] = useState<ClaudeProbe | null>(null)
  // Bumped on window focus while the CLI is still missing (see below). Kept
  // separate from the caller's `nonce` so a focus re-check and an explicit
  // re-check don't clobber one another.
  const [focusNonce, setFocusNonce] = useState(0)

  // Auto re-check on focus ONLY while missing (or not yet probed). Once the CLI
  // is detected this unsubscribes — we never re-probe a settled positive, so it
  // costs nothing in the normal case.
  const missing = probe === null || !probe.installed
  useEffect(() => {
    if (!enabled || !missing) return
    const recheck = () => {
      if (document.visibilityState === 'visible') setFocusNonce((n) => n + 1)
    }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => {
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  }, [enabled, missing])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // We do NOT reset to null on a re-fetch — keeping the last value avoids a
    // flicker (a transient "missing → ok → missing") each time the probe re-runs
    // on focus. The initial value is already null (useState).
    ;(async () => {
      try {
        // An explicit re-check (nonce) or a focus-driven re-check bypasses the
        // server's short probe cache so "I just installed it" reflects fast.
        const force = nonce > 0 || focusNonce > 0
        const res = await api.api['claude-probe'].$get(
          force ? { query: { force: '1' } } : {},
          { init: { cache: 'no-store' } },
        )
        const data = (await res.json()) as ClaudeProbe
        if (!cancelled) setProbe(data)
      } catch {
        // Server unreachable — treat as "unknown" (null), not "missing", so we
        // don't cry wolf when it's our own fetch that failed.
        if (!cancelled) setProbe(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [enabled, nonce, focusNonce])

  return probe
}
