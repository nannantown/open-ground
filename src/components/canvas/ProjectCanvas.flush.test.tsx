// @vitest-environment jsdom
//
// Race tests for ProjectCanvas's debounced-save flushing (data-loss guards).
//
// THE TWO BUGS THESE GUARD (both: the client fired a server mutation WITHOUT
// first awaiting the pending debounced edit-save, so the stale save landed
// after the mutation and undid it):
//
//   (1) RENAME CLOBBER — persistActive debounces a save holding a snapshot with
//       the OLD name. renameCanvas POSTs the rename and ADVANCES our synced rev,
//       but didn't flush. The debounced save then fired with the old name against
//       the now-matching rev (no 409 → it "succeeds"), reverting the rename on
//       disk. Reload showed the old name. Fix: renameCanvas awaits flushPending()
//       first (like switchTo/createCanvas/deleteCanvas).
//
//   (2) DELETE GHOST — deleteCanvas called flushPending() but did NOT await it,
//       so the delete POST raced the debounced save. Delete landing first meant
//       the save then re-created the just-deleted canvas as a brand-new file, and
//       self-healing listCanvases resurrected it. Fix: await flushPending() before
//       the delete POST.
//
// The test renders the real ProjectCanvas against a faithful in-memory OCC server
// (no real fetch / filesystem → inherently HOME-isolated) and drives its child
// callbacks, using fake timers to control the 400ms debounce deterministically.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, waitFor, cleanup, screen } from '@testing-library/react'
import type { CanvasElement, CanvasFile } from '@/lib/types'

// persistActive's debounce window (module-private in ProjectCanvas — kept in sync).
const SAVE_DEBOUNCE_MS = 400

const el = (id: string): CanvasElement => ({ id, type: 'sticky', x: 0, y: 0, text: id })

// Shared fake-server state + captured child props, hoisted so the (also hoisted)
// vi.mock factories below can close over them — the documented vi.hoisted pattern.
const h = vi.hoisted(() => {
  interface Entry {
    name: string
    elements: { id: string; type: string; x: number; y: number; text?: string }[]
    rev: number
  }
  return {
    server: new Map<string, Entry>(),
    order: [] as string[],
    log: [] as string[], // ordered POST actions, e.g. 'save:c1', 'rename:c1', 'delete:c1'
    state: { activeId: null as string | null, n: 1 },
    // When true, the next plain SAVE (no action) is held IN FLIGHT: its resolver
    // is parked in gatedResolvers until the test releases it. Lets a test put a
    // debounced save ON THE WIRE, THEN fire a delete, to exercise the in-flight
    // (already-fired-timer) leg of the ghost race — distinct from the pending
    // (timer-not-yet-fired) leg the sibling delete test covers.
    gateSaves: false,
    gatedResolvers: [] as Array<() => void>,
    // When true, the next delete action 500s (non-2xx body) so a test can exercise
    // deleteCanvas's FAILURE path: it must un-mark the id (else the still-existing
    // canvas is silently un-saveable — data loss) and surface the error.
    failDelete: false,
    // A fake canvas collab. null → collab OFF (the default most tests want). Set
    // before mount to exercise the onRemote (peer-change) leg; remoteCbs collects
    // the callbacks ProjectCanvas subscribes so a test can fire a peer change.
    collab: null as null | {
      seed: (v: CanvasFile) => void
      extract: (base: CanvasFile) => CanvasFile
      onRemote: (cb: () => void) => () => void
    },
    remoteCbs: [] as Array<() => void>,
    ws: { props: null as { canvas: CanvasFile; onChange: (c: CanvasFile) => void } | null },
    pages: {
      props: null as {
        onRename: (id: string, name: string) => Promise<void>
        onDelete: (id: string) => Promise<void>
      } | null,
    },
  }
})

// i18n / collab / presence are irrelevant here — neutralise them (mirrors the
// other ProjectCanvas / canvas suites).
vi.mock('@/i18n/I18nContext', () => ({ useT: () => ({ t: (k: string) => k, lang: 'en' }) }))
vi.mock('@/lib/collab/RealtimeContext', () => ({
  useBoardCollab: () => null,
  useCanvasCollab: () => h.collab,
}))
vi.mock('@/components/canvas/CollabPresence', () => ({ usePublishPresence: () => {} }))

// Capture the child callbacks ProjectCanvas wires up, so the test can drive an
// edit (CanvasWorkspace.onChange) and a rename/delete (PagesSection) directly —
// the seam where both bugs live. Both render nothing.
vi.mock('@/components/canvas/CanvasWorkspace', () => ({
  CanvasWorkspace: (props: { canvas: CanvasFile; onChange: (c: CanvasFile) => void }) => {
    h.ws.props = props
    return null
  },
}))
vi.mock('@/components/canvas/PagesSection', () => ({
  PagesSection: (props: {
    onRename: (id: string, name: string) => Promise<void>
    onDelete: (id: string) => Promise<void>
  }) => {
    h.pages.props = props
    return null
  },
}))

// A faithful in-memory canvas server with the real OCC + self-heal semantics:
//  • save (no action) with a matching rev writes through and bumps rev; a stale
//    rev 409s; a save for an id that no longer exists RE-CREATES it (the ghost).
//  • rename bumps the name + rev. delete drops the id. list returns whatever's
//    on the server (so a resurrected ghost reappears).
vi.mock('@/lib/api-client', () => {
  const reply = (ok: boolean, status: number, body: unknown) =>
    Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
  const fullFile = (id: string): CanvasFile => {
    const e = h.server.get(id)!
    return {
      id,
      name: e.name,
      rev: e.rev,
      viewport: { x: 0, y: 0, zoom: 1 },
      elements: e.elements as CanvasElement[],
      chats: [],
      activeChatId: null,
      sidebarOpen: false,
      sidebarWidth: null,
      createdAt: '2026-06-30T00:00:00Z',
      updatedAt: '2026-06-30T00:00:00Z',
    }
  }
  const $get = (arg?: { query?: { path?: string; id?: string } }) => {
    const id = arg?.query?.id
    if (id) {
      return h.server.has(id) ? reply(true, 200, fullFile(id)) : reply(false, 404, {})
    }
    return reply(true, 200, {
      index: { order: [...h.order], activeId: h.state.activeId },
      canvases: h.order.map((cid) => ({
        id: cid,
        name: h.server.get(cid)!.name,
        updatedAt: '2026-06-30T00:00:00Z',
      })),
    })
  }
  const $post = (arg: {
    query?: { action?: string }
    json: { path?: string; id?: string; name?: string; order?: string[]; canvas?: CanvasFile }
  }) => {
    const action = arg.query?.action
    const json = arg.json
    if (action === 'create') {
      const id = `c${h.state.n++}`
      h.server.set(id, { name: `Canvas ${id}`, elements: [], rev: 1 })
      h.order.push(id)
      h.state.activeId = id
      h.log.push(`create:${id}`)
      return reply(true, 200, {
        index: { order: [...h.order], activeId: h.state.activeId },
        canvas: fullFile(id),
      })
    }
    if (action === 'delete') {
      const id = json.id as string
      if (h.failDelete) {
        // A failed (non-2xx) delete: the canvas is NOT removed. deleteCanvas must
        // un-mark the id (so its saves work again) and surface, not silently strand it.
        h.log.push(`delete-fail:${id}`)
        return reply(false, 500, {})
      }
      h.log.push(`delete:${id}`)
      h.server.delete(id)
      const i = h.order.indexOf(id)
      if (i >= 0) h.order.splice(i, 1)
      h.state.activeId = h.order[0] ?? null
      return reply(true, 200, { index: { order: [...h.order], activeId: h.state.activeId } })
    }
    if (action === 'rename') {
      const id = json.id as string
      h.log.push(`rename:${id}`)
      const e = h.server.get(id)
      if (!e) return reply(false, 404, {})
      e.name = json.name as string
      e.rev += 1
      return reply(true, 200, fullFile(id))
    }
    if (action === 'active') {
      h.state.activeId = (json.id as string) ?? null
      return reply(true, 200, { ok: true })
    }
    if (action === 'reorder') return reply(true, 200, { ok: true })
    // save (no action) under OCC. Evaluated lazily so a GATED save reads the
    // server's state at RELEASE time, not call time — the resurrection check
    // (`!cur`) must observe whatever a delete that landed meanwhile did.
    const c = json.canvas as CanvasFile
    const runSave = () => {
      const id = c.id
      h.log.push(`save:${id}`)
      const cur = h.server.get(id)
      if (!cur) {
        // Resurrection: a save for a canvas no longer on disk re-creates it.
        h.server.set(id, {
          name: c.name,
          elements: c.elements,
          rev: (Number.isFinite(c.rev) ? c.rev : 0) + 1,
        })
        if (!h.order.includes(id)) h.order.push(id)
        return reply(true, 200, fullFile(id))
      }
      if (c.rev === cur.rev) {
        cur.name = c.name
        cur.elements = c.elements
        cur.rev += 1
        return reply(true, 200, fullFile(id))
      }
      return reply(false, 409, { canvas: fullFile(id) })
    }
    if (!h.gateSaves) return runSave()
    // Held in flight: park a resolver the test releases to land the save.
    return new Promise((resolve) => {
      h.gatedResolvers.push(() => resolve(runSave()))
    })
  }
  return { api: { api: { project: { canvases: { $get, $post } } } } }
})

import { ProjectCanvas } from './ProjectCanvas'

const seed = () => {
  h.server.set('c1', { name: 'Foo', elements: [el('a')], rev: 1 })
  h.server.set('c2', { name: 'Baz', elements: [], rev: 1 })
  h.order.push('c1', 'c2')
  h.state.activeId = 'c1'
}

// Render and wait until bootstrap finishes (active canvas mounted → props captured).
const mountLoaded = async () => {
  render(<ProjectCanvas projectPath="/p" />)
  await waitFor(() => expect(h.ws.props).not.toBeNull())
  await waitFor(() => expect(h.pages.props).not.toBeNull())
  return h.ws.props!
}

const idsOf = (id: string) => h.server.get(id)!.elements.map((e) => e.id)

beforeEach(() => {
  h.server.clear()
  h.order.length = 0
  h.log.length = 0
  h.state.activeId = null
  h.state.n = 1
  h.ws.props = null
  h.pages.props = null
  h.gateSaves = false
  h.gatedResolvers.length = 0
  h.failDelete = false
  h.collab = null
  h.remoteCbs.length = 0
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('ProjectCanvas — rename does not lose to a pending debounced save (bug 1)', () => {
  it('a rename within the debounce window survives (the stale-name save must not revert it)', async () => {
    seed()
    const ws = await mountLoaded()
    expect(ws.canvas.id).toBe('c1')
    expect(ws.canvas.name).toBe('Foo')

    vi.useFakeTimers()
    // 1) Edit an element → persistActive arms a debounced save snapshotting the
    //    CURRENT (old) name "Foo".
    act(() => {
      ws.onChange({ ...ws.canvas, elements: [...ws.canvas.elements, el('b')] })
    })
    // 2) Rename the tab BEFORE the debounce fires.
    await act(async () => {
      await h.pages.props!.onRename('c1', 'Bar')
    })
    // 3) Let any still-pending debounced save fire (the buggy path clobbers here).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50)
    })
    vi.useRealTimers()

    // The rename survived on disk …
    expect(h.server.get('c1')!.name).toBe('Bar')
    // … and the in-flight edit was preserved too.
    expect(idsOf('c1')).toContain('b')
  })

  it('a normal rename (no pending edit) persists the new name and leaves elements alone', async () => {
    seed()
    await mountLoaded()
    await act(async () => {
      await h.pages.props!.onRename('c1', 'Renamed')
    })
    expect(h.server.get('c1')!.name).toBe('Renamed')
    expect(idsOf('c1')).toEqual(['a'])
  })
})

describe('ProjectCanvas — delete does not resurrect via a pending debounced save (bug 2)', () => {
  it('a delete is not undone by the pending edit-save landing after it (no ghost canvas)', async () => {
    seed()
    const ws = await mountLoaded()

    vi.useFakeTimers()
    // Edit the active canvas, then delete it before the debounce fires.
    act(() => {
      ws.onChange({ ...ws.canvas, elements: [...ws.canvas.elements, el('b')] })
    })
    await act(async () => {
      await h.pages.props!.onDelete('c1')
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50)
    })
    vi.useRealTimers()

    // The deleted canvas stays gone — the late save must not re-create it.
    expect(h.server.has('c1')).toBe(false)
    expect([...h.order]).not.toContain('c1')
  })

  it('a delete is not undone by an IN-FLIGHT edit-save (debounce already fired) — no ghost', async () => {
    // The sibling test covers the timer-NOT-yet-fired leg (pendingRef still holds
    // the payload, so flushPending enqueues + awaits it). This covers the leg the
    // server's KNOWN-RESIDUAL comment names (canvasData.ts saveCanvasFile): the
    // debounce ALREADY fired, so the save is on the wire and pendingRef is null.
    // flushPending must STILL await that in-flight save before the delete POST, or
    // the late save lands after the delete and resurrects the canvas as a ghost.
    seed()
    const ws = await mountLoaded()

    vi.useFakeTimers()
    // Hold the next save in flight, then edit + let the debounce fire so the save
    // is ON THE WIRE (parked, not landed) with the debounced payload cleared.
    h.gateSaves = true
    act(() => {
      ws.onChange({ ...ws.canvas, elements: [...ws.canvas.elements, el('b')] })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50)
    })
    vi.useRealTimers()
    // The save fired and is parked in flight; no debounced payload remains.
    expect(h.gatedResolvers).toHaveLength(1)

    await act(async () => {
      h.gateSaves = false // don't gate the resurrection re-save, only the in-flight one
      const deleteP = h.pages.props!.onDelete('c1')
      // Give the BUGGY path room to run its un-awaited delete POST first (it does
      // not wait for the in-flight save) …
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      // … then land the in-flight save. Buggy: it hits a now-deleted canvas and
      // resurrects it. Fixed: flushPending was awaiting it, so the delete hasn't
      // run yet — the save lands on the live canvas, THEN the delete removes it.
      h.gatedResolvers.splice(0).forEach((r) => r())
      await deleteP
      // Drain the landed save's commit (onSaved → setCanvases) inside act.
      await Promise.resolve()
      await Promise.resolve()
    })

    // The deleted canvas stays gone — the in-flight save must not re-create it.
    expect(h.server.has('c1')).toBe(false)
    expect([...h.order]).not.toContain('c1')
  })

  it('an edit DURING deleteCanvas’s flush-await does not resurrect the canvas (bug 3)', async () => {
    // bugs 2a/2b cover edits that exist BEFORE deleteCanvas runs (a pending payload
    // or an already-in-flight save). This covers an edit that arrives WHILE
    // deleteCanvas is parked on `await flushPending()` — the window the in-flight-
    // await fix widened to a full RTT. A user edit here (a collab onRemote persist
    // is the SAME path — both funnel through persistActive) arms a FRESH debounced
    // save for the doomed id during that window; without the per-id deleting guard
    // it fires AFTER the delete POST and the server upsert resurrects it as a ghost.
    seed()
    const ws = await mountLoaded()

    vi.useFakeTimers()
    // 1) Park an edit-save IN FLIGHT so deleteCanvas's flushPending() has a real
    //    await window (it awaits the chain tail = this gated save).
    h.gateSaves = true
    act(() => {
      ws.onChange({ ...ws.canvas, elements: [...ws.canvas.elements, el('b')] })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50)
    })
    expect(h.gatedResolvers).toHaveLength(1)

    await act(async () => {
      h.gateSaves = false // the (buggy) resurrection re-save must NOT be gated
      // 2) Enter deleteCanvas: it marks c1 deleting, then parks on flushPending(),
      //    awaiting the gated save above — it is now suspended INSIDE its window.
      const deleteP = h.pages.props!.onDelete('c1')
      await Promise.resolve()
      // 3) DURING that window, edit the still-live, still-active c1 again. Read the
      //    LIVE props (step 1 re-rendered the workspace). Without the guard this
      //    persistActive arms a fresh 400ms timer for the doomed id.
      h.ws.props!.onChange({ ...h.ws.props!.canvas, elements: [el('a'), el('c')] })
      // 4) Release the gated save (it lands on the still-live c1), so flushPending
      //    resolves and deleteCanvas runs its delete POST + refresh to completion.
      h.gatedResolvers.splice(0).forEach((r) => r())
      await deleteP
      // 5) Fire the timer that step 3 would have armed — now AFTER the delete.
      //    Buggy: it POSTs a canvas no longer on disk → resurrection. Fixed: the
      //    guard dropped the save (it was never armed), so nothing fires here.
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50)
    })
    vi.useRealTimers()

    // The deleted canvas stays gone — the window edit must not re-create it …
    expect(h.server.has('c1')).toBe(false)
    expect([...h.order]).not.toContain('c1')
    // … and the unrelated canvas is untouched.
    expect(h.server.has('c2')).toBe(true)
  })

  it('a peer (collab onRemote) persist DURING the flush-await does not resurrect it (bug 3, collab leg)', async () => {
    // The sibling bug-3 test drives the window persist through the USER path
    // (CanvasWorkspace.onChange → handleActiveChange). This drives it through the
    // COLLAB path (collab.onRemote → setActive + persistActive) — the other source
    // the goal names. Both funnel through persistActive, so the per-id guard must
    // drop either; this proves the onRemote wiring respects the guard in the window.
    h.collab = {
      seed: () => {},
      // A peer change merged onto our LIVE canvas (same id → the doomed one).
      extract: (base) => ({ ...base, elements: [...base.elements, el('remote')] }),
      onRemote: (cb) => {
        h.remoteCbs.push(cb)
        return () => {}
      },
    }
    seed()
    const ws = await mountLoaded()
    await waitFor(() => expect(h.remoteCbs).toHaveLength(1)) // ProjectCanvas subscribed

    vi.useFakeTimers()
    h.gateSaves = true
    act(() => {
      ws.onChange({ ...ws.canvas, elements: [...ws.canvas.elements, el('b')] })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50)
    })
    expect(h.gatedResolvers).toHaveLength(1)

    await act(async () => {
      h.gateSaves = false
      const deleteP = h.pages.props!.onDelete('c1')
      await Promise.resolve()
      // DURING the flush-await window a peer change arrives → onRemote fires →
      // persistActive(merged) for the doomed id. The guard must drop it.
      h.remoteCbs.forEach((cb) => cb())
      h.gatedResolvers.splice(0).forEach((r) => r())
      await deleteP
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50)
    })
    vi.useRealTimers()

    expect(h.server.has('c1')).toBe(false)
    expect([...h.order]).not.toContain('c1')
  })

  it('a FAILED delete un-marks the id so the canvas stays saveable (no silent data-loss)', async () => {
    // The per-id deleting mark is set BEFORE the delete POST (to close the ghost
    // window). If the POST then fails — a transient error, a server swap mid-RTT,
    // or a non-2xx body — the canvas still exists, so the mark MUST be removed: a
    // stuck mark silently drops every future save to that still-mounted canvas
    // (data loss, strictly worse than the ghost). deleteCanvas's catch un-marks and
    // surfaces the failure. This regression test is the reason the catch exists.
    seed()
    await mountLoaded()

    // The next delete 500s (non-2xx). onDelete is fire-and-forget in PagesSection,
    // so deleteCanvas must NOT reject — it surfaces internally.
    h.failDelete = true
    await act(async () => {
      await h.pages.props!.onDelete('c1')
    })

    // The canvas survived the failed delete …
    expect(h.server.has('c1')).toBe(true)
    expect([...h.order]).toContain('c1')
    // … the failure was surfaced (the save-error notice), not swallowed …
    expect(screen.queryByRole('alert')).not.toBeNull()

    // CRITICAL: the canvas is saveable AGAIN — a later edit must persist. Without
    // the un-mark this save is silently dropped and the user's edit is lost.
    h.failDelete = false
    vi.useFakeTimers()
    act(() => {
      h.ws.props!.onChange({ ...h.ws.props!.canvas, elements: [el('a'), el('after-fail')] })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50)
    })
    vi.useRealTimers()

    expect(idsOf('c1')).toContain('after-fail')
  })

  it('a normal delete (no pending edit) removes only that canvas', async () => {
    seed()
    await mountLoaded()
    await act(async () => {
      await h.pages.props!.onDelete('c1')
    })
    expect(h.server.has('c1')).toBe(false)
    expect(h.server.has('c2')).toBe(true)
  })
})

describe('ProjectCanvas — the ordinary debounced save still works', () => {
  it('a plain edit is persisted when the debounce fires', async () => {
    seed()
    const ws = await mountLoaded()

    vi.useFakeTimers()
    act(() => {
      ws.onChange({ ...ws.canvas, elements: [...ws.canvas.elements, el('b')] })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS + 50)
    })
    vi.useRealTimers()

    expect(idsOf('c1')).toEqual(['a', 'b'])
  })
})
