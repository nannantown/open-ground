// Client-side mirror of the custom-modules store (docs/CUSTOM_TABS_PLAN.md).
//
// One GET /api/custom-modules returns BOTH the caller's role (decided
// server-side from the stored app-login session — the client never computes
// it) and the on-disk module list. ProjectPanel composes the tab row from the
// modules and gates the management UI ("+", Market, owner actions) on the
// role. `loaded` distinguishes "no custom tabs" from "haven't heard from the
// server yet" so a persisted `custom:<id>` tab isn't discarded before the
// list arrives.

import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CustomModuleDef,
  CustomModulesResponse,
  CustomTabRole,
} from '@/lib/types'

export interface CustomModulesState {
  role: CustomTabRole
  modules: CustomModuleDef[]
  /** True once a fetch has succeeded at least once. */
  loaded: boolean
  refresh: () => Promise<void>
}

export function useCustomModules(): CustomModulesState {
  const [role, setRole] = useState<CustomTabRole>('none')
  const [modules, setModules] = useState<CustomModuleDef[]>([])
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
      const r = await fetch('/api/custom-modules', { cache: 'no-store' })
      if (!r.ok) return // route missing / server error — keep what we have
      const body = (await r.json()) as CustomModulesResponse
      if (!aliveRef.current) return
      setRole(body.role ?? 'none')
      setModules(Array.isArray(body.modules) ? body.modules : [])
      setLoaded(true)
    } catch {
      // Offline / server restarting — keep the last-known list quietly.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // The role flips when the user signs in/out via the external browser —
  // re-check on window focus (the same return-from-browser signal the auth
  // poll uses), debounced so a tab-switch flurry doesn't hammer the server.
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

  return { role, modules, loaded, refresh }
}
