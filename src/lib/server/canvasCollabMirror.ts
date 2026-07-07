// canvasCollabMirror — the CANVAS twin of collabMirror.ts (same bug class as
// c2e4c57c, canvas edition).
//
// PROBLEM: while a project is realtime-collab shared, each canvas's authority
// is its own collab Y.Doc (room `<pid>:canvas:<canvasId>`) — docToCanvasFile
// takes name/elements/order wholesale from the doc. Server-side canvas writers
// (a Canvas AI job's completion write via appendCanvasElements /
// updateCanvasElementSource, renameCanvas, createCanvas) only wrote the disk
// file, so the doc never learned about them and the next client (re)connect
// REVERTED them — an AI generation that landed while the canvas was shared
// vanished when the canvas re-synced.
//
// FIX: mirror every successful server-side canvas write into that canvas's doc.
// The single choke point is canvasData.writeCanvasFile (every canvas write —
// client save, AI append, AI tweak, rename, create, delete-replacement — lands
// there); it calls queueCanvasMirror(path, saved) fire-and-forget after each
// write. The machinery (tri-state pid resolution, per-entry connection with
// idle teardown, coalescing drain with retry/backoff, persisted seen-set) is
// collabMirrorCore.ts, shared with the board mirror — see collabMirror.ts's
// header for the full WHY of each rule. Canvas-specific decisions:
//
//   - SCOPE/ROOMS: one room PER CANVAS (`canvas:<canvasId>`), so the mirror
//     keys its entries (connection, queue, seen-set, pid cache) by
//     (project, canvasId) — several canvases of one project mirror through
//     several independent connections, each torn down after its own idle
//     window.
//   - SHARED FIELDS ONLY: the canvas doc's shared contract (canvasDoc.ts) is
//     name + elements (flat e:<id>:<field> keys) + element order. Personal /
//     ephemeral CanvasFile fields (viewport, chats, activeChatId, sidebarOpen,
//     sidebarWidth, rev, createdAt, updatedAt) NEVER enter the doc — exactly
//     like the client's canvasFileToDoc. Asset BYTES are out of scope too: an
//     element's assetId / fillImageId mirror as plain element fields (the same
//     thing the client seeds), while upload/GC of the underlying files stays
//     with the existing asset machinery (canvasImages.ts / assetSync.ts).
//   - PRESERVING, not authoritative: the owner applies doc→disk only while
//     that canvas is the open view (ProjectCanvas binding) — a member's
//     doc-only element must survive a server-side write that doesn't know it
//     (per-canvas seen-set sidecar; deletions propagate only for ids
//     previously seen on disk). Same must-fix as the board. Fields of a
//     DISK-PRESENT element still follow the disk (per-field LWW) — so a member
//     edit landing in the [save fired → mirror applied] window (a cold connect
//     adds up to a couple of seconds) is snapped back to the save's snapshot;
//     with the canvas open on both sides the next save re-propagates it, so
//     the exposure is the FINAL gesture of an editing burst. This is the same
//     two-writer blast radius the board mirror shipped with (documented there,
//     accepted over inventing a doc-vs-disk merge protocol).
//   - ENQUEUE STAMP: a process-local monotonic counter, NOT the canvas rev and
//     NOT updatedAt. rev can legitimately REWIND (deleteCanvas + a straggler
//     client save re-creates the file at rev 1 — the documented ghost-canvas
//     upsert door), which would wedge a `stamp <= last` guard until rev caught
//     back up; updatedAt has millisecond resolution, so a same-ms write pair
//     would drop the second. The counter is taken synchronously in queue(), and
//     writeCanvasFile-per-canvas is serialised by withCanvasFileLock, so
//     counter order == disk write order; the guard's only job (an out-of-order
//     canonicalize completion must not regress the doc) needs nothing more.
//     (A restart resets the counter AND the entries map together — stale
//     comparisons across restarts can't happen.)
//   - The board doc's K_CANVAS_INDEX (the shared canvas LIST) is a different
//     doc + a different writer (the owner's Canvas tab, boardDoc.ts) — this
//     mirror never touches it. A server-side rename therefore reaches the
//     canvas doc's m:name immediately, while the tab-bar name a member sees
//     refreshes when the owner's Canvas tab next publishes the index — the
//     pre-existing contract, unchanged here.
//
// OCC note: the disk side's lost-update protection (rev/409 + per-canvas file
// lock) is untouched — this module only ADDS the doc write after a disk write
// already succeeded.

import * as Y from 'yjs'
import { join, resolve, sep } from 'path'
import { mkdir, readFile, unlink } from 'fs/promises'
import type { CanvasFile } from '../types'
import { CANVAS_ROOT, EL_PREFIX, K_NAME, K_ORDER } from '../collab/canvasDoc'
import { ORIGIN_SEED, setKey } from '../collab/ydoc'
import { createCollabMirror, openScopedDoc } from './collabMirrorCore'
import { canonicalize } from './canonicalize'
import { findOwnProjectIdByPath } from './projectMembers'
import { projectDataDir } from './projectDataPath'
import { atomicWriteJson } from './atomicWrite'

// Same cadence/TTL decisions as the board mirror (collabMirror.ts) — a Canvas
// AI job's burst of appends reuses one connection; an idle server holds no
// sockets; a Supabase blip retries rather than silently dropping writes.
const IDLE_MS = 60_000
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]
const PID_TTL_MS = 60_000

export interface CanvasMirrorDeps {
  /** Canonicalize a project path (the pid lookup's input — registry paths are
   *  canonical, so they match). */
  canonicalize: (p: string) => Promise<string>
  /** FIND-ONLY collabProjectId lookup — the tri-state projectMembers contract
   *  (string = shared / null = definitely not, cacheable / undefined = lookup
   *  FAILED, retried, never cached). */
  resolvePid: (canonicalPath: string) => Promise<string | null | undefined>
  /** Open a SYNCED Y.Doc for the canvas's room (`canvas:<canvasId>`). Throws on
   *  any failure. */
  openDoc: (pid: string, canvasId: string) => Promise<{ doc: Y.Doc; destroy: () => void }>
  /** Persisted PER-CANVAS seen-set (element ids observed on disk). load → null
   *  on absence/corruption (= first mirror: delete nothing); save best-effort. */
  seenStore: {
    load: (canonicalPath: string, canvasId: string) => Promise<string[] | null>
    save: (canonicalPath: string, canvasId: string, ids: string[]) => Promise<void>
  }
  idleMs: number
  retryDelaysMs: number[]
  pidTtlMs: number
}

export interface CanvasMirror {
  /** Queue a mirrored write of one canvas's full disk state (fire-and-forget;
   *  coalesces bursts per canvas). */
  queue: (projectPath: string, saved: CanvasFile) => void
  /** Drop the canvas's LIVE mirror entry (connection, pending payload and the
   *  in-memory seen-set) — the in-memory half of the deleteCanvas cascade; see
   *  forgetCanvasMirror below for why it must run. */
  forget: (projectPath: string, canvasId: string) => Promise<void>
  /** Tear down every connection/timer (tests + reload hygiene). */
  reset: () => void
  /** Test hook: resolves when (project, canvas)'s queue is fully drained;
   *  THROWS on timeout so a wedged drain can't pass assertions vacuously. */
  settle: (projectPath: string, canvasId: string) => Promise<void>
}

/** The preserving mirror write for one canvas — the exact canvas analogue of
 *  mirrorBoardPreserving (see collabMirror.ts's WHY). Writes ONLY the shared
 *  contract (name + element flat keys + order): upserts every disk element
 *  per-field, deletes only (a) stale fields of disk-present elements and (b)
 *  whole elements in `deletable` (= seen on disk before, gone now). Doc-only
 *  ids the disk never had are untouched and keep their order slots. Idempotent
 *  — identical content emits zero updates (setKey no-ops). */
export const mirrorCanvasPreserving = (
  doc: Y.Doc,
  file: CanvasFile,
  deletable: ReadonlySet<string>,
): void => {
  const map = doc.getMap<unknown>(CANVAS_ROOT)
  doc.transact(() => {
    setKey(map, K_NAME, file.name)

    // Desired flat keys for the DISK elements (same encoding rules as
    // reconcileCollectionFlat / canvasFileToDoc: skip unencodable ids, the id
    // field, ':' fields, undefined values).
    const desired = new Map<string, unknown>()
    const diskIds = new Set<string>()
    for (const el of file.elements ?? []) {
      if (typeof el.id !== 'string' || el.id.includes(':')) continue
      diskIds.add(el.id)
      const obj = el as unknown as Record<string, unknown>
      for (const k of Object.keys(obj)) {
        if (k === 'id' || k.includes(':') || obj[k] === undefined) continue
        desired.set(`${EL_PREFIX}${el.id}:${k}`, obj[k])
      }
    }
    for (const key of Array.from(map.keys())) {
      if (!key.startsWith(EL_PREFIX)) continue
      const rest = key.slice(EL_PREFIX.length)
      const sep2 = rest.indexOf(':')
      if (sep2 < 0) continue // malformed key — same skip as readCollectionFlat
      const id = rest.slice(0, sep2)
      if (deletable.has(id)) {
        map.delete(key) // a REAL deletion (was on disk, gone now) — propagate
      } else if (diskIds.has(id) && !desired.has(key)) {
        map.delete(key) // stale field of a disk element
      }
      // doc-only id (someone else's element) → untouched
    }
    for (const [k, v] of Array.from(desired)) setKey(map, k, v)

    // Order: disk order first, then every doc-order id we PRESERVED in its
    // existing relative order. orderedDisk MUST reuse diskIds's encodability
    // rule — an unencodable ':'-id in the order would re-enter via keepTail on
    // the NEXT pass and grow m:order on every mirror (the board's echo-loop
    // must-fix, same shape here).
    const docOrder = (map.get(K_ORDER) as string[] | undefined) ?? []
    const orderedDisk = (file.elements ?? []).map((e) => e.id).filter((id) => diskIds.has(id))
    const keepTail = Array.isArray(docOrder)
      ? docOrder.filter((id) => typeof id === 'string' && !diskIds.has(id) && !deletable.has(id))
      : []
    setKey(map, K_ORDER, [...orderedDisk, ...keepTail])
  }, ORIGIN_SEED)
}

/** Canvas-flavoured assembly of the generic mirror core: entries are keyed by
 *  (project, canvasId), the room sub-scope IS the canvasId, ids are the element
 *  ids, and the enqueue stamp is a process-local counter (see header). */
export const createCanvasMirror = (deps: CanvasMirrorDeps): CanvasMirror => {
  let seq = 0
  const core = createCollabMirror<CanvasFile>({
    canonicalize: deps.canonicalize,
    resolvePid: deps.resolvePid,
    openDoc: (pid, sub) => deps.openDoc(pid, sub),
    seenStore: {
      load: (canonicalPath, sub) => deps.seenStore.load(canonicalPath, sub),
      save: (canonicalPath, sub, ids) => deps.seenStore.save(canonicalPath, sub, ids),
    },
    idsOf: (file) => (file.elements ?? []).map((el) => el.id),
    applyMirror: mirrorCanvasPreserving,
    idleMs: deps.idleMs,
    retryDelaysMs: deps.retryDelaysMs,
    pidTtlMs: deps.pidTtlMs,
  })
  return {
    queue: (projectPath, saved) => {
      // A canvas without a usable id can't map to a room or a disk file —
      // nothing to mirror (writeCanvasFile would have thrown before the hook).
      if (typeof saved.id !== 'string' || !saved.id) return
      core.queue(projectPath, saved.id, saved, ++seq)
    },
    forget: (projectPath, canvasId) => core.forget(projectPath, canvasId),
    reset: core.reset,
    settle: (projectPath, canvasId) => core.settle(projectPath, canvasId),
  }
}

// ── Real deps ─────────────────────────────────────────────────────────────────

// The persisted per-canvas seen-set sidecars live in their own subdir of the
// project's central data dir — deliberately NOT inside canvases/ (listCanvases's
// on-disk orphan scan treats every canvases/*.json as a canvas file, so a
// sidecar there would surface as a phantom canvas in the tab bar).
const SEEN_DIR = 'collab-mirror-canvas-seen'

/** Resolve a canvas's sidecar path, refusing any canvasId whose resolved path
 *  escapes the sidecar dir (the same structural guard as canvasFilePath — ids
 *  reaching the mirror came from validated writes, but the sidecar must not be
 *  the one path that trusts its input). null = refuse (load treats it as
 *  absent; save no-ops). */
const seenFilePath = async (canonicalPath: string, canvasId: string): Promise<string | null> => {
  const dir = resolve(join(await projectDataDir(canonicalPath), SEEN_DIR))
  const full = resolve(dir, `${canvasId}.json`)
  if (!full.startsWith(dir + sep)) return null
  return full
}

/** Exported for tests (the fs contract below is behavior worth pinning); the
 *  production consumer is queueCanvasMirror's singleton. */
export const canvasMirrorSeenStore: CanvasMirrorDeps['seenStore'] = {
  load: async (canonicalPath, canvasId) => {
    try {
      const file = await seenFilePath(canonicalPath, canvasId)
      if (!file) return null
      const raw = JSON.parse(await readFile(file, 'utf8')) as { ids?: unknown }
      return Array.isArray(raw.ids) ? raw.ids.filter((x): x is string => typeof x === 'string') : null
    } catch {
      return null // absent/corrupt → first-mirror semantics (delete nothing)
    }
  },
  save: async (canonicalPath, canvasId, ids) => {
    const file = await seenFilePath(canonicalPath, canvasId)
    if (!file) return
    // NON-recursive mkdir, EEXIST tolerated: if the project's central data dir
    // has just been rm -rf'd (project delete racing an in-flight mirror), this
    // ENOENTs and the save fails — instead of a recursive mkdir resurrecting an
    // orphan dir under a dead UUID that nothing would ever prune. (The board's
    // sidecar save has no mkdir at all, which gives it the same property.)
    await mkdir(join(await projectDataDir(canonicalPath), SEEN_DIR)).catch((e) => {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
    })
    await atomicWriteJson(file, { ids })
  },
}

/** In-memory half of the deleteCanvas cascade: drop the process-wide mirror's
 *  LIVE entry for this canvas — its in-memory seen-set above all. Deleting only
 *  the persisted sidecar is not enough: within one process the surviving
 *  entry's seen-set (never re-read from disk) would classify the deleted
 *  canvas's elements as deletable on the ghost-upsert door's re-mirror and
 *  delete them from a DO room a member may still be viewing. MUST run BEFORE
 *  deleteCanvasMirrorSeen: once the entry is gone, an in-flight drain's
 *  seen-save is suppressed by the core's liveness guard, so it cannot
 *  resurrect the sidecar the second half is about to unlink. Only touches an
 *  EXISTING process-wide mirror — never instantiates one (a process that never
 *  mirrored has nothing to forget). */
export const forgetCanvasMirror = async (
  projectPath: string,
  canvasId: string,
): Promise<void> => {
  await globalThis.__openground_canvas_collab_mirror?.forget(projectPath, canvasId)
}

/** Persisted half of the deleteCanvas cascade: drop the canvas's seen-set
 *  sidecar. Without this the sidecar (a) accumulates forever — canvas ids
 *  never recur, so nothing would ever reclaim it short of deleting the whole
 *  project — and (b) hands the ghost-upsert door's re-mirror (in a LATER
 *  process, where forgetCanvasMirror has no entry to drop) a STALE
 *  deletable-set, with the same element-deletion blast radius. Best-effort:
 *  absent sidecar / already-deleted project are no-ops. */
export const deleteCanvasMirrorSeen = async (
  projectPath: string,
  canvasId: string,
): Promise<void> => {
  try {
    const file = await seenFilePath(projectPath, canvasId)
    if (file) await unlink(file)
  } catch {
    /* nothing to clean */
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_canvas_collab_mirror: CanvasMirror | undefined
}

/** The process-wide canvas mirror (globalThis so `tsx watch` reloads keep one
 *  set of connections instead of stacking). All real canvas writes route
 *  through here via canvasData.writeCanvasFile. */
export const queueCanvasMirror = (projectPath: string, saved: CanvasFile): void => {
  const mirror =
    globalThis.__openground_canvas_collab_mirror ??
    (globalThis.__openground_canvas_collab_mirror = createCanvasMirror({
      canonicalize,
      resolvePid: findOwnProjectIdByPath,
      openDoc: (pid, canvasId) => openScopedDoc(pid, `canvas:${canvasId}`),
      seenStore: canvasMirrorSeenStore,
      idleMs: IDLE_MS,
      retryDelaysMs: RETRY_DELAYS_MS,
      pidTtlMs: PID_TTL_MS,
    }))
  mirror.queue(projectPath, saved)
}
