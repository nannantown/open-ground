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
import { DurableObject } from 'cloudflare:workers'
import { PHONE_RELAY_TOKEN_HEADER, alreadyStored, asCursor, macAllowed, parseRoomPath, tokenHashFor, type Cursor } from './phoneRelayAuth'

export interface Env {
  OgPhoneRelay: DurableObjectNamespace<OgPhoneRelay>
}

const EVENT_KEEP = 200
const PHONE_FRAME_MAX = 16 * 1024
const MAC_FRAME_MAX = 64 * 1024
const HASH_HEADER = 'x-og-token-hash'
const evKey = (seq: number) => `ev:${String(seq).padStart(12, '0')}`

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

export class OgPhoneRelay extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // App-level keepalive answered without waking the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
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

  async fetch(req: Request): Promise<Response> {
    const at = parseRoomPath(new URL(req.url).pathname)
    const hash = req.headers.get(HASH_HEADER)
    if (!at || !hash || (await this.ctx.storage.get('revoked'))) return new Response('unauthorized', { status: 401 })
    if (at.role === 'mac') {
      const registered = await this.ctx.storage.get<string>('macHash')
      if (!macAllowed(registered, hash)) return new Response('unauthorized', { status: 401 })
      if (registered === undefined) await this.ctx.storage.put('macHash', hash)
    }
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
      this.toPhones({ type: 'mac', online: true })
    } else {
      const head = (await this.ctx.storage.get<number>('seq')) ?? 0
      const projects = (await this.ctx.storage.get('projects')) ?? null
      const macOnline = this.ctx.getWebSockets('mac').length > 0
      this.send(server, { type: 'hello', v: 1, mac: macOnline, head, projects })
      // Catch-up only when asked: no `after` = live from now (Number(null) is 0).
      const raw = new URL(req.url).searchParams.get('after')
      const after = raw === null || raw === '' ? NaN : Number(raw)
      if (Number.isInteger(after) && after >= 0 && after < head) {
        const from = Math.max(after + 1, head - EVENT_KEEP + 1)
        const rows = await this.ctx.storage.list({ start: evKey(from), end: evKey(head + 1) })
        for (const ev of rows.values()) this.send(server, ev)
      }
    }
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const role = this.ctx.getTags(ws)[0]
    if (role === 'phone') {
      const f = parse(msg, PHONE_FRAME_MAX)
      if (!f || (f.type !== 'say' && f.type !== 'select' && f.type !== 'projects')) {
        this.send(ws, { type: 'error', code: 'bad-frame' })
        return
      }
      const mac = this.ctx.getWebSockets('mac')[0]
      if (!mac) {
        this.send(ws, { type: 'error', code: 'mac-offline', ...(typeof f.id === 'string' ? { id: f.id } : {}) })
        return
      }
      this.send(mac, f)
      return
    }
    if (role !== 'mac') return
    const f = parse(msg, MAC_FRAME_MAX)
    if (!f) return
    if (f.type === 'event') {
      const { cur: raw, ...rest } = f
      const cur = asCursor(raw)
      // A resend after a resume: already stored and told — dropped, never twice.
      if (cur && alreadyStored(await this.ctx.storage.get<Cursor>('cur'), cur)) return
      const seq = ((await this.ctx.storage.get<number>('seq')) ?? 0) + 1
      const ev = { ...rest, seq, at: typeof f.at === 'number' ? f.at : Date.now() }
      await this.ctx.storage.put({ seq, [evKey(seq)]: ev, ...(cur ? { cur } : {}) })
      if (seq > EVENT_KEEP) await this.ctx.storage.delete(evKey(seq - EVENT_KEEP))
      this.toPhones(ev)
    } else if (f.type === 'projects') {
      await this.ctx.storage.put('projects', f)
      this.toPhones(f)
    } else if (f.type === 'ack') {
      this.toPhones(f)
    } else if (f.type === 'reset') {
      // Unpair: nothing of this room may be readable afterwards.
      for (const p of this.ctx.getWebSockets('phone')) p.close(4003, 'unpaired')
      await this.ctx.storage.deleteAll()
      // ...and the old keys open nothing again (a lost phone stays locked out).
      await this.ctx.storage.put('revoked', true)
      ws.close(1000, 'reset')
    }
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
    headers.delete(PHONE_RELAY_TOKEN_HEADER) // the key itself goes no further
    return env.OgPhoneRelay.get(env.OgPhoneRelay.idFromName(at.room)).fetch(new Request(req, { headers }))
  },
}
