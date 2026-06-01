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
// spawn on every mount). `nonce` re-runs the probe when bumped (e.g. after the
// user installs the CLI and re-opens Settings).
export const useClaudeProbe = (enabled: boolean, nonce = 0): ClaudeProbe | null => {
  const [probe, setProbe] = useState<ClaudeProbe | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setProbe(null)
    ;(async () => {
      try {
        // A bumped nonce means the user explicitly asked to re-check (e.g. after
        // installing the CLI) — bypass the server's short probe cache.
        const res = await api.api['claude-probe'].$get(
          nonce > 0 ? { query: { force: '1' } } : {},
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
  }, [enabled, nonce])

  return probe
}
