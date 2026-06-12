import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n/I18nContext'
import { PagesSection } from './PagesSection'
import { CanvasWorkspace } from './CanvasWorkspace'
import type {
  CanvasFile,
  CanvasSummary,
  CanvasesIndex,
} from '@/lib/types'
import { api } from '@/lib/api-client'

interface Props {
  /** Absolute project path — used as the API path argument and as the
   *  remount key so switching projects throws away in-flight state. */
  projectPath: string
  /** Bumped by the parent when canvas files may have changed on disk under us
   *  (a git-share Sync pulled teammates' edits, or a window-focus refetch
   *  while the project is shared). A change re-reads the index + the active
   *  canvas IN PLACE — no loading blank, no remount. */
  reloadToken?: number
}

// Persist no faster than once per 400ms — fast pan/zoom and rapid chat edits
// otherwise hammer the disk. The active Canvas is held in memory and flushed
// on every change; on unmount we flush synchronously so a quick tab-out
// doesn't drop the last edit.
const SAVE_DEBOUNCE_MS = 400

// ⌘\ focus-mode choice survives reloads. '0' = hidden; anything else visible.
const SIDEBARS_KEY = 'openground.canvas.sidebars'

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
export const ProjectCanvas = ({ projectPath, reloadToken }: Props) => {
  const { t } = useT()
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<CanvasFile | null>(null)
  const [loaded, setLoaded] = useState(false)
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

  // Bootstrap: read the index, then either fetch the active Canvas or create
  // a first one. Re-runs on project switch so state never leaks across cards.
  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    setActive(null)
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
        setLoaded(true)
        return
      }
      const id = index.activeId ?? list[0].id
      const file = await fetchCanvas(id)
      if (cancelled) return
      setActive(file)
      setLoaded(true)
    })().catch(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [projectPath, refreshList, fetchCanvas])

  // Flush whatever's pending whenever the active id changes (so switching
  // Canvases doesn't drop the prior one's last unsaved edit). Same on unmount.
  // Returns the save promise so a caller about to RE-READ from disk (the
  // reloadToken effect below) can await the write instead of racing it; the
  // fire-and-forget call sites just ignore it.
  const flushPending = useCallback((): Promise<void> => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const payload = pendingRef.current
    if (!payload) return Promise.resolve()
    pendingRef.current = null
    return api.api.project.canvases
      .$post({ json: { path: projectPath, canvas: payload } })
      .then(() => {})
      .catch(() => {})
  }, [projectPath])

  useEffect(() => {
    return () => {
      void flushPending()
    }
  }, [flushPending])

  // External reload (git share). The ref guards the mount run: the parent's
  // token persists across tab switches, so a remount with a non-zero token
  // must NOT trigger a redundant reload on top of the bootstrap fetch.
  const lastReloadRef = useRef(reloadToken)
  useEffect(() => {
    if (reloadToken === undefined || reloadToken === lastReloadRef.current)
      return
    lastReloadRef.current = reloadToken
    let cancelled = false
    ;(async () => {
      // Write our own pending edit first so the re-read can't resurrect a
      // pre-edit file (last-writer-wins, same as every other save here).
      await flushPending()
      const { index, canvases: list } = await refreshList()
      if (cancelled) return
      const id = index.activeId ?? list[0]?.id ?? null
      if (!id) return
      const file = await fetchCanvas(id)
      if (cancelled || !file) return
      setActiveId(id)
      setActive(file)
    })().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [reloadToken, flushPending, refreshList, fetchCanvas])

  const persistActive = useCallback(
    (next: CanvasFile) => {
      pendingRef.current = next
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const payload = pendingRef.current
        if (!payload) return
        pendingRef.current = null
        saveTimer.current = null
        api.api.project.canvases
          .$post({ json: { path: projectPath, canvas: payload } })
          .then(() => {
            // Keep tab-bar timestamps fresh so updatedAt ordering hints stay
            // accurate without an extra round-trip.
            setCanvases((prev) =>
              prev.map((c) =>
                c.id === payload.id
                  ? { ...c, name: payload.name, updatedAt: new Date().toISOString() }
                  : c,
              ),
            )
          })
          .catch(() => {})
      }, SAVE_DEBOUNCE_MS)
    },
    [projectPath],
  )

  const handleActiveChange = useCallback(
    (next: CanvasFile) => {
      setActive(next)
      persistActive(next)
    },
    [persistActive],
  )

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
    },
    [activeId, flushPending, fetchCanvas, projectPath],
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
  }, [flushPending, projectPath])

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
      // Refresh the list against the server's authoritative view rather than
      // patching locally — the "delete the last one" branch creates a
      // replacement we'd otherwise miss.
      const { index, canvases: list } = await refreshList()
      const target = index.activeId ?? list[0]?.id ?? null
      if (data.createdReplacement && target === data.createdReplacement.id) {
        setActive(data.createdReplacement)
      } else if (target) {
        const file = await fetchCanvas(target)
        setActive(file)
      } else {
        setActive(null)
      }
    },
    [flushPending, projectPath, refreshList, fetchCanvas],
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
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[12px] text-ink-subtle">
            Loading…
          </div>
        )}
      </div>
      {sidebarsVisible && (
        <aside className="flex w-60 shrink-0 flex-col border-l border-line bg-bg-card">
          <div ref={setInspectorHost} className="min-h-0 flex-1" />
        </aside>
      )}
    </div>
  )
}
