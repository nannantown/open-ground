
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import { InfiniteCanvas } from '@/components/canvas/InfiniteCanvas'
import { Toolbar } from '@/components/canvas/Toolbar'
import { ToolPalette } from '@/components/canvas/ToolPalette'
import { SettingsPanel } from '@/components/canvas/SettingsPanel'
import { NewProjectModal } from '@/components/canvas/NewProjectModal'
import { FeedbackModal } from '@/components/canvas/FeedbackModal'
import { AccountModal } from '@/components/canvas/AccountModal'
import { ProjectJumpPalette } from '@/components/canvas/ProjectJumpPalette'
import { ProjectPanel } from '@/components/canvas/ProjectPanel'
import { BulkActionBar } from '@/components/canvas/BulkActionBar'
import { ElementBar } from '@/components/canvas/ElementBar'
import { EmptyState } from '@/components/canvas/EmptyState'
import { UsageHud } from '@/components/canvas/UsageHud'
import { autoLayout, frameLabelFor } from '@/lib/layout'
import { useCanvasHistory } from '@/lib/useCanvasHistory'
import { useRuns } from '@/lib/useRuns'
import { newId } from '@/lib/ids'
import { loadPersistedView, savePersistedView } from '@/lib/persistView'
import { api } from '@/lib/api-client'
import type {
  CanvasState,
  ProjectMeta,
  RunSummaryInfo,
  Settings,
  ProjectsResponse,
  Tool,
} from '@/lib/types'

export default function App() {
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [canvas, setCanvas] = useState<CanvasState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // Whether the server has Supabase env configured. When false the feedback
  // entry stays hidden, so the public build (no env) shows nothing.
  const [feedbackEnabled, setFeedbackEnabled] = useState(false)
  const [accountOpen, setAccountOpen] = useState(false)
  // Whether the optional app login is configured server-side (same Supabase env
  // as feedback). When false the account entry stays hidden — public build clean.
  const [authEnabled, setAuthEnabled] = useState(false)
  const [jumpOpen, setJumpOpen] = useState(false)
  // Bumped when a run mutates the open project's tasks, so ProjectPanel refetches.
  const [projectDataVersion, setProjectDataVersion] = useState(0)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showArchived, setShowArchived] = useState(false)
  const [tool, setTool] = useState<Tool>('select')
  const [refreshing, setRefreshing] = useState(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (): Promise<ProjectsResponse | null> => {
    setRefreshing(true)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    try {
      const res = await api.api.projects.$get({}, { init: { cache: 'no-store' } })
      const data = (await res.json()) as ProjectsResponse
      const positions = autoLayout(data.projects, data.canvas.positions)
      const canvas = { ...data.canvas, positions }
      setProjects(data.projects)
      setSettings(data.settings)
      setCanvas(canvas)
      if (!data.settings.projectsRoot) setSettingsOpen(true)
      return { ...data, canvas }
    } finally {
      setRefreshing(false)
    }
  }, [])

  // Every task-run lives here, independent and concurrent. Runs keep streaming
  // while the user works elsewhere; finishing one refreshes project data —
  // debounced so a batch finishing together triggers one rescan, not many.
  const loadTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Refs so the notify callbacks see fresh values without re-instantiating
  // useRuns (which would tear down the SSE) when settings/selection change.
  const selectedRef = useRef(selectedIds)
  selectedRef.current = selectedIds
  const runs = useRuns(
    () => {
      if (loadTimer.current) clearTimeout(loadTimer.current)
      loadTimer.current = setTimeout(load, 600)
    },
    {
      enabled: settings?.notifyOnRunComplete !== false,
      sound: settings?.notifySound !== false,
      isViewingProject: (pid) => selectedRef.current.includes(pid),
      onPick: (pid) => {
        setSelectedIds([pid])
      },
    },
  )

  // A run that the server refused to start (e.g. the local `claude` CLI is
  // missing → 503) surfaces here as a dismissable banner, so a no-op run never
  // fails silently. Auto-clears after a while; clicking opens Settings (where
  // the Claude Code CLI readiness check + install hint live).
  const [runErrorToast, setRunErrorToast] = useState<string | null>(null)
  useEffect(() => {
    if (!runs.runError) return
    setRunErrorToast(runs.runError.message)
    const t = setTimeout(() => setRunErrorToast(null), 12_000)
    return () => clearTimeout(t)
  }, [runs.runError])

  // Restore "where the user was" exactly once, after the first project scan:
  // re-open the project they had open before reload, if it still exists. A
  // saved project that's gone (deleted / renamed / archived-and-hidden) falls
  // back to Ground. The panel tab is restored inside ProjectPanel itself.
  const didRestore = useRef(false)
  useEffect(() => {
    load().then((data) => {
      if (didRestore.current) return
      didRestore.current = true
      if (!data) return
      const { projectId } = loadPersistedView()
      if (projectId && data.projects.some((p) => p.id === projectId)) {
        // Don't clobber a selection the user may have made while the first
        // scan was still in flight — only restore onto an empty Ground.
        setSelectedIds((cur) => (cur.length === 0 ? [projectId] : cur))
      } else if (projectId) {
        // Saved project is gone (deleted / renamed / archived-and-hidden):
        // drop the stale id so it stops being read on every future reload.
        savePersistedView({ projectId: undefined })
      }
    })
  }, [load])

  // Persist the open project so a reload re-opens it. Exactly one selected
  // project is a real "location"; zero (Ground) or a multi-select isn't, so
  // clear the saved project in those cases. Gated on `didRestore` so the
  // mount-time `selectedIds === []` doesn't clear the saved id before the
  // restore effect (which resolves async after the first scan) can read it.
  useEffect(() => {
    if (!didRestore.current) return
    savePersistedView({ projectId: selectedIds.length === 1 ? selectedIds[0] : undefined })
  }, [selectedIds])

  // Keyboard shortcuts for tools (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const ae = document.activeElement
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return
      const k = e.key.toLowerCase()
      if (k === 'v') setTool('select')
      else if (k === 't') setTool('text')
      else if (k === 's') setTool('sticky')
      else if (k === 'f') setTool('frame')
      else if (k === 'n') {
        // ⌘N is reserved by Chrome for "new window" — single-key `n` opens the
        // new-project modal instead (same flavour as v/t/s/f tool keys).
        e.preventDefault()
        setNewProjectOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // One-shot probe of whether in-app feedback is configured server-side (the
  // Supabase env). Gates the toolbar entry so the public build (no env) hides
  // it. Best-effort: any failure leaves the entry hidden.
  useEffect(() => {
    let cancelled = false
    api.api.feedback.config
      .$get()
      .then((res) => res.json() as Promise<{ enabled?: boolean }>)
      .then((data) => {
        if (!cancelled) setFeedbackEnabled(!!data.enabled)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // One-shot probe of whether the optional app login is configured server-side
  // (same Supabase env as feedback). Gates the toolbar account entry; any
  // failure leaves it hidden so the public build (no env) shows nothing.
  useEffect(() => {
    let cancelled = false
    api.api.auth.config
      .$get()
      .then((res) => res.json() as Promise<{ enabled?: boolean }>)
      .then((data) => {
        if (!cancelled) setAuthEnabled(!!data.enabled)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const scheduleSave = useCallback((c: CanvasState) => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      api.api.canvas.$post({ json: c })
    }, 400)
  }, [])

  const onCanvasChange = useCallback(
    (c: CanvasState) => {
      setCanvas(c)
      scheduleSave(c)
    },
    [scheduleSave],
  )

  // Mutate the canvas from the freshest state — safe under rapid-fire updates
  // (held arrow keys) where a captured `canvas` would go stale.
  const mutateCanvas = useCallback(
    (fn: (c: CanvasState) => CanvasState) => {
      setCanvas((c) => {
        if (!c) return c
        const next = fn(c)
        if (next !== c) scheduleSave(next)
        return next
      })
    },
    [scheduleSave],
  )

  const { undo, redo } = useCanvasHistory(canvas, onCanvasChange)

  // Plain click selects one item; Shift+click toggles multi-selection.
  const handleSelect = useCallback((id: string | null, additive?: boolean) => {
    setSelectedIds((prev) => {
      if (!id) return []
      if (additive) {
        return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
      }
      return [id]
    })
  }, [])

  // Duplicate every selected canvas element (project cards are never cloned).
  const duplicateSelected = useCallback(() => {
    if (!canvas) return
    const clones = canvas.elements
      .filter((el) => selectedIds.includes(el.id))
      .map((el) => ({ ...el, id: newId(), x: el.x + 28, y: el.y + 28 }))
    if (!clones.length) return
    onCanvasChange({ ...canvas, elements: [...canvas.elements, ...clones] })
    setSelectedIds(clones.map((cl) => cl.id))
  }, [canvas, selectedIds, onCanvasChange])

  const visibleProjects = useMemo(
    () => (showArchived ? projects : projects.filter((p) => !p.archived)),
    [projects, showArchived],
  )

  // Phase 5.A — card-hero summaries with a persisted fallback. A live (or
  // recent disk) run-session always wins: runSummaryByProject reflects what
  // just happened and carries the freshest state. When the cockpit has no
  // session for a project (runs/ aged out, or a fresh page with empty
  // in-memory state), fall back to ProjectMeta.latestRunSummary — derived
  // server-side from the project's persisted task.latestRun — so the card
  // still narrates where the project stands instead of dropping to its bare
  // description.
  const cardSummaries = useMemo(() => {
    const live = runs.runSummaryByProject
    const merged = new Map<string, RunSummaryInfo>()
    for (const p of projects) {
      if (p.latestRunSummary) merged.set(p.id, p.latestRunSummary)
    }
    // Live/disk session summaries override the persisted fallback.
    live.forEach((v, k) => merged.set(k, v))
    return merged
  }, [projects, runs.runSummaryByProject])

  const ARROW_NUDGE: Record<string, [number, number]> = useMemo(
    () => ({
      arrowleft: [-1, 0],
      arrowright: [1, 0],
      arrowup: [0, -1],
      arrowdown: [0, 1],
    }),
    [],
  )

  // Canvas-wide keyboard shortcuts: undo/redo, duplicate, select-all,
  // deselect, enter-to-edit and arrow-key nudging.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ae = document.activeElement
      const typing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()

      if (mod && k === 'z') {
        if (typing) return
        e.preventDefault()
        e.shiftKey ? redo() : undo()
        return
      }
      if (mod && k === 'y') {
        if (typing) return
        e.preventDefault()
        redo()
        return
      }
      if (mod && k === 'd') {
        if (typing) return
        e.preventDefault()
        duplicateSelected()
        return
      }
      if (mod && k === 'a') {
        if (typing || !canvas) return
        e.preventDefault()
        setSelectedIds([
          ...visibleProjects.map((p) => p.id),
          ...canvas.elements.map((el) => el.id),
        ])
        return
      }
      if (mod && k === 'k') {
        // Jump-to-project palette — fires even while typing in a panel input,
        // since the palette will take over focus.
        e.preventDefault()
        setJumpOpen(true)
        return
      }
      if (mod) return // leave every other ⌘ combo to the browser

      if (k === 'escape') {
        if (typing || editingId) return
        setSelectedIds([])
        return
      }
      if (k === 'enter') {
        if (typing || editingId || selectedIds.length !== 1 || !canvas) return
        if (canvas.elements.some((el) => el.id === selectedIds[0])) {
          e.preventDefault()
          setEditingId(selectedIds[0])
        }
        return
      }
      const dir = ARROW_NUDGE[k]
      if (dir && !typing && !editingId && selectedIds.length) {
        e.preventDefault()
        const step = e.shiftKey ? 10 : 1
        const dx = dir[0] * step
        const dy = dir[1] * step
        mutateCanvas((c) => {
          const positions = { ...c.positions }
          for (const id of selectedIds) {
            const p = positions[id]
            if (p) positions[id] = { x: p.x + dx, y: p.y + dy }
          }
          const elements = c.elements.map((el) =>
            selectedIds.includes(el.id) ? { ...el, x: el.x + dx, y: el.y + dy } : el,
          )
          return { ...c, positions, elements }
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    undo,
    redo,
    duplicateSelected,
    canvas,
    selectedIds,
    editingId,
    visibleProjects,
    mutateCanvas,
    ARROW_NUDGE,
  ])

  const saveSettings = async (s: Settings) => {
    await api.api.settings.$post({ json: s })
    setSettingsOpen(false)
    await load()
  }

  const archive = async (project: ProjectMeta) => {
    if (!confirm(`Move "${project.name}" into the archive folder?`)) return
    const res = await api.api.project.archive.$post({ json: { path: project.path } })
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string }
      alert(`Archive failed: ${e.error ?? res.statusText}`)
      return
    }
    setSelectedIds([])
    await load()
  }

  // Re-centre the viewport on a freshly-created card so the user sees it.
  // Card geometry (256 × 132) is fixed in lib/layout.ts; we keep the current
  // zoom so the user's mental scale of the canvas is preserved.
  const centerOnCard = (pos: { x: number; y: number }) => {
    setCanvas((c) => {
      if (!c) return c
      const zoom = c.viewport.zoom
      const next = {
        ...c,
        viewport: {
          zoom,
          x: window.innerWidth / 2 - (pos.x + 128) * zoom,
          y: window.innerHeight / 2 - (pos.y + 66) * zoom,
        },
      }
      scheduleSave(next)
      return next
    })
  }

  const restore = async (project: ProjectMeta) => {
    const res = await api.api.project.restore.$post({ json: { path: project.path } })
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string }
      alert(`Restore failed: ${e.error ?? res.statusText}`)
      return
    }
    setSelectedIds([])
    await load()
  }

  if (!settings || !canvas) {
    return <div className="h-screen w-screen bg-bg" />
  }

  const hasProjectsRoot = !!settings.projectsRoot
  const showEmpty = !hasProjectsRoot || projects.length === 0
  const archivedCount = projects.filter((p) => p.archived).length
  const selectedProjects = visibleProjects.filter((p) => selectedIds.includes(p.id))
  const singleSelected = selectedProjects.length === 1 ? selectedProjects[0] : null
  const selectedElement =
    selectedIds.length === 1
      ? canvas.elements.find((el) => el.id === selectedIds[0]) ?? null
      : null
  // The frame the selected card sits inside supplies its category label —
  // derived from canvas geometry, not a hand-typed field.
  const frameLabel = singleSelected ? frameLabelFor(singleSelected.id, canvas) : null

  // Cancel whichever live run is working a given task.
  const cancelTaskRun = (taskId: string) => {
    const s = runs.sessions.find(
      (s) =>
        !s.finishedAt &&
        s.entries.some((e) => e.targetedTasks.some((t) => t.id === taskId)),
    )
    if (s) runs.cancelRun(s.id)
  }

  return (
    <main className="h-screen w-screen overflow-hidden bg-bg relative">
      <InfiniteCanvas
        projects={visibleProjects}
        canvas={canvas}
        onCanvasChange={onCanvasChange}
        selectedIds={selectedIds}
        onSelect={handleSelect}
        onSelectIds={setSelectedIds}
        editingId={editingId}
        onEditingIdChange={setEditingId}
        tool={tool}
        onToolChange={setTool}
        runStatuses={runs.statusByProject}
        runSummaries={cardSummaries}
      />
      {showEmpty && (
        <EmptyState configured={hasProjectsRoot} onConfigure={() => setSettingsOpen(true)} />
      )}
      {runErrorToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[60] max-w-[440px] w-[calc(100vw-3rem)]">
          <div
            role="alert"
            className="flex items-start gap-2.5 rounded-[4px] border border-accent/40 bg-bg-card/95 backdrop-blur-sm px-4 py-3 shadow-card-hover"
          >
            <AlertTriangle size={15} className="mt-[1px] shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-ink leading-relaxed">{runErrorToast}</p>
              <button
                onClick={() => {
                  setRunErrorToast(null)
                  setSettingsOpen(true)
                }}
                className="mt-1.5 label-cap text-accent hover:text-ink transition-colors"
              >
                Open settings
              </button>
            </div>
            <button
              onClick={() => setRunErrorToast(null)}
              aria-label="Dismiss"
              className="shrink-0 -mr-1 -mt-0.5 p-1 text-ink-faint hover:text-ink transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}
      <ToolPalette tool={tool} onToolChange={setTool} />
      <Toolbar
        onRefresh={load}
        onNewProject={() => setNewProjectOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onFeedback={feedbackEnabled ? () => setFeedbackOpen(true) : undefined}
        onAccount={authEnabled ? () => setAccountOpen(true) : undefined}
        projectsRoot={settings.projectsRoot}
        projectCount={visibleProjects.length}
        archivedCount={archivedCount}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived((v) => !v)}
        refreshing={refreshing}
      />
      {/* Slim, chrome-less usage strip — sits flush to the left of Toolbar's
       *  right button pill (≈ 92px wide inside p-5). */}
      <div className="absolute top-[26px] right-[120px] z-20">
        <UsageHud plan={settings.claudePlan} />
      </div>
      <ProjectPanel
        project={singleSelected}
        frameLabel={frameLabel}
        dataVersion={projectDataVersion}
        taskRuns={runs.taskRuns}
        allTaskRuns={runs.allTaskRuns}
        claudePlan={settings.claudePlan}
        onRunTask={(task, opts) => {
          if (singleSelected)
            runs.runTask(
              {
                id: singleSelected.id,
                name: singleSelected.name,
                path: singleSelected.path,
              },
              { id: task.id, title: task.title },
              opts,
            )
        }}
        onCancelTask={cancelTaskRun}
        onCancelAllPending={runs.cancelAllPending}
        canvasAddSignal={runs.canvasAddSignal}
        canvasErrorSignal={runs.canvasErrorSignal}
        onEnqueueInstruction={(task, instruction, opts, waitForSessionId) => {
          if (!singleSelected) return
          runs.enqueueInstruction({
            taskId: task.id,
            project: {
              id: singleSelected.id,
              name: singleSelected.name,
              path: singleSelected.path,
            },
            task: { id: task.id, title: task.title },
            instruction,
            permissionMode: opts?.permissionMode,
            skill: opts?.skill,
            canvasContext: opts?.canvasContext,
            waitForSessionId,
          })
        }}
        onClose={() => setSelectedIds([])}
        onArchive={archive}
        onRestore={restore}
        onSaved={(path, d) =>
          setProjects((prev) =>
            prev.map((p) =>
              p.path === path
                ? {
                    ...p,
                    description: d.description,
                    openTaskCount: d.tasks.filter((t) => !t.done).length,
                    totalTaskCount: d.tasks.length,
                  }
                : p,
            ),
          )
        }
        onDeleted={() => {
          setSelectedIds([])
          load()
        }}
        onRename={async (project, newName) => {
          const res = await api.api.project.rename.$post({
            json: { path: project.path, name: newName },
          })
          const json = (await res.json().catch(() => ({}))) as {
            error?: string
            path?: string
          }
          if (!res.ok) return { error: json.error ?? 'Rename failed' }
          // Reload, then re-select by the new path so the panel stays on the
          // same project (its id has changed because id = sha1(name)).
          const data = await load()
          const next = data?.projects.find((p) => p.path === json.path)
          if (next) setSelectedIds([next.id])
          return undefined
        }}
      />
      {selectedProjects.length >= 2 && (
        <BulkActionBar
          projects={selectedProjects}
          onClear={() => setSelectedIds([])}
          onReload={load}
        />
      )}
      {selectedElement && (
        <ElementBar
          element={selectedElement}
          onColor={(color) =>
            onCanvasChange({
              ...canvas,
              elements: canvas.elements.map((el) =>
                el.id === selectedElement.id ? { ...el, color } : el,
              ),
            })
          }
          onBringFront={() =>
            onCanvasChange({
              ...canvas,
              elements: [
                ...canvas.elements.filter((el) => el.id !== selectedElement.id),
                selectedElement,
              ],
            })
          }
          onSendBack={() =>
            onCanvasChange({
              ...canvas,
              elements: [
                selectedElement,
                ...canvas.elements.filter((el) => el.id !== selectedElement.id),
              ],
            })
          }
          onDuplicate={duplicateSelected}
          onDelete={() => {
            onCanvasChange({
              ...canvas,
              elements: canvas.elements.filter((el) => el.id !== selectedElement.id),
            })
            setEditingId(null)
            setSelectedIds([])
          }}
          onClear={() => {
            setEditingId(null)
            setSelectedIds([])
          }}
        />
      )}
      <SettingsPanel
        open={settingsOpen}
        settings={settings}
        onClose={() => setSettingsOpen(false)}
        onSave={saveSettings}
      />
      <NewProjectModal
        open={newProjectOpen}
        projectsRoot={settings.projectsRoot}
        onClose={() => setNewProjectOpen(false)}
        onCreated={async (newPath) => {
          setNewProjectOpen(false)
          const data = await load()
          // Open the new project's panel and centre the canvas on its card.
          const created = data?.projects.find((p) => p.path === newPath)
          if (created) {
            setSelectedIds([created.id])
            const pos = data!.canvas.positions[created.id]
            if (pos) centerOnCard(pos)
          }
        }}
      />
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
      <ProjectJumpPalette
        open={jumpOpen}
        projects={visibleProjects}
        onClose={() => setJumpOpen(false)}
        onPick={(p) => {
          setJumpOpen(false)
          setSelectedIds([p.id])
          const pos = canvas.positions[p.id]
          if (pos) centerOnCard(pos)
        }}
      />
    </main>
  )
}
