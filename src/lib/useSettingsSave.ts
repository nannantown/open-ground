import { useCallback, useEffect, useRef, useState } from 'react'
import type { Settings } from './types'

/** Serialize preference patches; retain a failed write until the user retries. */
export function useSettingsSave(onSave: (patch: Partial<Settings>) => void | Promise<void>) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const writer = useRef(onSave)
  writer.current = onSave
  const pending = useRef<Partial<Settings>>({})
  const inFlight = useRef<Partial<Settings>>({})
  const running = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const drain = useCallback(async () => {
    if (running.current || !Object.keys(pending.current).length) return
    running.current = true
    if (mounted.current) setState('saving')
    try {
      while (Object.keys(pending.current).length) {
        const patch = pending.current
        pending.current = {}
        inFlight.current = patch
        try {
          await writer.current(patch)
        } catch {
          pending.current = { ...patch, ...pending.current }
          if (mounted.current) setState('error')
          return
        } finally { inFlight.current = {} }
      }
      if (mounted.current) setState('saved')
    } finally { running.current = false }
  }, [])
  const save = useCallback((patch: Partial<Settings>) => {
    pending.current = { ...pending.current, ...patch }
    void drain()
  }, [drain])
  return { save, retry: () => { void drain() }, state,
    getUnsavedPatch: () => ({ ...inFlight.current, ...pending.current }),
  }
}
