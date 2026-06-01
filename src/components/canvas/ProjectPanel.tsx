import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  Building2,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ClipboardList,
  Clock,
  Compass,
  Copy,
  ExternalLink,
  Flag,
  Frame,
  GitMerge,
  HelpCircle,
  Info,
  Layers,
  Loader2,
  Map as MapIcon,
  MessageCircle,
  Columns3,
  Moon,
  MoreHorizontal,
  Mountain,
  Palette,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Sparkles,
  Square,
  Star,
  Target,
  Terminal,
  Trash2,
  Trees,
  Users,
  Waves,
  Wrench,
  X,
} from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import type {
  OpenApp,
  PermissionMode,
  ProjectData,
  ProjectMeta,
  ProjectTask,
  RunEntry,
  RunSession,
  Settings,
  TaskImage,
} from '@/lib/types'
import { newId } from '@/lib/ids'
import { api } from '@/lib/api-client'
import { migrateLs } from '@/lib/lsMigrate'
import { loadPersistedView, savePersistedView } from '@/lib/persistView'
import { RUN_KIND, fmtChatTime, fmtElapsed, isLive, runKind } from '@/lib/runStatus'
import { AUTO_MAX_ROUNDS, type RunTaskOpts } from '@/lib/useRuns'
import { useOnlineStatus } from '@/lib/useOnlineStatus'
import {
  deleteTaskImage,
  imageFilesFromClipboard,
  taskImageRelPath,
  uploadTaskImages,
} from '@/lib/taskImageUpload'
import { TaskImageThumb } from '@/components/canvas/TaskImageThumb'
import {
  RunGlyph,
  RunStatusBadge,
} from '@/components/canvas/RunStatusBadge'
import { EditableText } from '@/components/canvas/EditableText'
import {
  TerminalPane,
  type TerminalInfo,
  type TerminalPaneHandle,
} from '@/components/canvas/TerminalPane'
import { ProjectCanvas } from '@/components/canvas/ProjectCanvas'
import { OverviewVisionBroadsheet } from '@/components/canvas/overview/OverviewVisionBroadsheet'
import { GoalsTab } from '@/components/canvas/goals/GoalsTab'
import { UsageHud } from '@/components/canvas/UsageHud'
import { SkillPicker } from '@/components/canvas/SkillPicker'
import { BoardTab, useBoardRun } from '@/components/canvas/BoardTab'

type PanelView = 'overview' | 'tasks' | 'terminal' | 'canvas' | 'board' | 'goals'

// MVP scope: the per-project panel ships with Chats + Terminal + Canvas + Board.
// Tasks (goals) and Overview are hidden behind this flag — their code stays
// compiled and the render branches below remain in source, just unreachable from
// the UI (the tab row and the Ctrl+Tab cycle order are both filtered to MVP tabs,
// and the default view is always 'tasks'). To bring a tab back, flip
// SHOW_NON_MVP_TABS to true, or drop its value from MVP_HIDDEN_VIEWS.
const SHOW_NON_MVP_TABS = false
const MVP_HIDDEN_VIEWS: PanelView[] = ['goals', 'overview']
const isMvpVisibleTab = (v: PanelView) =>
  SHOW_NON_MVP_TABS || !MVP_HIDDEN_VIEWS.includes(v)

// Tab cycling order for Ctrl+Tab / Ctrl+Shift+Tab. Mirrors visual left-to-right
// order in the tab row, so "next" feels like "the one to my right." Filtered to
// MVP-visible tabs so Ctrl+Tab can never land on a hidden view.
const PANEL_VIEW_ORDER: PanelView[] = (
  ['tasks', 'terminal', 'canvas', 'board', 'goals', 'overview'] as PanelView[]
).filter(isMvpVisibleTab)

interface TerminalSlot {
  id: string
  label: string
}

const TERMINAL_SLOTS_KEY = (path: string) => `openground.terminal.slots.${path}`
const LEGACY_TERMINAL_SLOTS_KEY = (path: string) => `hove.terminal.slots.${path}`
const DEFAULT_SLOT: TerminalSlot = { id: 'default', label: 'Terminal 1' }

// Per-project slot list. Falls back to a single 'default' slot — that slot
// also re-uses the pre-slot cached PTY id inside TerminalPane, so users
// upgrading don't lose their existing shell.
const loadSlots = (path: string): TerminalSlot[] => {
  if (typeof window === 'undefined') return [DEFAULT_SLOT]
  try {
    migrateLs(LEGACY_TERMINAL_SLOTS_KEY(path), TERMINAL_SLOTS_KEY(path))
    const raw = localStorage.getItem(TERMINAL_SLOTS_KEY(path))
    if (!raw) return [DEFAULT_SLOT]
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed
        .filter((s): s is TerminalSlot => typeof s?.id === 'string')
        .map(s => ({ id: s.id, label: s.label || s.id }))
    }
  } catch {}
  return [DEFAULT_SLOT]
}

const saveSlots = (path: string, slots: TerminalSlot[]) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(TERMINAL_SLOTS_KEY(path), JSON.stringify(slots))
  } catch {}
}

export type ComposerDraft = { text: string; images: TaskImage[] }

interface Props {
  project: ProjectMeta | null
  onClose: () => void
  onArchive: (project: ProjectMeta) => void
  onRestore: (project: ProjectMeta) => void
  onSaved?: (path: string, data: ProjectData) => void
  onDeleted?: (path: string) => void
  /** Rename the project's folder on disk. Rejects bad names; should reload the
   *  canvas and re-select by the new path on success. */
  onRename?: (project: ProjectMeta, newName: string) => Promise<{ error?: string } | void>
  /** Label of the grouping frame this project's card sits inside, if any. */
  frameLabel: string | null
  /** Bumped by the page to force a re-fetch (a run mutated this project's tasks). */
  dataVersion?: number
  /** The most recent run-session per task id, from the run cockpit. */
  taskRuns: Map<string, RunSession>
  /** Every run-session per task id (oldest first) — feeds the task pane chat. */
  allTaskRuns: Map<string, RunSession[]>
  /** Fire (or resume) a task-run for one of this project's tasks. */
  onRunTask: (
    task: ProjectTask,
    opts?: RunTaskOpts,
  ) => void
  /** Cancel the active run of a task. */
  onCancelTask: (taskId: string) => void
  /** Queue an instruction to fire when the given task's current run finishes.
   *  Lets the user keep typing the next request while Claude is still busy. */
  onEnqueueInstruction?: (
    task: ProjectTask,
    instruction: string,
    opts: {
      permissionMode?: PermissionMode
      skill?: string | null
      canvasContext?: { canvasId: string }
    },
    waitForSessionId: string,
  ) => void
  /** Drop every queued instruction for a task — called from the chat delete
   *  flow alongside cancel-live-run so a removed chat doesn't leave a
   *  dangling queue. */
  onCancelAllPending?: (taskId: string) => void
  /** Observer's `canvas-add` SSE signal — forwarded to ProjectCanvas so the
   *  open canvas auto-refreshes when Claude's CANVAS_ADD: lands a new element. */
  canvasAddSignal?: { projectPath: string; canvasId: string; seq: number } | null
  /** Observer's `canvas-error` SSE signal — forwarded to ProjectCanvas so a
   *  rejected CANVAS_ADD / CANVAS_UPDATE marker surfaces as a toast. */
  canvasErrorSignal?: {
    projectPath: string
    canvasId: string
    message: string
    seq: number
  } | null
  /** Selected Claude plan — drives the usage gauge's scale. */
  claudePlan?: Settings['claudePlan']
}

export const ProjectPanel = ({
  project,
  onClose,
  onArchive,
  onRestore,
  onSaved,
  onDeleted,
  onRename,
  frameLabel,
  dataVersion,
  taskRuns,
  allTaskRuns,
  onRunTask,
  onCancelTask,
  onEnqueueInstruction,
  onCancelAllPending,
  canvasAddSignal,
  canvasErrorSignal,
  claudePlan,
}: Props) => {
  const [data, setData] = useState<ProjectData | null>(null)
  const [loading, setLoading] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmingArchive, setConfirmingArchive] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  // Surfaced inline inside the delete-confirm modal — deleting a project is
  // destructive (folder → Trash) and undo-less, so a failed/partial delete must
  // not vanish behind a native alert() the user can dismiss without reading.
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedJson = useRef<string>('')

  useEffect(() => {
    setConfirmingDelete(false)
    setConfirmingArchive(false)
    setConfirmText('')
    setDeleting(false)
    setDeleteError(null)
    if (!project) {
      setData(null)
      return
    }
    setLoading(true)
    api.api.project
      .$get({ query: { path: project.path } }, { init: { cache: 'no-store' } })
      .then(r => r.json() as Promise<ProjectData>)
      .then((d: ProjectData) => {
        setData(d)
        lastSavedJson.current = JSON.stringify(d)
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path, dataVersion])

  const persist = useCallback(
    (next: ProjectData) => {
      if (!project) return
      setData(next)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        const body = JSON.stringify(next)
        if (body === lastSavedJson.current) return
        api.api.project.$put({ query: { path: project.path }, json: next }).then(() => {
          lastSavedJson.current = body
          onSaved?.(project.path, next)
        })
      }, 350)
    },
    [project, onSaved],
  )

  // Board-run controller lives HERE (not in BoardTab) so a board run keeps
  // advancing while the user flips to Chats/Terminal/Canvas — ProjectPanel stays
  // mounted across tab switches; BoardTab does not.
  const boardRun = useBoardRun(data, taskRuns, persist, onRunTask)

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  // Fullscreen chat pane scroll container — jumped to the bottom on every
  // task switch so the latest round and composer are immediately in view
  // (the chat is oldest-first; the meaningful "where we are now" is at the
  // bottom).
  const chatScrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (selectedTaskId == null) return
    const stickToBottom = () => {
      const el = chatScrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    stickToBottom()
    // Re-pin after the next paint — images/log blocks can lay out a frame
    // late and change scrollHeight after the synchronous pass.
    const raf = requestAnimationFrame(stickToBottom)
    return () => cancelAnimationFrame(raf)
  }, [selectedTaskId])
  // Floating "scroll to bottom" affordance — shows up only when the user has
  // scrolled away from the tail of a long thread. ChatGPT / iMessage pattern:
  // a small chevron that smooth-scrolls back so they don't have to drag the
  // scrollbar all the way down.
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const handleChatScroll = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) {
      setShowScrollToBottom(false)
      return
    }
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setShowScrollToBottom(dist > 240)
  }, [])
  const scrollChatToBottom = useCallback(() => {
    const el = chatScrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])
  // Reset the button whenever the active chat changes — the post-switch effect
  // above pins to bottom synchronously, so the button should not flash on for
  // a frame on the new thread.
  useEffect(() => {
    setShowScrollToBottom(false)
  }, [selectedTaskId])
  // Tasks / Terminal / Canvas toggle. Persisted to localStorage so the user's
  // chosen tab survives a page reload (and popping the panel closed + re-open),
  // mirroring how the terminal session itself is cached in localStorage. The
  // saved tab is validated against the MVP-visible set so a stale hidden tab
  // (e.g. 'goals') can never strand the panel on a tab with no row entry.
  const [view, setView] = useState<PanelView>(() => {
    const saved = loadPersistedView().panelTab
    return saved && isMvpVisibleTab(saved) ? saved : 'tasks'
  })
  // Persist the active tab on every change (covers tab clicks and Ctrl+Tab).
  useEffect(() => {
    savePersistedView({ panelTab: view })
  }, [view])
  // Mirrored up from TerminalPane so the Terminal tab can show `zsh · 163×44`
  // and a Restart button next to its label — the tab thus reads as the header
  // of the panel it controls.
  const [terminalInfo, setTerminalInfo] = useState<TerminalInfo | null>(null)
  const terminalRef = useRef<TerminalPaneHandle | null>(null)
  // Multiple PTY sessions per project. Each slot has its own id and a
  // user-visible label; the active slot's TerminalPane is the one mounted at
  // any moment so resources stay bounded. List is mirrored to localStorage
  // (per-project) so the layout survives panel close / app relaunch.
  const [terminalSlots, setTerminalSlots] = useState<TerminalSlot[]>(() =>
    project ? loadSlots(project.path) : [DEFAULT_SLOT],
  )
  const [activeTerminalSlot, setActiveTerminalSlot] = useState<string>(
    () => terminalSlots[0]?.id ?? 'default',
  )
  // Tracks which project path's slot list is currently in state. Used to
  // gate persistence: we must not save until we've loaded for this path,
  // otherwise the initial-render default slot would clobber a saved
  // multi-slot list on every reload (the exact bug that ate user terminals
  // after Cmd+R).
  const loadedForPathRef = useRef<string | null>(
    project ? project.path : null,
  )
  useEffect(() => {
    const path = project?.path
    if (!path) return
    if (loadedForPathRef.current !== path) {
      // First time we see this project (mount, project arrival, or switch
      // between projects). Load from disk; this run does NOT save.
      const next = loadSlots(path)
      loadedForPathRef.current = path
      setTerminalSlots(next)
      setActiveTerminalSlot(next[0]?.id ?? 'default')
      return
    }
    // Subsequent runs for the same path: terminalSlots changed because the
    // user added / removed / switched a slot — persist it.
    saveSlots(path, terminalSlots)
  }, [project?.path, terminalSlots])

  // Ctrl+Tab cycles forward through the view tabs; Ctrl+Shift+Tab cycles
  // backward. Registered in capture phase so we intercept before xterm — when
  // the terminal pane is focused it would otherwise swallow Tab and forward
  // it to the shell as a literal `\t`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== 'Tab' || e.metaKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      const i = PANEL_VIEW_ORDER.indexOf(view)
      const step = e.shiftKey ? -1 : 1
      const next = PANEL_VIEW_ORDER[(i + step + PANEL_VIEW_ORDER.length) % PANEL_VIEW_ORDER.length]
      setView(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [view])
  const dataRef = useRef<ProjectData | null>(data)
  dataRef.current = data

  // Per-task composer draft — text + staged images survive switching between
  // chats in the right pane, so a half-typed reply on Task A doesn't bleed
  // into Task B and isn't lost when the user pops back to A.
  const [taskDrafts, setTaskDrafts] = useState<Record<string, ComposerDraft>>({})
  const taskDraftsRef = useRef(taskDrafts)
  taskDraftsRef.current = taskDrafts
  useEffect(() => {
    // When this project panel unmounts (or the user switches projects), drop
    // every staged-but-unsent image from disk. Per-task TaskThreads no longer
    // do this themselves in pane mode (they'd fire on every chat switch and
    // trash the draft), so the owner of the drafts handles it here.
    const path = project?.path
    if (!path) return
    return () => {
      for (const d of Object.values(taskDraftsRef.current)) {
        for (const im of d.images) void deleteTaskImage(path, im.id)
      }
    }
  }, [project?.path])
  const updateDraft = useCallback(
    (taskId: string, updater: (prev: ComposerDraft) => ComposerDraft) => {
      setTaskDrafts(prev => {
        const current = prev[taskId] ?? { text: '', images: [] }
        const next = updater(current)
        if (next.text === '' && next.images.length === 0) {
          if (!(taskId in prev)) return prev
          const { [taskId]: _, ...rest } = prev
          return rest
        }
        return { ...prev, [taskId]: next }
      })
    },
    [],
  )
  const dropDraft = useCallback((taskId: string, deleteImages: boolean) => {
    const existing = taskDraftsRef.current[taskId]
    const path = project?.path
    if (deleteImages && existing && path) {
      for (const im of existing.images) void deleteTaskImage(path, im.id)
    }
    setTaskDrafts(prev => {
      if (!(taskId in prev)) return prev
      const { [taskId]: _, ...rest } = prev
      return rest
    })
  }, [project?.path])

  // Fullscreen mode's left tasks sidebar is independently resizable. Width
  // persists across reloads via localStorage.
  const FS_SIDEBAR_DEFAULT_WIDTH = 400
  const [fsSidebarWidth, setFsSidebarWidth] = useState(FS_SIDEBAR_DEFAULT_WIDTH)
  useEffect(() => {
    migrateLs('hove.fsSidebarWidth', 'openground.fsSidebarWidth')
    const raw = localStorage.getItem('openground.fsSidebarWidth')
    const n = raw ? Number(raw) : NaN
    if (Number.isFinite(n)) {
      setFsSidebarWidth(Math.min(720, Math.max(280, n)))
    }
  }, [])
  const fsSidebarWidthRef = useRef(fsSidebarWidth)
  fsSidebarWidthRef.current = fsSidebarWidth
  const startFsSidebarDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = fsSidebarWidthRef.current
    const onMove = (ev: MouseEvent) => {
      const max = Math.min(720, window.innerWidth - 360)
      const next = Math.max(280, Math.min(max, startW + (ev.clientX - startX)))
      setFsSidebarWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      localStorage.setItem('openground.fsSidebarWidth', String(fsSidebarWidthRef.current))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }
  const resetFsSidebarWidth = () => {
    setFsSidebarWidth(FS_SIDEBAR_DEFAULT_WIDTH)
    localStorage.setItem('openground.fsSidebarWidth', String(FS_SIDEBAR_DEFAULT_WIDTH))
  }

  // "Open this folder in…" — only the apps the user has registered. The first
  // entry is the default for one-click Open; the dropdown can re-star it.
  const [openMenuOpen, setOpenMenuOpen] = useState(false)
  const [openApps, setOpenApps] = useState<OpenApp[]>([])
  useEffect(() => {
    api.api.project.open
      .$get()
      .then(r => r.json() as Promise<{ apps?: OpenApp[] }>)
      .then((d) => setOpenApps(d.apps ?? []))
      .catch(() => {})
  }, [])
  useEffect(() => {
    if (!openMenuOpen) return
    const close = () => setOpenMenuOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [openMenuOpen])
  const saveOpenApps = async (apps: OpenApp[]) => {
    try {
      await api.api.project.open.$put({ json: { apps } })
    } catch {
      /* best-effort; the in-memory list still updates */
    }
  }
  const addOpenApp = (app: OpenApp) => {
    if (!app.name.trim()) return
    if (openApps.some(a => a.name === app.name)) return
    const next = [...openApps, app]
    setOpenApps(next)
    saveOpenApps(next)
  }
  const removeOpenApp = (name: string) => {
    const next = openApps.filter(a => a.name !== name)
    setOpenApps(next)
    saveOpenApps(next)
  }
  const makeDefaultOpenApp = (name: string) => {
    const found = openApps.find(a => a.name === name)
    if (!found || openApps[0]?.name === name) return
    const next = [found, ...openApps.filter(a => a.name !== name)]
    setOpenApps(next)
    saveOpenApps(next)
  }
  const pickOpenApp = async () => {
    try {
      const res = await api.api.project.open.pick.$post()
      const d = (await res.json()) as {
        name?: string
        path?: string
        mode?: 'open' | 'cwd'
        cancelled?: boolean
        error?: string
      }
      if (d.cancelled || !d.name) return
      if (d.error) {
        alert(`Pick failed: ${d.error}`)
        return
      }
      addOpenApp({ name: d.name, path: d.path, mode: d.mode ?? 'open' })
    } catch (e: any) {
      alert(`Pick failed: ${e?.message ?? 'network error'}`)
    }
  }
  const openIn = async (app: OpenApp) => {
    setOpenMenuOpen(false)
    if (!project) return
    try {
      const res = await api.api.project.open.$post({
        json: { path: project.path, app: app.name },
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        alert(`Open failed: ${e.error ?? res.statusText}`)
      }
    } catch (e: any) {
      alert(`Open failed: ${e?.message ?? 'network error'}`)
    }
  }

  if (!project) return null

  const doDelete = async () => {
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await api.api.project.delete.$post({ json: { path: project.path } })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        setDeleteError(e.error ?? res.statusText ?? 'Delete failed.')
        setDeleting(false)
        return
      }
      onDeleted?.(project.path)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed.')
      setDeleting(false)
    }
  }

  const selectedTask =
    (data && selectedTaskId && data.tasks.find(t => t.id === selectedTaskId)) ||
    null
  const hasTasks = !!data && data.tasks.length > 0
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg-card">
      <header className="rule-double flex items-start justify-between gap-3 px-8 pt-5 pb-4">
        <div className="min-w-0">
          <button
            onClick={onClose}
            className="flex items-center gap-1 label-cap text-accent transition-colors hover:text-ink"
          >
            <ChevronLeft size={11} strokeWidth={2.5} /> Ground に戻る
          </button>
          <EditableTitle
            name={project.name}
            size="fullscreen"
            onRename={onRename ? (next) => onRename(project, next) : undefined}
          />
          {data && (
            <div className="mt-2 max-w-[560px]">
              <EditableText
                value={data.description}
                onSave={d => persist({ ...data, description: d })}
                placeholder="プロジェクトの説明を追加…"
              />
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Mirrors the Ground's top-right usage strip — model + token gauge,
              kept visible while working inside a project so the user always
              knows how close they are to the rate-limit cap. */}
          <UsageHud plan={claudePlan} />
          <div className="flex items-center gap-0.5">
            <MoreMenu
              archived={!!project.archived}
              onArchive={() => setConfirmingArchive(true)}
              onRestore={() => onRestore(project)}
              onDelete={() => setConfirmingDelete(true)}
            />
            <IconButton title="Close" onClick={onClose}>
              <X size={15} strokeWidth={1.75} />
            </IconButton>
          </div>
        </div>
      </header>

      <ViewTabs
        view={view}
        onChange={setView}
        terminalInfo={terminalInfo}
        onTerminalRestart={() => terminalRef.current?.restart()}
      />

      {view === 'terminal' ? (
        <div className="min-h-0 flex-1 flex">
          <TerminalSlotSidebar
            slots={terminalSlots}
            activeId={activeTerminalSlot}
            onActivate={setActiveTerminalSlot}
            onAdd={() => {
              // 'default' is the migration slot id; new slots get unique ids
              // so caches and PTYs can't collide. Labels just count up —
              // "Terminal N" picks the next free integer.
              const nextId = `t-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 6)}`
              const nextNum =
                Math.max(
                  0,
                  ...terminalSlots.map(s => {
                    const m = s.label.match(/Terminal (\d+)/)
                    return m ? Number(m[1]) : 0
                  }),
                ) + 1
              const slot: TerminalSlot = { id: nextId, label: `Terminal ${nextNum}` }
              setTerminalSlots(prev => [...prev, slot])
              setActiveTerminalSlot(slot.id)
            }}
            onClose={async id => {
              // Best-effort: tell the server to drop the PTY for the closed
              // slot. The cached id lives under
              // openground.terminal.session.<path>.<id> — read it, DELETE the
              // session, then drop the localStorage key.
              try {
                const key = `openground.terminal.session.${project.path}.${id}`
                const cached = localStorage.getItem(key)
                if (cached) {
                  api.api.terminal[':id'].$delete({ param: { id: cached } }).catch(
                    () => {},
                  )
                  localStorage.removeItem(key)
                }
              } catch {}
              setTerminalSlots(prev => {
                const next = prev.filter(s => s.id !== id)
                // Never end up with zero slots — the tab has to render
                // something. Seed a fresh slot if the user closed the last.
                return next.length > 0 ? next : [DEFAULT_SLOT]
              })
              setActiveTerminalSlot(prev => {
                if (prev !== id) return prev
                const remaining = terminalSlots.filter(s => s.id !== id)
                return remaining[0]?.id ?? DEFAULT_SLOT.id
              })
            }}
          />
          <div className="min-w-0 flex-1">
            <TerminalPane
              key={activeTerminalSlot}
              ref={terminalRef}
              projectPath={project.path}
              slotKey={activeTerminalSlot}
              onInfo={setTerminalInfo}
            />
          </div>
        </div>
      ) : view === 'canvas' ? (
        <div className="min-h-0 flex-1">
          <ProjectCanvas
            projectPath={project.path}
            taskRuns={taskRuns}
            allTaskRuns={allTaskRuns}
            onRunTask={onRunTask}
            onCancelTask={onCancelTask}
            canvasAddSignal={canvasAddSignal}
            canvasErrorSignal={canvasErrorSignal}
          />
        </div>
      ) : loading || !data ? (
        <div className="flex-1 px-8 py-6 text-[12px] text-ink-subtle">Loading…</div>
      ) : view === 'board' ? (
        <div className="min-h-0 flex-1">
          <BoardTab
            data={data}
            taskRuns={taskRuns}
            boardRun={boardRun}
            onPersist={persist}
            onRunTask={onRunTask}
            onCancelTask={onCancelTask}
            onOpenTask={id => {
              setSelectedTaskId(id)
              setView('tasks')
            }}
            onGoToChats={() => setView('tasks')}
          />
        </div>
      ) : view === 'goals' ? (
        <div className="min-h-0 flex-1">
          <GoalsTab projectPath={project.path} dataVersion={dataVersion} />
        </div>
      ) : view === 'overview' ? (
        <OverviewVisionBroadsheet data={data} project={project} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside
            style={{ width: fsSidebarWidth }}
            className="relative shrink-0 overflow-y-auto border-r border-line px-6 py-6"
          >
            <div
              onMouseDown={startFsSidebarDrag}
              onDoubleClick={resetFsSidebarWidth}
              title="ドラッグで幅を変更 / ダブルクリックで初期幅"
              className="absolute bottom-0 right-0 top-0 z-10 -mr-1 w-2 cursor-col-resize transition-colors hover:bg-accent/40"
            />
            <div className="space-y-6">
              <TasksSection
                data={data}
                projectPath={project.path}
                onChange={persist}
                taskRuns={taskRuns}
                onRunTask={onRunTask}
                onCancelTask={onCancelTask}
                selectable
                selectedTaskId={selectedTask?.id ?? null}
                onSelectTask={(id) => setSelectedTaskId(id)}
                // "+ New chat" just clears selection — the empty right pane
                // is itself the new-task composer (ChatGPT pattern).
                onStartNew={() => setSelectedTaskId(null)}
              />
              <NotesSection data={data} onChange={persist} />
            </div>
          </aside>
          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {selectedTask ? (
              <>
                <div className="shrink-0 border-b border-line-soft">
                  <div className="mx-auto flex max-w-[680px] items-center gap-3 px-8 py-4">
                    <p className="label-cap text-ink-muted">Chat thread</p>
                    {(() => {
                      const e = taskRuns.get(selectedTask.id)?.entries[0]
                      if (e) return <RunStatusBadge kind={runKind(e)} />
                      // Phase 5.A — no session, but a persisted latestRun: show
                      // its kind so the header badge matches the fallback card.
                      const lr = selectedTask.latestRun
                      return lr ? <RunStatusBadge kind={lr.kind} /> : null
                    })()}
                  </div>
                </div>
                <TaskThread
                  variant="pane"
                  task={selectedTask}
                  projectPath={project.path}
                  run={taskRuns.get(selectedTask.id)}
                  allRuns={allTaskRuns.get(selectedTask.id) ?? []}
                  draft={taskDrafts[selectedTask.id] ?? { text: '', images: [] }}
                  onDraftChange={updater =>
                    updateDraft(selectedTask.id, updater)
                  }
                  onRun={opts => onRunTask(selectedTask, opts)}
                  onEnqueue={
                    onEnqueueInstruction
                      ? (instruction, opts) => {
                          const latestRunId = taskRuns.get(selectedTask.id)?.id
                          if (!latestRunId) return
                          onEnqueueInstruction(
                            selectedTask,
                            instruction,
                            opts,
                            latestRunId,
                          )
                        }
                      : undefined
                  }
                  onUpdate={patch =>
                    persist({
                      ...data,
                      tasks: data.tasks.map(t =>
                        t.id === selectedTask.id ? { ...t, ...patch } : t,
                      ),
                    })
                  }
                  onCancel={() => onCancelTask(selectedTask.id)}
                  onDelete={() => {
                    // Phase 5.2: 3-point chat removal — cancel any live run,
                    // drop the queued instructions, then remove from disk.
                    // observer detach happens server-side when the cancel
                    // path tears down the PTY, so no client-side step is
                    // needed for that leg.
                    onCancelTask(selectedTask.id)
                    onCancelAllPending?.(selectedTask.id)
                    dropDraft(selectedTask.id, true)
                    persist({
                      ...data,
                      tasks: data.tasks.filter(t => t.id !== selectedTask.id),
                    })
                    setSelectedTaskId(null)
                  }}
                  paneScrollRef={chatScrollRef}
                  onPaneScroll={handleChatScroll}
                  paneContentClassName="mx-auto max-w-[680px] px-8 py-7"
                  paneScrollOverlay={
                    showScrollToBottom ? (
                      <button
                        type="button"
                        onClick={scrollChatToBottom}
                        title="一番下までスクロール"
                        aria-label="一番下までスクロール"
                        className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-bg-card text-ink-muted shadow-card transition-all duration-150 hover:bg-bg-elevated hover:text-ink active:scale-95"
                      >
                        <ChevronDown size={16} strokeWidth={2.25} />
                      </button>
                    ) : null
                  }
                />
              </>
            ) : (
              // ChatGPT pattern: the empty pane *is* the new-chat composer.
              // No mode switch, the composer is always there waiting.
              <NewTaskComposer
                projectPath={project.path}
                hasOtherChats={hasTasks}
                onCreate={(title, images, opts) => {
                  if (!data) return
                  const task: ProjectTask = {
                    id: newId(),
                    title,
                    done: false,
                    milestoneId: null,
                    createdAt: new Date().toISOString(),
                    ...(images.length > 0 ? { images } : {}),
                  }
                  persist({ ...data, tasks: [task, ...data.tasks] })
                  setSelectedTaskId(task.id)
                  // Fire the first Claude round straight away — submitting
                  // is the user's intent to "run", not just save.
                  onRunTask(task, {
                    permissionMode: opts?.planMode ? 'plan' : undefined,
                  })
                }}
              />
            )}
          </main>
        </div>
      )}

      {confirmingDelete && (
        <DeleteConfirm
          projectName={project.name}
          confirmText={confirmText}
          setConfirmText={setConfirmText}
          deleting={deleting}
          error={deleteError}
          onCancel={() => {
            setConfirmingDelete(false)
            setConfirmText('')
            setDeleteError(null)
          }}
          onConfirm={doDelete}
        />
      )}

      {confirmingArchive && (
        <ArchiveConfirm
          projectName={project.name}
          onCancel={() => setConfirmingArchive(false)}
          onConfirm={() => {
            setConfirmingArchive(false)
            onArchive(project)
          }}
        />
      )}
    </div>
  )
}

const DeleteConfirm = ({
  projectName,
  confirmText,
  setConfirmText,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  projectName: string
  confirmText: string
  setConfirmText: (s: string) => void
  deleting: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) => (
  <div className="absolute inset-0 z-20 flex flex-col justify-center gap-5 bg-bg-card px-6">
    <div className="mx-auto w-full max-w-[420px]">
      <p className="label-cap text-accent mb-2">Delete project</p>
      <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
        Move “{projectName}” to the Trash?
      </h3>
      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
        The entire project folder is moved to the macOS Trash. It is removed from
        OPEN GROUND and from your projects folder — but you can still restore it
        from the Trash in Finder.
      </p>
      <label className="label-cap text-ink-muted mb-1.5 mt-5 block">
        Type{' '}
        <span className="font-mono normal-case tracking-normal text-ink">
          {projectName}
        </span>{' '}
        to confirm
      </label>
      <input
        autoFocus
        value={confirmText}
        onChange={e => setConfirmText(e.target.value)}
        placeholder={projectName}
        className="w-full rounded-[2px] border border-line bg-bg px-3 py-2 font-mono text-[12px] text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent"
      />
      {error && (
        <p className="mt-3 text-[11px] leading-relaxed text-accent">
          Delete failed: {error}
        </p>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <Btn variant="subtle" size="md" onClick={onCancel}>Cancel</Btn>
        <Btn
          variant="primary"
          size="md"
          onClick={onConfirm}
          disabled={confirmText.trim() !== projectName || deleting}
        >
          {deleting ? 'Deleting…' : 'Delete'}
        </Btn>
      </div>
    </div>
  </div>
)

const IconButton = ({
  children,
  onClick,
  title,
  danger,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  danger?: boolean
}) => (
  <Btn variant="icon" size="md" onClick={onClick} title={title} danger={danger}>
    {children}
  </Btn>
)

// Tasks ↔ Terminal switcher. Renders as proper underline tabs whose active
// indicator visually replaces the bottom border under that tab — so the panel
// below reads as "the selected tab's content," not as a sibling of the tab row.
// The Terminal tab also shows live session info (`zsh · 163×44`) and a Restart
// affordance once a shell is attached.
const ViewTabs = ({
  view,
  onChange,
  terminalInfo,
  onTerminalRestart,
}: {
  view: PanelView
  onChange: (v: PanelView) => void
  terminalInfo: TerminalInfo | null
  onTerminalRestart: () => void
}) => {
  const tabs = ([
    { value: 'tasks', label: 'Chats', icon: <Check size={10} strokeWidth={2.25} /> },
    {
      value: 'terminal',
      label: 'Terminal',
      icon: <Terminal size={10} strokeWidth={2.25} />,
    },
    { value: 'canvas', label: 'Canvas', icon: <Palette size={10} strokeWidth={2.25} /> },
    { value: 'board', label: 'Board', icon: <Columns3 size={10} strokeWidth={2.25} /> },
    { value: 'goals', label: 'Tasks', icon: <Target size={10} strokeWidth={2.25} /> },
    { value: 'overview', label: 'Overview', icon: <Info size={10} strokeWidth={2.25} /> },
  ] as { value: PanelView; label: string; icon: React.ReactNode }[]).filter(t =>
    isMvpVisibleTab(t.value),
  )
  return (
    <div className="flex shrink-0 items-end gap-4 border-b border-line px-8">
      {tabs.map(t => {
        const active = t.value === view
        return (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            // -mb-px lets the active border-b sit directly on top of the
            // row's border-b, so the underline reads as "this tab owns the
            // panel below," not "this tab has its own underline above the
            // row line."
            className={[
              '-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 label-cap transition-colors',
              active
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-muted hover:text-accent',
            ].join(' ')}
          >
            {t.icon}
            <span>{t.label}</span>
          </button>
        )
      })}
      {view === 'terminal' && (
        <button
          onClick={onTerminalRestart}
          title="Restart shell"
          className="-mb-px ml-auto flex items-center gap-1 border-b-2 border-transparent px-1 py-2 label-cap text-ink-muted transition-colors hover:text-accent"
        >
          <RotateCw size={10} strokeWidth={2.25} />
          <span>Restart</span>
        </button>
      )}
    </div>
  )
}

// Overflow menu for low-frequency project actions (archive / restore / delete).
// Keeps the header focused on the everyday controls (just Close, alongside this menu).
const MoreMenu = ({
  archived,
  onArchive,
  onRestore,
  onDelete,
}: {
  archived: boolean
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
}) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  return (
    <div ref={ref} className="relative" onMouseDown={e => e.stopPropagation()}>
      <IconButton title="More actions" onClick={() => setOpen(v => !v)}>
        <MoreHorizontal size={15} strokeWidth={1.75} />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-52 rounded-[2px] border border-line bg-bg-card py-1 shadow-card-hover">
          {archived ? (
            <button
              onClick={() => {
                setOpen(false)
                onRestore()
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-bg-inset"
            >
              <ArchiveRestore size={12} strokeWidth={1.75} />
              アーカイブから戻す
            </button>
          ) : (
            <button
              onClick={() => {
                setOpen(false)
                onArchive()
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-bg-inset"
            >
              <Archive size={12} strokeWidth={1.75} />
              プロジェクトをアーカイブ
            </button>
          )}
          <div className="my-1 border-t border-line-soft" />
          <button
            onClick={() => {
              setOpen(false)
              onDelete()
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-accent transition-colors hover:bg-accent-soft"
          >
            <Trash2 size={12} strokeWidth={1.75} />
            プロジェクトを削除…
          </button>
        </div>
      )}
    </div>
  )
}

const ArchiveConfirm = ({
  projectName,
  onCancel,
  onConfirm,
}: {
  projectName: string
  onCancel: () => void
  onConfirm: () => void
}) => (
  <div className="absolute inset-0 z-20 flex flex-col justify-center gap-5 bg-bg-card px-6">
    <div className="mx-auto w-full max-w-[420px]">
      <p className="label-cap text-accent mb-2">Archive project</p>
      <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
        “{projectName}” をアーカイブしますか？
      </h3>
      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
        プロジェクトフォルダが <span className="font-mono normal-case tracking-normal text-ink">_archive/</span> に移動されます。
        Atlas の通常ビューからは見えなくなりますが、いつでもアーカイブセクターから復元できます。
      </p>
      <div className="mt-5 flex items-center justify-end gap-2">
        <Btn variant="subtle" size="md" onClick={onCancel}>Cancel</Btn>
        <Btn variant="primary" size="md" onClick={onConfirm}>Archive</Btn>
      </div>
    </div>
  </div>
)


const SectionLabel = ({ children, count }: { children: React.ReactNode; count?: number }) => (
  <div className="mb-2.5 flex items-baseline gap-2 label-cap text-ink-muted">
    <span>{children}</span>
    {count !== undefined && (
      <span className="font-mono normal-case tracking-normal text-ink-faint text-[10px]">
        {String(count).padStart(2, '0')}
      </span>
    )}
  </div>
)

// Small clipboard-copy button used wherever the user might want to grab the
// raw text shown above (run logs, parsed summaries). Flashes a "コピー済" tick
// for 1.5s so the user knows the write succeeded without spawning a toast.
// Falls back to a hidden-textarea + execCommand path on browsers / contexts
// that don't expose `navigator.clipboard` (older Safari, non-secure origin).
const CopyButton = ({
  text,
  label = 'コピー',
  title = 'クリップボードにコピー',
}: {
  text: string
  label?: string
  title?: string
}) => {
  const [copied, setCopied] = useState(false)
  const onClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    let ok = false
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text)
        ok = true
      }
    } catch {
      ok = false
    }
    if (!ok) {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        ta.style.pointerEvents = 'none'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        ok = true
      } catch {}
    }
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 label-cap text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink"
    >
      {copied ? (
        <Check size={10} strokeWidth={2.25} />
      ) : (
        <Copy size={10} strokeWidth={2} />
      )}
      {copied ? 'コピー済' : label}
    </button>
  )
}

// Button to trigger Claude-assisted conflict resolution for a worktree merge conflict.
// compact=true → inline mini button only (used in the conflict banner).
// mergeStatus='failed-fatal' → merge AND merge --abort both failed; surface a
// manual-intervention warning instead of offering another resolve cycle.
export const ResolveConflictBtn = ({
  sessionId,
  projectId,
  compact = false,
  mergeStatus = 'conflict',
}: {
  sessionId: string
  projectId: string
  compact?: boolean
  mergeStatus?: 'conflict' | 'failed-fatal'
}) => {
  const [resolving, setResolving] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleResolve = async () => {
    setResolving(true)
    setError(null)
    try {
      const res = await api.api.run['resolve-conflict'].$post({
        json: { sessionId, projectId },
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? 'Failed to start conflict resolution')
      }
    } catch {
      setError('Network error')
    } finally {
      setResolving(false)
    }
  }

  const handleDismiss = async () => {
    setDismissing(true)
    setError(null)
    try {
      const res = await api.api.run['dismiss-conflict'].$post({
        json: { sessionId, projectId },
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        setError(data.error ?? 'Failed to dismiss conflict')
      }
    } catch {
      setError('Network error')
    } finally {
      setDismissing(false)
    }
  }

  // failed-fatal: merge --abort itself failed (git index lock / repo broken).
  // No automated resolve is safe — instruct the user to open the worktree
  // and reconcile by hand. Dismiss is still offered so the UI doesn't get
  // stuck once the user has cleaned up manually.
  if (mergeStatus === 'failed-fatal') {
    return (
      <div className="rounded-[4px] border border-accent bg-accent/5 px-3 py-2.5">
        <p className="mb-2 text-[12px] leading-snug text-accent">
          マージが致命的に失敗しました。<code className="font-mono">git merge</code>
          {' と '}
          <code className="font-mono">--abort</code>
          {' '}の両方が落ちており、Claude による自動解消は安全に行えません。
        </p>
        <p className="mb-2 text-[12px] leading-snug text-ink-muted">
          ターミナルで対象プロジェクトの worktree (
          <code className="font-mono">.openground/worktrees/&lt;id&gt;</code>)
          を確認し、<code className="font-mono">git status</code> /{' '}
          <code className="font-mono">git reset</code> /{' '}
          <code className="font-mono">git worktree remove</code>{' '}
          で手動修復してください。
        </p>
        {error && <p className="mb-1.5 text-[10px] text-accent">{error}</p>}
        <Btn
          variant="ghost"
          size="xs"
          onClick={handleDismiss}
          disabled={dismissing}
          className="text-ink-faint hover:text-ink"
          title="手動修復後にこの表示を閉じる"
        >
          {dismissing ? '閉じ中…' : '手動で解消済み — 閉じる'}
        </Btn>
      </div>
    )
  }

  if (compact) {
    return (
      <div className="flex items-center gap-1.5">
        {error && <span className="text-[10px] text-accent">{error}</span>}
        <Btn
          variant="ghost"
          size="xs"
          onClick={handleResolve}
          disabled={resolving || dismissing}
          className="shrink-0 border-ochre text-ochre hover:bg-ochre/10"
        >
          <GitMerge size={9} />
          {resolving ? '解消中…' : '解消'}
        </Btn>
        <Btn
          variant="ghost"
          size="xs"
          onClick={handleDismiss}
          disabled={resolving || dismissing}
          className="shrink-0 text-ink-faint hover:text-ink"
          title="自分で解消したので閉じる"
        >
          {dismissing ? '閉じ中…' : '閉じる'}
        </Btn>
      </div>
    )
  }

  return (
    <div className="rounded-[4px] border border-ochre bg-ochre-soft px-3 py-2.5">
      <p className="mb-2 text-[12px] leading-snug text-ochre">
        マージコンフリクトが発生しました。Claude にコンフリクトを解消させますか？
      </p>
      {error && <p className="mb-1.5 text-[10px] text-accent">{error}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        <Btn
          variant="ghost"
          size="xs"
          onClick={handleResolve}
          disabled={resolving || dismissing}
          className="border-ochre text-ochre hover:bg-ochre/10"
        >
          <GitMerge size={9} />
          {resolving ? '解消中…' : 'コンフリクトを解消'}
        </Btn>
        <Btn
          variant="ghost"
          size="xs"
          onClick={handleDismiss}
          disabled={resolving || dismissing}
          className="text-ink-faint hover:text-ink"
          title="自分で解消したのでこの表示を閉じる"
        >
          {dismissing ? '閉じ中…' : '解消済みとして閉じる'}
        </Btn>
      </div>
    </div>
  )
}

// One labelled bullet list in a run Recap — used for やったこと (completed),
// 判断 (decisions, the "why" layer) and 次の一手 (followups). Renders nothing
// for an empty list so a section only appears when Claude populated it.
const RecapList = ({
  label,
  items,
  dot,
  labelClass,
}: {
  label: string
  items: string[] | undefined
  dot: string
  labelClass: string
}) =>
  !items || items.length === 0 ? null : (
    <div>
      <div className={['label-cap mb-1', labelClass].join(' ')}>
        {label} · {items.length}
      </div>
      <ul className="space-y-1">
        {items.map((it, i) => (
          <li
            key={i}
            className="flex items-start gap-2 text-[12px] leading-snug text-ink-muted"
          >
            <span
              className={['mt-[6px] inline-block h-1 w-1 shrink-0 rounded-full', dot].join(' ')}
            />
            <span>{it}</span>
          </li>
        ))}
      </ul>
    </div>
  )

// One Q/A round in the task pane chat — a user bubble (right) and a response
// card (left) carrying the run's status, summary, completed list, follow-ups,
// and a "view log" affordance, scoped to a task pane.
export const RoundView = ({
  session,
  isFirst,
  onFollowupClick,
  onPasteToCanvas,
}: {
  session: RunSession
  isFirst: boolean
  onFollowupClick: (text: string) => void
  /** Canvas-only: when set, render a "Paste to canvas" affordance that drops
   *  this round's narrative onto the surrounding Canvas as a sticky note. */
  onPasteToCanvas?: (text: string) => void
}) => {
  const [now, setNow] = useState(Date.now())
  const [showLog, setShowLog] = useState(false)
  const e = session.entries[0]
  const live = isLive(e.status)
  const kind = runKind(e)
  const startMs = Date.parse(e.startedAt ?? session.startedAt)
  const endMs = e.finishedAt ? Date.parse(e.finishedAt) : now
  const elapsed = fmtElapsed(endMs - startMs)
  const sentAt = fmtChatTime(e.startedAt ?? session.startedAt)
  const finishedAt = !live && e.finishedAt ? fmtChatTime(e.finishedAt) : ''
  // Show the captured user message; on legacy rounds with no feedback, only
  // the first round falls back to the task title so it doesn't echo on resume.
  const userMsg =
    e.feedback?.trim() || (isFirst ? e.targetedTasks[0]?.title ?? '' : '')
  const pr = e.parsedResult
  // What Claude is currently *thinking* — narrative-only, no tool calls or
  // file paths. Reads directly off the entry's thought stream so opening the
  // full log isn't necessary to follow the reasoning.
  const latestThought = useMemo(
    () => e.thoughts?.[e.thoughts.length - 1]?.text ?? '',
    [e.thoughts],
  )
  // What Claude is currently *doing* — last tool_use ("Edit auth.ts",
  // "Bash npm test", "Read README.md"). Paired with latestThought, this
  // answers "what file?" alongside "why?" without the user having to open
  // a raw terminal — Chat stays as a curated summary surface, not a
  // duplicate of the Terminal tab.
  const latestAction = useMemo(
    () => e.actions?.[e.actions.length - 1] ?? null,
    [e.actions],
  )

  // Live rounds need a ticking clock so elapsed actually advances.
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])

  return (
    <div className="flex flex-col gap-3">
      {e.resumeFallback && (
        <div className="self-center max-w-[80%] rounded-[3px] border border-ochre/40 bg-ochre/10 px-3 py-1.5 text-[11.5px] leading-snug text-ochre">
          前回の続きが見つからなかったので、新規セッションで開始しました。
        </div>
      )}
      {userMsg && (
        <div className="flex flex-col items-end gap-0.5">
          <div className="max-w-[78%] rounded-[6px] bg-accent px-3.5 py-2 text-[13px] leading-relaxed text-bg-card shadow-card whitespace-pre-wrap">
            {userMsg}
          </div>
          {sentAt && (
            <span className="px-0.5 font-mono text-[9px] tabular-nums text-ink-faint">
              {sentAt}
            </span>
          )}
        </div>
      )}

      <div className="flex justify-start">
        <div className="w-full max-w-[88%] rounded-[6px] border border-line bg-bg-card px-3.5 py-2.5 shadow-card">
          <div className="mb-1.5 flex items-center gap-1.5 label-cap text-ink-faint">
            <span className={['inline-flex items-center', RUN_KIND[kind].text].join(' ')}>
              <RunGlyph kind={kind} size={11} />
            </span>
            <span className={RUN_KIND[kind].text}>{RUN_KIND[kind].label}</span>
            <span>·</span>
            <span className="tabular-nums">{elapsed}</span>
            {e.autoRound != null && (
              <>
                <span>·</span>
                <span className="text-azure">auto {e.autoRound}/{AUTO_MAX_ROUNDS}</span>
              </>
            )}
            {e.permissionMode === 'plan' && (
              <>
                <span>·</span>
                <span className="flex items-center gap-0.5 text-moss">
                  <ClipboardList size={9} /> plan
                </span>
              </>
            )}
            {(finishedAt || sentAt) && (
              <span className="ml-auto font-mono text-[9px] normal-case tracking-normal text-ink-faint tabular-nums">
                {finishedAt || sentAt}
              </span>
            )}
          </div>

          {live ? (
            <div className="space-y-1.5">
              {latestAction && (
                <div className="flex items-start gap-1.5">
                  <Wrench
                    size={11}
                    strokeWidth={2.25}
                    className="mt-[4px] shrink-0 text-azure"
                  />
                  <div className="min-w-0 flex-1 font-mono text-[11.5px] leading-snug">
                    <span className="text-azure">{latestAction.tool}</span>
                    {latestAction.detail ? (
                      <span className="ml-1.5 text-ink-muted">
                        {latestAction.detail}
                      </span>
                    ) : null}
                  </div>
                </div>
              )}
              <div className="flex items-start gap-2 text-ink-muted">
                <Loader2 size={12} className="mt-[5px] shrink-0 animate-spin text-azure" />
                <div className="min-w-0 flex-1">
                  {latestThought ? (
                    <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink line-clamp-6 transition-opacity duration-200">
                      {latestThought}
                    </p>
                  ) : (
                    <p className="text-[12px]">考えています…</p>
                  )}
                </div>
              </div>
            </div>
          ) : pr ? (
            <div className="space-y-2">
              {pr.question && (
                <div className="rounded-[4px] border border-azure bg-azure-soft px-2.5 py-2">
                  <div className="mb-1 flex items-center gap-1.5 label-cap text-azure">
                    <HelpCircle size={11} strokeWidth={2.25} />
                    <span>返事待ち</span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-ink whitespace-pre-wrap">
                    {pr.question}
                  </p>
                </div>
              )}
              {pr.summary && (
                <p className="text-[13px] leading-relaxed text-ink whitespace-pre-wrap">
                  {pr.summary}
                </p>
              )}
              {pr.blockers && (
                <p className="flex items-start gap-1.5 text-[12px] leading-snug text-ochre">
                  <Flag size={12} className="mt-[3px] shrink-0" strokeWidth={2.25} />
                  <span>{pr.blockers}</span>
                </p>
              )}
              <RecapList label="やったこと" items={pr.completed} dot="bg-moss" labelClass="text-moss" />
              <RecapList label="判断" items={pr.decisions} dot="bg-azure" labelClass="text-azure" />
              <RecapList label="次の一手" items={pr.followups} dot="bg-ink-faint" labelClass="text-ink-muted" />
              {!pr.summary &&
                pr.completed.length === 0 &&
                !pr.blockers &&
                !pr.decisions?.length &&
                !pr.followups?.length && (
                <p className="text-[12px] italic text-ink-faint">
                  {kind === 'overloaded'
                    ? 'Claude API が混雑しています（Anthropic 側の一時障害・HTTP 529）。少し待ってから同じチャットで再送してください。'
                    : kind === 'error'
                      ? '実行が失敗しました。'
                      : kind === 'cancelled'
                        ? 'キャンセルされました。'
                        : '結果のサマリは取得できませんでした。'}
                </p>
              )}
            </div>
          ) : kind === 'overloaded' ? (
            <div className="rounded-[4px] border border-ochre bg-ochre-soft px-3 py-2.5">
              <div className="mb-1 flex items-center gap-1.5 label-cap text-ochre">
                <AlertCircle size={11} strokeWidth={2.25} />
                <span>API 混雑</span>
              </div>
              <p className="text-[12.5px] leading-relaxed text-ink">
                Claude API が一時的に過負荷でした（HTTP 529 / Anthropic 側）。OPEN GROUND やプロンプトの問題ではないので、少し待ってから同じチャットでもう一度送れば続きから再試行できます。混雑が続く場合は
                <a
                  href="https://status.claude.com"
                  target="_blank"
                  rel="noreferrer"
                  className="mx-0.5 underline decoration-ochre/40 underline-offset-2 hover:decoration-ochre"
                >
                  status.claude.com
                </a>
                を確認してください。
              </p>
            </div>
          ) : (
            <p className="text-[12px] italic text-ink-faint">
              {kind === 'error'
                ? '実行が失敗しました。'
                : kind === 'cancelled'
                  ? 'キャンセルされました。'
                  : /(?:HOVE_RESULT|PMMAP_RESULT):/.test(e.log ?? '')
                    ? '結果の読み取りに失敗しました。ログを開いて内容を確認してください。'
                    : '出力がありません。'}
            </p>
          )}

          {(e.log || onPasteToCanvas) && (
            <>
              <div className="mt-2 flex items-center justify-end gap-1">
                {!live && (pr?.summary || pr?.question) && (
                  <CopyButton
                    text={pr?.question || pr?.summary || ''}
                    label="返事をコピー"
                    title="Claude の返事本文をクリップボードへ"
                  />
                )}
                {onPasteToCanvas && !live && (pr?.summary || pr?.question) && (
                  <button
                    onClick={() => onPasteToCanvas(pr?.question || pr?.summary || '')}
                    className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 label-cap text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink"
                    title="このメッセージをキャンバスにスティッキーとして貼る"
                  >
                    <Sparkles size={10} strokeWidth={2} /> キャンバスに貼る
                  </button>
                )}
                {e.log && (
                  <CopyButton
                    text={e.log}
                    label="ログをコピー"
                    title="このラウンドのログ全文をクリップボードへ"
                  />
                )}
                {e.log && (
                  <button
                    onClick={() => setShowLog((v) => !v)}
                    className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 label-cap text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink"
                    title={showLog ? 'ログを閉じる' : 'ログを開く'}
                  >
                    {showLog ? (
                      <>
                        <ChevronUp size={10} strokeWidth={2} /> ログを閉じる
                      </>
                    ) : (
                      <>
                        <ChevronDown size={10} strokeWidth={2} /> ログを開く
                      </>
                    )}
                  </button>
                )}
              </div>
              {showLog && (
                <pre className="mt-1.5 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-[3px] bg-bg px-2.5 py-2 font-mono text-[11px] leading-[1.55] text-ink-muted">
                  {e.log}
                </pre>
              )}
            </>
          )}
        </div>
      </div>

      {!live && e.git && (e.git.commits.length > 0 || e.git.changedFiles.length > 0) && (
        <div className="space-y-0.5 px-1 font-mono text-[10px] text-ink-subtle">
          {e.git.commits.map((c, i) => (
            <div key={i} className="truncate text-ink-muted">{c}</div>
          ))}
          {e.git.changedFiles.length > 0 && (
            <div className="text-ink-faint">{e.git.changedFiles.length} file(s) changed</div>
          )}
        </div>
      )}
    </div>
  )
}

// Phase 5.A — THREAD fallback when no live/disk run-session exists for a task
// but the task carries a persisted `latestRun`. Renders the same response-card
// shell RoundView uses (status glyph + summary/blockers/question) so the chat
// pane never drops to an empty surface after the in-memory sessions age out,
// plus a "過去ログを見る" button that lazily streams the full claude transcript
// back via the Phase 4 GET /api/run/transcript API.
const PastRunFallback = ({
  summary,
  transcriptRef,
  projectPath,
}: {
  summary: NonNullable<ProjectTask['latestRun']>
  transcriptRef?: ProjectTask['transcriptRef']
  projectPath: string
}) => {
  const kind = summary.kind
  const finishedAt = summary.finishedAt ? fmtChatTime(summary.finishedAt) : ''
  // The full transcript is opt-in: a finished claude session can be thousands
  // of JSONL events, so we only fetch on the user's request (and only when we
  // hold a transcriptRef pointing at the on-disk JSONL).
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lines, setLines] = useState<Array<{ index: number; type: string; text: string | null; raw?: boolean }> | null>(null)

  const loadTranscript = async () => {
    if (!transcriptRef) return
    if (lines) {
      setOpen(v => !v)
      return
    }
    setOpen(true)
    setLoading(true)
    setError(null)
    try {
      const res = await api.api.run.transcript.$get({
        query: {
          sessionId: transcriptRef.sessionId,
          path: projectPath,
          // The transcript lives under where claude actually ran (worktree
          // path for worktree runs); transcriptRef.cwd carries that.
          ...(transcriptRef.cwd && transcriptRef.cwd !== projectPath
            ? { cwd: transcriptRef.cwd }
            : {}),
        },
      })
      if (!res.ok) {
        setError(
          res.status === 404
            ? '過去ログが見つかりませんでした（worktree が削除済みなど）。'
            : 'ログの読み込みに失敗しました。',
        )
        return
      }
      const page = (await res.json()) as {
        lines: Array<{ index: number; type: string; text: string | null; raw?: boolean }>
      }
      setLines(page.lines)
    } catch {
      setError('ネットワークエラーでログを読み込めませんでした。')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-start">
        <div className="w-full max-w-[88%] rounded-[6px] border border-line bg-bg-card px-3.5 py-2.5 shadow-card">
          <div className="mb-1.5 flex items-center gap-1.5 label-cap text-ink-faint">
            <span className={['inline-flex items-center', RUN_KIND[kind].text].join(' ')}>
              <RunGlyph kind={kind} size={11} />
            </span>
            <span className={RUN_KIND[kind].text}>{RUN_KIND[kind].label}</span>
            <span className="ml-2 normal-case tracking-normal text-ink-faint">
              過去の実行（サマリのみ）
            </span>
            {finishedAt && (
              <span className="ml-auto font-mono text-[9px] normal-case tracking-normal text-ink-faint tabular-nums">
                {finishedAt}
              </span>
            )}
          </div>

          <div className="space-y-2">
            {summary.question && (
              <div className="rounded-[4px] border border-azure bg-azure-soft px-2.5 py-2">
                <div className="mb-1 flex items-center gap-1.5 label-cap text-azure">
                  <HelpCircle size={11} strokeWidth={2.25} />
                  <span>返事待ち</span>
                </div>
                <p className="text-[13px] leading-relaxed text-ink whitespace-pre-wrap">
                  {summary.question}
                </p>
              </div>
            )}
            {summary.summary && (
              <p className="text-[13px] leading-relaxed text-ink whitespace-pre-wrap">
                {summary.summary}
              </p>
            )}
            {summary.blockers && (
              <p className="flex items-start gap-1.5 text-[12px] leading-snug text-ochre">
                <Flag size={12} className="mt-[3px] shrink-0" strokeWidth={2.25} />
                <span>{summary.blockers}</span>
              </p>
            )}
            <RecapList label="判断" items={summary.decisions} dot="bg-azure" labelClass="text-azure" />
            <RecapList label="次の一手" items={summary.followups} dot="bg-ink-faint" labelClass="text-ink-muted" />
            {!summary.summary &&
              !summary.blockers &&
              !summary.question &&
              !summary.decisions?.length &&
              !summary.followups?.length && (
                <p className="text-[12px] italic text-ink-faint">
                  この実行のサマリは保存されていません。
                </p>
              )}
          </div>

          {transcriptRef && (
            <>
              <div className="mt-2 flex items-center justify-end gap-1">
                <button
                  onClick={loadTranscript}
                  disabled={loading}
                  className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 label-cap text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink disabled:opacity-40"
                  title={open ? '過去ログを閉じる' : 'この実行の全文ログを開く'}
                >
                  {loading ? (
                    <>
                      <Loader2 size={10} className="animate-spin" /> 読み込み中…
                    </>
                  ) : open && lines ? (
                    <>
                      <ChevronUp size={10} strokeWidth={2} /> 過去ログを閉じる
                    </>
                  ) : (
                    <>
                      <ChevronDown size={10} strokeWidth={2} /> 過去ログを見る
                    </>
                  )}
                </button>
              </div>
              {error && (
                <p className="mt-1 text-right text-[10px] text-accent">{error}</p>
              )}
              {open && lines && (
                <pre className="mt-1.5 max-h-96 overflow-y-auto whitespace-pre-wrap rounded-[3px] bg-bg px-2.5 py-2 font-mono text-[11px] leading-[1.55] text-ink-muted">
                  {lines
                    .map(l => l.text)
                    .filter((t): t is string => !!t)
                    .join('\n')}
                </pre>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// The run thread for a task — its meta controls, the latest run's result, and
// a composer to continue (resume) the Claude session with the next instruction.
export const TaskThread = ({
  task,
  projectPath,
  run,
  allRuns,
  onRun,
  onEnqueue,
  onUpdate,
  onCancel,
  onDelete,
  variant = 'inline',
  draft: controlledDraft,
  onDraftChange,
  onPasteToCanvas,
  enableSkillPicker = false,
  paneScrollRef,
  onPaneScroll,
  paneContentClassName,
  paneScrollOverlay,
}: {
  task: ProjectTask
  /** Project root — needed by the pane composer to render staged image thumbnails. */
  projectPath: string
  run?: RunSession
  /** Pane mode: every session for this task, oldest first (chat history). */
  allRuns?: RunSession[]
  onRun: (opts?: RunTaskOpts) => void
  /** When set, submitting while a run is live queues the instruction for
   *  dispatch after that run finishes (instead of being a no-op). The parent
   *  resolves the live session id, so this callback only carries text + opts. */
  onEnqueue?: (
    instruction: string,
    opts: {
      permissionMode?: PermissionMode
      skill?: string | null
      canvasContext?: { canvasId: string }
    },
  ) => void
  onUpdate: (patch: Partial<ProjectTask>) => void
  onCancel: () => void
  onDelete: () => void
  /** 'inline' under a task row, or 'pane' filling the workspace detail column. */
  variant?: 'inline' | 'pane'
  /** Controlled composer draft. When provided, text + staged images live on
   *  the parent so switching tasks doesn't bleed one task's half-written reply
   *  into another's. Inline mode leaves this undefined and falls back to local
   *  state. */
  draft?: ComposerDraft
  onDraftChange?: (updater: (prev: ComposerDraft) => ComposerDraft) => void
  /** Canvas-only: surfaces a "Paste to canvas" affordance inside each round. */
  onPasteToCanvas?: (text: string) => void
  /** Canvas-only: render the Claude Code skill picker above the composer.
   *  Selection is stored on `task.activeSkill` and applied to every send. */
  enableSkillPicker?: boolean
  /** Pane mode: parent-owned ref / scroll handler attached to the inner
   *  messages scroll container. Lets the parent pin-to-bottom on chat switch
   *  or render a "scroll to bottom" affordance without owning the scroll DOM
   *  itself. The composer below stays pinned regardless. */
  paneScrollRef?: React.Ref<HTMLDivElement>
  onPaneScroll?: (e: React.UIEvent<HTMLDivElement>) => void
  /** Pane mode: padding/centering applied to both the scrollable message
   *  column and the pinned composer column so they line up visually. */
  paneContentClassName?: string
  /** Pane mode: rendered inside the scrollable message area as a sticky
   *  overlay (e.g. a floating "scroll to bottom" affordance). Sits above
   *  the pinned composer because it lives inside the scroll viewport. */
  paneScrollOverlay?: React.ReactNode
}) => {
  const isControlled = controlledDraft != null && onDraftChange != null
  const [localDraft, setLocalDraft] = useState<ComposerDraft>({ text: '', images: [] })
  const draft = isControlled ? controlledDraft! : localDraft
  const composer = draft.text
  const pendingImages = draft.images
  const updateDraft = useCallback(
    (updater: (prev: ComposerDraft) => ComposerDraft) => {
      if (isControlled) onDraftChange!(updater)
      else setLocalDraft(updater)
    },
    [isControlled, onDraftChange],
  )
  const setComposer = useCallback(
    (next: string | ((prev: string) => string)) => {
      updateDraft(prev => ({
        ...prev,
        text: typeof next === 'function' ? next(prev.text) : next,
      }))
    },
    [updateDraft],
  )
  const setPendingImages = useCallback(
    (next: TaskImage[] | ((prev: TaskImage[]) => TaskImage[])) => {
      updateDraft(prev => ({
        ...prev,
        images: typeof next === 'function' ? next(prev.images) : next,
      }))
    },
    [updateDraft],
  )

  // Plan mode → Claude can read and think but won't edit files. Mutually
  // exclusive with auto (a plan never reports the task complete).
  const [planMode, setPlanMode] = useState(false)
  const [logExpanded, setLogExpanded] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // Clipboard pastes stage here so the user sees a thumbnail under the
  // composer (matching the new-chat composer). On submit they're attached to
  // the task and their on-disk paths are appended to the instruction so the
  // resumed Claude session can Read them. Same flow in inline and pane modes
  // so "paste a screenshot, continue the chat" feels consistent everywhere.
  const [pendingUploading, setPendingUploading] = useState(0)
  const [pendingError, setPendingError] = useState<string | null>(null)
  const pendingRef = useRef<TaskImage[]>(pendingImages)
  pendingRef.current = pendingImages

  // Drop any staged-but-unsent images when the composer unmounts. In
  // controlled mode the draft outlives this component (it's owned by the
  // parent so a chat switch preserves it), so the parent handles cleanup —
  // running it here would trash the draft on every switch.
  useEffect(() => {
    if (isControlled) return
    return () => {
      for (const im of pendingRef.current) {
        void deleteTaskImage(projectPath, im.id)
      }
    }
  }, [projectPath, isControlled])

  const stagePastedImages = useCallback(
    async (files: File[]) => {
      setPendingError(null)
      setPendingUploading(n => n + files.length)
      const { added, error } = await uploadTaskImages(projectPath, files)
      setPendingUploading(n => n - files.length)
      if (error) setPendingError(error)
      if (added.length) setPendingImages(prev => [...prev, ...added])
    },
    [projectPath],
  )

  const handleComposerPaste = (ev: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromClipboard(ev.clipboardData)
    if (files.length === 0) return
    ev.preventDefault()
    stagePastedImages(files)
  }

  // Drain staged screenshots into (a) an instruction patch so the resumed
  // Claude session sees the file paths and can Read them, and (b) the task's
  // image strip so the references survive across reloads. Clear local state
  // BEFORE the unmount cleanup could fire — pendingRef is read in the
  // cleanup, so emptying it now keeps the attached files alive even if the
  // caller's `onRun` re-renders the tree.
  const drainStagedIntoInstruction = (text: string): string => {
    const staged = pendingImages
    if (staged.length === 0) return text
    setPendingImages([])
    pendingRef.current = []
    onUpdate({ images: [...(task.images ?? []), ...staged] })
    const pathsBlock =
      '\n\n[添付スクリーンショット — Read で読んでください]\n' +
      staged.map(im => `- ${taskImageRelPath(im)}`).join('\n')
    return `${text}${pathsBlock}`.trim()
  }

  const stagedThumbs = (pendingImages.length > 0 || pendingUploading > 0) && (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {pendingImages.map(im => (
        <TaskImageThumb
          key={im.id}
          image={im}
          projectPath={projectPath}
          size={48}
          onRemove={() => {
            setPendingImages(prev => prev.filter(x => x.id !== im.id))
            void deleteTaskImage(projectPath, im.id)
          }}
        />
      ))}
      {Array.from({ length: pendingUploading }).map((_, i) => (
        <div
          key={i}
          className="h-12 w-12 animate-pulse rounded-[2px] border border-line-soft bg-bg-inset"
        />
      ))}
    </div>
  )
  const entry = run?.entries[0]
  const kind = entry ? runKind(entry) : undefined
  const live = kind === 'running' || kind === 'queued'
  const pr = entry?.parsedResult
  const canResume = !!entry?.agentSessionId && !live
  // Filter out the OPENGROUND_RESULT marker line (and the legacy HOVE_/PMMAP_
  // variants) — that line is just the machine-readable envelope which we
  // already parse and render structured above the log, so showing the raw
  // JSON twice is pure noise. Keep every other line of the assistant's
  // narrative, including any "---" divider it draws before the marker.
  const logLines = useMemo(
    () =>
      entry
        ? entry.log
            .trimEnd()
            .split('\n')
            .filter(Boolean)
            .filter((l) => !/^(?:OPENGROUND_RESULT|HOVE_RESULT|PMMAP_RESULT):/.test(l.trim()))
        : [],
    [entry],
  )

  const submit = () => {
    if (live) return
    const instruction = drainStagedIntoInstruction(composer.trim())
    onRun({
      instruction: instruction || undefined,
      resumeFrom: canResume ? entry?.agentSessionId : undefined,
      auto: false,
      permissionMode: planMode ? 'plan' : undefined,
    })
    setComposer('')
    if (taRef.current) taRef.current.style.height = 'auto'
  }

  // Pane mode: full chat-style transcript over the workspace detail column.
  // The inline mode below stays as the compact under-row drawer.
  if (variant === 'pane') {
    const runs = allRuns ?? []
    const latestSession = runs[runs.length - 1]
    const latestEntry = latestSession?.entries[0]
    const latestLive = latestEntry ? isLive(latestEntry.status) : false
    // Phase 5.A — no live/disk session for this task, but it carries a
    // persisted latestRun: render the summary + 過去ログ fallback instead of an
    // empty pane, and let the composer resume the persisted agent session.
    const showPastFallback = runs.length === 0 && !!task.latestRun
    const paneCanResume = latestEntry
      ? !!latestEntry.agentSessionId && !latestLive
      : showPastFallback && !!task.agentSessionId
    const resumeSessionId = latestEntry?.agentSessionId ?? task.agentSessionId
    const awaitingReply = !!latestEntry?.parsedResult?.question && !latestLive
    const conflictKind: 'conflict' | 'failed-fatal' | null =
      !latestLive && latestEntry?.mergeStatus === 'conflict'
        ? 'conflict'
        : !latestLive && latestEntry?.mergeStatus === 'failed-fatal'
          ? 'failed-fatal'
          : null
    const hasConflict = !!conflictKind

    const paneSubmit = () => {
      const trimmed = composer.trim()
      // While a run is live, the user's submission is queued for after it
      // finishes (provided the parent wired `onEnqueue`). Lets them keep
      // typing the next instruction without waiting on the spinner.
      if (latestLive) {
        if (!onEnqueue || !trimmed) return
        const instruction = drainStagedIntoInstruction(trimmed)
        if (!instruction) return
        onEnqueue(instruction, {
          permissionMode: planMode ? 'plan' : undefined,
          skill: enableSkillPicker ? task.activeSkill ?? null : null,
        })
        setComposer('')
        if (taRef.current) taRef.current.style.height = 'auto'
        return
      }
      const instruction = drainStagedIntoInstruction(trimmed)
      onRun({
        instruction: instruction || undefined,
        resumeFrom: paneCanResume ? resumeSessionId : undefined,
        auto: false,
        permissionMode: planMode ? 'plan' : undefined,
        skill: enableSkillPicker ? task.activeSkill ?? null : null,
      })
      setComposer('')
      if (taRef.current) taRef.current.style.height = 'auto'
    }

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div
          ref={paneScrollRef}
          onScroll={onPaneScroll}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className={paneContentClassName}>
            <div className="space-y-5">
              {runs.map((session, i) => (
                <RoundView
                  key={session.id}
                  session={session}
                  isFirst={i === 0}
                  onFollowupClick={setComposer}
                  onPasteToCanvas={onPasteToCanvas}
                />
              ))}

              {showPastFallback && task.latestRun && (
                <PastRunFallback
                  summary={task.latestRun}
                  transcriptRef={task.transcriptRef}
                  projectPath={projectPath}
                />
              )}

              {(runs.length > 0 || showPastFallback) && (
                <div className="border-t border-line-soft pt-2" />
              )}

              {hasConflict && conflictKind && latestSession && latestEntry && (
                <ResolveConflictBtn
                  sessionId={latestSession.id}
                  projectId={latestEntry.projectId}
                  mergeStatus={conflictKind}
                />
              )}

              <div className="flex items-center justify-end gap-2">
                {latestLive && (
                  <Btn variant="ghost" size="xs" onClick={onCancel} title="Cancel this run">
                    <Square size={8} fill="currentColor" /> Cancel
                  </Btn>
                )}
                <Btn variant="icon" size="sm" danger onClick={onDelete} title="Delete task">
                  <Trash2 size={13} />
                </Btn>
              </div>
            </div>
          </div>
          {paneScrollOverlay && (
            <div className="pointer-events-none sticky bottom-3 z-10 flex justify-end px-4">
              <div className="pointer-events-auto">{paneScrollOverlay}</div>
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-line-soft bg-bg-card">
          <div className={paneContentClassName}>
            <div className="space-y-2">
              {enableSkillPicker && (
                <SkillPicker
                  projectPath={projectPath}
                  value={task.activeSkill ?? null}
                  onChange={(next) => onUpdate({ activeSkill: next })}
                />
              )}
              <div className="rounded-[2px] border border-line bg-bg-card px-3 py-2 transition-colors focus-within:border-accent">
                <textarea
                  ref={taRef}
                  value={composer}
                  rows={2}
                  onChange={e => {
                    setComposer(e.target.value)
                    autoGrowArea(e.target)
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault()
                      paneSubmit()
                    }
                  }}
                  onPaste={handleComposerPaste}
                  placeholder={
                    awaitingReply
                      ? 'Claude からの質問に返事を書く… (画像ペースト可・⌘↵ で送信)'
                      : paneCanResume
                        ? '続きの指示を入力… (画像ペースト可・⌘↵ で送信)'
                        : runs.length > 0
                          ? '指示を入力して再実行… (画像ペースト可・⌘↵ で送信)'
                          : '追加の指示（任意）… (画像ペースト可・⌘↵ で送信)'
                  }
                  className="block w-full resize-none bg-transparent text-[13px] leading-snug text-ink placeholder:text-ink-faint focus:outline-none"
                />
                {stagedThumbs}
              </div>
              {pendingError && (
                <p className="text-[10px] text-accent">{pendingError}</p>
              )}
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setPlanMode(v => !v)}
                  title="プランモード — Claude は読み取り＆思考のみ。ファイルは編集しません。"
                  className={[
                    'flex shrink-0 items-center gap-1 rounded-[2px] border px-2 py-1.5 label-cap transition-colors',
                    planMode
                      ? 'border-moss bg-moss/10 text-moss'
                      : 'border-line bg-bg-card text-ink-muted hover:border-moss hover:text-moss',
                  ].join(' ')}
                >
                  <ClipboardList size={9} /> プラン
                </button>
                <Btn
                  variant="primary"
                  size="sm"
                  onClick={paneSubmit}
                  // No longer disabled while live — if onEnqueue is wired
                  // (Chats tab), pressing Send queues the message for after
                  // the current run. Falls back to disabling only when the
                  // parent didn't wire the enqueue path.
                  disabled={latestLive && !onEnqueue}
                  className="shrink-0"
                >
                  {latestLive && onEnqueue ? (
                    <>
                      <Clock size={10} /> あとで送る
                    </>
                  ) : planMode ? (
                    <>
                      <ClipboardList size={10} /> Plan
                    </>
                  ) : paneCanResume ? (
                    <>
                      <RotateCw size={10} /> Continue
                    </>
                  ) : (
                    <>
                      <Play size={9} fill="currentColor" /> Run
                    </>
                  )}
                </Btn>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Inline mode — compact drawer under a task row in the sidebar list.
  return (
    <div className="mt-1.5 ml-6 space-y-2 rounded-[2px] border border-line-soft bg-bg-elevated p-2.5">
      {/* Run status carries "done-ness" now — no separate user-managed
          done flag. The toolbar just exposes Cancel (when live) + Delete. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-b border-line-soft pb-2.5">
        {live && (
          <Btn variant="ghost" size="xs" onClick={onCancel} title="Cancel this run">
            <Square size={8} fill="currentColor" /> Cancel
          </Btn>
        )}
        <Btn variant="icon" size="sm" danger onClick={onDelete} title="Delete task">
          <Trash2 size={13} />
        </Btn>
      </div>
      {(entry?.mergeStatus === 'conflict' || entry?.mergeStatus === 'failed-fatal') &&
        !live &&
        run && (
          <ResolveConflictBtn
            sessionId={run.id}
            projectId={entry.projectId}
            mergeStatus={entry.mergeStatus}
          />
        )}

      {entry?.autoRound != null && (
        <p className="label-cap text-azure">
          自動ループ {entry.autoRound}/{AUTO_MAX_ROUNDS}
        </p>
      )}
      {entry && (live ? logLines.length > 0 : entry.log.length > 0) && (
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="label-cap text-ink-faint">
              {live ? 'Live log' : 'Run log'} · {logLines.length} lines
            </span>
            <div className="flex items-center gap-0.5">
              <CopyButton
                text={entry.log}
                label="コピー"
                title="このラウンドのログ全文をクリップボードへ"
              />
              <button
                onClick={() => setLogExpanded((v) => !v)}
                title={logExpanded ? 'ログを折りたたむ' : 'ログを開く'}
                className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 label-cap text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink"
              >
                {logExpanded ? (
                  <>
                    <ChevronUp size={10} strokeWidth={2} /> 折りたたむ
                  </>
                ) : (
                  <>
                    <ChevronDown size={10} strokeWidth={2} /> 全部見る
                  </>
                )}
              </button>
            </div>
          </div>
          <pre
            className={[
              'overflow-y-auto whitespace-pre-wrap rounded-[2px] bg-bg px-2 py-1.5 text-[10.5px] font-mono leading-relaxed text-ink-muted',
              logExpanded ? 'max-h-96' : 'max-h-36',
            ].join(' ')}
          >
            {logExpanded ? logLines.join('\n') : logLines.slice(-40).join('\n')}
          </pre>
        </div>
      )}
      {entry && !live && pr?.question && (
        <div className="rounded-[4px] border border-azure bg-azure-soft px-2 py-1.5">
          <div className="mb-0.5 flex items-center gap-1 label-cap text-azure">
            <HelpCircle size={10} strokeWidth={2.25} />
            <span>返事待ち</span>
          </div>
          <p className="text-[12px] leading-snug text-ink whitespace-pre-wrap">
            {pr.question}
          </p>
        </div>
      )}
      {entry && !live && pr?.summary && (
        <p className="text-[12px] leading-snug text-ink-muted">{pr.summary}</p>
      )}
      {entry && !live && pr?.blockers && (
        <p className="flex gap-1.5 text-[12px] leading-snug text-ochre">
          <Flag size={12} className="mt-[2px] shrink-0" strokeWidth={2.25} />
          <span>{pr.blockers}</span>
        </p>
      )}
      <div className="flex items-end gap-2">
        <div className="flex-1 rounded-[2px] border border-line bg-bg-card px-2 py-1.5 transition-colors focus-within:border-accent">
          <textarea
            ref={taRef}
            value={composer}
            rows={1}
            onChange={e => {
              setComposer(e.target.value)
              autoGrowArea(e.target)
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                submit()
              }
            }}
            onPaste={handleComposerPaste}
            title="Paste a clipboard image to attach it — sent to Claude on ⌘↵"
            placeholder={
              !live && pr?.question
                ? 'Claude からの質問に返事を書く… (画像ペースト可・⌘↵)'
                : canResume
                  ? '続きの指示を入力… (画像ペースト可・⌘↵)'
                  : entry
                    ? '指示を入力して再実行… (画像ペースト可・⌘↵)'
                    : '追加の指示（任意）… (画像ペースト可・⌘↵)'
            }
            className="block w-full resize-none bg-transparent text-[12px] leading-snug text-ink placeholder:text-ink-faint focus:outline-none"
          />
          {stagedThumbs}
        </div>
        <button
          onClick={() => setPlanMode(v => !v)}
          title="プランモード — Claude は読み取り＆思考のみ。ファイルは編集しません。"
          className={[
            'flex shrink-0 items-center gap-1 rounded-[2px] border px-2 py-1.5 label-cap transition-colors',
            planMode
              ? 'border-moss bg-moss/10 text-moss'
              : 'border-line bg-bg-card text-ink-muted hover:border-moss hover:text-moss',
          ].join(' ')}
        >
          <ClipboardList size={9} /> プラン
        </button>
        <Btn
          variant="primary"
          size="sm"
          onClick={submit}
          disabled={live}
          className="shrink-0"
        >
          {planMode ? (
            <>
              <ClipboardList size={10} /> Plan
            </>
          ) : canResume ? (
            <>
              <RotateCw size={10} /> Continue
            </>
          ) : (
            <>
              <Play size={9} fill="currentColor" /> Run
            </>
          )}
        </Btn>
      </div>
      {pendingError && (
        <p className="text-[10px] text-accent">{pendingError}</p>
      )}
      {live && (
        <p className="text-[10px] text-ink-subtle">
          Running — wait for it to finish to continue.
        </p>
      )}
    </div>
  )
}

// ---------- Description ----------

// ---------- Tasks ----------

const TasksSection = ({
  data,
  projectPath,
  onChange,
  taskRuns,
  onRunTask,
  onCancelTask,
  selectable,
  selectedTaskId,
  onSelectTask,
  onStartNew,
}: {
  data: ProjectData
  projectPath: string
  onChange: (d: ProjectData) => void
  taskRuns: Map<string, RunSession>
  onRunTask: (task: ProjectTask, opts?: RunTaskOpts) => void
  onCancelTask: (taskId: string) => void
  selectable?: boolean
  selectedTaskId?: string | null
  onSelectTask?: (taskId: string) => void
  /** Workspace mode only: clicked the "+ New task" button — open the composer
   *  in the right pane. The draft input is no longer shown in this sidebar. */
  onStartNew?: () => void
}) => {
  const [draft, setDraft] = useState('')
  const draftRef = useRef<HTMLTextAreaElement>(null)
  // Clipboard-image paste on the "add task" field: count of in-flight uploads
  // and the last error, so the field can show progress before the task exists.
  const [draftUploading, setDraftUploading] = useState(0)
  const [draftImgError, setDraftImgError] = useState<string | null>(null)
  // Pasted images stay attached to the in-flight composer instead of spawning
  // their own task, so a screenshot + caption end up on a single task.
  const [draftImages, setDraftImages] = useState<TaskImage[]>([])

  const addTask = (opts?: { run?: boolean }) => {
    const trimmed = draft.trim()
    if (!trimmed && draftImages.length === 0) return
    const task: ProjectTask = {
      id: newId(),
      title: trimmed || 'スクリーンショット',
      done: false,
      milestoneId: null,
      createdAt: new Date().toISOString(),
      ...(draftImages.length > 0 ? { images: draftImages } : {}),
    }
    onChange({ ...data, tasks: [task, ...data.tasks] })
    setDraft('')
    setDraftImages([])
    if (draftRef.current) draftRef.current.style.height = 'auto'
    if (opts?.run) onRunTask(task)
  }

  // Pasting a screenshot stages it on the composer; the actual task isn't
  // created until ⌘↵, so any text typed alongside lands on the same task.
  const handleDraftPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromClipboard(e.clipboardData)
    if (files.length === 0) return // plain text — let the textarea paste it
    e.preventDefault()
    setDraftImgError(null)
    setDraftUploading(n => n + files.length)
    const { added, error } = await uploadTaskImages(projectPath, files)
    setDraftUploading(n => n - files.length)
    if (error) setDraftImgError(error)
    if (added.length === 0) return
    setDraftImages(prev => [...prev, ...added])
    draftRef.current?.focus()
  }

  const updateTask = (id: string, patch: Partial<ProjectTask>) => {
    onChange({
      ...data,
      tasks: data.tasks.map(t => (t.id === id ? { ...t, ...patch } : t)),
    })
  }

  const deleteTask = (id: string) => {
    onChange({ ...data, tasks: data.tasks.filter(t => t.id !== id) })
  }

  const openTasks = data.tasks.filter(t => !t.done)
  const doneTasks = data.tasks.filter(t => t.done)

  // Drag-to-reorder open tasks. dragFrom is the index in openTasks of the row
  // being dragged; dropAt is the insertion index (0..openTasks.length).
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const reorderOpen = (from: number, to: number) => {
    // Insertion model: `to` is the slot the moved row should occupy. Dropping
    // immediately above/below itself is a no-op.
    if (from === to || from + 1 === to) return
    const next = [...openTasks]
    const [moved] = next.splice(from, 1)
    const insert = to > from ? to - 1 : to
    next.splice(insert, 0, moved)
    // Done tasks keep their relative order; they all sit after the open list
    // — display-wise they live in the Archive section anyway.
    onChange({ ...data, tasks: [...next, ...doneTasks] })
  }
  const openCount = openTasks.length
  const [archiveOpen, setArchiveOpen] = useState(false)

  // Online/offline gate for the "run all" action — POSTing /api/run needs a
  // working fetch, so the button is disabled (and runAllOpen is a no-op) when
  // the browser reports offline.
  const online = useOnlineStatus()

  // Chats eligible for "run all": open (not done) and not already running or
  // queued. Same predicate the button's disabled state uses, so what the count
  // promises is exactly what the click fires. Each run is fired through the
  // existing per-chat trigger (onRunTask) — the server-side gate
  // (projectRunGate) then bounds how many actually run at once per project;
  // the rest queue and start as slots free.
  const runnableOpen = useMemo(
    () => openTasks.filter(t => !isLive(taskRuns.get(t.id)?.entries[0]?.status)),
    [openTasks, taskRuns],
  )
  const runAllOpen = () => {
    if (!online) return
    for (const t of runnableOpen) onRunTask(t)
  }
  const canRunAll = online && runnableOpen.length > 0

  // Workspace mode flattens open + done into a single chat-style list, sorted
  // by recent activity (last run, then createdAt). Running tasks float to the
  // top; quiet finished ones drift down. The sidebar mode keeps the old
  // open/Archive split because its narrower layout works better that way.
  const sortedAll = useMemo(() => {
    const activityOf = (t: ProjectTask) => {
      const run = taskRuns.get(t.id)
      const e = run?.entries[0]
      const live = e && isLive(e.status)
      const stamp = e?.finishedAt ?? e?.startedAt ?? t.createdAt ?? ''
      return { live: !!live, stamp }
    }
    return [...data.tasks].sort((a, b) => {
      const sa = activityOf(a)
      const sb = activityOf(b)
      if (sa.live !== sb.live) return sa.live ? -1 : 1
      return sb.stamp.localeCompare(sa.stamp)
    })
  }, [data.tasks, taskRuns])

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <SectionLabel count={data.tasks.length}>
          {selectable ? 'Chats' : `Chats · ${openCount} open`}
        </SectionLabel>
        {!selectable && openCount > 0 && (
          <button
            onClick={runAllOpen}
            disabled={!canRunAll}
            title={
              !online
                ? 'オフラインのため実行できません'
                : runnableOpen.length === 0
                  ? '実行待ちのチャットはありません'
                  : `実行待ちの ${runnableOpen.length} 件のチャットを並列実行`
            }
            className="label-cap text-ink-muted hover:text-azure disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-muted flex items-center gap-1 transition-colors"
          >
            <Play size={9} fill="currentColor" /> Run all
          </button>
        )}
      </div>

      {selectable ? (
        // Workspace mode: composer lives in the right pane; this is the
        // "+ New chat" affordance. Solid accent button so it reads as the
        // primary action, not an input field — input lives in the right pane.
        <>
          <div className="mb-3 flex items-center gap-1.5">
            <Btn variant="primary" size="sm" flat onClick={() => onStartNew?.()} className="flex-1">
              <Plus size={12} strokeWidth={2.5} />
              新規チャット
            </Btn>
            <Btn
              variant="ghost"
              size="sm"
              onClick={runAllOpen}
              disabled={!canRunAll}
              title={
                !online
                  ? 'オフラインのため実行できません'
                  : runnableOpen.length === 0
                    ? '実行待ちのチャットはありません'
                    : `実行待ちの ${runnableOpen.length} 件のチャットを並列実行`
              }
            >
              <Play size={11} fill="currentColor" />
              すべて実行
              {runnableOpen.length > 0 && (
                <span className="text-ink-faint">{runnableOpen.length}</span>
              )}
            </Btn>
          </div>
          {(() => {
            const conflicted = sortedAll.filter(t => {
              const ms = taskRuns.get(t.id)?.entries[0]?.mergeStatus
              // Include 'failed-fatal' (git index-locked) alongside 'conflict'
              // so a fatally-wedged run isn't hidden from the aggregate list —
              // the pane + inline banners already surface both.
              return ms === 'conflict' || ms === 'failed-fatal'
            })
            if (conflicted.length === 0) return null
            return (
              <div className="mb-3 rounded-[4px] border border-ochre bg-ochre-soft px-3 py-2.5">
                <div className="mb-2 flex items-center gap-1.5 label-cap text-ochre">
                  <AlertCircle size={10} strokeWidth={2.5} />
                  マージコンフリクト · {conflicted.length}件
                </div>
                <div className="space-y-1.5">
                  {conflicted.map(t => {
                    const session = taskRuns.get(t.id)!
                    const entry = session.entries[0]
                    return (
                      <div key={t.id} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
                          {t.title}
                        </span>
                        <ResolveConflictBtn
                          sessionId={session.id}
                          projectId={entry.projectId}
                          mergeStatus={
                            entry.mergeStatus === 'failed-fatal'
                              ? 'failed-fatal'
                              : 'conflict'
                          }
                          compact
                        />
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })()}
        </>
      ) : (
        <div className="mb-1.5">
          <div className="rounded-[2px] border border-line-soft px-2.5 py-1.5 transition-colors focus-within:border-accent">
            <div className="flex items-start gap-2">
              <Plus size={12} className="mt-[3px] shrink-0 text-ink-faint" strokeWidth={2} />
              <textarea
                ref={draftRef}
                value={draft}
                rows={1}
                onChange={e => {
                  setDraft(e.target.value)
                  autoGrowArea(e.target)
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    addTask({ run: true })
                  }
                }}
                onPaste={handleDraftPaste}
                title="Paste a clipboard image to attach it to this task — add text and press ⌘↵ to create and run the task"
                placeholder={
                  draftImages.length > 0
                    ? '説明を追加して ⌘↵ で作成＆実行…'
                    : 'Add a task or paste an image…   ⌘↵ で作成＆実行'
                }
                className="flex-1 resize-none bg-transparent text-[13px] leading-snug text-ink placeholder:text-ink-faint focus:outline-none"
              />
            </div>
            {draftImages.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1 pl-5">
                {draftImages.map(img => (
                  <TaskImageThumb
                    key={img.id}
                    image={img}
                    projectPath={projectPath}
                    size={40}
                    onRemove={() => {
                      setDraftImages(prev => prev.filter(x => x.id !== img.id))
                      void deleteTaskImage(projectPath, img.id)
                    }}
                  />
                ))}
              </div>
            )}
          </div>
          {(draftUploading > 0 || draftImgError) && (
            <div className="mt-1 pl-6 text-[10px] leading-relaxed">
              {draftUploading > 0 && (
                <span className="text-ink-subtle">画像をアップロード中…</span>
              )}
              {draftImgError && <span className="text-accent">{draftImgError}</span>}
            </div>
          )}
        </div>
      )}

      <div>
        {data.tasks.length === 0 && (
          <p className="px-1 py-3 text-[12px] italic text-ink-faint">
            {selectable
              ? 'チャットがまだありません。「+ 新規チャット」から始めてください。'
              : 'まだチャットがありません。'}
          </p>
        )}
        {selectable
          ? sortedAll.map(t => (
              <TaskRow
                key={t.id}
                task={t}
                projectPath={projectPath}
                run={taskRuns.get(t.id)}
                onRun={opts => onRunTask(t, opts)}
                onCancelRun={() => onCancelTask(t.id)}
                onUpdate={patch => updateTask(t.id, patch)}
                onDelete={() => deleteTask(t.id)}
                selectable
                selected={selectedTaskId === t.id}
                onOpenThread={() => onSelectTask?.(t.id)}
              />
            ))
          : openTasks.map((t, i) => (
              <TaskRow
                key={t.id}
                task={t}
                projectPath={projectPath}
                run={taskRuns.get(t.id)}
                onRun={opts => onRunTask(t, opts)}
                onCancelRun={() => onCancelTask(t.id)}
                onUpdate={patch => updateTask(t.id, patch)}
                onDelete={() => deleteTask(t.id)}
                selectable={selectable}
                selected={selectedTaskId === t.id}
                onOpenThread={() => onSelectTask?.(t.id)}
                reorder={{
                  index: i,
                  count: openTasks.length,
                  dragFrom,
                  dropAt,
                  onDragStart: () => setDragFrom(i),
                  onDragOver: (at) => setDropAt(at),
                  onDrop: () => {
                    if (dragFrom !== null && dropAt !== null) reorderOpen(dragFrom, dropAt)
                    setDragFrom(null)
                    setDropAt(null)
                  },
                  onDragEnd: () => {
                    setDragFrom(null)
                    setDropAt(null)
                  },
                }}
              />
            ))}
      </div>

      {!selectable && doneTasks.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setArchiveOpen(v => !v)}
            className="group flex w-full items-center gap-1.5 text-left"
          >
            <span className="text-ink-faint transition-colors group-hover:text-ink-muted">
              {archiveOpen ? (
                <ChevronDown size={12} />
              ) : (
                <ChevronRight size={12} />
              )}
            </span>
            <span className="label-cap text-ink-muted">
              Archive · {doneTasks.length} done
            </span>
          </button>
          {archiveOpen && (
            <div className="mt-1">
              {doneTasks.map(t => (
                <TaskRow
                  key={t.id}
                  task={t}
                  projectPath={projectPath}
                  run={taskRuns.get(t.id)}
                  onRun={opts => onRunTask(t, opts)}
                  onCancelRun={() => onCancelTask(t.id)}
                  onUpdate={patch => updateTask(t.id, patch)}
                  onDelete={() => deleteTask(t.id)}
                  selectable={selectable}
                  selected={selectedTaskId === t.id}
                  onOpenThread={() => onSelectTask?.(t.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

interface ReorderProps {
  /** This row's position in the open-tasks list. */
  index: number
  /** Total number of open tasks — used so the last row can render the
   *  insert-at-end bar along its own bottom edge instead of needing a tail. */
  count: number
  dragFrom: number | null
  dropAt: number | null
  onDragStart: () => void
  /** Called as the pointer crosses the row, with the insertion slot the row
   *  wants to claim (its own index, or its index + 1 if past the midpoint). */
  onDragOver: (at: number) => void
  onDrop: () => void
  onDragEnd: () => void
}

const TaskRow = ({
  task,
  projectPath,
  run,
  onRun,
  onCancelRun,
  onUpdate,
  onDelete,
  selectable,
  selected,
  onOpenThread,
  reorder,
}: {
  task: ProjectTask
  projectPath: string
  run?: RunSession
  onRun: (opts?: RunTaskOpts) => void
  onCancelRun: () => void
  onUpdate: (patch: Partial<ProjectTask>) => void
  onDelete: () => void
  /** In the workspace, the row selects into the detail pane instead of expanding. */
  selectable?: boolean
  selected?: boolean
  onOpenThread?: () => void
  /** Omit for done/archived rows so only open tasks reorder. */
  reorder?: ReorderProps
}) => {
  // Count of in-flight uploads, so the UI can show a placeholder per image.
  const [uploading, setUploading] = useState(0)
  const [imgError, setImgError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const entry = run?.entries[0]
  const kind = entry ? runKind(entry) : null
  const images = task.images ?? []

  // Upload pasted images, then attach them all in a single task update so a
  // multi-image paste doesn't race on a stale `task.images`.
  const uploadImages = useCallback(
    async (files: File[]) => {
      setImgError(null)
      setUploading(n => n + files.length)
      const { added, error } = await uploadTaskImages(projectPath, files)
      setUploading(n => n - files.length)
      if (error) setImgError(error)
      if (added.length) onUpdate({ images: [...(task.images ?? []), ...added] })
    },
    [projectPath, onUpdate, task.images],
  )

  // Intercept clipboard images on the title field; let plain text paste as usual.
  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromClipboard(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    uploadImages(files)
  }

  const removeImage = (id: string) => {
    onUpdate({ images: (task.images ?? []).filter(im => im.id !== id) })
  }

  // DnD indicator + dragged-row dimming, only when reorder is enabled.
  const showTopBar =
    !!reorder &&
    reorder.dragFrom !== null &&
    reorder.dragFrom !== reorder.index &&
    reorder.dropAt === reorder.index
  const showBottomBar =
    !!reorder &&
    reorder.dragFrom !== null &&
    reorder.dragFrom !== reorder.index &&
    reorder.dropAt === reorder.index + 1 &&
    reorder.index === reorder.count - 1
  const dimmed = !!reorder && reorder.dragFrom === reorder.index

  return (
    <div
      draggable={!!reorder}
      onDragStart={(e) => {
        if (!reorder) return
        e.dataTransfer.effectAllowed = 'move'
        // Required by Firefox for the drag to actually fire; the payload is
        // unused — we read state instead.
        e.dataTransfer.setData('text/plain', String(reorder.index))
        reorder.onDragStart()
      }}
      onDragOver={(e) => {
        if (!reorder || reorder.dragFrom === null || reorder.dragFrom === reorder.index) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = e.currentTarget.getBoundingClientRect()
        const past = e.clientY > r.top + r.height / 2
        reorder.onDragOver(reorder.index + (past ? 1 : 0))
      }}
      onDrop={(e) => {
        if (!reorder) return
        e.preventDefault()
        reorder.onDrop()
      }}
      onDragEnd={() => reorder?.onDragEnd()}
      onClick={() => (selectable ? onOpenThread?.() : setExpanded(v => !v))}
      className={[
        'group relative cursor-pointer border-b border-l-2 border-line-soft transition-colors',
        selected
          ? 'border-l-accent bg-bg-elevated'
          : 'border-l-transparent hover:bg-bg-elevated',
        dimmed ? 'opacity-40' : '',
      ].join(' ')}
    >
      {showTopBar && (
        <div className="pointer-events-none absolute -top-px left-0 right-0 z-10 h-0.5 bg-accent" />
      )}
      {showBottomBar && (
        <div className="pointer-events-none absolute -bottom-px left-0 right-0 z-10 h-0.5 bg-accent" />
      )}
      {selectable ? (
        // Workspace sidebar — ChatGPT-style compact row: a status dot on the
        // left, then a one-line label (the latest run's summary if any, else
        // a shortened task title), plus a tiny image-count chip when the task
        // has pasted screenshots. The full text lives in the right detail pane.
        <CompactTaskRow
          task={task}
          entry={entry}
          selected={!!selected}
        />
      ) : (
        <>
          <div className="flex items-start gap-2 px-2.5 py-2">
            <div className="mt-0.5 flex shrink-0 items-center gap-1">
              <span
                title={kind ? RUN_KIND[kind].label : 'No run yet'}
                className={[
                  'flex h-4 w-4 shrink-0 items-center justify-center',
                  kind ? RUN_KIND[kind].text : 'text-ink-faint/40',
                ].join(' ')}
              >
                {kind ? <RunGlyph kind={kind} size={13} /> : (
                  <span className="h-1.5 w-1.5 rounded-full border border-current" />
                )}
              </span>
              <span
                className={[
                  'flex h-4 w-4 items-center justify-center transition-colors',
                  selected ? 'text-azure' : 'text-ink-faint group-hover:text-ink-muted',
                ].join(' ')}
              >
                {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              </span>
            </div>
            <EditableTaskTitle
              title={task.title}
              done={task.done}
              onSave={(next) => onUpdate({ title: next })}
              onSaveAndRun={task.done ? undefined : (next) => {
                if (next !== task.title) onUpdate({ title: next })
                onRun()
              }}
              onPaste={handlePaste}
            />
            {(images.length > 0 || uploading > 0) && (
              <div
                className="flex shrink-0 flex-wrap justify-end gap-1"
                style={{ maxWidth: 84 }}
                onClick={e => e.stopPropagation()}
              >
                {images.map(im => (
                  <TaskImageThumb
                    key={im.id}
                    image={im}
                    projectPath={projectPath}
                    onRemove={() => removeImage(im.id)}
                    size={40}
                  />
                ))}
                {Array.from({ length: uploading }).map((_, i) => (
                  <div
                    key={i}
                    className="h-10 w-10 animate-pulse rounded-[2px] border border-line-soft bg-bg-inset"
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
      {imgError && (
        <p className="px-2.5 pb-1.5 pl-9 text-[10px] text-accent">{imgError}</p>
      )}

      {!selectable && expanded && (
        <div className="px-2.5 pb-2.5" onClick={e => e.stopPropagation()}>
          <TaskThread
            task={task}
            projectPath={projectPath}
            run={run}
            onRun={onRun}
            onUpdate={onUpdate}
            onCancel={onCancelRun}
            onDelete={onDelete}
          />
        </div>
      )}
    </div>
  )
}

// ---------- Overview (vision broadsheet) ----------

// The Overview tab is a read-only vision broadsheet for OPEN GROUND. No
// inputs — the per-project description and notes are still
// editable in the panel header and the Chats sidebar. Laid out like an
// editorial spread: masthead, eight numbered pillars, themed-grounds atlas,
// inner Canvas tab-row preview, 24h off-peak strip, five-stop survey
// roadmap, closing creed.
// The slot sidebar for the Terminal tab. A vertical list of "Terminal N"
// buttons + a `+` to spin up another PTY. Each row's hover state reveals an
// `×` to close the slot. Visually a hair narrower than the chat sidebar so
// it doesn't feel like a second navigation column.
const TerminalSlotSidebar = ({
  slots,
  activeId,
  onActivate,
  onAdd,
  onClose,
}: {
  slots: TerminalSlot[]
  activeId: string
  onActivate: (id: string) => void
  onAdd: () => void
  onClose: (id: string) => void
}) => (
  <aside className="flex w-[148px] shrink-0 flex-col gap-1 border-r border-line bg-bg-elevated/40 px-2 py-2">
    {slots.map(s => {
      const active = s.id === activeId
      const canClose = slots.length > 1
      return (
        <div key={s.id} className="group relative">
          <button
            onClick={() => onActivate(s.id)}
            className={[
              'flex w-full items-center gap-1.5 rounded-[3px] border px-2 py-1.5 text-left text-[12px] transition-colors',
              active
                ? 'border-accent bg-accent-soft text-accent'
                : 'border-transparent text-ink-muted hover:border-line-soft hover:bg-bg-inset hover:text-ink',
            ].join(' ')}
          >
            <Terminal size={11} strokeWidth={2} />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
          </button>
          {canClose && (
            <button
              onClick={e => {
                e.stopPropagation()
                onClose(s.id)
              }}
              title="Close terminal"
              className={[
                'absolute right-1.5 top-1/2 -translate-y-1/2 rounded-[2px] p-0.5 text-ink-faint transition-opacity hover:bg-bg-card hover:text-accent',
                active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
              ].join(' ')}
            >
              <X size={11} strokeWidth={2} />
            </button>
          )}
        </div>
      )
    })}
    <button
      onClick={onAdd}
      title="New terminal"
      className="mt-1 flex items-center justify-center gap-1 rounded-[3px] border border-dashed border-line-soft px-2 py-1.5 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-accent"
    >
      <Plus size={11} strokeWidth={2} />
      <span>New</span>
    </button>
  </aside>
)


// Notes stay collapsed until wanted — a quiet header that opens the textarea.
const NotesSection = ({
  data,
  onChange,
}: {
  data: ProjectData
  onChange: (d: ProjectData) => void
}) => {
  const [open, setOpen] = useState(false)
  const hasNotes = data.notes.trim() !== ''
  return (
    <section>
      <button
        onClick={() => setOpen(v => !v)}
        className="group flex w-full items-center gap-1.5 text-left"
      >
        <span className="text-ink-faint transition-colors group-hover:text-ink-muted">
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="label-cap text-ink-muted">Notes</span>
        {!open && hasNotes && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-ink-faint">
            · {data.notes.trim()}
          </span>
        )}
      </button>
      {open && (
        <textarea
          autoFocus
          value={data.notes}
          onChange={e => onChange({ ...data, notes: e.target.value })}
          placeholder="Comments, plans, anything…"
          className="mt-2 min-h-[120px] w-full resize-y rounded-[2px] border border-line-soft bg-bg-elevated px-3 py-2.5 text-[13px] leading-relaxed text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
      )}
    </section>
  )
}

// Grow a one-row textarea to fit its content, so task fields can hold
// multiple lines (Enter / Shift+Enter) while staying compact when short.
function autoGrowArea(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

// ---------- Compact sidebar row (workspace mode) ----------

// First sentence (ja or en terminator), capped at ~80 chars so the sidebar
// row keeps the gist — typically 1–2 wrapped lines — without devolving into
// the wall of text the original task title would be. Falls back to a hard
// cut + ellipsis.
const shortenLabel = (s: string, cap = 80) => {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (!flat) return ''
  const m = flat.match(
    new RegExp(`^([\\s\\S]{1,${cap}}?[。．\\.！!？?])`),
  )
  if (m) return m[1]
  return flat.length > cap ? flat.slice(0, cap - 1).trimEnd() + '…' : flat
}

const CompactTaskRow = ({
  task,
  entry,
  selected,
}: {
  task: ProjectTask
  entry?: RunEntry
  selected: boolean
}) => {
  const kind = entry ? runKind(entry) : null
  const live = !!entry && isLive(entry.status)
  const pr = entry?.parsedResult

  // The task title is the topic — what this chat is about. Always shown as
  // the primary row label so the sidebar reads as "table of contents".
  const title = shortenLabel(task.title)

  // A second line narrates "what's being talked about right now":
  //   - live: latest streaming log line (gist of what Claude is doing)
  //   - awaiting reply: the question Claude is asking
  //   - blockers / summary: most recent round's outcome
  //   - feedback fallback: the user's last message if no result yet
  // When the latest activity duplicates the title (typical first run with no
  // result yet), the second line is suppressed to keep the row quiet.
  const latestThought = useMemo(() => {
    if (!live) return ''
    const last = entry?.thoughts?.[entry.thoughts.length - 1]?.text ?? ''
    // First line of the thought reads best in the cramped sidebar row — the
    // whole text is available in the chat view.
    return last.split('\n').find(l => l.trim()) ?? ''
  }, [live, entry?.thoughts])

  const activity = (() => {
    if (live) {
      const snippet = latestThought ? shortenLabel(latestThought, 70) : ''
      return {
        kind: 'live' as const,
        text: snippet ? `考え中 · ${snippet}` : '考えています…',
      }
    }
    if (pr?.question?.trim()) {
      return { kind: 'question' as const, text: shortenLabel(pr.question) }
    }
    if (pr?.blockers?.trim()) {
      return { kind: 'blockers' as const, text: shortenLabel(pr.blockers) }
    }
    if (pr?.summary?.trim()) {
      return { kind: 'summary' as const, text: shortenLabel(pr.summary) }
    }
    if (entry?.feedback?.trim()) {
      return { kind: 'feedback' as const, text: shortenLabel(entry.feedback) }
    }
    return null
  })()

  // Don't echo the title — keep the row to a single line when there's nothing
  // new to add.
  const showActivity = !!activity && activity.text !== title

  const imageCount = task.images?.length ?? 0

  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <span
        title={kind ? RUN_KIND[kind].label : 'No run yet'}
        className={[
          'mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center',
          kind ? RUN_KIND[kind].text : 'text-ink-faint/40',
        ].join(' ')}
      >
        {kind ? (
          <RunGlyph kind={kind} size={10} />
        ) : (
          <span className="h-1.5 w-1.5 rounded-full border border-current" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div
          className={[
            'text-[12.5px] leading-snug whitespace-normal break-words',
            task.done ? 'text-ink-faint line-through' : selected ? 'text-ink' : 'text-ink-muted',
          ].join(' ')}
        >
          {title || <span className="italic text-ink-faint">Untitled task</span>}
        </div>
        {showActivity && (
          <div
            className={[
              'mt-1 flex items-start gap-1 text-[11px] leading-snug whitespace-normal break-words',
              activity.kind === 'live'
                ? 'text-azure'
                : activity.kind === 'question'
                  ? 'text-azure'
                  : activity.kind === 'blockers'
                    ? 'text-ochre'
                    : 'text-ink-faint',
            ].join(' ')}
          >
            {activity.kind === 'live' && (
              <Loader2 size={10} className="mt-[2px] shrink-0 animate-spin" />
            )}
            {activity.kind === 'question' && (
              <HelpCircle size={10} className="mt-[2px] shrink-0" strokeWidth={2.25} />
            )}
            {activity.kind === 'blockers' && (
              <Flag size={10} className="mt-[2px] shrink-0" strokeWidth={2.25} />
            )}
            <span className="min-w-0 flex-1">{activity.text}</span>
          </div>
        )}
      </div>
      {imageCount > 0 && (
        <span
          title={`${imageCount} image${imageCount === 1 ? '' : 's'}`}
          className="mt-0.5 shrink-0 label-cap text-ink-faint"
        >
          {imageCount}
        </span>
      )}
    </div>
  )
}

// ---------- New-task composer (workspace right pane) ----------

// The empty-state composer is the workspace's permanent "what now?" surface —
// always rendered when no chat is selected, ChatGPT-style. A short prompt
// occupies the upper area, the composer (textarea + paste handler + submit)
// is pinned to the bottom. On submit it creates the task, attaches any
// uploaded images, and hands the new task back to the parent so it can be
// selected and run. Pending pasted images are GC'd on unmount so switching
// chats away from a half-typed draft doesn't leave bytes on disk.
export const NewTaskComposer = ({
  projectPath,
  onCreate,
  hasOtherChats,
  enableSkillPicker = false,
}: {
  projectPath: string
  /** Make and persist a task with this text + images. The parent decides
   *  whether to immediately fire its first Claude run. */
  onCreate: (
    title: string,
    images: TaskImage[],
    opts?: { planMode?: boolean; skill?: string | null },
  ) => void
  /** When true, soften the placeholder copy — first-time empty state needs a
   *  bigger nudge than a return-to-empty state. */
  hasOtherChats: boolean
  /** Canvas only: show the skill picker above the controls. Selection is
   *  passed through onCreate so the new chat starts its first run with the
   *  chosen Claude Code skill applied. */
  enableSkillPicker?: boolean
}) => {
  const [text, setText] = useState('')
  const [images, setImages] = useState<TaskImage[]>([])
  const [uploading, setUploading] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [planMode, setPlanMode] = useState(false)
  const [skill, setSkill] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // Latest images in a ref so the unmount cleanup sees the current set
  // without having to re-subscribe the effect on every paste.
  const pendingRef = useRef<TaskImage[]>(images)
  pendingRef.current = images

  useEffect(() => {
    // Land focus straight into the composer so the user can type immediately.
    setTimeout(() => taRef.current?.focus(), 0)
    return () => {
      // The composer unmounted with images that were uploaded but never sent
      // (e.g. user switched chats mid-draft). Reclaim the disk.
      for (const im of pendingRef.current) void deleteTaskImage(projectPath, im.id)
    }
  }, [projectPath])

  const uploadFiles = useCallback(
    async (files: File[]) => {
      setErr(null)
      setUploading(n => n + files.length)
      const { added, error } = await uploadTaskImages(projectPath, files)
      setUploading(n => n - files.length)
      if (error) setErr(error)
      if (added.length) setImages(prev => [...prev, ...added])
    },
    [projectPath],
  )

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = imageFilesFromClipboard(e.clipboardData)
    if (files.length === 0) return
    e.preventDefault()
    uploadFiles(files)
  }

  const submit = () => {
    const title = text.trim()
    if (!title && images.length === 0) return
    // Hand images to the parent BEFORE clearing local state, so the unmount
    // cleanup (which reads pendingRef) doesn't see them as orphans.
    onCreate(title || 'スクリーンショット', images, { planMode, skill })
    setText('')
    setImages([])
    pendingRef.current = []
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 items-center justify-center px-8 text-center">
        <div className="text-ink-subtle">
          <Frame size={26} strokeWidth={1.25} className="mx-auto mb-3 opacity-50" />
          <p className="text-[13px] leading-relaxed">
            {hasOtherChats
              ? '新しいチャットを書くと、別の Claude セッションが始まります。'
              : 'はじめの指示を書くと、Claude セッションが始まります。'}
          </p>
        </div>
      </div>
      <div className="shrink-0 border-t border-line-soft bg-bg-card px-6 py-4">
        <div className="mx-auto max-w-[760px]">
          {enableSkillPicker && (
            <div className="mb-2">
              <SkillPicker projectPath={projectPath} value={skill} onChange={setSkill} />
            </div>
          )}
          <div className="rounded-[6px] border border-line-strong bg-bg px-3 py-2.5 transition-colors focus-within:border-accent">
            <textarea
              ref={taRef}
              value={text}
              rows={2}
              onChange={e => {
                setText(e.target.value)
                autoGrowArea(e.target)
              }}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  submit()
                }
              }}
              onPaste={onPaste}
              placeholder="新しいチャットを書く… (画像ペースト可・⌘↵ で送信)"
              className="block w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none"
            />
            {(images.length > 0 || uploading > 0) && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {images.map(im => (
                  <TaskImageThumb
                    key={im.id}
                    image={im}
                    projectPath={projectPath}
                    size={56}
                    onRemove={() => {
                      setImages(prev => prev.filter(x => x.id !== im.id))
                      void deleteTaskImage(projectPath, im.id)
                    }}
                  />
                ))}
                {Array.from({ length: uploading }).map((_, i) => (
                  <div
                    key={i}
                    className="h-14 w-14 animate-pulse rounded-[2px] border border-line-soft bg-bg-inset"
                  />
                ))}
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="label-cap text-ink-faint">
              {err
                ? <span className="text-accent">{err}</span>
                : uploading > 0
                  ? '画像をアップロード中…'
                  : '⌘↵ で送信'}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPlanMode(v => !v)}
                title="プランモード — Claude は読み取り＆思考のみ。ファイルは編集しません。"
                className={[
                  'flex shrink-0 items-center gap-1 rounded-[2px] border px-2.5 py-1.5 label-cap transition-colors',
                  planMode
                    ? 'border-moss bg-moss/10 text-moss'
                    : 'border-line bg-bg-card text-ink-muted hover:border-moss hover:text-moss',
                ].join(' ')}
              >
                <ClipboardList size={10} /> プラン
              </button>
              <Btn
                variant="primary"
                size="md"
                onClick={submit}
                disabled={!text.trim() && images.length === 0}
              >
                {planMode ? (
                  <>
                    <ClipboardList size={10} /> Plan
                  </>
                ) : (
                  <>
                    <Play size={10} fill="currentColor" /> 送信
                  </>
                )}
              </Btn>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------- Editable task title ----------

// Read-only by default with a pencil-on-hover affordance; double-click or the
// pencil enters edit mode. Edit mode is an auto-growing textarea so multi-line
// task titles still work, and it keeps the paste-image handler that drops
// clipboard screenshots straight onto the task. Click+key events inside the
// editor stop propagation so the row's click-to-expand doesn't fire.
const EditableTaskTitle = ({
  title,
  done,
  onSave,
  onSaveAndRun,
  onPaste,
}: {
  title: string
  done: boolean
  onSave: (next: string) => void
  /** Optional: commit the edit and immediately fire a run on the task. */
  onSaveAndRun?: (next: string) => void
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void
}) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!editing) setDraft(title)
  }, [title, editing])

  useEffect(() => {
    const el = ref.current
    if (!editing || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    autoGrowArea(el)
  }, [editing])

  const start = (e: React.SyntheticEvent) => {
    e.stopPropagation()
    setDraft(title)
    setEditing(true)
  }

  const commit = () => {
    setEditing(false)
    const next = draft.trimEnd()
    if (next !== title) onSave(next)
  }

  const commitAndRun = () => {
    setEditing(false)
    const next = draft.trimEnd()
    if (next !== title) onSave(next)
    onSaveAndRun?.(next)
  }

  if (editing) {
    return (
      <textarea
        ref={ref}
        value={draft}
        rows={1}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          setDraft(e.target.value)
          autoGrowArea(e.target)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && onSaveAndRun) {
            e.preventDefault()
            commitAndRun()
          } else if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            commit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            setEditing(false)
            setDraft(title)
          }
        }}
        onPaste={onPaste}
        title="Paste a clipboard image to attach it as a reference · Enter to save · ⌘↵ to save & run · Shift+Enter for newline"
        className={[
          'min-w-0 flex-1 resize-none rounded-[2px] border border-accent bg-bg-card px-1.5 py-0.5 text-[13px] leading-snug focus:outline-none',
          done ? 'text-ink-faint line-through' : 'text-ink',
        ].join(' ')}
      />
    )
  }

  return (
    <div className="group/title flex min-w-0 flex-1 items-start gap-1">
      <p
        onDoubleClick={start}
        className={[
          'min-w-0 flex-1 whitespace-pre-wrap text-[13px] leading-snug',
          done ? 'text-ink-faint line-through' : 'text-ink',
        ].join(' ')}
      >
        {title || <span className="italic text-ink-faint">Untitled task</span>}
      </p>
      <button
        onClick={start}
        title="Edit (double-click works too)"
        className="mt-0.5 shrink-0 rounded-sm p-0.5 text-ink-faint opacity-0 transition-opacity hover:bg-bg-inset hover:text-ink-muted group-hover/title:opacity-100"
      >
        <Pencil size={11} />
      </button>
    </div>
  )
}

// ---------- Editable project title ----------

// Read-only display heading; double-click (or hit Enter while typing in the
// input) to rename the folder on disk. Validation errors surface inline so a
// collision doesn't silently swallow the rename. Disabled when onRename is
// omitted (e.g. archived projects, until we support rename-within-archive).
const TITLE_CSS = {
  fullscreen: {
    text: 'mt-1 font-display text-[26px] leading-[1.05] tracking-tightest text-ink',
    style: { fontVariationSettings: "'opsz' 30, 'SOFT' 40" } as React.CSSProperties,
    input: 'mt-1 font-display text-[26px] leading-[1.05] tracking-tightest',
  },
  sidebar: {
    text: 'font-display text-[24px] text-ink leading-[1.05] tracking-tightest truncate',
    style: { fontVariationSettings: "'opsz' 28, 'SOFT' 40" } as React.CSSProperties,
    input: 'font-display text-[24px] leading-[1.05] tracking-tightest',
  },
}

const EditableTitle = ({
  name,
  size,
  onRename,
}: {
  name: string
  size: 'fullscreen' | 'sidebar'
  onRename?: (next: string) => Promise<{ error?: string } | void>
}) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const css = TITLE_CSS[size]

  // Re-sync the draft whenever the underlying name changes (a successful
  // rename, or switching to a different selected project).
  useEffect(() => {
    if (!editing) setDraft(name)
  }, [name, editing])

  const start = () => {
    if (!onRename) return
    setDraft(name)
    setError(null)
    setEditing(true)
    setTimeout(() => {
      const el = inputRef.current
      if (el) {
        el.focus()
        el.select()
      }
    }, 0)
  }

  const cancel = () => {
    setEditing(false)
    setDraft(name)
    setError(null)
  }

  const commit = async () => {
    if (!onRename || busy) return
    const next = draft.trim()
    if (!next || next === name) {
      cancel()
      return
    }
    setBusy(true)
    const res = await onRename(next)
    setBusy(false)
    if (res && res.error) {
      setError(res.error)
      return
    }
    setEditing(false)
    setError(null)
  }

  if (editing) {
    return (
      <div>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancel()
            }
          }}
          disabled={busy}
          className={[
            css.input,
            'w-full rounded-[2px] border border-accent bg-bg-card px-1.5 py-0.5 text-ink focus:outline-none',
          ].join(' ')}
          style={css.style}
        />
        {error && (
          <p className="mt-1 text-[11px] text-accent leading-tight">{error}</p>
        )}
      </div>
    )
  }

  return (
    <h2
      onDoubleClick={start}
      title={onRename ? 'Double-click to rename' : undefined}
      className={[css.text, onRename ? 'cursor-text' : ''].join(' ')}
      style={css.style}
    >
      {name}
    </h2>
  )
}
