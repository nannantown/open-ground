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
  isSdkSessionLive,
  pushSdkInput,
  terminateSdkSession,
  type SdkStreamFrame,
} from '@/lib/server/sdkSession'
import { projectUUIDFromPath } from '@/lib/server/projectDataPath'
import { requireProjectPath } from '../middleware/projectPath'

const HEARTBEAT_MS = 25_000

/** Resolve the session and prove the caller is entitled to it.
 *
 *  Two gates, not one: the supplied project path must be a registered project
 *  (requireProjectPath), AND the session must belong to that project. Without
 *  the second, any registered project would unlock every live session.
 *
 *  Ownership is judged by REGISTRY UUID, not by path prefix. The first shipped
 *  version compared `s.cwd.startsWith(path)` — which quietly 403'd EVERY SDK
 *  worker, because a worker's cwd is its worktree and worktrees live OUTSIDE
 *  the repo (~/.openground/projects/<uuid>/worktrees/, the central-dir design).
 *  Its route test passed by constructing a worktree INSIDE the project — an
 *  arrangement production never creates. `projectUUIDFromPath` already resolves
 *  both the project root and that project's central worktrees to the same UUID
 *  (it is the same predicate validateProjectPath stands on), so same-UUID is
 *  precisely "this session works for this project". */
const requireSession = async (c: Parameters<typeof requireProjectPath>[0], id: string) => {
  const path = await requireProjectPath(c)
  if (path instanceof Response) return path
  const s = getSdkSession(id)
  if (!s) return c.json({ error: 'no such sdk session' }, 404)
  try {
    const [caller, owner] = await Promise.all([
      projectUUIDFromPath(path),
      projectUUIDFromPath(s.cwd),
    ])
    if (caller !== owner) throw new Error('different project')
  } catch {
    // Deliberately the same 403 shape for "other project" and "cwd resolves to
    // nothing": which sessions exist is not something an unentitled caller
    // should be able to probe.
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

      // Close the stream when the SESSION ends, not only when the client leaves.
      // Without this, the finished session's last frame was delivered and then
      // nothing: the heartbeat kept pinging a dead session forever, the `await`
      // at the bottom never settled (one pending promise + one interval per
      // finished worker), and the client never got its 'end' — so a tile whose
      // worker had exited kept rendering as live.
      //
      // Declared HERE, above `send`, deliberately. The first version of this fix
      // forward-declared a `let endIfFinishedRef` assigned further down, which
      // left a real window: the listener is attached before that assignment and
      // there are `await`s in between, so a terminal frame arriving in the gap
      // hit a no-op and the stream stayed open until the next 25 s heartbeat
      // noticed. Defining it up front removes the window instead of narrowing it.
      //
      // ⚠ REAPED, NEVER STATUS. `end` means "no further event can arrive on this
      // stream", and that is the definition of {@link isSdkSessionLive}'s
      // negation — not of a terminal STATUS. `terminateSdkSession` writes
      // 'exited' synchronously (it only ASKS the CLI to stop), while the pump
      // keeps draining and keeps emitting: the aborted turn's own `result`, the
      // last tool results, the exit reason. Judged on status this route:
      //   • cut the stream at the heartbeat that noticed, dropping exactly those
      //     final frames — the ones that say HOW the desk ended;
      //   • answered a re-attach during the teardown with an instant `end`, so a
      //     reopened tile went blank;
      //   • and disagreed with the Swarm list beside it on the same screen,
      //     which counts `!reaped` and therefore still drew the desk as running.
      // One question, one predicate.
      //
      // NO LATENCY IS ADDED BY THIS — checked in the pump itself rather than
      // assumed (src/lib/server/sdkSession.ts, the `finally`): `reaped = true`
      // is set BEFORE the terminal status frame is emitted, and that frame is
      // now emitted UNCONDITIONALLY (setStatus's dedupe used to swallow it after
      // a terminate, leaving the reap with no frame to ride on and this stream
      // waiting out a heartbeat). So the pool already answers "reaped" when the
      // announcement reaches `send` below: every path that was right to end
      // still ends on the same tick.
      //
      // ⚠ AND THE STREAM CAN OUTLIVE THE DESK'S USEFULNESS — ON PURPOSE. This
      // route ends on the REAP and on nothing else, so a session whose pump never
      // returns (the owner stopped it, the CLI wedged — e.g. a claude stuck in
      // D-state `git`, the 2026-07-28 machine freeze) NEVER gets an `end`: the
      // client sits on a 25 s heartbeat indefinitely. That is the intended
      // trade, not an oversight. The desk is genuinely still there — the pool
      // still reports its cwd as live (`listActiveSdkCwds`) and the retention
      // sweep deliberately refuses to drop it, precisely so nothing deletes its
      // worktree out from under it. Telling the tile "gone" while every other
      // reader says "running" is the one-screen-two-answers defect this whole
      // seam exists to remove; an idle SSE connection is the cheap half. A
      // heartbeat-based give-up would have to disagree with `reaped`, so if that
      // is ever wanted it belongs in the POOL (a reap timeout), never here.
      const endIfFinished = (): boolean => {
        const cur = getSdkSession(id)
        if (cur && isSdkSessionLive(cur)) return false
        void stream
          .writeSSE({ event: 'end', data: JSON.stringify({ session: cur }) })
          .catch(() => {})
          .finally(() => closeAll())
        return true
      }

      const send = (frame: SdkStreamFrame) => {
        if (closed) return
        void stream
          .writeSSE({ event: 'frame', data: JSON.stringify(frame) })
          .then(() => {
            // Ask after EVERY frame, not only after a terminal status one.
            // Which frame carries the news is not something this route may
            // assume; the previous shape assumed it. Asking is a map lookup and
            // frames here are distilled events, not terminal repaints.
            //
            // ⚠ HONEST SCOPE, MEASURED 2026-08-01 — do not read more into this
            // line than it earns. Reverting THIS ONE HUNK to the old
            // `if (frame.ev.kind === 'status' && terminal)` condition leaves the
            // whole suite GREEN, and that is not a gap in the guards: it is
            // currently unobservable. Every path that sets `reaped` announces it
            // with a terminal STATUS frame (the pump's `finally`, and the
            // spawn-failure path in spawnSdkSession), and no frame at all can be
            // emitted after that one — so today the old condition happens to fire
            // on exactly the same frames. What the widening buys is that the
            // route stops DEPENDING on that fact. The fact itself is pinned next
            // door ("announces the reap even though terminate already wrote the
            // SAME status", which counts frames) — but a route that reads a
            // predicate it can check directly is not the place to spend a
            // cross-module invariant. Cost: one Map.get per distilled event.
            endIfFinished()
          })
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
      // not leave the connection hanging — FINISHED meaning reaped, for the same
      // reason the tail does (above). A tile re-attached while the owner's stop
      // was still unwinding used to be handed an immediate `end` and drew a desk
      // that was still writing files as gone.
      const now = getSdkSession(id)
      if (!now || !isSdkSessionLive(now)) {
        await stream.writeSSE({ event: 'end', data: JSON.stringify({ session: now }) })
        closeAll()
        return
      }

      heartbeat = setInterval(() => {
        if (closed) return
        if (endIfFinished()) return
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
