import { describe, it, expect, afterEach } from 'vitest'
import * as Y from 'yjs'
import { createBoardMirror, mirrorBoardPreserving, type MirrorDeps, type BoardMirror } from './collabMirror'
import { boardDocToProjectData, projectDataToBoardDoc } from '../collab/boardDoc'
import type { ProjectData, ProjectTask } from '../types'

// The server-side board mirror (bug c2e4c57c): every server-side board write
// must reach the collab Y.Doc, or a client (re)connect reverts it. Exercised
// against a REAL Y.Doc through fake deps — no network, no Supabase. The fake
// openDoc hands back a locally-held doc, so assertions read what a member /
// the owner's client would see after sync.

const task = (id: string, over: Partial<ProjectTask> = {}): ProjectTask => ({
  id,
  title: `task ${id}`,
  done: false,
  createdAt: '2026-07-02T00:00:00Z',
  boardColumn: 'todo',
  ...over,
})

const data = (tasks: ProjectTask[], updatedAt = '2026-07-02T01:00:00.000Z'): ProjectData => ({
  description: 'desc',
  tasks,
  notes: 'notes',
  updatedAt,
})

interface Fake {
  deps: MirrorDeps
  doc: Y.Doc
  openCalls: number
  resolveCalls: number
  destroyed: number
  savedSeen: string[][]
}

const makeFake = (over: Partial<MirrorDeps> = {}): Fake => {
  const doc = new Y.Doc()
  const fake: Fake = {
    doc,
    openCalls: 0,
    resolveCalls: 0,
    destroyed: 0,
    savedSeen: [],
    deps: {
      canonicalize: async (p) => p,
      resolvePid: async () => {
        fake.resolveCalls += 1
        return 'pid-1'
      },
      openDoc: async () => {
        fake.openCalls += 1
        return { doc, destroy: () => { fake.destroyed += 1 } }
      },
      seenStore: {
        load: async () => null,
        save: async (_p, ids) => { fake.savedSeen.push(ids) },
      },
      idleMs: 60_000,
      retryDelaysMs: [10, 10, 10],
      pidTtlMs: 60_000,
      ...over,
    },
  }
  return fake
}

const docTasks = (doc: Y.Doc): ProjectTask[] =>
  boardDocToProjectData(doc, data([])).tasks

let mirror: BoardMirror | null = null
afterEach(() => {
  mirror?.reset()
  mirror = null
})

describe('collabMirror — server-side board writes reach the collab doc (c2e4c57c)', () => {
  it('a NOT-shared project never opens a doc (find-only gate, no side effects)', async () => {
    const fake = makeFake({ resolvePid: async () => null })
    mirror = createBoardMirror(fake.deps)
    mirror.queue('/proj', data([task('a')]))
    await mirror.settle('/proj')
    expect(fake.openCalls).toBe(0)
  })

  it('a shared project write lands in the doc — the state a reconnecting client sees', async () => {
    const fake = makeFake()
    mirror = createBoardMirror(fake.deps)
    mirror.queue('/proj', data([task('a'), task('b', { boardColumn: 'done', done: true })]))
    await mirror.settle('/proj')
    const ts = docTasks(fake.doc)
    expect(ts.map((t) => t.id)).toEqual(['a', 'b'])
    expect(ts[1].boardColumn).toBe('done')
  })

  it("PRESERVES a member's doc-only card — a swarm write must never delete what the disk never had (must-fix #1)", async () => {
    const fake = makeFake()
    // A member (folder-less) added card X directly into the doc; the owner
    // never had it on disk (Board tab not active → no doc→disk apply).
    projectDataToBoardDoc(fake.doc, data([task('x', { title: 'member card' })]))
    mirror = createBoardMirror(fake.deps)
    // Server-side swarm write with a disk state that has no idea about X.
    mirror.queue('/proj', data([task('a')]))
    await mirror.settle('/proj')
    const ids = docTasks(fake.doc).map((t) => t.id)
    expect(ids).toContain('x') // the member's card SURVIVES
    expect(ids).toContain('a')
    // ...and keeps an order slot (disk order first, preserved ids after).
    const order = fake.doc.getMap<unknown>('og').get('m:order')
    expect(order).toEqual(['a', 'x'])
  })

  it('DELETIONS propagate for ids previously seen on disk (persisted seen-set)', async () => {
    const fake = makeFake({
      seenStore: {
        load: async () => ['a', 'b'], // a prior session mirrored a+b from disk
        save: async (_p, ids) => { fake.savedSeen.push(ids) },
      },
    })
    projectDataToBoardDoc(fake.doc, data([task('a'), task('b')]))
    mirror = createBoardMirror(fake.deps)
    // b was deleted on disk (e.g. the cleanup) — first write after a restart.
    mirror.queue('/proj', data([task('a')]))
    await mirror.settle('/proj')
    expect(docTasks(fake.doc).map((t) => t.id)).toEqual(['a'])
    const map = fake.doc.getMap<unknown>('og')
    expect(Array.from(map.keys()).some((k) => k.startsWith('t:b:'))).toBe(false)
    // the new seen-set was persisted for the next session
    expect(fake.savedSeen.at(-1)).toEqual(['a'])
  })

  it('first mirror with NO persisted seen-set deletes nothing (safe cold start)', async () => {
    const fake = makeFake() // seenStore.load → null
    projectDataToBoardDoc(fake.doc, data([task('ghost')]))
    mirror = createBoardMirror(fake.deps)
    mirror.queue('/proj', data([task('a')]))
    await mirror.settle('/proj')
    // ghost is indistinguishable from a member's card → preserved
    expect(docTasks(fake.doc).map((t) => t.id).sort()).toEqual(['a', 'ghost'])
  })

  it('a FAILED pid lookup (undefined) retries and is NEVER negative-cached (must-fix #2)', async () => {
    const fake = makeFake()
    let calls = 0
    const flakyResolve: MirrorDeps['resolvePid'] = async () => {
      calls += 1
      return calls === 1 ? undefined : 'pid-1' // one Supabase blip, then fine
    }
    mirror = createBoardMirror({ ...fake.deps, resolvePid: flakyResolve })
    mirror.queue('/proj', data([task('a')]))
    for (let i = 0; i < 100 && docTasks(fake.doc).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(docTasks(fake.doc).map((t) => t.id)).toEqual(['a']) // the write survived the blip
    expect(calls).toBe(2) // retried — the failure was not cached as "not shared"
  })

  it('drops an OUT-OF-ORDER enqueue — an older write can never overwrite a newer one (must-fix #3)', async () => {
    const fake = makeFake()
    mirror = createBoardMirror(fake.deps)
    // Simulates canonicalize completion-order inversion: the NEWER write (T2)
    // reaches the queue first, the older (T1) after. The stamp guard must drop T1.
    mirror.queue('/proj', data([task('new')], '2026-07-02T02:00:00.000Z'))
    await mirror.settle('/proj')
    mirror.queue('/proj', data([task('old')], '2026-07-02T01:00:00.000Z'))
    await mirror.settle('/proj')
    expect(docTasks(fake.doc).map((t) => t.id)).toEqual(['new'])
  })

  it('an EMPTY updatedAt is unstamped — mirrored, never dropped (pre-core queue-guard truth table)', async () => {
    const fake = makeFake()
    mirror = createBoardMirror(fake.deps)
    mirror.queue('/proj', data([task('a')], '2026-07-02T01:00:00.000Z'))
    await mirror.settle('/proj')
    // '' is falsy in the original guard (`stamp && lastStamp && …`): it must
    // bypass the ordering drop AND must not poison lastStamp for later writes.
    mirror.queue('/proj', data([task('b')], ''))
    await mirror.settle('/proj')
    expect(docTasks(fake.doc).map((t) => t.id)).toEqual(['b'])
    mirror.queue('/proj', data([task('c')], '2026-07-02T02:00:00.000Z'))
    await mirror.settle('/proj')
    expect(docTasks(fake.doc).map((t) => t.id)).toEqual(['c'])
  })

  it('coalesces a burst: one connection, the LAST write wins', async () => {
    let release: (() => void) | null = null
    const gate = new Promise<void>((r) => { release = r })
    const fake = makeFake()
    const slowOpen: MirrorDeps['openDoc'] = async (pid) => {
      await gate
      return fake.deps.openDoc(pid)
    }
    mirror = createBoardMirror({ ...fake.deps, openDoc: slowOpen })
    mirror.queue('/proj', data([task('a')], '2026-07-02T01:00:00.000Z'))
    mirror.queue('/proj', data([task('b')], '2026-07-02T02:00:00.000Z'))
    mirror.queue('/proj', data([task('c')], '2026-07-02T03:00:00.000Z'))
    release!()
    await mirror.settle('/proj')
    expect(fake.openCalls).toBe(1)
    expect(docTasks(fake.doc).map((t) => t.id)).toEqual(['c'])
  })

  it('re-mirroring identical content changes no CONTENT key (the echo/loop guard)', async () => {
    const fake = makeFake()
    mirror = createBoardMirror(fake.deps)
    const payload = data([task('a')])
    mirror.queue('/proj', payload)
    await mirror.settle('/proj')
    const before = new Map(fake.doc.getMap<unknown>('og').entries())
    // The client applying doc→disk re-triggers the hook with identical board
    // content. Only the disk stamp may move (74ec0b0d — every write must stamp,
    // or the client's adoption gate never re-opens); no board content is
    // rewritten, and the client answers the stamp with nothing (boardDoc's echo
    // check returns base identity), so the echo cannot loop.
    mirror.queue('/proj', { ...payload, updatedAt: '2026-07-02T04:00:00.000Z' })
    await mirror.settle('/proj')
    const after = fake.doc.getMap<unknown>('og')
    for (const key of Array.from(after.keys())) {
      if (key === 'm:diskStamp') continue
      expect(after.get(key)).toEqual(before.get(key))
    }
    expect(Array.from(after.keys()).sort()).toEqual(
      Array.from(before.keys()).sort(), // no key added or dropped
    )
    // The echo is invisible to the client: nothing to adopt ⇒ nothing to persist.
    const base = { ...payload, updatedAt: '2026-07-02T04:00:00.000Z' }
    expect(boardDocToProjectData(fake.doc, base)).toBe(base)
  })

  it('a failed connect retries with backoff and eventually lands the LATEST state', async () => {
    const fake = makeFake()
    let failures = 2
    const flaky: MirrorDeps['openDoc'] = async (pid) => {
      if (failures > 0) {
        failures -= 1
        throw new Error('connect refused')
      }
      return fake.deps.openDoc(pid)
    }
    mirror = createBoardMirror({ ...fake.deps, openDoc: flaky })
    mirror.queue('/proj', data([task('a')]))
    // generous ceiling — retries are 10ms apart; poll for convergence
    for (let i = 0; i < 100 && docTasks(fake.doc).length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(docTasks(fake.doc).map((t) => t.id)).toEqual(['a'])
  })

  it('caches a DEFINITE pid resolution across writes (one lookup per TTL window)', async () => {
    const fake = makeFake()
    mirror = createBoardMirror(fake.deps)
    mirror.queue('/proj', data([task('a')], '2026-07-02T01:00:00.000Z'))
    await mirror.settle('/proj')
    mirror.queue('/proj', data([task('b')], '2026-07-02T05:00:00.000Z'))
    await mirror.settle('/proj')
    expect(fake.resolveCalls).toBe(1)
  })

  it('reset() tears down the connection', async () => {
    const fake = makeFake()
    mirror = createBoardMirror(fake.deps)
    mirror.queue('/proj', data([task('a')]))
    await mirror.settle('/proj')
    mirror.reset()
    expect(fake.destroyed).toBe(1)
    mirror = null
  })
})

describe('mirrorBoardPreserving — the write primitive', () => {
  it('deletes stale FIELDS of a disk card while preserving other cards wholesale', () => {
    const doc = new Y.Doc()
    projectDataToBoardDoc(doc, data([task('a', { notes: 'old-notes' }), task('m')]))
    // disk now has a WITHOUT notes; m is doc-only (not deletable)
    mirrorBoardPreserving(doc, data([task('a')]), new Set())
    const map = doc.getMap<unknown>('og')
    expect(map.has('t:a:notes')).toBe(false) // stale field cleaned
    expect(map.get('t:m:title')).toBe('task m') // untouched card intact
  })

  it('is idempotent — re-applying identical state emits zero updates', () => {
    const doc = new Y.Doc()
    const payload = data([task('a')])
    mirrorBoardPreserving(doc, payload, new Set())
    let updates = 0
    doc.on('update', () => { updates += 1 })
    mirrorBoardPreserving(doc, payload, new Set())
    expect(updates).toBe(0)
  })

  it("an unencodable ':'-id can never grow m:order across passes (echo-loop must-fix)", () => {
    const doc = new Y.Doc()
    const payload = data([task('a'), task('bad:id')]) // schema-legal, flat-key-unencodable
    mirrorBoardPreserving(doc, payload, new Set())
    const map = doc.getMap<unknown>('og')
    const after1 = map.get('m:order')
    expect(after1).toEqual(['a']) // the unencodable id never enters the order
    let updates = 0
    doc.on('update', () => { updates += 1 })
    mirrorBoardPreserving(doc, payload, new Set())
    mirrorBoardPreserving(doc, payload, new Set())
    expect(map.get('m:order')).toEqual(['a']) // stable — no per-pass growth
    expect(updates).toBe(0) // and no update storm
  })

  it("a malformed separator-less 't:' key is skipped, never coincidentally deleted", () => {
    const doc = new Y.Doc()
    doc.getMap<unknown>('og').set('t:garbage', 'x') // no ':field' part
    mirrorBoardPreserving(doc, data([task('a')]), new Set(['garbag'])) // truncated-id trap
    expect(doc.getMap<unknown>('og').get('t:garbage')).toBe('x') // untouched
  })

  // 74ec0b0d: the mirror is what lets the owner's client trust the doc enough to
  // write it back to disk. Stamping the disk state it just mirrored is that
  // permission — without it the client gates adoption forever (safe, but stuck).
  it('stamps the disk state it just mirrored (the owner’s adoption gate)', () => {
    const doc = new Y.Doc()
    mirrorBoardPreserving(doc, data([task('a')], '2026-07-02T03:00:00.000Z'), new Set())
    expect(doc.getMap<unknown>('og').get('m:diskStamp')).toBe('2026-07-02T03:00:00.000Z')
  })

  // Same rule the client's seed obeys: content and stamp move together, or not at
  // all. The drain re-applies its last payload on retry, and a direct write to
  // tasks.json mirrors nothing — so an older payload CAN arrive after the doc has
  // learned a newer disk state. Writing its content under the newer (monotonic)
  // stamp would tell the owner's client "this doc is current" about stale cards.
  it('REFUSES a payload older than the disk state the doc already reflects', () => {
    const doc = new Y.Doc()
    mirrorBoardPreserving(doc, data([task('a', { boardColumn: 'done' })], '2026-07-02T03:00:00.000Z'), new Set())
    mirrorBoardPreserving(doc, data([task('a', { boardColumn: 'review' })], '2026-07-02T01:00:00.000Z'), new Set())
    const map = doc.getMap<unknown>('og')
    expect(map.get('t:a:boardColumn')).toBe('done') // content not regressed
    expect(map.get('m:diskStamp')).toBe('2026-07-02T03:00:00.000Z')
  })
})
