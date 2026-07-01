// @vitest-environment jsdom
//
// Unit test for the pure OCC save loop `saveCanvasWithOcc` extracted from
// ProjectCanvas (same "pure + deterministically testable" rationale as
// reconcileCanvasElements).
//
// THE BUG THIS GUARDS (data loss): the retry loop merges on its FINAL iteration
// too, so when a canvas under a sustained 409 burst (two views editing the same
// canvas, or rapid AI appends) exhausts its retries, the freshly-merged payload
// was reflected into local state (setActive) but NEVER sent — and the next
// reload silently lost the user's merged edits. The fix flushes the last merged
// payload ONCE after the loop, and surfaces a notice if even that can't land.
//
// The test drives the loop with a fake transport (no React render, no server,
// no filesystem — inherently HOME-isolated) so the conflict count is exact and
// deterministic.
import { describe, it, expect, vi } from 'vitest'

// The unit under test is the pure loop; neutralise ProjectCanvas's heavy
// children so importing the module is cheap and environment-agnostic (the
// canvas engine / yjs / collab are irrelevant here and never run).
vi.mock('@/components/canvas/CanvasWorkspace', () => ({ CanvasWorkspace: () => null }))
vi.mock('@/components/canvas/PagesSection', () => ({ PagesSection: () => null }))
vi.mock('@/lib/collab/RealtimeContext', () => ({
  useBoardCollab: () => null,
  useCanvasCollab: () => null,
}))
vi.mock('@/components/canvas/CollabPresence', () => ({ usePublishPresence: () => {} }))

import {
  saveCanvasWithOcc,
  MAX_SAVE_RETRIES,
  type CanvasSaveOcc,
  type CanvasSavePost,
} from '@/components/canvas/ProjectCanvas'
import type { CanvasElement, CanvasFile } from '@/lib/types'

const el = (id: string): CanvasElement => ({ id, type: 'sticky', x: 0, y: 0, text: id })

const makeCanvas = (id: string, rev: number, elements: CanvasElement[]): CanvasFile => ({
  id,
  name: 'C',
  rev,
  viewport: { x: 0, y: 0, zoom: 1 },
  elements,
  chats: [],
  activeChatId: null,
  sidebarOpen: false,
  sidebarWidth: null,
  createdAt: '2026-06-30T00:00:00Z',
  updatedAt: '2026-06-30T00:00:00Z',
})

const ID = 'c1'

interface Harness {
  occ: CanvasSaveOcc
  posts: Array<{ payload: CanvasFile; expectedRev: number }>
  merged: CanvasFile[]
  saved: Array<{ saved: CanvasFile; sent: CanvasFile }>
  exhausted: string[]
  rev: Map<string, number>
  base: Map<string, CanvasElement[]>
}

/** Build an OCC harness whose POST outcome is decided per-call by `script`
 *  (given the 0-based attempt index + the payload it was handed). An in-memory
 *  rev/base store mirrors the component's refs; every effect is recorded. */
function makeHarness(opts: {
  initialRev?: number
  initialBase?: CanvasElement[]
  liveLocal?: () => CanvasFile | null
  script: (attempt: number, payload: CanvasFile) => CanvasSavePost
  maxRetries?: number
}): Harness {
  const posts: Harness['posts'] = []
  const merged: CanvasFile[] = []
  const saved: Harness['saved'] = []
  const exhausted: string[] = []
  const rev = new Map<string, number>()
  const base = new Map<string, CanvasElement[]>()
  if (opts.initialRev !== undefined) rev.set(ID, opts.initialRev)
  if (opts.initialBase !== undefined) base.set(ID, opts.initialBase)

  const occ: CanvasSaveOcc = {
    post: async (payload, expectedRev) => {
      const attempt = posts.length
      posts.push({ payload, expectedRev })
      return opts.script(attempt, payload)
    },
    // Tests always carry serverCanvas inline on the conflict; fetchCanvas is the
    // fallback only and should never be reached here.
    fetchCanvas: async () => null,
    getRev: (id) => rev.get(id) ?? 0,
    setRev: (id, v) => rev.set(id, v),
    getBase: (id) => base.get(id) ?? [],
    setBase: (id, v) => base.set(id, v),
    liveLocal: opts.liveLocal ?? (() => null),
    onSaved: (_id, s, sent) => saved.push({ saved: s, sent }),
    onMerged: (m) => merged.push(m),
    onExhausted: (id) => exhausted.push(id),
    maxRetries: opts.maxRetries ?? MAX_SAVE_RETRIES,
  }
  return { occ, posts, merged, saved, exhausted, rev, base }
}

const ids = (els: CanvasElement[]) => els.map((e) => e.id)

describe('saveCanvasWithOcc — data-loss guard on retry exhaustion', () => {
  it('flushes the final merged payload after MAX_SAVE_RETRIES consecutive 409s (the bug)', async () => {
    // The user's element is 'u'; each conflict reveals one more AI-appended
    // element on the server, so the running merge accumulates u ∪ ai1..aiN.
    const aiEls: CanvasElement[] = []
    const h = makeHarness({
      initialRev: 0,
      initialBase: [], // fresh load: nothing was on the server at load time
      script: (attempt) => {
        if (attempt <= MAX_SAVE_RETRIES) {
          aiEls.push(el(`ai${attempt + 1}`))
          return { kind: 'conflict', serverCanvas: makeCanvas(ID, attempt + 1, [...aiEls]) }
        }
        // The flush (the post AFTER the loop) finally lands.
        return { kind: 'saved', saved: makeCanvas(ID, 100, []) }
      },
    })

    await saveCanvasWithOcc(makeCanvas(ID, 0, [el('u')]), h.occ)

    // 1 initial + MAX_SAVE_RETRIES retries = MAX_SAVE_RETRIES+1 in-loop POSTs,
    // then exactly ONE flush POST after the loop — the heart of the fix.
    expect(h.posts).toHaveLength(MAX_SAVE_RETRIES + 2)
    const flush = h.posts[h.posts.length - 1]
    // The flush carried the accumulated merge (the user's edit + every AI add),
    // not the stale original — this is what used to be silently dropped.
    expect(ids(flush.payload.elements).sort()).toEqual(
      ['u', ...Array.from({ length: MAX_SAVE_RETRIES + 1 }, (_, i) => `ai${i + 1}`)].sort(),
    )
    // The flush was sent against the freshest rev we learned (the last server rev).
    expect(flush.expectedRev).toBe(MAX_SAVE_RETRIES + 1)
    // It landed: onSaved fired with that merged payload, the notice did NOT fire.
    expect(h.saved).toHaveLength(1)
    expect(ids(h.saved[0].sent.elements)).toContain('u')
    expect(h.exhausted).toHaveLength(0)
    // OCC store advanced to the server's confirmed rev.
    expect(h.rev.get(ID)).toBe(100)
  })

  it('flushes a prior merge even if a later 409 yields no server canvas (no silent drop)', async () => {
    // attempt 0: 409 WITH a server canvas → merge (mergedUnsaved = true).
    // attempt 1: 409 with NO server canvas, and the fetchCanvas() fallback also
    // returns null → this iteration can't merge; the loop must still `break` to
    // the flush so the prior merge isn't dropped (the asymmetry the review
    // flagged: the error path broke to the flush but this path used to `return`).
    const h = makeHarness({
      initialRev: 0,
      initialBase: [],
      script: (attempt) => {
        if (attempt === 0) return { kind: 'conflict', serverCanvas: makeCanvas(ID, 1, [el('ai1')]) }
        if (attempt === 1) return { kind: 'conflict', serverCanvas: null } // fetchCanvas also null
        return { kind: 'saved', saved: makeCanvas(ID, 2, []) } // the flush lands
      },
    })

    await saveCanvasWithOcc(makeCanvas(ID, 0, [el('u')]), h.occ)

    // attempt0 (merge) + attempt1 (null server → break) + 1 flush = 3 POSTs.
    expect(h.posts).toHaveLength(3)
    // The flush carried the prior merge (u + ai1), not a dropped/empty payload.
    expect(ids(h.posts[2].payload.elements).sort()).toEqual(['ai1', 'u'])
    expect(h.saved).toHaveLength(1)
    expect(h.exhausted).toHaveLength(0)
  })

  it('notifies (onExhausted) when even the final flush still 409s', async () => {
    const aiEls: CanvasElement[] = []
    const h = makeHarness({
      initialRev: 0,
      initialBase: [],
      // EVERY post conflicts, including the flush — a never-ending burst.
      script: (attempt) => {
        aiEls.push(el(`ai${attempt + 1}`))
        return { kind: 'conflict', serverCanvas: makeCanvas(ID, attempt + 1, [...aiEls]) }
      },
    })

    await saveCanvasWithOcc(makeCanvas(ID, 0, [el('u')]), h.occ)

    // Bounded: MAX_SAVE_RETRIES+1 in-loop POSTs + 1 flush, then it gives up.
    expect(h.posts).toHaveLength(MAX_SAVE_RETRIES + 2)
    // The flush still tried to persist the accumulated merge before giving up …
    const flush = h.posts[h.posts.length - 1]
    expect(ids(flush.payload.elements)).toContain('u')
    // … and since it couldn't land, the user is notified (no silent loss).
    expect(h.exhausted).toEqual([ID])
    expect(h.saved).toHaveLength(0)
  })
})

describe('saveCanvasWithOcc — normal saves are unchanged', () => {
  it('a save that succeeds on the first try makes exactly one POST and no notice', async () => {
    const h = makeHarness({
      initialRev: 7,
      script: () => ({ kind: 'saved', saved: makeCanvas(ID, 8, []) }),
    })
    const initial = makeCanvas(ID, 7, [el('u')])

    await saveCanvasWithOcc(initial, h.occ)

    expect(h.posts).toHaveLength(1)
    expect(h.posts[0].expectedRev).toBe(7) // echoed the rev we were synced to
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0].sent).toBe(initial) // sent exactly what we had
    expect(h.merged).toHaveLength(0)
    expect(h.exhausted).toHaveLength(0)
    expect(h.rev.get(ID)).toBe(8) // advanced to the server's rev
    expect(h.base.get(ID)).toBe(initial.elements) // new merge base = what we sent
  })

  it('one 409 then success persists the MERGED payload (keeps the AI append) and never notifies', async () => {
    const live = makeCanvas(ID, 0, [el('u')]) // canvas still active → merge uses it
    const h = makeHarness({
      initialRev: 0,
      initialBase: [],
      liveLocal: () => live,
      script: (attempt) =>
        attempt === 0
          ? { kind: 'conflict', serverCanvas: makeCanvas(ID, 1, [el('ai1')]) }
          : { kind: 'saved', saved: makeCanvas(ID, 2, []) },
    })

    await saveCanvasWithOcc(makeCanvas(ID, 0, [el('u')]), h.occ)

    expect(h.posts).toHaveLength(2) // conflict then success — no flush needed
    expect(h.merged).toHaveLength(1) // the merge was reflected locally (active)
    expect(ids(h.merged[0].elements).sort()).toEqual(['ai1', 'u'])
    // The SECOND POST (the retry) carried the merged payload, which then saved.
    expect(ids(h.posts[1].payload.elements).sort()).toEqual(['ai1', 'u'])
    expect(h.saved).toHaveLength(1)
    expect(ids(h.saved[0].sent.elements).sort()).toEqual(['ai1', 'u'])
    expect(h.exhausted).toHaveLength(0)
  })

  it('a non-409 error on the first attempt (nothing merged yet) drops silently — no notice, no flush', async () => {
    const h = makeHarness({
      initialRev: 3,
      script: () => ({ kind: 'error' }),
    })

    await saveCanvasWithOcc(makeCanvas(ID, 3, [el('u')]), h.occ)

    // Matches the prior fire-and-forget behaviour: one attempt, then give up;
    // the next local edit re-saves. No flush (nothing was merged), no notice.
    expect(h.posts).toHaveLength(1)
    expect(h.saved).toHaveLength(0)
    expect(h.merged).toHaveLength(0)
    expect(h.exhausted).toHaveLength(0)
  })

  it('a non-409 error AFTER a merge still flushes the merged payload once (and notifies only if that fails)', async () => {
    // conflict (merge) → transient error → the flush lands.
    const okFlush = makeHarness({
      initialRev: 0,
      initialBase: [],
      script: (attempt) => {
        if (attempt === 0) return { kind: 'conflict', serverCanvas: makeCanvas(ID, 1, [el('ai1')]) }
        if (attempt === 1) return { kind: 'error' }
        return { kind: 'saved', saved: makeCanvas(ID, 2, []) }
      },
    })
    await saveCanvasWithOcc(makeCanvas(ID, 0, [el('u')]), okFlush.occ)
    expect(okFlush.posts).toHaveLength(3) // conflict, error (break), flush
    expect(ids(okFlush.posts[2].payload.elements)).toContain('u') // flush sent the merge
    expect(okFlush.saved).toHaveLength(1)
    expect(okFlush.exhausted).toHaveLength(0)

    // Same path but the flush also errors → the user is notified.
    const failFlush = makeHarness({
      initialRev: 0,
      initialBase: [],
      script: (attempt) =>
        attempt === 0
          ? { kind: 'conflict', serverCanvas: makeCanvas(ID, 1, [el('ai1')]) }
          : { kind: 'error' },
    })
    await saveCanvasWithOcc(makeCanvas(ID, 0, [el('u')]), failFlush.occ)
    expect(failFlush.posts).toHaveLength(3)
    expect(failFlush.saved).toHaveLength(0)
    expect(failFlush.exhausted).toEqual([ID])
  })
})
