// Programmatic local convergence test for the OPEN GROUND collab Worker.
//
// WHAT IT PROVES (all against a REAL worker booted in-process):
//   1. Two y-partyserver YProvider clients in the SAME room converge: a Y.Map
//      value set on client A is observed on client B (polled, hard timeout).
//   2. PERSISTENCE WITH NO LIVE PEERS: after A writes and B converges, we wait
//      for the DO's debounced onSave to flush, then DESTROY every provider so the
//      room has ZERO connections, then connect a FRESH client and assert it still
//      receives the value. This proves the document is server-HELD (onSave→DO
//      storage→onLoad), not merely relayed live between connected peers — the gap
//      the earlier "late joiner while A+B are still connected" check missed.
//   3. An INVALID ticket is rejected — the gated upgrade never opens (401),
//      so that provider never reports `synced`.
//
// HOW IT BOOTS: wrangler `unstable_dev` with { local: true, config:
// "wrangler.jsonc" } — i.e. it loads the SAME wrangler.jsonc that `wrangler
// dev`/`deploy` use (NOT the .toml). The shared HMAC secret is injected via
// `vars` so verifyTicket has a key. We mint tickets in-test with node's crypto
// in the EXACT wire format the Worker verifies.
//
// HOW TO RUN (from worker/):  npm test     (== node test/local.mjs)
// Requires deps installed first (npm install) — partyserver, y-partyserver,
// yjs, wrangler, ws. (The orchestrator installs; this file does not.)

import { unstable_dev } from 'wrangler'
import crypto from 'node:crypto'
import http from 'node:http'
import * as Y from 'yjs'
import WebSocket from 'ws'
import YProvider from 'y-partyserver/provider'

// ── config ──────────────────────────────────────────────────────────────────
const SECRET = 'test-secret-do-not-use-in-prod'
const PARTY = 'og-collab-doc'
const PID = 'proj-test-123'
const SCOPE = 'board'
const ROOM = `${PID}:${SCOPE}` // ROOM = collabProjectId + ":" + scope
const CANVAS_SCOPE = 'canvas:abc'
const CANVAS_ROOM = `${PID}:${CANVAS_SCOPE}`

const CONVERGE_TIMEOUT_MS = 15_000
const POLL_MS = 100

// ── tiny assert/log harness ───────────────────────────────────────────────────
let failures = 0
function check(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`)
  } else {
    failures++
    console.error(`  ✗ ${msg}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// base64url (no padding) — the shared wire encoding.
const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Mint a ticket EXACTLY as the Hono minter does (and the Worker verifies):
 *   base64url(JSON{pid,scope,sub,role,exp}) + "." + base64url(HMAC_SHA256(secret, firstPart))
 * exp is epoch MILLISECONDS.
 */
function mintTicket({ pid, scope, sub = 'user-1', role = 'owner', ttlMs = 60_000 }) {
  const payload = { pid, scope, sub, role, exp: Date.now() + ttlMs }
  const first = b64url(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', SECRET).update(first).digest()
  return `${first}.${b64url(sig)}`
}

/** Verify an HMAC ticket the SAME way the Worker does (node crypto), returning
 *  the decoded claims or null. Used to prove a WORKER-MINTED zero-config ticket
 *  is well-formed + signed with the shared secret. */
function verifyTicketNode(token, secret) {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const head = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = b64url(crypto.createHmac('sha256', secret).update(head).digest())
  if (sig !== expected) return null
  try {
    return JSON.parse(Buffer.from(head, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

// ── zero-config auth fixtures: Supabase-style asymmetric JWTs + a mock Supabase ─
// Supabase signs access tokens with asymmetric keys (ES256 by default, RS256 also
// supported) and publishes the public keys as a JWKS. We generate BOTH key types
// so the test exercises the Worker's alg dispatch, mint JWTs in the exact JWS wire
// format the Worker verifies, and stand up a tiny mock Supabase that serves the
// JWKS + an RLS-faithful og_project_members read.
const ES_KID = 'es-test-key-1'
const RSA_KID = 'rsa-test-key-1'
const ANON_KEY = 'test-anon-key-not-secret'

const ecKeys = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
const rsaKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const esJwk = { ...ecKeys.publicKey.export({ format: 'jwk' }), kid: ES_KID, alg: 'ES256', use: 'sig' }
const rsaJwk = { ...rsaKeys.publicKey.export({ format: 'jwk' }), kid: RSA_KID, alg: 'RS256', use: 'sig' }

/** Sign a JWS with the test key for `alg`. ES256 uses the raw R||S (ieee-p1363)
 *  form the JWS spec mandates; RS256 is PKCS#1 v1.5. */
function signJwt(alg, payload) {
  const kid = alg === 'ES256' ? ES_KID : RSA_KID
  const header = { alg, typ: 'JWT', kid }
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig =
    alg === 'ES256'
      ? crypto.sign('sha256', Buffer.from(input), { key: ecKeys.privateKey, dsaEncoding: 'ieee-p1363' })
      : crypto.sign('sha256', Buffer.from(input), rsaKeys.privateKey)
  return `${input}.${b64url(sig)}`
}

/** Mint a Supabase-shaped access token. `iss` is supplied by the caller (it must
 *  equal `${SUPABASE_URL}/auth/v1`, only known once the mock is listening). */
function makeJwt({ sub, email, alg = 'ES256', iss, aud = 'authenticated', ttlSec = 3600, expSec }) {
  const nowSec = Math.floor(Date.now() / 1000)
  const payload = { sub, aud, iss, iat: nowSec, exp: expSec ?? nowSec + ttlSec }
  if (email !== undefined) payload.email = email
  return signJwt(alg, payload)
}

// The mock roster. The membership-read mock mirrors Supabase RLS (migration 0005
// "og members read roster"): a MEMBER's read returns the WHOLE roster; a
// non-member's read returns []. So the Worker must filter the roster to the
// caller's own row to read THEIR role — which these fixtures exercise (an owner
// row + a uid-member row + an email-only member row).
const ZPID = '11111111-2222-3333-4444-555555555555'
const OWNER_SUB = 'owner-uuid-0001'
const MEMBER_SUB = 'member-uuid-0002'
const MEMBER_EMAIL = 'emailmember@example.com'
const ROSTER = [
  { project_id: ZPID, user_id: OWNER_SUB, email: null, role: 'owner' },
  { project_id: ZPID, user_id: MEMBER_SUB, email: null, role: 'member' },
  { project_id: ZPID, user_id: null, email: MEMBER_EMAIL, role: 'member' },
]

/** Decode (NOT verify) a JWT payload from an Authorization header — the mock
 *  stands in for RLS, which already trusts the gateway-verified JWT claims. */
function decodeJwtPayload(authHeader) {
  const m = /^Bearer\s+(.+)$/i.exec(authHeader || '')
  if (!m) return null
  const parts = m[1].split('.')
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

/** The mock Supabase request handler: JWKS + an RLS-faithful members read. */
function mockSupabaseHandler(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1')
  if (req.method === 'GET' && u.pathname === '/auth/v1/.well-known/jwks.json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ keys: [esJwk, rsaJwk] }))
    return
  }
  if (req.method === 'GET' && u.pathname === '/rest/v1/og_project_members') {
    const claims = decodeJwtPayload(req.headers['authorization'])
    const sub = claims?.sub
    const email = (claims?.email || '').toLowerCase()
    // RLS og_is_member: the caller may read iff their uid OR email is in the roster.
    const isMember = ROSTER.some(
      (r) => (r.user_id && r.user_id === sub) || (r.email && r.email.toLowerCase() === email),
    )
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(isMember ? ROSTER : []))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('[]')
}

/** Poll `fn()` until it returns truthy or the timeout elapses. */
async function waitFor(fn, timeoutMs, label) {
  const start = Date.now()
  for (;;) {
    let v
    try {
      v = await fn()
    } catch {
      v = undefined
    }
    if (v) return true
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for: ${label} (${timeoutMs}ms)`)
    }
    await sleep(POLL_MS)
  }
}

/**
 * Build a YProvider against the local worker, per the proven recipe.
 *
 * NOTE on the option name: the SHARED CONTRACT calls the per-reconnect ticket
 * provider `query`, but y-partyserver v2.2.0's `YProvider` exposes it as
 * `params` (a `ParamsProvider` = object | () => object | Promise<object>). The
 * provider awaits it on every (re)connect and appends each key/value to the URL
 * query string verbatim — so `params: () => ({ token })` lands as `?...&token=…`,
 * which is exactly what the Worker's onBeforeConnect reads. The auto-refresh
 * semantics the contract describes are intact; only the option key differs.
 */
function makeProvider(host, room, doc, paramsFn) {
  return new YProvider(host, room, doc, {
    party: PARTY, // kebab-case of OgCollabDoc — must match the DO route
    connect: true,
    disableBc: true, // no cross-tab BroadcastChannel in Node
    WebSocketPolyfill: WebSocket, // y-partyserver/partysocket needs a WS impl
    params: paramsFn, // re-run on every (re)connect → ticket auto-refresh
  })
}

async function main() {
  // Stand up the mock Supabase FIRST so SUPABASE_URL is known before the Worker
  // boots (its env must point at the mock for JWKS + membership reads).
  const mock = http.createServer(mockSupabaseHandler)
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve))
  const SUPABASE_URL = `http://127.0.0.1:${mock.address().port}`
  const ISS = `${SUPABASE_URL}/auth/v1`
  console.log(`Mock Supabase up at ${SUPABASE_URL}`)
  // Sanity: the mock itself serves the JWKS (so a later Worker-side failure is
  // about Worker→mock reachability/logic, not a broken mock).
  const jwksProbe = await fetch(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`).then((r) => r.json())
  check(Array.isArray(jwksProbe.keys) && jwksProbe.keys.length === 2, 'mock Supabase serves a 2-key JWKS')

  console.log('Booting worker via wrangler unstable_dev (local, config=wrangler.jsonc)…')
  const worker = await unstable_dev('src/index.ts', {
    config: 'wrangler.jsonc',
    local: true,
    // Inject the shared secret so verifyTicket has a key (mirrors
    // `wrangler secret put OPENGROUND_COLLAB_TICKET_SECRET` in prod) PLUS the
    // Supabase public config the zero-config /ticket route reads.
    vars: {
      OPENGROUND_COLLAB_TICKET_SECRET: SECRET,
      SUPABASE_URL,
      SUPABASE_ANON_KEY: ANON_KEY,
    },
    experimental: { disableExperimentalWarning: true },
  })

  // Normalize the bind address for the client URL. YProvider picks ws:// (not
  // wss://) only for loopback/private hosts (127.0.0.1, localhost, 10.*, …); if
  // unstable_dev reports 0.0.0.0 / :: we must dial 127.0.0.1 or it would try TLS.
  const rawAddr = worker.address
  const addr =
    !rawAddr || rawAddr === '0.0.0.0' || rawAddr === '::' || rawAddr === '[::]'
      ? '127.0.0.1'
      : rawAddr
  // YProvider derives ws://host/parties/<party>/<room> from this http host.
  const host = `http://${addr}:${worker.port}`
  console.log(`Worker up at ${host}`)

  const providers = []
  try {
    // Sanity: the worker answers the health probe at all.
    const health = await worker.fetch('/health')
    check(health.status === 200, 'worker /health responds 200')

    // ── TEST 1: two valid clients converge ────────────────────────────────────
    console.log('\n[1] two valid clients converge on a Y.Map value')
    const docA = new Y.Doc()
    const docB = new Y.Doc()
    const provA = makeProvider(host, ROOM, docA, async () => ({
      token: mintTicket({ pid: PID, scope: SCOPE }),
    }))
    const provB = makeProvider(host, ROOM, docB, async () => ({
      token: mintTicket({ pid: PID, scope: SCOPE }),
    }))
    providers.push(provA, provB)

    await waitFor(() => provA.synced, CONVERGE_TIMEOUT_MS, 'client A synced')
    await waitFor(() => provB.synced, CONVERGE_TIMEOUT_MS, 'client B synced')
    check(true, 'both valid clients reached synced')

    // Set on A; expect it on B. Use the SAME flat-map root the app uses ("og").
    const VALUE = `hello-${Date.now()}`
    docA.getMap('og').set('m:probe', VALUE)

    await waitFor(
      () => docB.getMap('og').get('m:probe') === VALUE,
      CONVERGE_TIMEOUT_MS,
      'client B observes A’s value',
    )
    check(docB.getMap('og').get('m:probe') === VALUE, `B converged to A's value (${VALUE})`)

    // ── TEST 2: persistence with NO live peers (DO storage survives) ──────────
    // The earlier version connected C while A+B were STILL connected, so it only
    // proved live fan-out. Here we tear the room down to ZERO connections first,
    // so a fresh client can ONLY get the value from the server-held document
    // (onSave→DO storage→onLoad), not from a live peer.
    console.log('\n[2] a fresh client gets prior state after ALL peers disconnect (DO-held)')

    // 1) Give the DO's debounced onSave time to flush to storage. y-partyserver's
    //    YServer persists on a 2s debounce (debounceWait), so wait past it.
    await sleep(3_000)

    // 2) Destroy every live provider (A, B) — the room now has no connections.
    check(providers.length >= 2, 'have A+B providers to tear down')
    for (const p of providers.splice(0, providers.length)) {
      try {
        p.disconnect()
      } catch {
        /* ignore */
      }
      try {
        p.destroy()
      } catch {
        /* ignore */
      }
    }
    // 3) Let the sockets fully close so the DO truly has zero live peers before
    //    the fresh client opens (and any post-disconnect save settles).
    await sleep(1_500)

    // 4) Connect a brand-new client into the same room. If it observes VALUE, the
    //    document survived with no peers → it came from the DO's own storage.
    const docFresh = new Y.Doc()
    const provFresh = makeProvider(host, ROOM, docFresh, async () => ({
      token: mintTicket({ pid: PID, scope: SCOPE }),
    }))
    providers.push(provFresh)

    await waitFor(() => provFresh.synced, CONVERGE_TIMEOUT_MS, 'fresh client synced')
    await waitFor(
      () => docFresh.getMap('og').get('m:probe') === VALUE,
      CONVERGE_TIMEOUT_MS,
      'fresh client receives DO-persisted prior state',
    )
    check(
      docFresh.getMap('og').get('m:probe') === VALUE,
      'fresh client received prior state with NO live peers (DO storage survived)',
    )

    // ── TEST 3: an INVALID ticket is rejected (no open / 401) ──────────────────
    console.log('\n[3] an invalid ticket is rejected (upgrade never opens)')

    // 3a) Tampered signature for the right room.
    const goodFirst = mintTicket({ pid: PID, scope: SCOPE }).split('.')[0]
    const badTicket = `${goodFirst}.${b64url('tampered-signature-bytes')}`

    // 3b) Valid signature but for a DIFFERENT room (scope mismatch) — must also fail.
    const wrongRoomTicket = mintTicket({ pid: PID, scope: CANVAS_SCOPE }) // canvas ticket…
    // …used to join the BOARD room below.

    // Direct WS probe so we can observe the HTTP 401 on the upgrade itself.
    // The room segment is inserted RAW (no encodeURIComponent) — that is how the
    // y-partyserver client builds the URL and how partyserver derives lobby.name
    // — so the ONLY reason this is rejected is the tampered signature.
    const wsUrl = `ws://${addr}:${worker.port}/parties/${PARTY}/${ROOM}?token=${encodeURIComponent(
      badTicket,
    )}`
    const rejected = await new Promise((resolve) => {
      let settled = false
      const done = (v) => {
        if (!settled) {
          settled = true
          resolve(v)
        }
      }
      const ws = new WebSocket(wsUrl)
      ws.on('open', () => {
        ws.close()
        done({ opened: true })
      })
      ws.on('unexpected-response', (_req, res) => done({ opened: false, status: res.statusCode }))
      ws.on('error', () => done({ opened: false, status: 'error' }))
      setTimeout(() => done({ opened: false, status: 'timeout-no-open' }), 5_000)
    })
    check(rejected.opened !== true, `tampered-ticket upgrade did NOT open (status=${rejected.status})`)
    check(
      rejected.status === 401 || rejected.status === 'timeout-no-open' || rejected.status === 'error',
      'tampered-ticket upgrade rejected at the gate (401 / no upgrade)',
    )

    // Wrong-room ticket via a YProvider should never reach synced.
    const docBad = new Y.Doc()
    const provBad = makeProvider(host, ROOM, docBad, async () => ({ token: wrongRoomTicket }))
    providers.push(provBad)
    await sleep(3_000)
    check(provBad.synced !== true, 'wrong-room (scope-mismatch) ticket never reached synced')

    // Sanity that the canvas room DOES accept its own correct ticket (positive
    // control for the room-binding check).
    const docCanvas = new Y.Doc()
    const provCanvas = makeProvider(host, CANVAS_ROOM, docCanvas, async () => ({
      token: mintTicket({ pid: PID, scope: CANVAS_SCOPE }),
    }))
    providers.push(provCanvas)
    await waitFor(() => provCanvas.synced, CONVERGE_TIMEOUT_MS, 'canvas-room client synced')
    check(provCanvas.synced === true, 'correct canvas-room ticket is accepted (positive control)')

    // ── TEST 4: R2 image assets — owner PUT, member/owner GET, auth+role gates ──
    // u14b. The Worker is the only R2 gateway; the same board-room ticket gates
    // these HTTP routes (no WebSocket). WRITE is owner-only. Object key is
    // <pid>/<canvasId>/<assetId>. The local miniflare R2 comes from the
    // r2_buckets binding in wrangler.jsonc.
    console.log('\n[4] R2 image assets: owner PUT, member/owner GET, auth + role gates')
    const CANVAS_ID = 'cv-1'
    const ASSET_ID = 'asset-1'
    const assetPath = `/assets/${PID}/${CANVAS_ID}/${ASSET_ID}`
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])
    const ownerTok = mintTicket({ pid: PID, scope: SCOPE, role: 'owner' })
    const memberTok = mintTicket({ pid: PID, scope: SCOPE, role: 'member' })

    // 4a) owner PUT → 204
    const put = await worker.fetch(`${assetPath}?token=${encodeURIComponent(ownerTok)}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
      body: bytes,
    })
    check(put.status === 204, `owner PUT stored the asset (status=${put.status})`)

    // 4b) member GET → 200 + identical bytes + content-type preserved
    const get = await worker.fetch(`${assetPath}?token=${encodeURIComponent(memberTok)}`)
    check(get.status === 200, `member GET retrieves the asset (status=${get.status})`)
    check(get.headers.get('content-type') === 'image/png', 'GET preserves the image content-type')
    const got = new Uint8Array(await get.arrayBuffer())
    const sameBytes = got.length === bytes.length && got.every((b, i) => b === bytes[i])
    check(sameBytes, 'GET returns the exact bytes that were PUT')

    // 4c) GET without a ticket → 401
    const noTok = await worker.fetch(assetPath)
    check(noTok.status === 401, `GET without a ticket is rejected (status=${noTok.status})`)

    // 4d) member PUT → 403 (write is owner-only)
    const memberPut = await worker.fetch(`${assetPath}?token=${encodeURIComponent(memberTok)}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png', 'content-length': String(bytes.byteLength) },
      body: bytes,
    })
    check(memberPut.status === 403, `member PUT is forbidden — write is owner-only (status=${memberPut.status})`)

    // 4e) GET with a ticket minted for a DIFFERENT project → 401 (room mismatch)
    const otherTok = mintTicket({ pid: 'proj-other-999', scope: SCOPE, role: 'owner' })
    const crossGet = await worker.fetch(`${assetPath}?token=${encodeURIComponent(otherTok)}`)
    check(crossGet.status === 401, `cross-project ticket cannot read this asset (status=${crossGet.status})`)

    // 4f) owner PUT of a non-image content-type → 415
    const badType = await worker.fetch(
      `/assets/${PID}/${CANVAS_ID}/asset-bad?token=${encodeURIComponent(ownerTok)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'content-length': '2' },
        body: new Uint8Array([0x7b, 0x7d]),
      },
    )
    check(badType.status === 415, `non-image upload is rejected (status=${badType.status})`)

    // 4g) GET an absent asset → 404
    const missing = await worker.fetch(
      `/assets/${PID}/${CANVAS_ID}/asset-missing?token=${encodeURIComponent(memberTok)}`,
    )
    check(missing.status === 404, `GET of an absent asset is 404 (status=${missing.status})`)

    // 4h) a malformed percent-escape in the path → clean 400 (not an uncaught 500)
    const malformed = await worker.fetch(
      `/assets/${PID}/${CANVAS_ID}/%?token=${encodeURIComponent(ownerTok)}`,
    )
    check(malformed.status === 400, `malformed %-escape path → 400, not 500 (status=${malformed.status})`)

    // ── TEST 5: zero-config /ticket — Supabase JWT verify + membership → mint ──
    // The Worker authenticates a member's Supabase JWT against the (mock) JWKS,
    // confirms membership via an RLS read, and mints the SAME HMAC ticket the WS
    // gate verifies. A member succeeds; a non-member / bad token is refused.
    console.log('\n[5] zero-config /ticket: Supabase JWT verify + membership gate → HMAC ticket')

    const postTicket = (jwt, body) =>
      worker.fetch('/ticket', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
      })

    // 5a) a real member (ES256) → 200 + a ticket that verifies, correctly bound.
    const memberJwt = makeJwt({ sub: MEMBER_SUB, email: 'member@example.com', alg: 'ES256', iss: ISS })
    const res5a = await postTicket(memberJwt, { pid: ZPID, scope: 'board' })
    check(res5a.status === 200, `member JWT issues a ticket (status=${res5a.status})`)
    const body5a = await res5a.json().catch(() => ({}))
    const claims5a = verifyTicketNode(body5a.token, SECRET)
    check(!!claims5a, 'issued ticket verifies against the shared HMAC secret')
    check(claims5a?.role === 'member', `issued ticket role=member (got ${claims5a?.role})`)
    check(claims5a?.pid === ZPID && claims5a?.scope === 'board', 'issued ticket binds pid+scope')
    check(claims5a?.sub === MEMBER_SUB, 'issued ticket sub = the JWT subject')
    check(body5a.room === `${ZPID}:board`, 'response room is pid:scope')
    check(
      typeof body5a.expiresAt === 'number' && body5a.expiresAt > Date.now(),
      'response carries a future expiry',
    )

    // 5b) the OWNER → an owner-role ticket (roster-wide read filtered to self).
    const ownerJwt = makeJwt({ sub: OWNER_SUB, email: 'owner@example.com', alg: 'ES256', iss: ISS })
    const res5b = await postTicket(ownerJwt, { pid: ZPID, scope: 'board' })
    check(res5b.status === 200, `owner JWT issues a ticket (status=${res5b.status})`)
    check(
      verifyTicketNode((await res5b.json()).token, SECRET)?.role === 'owner',
      'owner JWT → owner-role ticket (not mislabeled from the roster)',
    )

    // 5c) an email-seeded member (uid absent from roster, email present) → member.
    const emailMemberJwt = makeJwt({ sub: 'fresh-login-uuid', email: MEMBER_EMAIL, alg: 'ES256', iss: ISS })
    const res5c = await postTicket(emailMemberJwt, { pid: ZPID, scope: 'canvas:abc' })
    check(res5c.status === 200, `email-matched member issues a ticket (status=${res5c.status})`)
    check(
      verifyTicketNode((await res5c.json()).token, SECRET)?.role === 'member',
      'email-matched member is role member',
    )

    // 5d) RS256 token path also verifies (proves the alg dispatch, not just ES256).
    const rsaMemberJwt = makeJwt({ sub: MEMBER_SUB, email: 'member@example.com', alg: 'RS256', iss: ISS })
    const res5d = await postTicket(rsaMemberJwt, { pid: ZPID, scope: 'board' })
    check(res5d.status === 200, `RS256 member JWT issues a ticket (status=${res5d.status})`)

    // 5e) a NON-member with an otherwise-valid token → 403.
    const strangerJwt = makeJwt({ sub: 'stranger-uuid', email: 'stranger@example.com', alg: 'ES256', iss: ISS })
    const res5e = await postTicket(strangerJwt, { pid: ZPID, scope: 'board' })
    check(res5e.status === 403, `non-member JWT is refused (status=${res5e.status})`)

    // 5f) a tampered signature → 401 (rejected at authentication).
    const tamperedJwt = memberJwt.slice(0, -2) + (memberJwt.endsWith('aa') ? 'bb' : 'aa')
    const res5f = await postTicket(tamperedJwt, { pid: ZPID, scope: 'board' })
    check(res5f.status === 401, `tampered JWT signature is rejected (status=${res5f.status})`)

    // 5g) an expired token → 401.
    const expiredJwt = makeJwt({
      sub: MEMBER_SUB,
      alg: 'ES256',
      iss: ISS,
      expSec: Math.floor(Date.now() / 1000) - 60,
    })
    const res5g = await postTicket(expiredJwt, { pid: ZPID, scope: 'board' })
    check(res5g.status === 401, `expired JWT is rejected (status=${res5g.status})`)

    // 5h) a token from a DIFFERENT issuer (signed by our key, but wrong iss) → 401.
    const wrongIssJwt = makeJwt({ sub: MEMBER_SUB, alg: 'ES256', iss: 'https://evil.example/auth/v1' })
    const res5h = await postTicket(wrongIssJwt, { pid: ZPID, scope: 'board' })
    check(res5h.status === 401, `wrong-issuer JWT is rejected (status=${res5h.status})`)

    // 5i) missing Authorization → 401.
    const res5i = await postTicket(null, { pid: ZPID, scope: 'board' })
    check(res5i.status === 401, `missing Authorization is rejected (status=${res5i.status})`)

    // 5j) invalid scope → 400 (cheap validation before any crypto).
    const res5j = await postTicket(memberJwt, { pid: ZPID, scope: 'nope' })
    check(res5j.status === 400, `invalid scope is rejected (status=${res5j.status})`)

    // 5k) wrong method (GET) → 405.
    const res5k = await worker.fetch('/ticket', { method: 'GET' })
    check(res5k.status === 405, `GET /ticket is method-not-allowed (status=${res5k.status})`)

    // ── TEST 6: a WORKER-MINTED (zero-config) ticket opens the WS gate ─────────
    // The strongest proof: mint a ticket via /ticket, then hand it to a YProvider.
    // The SAME Worker's onBeforeConnect must accept it for the upgrade → synced.
    console.log('\n[6] a worker-minted (zero-config) ticket opens the WebSocket gate end-to-end')
    const docZ = new Y.Doc()
    const provZ = makeProvider(host, `${ZPID}:board`, docZ, async () => {
      const r = await postTicket(
        makeJwt({ sub: MEMBER_SUB, email: 'member@example.com', alg: 'ES256', iss: ISS }),
        { pid: ZPID, scope: 'board' },
      )
      const { token } = await r.json()
      return { token }
    })
    providers.push(provZ)
    await waitFor(() => provZ.synced, CONVERGE_TIMEOUT_MS, 'zero-config client synced')
    check(provZ.synced === true, 'worker-minted ticket is accepted by onBeforeConnect (end-to-end)')
  } finally {
    for (const p of providers) {
      try {
        p.disconnect()
      } catch {
        /* ignore */
      }
      try {
        p.destroy()
      } catch {
        /* ignore */
      }
    }
    try {
      await worker.stop()
    } catch {
      /* ignore */
    }
    try {
      await new Promise((resolve) => mock.close(resolve))
    } catch {
      /* ignore */
    }
  }

  console.log('')
  if (failures > 0) {
    console.error(`FAILED: ${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('PASSED: all collab worker checks green')
  process.exit(0)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
