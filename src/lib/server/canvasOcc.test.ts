// canvasOcc.test.ts — the SERVER side of Canvas optimistic concurrency control.
// Exercises saveCanvasFile (the client-save path) against the AI persistence
// helpers (appendCanvasElements / updateCanvasElementSource) to prove a stale
// client save can no longer silently erase what an AI job appended/tweaked.
// HOME is the throwaway test home (setup-home.ts), so writes land there, never
// the real ~/.openground.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createCanvas,
  readCanvasFile,
  writeCanvasFile,
  saveCanvasFile,
  appendCanvasElements,
  updateCanvasElementSource,
} from './canvasData'
import { registerTestProject } from '../../test/registerProject'
import type { CanvasElement, CanvasFile } from '@/lib/types'

const txt = (id: string, x = 0, y = 0): CanvasElement => ({ id, type: 'text', x, y, text: id })
const screenEl = (id: string, source: string): CanvasElement => ({
  id,
  type: 'screen',
  x: 0,
  y: 0,
  width: 400,
  height: 300,
  text: source,
})

describe('canvas optimistic concurrency (saveCanvasFile)', () => {
  let projectPath: string
  let canvasId: string
  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-occ-'))
    await registerTestProject(projectPath)
    const { canvas } = await createCanvas(projectPath, 'C1')
    canvasId = canvas.id
  })
  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  // (f) canvas load returns a rev; (b) createCanvas's write already bumped it.
  it('a freshly created canvas loads with a numeric rev', async () => {
    const loaded = await readCanvasFile(projectPath, canvasId)
    expect(typeof loaded?.rev).toBe('number')
    expect(loaded?.rev).toBe(1) // emptyCanvas rev 0 → createCanvas write bumps to 1
  })

  // (b) every write bumps the rev: create → append → tweak → client save.
  it('every write path bumps the rev monotonically', async () => {
    expect((await readCanvasFile(projectPath, canvasId))?.rev).toBe(1) // create
    await appendCanvasElements(projectPath, canvasId, [txt('e1')])
    expect((await readCanvasFile(projectPath, canvasId))?.rev).toBe(2) // append
    // Seed a screen element to tweak, then tweak it.
    const c = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, { ...c!, elements: [...c!.elements, screenEl('s1', 'OLD')] })
    expect((await readCanvasFile(projectPath, canvasId))?.rev).toBe(3) // seed write
    await updateCanvasElementSource(projectPath, canvasId, 's1', 'NEW')
    expect((await readCanvasFile(projectPath, canvasId))?.rev).toBe(4) // tweak
    const cur = await readCanvasFile(projectPath, canvasId)
    const out = await saveCanvasFile(projectPath, cur!) // client save at the current rev
    expect(out.ok).toBe(true)
    expect(out.canvas.rev).toBe(5) // client save
  })

  // (f, no-regression) a save whose rev matches the server writes through and
  // bumps — the ordinary single-writer path is unchanged.
  it('a save with the current rev succeeds and persists', async () => {
    const loaded = await readCanvasFile(projectPath, canvasId)
    const edited: CanvasFile = { ...loaded!, elements: [txt('keep'), txt('mine', 50)] }
    const out = await saveCanvasFile(projectPath, edited)
    expect(out.ok).toBe(true)
    expect(out.conflict).toBeFalsy()
    expect(out.canvas.rev).toBe((loaded!.rev as number) + 1)
    expect((await readCanvasFile(projectPath, canvasId))?.elements.map((e) => e.id)).toEqual([
      'keep',
      'mine',
    ])
  })

  // (a + c + d-server) the core race: the client loaded at rev N, an AI job
  // appended at rev N+1, then the client's STALE save (rev N, snapshot without
  // the appended element) must be REJECTED — never clobber the append.
  it('rejects a stale client save and preserves the AI-appended element on disk', async () => {
    // Client loads the canvas at rev N.
    const clientSnapshot = await readCanvasFile(projectPath, canvasId)
    const baseRev = clientSnapshot!.rev as number

    // An AI job appends server-side → rev N+1.
    await appendCanvasElements(projectPath, canvasId, [txt('ai-added')])

    // The client's debounced save fires from its stale snapshot (rev N), with a
    // local edit of its own and WITHOUT the AI element it never saw.
    const staleSave: CanvasFile = {
      ...clientSnapshot!,
      elements: [txt('client-edit')],
      rev: baseRev,
    }
    const out = await saveCanvasFile(projectPath, staleSave)

    // Rejected as a conflict; the current canvas (with the AI element) comes back.
    expect(out.ok).toBe(false)
    expect(out.conflict).toBe(true)
    expect(out.canvas.elements.map((e) => e.id)).toContain('ai-added')

    // On disk: the append survived, the stale overwrite did NOT land, and the
    // rejected save did NOT bump the rev.
    const onDisk = await readCanvasFile(projectPath, canvasId)
    expect(onDisk?.elements.map((e) => e.id)).toContain('ai-added')
    expect(onDisk?.elements.map((e) => e.id)).not.toContain('client-edit')
    expect(onDisk?.rev).toBe(baseRev + 1)
  })

  // (e-server) the same protection for an AI TWEAK: a stale save must not erase
  // a rewritten screen source.
  it('a stale save does not clobber an AI tweak to a screen source', async () => {
    // Seed a screen element and let the client capture it at this rev.
    const seeded = await readCanvasFile(projectPath, canvasId)
    await writeCanvasFile(projectPath, { ...seeded!, elements: [screenEl('s1', 'OLD')] })
    const clientSnapshot = await readCanvasFile(projectPath, canvasId)
    const baseRev = clientSnapshot!.rev as number

    // AI tweak rewrites the source → rev bumps.
    expect(await updateCanvasElementSource(projectPath, canvasId, 's1', 'NEW')).toBe(true)

    // Client saves its stale copy (still 'OLD') at the pre-tweak rev.
    const out = await saveCanvasFile(projectPath, {
      ...clientSnapshot!,
      elements: [screenEl('s1', 'OLD')],
      rev: baseRev,
    })
    expect(out.ok).toBe(false)
    expect(out.conflict).toBe(true)

    // The tweak survives on disk.
    expect((await readCanvasFile(projectPath, canvasId))?.elements.find((e) => e.id === 's1')?.text).toBe(
      'NEW',
    )
  })

  // Two concurrent client saves from the SAME rev: serialised by the lock, the
  // first wins and the second (now stale) conflicts — neither is lost silently.
  it('serialises two saves from the same rev — first wins, second conflicts', async () => {
    const snap = await readCanvasFile(projectPath, canvasId)
    const rev = snap!.rev as number
    const [a, b] = await Promise.all([
      saveCanvasFile(projectPath, { ...snap!, elements: [txt('A')], rev }),
      saveCanvasFile(projectPath, { ...snap!, elements: [txt('B')], rev }),
    ])
    const oks = [a, b].filter((r) => r.ok)
    const conflicts = [a, b].filter((r) => r.conflict)
    expect(oks).toHaveLength(1)
    expect(conflicts).toHaveLength(1)
  })

  // A save for a canvas id not yet on disk is treated as a first write (rev 1),
  // not a conflict.
  it('writes a brand-new canvas (not yet on disk) as rev 1', async () => {
    const fresh: CanvasFile = {
      id: 'brand-new-id',
      name: 'New',
      rev: 0,
      viewport: { x: 0, y: 0, zoom: 1 },
      elements: [txt('x')],
      chats: [],
      activeChatId: null,
      sidebarOpen: false,
      sidebarWidth: null,
      createdAt: '',
      updatedAt: '',
    }
    const out = await saveCanvasFile(projectPath, fresh)
    expect(out.ok).toBe(true)
    expect(out.canvas.rev).toBe(1)
    expect((await readCanvasFile(projectPath, 'brand-new-id'))?.elements.map((e) => e.id)).toEqual(['x'])
  })
})
