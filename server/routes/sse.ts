// server/routes/sse.ts — Hono sub-router for the SSE group.
// Declares FULL /api/... paths (the mount prefix in app.ts is empty:
// app.route('/', sseRoutes)). Handlers are THIN ADAPTERS over the existing
// src/lib/server/* logic — the hand-rolled ReadableStream + TextEncoder of the
// Next routes is replaced with hono/streaming's streamSSE, but subscribe/emit
// and the runner's globalThis state stay exactly as-is.
//
// streamSSE keeps the connection open until its callback resolves; we await a
// promise that only settles on client abort, then clean up subscriptions and
// the heartbeat. SSE frame fields map: id -> {id}, event -> {event},
// data -> {data: JSON.stringify(x)}. We do NOT set dynamic='force-dynamic'
// (Next-only); Hono streams natively.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { currentSeq, getEventsSince, oldestSeq, subscribeAll } from '@/lib/server/runner'
import type { RunEvent } from '@/lib/server/runner'
import { subscribeTerminal } from '@/lib/server/terminal'

export const sseRoutes = new Hono()
// ── /api/run/events ─────────────────────────────────────────────────────────
// A single multiplexed SSE stream carrying every run's events, each tagged with
// its `sessionId` and a monotonic `id:` (the runner seq).
//
// Reconnection model:
//   - EventSource auto-reconnects and sends the last id via `Last-Event-ID`;
//     we replay everything newer.
//   - Manual reconnects (visibilitychange / online) pass the same value via
//     `?since=<seq>` — both paths converge here.
//   - First-time clients get a `cursor` event with the current seq and
//     rehydrate snapshot state via /api/run/list.
//   - If the gap is wider than the in-memory buffer, we emit `cursor` so the
//     client knows to rehydrate from scratch.
  .get('/api/run/events', (c) => {
  const lastEventId = c.req.header('last-event-id') ?? c.req.query('since')
  const parsed = lastEventId ? parseInt(lastEventId, 10) : NaN
  const since = Number.isFinite(parsed) ? parsed : null

  return streamSSE(c, async (stream) => {
    // G1 crash resilience: once the stream is torn down (client abort, or a
    // writeSSE that threw because the socket is gone) we must stop touching it.
    // `closed` gates every write; `closeAll` is idempotent (safe to call from
    // both the catch path and onAbort, and twice over) so cleanup can never
    // double-clear or double-unsubscribe into a throw.
    let closed = false
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let unsubscribe: (() => void) | null = null
    const closeAll = () => {
      if (closed) return
      closed = true
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
      try { unsubscribe?.() } catch {}
      unsubscribe = null
    }

    const send = (event: string, data: unknown, id: number) => {
      if (closed) return Promise.resolve()
      return stream.writeSSE({ id: String(id), event, data: JSON.stringify(data) })
    }

    try {
      // SUBSCRIBE FIRST, then replay. The old order (replay → subscribe) had a
      // gap: events emitted during the awaited replay loop were neither in the
      // replay snapshot nor yet subscribed, so they were dropped on this
      // connection until the next reconnect (a live log could skip lines mid-
      // run). Now we subscribe up front, buffer anything that arrives while
      // we're replaying, then flush the buffer — de-duped against the replay by
      // sequence number (`upTo`). check+subscribe is synchronous so no emit can
      // interleave before `upTo` is captured.
      const buffered: { seq: number; sessionId: string; e: RunEvent }[] = []
      let live = false
      unsubscribe = subscribeAll((sessionId, e, seq) => {
        if (!live) {
          buffered.push({ seq, sessionId, e })
          return
        }
        void send(e.type, { ...e, sessionId }, seq)
      })
      const upTo = currentSeq()

      // Catch-up: replay buffered events the client missed during the gap.
      // If the gap is wider than our ring buffer can cover, fall through to a
      // cursor event so the client knows to rehydrate via /api/run/list.
      if (since !== null) {
        const oldest = oldestSeq()
        if (since < oldest - 1) {
          await send('cursor', { seq: upTo }, upTo)
        } else {
          for (const { seq, sessionId, event } of getEventsSince(since)) {
            if (seq <= upTo) await send(event.type, { ...event, sessionId }, seq)
          }
        }
      } else {
        // First connection — broadcast current seq so the client can resume
        // from here on the next reconnect.
        await send('cursor', { seq: upTo }, upTo)
      }

      // Go live, then flush anything that arrived during replay (seq > upTo so
      // it can't duplicate a replayed event).
      live = true
      for (const { seq, sessionId, e } of buffered) {
        if (seq > upTo) await send(e.type, { ...e, sessionId }, seq)
      }
      buffered.length = 0

      // Keep the long-lived connection from being dropped while idle.
      heartbeat = setInterval(() => {
        if (closed) return
        void stream.writeSSE({ event: 'ping', data: '' }).catch(() => closeAll())
      }, 25000)

      // Hold the stream open until the client disconnects, then clean up.
      // onAbort -> closeAll is idempotent, so registering it twice (here +
      // the resolve below) and firing on a stream that's already closed is safe.
      stream.onAbort(closeAll)
      await new Promise<void>((resolve) => stream.onAbort(resolve))
    } catch (err) {
      // A throw from send/writeSSE means the connection is dead — unsubscribe
      // and stop the heartbeat so we don't leak a listener/timer, then let the
      // stream resolve cleanly (no rethrow → no unhandledRejection).
      console.error('[openground:sse] run/events stream error', err)
    } finally {
      closeAll()
    }
  })
})
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
        (chunk) => { void send('data', { chunk }) },
        (info) => {
          void send('exit', info)
          closeAll()
        },
      )

      if (!sub) {
        await send('error', { error: 'not found' })
        return
      }

      await send('init', { info: sub.info, replay: sub.replay })

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
