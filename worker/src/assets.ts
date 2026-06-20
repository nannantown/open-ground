// R2-backed canvas image assets for collab (u14b).
//
// The collab Worker is the ONLY R2 gateway — the browser never holds R2 creds.
// Owner uploads (PUT) and member/owner downloads (GET) are both gated by the
// SAME short-lived HMAC ticket used for the WebSocket, verified against the
// project's BOARD room `<pid>:board`. A valid ticket means the holder is a
// member (the Hono minter only mints for members); WRITE additionally requires
// `role === 'owner'`.
//
// Object key = `<pid>/<canvasId>/<assetId>` — a flat R2 key. `pid` namespaces
// it so only that project's owner can write under it, and `pid` is taken from
// the ticket-bound path, never trusted blindly. The Y.Doc carries this
// reference (CanvasElement.storageKey), never the bytes.

import { verifyTicketPayload } from './ticket'

interface AssetEnv {
  ASSET_BUCKET?: R2Bucket
  OPENGROUND_COLLAB_TICKET_SECRET: string
}

// Path segments are UUIDs / canvas ids — keep them to a safe, key-safe charset
// so a crafted key can't smuggle slashes or odd bytes into the R2 namespace.
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MAX_BYTES = 10 * 1024 * 1024 // 10 MB — generous for a single UI image

const text = (body: string, status: number, headers?: Record<string, string>) =>
  new Response(body, { status, headers })

/**
 * Handle `GET|PUT /assets/<pid>/<canvasId>/<assetId>`. Returns null when the
 * path is NOT an asset route, so the caller falls through to its own routing.
 */
export async function handleAssetRequest(
  req: Request,
  env: AssetEnv,
  url: URL,
): Promise<Response | null> {
  const m = url.pathname.match(/^\/assets\/([^/]+)\/([^/]+)\/([^/]+)\/?$/)
  if (!m) return null

  if (!env.OPENGROUND_COLLAB_TICKET_SECRET) return text('unauthorized', 401)
  const bucket = env.ASSET_BUCKET
  if (!bucket) return text('storage unavailable', 503)

  let pid: string
  let canvasId: string
  let assetId: string
  try {
    // A malformed percent-escape (e.g. a lone '%') makes decodeURIComponent
    // throw — turn that into a clean 400 rather than an uncaught 500.
    pid = decodeURIComponent(m[1])
    canvasId = decodeURIComponent(m[2])
    assetId = decodeURIComponent(m[3])
  } catch {
    return text('bad request', 400)
  }
  if (!SAFE_ID.test(pid) || !SAFE_ID.test(canvasId) || !SAFE_ID.test(assetId)) {
    return text('bad request', 400)
  }

  // Auth: ticket is minted for the BOARD room of this project. A valid ticket
  // ⇒ member (minter gate). pid comes from the path and is bound INTO the room
  // string the ticket must match, so a member of project A can't fetch B.
  const token = url.searchParams.get('token')
  const room = `${pid}:board`
  const payload = await verifyTicketPayload(token, env.OPENGROUND_COLLAB_TICKET_SECRET, room)
  if (!payload) return text('unauthorized', 401)

  const key = `${pid}/${canvasId}/${assetId}`

  if (req.method === 'GET') {
    const obj = await bucket.get(key)
    if (!obj) return text('not found', 404)
    const headers = new Headers()
    obj.writeHttpMetadata(headers)
    if (!headers.has('content-type')) headers.set('content-type', 'application/octet-stream')
    headers.set('cache-control', 'private, max-age=300')
    return new Response(obj.body, { status: 200, headers })
  }

  if (req.method === 'PUT') {
    // WRITE is owner-only.
    if (payload.role !== 'owner') return text('forbidden', 403)
    const contentType = req.headers.get('content-type') ?? ''
    if (!contentType.startsWith('image/')) return text('unsupported media type', 415)
    // Early-reject when a (trusted-ish) declared length already exceeds the cap,
    // before reading the body at all.
    const declared = Number(req.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_BYTES) return text('payload too large', 413)
    if (!req.body) return text('bad request', 400)
    // Buffer (bounded) so the true byte length is checked before it lands in R2,
    // even if content-length was absent or lied.
    const buf = await req.arrayBuffer()
    if (buf.byteLength === 0) return text('bad request', 400)
    if (buf.byteLength > MAX_BYTES) return text('payload too large', 413)
    await bucket.put(key, buf, { httpMetadata: { contentType } })
    return new Response(null, { status: 204 })
  }

  return text('method not allowed', 405, { allow: 'GET, PUT' })
}
