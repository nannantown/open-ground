import { mkdir, readFile, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { CanvasFile, CanvasSummary, CanvasesIndex } from '../types'
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
    // (same array) on v2 files.
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
    await writeCanvasesIndex(projectPath, nextIndex)
    return nextIndex
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
