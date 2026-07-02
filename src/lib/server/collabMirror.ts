// collabMirror — the server-side half of "share × swarm" (bug card c2e4c57c).
//
// PROBLEM: while a project is realtime-collab shared, the Board's authority is
// the collab Y.Doc (CF Durable Object room) — `boardDocToProjectData` takes the
// task list wholesale from the doc. Server-side board writers (PUT /api/project,
// POST /api/project/tasks → swarm-board.sh, the swarm orchestrator's column
// moves) only wrote tasks.json, so the doc never learned about them and every
// client (re)connect REVERTED them — deleted cards resurrected, moves undone
// (observed 2026-07-02: a 23-move cleanup rolled back 2s after app boot).
//
// FIX: mirror every successful server-side board write into the doc. The single
// choke point is projectData.ts (writeProjectData / mutateProjectData both land
// in writeCasGuarded) — it calls queueBoardMirror(path, saved) fire-and-forget
// after each write. The mirror then:
//   1. resolves whether the path IS collab-shared — findOwnProjectIdByPath, the
//      FIND-ONLY lookup (never creates og_projects rows), cached per path with a
//      short TTL. `null` (definitely no row) IS cached; a FAILED lookup
//      (undefined) is NEVER cached and takes the retry path — otherwise one
//      Supabase blip would silently drop a shared project's writes for a whole
//      TTL window (review must-fix #2);
//   2. lazily connects one Y.Doc per project (ticket relay → y-partyserver
//      provider, the same transport the client uses), kept for IDLE_MS after the
//      last write so orchestrator bursts reuse it, then torn down;
//   3. applies a PRESERVING mirror (mirrorBoardPreserving below) — per-field
//      upserts of the disk state whose idempotence (setKey no-ops identical
//      values) is the echo/LOOP guard: the client applying doc→disk re-triggers
//      this hook with identical board content, which emits ZERO doc updates.
//
// WHY a preserving mirror, not boardDoc's authoritative one (review must-fix #1):
// the owner applies doc→disk ONLY while that project's Board tab is the active
// view (BoardModule onRemote → persist). A member's just-added card therefore
// lives ONLY in the doc — often for hours — and a blind full reconcile
// (reconcileCollectionFlat deletes every t:* key absent from disk) would destroy
// it on the next swarm write: data loss, not LWW. So deletions are restricted to
// ids this mirror has PREVIOUSLY seen on disk (a per-project seen-set, persisted
// in the project's central dir so the semantics survive restarts): a card that
// left the disk after being on it = a real deletion → propagated; a doc-only id
// the disk never had = someone else's card → preserved (its order slot too).
// Field-level edits of a card that IS on disk still follow the disk (per-field
// LWW — the documented two-writer semantics, same blast radius as two humans).
//
// FAILURE: never blocks or fails the save (disk write already happened). On a
// mirror error the payload is kept IN MEMORY and retried with backoff, then
// indefinitely at the final cadence — an offline stretch heals on reconnect
// while the process lives, because every mirror is a FULL-state mirror (missed
// intermediates don't matter). A restart drops a pending payload; the NEXT
// server write re-mirrors the full disk state (and the persisted seen-set keeps
// deletion semantics correct across the gap), so the residual exposure is a
// deletion mirrored never-successfully before a restart AND never followed by
// another write — accepted and documented rather than papered over. Enqueues
// are ordered by the write stamp (updatedAt is strictly monotonic per project),
// so a slow canonicalize can never let an OLDER payload overwrite a newer one
// (review must-fix #3).
//
// Node runtime note: Electron 31 forks the server under Node 20, which has NO
// global WebSocket — `ws` is polyfilled in once, lazily, before the first
// connect (bundled by build-server.js; its optional native accelerators stay
// external and fall back to pure JS).

import * as Y from 'yjs'
import { join } from 'path'
import { readFile } from 'fs/promises'
import type { ProjectData, CollabTicketResponse } from '../types'
import {
  BOARD_ROOT,
  TASK_PREFIX,
  K_DESCRIPTION,
  K_DESCRIPTION_JA,
  K_DESCRIPTION_EN,
  K_CONFIG,
  K_NOTES,
  K_ORDER,
} from '../collab/boardDoc'
import { ORIGIN_SEED, setKey } from '../collab/ydoc'
import { connectCollabDoc } from '../collab/provider'
import { canonicalize } from './canonicalize'
import { findOwnProjectIdByPath } from './projectMembers'
import { getFreshAccessToken } from './supabaseAuth'
import { projectDataDir } from './projectDataPath'
import { atomicWriteJson } from './atomicWrite'
import { readCollabWsUrl, roomFor, issueWorkerTicket } from '../../../server/routes/ticket'

/** How long a project's doc connection lingers after the last mirrored write —
 *  long enough that an orchestrator pass's burst of column moves reuses one
 *  connection, short enough that an idle server holds no sockets. */
const IDLE_MS = 60_000
/** Backoff for failed mirrors (connect refused / ticket denied / sync timeout /
 *  pid lookup failure). After the last step it KEEPS retrying at the final
 *  cadence, so an offline stretch heals once connectivity returns. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]
/** How long a resolved pid — or a definite "no row" — is trusted before
 *  re-asking Supabase. Sharing/unsharing is rare; board writes are not. */
const PID_TTL_MS = 60_000
/** Ceiling for the initial doc sync — past this the connect attempt is failed
 *  (and retried by the backoff), so a wedged socket can't pin the queue. */
const SYNC_TIMEOUT_MS = 10_000

export interface MirrorDeps {
  /** Canonicalize a project path to the mirror's cache key (and the pid
   *  lookup's input — the registry stores canonical paths, so they match). */
  canonicalize: (p: string) => Promise<string>
  /** FIND-ONLY collabProjectId lookup. Tri-state (projectMembers contract):
   *  string = shared; null = definitely NOT shared (cacheable); undefined = the
   *  LOOKUP FAILED (never cached — the caller must retry, not conclude). */
  resolvePid: (canonicalPath: string) => Promise<string | null | undefined>
  /** Open a SYNCED Y.Doc for the project's board room. Throws on any failure
   *  (no ticket / connect error / sync timeout). The default impl carries the
   *  whole ticket-relay + provider + WebSocket-polyfill dance. */
  openDoc: (pid: string) => Promise<{ doc: Y.Doc; destroy: () => void }>
  /** Persisted per-project seen-set (ids this mirror has observed on disk) —
   *  what makes "deletion vs someone-else's-card" distinguishable across
   *  restarts. load → null on absence/corruption (= first mirror: delete
   *  nothing); save is best-effort. */
  seenStore: {
    load: (canonicalPath: string) => Promise<string[] | null>
    save: (canonicalPath: string, ids: string[]) => Promise<void>
  }
  idleMs: number
  retryDelaysMs: number[]
  pidTtlMs: number
}

interface MirrorEntry {
  /** The newest not-yet-mirrored payload (coalesced — only the latest full
   *  state matters, every mirror is a full-state mirror). */
  latest: ProjectData | null
  /** Monotonic enqueue guard: the highest updatedAt ever enqueued. A payload
   *  whose stamp is not newer is DROPPED — canonicalize completion order must
   *  never let an older write become `latest` (must-fix #3). */
  lastStamp: string | null
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

export interface BoardMirror {
  /** Queue a mirrored write (fire-and-forget; coalesces bursts). */
  queue: (projectPath: string, saved: ProjectData) => void
  /** Tear down every connection/timer (tests + reload hygiene). */
  reset: () => void
  /** Test hook: resolves when the given project's queue is fully drained
   *  (latest consumed and no drain running); THROWS on timeout so a wedged
   *  drain can't let assertions pass vacuously. */
  settle: (projectPath: string) => Promise<void>
}

/** The preserving mirror write (see the header's WHY). Upserts every disk task
 *  per-field, deletes ONLY (a) stale fields of disk-present cards and (b) whole
 *  cards in `deletable` (= seen on disk before, gone now). Doc-only ids the
 *  disk never had are untouched, and keep their order slots. Idempotent —
 *  identical content emits zero updates (setKey no-ops). */
export const mirrorBoardPreserving = (
  doc: Y.Doc,
  data: ProjectData,
  deletable: ReadonlySet<string>,
): void => {
  const map = doc.getMap<unknown>(BOARD_ROOT)
  doc.transact(() => {
    setKey(map, K_DESCRIPTION, data.description)
    setKey(map, K_DESCRIPTION_JA, data.descriptionJa)
    setKey(map, K_DESCRIPTION_EN, data.descriptionEn)
    setKey(map, K_CONFIG, data.config)
    setKey(map, K_NOTES, data.notes ?? '')

    // Desired flat keys for the DISK cards (same encoding rules as
    // reconcileCollectionFlat: skip unencodable ids, the id field, ':' fields,
    // undefined values).
    const desired = new Map<string, unknown>()
    const diskIds = new Set<string>()
    for (const task of data.tasks ?? []) {
      if (typeof task.id !== 'string' || task.id.includes(':')) continue
      diskIds.add(task.id)
      const obj = task as unknown as Record<string, unknown>
      for (const k of Object.keys(obj)) {
        if (k === 'id' || k.includes(':') || obj[k] === undefined) continue
        desired.set(`${TASK_PREFIX}${task.id}:${k}`, obj[k])
      }
    }
    for (const key of Array.from(map.keys())) {
      if (!key.startsWith(TASK_PREFIX)) continue
      const rest = key.slice(TASK_PREFIX.length)
      const sep = rest.indexOf(':')
      if (sep < 0) continue // malformed key — same skip as readCollectionFlat
      const id = rest.slice(0, sep)
      if (deletable.has(id)) {
        map.delete(key) // a REAL deletion (was on disk, gone now) — propagate
      } else if (diskIds.has(id) && !desired.has(key)) {
        map.delete(key) // stale field of a disk card
      }
      // doc-only id (someone else's card) → untouched
    }
    for (const [k, v] of Array.from(desired)) setKey(map, k, v)

    // Order: disk order first, then every doc-order id we PRESERVED (unknown to
    // disk, not deleted) in its existing relative order — so a member's card
    // keeps a stable slot instead of being dropped from the order (it would
    // still survive via readCollectionFlat's remainder append, but jumping to a
    // sorted tail on every swarm write is gratuitous churn). orderedDisk MUST
    // use the same encodability rule as diskIds (skip ':'-ids): an id in order
    // but not in diskIds would re-enter via keepTail on the NEXT pass and grow
    // m:order (+ emit an update) on every mirror — an unbounded echo loop
    // (review must-fix).
    const docOrder = (map.get(K_ORDER) as string[] | undefined) ?? []
    const orderedDisk = (data.tasks ?? []).map((t) => t.id).filter((id) => diskIds.has(id))
    const keepTail = Array.isArray(docOrder)
      ? docOrder.filter((id) => typeof id === 'string' && !diskIds.has(id) && !deletable.has(id))
      : []
    setKey(map, K_ORDER, [...orderedDisk, ...keepTail])
  }, ORIGIN_SEED)
}

export const createBoardMirror = (deps: MirrorDeps): BoardMirror => {
  const entries = new Map<string, MirrorEntry>()

  const entryFor = (key: string): MirrorEntry => {
    let e = entries.get(key)
    if (!e) {
      e = {
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

  const teardown = (e: MirrorEntry): void => {
    if (e.idleTimer) { clearTimeout(e.idleTimer); e.idleTimer = null }
    if (e.conn) {
      try { e.conn.destroy() } catch { /* best-effort */ }
      e.conn = null
    }
  }

  const armIdle = (e: MirrorEntry): void => {
    if (e.idleTimer) clearTimeout(e.idleTimer)
    e.idleTimer = setTimeout(() => { e.idleTimer = null; teardown(e) }, deps.idleMs)
    ;(e.idleTimer as { unref?: () => void }).unref?.()
  }

  /** Resolve the pid through the TTL cache. A DEFINITE answer (string/null) is
   *  cached; a FAILED lookup (undefined) throws so the caller lands on the
   *  retry path and nothing is cached (must-fix #2). */
  const resolvePidCached = async (e: MirrorEntry, key: string): Promise<string | null> => {
    if (e.pid && Date.now() - e.pid.at < deps.pidTtlMs) return e.pid.value
    const value = await deps.resolvePid(key)
    if (value === undefined) throw new Error('collab pid lookup failed (transient)')
    e.pid = { value, at: Date.now() }
    return value
  }

  /** One full-state mirror. Returns false on failure (caller schedules retry). */
  const mirrorOnce = async (e: MirrorEntry, key: string, data: ProjectData): Promise<boolean> => {
    try {
      const pid = await resolvePidCached(e, key)
      if (pid === null) return true // definitely not shared — nothing to mirror
      if (!e.conn) {
        const conn = await deps.openDoc(pid)
        // reset() may have raced the await — never adopt a connection into an
        // orphaned entry (it would live until the unref'd idle timer fired).
        if (entries.get(key) !== e) {
          try { conn.destroy() } catch { /* best-effort */ }
          return true
        }
        e.conn = conn
      }
      if (e.seen === 'unloaded') {
        e.seen = await deps.seenStore.load(key).then((ids) => (ids ? new Set(ids) : null))
      }
      const diskIds = new Set((data.tasks ?? []).map((t) => t.id))
      // Deletions = ids we have PREVIOUSLY seen on disk that are gone now. On
      // the very first mirror (no persisted seen-set) delete NOTHING — an
      // unknown doc-only id is indistinguishable from a member's new card, and
      // preserving is the safe direction (see header).
      const deletable =
        e.seen instanceof Set
          ? new Set(Array.from(e.seen).filter((id) => !diskIds.has(id)))
          : new Set<string>()
      mirrorBoardPreserving(e.conn.doc, data, deletable)
      e.seen = diskIds
      await deps.seenStore.save(key, Array.from(diskIds)).catch(() => {})
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
    const e = entryFor(key)
    if (e.running) return
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
    queue: (projectPath, saved) => {
      void (async () => {
        try {
          const key = await deps.canonicalize(projectPath)
          const e = entryFor(key)
          // Monotonic enqueue: updatedAt is strictly monotonic per project
          // (nextUpdatedAt), so "not newer" = out-of-order canonicalize
          // completion or a duplicate — drop it, never regress the doc.
          const stamp = typeof saved.updatedAt === 'string' ? saved.updatedAt : null
          if (stamp && e.lastStamp && stamp <= e.lastStamp) return
          if (stamp) e.lastStamp = stamp
          e.latest = saved
          void drain(key)
        } catch {
          /* unregistered/vanished path — nothing to mirror */
        }
      })()
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
    settle: async (projectPath) => {
      const key = await deps.canonicalize(projectPath)
      for (let i = 0; i < 200; i++) {
        const e = entries.get(key)
        if (!e || (!e.latest && !e.running)) return
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error('collabMirror.settle: drain did not settle within 2s')
    },
  }
}

// ── Real deps ─────────────────────────────────────────────────────────────────

/** Polyfill the global WebSocket once for Node < 22 (Electron 31 forks the
 *  server under Node 20). partysocket + y-partyserver read the GLOBAL — passing
 *  only options.WebSocketPolyfill isn't enough (bare `WebSocket.OPEN` references
 *  remain) — so install `ws` globally when absent. */
const ensureWebSocket = async (): Promise<void> => {
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket !== 'undefined') return
  const wsMod = (await import('ws')) as unknown as { WebSocket: unknown; default?: unknown }
  ;(globalThis as { WebSocket?: unknown }).WebSocket = wsMod.WebSocket ?? wsMod.default
}

const realOpenDoc = async (pid: string): Promise<{ doc: Y.Doc; destroy: () => void }> => {
  const wsUrl = readCollabWsUrl()
  if (!wsUrl) throw new Error('collab ws url unset')
  const mint = async (): Promise<CollabTicketResponse | null> => {
    const token = await getFreshAccessToken()
    if (!token) return null
    const relay = await issueWorkerTicket(wsUrl, token, pid, 'board')
    if (!relay.ok) return null
    return { wsUrl, room: roomFor(pid, 'board'), token: relay.ticket.token, expiresAt: relay.ticket.expiresAt }
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

// The persisted seen-set sidecar (ids this mirror has observed on disk), one
// small JSON per project in its central data dir — NOT inside the repo.
const SEEN_FILE = 'collab-mirror-seen.json'
const realSeenStore: MirrorDeps['seenStore'] = {
  load: async (canonicalPath) => {
    try {
      const dir = await projectDataDir(canonicalPath)
      const raw = JSON.parse(await readFile(join(dir, SEEN_FILE), 'utf8')) as { ids?: unknown }
      return Array.isArray(raw.ids) ? raw.ids.filter((x): x is string => typeof x === 'string') : null
    } catch {
      return null // absent/corrupt → first-mirror semantics (delete nothing)
    }
  },
  save: async (canonicalPath, ids) => {
    const dir = await projectDataDir(canonicalPath)
    await atomicWriteJson(join(dir, SEEN_FILE), { ids })
  },
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_collab_mirror: BoardMirror | undefined
}

/** The process-wide mirror (globalThis so `tsx watch` reloads keep one set of
 *  connections instead of stacking). All real board writes route through here
 *  via projectData.ts. */
export const queueBoardMirror = (projectPath: string, saved: ProjectData): void => {
  const mirror =
    globalThis.__openground_collab_mirror ??
    (globalThis.__openground_collab_mirror = createBoardMirror({
      canonicalize,
      resolvePid: findOwnProjectIdByPath,
      openDoc: realOpenDoc,
      seenStore: realSeenStore,
      idleMs: IDLE_MS,
      retryDelaysMs: RETRY_DELAYS_MS,
      pidTtlMs: PID_TTL_MS,
    }))
  mirror.queue(projectPath, saved)
}