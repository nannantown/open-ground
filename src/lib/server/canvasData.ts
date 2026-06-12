import { cp, mkdir, readFile, readdir, rm, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { CanvasFile, CanvasSummary, CanvasesIndex } from '../types'
import { normalizeLayoutOrder } from '../canvasAutoLayout'
import { atomicWriteJson } from './atomicWrite'
import { projectDataDir } from './projectDataPath'
import { noteSharedWrite } from './shareAutoSync'
import {
  SHARED_DATA_VERSION,
  canvasAssetsDir,
  canvasAssetsRoot,
  canvasFilesDir,
  canvasIndexPath,
  isShared,
  sharedDataDir,
  sharedMarkerPath,
} from './sharedData'
import { CANVAS_ASSETS_SUFFIX } from './canvasImages'

// Canvas data lives in the project's CENTRAL OPEN GROUND data dir by default
// (~/.openground/projects/<uuid>/canvases/ + canvases-index.json), NOT in the
// user's repo.
//
// EXCEPT in git-shared mode (.openground/openground.json marker — see
// sharedData.ts / docs/SHARED_DATA_PLAN.md): then the canvas FILES and the
// canvas ORDER live inside the repo (.openground/canvas/) so collaborators
// share them through normal git, while the personal `activeId` keeps living in
// the central canvases-index.json in BOTH modes. Readers compose the two
// sources (order from the repo, activeId from central); writers split
// accordingly (create/delete/reorder touch the repo index, setActiveCanvas
// touches only central). The public API of this module is identical in both
// modes — callers never branch.
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

// ── storage location (central vs git-shared) ───────────────────────────────

const centralCanvasesDir = async (projectPath: string) =>
  join(await projectDataDir(projectPath), CANVAS_DIR)

const centralIndexPath = async (projectPath: string) =>
  join(await projectDataDir(projectPath), INDEX_FILE)

const canvasesDir = async (projectPath: string) =>
  (await isShared(projectPath))
    ? canvasFilesDir(projectPath)
    : centralCanvasesDir(projectPath)

const canvasFilePath = async (projectPath: string, id: string) =>
  join(await canvasesDir(projectPath), `${id}.json`)

const ensureCanvasesDir = async (projectPath: string) => {
  await mkdir(await canvasesDir(projectPath), { recursive: true })
}

// Raw central index read. In shared mode this file still exists and holds the
// personal activeId (plus a stale order kept as a backup for un-sharing).
const readCentralIndex = async (projectPath: string): Promise<CanvasesIndex> => {
  try {
    const raw = await readFile(await centralIndexPath(projectPath), 'utf8')
    const parsed = JSON.parse(raw)
    return { ...emptyIndex(), ...parsed }
  } catch {
    return emptyIndex()
  }
}

// Shared order read ({order: string[]} in the repo). Defensive: a hand-edited
// or merge-mangled index.json degrades to [] and listCanvases' self-healing
// rebuilds the order from the canvas files on disk.
const readSharedOrder = async (projectPath: string): Promise<string[]> => {
  try {
    const raw = await readFile(canvasIndexPath(projectPath), 'utf8')
    const order = (JSON.parse(raw) as { order?: unknown })?.order
    return Array.isArray(order) ? order.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export const readCanvasesIndex = async (projectPath: string): Promise<CanvasesIndex> => {
  await ensureCanvasesDir(projectPath)
  if (await isShared(projectPath)) {
    // Compose: shared order from the repo, personal activeId from central.
    // (activeId is validated against the live order by listCanvases — same
    // fallback logic as the central path.)
    const [order, central] = await Promise.all([
      readSharedOrder(projectPath),
      readCentralIndex(projectPath),
    ])
    return { order, activeId: central.activeId }
  }
  return readCentralIndex(projectPath)
}

// Persist ONLY the personal activeId into the central index, preserving
// whatever (stale) order the central file holds — shared mode never publishes
// activeId into the repo.
const writeCentralActiveId = async (projectPath: string, activeId: string | null) => {
  const central = await readCentralIndex(projectPath)
  if (central.activeId === activeId) return
  await mkdir(await projectDataDir(projectPath), { recursive: true })
  await atomicWriteJson(await centralIndexPath(projectPath), { ...central, activeId })
}

const writeCanvasesIndex = async (projectPath: string, idx: CanvasesIndex) => {
  await ensureCanvasesDir(projectPath)
  if (await isShared(projectPath)) {
    // Split write: order is shared through the repo; activeId stays central.
    await atomicWriteJson(canvasIndexPath(projectPath), { order: idx.order })
    await writeCentralActiveId(projectPath, idx.activeId)
    noteSharedWrite(projectPath)
    return
  }
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
    // The single read seam both central and git-shared files pass through
    // (canvasFilePath branches on the marker): converge files saved by the old
    // position-sorting auto-layout engine to the v2 array-order contract, so
    // the picture doesn't change on load. No-op (same array) on v2 files.
    return { ...canvas, elements: normalizeLayoutOrder(canvas.elements ?? []) }
  } catch {
    return null
  }
}

export const writeCanvasFile = async (
  projectPath: string,
  canvas: CanvasFile,
): Promise<CanvasFile> => {
  await ensureCanvasesDir(projectPath)
  const next: CanvasFile = { ...canvas, updatedAt: new Date().toISOString() }
  await atomicWriteJson(await canvasFilePath(projectPath,canvas.id), next)
  // In shared mode the canvas file lives in the repo — wake the auto-sync
  // engine (debounced; several strokes ride one commit).
  if (await isShared(projectPath)) noteSharedWrite(projectPath)
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
// each op observes the previous one's result. Same shape as canvasWriteQueue;
// survives HMR via globalThis. NOTE: listCanvases is a plain reader and is
// deliberately NOT wrapped — it runs *inside* these ops, so locking it would
// self-deadlock.
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
    await writeCanvasFile(projectPath, canvas)
    const nextIndex: CanvasesIndex = {
      order: [...index.order, id],
      activeId: id,
    }
    await writeCanvasesIndex(projectPath, nextIndex)
    return { index: nextIndex, canvas }
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
      await writeCanvasFile(projectPath, replacement)
      const nextIndex: CanvasesIndex = { order: [replacementId], activeId: replacementId }
      await writeCanvasesIndex(projectPath, nextIndex)
      return { index: nextIndex, createdReplacement: replacement }
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
  const canvas = await readCanvasFile(projectPath, id)
  if (!canvas) return null
  return writeCanvasFile(projectPath, { ...canvas, name: trimmed })
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
    if (await isShared(projectPath)) {
      // activeId is personal: never dirty the repo index for a tab switch.
      await writeCentralActiveId(projectPath, id)
    } else {
      await writeCanvasesIndex(projectPath, nextIndex)
    }
    return nextIndex
  })

// ── git-shared migration (canvas side) ──────────────────────────────────────
// Called by the share enable/disable routes (wired in the integration phase —
// see docs/SHARED_DATA_PLAN.md). These deliberately address the central and
// repo layouts EXPLICITLY rather than through the mode-branched helpers above:
// the marker may flip at any point around them (the board migration also
// ensures it), so the branched readers can't be trusted to point at the source
// side mid-migration. Both run under the per-project index lock so a
// concurrent canvas op can't interleave with the copy.

// The canvas-json ids present in a dir (file names minus `.json`).
const listCanvasIds = async (dir: string): Promise<string[]> => {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
  } catch {
    return []
  }
}

// `order` filtered to live ids, with any id missing from `order` appended —
// the same convergence rule listCanvases applies, so a stale index never
// drops a canvas during migration.
const orderWithLeftovers = (order: string[], ids: string[]): string[] => {
  const live = new Set(ids)
  const out = order.filter((id) => live.has(id))
  for (const id of ids) if (!out.includes(id)) out.push(id)
  return out
}

// Ensure the shared marker exists. Idempotent, and PRESERVES every field of an
// existing file (description, fields newer code may add) — the board migration
// also touches the marker, so this must be a read-then-merge, never a blind
// overwrite. A file that already carries a numeric `version` is left alone.
const ensureSharedMarker = async (projectPath: string) => {
  let existing: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(sharedMarkerPath(projectPath), 'utf-8'))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>
    }
  } catch {}
  if (typeof existing.version === 'number') return
  await mkdir(sharedDataDir(projectPath), { recursive: true })
  await atomicWriteJson(sharedMarkerPath(projectPath), {
    ...existing,
    version: SHARED_DATA_VERSION,
  })
}

/** Central canvases + index order + ALL asset dirs → repo layout
 *  (.openground/canvas/). Overwrites any stale repo canvas data, ensures the
 *  marker exists, and leaves the central files untouched as a stale backup
 *  (the marker decides the live source). Idempotent. */
export const migrateCanvasToShared = (projectPath: string): Promise<void> =>
  withIndexLock(projectPath, async () => {
    const srcDir = await centralCanvasesDir(projectPath)
    const central = await readCentralIndex(projectPath)
    const ids = await listCanvasIds(srcDir)

    // Overwrite semantics: clear any stale repo canvas layout first, so a
    // re-run (or a re-enable after a half-finished disable) converges.
    const destDir = canvasFilesDir(projectPath)
    const destAssetsRoot = canvasAssetsRoot(projectPath)
    await rm(destDir, { recursive: true, force: true })
    await rm(destAssetsRoot, { recursive: true, force: true })
    await mkdir(destDir, { recursive: true })

    for (const id of ids) {
      await cp(join(srcDir, `${id}.json`), join(destDir, `${id}.json`))
    }
    await atomicWriteJson(canvasIndexPath(projectPath), {
      order: orderWithLeftovers(central.order, ids),
    })

    // ALL central asset dirs move over — even one whose canvas json vanished:
    // better to carry a few orphan bytes than lose a referenced image.
    let entries: string[] = []
    try {
      entries = await readdir(srcDir)
    } catch {}
    for (const entry of entries) {
      if (!entry.endsWith(CANVAS_ASSETS_SUFFIX)) continue
      const canvasId = entry.slice(0, -CANVAS_ASSETS_SUFFIX.length)
      await cp(join(srcDir, entry), canvasAssetsDir(projectPath, canvasId), { recursive: true })
    }

    await ensureSharedMarker(projectPath)
  })

/** Repo layout → central (overwrite canvases/order/assets; the personal
 *  central activeId is preserved when it still points at a live canvas).
 *  Does NOT delete .openground/ or the marker — the disable route owns that,
 *  and until it does the marker keeps routing reads to the repo. */
export const migrateCanvasFromShared = (projectPath: string): Promise<void> =>
  withIndexLock(projectPath, async () => {
    const srcDir = canvasFilesDir(projectPath)
    const srcAssetsRoot = canvasAssetsRoot(projectPath)
    const sharedOrder = await readSharedOrder(projectPath)
    const ids = await listCanvasIds(srcDir)

    // Capture the personal activeId BEFORE overwriting the central layout.
    const central = await readCentralIndex(projectPath)

    const destDir = await centralCanvasesDir(projectPath)
    // Overwrite: drops the stale central canvases AND their old asset dirs
    // (assets live inside canvases/<id>-assets, so one rm covers both).
    await rm(destDir, { recursive: true, force: true })
    await mkdir(destDir, { recursive: true })

    for (const id of ids) {
      await cp(join(srcDir, `${id}.json`), join(destDir, `${id}.json`))
    }
    try {
      const assetDirs = await readdir(srcAssetsRoot, { withFileTypes: true })
      for (const d of assetDirs) {
        if (!d.isDirectory()) continue
        await cp(join(srcAssetsRoot, d.name), join(destDir, `${d.name}${CANVAS_ASSETS_SUFFIX}`), {
          recursive: true,
        })
      }
    } catch {}

    const order = orderWithLeftovers(sharedOrder, ids)
    const activeId =
      central.activeId && order.includes(central.activeId)
        ? central.activeId
        : order[0] ?? null
    await atomicWriteJson(await centralIndexPath(projectPath), { order, activeId })
  })

// Used by tests / debugging only — wipes the entire Canvases directory so
// migration runs again. Not wired to any route.
export const _resetCanvasesForTest = async (projectPath: string) => {
  try {
    await rm(await canvasesDir(projectPath), { recursive: true, force: true })
    await unlink(await centralIndexPath(projectPath))
  } catch {}
}
