// useJoinDeepLink.ts — subscribe the renderer to `openground://join?code=…` deep
// links delivered by the Electron main process (electron/preload.js bridge).
//
// Two delivery paths, both handled:
//   * WARM — the app is already open and the OS hands main a new URL
//     (`open-url` on macOS / `second-instance` argv on Win/Linux); main forwards it
//     via webContents.send → preload `onDeepLink(cb)`.
//   * COLD — the app was LAUNCHED by the link; main buffers it until the renderer
//     asks via preload `getInitialDeepLink()` (invoke → returns + clears the buffer).
//
// No-op in a plain browser (the bridge is absent), so this is safe to call
// unconditionally. The callback should be stable (useCallback) — the effect
// re-subscribes when it changes.

import { useEffect, useRef } from 'react'
import { parseJoinDeepLink } from './deepLink'

interface DeepLinkBridge {
  /** Subscribe to warm deep links; returns an unsubscribe (or void). */
  onDeepLink?: (cb: (url: string) => void) => (() => void) | void
  /** Fetch + clear a cold-start deep link the app was launched with. */
  getInitialDeepLink?: () => Promise<string | null>
}

const bridge = (): DeepLinkBridge | undefined =>
  (window as unknown as { openground?: DeepLinkBridge }).openground

export const useJoinDeepLink = (onJoinCode: (code: string) => void): void => {
  // The cold-start fetch is a ONE-SHOT (main clears the buffer on read). A ref —
  // which survives React StrictMode's mount → cleanup → re-mount double-invoke on
  // the SAME component instance — guarantees we drain it exactly once and never
  // lose it to the cleanup of the first (discarded) mount.
  const fetchedInitial = useRef(false)
  // Latest callback without re-subscribing the effect on every render.
  const cbRef = useRef(onJoinCode)
  cbRef.current = onJoinCode

  useEffect(() => {
    const og = bridge()
    if (!og) return

    // Warm links (app already running) — re-subscribed per mount, removed on cleanup.
    const off = og.onDeepLink?.((url) => {
      const code = parseJoinDeepLink(url)
      if (code) cbRef.current(code)
    })

    // Cold-start link (app launched by the link). Fetched once total; delivered
    // unconditionally (the host component stays mounted — only the effect is torn
    // down and re-run under StrictMode), so the drained buffer is never lost.
    if (!fetchedInitial.current) {
      fetchedInitial.current = true
      void og
        .getInitialDeepLink?.()
        .then((url) => {
          if (!url) return
          const code = parseJoinDeepLink(url)
          if (code) cbRef.current(code)
        })
        .catch(() => {})
    }

    return () => {
      if (typeof off === 'function') off()
    }
  }, [])
}
