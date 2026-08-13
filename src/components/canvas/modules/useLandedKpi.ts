// useLandedKpi — the front-end half of GET /api/swarm/kpi/landed (the durable
// 「外向き着地/週」dial). SwarmModule calls this ONCE and threads the result into
// SwarmManagerPane as a prop, keeping the pane purely presentational (its stated
// contract — it never fetches).
//
// Polling is deliberately lazy (5 min): the ledger changes at most a few times a
// day (a land is a human merge), and the pane re-mounts on tab entry anyway,
// which refetches immediately. Failure shape: any !ok / network error leaves the
// last good data in place (or null before the first success) — the section
// simply doesn't render until the server answers, and a transient error never
// erases a chart the owner is looking at.

import { useEffect, useState } from 'react'
import type { SwarmLandedKpi } from '@/lib/types'

const POLL_MS = 5 * 60_000

export const useLandedKpi = (): SwarmLandedKpi | null => {
  const [data, setData] = useState<SwarmLandedKpi | null>(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/swarm/kpi/landed')
        if (!res.ok) return
        const body = (await res.json()) as SwarmLandedKpi
        if (alive && Array.isArray(body.weeks) && body.totals) setData(body)
      } catch {
        /* transient (offline / server restarting) — the next poll retries */
      }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return data
}
