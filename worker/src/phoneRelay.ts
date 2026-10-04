// OPEN GROUND phone link relay — a separate Worker from og-collab
// (wrangler.phone.jsonc). Protocol: docs/PHONE_LINK.md.
//
// The Mac never accepts a connection from the internet: it dials OUT to its
// room here, the phone dials in to the same room, and the room passes frames
// between them. One Durable Object per room (= per pairing), WebSocket
// hibernation so an idle room costs nothing on the free plan.
//
// What the room keeps: the Mac key's hash, the last project list, the last
// EVENT_KEEP events (so a phone that was out of signal catches up with
// `?after=<seq>`), and the transcript position of the newest stored event. A Mac `reset` frame erases all of it and retires the room
// for good (unpair / re-pair: a new pairing is a new room).
//
// Owner-only and bounded (docs/PHONE_LINK.md "Security model"; every number is
// in RELAY_LIMITS, phoneRelayAuth.ts): only a Mac that may create rooms
// (`mayCreateRoom`) makes one; an event is erased once the phone says it heard
// it (`?heard=`) or after eventTtlS at the latest; a room nobody connected to
// for roomIdleS is emptied but for its Mac key hash and newest event position
// (the alarm); a room holds at most
// phonesMax phone sockets and takes connectsPerMin / macFramesPerMin / phoneFramesPerMin.
// The assistant's frames (`assistant`, `assistant-history` — sealed on v2 like
// every content frame) are passed on and never kept: its records live on the
// Mac, the phone fetches them there.
import { DurableObject } from 'cloudflare:workers'
import {
  MinuteCounter,
  PHONE_RELAY_APP_KEY_HEADER,
  PHONE_RELAY_TOKEN_HEADER,
  admission,
  alreadyStored,
  asCursor,
  asPushTarget,
  nextSweep,
  sweepSlackMs,
  parseRoomPath,
  relayLimits,
  sha256Hex,
  tokenHashFor,
  type Cursor,
  type RelayLimits,
} from './phoneRelayAuth'

export interface Env {
  OgPhoneRelay: DurableObjectNamespace<OgPhoneRelay>
  /** Worker secret: `npx wrangler secret put ROOM_CREATE_KEY -c wrangler.phone.jsonc`.
   *  Unset = no room can be created (fail closed). */
  ROOM_CREATE_KEY?: string
  /** Rollout only: "open" = any Mac may still create a room (as before the gate),
   *  for while the owner's Mac runs a build without the app key — re-pairing from
   *  such a build would otherwise lose the pairing. Remove it (wrangler.phone.jsonc)
   *  once a release carrying the key is installed: the gate is then on. */
  ROOM_CREATE?: string
  /** Overrides of RELAY_LIMITS — the local test only (short expiries). */
  RELAY_LIMITS?: unknown
}

const EVENT_KEEP = 200
const PHONE_FRAME_MAX = 16 * 1024
const MAC_FRAME_MAX = 64 * 1024
const HASH_HEADER = 'x-og-token-hash'
/** Set by the Worker (never taken from the client): this Mac may create a room. */
const CREATE_HEADER = 'x-og-may-create'
const evKey = (seq: number) => `ev:${String(seq).padStart(12, '0')}`

/**
 * Who may create a room — THE swap point for the App Store launch. Today: the
 * app key every OPEN GROUND build carries (baked at release from the open-ground
 * repo secret OPENGROUND_PHONE_RELAY_APP_KEY; the same value is this Worker's
 * ROOM_CREATE_KEY secret). At launch, replace the body with a subscription check
 * (e.g. verify a signed entitlement the Mac sends) — nothing else changes: a room
 * that exists is entered with its keys, as today.
 */
export const mayCreateRoom = async (req: Request, env: Env): Promise<boolean> => {
  if (env.ROOM_CREATE === 'open') return true
  const want = env.ROOM_CREATE_KEY
  const got = req.headers.get(PHONE_RELAY_APP_KEY_HEADER)
  if (!want || !got) return false
  // Hashes compared, so the comparison's timing says nothing about the key.
  return (await sha256Hex(got)) === (await sha256Hex(want))
}

type Frame = Record<string, unknown> & { type?: unknown }

const parse = (msg: string | ArrayBuffer, max: number): Frame | null => {
  if (typeof msg !== 'string' || msg.length > max) return null
  try {
    const v = JSON.parse(msg)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Frame) : null
  } catch {
    return null
  }
}

const seqParam = (url: URL, name: string): number => {
  const raw = url.searchParams.get(name)
  return raw === null || raw === '' ? NaN : Number(raw)
}

export class OgPhoneRelay extends DurableObject<Env> {
  // In memory: they restart when the room sleeps (a sleeping room is not flooded).
  private connects = new MinuteCounter()
  private macFrames = new MinuteCounter()
  private phoneFrames = new MinuteCounter()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // App-level keepalive answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  private get limits(): RelayLimits {
    return relayLimits(this.env.RELAY_LIMITS)
  }

  private send(ws: WebSocket, frame: unknown): void {
    try {
      ws.send(JSON.stringify(frame))
    } catch {
      /* closing socket */
    }
  }

  private toPhones(frame: unknown): void {
    for (const ws of this.ctx.getWebSockets('phone')) this.send(ws, frame)
  }

  /** The alarm fires no later than `at` (setAlarm is a billed write: only when it moves earlier). */
  private async arm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm()
    if (current === null || current > at) await this.ctx.storage.setAlarm(at)
  }

  private async erase(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 128) await this.ctx.storage.delete(keys.slice(i, i + 128))
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const at = parseRoomPath(url.pathname)
    const hash = req.headers.get(HASH_HEADER)
    if (!at || !hash || (await this.ctx.storage.get('revoked'))) return new Response('unauthorized', { status: 401 })
    const registered = await this.ctx.storage.get<string>('macHash')
    const door = admission(at.role, registered, hash, req.headers.get(CREATE_HEADER) === '1')
    if (door === 'refuse') return new Response('unauthorized', { status: 401 })
    if (door === 'absent') return new Response('no room (yet)', { status: 404 })
    const lim = this.limits
    const now = Date.now()
    // Counted once admitted: a stranger hammering with wrong keys cannot lock the owner out.
    if (!this.connects.hit(now, lim.connectsPerMin)) return new Response('too many requests', { status: 429 })
    if (at.role === 'phone') {
      // A socket that stopped pinging is dead (a network switch): it makes room.
      let live = 0
      for (const ws of this.ctx.getWebSockets('phone')) {
        const seen =
          this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ??
          (ws.deserializeAttachment() as { t?: number } | null)?.t ??
          0
        if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue // closing: already on its way out
        if (now - seen <= lim.phoneStaleS * 1000) live++
        else
          try {
            ws.close(4000, 'stale')
          } catch {
            /* already closing */
          }
      }
      if (live >= lim.phonesMax) return new Response('too many connections', { status: 429 })
    }
    // Last use, written at most every tenth of the idle limit (a day in production).
    const used = await this.ctx.storage.get<number>('used')
    const fresh = used === undefined || now - used > Math.min(86_400_000, lim.roomIdleS * 100)
    if (door === 'create') await this.ctx.storage.put({ macHash: hash, used: now })
    else if (fresh) await this.ctx.storage.put('used', now)
    // A room entered with no last-use time (made before the sweep existed, or
    // emptied after idle days) may hold old events: sweep it right away.
    await this.arm(used === undefined && door === 'enter' ? now : nextSweep(fresh || used === undefined ? now : used, undefined, lim))

    const pair = new WebSocketPair()
    const [client, server] = [pair[0], pair[1]]
    if (at.role === 'mac') {
      // One Mac end: the newest wins (an app restart reconnects before the old
      // socket times out).
      for (const old of this.ctx.getWebSockets('mac')) old.close(4001, 'replaced')
    }
    this.ctx.acceptWebSocket(server, [at.role])
    if (at.role === 'mac') {
      // The Mac rewinds its transcript reader to just after this, so whatever it
      // sent into a half-dead socket (OPEN, but never arrived) is sent again.
      this.send(server, { type: 'resume', cur: (await this.ctx.storage.get<Cursor>('cur')) ?? null })
      const held = await this.ctx.storage.get('pushToken')
      if (held) {
        this.send(server, held)
        await this.ctx.storage.delete('pushToken')
      }
      this.toPhones({ type: 'mac', online: true })
    } else {
      server.serializeAttachment({ t: now })
      const head = (await this.ctx.storage.get<number>('seq')) ?? 0
      const projects = (await this.ctx.storage.get('projects')) ?? null
      const macOnline = this.ctx.getWebSockets('mac').length > 0
      // `pushToken`: hand over your push token — the Mac (as it last said) can push.
      const pushToken = (await this.ctx.storage.get<boolean>('push')) === true
      this.send(server, { type: 'hello', v: 1, mac: macOnline, head, projects, pushToken })
      // Catch-up only when asked: no `after` = live from now (Number(null) is 0).
      const after = seqParam(url, 'after')
      if (Number.isInteger(after) && after >= 0 && after < head) {
        const from = Math.max(after + 1, head - EVENT_KEEP + 1)
        const rows = await this.ctx.storage.list({ start: evKey(from), end: evKey(head + 1) })
        for (const ev of rows.values()) this.send(server, ev)
      }
      // What the phone says it heard is erased now (not `after`: the phone may
      // rewind below that to hear again a line that found no audio).
      const heard = seqParam(url, 'heard')
      if (Number.isInteger(heard) && heard >= 1) {
        const done = await this.ctx.storage.list({ start: evKey(1), end: evKey(Math.min(heard, head) + 1) })
        await this.erase([...done.keys()])
      }
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const role = this.ctx.getTags(ws)[0]
    if (role !== 'phone' && role !== 'mac') return
    const f = parse(msg, role === 'phone' ? PHONE_FRAME_MAX : MAC_FRAME_MAX)
    // Counted per end: every phone frame; of the Mac's, those that write here
    // (event / projects / push-ready) — what the Mac sends again on a redial.
    const lim = this.limits
    const over =
      role === 'phone'
        ? !this.phoneFrames.hit(Date.now(), lim.phoneFramesPerMin)
        : (f?.type === 'event' || f?.type === 'projects' || f?.type === 'push-ready') &&
          !this.macFrames.hit(Date.now(), lim.macFramesPerMin)
    await this.handle(ws, role, f)
    // Too fast: this frame was handled, then the sender is cut off. It redials
    // (backoff); the Mac resumes from the newest stored event and sends its
    // project list and push-ready again on connect.
    if (over)
      try {
        ws.close(4029, 'rate')
      } catch {
        /* already closing */
      }
  }

  private async handle(ws: WebSocket, role: 'phone' | 'mac', f: Frame | null): Promise<void> {
    if (role === 'phone') {
      if (
        !f ||
        (f.type !== 'say' && f.type !== 'select' && f.type !== 'projects' && f.type !== 'push-token' && f.type !== 'assistant-history' && f.type !== 'call-note')
      ) {
        this.send(ws, { type: 'error', code: 'bad-frame' })
        return
      }
      const mac = this.ctx.getWebSockets('mac')[0]
      if (!mac && f.type === 'push-token') {
        // A new token while the Mac sleeps: held (the newest only) until it is
        // back, or the Mac would push to a dead token and the phone, locked,
        // would never be woken again. Erased by `reset` with the rest.
        const target = asPushTarget(f)
        if (target === undefined) return this.send(ws, { type: 'error', code: 'bad-frame' })
        await this.ctx.storage.put('pushToken', { type: 'push-token', ...(target ?? { token: null }) })
        return
      }
      if (!mac) {
        this.send(ws, { type: 'error', code: 'mac-offline', ...(typeof f.id === 'string' ? { id: f.id } : {}) })
        return
      }
      if (f.type === 'push-token') {
        // Passed on, never stored here: the Mac keeps it and sends the push.
        const target = asPushTarget(f)
        if (target === undefined) return this.send(ws, { type: 'error', code: 'bad-frame' })
        this.send(mac, { type: 'push-token', ...(target ?? { token: null }) })
        return
      }
      this.send(mac, f)
      return
    }
    if (!f) return
    if (f.type === 'event') {
      const { cur: raw, ...rest } = f
      const cur = asCursor(raw)
      // A resend after a resume: already stored and told — dropped, never twice.
      if (cur && alreadyStored(await this.ctx.storage.get<Cursor>('cur'), cur)) return
      const seq = ((await this.ctx.storage.get<number>('seq')) ?? 0) + 1
      const now = Date.now()
      // Never later than now: the expiry runs on this time and must not be put off.
      const ev = { ...rest, seq, at: typeof f.at === 'number' && Number.isFinite(f.at) && f.at <= now ? f.at : now }
      await this.ctx.storage.put({ seq, [evKey(seq)]: ev, ...(cur ? { cur } : {}) })
      if (seq > EVENT_KEEP) await this.ctx.storage.delete(evKey(seq - EVENT_KEEP))
      await this.arm(ev.at + this.limits.eventTtlS * 1000)
      this.toPhones(ev)
    } else if (f.type === 'projects') {
      await this.ctx.storage.put('projects', f)
      this.toPhones(f)
    } else if (f.type === 'ack' || f.type === 'assistant' || f.type === 'assistant-history') {
      this.toPhones(f)
    } else if (f.type === 'push-ready') {
      await this.ctx.storage.put('push', f.on === true)
    } else if (f.type === 'reset') {
      // Unpair: nothing of this room may be readable afterwards.
      for (const p of this.ctx.getWebSockets('phone')) p.close(4003, 'unpaired')
      // deleteAll also drops the alarm (compatibility_date >= 2026-02-24).
      await this.ctx.storage.deleteAll()
      // ...and the old keys open nothing again (a lost phone stays locked out).
      await this.ctx.storage.put('revoked', true)
      ws.close(1000, 'reset')
    }
  }

  /** The room's sweep: expired events go; a room unused for roomIdleS is emptied
   *  — everything but the Mac key's hash, so its Mac (even a build without the
   *  app key) can come back to it and the phone is not told "unlinked" — and the
   *  position of the newest event it stored (`cur`), so that Mac does not send
   *  its old talk again. */
  async alarm(): Promise<void> {
    if (await this.ctx.storage.get('revoked')) return
    const lim = this.limits
    const now = Date.now()
    let used = (await this.ctx.storage.get<number>('used')) ?? 0
    if (this.ctx.getWebSockets().length > 0) {
      // Someone is connected: in use, however long ago they dialled.
      used = now
      await this.ctx.storage.put('used', now)
    } else if (now - used >= lim.roomIdleS * 1000) {
      // Also drops the alarm (re-armed when someone connects again).
      // `cur` stays too: without it the returning Mac hears `resume null` and
      // sends again up to 4 MB of old talk as new — waking the phone to read it.
      const keep = await this.ctx.storage.get(['macHash', 'cur'])
      await this.ctx.storage.deleteAll()
      if (keep.size > 0) await this.ctx.storage.put(Object.fromEntries(keep))
      return
    }
    const cutoff = now - lim.eventTtlS * 1000 + sweepSlackMs(lim)
    const expired: string[] = []
    let oldest: number | undefined
    for (const [k, ev] of await this.ctx.storage.list<{ at?: number }>({ prefix: 'ev:' })) {
      const t = typeof ev.at === 'number' ? ev.at : 0
      if (t <= cutoff) expired.push(k)
      else oldest = Math.min(oldest ?? t, t)
    }
    await this.erase(expired)
    await this.ctx.storage.setAlarm(nextSweep(used, oldest, lim))
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    if (this.ctx.getTags(ws)[0] !== 'mac') return
    if (this.ctx.getWebSockets('mac').every((m) => m === ws)) this.toPhones({ type: 'mac', online: false })
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname === '/' || url.pathname === '/health') return new Response('og-phone-relay ok')
    const at = parseRoomPath(url.pathname)
    if (!at) return new Response('not found', { status: 404 })
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('upgrade required', { status: 426 })
    const hash = await tokenHashFor(at.role, at.room, req.headers.get(PHONE_RELAY_TOKEN_HEADER))
    if (!hash) return new Response('unauthorized', { status: 401 })
    const headers = new Headers(req.headers)
    headers.set(HASH_HEADER, hash) // set, never appended: a client copy is overwritten
    headers.delete(CREATE_HEADER) // only this Worker says who may create
    if (at.role === 'mac' && (await mayCreateRoom(req, env))) headers.set(CREATE_HEADER, '1')
    headers.delete(PHONE_RELAY_TOKEN_HEADER) // the keys themselves go no further
    headers.delete(PHONE_RELAY_APP_KEY_HEADER)
    return env.OgPhoneRelay.get(env.OgPhoneRelay.idFromName(at.room)).fetch(new Request(req, { headers }))
  },
}
