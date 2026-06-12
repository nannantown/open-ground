import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { CanvasElement } from '../types'
import {
  createCanvas,
  deleteCanvas,
  listCanvases,
  migrateCanvasFromShared,
  migrateCanvasToShared,
  readCanvasFile,
  readCanvasesIndex,
  renameCanvas,
  reorderCanvases,
  setActiveCanvas,
  writeCanvasFile,
} from './canvasData'
import {
  deleteCanvasAsset,
  pruneCanvasAssets,
  readCanvasAsset,
  writeCanvasAsset,
} from './canvasImages'
import {
  SHARED_DIR,
  canvasAssetsDir,
  canvasFilesDir,
  canvasIndexPath,
  sharedMarkerPath,
  writeSharedMarker,
} from './sharedData'
import { projectDataDir } from './projectDataPath'
import { registerTestProject } from '../../test/registerProject'

// Track B — the canvas storage adapter for git-shared mode. When a project
// carries the .openground marker, canvas FILES + ORDER live in the repo
// (.openground/canvas/) while the personal activeId stays in the central
// canvases-index.json; without the marker everything stays central exactly as
// before. The module's public API is identical in both modes.
//
// HOME is isolated by src/test/setup-home.ts (OPENGROUND_HOME → tmpdir), so
// the "central" store here is a throwaway dir, never the real ~/.openground.

const centralIndexPathOf = async (dir: string) =>
  join(await projectDataDir(dir), 'canvases-index.json')

const centralCanvasJsonOf = async (dir: string, id: string) =>
  join(await projectDataDir(dir), 'canvases', `${id}.json`)

const centralAssetsDirOf = async (dir: string, canvasId: string) =>
  join(await projectDataDir(dir), 'canvases', `${canvasId}-assets`)

const enableSharedMarker = async (dir: string) => {
  await mkdir(join(dir, SHARED_DIR), { recursive: true })
  await writeSharedMarker(dir, { version: 1 })
}

// Loose shape covering every JSON file these tests inspect (repo/central
// canvas indexes, the shared marker, canvas files).
type LooseJson = {
  order?: string[]
  activeId?: string | null
  version?: number
  name?: string
  description?: string
  custom?: number
}
const readJson = async (path: string): Promise<LooseJson> =>
  JSON.parse(await readFile(path, 'utf8')) as LooseJson

// A minimal image element — only the fields the asset GC looks at matter here.
const imageEl = (assetId: string): CanvasElement =>
  ({ id: randomUUID(), type: 'image', assetId } as unknown as CanvasElement)

// Binary payload with non-UTF8 bytes (PNG-ish header + the full byte range) so
// a lossy text-mode copy in the migration would be caught.
const binaryBytes = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
  ])

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'og-canvas-shared-'))
  await registerTestProject(dir)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

describe('canvas CRUD in git-shared mode (repo layout)', () => {
  beforeEach(() => enableSharedMarker(dir))

  it('create/save/rename/reorder/delete round-trip through .openground/canvas/', async () => {
    const a = await createCanvas(dir, 'A')
    const b = await createCanvas(dir, 'B')

    // Canvas files land in the repo, not in the central store.
    expect(existsSync(join(canvasFilesDir(dir), `${a.canvas.id}.json`))).toBe(true)
    expect(existsSync(join(canvasFilesDir(dir), `${b.canvas.id}.json`))).toBe(true)
    expect(existsSync(await centralCanvasJsonOf(dir, a.canvas.id))).toBe(false)

    // The repo index shares the ORDER only.
    const repoIdx = await readJson(canvasIndexPath(dir))
    expect(repoIdx).toEqual({ order: [a.canvas.id, b.canvas.id] })

    // save (full CanvasFile write) round-trips through the repo file.
    await writeCanvasFile(dir, { ...a.canvas, elements: [imageEl(randomUUID())] })
    const reread = await readCanvasFile(dir, a.canvas.id)
    expect(reread?.elements).toHaveLength(1)

    // rename
    await renameCanvas(dir, a.canvas.id, 'Renamed')
    expect((await readCanvasFile(dir, a.canvas.id))?.name).toBe('Renamed')

    // reorder updates the repo index
    await reorderCanvases(dir, [b.canvas.id, a.canvas.id])
    expect((await readJson(canvasIndexPath(dir))).order).toEqual([b.canvas.id, a.canvas.id])

    // delete removes the repo file and the id from the repo order
    await deleteCanvas(dir, a.canvas.id)
    expect(existsSync(join(canvasFilesDir(dir), `${a.canvas.id}.json`))).toBe(false)
    expect((await readJson(canvasIndexPath(dir))).order).toEqual([b.canvas.id])
  })

  it('activeId stays central; setActiveCanvas never touches the repo index', async () => {
    const a = await createCanvas(dir, 'A')
    await createCanvas(dir, 'B') // active is now B

    const repoIdxFile = canvasIndexPath(dir)
    const before = await stat(repoIdxFile)
    expect('activeId' in (await readJson(repoIdxFile))).toBe(false)

    const next = await setActiveCanvas(dir, a.canvas.id)
    expect(next.activeId).toBe(a.canvas.id)

    // The repo index was not rewritten (no git dirt from a personal tab
    // switch) and still carries no activeId.
    const after = await stat(repoIdxFile)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect('activeId' in (await readJson(repoIdxFile))).toBe(false)

    // The personal activeId landed in the CENTRAL index.
    expect((await readJson(await centralIndexPathOf(dir))).activeId).toBe(a.canvas.id)

    // The composed read: order from repo, activeId from central.
    const composed = await readCanvasesIndex(dir)
    expect(composed.order).toHaveLength(2)
    expect(composed.activeId).toBe(a.canvas.id)
  })

  it('a stale central activeId falls back to the first live canvas', async () => {
    const a = await createCanvas(dir, 'A')
    await createCanvas(dir, 'B')
    // Simulate a central activeId pointing at a canvas that no longer exists
    // (e.g. a teammate deleted it and we pulled).
    await writeFile(
      await centralIndexPathOf(dir),
      JSON.stringify({ order: [], activeId: 'dead-id' }),
      'utf8',
    )
    const { index } = await listCanvases(dir)
    expect(index.order[0]).toBe(a.canvas.id)
    expect(index.activeId).toBe(a.canvas.id)
  })
})

describe('canvas assets in git-shared mode', () => {
  beforeEach(() => enableSharedMarker(dir))

  it('write/read/delete go through .openground/canvas/assets/<canvasId>/', async () => {
    const { canvas } = await createCanvas(dir, 'A')
    const assetId = randomUUID()
    const bytes = binaryBytes()

    await writeCanvasAsset(dir, canvas.id, assetId, 'image/png', bytes)
    const onDisk = join(canvasAssetsDir(dir, canvas.id), `${assetId}.png`)
    expect(existsSync(onDisk)).toBe(true)
    expect((await readFile(onDisk)).equals(bytes)).toBe(true)
    // Nothing landed in the central layout.
    expect(existsSync(await centralAssetsDirOf(dir, canvas.id))).toBe(false)

    const read = await readCanvasAsset(dir, canvas.id, assetId)
    expect(read?.mime).toBe('image/png')
    expect(read?.data.equals(bytes)).toBe(true)

    await deleteCanvasAsset(dir, canvas.id, assetId)
    expect(await readCanvasAsset(dir, canvas.id, assetId)).toBeNull()
  })

  it('pruneCanvasAssets reaps unreferenced old files but keeps referenced ones', async () => {
    const { canvas } = await createCanvas(dir, 'A')
    const keepId = randomUUID()
    const reapId = randomUUID()
    await writeCanvasAsset(dir, canvas.id, keepId, 'image/png', binaryBytes())
    await writeCanvasAsset(dir, canvas.id, reapId, 'image/png', binaryBytes())
    // Backdate both past the GC grace period.
    const old = new Date(Date.now() - 10 * 60 * 1000)
    for (const id of [keepId, reapId]) {
      await utimes(join(canvasAssetsDir(dir, canvas.id), `${id}.png`), old, old)
    }

    await pruneCanvasAssets(dir, canvas.id, { ...canvas, elements: [imageEl(keepId)] })
    expect(await readCanvasAsset(dir, canvas.id, keepId)).not.toBeNull()
    expect(await readCanvasAsset(dir, canvas.id, reapId)).toBeNull()
  })

  it('deleteCanvas cascades the shared assets dir', async () => {
    const { canvas } = await createCanvas(dir, 'A')
    await writeCanvasAsset(dir, canvas.id, randomUUID(), 'image/png', binaryBytes())
    expect(existsSync(canvasAssetsDir(dir, canvas.id))).toBe(true)
    await deleteCanvas(dir, canvas.id)
    expect(existsSync(canvasAssetsDir(dir, canvas.id))).toBe(false)
  })
})

describe('migration central → shared', () => {
  it('moves canvases, order and binary assets into the repo; marker appears', async () => {
    const a = await createCanvas(dir, 'First')
    const b = await createCanvas(dir, 'Second')
    await setActiveCanvas(dir, a.canvas.id)
    const assetId = randomUUID()
    const bytes = binaryBytes()
    await writeCanvasAsset(dir, a.canvas.id, assetId, 'image/png', bytes) // central (not shared yet)

    await migrateCanvasToShared(dir)

    // Marker exists with the schema version.
    expect((await readJson(sharedMarkerPath(dir))).version).toBe(1)
    // Repo layout holds the canvases, the order, and the binary asset.
    expect(existsSync(join(canvasFilesDir(dir), `${a.canvas.id}.json`))).toBe(true)
    expect(existsSync(join(canvasFilesDir(dir), `${b.canvas.id}.json`))).toBe(true)
    expect((await readJson(canvasIndexPath(dir))).order).toEqual([a.canvas.id, b.canvas.id])
    const migrated = await readFile(join(canvasAssetsDir(dir, a.canvas.id), `${assetId}.png`))
    expect(migrated.equals(bytes)).toBe(true)

    // The public API now transparently reads the repo…
    const { index, canvases } = await listCanvases(dir)
    expect(canvases.map((c) => c.name)).toEqual(['First', 'Second'])
    // …while the personal activeId still comes from central.
    expect(index.activeId).toBe(a.canvas.id)
    const asset = await readCanvasAsset(dir, a.canvas.id, assetId)
    expect(asset?.data.equals(bytes)).toBe(true)

    // Central files stay behind as a stale backup (the marker decides).
    expect(existsSync(await centralCanvasJsonOf(dir, a.canvas.id))).toBe(true)
  })

  it('is idempotent and preserves unknown fields of an existing marker', async () => {
    // Track A's board migration may have written the marker first — with a
    // description and fields newer code might add. Ours must merge, not clobber.
    await mkdir(join(dir, SHARED_DIR), { recursive: true })
    await writeFile(
      sharedMarkerPath(dir),
      JSON.stringify({ description: 'keep me', custom: 42 }), // no version yet ⇒ not shared
      'utf8',
    )
    await createCanvas(dir, 'Solo') // central — marker isn't valid yet

    await migrateCanvasToShared(dir)
    await migrateCanvasToShared(dir) // idempotent re-run

    const marker = await readJson(sharedMarkerPath(dir))
    expect(marker).toEqual({ description: 'keep me', custom: 42, version: 1 })
    const { canvases } = await listCanvases(dir)
    expect(canvases.map((c) => c.name)).toEqual(['Solo'])
  })
})

describe('migration shared → central (round-trip)', () => {
  it('copies repo data back, preserves a still-valid activeId and binary assets, keeps .openground', async () => {
    // Seed central, go shared, then do some work IN shared mode.
    const a = await createCanvas(dir, 'First')
    const b = await createCanvas(dir, 'Second')
    await setActiveCanvas(dir, a.canvas.id)
    const assetId = randomUUID()
    const bytes = binaryBytes()
    await writeCanvasAsset(dir, a.canvas.id, assetId, 'image/png', bytes)
    await migrateCanvasToShared(dir)
    await renameCanvas(dir, b.canvas.id, 'Second v2')
    const c = await createCanvas(dir, 'Third') // exists only in the repo

    await migrateCanvasFromShared(dir)

    // .openground (and the marker) are NOT deleted — the disable route owns that.
    expect(existsSync(sharedMarkerPath(dir))).toBe(true)
    // Central layout now holds everything, including the shared-mode edits.
    expect((await readJson(await centralCanvasJsonOf(dir, b.canvas.id))).name).toBe('Second v2')
    expect(existsSync(await centralCanvasJsonOf(dir, c.canvas.id))).toBe(true)
    const centralIdx = await readJson(await centralIndexPathOf(dir))
    expect(centralIdx.order).toEqual([a.canvas.id, b.canvas.id, c.canvas.id])
    // createCanvas('Third') activated it (activeId is personal/central even in
    // shared mode) — still valid after the migration ⇒ preserved as-is.
    expect(centralIdx.activeId).toBe(c.canvas.id)
    const centralAsset = await readFile(
      join(await centralAssetsDirOf(dir, a.canvas.id), `${assetId}.png`),
    )
    expect(centralAsset.equals(bytes)).toBe(true)

    // Simulate the disable route removing the folder: central mode resumes
    // with the migrated data fully readable through the public API.
    await rm(join(dir, SHARED_DIR), { recursive: true, force: true })
    const { index, canvases } = await listCanvases(dir)
    expect(canvases.map((x) => x.name)).toEqual(['First', 'Second v2', 'Third'])
    expect(index.activeId).toBe(c.canvas.id)
    expect((await readCanvasAsset(dir, a.canvas.id, assetId))?.data.equals(bytes)).toBe(true)
  })

  it('falls back to the first canvas when the central activeId died while shared', async () => {
    const a = await createCanvas(dir, 'First')
    const b = await createCanvas(dir, 'Second')
    await setActiveCanvas(dir, a.canvas.id)
    await migrateCanvasToShared(dir)
    await deleteCanvas(dir, a.canvas.id) // the active one disappears in shared mode

    await migrateCanvasFromShared(dir)
    const centralIdx = await readJson(await centralIndexPathOf(dir))
    expect(centralIdx.order).toEqual([b.canvas.id])
    expect(centralIdx.activeId).toBe(b.canvas.id)
  })
})

describe('read-time layout-order normalization', () => {
  // applyAutoLayout v2 flows layout children in ARRAY order; files saved by
  // the old engine guaranteed only POSITION order. readCanvasFile — the one
  // seam both central and git-shared reads pass through — converges them via
  // normalizeLayoutOrder so the picture doesn't change on load. The write
  // path stores elements as-is.
  const positionSortedEls = (): CanvasElement[] => [
    {
      id: 'f',
      type: 'frame',
      x: 0,
      y: 0,
      width: 500,
      height: 300,
      text: '',
      layout: { mode: 'row', gap: 10, padding: 20, align: 'start' },
    },
    { id: 'b', type: 'sticky', parentId: 'f', x: 300, y: 20, width: 60, height: 60, text: '' },
    { id: 'a', type: 'sticky', parentId: 'f', x: 100, y: 20, width: 60, height: 60, text: '' },
  ]

  it('central mode: readCanvasFile returns layout children in main-axis order', async () => {
    const { canvas } = await createCanvas(dir, 'A')
    await writeCanvasFile(dir, { ...canvas, elements: positionSortedEls() })
    const read = await readCanvasFile(dir, canvas.id)
    expect(read?.elements.map((e) => e.id)).toEqual(['f', 'a', 'b'])
  })

  it('git-shared mode: the same normalization applies through the repo layout', async () => {
    await enableSharedMarker(dir)
    const { canvas } = await createCanvas(dir, 'A')
    await writeCanvasFile(dir, { ...canvas, elements: positionSortedEls() })
    const read = await readCanvasFile(dir, canvas.id)
    expect(read?.elements.map((e) => e.id)).toEqual(['f', 'a', 'b'])
  })

  it('canvases without layout frames come back in saved order', async () => {
    const { canvas } = await createCanvas(dir, 'A')
    const els = positionSortedEls().map(({ layout: _layout, ...rest }) => rest as CanvasElement)
    await writeCanvasFile(dir, { ...canvas, elements: els })
    const read = await readCanvasFile(dir, canvas.id)
    expect(read?.elements.map((e) => e.id)).toEqual(['f', 'b', 'a'])
  })
})

describe('non-shared regression (no marker)', () => {
  it('full CRUD + assets stay central and never create .openground in the repo', async () => {
    const a = await createCanvas(dir, 'A')
    const b = await createCanvas(dir, 'B')
    await writeCanvasFile(dir, { ...a.canvas, elements: [imageEl(randomUUID())] })
    await renameCanvas(dir, a.canvas.id, 'Renamed')
    await reorderCanvases(dir, [b.canvas.id, a.canvas.id])
    await setActiveCanvas(dir, a.canvas.id)
    const assetId = randomUUID()
    await writeCanvasAsset(dir, a.canvas.id, assetId, 'image/png', binaryBytes())
    expect(await readCanvasAsset(dir, a.canvas.id, assetId)).not.toBeNull()
    await deleteCanvas(dir, b.canvas.id)

    // Everything above lived in the central store…
    expect(existsSync(await centralCanvasJsonOf(dir, a.canvas.id))).toBe(true)
    const idx = await readJson(await centralIndexPathOf(dir))
    expect(idx).toEqual({ order: [a.canvas.id], activeId: a.canvas.id })
    expect(existsSync(join(await centralAssetsDirOf(dir, a.canvas.id), `${assetId}.png`))).toBe(
      true,
    )
    // …and the project folder stayed free of OPEN GROUND files.
    expect(existsSync(join(dir, SHARED_DIR))).toBe(false)
  })
})
