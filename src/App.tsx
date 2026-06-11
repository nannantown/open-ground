
import { useCallback, useEffect, useRef, useState } from 'react'
import { InfiniteCanvas } from '@/components/canvas/InfiniteCanvas'
import { Toolbar } from '@/components/canvas/Toolbar'
import { ToolPalette } from '@/components/canvas/ToolPalette'
import { SettingsPanel } from '@/components/canvas/SettingsPanel'
import { VoiceController } from '@/components/canvas/VoiceController'
import { NewProjectModal } from '@/components/canvas/NewProjectModal'
import { FeedbackModal } from '@/components/canvas/FeedbackModal'
import { AccountModal } from '@/components/canvas/AccountModal'
import { ProjectJumpPalette } from '@/components/canvas/ProjectJumpPalette'
import { ProjectPanel } from '@/components/canvas/ProjectPanel'
import { Onboarding } from '@/components/Onboarding'
import { BulkActionBar } from '@/components/canvas/BulkActionBar'
import { ElementBar } from '@/components/canvas/ElementBar'
import { EmptyState } from '@/components/canvas/EmptyState'
import { UsageHud } from '@/components/canvas/UsageHud'
import { autoLayout, frameLabelFor } from '@/lib/layout'
import { useCanvasHistory } from '@/lib/useCanvasHistory'
import { newId } from '@/lib/ids'
import { loadPersistedView, savePersistedView } from '@/lib/persistView'
import { api } from '@/lib/api-client'
import { useAuth } from '@/lib/auth/AuthContext'
import { useT } from '@/i18n/I18nContext'
import type {
  CanvasState,
  ProjectMeta,
  Settings,
  ProjectsResponse,
  Tool,
  FeedbackConfigResponse,
} from '@/lib/types'

// localStorage key holding the newest feedback created_at the owner has seen in
// the inbox. Used to compute the unread count for the settings-gear dot. Scoped
// by the server's sourceId (hash of Supabase url+table) so repointing at another
// project/table doesn't carry a stale marker; falls back to the bare key when
// the source isn't known yet.
const FEEDBACK_SEEN_KEY = 'openground:feedbackSeenAt'
// First-run onboarding is a once-per-machine gate (sign in vs use as guest +
// a light tour). Persisted in localStorage so it never reappears after the
// user has made a choice.
const ONBOARDED_KEY = 'openground:onboarded'
const feedbackSeenKey = (sourceId: string | null) =>
  sourceId ? `${FEEDBACK_SEEN_KEY}:${sourceId}` : FEEDBACK_SEEN_KEY

// Arrow-key nudge vectors for the canvas keyboard shortcuts. Static, so it
// lives outside the component (and outside the effect's dependency list).
const ARROW_NUDGE: Record<string, [number, number]> = {
  arrowleft: [-1, 0],
  arrowright: [1, 0],
  arrowup: [0, -1],
  arrowdown: [0, 1],
}

export default function App() {
  const { t } = useT()
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [canvas, setCanvas] = useState<CanvasState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  // Whether the server has Supabase env configured. When false the feedback
  // entry stays hidden, so the public build (no env) shows nothing.
  const [feedbackEnabled, setFeedbackEnabled] = useState(false)
  // Whether the server also has a service-role key (owner-only), so the
  // "Incoming feedback" inbox in Settings can read submissions. False on the
  // public build — the inbox never appears there.
  const [feedbackCanRead, setFeedbackCanRead] = useState(false)
  // Count of feedback submissions newer than the last time the owner opened the
  // inbox. Drives the dot on the settings gear. Owner build only (canRead).
  const [feedbackUnread, setFeedbackUnread] = useState(0)
  // Stable id of the Supabase data source (from /config) used to scope the
  // localStorage "seen" marker. Null until the config probe resolves.
  const [feedbackSourceId, setFeedbackSourceId] = useState<string | null>(null)
  // Current signed-in app user. `canRead` (owner inbox) can depend on identity
  // when an admin allowlist is set, so we re-probe feedback config when it changes.
  const { user: authUser } = useAuth()
  const [accountOpen, setAccountOpen] = useState(false)
  // Whether the optional app login is configured server-side (same Supabase env
  // as feedback). When false the account entry stays hidden — public build clean.
  const [authEnabled, setAuthEnabled] = useState(false)
  // First-run onboarding gate (sign in / guest). Defaults to "seen" if storage
  // is unavailable so we never trap the user behind an un-dismissable overlay.
  const [onboarded, setOnboarded] = useState(() => {
    try {
      return localStorage.getItem(ONBOARDED_KEY) === '1'
    } catch {
      return true
    }
  })
  const [jumpOpen, setJumpOpen] = useState(false)
  // Project ids that currently have at least one LIVE PTY (plain shell or
  // claude session) — drives the small pulsing "Terminal" beacon on Ground
  // cards. Polled from /api/terminal/active; replaces the old run-status edge
  // bar as the only "something is happening here" signal.
  const [terminalActiveIds, setTerminalActiveIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  )
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(async (): Promise<ProjectsResponse | null> => {
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const res = await api.api.projects.$get({}, { init: { cache: 'no-store' } })
    const data = (await res.json()) as ProjectsResponse
    const positions = autoLayout(data.projects, data.canvas.positions)
    const canvas = { ...data.canvas, positions }
    setProjects(data.projects)
    setSettings(data.settings)
    setCanvas(canvas)
    return { ...data, canvas }
  }, [])

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

  // Refresh the project scan without a permanent toolbar button: ⌘R / Ctrl+R
  // does a fast in-app reload (preserving canvas state, unlike a full page
  // reload), and returning to the window re-scans if it's been a while — this
  // covers out-of-band folder changes the user made elsewhere.
  useEffect(() => {
    let lastFocusLoad = Date.now()
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault()
        void load()
      }
    }
    const onFocus = () => {
      if (Date.now() - lastFocusLoad >= 30_000) {
        lastFocusLoad = Date.now()
        void load()
      }
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  // Probe whether in-app feedback is configured server-side (the Supabase env)
  // and whether THIS user may read it. `enabled` gates the "Send feedback" entry;
  // `canRead` gates the owner inbox — server-computed and identity-dependent when
  // an admin allowlist is set, so we re-probe whenever the signed-in user changes
  // (login/logout flips canRead). Best-effort: any failure leaves entries hidden.
  useEffect(() => {
    let cancelled = false
    api.api.feedback.config
      .$get()
      .then((res) => res.json() as Promise<Partial<FeedbackConfigResponse>>)
      .then((data) => {
        if (!cancelled) {
          setFeedbackEnabled(!!data.enabled)
          setFeedbackCanRead(!!data.canRead)
          setFeedbackSourceId(data.sourceId ?? null)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [authUser?.id])

  // Poll the unread feedback count (owner build only) so the settings gear can
  // show a "new feedback" dot. `since` is the newest created_at we've shown in
  // the inbox (persisted in localStorage, scoped per data source); the server
  // counts rows after it. Re-checks on mount, every 5 min, and on window focus
  // (throttled to once a minute — alt-tab fires focus a lot on a desktop shell).
  //
  // Paused while Settings is open: the inbox there IS the live view, and the
  // moment it loads it marks everything seen — so a poll racing in with a stale
  // `since` must not resurrect the dot. Opening Settings re-runs this effect,
  // whose cleanup cancels any in-flight poll; closing it re-runs and polls once
  // immediately against the now-updated seen marker.
  useEffect(() => {
    if (!feedbackCanRead || settingsOpen) return
    let cancelled = false
    let lastPoll = 0
    const poll = () => {
      lastPoll = Date.now()
      const since = localStorage.getItem(feedbackSeenKey(feedbackSourceId)) ?? ''
      api.api.feedback.unread
        .$get({ query: since ? { since } : {} })
        .then((res) => (res.ok ? (res.json() as Promise<{ count?: number }>) : null))
        .then((data) => {
          if (!cancelled && data) setFeedbackUnread(data.count ?? 0)
        })
        .catch(() => {})
    }
    // Only poll on focus if it's been a while — avoids hammering on every alt-tab.
    const onFocus = () => {
      if (Date.now() - lastPoll >= 60_000) poll()
    }
    poll()
    const id = window.setInterval(poll, 300_000)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [feedbackCanRead, settingsOpen, feedbackSourceId])

  // Called by the Settings inbox once it has loaded submissions: record the
  // newest timestamp as "seen" (scoped per data source) and clear the gear dot.
  const markFeedbackSeen = useCallback(
    (latestCreatedAt: string | null) => {
      if (latestCreatedAt)
        localStorage.setItem(feedbackSeenKey(feedbackSourceId), latestCreatedAt)
      setFeedbackUnread(0)
    },
    [feedbackSourceId],
  )

  // Poll which projects have a live terminal (every 5s, skipped while the tab
  // is hidden; an immediate re-poll on focus covers the return). Terminals are
  // always spawned with cwd = the registered project path, so plain equality
  // matches — "or under" covers the edge case of a subdir cwd. Best-effort: a
  // failed poll keeps the last known state rather than flashing beacons off.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.hidden) return
      try {
        const res = await api.api.terminal.active.$get()
        if (!res.ok) return
        const { cwds } = (await res.json()) as { cwds: string[] }
        if (cancelled) return
        const next = new Set(
          projects
            .filter((p) =>
              cwds.some((cwd) => cwd === p.path || cwd.startsWith(p.path + '/')),
            )
            .map((p) => p.id),
        )
        // Keep the previous Set identity when nothing changed so the canvas
        // doesn't re-render every 5 seconds.
        setTerminalActiveIds((prev) =>
          prev.size === next.size && Array.from(next).every((id) => prev.has(id))
            ? prev
            : next,
        )
      } catch {
        /* server restarting / offline — keep the last known state */
      }
    }
    void poll()
    const id = window.setInterval(() => void poll(), 5_000)
    const onFocus = () => void poll()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [projects])

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

  // Every registered project is shown (archive was removed; "Remove from
  // canvas" unregisters instead). Kept as a named binding so the rest of the
  // file reads the same.
  const visibleProjects = projects

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
        // An overlay owns this Escape. Two signals, both needed:
        // - defaultPrevented: the ⌘K palette / feedback / new-project modals
        //   preventDefault when they close themselves — and they UNMOUNT
        //   before this bubble listener runs, so a DOM check can't see them.
        // - [data-esc-overlay] in the DOM: overlays that DON'T self-close on
        //   Esc (panel dialogs, settings) or close later (AccountModal's own
        //   window listener registered after this one) are still mounted.
        // Without these, clearing the selection also closes the project
        // panel beneath the overlay.
        if (e.defaultPrevented) return
        if (document.querySelector('[data-esc-overlay]')) return
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
  ])

  const saveSettings = async (s: Settings) => {
    await api.api.settings.$post({ json: s })
    setSettingsOpen(false)
    await load()
  }

  // "Remove from Ground" — unregister the project. The folder is left on disk;
  // only its card (registry entry + canvas position) goes away.
  const removeFromCanvas = async (project: ProjectMeta) => {
    if (!confirm(t('misc.ground.removeConfirm', { name: project.name }))) return
    const res = await api.api.projects.remove.$post({ json: { path: project.path } })
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string }
      alert(t('misc.ground.removeFailed', { error: e.error ?? res.statusText }))
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

  // Import an existing folder: pick it natively, register it, then open + centre
  // its new card.
  const importProject = async () => {
    const pick = await api.api['pick-folder'].$post()
    const picked = (await pick.json().catch(() => ({}))) as {
      path?: string
      cancelled?: boolean
      error?: string
    }
    if (picked.cancelled || !picked.path) {
      if (picked.error) alert(picked.error)
      return
    }
    const res = await api.api.projects.import.$post({ json: { path: picked.path } })
    const data = (await res.json().catch(() => ({}))) as { error?: string; path?: string; id?: string }
    if (!res.ok) {
      alert(t('misc.ground.importFailed', { error: data.error ?? res.statusText }))
      return
    }
    const loaded = await load()
    const created = loaded?.projects.find((p) => p.id === data.id)
    if (created) {
      setSelectedIds([created.id])
      const pos = loaded!.canvas.positions[created.id]
      if (pos) centerOnCard(pos)
    }
  }

  // Re-point a missing project at the folder the user picks, KEEPING its uuid so
  // its central data (tasks / journal / canvases) reconnects. Distinct from
  // Import (which mints a new id). Mirrors importProject's pick→call→reload flow.
  const relocateProject = async (id: string) => {
    const pick = await api.api['pick-folder'].$post()
    const picked = (await pick.json().catch(() => ({}))) as {
      path?: string
      cancelled?: boolean
      error?: string
    }
    if (picked.cancelled || !picked.path) {
      if (picked.error) alert(picked.error)
      return
    }
    const res = await api.api.projects.relocate.$post({ json: { id, newPath: picked.path } })
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      alert(t('misc.ground.locateFailed', { error: data.error ?? res.statusText }))
      return
    }
    await load()
  }

  if (!settings || !canvas) {
    return <div className="h-screen w-screen bg-bg" />
  }

  const showEmpty = projects.length === 0
  const selectedProjects = visibleProjects.filter((p) => selectedIds.includes(p.id))
  const singleSelected = selectedProjects.length === 1 ? selectedProjects[0] : null
  const selectedElement =
    selectedIds.length === 1
      ? canvas.elements.find((el) => el.id === selectedIds[0]) ?? null
      : null
  // The frame the selected card sits inside supplies its category label —
  // derived from canvas geometry, not a hand-typed field.
  const frameLabel = singleSelected ? frameLabelFor(singleSelected.id, canvas) : null

  return (
    <main className="h-screen w-screen overflow-hidden bg-bg relative">
      <InfiniteCanvas
        projects={visibleProjects}
        terminalActiveIds={terminalActiveIds}
        canvas={canvas}
        onCanvasChange={onCanvasChange}
        selectedIds={selectedIds}
        onSelect={handleSelect}
        onSelectIds={setSelectedIds}
        editingId={editingId}
        onEditingIdChange={setEditingId}
        tool={tool}
        onToolChange={setTool}
      />
      {showEmpty && (
        <EmptyState
          onCreateNew={() => setNewProjectOpen(true)}
          onImport={importProject}
        />
      )}
      {/* Canvas tools are meaningless with no projects — hide them under the
          empty-state modal so the first-run screen stays focused. */}
      {!showEmpty && <ToolPalette tool={tool} onToolChange={setTool} />}
      <Toolbar
        onNewProject={() => setNewProjectOpen(true)}
        onImport={importProject}
        onOpenSettings={() => setSettingsOpen(true)}
        onFeedback={feedbackEnabled ? () => setFeedbackOpen(true) : undefined}
        onAccount={authEnabled ? () => setAccountOpen(true) : undefined}
        unreadFeedback={feedbackUnread}
        projectCount={visibleProjects.length}
        usage={<UsageHud />}
      />
      <ProjectPanel
        project={singleSelected}
        onRelocate={relocateProject}
        frameLabel={frameLabel}
        feedbackEnabled={feedbackEnabled}
        onClose={() => setSelectedIds([])}
        onRemove={removeFromCanvas}
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
          // The project id is a stable registry UUID — it survives the rename —
          // so the panel stays on the same project. Reload to pick up the new
          // path/name; the selection id is unchanged.
          await load()
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
        onReload={load}
        feedbackCanRead={feedbackCanRead}
        onFeedbackSeen={markFeedbackSeen}
        onOpenFeedback={
          feedbackEnabled
            ? () => {
                setSettingsOpen(false)
                setFeedbackOpen(true)
              }
            : undefined
        }
      />
      <NewProjectModal
        open={newProjectOpen}
        defaultWorkspace={settings.defaultWorkspace ?? null}
        onClose={() => setNewProjectOpen(false)}
        onCreated={async (newId) => {
          setNewProjectOpen(false)
          const data = await load()
          // Open the new project's panel and centre the canvas on its card.
          // Match by stable id — the server canonicalizes the folder path, so a
          // path compare would miss when the workspace contains a symlink.
          const created = data?.projects.find((p) => p.id === newId)
          if (created) {
            setSelectedIds([created.id])
            const pos = data!.canvas.positions[created.id]
            if (pos) centerOnCard(pos)
          }
        }}
      />
      <VoiceController voice={settings.voice} projectPath={singleSelected?.path ?? null} />
      <FeedbackModal open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
      <AccountModal open={accountOpen} onClose={() => setAccountOpen(false)} />
      <Onboarding
        open={!onboarded}
        onComplete={() => {
          try {
            localStorage.setItem(ONBOARDED_KEY, '1')
          } catch {
            /* storage unavailable — onboarding just won't persist */
          }
          setOnboarded(true)
        }}
      />
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
