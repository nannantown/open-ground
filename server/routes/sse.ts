// server/routes/sse.ts — Hono sub-router for the SSE group (terminal stream).
// Declares FULL /api/... paths (the mount prefix in app.ts is empty:
// app.route('/', sseRoutes)). Handlers are THIN ADAPTERS over the existing
// src/lib/server/* logic.
//
// streamSSE keeps the connection open until its callback resolves; we await a
// promise that only settles on client abort (or PTY exit), then clean up
// subscriptions and the heartbeat. SSE frame fields map: event -> {event},
// data -> {data: JSON.stringify(x)}.

import { randomUUID } from 'crypto'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import {
  registerFlowStream,
  subscribeTerminal,
  trackFlowSent,
  unregisterFlowStream,
} from '@/lib/server/terminal'

// Coalescing window, LEADING edge: the first chunk after an idle gap goes out
// immediately (a single keystroke echo pays zero added latency), then chunks
// landing within COALESCE_MS are merged into ONE `data` event when the window
// closes — re-armed while the burst lasts. Claude's TUI repaints emit hundreds
// of tiny chunks per second — per-chunk SSE events flood the client's main
// thread (and multiply across parallel sessions), while ~one event per frame
// is invisible to the eye. Exported for the route tests (which drive the
// window with fake timers).
export const COALESCE_MS = 16

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
    // The exit event must go out exactly once. Two paths can race to it: the
    // PTY onExit chain (flush → exit → closeAll) and the post-init finishedAt
    // re-check below (a PTY that died while `init` was being awaited). Both
    // test-and-set this flag synchronously before writing.
    let exitSent = false
    let heartbeat: ReturnType<typeof setInterval> | null = null
    let sub: ReturnType<typeof subscribeTerminal> = null
    // Identifies THIS subscriber in the terminal's flow accounting (several
    // tabs can stream the same PTY). Sent to the client in `init` so its ACKs
    // (POST /api/terminal/:id/ack) credit the right flow.
    const streamId = randomUUID()
    // Lets the PTY-exit callback end the stream server-side. Without this the
    // callback cleaned up listeners but never resolved the hold-open promise,
    // so the SSE connection lingered half-open until the client disconnected.
    let resolveDone: (() => void) | null = null
    // Coalescing state: the first chunk of a burst flushes immediately
    // (leading edge), then `pending` accumulates and drains as one `data`
    // event per COALESCE_MS window while output keeps arriving. Only the
    // flushed length is counted toward flow control — the client ACKs the
    // same chunk strings' .length.
    let pending = ''
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const closeAll = () => {
      if (closed) return
      closed = true
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null }
      try { sub?.unsubscribe() } catch {}
      unregisterFlowStream(id, streamId)
      resolveDone?.()
    }

    const send = (event: string, data: unknown) => {
      if (closed) return Promise.resolve()
      return stream.writeSSE({ event, data: JSON.stringify(data) })
    }

    // Drains `pending` synchronously (state + flow accounting settle in this
    // tick); the returned promise tracks the wire write so the exit path can
    // order itself behind it.
    const flush = (): Promise<unknown> => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      if (closed || !pending) return Promise.resolve()
      const out = pending
      pending = ''
      // Catch a write-to-dead-socket rejection (and tear down) so it can't
      // become an unhandledRejection before onAbort fires. Mirrors heartbeat.
      const wrote = send('data', { chunk: out }).catch(() => closeAll())
      trackFlowSent(id, streamId, out.length)
      return wrote
    }

    // Window close: drain whatever piled up during the window and hold the
    // cadence (one event per COALESCE_MS while the burst lasts); an empty
    // window ends the cadence, so the next chunk leads again.
    const onWindow = () => {
      flushTimer = null
      if (closed || !pending) return
      void flush()
      flushTimer = setTimeout(onWindow, COALESCE_MS)
    }

    try {
      sub = subscribeTerminal(
        id,
        (chunk) => {
          pending += chunk
          // Leading edge: idle stream → send NOW (a lone keystroke echo pays
          // no coalescing latency) and open the merge window; mid-burst
          // chunks pile into `pending` until the window closes.
          if (!flushTimer && !closed) {
            void flush()
            flushTimer = setTimeout(onWindow, COALESCE_MS)
          }
        },
        (info) => {
          // Flush BEFORE the exit event so the tail of the output is neither
          // dropped nor reordered behind it — and close only once both writes
          // have settled: closeAll resolves the hold-open promise, after which
          // streamSSE close()s the stream, and a close racing the un-awaited
          // writes drops them on the floor (StreamingApi.write swallows the
          // rejection).
          void flush()
            .then(() => {
              if (exitSent) return
              exitSent = true
              return send('exit', info)
            })
            .catch(() => {})
            .then(() => closeAll())
        },
      )

      if (!sub) {
        await send('error', { error: 'not found' })
        return
      }

      // closeAll doubles as the flow's onStall: when THIS subscriber stalls
      // (a background-throttled renderer stops draining xterm, so its ACKs
      // stop), the server ends the stream rather than let it jam the PTY —
      // immediately if a healthy watcher of the same PTY would otherwise be
      // frozen by the pause, or after FLOW_PAUSE_CAP_MS of paused PTY when
      // it was the only watcher. EventSource auto-reconnects and the fresh
      // init below repaints the screen.
      registerFlowStream(id, streamId, closeAll)

      // streamId is an ADDITIVE field — an older client just ignores it (and
      // never ACKs, which flow control treats as an uncontrolled flow). The
      // replay is deliberately not counted as sent: the client ACKs only
      // `data` chunks, so counting it would fake a permanent backlog.
      // CONTRACT for ACKing clients: treat every init as a FULL repaint —
      // reset the terminal before writing `replay`. A reconnect after a stall
      // drop re-delivers the whole ring buffer; appending it to the existing
      // screen would double-paint. (Non-ACKing clients are never stall-dropped,
      // so their append-on-first-init behavior is unaffected.)
      await send('init', { info: sub.info, replay: sub.replay, streamId })

      // If the PTY already exited (a session that finished in the window
      // between the client's metadata probe and this subscribe, while still in
      // its post-exit linger), the onExit listener we just registered will
      // NEVER fire — proc.onExit is a one-shot past event. Without this the
      // stream would hold open until the client disconnects (leaked half-open
      // SSE) and the client never sees the exit. Emit it explicitly and end —
      // unless the PTY died DURING the awaited init above, in which case the
      // onExit chain fired and already owns (or sent) the exit event.
      if (sub.info.finishedAt) {
        if (!exitSent) {
          exitSent = true
          await send('exit', sub.info)
        }
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
