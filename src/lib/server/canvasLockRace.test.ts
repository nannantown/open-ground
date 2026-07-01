import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Deterministic regressions for the canvas-locking fixes in canvasData.ts:
//   (1) ghost-canvas — a Canvas AI write (appendCanvasElements) that read a
//       canvas just BEFORE it is deleted must not write it back AFTER the delete
//       and resurrect it (the deleteCanvas-unlink-under-file-lock fix);
//   (3) activeId rollback — the GET-path self-heal (the public listCanvases,
//       which persists its heal) must not write back a pre-create snapshot's
//       activeId and clobber a concurrent createCanvas (the heal now runs under
//       withIndexLock instead of lock-free).
//
// Both races are timing-dependent, so a naive Promise.all wouldn't reliably hit
// the bug interleaving (and so wouldn't have teeth). We force the exact ordering
// with a one-shot GATE over fs/promises.readFile: when armed, the next read whose
// path matches resolves its bytes, flips `hit`, then BLOCKS (holding whatever
// lock its caller holds) until the test releases it. Every other read passes
// straight through, so the rest of the module graph is unaffected.
// HOME is tmpdir-isolated (setup-home.ts); all writes land there.

const gate: {
  pauseSuffix: string | null
  hit: boolean
  released: Promise<void> | null
  release: (() => void) | null
} = { pauseSuffix: null, hit: false, released: null, release: null }

vi.mock('fs/promises', async (importActual) => {
  const actual = await importActual<typeof import('fs/promises')>()
  return {
    ...actual,
    // Pause AFTER the real bytes are read, so a paused appendCanvasElements still
    // holds the canvas content it will (in the buggy ordering) write back.
    readFile: vi.fn(async (path: unknown, ...rest: unknown[]) => {
      const bytes = await (actual.readFile as (...a: unknown[]) => Promise<unknown>)(path, ...rest)
      if (gate.pauseSuffix && typeof path === 'string' && path.endsWith(gate.pauseSuffix)) {
        gate.pauseSuffix = null // one-shot: only the first matching read pauses
        gate.hit = true
        if (gate.released) await gate.released
      }
      return bytes
    }),
  }
})

// mkdtemp / rm resolve to the REAL impls via the {...actual} spread above.
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createCanvas,
  deleteCanvas,
  appendCanvasElements,
  listCanvases,
  readCanvasesIndex,
} from './canvasData'
import { registerTestProject } from '../../test/registerProject'
import type { CanvasElement } from '@/lib/types'

const txt = (id: string, x = 0, y = 0): CanvasElement => ({ id, type: 'text', x, y, text: id })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const arm = (suffix: string) => {
  gate.hit = false
  gate.pauseSuffix = suffix
  gate.released = new Promise<void>((r) => {
    gate.release = r
  })
}
const release = () => gate.release?.()
const waitForHit = async () => {
  for (let i = 0; i < 600; i++) {
    if (gate.hit) return
    await sleep(5)
  }
  throw new Error('gated read was never reached')
}

describe('canvas locking — deterministic race regressions', () => {
  let projectPath: string
  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-lock-'))
    await registerTestProject(projectPath)
  })
  afterEach(async () => {
    // Disarm + release so a failed assertion can never wedge the next test.
    gate.pauseSuffix = null
    release()
    gate.released = null
    gate.release = null
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('a Canvas AI append racing a delete does not revive the deleted canvas', async () => {
    const keep = await createCanvas(projectPath, 'Keep')
    const target = await createCanvas(projectPath, 'Target')
    const id = target.canvas.id

    // Pause the append AFTER it has read the target canvas: it now holds the
    // per-canvas file lock with the content in hand, about to write it back.
    arm(`${id}.json`)
    const appendP = appendCanvasElements(projectPath, id, [txt('ai-1')]).catch((e) => e)
    await waitForHit()

    // Now run the delete. With the fix it BLOCKS on the file lock the paused
    // append holds (so awaiting it here would hang); without the fix it unlinks
    // freely and finishes. Poll until either the canvas leaves the on-disk index
    // (delete completed — the buggy path) or a cap elapses (delete is blocked —
    // already fixed), THEN release the append.
    const deleteP = deleteCanvas(projectPath, id).catch((e) => e)
    for (let i = 0; i < 60; i++) {
      const idx = await readCanvasesIndex(projectPath)
      if (!idx.order.includes(id)) break
      await sleep(5)
    }
    release()
    await Promise.all([appendP, deleteP])

    // The deleted canvas must be gone — not resurfaced by the orphan scan, and
    // not lingering in the index. Buggy ordering re-creates the .json after the
    // unlink, which listCanvases would revive (with assets already gone).
    const { index, canvases } = await listCanvases(projectPath)
    expect(index.order).not.toContain(id)
    expect(canvases.map((c) => c.id)).not.toContain(id)
    expect(index.order).toContain(keep.canvas.id)
  })

  it('the GET-path self-heal does not roll back a concurrent create activeId', async () => {
    await createCanvas(projectPath, 'Keep')
    const x = await createCanvas(projectPath, 'X') // activeId is now X

    // Pause listCanvases (the public, persisting GET read) AFTER it reads the
    // index (snapshot activeId = X), before its disk scan / persist.
    arm('canvases-index.json')
    const listP = listCanvases(projectPath)
    await waitForHit()

    // A concurrent create lands Y and sets activeId = Y. With the fix it
    // serialises behind the index-locked self-heal; without it, it races ahead
    // and the stale self-heal then writes activeId back to X.
    const createP = createCanvas(projectPath, 'Y')
    await sleep(40)
    release()
    const [, created] = await Promise.all([listP, createP])

    const idx = await readCanvasesIndex(projectPath)
    expect(idx.activeId).toBe(created.canvas.id) // Y — not rolled back to X
    expect(idx.order).toContain(x.canvas.id)
    expect(idx.order).toContain(created.canvas.id)
  })
})
