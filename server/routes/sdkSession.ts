// server/routes/sdkSession.ts — Hono sub-router for Agent SDK worker sessions.
// Declares FULL /api/... paths (the mount prefix in app.ts is empty). Handlers
// are THIN ADAPTERS over src/lib/server/sdkSession.ts.
//
// The PTY equivalent is routes/terminal.ts + routes/sse.ts. This one is much
// smaller for a structural reason: an SDK session emits a handful of distilled
// events per turn, not a torrent of terminal repaints, so none of the xterm-era
// machinery (16ms coalescing, ACK-based flow control, replay of a screen
// buffer) applies. What replaces it is a sequence number: a reader says where
// it got to and is served what came after — and is TOLD when the ring buffer
// has already dropped frames rather than being handed a quietly incomplete
// history.
//
// SECURITY. Every path-accepting endpoint must pass validateProjectPath — the
// registry is the allowlist and a worker's worktree sits under the project's
// central worktrees dir, which that predicate already admits. The session's own
// cwd is ALSO checked against the caller-supplied path, so a valid project path
// cannot be used to reach a session belonging to a different one.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  attachSdkListener,
  getSdkSession,
  interruptSdkSession,
  pushSdkInput,
  terminateSdkSession,
  type SdkStreamFrame,
} from '@/lib/server/sdkSession'
import { requireProjectPath } from '../middleware/projectPath'

const HEARTBEAT_MS = 25_000

/** Resolve the session and prove the caller is entitled to it.
 *
 *  Two gates, not one: the supplied project path must be a registered project
 *  (requireProjectPath), AND the session's cwd must sit under it. Without the
 *  second, any registered project would unlock every live session. */
const requireSession = async (c: Parameters<typeof requireProjectPath>[0], id: string) => {
  const path = await requireProjectPath(c)
  if (path instanceof Response) return path
  const s = getSdkSession(id)
  if (!s) return c.json({ error: 'no such sdk session' }, 404)
  const cwd = s.cwd
  if (cwd !== path && !cwd.startsWith(path.endsWith('/') ? path : path + '/')) {
    // Deliberately the same 403 shape as an unregistered path: which sessions
    // exist is not something an unentitled caller should be able to probe.
    return c.json({ error: 'session does not belong to this project' }, 403)
  }
  return s
}

export const sdkSessionRoutes = new Hono()
  // ── GET /api/sdk-session/:id ───────────────────────────────────────────────
  .get('/api/sdk-session/:id', async (c) => {
    const s = await requireSession(c, c.req.param('id'))
    if (s instanceof Response) return s
    return c.json(s)
  })

  // ── GET /api/sdk-session/:id/stream?from=<seq> ─────────────────────────────
  // SSE. Replays whatever the ring buffer still holds after `from`, then tails.
  .get('/api/sdk-session/:id/stream', async (c) => {
    const id = c.req.param('id')
    const gate = await requireSession(c, id)
    if (gate instanceof Response) return gate

    const fromRaw = Number(c.req.query('from') ?? '0')
    const from = Number.isFinite(fromRaw) && fromRaw > 0 ? Math.floor(fromRaw) : 0

    return streamSSE(c, async (stream) => {
      let closed = false
      let heartbeat: ReturnType<typeof setInterval> | null = null
      let detach: (() => void) | null = null
      let resolveDone: (() => void) | null = null

      const closeAll = () => {
        if (closed) return
        closed = true
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = null
        detach?.()
        detach = null
        resolveDone?.()
      }

      const send = (frame: SdkStreamFrame) => {
        if (closed) return
        void stream
          .writeSSE({ event: 'frame', data: JSON.stringify(frame) })
          .catch(() => closeAll())
      }

      const att = attachSdkListener(id, from, send)
      if (!att) {
        await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'gone' }) })
        return
      }
      detach = att.detach

      // `init` first so the client knows the session state AND whether it is
      // looking at a complete history. `truncated` is not cosmetic: a reader
      // that silently missed frames would draw wrong conclusions from a
      // transcript that merely looks continuous.
      await stream.writeSSE({
        event: 'init',
        data: JSON.stringify({
          session: getSdkSession(id),
          truncated: att.truncated,
          replay: att.replay,
        }),
      })

      // A session that had already finished before this stream attached must
      // not leave the connection hanging.
      const now = getSdkSession(id)
      if (!now || now.status === 'exited' || now.status === 'failed') {
        await stream.writeSSE({ event: 'end', data: JSON.stringify({ session: now }) })
        closeAll()
        return
      }

      heartbeat = setInterval(() => {
        if (closed) return
        void stream.writeSSE({ event: 'ping', data: '{}' }).catch(() => closeAll())
      }, HEARTBEAT_MS)

      c.req.raw.signal?.addEventListener('abort', closeAll)

      await new Promise<void>((res) => {
        resolveDone = res
      })
    })
  })

  // ── POST /api/sdk-session/:id/input ────────────────────────────────────────
  // One turn. Safe MID-TURN: the CLI queues it and handles it when the current
  // turn ends (measured), which is what lets the engine inject a rework
  // instruction without the PTY path's paste-then-re-read-the-screen dance.
  .post('/api/sdk-session/:id/input', async (c) => {
    const id = c.req.param('id')
    const gate = await requireSession(c, id)
    if (gate instanceof Response) return gate
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown }
    const text = typeof body.text === 'string' ? body.text : ''
    if (!text.trim()) return c.json({ error: 'text is required' }, 400)
    const queued = pushSdkInput(id, text)
    if (!queued) return c.json({ error: 'session is no longer accepting input' }, 409)
    return c.json({ ok: true, queued: true })
  })

  // ── POST /api/sdk-session/:id/interrupt ────────────────────────────────────
  // Stop the CURRENT turn, keep the session. The graceful stop the PTY path
  // never had (there, stopping a worker meant killing it).
  .post('/api/sdk-session/:id/interrupt', async (c) => {
    const id = c.req.param('id')
    const gate = await requireSession(c, id)
    if (gate instanceof Response) return gate
    return c.json({ ok: await interruptSdkSession(id) })
  })

  // ── DELETE /api/sdk-session/:id ────────────────────────────────────────────
  .delete('/api/sdk-session/:id', async (c) => {
    const id = c.req.param('id')
    const gate = await requireSession(c, id)
    if (gate instanceof Response) return gate
    return c.json({ ok: terminateSdkSession(id) })
  })
