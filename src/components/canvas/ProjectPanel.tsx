import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import {
  AlertCircle,
  Archive,
  ChevronLeft,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Plus,
  RotateCw,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import type {
  OpenApp,
  ProjectConfig,
  ProjectData,
  ProjectLaunchPrefs,
  ProjectMeta,
  ProjectTask,
  ShareAutoStatus,
  ShareConflict,
  ShareStatus,
} from '@/lib/types'
import { api } from '@/lib/api-client'
import {
  disableShare,
  enableShare,
  fetchShareStatus,
  remoteShortName,
  resolveShare,
  syncShare,
} from '@/lib/shareClient'
import { boardDiffDigest } from '@/lib/boardDigest'
import { useClaudeProbe } from '@/lib/useClaudeProbe'
import { migrateLs } from '@/lib/lsMigrate'
import { loadPersistedView, savePersistedView } from '@/lib/persistView'
import { descriptionForLang } from '@/lib/descriptionLang'
import {
  TerminalPane,
  type TerminalInfo,
} from '@/components/canvas/TerminalPane'
import { BoardTaskTerminal } from '@/components/canvas/TaskTerminal'
import { TerminalDock } from '@/components/canvas/EmbeddedClaudeTerminal'
import { ProjectCanvas } from '@/components/canvas/ProjectCanvas'
import { UsageHud } from '@/components/canvas/UsageHud'
import { FeedbackModal } from '@/components/canvas/FeedbackModal'
import { BoardModule } from '@/components/canvas/modules/BoardModule'
import { enabledModules, isModuleIdEnabled, type ModuleDef } from '@/components/canvas/moduleRegistry'
import type { ModuleId } from '@/lib/modules/ids'
import { effectiveTabOrder, moveTab } from '@/lib/modules/tabOrder'

// The per-project tabs are now declared once in the module registry
// (moduleRegistry.tsx). PanelView is just its id type; visibility, the tab row,
// the Ctrl+Tab order and persistView's allowlist all derive from MODULES.
type PanelView = ModuleId
const isMvpVisibleTab = isModuleIdEnabled

// The enabled module ids in registry (default) order. Per project this is
// reordered by the user (drag-to-reorder, persisted in ProjectData.tabOrder)
// and normalised via effectiveTabOrder; the result drives both the tab row's
// left-to-right order AND the Ctrl+Tab cycle order ("next" = the tab to my
// right). With no saved order a project falls back to this default order.
const ENABLED_MODULE_IDS: PanelView[] = enabledModules().map(m => m.id)

// A Terminal-tab pane is a plain shell, nothing more. Claude is something the
// user types (`claude`) — the old slot-level promotion ("▶ Claude" /
// kind/claudeTerminalId/taskId machinery) is gone, and Board tasks keep their
// terminals entirely inside the Board drawer (see taskTerminals below).
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
        .filter(
          (s): s is { id: string; label?: unknown; claudeTerminalId?: unknown } =>
            typeof s?.id === 'string',
        )
        .map(s => {
          // Legacy claude-promoted / board-task panes: that pane type is gone
          // (the tab is plain shells now), so best-effort kill the old claude
          // PTY — otherwise it lingers as an idle process nothing renders.
          if (typeof s.claudeTerminalId === 'string') {
            fetch(`/api/terminal/${s.claudeTerminalId}`, { method: 'DELETE' }).catch(
              () => {},
            )
          }
          return {
            id: s.id,
            label: typeof s.label === 'string' && s.label ? s.label : s.id,
          }
        })
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

// Board task terminals: taskId → claude PTY id. Board-scoped — a task's
// session renders ONLY inside the Board drawer; the Terminal tab never sees
// it. Persisted per project so reopening the panel reattaches the drawer to a
// still-running PTY (a dead one just falls back to the launch CTA).
const TASK_TERMINALS_KEY = (path: string) =>
  `openground.board.taskTerminals.${path}`

const loadTaskTerminals = (path: string): Record<string, string> => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(TASK_TERMINALS_KEY(path))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    }
  } catch {}
  return {}
}

const saveTaskTerminals = (path: string, map: Record<string, string>) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(TASK_TERMINALS_KEY(path), JSON.stringify(map))
  } catch {}
}

// Split-view tuning. Pane width is purely count-based: up to 4 panes share
// the row equally (1/N each), a 5th+ keeps the quarter width and overflows
// into the horizontal scroll. No per-pane resize, nothing persisted — the
// old drag-to-resize pinning fought the equal-split rule (a stale stored
// width broke "press New → halves"). MAX caps how many PTYs one project can
// spawn at once.
const MAX_TERMINALS = 6
const paneWidthPct = (count: number) => 100 / Math.min(Math.max(count, 1), 4)

interface Props {
  project: ProjectMeta | null
  onClose: () => void
  /** Remove the project from the canvas (unregister; folder stays on disk). */
  onRemove: (project: ProjectMeta) => void
  onSaved?: (path: string, data: ProjectData) => void
  onDeleted?: (path: string) => void
  /** Rename the project's folder on disk. Rejects bad names; should reload the
   *  canvas and re-select by the new path on success. */
  onRename?: (project: ProjectMeta, newName: string) => Promise<{ error?: string } | void>
  /** Re-point a MISSING project at a folder the user picks (keeps its uuid so
   *  central data reconnects). Picks natively, calls relocate, reloads. */
  onRelocate?: (id: string) => Promise<void>
  /** Label of the grouping frame this project's card sits inside, if any. */
  frameLabel: string | null
  /** When true, show the subtle per-tab feedback affordance in the tab row.
   *  Gated so the whole feature only appears when feedback is configured
   *  (the integrator passes this down from App.tsx). */
  feedbackEnabled?: boolean
}

export const ProjectPanel = ({
  project,
  onClose,
  onRemove,
  onSaved,
  onDeleted,
  onRename,
  onRelocate,
  frameLabel,
  feedbackEnabled,
}: Props) => {
  const { t, lang } = useT()
  // Per-tab contextual feedback: opening the modal here tags the submission
  // with the active tab (source + display label) so the report says which
  // surface it's about. Only mounted/offered when `feedbackEnabled` is true.
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [data, setData] = useState<ProjectData | null>(null)
  // Which project path the currently-held `data` was loaded for. `data` itself
  // carries no path, and a project switch keeps the old data on screen until the
  // new fetch resolves — so the "open on the first tab" logic must wait until
  // this matches the live project before reading data.tabOrder.
  const loadedDataPathRef = useRef<string | null>(null)
  // The last project path we applied the first-tab default for. Guards against
  // re-defaulting the tab on a same-project save/refetch (e.g. dragging a tab
  // persists tabOrder → data changes → must NOT yank the view back to tab 1).
  const defaultViewedPathRef = useRef<string | null>(null)
  const [loading, setLoading] = useState(false)
  // The Project settings dialog (shared policy + personal launch prefs) —
  // opened from the ⋯ menu; drafts live inside the dialog, Save persists.
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [confirmText, setConfirmText] = useState('')
  const [deleting, setDeleting] = useState(false)
  // Surfaced inline inside the delete-confirm modal — deleting a project is
  // destructive (folder → Trash) and undo-less, so a failed/partial delete must
  // not vanish behind a native alert() the user can dismiss without reading.
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSavedJson = useRef<string>('')

  // ── Regenerate description (auto-generate via the local `claude` CLI) ──
  // Subscription-only: the server runs claude inside a PTY (never `claude -p`).
  // On success we AUTO-SAVE: the generated text just swaps in as the new
  // description (no edit form, no ⌘↵) — generation is a one-shot replace.
  // Path currently being described (null = idle). Tracked by path, not a bare
  // boolean, because this panel is reused across project switches (no key): if
  // the user opens a different project while claude is working, the spinner
  // belongs to the one we started for, and a stale return must not flip the
  // new project's state.
  const [describingPath, setDescribingPath] = useState<string | null>(null)
  const describing = !!project && describingPath === project.path
  // Probe the local `claude` CLI while a project is open so we can disable the
  // regenerate affordance (and not fire a doomed request) when it's missing.
  const claudeProbe = useClaudeProbe(!!project)
  const claudeMissing = claudeProbe?.installed === false

  // Open the project folder in the host OS file manager (Finder / Explorer /
  // xdg-open) — fire-and-forget; the server picks the right command per platform.
  const revealInFinder = useCallback(() => {
    if (!project || project.missing) return
    fetch('/api/project/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: project.path }),
    }).catch(() => {})
  }, [project])

  const regenerateDescription = useCallback(async () => {
    if (!project || project.missing || describing || claudeMissing) return
    // claude can take ~2 min to answer; this panel is reused across project
    // switches (no key), so the user may open a different project meanwhile.
    // Pin the path we asked for and, on return, only apply the result if that
    // project is still the loaded one — otherwise we'd prefill (and let the
    // user save) project A's text into project B. loadedDataPathRef tracks the
    // currently-loaded project, surviving the stale `project` closure.
    const requestedPath = project.path
    setDescribingPath(requestedPath)
    try {
      const res = await api.api.project.describe.$post({
        query: { path: requestedPath },
      })
      if (loadedDataPathRef.current !== requestedPath) return
      if (!res.ok) return
      const body = (await res.json()) as {
        description?: string
        descriptionJa?: string
        descriptionEn?: string
      }
      if (loadedDataPathRef.current !== requestedPath) return
      const text = (body.description ?? '').trim()
      // Auto-confirm: replace the description and persist immediately — the text
      // just swaps in, no edit form / ⌘↵. dataRef holds the latest data and
      // requestedPath is verified current above, so we never write into a
      // switched-to project. (Saved directly rather than via the debounced
      // persist() because that callback is defined below this hook.)
      const base = dataRef.current
      if (text && base) {
        // Store the generated language pair alongside the active-language copy
        // so a later language switch shows the matching text instantly.
        const next = {
          ...base,
          description: text,
          ...(body.descriptionJa ? { descriptionJa: body.descriptionJa.trim() } : {}),
          ...(body.descriptionEn ? { descriptionEn: body.descriptionEn.trim() } : {}),
        }
        setData(next)
        lastSavedJson.current = JSON.stringify(next)
        void api.api.project
          .$put({ query: { path: requestedPath }, json: next })
          .then(() => onSaved?.(requestedPath, next))
      }
    } catch {
      // Network/CLI failure — leave the existing description untouched.
    } finally {
      // Clear the spinner only for the project we started for; a stale return
      // must not reset another project's (possibly in-flight) state.
      setDescribingPath((p) => (p === requestedPath ? null : p))
    }
  }, [project, describing, claudeMissing, onSaved])

  useEffect(() => {
    setProjectSettingsOpen(false)
    setConfirmingDelete(false)
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
        loadedDataPathRef.current = project.path
        lastSavedJson.current = JSON.stringify(d)
      })
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path])

  // Serialize saves: a fire while a PUT is in flight re-schedules, so the next
  // body always carries the CAS token adopted from the previous response (a
  // parallel PUT with the old token would 409 against our own write).
  const savingRef = useRef(false)
  const persist = useCallback(
    (next: ProjectData) => {
      if (!project) return
      setData(next)
      if (saveTimer.current) clearTimeout(saveTimer.current)
      const fire = async () => {
        if (savingRef.current) {
          saveTimer.current = setTimeout(fire, 100)
          return
        }
        // Send the LATEST draft at fire time, not the `next` captured when the
        // timer was scheduled — state may have adopted a fresher CAS token (or
        // newer edits) since then.
        const current = dataRef.current
        if (!current) return
        const body = JSON.stringify(current)
        if (body === lastSavedJson.current) return
        savingRef.current = true
        try {
          const res = await api.api.project
            .$put({ query: { path: project.path }, json: current })
            .catch(() => null)
          if (!res) return
          if (res.status === 409) {
            // The store moved on under us (another window, another client, a
            // pull). Newer data wins: drop this draft and adopt theirs —
            // clobbering the store with a stale snapshot is how a shared
            // board gets wiped (incident 2026-06-10).
            const fresh = await api.api.project
              .$get({ query: { path: project.path } }, { init: { cache: 'no-store' } })
              .catch(() => null)
            if (fresh?.ok) {
              const d = (await fresh.json()) as ProjectData
              setData(d)
              lastSavedJson.current = JSON.stringify(d)
              onSaved?.(project.path, d)
            }
            return
          }
          if (!res.ok) return
          const saved = (await res.json()) as ProjectData
          // Adopt the server-stamped CAS token without touching newer local
          // edits (field values stay identical, so controlled inputs — and an
          // in-progress IME composition — are unaffected).
          setData(prev => (prev ? { ...prev, updatedAt: saved.updatedAt } : prev))
          lastSavedJson.current = JSON.stringify({ ...current, updatedAt: saved.updatedAt })
          onSaved?.(project.path, saved)
        } finally {
          savingRef.current = false
        }
      }
      saveTimer.current = setTimeout(fire, 350)
    },
    [project, onSaved],
  )

  // Board self-contained (P1): the task whose detail/conversation is open as a
  // drawer INSIDE the Board tab. Clicking a card opens it here instead of
  // bouncing to the Chats tab — the Board owns the conversation surface.
  const [boardDetailId, setBoardDetailId] = useState<string | null>(null)
  // Tasks / Terminal / Canvas toggle. Persisted to localStorage so the user's
  // chosen tab survives a page reload (and popping the panel closed + re-open),
  // mirroring how the terminal session itself is cached in localStorage. The
  // saved tab is validated against the registry so a stale retired tab
  // (e.g. the removed 'goals') can never strand the panel on a tab with no
  // row entry.
  const [view, setView] = useState<PanelView>(() => {
    const saved = loadPersistedView().panelTab
    // 'board' is the new default leftmost tab now that Chats is gone (a stale
    // persisted 'tasks' fails isMvpVisibleTab and falls back here).
    return saved && isMvpVisibleTab(saved) ? saved : 'board'
  })
  // Persist the active tab on every change (covers tab clicks and Ctrl+Tab).
  useEffect(() => {
    savePersistedView({ panelTab: view })
  }, [view])
  // The per-project, normalised tab order: the user's saved drag order
  // (ProjectData.tabOrder) reconciled against the live registry, falling back to
  // the registry default order when a project has none. Drives the tab row, the
  // Ctrl+Tab cycle, and the first-tab default below.
  const tabOrder = useMemo(
    () => effectiveTabOrder(data?.tabOrder, ENABLED_MODULE_IDS),
    [data?.tabOrder],
  )
  // "The leftmost tab opens by default." When a project's data first loads
  // (opening it, or switching to it — guarded so a same-project save/refetch
  // doesn't yank the view), land on that project's first tab.
  useEffect(() => {
    const path = project?.path
    if (!path || !data || loadedDataPathRef.current !== path) return
    if (defaultViewedPathRef.current === path) return
    defaultViewedPathRef.current = path
    const first = effectiveTabOrder(data.tabOrder, ENABLED_MODULE_IDS)[0] ?? 'board'
    setView(first)
  }, [project?.path, data])
  // Persist a drag-reordered tab row to this project's ProjectData.tabOrder.
  const reorderTabs = useCallback(
    (from: number, to: number) => {
      if (!data) return
      const next = moveTab(tabOrder, from, to)
      if (next.every((id, i) => id === tabOrder[i])) return
      persist({ ...data, tabOrder: next })
    },
    [data, tabOrder, persist],
  )
  // Mirrored up from TerminalPane so the Terminal tab can show `zsh · 163×44`
  // and a Restart button next to its label — the tab thus reads as the header
  // of the panel it controls.
  const [terminalInfo, setTerminalInfo] = useState<TerminalInfo | null>(null)
  // Multiple PTY sessions per project. Each slot has its own id and a
  // user-visible label; the active slot's TerminalPane is the one mounted at
  // any moment so resources stay bounded. List is mirrored to localStorage
  // (per-project) so the layout survives panel close / app relaunch.
  const [terminalSlots, setTerminalSlots] = useState<TerminalSlot[]>(() =>
    project ? loadSlots(project.path) : [DEFAULT_SLOT],
  )
  // In the split view every slot is mounted at once and tiled horizontally;
  // `activeTerminalSlot` now means the *focused* pane — the one whose shell
  // info feeds the Terminal tab header and whose session Restart drives.
  const [activeTerminalSlot, setActiveTerminalSlot] = useState<string>(
    () => terminalSlots[0]?.id ?? 'default',
  )
  const activeTerminalSlotRef = useRef(activeTerminalSlot)
  activeTerminalSlotRef.current = activeTerminalSlot
  // Board task terminals (taskId → claude PTY id) — board-scoped, persisted.
  // See loadTaskTerminals above. Exit state is component-level only: a fresh
  // load re-probes liveness via the drawer's pane itself.
  const [taskTerminals, setTaskTerminals] = useState<Record<string, string>>(
    () => (project ? loadTaskTerminals(project.path) : {}),
  )
  const [exitedTaskTerminals, setExitedTaskTerminals] = useState<Set<string>>(
    new Set(),
  )
  const markTaskTerminalExited = (taskId: string) =>
    setExitedTaskTerminals(prev => new Set(prev).add(taskId))
  // Tasks with an in-flight launch — blocks a double-spawn (a double-click
  // would POST twice and orphan the first PTY).
  const launchingTasksRef = useRef<Set<string>>(new Set())
  // Last-known shell info per pane, so switching focus immediately repaints the
  // tab header with that pane's `zsh · cols×rows` instead of waiting for its
  // next info event.
  const terminalInfoMapRef = useRef<Record<string, TerminalInfo | null>>({})
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
      setTaskTerminals(loadTaskTerminals(path))
      setExitedTaskTerminals(new Set())
      setActiveTerminalSlot(next[0]?.id ?? 'default')
      return
    }
    // Subsequent runs for the same path: terminalSlots changed because the
    // user added / removed / switched a slot — persist it.
    saveSlots(path, terminalSlots)
  }, [project?.path, terminalSlots])
  // Persist the board task-terminal map under the same loaded-for-path guard,
  // so the initial empty map can't clobber a saved one before load.
  useEffect(() => {
    const path = project?.path
    if (!path || loadedForPathRef.current !== path) return
    saveTaskTerminals(path, taskTerminals)
  }, [project?.path, taskTerminals])
  // When focus moves to another pane, repaint the tab header from that pane's
  // last-known shell info immediately.
  useEffect(() => {
    setTerminalInfo(terminalInfoMapRef.current[activeTerminalSlot] ?? null)
  }, [activeTerminalSlot])

  // The horizontal scroll container that tiles the panes. Read at drag start to
  // turn a pixel delta into a width fraction.
  const terminalRowRef = useRef<HTMLDivElement | null>(null)
  // Pointer-drag reorder of pane tabs. termDragDX is the live horizontal offset
  // of the dragged tab so it visibly slides under the cursor.
  const [termDragId, setTermDragId] = useState<string | null>(null)
  const [termDragOverId, setTermDragOverId] = useState<string | null>(null)
  const [termDragDX, setTermDragDX] = useState(0)
  // Inline rename of a pane (double-click its tab label).
  const [renamingTermId, setRenamingTermId] = useState<string | null>(null)
  const [renameTermDraft, setRenameTermDraft] = useState('')

  // Add a pane. Widths are count-based (paneWidthPct), so there is nothing to
  // seed; labels just count up — "Terminal N" picks the next free integer.
  // Capped at MAX_TERMINALS.
  const addTerminal = () => {
    if (terminalSlots.length >= MAX_TERMINALS) return
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
  }

  // Launch (or relaunch) the claude terminal FOR A BOARD TASK — board-scoped:
  // the PTY id lands in taskTerminals and the session renders only inside the
  // Board drawer (BoardTaskTerminal). The Terminal tab is not involved. The
  // title is the prompt; notes are NOT sent.
  const launchTaskTerminal = async (task: ProjectTask) => {
    if (!project) return
    if (taskTerminals[task.id] && !exitedTaskTerminals.has(task.id)) return
    if (launchingTasksRef.current.has(task.id)) return
    launchingTasksRef.current.add(task.id)
    try {
      const title = task.title?.trim()
      const r = await fetch('/api/terminal/claude', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Structured task launch: the server composes the first prompt from
        // title + content, and on a git project adds the task-branch/worktree
        // protocol (claude names its own branch; parallel cards never share a
        // checkout). Falls back to a bare session when the card is untitled.
        body: JSON.stringify({
          cwd: project.path,
          ...(title
            ? { task: { id: task.id, title, notes: task.notes ?? '' } }
            : {}),
        }),
      })
      if (!r.ok) return
      const info = (await r.json()) as TerminalInfo
      setExitedTaskTerminals(prev => {
        if (!prev.has(task.id)) return prev
        const n = new Set(prev)
        n.delete(task.id)
        return n
      })
      setTaskTerminals(prev => ({ ...prev, [task.id]: info.id }))
    } catch {
      /* swallow — the Board card stays on its launch button to retry */
    } finally {
      launchingTasksRef.current.delete(task.id)
    }
  }

  // Tear down a task's terminal: kill its PTY (best-effort) and forget the
  // binding. Used on task delete and by the orphan reconciler below.
  const closeTaskTerminal = (taskId: string) => {
    const ptyId = taskTerminals[taskId]
    if (ptyId) {
      api.api.terminal[':id'].$delete({ param: { id: ptyId } }).catch(() => {})
    }
    setTaskTerminals(prev => {
      if (!(taskId in prev)) return prev
      const next = { ...prev }
      delete next[taskId]
      return next
    })
    setExitedTaskTerminals(prev => {
      if (!prev.has(taskId)) return prev
      const n = new Set(prev)
      n.delete(taskId)
      return n
    })
  }

  // Close a pane: drop its PTY on the server, prune its cached id + stored
  // width, and never leave zero panes (seed a fresh default if the last is
  // closed).
  const closeTerminal = async (id: string) => {
    if (!project) return
    try {
      const key = `openground.terminal.session.${project.path}.${id}`
      const cached = localStorage.getItem(key)
      if (cached) {
        api.api.terminal[':id'].$delete({ param: { id: cached } }).catch(() => {})
        localStorage.removeItem(key)
      }
    } catch {}
    setTerminalSlots(prev => {
      const next = prev.filter(s => s.id !== id)
      return next.length > 0 ? next : [DEFAULT_SLOT]
    })
    setActiveTerminalSlot(prev => {
      if (prev !== id) return prev
      const remaining = terminalSlots.filter(s => s.id !== id)
      return remaining[0]?.id ?? DEFAULT_SLOT.id
    })
  }

  // Reconcile task terminals against live tasks. onDeleteTask tears the
  // binding down synchronously, but if the task is deleted WHILE its launch is
  // still in flight, launchTaskTerminal writes the map entry AFTER that read —
  // so the PTY outlives the task. This effect is the race safety net: any
  // entry whose taskId no longer maps to a live task gets its PTY killed and
  // the binding dropped.
  useEffect(() => {
    if (!data) return
    const taskIds = new Set(data.tasks.map(t => t.id))
    const orphan = Object.keys(taskTerminals).find(id => !taskIds.has(id))
    if (orphan) closeTaskTerminal(orphan)
    // closeTaskTerminal is a stable per-render closure; re-listing it would
    // re-run this every render. Reconciliation depends only on tasks + map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, taskTerminals])

  // Reorder panes by dropping one tab onto another. The slot id is the React
  // key, so React moves the existing TerminalPane instance instead of
  // remounting — the PTY/xterm survive with no reconnect.
  const reorderTerminals = (fromId: string, toId: string) => {
    if (fromId === toId) return
    setTerminalSlots(prev => {
      const from = prev.findIndex(s => s.id === fromId)
      const to = prev.findIndex(s => s.id === toId)
      if (from < 0 || to < 0) return prev
      const next = [...prev]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return next
    })
  }

  // Which pane sits under a given client-x. Used by the pointer-based tab drag
  // to hit-test the drop target.
  const paneIdAtX = (clientX: number): string | null => {
    const row = terminalRowRef.current
    if (!row) return null
    for (const el of Array.from(
      row.querySelectorAll<HTMLElement>('[data-term-slot]'),
    )) {
      const r = el.getBoundingClientRect()
      if (clientX >= r.left && clientX <= r.right) return el.dataset.termSlot ?? null
    }
    return null
  }

  // Drag a pane's header (tab) to reorder. Pointer-based, not HTML5 DnD — the
  // same mousedown→window-listener pattern the dividers use, so it works
  // identically under automation and for real users. A sub-threshold press is
  // treated as a plain focus click (handled by the wrapper's onMouseDown).
  const startTabDrag = (id: string) => (e: React.MouseEvent) => {
    if (e.button !== 0) return
    const startX = e.clientX
    const startY = e.clientY
    let dragging = false
    const onMove = (ev: MouseEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 5 && Math.abs(ev.clientY - startY) < 5)
          return
        dragging = true
        setTermDragId(id)
        document.body.style.userSelect = 'none'
        document.body.style.cursor = 'grabbing'
      }
      setTermDragDX(ev.clientX - startX)
      setTermDragOverId(paneIdAtX(ev.clientX))
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      if (dragging) {
        const over = paneIdAtX(ev.clientX)
        if (over) reorderTerminals(id, over)
      }
      setTermDragId(null)
      setTermDragOverId(null)
      setTermDragDX(0)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Inline rename. Double-click a tab label → editable input; Enter / blur
  // commits a non-empty name, Escape cancels. Persisted via saveSlots.
  const beginRenameTerminal = (slot: TerminalSlot) => {
    setRenamingTermId(slot.id)
    setRenameTermDraft(slot.label)
  }
  const commitRenameTerminal = () => {
    const id = renamingTermId
    if (!id) return
    const label = renameTermDraft.trim()
    setRenamingTermId(null)
    if (label)
      setTerminalSlots(prev =>
        prev.map(s => (s.id === id ? { ...s, label } : s)),
      )
  }

  // Ctrl+Tab cycles forward through the view tabs; Ctrl+Shift+Tab cycles
  // backward. Registered in capture phase so we intercept before xterm — when
  // the terminal pane is focused it would otherwise swallow Tab and forward
  // it to the shell as a literal `\t`.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.key !== 'Tab' || e.metaKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      const i = tabOrder.indexOf(view)
      const step = e.shiftKey ? -1 : 1
      const next = tabOrder[(i + step + tabOrder.length) % tabOrder.length]
      if (next) setView(next)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [view, tabOrder])
  const dataRef = useRef<ProjectData | null>(data)
  dataRef.current = data

  // ── Git-shared data (.openground/ in the repo — docs/SHARED_DATA_PLAN.md) ──
  // The whole feature is driven by ShareStatus | null: null means "unknown"
  // (routes not deployed yet / fetch failed / project switch in flight) and
  // hides every share affordance quietly. The panel is reused across project
  // switches (no key), so every async return is pinned to the path it was
  // requested for — same idiom as describingPath above.
  const [shareStatus, setShareStatus] = useState<ShareStatus | null>(null)
  const shareStatusRef = useRef<ShareStatus | null>(null)
  shareStatusRef.current = shareStatus
  const projectPathRef = useRef<string | null>(null)
  projectPathRef.current = project?.path ?? null
  // Path currently syncing (null = idle) — a stale return must not clear a
  // newer project's in-flight state.
  const [syncingPath, setSyncingPath] = useState<string | null>(null)
  const syncing = !!project && syncingPath === project.path
  // Inline feedback next to the Sync button (the panel has no toast system;
  // the delete flow's inline-error language is the established pattern).
  // Successes auto-fade; errors stay until the next action or project switch.
  const [shareNotice, setShareNotice] = useState<
    { kind: 'ok' | 'error'; text: string } | null
  >(null)
  const shareNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [shareDialog, setShareDialog] = useState<'enable' | 'disable' | null>(null)
  // Conflict-resolution dialog (S15–S20 phase 3): the structured conflicts of
  // the last failed Sync, or null. Only offered when EVERY conflicted file is
  // shared data (.openground/) — the app never auto-resolves the user's code.
  const [conflictDialog, setConflictDialog] = useState<ShareConflict[] | null>(null)
  const [resolving, setResolving] = useState(false)
  const [shareBusy, setShareBusy] = useState(false)
  const [shareDialogError, setShareDialogError] = useState<string | null>(null)
  // Bumped whenever shared files may have changed on disk (after a successful
  // Sync / enable / disable, and on window focus while shared) — ProjectCanvas
  // re-reads the index + active canvas in place when it changes.
  const [canvasReloadToken, setCanvasReloadToken] = useState(0)
  // "Last sync" timestamp (S10): per-project, local-machine memory — gives the
  // assignee/column info on the board a freshness anchor. Shown in the Sync
  // button's tooltip.
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null)
  useEffect(() => {
    if (!project?.path) {
      setLastSyncAt(null)
      return
    }
    const v = Number(localStorage.getItem(`og.share.lastSync.${project.path}`))
    setLastSyncAt(Number.isFinite(v) && v > 0 ? v : null)
  }, [project?.path])
  const formatSyncTime = (ts: number): string => {
    const d = new Date(ts)
    const sameDay = new Date().toDateString() === d.toDateString()
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }
  // ── Auto-sync presentation (ShareStatus.auto) ───────────────────────────
  // When the engine is on, the Sync button reads as a LIVE indicator; the
  // click stays a manual force-sync. All modes degrade to the classic manual
  // button when auto is absent/disabled.
  const auto = shareStatus?.auto
  const autoLive = auto?.enabled === true
  const autoMode: ShareAutoStatus['mode'] | 'manual-syncing' = syncing
    ? 'manual-syncing'
    : (auto?.mode ?? 'disabled')
  const autoLabel =
    autoMode === 'manual-syncing' || autoMode === 'syncing'
      ? t('projectPanel.syncing')
      : autoMode === 'paused-code'
        ? t('projectPanel.autoPausedCode')
        : autoMode === 'conflict'
          ? t('projectPanel.autoConflict')
          : autoMode === 'offline'
            ? t('projectPanel.autoOffline')
            : autoMode === 'blocked'
              ? t('projectPanel.autoBlocked')
              : autoMode === 'error'
                ? t('projectPanel.autoError')
                : t('projectPanel.autoLive')
  const autoTitle =
    autoMode === 'paused-code'
      ? t('projectPanel.autoPausedCodeHint')
      : autoMode === 'conflict'
        ? t('projectPanel.autoConflictHint')
        : autoMode === 'offline'
          ? t('projectPanel.syncOffline')
          : autoMode === 'blocked'
            ? t('projectPanel.autoBlockedHint')
            : autoMode === 'error'
              ? (auto?.message ?? t('projectPanel.autoErrorHint'))
              : t('projectPanel.autoLiveHint')
  const effectiveLastSync = auto?.lastSyncAt ?? lastSyncAt
  // Surface auto-round outcomes the user would otherwise never see (the
  // engine runs without clicks): a conflict or loud error posts a persistent
  // notice ON TRANSITION; recovering clears a stale one.
  const prevAutoModeRef = useRef<string | null>(null)
  useEffect(() => {
    const prev = prevAutoModeRef.current
    prevAutoModeRef.current = autoMode
    if (!autoLive || prev === null || prev === autoMode) return
    if (autoMode === 'conflict') {
      setShareNoticeFading({ kind: 'error', text: t('projectPanel.autoConflictHint') })
    } else if (autoMode === 'error') {
      const msg = auto?.message ?? ''
      setShareNoticeFading({
        kind: 'error',
        text: /stash/i.test(msg)
          ? t('projectPanel.syncAutostashConflict')
          : t('projectPanel.syncFailed', { error: msg || 'auto-sync error' }),
      })
    } else if (prev === 'conflict' || prev === 'error') {
      setShareNoticeFading(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode, autoLive])
  // An auto round just landed new data (lastSyncAt moved): refresh the board
  // immediately (instead of waiting for the 5s poll) and re-read canvases.
  const prevAutoSyncAtRef = useRef<number | null>(null)
  useEffect(() => {
    const at = auto?.lastSyncAt ?? null
    const prev = prevAutoSyncAtRef.current
    prevAutoSyncAtRef.current = at
    if (at === null || prev === at || prev === null) return
    void reloadProjectData()
    setCanvasReloadToken(v => v + 1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto?.lastSyncAt])
  const remoteName = useMemo(
    () => remoteShortName(shareStatus?.remoteUrl ?? null),
    [shareStatus?.remoteUrl],
  )

  const refreshShareStatus = useCallback(async () => {
    const path = project?.path
    if (!path) return
    const status = await fetchShareStatus(path)
    if (projectPathRef.current !== path) return
    // A transient fetch failure (null) must not wipe a known status — that
    // would hide the Sync button and kill the 90s poll until the next focus.
    // Project switches reset the state to null explicitly, so keeping the
    // last-known value here never leaks across projects.
    setShareStatus((prev) => status ?? prev)
  }, [project?.path])

  // Re-read ProjectData from disk after an external change (Sync pulled
  // teammates' edits, or a terminal claude touched .openground/). Skipped when
  // a local edit hasn't flushed through the debounced persist yet — the local
  // save wins and the next focus refetch picks the merge up. Resolves with the
  // data it applied (null on every skip path) so doSync can diff it against
  // its pre-sync snapshot for the board digest.
  const reloadProjectData = useCallback(async (): Promise<ProjectData | null> => {
    const path = project?.path
    if (!path) return null
    try {
      const res = await api.api.project.$get(
        { query: { path } },
        { init: { cache: 'no-store' } },
      )
      if (!res.ok) return null
      const d = (await res.json()) as ProjectData
      if (projectPathRef.current !== path || loadedDataPathRef.current !== path)
        return null
      if (dataRef.current && JSON.stringify(dataRef.current) !== lastSavedJson.current)
        return null
      setData(d)
      lastSavedJson.current = JSON.stringify(d)
      // Keep the Ground card's mirror (description / task counts) fresh too.
      onSaved?.(path, d)
      return d
    } catch {
      /* keep showing the data we have */
      return null
    }
  }, [project?.path, onSaved])

  const setShareNoticeFading = useCallback(
    (notice: { kind: 'ok' | 'error'; text: string } | null) => {
      if (shareNoticeTimer.current) {
        clearTimeout(shareNoticeTimer.current)
        shareNoticeTimer.current = null
      }
      setShareNotice(notice)
      if (notice?.kind === 'ok') {
        shareNoticeTimer.current = setTimeout(() => setShareNotice(null), 5000)
      }
    },
    [],
  )

  // One click: commit (scoped to .openground/) → pull --rebase → push, then
  // pull the freshly-merged data back into the UI.
  const doSync = useCallback(async () => {
    const path = project?.path
    if (!path || syncingPath || project?.missing) return
    setSyncingPath(path)
    setShareNoticeFading(null)
    // Snapshot the board BEFORE the sync so a successful pull can be diffed
    // into a "what changed" digest (boardDiffDigest) for the notice line.
    const beforeTasks = dataRef.current?.tasks ?? null
    try {
      const r = await syncShare(path)
      if (projectPathRef.current !== path) return
      if ('error' in r) {
        setShareNoticeFading({
          kind: 'error',
          text: t('projectPanel.syncFailed', { error: r.error }),
        })
      } else if (r.result.conflict) {
        // Say WHAT conflicted (card titles / notes / canvas files) — the
        // server's message is the raw English fallback for the rest.
        const items = r.result.conflictFiles?.length
          ? t('projectPanel.syncConflictItems', {
              items: r.result.conflictFiles.join(', '),
            })
          : r.result.message
        setShareNoticeFading({
          kind: 'error',
          text: [t('projectPanel.syncConflict'), items].filter(Boolean).join(' — '),
        })
        // Offer in-app resolution ONLY for pure shared-data conflicts — a
        // conflicted code file is the user's own rebase to run.
        const cs = r.result.conflicts
        if (cs?.length && cs.every(c => c.file.startsWith('.openground/'))) {
          setConflictDialog(cs)
        }
      } else if (!r.result.ok) {
        // Machine-readable reasons get a localized, actionable line; anything
        // else falls back to the server's raw message. Error notices persist
        // (no auto-fade) — an autostash conflict must never slip by unseen.
        const reasonTexts: Record<string, string> = {
          'rebase-in-progress': t('projectPanel.syncBlockedRebase'),
          'merge-in-progress': t('projectPanel.syncBlockedMerge'),
          'detached-head': t('projectPanel.syncBlockedDetached'),
          'autostash-conflict': t('projectPanel.syncAutostashConflict'),
          'no-identity': t('projectPanel.syncNoIdentity'),
        }
        const reasonText = r.result.reason ? reasonTexts[r.result.reason] : undefined
        setShareNoticeFading({
          kind: 'error',
          text:
            reasonText ??
            t('projectPanel.syncFailed', { error: r.result.message ?? 'sync error' }),
        })
        // An autostash conflict still pulled — show the merged board, not the
        // pre-sync snapshot.
        if (r.result.pulled) {
          await reloadProjectData()
          setCanvasReloadToken(v => v + 1)
        }
      } else {
        // ok — pull the freshly-merged data back in first, then say WHAT the
        // pull changed on the board (added/done/moved/removed cards) instead
        // of the generic "Synced". Falls back to the generic text when the
        // pull brought nothing board-visible (or the refetch was skipped),
        // and keeps any caveat message (e.g. push skipped: no upstream).
        const reloaded = await reloadProjectData()
        setCanvasReloadToken(v => v + 1)
        const digest =
          r.result.pulled && beforeTasks && reloaded
            ? boardDiffDigest(beforeTasks, reloaded.tasks ?? [], t)
            : null
        // Localized lines for the classified degradations replace the raw
        // git notes; an unclassified note still shows verbatim as a caveat.
        const caveat = r.result.offline
          ? t('projectPanel.syncOffline')
          : r.result.noRemote
            ? t('projectPanel.syncNoRemote')
            : r.result.message
        // Remember when this machine last synced (the tooltip's freshness line).
        const now = Date.now()
        localStorage.setItem(`og.share.lastSync.${path}`, String(now))
        setLastSyncAt(now)
        if (r.result.forcedUpdate) {
          // A rewritten upstream deserves a persistent warning, not a 5s toast.
          setShareNoticeFading({
            kind: 'error',
            text: [t('projectPanel.syncForcedUpdate'), digest]
              .filter((s): s is string => !!s)
              .join(' — '),
          })
        } else {
          const parts = [digest, caveat].filter((s): s is string => !!s)
          setShareNoticeFading({
            kind: r.result.offline ? 'error' : 'ok',
            text: parts.length > 0 ? parts.join(' — ') : t('projectPanel.syncDone'),
          })
        }
      }
      // Whatever happened, the dirty dot may have changed (commit succeeded
      // even when push didn't, etc.) — re-read the truth.
      void refreshShareStatus()
    } finally {
      setSyncingPath(p => (p === path ? null : p))
    }
  }, [
    project?.path,
    project?.missing,
    syncingPath,
    t,
    setShareNoticeFading,
    reloadProjectData,
    refreshShareStatus,
  ])

  // Confirm in the share / unshare dialog → POST enable|disable, then refetch
  // everything (status decides which UI shows; data + canvases changed source).
  // Confirm in the conflict-resolution dialog → POST resolve with the chosen
  // side per file. Success closes the dialog and reloads the merged data; a
  // FRESH conflict set (files changed since the dialog opened) re-populates
  // the dialog instead of dumping the user back to the manual path.
  const confirmResolve = useCallback(
    async (choices: Record<string, 'mine' | 'theirs'>) => {
      const path = project?.path
      if (!path || resolving) return
      setResolving(true)
      try {
        const r = await resolveShare(path, choices)
        if (projectPathRef.current !== path) return
        if ('error' in r) {
          setConflictDialog(null)
          setShareNoticeFading({
            kind: 'error',
            text: t('projectPanel.syncFailed', { error: r.error }),
          })
          return
        }
        if (r.result.conflict) {
          const cs = r.result.conflicts
          if (cs?.length && cs.every(c => c.file.startsWith('.openground/'))) {
            setConflictDialog(cs)
          } else {
            setConflictDialog(null)
            setShareNoticeFading({
              kind: 'error',
              text: [t('projectPanel.syncConflict'), r.result.message]
                .filter(Boolean)
                .join(' — '),
            })
          }
          return
        }
        setConflictDialog(null)
        if (!r.result.ok) {
          const reasonTexts: Record<string, string> = {
            'rebase-in-progress': t('projectPanel.syncBlockedRebase'),
            'merge-in-progress': t('projectPanel.syncBlockedMerge'),
            'detached-head': t('projectPanel.syncBlockedDetached'),
            'autostash-conflict': t('projectPanel.syncAutostashConflict'),
            'no-identity': t('projectPanel.syncNoIdentity'),
          }
          const reasonText = r.result.reason ? reasonTexts[r.result.reason] : undefined
          setShareNoticeFading({
            kind: 'error',
            text:
              reasonText ?? t('projectPanel.syncFailed', { error: r.result.message ?? 'sync error' }),
          })
          if (r.result.pulled) {
            await reloadProjectData()
            setCanvasReloadToken(v => v + 1)
          }
          return
        }
        await reloadProjectData()
        setCanvasReloadToken(v => v + 1)
        const now = Date.now()
        localStorage.setItem(`og.share.lastSync.${path}`, String(now))
        setLastSyncAt(now)
        setShareNoticeFading({
          kind: 'ok',
          text: [t('projectPanel.syncResolvedDone'), r.result.message]
            .filter((s): s is string => !!s)
            .join(' — '),
        })
        void refreshShareStatus()
      } finally {
        setResolving(false)
      }
    },
    [project?.path, resolving, t, setShareNoticeFading, reloadProjectData, refreshShareStatus],
  )

  const confirmShareDialog = useCallback(async () => {
    const path = project?.path
    const mode = shareDialog
    if (!path || !mode || shareBusy) return
    setShareBusy(true)
    setShareDialogError(null)
    try {
      const r = mode === 'enable' ? await enableShare(path) : await disableShare(path)
      if (projectPathRef.current !== path) return
      if (!r.ok) {
        setShareDialogError(r.error)
        return
      }
      setShareDialog(null)
      await refreshShareStatus()
      await reloadProjectData()
      setCanvasReloadToken(v => v + 1)
      // Enable migrates the data but deliberately commits nothing — the first
      // Sync publishes it. Say so, or the user stares at a dirty dot (S1).
      if (mode === 'enable') {
        setShareNoticeFading({ kind: 'ok', text: t('projectPanel.shareEnabledNotice') })
      }
    } finally {
      setShareBusy(false)
    }
  }, [project?.path, shareDialog, shareBusy, refreshShareStatus, reloadProjectData, t, setShareNoticeFading])

  // Fetch the status when a project opens (and reset all share UI state so
  // nothing leaks across a project switch).
  useEffect(() => {
    setShareStatus(null)
    setShareNoticeFading(null)
    setShareDialog(null)
    setShareDialogError(null)
    setConflictDialog(null)
    if (!project?.path) return
    void refreshShareStatus()
    // refreshShareStatus is recreated with project?.path — listing it here
    // would double-run the effect for the same path.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path])

  // Window focus while the panel is open: re-check the share status and
  // refetch the project data (a terminal claude may have added board cards via
  // the API in ANY mode — see the launch-time app context in claudeTerminal —
  // and in shared mode a teammate's pull may have edited .openground/).
  // Canvases refetch only while shared (their writers are git/the app).
  // Debounced so a tab-switch flurry doesn't hammer the server.
  const lastFocusRefetchRef = useRef(0)
  useEffect(() => {
    if (!project?.path) return
    const onFocus = () => {
      const now = Date.now()
      if (now - lastFocusRefetchRef.current < 3000) return
      lastFocusRefetchRef.current = now
      void refreshShareStatus()
      void reloadProjectData()
      if (shareStatusRef.current?.shared) {
        setCanvasReloadToken(v => v + 1)
      }
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [project?.path, refreshShareStatus, reloadProjectData])

  // Remote awareness while shared: re-check the share status every 90s while
  // the window is visible, so the Sync button's ↓ badge appears when a
  // teammate pushes even if the user never refocuses the window. The server
  // throttles the underlying `git fetch` to one per minute per project, so
  // this stays cheap; hidden windows skip the tick entirely.
  useEffect(() => {
    if (!project?.path || !shareStatus?.shared) return
    // Auto-sync on: the status poll is also the live-indicator heartbeat —
    // tighter (the server side stays cheap: fetches are engine-throttled).
    const everyMs = shareStatus.auto?.enabled ? 20_000 : 90_000
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refreshShareStatus()
    }, everyMs)
    return () => clearInterval(id)
  }, [project?.path, shareStatus?.shared, shareStatus?.auto?.enabled, refreshShareStatus])

  // Live board: while the panel is open and visible, poll the project data
  // every 5s so cards added from OUTSIDE this window — chiefly a terminal
  // claude calling POST /api/project/tasks — appear without any user action.
  // reloadProjectData skips itself while local edits are unsaved, so the poll
  // can never clobber typing; a local GET is effectively free.
  useEffect(() => {
    if (!project?.path) return
    const tick = () => {
      if (document.hidden) return
      void reloadProjectData()
    }
    const iv = setInterval(tick, 5000)
    return () => clearInterval(iv)
  }, [project?.path, reloadProjectData])

  // Clear the fade timer on unmount so it can't fire into an unmounted panel.
  useEffect(() => {
    return () => {
      if (shareNoticeTimer.current) clearTimeout(shareNoticeTimer.current)
    }
  }, [])

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
        alert(t('projectPanel.pickFailed', { error: d.error }))
        return
      }
      addOpenApp({ name: d.name, path: d.path, mode: d.mode ?? 'open' })
    } catch (e: any) {
      alert(t('projectPanel.pickFailed', { error: e?.message ?? t('projectPanel.networkError') }))
    }
  }
  const openIn = async (app: OpenApp) => {
    setOpenMenuOpen(false)
    if (!project) return
    if (project.missing) {
      alert(t('projectPanel.folderGone'))
      return
    }
    try {
      const res = await api.api.project.open.$post({
        json: { path: project.path, app: app.name },
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        alert(t('projectPanel.openFailed', { error: e.error ?? res.statusText }))
      }
    } catch (e: any) {
      alert(t('projectPanel.openFailed', { error: e?.message ?? t('projectPanel.networkError') }))
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

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg-card">
      {/* flex-wrap: when the window is too narrow to fit the title column and
          the controls cluster side by side, the controls drop to their own row
          below instead of crushing the title / overflowing the viewport. */}
      <header className="rule-double flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-8 pt-5 pb-4">
        {/* flex-1 so this column has a definite width: the description box caps
            at max-w-[560px] in BOTH read and edit modes. Without it the column
            shrank to its content, so swapping the wide <p> for a <textarea>
            (narrow intrinsic width) collapsed the whole box to ~190px.
            basis-[280px] is the width the title block defends before the
            controls cluster wraps below it. */}
        <div className="min-w-0 flex-1 basis-[280px]">
          <button
            onClick={onClose}
            className="flex items-center gap-1 label-cap text-accent transition-colors hover:text-ink"
          >
            <ChevronLeft size={11} strokeWidth={2.5} /> {t('projectPanel.backToGround')}
          </button>
          <div className="flex min-w-0 items-center gap-2.5">
            <EditableTitle
              name={project.name}
              size="fullscreen"
              onRename={onRename ? (next) => onRename(project, next) : undefined}
            />
            {/* Frequently used, so it's a standalone one-click button next to the
                title rather than buried in the ⋯ menu. Label/tooltip follows the
                host OS (Finder / Explorer / file manager). */}
            <button
              onClick={revealInFinder}
              disabled={project.missing}
              title={t(revealLabelKey())}
              aria-label={t(revealLabelKey())}
              className="shrink-0 rounded-sm p-1 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint"
            >
              <FolderOpen size={16} strokeWidth={1.75} />
            </button>
          </div>
          {data && (
            data.description ? (
              /* ── Filled state: refresh button LEFT, then the generated text.
                    The description is generate-only (no manual editing) — the
                    text swaps in when claude finishes, persisted server-side. ── */
              <div className="mt-2 flex max-w-[560px] items-start gap-1.5">
                {/* Refresh button — spins while claude works */}
                <button
                  onClick={regenerateDescription}
                  disabled={describing || project.missing || claudeMissing}
                  title={
                    claudeMissing
                      ? t('projectPanel.claudeNotFound')
                      : describing
                        ? t('projectPanel.generating')
                        : t('projectPanel.regenerateDescription')
                  }
                  aria-label={t('projectPanel.regenerateDescription')}
                  className="mt-0.5 shrink-0 rounded-sm p-0.5 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint"
                >
                  {describing ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <RotateCw size={11} />
                  )}
                </button>
                <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-ink-muted">
                  {descriptionForLang(data, lang)}
                </p>
              </div>
            ) : (
              /* ── Empty state: a plain text-only generate button (no icon) ── */
              <div className="mt-2">
                <button
                  onClick={regenerateDescription}
                  disabled={describing || project.missing || claudeMissing}
                  title={
                    claudeMissing
                      ? t('projectPanel.claudeNotFound')
                      : describing
                        ? t('projectPanel.generating')
                        : t('projectPanel.generateDescription')
                  }
                  aria-label={t('projectPanel.generateDescription')}
                  className="rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
                >
                  {describing
                    ? t('projectPanel.generating')
                    : t('projectPanel.generateDescription')}
                </button>
              </div>
            )
          )}
        </div>
        {/* ml-auto keeps the cluster right-aligned even when flex-wrap moves
            it onto its own row; inner flex-wrap lets the share strip / HUD /
            feedback button flow onto further rows on very narrow windows. */}
        <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
          {/* Git share: a quiet text-only Sync button (dot = unsynced local
              changes) + the remote's short name as faint context. Lives with
              the project-scoped header controls; hidden entirely unless the
              project is actually shared. */}
          {shareStatus?.shared && (
            <div className="flex min-w-0 items-center gap-2">
              {shareNotice && (
                <span
                  role="status"
                  className={[
                    // Errors carry the actionable detail (conflicted card
                    // names, recovery steps) — give them room; the full text
                    // is always on the tooltip either way.
                    shareNotice.kind === 'error'
                      ? 'max-w-[480px] text-accent'
                      : 'max-w-[260px] text-ink-faint',
                    'truncate text-[11px] transition-opacity duration-150',
                  ].join(' ')}
                  title={shareNotice.text}
                >
                  {shareNotice.text}
                </span>
              )}
              {remoteName && (
                <span
                  title={shareStatus.remoteUrl ?? undefined}
                  className="max-w-[160px] truncate font-mono text-[10px] text-ink-faint"
                >
                  {remoteName}
                </span>
              )}
              {/* Shared data follows the checked-out branch (S27) — name the
                  branch so a switch explains a suddenly-different board. */}
              {shareStatus.branch && (
                <span
                  title={t('projectPanel.syncBranchHint')}
                  className="flex max-w-[140px] items-center gap-0.5 font-mono text-[10px] text-ink-faint"
                >
                  <GitBranch size={10} className="shrink-0" aria-hidden />
                  <span className="truncate">{shareStatus.branch}</span>
                </span>
              )}
              <button
                type="button"
                onClick={() => void doSync()}
                disabled={syncing || project.missing}
                title={[
                  autoLive
                    ? autoTitle
                    : shareStatus.forcedUpdate
                      ? t('projectPanel.syncForcedHint')
                      : shareStatus.behind > 0
                        ? t('projectPanel.syncBehindHint', { count: shareStatus.behind })
                        : shareStatus.dirty || shareStatus.ahead > 0
                          ? t('projectPanel.syncDirtyHint')
                          : t('projectPanel.syncHint'),
                  effectiveLastSync
                    ? t('projectPanel.syncLastAt', { time: formatSyncTime(effectiveLastSync) })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                className="flex shrink-0 items-center gap-1.5 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
              >
                {/* Auto-sync on: the button reads as a LIVE indicator (the
                    click is still a manual force-sync). Auto-sync off: the
                    classic Sync button. */}
                {autoLive ? (
                  <>
                    <span
                      aria-hidden
                      className={[
                        'h-[5px] w-[5px] shrink-0 rounded-full',
                        autoMode === 'live' ? 'bg-moss' : 'bg-accent',
                      ].join(' ')}
                    />
                    {autoLabel}
                  </>
                ) : (
                  <>
                    {shareStatus.dirty && !syncing && (
                      <span
                        aria-hidden
                        className="h-[5px] w-[5px] shrink-0 rounded-full bg-accent"
                      />
                    )}
                    {syncing ? t('projectPanel.syncing') : t('projectPanel.sync')}
                  </>
                )}
                {/* Unpushed (↑) / incoming (↓) commit counts, scoped to
                    .openground/. ↓ is the "a teammate pushed — pull me"
                    signal, so it reads in accent. Under auto-sync these only
                    linger in the paused/parked modes — live mode drains them. */}
                {!syncing && shareStatus.ahead > 0 && (
                  <span aria-hidden className="tabular-nums text-[10px] text-ink-faint">
                    ↑{shareStatus.ahead}
                  </span>
                )}
                {!syncing && shareStatus.behind > 0 && (
                  <span aria-hidden className="tabular-nums text-[10px] text-accent">
                    ↓{shareStatus.behind}
                  </span>
                )}
                {/* Rewritten upstream (force-push) — warn before the pull. */}
                {!syncing && shareStatus.forcedUpdate && (
                  <span aria-hidden className="text-[10px] text-accent">
                    ⚠
                  </span>
                )}
              </button>
            </div>
          )}
          {/* Mirrors the Ground's top-right usage strip — model + token gauge,
              kept visible while working inside a project so the user always
              knows how close they are to the rate-limit cap. */}
          <UsageHud />
          {/* Beta: feedback is surfaced prominently (labelled button), not
              hidden in a menu, so it's easy to send from inside a project. */}
          {feedbackEnabled && (
            <button
              type="button"
              onClick={() => setFeedbackOpen(true)}
              title={t('toolbar.feedback')}
              className="flex items-center gap-1.5 rounded-[3px] border border-line px-2.5 py-1 text-[12px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <MessageSquare size={13} strokeWidth={1.75} />
              {/* Narrow window: icon only (the title attr still carries the label). */}
              <span className="hidden md:inline">{t('toolbar.feedback')}</span>
            </button>
          )}
          <div className="flex items-center gap-0.5">
            <MoreMenu
              onProjectSettings={() => setProjectSettingsOpen(true)}
              projectSettingsDisabled={!data}
              onRemove={() => onRemove(project)}
              onDelete={() => setConfirmingDelete(true)}
              share={
                shareStatus
                  ? {
                      status: shareStatus,
                      missing: !!project.missing,
                      onShare: () => {
                        setShareDialogError(null)
                        setShareDialog('enable')
                      },
                      onUnshare: () => {
                        setShareDialogError(null)
                        setShareDialog('disable')
                      },
                    }
                  : null
              }
            />
            <IconButton title={t('common.close')} onClick={onClose}>
              <X size={15} strokeWidth={1.75} />
            </IconButton>
          </div>
        </div>
      </header>

      {project.missing && (
        <div className="flex items-start gap-2 border-b border-accent/30 bg-accent/5 px-8 py-2.5">
          <AlertCircle size={14} className="mt-[1px] shrink-0 text-accent" />
          <div className="flex flex-1 flex-col items-start gap-1.5">
            <p className="text-[11.5px] leading-relaxed text-ink-muted">
              {t('projectPanel.missingBanner')}
            </p>
            {onRelocate && (
              <Btn
                variant="ghost"
                size="xs"
                onClick={() => onRelocate(project.id)}
                title={t('projectPanel.locateFolderHint')}
              >
                {t('projectPanel.locateFolder')}
              </Btn>
            )}
          </div>
        </div>
      )}

      <ViewTabs
        view={view}
        onChange={setView}
        order={tabOrder}
        onReorder={reorderTabs}
        terminalInfo={terminalInfo}
      />

      {/* Content + assistant. The assistant is either the bottom dock (a child
          at the end of the content column) or a right sidebar (a push panel
          beside the content column) — flipped via the in-panel toggle. */}
      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      {view === 'terminal' ? (
        // Dark like the panes themselves: the "+ New" column (and any slack)
        // must read as terminal surface, not as the app's light background
        // bleeding through.
        <div className="min-h-0 flex-1 flex bg-[#1a1a1a]">
          <div
            ref={terminalRowRef}
            className="min-h-0 min-w-0 flex-1 flex overflow-x-auto"
          >
          {terminalSlots.map(slot => {
            const active = slot.id === activeTerminalSlot
            const canClose = terminalSlots.length > 1
            const isDropTarget = termDragOverId === slot.id && termDragId !== slot.id
            return (
              <div
                key={slot.id}
                data-term-slot={slot.id}
                onMouseDown={() => setActiveTerminalSlot(slot.id)}
                // Count-based tiling: 1 pane fills the row, 2 halve it, 3
                // third it, 4 quarter it; a 5th+ keeps the quarter width and
                // slides into the horizontal scroll.
                style={{
                  width: `${paneWidthPct(terminalSlots.length)}%`,
                  flex: '0 0 auto',
                }}
                className="relative flex min-w-0 flex-col border-r border-line bg-[#1a1a1a]"
              >
                {/* Drop-position indicator while reordering tabs. */}
                {isDropTarget && (
                  <div className="pointer-events-none absolute inset-y-0 left-0 z-20 w-[2px] bg-accent" />
                )}
                {/* Pane header doubles as the draggable tab (pointer-based).
                 *  Dark, terminal-native colours so the active tab reads clearly
                 *  against the #1a1a1a body; the dragged tab slides under the
                 *  cursor via translateX; double-click the label to rename. */}
                <div
                  onMouseDown={
                    renamingTermId === slot.id ? undefined : startTabDrag(slot.id)
                  }
                  style={
                    termDragId === slot.id
                      ? { transform: `translateX(${termDragDX}px)` }
                      : undefined
                  }
                  className={[
                    'group/term relative flex shrink-0 select-none items-center gap-1.5 border-b-2 px-2.5 py-1.5 text-[11px] transition-colors',
                    termDragId === slot.id
                      ? 'z-30 cursor-grabbing opacity-95 shadow-lg'
                      : 'cursor-grab',
                    active
                      ? 'border-b-accent bg-[#2e2e2e] text-white'
                      : 'border-b-[#272727] bg-[#1c1c1c] text-[#7c7c7c] hover:bg-[#242424] hover:text-[#d4d4d4]',
                  ].join(' ')}
                >
                  <Terminal
                    size={11}
                    strokeWidth={2}
                    className={active ? 'shrink-0 text-accent' : 'shrink-0'}
                  />
                  {renamingTermId === slot.id ? (
                    <input
                      autoFocus
                      value={renameTermDraft}
                      onChange={e => setRenameTermDraft(e.target.value)}
                      onMouseDown={e => e.stopPropagation()}
                      onBlur={commitRenameTerminal}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          commitRenameTerminal()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          setRenamingTermId(null)
                        }
                      }}
                      className="min-w-0 flex-1 border-b border-accent bg-transparent text-white outline-none"
                    />
                  ) : (
                    <span
                      onDoubleClick={e => {
                        e.stopPropagation()
                        beginRenameTerminal(slot)
                      }}
                      // Show the full label on hover (it truncates in a narrow
                      // pane) + the rename affordance.
                      title={`${slot.label}\n(${t('projectPanel.renameTerminal')})`}
                      className="min-w-0 flex-1 truncate"
                    >
                      {slot.label}
                    </span>
                  )}
                  {canClose && (
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => {
                        e.stopPropagation()
                        void closeTerminal(slot.id)
                      }}
                      title={t('projectPanel.closeTerminal')}
                      className={[
                        'rounded-[2px] p-0.5 transition-opacity hover:text-accent',
                        active
                          ? 'text-white/60 opacity-100'
                          : 'text-[#666] opacity-0 group-hover/term:opacity-100',
                      ].join(' ')}
                    >
                      <X size={11} strokeWidth={2} />
                    </button>
                  )}
                </div>
                <div className="min-h-0 flex-1">
                  <TerminalPane
                    key={slot.id}
                    projectPath={project.path}
                    slotKey={slot.id}
                    onInfo={inf => {
                      terminalInfoMapRef.current[slot.id] = inf
                      if (activeTerminalSlotRef.current === slot.id)
                        setTerminalInfo(inf)
                    }}
                  />
                </div>
              </div>
            )
          })}
          </div>
          {/* "+ New" sits at the strip's right edge OUTSIDE the scroll row
           *  (like a browser tab bar's trailing +): always reachable without
           *  scrolling, and the pane percentages split the scroll area into
           *  exact halves/thirds/quarters. */}
          <div className="flex shrink-0 flex-col">
            <button
              onClick={addTerminal}
              disabled={terminalSlots.length >= MAX_TERMINALS}
              title={t('projectPanel.newTerminal')}
              className="flex shrink-0 select-none items-center gap-1 border-b-2 border-b-[#272727] bg-[#1c1c1c] px-2.5 py-1.5 text-[11px] text-[#7c7c7c] transition-colors hover:bg-[#242424] hover:text-[#d4d4d4] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-[#1c1c1c] disabled:hover:text-[#7c7c7c]"
            >
              <Plus size={11} strokeWidth={2.25} />
              <span>{t('projectPanel.new')}</span>
            </button>
          </div>
        </div>
      ) : view === 'canvas' ? (
        <div className="flex min-h-0 flex-1">
          <div className="min-h-0 flex-1">
            <ProjectCanvas
              projectPath={project.path}
              reloadToken={canvasReloadToken}
            />
          </div>
          {/* Terminal-only mode: tabbed raw claude terminals to drive design
           *  work. */}
          <TerminalDock
            key="dock-canvas"
            projectPath={project.path}
            context="canvas"
            hint={t('projectPanel.canvasDockHint')}
          />
        </div>
      ) : loading || !data ? (
        <div className="flex-1 px-8 py-6 text-[12px] text-ink-subtle">{t('projectPanel.loading')}</div>
      ) : view === 'board' ? (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <BoardModule
          data={data}
          project={project}
          persist={persist}
          detailId={boardDetailId}
          onOpenDetail={setBoardDetailId}
          // A card with a launched terminal counts as "touched" — the drawer's
          // close-discards-empty-card check must not drop it.
          hasTerminalSlot={id => id in taskTerminals}
          // Delete lives in the drawer HEADER (next to ×), not floating in the
          // conversation pane.
          onDeleteTask={id => {
            // Tear the task's terminal down with it — else its claude PTY
            // orphans as an idle process nothing renders.
            closeTaskTerminal(id)
            if (data) persist({ ...data, tasks: data.tasks.filter(t => t.id !== id) })
          }}
          // Draft mode's Launch bar — same launch as the card ▶.
          onLaunchTask={launchTaskTerminal}
          // The task's session lives ONLY here in the drawer (board-scoped
          // taskTerminals map) — a raw PTY terminal, works on the
          // subscription, no JSONL. The Terminal tab is plain shells.
          renderConversation={(task) => {
            const ptyId = taskTerminals[task.id]
            const liveId =
              ptyId && !exitedTaskTerminals.has(task.id) ? ptyId : null
            return (
              <BoardTaskTerminal
                terminalId={liveId}
                onLaunch={() => launchTaskTerminal(task)}
                onExit={() => markTaskTerminalExited(task.id)}
              />
            )
          }}
        />
          </div>
          {/* Plain raw-claude terminal sidebar for the Board (same dock as
           *  Canvas). No board context is injected — it's just `claude` in
           *  the project dir, like opening a terminal here. Distinct key +
           *  context so it never shares state with the canvas dock. */}
          <TerminalDock
            key="dock-board"
            projectPath={project.path}
            context="board"
            hint={t('projectPanel.boardDockHint')}
          />
        </div>
      ) : null}
      </div>
      </div>

      {projectSettingsOpen && data && (
        <ProjectSettingsDialog
          projectName={project.name}
          data={data}
          onCancel={() => setProjectSettingsOpen(false)}
          onSave={(config, launch) => {
            persist({ ...data, config, launch })
            setProjectSettingsOpen(false)
          }}
        />
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

      {shareDialog && (
        <ShareConfirm
          mode={shareDialog}
          busy={shareBusy}
          error={shareDialogError}
          onCancel={() => {
            setShareDialog(null)
            setShareDialogError(null)
          }}
          onConfirm={() => void confirmShareDialog()}
        />
      )}

      {conflictDialog && (
        <ConflictResolveDialog
          // Re-key on the file set so a FRESH conflict batch resets choices.
          key={conflictDialog.map(c => c.file).join('|')}
          conflicts={conflictDialog}
          busy={resolving}
          onCancel={() => setConflictDialog(null)}
          onConfirm={choices => void confirmResolve(choices)}
        />
      )}

      {feedbackEnabled && (
        <FeedbackModal
          open={feedbackOpen}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
    </div>
  )
}

// Sync conflict resolution — per conflicted file, keep MY version or take the
// TEAMMATE's (the losing version stays in git history either way). Same
// full-panel overlay language as DeleteConfirm/ShareConfirm. Card conflicts
// show both titles; the delete side of a delete/modify conflict is labelled —
// choosing it deletes the card.
const ConflictResolveDialog = ({
  conflicts,
  busy,
  onCancel,
  onConfirm,
}: {
  conflicts: ShareConflict[]
  busy: boolean
  onCancel: () => void
  onConfirm: (choices: Record<string, 'mine' | 'theirs'>) => void
}) => {
  const { t } = useT()
  // Default to keeping the user's own version — the safe, predictable side.
  const [choices, setChoices] = useState<Record<string, 'mine' | 'theirs'>>(() =>
    Object.fromEntries(conflicts.map(c => [c.file, 'mine' as const])),
  )
  const sideButton = (
    c: ShareConflict,
    side: 'mine' | 'theirs',
  ): ReactNode => {
    const info = side === 'mine' ? c.mine : c.theirs
    const active = choices[c.file] === side
    const base = side === 'mine' ? t('projectPanel.syncResolveMine') : t('projectPanel.syncResolveTheirs')
    const detail = !info.exists
      ? t('projectPanel.syncResolveDeleted')
      : info.title ?? null
    return (
      <button
        type="button"
        aria-pressed={active}
        onClick={() => setChoices(prev => ({ ...prev, [c.file]: side }))}
        disabled={busy}
        className={[
          'min-w-0 flex-1 rounded-[4px] border px-2.5 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50',
          active
            ? 'border-accent bg-accent text-bg-card'
            : 'border-line text-ink-muted hover:bg-bg-inset hover:text-ink',
        ].join(' ')}
      >
        <span className="block text-[11px] font-medium">{base}</span>
        {detail && (
          <span
            className={[
              'mt-0.5 block truncate text-[11px]',
              active ? 'text-bg-card/85' : 'text-ink-faint',
            ].join(' ')}
          >
            {detail}
          </span>
        )}
      </button>
    )
  }
  return (
    <div
      data-esc-overlay
      className="absolute inset-0 z-20 flex flex-col justify-center gap-5 overflow-y-auto bg-bg-card px-6 py-8"
    >
      <div className="mx-auto w-full max-w-[480px]">
        <p className="label-cap text-accent mb-2">{t('projectPanel.syncResolveLabel')}</p>
        <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
          {t('projectPanel.syncResolveTitle')}
        </h3>
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
          {t('projectPanel.syncResolveExplain')}
        </p>
        <div className="mt-4 max-h-[45vh] space-y-3 overflow-y-auto pr-1">
          {conflicts.map(c => (
            <div key={c.file} className="rounded-[4px] border border-line p-3">
              <p className="truncate text-[12px] text-ink" title={c.file}>
                {c.label}
              </p>
              <div className="mt-2 flex gap-2">
                {sideButton(c, 'mine')}
                {sideButton(c, 'theirs')}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2">
          <Btn variant="subtle" size="md" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Btn>
          <Btn variant="primary" size="md" onClick={() => onConfirm(choices)} disabled={busy}>
            {busy ? t('projectPanel.syncResolveWorking') : t('projectPanel.syncResolveConfirm')}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// Share / unshare confirmation. Same modal language as DeleteConfirm (the
// panel's established pattern): full-panel overlay, label-cap heading, one
// short explanation paragraph, inline error, subtle-cancel + primary-confirm.
const ShareConfirm = ({
  mode,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  mode: 'enable' | 'disable'
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) => {
  const { t } = useT()
  const k = mode === 'enable' ? 'share' : 'unshare'
  return (
    <div data-esc-overlay className="absolute inset-0 z-20 flex flex-col justify-center gap-5 bg-bg-card px-6">
      <div className="mx-auto w-full max-w-[420px]">
        <p className="label-cap text-accent mb-2">
          {t(`projectPanel.${k}DialogLabel`)}
        </p>
        <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
          {t(`projectPanel.${k}DialogTitle`)}
        </h3>
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
          {t(`projectPanel.${k}DialogExplain`)}
        </p>
        {error && (
          <p className="mt-3 text-[11px] leading-relaxed text-accent">
            {t('projectPanel.shareFailed', { error })}
          </p>
        )}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Btn variant="subtle" size="md" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Btn>
          <Btn variant="primary" size="md" onClick={onConfirm} disabled={busy}>
            {busy
              ? t('projectPanel.shareWorking')
              : t(`projectPanel.${k}Confirm`)}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// Project settings — edits BOTH per-project layers in one dialog, clearly
// separated: the SHARED policy (ProjectData.config — travels with the board,
// both collaborators see it) and the PERSONAL launch prefs (ProjectData.launch
// — stored centrally, never synced). Same full-panel overlay language as
// DeleteConfirm/ShareConfirm; drafts are local, Save persists, Cancel discards.
const FIELD_INPUT_CSS =
  'w-full rounded-[3px] border border-line bg-bg px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-faint transition-colors focus:border-accent focus:outline-none'

const ProjectSettingsDialog = ({
  projectName,
  data,
  onCancel,
  onSave,
}: {
  projectName: string
  data: ProjectData
  onCancel: () => void
  onSave: (config: ProjectConfig, launch: ProjectLaunchPrefs) => void
}) => {
  const { t } = useT()
  // Shared policy drafts
  const [flow, setFlow] = useState<'merge' | 'pr'>(
    data.config?.completionFlow ?? 'merge',
  )
  const [targetBranch, setTargetBranch] = useState(data.config?.targetBranch ?? '')
  const [verifyText, setVerifyText] = useState(
    (data.config?.verifyCommands ?? []).join('\n'),
  )
  const [reviewCol, setReviewCol] = useState(!!data.config?.reviewColumn)
  const [membersText, setMembersText] = useState(
    (data.config?.members ?? []).join('\n'),
  )
  // Personal drafts
  const [permissionMode, setPermissionMode] = useState<
    NonNullable<ProjectLaunchPrefs['permissionMode']>
  >(data.launch?.permissionMode ?? 'default')
  const [model, setModel] = useState(data.launch?.model ?? '')
  const [autoSync, setAutoSync] = useState(data.launch?.autoSync !== false)

  const save = () => {
    const verifyCommands = verifyText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    const members = membersText
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
    const config: ProjectConfig = {
      ...data.config,
      completionFlow: flow,
      targetBranch: targetBranch.trim() || undefined,
      verifyCommands: verifyCommands.length > 0 ? verifyCommands : undefined,
      reviewColumn: reviewCol || undefined,
      members: members.length > 0 ? members : undefined,
    }
    const launch: ProjectLaunchPrefs = {
      ...data.launch,
      permissionMode: permissionMode === 'default' ? undefined : permissionMode,
      model: model.trim() || undefined,
      // Default ON — only an explicit opt-out is stored.
      autoSync: autoSync ? undefined : false,
    }
    onSave(config, launch)
  }

  const permissionOptions: {
    value: NonNullable<ProjectLaunchPrefs['permissionMode']>
    labelKey:
      | 'projectPanel.settingsPermDefault'
      | 'projectPanel.settingsPermAcceptEdits'
      | 'projectPanel.settingsPermPlan'
      | 'projectPanel.settingsPermBypass'
  }[] = [
    { value: 'default', labelKey: 'projectPanel.settingsPermDefault' },
    { value: 'acceptEdits', labelKey: 'projectPanel.settingsPermAcceptEdits' },
    { value: 'plan', labelKey: 'projectPanel.settingsPermPlan' },
    { value: 'bypass', labelKey: 'projectPanel.settingsPermBypass' },
  ]

  return (
    <div data-esc-overlay className="absolute inset-0 z-20 flex flex-col justify-center gap-5 overflow-y-auto bg-bg-card px-6 py-8">
      <div className="mx-auto my-auto w-full max-w-[440px]">
        <p className="label-cap text-accent mb-2">
          {t('projectPanel.settingsDialogLabel')}
        </p>
        <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
          {projectName}
        </h3>

        {/* ── Shared policy ── */}
        <div className="mt-5 border-t border-line pt-4">
          <p className="label-cap text-ink">{t('projectPanel.settingsSharedHeading')}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
            {t('projectPanel.settingsSharedHint')}
          </p>

          <div className="mt-3 space-y-3.5">
            <div>
              <label className="mb-1.5 block label-cap text-ink-muted">
                {t('projectPanel.settingsCompletionFlow')}
              </label>
              <div className="flex items-center gap-4">
                {(['merge', 'pr'] as const).map(v => (
                  <label
                    key={v}
                    className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink transition-colors hover:text-accent"
                  >
                    <input
                      type="radio"
                      name="completion-flow"
                      checked={flow === v}
                      onChange={() => setFlow(v)}
                      className="accent-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    />
                    {t(
                      v === 'merge'
                        ? 'projectPanel.settingsFlowMerge'
                        : 'projectPanel.settingsFlowPr',
                    )}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block label-cap text-ink-muted">
                {t('projectPanel.settingsTargetBranch')}
              </label>
              <input
                value={targetBranch}
                onChange={e => setTargetBranch(e.target.value)}
                placeholder={t('projectPanel.settingsTargetBranchPlaceholder')}
                className={FIELD_INPUT_CSS}
              />
            </div>

            <div>
              <label className="mb-1 block label-cap text-ink-muted">
                {t('projectPanel.settingsVerifyCommands')}
              </label>
              <textarea
                value={verifyText}
                onChange={e => setVerifyText(e.target.value)}
                placeholder={t('projectPanel.settingsVerifyPlaceholder')}
                rows={3}
                className={`${FIELD_INPUT_CSS} resize-y font-mono leading-relaxed`}
              />
            </div>

            <div>
              <label className="mb-1 block label-cap text-ink-muted">
                {t('projectPanel.settingsMembers')}
              </label>
              <textarea
                value={membersText}
                onChange={e => setMembersText(e.target.value)}
                placeholder={t('projectPanel.settingsMembersPlaceholder')}
                rows={2}
                className={`${FIELD_INPUT_CSS} resize-y leading-relaxed`}
              />
              <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                {t('projectPanel.settingsMembersHint')}
              </p>
            </div>

            <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink transition-colors hover:text-accent">
              <input
                type="checkbox"
                checked={reviewCol}
                onChange={e => setReviewCol(e.target.checked)}
                className="accent-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              />
              {t('projectPanel.settingsReviewColumn')}
            </label>
          </div>
        </div>

        {/* ── Personal ── */}
        <div className="mt-5 border-t border-line pt-4">
          <p className="label-cap text-ink">{t('projectPanel.settingsPersonalHeading')}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
            {t('projectPanel.settingsPersonalHint')}
          </p>

          <div className="mt-3 space-y-3.5">
            <div>
              <label className="mb-1 block label-cap text-ink-muted">
                {t('projectPanel.settingsPermissionMode')}
              </label>
              <select
                value={permissionMode}
                onChange={e =>
                  setPermissionMode(
                    e.target.value as NonNullable<ProjectLaunchPrefs['permissionMode']>,
                  )
                }
                className={`${FIELD_INPUT_CSS} cursor-pointer`}
              >
                {permissionOptions.map(o => (
                  <option key={o.value} value={o.value}>
                    {t(o.labelKey)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block label-cap text-ink-muted">
                {t('projectPanel.settingsModel')}
              </label>
              <input
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder={t('projectPanel.settingsModelPlaceholder')}
                className={FIELD_INPUT_CSS}
              />
            </div>

            <div>
              <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink transition-colors hover:text-accent">
                <input
                  type="checkbox"
                  checked={autoSync}
                  onChange={e => setAutoSync(e.target.checked)}
                  className="accent-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                {t('projectPanel.settingsAutoSync')}
              </label>
              <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                {t('projectPanel.settingsAutoSyncHint')}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2">
          <Btn variant="subtle" size="md" onClick={onCancel}>
            {t('common.cancel')}
          </Btn>
          <Btn variant="primary" size="md" onClick={save}>
            {t('common.save')}
          </Btn>
        </div>
      </div>
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
}) => {
  const { t } = useT()
  return (
  <div className="absolute inset-0 z-20 flex flex-col justify-center gap-5 bg-bg-card px-6">
    <div className="mx-auto w-full max-w-[420px]">
      <p className="label-cap text-accent mb-2">{t('projectPanel.deleteProjectLabel')}</p>
      <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
        {t('projectPanel.moveToTrashQuestion', { name: projectName })}
      </h3>
      <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
        {t('projectPanel.deleteExplain')}
      </p>
      <label className="label-cap text-ink-muted mb-1.5 mt-5 block">
        {t('projectPanel.typeToConfirmBefore')}{' '}
        <span className="font-mono normal-case tracking-normal text-ink">
          {projectName}
        </span>{' '}
        {t('projectPanel.typeToConfirmAfter')}
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
          {t('projectPanel.deleteFailed', { error })}
        </p>
      )}
      <div className="mt-5 flex items-center justify-end gap-2">
        <Btn variant="subtle" size="md" onClick={onCancel}>{t('common.cancel')}</Btn>
        <Btn
          variant="primary"
          size="md"
          onClick={onConfirm}
          disabled={confirmText.trim() !== projectName || deleting}
        >
          {deleting ? t('projectPanel.deleting') : t('common.delete')}
        </Btn>
      </div>
    </div>
  </div>
  )
}

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
  order,
  onReorder,
  terminalInfo,
}: {
  view: PanelView
  onChange: (v: PanelView) => void
  // Per-project, normalised left-to-right tab order (ids only).
  order: PanelView[]
  // Commit a drag from index `from` to insertion slot `to` (original-array index
  // space, matching moveTab's convention).
  onReorder: (from: number, to: number) => void
  terminalInfo: TerminalInfo | null
}) => {
  const { t } = useT()
  // Metadata (icon/label) keyed by id; the row is rendered in `order`.
  const byId = useMemo(() => {
    const m = new Map<PanelView, ModuleDef>()
    for (const def of enabledModules()) m.set(def.id, def)
    return m
  }, [])
  const tabs = order.map(id => byId.get(id)).filter((m): m is ModuleDef => !!m)

  // Drag-to-reorder state. `dragFrom` = the tab being dragged; `dropAt` = the
  // insertion slot it would land in (0..tabs.length). Mirrors the task-list
  // reorder idiom, adapted to a horizontal row (midpoint test on clientX).
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)
  const endDrag = () => {
    setDragFrom(null)
    setDropAt(null)
  }
  const commitDrop = () => {
    if (dragFrom !== null && dropAt !== null) onReorder(dragFrom, dropAt)
    endDrag()
  }
  // Alt+Arrow keyboard reorder: nudge the focused tab left/right (accessible
  // alternative to dragging). Move = drop the tab one slot over.
  const onTabKeyDown = (e: ReactKeyboardEvent, i: number) => {
    if (!e.altKey) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onReorder(i, i - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      onReorder(i, i + 2)
    }
  }

  return (
    <div className="flex shrink-0 items-end gap-4 border-b border-line px-8">
      {tabs.map((m, i) => {
        const active = m.id === view
        const dimmed = dragFrom === i
        // Accent insertion bar: before this tab when it's the drop slot, or
        // after the last tab when dropping at the end.
        // Show the insertion bar only where a drop would actually move the tab.
        // moveTab is a no-op for both dropAt===dragFrom and dropAt===dragFrom+1
        // (dropping onto self or just after self), so suppress the bar for both.
        const barBefore =
          dragFrom !== null && dropAt === i && dropAt !== dragFrom && dropAt !== dragFrom + 1
        const barAfter =
          dragFrom !== null &&
          i === tabs.length - 1 &&
          dropAt === tabs.length &&
          dropAt !== dragFrom + 1
        return (
          <button
            key={m.id}
            draggable
            onDragStart={e => {
              e.dataTransfer.effectAllowed = 'move'
              // Firefox needs a payload for the drag to fire; we read state.
              e.dataTransfer.setData('text/plain', String(i))
              setDragFrom(i)
            }}
            onDragOver={e => {
              if (dragFrom === null) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'move'
              const r = e.currentTarget.getBoundingClientRect()
              const past = e.clientX > r.left + r.width / 2
              setDropAt(i + (past ? 1 : 0))
            }}
            onDrop={e => {
              e.preventDefault()
              commitDrop()
            }}
            onDragEnd={endDrag}
            onClick={() => onChange(m.id)}
            onKeyDown={e => onTabKeyDown(e, i)}
            title={t('projectPanel.dragToReorder')}
            // -mb-px lets the active border-b sit directly on top of the
            // row's border-b, so the underline reads as "this tab owns the
            // panel below," not "this tab has its own underline above the
            // row line."
            className={[
              '-mb-px relative flex items-center gap-1.5 border-b-2 px-1 py-2 label-cap transition-colors',
              active
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-muted hover:text-accent',
              dimmed ? 'opacity-40' : '',
              dragFrom !== null ? 'cursor-grabbing' : 'cursor-grab',
            ].join(' ')}
          >
            {barBefore && (
              <span className="pointer-events-none absolute -left-2 top-1 bottom-1 w-0.5 bg-accent" />
            )}
            {m.icon}
            <span>{m.label}</span>
            {barAfter && (
              <span className="pointer-events-none absolute -right-2 top-1 bottom-1 w-0.5 bg-accent" />
            )}
          </button>
        )
      })}
    </div>
  )
}

// Overflow menu for low-frequency project actions (archive / restore / delete).
// Keeps the header focused on the everyday controls (just Close, alongside this menu).
// The OS file manager has a different name per platform, so the "reveal" label
// follows the host OS rather than a fixed string. navigator.platform is
// deprecated but still the most reliable synchronous signal in Electron/Chrome.
const revealLabelKey = (): 'projectPanel.revealInFinder' | 'projectPanel.revealInExplorer' | 'projectPanel.revealFolder' => {
  const p = (typeof navigator !== 'undefined' && navigator.platform) || ''
  if (/mac/i.test(p)) return 'projectPanel.revealInFinder'
  if (/win/i.test(p)) return 'projectPanel.revealInExplorer'
  return 'projectPanel.revealFolder'
}

const MoreMenu = ({
  onProjectSettings,
  projectSettingsDisabled,
  onRemove,
  onDelete,
  share,
}: {
  /** Open the Project settings dialog (shared policy + personal launch
   *  prefs). Disabled until the project's data has loaded. */
  onProjectSettings: () => void
  projectSettingsDisabled?: boolean
  onRemove: () => void
  onDelete: () => void
  /** Git-share section. null = status unknown (share routes absent / fetch
   *  failed) → the section is hidden entirely, per the graceful-degrade rule. */
  share: {
    status: ShareStatus
    /** project.missing — the folder is gone, so enable can't run. */
    missing: boolean
    onShare: () => void
    onUnshare: () => void
  } | null
}) => {
  const { t } = useT()
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
      <IconButton title={t('projectPanel.moreActions')} onClick={() => setOpen(v => !v)}>
        <MoreHorizontal size={15} strokeWidth={1.75} />
      </IconButton>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-1 w-56 rounded-[2px] border border-line bg-bg-card py-1 shadow-card-hover">
          {/* Project settings (text-only item, like the share entries). */}
          <button
            disabled={projectSettingsDisabled}
            onClick={() => {
              setOpen(false)
              onProjectSettings()
            }}
            className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          >
            {t('projectPanel.projectSettingsMenu')}
          </button>
          <div className="my-1 border-t border-line-soft" />
          <button
            onClick={() => {
              setOpen(false)
              onRemove()
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-bg-inset"
          >
            <Archive size={12} strokeWidth={1.75} />
            {t('projectPanel.removeFromCanvas')}
          </button>
          {/* Git share (text-only items — the share UI carries no icons). */}
          {share && (
            <>
              <div className="my-1 border-t border-line-soft" />
              {share.status.shared ? (
                <button
                  onClick={() => {
                    setOpen(false)
                    share.onUnshare()
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                >
                  {t('projectPanel.unshareMenu')}
                </button>
              ) : (
                <button
                  disabled={!share.status.gitRepo || share.missing}
                  title={
                    !share.status.gitRepo
                      ? t('projectPanel.shareNeedsGitRepo')
                      : share.missing
                        ? t('projectPanel.folderGone')
                        : undefined
                  }
                  onClick={() => {
                    setOpen(false)
                    share.onShare()
                  }}
                  className="flex w-full items-center px-3 py-1.5 text-left text-[12px] text-ink transition-colors hover:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                >
                  {t('projectPanel.shareMenu')}
                </button>
              )}
            </>
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
            {t('projectPanel.deleteProjectMenu')}
          </button>
        </div>
      )}
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
    // min-w-0 + break-words: a long folder name wraps inside the header
    // column instead of widening it past the viewport.
    text: 'mt-1 min-w-0 break-words font-display text-[26px] leading-[1.05] tracking-tightest text-ink',
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
  const { t } = useT()
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
      <div className="min-w-0 flex-1">
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
      title={onRename ? t('projectPanel.doubleClickToRename') : undefined}
      className={[css.text, onRename ? 'cursor-text' : ''].join(' ')}
      style={css.style}
    >
      {name}
    </h2>
  )
}
