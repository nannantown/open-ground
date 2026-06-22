import { mkdir, readFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { CanvasElement, CanvasFile, CanvasSummary, CanvasesIndex } from '../types'
import { normalizeLayoutOrder } from '../canvasAutoLayout'
import { atomicWriteJson } from './atomicWrite'
import { projectDataDir } from './projectDataPath'

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

// ── storage location ────────────────────────────────────────────────────────

const centralCanvasesDir = async (projectPath: string) =>
  join(await projectDataDir(projectPath), CANVAS_DIR)

const centralIndexPath = async (projectPath: string) =>
  join(await projectDataDir(projectPath), INDEX_FILE)

const canvasesDir = (projectPath: string): Promise<string> => centralCanvasesDir(projectPath)

const canvasFilePath = async (projectPath: string, id: string) =>
  join(await canvasesDir(projectPath), `${id}.json`)

const ensureCanvasesDir = async (projectPath: string) => {
  await mkdir(await canvasesDir(projectPath), { recursive: true })
}

// Central index read.
const readCentralIndex = async (projectPath: string): Promise<CanvasesIndex> => {
  try {
    const raw = await readFile(await centralIndexPath(projectPath), 'utf8')
    const parsed = JSON.parse(raw)
    return { ...emptyIndex(), ...parsed }
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
  try {
    const raw = await readFile(await canvasFilePath(projectPath,id), 'utf8')
    const parsed = JSON.parse(raw) as CanvasFile
    const canvas = { ...emptyCanvas(id, parsed.name ?? 'Canvas'), ...parsed }
    // Converge files saved by the old position-sorting auto-layout engine to the
    // v2 array-order contract, so the picture doesn't change on load. No-op
    // (same array) on v2 files. `rev` is normalised to a finite number so a
    // legacy file written before rev existed loads as 0 (the client then saves
    // with expectedRev 0, which matches and upgrades the file to rev 1).
    return {
      ...canvas,
      rev: Number.isFinite(canvas.rev) ? canvas.rev : 0,
      elements: normalizeLayoutOrder(canvas.elements ?? []),
    }
  } catch {
    return null
  }
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
  await atomicWriteJson(await canvasFilePath(projectPath,canvas.id), next)
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
// NOTE: listCanvases is a plain reader and is deliberately NOT wrapped — it
// runs *inside* these ops, so locking it would self-deadlock.
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

// Return summaries for every Canvas recorded in the index. Filters out any
// id that no longer has a file on disk (best-effort self-healing).
export const listCanvases = async (
  projectPath: string,
): Promise<{ index: CanvasesIndex; canvases: CanvasSummary[] }> => {
  await ensureCanvasesDir(projectPath)
  const index = await readCanvasesIndex(projectPath)
  const summaries: CanvasSummary[] = []
  const liveOrder: string[] = []
  for (const id of index.order) {
    try {
      const raw = await readFile(await canvasFilePath(projectPath,id), 'utf8')
      const parsed = JSON.parse(raw) as CanvasFile
      summaries.push({
        id,
        name: parsed.name ?? 'Canvas',
        updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
      })
      liveOrder.push(id)
    } catch {
      // Missing file — drop the id silently so the index converges.
    }
  }
  // If on-disk files exist that weren't in the index (e.g. recovered from a
  // crash), surface them at the end so they aren't lost.
  try {
    const entries = await readdir(await canvasesDir(projectPath))
    for (const f of entries) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -5)
      if (liveOrder.includes(id)) continue
      try {
        const raw = await readFile(await canvasFilePath(projectPath,id), 'utf8')
        const parsed = JSON.parse(raw) as CanvasFile
        summaries.push({
          id,
          name: parsed.name ?? 'Canvas',
          updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
        })
        liveOrder.push(id)
      } catch {}
    }
  } catch {}
  let activeId = index.activeId
  if (!activeId || !liveOrder.includes(activeId)) {
    activeId = liveOrder[0] ?? null
  }
  const nextIndex: CanvasesIndex = { order: liveOrder, activeId }
  // Persist the healed index so subsequent reads don't keep paying the cost.
  const shouldRewrite =
    nextIndex.order.join(',') !== index.order.join(',') || nextIndex.activeId !== index.activeId
  if (shouldRewrite) await writeCanvasesIndex(projectPath, nextIndex)
  return { index: nextIndex, canvases: summaries }
}

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
    const { index, canvases } = await listCanvases(projectPath)
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
    const { index } = await listCanvases(projectPath)
    if (!index.order.includes(id)) {
      return { index }
    }
    const remaining = index.order.filter((x) => x !== id)
    try {
      await unlink(await canvasFilePath(projectPath,id))
    } catch {}
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
    const { index } = await listCanvases(projectPath)
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
    const { index } = await listCanvases(projectPath)
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
    await writeCanvasFile(projectPath, {
      ...canvas,
      elements: [...canvas.elements, ...placed],
    })
    return placed
  })

/** Write a tweaked source onto one screen/mock element in a canvas, server-side.
 *  Returns true when the element was found and updated; false when the canvas or
 *  element is gone (deleted mid-run). */
export const updateCanvasElementSource = (
  projectPath: string,
  canvasId: string,
  elementId: string,
  source: string,
): Promise<boolean> =>
  withCanvasFileLock(projectPath, canvasId, async () => {
    const canvas = await readCanvasFile(projectPath, canvasId)
    if (!canvas) return false
    let found = false
    const next = canvas.elements.map((el) => {
      if (el.id !== elementId) return el
      found = true
      return { ...el, text: source }
    })
    if (!found) return false
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
      const written = await writeCanvasFile(projectPath, { ...incoming, rev: currentRev })
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
