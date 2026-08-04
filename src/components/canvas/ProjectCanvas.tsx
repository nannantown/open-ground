import { useCallback, useEffect, useRef, useState } from 'react'
import { useBoardCollab, useCanvasCollab } from '@/lib/collab/RealtimeContext'
import { usePublishPresence } from '@/components/canvas/CollabPresence'
import { useT } from '@/i18n/I18nContext'
import { PagesSection } from './PagesSection'
import { CanvasWorkspace } from './CanvasWorkspace'
import type {
  CanvasElement,
  CanvasFile,
  CanvasSummary,
  CanvasesIndex,
} from '@/lib/types'
import { reconcileCanvasElements } from '@/lib/canvasMerge'
import { api } from '@/lib/api-client'

interface Props {
  /** Absolute project path — used as the API path argument and as the
   *  remount key so switching projects throws away in-flight state. */
  projectPath: string
}

// Persist no faster than once per 400ms — fast pan/zoom and rapid chat edits
// otherwise hammer the disk. The active Canvas is held in memory and flushed
// on every change; on unmount we flush synchronously so a quick tab-out
// doesn't drop the last edit.
const SAVE_DEBOUNCE_MS = 400

// Optimistic concurrency: a save whose rev is behind the server's (a Canvas AI
// job appended/tweaked since this client loaded the canvas) is rejected 409; we
// refetch, 3-way-merge our edits with the server's new elements, and retry
// against the fresh rev. Bounded so a canvas under a burst of AI writes can't
// loop forever — on exhaustion we flush the last merge once (see
// saveCanvasWithOcc) so it can't be lost silently. Exported so the save-loop
// unit test exercises the real production bound.
export const MAX_SAVE_RETRIES = 5

// The reason a bottom-right recovery notice is showing. A discriminated kind
// (not a bare boolean) so a failed delete shows its OWN wording instead of
// borrowing the save-conflict copy: 'save-conflict' = a debounced save exhausted
// its OCC retries (re-save to land the merged edits); 'delete-failed' = a canvas
// delete POST never landed (the canvas still exists and is saveable — re-save to
// keep any edit dropped during the attempt). null = no notice.
type CanvasNotice = 'save-conflict' | 'delete-failed'

// ⌘\ focus-mode choice survives reloads. '0' = hidden; anything else visible.
const SIDEBARS_KEY = 'openground.canvas.sidebars'

// Owner asset-upload (u14b) retry backoff: a failed upload isn't retried until
// this long has passed, so a persistently-failing R2/Worker can't be hammered by
// the sweep re-firing on every canvas change during active collaboration.
const ASSET_RETRY_COOLDOWN_MS = 30_000

// ── Canvas save under optimistic concurrency control (OCC) ─────────────────
// Extracted from the component (mirroring reconcileCanvasElements) so the retry
// loop is a pure, deterministically-testable unit with no React/fetch coupling.

/** One POST attempt's outcome, normalised so the OCC loop never touches
 *  `fetch`/`Response`. */
export type CanvasSavePost =
  | { kind: 'saved'; saved: CanvasFile }
  | { kind: 'conflict'; serverCanvas: CanvasFile | null }
  | { kind: 'error' }

/** The React side-effects the OCC save loop drives — the seam the unit test
 *  injects fakes through (rev/base store, the POST transport, local-state
 *  reflection, and the save-failure notice). */
export interface CanvasSaveOcc {
  /** POST `payload` echoing `expectedRev`; classify the response. */
  post: (payload: CanvasFile, expectedRev: number) => Promise<CanvasSavePost>
  /** Refetch the server canvas when a 409 body carried none. */
  fetchCanvas: (id: string) => Promise<CanvasFile | null>
  getRev: (id: string) => number
  setRev: (id: string, rev: number) => void
  getBase: (id: string) => CanvasElement[]
  setBase: (id: string, elements: CanvasElement[]) => void
  /** Freshest local canvas for `id` while it's still active (the merge's
   *  `local` leg — the user may have edited mid-round-trip), else null. */
  liveLocal: (id: string) => CanvasFile | null
  /** A server-confirmed save landed: `sent` is exactly what the server now
   *  holds. (Refresh the tab-bar timestamp + clear any save-failure notice.) */
  onSaved: (id: string, saved: CanvasFile, sent: CanvasFile) => void
  /** Reflect a 3-way merge into local state so AI additions appear at once. */
  onMerged: (merged: CanvasFile) => void
  /** Retries were exhausted (or a post-merge transport error stopped them) AND
   *  the final flush save still couldn't land → let the user re-save manually
   *  instead of losing the merge silently on the next reload. */
  onExhausted: (id: string) => void
  maxRetries: number
}

/** Persist a full canvas under OCC. Sends the rev we're synced to for THIS id;
 *  on 409 (an AI job advanced the file since our base) refetch, 3-way-merge
 *  (keep our edits ∪ the AI's new/updated elements, never resurrect our
 *  deletions), reflect the merge locally, and retry against the fresh rev —
 *  bounded by `maxRetries`.
 *
 *  DATA-LOSS GUARD: the loop merges on its FINAL iteration too, so on exhaustion
 *  the freshly-merged payload has been reflected into local state (via onMerged)
 *  but NEVER sent — and would be silently lost on the next reload (it lives only
 *  in memory). So after the loop — whether it exhausted its retries or broke out
 *  on a post-merge transport error — flush the last merged payload ONCE; if even
 *  that can't land, surface onExhausted so the user can re-save. A normal save (a
 *  success inside the loop) returns before this tail, so its behaviour is
 *  unchanged. */
export async function saveCanvasWithOcc(
  initial: CanvasFile,
  occ: CanvasSaveOcc,
): Promise<void> {
  const id = initial.id
  let payload = initial
  let mergedUnsaved = false

  const commit = (saved: CanvasFile, sent: CanvasFile, expectedRev: number) => {
    occ.setRev(id, Number.isFinite(saved.rev) ? saved.rev : expectedRev + 1)
    // The server now holds exactly what we sent → it's the new merge base.
    occ.setBase(id, sent.elements)
    occ.onSaved(id, saved, sent)
  }

  for (let attempt = 0; attempt <= occ.maxRetries; attempt++) {
    const expectedRev = occ.getRev(id)
    const res = await occ.post(payload, expectedRev)
    if (res.kind === 'saved') {
      commit(res.saved, payload, expectedRev)
      return
    }
    // Non-409 mid-loop: stop retrying. If a merge is already pending-unsaved we
    // still fall through to the final flush below; otherwise (e.g. a transient
    // error on the very first attempt, nothing merged yet) the prior
    // fire-and-forget behaviour stands — the next edit re-saves.
    if (res.kind === 'error') break
    // 409 → refetch + 3-way-merge + retry against the fresh rev.
    let serverCanvas = res.serverCanvas
    if (!serverCanvas) serverCanvas = await occ.fetchCanvas(id)
    // Couldn't obtain the server's state to merge against → stop, but `break`
    // (not `return`) so any merge from a PRIOR iteration still gets flushed
    // below — same silent-loss guard as the non-409 break above. (Unreachable in
    // prod: the server's 409 always carries the canvas; defensive symmetry.)
    if (!serverCanvas) break
    const live = occ.liveLocal(id)
    const local = live ?? payload
    const merged: CanvasFile = {
      ...local,
      elements: reconcileCanvasElements(
        occ.getBase(id),
        local.elements,
        serverCanvas.elements,
      ),
      rev: serverCanvas.rev,
    }
    // We now KNOW the server holds serverCanvas at this rev → new merge base.
    occ.setRev(id, Number.isFinite(serverCanvas.rev) ? serverCanvas.rev : expectedRev)
    occ.setBase(id, serverCanvas.elements)
    // Reflect the reconciled canvas so AI additions appear immediately — but
    // only while we're still on this canvas (a mid-flight switch must win).
    if (live) occ.onMerged(merged)
    payload = merged
    mergedUnsaved = true
  }

  // Nothing merged → the loop left nothing unpersisted (a normal success already
  // returned above; a no-merge transient error drops as before).
  if (!mergedUnsaved) return

  // Flush the last merged payload ONCE so a burst of conflicting writes can't
  // silently drop the user's merged edits.
  const expectedRev = occ.getRev(id)
  const res = await occ.post(payload, expectedRev)
  if (res.kind === 'saved') {
    commit(res.saved, payload, expectedRev)
    return
  }
  // Even the flush lost the race (still conflicting) or errored → notify.
  occ.onExhausted(id)
}

// Top-level orchestrator for the Canvas tab — the Figma-style docked 3-pane
// shell. Left sidebar: Pages (Canvas list) over a Layers slot; centre: the
// active CanvasWorkspace; right sidebar: the inspector slot. The slots are
// plain host divs that CanvasWorkspace fills via portals (its selection /
// element state stays where it lives, while the sidebar frames stay mounted
// across Canvas switches so the shell never flashes). Owns
//  • the list of Canvases + the active id (sourced from .openground/canvases-index.json
//    via /api/project/canvases)
//  • the full file for the active Canvas (the only one fetched at a time —
//    inactive Canvases stay on disk so heavy drawings don't all live in memory)
//  • debounced persistence + flush-on-unmount
//  • the ⌘\ both-sidebars toggle (focus mode), persisted to localStorage
export const ProjectCanvas = ({ projectPath }: Props) => {
  const { t, lang } = useT()
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<CanvasFile | null>(null)
  const activeRef = useRef<CanvasFile | null>(null)
  activeRef.current = active
  // Realtime collab for the ACTIVE canvas (null when OFF / not a member). Scope
  // is canvas:<activeId>, so switching canvases swaps docs automatically.
  const collab = useCanvasCollab(projectPath, activeId)
  // OWNER publish of the SHARED canvas index (cv2): a second, board-scope binding
  // (null when OFF / not a member) used ONLY to write `m:canvasIndex` so a
  // folder-less member can discover this project's canvases. It does NOT seed the
  // board (BoardModule owns that on the Board tab); writing only m:canvasIndex
  // upholds the two-writer no-clobber invariant (see boardDoc.ts).
  const boardCollab = useBoardCollab(projectPath)
  // Presence (u15): publish the owner's identity into the board room while on the
  // Canvas tab, so members see them online here too.
  usePublishPresence(boardCollab)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    // Gate on `loaded`: before the canvas list has loaded, `canvases` is [] — and
    // publishing an empty index could briefly LWW-win over a real server index
    // (clientID tiebreak), flickering the member's list empty (review LOW). Once
    // loaded, the list is real and this also re-fires causally after any merge.
    if (!boardCollab || !loaded) return
    const index = canvases.map((c) => ({ id: c.id, name: c.name }))
    let cancelled = false
    // Lazy-import keeps boardDoc/yjs out of this module's static graph (OFF guard).
    void import('@/lib/collab/boardDoc').then((m) => {
      if (!cancelled) m.writeBoardCanvasIndex(boardCollab.doc, index)
    })
    return () => {
      cancelled = true
    }
  }, [boardCollab, canvases, loaded])
  const [sidebarsVisible, setSidebarsVisible] = useState(() => {
    try {
      return localStorage.getItem(SIDEBARS_KEY) !== '0'
    } catch {
      return true
    }
  })
  // Sidebar slot elements — state (not refs) so CanvasWorkspace re-renders its
  // portals when a slot mounts/unmounts (⌘\ toggle).
  const [layersHost, setLayersHost] = useState<HTMLDivElement | null>(null)
  const [inspectorHost, setInspectorHost] = useState<HTMLDivElement | null>(null)
  // Right dock visibility — driven by the active workspace's selection
  // (CanvasWorkspace calls onInspectorOpenChange). Collapsed → the canvas
  // widens into the freed space (Figma-style). Starts closed: a freshly
  // mounted canvas has no selection.
  const [inspectorOpen, setInspectorOpen] = useState(false)
  // Set when a recovery affordance must surface bottom-right: either a save that
  // can't land even after the bounded OCC retries + a final flush (a sustained
  // conflict burst), or a canvas delete that never landed. The kind drives the
  // wording so the two cases don't share one message. A 'save-conflict' notice is
  // cleared by any subsequent successful save (onSaved); a 'delete-failed' one
  // persists until the user dismisses or re-saves (a save landing doesn't prove
  // the delete it reports on succeeded).
  const [notice, setNotice] = useState<CanvasNotice | null>(null)

  // ⌘\ toggles both sidebars (Figma focus mode). Inert while the user is
  // typing — focused input/textarea/contenteditable or mid-IME-composition.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return
      // 'IntlYen' is the JIS keyboard's backslash position (¥) — same physical
      // shortcut as ⌘\ on ANSI/ISO layouts.
      if (e.key !== '\\' && e.code !== 'Backslash' && e.code !== 'IntlYen') return
      if (e.isComposing) return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)
      )
        return
      e.preventDefault()
      setSidebarsVisible((v) => {
        const next = !v
        try {
          localStorage.setItem(SIDEBARS_KEY, next ? '1' : '0')
        } catch {
          /* storage unavailable — toggle still works in-session */
        }
        return next
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // No active canvas → nothing is selectable, so keep the right dock collapsed.
  // Once a canvas mounts, CanvasWorkspace re-drives openness from its selection
  // via onInspectorOpenChange.
  const hasActiveCanvas = active != null
  useEffect(() => {
    if (!hasActiveCanvas) setInspectorOpen(false)
  }, [hasActiveCanvas])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingRef = useRef<CanvasFile | null>(null)

  const refreshList = useCallback(async (): Promise<{ index: CanvasesIndex; canvases: CanvasSummary[] }> => {
    const res = await api.api.project.canvases.$get(
      { query: { path: projectPath } },
      { init: { cache: 'no-store' } },
    )
    const data = (await res.json()) as { index: CanvasesIndex; canvases: CanvasSummary[] }
    setCanvases(data.canvases)
    setActiveId(data.index.activeId)
    return data
  }, [projectPath])

  const fetchCanvas = useCallback(
    async (id: string): Promise<CanvasFile | null> => {
      const res = await api.api.project.canvases.$get(
        { query: { path: projectPath, id } },
        { init: { cache: 'no-store' } },
      )
      if (!res.ok) return null
      return (await res.json()) as CanvasFile
    },
    [projectPath],
  )

  // ── Optimistic concurrency control (OCC) state ───────────────────────────
  // Per-canvas-id: the server rev this client is synced to, and the element set
  // at that rev (the 3-way-merge base). KEYED BY ID — not a single "active" pair
  // — because a save for a canvas the user just switched AWAY from can still be
  // finishing on the chain (e.g. an AI job appended to it mid-navigation); a
  // global pair would let that late save's rev/base clobber the just-adopted new
  // canvas's state. Refs so the serialised save chain reads the freshest values.
  const revByIdRef = useRef<Map<string, number>>(new Map())
  const baseByIdRef = useRef<Map<string, CanvasElement[]>>(new Map())
  // All saves funnel through one promise chain so a 409 refetch+merge+retry
  // can't interleave with a concurrent debounced save racing the same id's state.
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())

  // Canvas ids whose deletion has begun. deleteCanvas marks the id here BEFORE
  // its flush-await, and every save chokepoint drops a payload whose id is marked
  // (persistActive won't arm a debounced save; enqueueSave won't POST). WHY: during
  // deleteCanvas's `await flushPending()` — widened to a full server RTT by the
  // in-flight-await fix — a user edit or a collab onRemote persist can arm a FRESH
  // debounced save for the doomed id; landing AFTER the delete POST it re-creates
  // the canvas (the server upserts the unknown id, self-healing listCanvases
  // revives it) as a ghost. An id is removed again ONLY if its delete fails before
  // the server confirms it (deleteCanvas's catch — the canvas still exists, so its
  // saves must work again); a confirmed-deleted id stays (UUIDs never recur). The
  // whole set is also cleared on project switch alongside the OCC maps.
  const deletingIdsRef = useRef<Set<string>>(new Set())

  // Adopt a freshly-loaded server canvas as the OCC base (rev + elements) for its id.
  const adoptServerCanvas = useCallback((file: CanvasFile) => {
    revByIdRef.current.set(file.id, Number.isFinite(file.rev) ? file.rev : 0)
    baseByIdRef.current.set(file.id, file.elements)
  }, [])

  // Persist a full canvas via the pure saveCanvasWithOcc loop above — this
  // wrapper only wires the React side-effects (the per-id rev/base maps, the
  // POST transport, setActive on a merge, tab-bar timestamps, and the
  // save-failure notice) into it. Exhausted retries / a post-merge failure no
  // longer drop the merge silently: the loop flushes the last merged payload
  // once and, if even that can't land, flips the notice to 'save-conflict' so the
  // user can re-save.
  const doSave = useCallback(
    (initial: CanvasFile): Promise<void> =>
      saveCanvasWithOcc(initial, {
        post: async (payload, expectedRev) => {
          const res = await api.api.project.canvases.$post({
            json: { path: projectPath, canvas: { ...payload, rev: expectedRev } },
          })
          if (res.ok) return { kind: 'saved', saved: (await res.json()) as CanvasFile }
          if (res.status !== 409) return { kind: 'error' }
          let serverCanvas: CanvasFile | null = null
          try {
            const conflict = (await res.json()) as { canvas?: CanvasFile }
            serverCanvas = conflict.canvas ?? null
          } catch {
            serverCanvas = null
          }
          return { kind: 'conflict', serverCanvas }
        },
        fetchCanvas,
        getRev: (id) => revByIdRef.current.get(id) ?? 0,
        setRev: (id, rev) => revByIdRef.current.set(id, rev),
        getBase: (id) => baseByIdRef.current.get(id) ?? [],
        setBase: (id, elements) => baseByIdRef.current.set(id, elements),
        // Merge against our LATEST local state (the user may have edited during
        // the round-trip) when this canvas is still active; else the snapshot.
        liveLocal: (id) =>
          activeRef.current && activeRef.current.id === id ? activeRef.current : null,
        onSaved: (id, saved, sent) => {
          // A save landed → clear any prior save-conflict notice. Leave a
          // 'delete-failed' notice alone: this save isn't proof the delete it
          // reports on succeeded, so that notice is the delete path's to clear.
          setNotice((n) => (n === 'save-conflict' ? null : n))
          // Keep tab-bar timestamps fresh without an extra round-trip.
          setCanvases((prev) =>
            prev.map((c) =>
              c.id === id ? { ...c, name: sent.name, updatedAt: saved.updatedAt } : c,
            ),
          )
        },
        onMerged: (merged) => setActive(merged),
        onExhausted: () => setNotice('save-conflict'),
        maxRetries: MAX_SAVE_RETRIES,
      }),
    [projectPath, fetchCanvas],
  )

  // Serialise every save through one chain (see saveChainRef).
  const enqueueSave = useCallback(
    (payload: CanvasFile): Promise<void> => {
      // Drop a save for a canvas whose delete has begun — POSTing it resurrects it
      // as a ghost (the server upserts the unknown id). Return the chain TAIL (not a
      // bare resolve) so deleteCanvas's flushPending() still drains any genuinely
      // in-flight save before its delete POST. This is the comprehensive backstop —
      // every save path (debounce timer, flush, the re-save button) funnels here.
      if (deletingIdsRef.current.has(payload.id)) return saveChainRef.current.catch(() => {})
      const run = saveChainRef.current.catch(() => {}).then(() => doSave(payload))
      saveChainRef.current = run.catch(() => {})
      return run
    },
    [doSave],
  )

  // Bootstrap: read the index, then either fetch the active Canvas or create
  // a first one. Re-runs on project switch so state never leaks across cards.
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setActive(null)
    // New project → the prior project's per-id OCC state is irrelevant; clear it
    // so the maps don't accumulate across projects over a long session.
    revByIdRef.current.clear()
    baseByIdRef.current.clear()
    deletingIdsRef.current.clear()
    ;(async () => {
      const { index, canvases: list } = await refreshList()
      if (cancelled) return
      if (list.length === 0) {
        const res = await api.api.project.canvases.$post({
          query: { action: 'create' },
          json: { path: projectPath },
        })
        const data = (await res.json()) as { index: CanvasesIndex; canvas: CanvasFile }
        if (cancelled) return
        await refreshList()
        setActive(data.canvas)
        adoptServerCanvas(data.canvas)
        setLoaded(true)
        return
      }
      const id = index.activeId ?? list[0].id
      const file = await fetchCanvas(id)
      if (cancelled) return
      setActive(file)
      if (file) adoptServerCanvas(file)
      setLoaded(true)
    })().catch(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath, refreshList, fetchCanvas, adoptServerCanvas])

  // Flush whatever's pending whenever the active id changes (so switching
  // Canvases doesn't drop the prior one's last unsaved edit). Same on unmount.
  // Returns a promise that resolves once BOTH the not-yet-fired debounced save
  // AND any save already in flight on the chain have landed — so a caller about
  // to RE-READ or MUTATE this canvas (deleteCanvas / renameCanvas) can await the
  // write instead of racing it; the fire-and-forget call sites just ignore it.
  const flushPending = useCallback((): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const payload = pendingRef.current
    if (!payload) {
      // No debounced payload waiting — but a PREVIOUSLY-debounced save may have
      // already fired and still be in flight on the chain (its timer elapsed, so
      // its payload moved onto saveChainRef and pendingRef was cleared). A caller
      // that next mutates this same canvas — deleteCanvas / renameCanvas await
      // this — must land AFTER that in-flight save, or the late save races their
      // mutation: re-creating a just-deleted canvas as a ghost (the server upsert
      // re-orphans it, listCanvases revives it) or reverting a rename. Await the
      // chain tail so "flush" means "every save has landed", not just the
      // not-yet-fired one. (enqueueSave below already chains off this tail, so the
      // payload path awaits any in-flight save too.)
      return saveChainRef.current.catch(() => {})
    }
    pendingRef.current = null
    return enqueueSave(payload)
  }, [enqueueSave])

  useEffect(() => {
    return () => {
      void flushPending()
    }
  }, [flushPending])

  const persistActive = useCallback(
    (next: CanvasFile) => {
      // A canvas being deleted must not arm a new debounced save: firing after the
      // delete POST it would ghost-resurrect the canvas. This is the window a user
      // edit or a collab onRemote persist slips through while deleteCanvas is parked
      // on its flush-await (it marks the id first). enqueueSave double-checks below.
      if (deletingIdsRef.current.has(next.id)) return
      pendingRef.current = next
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const payload = pendingRef.current
        if (!payload) return
        pendingRef.current = null
        saveTimer.current = null
        // doSave (via the chain) handles the rev round-trip, the tab-bar
        // timestamp refresh, and 409 → refetch+merge+retry.
        void enqueueSave(payload)
      }, SAVE_DEBOUNCE_MS)
    },
    [enqueueSave],
  )

  const handleActiveChange = useCallback(
    (next: CanvasFile) => {
      setActive(next)
      persistActive(next)
    },
    [persistActive],
  )

  // Realtime: mirror every local canvas change into the shared Y.Doc (seed is
  // idempotent → loop-safe; this also seeds the doc once the canvas loads), and
  // apply peer changes by feeding the merged file through setActive + persist
  // (CanvasWorkspace's external-adoption path renders it). OFF → both no-op.
  useEffect(() => {
    if (collab && active) collab.seed(active)
  }, [collab, active])

  useEffect(() => {
    if (!collab) return
    return collab.onRemote(() => {
      const base = activeRef.current
      if (!base) return
      const merged = collab.extract(base)
      setActive(merged)
      persistActive(merged)
    })
  }, [collab, persistActive])

  // Owner asset upload (u14b): while this canvas is collab-shared, push any local
  // image bytes members can't see yet to shared storage (R2 via the loopback
  // proxy), then write the returned storageKey onto the element so the doc
  // carries it to members (the seed effect above mirrors it). Self-terminating —
  // once an element has a storageKey the filter skips it; uploadingRef dedupes
  // concurrent attempts and a failed upload is retried on a later change. Owner-
  // only by construction (members render SharedCanvasView, not ProjectCanvas).
  const uploadingRef = useRef<Set<string>>(new Set())
  const failedAtRef = useRef<Map<string, number>>(new Map())
  useEffect(() => {
    if (!collab || !active || !projectPath) return
    const canvasId = active.id
    const now = Date.now()
    const pending = active.elements.filter((e) => {
      if (e.type !== 'image' || !e.assetId || e.storageKey) return false
      if (uploadingRef.current.has(e.assetId)) return false // in-flight
      const failedAt = failedAtRef.current.get(e.assetId)
      if (failedAt !== undefined && now - failedAt < ASSET_RETRY_COOLDOWN_MS) return false // backoff
      return true
    })
    if (pending.length === 0) return
    let cancelled = false
    void (async () => {
      const m = await import('@/lib/collab/assetSync')
      const updates = new Map<string, string>() // elementId -> storageKey
      for (const el of pending) {
        const aid = el.assetId as string
        uploadingRef.current.add(aid)
        const key = await m.uploadCanvasAsset(projectPath, canvasId, aid)
        if (key) {
          updates.set(el.id, key)
          failedAtRef.current.delete(aid) // clear any prior failure
        } else {
          uploadingRef.current.delete(aid)
          failedAtRef.current.set(aid, Date.now()) // back off before retrying
        }
      }
      if (cancelled || updates.size === 0) return
      const base = activeRef.current
      if (!base || base.id !== canvasId) return // canvas switched mid-upload
      const merged: CanvasFile = {
        ...base,
        elements: base.elements.map((e) =>
          updates.has(e.id) ? { ...e, storageKey: updates.get(e.id) } : e,
        ),
      }
      setActive(merged)
      persistActive(merged) // → the seed effect mirrors storageKey to members
    })()
    return () => {
      cancelled = true
    }
  }, [collab, active, projectPath, persistActive])

  const switchTo = useCallback(
    async (id: string) => {
      if (id === activeId) return
      flushPending()
      setActiveId(id)
      setActive(null)
      // Tell the server which Canvas is now active so a reload restores it.
      api.api.project.canvases
        .$post({ query: { action: 'active' }, json: { path: projectPath, id } })
        .catch(() => {})
      const file = await fetchCanvas(id)
      setActive(file)
      if (file) adoptServerCanvas(file)
    },
    [activeId, flushPending, fetchCanvas, projectPath, adoptServerCanvas],
  )

  const createCanvas = useCallback(async () => {
    flushPending()
    const res = await api.api.project.canvases.$post({
      query: { action: 'create' },
      json: { path: projectPath },
    })
    const data = (await res.json()) as { index: CanvasesIndex; canvas: CanvasFile }
    setCanvases((prev) => [
      ...prev,
      { id: data.canvas.id, name: data.canvas.name, updatedAt: data.canvas.updatedAt },
    ])
    setActiveId(data.canvas.id)
    setActive(data.canvas)
    adoptServerCanvas(data.canvas)
  }, [flushPending, projectPath, adoptServerCanvas])

  const deleteCanvas = useCallback(
    async (id: string) => {
      // Mark the id deleting BEFORE anything async runs: from here on persistActive
      // and enqueueSave drop any save for this id (see deletingIdsRef). That closes
      // the window where a user edit / collab onRemote persist, arriving DURING the
      // flush-await below, arms a fresh debounced save that fires AFTER the delete
      // POST and resurrects the canvas as a ghost.
      deletingIdsRef.current.add(id)
      // `confirmed` flips only once the server has actually removed the canvas
      // (res.ok). It's the un-mark boundary: BEFORE it, any failure leaves the
      // canvas still existing, so we MUST un-mark (a stuck mark silently drops every
      // future save to that still-mounted canvas — data loss, strictly worse than
      // the ghost the mark guards against). AFTER it the canvas is gone, so the mark
      // stays even if the UI-refresh below throws (un-marking then would let a later
      // save re-create it as a ghost).
      let confirmed = false
      try {
        // Still AWAIT the flush: a save ALREADY in flight (dispatched before this
        // delete, mid-RTT) can't be cancelled — flushPending awaits the chain tail
        // so it lands while the canvas still exists, instead of after the delete
        // (which would re-create the just-deleted canvas as a ghost). The not-yet-
        // fired pending save, by contrast, the guard above drops — no point
        // persisting a canvas we're about to delete (a failed delete re-queues it
        // via the delete-failed notice's re-save path below).
        await flushPending()
        const res = await api.api.project.canvases.$post({
          query: { action: 'delete' },
          json: { path: projectPath, id },
        })
        // Check res.ok BEFORE res.json(): a non-2xx body may be non-JSON (json()
        // would throw an opaque parse error), and a failed delete must surface
        // rather than silently strand the canvas (and its now-stuck mark).
        if (!res.ok) throw new Error(`canvas delete failed: HTTP ${res.status}`)
        const data = (await res.json()) as {
          index: CanvasesIndex
          createdReplacement?: CanvasFile
        }
        confirmed = true
        // The deleted canvas's OCC state is dead — drop it (its id is a UUID and
        // never recurs, so a lingering entry would only leak).
        revByIdRef.current.delete(id)
        baseByIdRef.current.delete(id)
        // Refresh the list against the server's authoritative view rather than
        // patching locally — the "delete the last one" branch creates a
        // replacement we'd otherwise miss.
        const { index, canvases: list } = await refreshList()
        const target = index.activeId ?? list[0]?.id ?? null
        if (data.createdReplacement && target === data.createdReplacement.id) {
          setActive(data.createdReplacement)
          adoptServerCanvas(data.createdReplacement)
        } else if (target) {
          const file = await fetchCanvas(target)
          setActive(file)
          if (file) adoptServerCanvas(file)
        } else {
          setActive(null)
        }
      } catch (err) {
        if (!confirmed) {
          // Delete never landed — a transient/network failure, a server swap mid-RTT
          // (self-update canary / tsx-watch reload), or a non-2xx response. The
          // canvas still exists and is still mounted, so UN-MARK it: leaving the mark
          // would silently drop every future save to it (the edit the flush dropped,
          // plus anything the user types next). Trace the cause first — this catch is
          // the ONLY place a delete error surfaces (onDelete is fire-and-forget in
          // PagesSection, so a rejection would just be an unhandled promise) and the
          // bare `catch {}` here used to swallow it. Then surface a DELETE-specific
          // notice (not the save-conflict copy) whose "re-save" button re-persists
          // the now-saveable canvas's live state.
          console.error('canvas delete failed', err)
          deletingIdsRef.current.delete(id)
          setNotice('delete-failed')
        } else {
          // confirmed → the canvas is already gone; a UI-refresh failure here is not
          // data loss and must NOT un-mark (that would re-open the ghost race) — a
          // reload re-syncs the (now canvas-free or replacement) view. Still trace it
          // so a broken post-delete refresh isn't swallowed either.
          console.error('canvas delete: post-delete refresh failed', err)
        }
      }
    },
    [flushPending, projectPath, refreshList, fetchCanvas, adoptServerCanvas],
  )

  const renameCanvas = useCallback(
    async (id: string, name: string) => {
      // Flush any debounced edit-save FIRST (and await it). persistActive holds a
      // snapshot carrying the OLD name, and the rename below advances our synced
      // rev for this id — so a debounced save firing AFTER the rename would POST
      // that stale name against the now-matching rev (no 409 → it "succeeds") and
      // silently revert the rename on disk. Flushing first lands the edit under the
      // current name, then the rename wins. (deleteCanvas awaits its flush for the
      // same reason; switchTo/createCanvas flush fire-and-forget — they target a
      // DIFFERENT id, so a stale save there can't clobber the newly-adopted canvas.)
      await flushPending()
      const res = await api.api.project.canvases.$post({
        query: { action: 'rename' },
        json: { path: projectPath, id, name },
      })
      if (!res.ok) return
      const updated = (await res.json()) as CanvasFile
      setCanvases((prev) =>
        prev.map((c) => (c.id === id ? { ...c, name: updated.name, updatedAt: updated.updatedAt } : c)),
      )
      // Rename bumped the server rev (renameCanvas writes through the lock).
      // Advance our synced rev for THIS id so the next save isn't a needless
      // 409. Elements are untouched by a rename, so the merge base stays valid.
      if (revByIdRef.current.has(id)) {
        revByIdRef.current.set(
          id,
          Number.isFinite(updated.rev) ? updated.rev : revByIdRef.current.get(id) ?? 0,
        )
      }
      if (active && active.id === id) {
        setActive({ ...active, name: updated.name, updatedAt: updated.updatedAt })
      }
    },
    [projectPath, active, flushPending],
  )

  const reorderCanvases = useCallback(
    async (order: string[]) => {
      // Reorder locally first so the UI feels instant; server only stores the
      // index so failure is recoverable on next list().
      setCanvases((prev) => {
        const byId = new Map(prev.map((c) => [c.id, c]))
        const next: CanvasSummary[] = []
        for (const id of order) {
          const c = byId.get(id)
          if (c) next.push(c)
        }
        for (const c of prev) if (!order.includes(c.id)) next.push(c)
        return next
      })
      await api.api.project.canvases
        .$post({ query: { action: 'reorder' }, json: { path: projectPath, order } })
        .catch(() => {})
    },
    [projectPath],
  )

  if (!loaded) {
    return (
      <div className="flex h-full w-full items-center justify-center text-ui text-ink-subtle">
        Loading…
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full overflow-hidden bg-bg">
      {sidebarsVisible && (
        <aside className="flex w-60 shrink-0 flex-col border-r border-line bg-bg-card">
          <PagesSection
            canvases={canvases}
            activeId={activeId}
            onSelect={switchTo}
            onCreate={createCanvas}
            onDelete={deleteCanvas}
            onRename={renameCanvas}
            onReorder={reorderCanvases}
            // Presence avatars in the Pages header (display only — ProjectCanvas
            // publishes the owner's presence above so it survives focus mode).
            presence={boardCollab}
          />
          <section className="flex min-h-0 flex-1 flex-col border-t border-line">
            <div className="label-cap shrink-0 px-3 py-2 text-ink-muted">
              {t('canvas.layers')}
            </div>
            <div ref={setLayersHost} className="min-h-0 flex-1" />
          </section>
        </aside>
      )}
      <div className="min-h-0 min-w-0 flex-1">
        {active ? (
          <CanvasWorkspace
            key={active.id}
            projectPath={projectPath}
            canvas={active}
            onChange={handleActiveChange}
            layersHost={layersHost}
            inspectorHost={inspectorHost}
            onInspectorOpenChange={setInspectorOpen}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-ui text-ink-subtle">
            Loading…
          </div>
        )}
      </div>
      {sidebarsVisible && (
        // Figma-style auto-collapse: width animates 240px↔0 with selection.
        // overflow-hidden clips the fixed-width (w-60) host as it slides, so
        // the inspector never reflows; the freed width flows to the canvas
        // (flex-1), which follows the transition. border only while open so no
        // 1px seam lingers when collapsed.
        <aside
          className={`flex shrink-0 flex-col overflow-hidden bg-bg-card transition-[width] duration-200 ease-out ${
            inspectorOpen ? 'w-60 border-l border-line' : 'w-0'
          }`}
          aria-hidden={!inspectorOpen}
        >
          <div ref={setInspectorHost} className="min-h-0 w-60 flex-1" />
        </aside>
      )}
      {notice && (
        <div
          role="alert"
          className="absolute bottom-4 right-4 z-20 flex max-w-md items-center gap-3 rounded-[4px] border border-line bg-bg-card/95 px-4 py-2.5 text-ui shadow-card backdrop-blur"
        >
          <span className="text-ink">
            {notice === 'delete-failed'
              ? lang === 'ja'
                ? 'キャンバスを削除できませんでした。編集内容を再保存してください。'
                : "Couldn't delete the canvas. Re-save your edits to be safe."
              : lang === 'ja'
                ? '編集の保存が競合で完了しませんでした。再保存してください。'
                : "Couldn't save your latest edits (save conflict). Please re-save."}
          </span>
          <button
            type="button"
            onClick={() => {
              const a = activeRef.current
              setNotice(null)
              if (a) void enqueueSave(a)
            }}
            className="shrink-0 rounded-[3px] border border-line px-2.5 py-1 font-medium text-accent transition-colors hover:bg-bg-elevated hover:text-ink active:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {lang === 'ja' ? '再保存' : 'Save again'}
          </button>
          <button
            type="button"
            aria-label={lang === 'ja' ? '閉じる' : 'Dismiss'}
            onClick={() => setNotice(null)}
            className="shrink-0 rounded-[3px] px-1.5 py-1 text-ink-muted transition-colors hover:bg-bg-elevated hover:text-ink active:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  )
}
