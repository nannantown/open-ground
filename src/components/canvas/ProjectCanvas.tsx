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
// loop forever — on exhaustion we drop the save and the next local edit retries.
const MAX_SAVE_RETRIES = 5

// ⌘\ focus-mode choice survives reloads. '0' = hidden; anything else visible.
const SIDEBARS_KEY = 'openground.canvas.sidebars'

// Owner asset-upload (u14b) retry backoff: a failed upload isn't retried until
// this long has passed, so a persistently-failing R2/Worker can't be hammered by
// the sweep re-firing on every canvas change during active collaboration.
const ASSET_RETRY_COOLDOWN_MS = 30_000

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
  const { t } = useT()
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

  // Adopt a freshly-loaded server canvas as the OCC base (rev + elements) for its id.
  const adoptServerCanvas = useCallback((file: CanvasFile) => {
    revByIdRef.current.set(file.id, Number.isFinite(file.rev) ? file.rev : 0)
    baseByIdRef.current.set(file.id, file.elements)
  }, [])

  // Persist a full canvas under OCC. Sends the rev we're synced to for THIS id;
  // on 409 (an AI job advanced the file since our base) refetch the server
  // canvas, 3-way-merge (keep our edits ∪ AI's new/updated elements, never
  // resurrect our deletions), reflect the merge locally so the AI additions
  // appear, and retry against the fresh rev. A non-409 failure (or exhausted
  // retries) is dropped — matching the prior fire-and-forget behaviour; the next
  // edit re-saves.
  const doSave = useCallback(
    async (initial: CanvasFile): Promise<void> => {
      let payload = initial
      const id = initial.id
      for (let attempt = 0; attempt <= MAX_SAVE_RETRIES; attempt++) {
        const expectedRev = revByIdRef.current.get(id) ?? 0
        const res = await api.api.project.canvases.$post({
          json: { path: projectPath, canvas: { ...payload, rev: expectedRev } },
        })
        if (res.ok) {
          const saved = (await res.json()) as CanvasFile
          revByIdRef.current.set(id, Number.isFinite(saved.rev) ? saved.rev : expectedRev + 1)
          // The server now holds exactly what we sent → it's the new base.
          baseByIdRef.current.set(id, payload.elements)
          // Keep tab-bar timestamps fresh without an extra round-trip.
          setCanvases((prev) =>
            prev.map((c) =>
              c.id === id ? { ...c, name: payload.name, updatedAt: saved.updatedAt } : c,
            ),
          )
          return
        }
        if (res.status !== 409) return
        let serverCanvas: CanvasFile | null = null
        try {
          const conflict = (await res.json()) as { canvas?: CanvasFile }
          serverCanvas = conflict.canvas ?? null
        } catch {
          serverCanvas = null
        }
        if (!serverCanvas) serverCanvas = await fetchCanvas(id)
        if (!serverCanvas) return
        // Merge against our LATEST local state (the user may have edited during
        // the round-trip) when this canvas is still active; else the snapshot.
        const liveLocal =
          activeRef.current && activeRef.current.id === id ? activeRef.current : payload
        const mergedElements = reconcileCanvasElements(
          baseByIdRef.current.get(id) ?? [],
          liveLocal.elements,
          serverCanvas.elements,
        )
        const merged: CanvasFile = {
          ...liveLocal,
          elements: mergedElements,
          rev: serverCanvas.rev,
        }
        // We now KNOW the server holds serverCanvas at this rev → new merge base.
        revByIdRef.current.set(
          id,
          Number.isFinite(serverCanvas.rev) ? serverCanvas.rev : expectedRev,
        )
        baseByIdRef.current.set(id, serverCanvas.elements)
        // Reflect the reconciled canvas so AI additions appear immediately — but
        // only while we're still on this canvas (a mid-flight switch must win).
        if (activeRef.current && activeRef.current.id === id) setActive(merged)
        payload = merged
      }
    },
    [projectPath, fetchCanvas],
  )

  // Serialise every save through one chain (see saveChainRef).
  const enqueueSave = useCallback(
    (payload: CanvasFile): Promise<void> => {
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
  // Returns the save promise so a caller about to RE-READ from disk can await
  // the write instead of racing it; the fire-and-forget call sites just ignore
  // it.
  const flushPending = useCallback((): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const payload = pendingRef.current
    if (!payload) return Promise.resolve()
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
      flushPending()
      const res = await api.api.project.canvases.$post({
        query: { action: 'delete' },
        json: { path: projectPath, id },
      })
      const data = (await res.json()) as {
        index: CanvasesIndex
        createdReplacement?: CanvasFile
      }
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
    },
    [flushPending, projectPath, refreshList, fetchCanvas, adoptServerCanvas],
  )

  const renameCanvas = useCallback(
    async (id: string, name: string) => {
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
    [projectPath, active],
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
      <div className="flex h-full w-full items-center justify-center text-[12px] text-ink-subtle">
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
          <div className="flex h-full w-full items-center justify-center text-[12px] text-ink-subtle">
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
    </div>
  )
}
