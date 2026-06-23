// Client-side mirror of the server's experiment gate (src/lib/server/
// experiments.ts). ONE GET /api/experiments returns both `eligible` (may this
// user toggle experiments at all — owner) and the resolved per-experiment
// `flags` (owner && the settings toggle). The client never computes the owner
// check itself: a signed-out / non-owner user gets eligible:false + all-false
// flags from the server, so experimental surfaces stay invisible regardless of
// any settings.json they forge.
//
// Owned by App, which passes `eligible` to the Settings panel (to reveal the
// owner-only toggle) and `flags` to the project panel (to gate which modules
// surface as tabs). `refresh` is called after a settings save so toggling an
// experiment shows/hides its module immediately.

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExperimentFlags, ExperimentsResponse } from '@/lib/types'

// Fail-closed defaults: nothing eligible, every flag off. Matches the shipped /
// signed-out / non-owner state until the first fetch resolves.
const NO_FLAGS: ExperimentFlags = { swarm: false }

export interface ExperimentsState {
  /** The user may toggle experiments at all (owner). Gates the settings toggle. */
  eligible: boolean
  /** Resolved per-experiment open state (owner && the settings toggle). */
  flags: ExperimentFlags
  /** True once a fetch has succeeded at least once. */
  loaded: boolean
  refresh: () => Promise<void>
}

export function useExperiments(): ExperimentsState {
  const [eligible, setEligible] = useState(false)
  const [flags, setFlags] = useState<ExperimentFlags>(NO_FLAGS)
  const [loaded, setLoaded] = useState(false)
  // Guards setState-after-unmount from a slow in-flight fetch.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/experiments', { cache: 'no-store' })
      if (!r.ok) return // route missing / server error — keep what we have
      const body = (await r.json()) as ExperimentsResponse
      if (!aliveRef.current) return
      setEligible(!!body.eligible)
      // Take only known flag keys, coerced to booleans — never trust the wire to
      // be exactly NO_FLAGS' shape.
      setFlags({ swarm: body.flags?.swarm === true })
      setLoaded(true)
    } catch {
      // Offline / server restarting — keep the last-known gate quietly.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The role flips when the user signs in/out via the external browser —
  // re-check on window focus (the same return-from-browser signal the auth poll
  // uses), debounced so a tab-switch flurry doesn't hammer the server. Mirrors
  // useCustomModules.
  const lastFocusRef = useRef(0)
  useEffect(() => {
    const onFocus = () => {
      const now = Date.now()
      if (now - lastFocusRef.current < 5000) return
      lastFocusRef.current = now
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  return { eligible, flags, loaded, refresh }
}
