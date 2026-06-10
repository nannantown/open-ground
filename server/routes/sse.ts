// server/routes/sse.ts — Hono sub-router for the SSE group (terminal stream).
// Declares FULL /api/... paths (the mount prefix in app.ts is empty:
// app.route('/', sseRoutes)). Handlers are THIN ADAPTERS over the existing
// src/lib/server/* logic.
//
// streamSSE keeps the connection open until its callback resolves; we await a
// promise that only settles on client abort (or PTY exit), then clean up
// subscriptions and the heartbeat. SSE frame fields map: event -> {event},
// data -> {data: JSON.stringify(x)}.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { subscribeTerminal } from '@/lib/server/terminal'

export const sseRoutes = new Hono()
  // ── /api/terminal/:id/stream ([id] -> :id) ─────────────────────────────────
  // SSE stream of PTY output for one terminal session. The first event is an
  // `init` carrying the replay buffer so a fresh subscriber (page reload, panel
  // re-mount) repaints the screen instead of seeing a blank.
  .get('/api/terminal/:id/stream', (c) => {
  const id = c.req.param('id')

  return streamSSE(c, async (stream) => {
    // G1 crash resilience — same closed/closeAll discipline as run/events.
    // closeAll guards on `closed` so the PTY exit callback, the client abort,
    // and the catch/finally paths can all call it without double-clearing the
    // heartbeat or double-unsubscribing.
    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let sub: ReturnType<typeof subscribeTerminal> = null
    // Lets the PTY-exit callback end the stream server-side. Without this the
    // callback cleaned up listeners but never resolved the hold-open promise,
    // so the SSE connection lingered half-open until the client disconnected.
    let resolveDone: (() => void) | null = null
    const closeAll = () => {
      if (closed) return
      closed = true
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
      try { sub?.unsubscribe() } catch {}
      resolveDone?.()
    }

    const send = (event: string, data: unknown) => {
      if (closed) return Promise.resolve()
      return stream.writeSSE({ event, data: JSON.stringify(data) })
    }

    try {
      sub = subscribeTerminal(
        id,
        // Catch a write-to-dead-socket rejection (and tear down) so it can't
        // become an unhandledRejection before onAbort fires. Mirrors heartbeat.
        (chunk) => { void send('data', { chunk }).catch(() => closeAll()) },
        (info) => {
          void send('exit', info).catch(() => {})
          closeAll()
        },
      )

      if (!sub) {
        await send('error', { error: 'not found' })
        return
      }

      await send('init', { info: sub.info, replay: sub.replay })

      // If the PTY already exited (a session that finished in the window
      // between the client's metadata probe and this subscribe, while still in
      // its post-exit linger), the onExit listener we just registered will
      // NEVER fire — proc.onExit is a one-shot past event. Without this the
      // stream would hold open until the client disconnects (leaked half-open
      // SSE) and the client never sees the exit. Emit it explicitly and end.
      if (sub.info.finishedAt) {
        await send('exit', sub.info)
        return
      }

      heartbeat = setInterval(() => {
        if (closed) return
        void stream.writeSSE({ event: 'ping', data: '' }).catch(() => closeAll())
      }, 25000)

      stream.onAbort(closeAll)
      await new Promise<void>((resolve) => {
        resolveDone = resolve
        // If the PTY already exited synchronously during subscribe, closeAll
        // ran before resolveDone was set — end immediately in that case.
        if (closed) resolve()
      })
    } catch (err) {
      console.error('[openground:sse] terminal stream error', err)
    } finally {
      closeAll()
    }
  })
})
