import type { Doc as YDoc } from 'yjs'
import type { CollabSource, CollabTicketResponse, DocScope } from '../types'

/** Build the `?path=` (owner) or `?collabProjectId=` (member) query fragment for
 *  a collab source. Centralised so the ticket + project calls stay consistent. */
export const sourceQuery = (source: CollabSource): string =>
  'path' in source
    ? `path=${encodeURIComponent(source.path)}`
    : `collabProjectId=${encodeURIComponent(source.collabProjectId)}`

// Client transport for realtime collab — Cloudflare Durable Object edition.
//
// The WebSocket is opened against a y-partyserver Worker (a `YServer` Durable
// Object). The browser never holds a long-lived secret: it asks the loopback
// Hono server for a short-lived signed TICKET (GET /api/collab/ticket), which
// the Worker verifies (HMAC + exp + room match). partysocket re-runs the
// `params` callback on every (re)connect, so the ticket auto-refreshes without a
// manual timer.
//
// y-partyserver/provider (the YProvider default export) is loaded with a dynamic
// `import()` so the heavy transport is code-split out of the main bundle and
// never shipped to the credential-free / collab-OFF build. The fetch helper
// returns null on any non-2xx so callers degrade gracefully.

/** Mint a fresh collab ticket for (source, scope). `source` is a local project
 *  path (owner) OR a collabProjectId (member, no local folder). Returns null on
 *  any non-2xx (collab disabled / non-member / no collabProjectId / network) so
 *  the caller keeps its local-only path. */
export const fetchCollabTicket = async (
  source: CollabSource,
  scope: DocScope,
): Promise<CollabTicketResponse | null> => {
  try {
    const res = await fetch(
      `/api/collab/ticket?${sourceQuery(source)}&scope=${encodeURIComponent(scope)}`,
    )
    if (!res.ok) return null
    return (await res.json()) as CollabTicketResponse
  } catch {
    return null
  }
}

/** Accept either a full `wss://host[:port][/path]` URL or a bare `host:port`
 *  and return the host string partysocket wants (host, optionally `host:port`).
 *  partysocket builds the final ws URL itself from (host, room, party); it only
 *  needs the authority, not the scheme or path. */
export const hostFromUrl = (wsUrl: string): string => {
  const raw = (wsUrl ?? '').trim()
  if (!raw) return raw
  // Bare host[:port] (no scheme, no path) — hand it through untouched.
  if (!/^[a-z]+:\/\//i.test(raw) && !raw.includes('/')) return raw
  try {
    // URL() needs a scheme; normalise ws/wss/http/https → a parseable URL.
    const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `wss://${raw}`
    return new URL(withScheme).host
  } catch {
    // Last resort: strip any scheme prefix and any path, keep host[:port].
    return raw.replace(/^[a-z]+:\/\//i, '').split('/')[0]
  }
}

/** The Yjs Awareness surface we use for presence (u15) — typed loosely because
 *  the provider module is dynamically imported. setLocalState(null) clears our
 *  entry; getStates() maps clientID → that client's state; 'change'/'update'
 *  fire when any peer's state changes. `clientID` identifies the local client so
 *  callers can exclude themselves. */
export interface AwarenessLike {
  clientID: number
  setLocalState: (state: Record<string, unknown> | null) => void
  getStates: () => Map<number, Record<string, unknown>>
  on: (event: string, cb: () => void) => void
  off: (event: string, cb: () => void) => void
}

export interface DocConnection {
  /** The live y-partyserver provider (typed loosely — its module is dynamically
   *  imported, so the concrete class isn't in this module's type graph). */
  provider: {
    synced?: boolean
    on?: (ev: string, cb: (v: unknown) => void) => void
    awareness?: AwarenessLike
  }
  /** Tear down the provider + its WebSocket. */
  destroy: () => void
}

/** Bind a Y.Doc to its collab room over the y-partyserver Worker.
 *
 *  `info` is a freshly-minted ticket (so we have the wsUrl + room for the FIRST
 *  connect); `getFreshToken` is invoked by partysocket on every (re)connect to
 *  attach an up-to-date ticket as the `token` query param — that is the whole
 *  refresh mechanism (no timer). `party` MUST be the kebab-case of the Worker's
 *  Durable-Object class name `OgCollabDoc` → `og-collab-doc`.
 *
 *  Dynamic-imports the default export of "y-partyserver/provider" so the OFF
 *  build never bundles it. */
export const connectCollabDoc = async (
  doc: YDoc,
  info: CollabTicketResponse,
  getFreshToken: () => Promise<string | null>,
): Promise<DocConnection> => {
  const mod = await import('y-partyserver/provider')
  const YProvider = (mod as { default: new (...args: unknown[]) => unknown }).default
  const provider = new YProvider(hostFromUrl(info.wsUrl), info.room, doc, {
    party: 'og-collab-doc',
    // y-partyserver@2.2.0 names this the `params` provider (NOT `query`): it is
    // awaited on every (re)connect and its keys are appended to the WS
    // querystring, so the short-lived ticket auto-refreshes on reconnect with no
    // manual timer. The Worker reads ?token= in onBeforeConnect.
    params: async () => {
      const t = await getFreshToken()
      return t ? { token: t } : {}
    },
  }) as DocConnection['provider'] & { destroy: () => void }
  return {
    provider,
    destroy: () => {
      try {
        provider.destroy()
      } catch {
        /* best-effort teardown */
      }
    },
  }
}
