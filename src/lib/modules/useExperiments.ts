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
const NO_FLAGS: ExperimentFlags = { swarm: false, sandbox: false, persona: false }

/** The PUBLIC swarm opt-in state (all users). Fail-closed until first fetch. */
const NO_OPT_IN = { available: false, enabled: false }

export interface ExperimentsState {
  /** The user may toggle experiments at all (owner). Gates the settings toggle. */
  eligible: boolean
  /** Resolved per-experiment open state (owner && the settings toggle). */
  flags: ExperimentFlags
  /** The public swarm opt-in: `available` (this machine — macOS) gates the
   *  Settings toggle's visibility for ALL users; `enabled` reflects the choice. */
  swarmOptIn: { available: boolean; enabled: boolean }
  /** The public persona opt-in: `available` is true on every platform;
   *  `enabled` reflects the choice. */
  personaOptIn: { available: boolean; enabled: boolean }
  /** True once a fetch has succeeded at least once. */
  loaded: boolean
  refresh: () => Promise<void>
}

export function useExperiments(): ExperimentsState {
  const [eligible, setEligible] = useState(false)
  const [flags, setFlags] = useState<ExperimentFlags>(NO_FLAGS)
  const [swarmOptIn, setSwarmOptIn] = useState(NO_OPT_IN)
  const [personaOptIn, setPersonaOptIn] = useState(NO_OPT_IN)
  const [loaded, setLoaded] = useState(false)
  // Guards setState-after-unmount from a slow in-flight fetch.
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // Holds the last flags object handed out, so a refresh that resolves to the
  // same values (the common case — the focus-triggered re-check almost never
  // actually changes anything) reuses the SAME reference instead of minting a
  // new one. Consumers (e.g. ProjectPanel's moduleGate) can then depend on the
  // `flags` object itself and have it stay stable across no-op polls, rather
  // than hand-picking individual keys to watch — which silently stops tracking
  // a newly added ExperimentId until someone remembers to extend the dep list.
  const flagsRef = useRef(flags)
  flagsRef.current = flags

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/experiments', { cache: 'no-store' })
      if (!r.ok) return // route missing / server error — keep what we have
      const body = (await r.json()) as ExperimentsResponse
      if (!aliveRef.current) return
      setEligible(!!body.eligible)
      // Take only known flag keys, coerced to booleans — never trust the wire to
      // be exactly NO_FLAGS' shape.
      const next: ExperimentFlags = {
        swarm: body.flags?.swarm === true,
        sandbox: body.flags?.sandbox === true,
        persona: body.flags?.persona === true,
      }
      const prev = flagsRef.current
      const unchanged = (Object.keys(next) as (keyof ExperimentFlags)[]).every(
        (k) => prev[k] === next[k],
      )
      if (!unchanged) setFlags(next)
      setSwarmOptIn({
        available: body.swarmOptIn?.available === true,
        enabled: body.swarmOptIn?.enabled === true,
      })
      setPersonaOptIn({
        available: body.personaOptIn?.available === true,
        enabled: body.personaOptIn?.enabled === true,
      })
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

  return { eligible, flags, swarmOptIn, personaOptIn, loaded, refresh }
}
