import { useEffect, useState } from 'react'

// Reflects the browser's connectivity (navigator.onLine) and keeps it live via
// the standard `online` / `offline` window events. OPEN GROUND runs against a
// loopback server, but firing a run still needs a working fetch to POST
// /api/run and an SSE stream to follow it — when the browser reports offline,
// those POSTs fail, so gating the "run all" action on this is the right
// behaviour (and the standard browser API, not a hack).
//
// SSR-safe: defaults to `true` when `navigator` is unavailable.
export const useOnlineStatus = (): boolean => {
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  useEffect(() => {
    const up = () => setOnline(true)
    const down = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', down)
    // Re-sync once on mount in case the status changed before listeners attached.
    setOnline(navigator.onLine)
    return () => {
      window.removeEventListener('online', up)
      window.removeEventListener('offline', down)
    }
  }, [])
  return online
}
