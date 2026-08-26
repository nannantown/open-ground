// Operator-only ERASURE route for collab rooms.
//
// WHY THIS EXISTS
// Until 2026-08-26 there was NO way to delete a room's contents. Board/Canvas
// state landed in a Durable Object's SQLite storage and stayed there forever —
// deleting the project locally, unsharing it, or removing the Supabase rows all
// left the Y.Doc untouched (docs/COLLAB_STATUS.md P1-(5)). Combined with the
// baked-in-ON defect in builds <= v0.11.95, that meant "any project a signed-in
// user merely OPENED is on the operator's infrastructure, irrevocably".
// This route is the missing erasure path.
//
// TRUST MODEL — deliberately NOT the ticket
// Every other route here is gated by the 60-second HMAC ticket, which proves
// "this caller is a member of this project". Erasure is not a member action: a
// member must never be able to destroy a room, and the operator must be able to
// erase a room whose membership rows are ALREADY GONE (that is exactly the
// cleanup case — Supabase is emptied first so nothing can reconnect mid-wipe).
// So this route takes a separate operator secret instead.
//
// FAIL-CLOSED: with OPENGROUND_COLLAB_ADMIN_SECRET unset the route does nothing
// and answers 503. It is inert until an operator deliberately provisions it:
//   wrangler secret put OPENGROUND_COLLAB_ADMIN_SECRET
// A deploy that forgets the secret therefore cannot expose an open erase button.
//
// ORDERING CONTRACT (the caller's obligation — see purgeStorage in OgCollabDoc)
// Revoke membership in Supabase BEFORE calling this. Storage is emptied here and
// live sockets are closed, but a client that can still mint a ticket could
// reconnect within the ~10s hibernation window and re-sync a doc this Worker has
// already forgotten. Membership-first makes that window unreachable.

import type { OgCollabDoc } from './OgCollabDoc'

interface AdminEnv {
  OgCollabDoc: DurableObjectNamespace<OgCollabDoc>
  OPENGROUND_COLLAB_ADMIN_SECRET?: string
}

/** One purge target: either a room NAME or a raw DO hex id. */
export interface PurgeResult {
  target: string
  kind: 'room' | 'id'
  ok: boolean
  /**
   * The resolved DurableObjectId (64 hex). Returned for BOTH forms so an
   * operator can cross-check what was erased against the namespace listing
   * Cloudflare's API returns (`/workers/durable_objects/namespaces/<ns>/objects`),
   * which speaks only in ids. Without this, a room-name purge could not be
   * reconciled against that list at all.
   */
  id?: string
  /** Whether the room actually held a persisted document before we erased it. */
  hadDoc?: boolean
  error?: string
}

// A room is `<pid>:board` or `<pid>:canvas:<canvasId>` (issueTicket.ts mints
// against exactly these). Kept strict so a crafted body cannot address arbitrary
// DO names.
//
// NOTE: historical rooms may fall OUTSIDE this pattern — COLLAB_STATUS.md P1-(8)
// records that `canvas:<id>` was never length- or charset-limited on the mint
// path, so rooms created before that is fixed can carry ids this regex rejects.
// That is why the `ids` form exists: the Cloudflare API can enumerate every
// object in the namespace by hex id regardless of how its name was spelled, so
// id-addressing is the only form that can promise COMPLETE coverage.
const ROOM_RE = /^[A-Za-z0-9_-]{1,128}:(board|canvas:[A-Za-z0-9_-]{1,128})$/
// A DurableObjectId stringifies to 64 lowercase hex characters.
const HEX_ID_RE = /^[0-9a-f]{64}$/
// Bound the work one request can queue. The 2026-08-26 cleanup addressed 41
// rooms; a per-project delete addresses a handful. 256 is far above both and far
// below anything that would time out.
const MAX_TARGETS = 256

const text = (body: string, status: number, headers?: Record<string, string>) =>
  new Response(body, { status, headers })

const sha256 = async (s: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))

/**
 * Constant-time string equality. Comparing the SHA-256 digests rather than the
 * raw bytes keeps the comparison fixed-width, so neither the secret's LENGTH nor
 * the position of the first differing byte leaks through timing. (Web Crypto
 * only — the node `crypto` module does not exist in the Workers runtime.)
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i]
  return diff === 0
}

/**
 * Handle `POST /admin/rooms/purge`. Returns null when the path is NOT an admin
 * route, so the caller falls through to its own routing.
 *
 * Body: `{ "rooms": ["<pid>:board", ...], "ids": ["<64 hex>", ...] }`
 * Either key may be omitted; at least one target is required.
 *
 * Response 200: `{ "purged": <n>, "failed": <n>, "results": PurgeResult[] }`
 * A per-target result is returned rather than a bare 204 so the operator can
 * MEASURE what happened instead of inferring it from a status code.
 */
export async function handleAdminRequest(
  req: Request,
  env: AdminEnv,
  url: URL,
): Promise<Response | null> {
  if (url.pathname !== '/admin/rooms/purge') return null

  // Fail-closed BEFORE method/auth checks: an unprovisioned route reveals and
  // does nothing at all.
  const secret = env.OPENGROUND_COLLAB_ADMIN_SECRET
  if (!secret) return text('admin disabled', 503)

  if (req.method !== 'POST') return text('method not allowed', 405, { allow: 'POST' })

  const auth = req.headers.get('authorization') ?? ''
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  // Compare unconditionally (even when empty) so the no-header and wrong-secret
  // paths cost the same.
  if (!(await timingSafeEqual(presented, secret))) return text('unauthorized', 401)

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return text('bad request', 400)
  }
  if (typeof body !== 'object' || body === null) return text('bad request', 400)

  const { rooms, ids } = body as { rooms?: unknown; ids?: unknown }
  const roomList = Array.isArray(rooms) ? rooms : []
  const idList = Array.isArray(ids) ? ids : []
  if (roomList.length === 0 && idList.length === 0) return text('no targets', 400)
  if (roomList.length + idList.length > MAX_TARGETS) return text('too many targets', 413)

  const results: PurgeResult[] = []

  const purge = async (
    target: string,
    kind: 'room' | 'id',
    resolve: () => DurableObjectId,
  ): Promise<void> => {
    let id: string | undefined
    try {
      const doId = resolve()
      id = doId.toString()
      const stub = env.OgCollabDoc.get(doId)
      const { hadDoc } = await stub.purgeStorage()
      // Second call, deliberately: ctx.abort() kills its own request, so it
      // cannot live inside purgeStorage() without destroying that return value.
      // Without this the room stays resident and keeps serving the document it
      // has already forgotten on disk — measured, not hypothetical (see the
      // comment on purgeStorage). The rejection here is the SUCCESS signal, so
      // swallow it; the erase itself was already committed above.
      try {
        await stub.resetInstance()
      } catch {
        // Expected — the instance tore itself down mid-call.
      }
      results.push({ target, kind, ok: true, id, hadDoc })
    } catch (err) {
      results.push({
        target,
        kind,
        ok: false,
        id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  for (const raw of roomList) {
    if (typeof raw !== 'string' || !ROOM_RE.test(raw)) {
      results.push({ target: String(raw), kind: 'room', ok: false, error: 'invalid room' })
      continue
    }
    await purge(raw, 'room', () => env.OgCollabDoc.idFromName(raw))
  }

  for (const raw of idList) {
    if (typeof raw !== 'string' || !HEX_ID_RE.test(raw)) {
      results.push({ target: String(raw), kind: 'id', ok: false, error: 'invalid id' })
      continue
    }
    // idFromString throws if the id was not minted for THIS namespace, which is
    // the behaviour we want — a foreign id must fail loudly, not silently no-op.
    await purge(raw, 'id', () => env.OgCollabDoc.idFromString(raw))
  }

  const purged = results.filter((r) => r.ok).length
  return new Response(JSON.stringify({ purged, failed: results.length - purged, results }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
