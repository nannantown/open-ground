import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AlertCircle,
  Archive,
  ChevronLeft,
  FolderOpen,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Play,
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
  ShareStatus,
} from '@/lib/types'
import { api } from '@/lib/api-client'
import {
  disableShare,
  enableShare,
  fetchShareStatus,
  remoteShortName,
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
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
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

interface TerminalSlot {
  id: string
  label: string
  // A pane starts as a plain shell. The "▶ Claude" button promotes it to a
  // claude session (OG launches `claude --session-id`). These fields persist
  // so a reload reattaches.
  kind?: 'shell' | 'claude'
  agentSessionId?: string
  claudeTerminalId?: string
  // Set when this slot was launched FROM a Board card — the slot IS the single
  // source of truth for that task's terminal, so the same session shows both in
  // the Board drawer and as a labelled pane in the Terminal tab (one-way:
  // board → terminal tab). The label tracks the task title.
  taskId?: string
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
        .map(s => ({
          id: s.id,
          label: s.label || s.id,
          // Preserve the claude-session fields so a reload can reattach both
          // views to the same PTY. (Dropping these silently breaks reattach.)
          ...(s.kind === 'claude' ? { kind: 'claude' as const } : {}),
          ...(typeof s.agentSessionId === 'string'
            ? { agentSessionId: s.agentSessionId }
            : {}),
          ...(typeof s.claudeTerminalId === 'string'
            ? { claudeTerminalId: s.claudeTerminalId }
            : {}),
        }))
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

// Split-view tuning. Each pane's width is stored as a fraction of the visible
// terminal area. MIN keeps a pane at least a quarter of the screen, so up to 4
// tile without scrolling and a 5th+ overflows into a horizontal scroll. MAX caps
// how many PTYs one project can spawn at once.
const TERMINAL_WIDTHS_KEY = (path: string) => `openground.terminal.widths.${path}`
const MIN_TERMINAL_FRACTION = 0.25
const MAX_TERMINALS = 6

// Per-project pane widths (id → fraction of the visible area). A slot with no
// stored width falls back to MIN_TERMINAL_FRACTION, so newly added panes need no
// seeding. Values are clamped to the minimum on read so an old/corrupt store
// can't produce a sliver pane.
const loadWidths = (path: string): Record<string, number> => {
  if (typeof window === 'undefined') return {}
  try {
    const raw = localStorage.getItem(TERMINAL_WIDTHS_KEY(path))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isFinite(v)) {
          out[k] = Math.max(MIN_TERMINAL_FRACTION, v)
        }
      }
      return out
    }
  } catch {}
  return {}
}

const saveWidths = (path: string, widths: Record<string, number>) => {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(TERMINAL_WIDTHS_KEY(path), JSON.stringify(widths))
  } catch {}
}

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
  // Per-pane width fractions (id → fraction of the visible area). Persisted
  // per-project alongside the slot list.
  const [terminalWidths, setTerminalWidths] = useState<Record<string, number>>(
    () => (project ? loadWidths(project.path) : {}),
  )
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
      setTerminalWidths(loadWidths(path))
      setActiveTerminalSlot(next[0]?.id ?? 'default')
      return
    }
    // Subsequent runs for the same path: terminalSlots changed because the
    // user added / removed / switched a slot — persist it.
    saveSlots(path, terminalSlots)
  }, [project?.path, terminalSlots])
  // Persist pane widths whenever they change (drag-resize / reset / add /
  // close), but only once we've loaded the real list for this path — same guard
  // as the slot list so the initial empty map can't clobber a saved layout.
  useEffect(() => {
    const path = project?.path
    if (!path || loadedForPathRef.current !== path) return
    saveWidths(path, terminalWidths)
  }, [project?.path, terminalWidths])
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

  // A pane with a stored width is "pinned" to that fraction; one without flexes
  // to share the row equally (floored at the 1/4 minimum). So 1 pane fills the
  // row, 4 sit at 1/4 each, and a 5th+ overflows into the horizontal scroll.
  const pinnedWidth = (id: string): number | null => {
    const v = terminalWidths[id]
    return typeof v === 'number' ? Math.max(MIN_TERMINAL_FRACTION, v) : null
  }

  // Add a pane. New panes append at MIN width; labels just count up — "Terminal
  // N" picks the next free integer. Capped at MAX_TERMINALS.
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

  // Panes whose claude PTY has exited — show "▶ Claude" (relaunch) instead of
  // the Terminal/Chat toggle. Component-level (not persisted): a fresh load
  // re-probes liveness via the panes themselves.
  const [exitedClaudeSlots, setExitedClaudeSlots] = useState<Set<string>>(new Set())
  const markClaudeExited = (id: string) =>
    setExitedClaudeSlots(prev => new Set(prev).add(id))
  // Slots with an in-flight promoteToClaude — blocks a double-spawn.
  const promotingSlotsRef = useRef<Set<string>>(new Set())

  // "▶ Claude": launch a claude session for this pane. OG mints the session id
  // (POST /api/terminal/claude) so it owns the JSONL — both the raw terminal
  // view and the rendered chat view attach to the returned PTY.
  const promoteToClaude = async (id: string) => {
    if (!project) return
    // In-flight guard: a double-click (or header + body CTA) would otherwise
    // POST twice, spawn two claude PTYs, and orphan the first (only the second
    // id is kept on the slot).
    if (promotingSlotsRef.current.has(id)) return
    promotingSlotsRef.current.add(id)
    try {
      const r = await fetch('/api/terminal/claude', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: project.path }),
      })
      if (!r.ok) return
      const info = (await r.json()) as TerminalInfo & { agentSessionId?: string }
      // Promotion replaces the shell PTY with a claude PTY — kill the old shell
      // so it doesn't orphan.
      try {
        const key = `openground.terminal.session.${project.path}.${id}`
        const cached = localStorage.getItem(key)
        if (cached) {
          api.api.terminal[':id'].$delete({ param: { id: cached } }).catch(() => {})
          localStorage.removeItem(key)
        }
      } catch {}
      setExitedClaudeSlots(prev => {
        const n = new Set(prev)
        n.delete(id)
        return n
      })
      setTerminalSlots(prev => {
        // The pane was closed while the launch was in flight — kill the just-
        // spawned claude PTY so it doesn't orphan an idle process.
        if (!prev.some(s => s.id === id)) {
          api.api.terminal[':id'].$delete({ param: { id: info.id } }).catch(() => {})
          return prev
        }
        return prev.map(s =>
          s.id === id
            ? {
                ...s,
                kind: 'claude' as const,
                agentSessionId: info.agentSessionId,
                claudeTerminalId: info.id,
              }
            : s,
        )
      })
      setActiveTerminalSlot(id)
    } catch {} finally {
      promotingSlotsRef.current.delete(id)
    }
  }

  // Launch (or relaunch) the claude terminal FOR A BOARD TASK. The task's
  // terminal IS a Terminal-tab slot (single source of truth): we create/refresh
  // a slot keyed by taskId, labelled with the title, so the same session is
  // visible both in the Board drawer and as a labelled pane in the Terminal tab.
  // Built as one atomic add (fetch → fully-formed claude slot) so the slot never
  // sits in a half-promoted state. The title is the prompt; notes are NOT sent.
  const launchTaskTerminal = async (task: ProjectTask) => {
    if (!project) return
    const existing = terminalSlots.find(s => s.taskId === task.id)
    if (existing?.claudeTerminalId && !exitedClaudeSlots.has(existing.id)) return
    // Guard on the slot id when one already exists, so a concurrent
    // promoteToClaude (the Terminal-tab "▶ Claude" restart targets the slot by
    // id) on the SAME slot is serialized with this relaunch — keying them
    // differently let both POST /api/terminal/claude and orphan a PTY. The
    // create case (no slot yet) keys on the task id.
    const guard = existing ? existing.id : `task:${task.id}`
    if (promotingSlotsRef.current.has(guard)) return
    promotingSlotsRef.current.add(guard)
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
      const info = (await r.json()) as TerminalInfo & { agentSessionId?: string }
      setExitedClaudeSlots(prev => {
        if (!existing) return prev
        const n = new Set(prev)
        n.delete(existing.id)
        return n
      })
      setTerminalSlots(prev => {
        const idx = prev.findIndex(s => s.taskId === task.id)
        const filled = {
          label: title || t('projectPanel.taskSlotFallback'),
          kind: 'claude' as const,
          taskId: task.id,
          agentSessionId: info.agentSessionId,
          claudeTerminalId: info.id,
        }
        if (idx >= 0) return prev.map((s, i) => (i === idx ? { ...s, ...filled } : s))
        const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        return [...prev, { id, ...filled }]
      })
    } catch {
      /* swallow — the Board card stays on its launch button to retry */
    } finally {
      promotingSlotsRef.current.delete(guard)
    }
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
      // A claude pane's PTY is tracked on the slot (not the shell-session key),
      // so kill it explicitly or it would orphan an idle `claude` process.
      const claudeId = terminalSlots.find(s => s.id === id)?.claudeTerminalId
      if (claudeId) {
        api.api.terminal[':id'].$delete({ param: { id: claudeId } }).catch(() => {})
      }
    } catch {}
    setTerminalWidths(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
    // Drop any exited-claude membership so the id (esp. the reusable 'default')
    // can't carry a stale "exited" flag onto a freshly-seeded pane.
    setExitedClaudeSlots(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
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

  // Reconcile task-bound terminal slots against live tasks. onDeleteTask closes
  // a task's slot synchronously, but if the task is deleted WHILE its launch is
  // still in flight, launchTaskTerminal's setTerminalSlots adds the slot AFTER
  // that read — so the slot (and its claude PTY) outlives the task. This effect
  // is the race safety net: any slot whose taskId no longer maps to a live task
  // gets torn down (PTY killed via closeTerminal). Non-task (shell) slots have
  // no taskId and are never touched.
  useEffect(() => {
    if (!data) return
    const taskIds = new Set(data.tasks.map(t => t.id))
    const orphan = terminalSlots.find(s => s.taskId && !taskIds.has(s.taskId))
    if (orphan) void closeTerminal(orphan.id)
    // closeTerminal is a stable per-render closure; re-listing it would re-run
    // this every render. Reconciliation depends only on tasks + slots.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, terminalSlots])

  // Drag the right edge of a pane to set its width. Mirrors startFsSidebarDrag:
  // window-level mousemove/up, fraction clamped to the minimum (no upper bound —
  // overflow is absorbed by the horizontal scroll), persisted on release.
  const startTerminalDivider = (id: string) => (e: React.MouseEvent) => {
    e.preventDefault()
    const containerW = terminalRowRef.current?.clientWidth ?? 0
    if (containerW <= 0) return
    const startX = e.clientX
    // Seed from the pane's *actual* rendered width so a drag that starts on an
    // unpinned (auto-flexed) pane doesn't jump.
    const paneEl = (e.currentTarget as HTMLElement).parentElement
    const startFrac = paneEl
      ? paneEl.getBoundingClientRect().width / containerW
      : MIN_TERMINAL_FRACTION
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(
        MIN_TERMINAL_FRACTION,
        startFrac + (ev.clientX - startX) / containerW,
      )
      setTerminalWidths(prev => ({ ...prev, [id]: next }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  // Double-click a divider → drop the pin and let the pane flex equally again.
  const resetTerminalWidth = (id: string) =>
    setTerminalWidths(prev => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })

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
  const [shareBusy, setShareBusy] = useState(false)
  const [shareDialogError, setShareDialogError] = useState<string | null>(null)
  // Bumped whenever shared files may have changed on disk (after a successful
  // Sync / enable / disable, and on window focus while shared) — ProjectCanvas
  // re-reads the index + active canvas in place when it changes.
  const [canvasReloadToken, setCanvasReloadToken] = useState(0)
  const remoteName = useMemo(
    () => remoteShortName(shareStatus?.remoteUrl ?? null),
    [shareStatus?.remoteUrl],
  )

  const refreshShareStatus = useCallback(async () => {
    const path = project?.path
    if (!path) return
    const status = await fetchShareStatus(path)
    if (projectPathRef.current !== path) return
    setShareStatus(status)
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
        setShareNoticeFading({
          kind: 'error',
          text: [t('projectPanel.syncConflict'), r.result.message]
            .filter(Boolean)
            .join(' — '),
        })
      } else if (!r.result.ok) {
        setShareNoticeFading({
          kind: 'error',
          text: t('projectPanel.syncFailed', {
            error: r.result.message ?? 'sync error',
          }),
        })
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
        const parts = [digest, r.result.message].filter((s): s is string => !!s)
        setShareNoticeFading({
          kind: 'ok',
          text: parts.length > 0 ? parts.join(' — ') : t('projectPanel.syncDone'),
        })
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
    } finally {
      setShareBusy(false)
    }
  }, [project?.path, shareDialog, shareBusy, refreshShareStatus, reloadProjectData])

  // Fetch the status when a project opens (and reset all share UI state so
  // nothing leaks across a project switch).
  useEffect(() => {
    setShareStatus(null)
    setShareNoticeFading(null)
    setShareDialog(null)
    setShareDialogError(null)
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
      <header className="rule-double flex items-start justify-between gap-3 px-8 pt-5 pb-4">
        {/* flex-1 so this column has a definite width: the description box caps
            at max-w-[560px] in BOTH read and edit modes. Without it the column
            shrank to its content, so swapping the wide <p> for a <textarea>
            (narrow intrinsic width) collapsed the whole box to ~190px. */}
        <div className="min-w-0 flex-1">
          <button
            onClick={onClose}
            className="flex items-center gap-1 label-cap text-accent transition-colors hover:text-ink"
          >
            <ChevronLeft size={11} strokeWidth={2.5} /> {t('projectPanel.backToGround')}
          </button>
          <div className="flex items-center gap-2.5">
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
        <div className="flex shrink-0 items-center gap-3">
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
                    'max-w-[260px] truncate text-[11px] transition-opacity duration-150',
                    shareNotice.kind === 'error' ? 'text-accent' : 'text-ink-faint',
                  ].join(' ')}
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
              <button
                type="button"
                onClick={() => void doSync()}
                disabled={syncing || project.missing}
                title={
                  shareStatus.dirty
                    ? t('projectPanel.syncDirtyHint')
                    : t('projectPanel.syncHint')
                }
                className="flex shrink-0 items-center gap-1.5 rounded-sm border border-line px-2.5 py-1 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
              >
                {shareStatus.dirty && !syncing && (
                  <span
                    aria-hidden
                    className="h-[5px] w-[5px] shrink-0 rounded-full bg-accent"
                  />
                )}
                {syncing ? t('projectPanel.syncing') : t('projectPanel.sync')}
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
              <span>{t('toolbar.feedback')}</span>
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
        onAddTerminal={addTerminal}
        canAddTerminal={terminalSlots.length < MAX_TERMINALS}
      />

      {/* Content + assistant. The assistant is either the bottom dock (a child
          at the end of the content column) or a right sidebar (a push panel
          beside the content column) — flipped via the in-panel toggle. */}
      <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
      {view === 'terminal' ? (
        <div
          ref={terminalRowRef}
          className="min-h-0 flex-1 flex overflow-x-auto"
        >
          {terminalSlots.map(slot => {
            const active = slot.id === activeTerminalSlot
            const canClose = terminalSlots.length > 1
            const isDropTarget = termDragOverId === slot.id && termDragId !== slot.id
            const pinned = pinnedWidth(slot.id)
            return (
              <div
                key={slot.id}
                data-term-slot={slot.id}
                onMouseDown={() => setActiveTerminalSlot(slot.id)}
                style={
                  pinned !== null
                    ? { width: `${pinned * 100}%`, flexGrow: 0, flexShrink: 0 }
                    : { flex: '1 1 0%', minWidth: '25%' }
                }
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
                      // Show the full label on hover (board-task panes use the
                      // task title, which truncates in a narrow pane) + the
                      // rename affordance.
                      title={`${slot.label}\n(${t('projectPanel.renameTerminal')})`}
                      className="min-w-0 flex-1 truncate"
                    >
                      {slot.label}
                    </span>
                  )}
                  {/* Claude controls: a shell (or exited) pane shows "▶ Claude"
                   *  to promote it; a live claude pane shows no extra control —
                   *  just its label + close. */}
                  {slot.kind === 'claude' &&
                  slot.claudeTerminalId &&
                  !exitedClaudeSlots.has(slot.id) ? null : (
                    <button
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => {
                        e.stopPropagation()
                        void promoteToClaude(slot.id)
                      }}
                      title={t('projectPanel.launchClaudeInPane')}
                      className="flex shrink-0 items-center gap-0.5 rounded-[3px] px-1.5 py-0.5 text-[9px] text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                    >
                      <Play size={9} strokeWidth={2.5} />
                      Claude
                    </button>
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
                  {slot.kind === 'claude' &&
                  slot.claudeTerminalId &&
                  exitedClaudeSlots.has(slot.id) ? (
                    // The claude session ended (or its PTY is gone) — show an
                    // in-body relaunch CTA, not a dead transcript with a header
                    // that says "▶ Claude" elsewhere.
                    <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#1a1a1a] text-center">
                      <span className="text-[12px] text-white/50">
                        {t('projectPanel.claudeSessionEnded')}
                      </span>
                      <button
                        type="button"
                        onClick={() => void promoteToClaude(slot.id)}
                        className="flex items-center gap-1.5 rounded-[4px] border border-white/15 px-3 py-1.5 text-[12px] text-white/80 transition-colors hover:border-accent hover:text-white"
                      >
                        <Play size={11} strokeWidth={2.5} />
                        {t('projectPanel.relaunchClaude')}
                      </button>
                    </div>
                  ) : slot.kind === 'claude' && slot.claudeTerminalId ? (
                    // A live claude pane is the raw PTY terminal (chromeless).
                    <ClaudeTerminalPane
                      terminalId={slot.claudeTerminalId}
                      chrome={false}
                      onExit={() => markClaudeExited(slot.id)}
                    />
                  ) : (
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
                  )}
                </div>
                {/* Drag the right edge to widen/narrow this pane; double-click
                 *  resets it to the minimum quarter-width. */}
                <div
                  onMouseDown={startTerminalDivider(slot.id)}
                  onDoubleClick={() => resetTerminalWidth(slot.id)}
                  title={t('projectPanel.resizeHint')}
                  className="absolute bottom-0 right-0 top-0 z-10 -mr-1 w-2 cursor-col-resize transition-colors hover:bg-accent/40"
                />
              </div>
            )
          })}
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
          // A card with a live/launched terminal slot counts as "touched" — the
          // drawer's close-discards-empty-card check must not drop it.
          hasTerminalSlot={id => terminalSlots.some(s => s.taskId === id)}
          // Delete lives in the drawer HEADER (next to ×), not floating in the
          // conversation pane.
          onDeleteTask={id => {
            // The task's terminal IS a Terminal-tab slot (single source of
            // truth, keyed by taskId). Deleting the task must tear that slot
            // down too — closeTerminal kills its claude PTY and drops the pane —
            // else a labelled pane for a now-deleted task lingers in the
            // Terminal tab and its PTY orphans as an idle process.
            const slot = terminalSlots.find(s => s.taskId === id)
            if (slot) void closeTerminal(slot.id)
            if (data) persist({ ...data, tasks: data.tasks.filter(t => t.id !== id) })
          }}
          // Terminal-only mode: drive each task through a raw PTY terminal
          // (works on the subscription, no JSONL).
          renderConversation={(task) => {
            // The task's terminal IS a Terminal-tab slot (single source of
            // truth), keyed by taskId. Render that slot's live session here.
            const slot = terminalSlots.find(s => s.taskId === task.id)
            const liveId =
              slot?.claudeTerminalId && !exitedClaudeSlots.has(slot.id)
                ? slot.claudeTerminalId
                : null
            return (
              <BoardTaskTerminal
                terminalId={liveId}
                onLaunch={() => launchTaskTerminal(task)}
                onExit={() => slot && markClaudeExited(slot.id)}
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

      {feedbackEnabled && (
        <FeedbackModal
          open={feedbackOpen}
          onClose={() => setFeedbackOpen(false)}
        />
      )}
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
    <div className="absolute inset-0 z-20 flex flex-col justify-center gap-5 bg-bg-card px-6">
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
    <div className="absolute inset-0 z-20 flex flex-col justify-center gap-5 overflow-y-auto bg-bg-card px-6 py-8">
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
  onAddTerminal,
  canAddTerminal,
}: {
  view: PanelView
  onChange: (v: PanelView) => void
  // Per-project, normalised left-to-right tab order (ids only).
  order: PanelView[]
  // Commit a drag from index `from` to insertion slot `to` (original-array index
  // space, matching moveTab's convention).
  onReorder: (from: number, to: number) => void
  terminalInfo: TerminalInfo | null
  // Spawn another terminal pane (Terminal tab only). Disabled at the cap.
  onAddTerminal: () => void
  canAddTerminal: boolean
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
      {view === 'terminal' && (
        <button
          onClick={onAddTerminal}
          disabled={!canAddTerminal}
          title={t('projectPanel.newTerminal')}
          className="-mb-px ml-auto flex items-center gap-1 border-b-2 border-transparent px-1 py-2 label-cap text-ink-muted transition-colors hover:text-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-muted"
        >
          <Plus size={10} strokeWidth={2.25} />
          <span>{t('projectPanel.new')}</span>
        </button>
      )}
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
      title={onRename ? t('projectPanel.doubleClickToRename') : undefined}
      className={[css.text, onRename ? 'cursor-text' : ''].join(' ')}
      style={css.style}
    >
      {name}
    </h2>
  )
}
