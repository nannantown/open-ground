// The zero-config ticket-issuing route for the collab Worker.
//
//   POST /ticket
//     Authorization: Bearer <supabase access-token JWT>
//     body: { "pid": "<collabProjectId>", "scope": "board" | "canvas:<id>" }
//   → 200 { room, token, expiresAt }   (token = the short-lived HMAC ticket)
//
// This is the ZERO-CONFIG auth path. In the v2 model the owner's Hono server
// verified the caller's Supabase session and minted the ticket — so a member
// could only join while that machine was up. Here the WORKER does it:
//   1. verify the caller's Supabase JWT against the project's JWKS (jwt.ts),
//   2. confirm membership by reading og_project_members under that JWT (RLS,
//      membership.ts) — which also yields the caller's role,
//   3. mint the SAME HMAC ticket the WebSocket/asset gates already verify
//      (ticket.ts) and return it.
// The client then dials wss://<thisWorker>/parties/og-collab-doc/<room>?token=…
// exactly as before. The Worker holds Supabase's PUBLIC config only (URL + anon
// key) plus the shared ticket secret — no Supabase service-role key, no secrets
// beyond what the WebSocket gate already needs.
//
// Returns null when the path is not /ticket so index.ts falls through to its
// other routes.

import { verifySupabaseJwt } from './jwt'
import { resolveMembership } from './membership'
import { mintTicket } from './ticket'

export interface IssueTicketEnv {
  SUPABASE_URL?: string
  SUPABASE_ANON_KEY?: string
  OPENGROUND_COLLAB_TICKET_SECRET: string
}

// pid is a collabProjectId (og_projects.id, a uuid) — keep it to a safe charset
// so it can't smuggle anything into the PostgREST filter or the room string.
const SAFE_PID = /^[A-Za-z0-9_-]{1,128}$/

// Mirror the Hono route's isValidScope: 'board' or 'canvas:<non-empty id>'.
const isValidScope = (scope: string): boolean => {
  if (scope === 'board') return true
  const m = /^canvas:(.+)$/.exec(scope)
  return !!m && m[1].length > 0
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

/** Extract the bearer token from the Authorization header (case-insensitive). */
const bearer = (req: Request): string | null => {
  const h = req.headers.get('authorization')
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1].trim() : null
}

/**
 * Handle `POST /ticket`. Returns null when the path isn't /ticket (caller falls
 * through). Status map:
 *   503 zero-config auth not configured · 405 wrong method · 401 missing/invalid
 *   JWT · 400 bad body/scope/pid · 403 not a member · 200 ticket issued
 */
export async function handleTicketRequest(
  req: Request,
  env: IssueTicketEnv,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== '/ticket') return null
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  // The zero-config path needs Supabase's public config AND the shared ticket
  // secret. Absent any of them, this route is simply unavailable (the WebSocket
  // gate + server-minted tickets still work independently).
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY || !env.OPENGROUND_COLLAB_TICKET_SECRET) {
    return json({ error: 'collab auth unavailable' }, 503)
  }

  const token = bearer(req)
  if (!token) return json({ error: 'unauthorized' }, 401)

  let pid: string
  let scope: string
  try {
    const body = (await req.json()) as { pid?: unknown; scope?: unknown }
    pid = typeof body.pid === 'string' ? body.pid.trim() : ''
    scope = typeof body.scope === 'string' ? body.scope.trim() : ''
  } catch {
    return json({ error: 'bad request' }, 400)
  }
  if (!SAFE_PID.test(pid) || !isValidScope(scope)) return json({ error: 'bad request' }, 400)

  // 1) Authenticate: verify the Supabase JWT (JWKS + crypto.subtle).
  const identity = await verifySupabaseJwt(token, env)
  if (!identity) return json({ error: 'unauthorized' }, 401)

  // 2) Authorize: confirm membership (RLS read under the caller's JWT) + role.
  const role = await resolveMembership(env, token, pid, identity)
  if (!role) return json({ error: 'forbidden' }, 403)

  // 3) Issue: mint the existing HMAC ticket the WS/asset gates verify.
  const { token: ticket, expiresAt } = await mintTicket(
    { pid, scope, sub: identity.sub, role },
    env.OPENGROUND_COLLAB_TICKET_SECRET,
  )
  return json({ room: `${pid}:${scope}`, token: ticket, expiresAt }, 200)
}
