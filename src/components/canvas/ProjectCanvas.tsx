import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { CanvasTabBar } from './CanvasTabBar'
import { CanvasWorkspace } from './CanvasWorkspace'
import type {
  CanvasFile,
  CanvasSummary,
  CanvasesIndex,
  ProjectTask,
  RunSession,
} from '@/lib/types'
import type { RunTaskOpts } from '@/lib/useRuns'
import { api } from '@/lib/api-client'

interface Props {
  /** Absolute project path — used as the API path argument and as the
   *  remount key so switching projects throws away in-flight state. */
  projectPath: string
  /** Shared with Chats tab so Canvas chats use the same SSE / runner. */
  taskRuns: Map<string, RunSession>
  allTaskRuns: Map<string, RunSession[]>
  onRunTask: (task: ProjectTask, opts?: RunTaskOpts) => void
  onCancelTask: (taskId: string) => void
  /** Server-side observer signal: bumps when CANVAS_ADD: lands a new element
   *  in any canvas. We compare to the currently-open canvas and re-fetch on
   *  a match — otherwise the new element only shows up after a manual reload. */
  canvasAddSignal?: { projectPath: string; canvasId: string; seq: number } | null
  /** Observer signal: bumps when a CANVAS_ADD / CANVAS_UPDATE marker is
   *  rejected. Surfaced as a transient toast so a bad marker fails loudly. */
  canvasErrorSignal?: {
    projectPath: string
    canvasId: string
    message: string
    seq: number
  } | null
}

// Persist no faster than once per 400ms — fast pan/zoom and rapid chat edits
// otherwise hammer the disk. The active Canvas is held in memory and flushed
// on every change; on unmount we flush synchronously so a quick tab-out
// doesn't drop the last edit.
const SAVE_DEBOUNCE_MS = 400

// Top-level orchestrator for the Canvas tab. Renders the Chrome-style tab
// strip on top and one CanvasWorkspace below it for the active Canvas. Owns
//  • the list of Canvases + the active id (sourced from .openground/canvases-index.json
//    via /api/project/canvases)
//  • the full file for the active Canvas (the only one fetched at a time —
//    inactive Canvases stay on disk so heavy drawings don't all live in memory)
//  • debounced persistence + flush-on-unmount
export const ProjectCanvas = ({
  projectPath,
  taskRuns,
  allTaskRuns,
  onRunTask,
  onCancelTask,
  canvasAddSignal,
  canvasErrorSignal,
}: Props) => {
  const [canvases, setCanvases] = useState<CanvasSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [active, setActive] = useState<CanvasFile | null>(null)
  // Forward-declared so the canvas-add reload effect (which sits above
  // flushPending's definition) can call the live closure.
  const flushPendingRef = useRef<() => void>(() => {})
  const [loaded, setLoaded] = useState(false)

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

  // CANVAS_ADD round-trip: when the observer writes a new element into the
  // currently-open canvas (Claude responding to a Canvas chat), flush any
  // unsaved local edits and re-fetch the file so the new element actually
  // appears on screen. Without this the disk grows but the client never knows.
  useEffect(() => {
    if (!canvasAddSignal) return
    if (canvasAddSignal.projectPath !== projectPath) return
    if (!activeId || canvasAddSignal.canvasId !== activeId) return
    // Flush local edits first so we don't immediately overwrite them.
    flushPendingRef.current()
    let cancelled = false
    ;(async () => {
      const file = await fetchCanvas(activeId)
      if (cancelled || !file) return
      setActive(file)
    })().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [canvasAddSignal, projectPath, activeId, fetchCanvas])

  // Transient toast for a rejected CANVAS_ADD / CANVAS_UPDATE marker so a bad
  // marker fails loudly instead of vanishing into the run log.
  const [errorToast, setErrorToast] = useState<string | null>(null)
  const lastErrSeqRef = useRef(0)
  // Show the toast when a new error for THIS project arrives. No timer here, so
  // a project switch mid-toast can't clear the timer without re-arming it.
  useEffect(() => {
    if (!canvasErrorSignal) return
    if (canvasErrorSignal.projectPath !== projectPath) return
    if (canvasErrorSignal.seq === lastErrSeqRef.current) return
    lastErrSeqRef.current = canvasErrorSignal.seq
    setErrorToast(canvasErrorSignal.message)
  }, [canvasErrorSignal, projectPath])
  // Auto-dismiss is armed off the toast value itself, so it always (re)arms when
  // a toast is shown and clears only when the toast actually goes away.
  useEffect(() => {
    if (!errorToast) return
    const t = setTimeout(() => setErrorToast(null), 7000)
    return () => clearTimeout(t)
  }, [errorToast])
  // Don't carry a stale toast across a project switch (this component re-renders
  // in place rather than remounting).
  useEffect(() => {
    setErrorToast(null)
  }, [projectPath])

  // Flush whatever's pending whenever the active id changes (so switching
  // Canvases doesn't drop the prior one's last unsaved edit). Same on unmount.
  const flushPending = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const payload = pendingRef.current
    if (!payload) return
    pendingRef.current = null
    api.api.project.canvases
      .$post({ json: { path: projectPath, canvas: payload } })
      .catch(() => {})
  }, [projectPath])
  // Mirror through a ref so the canvas-add reload effect (declared earlier
  // in the function) can call the latest closure without re-running every
  // time `flushPending` is rebuilt.
  flushPendingRef.current = flushPending

  useEffect(() => {
    return () => {
      flushPending()
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
    <div className="relative flex h-full w-full flex-col overflow-hidden bg-bg">
      <CanvasTabBar
        canvases={canvases}
        activeId={activeId}
        onSelect={switchTo}
        onCreate={createCanvas}
        onDelete={deleteCanvas}
        onRename={renameCanvas}
        onReorder={reorderCanvases}
      />
      <div className="min-h-0 flex-1">
        {active ? (
          <CanvasWorkspace
            key={active.id}
            projectPath={projectPath}
            canvas={active}
            onChange={handleActiveChange}
            taskRuns={taskRuns}
            allTaskRuns={allTaskRuns}
            onRunTask={onRunTask}
            onCancelTask={onCancelTask}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[12px] text-ink-subtle">
            Loading…
          </div>
        )}
      </div>

      {errorToast && (
        <div className="dock-in pointer-events-auto absolute bottom-4 left-1/2 z-50 flex max-w-[520px] -translate-x-1/2 items-start gap-2 rounded-[6px] border border-accent/30 bg-bg-card px-3.5 py-2.5 shadow-card-hover">
          <AlertTriangle size={15} strokeWidth={2} className="mt-px shrink-0 text-accent" />
          <div className="min-w-0">
            <p className="label-cap text-accent">Canvas マーカー失敗</p>
            <p className="mt-0.5 break-words font-mono text-[11.5px] leading-snug text-ink-muted">
              {errorToast}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setErrorToast(null)}
            className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-ink-faint hover:bg-bg-inset hover:text-ink"
          >
            <X size={13} />
          </button>
        </div>
      )}
    </div>
  )
}
