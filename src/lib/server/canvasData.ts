import { mkdir, readFile, readdir, rename, rm, stat, unlink } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { CanvasElement, CanvasFile, CanvasSummary, CanvasesIndex, LegacyCanvasState } from '../types'
import { ensureOpenGroundProjectDir } from './projectMigration'
import { atomicWriteJson } from './atomicWrite'

const CANVAS_DIR = '.openground/canvases'
const INDEX_FILE = '.openground/canvases-index.json'
// Two earlier disk layouts. The legacy single-file (`ground.json`) predates
// multi-tab Canvases; the intermediate (`grounds/` directory + index) was the
// multi-tab layout before the rename to "Canvas". Both are migrated on read.
const LEGACY_SINGLE_FILE = '.openground/ground.json'
const LEGACY_DIR = '.openground/grounds'
const LEGACY_INDEX_FILE = '.openground/grounds-index.json'

const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : randomUUID()

const fileExists = async (p: string) => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

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

const canvasFilePath = (projectPath: string, id: string) =>
  join(projectPath, CANVAS_DIR, `${id}.json`)

const indexPath = (projectPath: string) => join(projectPath, INDEX_FILE)

const legacySingleFilePath = (projectPath: string) =>
  join(projectPath, LEGACY_SINGLE_FILE)
const legacyDirPath = (projectPath: string) => join(projectPath, LEGACY_DIR)
const legacyIndexPath = (projectPath: string) =>
  join(projectPath, LEGACY_INDEX_FILE)

// One-shot migration from the single `.openground/ground.json` to the per-id
// directory layout. Idempotent: runs only when the legacy file exists AND no
// canvases-index has been written yet. Promotes the legacy state into
// "Canvas 1" and removes the old file once the new files are durably written.
const migrateLegacySingleFile = async (projectPath: string) => {
  const legacy = legacySingleFilePath(projectPath)
  const idx = indexPath(projectPath)
  const hasLegacy = await fileExists(legacy)
  const hasIndex = await fileExists(idx)
  if (!hasLegacy || hasIndex) return
  let legacyState: LegacyCanvasState | null = null
  try {
    legacyState = JSON.parse(await readFile(legacy, 'utf8'))
  } catch {
    // Corrupt legacy file — drop it on the floor; the user can keep working
    // with a fresh empty Canvas rather than failing the migration.
    legacyState = null
  }
  const id = newId()
  const canvas = emptyCanvas(id, 'Canvas 1')
  if (legacyState) {
    if (legacyState.viewport) canvas.viewport = legacyState.viewport
    if (Array.isArray(legacyState.elements)) canvas.elements = legacyState.elements
  }
  await mkdir(join(projectPath, CANVAS_DIR), { recursive: true })
  await atomicWriteJson(canvasFilePath(projectPath, id), canvas)
  await atomicWriteJson(idx, { order: [id], activeId: id })
  // Remove the legacy file last — if anything above throws we keep it so the
  // next attempt can retry.
  try {
    await unlink(legacy)
  } catch {}
}

// One-shot migration from the intermediate `.openground/grounds/` + `.openground/grounds-index.json`
// layout (multi-tab, pre-Canvas-rename) to the current `.openground/canvases/` layout.
// Idempotent: only runs when the new locations don't exist yet AND a grounds
// directory or index is present. The file contents inside the directory don't
// need rewriting — the JSON shape is identical, only the directory and index
// filename change.
const migrateLegacyDir = async (projectPath: string) => {
  const newDir = join(projectPath, CANVAS_DIR)
  const newIdx = indexPath(projectPath)
  const oldDir = legacyDirPath(projectPath)
  const oldIdx = legacyIndexPath(projectPath)
  const hasOldDir = await fileExists(oldDir)
  const hasOldIdx = await fileExists(oldIdx)
  if (!hasOldDir && !hasOldIdx) return
  const hasNewDir = await fileExists(newDir)
  const hasNewIdx = await fileExists(newIdx)
  // If anything in the new layout is already present, the user has already
  // migrated (or is in the middle of one); don't touch the old layout.
  if (hasNewDir || hasNewIdx) return
  if (hasOldDir) {
    try {
      await rename(oldDir, newDir)
    } catch {
      // Cross-device rename failure is theoretically possible inside a single
      // project tree but not in practice — leave the old dir in place so the
      // next attempt can retry. The user keeps seeing their work.
      return
    }
  }
  if (hasOldIdx) {
    try {
      await rename(oldIdx, newIdx)
    } catch {}
  }
}

const ensureCanvasesDir = async (projectPath: string) => {
  await ensureOpenGroundProjectDir(projectPath)
  await migrateLegacyDir(projectPath)
  await migrateLegacySingleFile(projectPath)
  await mkdir(join(projectPath, CANVAS_DIR), { recursive: true })
}

export const readCanvasesIndex = async (projectPath: string): Promise<CanvasesIndex> => {
  await ensureCanvasesDir(projectPath)
  try {
    const raw = await readFile(indexPath(projectPath), 'utf8')
    const parsed = JSON.parse(raw)
    return { ...emptyIndex(), ...parsed }
  } catch {
    return emptyIndex()
  }
}

const writeCanvasesIndex = async (projectPath: string, idx: CanvasesIndex) => {
  await ensureCanvasesDir(projectPath)
  await atomicWriteJson(indexPath(projectPath), idx)
}

export const readCanvasFile = async (
  projectPath: string,
  id: string,
): Promise<CanvasFile | null> => {
  await ensureCanvasesDir(projectPath)
  try {
    const raw = await readFile(canvasFilePath(projectPath, id), 'utf8')
    const parsed = JSON.parse(raw) as CanvasFile
    return { ...emptyCanvas(id, parsed.name ?? 'Canvas'), ...parsed }
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
  await atomicWriteJson(canvasFilePath(projectPath, canvas.id), next)
  return next
}

// Per-canvas serial queue. Two parallel `appendCanvasElement` calls used to
// race: both would read the current file (seeing the same N elements), both
// would write back (N+1), and the second writer's append would replace the
// first writer's append → only one of the two adds survives. We serialise
// per-canvas so each append observes the result of the previous one.
// Survives HMR reloads via globalThis.
declare global {
  // eslint-disable-next-line no-var
  var __openground_canvas_writes: Map<string, Promise<unknown>> | undefined
}
const canvasWriteQueue: Map<string, Promise<unknown>> =
  globalThis.__openground_canvas_writes ??
  (globalThis.__openground_canvas_writes = new Map())

// Append a single element to a Canvas without the caller having to round-trip
// the whole file. Used by the observer when it sees a `CANVAS_ADD:` marker
// in a Canvas chat's Claude output — Claude is forbidden by CLAUDE.md from
// touching .openground/ directly, so OPEN GROUND writes on its behalf. The
// returned CanvasFile reflects the post-append state for the UI to refresh on.
export const appendCanvasElement = async (
  projectPath: string,
  canvasId: string,
  element: CanvasElement,
): Promise<CanvasFile | null> => {
  const key = `${projectPath}::${canvasId}`
  const prev = canvasWriteQueue.get(key) ?? Promise.resolve()
  const myRun = prev.then(async () => {
    const current = await readCanvasFile(projectPath, canvasId)
    if (!current) return null
    // Guard against id collisions (Claude can pick its own id, but we don't
    // want to silently overwrite an existing element). Force a new id if the
    // requested one is already in use.
    const used = new Set(current.elements.map((e) => e.id))
    let safeId = element.id
    if (used.has(safeId)) {
      // Suffix until we find a genuinely-unused id — the old `${id}-${len+1}`
      // could itself collide (e.g. an existing "x-3"), producing two elements
      // with the same id.
      let n = current.elements.length + 1
      while (used.has(`${element.id}-${n}`)) n += 1
      safeId = `${element.id}-${n}`
    }
    // Comment-anchor integrity: a CANVAS_ADD comment may name an `anchorId`,
    // but the observer can't verify the target exists (it fires-and-forgets
    // without reading the file). Drop the anchorId here if no element in the
    // Canvas actually carries that id, so we never persist a dangling pin.
    const safeElement =
      element.type === 'comment' && element.anchorId && !used.has(element.anchorId)
        ? (() => {
            const { anchorId: _drop, ...rest } = element
            return rest as CanvasElement
          })()
        : element
    const next: CanvasFile = {
      ...current,
      updatedAt: new Date().toISOString(),
      elements: [...current.elements, { ...safeElement, id: safeId }],
    }
    await atomicWriteJson(canvasFilePath(projectPath, canvasId), next)
    return next
  })
  // Keep the queue advancing even when one step throws — otherwise a bad
  // element JSON would deadlock every subsequent append for that canvas.
  canvasWriteQueue.set(key, myRun.catch(() => undefined))
  return myRun
}

// Patch an existing element in place by id (partial merge). Used by the
// observer for a `CANVAS_UPDATE:` marker so Claude can iterate on an element
// it (or the user) already created — e.g. rewrite a screen's source — instead
// of stacking a duplicate. `type` and `id` are never changed. Returns the
// post-update file, or null when the canvas or the element id is missing.
export const updateCanvasElement = async (
  projectPath: string,
  canvasId: string,
  elementId: string,
  patch: Partial<CanvasElement>,
): Promise<CanvasFile | null> => {
  const key = `${projectPath}::${canvasId}`
  const prev = canvasWriteQueue.get(key) ?? Promise.resolve()
  const myRun = prev.then(async () => {
    const current = await readCanvasFile(projectPath, canvasId)
    if (!current) return null
    const idx = current.elements.findIndex((e) => e.id === elementId)
    if (idx < 0) return null
    const existing = current.elements[idx]
    // Drop type-inappropriate fields so an update can't smear screen/mock-only
    // keys onto a sticky/text/frame (mirrors the type-gating CANVAS_ADD does).
    const safe = { ...patch }
    if (existing.type !== 'mock' && existing.type !== 'screen') {
      delete safe.framework
      delete safe.theme
    }
    if (existing.type !== 'screen') {
      delete safe.chrome
      delete safe.scrollable
      delete safe.props
    }
    // id / type are immutable; everything else is a shallow overwrite.
    const merged: CanvasElement = { ...existing, ...safe, id: existing.id, type: existing.type }
    const elements = current.elements.slice()
    elements[idx] = merged
    const next: CanvasFile = {
      ...current,
      updatedAt: new Date().toISOString(),
      elements,
    }
    await atomicWriteJson(canvasFilePath(projectPath, canvasId), next)
    return next
  })
  canvasWriteQueue.set(key, myRun.catch(() => undefined))
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
      const raw = await readFile(canvasFilePath(projectPath, id), 'utf8')
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
    const entries = await readdir(join(projectPath, CANVAS_DIR))
    for (const f of entries) {
      if (!f.endsWith('.json')) continue
      const id = f.slice(0, -5)
      if (liveOrder.includes(id)) continue
      try {
        const raw = await readFile(canvasFilePath(projectPath, id), 'utf8')
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

export const createCanvas = async (
  projectPath: string,
  name?: string,
): Promise<{ index: CanvasesIndex; canvas: CanvasFile }> => {
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
}

// Removing the last Canvas is treated as "reset" rather than an error: a fresh
// empty Canvas takes its place so the user never sees a Canvas tab bar with
// zero tabs.
export const deleteCanvas = async (
  projectPath: string,
  id: string,
): Promise<{ index: CanvasesIndex; createdReplacement?: CanvasFile }> => {
  await ensureCanvasesDir(projectPath)
  const { index } = await listCanvases(projectPath)
  if (!index.order.includes(id)) {
    return { index }
  }
  const remaining = index.order.filter((x) => x !== id)
  try {
    await unlink(canvasFilePath(projectPath, id))
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
}

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

export const reorderCanvases = async (
  projectPath: string,
  order: string[],
): Promise<CanvasesIndex> => {
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
}

export const setActiveCanvas = async (
  projectPath: string,
  id: string,
): Promise<CanvasesIndex> => {
  const { index } = await listCanvases(projectPath)
  if (!index.order.includes(id)) return index
  const nextIndex: CanvasesIndex = { ...index, activeId: id }
  await writeCanvasesIndex(projectPath, nextIndex)
  return nextIndex
}

// Used by tests / debugging only — wipes the entire Canvases directory so
// migration runs again. Not wired to any route.
export const _resetCanvasesForTest = async (projectPath: string) => {
  try {
    await rm(join(projectPath, CANVAS_DIR), { recursive: true, force: true })
    await unlink(indexPath(projectPath))
  } catch {}
}
