// useGroundLook — "the owner is looking at this project" for the Ground card
// marks (src/lib/groundLamp.ts, 2026-09-26). Two kinds of look:
//   'opened' — the project is open at all (ProjectPanel). Clears the eye only.
//   'seen'   — the agent-team bar (the president's seat) is unfolded
//              (SwarmBottomBar). Also clears the president's hand.
// Stamped when the look starts and again when it ends (leave, fold, window
// hidden) so whatever arrived WHILE the owner sat here counts as seen too.

import { useEffect } from 'react'
import { GROUND_SEEN_EVENT } from '@/lib/groundLamp'

export const useGroundLook = (path: string | undefined, kind: 'opened' | 'seen', active = true): void => {
  useEffect(() => {
    if (!active || !path) return
    const stamp = () =>
      void fetch(`/api/ground/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
        keepalive: true,
      })
        .then((r) => {
          if (r.ok) window.dispatchEvent(new Event(GROUND_SEEN_EVENT))
        })
        .catch(() => {})
    if (!document.hidden) stamp()
    document.addEventListener('visibilitychange', stamp)
    return () => {
      document.removeEventListener('visibilitychange', stamp)
      stamp()
    }
  }, [active, path, kind])
}
