// swarmConnectivity.ts — "can a desk reach the API right now?"
//
// WHY THIS EXISTS (measured 2026-09-02). The owner closed the laptop, moved to
// a café, reconnected — and the commander stayed 待機中 with a review card
// waiting. Every part of the wake machinery had worked: the notice was typed
// into the desk, then three 10-minute pokes, then the one re-arm. All of them
// landed in a claude whose API call could not leave the machine, and every
// one was CHARGED as "the desk ignored us". By the time the network was back
// the budget was spent and the engine had gone deliberately mute (an ignored
// desk is a human matter). Nothing in the engine knew the difference between
// a desk that ignores and a Wi-Fi that drops.
//
// This module is that difference: one cheap reachability probe, cached, so
// the integrate pass can HOLD its voice while offline and spend it the moment
// the route is back (the edge is the event — see the offline-hold block in
// swarmOrchestrator's manager reflex).
//
// SEMANTICS. Online = ANY HTTP answer from the API host, 4xx included — the
// question is whether a request can get there and back, not whether it would
// be authorised. Offline = the fetch throws (ENOTFOUND / ENETUNREACH /
// ECONNREFUSED / the abort timeout). Known gap: a captive portal answers HTTP
// for everything, so a café login page reads as "online" until the owner
// clicks through — the desk's own turn then fails and the hold re-engages on
// the next probe once the portal is dismissed. Bounded by the cache TTL, never
// by a human.

export const CONNECTIVITY_PROBE_URL = 'https://api.anthropic.com/'
/** How long one verdict stands before the next tick re-probes. The integrate
 *  pass ticks every 15s; probing on every tick would double the API host's
 *  idle traffic for nothing — a route does not flap that fast. */
export const CONNECTIVITY_PROBE_TTL_MS = 30_000
/** The probe's own deadline. Shorter than the pass's patience, longer than a
 *  slow café DNS resolve. */
export const CONNECTIVITY_PROBE_TIMEOUT_MS = 3_000

export interface ConnectivityProbeDeps {
  fetch?: typeof fetch
  now?: () => number
  timeoutMs?: number
}

interface Verdict {
  online: boolean
  at: number
}

// Survives `tsx watch` reloads like every other in-memory server state (the
// terminal pool pattern) — a reload must not turn one probe into many.
declare global {
  // eslint-disable-next-line no-var
  var __openground_connectivity: { verdict: Verdict | null } | undefined
}
const store = (globalThis.__openground_connectivity ??= { verdict: null })

/** Is the API host reachable? Cached for {@link CONNECTIVITY_PROBE_TTL_MS};
 *  never throws (a probe that cannot run answers offline — the same direction
 *  a dropped route answers). */
export const probeOnline = async (deps: ConnectivityProbeDeps = {}): Promise<boolean> => {
  const now = (deps.now ?? Date.now)()
  const cached = store.verdict
  if (cached && now - cached.at < CONNECTIVITY_PROBE_TTL_MS) return cached.online
  const doFetch = deps.fetch ?? globalThis.fetch
  let online: boolean
  try {
    await doFetch(CONNECTIVITY_PROBE_URL, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? CONNECTIVITY_PROBE_TIMEOUT_MS),
    })
    online = true
  } catch {
    online = false
  }
  store.verdict = { online, at: now }
  return online
}

/** Test seam: forget the cached verdict. */
export const resetConnectivityForTests = (): void => {
  store.verdict = null
}
