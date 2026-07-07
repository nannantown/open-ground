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
// MACHINERY: the scope-agnostic skeleton (entry/queue/drain/retry, tri-state pid
// cache, seen-set bookkeeping, the real ticket-relay transport incl. the Node 20
// WebSocket polyfill) lives in collabMirrorCore.ts, shared with the CANVAS
// mirror (canvasCollabMirror.ts — same bug class, scope 'canvas:<id>'). This
// module keeps the board-specific parts: the preserving write primitive, the
// per-project seen-set sidecar, and the public queueBoardMirror API.

import * as Y from 'yjs'
import { join } from 'path'
import { readFile } from 'fs/promises'
import type { ProjectData } from '../types'
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
import { createCollabMirror, openScopedDoc } from './collabMirrorCore'
import { canonicalize } from './canonicalize'
import { findOwnProjectIdByPath } from './projectMembers'
import { projectDataDir } from './projectDataPath'
import { atomicWriteJson } from './atomicWrite'

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

/** Board-flavoured assembly of the generic mirror core: the payload is a whole
 *  ProjectData, ids are the task ids, the room sub-scope is '' (one board room
 *  per project), and the enqueue stamp is updatedAt (strictly monotonic per
 *  project — nextUpdatedAt). The public deps shape predates the core split and
 *  is preserved verbatim (tests build against it). */
export const createBoardMirror = (deps: MirrorDeps): BoardMirror => {
  const core = createCollabMirror<ProjectData>({
    canonicalize: deps.canonicalize,
    resolvePid: deps.resolvePid,
    openDoc: (pid, _sub) => deps.openDoc(pid),
    seenStore: {
      load: (canonicalPath, _sub) => deps.seenStore.load(canonicalPath),
      save: (canonicalPath, _sub, ids) => deps.seenStore.save(canonicalPath, ids),
    },
    idsOf: (data) => (data.tasks ?? []).map((t) => t.id),
    applyMirror: mirrorBoardPreserving,
    idleMs: deps.idleMs,
    retryDelaysMs: deps.retryDelaysMs,
    pidTtlMs: deps.pidTtlMs,
  })
  return {
    queue: (projectPath, saved) =>
      core.queue(
        projectPath,
        '',
        saved,
        // '' maps to null (no ordering guard) — the pre-core queue guard was
        // `stamp && lastStamp && …`, so a falsy stamp was never dropped and
        // never stored; keep that truth table exactly (production updatedAt is
        // always a non-empty ISO stamp, but the exported seam must not drift).
        typeof saved.updatedAt === 'string' && saved.updatedAt ? saved.updatedAt : null,
      ),
    reset: core.reset,
    settle: (projectPath) => core.settle(projectPath, ''),
  }
}

// ── Real deps ─────────────────────────────────────────────────────────────────

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
      openDoc: (pid) => openScopedDoc(pid, 'board'),
      seenStore: realSeenStore,
      idleMs: IDLE_MS,
      retryDelaysMs: RETRY_DELAYS_MS,
      pidTtlMs: PID_TTL_MS,
    }))
  mirror.queue(projectPath, saved)
}
