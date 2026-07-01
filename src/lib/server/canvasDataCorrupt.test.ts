import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createCanvas,
  readCanvasFile,
  saveCanvasFile,
  listCanvases,
  readCanvasesIndex,
} from './canvasData'
import { projectDataDir } from './projectDataPath'
import { registerTestProject } from '../../test/registerProject'
import type { CanvasElement, CanvasFile } from '@/lib/types'

// Goal condition (2) for the Canvas store: a corrupt canvas file / index must be
// TOLERATED — readers recover (null / empty / coerced) instead of crashing, and
// a corrupt canvas file is QUARANTINED rather than clobbered on the next save.
// HOME is tmpdir-isolated (setup-home.ts).

const txt = (id: string, x = 0, y = 0): CanvasElement => ({ id, type: 'text', x, y, text: id })

const canvasOf = (id: string, over: Partial<CanvasFile> = {}): CanvasFile => ({
  id,
  name: 'X',
  rev: 0,
  viewport: { x: 0, y: 0, zoom: 1 },
  elements: [],
  chats: [],
  activeChatId: null,
  sidebarOpen: false,
  sidebarWidth: null,
  createdAt: '',
  updatedAt: '',
  ...over,
})

describe('canvas store — corrupt file & index resilience', () => {
  let projectPath: string
  let canvasesDir: string
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-corrupt-'))
    await registerTestProject(projectPath)
    canvasesDir = join(await projectDataDir(projectPath), 'canvases')
    await mkdir(canvasesDir, { recursive: true })
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(async () => {
    warn.mockRestore()
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
    await rm(await projectDataDir(projectPath), { recursive: true, force: true }).catch(() => {})
  })

  const seedCanvasRaw = async (id: string, raw: string) => {
    await writeFile(join(canvasesDir, `${id}.json`), raw, 'utf8')
  }
  const seedIndexRaw = async (raw: string) => {
    await writeFile(join(await projectDataDir(projectPath), 'canvases-index.json'), raw, 'utf8')
  }
  const corruptSiblings = async (id: string) =>
    (await readdir(canvasesDir)).filter((f) => f.startsWith(`${id}.corrupt-`) && f.endsWith('.json'))

  it('readCanvasFile returns null (not a crash) for an unparseable file, leaving it on disk', async () => {
    await seedCanvasRaw('c1', '{ broken json ::::')
    expect(await readCanvasFile(projectPath, 'c1')).toBeNull()
    // A READ never destroys it (quarantine happens on WRITE).
    expect(await readFile(join(canvasesDir, 'c1.json'), 'utf8')).toBe('{ broken json ::::')
  })

  it('readCanvasFile returns null for a non-object canvas file (no key pollution / null deref)', async () => {
    for (const raw of ['"a string"', '[1,2,3]', 'null', '42']) {
      await seedCanvasRaw('c2', raw)
      expect(await readCanvasFile(projectPath, 'c2')).toBeNull()
    }
  })

  it('readCanvasFile coerces a non-array `elements` to [] instead of crashing normalizeLayoutOrder', async () => {
    await seedCanvasRaw('c3', JSON.stringify({ id: 'c3', name: 'N', rev: 5, elements: 'not-an-array' }))
    const out = await readCanvasFile(projectPath, 'c3')
    expect(out).not.toBeNull()
    expect(out?.elements).toEqual([])
    expect(out?.rev).toBe(5) // the rest of the valid file is preserved
  })

  it('readCanvasFile coerces a non-string `name` to a default (no downstream string-op crash)', async () => {
    await seedCanvasRaw('c4', JSON.stringify({ id: 'c4', name: 123, rev: 1, elements: [] }))
    const out = await readCanvasFile(projectPath, 'c4')
    expect(out).not.toBeNull()
    expect(typeof out?.name).toBe('string')
    expect(out?.name).toBe('Canvas')
  })

  it('readCanvasesIndex coerces a non-array `order` / non-string `activeId` to safe defaults', async () => {
    await seedIndexRaw(JSON.stringify({ order: 'garbage', activeId: 123 }))
    const idx = await readCanvasesIndex(projectPath)
    expect(Array.isArray(idx.order)).toBe(true)
    expect(idx.order).toEqual([])
    expect(idx.activeId).toBeNull()
  })

  it('listCanvases survives a corrupt index by recovering the real canvas files from disk', async () => {
    const a = await createCanvas(projectPath, 'A')
    const b = await createCanvas(projectPath, 'B')
    // Corrupt the index AFTER the real files exist on disk.
    await seedIndexRaw('{ "order": "garbage", "activeId": 999 }')
    const { index, canvases } = await listCanvases(projectPath)
    // No crash; both real canvases are recovered via the on-disk orphan scan.
    expect(canvases.map((c) => c.id).sort()).toEqual([a.canvas.id, b.canvas.id].sort())
    expect(index.order.sort()).toEqual([a.canvas.id, b.canvas.id].sort())
    expect(index.activeId && index.order.includes(index.activeId)).toBeTruthy()
  })

  it('a non-iterable `order` (number/object) does not 500 — ops fall back to the disk scan', async () => {
    // The sharp case behind goal condition (2): a hand-corrupted index whose
    // `order` is a NUMBER makes the old `for (const id of index.order)` throw
    // "0 is not iterable", 500-ing every Canvas operation. readCentralIndex now
    // coerces it to [], so both the GET (listCanvases) and a mutating op
    // (createCanvas) recover via the on-disk orphan scan instead of throwing.
    const good = await createCanvas(projectPath, 'Good')
    await seedIndexRaw('{ "order": 0, "activeId": false }')
    const listed = await listCanvases(projectPath)
    expect(listed.canvases.map((c) => c.id)).toContain(good.canvas.id)
    // A mutating op survives the same malformed index (it lists internally first).
    const made = await createCanvas(projectPath, 'After')
    const { index } = await listCanvases(projectPath)
    expect(index.order).toContain(good.canvas.id)
    expect(index.order).toContain(made.canvas.id)
  })

  it('listCanvases drops a corrupt canvas but keeps the valid ones (no loss of healthy data)', async () => {
    const good = await createCanvas(projectPath, 'Good')
    // A corrupt file present on disk + listed in the index.
    await seedCanvasRaw('broken', '{ not json')
    await seedIndexRaw(JSON.stringify({ order: [good.canvas.id, 'broken'], activeId: good.canvas.id }))
    const { canvases } = await listCanvases(projectPath)
    expect(canvases.map((c) => c.id)).toEqual([good.canvas.id])
  })

  it('saveCanvasFile quarantines a corrupt canvas file instead of clobbering it', async () => {
    const corrupt = '{ corrupt canvas the user may want back :::'
    await seedCanvasRaw('c9', corrupt)
    // readCanvasFile sees null (corrupt), so saveCanvasFile would treat it as a
    // brand-new first write — it must preserve the corrupt bytes first.
    const out = await saveCanvasFile(projectPath, canvasOf('c9', { elements: [txt('fresh')] }))
    expect(out.ok).toBe(true)
    // The fresh canvas landed…
    expect((await readCanvasFile(projectPath, 'c9'))?.elements.map((e) => e.id)).toEqual(['fresh'])
    // …and the corrupt original was moved aside, not destroyed.
    const siblings = await corruptSiblings('c9')
    expect(siblings).toHaveLength(1)
    expect(await readFile(join(canvasesDir, siblings[0]), 'utf8')).toBe(corrupt)
  })

  it('a genuinely-new canvas save creates no quarantine sibling (no churn on the happy path)', async () => {
    const out = await saveCanvasFile(projectPath, canvasOf('brand-new', { elements: [txt('x')] }))
    expect(out.ok).toBe(true)
    expect(await corruptSiblings('brand-new')).toEqual([])
  })
})
