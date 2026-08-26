import { routePartykitRequest, type Lobby } from 'partyserver'
import { verifyTicket } from './ticket'
import { handleAssetRequest } from './assets'
import { handleTicketRequest } from './issueTicket'
import { handleAdminRequest } from './admin'
import { OgCollabDoc } from './OgCollabDoc'

// OPEN GROUND realtime collab Worker — entry point.
//
// One Durable Object class (OgCollabDoc) hosts every Yjs room. partyserver's
// `routePartykitRequest` maps an incoming request at
//   /parties/<party>/<room>
// to the matching DO namespace, where <party> is the kebab-cased class name.
// OgCollabDoc => "og-collab-doc", which MUST equal the `party` the client
// passes to its YProvider.
//
// AUTH: every WebSocket upgrade is gated by `onBeforeConnect` BEFORE the socket
// is accepted. We verify the short-lived HMAC ticket (?token=) against the
// shared secret and confirm it was minted for THIS room. An invalid/expired/
// mismatched ticket gets a 401 and the connection is never established. (The DO
// itself then treats every accepted connection as a verified member.)
//
// ROOM identity: partyserver derives the room from the URL path segment exactly
// as the DO address (`idFromName(name)`) — RAW, not URL-decoded — and the
// y-partyserver client inserts the room into the URL RAW as well. So the
// `lobby.name` partyserver hands us IS the room string the client used (e.g.
// "<pid>:board" or "<pid>:canvas:<id>"), with no encoding round-trip. We use it
// directly as the room to bind the ticket against.

export interface Env {
  // Binding name === DO class name (see wrangler.jsonc). partyserver resolves
  // the namespace for party "og-collab-doc" from this. Parameterised by the
  // class so the operator purge route can call `stub.purgeStorage()` over RPC
  // with types (partyserver's own routing does not need the parameter).
  OgCollabDoc: DurableObjectNamespace<OgCollabDoc>
  // Shared HMAC secret — set via `wrangler secret put OPENGROUND_COLLAB_TICKET_SECRET`.
  // Must equal the value the Hono ticket minter signs with.
  OPENGROUND_COLLAB_TICKET_SECRET: string
  // R2 bucket for shared canvas image bytes (u14b). Optional at the type level
  // so the WebSocket/health paths work even before the bucket is provisioned;
  // the asset routes 503 when it's absent. See wrangler.jsonc `r2_buckets`.
  ASSET_BUCKET?: R2Bucket
  // Supabase PUBLIC config for the ZERO-CONFIG ticket route (POST /ticket): the
  // Worker verifies a member's Supabase JWT against the project's JWKS and reads
  // og_project_members under that JWT (RLS) to mint a ticket itself — so a member
  // can join without the owner's Hono server running. Both optional: absent, the
  // /ticket route 503s and only the server-minted-ticket path is available. NO
  // service-role key is ever given to the Worker. Set as plain vars (public):
  //   wrangler secret put is unnecessary — these are the same values shipped to
  //   the browser. e.g. SUPABASE_URL=https://<ref>.supabase.co
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  // OPERATOR-ONLY erase secret for POST /admin/rooms/purge (src/admin.ts). This
  // is NOT the ticket secret and NOT a member credential — erasure must work for
  // rooms whose membership rows are already gone. Optional on purpose: while it
  // is unset the admin route is inert (503), so a deploy that forgets it cannot
  // ship an open erase button.
  //   wrangler secret put OPENGROUND_COLLAB_ADMIN_SECRET
  OPENGROUND_COLLAB_ADMIN_SECRET?: string
}

// Re-export the DO class so the runtime can instantiate the durable_objects
// binding declared in wrangler.jsonc.
export { OgCollabDoc }

const unauthorized = (): Response => new Response('unauthorized', { status: 401 })

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const routed = await routePartykitRequest<Env>(req, env, {
      // Gate the upgrade. Returning a Response short-circuits with that
      // Response (no DO connection); returning undefined allows the connection.
      onBeforeConnect: async (
        request: Request,
        lobby: Lobby<Env>,
      ): Promise<Response | undefined> => {
        if (!env.OPENGROUND_COLLAB_TICKET_SECRET) return unauthorized()

        // `lobby.name` is the room partyserver routed to (== the client's room
        // string, raw). Bind the ticket to it.
        const room = lobby.name
        const token = new URL(request.url).searchParams.get('token')
        if (!room || !token) return unauthorized()

        const ok = await verifyTicket(token, env.OPENGROUND_COLLAB_TICKET_SECRET, room)
        return ok ? undefined : unauthorized()
      },
    })

    if (routed) return routed

    const url = new URL(req.url)

    // Zero-config ticket issuance (POST /ticket): verify a Supabase JWT + read
    // membership, then mint the same HMAC ticket the WS gate verifies. Returns
    // null when the path isn't /ticket, so we fall through to assets/health/404.
    const ticket = await handleTicketRequest(req, env, url)
    if (ticket) return ticket

    // Operator-only room erasure (POST /admin/rooms/purge) — gated by a separate
    // admin secret, NOT the member ticket, and inert (503) while that secret is
    // unset. Returns null when the path isn't /admin/..., so we fall through.
    const admin = await handleAdminRequest(req, env, url)
    if (admin) return admin

    // R2-backed canvas image assets (u14b) — ticket-gated, owner-write. Returns
    // null when the path isn't /assets/..., so we fall through to health/404.
    const asset = await handleAssetRequest(req, env, url)
    if (asset) return asset

    // Not a partyserver route. A tiny health endpoint helps `unstable_dev`
    // readiness checks and manual probes; everything else is 404.
    if (url.pathname === '/' || url.pathname === '/health') {
      return new Response('og-collab ok', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    }
    return new Response('not found', { status: 404 })
  },
}
