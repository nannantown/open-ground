import { mkdir, readFile, readdir, rename, unlink } from 'fs/promises'
import { join, resolve, sep } from 'path'
import { createHash, randomUUID } from 'crypto'
import type { CanvasElement, CanvasFile, CanvasSummary, CanvasesIndex } from '../types'
import { normalizeLayoutOrder } from '../canvasAutoLayout'
import { atomicWriteJson } from './atomicWrite'
import { projectDataDir } from './projectDataPath'
import { pruneCanvasAssets } from './canvasImages'

// Canvas data lives in the project's CENTRAL OPEN GROUND data dir
// (~/.openground/projects/<uuid>/canvases/ + canvases-index.json), NOT in the
// user's repo.
const CANVAS_DIR = 'canvases'
const INDEX_FILE = 'canvases-index.json'

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : randomUUID()

const emptyCanvas = (id: string, name: string): CanvasFile => {
  const now = new Date().toISOString()
  return {
    id,
    name,
    rev: 0,
    viewport: { x: 0, y: 0, zoom: 1 },
    elements: [],
    chats: [],
    activeChatId: null,
    sidebarOpen: false,
    sidebarWidth: null,
    createdAt: now,
    updatedAt: now,
  }
}

const emptyIndex = (): CanvasesIndex => ({ order: [], activeId: null })

// A corrupt canvas file / index that parses to a NON-object (bare string,
// number, array, null) must be treated as corrupt rather than spread — spreading
// it injects char/numeric keys into the result. Every on-disk canvas shape is a
// plain object, so this never rejects valid data.
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

// ── storage location ────────────────────────────────────────────────────────

const centralCanvasesDir = async (projectPath: string) =>
  join(await projectDataDir(projectPath), CANVAS_DIR)

const centralIndexPath = async (projectPath: string) =>
  join(await projectDataDir(projectPath), INDEX_FILE)

const canvasesDir = (projectPath: string): Promise<string> => centralCanvasesDir(projectPath)

// The canvas id is echoed from the client (GET ?id / POST canvas.id / rename /
// delete), so a `../`-laden id would let `${id}.json` escape the canvases dir
// and resolve to ~/.openground/auth.json (OAuth token read) or settings.json
// (arbitrary overwrite). Route handlers pre-validate with isValidCanvasId, but
// this is the structural last line of defense: any id whose resolved path leaves
// the canvases dir is rejected here, regardless of caller. readCanvasFile's
// try/catch turns the throw into a null (→ 404); writers reject the promise.
const canvasFilePath = async (projectPath: string, id: string): Promise<string> => {
  const dir = resolve(await canvasesDir(projectPath))
  const full = resolve(dir, `${id}.json`)
  if (!full.startsWith(dir + sep)) {
    throw new Error('invalid canvas id')
  }
  return full
}

const ensureCanvasesDir = async (projectPath: string) => {
  await mkdir(await canvasesDir(projectPath), { recursive: true })
}

// Central index read.
const readCentralIndex = async (projectPath: string): Promise<CanvasesIndex> => {
  try {
    const raw = await readFile(await centralIndexPath(projectPath), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed)) return emptyIndex()
    // Coerce the two fields to their contract BEFORE listCanvases iterates them.
    // A hand-corrupted index with a non-array `order` would otherwise make
    // `for (const id of index.order)` iterate a string's chars (or throw), and
    // a non-string `activeId` would leak through. A bad `order` is recoverable:
    // listCanvases's on-disk orphan scan re-surfaces the real canvas files, so
    // dropping a junk order loses nothing.
    const order = Array.isArray(parsed.order)
      ? parsed.order.filter((x): x is string => typeof x === 'string')
      : []
    const activeId = typeof parsed.activeId === 'string' ? parsed.activeId : null
    // CanvasesIndex is exactly {order, activeId} — build it explicitly rather
    // than spreading `parsed`, so a corrupt index's junk keys aren't carried
    // through (and re-persisted on the self-heal rewrite).
    return { order, activeId }
  } catch {
    return emptyIndex()
  }
}

export const readCanvasesIndex = async (projectPath: string): Promise<CanvasesIndex> => {
  await ensureCanvasesDir(projectPath)
  return readCentralIndex(projectPath)
}

const writeCanvasesIndex = async (projectPath: string, idx: CanvasesIndex) => {
  await ensureCanvasesDir(projectPath)
  await atomicWriteJson(await centralIndexPath(projectPath), idx)
}

export const readCanvasFile = async (
  projectPath: string,
  id: string,
): Promise<CanvasFile | null> => {
  await ensureCanvasesDir(projectPath)
  let raw: string
  try {
    raw = await readFile(await canvasFilePath(projectPath, id), 'utf8')
  } catch {
    return null // missing file — the ordinary "no such canvas" case, silent
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    // Corrupt file that isn't a plain object → treat as missing (null), the same
    // contract as an unparseable file. Guards against a null deref on
    // `parsed.name` and against spreading char/numeric keys into the canvas.
    if (!isPlainObject(parsed)) {
      // eslint-disable-next-line no-console
      console.warn(`[canvasData] ${id}.json is not a canvas object at ${projectPath}`)
      return null
    }
    const canvas = { ...emptyCanvas(id, typeof parsed.name === 'string' ? parsed.name : 'Canvas'), ...(parsed as Partial<CanvasFile>) }
    // Converge files saved by the old position-sorting auto-layout engine to the
    // v2 array-order contract, so the picture doesn't change on load. No-op
    // (same array) on v2 files. `rev` is normalised to a finite number so a
    // legacy file written before rev existed loads as 0 (the client then saves
    // with expectedRev 0, which matches and upgrades the file to rev 1).
    // `elements` is coerced to an array first: a hand-corrupted file with a
    // non-array `elements` would otherwise crash normalizeLayoutOrder. `name` is
    // coerced to a string so a non-string (corrupt) name can't crash downstream
    // string ops (the spread of `parsed` above can override the default).
    return {
      ...canvas,
      name: typeof canvas.name === 'string' ? canvas.name : 'Canvas',
      rev: Number.isFinite(canvas.rev) ? canvas.rev : 0,
      elements: normalizeLayoutOrder(Array.isArray(canvas.elements) ? canvas.elements : []),
    }
  } catch {
    // Present but unparseable — surface it (don't crash) and treat as missing.
    // eslint-disable-next-line no-console
    console.warn(`[canvasData] ${id}.json is not valid JSON at ${projectPath}`)
    return null
  }
}

// Fire-and-forget mirror of a successful canvas write into that canvas's collab
// Y.Doc (the canvas twin of board bug c2e4c57c: while shared, the doc is the
// canvas's authority — a server-side write it never learns about, e.g. a Canvas
// AI job's completion, is REVERTED on the next client (re)connect). Dynamic
// import keeps yjs + the transport out of this module's static graph; a no-op
// unless the project is actually collab-shared (find-only lookup, cached).
// NEVER blocks or fails the save. Same pattern as projectData's
// queueBoardMirrorSafe. Ordering note: the mirror stamps writes in queue-call
// order, and dynamic-import .then callbacks run FIFO, so two same-canvas writes
// (serialised by withCanvasFileLock) can't reach the mirror inverted.
const queueCanvasMirrorSafe = (projectPath: string, saved: CanvasFile): void => {
  void import('./canvasCollabMirror')
    .then((m) => m.queueCanvasMirror(projectPath, saved))
    .catch(() => {})
}

// Low-level canvas writer. ALWAYS bumps `rev` (the OCC version) off whatever
// rev the passed object carries, so every write — client save, AI append, AI
// tweak, rename, create — advances the revision. It is deliberately UNLOCKED:
// the in-lock callers (appendCanvasElements / updateCanvasElementSource /
// saveCanvasFile / renameCanvas) compose it INSIDE withCanvasFileLock after
// reading the current canvas, so the rev they bump from is the on-disk one.
// Calling it directly (create/delete of a brand-new unique id, tests) is safe
// because those ids have no concurrent writer.
export const writeCanvasFile = async (
  projectPath: string,
  canvas: CanvasFile,
): Promise<CanvasFile> => {
  await ensureCanvasesDir(projectPath)
  const baseRev = Number.isFinite(canvas.rev) ? canvas.rev : 0
  const next: CanvasFile = { ...canvas, rev: baseRev + 1, updatedAt: new Date().toISOString() }
  // Deliberately NOT fsync'd (atomic, but not power-loss durable). The client
  // save path is debounced and fires often during editing; an fsync(+dir fsync)
  // per keystroke-batch would add real latency to the hot canvas-edit loop. The
  // atomic temp+rename still guarantees no torn file and survives a process
  // crash/quit; only a power cut in the brief pre-flush window could lose the
  // very latest canvas save, which the next debounced save overwrites anyway.
  // (Contrast tasks.json, which IS fsync'd — see writeProjectData.)
  await atomicWriteJson(await canvasFilePath(projectPath,canvas.id), next)
  // Every canvas write path converges HERE (this is the canvas analogue of
  // projectData's writeCasGuarded choke point), so hooking the collab mirror
  // after the successful disk write covers client saves, AI append/tweak,
  // rename, create and the delete-replacement seed alike.
  queueCanvasMirrorSafe(projectPath, next)
  return next
}

declare global {
  // eslint-disable-next-line no-var
  var __openground_canvas_index_writes: Map<string, Promise<unknown>> | undefined
}

// Per-PROJECT serial queue for canvas-INDEX read-modify-writes. createCanvas /
// deleteCanvas / reorderCanvases / setActiveCanvas each read the index (via
// listCanvases), compute the next one, then write it back. Without
// serialisation two concurrent ops read the same stale index and the second
// write clobbers the first — a just-created canvas drops out of the index
// (orphaned on disk), or a stale activeId lingers. Serialise per project so
// each op observes the previous one's result. Survives HMR via globalThis.
// NOTE: the in-lock ops read live state via computeLiveCanvases (a PURE reader),
// NOT via listCanvases — listCanvases itself takes this lock, so re-entering it
// from inside an op would self-deadlock. listCanvases is the PUBLIC, persisting
// read for the lock-free GET path: it re-computes + writes the heal INSIDE this
// lock, so it can't roll back a concurrent writer's activeId the way the old
// lock-free self-heal write did.
const indexWriteQueue: Map<string, Promise<unknown>> =
  globalThis.__openground_canvas_index_writes ??
  (globalThis.__openground_canvas_index_writes = new Map())

const withIndexLock = <T>(projectPath: string, fn: () => Promise<T>): Promise<T> => {
  const prev = indexWriteQueue.get(projectPath) ?? Promise.resolve()
  const myRun = prev.then(fn)
  // Keep the queue advancing even if one op throws, so a single failure can't
  // deadlock every subsequent index op for this project.
  indexWriteQueue.set(projectPath, myRun.catch(() => undefined))
  return myRun
}

// Read just a canvas file's SUMMARY (id/name/updatedAt). Returns null when the
// file is missing OR corrupt (unparseable, or parses to a non-object) — the same
// "corrupt → drop" contract readCanvasFile uses — so listCanvases converges the
// index away from a damaged file instead of surfacing a junk summary.
const readCanvasSummary = async (
  projectPath: string,
  id: string,
): Promise<CanvasSummary | null> => {
  try {
    const raw = await readFile(await canvasFilePath(projectPath, id), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!isPlainObject(parsed)) return null
    return {
      id,
      name: typeof parsed.name === 'string' ? parsed.name : 'Canvas',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date(0).toISOString(),
    }
  } catch {
    return null
  }
}

// Core read+reconcile, PURE (never writes): read the index, drop ids whose file
// is missing/corrupt, surface on-disk orphans (crash recovery) at the end, and
// repoint a dead activeId at a live canvas. `changed` reports whether the healed
// index differs from what's on disk, so the persisting caller can skip a no-op
// write. The index-mutating ops (createCanvas / deleteCanvas / reorderCanvases /
// setActiveCanvas) compose THIS directly: they already run inside withIndexLock
// and write their own next index, so they must NOT re-enter the lock (self-
// deadlock) nor double-persist. The lock-free GET path uses listCanvases below,
// which persists the heal under the lock.
const computeLiveCanvases = async (
  projectPath: string,
): Promise<{ healed: CanvasesIndex; canvases: CanvasSummary[]; changed: boolean }> => {
  const index = await readCanvasesIndex(projectPath)
  const summaries: CanvasSummary[] = []
  const liveOrder: string[] = []
  for (const id of index.order) {
    const summary = await readCanvasSummary(projectPath, id)
    // Missing OR corrupt file — drop the id silently so the index converges.
    if (!summary) continue
    summaries.push(summary)
    liveOrder.push(id)
  }
  // If on-disk files exist that weren't in the index (e.g. recovered from a
  // crash), surface them at the end so they aren't lost.
  try {
    const entries = await readdir(await canvasesDir(projectPath))
    for (const f of entries) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -5)
      if (liveOrder.includes(id)) continue
      const summary = await readCanvasSummary(projectPath, id)
      if (!summary) continue
      summaries.push(summary)
      liveOrder.push(id)
    }
  } catch {}
  let activeId = index.activeId
  if (!activeId || !liveOrder.includes(activeId)) {
    activeId = liveOrder[0] ?? null
  }
  const healed: CanvasesIndex = { order: liveOrder, activeId }
  const changed =
    healed.order.join(',') !== index.order.join(',') || healed.activeId !== index.activeId
  return { healed, canvases: summaries, changed }
}

// Public list for the GET route (and tests): reconcile the index to disk AND
// PERSIST the heal, so repeated reads don't keep re-deriving it from a disk scan.
// The reconcile+persist runs INSIDE withIndexLock with a FRESH compute, so it
// serialises with the index-mutating ops: a create/setActive that advanced the
// index between two GETs can no longer be rolled back by a stale self-heal write
// (the activeId-rollback the OLD lock-free self-heal caused). MUST NOT be called
// from inside withIndexLock — it re-acquires the lock and would self-deadlock;
// the in-lock ops (createCanvas / deleteCanvas / …) use computeLiveCanvases.
export const listCanvases = (
  projectPath: string,
): Promise<{ index: CanvasesIndex; canvases: CanvasSummary[] }> =>
  withIndexLock(projectPath, async () => {
    const { healed, canvases, changed } = await computeLiveCanvases(projectPath)
    if (changed) await writeCanvasesIndex(projectPath, healed)
    return { index: healed, canvases }
  })

const nextCanvasName = (existing: CanvasSummary[]): string => {
  // Pick the smallest "Canvas N" integer not in use, so deleting from the
  // middle of the list eventually backfills.
  const used = new Set<number>()
  for (const c of existing) {
    const m = c.name.match(/^Canvas (\d+)$/)
    if (m) used.add(parseInt(m[1], 10))
  }
  let n = 1
  while (used.has(n)) n += 1
  return `Canvas ${n}`
}

export const createCanvas = (
  projectPath: string,
  name?: string,
): Promise<{ index: CanvasesIndex; canvas: CanvasFile }> =>
  withIndexLock(projectPath, async () => {
    await ensureCanvasesDir(projectPath)
    const { healed: index, canvases } = await computeLiveCanvases(projectPath)
    const id = newId()
    const canvas = emptyCanvas(id, name?.trim() || nextCanvasName(canvases))
    // Return the WRITTEN canvas (rev 1, not the pre-write rev 0) so the client
    // adopts the correct rev as its OCC base from the create response.
    const written = await writeCanvasFile(projectPath, canvas)
    const nextIndex: CanvasesIndex = {
      order: [...index.order, id],
      activeId: id,
    }
    await writeCanvasesIndex(projectPath, nextIndex)
    return { index: nextIndex, canvas: written }
  })

// Removing the last Canvas is treated as "reset" rather than an error: a fresh
// empty Canvas takes its place so the user never sees a Canvas tab bar with
// zero tabs.
export const deleteCanvas = (
  projectPath: string,
  id: string,
): Promise<{ index: CanvasesIndex; createdReplacement?: CanvasFile }> =>
  withIndexLock(projectPath, async () => {
    await ensureCanvasesDir(projectPath)
    const { healed: index } = await computeLiveCanvases(projectPath)
    if (!index.order.includes(id)) {
      return { index }
    }
    const remaining = index.order.filter((x) => x !== id)
    // Unlink the canvas file UNDER its per-(project,canvas) file lock — the SAME
    // lock the Canvas AI writers (appendCanvasElements / updateCanvasElementSource)
    // and renameCanvas / saveCanvasFile take. deleteCanvas otherwise runs under a
    // DIFFERENT lock (indexWriteQueue) than those writers (canvasFileWriteQueue),
    // so a Canvas AI job that read this canvas just before the delete could write
    // it back just after the unlink — re-creating the .json the delete removed.
    // listCanvases's on-disk orphan scan would then "revive" the deleted canvas,
    // with its image assets already cascaded away → it loads with broken images.
    // Sharing the lock makes the AI write either land BEFORE the unlink (then be
    // removed by it) or observe the gone file and abort (appendCanvasElements
    // throws 'canvas no longer exists'; updateCanvasElementSource returns false);
    // its read→write can no longer straddle the unlink. The canvas stays deleted.
    await withCanvasFileLock(projectPath, id, async () => {
      try {
        await unlink(await canvasFilePath(projectPath, id))
      } catch {}
      // Cascade the collab-mirror state INSIDE the same lock, so it is strictly
      // ordered against the ghost-canvas upsert door (a straggler client save
      // re-creating this id runs through this SAME lock): by the time such a
      // ghost write can happen, both mirror halves below are gone and its
      // re-mirror gets cold-start seen semantics (delete NOTHING) — otherwise a
      // stale seen-set would classify this canvas's elements as deletable and
      // delete them from a DO room a member may still be viewing. Order
      // matters: forget the LIVE entry first (its in-memory seen-set is the
      // same hazard within this process, and once the entry is dropped the
      // core's liveness guard stops any in-flight drain from re-persisting the
      // sidecar), THEN unlink the persisted sidecar (the cross-restart copy of
      // the same hazard, plus permanent accumulation — ids never recur).
      // Best-effort; dynamic import for the same bundle-graph reason as the
      // mirror hook above.
      try {
        const { forgetCanvasMirror, deleteCanvasMirrorSeen } = await import('./canvasCollabMirror')
        await forgetCanvasMirror(projectPath, id)
        await deleteCanvasMirrorSeen(projectPath, id)
      } catch {}
    })
    // Cascade: drop the canvas's image-asset directory so we never accumulate
    // orphan bytes after a delete. Best-effort — if the dir was never created
    // (canvas never had an image), rm -rf is a no-op.
    try {
      const { deleteCanvasAssetsDir } = await import('./canvasImages')
      await deleteCanvasAssetsDir(projectPath, id)
    } catch {}
    if (remaining.length === 0) {
      const replacementId = newId()
      const replacement = emptyCanvas(replacementId, 'Canvas 1')
      const written = await writeCanvasFile(projectPath, replacement)
      const nextIndex: CanvasesIndex = { order: [replacementId], activeId: replacementId }
      await writeCanvasesIndex(projectPath, nextIndex)
      return { index: nextIndex, createdReplacement: written }
    }
    const activeId =
      index.activeId === id ? remaining[0] : index.activeId ?? remaining[0]
    const nextIndex: CanvasesIndex = { order: remaining, activeId }
    await writeCanvasesIndex(projectPath, nextIndex)
    return { index: nextIndex }
  })

export const renameCanvas = async (
  projectPath: string,
  id: string,
  name: string,
): Promise<CanvasFile | null> => {
  const trimmed = name.trim()
  if (!trimmed) return null
  // Read-modify-write of the single canvas file → serialise with AI append /
  // tweak (and client save) via the same per-(project,canvas) lock, so a rename
  // landing between an AI job's read and write can't drop the appended elements
  // (the same lost-update class this OCC work closes for the client save path).
  return withCanvasFileLock(projectPath, id, async () => {
    const canvas = await readCanvasFile(projectPath, id)
    if (!canvas) return null
    return writeCanvasFile(projectPath, { ...canvas, name: trimmed })
  })
}

export const reorderCanvases = (
  projectPath: string,
  order: string[],
): Promise<CanvasesIndex> =>
  withIndexLock(projectPath, async () => {
    const { healed: index } = await computeLiveCanvases(projectPath)
    const allowed = new Set(index.order)
    const filtered = order.filter((id) => allowed.has(id))
    // Tack on any id that the client forgot to include — better than silently
    // dropping it.
    for (const id of index.order) if (!filtered.includes(id)) filtered.push(id)
    const activeId =
      index.activeId && filtered.includes(index.activeId) ? index.activeId : filtered[0] ?? null
    const nextIndex: CanvasesIndex = { order: filtered, activeId }
    await writeCanvasesIndex(projectPath, nextIndex)
    return nextIndex
  })

export const setActiveCanvas = (
  projectPath: string,
  id: string,
): Promise<CanvasesIndex> =>
  withIndexLock(projectPath, async () => {
    const { healed: index } = await computeLiveCanvases(projectPath)
    if (!index.order.includes(id)) return index
    const nextIndex: CanvasesIndex = { ...index, activeId: id }
    await writeCanvasesIndex(projectPath, nextIndex)
    return nextIndex
  })

// ── Canvas AI persistence (server-side job results) ──────────────────────────
// A Canvas AI job (src/lib/server/canvasAi.ts) writes its result straight into
// the target canvas on completion, so the design lands whether or not the user
// is still watching the canvas. Both ops are a read-modify-write of the SINGLE
// canvas file, serialised per (project, canvas) so two jobs targeting the same
// canvas can't clobber each other's append (the AI chain serialises the claude
// runs, but the persist that follows each run can still overlap the next). The
// concurrent CLIENT persist (the debounced /api/project/canvases POST) now runs
// through saveCanvasFile, which takes this SAME lock and gates on rev — so a
// client save can no longer interleave (or silently overwrite) an AI append /
// tweak; a stale one is rejected (409) and the client merges + retries.

declare global {
  // eslint-disable-next-line no-var
  var __openground_canvas_file_writes: Map<string, Promise<unknown>> | undefined
}

const canvasFileWriteQueue: Map<string, Promise<unknown>> =
  globalThis.__openground_canvas_file_writes ??
  (globalThis.__openground_canvas_file_writes = new Map())

const withCanvasFileLock = <T>(
  projectPath: string,
  canvasId: string,
  fn: () => Promise<T>,
): Promise<T> => {
  const key = `${projectPath}::${canvasId}`
  const prev = canvasFileWriteQueue.get(key) ?? Promise.resolve()
  const myRun = prev.then(fn)
  canvasFileWriteQueue.set(key, myRun.catch(() => undefined))
  return myRun
}

// Bounding box over x/y/(width|height). Rotation is ignored — this only feeds
// the append-placement offset, where an axis-aligned box is close enough.
interface ElBounds { minX: number; minY: number; maxX: number; maxY: number }
const elementsBounds = (els: CanvasElement[]): ElBounds | null => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of els) {
    if (!Number.isFinite(el.x) || !Number.isFinite(el.y)) continue
    const w = typeof el.width === 'number' && Number.isFinite(el.width) ? el.width : 0
    const h = typeof el.height === 'number' && Number.isFinite(el.height) ? el.height : 0
    minX = Math.min(minX, el.x)
    minY = Math.min(minY, el.y)
    maxX = Math.max(maxX, el.x + w)
    maxY = Math.max(maxY, el.y + h)
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

// Gap between existing content and a freshly appended AI batch.
const APPEND_GAP = 80

/** Offset a freshly generated batch so it sits to the RIGHT of the canvas's
 *  existing content with a gap (top-aligned), or near the origin on an empty
 *  canvas — so an AI generation never lands on top of what's already there.
 *  Mutates each element's x/y in place. Exported for unit tests. */
export const placeAppendedElements = (
  existing: CanvasElement[],
  incoming: CanvasElement[],
): CanvasElement[] => {
  const inB = elementsBounds(incoming)
  if (!inB) return incoming
  const exB = elementsBounds(existing)
  const targetX = exB ? exB.maxX + APPEND_GAP : 0
  const targetY = exB ? exB.minY : 0
  const dx = Math.round(targetX - inB.minX)
  const dy = Math.round(targetY - inB.minY)
  if (dx === 0 && dy === 0) return incoming
  for (const el of incoming) {
    el.x += dx
    el.y += dy
  }
  return incoming
}

/** Append AI-generated elements to a canvas at a non-overlapping position
 *  (right of existing content), server-side. Returns the appended elements with
 *  their FINAL positions, so a still-open canvas can reflect them locally with
 *  no extra refetch. Throws when the canvas no longer exists (deleted mid-run).
 */
export const appendCanvasElements = (
  projectPath: string,
  canvasId: string,
  elements: CanvasElement[],
): Promise<CanvasElement[]> =>
  withCanvasFileLock(projectPath, canvasId, async () => {
    const canvas = await readCanvasFile(projectPath, canvasId)
    if (!canvas) throw new Error('canvas no longer exists')
    const placed = placeAppendedElements(
      canvas.elements,
      elements.map((e) => ({ ...e })),
    )
    const written = await writeCanvasFile(projectPath, {
      ...canvas,
      elements: [...canvas.elements, ...placed],
    })
    // Reclaim image bytes no element references anymore. Append only ADDS
    // elements, so this never drops an asset this write referenced; it sweeps up
    // orphans an earlier de-reference left behind. Best-effort, never throws.
    await pruneCanvasAssets(projectPath, canvasId, written)
    return placed
  })

/** Stable content hash of an element's source `text`. Used to detect whether a
 *  screen/mock element was edited between a tweak's START (the snapshot claude
 *  rewrote) and its COMPLETION (the guarded write below) — see
 *  updateCanvasElementSource's `expectedBaseHash`. sha256 hex; BOTH the snapshot
 *  side (startTweakJob, over the start-time source) and the write side here MUST
 *  hash through this one function, so an unchanged element always compares equal. */
export const hashElementSource = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex')

/** Write a tweaked source onto one screen/mock element in a canvas, server-side.
 *  Returns `true` when the element was found and updated, `false` when the canvas
 *  or element is gone (deleted mid-run), or `'conflict'` when the optimistic
 *  guard below tripped.
 *
 *  A `false` is NOT benign for the only production caller: the Canvas AI tweak job
 *  (startTweakJob) treats it as a job error (TWEAK_TARGET_REMOVED_MESSAGE) rather
 *  than reporting done+source — a rewrite that reached disk nowhere must not be
 *  claimed as applied. Keep this tri-state; do not collapse `false` into a silent
 *  success.
 *
 *  LOST-UPDATE GUARD (`expectedBaseHash`): a Canvas AI tweak is a 30s–3min claude
 *  run that rewrites a SNAPSHOT of the element's source taken when the run began.
 *  If the user manually edits that SAME element WHILE the tweak runs, blindly
 *  writing the rewrite here would silently destroy their edit — the rewrite is
 *  based on the now-stale snapshot. So startTweakJob passes the snapshot's hash:
 *  the write lands only while the on-disk element still hashes to it. If it
 *  changed, we return `'conflict'` WITHOUT writing, so the manual edit is kept
 *  and the caller surfaces the conflict (the user re-runs the tweak). Omit
 *  `expectedBaseHash` for an unconditional overwrite (non-tweak writers / tests).
 *
 *  SCOPE: the guard compares the PERSISTED source. An edit still buffered on the
 *  client (typed but not yet flushed by the debounced save) isn't visible here,
 *  so the sub-second tail of an in-progress edit is a separate, much narrower
 *  window than the whole-run overwrite this closes — a client-side concern, not
 *  one this disk-level guard can see. */
export const updateCanvasElementSource = (
  projectPath: string,
  canvasId: string,
  elementId: string,
  source: string,
  expectedBaseHash?: string,
): Promise<boolean | 'conflict'> =>
  withCanvasFileLock(projectPath, canvasId, async () => {
    const canvas = await readCanvasFile(projectPath, canvasId)
    if (!canvas) return false
    const target = canvas.elements.find((el) => el.id === elementId)
    if (!target) return false
    // The element's source changed since the tweak's start-time snapshot (a
    // manual edit during the run) → refuse rather than clobber it. An undefined
    // hash means "no guard" — the legacy unconditional overwrite.
    if (
      expectedBaseHash !== undefined &&
      hashElementSource(target.text ?? '') !== expectedBaseHash
    ) {
      return 'conflict'
    }
    const next = canvas.elements.map((el) =>
      el.id === elementId ? { ...el, text: source } : el,
    )
    await writeCanvasFile(projectPath, { ...canvas, elements: next })
    return true
  })

// ── Client save (optimistic concurrency control) ────────────────────────────
// The debounced full-canvas POST from the client used to blind-overwrite the
// file OUTSIDE the lock, so a save based on a snapshot taken BEFORE an AI job
// appended could silently erase the appended elements (lost update). This is
// the serialised, rev-checked replacement: it runs INSIDE withCanvasFileLock
// (so it can't interleave an AI append/tweak) and only writes when the client's
// expected rev still matches the on-disk rev. If the server has advanced (an AI
// job landed since the client's load), it returns a conflict + the CURRENT
// canvas so the route can 409 and the client can refetch → 3-way-merge
// (canvasMerge.reconcileCanvasElements) → retry, preserving BOTH the client's
// edits and the AI's additions and never resurrecting a client-deleted element.

export interface SaveCanvasOutcome {
  ok: boolean
  /** true when the write was rejected because the client's rev was stale. */
  conflict?: boolean
  /** ok → the written canvas (new rev). conflict → the CURRENT server canvas
   *  (so the client can merge against it and retry). */
  canvas: CanvasFile
}

/** If a canvas file is present on disk but DAMAGED (unparseable / not an
 *  object), readCanvasFile returns null — indistinguishable from "missing". A
 *  caller about to treat null as a brand-new first write would then overwrite
 *  (and destroy) the damaged file. Move it aside to a sibling first so its bytes
 *  survive for manual recovery. Returns true if it quarantined something. A
 *  genuinely-missing file is a no-op. Best-effort. */
const quarantineDamagedCanvas = async (projectPath: string, id: string): Promise<boolean> => {
  const file = await canvasFilePath(projectPath, id)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return false // genuinely missing — nothing to preserve
  }
  try {
    if (isPlainObject(JSON.parse(raw))) return false // a valid object isn't damaged
  } catch {
    /* unparseable → fall through to quarantine */
  }
  try {
    await rename(file, join(await canvasesDir(projectPath), `${id}.corrupt-${Date.now()}.json`))
    return true
  } catch {
    return false
  }
}

/** Persist a full client-authored Canvas under optimistic concurrency control.
 *  `incoming.rev` is the rev the client loaded; the write succeeds only while
 *  it still matches the on-disk rev (or the canvas isn't on disk yet — a
 *  brand-new first save). Otherwise the save is rejected as a conflict without
 *  touching the file, so an AI job's just-appended elements are never lost. */
export const saveCanvasFile = (
  projectPath: string,
  incoming: CanvasFile,
): Promise<SaveCanvasOutcome> =>
  withCanvasFileLock(projectPath, incoming.id, async () => {
    const current = await readCanvasFile(projectPath, incoming.id)
    const currentRev = current?.rev ?? 0
    const expectedRev = Number.isFinite(incoming.rev) ? incoming.rev : 0
    // Brand-new (not on disk yet) OR the client is up to date → write + bump.
    // Bump from the SERVER's current rev, not the client's echoed value, so a
    // client that under-reports can't rewind the version.
    if (!current || currentRev === expectedRev) {
      // `!current` can mean the file is MISSING (true brand-new) or DAMAGED
      // (corrupt on disk). Quarantine a damaged file before the write so its
      // bytes aren't silently destroyed (mirrors writeProjectData's quarantine).
      if (!current) await quarantineDamagedCanvas(projectPath, incoming.id)
      // GHOST-CANVAS upsert door (intentionally open HERE; closed CLIENT-side):
      // if a debounced client save for this id lands just AFTER a concurrent
      // deleteCanvas unlinked the file, `!current` is true and this upsert
      // RE-CREATES it as an orphan, which listCanvases's scan then revives (its
      // assets already cascaded away → broken images). From disk+index state alone
      // the server CANNOT tell "deleted" from a legitimate "brand-new first save" /
      // "corrupt-recovery" (both are absent-from-index + no-file), and that upsert
      // contract is pinned by canvasOcc.test.ts / canvasDataCorrupt.test.ts — so
      // the race is closed where it IS knowable: the CLIENT. ProjectCanvas's
      // deleteCanvas awaits flushPending(), which now drains BOTH the not-yet-fired
      // debounced save AND any save already in flight on the save chain before
      // issuing the delete, so no client save for a deleted id is left outstanding
      // (ProjectCanvas.flush.test.tsx pins both legs). The same file-lock closes
      // this symptom for the Canvas AI writers server-side.
      const written = await writeCanvasFile(projectPath, { ...incoming, rev: currentRev })
      // A client save is where an image element gets replaced (a fresh upload
      // issues a NEW assetId, orphaning the old bytes) or deleted outright — so
      // GC unreferenced assets now that the new element set is on disk.
      // pruneCanvasAssets keeps referenced + freshly-uploaded assets and is
      // best-effort (never throws), so it can't fail the save. The rejected
      // conflict path below does NOT prune: it wrote nothing, and the client's
      // merge+retry will run through here and prune once the save lands.
      await pruneCanvasAssets(projectPath, incoming.id, written)
      return { ok: true, canvas: written }
    }
    // Server advanced past the client's base (an AI job appended/tweaked, or a
    // rename landed) → conflict; hand back the current canvas for the merge.
    return { ok: false, conflict: true, canvas: current }
  })

// Used by tests / debugging only — wipes the entire Canvases directory so
// the next read rebuilds from scratch. Not wired to any route.
export const _resetCanvasesForTest = async (projectPath: string) => {
  try {
    const { rm } = await import('fs/promises')
    await rm(await canvasesDir(projectPath), { recursive: true, force: true })
    await unlink(await centralIndexPath(projectPath))
  } catch {}
}
