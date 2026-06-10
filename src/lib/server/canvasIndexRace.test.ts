import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createCanvas, deleteCanvas, listCanvases, readCanvasesIndex } from './canvasData'
import { registerTestProject } from '../../test/registerProject'

// Regression guard for the canvas-INDEX lost-update race. The index-mutating
// ops (createCanvas / deleteCanvas / reorderCanvases / setActiveCanvas) each do
// read-index → compute → write-index. Before serialisation, two concurrent ops
// read the same stale index and the second write clobbered the first, so a
// just-created canvas vanished from the index (orphaned on disk). withIndexLock
// serialises them per project so each observes the previous op's result.

describe('canvas index write serialisation (lost-update race)', () => {
  let projectPath: string
  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-idx-'))
    await registerTestProject(projectPath)
  })
  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('concurrent createCanvas calls all land in the index (none clobbered)', async () => {
    const N = 8
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => createCanvas(projectPath, `C${i}`)),
    )
    const createdIds = results.map((r) => r.canvas.id)
    expect(new Set(createdIds).size).toBe(N) // all distinct ids minted

    const idx = await readCanvasesIndex(projectPath)
    // The bug: concurrent read-modify-writes left only the last writer's id in
    // the index. With serialisation every created id must be present.
    for (const id of createdIds) expect(idx.order).toContain(id)
    expect(idx.order.length).toBe(N)
  })

  it('interleaved create + delete keep the index consistent with disk', async () => {
    // Seed two canvases, then concurrently create one more and delete one.
    const a = await createCanvas(projectPath, 'A')
    await createCanvas(projectPath, 'B')
    const [created] = await Promise.all([
      createCanvas(projectPath, 'C'),
      deleteCanvas(projectPath, a.canvas.id),
    ])
    const { index, canvases } = await listCanvases(projectPath)
    // The freshly created canvas survives; the deleted one is gone; the index
    // order matches the live files on disk (listCanvases reconciles), and the
    // activeId points at a live canvas.
    expect(index.order).toContain(created.canvas.id)
    expect(index.order).not.toContain(a.canvas.id)
    expect(new Set(index.order).size).toBe(index.order.length) // no dup ids
    expect(canvases.map((c) => c.id).sort()).toEqual([...index.order].sort())
    expect(index.activeId && index.order.includes(index.activeId)).toBeTruthy()
  })
})
