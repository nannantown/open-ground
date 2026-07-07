// collabMirrorCore — the scope-agnostic skeleton of the server-side collab
// mirror (bug c2e4c57c and its canvas twin).
//
// PROBLEM (both scopes): while a project is realtime-collab shared, the collab
// Y.Doc (CF Durable Object room) is the authority for that scope's shared
// state. Server-side writers (swarm board moves, Canvas AI job completions,
// renames) only wrote the disk store, so the doc never learned about them and
// every client (re)connect REVERTED them. The fix is to mirror every successful
// server-side write into the doc.
//
// This module holds everything that is IDENTICAL between the board mirror
// (collabMirror.ts, one 'board' room per project) and the canvas mirror
// (canvasCollabMirror.ts, one 'canvas:<id>' room per canvas):
//   1. pid resolution — findOwnProjectIdByPath's tri-state contract (string =
//      shared / null = definitely-not cacheable / undefined = lookup FAILED,
//      never cached, retried) behind a short TTL cache per entry;
//   2. one lazily-opened Y.Doc connection per entry (ticket relay →
//      y-partyserver provider — the same transport the client uses), kept for
//      idleMs after the last write so write bursts reuse it, then torn down;
//   3. the drain loop: coalescing queue (only the LATEST full state matters),
//      monotonic enqueue stamps (an out-of-order canonicalize completion can
//      never let an older payload overwrite a newer one), retry with backoff
//      that never stops at the final cadence, reset/settle hygiene;
//   4. the persisted seen-set bookkeeping that makes the PRESERVING mirror's
//      deletion semantics survive restarts (ids previously seen on disk are
//      deletable when gone; unknown doc-only ids are someone else's work and
//      preserved).
// What differs per scope — the payload type, its id set, the preserving write
// primitive, the room sub-scope, and where the seen-set sidecar lives — is
// injected through CoreMirrorDeps. The WHY of every rule above is documented
// at length in collabMirror.ts's header; this module keeps the machinery.
//
// FAILURE MODEL (shared): never blocks or fails the disk save (it already
// happened). On a mirror error the payload is kept IN MEMORY and retried with
// backoff, then indefinitely at the final cadence — an offline stretch heals on
// reconnect while the process lives, because every mirror is a FULL-state
// mirror (missed intermediates don't matter). A restart drops a pending
// payload; the NEXT server write re-mirrors the full disk state (and the
// persisted seen-set keeps deletion semantics correct across the gap).

import * as Y from 'yjs'
import type { CollabTicketResponse, DocScope } from '../types'
import { connectCollabDoc } from '../collab/provider'
import { getFreshAccessToken } from './supabaseAuth'
import { readCollabWsUrl, roomFor, issueWorkerTicket } from '../../../server/routes/ticket'

/** Ceiling for the initial doc sync — past this the connect attempt is failed
 *  (and retried by the backoff), so a wedged socket can't pin the queue. */
const SYNC_TIMEOUT_MS = 10_000

export interface CoreMirrorDeps<P> {
  /** Canonicalize a project path to the entry key's path part (and the pid
   *  lookup's input — the registry stores canonical paths, so they match). */
  canonicalize: (p: string) => Promise<string>
  /** FIND-ONLY collabProjectId lookup. Tri-state (projectMembers contract):
   *  string = shared; null = definitely NOT shared (cacheable); undefined = the
   *  LOOKUP FAILED (never cached — the caller must retry, not conclude). */
  resolvePid: (canonicalPath: string) => Promise<string | null | undefined>
  /** Open a SYNCED Y.Doc for (pid, sub). `sub` is the per-entry sub-scope
   *  discriminator: '' for the board (one room per project), the canvasId for
   *  canvas scopes (one room per canvas). Throws on any failure (no ticket /
   *  connect error / sync timeout). */
  openDoc: (pid: string, sub: string) => Promise<{ doc: Y.Doc; destroy: () => void }>
  /** Persisted per-entry seen-set (ids this mirror has observed on disk) —
   *  what makes "deletion vs someone-else's-item" distinguishable across
   *  restarts. load → null on absence/corruption (= first mirror: delete
   *  nothing); save is best-effort. */
  seenStore: {
    load: (canonicalPath: string, sub: string) => Promise<string[] | null>
    save: (canonicalPath: string, sub: string, ids: string[]) => Promise<void>
  }
  /** The payload's on-disk id set (deletion bookkeeping — RAW ids, no
   *  encodability filtering; the write primitive applies its own). */
  idsOf: (payload: P) => string[]
  /** The scope's preserving write primitive. Must be idempotent (identical
   *  content emits zero updates) — that is the echo/loop guard. */
  applyMirror: (doc: Y.Doc, payload: P, deletable: ReadonlySet<string>) => void
  idleMs: number
  retryDelaysMs: number[]
  pidTtlMs: number
}

interface MirrorEntry<P> {
  canonicalPath: string
  sub: string
  /** The newest not-yet-mirrored payload (coalesced — only the latest full
   *  state matters, every mirror is a full-state mirror). */
  latest: P | null
  /** Monotonic enqueue guard: the highest stamp ever enqueued. A payload whose
   *  stamp is not newer is DROPPED — canonicalize completion order must never
   *  let an older write become `latest`. */
  lastStamp: string | number | null
  /** A drain loop is currently running for this entry. */
  running: boolean
  conn: { doc: Y.Doc; destroy: () => void } | null
  idleTimer: ReturnType<typeof setTimeout> | null
  retryTimer: ReturnType<typeof setTimeout> | null
  failures: number
  pid: { value: string | null; at: number } | null
  /** Ids previously seen on disk ('unloaded' until the seenStore is read). */
  seen: Set<string> | null | 'unloaded'
}

export interface CollabMirror<P> {
  /** Queue a mirrored write (fire-and-forget; coalesces bursts). `stamp` is the
   *  caller's monotonic write ordinal (null = no ordering guard). */
  queue: (projectPath: string, sub: string, payload: P, stamp: string | number | null) => void
  /** Drop ONE entry entirely — connection, timers, pending payload, and (most
   *  importantly) the in-memory seen-set. The deletion cascade's in-memory
   *  half: when the entity behind (path, sub) is deleted, a later re-creation
   *  of the SAME sub (the canvas ghost-upsert door) must build a FRESH entry
   *  with cold-start seen semantics (delete nothing) — a surviving entry's
   *  stale seen-set would turn the ghost's first mirror into deletions of
   *  elements a member may still be viewing. No-op for an unknown entry. */
  forget: (projectPath: string, sub: string) => Promise<void>
  /** Tear down every connection/timer (tests + reload hygiene). */
  reset: () => void
  /** Test hook: resolves when the given entry's queue is fully drained (latest
   *  consumed and no drain running); THROWS on timeout so a wedged drain can't
   *  let assertions pass vacuously. */
  settle: (projectPath: string, sub: string) => Promise<void>
}

/** Stamps are homogeneous per mirror (the board uses updatedAt strings, the
 *  canvas a process-local counter) — a cross-type comparison never happens in
 *  practice and is treated as "not stale" (fail open: mirror rather than drop). */
const isStale = (stamp: string | number | null, last: string | number | null): boolean => {
  if (stamp === null || last === null) return false
  if (typeof stamp === 'string' && typeof last === 'string') return stamp <= last
  if (typeof stamp === 'number' && typeof last === 'number') return stamp <= last
  return false
}

// '\u0000' never appears in a filesystem path or an id, so the composite key
// can't collide across (path, sub) pairs.
const entryKey = (canonicalPath: string, sub: string): string => `${canonicalPath}\u0000${sub}`

export const createCollabMirror = <P>(deps: CoreMirrorDeps<P>): CollabMirror<P> => {
  const entries = new Map<string, MirrorEntry<P>>()

  const entryFor = (key: string, canonicalPath: string, sub: string): MirrorEntry<P> => {
    let e = entries.get(key)
    if (!e) {
      e = {
        canonicalPath,
        sub,
        latest: null,
        lastStamp: null,
        running: false,
        conn: null,
        idleTimer: null,
        retryTimer: null,
        failures: 0,
        pid: null,
        seen: 'unloaded',
      }
      entries.set(key, e)
    }
    return e
  }

  const teardown = (e: MirrorEntry<P>): void => {
    if (e.idleTimer) { clearTimeout(e.idleTimer); e.idleTimer = null }
    if (e.conn) {
      try { e.conn.destroy() } catch { /* best-effort */ }
      e.conn = null
    }
  }

  const armIdle = (e: MirrorEntry<P>): void => {
    if (e.idleTimer) clearTimeout(e.idleTimer)
    e.idleTimer = setTimeout(() => { e.idleTimer = null; teardown(e) }, deps.idleMs)
    ;(e.idleTimer as { unref?: () => void }).unref?.()
  }

  /** Resolve the pid through the TTL cache. A DEFINITE answer (string/null) is
   *  cached; a FAILED lookup (undefined) throws so the caller lands on the
   *  retry path and nothing is cached. */
  const resolvePidCached = async (e: MirrorEntry<P>): Promise<string | null> => {
    if (e.pid && Date.now() - e.pid.at < deps.pidTtlMs) return e.pid.value
    const value = await deps.resolvePid(e.canonicalPath)
    if (value === undefined) throw new Error('collab pid lookup failed (transient)')
    e.pid = { value, at: Date.now() }
    return value
  }

  /** One full-state mirror. Returns false on failure (caller schedules retry). */
  const mirrorOnce = async (e: MirrorEntry<P>, key: string, data: P): Promise<boolean> => {
    try {
      const pid = await resolvePidCached(e)
      if (pid === null) return true // definitely not shared — nothing to mirror
      if (!e.conn) {
        const conn = await deps.openDoc(pid, e.sub)
        // reset() may have raced the await — never adopt a connection into an
        // orphaned entry (it would live until the unref'd idle timer fired).
        if (entries.get(key) !== e) {
          try { conn.destroy() } catch { /* best-effort */ }
          return true
        }
        e.conn = conn
      }
      if (e.seen === 'unloaded') {
        e.seen = await deps.seenStore
          .load(e.canonicalPath, e.sub)
          .then((ids) => (ids ? new Set(ids) : null))
      }
      const diskIds = new Set(deps.idsOf(data))
      // Deletions = ids we have PREVIOUSLY seen on disk that are gone now. On
      // the very first mirror (no persisted seen-set) delete NOTHING — an
      // unknown doc-only id is indistinguishable from a member's new item, and
      // preserving is the safe direction.
      const deletable =
        e.seen instanceof Set
          ? new Set(Array.from(e.seen).filter((id) => !diskIds.has(id)))
          : new Set<string>()
      deps.applyMirror(e.conn.doc, data, deletable)
      e.seen = diskIds
      // Liveness guard (same shape as the conn-adoption guard above): a
      // forget()/reset() may have raced the awaits in this function. Persisting
      // the seen-set for a dropped entry would RESURRECT the sidecar the
      // deletion cascade just removed — and arm the ghost-upsert door's next
      // mirror with stale deletables. The doc write above is fine (it is the
      // pre-deletion payload flushing into a room nobody routes to anymore);
      // the persisted bookkeeping must not outlive the entry.
      if (entries.get(key) === e) {
        await deps.seenStore.save(e.canonicalPath, e.sub, Array.from(diskIds)).catch(() => {})
      }
      return true
    } catch (err) {
      console.error(
        '[openground:collab-mirror] mirror failed',
        err instanceof Error ? err.message : err,
      )
      teardown(e) // a broken socket must not be reused
      return false
    }
  }

  const drain = async (key: string): Promise<void> => {
    const e = entries.get(key)
    if (!e || e.running) return
    e.running = true
    try {
      while (e.latest) {
        const data = e.latest
        e.latest = null
        const ok = await mirrorOnce(e, key, data)
        if (ok) {
          e.failures = 0
          continue
        }
        // Failure: keep the newest payload (a newer write may have landed while
        // we were failing — that one wins) and back off.
        e.latest = e.latest ?? data
        const delay = deps.retryDelaysMs[Math.min(e.failures, deps.retryDelaysMs.length - 1)]
        e.failures += 1
        if (entries.get(key) !== e) break // reset() raced us — don't resurrect
        if (e.retryTimer) clearTimeout(e.retryTimer)
        e.retryTimer = setTimeout(() => { e.retryTimer = null; void drain(key) }, delay)
        ;(e.retryTimer as { unref?: () => void }).unref?.()
        break
      }
    } finally {
      e.running = false
      if (e.conn) armIdle(e)
      // Close the enqueue/exit race: a queue() that observed running=true right
      // as this loop drained its last payload would otherwise strand its write
      // until the NEXT one. Re-kick when anything arrived after the loop's last
      // e.latest check (skip while a retry is already scheduled — backoff owns it).
      if (e.latest && !e.retryTimer && entries.get(key) === e) void drain(key)
    }
  }

  return {
    queue: (projectPath, sub, payload, stamp) => {
      void (async () => {
        try {
          const canonicalPath = await deps.canonicalize(projectPath)
          const key = entryKey(canonicalPath, sub)
          const e = entryFor(key, canonicalPath, sub)
          // Monotonic enqueue: "not newer" = out-of-order canonicalize
          // completion or a duplicate — drop it, never regress the doc.
          if (isStale(stamp, e.lastStamp)) return
          if (stamp !== null) e.lastStamp = stamp
          e.latest = payload
          void drain(key)
        } catch {
          /* unregistered/vanished path — nothing to mirror */
        }
      })()
    },
    forget: async (projectPath, sub) => {
      const key = entryKey(await deps.canonicalize(projectPath), sub)
      const e = entries.get(key)
      if (!e) return
      if (e.retryTimer) clearTimeout(e.retryTimer)
      e.retryTimer = null
      e.latest = null
      teardown(e)
      // Removing the entry is what flips every liveness guard (conn adoption,
      // seen save, drain re-kick, retry resurrection) for any in-flight drain
      // still holding `e` — the same mechanism reset() relies on, scoped to one
      // entry.
      entries.delete(key)
    },
    reset: () => {
      for (const e of Array.from(entries.values())) {
        if (e.retryTimer) clearTimeout(e.retryTimer)
        e.retryTimer = null
        e.latest = null
        teardown(e)
      }
      entries.clear()
    },
    settle: async (projectPath, sub) => {
      const key = entryKey(await deps.canonicalize(projectPath), sub)
      for (let i = 0; i < 200; i++) {
        const e = entries.get(key)
        if (!e || (!e.latest && !e.running)) return
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error('collabMirror.settle: drain did not settle within 2s')
    },
  }
}

// ── Real transport (shared by both scopes) ───────────────────────────────────

/** Polyfill the global WebSocket once for Node < 22 (Electron 31 forks the
 *  server under Node 20). partysocket + y-partyserver read the GLOBAL — passing
 *  only options.WebSocketPolyfill isn't enough (bare `WebSocket.OPEN` references
 *  remain) — so install `ws` globally when absent. */
const ensureWebSocket = async (): Promise<void> => {
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined') return
  const wsMod = (await import('ws')) as unknown as { WebSocket: unknown; default?: unknown }
  ;(globalThis as { WebSocket?: unknown }).WebSocket = wsMod.WebSocket ?? wsMod.default
}

/** Open a SYNCED Y.Doc for (pid, scope) over the real ticket-relay transport —
 *  the whole ticket + provider + WebSocket-polyfill dance, shared by the board
 *  mirror (scope 'board') and the canvas mirror (scope 'canvas:<id>'). */
export const openScopedDoc = async (
  pid: string,
  scope: DocScope,
): Promise<{ doc: Y.Doc; destroy: () => void }> => {
  const wsUrl = readCollabWsUrl()
  if (!wsUrl) throw new Error('collab ws url unset')
  const mint = async (): Promise<CollabTicketResponse | null> => {
    const token = await getFreshAccessToken()
    if (!token) return null
    const relay = await issueWorkerTicket(wsUrl, token, pid, scope)
    if (!relay.ok) return null
    return { wsUrl, room: roomFor(pid, scope), token: relay.ticket.token, expiresAt: relay.ticket.expiresAt }
  }
  const first = await mint()
  if (!first) throw new Error('collab ticket unavailable')
  await ensureWebSocket()
  const doc = new Y.Doc()
  const conn = await connectCollabDoc(doc, first, async () => (await mint())?.token ?? null)
  // Wait for the initial sync so the mirror never writes into a doc it hasn't
  // seen (a blind write into an unsynced doc would look like an independent
  // seed). synced flips even for an empty room.
  const t0 = Date.now()
  while (Date.now() - t0 < SYNC_TIMEOUT_MS) {
    if ((conn.provider as { synced?: boolean }).synced) {
      return { doc, destroy: () => { conn.destroy(); doc.destroy() } }
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  conn.destroy()
  doc.destroy()
  throw new Error('collab doc sync timeout')
}
