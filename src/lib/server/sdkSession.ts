// sdkSession — the Agent SDK session pool. The SDK-side sibling of terminal.ts.
//
// One entry is one running `claude` driven through the Agent SDK: an input
// queue we push turns into, a ring buffer of distilled {@link SdkEvent}s the UI
// and the engine read, and a status the engine steers on.
//
// WHY A POOL AND NOT A PROMISE. The engine outlives any one turn: it dispatches
// a worker, walks away, and comes back on the next monitor tick to ask how it
// is doing. That is the same shape terminal.ts serves for PTYs, so this mirrors
// its contracts deliberately — including keeping state on `globalThis` so a
// `tsx watch` reload in dev does not orphan live sessions (CLAUDE.md records
// that pattern as the rule for any new in-memory server state).
//
// TESTABILITY IS A REQUIREMENT, NOT A NICETY. `queryFn` is injected. Nothing in
// the unit suite may spawn a real `claude`: besides being slow and quota-hungry,
// an isolated HOME cannot even authenticate (measured — migration plan appendix
// B-6), so a "real" test would either touch the owner's own session state or
// fail for the wrong reason. Live behaviour is pinned by the probes in
// scripts/probe-sdk-*.mts instead.
//
// See docs/SDK_WORKER_MIGRATION_PLAN.md §3.1 / §6.

import { randomUUID } from 'crypto'
import { resolve as pathResolve } from 'path'
import { distillSdkMessage, statusAfter, type SdkEvent, type SdkSessionStatus } from './sdkEvents'

// ── injected shapes ─────────────────────────────────────────────────────────
// Structural, not imported from the SDK: the pool must be constructible in a
// test with a hand-rolled async generator and no SDK types in sight.

/** What `query()` returns: an async iterable of raw messages, plus controls. */
export interface SdkQueryHandle extends AsyncIterable<unknown> {
  interrupt?: () => Promise<unknown>
}

export interface SdkQueryParams {
  prompt: AsyncIterable<unknown>
  options: Record<string, unknown>
}

export type SdkQueryFn = (params: SdkQueryParams) => SdkQueryHandle

/** Which OPEN GROUND role a session carries. The pool is otherwise anonymous,
 *  and "is a commander desk alive in this project?" must be answerable from the
 *  POOL rather than from a store any spawn can overwrite — that is the exact
 *  desync that produced eleven PTY commander desks in three hours (swarmManager
 *  `adoptLiveDesk`). A pool cannot desynchronise from itself, so the SDK pool
 *  has to be able to answer the same question the PTY pool answers via
 *  `TerminalInfo.deskLabel`. */
export type SdkSessionRole = 'worker' | 'manager' | 'supply'

export interface SpawnSdkSessionOpts {
  /** Working directory the session runs in (a worker's worktree). */
  cwd: string
  /** What this session IS, for pool queries (see {@link SdkSessionRole}). */
  role?: SdkSessionRole
  /** The CLAUDE session id this session drives (`sessionId`/`resume` in the SDK
   *  options). Distinct from the pool id: the pool id addresses the session in
   *  OG's own API surface, this one addresses the CONVERSATION on disk and is
   *  what swarmSessions persists so a restart can resume it. */
  agentSessionId?: string
  /** Options handed to `query()` verbatim. Built by the caller (swarmWorkerSdk
   *  for a worker) so this module owns no policy — not permissions, not the
   *  guard, not the model. */
  options: Record<string, unknown>
  /** First turn, sent as soon as the session starts. Omit for a session the
   *  caller will drive with {@link pushSdkInput}. */
  initialPrompt?: string
  /** Injected for tests; defaults to the real SDK `query`. */
  queryFn?: SdkQueryFn
  /** Injected id (tests / deterministic resume). Defaults to a fresh uuid. */
  id?: string
}

export interface SdkSessionInfo {
  id: string
  cwd: string
  role?: SdkSessionRole
  agentSessionId?: string
  status: SdkSessionStatus
  startedAt: number
  /** Wall-clock of the newest event — the liveness signal that replaces
   *  guessing from a heartbeat file's mtime. */
  lastEventAt: number
  /** Why the session ended, once it has. */
  exitReason?: string
  /** Highest sequence number emitted so far. */
  seq: number
}

export interface SdkStreamFrame {
  seq: number
  ev: SdkEvent
}

type Listener = (frame: SdkStreamFrame) => void

interface Entry {
  id: string
  cwd: string
  role?: SdkSessionRole
  agentSessionId?: string
  status: SdkSessionStatus
  startedAt: number
  lastEventAt: number
  exitReason?: string
  seq: number
  /** Ring buffer. Bounded so a long-lived worker cannot grow without limit;
   *  a reader that has fallen further behind than this is told so rather than
   *  being served a silently incomplete history. */
  buffer: SdkStreamFrame[]
  /** True once the buffer has dropped at least one frame. */
  truncated: boolean
  listeners: Set<Listener>
  /** Pending turns waiting to be yielded into the SDK. */
  queue: string[]
  /** Parked resolver of the input generator, when it is waiting. */
  wake: ((text: string | null) => void) | null
  closed: boolean
  handle: SdkQueryHandle | null
}

const RING_CAPACITY = 4096

// Survive `tsx watch` reloads, exactly like the PTY pool.
interface PoolShape {
  sessions: Map<string, Entry>
}
const g = globalThis as unknown as { __openground_sdk_sessions?: PoolShape }
const pool: PoolShape = (g.__openground_sdk_sessions ??= { sessions: new Map() })

// The SDK's own refusal vocabulary, loaded lazily so importing this module
// never requires the SDK to be resolvable (tests inject queryFn and may run in
// an environment without it). Falls back to an EMPTY list — which makes
// quota detection silent rather than wrong; a private copy of Anthropic's
// wording is the thing sdkEvents exists to avoid.
let cachedPrefixes: readonly string[] | null = null
const quotaPrefixes = (): readonly string[] => {
  if (cachedPrefixes) return cachedPrefixes
  try {

    const sdk = require('@anthropic-ai/claude-agent-sdk') as { USAGE_LIMIT_ERROR_PREFIXES?: string[] }
    cachedPrefixes = sdk.USAGE_LIMIT_ERROR_PREFIXES ?? []
  } catch {
    cachedPrefixes = []
  }
  return cachedPrefixes
}
/** Test seam: pin the prefix list without loading the SDK. */
export const __setQuotaPrefixesForTests = (p: readonly string[] | null): void => {
  cachedPrefixes = p
}

const emit = (e: Entry, ev: SdkEvent): void => {
  e.seq += 1
  const frame: SdkStreamFrame = { seq: e.seq, ev }
  e.buffer.push(frame)
  if (e.buffer.length > RING_CAPACITY) {
    e.buffer.shift()
    e.truncated = true
  }
  e.lastEventAt = Date.now()
  // forEach, not for..of: tsconfig sets no `target` (⇒ ES5), where iterating an
  // iterator is a TS2802 — the same trap swarmOrchestrator's exec-loop records.
  e.listeners.forEach((l) => {
    try {
      l(frame)
    } catch {
      // A broken listener (a disconnected SSE write) must never take down the
      // pump — the session keeps running and the listener is simply noisy.
    }
  })
}

const setStatus = (e: Entry, status: SdkSessionStatus, detail?: string): void => {
  if (e.status === status) return
  e.status = status
  emit(e, { kind: 'status', status, ...(detail ? { detail } : {}) })
}

const makeInputIterable = (e: Entry): AsyncIterable<unknown> => ({
  async *[Symbol.asyncIterator]() {
    for (;;) {
      let text: string | null
      if (e.queue.length) text = e.queue.shift()!
      else if (e.closed) return
      else text = await new Promise<string | null>((res) => (e.wake = res))
      if (text === null) return
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
        parent_tool_use_id: null,
        session_id: '',
      }
    }
  },
})

/** Drain the SDK's output into the ring buffer until it ends. */
const pump = async (e: Entry): Promise<void> => {
  const prefixes = quotaPrefixes()
  let sawAbort = false
  try {
    for await (const msg of e.handle!) {
      if (e.status === 'starting') setStatus(e, 'working')
      for (const ev of distillSdkMessage(msg, prefixes)) {
        emit(e, ev)
        if (ev.kind === 'turn_end' && ev.reason === 'aborted_streaming') sawAbort = true
        const next = statusAfter(ev)
        if (next) setStatus(e, next)
      }
    }
    e.exitReason = 'completed'
  } catch (err) {
    // An `interrupt()` makes the iterator THROW after the aborted turn's result
    // has already been delivered (measured 2026-07-30 — the `[ede_diagnostic]`
    // message). That is a normal stop, not a failure, and the distinguishing
    // evidence is the turn_end we already saw — never the exception text.
    e.exitReason = sawAbort ? 'interrupted' : `error: ${String((err as Error)?.message ?? err).slice(0, 200)}`
  } finally {
    e.closed = true
    if (e.wake) {
      const w = e.wake
      e.wake = null
      w(null)
    }
    setStatus(e, e.exitReason && e.exitReason.startsWith('error:') ? 'failed' : 'exited', e.exitReason)
  }
}

export const spawnSdkSession = (opts: SpawnSdkSessionOpts): SdkSessionInfo => {
  const id = opts.id ?? randomUUID()
  const now = Date.now()
  const e: Entry = {
    id,
    cwd: opts.cwd,
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.agentSessionId ? { agentSessionId: opts.agentSessionId } : {}),
    status: 'starting',
    startedAt: now,
    lastEventAt: now,
    seq: 0,
    buffer: [],
    truncated: false,
    listeners: new Set(),
    queue: [],
    wake: null,
    closed: false,
    handle: null,
  }
  pool.sessions.set(id, e)

  if (opts.initialPrompt) e.queue.push(opts.initialPrompt)

  const queryFn: SdkQueryFn =
    opts.queryFn ??
    ((params) => {

      const sdk = require('@anthropic-ai/claude-agent-sdk') as { query: SdkQueryFn }
      return sdk.query(params)
    })

  try {
    e.handle = queryFn({ prompt: makeInputIterable(e), options: opts.options })
  } catch (err) {
    e.closed = true
    e.exitReason = `spawn failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`
    setStatus(e, 'failed', e.exitReason)
    return snapshot(e)
  }

  void pump(e)
  return snapshot(e)
}

const snapshot = (e: Entry): SdkSessionInfo => ({
  id: e.id,
  cwd: e.cwd,
  ...(e.role ? { role: e.role } : {}),
  ...(e.agentSessionId ? { agentSessionId: e.agentSessionId } : {}),
  status: e.status,
  startedAt: e.startedAt,
  lastEventAt: e.lastEventAt,
  ...(e.exitReason ? { exitReason: e.exitReason } : {}),
  seq: e.seq,
})

export const getSdkSession = (id: string): SdkSessionInfo | null => {
  const e = pool.sessions.get(id)
  return e ? snapshot(e) : null
}

export const listSdkSessions = (): SdkSessionInfo[] => {
  // forEach for the same ES5-target reason as emit().
  const out: SdkSessionInfo[] = []
  pool.sessions.forEach((e) => out.push(snapshot(e)))
  return out
}

/** Is the session still able to do work? (Liveness only.) */
export const isSdkSessionAlive = (id: string): boolean => {
  const e = pool.sessions.get(id)
  return !!e && e.status !== 'exited' && e.status !== 'failed'
}

/** Every LIVE session of `role` whose cwd is `cwd` — the SDK counterpart of
 *  terminal.ts's `listLiveDesksIn`, and the authority for "does this project
 *  already have a commander desk?".
 *
 *  Paths are compared RESOLVED, exactly as the PTY side compares them, so a
 *  symlinked or trailing-slash spelling of the same directory can never look
 *  like a different project and earn itself a second desk. */
export const listSdkSessionsIn = (cwd: string, role: SdkSessionRole): SdkSessionInfo[] => {
  const want = pathResolve(cwd)
  const out: SdkSessionInfo[] = []
  pool.sessions.forEach((e) => {
    if (e.role !== role) return
    if (e.status === 'exited' || e.status === 'failed') return
    if (pathResolve(e.cwd) !== want) return
    out.push(snapshot(e))
  })
  return out
}

/** Queue one turn. Returns false when the session is gone or already finished.
 *
 *  Mid-turn is FINE: a message pushed while the model is generating is queued
 *  by the CLI and handled when the current turn ends (measured 2026-07-30 —
 *  migration plan appendix B-3). That is what lets the engine inject a rework
 *  instruction without the bracketed-paste + screen-re-read dance the PTY path
 *  needs to confirm the text ever landed. */
export const pushSdkInput = (id: string, text: string): boolean => {
  const e = pool.sessions.get(id)
  if (!e || e.closed) return false
  if (e.status === 'waiting' || e.status === 'quota-parked') setStatus(e, 'working')
  if (e.wake) {
    const w = e.wake
    e.wake = null
    w(text)
  } else {
    e.queue.push(text)
  }
  return true
}

/** Stop the CURRENT turn but keep the session usable (the graceful stop the PTY
 *  path never had — there, stopping a worker meant killing it). */
export const interruptSdkSession = async (id: string): Promise<boolean> => {
  const e = pool.sessions.get(id)
  if (!e || e.closed || !e.handle?.interrupt) return false
  try {
    await e.handle.interrupt()
    return true
  } catch {
    // The interrupt path is inherently racy (the turn may have just ended).
    // A failed interrupt is not a failed session.
    return false
  }
}

/** End the session. Idempotent — the engine stops workers defensively on paths
 *  where the process may already be gone. */
export const terminateSdkSession = (id: string): boolean => {
  const e = pool.sessions.get(id)
  if (!e) return false
  if (!e.closed) {
    e.closed = true
    if (e.wake) {
      const w = e.wake
      e.wake = null
      w(null)
    }
    void e.handle?.interrupt?.().catch(() => {})
    e.exitReason ??= 'terminated'
    setStatus(e, 'exited', e.exitReason)
  }
  return true
}

/** Drop a finished session from the pool. Live sessions are never dropped —
 *  terminate first. */
export const removeSdkSession = (id: string): boolean => {
  const e = pool.sessions.get(id)
  if (!e || !e.closed) return false
  pool.sessions.delete(id)
  return true
}

export interface AttachResult {
  /** Frames from `fromSeq` (exclusive) that are still in the buffer. */
  replay: SdkStreamFrame[]
  /** True when frames older than `replay[0]` have been dropped — the reader is
   *  looking at an incomplete history and must be told, not quietly served. */
  truncated: boolean
  detach: () => void
}

/** Subscribe to a session's events, replaying what the buffer still holds. */
export const attachSdkListener = (
  id: string,
  fromSeq: number,
  cb: Listener,
): AttachResult | null => {
  const e = pool.sessions.get(id)
  if (!e) return null
  const replay = e.buffer.filter((f) => f.seq > fromSeq)
  const oldest = e.buffer.length ? e.buffer[0].seq : e.seq + 1
  const missed = e.truncated && oldest > fromSeq + 1
  e.listeners.add(cb)
  return {
    replay,
    truncated: missed,
    detach: () => {
      e.listeners.delete(cb)
    },
  }
}

/** Test seam: forget every session. Never call from server code. */
export const __resetSdkSessionsForTests = (): void => {
  pool.sessions.clear()
}
