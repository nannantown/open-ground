import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import * as Y from 'yjs'
import { mkdtemp, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createCanvasMirror,
  mirrorCanvasPreserving,
  canvasMirrorSeenStore,
  deleteCanvasMirrorSeen,
  type CanvasMirrorDeps,
  type CanvasMirror,
} from './canvasCollabMirror'
import { canvasFileToDoc, docToCanvasFile, CANVAS_ROOT, K_ORDER } from '../collab/canvasDoc'
import { createCanvas, deleteCanvas } from './canvasData'
import { projectDataDir } from './projectDataPath'
import { registerTestProject } from '../../test/registerProject'
import type { CanvasElement, CanvasFile } from '../types'

// The server-side CANVAS mirror (the canvas twin of board bug c2e4c57c): every
// server-side canvas write (Canvas AI append/tweak, rename, create) must reach
// the canvas's collab Y.Doc, or a client (re)connect reverts it. Exercised
// against REAL Y.Docs through fake deps — no network, no Supabase. The fake
// openDoc hands back one locally-held doc PER CANVAS ID (rooms are per-canvas),
// so assertions read what a member / the owner's client would see after sync.

const el = (id: string, over: Partial<CanvasElement> = {}): CanvasElement => ({
  id,
  type: 'sticky',
  x: 0,
  y: 0,
  text: `el ${id}`,
  ...over,
})

const canvas = (
  id: string,
  elements: CanvasElement[],
  over: Partial<CanvasFile> = {},
): CanvasFile => ({
  id,
  name: `Canvas ${id}`,
  rev: 1,
  viewport: { x: 0, y: 0, zoom: 1 },
  elements,
  chats: [],
  activeChatId: null,
  sidebarOpen: false,
  sidebarWidth: null,
  createdAt: '2026-07-02T00:00:00Z',
  updatedAt: '2026-07-02T00:00:00Z',
  ...over,
})

interface Fake {
  deps: CanvasMirrorDeps
  /** One doc per canvasId — the per-canvas room model. */
  docs: Map<string, Y.Doc>
  openCalls: string[]
  resolveCalls: number
  destroyed: number
  savedSeen: Array<{ canvasId: string; ids: string[] }>
}

const makeFake = (over: Partial<CanvasMirrorDeps> = {}): Fake => {
  const docs = new Map<string, Y.Doc>()
  const fake: Fake = {
    docs,
    openCalls: [],
    resolveCalls: 0,
    destroyed: 0,
    savedSeen: [],
    deps: {
      canonicalize: async (p) => p,
      resolvePid: async () => {
        fake.resolveCalls += 1
        return 'pid-1'
      },
      openDoc: async (_pid, canvasId) => {
        fake.openCalls.push(canvasId)
        let doc = docs.get(canvasId)
        if (!doc) {
          doc = new Y.Doc()
          docs.set(canvasId, doc)
        }
        return { doc, destroy: () => { fake.destroyed += 1 } }
      },
      seenStore: {
        load: async () => null,
        save: async (_p, canvasId, ids) => { fake.savedSeen.push({ canvasId, ids }) },
      },
      idleMs: 60_000,
      retryDelaysMs: [10, 10, 10],
      pidTtlMs: 60_000,
      ...over,
    },
  }
  return fake
}

const docOf = (fake: Fake, canvasId: string): Y.Doc => {
  let doc = fake.docs.get(canvasId)
  if (!doc) {
    doc = new Y.Doc()
    fake.docs.set(canvasId, doc)
  }
  return doc
}

const docElements = (doc: Y.Doc): CanvasElement[] =>
  docToCanvasFile(doc, canvas('base', [])).elements

let mirror: CanvasMirror | null = null
afterEach(() => {
  mirror?.reset()
  mirror = null
})

describe('canvasCollabMirror — server-side canvas writes reach the collab doc', () => {
  it('a NOT-shared project never opens a doc (find-only gate, no side effects)', async () => {
    const fake = makeFake({ resolvePid: async () => null })
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('c1', [el('a')]))
    await mirror.settle('/proj', 'c1')
    expect(fake.openCalls).toEqual([])
  })

  it('a shared canvas write lands in the doc — the state a reconnecting client sees', async () => {
    const fake = makeFake()
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('c1', [el('a'), el('b', { type: 'frame', text: 'F' })], { name: 'Design' }))
    await mirror.settle('/proj', 'c1')
    const got = docToCanvasFile(docOf(fake, 'c1'), canvas('c1', []))
    expect(got.name).toBe('Design')
    expect(got.elements.map((e) => e.id)).toEqual(['a', 'b'])
    expect(got.elements[1].type).toBe('frame')
  })

  it("PRESERVES a member's doc-only element — an AI write must never delete what the disk never had", async () => {
    const fake = makeFake()
    // A member added element X directly into the canvas doc; the owner never
    // had it on disk (canvas not open → no doc→disk apply).
    canvasFileToDoc(docOf(fake, 'c1'), canvas('c1', [el('x', { text: 'member el' })]))
    mirror = createCanvasMirror(fake.deps)
    // Server-side AI append with a disk state that has no idea about X.
    mirror.queue('/proj', canvas('c1', [el('a')]))
    await mirror.settle('/proj', 'c1')
    const ids = docElements(docOf(fake, 'c1')).map((e) => e.id)
    expect(ids).toContain('x') // the member's element SURVIVES
    expect(ids).toContain('a')
    // ...and keeps an order slot (disk order first, preserved ids after).
    const order = docOf(fake, 'c1').getMap<unknown>(CANVAS_ROOT).get(K_ORDER)
    expect(order).toEqual(['a', 'x'])
  })

  it('DELETIONS propagate for ids previously seen on disk (persisted per-canvas seen-set)', async () => {
    const fake = makeFake({
      seenStore: {
        load: async () => ['a', 'b'], // a prior session mirrored a+b from disk
        save: async (_p, canvasId, ids) => { fake.savedSeen.push({ canvasId, ids }) },
      },
    })
    canvasFileToDoc(docOf(fake, 'c1'), canvas('c1', [el('a'), el('b')]))
    mirror = createCanvasMirror(fake.deps)
    // b was deleted on disk — first write after a restart.
    mirror.queue('/proj', canvas('c1', [el('a')]))
    await mirror.settle('/proj', 'c1')
    expect(docElements(docOf(fake, 'c1')).map((e) => e.id)).toEqual(['a'])
    const map = docOf(fake, 'c1').getMap<unknown>(CANVAS_ROOT)
    expect(Array.from(map.keys()).some((k) => k.startsWith('e:b:'))).toBe(false)
    // the new seen-set was persisted for the next session, keyed by canvas
    expect(fake.savedSeen.at(-1)).toEqual({ canvasId: 'c1', ids: ['a'] })
  })

  it('first mirror with NO persisted seen-set deletes nothing (safe cold start)', async () => {
    const fake = makeFake() // seenStore.load → null
    canvasFileToDoc(docOf(fake, 'c1'), canvas('c1', [el('ghost')]))
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('c1', [el('a')]))
    await mirror.settle('/proj', 'c1')
    // ghost is indistinguishable from a member's element → preserved
    expect(docElements(docOf(fake, 'c1')).map((e) => e.id).sort()).toEqual(['a', 'ghost'])
  })

  it('a FAILED pid lookup (undefined) retries and is NEVER negative-cached', async () => {
    const fake = makeFake()
    let calls = 0
    const flakyResolve: CanvasMirrorDeps['resolvePid'] = async () => {
      calls += 1
      return calls === 1 ? undefined : 'pid-1' // one Supabase blip, then fine
    }
    mirror = createCanvasMirror({ ...fake.deps, resolvePid: flakyResolve })
    mirror.queue('/proj', canvas('c1', [el('a')]))
    for (let i = 0; i < 100 && docElements(docOf(fake, 'c1')).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(docElements(docOf(fake, 'c1')).map((e) => e.id)).toEqual(['a'])
    expect(calls).toBe(2) // retried — the failure was not cached as "not shared"
  })

  it('coalesces a burst: one connection, the LAST write wins', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => { release = r })
    const fake = makeFake()
    const slowOpen: CanvasMirrorDeps['openDoc'] = async (pid, canvasId) => {
      await gate
      return fake.deps.openDoc(pid, canvasId)
    }
    mirror = createCanvasMirror({ ...fake.deps, openDoc: slowOpen })
    mirror.queue('/proj', canvas('c1', [el('a')]))
    mirror.queue('/proj', canvas('c1', [el('b')]))
    mirror.queue('/proj', canvas('c1', [el('c')]))
    release!()
    await mirror.settle('/proj', 'c1')
    expect(fake.openCalls).toEqual(['c1'])
    expect(docElements(docOf(fake, 'c1')).map((e) => e.id)).toEqual(['c'])
  })

  it('re-mirroring identical content emits ZERO doc updates (the echo/loop guard)', async () => {
    const fake = makeFake()
    mirror = createCanvasMirror(fake.deps)
    const payload = canvas('c1', [el('a')])
    mirror.queue('/proj', payload)
    await mirror.settle('/proj', 'c1')
    let updates = 0
    docOf(fake, 'c1').on('update', () => { updates += 1 })
    // the client applying doc→disk re-triggers the hook with identical canvas
    // content (only rev/updatedAt — NOT shared — differ); zero broadcasts.
    mirror.queue('/proj', { ...payload, rev: 7, updatedAt: '2026-07-02T04:00:00Z' })
    await mirror.settle('/proj', 'c1')
    expect(updates).toBe(0)
  })

  it('a failed connect retries with backoff and eventually lands the LATEST state', async () => {
    const fake = makeFake()
    let failures = 2
    const flaky: CanvasMirrorDeps['openDoc'] = async (pid, canvasId) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('connect refused')
      }
      return fake.deps.openDoc(pid, canvasId)
    }
    mirror = createCanvasMirror({ ...fake.deps, openDoc: flaky })
    mirror.queue('/proj', canvas('c1', [el('a')]))
    // generous ceiling — retries are 10ms apart; poll for convergence
    for (let i = 0; i < 100 && docElements(docOf(fake, 'c1')).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(docElements(docOf(fake, 'c1')).map((e) => e.id)).toEqual(['a'])
  })

  it('caches a DEFINITE pid resolution across writes (one lookup per TTL window)', async () => {
    const fake = makeFake()
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('c1', [el('a')]))
    await mirror.settle('/proj', 'c1')
    mirror.queue('/proj', canvas('c1', [el('b')]))
    await mirror.settle('/proj', 'c1')
    expect(fake.resolveCalls).toBe(1)
  })

  it('rooms are PER CANVAS: two canvases mirror through two independent docs', async () => {
    const fake = makeFake()
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('c1', [el('a')], { name: 'One' }))
    mirror.queue('/proj', canvas('c2', [el('b')], { name: 'Two' }))
    await mirror.settle('/proj', 'c1')
    await mirror.settle('/proj', 'c2')
    expect(fake.openCalls.slice().sort()).toEqual(['c1', 'c2'])
    expect(docElements(docOf(fake, 'c1')).map((e) => e.id)).toEqual(['a'])
    expect(docElements(docOf(fake, 'c2')).map((e) => e.id)).toEqual(['b'])
    const map1 = docOf(fake, 'c1').getMap<unknown>(CANVAS_ROOT)
    const map2 = docOf(fake, 'c2').getMap<unknown>(CANVAS_ROOT)
    expect(map1.get('m:name')).toBe('One')
    expect(map2.get('m:name')).toBe('Two')
  })

  it('reset() tears down every connection', async () => {
    const fake = makeFake()
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('c1', [el('a')]))
    mirror.queue('/proj', canvas('c2', [el('b')]))
    await mirror.settle('/proj', 'c1')
    await mirror.settle('/proj', 'c2')
    mirror.reset()
    expect(fake.destroyed).toBe(2)
    mirror = null
  })

  it('a canvas without a usable id is ignored (nothing to key a room on)', async () => {
    const fake = makeFake()
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('', [el('a')]))
    // No settle target — just give the (absent) pipeline a beat.
    await new Promise((r) => setTimeout(r, 30))
    expect(fake.openCalls).toEqual([])
  })

  it('SAME-PROCESS ghost re-mirror after the deleteCanvas cascade deletes NOTHING (in-memory seen must not survive forget)', async () => {
    // The full deleteCanvas cascade, unit-level: a persisted-store fake makes
    // the seen-set round-trip real, then the cascade (forget the live entry,
    // drop the sidecar) runs IN THE SAME PROCESS — the case where a surviving
    // in-memory seen-set would classify the old elements as deletable and
    // destroy them in a room a member may still be viewing.
    const store = new Map<string, string[]>()
    const fake = makeFake({
      seenStore: {
        load: async (_p, canvasId) => store.get(canvasId) ?? null,
        save: async (_p, canvasId, ids) => { store.set(canvasId, ids) },
      },
    })
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('c1', [el('a'), el('b')]))
    await mirror.settle('/proj', 'c1')
    expect(store.get('c1')).toEqual(['a', 'b']) // live entry now remembers a+b
    // deleteCanvas cascade, same order as canvasData.deleteCanvas:
    await mirror.forget('/proj', 'c1') // in-memory entry first
    store.delete('c1') // then the persisted sidecar
    // Ghost-upsert door: a straggler save re-creates the id from a stale
    // snapshot that lacks b.
    mirror.queue('/proj', canvas('c1', [el('a')]))
    await mirror.settle('/proj', 'c1')
    // Cold-start semantics: b was NOT deletable — it survives in the doc.
    expect(docElements(docOf(fake, 'c1')).map((e) => e.id).sort()).toEqual(['a', 'b'])
  })

  it('forget() tears down the entry connection; the next write starts FRESH', async () => {
    const fake = makeFake()
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('c1', [el('a')]))
    await mirror.settle('/proj', 'c1')
    await mirror.forget('/proj', 'c1')
    expect(fake.destroyed).toBe(1) // the live connection was torn down
    mirror.queue('/proj', canvas('c1', [el('c')]))
    await mirror.settle('/proj', 'c1')
    expect(fake.openCalls).toEqual(['c1', 'c1']) // a NEW connection, not a reuse
  })

  it("an in-flight mirror whose entry was forgotten does NOT persist its seen-set (sidecar-resurrection race)", async () => {
    // Park the drain inside seenStore.load (the awaited step between connect
    // and the seen save), forget the entry mid-flight, then release: the
    // liveness guard must suppress the save — otherwise it would re-create the
    // sidecar the deleteCanvas cascade just unlinked.
    const store = new Map<string, string[]>()
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => { release = r })
    let loadEntered = false
    const fake = makeFake({
      seenStore: {
        load: async () => {
          loadEntered = true
          await gate
          return null
        },
        save: async (_p, canvasId, ids) => { store.set(canvasId, ids) },
      },
    })
    mirror = createCanvasMirror(fake.deps)
    mirror.queue('/proj', canvas('c1', [el('a')]))
    for (let i = 0; i < 200 && !loadEntered; i++) await new Promise((r) => setTimeout(r, 5))
    expect(loadEntered).toBe(true)
    await mirror.forget('/proj', 'c1') // the delete cascade wins the race
    release!()
    await new Promise((r) => setTimeout(r, 50)) // let the in-flight drain finish
    expect(store.size).toBe(0) // seen-set was NOT persisted for the dropped entry
  })
})

describe('mirrorCanvasPreserving — the write primitive', () => {
  it('deletes stale FIELDS of a disk element while preserving other elements wholesale', () => {
    const doc = new Y.Doc()
    canvasFileToDoc(doc, canvas('c1', [el('a', { color: '#fff' }), el('m')]))
    // disk now has a WITHOUT color; m is doc-only (not deletable)
    mirrorCanvasPreserving(doc, canvas('c1', [el('a')]), new Set())
    const map = doc.getMap<unknown>(CANVAS_ROOT)
    expect(map.has('e:a:color')).toBe(false) // stale field cleaned
    expect(map.get('e:m:text')).toBe('el m') // untouched element intact
  })

  it('is idempotent — re-applying identical state emits zero updates', () => {
    const doc = new Y.Doc()
    const payload = canvas('c1', [el('a')])
    mirrorCanvasPreserving(doc, payload, new Set())
    let updates = 0
    doc.on('update', () => { updates += 1 })
    mirrorCanvasPreserving(doc, payload, new Set())
    expect(updates).toBe(0)
  })

  it('writes ONLY the shared contract — personal fields never enter the doc', () => {
    const doc = new Y.Doc()
    mirrorCanvasPreserving(
      doc,
      canvas('c1', [el('a')], {
        rev: 42,
        viewport: { x: 9, y: 9, zoom: 2 },
        chats: [{ id: 't', title: 'chat', done: false, createdAt: 'x' } as CanvasFile['chats'][number]],
        activeChatId: 't',
        sidebarOpen: true,
        sidebarWidth: 300,
      }),
      new Set(),
    )
    const keys = Array.from(doc.getMap<unknown>(CANVAS_ROOT).keys())
    // Exactly the shared contract: meta name/order + element flat keys.
    expect(keys.every((k) => k === 'm:name' || k === 'm:order' || k.startsWith('e:'))).toBe(true)
    // Same boundary the client's canvasFileToDoc draws (no viewport/chats/rev).
    expect(keys.some((k) => /viewport|chat|sidebar|rev|createdAt|updatedAt/.test(k))).toBe(false)
  })

  it("an unencodable ':'-id can never grow m:order across passes (echo-loop guard)", () => {
    const doc = new Y.Doc()
    const payload = canvas('c1', [el('a'), el('bad:id')])
    mirrorCanvasPreserving(doc, payload, new Set())
    const map = doc.getMap<unknown>(CANVAS_ROOT)
    expect(map.get(K_ORDER)).toEqual(['a']) // the unencodable id never enters the order
    let updates = 0
    doc.on('update', () => { updates += 1 })
    mirrorCanvasPreserving(doc, payload, new Set())
    mirrorCanvasPreserving(doc, payload, new Set())
    expect(map.get(K_ORDER)).toEqual(['a']) // stable — no per-pass growth
    expect(updates).toBe(0) // and no update storm
  })

  it("a malformed separator-less 'e:' key is skipped, never coincidentally deleted", () => {
    const doc = new Y.Doc()
    doc.getMap<unknown>(CANVAS_ROOT).set('e:garbage', 'x') // no ':field' part
    mirrorCanvasPreserving(doc, canvas('c1', [el('a')]), new Set(['garbag'])) // truncated-id trap
    expect(doc.getMap<unknown>(CANVAS_ROOT).get('e:garbage')).toBe('x') // untouched
  })

  it('round-trips through docToCanvasFile — what a member reads matches the disk write', () => {
    const doc = new Y.Doc()
    const payload = canvas('c1', [
      el('a', { type: 'mock', text: '<App/>', width: 320, height: 200 }),
      el('b', { type: 'image', text: 'alt' }),
    ], { name: 'RT' })
    mirrorCanvasPreserving(doc, payload, new Set())
    const got = docToCanvasFile(doc, canvas('c1', []))
    expect(got.name).toBe('RT')
    expect(got.elements).toEqual(payload.elements)
  })
})

describe('canvas mirror seen-set sidecar — fs contract', () => {
  let projectPath: string
  beforeEach(async () => {
    projectPath = await mkdtemp(join(tmpdir(), 'og-canvas-mirror-'))
    await registerTestProject(projectPath)
    // Establish the central data dir the way production always does: a canvas
    // write precedes every mirror save (the hook fires after writeCanvasFile →
    // ensureCanvasesDir), so the sidecar's NON-recursive mkdir may assume the
    // central dir exists — its absence means "project deleted", not "not yet".
    await createCanvas(projectPath, 'Seed')
  })
  afterEach(async () => {
    await rm(projectPath, { recursive: true, force: true }).catch(() => {})
  })

  it('save→load round-trips per canvas; deleteCanvasMirrorSeen removes exactly that sidecar', async () => {
    await canvasMirrorSeenStore.save(projectPath, 'c1', ['a', 'b'])
    await canvasMirrorSeenStore.save(projectPath, 'c2', ['z'])
    expect(await canvasMirrorSeenStore.load(projectPath, 'c1')).toEqual(['a', 'b'])
    await deleteCanvasMirrorSeen(projectPath, 'c1')
    // gone → the ghost-upsert door re-mirrors with COLD-START semantics
    expect(await canvasMirrorSeenStore.load(projectPath, 'c1')).toBeNull()
    // ...without touching a sibling canvas's sidecar
    expect(await canvasMirrorSeenStore.load(projectPath, 'c2')).toEqual(['z'])
  })

  it('deleteCanvas CASCADES the sidecar (no permanent orphan per deleted canvas)', async () => {
    const { canvas: created } = await createCanvas(projectPath, 'X')
    await canvasMirrorSeenStore.save(projectPath, created.id, ['e1', 'e2'])
    await deleteCanvas(projectPath, created.id)
    expect(await canvasMirrorSeenStore.load(projectPath, created.id)).toBeNull()
  })

  it('deleteCanvas forgets the LIVE mirror entry BEFORE unlinking the sidecar (cascade wiring + order)', async () => {
    // Swap the process-wide mirror for a probe: its forget() records whether
    // the sidecar still existed at that moment — pinning both the wiring
    // (deleteCanvas reaches forget at all) and the order (in-memory entry
    // first, THEN the persisted sidecar; reversed, an in-flight drain could
    // re-persist the sidecar between the unlink and the forget).
    const calls: string[] = []
    const probe: CanvasMirror = {
      queue: () => {},
      forget: async (_p, canvasId) => {
        const sidecarStillThere =
          (await canvasMirrorSeenStore.load(projectPath, canvasId)) !== null
        calls.push(`forget:${canvasId}:sidecar=${sidecarStillThere}`)
      },
      reset: () => {},
      settle: async () => {},
    }
    const prev = globalThis.__openground_canvas_collab_mirror
    globalThis.__openground_canvas_collab_mirror = probe
    try {
      const { canvas: created } = await createCanvas(projectPath, 'W')
      await canvasMirrorSeenStore.save(projectPath, created.id, ['e1'])
      await deleteCanvas(projectPath, created.id)
      expect(calls).toEqual([`forget:${created.id}:sidecar=true`]) // forget ran first
      expect(await canvasMirrorSeenStore.load(projectPath, created.id)).toBeNull() // then the unlink
    } finally {
      globalThis.__openground_canvas_collab_mirror = prev
    }
  })

  it("save after the project's central dir vanished FAILS instead of resurrecting a dead-UUID dir", async () => {
    await canvasMirrorSeenStore.save(projectPath, 'c1', ['a']) // steady state established
    const dataDir = await projectDataDir(projectPath)
    await rm(dataDir, { recursive: true, force: true }) // the project-delete rm -rf
    // Non-recursive mkdir → ENOENT surfaces (the mirror core catches it as a
    // best-effort save failure)...
    await expect(canvasMirrorSeenStore.save(projectPath, 'c1', ['b'])).rejects.toThrow()
    // ...and the dead-UUID central dir was NOT re-created.
    await expect(stat(dataDir)).rejects.toThrow()
  })

  it('a path-escaping canvasId is refused (load null, save writes nothing outside the sidecar dir)', async () => {
    await canvasMirrorSeenStore.save(projectPath, '../escape', ['a'])
    expect(await canvasMirrorSeenStore.load(projectPath, '../escape')).toBeNull()
    const dataDir = await projectDataDir(projectPath)
    await expect(stat(join(dataDir, 'escape.json'))).rejects.toThrow()
  })
})
