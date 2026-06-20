// server/routes/ticket.ts — OG-collab Worker RELAY CLIENT (zero-config auth).
//
// ZERO-CONFIG MODEL: the HMAC ticket secret (OPENGROUND_COLLAB_TICKET_SECRET)
// now lives ONLY on the operator Worker — never on a user's Hono. The loopback
// Hono therefore no longer MINTS tickets; it RELAYS. The browser still asks its
// local Hono for a ticket (GET /api/collab/ticket); the Hono presents the
// signed-in user's server-held Supabase access token to the Worker's
// `POST /ticket` endpoint (server-to-server — the token NEVER reaches the
// browser), and the Worker verifies the JWT + membership and mints the same
// short-lived HMAC ticket its WebSocket/asset gates already check. This module
// is that relay client plus the two tiny shared derivations the routes need.
//
// (The mint/verify wire-format implementation moved wholesale to the Worker —
// worker/src/{ticket,issueTicket,membership,jwt}.ts. The Hono side treats the
// returned ticket as an opaque, ~60s credential it forwards to the browser.)
//
// See docs/COLLAB_ZEROCONFIG_PLAN.md §2 (the operator-Worker model) for the
// full flow + the security properties preserved (no service-role key anywhere;
// tokens never reach the browser; OFF guarantee intact).

/** The public WS endpoint the client dials (the Worker host). null when unset.
 *  e.g. "wss://og-collab.<account>.workers.dev". The y-partyserver provider
 *  takes a host; the route returns this verbatim as CollabTicketResponse.wsUrl,
 *  and the relay derives the Worker's HTTP origin from it (workerHttpBase). */
export const readCollabWsUrl = (): string | null =>
  process.env.OPENGROUND_COLLAB_WS_URL?.trim() || null

/** ROOM string — the SINGLE shared-contract derivation (collabProjectId + ":" +
 *  scope). The Worker binds the minted ticket to this exact room, so the route
 *  derives it locally (from the pid+scope it validated) rather than trusting the
 *  Worker's echo. */
export const roomFor = (collabProjectId: string, scope: string): string =>
  `${collabProjectId}:${scope}`

/** The Worker's HTTP origin, derived from the configured WS endpoint
 *  (OPENGROUND_COLLAB_WS_URL). The relay (`POST /ticket`) and the asset proxy
 *  (`/assets/...`) live on the SAME Worker as the WebSocket, just over HTTP.
 *  Accepts ws/wss/http/https or a bare host; returns the origin (no path).
 *  Throws on an unparseable value — callers gate on readCollabWsUrl() first, so
 *  this only ever sees a configured URL. */
export const workerHttpBase = (wsUrl: string): string => {
  let raw = wsUrl.trim().replace(/^ws:\/\//i, 'http://').replace(/^wss:\/\//i, 'https://')
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  return new URL(raw).origin
}

/** A ticket the Worker minted for (pid, scope) — the opaque, short-lived HMAC
 *  credential plus its room + expiry. Shape mirrors the Worker's `POST /ticket`
 *  200 body. */
export interface WorkerTicket {
  room: string
  token: string
  expiresAt: number
}

/** Outcome of a relay call: the ticket on success, or a status the route maps to
 *  its own response (403 = the Worker rejected membership; any other failure —
 *  bad/expired token, Worker unconfigured, network — collapses to 502 upstream). */
export type RelayResult =
  | { ok: true; ticket: WorkerTicket }
  | { ok: false; status: number }

/**
 * Relay to the Worker's `POST /ticket`: present the caller's Supabase access
 * token server-to-server; the Worker verifies the JWT + og_project_members
 * membership (under that token, RLS — no Supabase secret) and mints the HMAC
 * ticket itself. Returns the ticket on 200; otherwise a coarse status the route
 * surfaces. NEVER throws and never exposes the access token beyond this hop.
 *
 * @param wsUrl       OPENGROUND_COLLAB_WS_URL (already confirmed non-null)
 * @param accessToken the signed-in user's FRESH Supabase access token (server-held)
 * @param pid         collabProjectId (og_projects.id)
 * @param scope       'board' | 'canvas:<id>'
 */
export const issueWorkerTicket = async (
  wsUrl: string,
  accessToken: string,
  pid: string,
  scope: string,
): Promise<RelayResult> => {
  let res: Response
  try {
    res = await fetch(`${workerHttpBase(wsUrl)}/ticket`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The ONLY place the Supabase access token leaves the loopback process —
        // a server-to-server TLS hop to the operator Worker, never the browser.
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ pid, scope }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return { ok: false, status: 502 }
  }
  // 403 = membership rejected at the Worker (a race vs. the local check, or an
  // eviction between them) — fail closed and surface it as 403. Everything else
  // (401 bad token, 400, 503 worker-unconfigured, 5xx) is an upstream problem.
  if (!res.ok) return { ok: false, status: res.status === 403 ? 403 : 502 }
  let body: Partial<WorkerTicket>
  try {
    body = (await res.json()) as Partial<WorkerTicket>
  } catch {
    return { ok: false, status: 502 }
  }
  if (
    typeof body.token !== 'string' ||
    typeof body.room !== 'string' ||
    typeof body.expiresAt !== 'number'
  ) {
    return { ok: false, status: 502 }
  }
  return { ok: true, ticket: { room: body.room, token: body.token, expiresAt: body.expiresAt } }
}
