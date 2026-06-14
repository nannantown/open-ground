import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import {
  AlertCircle,
  Archive,
  ChevronLeft,
  FolderOpen,
  GitBranch,
  Loader2,
  MessageSquare,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCw,
  SquareCode,
  Store,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { useT } from '@/i18n/I18nContext'
import type {
  BranchChangesResponse,
  OpenApp,
  ProjectConfig,
  ProjectData,
  ProjectLaunchPrefs,
  ProjectMeta,
  ProjectTask,
  ShareAutoStatus,
  ShareConflict,
  ShareStatus,
  SettingsResponse,
  ProjectWorktreeInfo,
  CleanWorktreesResult,
  CustomModuleDef,
} from '@/lib/types'
import { api } from '@/lib/api-client'
import {
  disableShare,
  fetchShareStatus,
  remoteShortName,
  resolveShare,
  syncShare,
} from '@/lib/shareClient'
import { settingsSections, showHeaderShare } from '@/lib/shareUx'
import {
  FIELD_INPUT_CSS,
  MembersField,
  ShareStartDialog,
  TargetBranchField,
  useProjectBranches,
  type SyncOutcome,
} from '@/components/canvas/ShareStartDialog'
import { boardDiffDigest } from '@/lib/boardDigest'
import { migrateLs } from '@/lib/lsMigrate'
import {
  loadPersistedView,
  savePersistedView,
  type PersistedPanelTab,
  type PersistedView,
} from '@/lib/persistView'
import { paneHeaderTitle, paneTooltip } from '@/lib/paneTitle'
import { descriptionForLang } from '@/lib/descriptionLang'
import {
  TerminalPane,
  type TerminalInfo,
} from '@/components/canvas/TerminalPane'
import { BoardTaskTerminal } from '@/components/canvas/TaskTerminal'
import { TerminalDock } from '@/components/canvas/EmbeddedClaudeTerminal'
import { ProjectCanvas } from '@/components/canvas/ProjectCanvas'
import { BranchChangesModal } from '@/components/canvas/BranchChangesModal'
import { UsageHud } from '@/components/canvas/UsageHud'
import { FeedbackModal } from '@/components/canvas/FeedbackModal'
import {
  BoardModule,
  type TaskLaunchResult,
  type TaskRunPayload,
} from '@/components/canvas/modules/BoardModule'
import {
  customModuleTabDef,
  enabledModules,
  isModuleIdEnabled,
  type TabDef,
} from '@/components/canvas/moduleRegistry'
import { customTabId, customModuleIdFromTab, isCustomTabId } from '@/lib/modules/ids'
import { effectiveTabOrder, moveTab, preserveCustomTabs } from '@/lib/modules/tabOrder'
import { attachCustomTab, detachCustomTab } from '@/lib/modules/customTabAttach'
import { useCustomModules } from '@/lib/modules/useCustomModules'
import { CustomModuleView } from '@/components/canvas/modules/CustomModuleView'
import { customModuleStorageId } from '@/components/canvas/modules/CustomModuleView'
import { killEmbeddedTerminals } from '@/components/canvas/EmbeddedClaudeTerminal'
import { CustomTabCreateDialog } from '@/components/canvas/modules/CustomTabCreateDialog'
import { CustomTabPickerDialog } from '@/components/canvas/modules/CustomTabPickerDialog'
import { MarketplaceDialog } from '@/components/canvas/modules/MarketplaceDialog'

// The per-project tabs are declared once in the module registry
// (moduleRegistry.tsx) — plus the user's custom tabs (`custom:<uuid>`,
// docs/CUSTOM_TABS_PLAN.md) fetched at runtime, so PanelView is a plain
// string: a built-in ModuleId or a custom tab id. The tab row, the Ctrl+Tab
// order and persistView's allowlist all derive from the merged id list.
type PanelView = string
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
  // The view persisted before this mount, captured once (lazy ref — a useRef
  // initializer expression would re-read localStorage every render). The
  // first-tab-default effect consumes it to tell a RELOAD RESTORE (App reopens
  // the same project; keep the user's restored tab) apart from an explicit
  // project open (apply the project's first-tab launch profile).
  const restoredViewRef = useRef<PersistedView | null | undefined>(undefined)
  if (restoredViewRef.current === undefined) restoredViewRef.current = loadPersistedView()
  const [loading, setLoading] = useState(false)
  // Initial project-data load failed (server unreachable / non-JSON response).
  // Tracked apart from `loading` so the panel shows a retryable error instead
  // of sitting on "Loading…" forever: a REJECTED initial fetch leaves `data`
  // null with loading back to false, and the body's `loading || !data` branch
  // would otherwise render the spinner indefinitely. The 5s poll can't self-heal
  // this case (reloadProjectData's loadedDataPathRef guard never armed), so an
  // explicit Retry — bumping reloadNonce to re-run the load effect — recovers.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
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

  // Open the project folder in the user's code editor (cursor/code/windsurf/
  // zed, or OPENGROUND_EDITOR_CMD). Unlike reveal this CAN meaningfully fail
  // (no editor installed → 503 with a human message), so failures surface via
  // the same alert pattern "Open in…" uses.
  const openInEditor = useCallback(async () => {
    if (!project || project.missing) return
    try {
      const res = await fetch('/api/project/open-editor', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      })
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string }
        alert(t('projectPanel.editorOpenFailed', { error: e.error ?? res.statusText }))
      }
    } catch (e: any) {
      alert(
        t('projectPanel.editorOpenFailed', {
          error: e?.message ?? t('projectPanel.networkError'),
        }),
      )
    }
  }, [project, t])

  // Header branch chip: branch name + a dot when the working tree is dirty.
  // Fetched once per project open (good enough — the modal re-fetches fresh
  // data on open and pushes it back here, so the chip never drifts far).
  const [branchInfo, setBranchInfo] = useState<BranchChangesResponse | null>(null)
  const [branchModalOpen, setBranchModalOpen] = useState(false)
  useEffect(() => {
    setBranchInfo(null)
    setBranchModalOpen(false)
    if (!project || project.missing) return
    let cancelled = false
    fetch(`/api/project/branch-changes?path=${encodeURIComponent(project.path)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!cancelled && body && typeof (body as BranchChangesResponse).isGit === 'boolean') {
          setBranchInfo(body as BranchChangesResponse)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path, project?.missing])

  const regenerateDescription = useCallback(async () => {
    if (!project || project.missing || describing) return
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
  }, [project, describing, onSaved])

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
    let cancelled = false
    const requestedPath = project.path
    setLoading(true)
    setLoadError(null)
    api.api.project
      .$get({ query: { path: requestedPath } }, { init: { cache: 'no-store' } })
      .then(r => r.json() as Promise<ProjectData>)
      .then((d: ProjectData) => {
        if (cancelled) return
        setData(d)
        loadedDataPathRef.current = requestedPath
        lastSavedJson.current = JSON.stringify(d)
      })
      .catch((e: unknown) => {
        // Server unreachable / bad payload. Leave `data` null and surface a
        // retryable error rather than an endless spinner. Guarded so a reject
        // from a project we've since switched away from can't flip the error on.
        if (cancelled) return
        setLoadError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path, reloadNonce])

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
    // persisted 'tasks' fails isMvpVisibleTab and falls back here). A saved
    // `custom:<uuid>` id is adopted tentatively — whether the module still
    // exists is verified once the custom list arrives (effect below).
    return saved && (isMvpVisibleTab(saved) || isCustomTabId(saved))
      ? saved
      : 'board'
  })
  // Persist the active tab on every change (covers tab clicks and Ctrl+Tab).
  // The cast narrows the plain-string PanelView back to the persisted TabId
  // union — `view` only ever holds a registry id or a `custom:*` id (both
  // validated above / by the tab row).
  useEffect(() => {
    savePersistedView({ panelTab: view as PersistedPanelTab })
  }, [view])
  // ── Custom tabs (docs/CUSTOM_TABS_PLAN.md) ───────────────────────────────
  // The global custom-module list + the caller's role, fetched once and
  // refreshed after create/install/publish/delete. Custom tabs surface as
  // `custom:<uuid>` ids appended after the built-ins.
  const {
    role: customRole,
    modules: customModules,
    loaded: customModulesLoaded,
    refresh: refreshCustomModules,
  } = useCustomModules()
  // ATTACHMENT IS CANONICAL (docs/CUSTOM_TABS_PLAN.md — per-project
  // attachment): a module surfaces in THIS project's row only when its id is
  // listed in ProjectData.customTabs AND it still exists in the library.
  // Creating/installing a module alone surfaces nothing.
  const attachedModuleIds = useMemo<string[]>(() => {
    const lib = new Set(customModules.map(m => m.id))
    return (data?.customTabs ?? []).filter(id => lib.has(id))
  }, [data?.customTabs, customModules])
  // Every id that can appear in the tab row: built-ins in registry order,
  // then the ATTACHED custom tabs in attachment order. effectiveTabOrder
  // reconciles a saved per-project order against this set.
  const allTabIds = useMemo<PanelView[]>(
    () => [...ENABLED_MODULE_IDS, ...attachedModuleIds.map(customTabId)],
    [attachedModuleIds],
  )
  // The per-project, normalised tab order: the user's saved drag order
  // (ProjectData.tabOrder) reconciled against the live registry + custom set,
  // falling back to the default order when a project has none. Drives the tab
  // row, the Ctrl+Tab cycle, and the first-tab default below.
  const tabOrder = useMemo(
    () => effectiveTabOrder<PanelView>(data?.tabOrder, allTabIds),
    [data?.tabOrder, allTabIds],
  )
  // A persisted / lingering custom tab that is no longer in this project's
  // row — NOT attached here (detached, or never was on this project), or its
  // module vanished from the library (deleted elsewhere, a stale localStorage
  // value) — falls back to the first built-in. Only judged once BOTH sources
  // are in (the library list AND this project's data) — before that, "not in
  // the row" just means "haven't heard from the server yet".
  useEffect(() => {
    if (!customModulesLoaded || !data || !isCustomTabId(view)) return
    if (allTabIds.includes(view)) return
    setView(tabOrder.find(id => !isCustomTabId(id)) ?? 'board')
  }, [customModulesLoaded, data, view, allTabIds, tabOrder])
  // "The leftmost tab opens by default." When a project's data first loads
  // (opening it, or switching to it — guarded so a same-project save/refetch
  // doesn't yank the view), land on that project's first tab. When the saved
  // first tab is a custom one, wait for the custom list so a slow fetch can't
  // misroute the default to a built-in.
  useEffect(() => {
    const path = project?.path
    if (!path || !data || loadedDataPathRef.current !== path) return
    if (defaultViewedPathRef.current === path) return
    // One-shot: only the first project-open after mount can be a reload
    // restore. When it is (App reopened the very project the mount-time view
    // state was initialised from), honour the restored tab instead of yanking
    // to the project's first tab — otherwise a reload on Canvas/Terminal lands
    // back on the leftmost tab every time. (A restored custom tab whose module
    // vanished still falls back via the effect above once the list loads.)
    const restored = restoredViewRef.current
    restoredViewRef.current = null
    if (restored?.panelTab && project.id === restored.projectId) {
      defaultViewedPathRef.current = path
      return
    }
    const savedFirst = data.tabOrder?.[0]
    if (savedFirst && isCustomTabId(savedFirst) && !customModulesLoaded) return
    defaultViewedPathRef.current = path
    const first = effectiveTabOrder<PanelView>(data.tabOrder, allTabIds)[0] ?? 'board'
    setView(first)
  }, [project?.path, project?.id, data, customModulesLoaded, allTabIds])
  // Custom-tab management UI: the "+" picker (owner|tester — attach from the
  // library, jump to create), the create dialog it hands off to (owner), the
  // marketplace (owner|tester), and the one-shot post-create setup — the
  // freshly created module's id, which makes its CustomModuleView auto-open
  // the sidebar, launch claude and paste the brush-up prompt (unsent).
  // Consumed once.
  const [pickerOpen, setPickerOpen] = useState(false)
  const [customCreateOpen, setCustomCreateOpen] = useState(false)
  const [marketOpen, setMarketOpen] = useState(false)
  const [customSetupId, setCustomSetupId] = useState<string | null>(null)
  // Attach a library module to THIS project (ProjectData.customTabs — the
  // same persist path tabOrder rides) and land on its tab. Reads through
  // dataRef so the async create/install flows can't persist a stale draft.
  const attachTabToProject = useCallback(
    (moduleId: string) => {
      const base = dataRef.current
      if (!base) return
      persist({ ...base, customTabs: attachCustomTab(base.customTabs, moduleId) })
      setView(customTabId(moduleId))
    },
    [persist],
  )
  const onCustomTabCreated = useCallback(
    async (def: CustomModuleDef) => {
      setCustomCreateOpen(false)
      await refreshCustomModules()
      // Auto-attach to the CURRENT project — creation alone surfaces nothing
      // (per-project attachment), and the setup flow needs the tab visible.
      attachTabToProject(def.id)
      setCustomSetupId(def.id)
    },
    [refreshCustomModules, attachTabToProject],
  )
  // The custom module rendered by the active tab (null on built-ins / a
  // just-deleted module whose fallback effect hasn't run yet).
  const activeCustomModule = useMemo(
    () =>
      isCustomTabId(view)
        ? customModules.find(m => customTabId(m.id) === view) ?? null
        : null,
    [view, customModules],
  )
  // Tab-row right-click = DETACH only (non-destructive, no confirm): drop the
  // module id from THIS project's customTabs and scrub its custom:<id> entry
  // from tabOrder, persisted together. The module stays in the library — the
  // picker can re-attach it. Offered to anyone who manages custom tabs
  // (cosmetic — attachment is personal per-project state, no server role
  // gate applies to it).
  const canDetachTab = useCallback(
    (tabId: string): boolean => customRole !== 'none' && isCustomTabId(tabId),
    [customRole],
  )
  const detachTabFromProject = useCallback(
    (tabId: string) => {
      if (!isCustomTabId(tabId)) return
      const base = dataRef.current
      if (!base) return
      const moduleId = customModuleIdFromTab(tabId as `custom:${string}`)
      persist({ ...base, ...detachCustomTab(base, moduleId) })
      // The dangling-view fallback effect moves the view off the detached id.
    },
    [persist],
  )
  // LIBRARY-level destruction (now lives in the "+" picker, not the tab row):
  // server DELETE, then PTY/dock teardown, then a list refresh. The picker
  // owns the two-step confirm; the server enforces the role.
  const deleteCustomModule = useCallback(
    async (moduleId: string) => {
      try {
        const r = await fetch(`/api/custom-modules/${moduleId}`, { method: 'DELETE' })
        if (!r.ok) {
          console.error('[customTabs] remove failed', r.status)
          return
        }
        // Server killed any PTY cwd'd in the module dir; drop the cached
        // dock bindings too — nothing could ever reclaim them post-delete.
        killEmbeddedTerminals(customModuleStorageId(moduleId))
      } finally {
        // Refresh drops the module from the library (and thus from every
        // project's row); the dangling-view fallback effect then moves the
        // view off the dead id.
        void refreshCustomModules()
      }
    },
    [refreshCustomModules],
  )
  // Persist a drag-reordered tab row to this project's ProjectData.tabOrder.
  // Until the custom-module list has loaded, the rendered row — and thus
  // moveTab's result — holds only the built-ins; persisting that verbatim
  // would drop every saved `custom:*` id and reset those tabs' dragged
  // positions. preserveCustomTabs re-inserts them next to their saved
  // neighbours during that window (once loaded, the row is authoritative and
  // a stale custom id is correctly scrubbed, like any retired builtin).
  const reorderTabs = useCallback(
    (from: number, to: number) => {
      if (!data) return
      const next = moveTab(tabOrder, from, to)
      if (next.every((id, i) => id === tabOrder[i])) return
      persist({
        ...data,
        tabOrder: customModulesLoaded ? next : preserveCustomTabs(data.tabOrder, next),
      })
    },
    [data, tabOrder, persist, customModulesLoaded],
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
  // Live mirrors of the two states above. BoardModule keeps long-lived async
  // closures over the liveTerminalId prop (the "Review with claude" flow polls
  // it while another launch is in flight) — reading through refs makes any
  // captured copy see the CURRENT map instead of the render-time snapshot.
  const taskTerminalsRef = useRef(taskTerminals)
  taskTerminalsRef.current = taskTerminals
  const exitedTaskTerminalsRef = useRef(exitedTaskTerminals)
  exitedTaskTerminalsRef.current = exitedTaskTerminals
  const markTaskTerminalExited = (taskId: string) =>
    setExitedTaskTerminals(prev => new Set(prev).add(taskId))
  // Verify the persisted task-PTY bindings on project load. localStorage
  // happily claims a session is live across a server restart — the card dot
  // and "Insert task into input" would lie until the user opens the drawer.
  // Probe each saved PTY id with GET /api/terminal/:id (the same validation
  // TerminalPane.ensureSession runs before re-attaching): 404 or finishedAt
  // means the PTY is gone → mark the task exited. A network failure marks
  // nothing (don't flip a possibly-live dot off on a transient error), and a
  // task relaunched onto a NEW PTY while the probe was in flight is skipped
  // (the binding no longer points at the probed id).
  useEffect(() => {
    const path = project?.path
    if (!path) return
    const probed = loadTaskTerminals(path)
    const entries = Object.entries(probed)
    if (entries.length === 0) return
    let cancelled = false
    void Promise.all(
      entries.map(async ([taskId, ptyId]): Promise<string | null> => {
        try {
          const r = await api.api.terminal[':id'].$get({ param: { id: ptyId } })
          if (r.ok) {
            const inf = (await r.json()) as TerminalInfo
            if (!inf.finishedAt) return null // alive — leave it
          }
          return taskId // 404 / finished → dead
        } catch {
          return null
        }
      }),
    ).then(ids => {
      if (cancelled) return
      const dead = ids.filter(
        (taskId): taskId is string =>
          !!taskId &&
          // Still bound to the PTY we probed? A concurrent relaunch wins.
          taskTerminalsRef.current[taskId] === probed[taskId],
      )
      if (dead.length === 0) return
      setExitedTaskTerminals(prev => {
        const n = new Set(prev)
        for (const id of dead) n.add(id)
        return n
      })
    })
    return () => {
      cancelled = true
    }
  }, [project?.path])
  // Tasks with an in-flight launch — blocks a double-spawn (a double-click
  // would POST twice and orphan the first PTY).
  const launchingTasksRef = useRef<Set<string>>(new Set())
  // Last-known shell info per pane, so switching focus immediately repaints the
  // tab header with that pane's `zsh · cols×rows` instead of waiting for its
  // next info event.
  const terminalInfoMapRef = useRef<Record<string, TerminalInfo | null>>({})
  // Live OSC title per pane (slot id → title) — what's running in the pane,
  // straight from the PTY stream (Claude Code emits a topic summary as an OSC
  // title escape; xterm parses it). NOT persisted: the SSE replay buffer
  // re-emits the escape on reload — best-effort only (the buffer is bounded,
  // so a title that scrolled >200KB behind is lost and the header falls back
  // to the slot label until the next title emit). TerminalPane reports null
  // when a session exits or a fresh one (re)connects; we drop the entry then.
  const [terminalOscTitles, setTerminalOscTitles] = useState<
    Record<string, string>
  >({})
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
      setTerminalOscTitles({})
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
  // Board drawer (BoardTaskTerminal). The Terminal tab is not involved.
  // Two shapes (opts.run):
  //   - WITHOUT run: claude starts PLAIN — no prompt is sent (restart /
  //     "Review with claude"). Content can still reach the input box UNSENT
  //     via the drawer's "Insert task into input" (paste-task).
  //   - WITH run (the drawer's 実行 button): the card's LIVE fields + per-card
  //     overrides ride the request as body.task; the SERVER composes the task
  //     prompt and passes it as the initialPrompt, so claude starts working
  //     immediately — no Enter required.
  // taskWorktrees pre-authorizes the central worktrees dir (--add-dir) on git
  // projects for the task-branch protocol.
  // Returns { ok } so the caller (BoardModule's Run button) can show a manual
  // retry affordance instead of silently dead-ending when the spawn fails. On
  // failure, `reason` distinguishes a missing claude CLI (the server's 503
  // { claudeMissing: true } pre-flight) from everything else (5xx, offline) —
  // BoardModule picks the failure copy from it. An already-live slot counts as
  // success (nothing to do). On success `terminalId` carries the slot's PTY id
  // so a caller can act on the session in the same tick (the Board drawer's
  // "Review with claude" pastes into it right after launch — the taskTerminals
  // state write hasn't re-rendered yet).
  //
  // opts.cwd overrides the spawn directory (still subject to the server's
  // validateProjectPath — the review worktree under the central worktrees dir
  // passes). An override launches PLAIN claude without taskWorktrees: the
  // session already sits inside the worktree, nothing else to pre-authorize.
  const launchTaskTerminal = async (
    task: ProjectTask,
    opts?: { cwd?: string; run?: TaskRunPayload },
  ): Promise<TaskLaunchResult> => {
    if (!project) return { ok: false, reason: 'other' }
    if (taskTerminals[task.id] && !exitedTaskTerminals.has(task.id))
      return { ok: true, terminalId: taskTerminals[task.id] }
    if (launchingTasksRef.current.has(task.id)) return { ok: true }
    launchingTasksRef.current.add(task.id)
    try {
      const r = await fetch('/api/terminal/claude', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          opts?.cwd
            ? { cwd: opts.cwd }
            : {
                cwd: project.path,
                taskWorktrees: true,
                ...(opts?.run ? { task: { id: task.id, ...opts.run } } : {}),
              },
        ),
      })
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { claudeMissing?: boolean }
        return { ok: false, reason: body.claudeMissing ? 'claudeMissing' : 'other' }
      }
      const info = (await r.json()) as TerminalInfo
      setExitedTaskTerminals(prev => {
        if (!prev.has(task.id)) return prev
        const n = new Set(prev)
        n.delete(task.id)
        return n
      })
      setTaskTerminals(prev => ({ ...prev, [task.id]: info.id }))
      return { ok: true, terminalId: info.id }
    } catch {
      return { ok: false, reason: 'other' }
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
    setTerminalOscTitles(prev => {
      if (!(id in prev)) return prev
      const { [id]: _, ...rest } = prev
      return rest
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
  // The unshare confirmation (the only ShareConfirm left — enabling goes
  // through ShareStartDialog below).
  const [shareDialog, setShareDialog] = useState<'disable' | null>(null)
  // Share-start dialog / invite panel ('start' = the full enable form,
  // 'invite' = re-show the invite instructions for an already-shared project).
  const [shareStart, setShareStart] = useState<'start' | 'invite' | null>(null)
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
      // Content unchanged since the last save/load (lastSavedJson is the JSON
      // of whatever setData last adopted) → DON'T setData: swapping in a fresh
      // object with identical content would still replace the tasks ARRAY
      // IDENTITY, which BoardModule's external-update detection reads as a
      // remote change and answers by dropping the undo/redo stacks — the 5s
      // poll would wipe ⌘Z history every tick. Returning d (not null) is
      // correct for doSync's digest: the reload succeeded, the diff is empty.
      const body = JSON.stringify(d)
      if (body === lastSavedJson.current) return d
      setData(d)
      lastSavedJson.current = body
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
  // pull the freshly-merged data back into the UI. Resolves with what
  // happened (SyncOutcome) so callers covering the header notice — the
  // InvitePanel's "Publish now" — can show the failure INLINE; the outcome's
  // error is the exact localized text this function posts to shareNotice.
  const doSync = useCallback(async (): Promise<SyncOutcome> => {
    const path = project?.path
    // Guarded no-op (already syncing / missing project): nothing failed,
    // nothing to report — callers' buttons are disabled in these states.
    if (!path || syncingPath || project?.missing) return { ok: true }
    setSyncingPath(path)
    setShareNoticeFading(null)
    // Snapshot the board BEFORE the sync so a successful pull can be diffed
    // into a "what changed" digest (boardDiffDigest) for the notice line.
    const beforeTasks = dataRef.current?.tasks ?? null
    let outcome: SyncOutcome = { ok: true }
    try {
      const r = await syncShare(path)
      // Stale return (project switched mid-sync): the dialog that asked is
      // gone — report a no-op, never touch the new project's notices.
      if (projectPathRef.current !== path) return { ok: true }
      if ('error' in r) {
        const text = t('projectPanel.syncFailed', { error: r.error })
        outcome = { ok: false, error: text }
        setShareNoticeFading({ kind: 'error', text })
      } else if (r.result.conflict) {
        // Say WHAT conflicted (card titles / notes / canvas files) — the
        // server's message is the raw English fallback for the rest.
        const items = r.result.conflictFiles?.length
          ? t('projectPanel.syncConflictItems', {
              items: r.result.conflictFiles.join(', '),
            })
          : r.result.message
        const text = [t('projectPanel.syncConflict'), items]
          .filter(Boolean)
          .join(' — ')
        outcome = { ok: false, error: text }
        setShareNoticeFading({ kind: 'error', text })
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
        const text =
          reasonText ??
          t('projectPanel.syncFailed', { error: r.result.message ?? 'sync error' })
        outcome = { ok: false, error: text }
        setShareNoticeFading({ kind: 'error', text })
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
        // ok-but-nothing-pushed (offline / no remote): the local sync is fine
        // but a caller asking "did this publish?" must hear NO with the why.
        if (r.result.offline || r.result.noRemote) {
          outcome = {
            ok: false,
            error: r.result.offline
              ? t('projectPanel.syncOffline')
              : t('projectPanel.syncNoRemote'),
          }
        }
      }
      // Whatever happened, the dirty dot may have changed (commit succeeded
      // even when push didn't, etc.) — re-read the truth.
      void refreshShareStatus()
      return outcome
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

  // Confirm in the unshare dialog → POST disable, then refetch everything
  // (status decides which UI shows; data + canvases changed source). The
  // ENABLE side lives in ShareStartDialog (display name + policy + invite).
  const confirmShareDialog = useCallback(async () => {
    const path = project?.path
    if (!path || !shareDialog || shareBusy) return
    setShareBusy(true)
    setShareDialogError(null)
    try {
      const r = await disableShare(path)
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

  // After a successful enable inside ShareStartDialog: pull the new truth in
  // (the dialog itself stays open, switching to the invite panel).
  const onShareEnabled = useCallback(async () => {
    await refreshShareStatus()
    await reloadProjectData()
    setCanvasReloadToken(v => v + 1)
  }, [refreshShareStatus, reloadProjectData])

  // Fetch the status when a project opens (and reset all share UI state so
  // nothing leaks across a project switch).
  useEffect(() => {
    setShareStatus(null)
    setShareNoticeFading(null)
    setShareDialog(null)
    setShareStart(null)
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
      <header className="rule-double flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-8 pt-3 pb-2.5">
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
            {/* Open the folder in the user's code editor — same family as the
                reveal button, one click from the title. */}
            <button
              onClick={openInEditor}
              disabled={project.missing}
              title={t('projectPanel.openInEditor')}
              aria-label={t('projectPanel.openInEditor')}
              className="shrink-0 rounded-sm p-1 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint"
            >
              <SquareCode size={16} strokeWidth={1.75} />
            </button>
            {/* Branch chip — only for git projects: current branch, a dot when
                the working tree is dirty; opens the Branch changes modal. */}
            {branchInfo?.isGit && (
              <button
                onClick={() => setBranchModalOpen(true)}
                disabled={project.missing}
                title={t('projectPanel.branchChipTitle')}
                aria-label={t('projectPanel.branchChipTitle')}
                className="flex min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 py-0.5 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
              >
                <GitBranch size={11} strokeWidth={2} className="shrink-0" />
                <span className="max-w-[180px] truncate font-mono">
                  {branchInfo.branch ?? 'HEAD'}
                </span>
                {branchInfo.working.length > 0 && (
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-ochre"
                  />
                )}
              </button>
            )}
          </div>
          {data && (
            descriptionForLang(data, lang) ? (
              /* ── Filled state: refresh button LEFT, then the generated text.
                    The description is generate-only (no manual editing) — the
                    text swaps in when claude finishes, persisted server-side. ── */
              <div className="mt-1 flex max-w-[560px] items-start gap-1.5">
                {/* Refresh button — spins while claude works */}
                <button
                  onClick={regenerateDescription}
                  disabled={describing || project.missing}
                  title={
                    describing
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
                <p className="min-w-0 flex-1 truncate text-[12px] leading-snug text-ink-muted">
                  {descriptionForLang(data, lang)}
                </p>
              </div>
            ) : (
              /* ── Empty state: a plain text-only generate button (no icon) ── */
              <div className="mt-1">
                <button
                  onClick={regenerateDescription}
                  disabled={describing || project.missing}
                  title={
                    describing
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
          {/* Pre-share occupant of the same slot: a quiet text "Share…"
              button for an unshared git repo — after sharing this exact spot
              becomes the Sync/Live cluster, so the location only has to be
              learned once. Non-git projects show nothing here. */}
          {showHeaderShare(shareStatus, !!project.missing) && (
            <button
              type="button"
              onClick={() => setShareStart('start')}
              title={t('projectPanel.shareButtonHint')}
              className="shrink-0 rounded-sm px-1 py-1 text-[11px] text-ink-faint transition-colors hover:text-ink active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('projectPanel.shareButton')}
            </button>
          )}
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
        // Custom tabs (label from the fetched def, fixed Puzzle icon) — the
        // row renders them wherever `order` puts them; `order` only ever
        // contains tabs ATTACHED to this project (allTabIds above).
        customTabs={customModules.map(customModuleTabDef)}
        // Management affordances are role-gated COSMETICALLY (server is the
        // source of truth): "+" opens the attach picker (owner|tester), which
        // now also carries the marketplace entry.
        onAddTab={customRole !== 'none' ? () => setPickerOpen(true) : undefined}
        // Right-click menu on custom tabs: detach from this project's row
        // (non-destructive — library delete lives in the picker).
        customTabMenu={{ canDetach: canDetachTab, onDetach: detachTabFromProject }}
        // Cards waiting in Review — the reviewer's pull signal (F066). Only
        // counted when the review column is enabled for this board.
        badges={{
          board:
            data?.config?.reviewColumn
              ? data.tasks.filter(t => !t.done && t.boardColumn === 'review').length
              : 0,
        }}
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
            // Live OSC title (what's running) wins over an auto-generated
            // "Terminal N" label; an explicit user rename always wins (see
            // paneHeaderTitle). Gated on loadedForPathRef so the first frame
            // after a project switch can't flash the previous project's title
            // (slot ids like 'default' are shared across projects and the
            // reset effect runs only after that first paint).
            const oscTitle =
              loadedForPathRef.current === project.path
                ? terminalOscTitles[slot.id]
                : undefined
            const headerTitle = paneHeaderTitle(oscTitle, slot.label)
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
                    'group/term relative flex shrink-0 select-none items-center gap-1.5 border-b-2 px-2.5 pt-3 pb-2 text-xs font-semibold transition-colors',
                    termDragId === slot.id
                      ? 'z-30 cursor-grabbing opacity-95 shadow-lg'
                      : 'cursor-grab',
                    active
                      ? 'border-b-accent bg-[#2e2e2e] text-white'
                      : 'border-b-[#272727] bg-[#1c1c1c] text-[#9a9a9a] hover:bg-[#242424] hover:text-[#d4d4d4]',
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
                      // Show the full title on hover (it truncates in a narrow
                      // pane) — both the live OSC title and the slot label when
                      // they differ — + the rename affordance.
                      title={`${paneTooltip(oscTitle, slot.label)}\n(${t('projectPanel.renameTerminal')})`}
                      className="min-w-0 flex-1 truncate"
                    >
                      {headerTitle}
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
                    onTitle={title =>
                      setTerminalOscTitles(prev => {
                        if (title === null) {
                          // Session ended / fresh session connecting — drop
                          // the dead session's title.
                          if (!(slot.id in prev)) return prev
                          const { [slot.id]: _, ...rest } = prev
                          return rest
                        }
                        return prev[slot.id] === title
                          ? prev
                          : { ...prev, [slot.id]: title }
                      })
                    }
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
      ) : isCustomTabId(view) ? (
        // Custom tab: the module's component in a sandboxed iframe, plus the
        // owner's claude sidebar. Keyed by module id so switching between two
        // custom tabs remounts cleanly (fresh poll, fresh sidebar state).
        activeCustomModule ? (
          <CustomModuleView
            key={activeCustomModule.id}
            module={activeCustomModule}
            role={customRole}
            setup={customSetupId === activeCustomModule.id}
            onSetupConsumed={() => setCustomSetupId(null)}
            onChanged={refreshCustomModules}
          />
        ) : (
          // List still loading (or the module vanished — the fallback effect
          // is about to move the view).
          <div className="flex-1 px-8 py-6 text-[12px] text-ink-subtle">
            {t('projectPanel.loading')}
          </div>
        )
      ) : loadError && !data ? (
        // Initial load failed (e.g. the API server isn't running) — an explicit,
        // retryable message beats an endless "Loading…". Retry re-runs the load.
        <div className="flex-1 px-8 py-6 text-[12px] text-ink-subtle">
          {t('projectPanel.loadFailed')}{' '}
          <button
            type="button"
            onClick={() => setReloadNonce(n => n + 1)}
            className="text-ink-faint underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {t('projectPanel.retry')}
          </button>
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
          // Git-shared board (marker detected) — drives the one-line welcome
          // strip a freshly imported shared clone shows above the board.
          shared={shareStatus?.shared ?? false}
          detailId={boardDetailId}
          onOpenDetail={setBoardDetailId}
          // Surface Project Settings right on the Board toolbar (the ⋯ menu
          // entry stays as a second route).
          onOpenProjectSettings={() => setProjectSettingsOpen(true)}
          // A card with a launched terminal counts as "touched" — the drawer's
          // close-discards-empty-card check must not drop it.
          hasTerminalSlot={id => id in taskTerminals}
          // The task's LIVE claude PTY id (launched and not exited) — feeds
          // the drawer's "Insert task into input" button (paste-task route).
          // Read through the refs, not the render-time state: BoardModule's
          // "Review with claude" flow POLLS a captured copy of this callback
          // while a concurrent launch resolves, and a state closure would
          // never see the id land.
          liveTerminalId={id => {
            const ptyId = taskTerminalsRef.current[id]
            return ptyId && !exitedTaskTerminalsRef.current.has(id) ? ptyId : null
          }}
          // Delete lives in the drawer HEADER (next to ×), not floating in the
          // conversation pane.
          onDeleteTask={id => {
            // Tear the task's terminal down with it — else its claude PTY
            // orphans as an idle process nothing renders.
            closeTaskTerminal(id)
            if (data) persist({ ...data, tasks: data.tasks.filter(t => t.id !== id) })
          }}
          // Auto-launched by the drawer once the card has a title (plain
          // claude, no prompt sent) — same launch as the card ▶.
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
                onLaunch={async () => {
                  await launchTaskTerminal(task)
                }}
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
          projectPath={project.path}
          data={data}
          shareStatus={shareStatus}
          projectMissing={!!project.missing}
          onStartShare={() => {
            setProjectSettingsOpen(false)
            setShareStart('start')
          }}
          onShowInvite={() => {
            setProjectSettingsOpen(false)
            setShareStart('invite')
          }}
          onStopShare={() => {
            setProjectSettingsOpen(false)
            setShareDialogError(null)
            setShareDialog('disable')
          }}
          onBrowseMarket={
            customRole !== 'none'
              ? () => {
                  setProjectSettingsOpen(false)
                  setMarketOpen(true)
                }
              : undefined
          }
          onClose={() => setProjectSettingsOpen(false)}
          onChange={(config, launch) => {
            // Autosave: every committed change in the dialog persists right
            // away through the debounced PUT. Closing is separate — only the
            // Back button / ESC dismisses the dialog.
            persist({ ...data, config, launch })
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
        <UnshareConfirm
          busy={shareBusy}
          error={shareDialogError}
          onCancel={() => {
            setShareDialog(null)
            setShareDialogError(null)
          }}
          onConfirm={() => void confirmShareDialog()}
        />
      )}

      {shareStart && (
        <ShareStartDialog
          projectName={project.name}
          projectPath={project.path}
          mode={shareStart}
          shareStatus={shareStatus}
          initialConfig={data?.config}
          syncing={syncing}
          onSync={doSync}
          onEnabled={onShareEnabled}
          onClose={() => setShareStart(null)}
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

      {pickerOpen && (
        <CustomTabPickerDialog
          modules={customModules}
          role={customRole}
          attachedIds={new Set(attachedModuleIds)}
          onAttach={moduleId => {
            attachTabToProject(moduleId)
            setPickerOpen(false)
          }}
          // Create is owner-only (the server re-checks); the picker closes
          // and hands off to the create dialog.
          onCreateNew={
            customRole === 'owner'
              ? () => {
                  setPickerOpen(false)
                  setCustomCreateOpen(true)
                }
              : undefined
          }
          onBrowseMarket={
            customRole !== 'none'
              ? () => {
                  setPickerOpen(false)
                  setMarketOpen(true)
                }
              : undefined
          }
          onDelete={deleteCustomModule}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {customCreateOpen && (
        <CustomTabCreateDialog
          onCreated={def => void onCustomTabCreated(def)}
          onClose={() => setCustomCreateOpen(false)}
        />
      )}

      {marketOpen && (
        <MarketplaceDialog
          installedRemoteIds={
            new Set(
              customModules
                .map(m => m.remoteId)
                .filter((id): id is string => !!id),
            )
          }
          onInstalled={async def => {
            // The library list first (so the new module exists everywhere the
            // row derives from), then auto-attach to the CURRENT project.
            await refreshCustomModules()
            const base = dataRef.current
            if (base) {
              persist({ ...base, customTabs: attachCustomTab(base.customTabs, def.id) })
            }
          }}
          onClose={() => setMarketOpen(false)}
        />
      )}

      {feedbackEnabled && (
        <FeedbackModal
          open={feedbackOpen}
          onClose={() => setFeedbackOpen(false)}
        />
      )}

      <BranchChangesModal
        open={branchModalOpen}
        path={project.path}
        onClose={() => setBranchModalOpen(false)}
        onData={setBranchInfo}
      />
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

// Unshare confirmation. Same modal language as DeleteConfirm (the panel's
// established pattern): full-panel overlay, label-cap heading, one short
// explanation paragraph, inline error, subtle-cancel + primary-confirm.
// (Enabling has its own ShareStartDialog — this side stays a confirm.)
const UnshareConfirm = ({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}) => {
  const { t } = useT()
  return (
    <div data-esc-overlay className="absolute inset-0 z-20 flex flex-col justify-center gap-5 bg-bg-card px-6">
      <div className="mx-auto w-full max-w-[420px]">
        <p className="label-cap text-accent mb-2">
          {t('projectPanel.unshareDialogLabel')}
        </p>
        <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
          {t('projectPanel.unshareDialogTitle')}
        </h3>
        <p className="mt-2.5 text-[12px] leading-relaxed text-ink-muted">
          {t('projectPanel.unshareDialogExplain')}
        </p>
        {/* S036: the teammates' clones fall back to their (empty) central
            data once the removal lands — warn the owner to tell them. */}
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          {t('projectPanel.unshareTeammateNote')}
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
              : t('projectPanel.unshareConfirm')}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// Project settings — section layout adapts to the project's share/git state
// (settingsSections in src/lib/shareUx.ts — docs/SHARE_UX_FLOWS.md §2a):
//   - shared:           共有 (team) + タスクのワークフロー + Personal
//   - unshared git:     タスクのワークフロー + Personal + "share…" CTA
//                       (NO share vocabulary anywhere — S033/S034)
//   - non-git:          Personal only (S047)
// AUTOSAVE dialog: every committed change persists the moment it's made (the
// parent debounces the PUT); a single Back button / ESC just dismisses. The
// display name is a GLOBAL setting (settings.displayName) edited inline while
// shared and saved to /api/settings on its own debounced path — separate from
// the per-project config.

const ProjectSettingsDialog = ({
  projectName,
  projectPath,
  data,
  shareStatus,
  projectMissing,
  onStartShare,
  onShowInvite,
  onStopShare,
  onBrowseMarket,
  onClose,
  onChange,
}: {
  projectName: string
  projectPath: string
  data: ProjectData
  /** null = unknown (share routes unreachable) → conservative layout. */
  shareStatus: ShareStatus | null
  projectMissing: boolean
  /** Open the ShareStartDialog (the bottom CTA, unshared git repos only). */
  onStartShare: () => void
  /** Re-show the invite panel (shared projects). */
  onShowInvite: () => void
  /** Open the unshare confirmation (shared projects). */
  onStopShare: () => void
  /** Owner|tester: open the marketplace dialog (the parent closes settings
   *  first). undefined hides the settings-side marketplace entry. */
  onBrowseMarket?: () => void
  onClose: () => void
  onChange: (config: ProjectConfig, launch: ProjectLaunchPrefs) => void
}) => {
  const { t } = useT()
  const sections = useMemo(() => settingsSections(shareStatus), [shareStatus])

  // ESC dismisses the dialog (same as the Back button). Skips an Escape that
  // cancels an IME composition or one another handler already consumed, and
  // preventDefault keeps App's global Escape handler (clear selection / close
  // panel / JumpPalette) from also acting on it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Workflow drafts. (completionFlow and the launch profile — permission
  // mode / model / effort — are edited on the Board's run-defaults strip
  // since 2026-06-12; this dialog no longer duplicates them.)
  const [targetBranch, setTargetBranch] = useState(data.config?.targetBranch ?? '')
  // Dedupe on init: legacy / shared boards can carry exact-duplicate names
  // (which would collide as React keys and make one ✕ remove all twins).
  const [members, setMembers] = useState<string[]>(() =>
    Array.from(new Set(data.config?.members ?? [])),
  )
  // Personal drafts
  const [autoSync, setAutoSync] = useState(data.launch?.autoSync !== false)

  // Display name (GLOBAL settings) — read on open while the team section is
  // visible; null = still loading (input disabled, never clobbered by a slow
  // fetch). Saved back via POST /api/settings only when actually changed.
  const [displayName, setDisplayName] = useState<string | null>(null)
  const initialDisplayNameRef = useRef<string>('')
  useEffect(() => {
    if (!sections.team) return
    let cancelled = false
    fetch('/api/settings', { cache: 'no-store' })
      .then(r => (r.ok ? (r.json() as Promise<SettingsResponse>) : null))
      .then(body => {
        if (cancelled) return
        initialDisplayNameRef.current = body?.displayName ?? ''
        setDisplayName(prev => (prev !== null ? prev : (body?.displayName ?? '')))
      })
      .catch(() => {
        if (!cancelled) setDisplayName(prev => (prev !== null ? prev : ''))
      })
    return () => {
      cancelled = true
    }
  }, [sections.team])
  // Display name autosave — its own debounced write to /api/settings (the
  // POST merges partial bodies), since it is GLOBAL, not part of ProjectData.
  // Local state stays the source of truth (nothing re-reads the server after
  // the initial fetch), so an in-flight IME composition is never rolled back.
  // Blur — and unmount, for a Back/ESC right after typing — flushes the
  // pending write. A FAILED post is never swallowed (assignees/mineOnly
  // depend on the name): the error shows inline under the field, and
  // lastPosted rolls back so the next change/blur retries naturally.
  const displayNameRef = useRef<string | null>(null)
  displayNameRef.current = displayName
  const displayNameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastPostedDisplayName = useRef<string | null>(null)
  const [displayNameError, setDisplayNameError] = useState<string | null>(null)
  const postDisplayName = useCallback(() => {
    const raw = displayNameRef.current
    if (raw === null) return
    const v = raw.trim()
    const prev = lastPostedDisplayName.current ?? initialDisplayNameRef.current
    if (v === prev) return
    lastPostedDisplayName.current = v
    void fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: v }),
    })
      .catch(() => null)
      .then(res => {
        if (res && res.ok) {
          setDisplayNameError(null)
          return
        }
        // Roll back ONLY if no newer post superseded this one, so the next
        // edit / blur diffs against the last value the server confirmed.
        if (lastPostedDisplayName.current === v) {
          lastPostedDisplayName.current = prev
        }
        setDisplayNameError(
          t('projectPanel.settingsDisplayNameSaveFailed', {
            error: res ? `HTTP ${res.status}` : t('projectPanel.networkError'),
          }),
        )
      })
  }, [t])
  const flushDisplayName = useCallback(() => {
    if (displayNameTimer.current) {
      clearTimeout(displayNameTimer.current)
      displayNameTimer.current = null
    }
    postDisplayName()
  }, [postDisplayName])
  const scheduleDisplayNameSave = useCallback(() => {
    if (displayNameTimer.current) clearTimeout(displayNameTimer.current)
    displayNameTimer.current = setTimeout(() => {
      displayNameTimer.current = null
      postDisplayName()
    }, 350)
  }, [postDisplayName])
  useEffect(() => flushDisplayName, [flushDisplayName])

  // The repo's branch list (shared hook with ShareStartDialog) — a failed
  // fetch / non-git folder falls back to the plain text input.
  const { branches, failed: branchesFailed } = useProjectBranches(projectPath)
  // Central worktrees (B012 / F082) — fetched once when the dialog opens so
  // the Personal column can show "n active · m dirty" and offer a one-click
  // sweep of the CLEAN ones. null = loading; a failed fetch hides the section's
  // numbers (it shows the error instead of fake zeros).
  const [worktrees, setWorktrees] = useState<ProjectWorktreeInfo[] | null>(null)
  const [worktreesFailed, setWorktreesFailed] = useState(false)
  const [wtCleaning, setWtCleaning] = useState(false)
  const [wtResult, setWtResult] = useState<CleanWorktreesResult | null>(null)
  const [wtError, setWtError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/project/worktrees?path=${encodeURIComponent(projectPath)}`)
      .then(r =>
        r.ok
          ? (r.json() as Promise<{ worktrees: ProjectWorktreeInfo[] }>)
          : Promise.reject(new Error(String(r.status))),
      )
      .then(body => {
        if (!cancelled) setWorktrees(Array.isArray(body.worktrees) ? body.worktrees : [])
      })
      .catch(() => {
        if (!cancelled) setWorktreesFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectPath])

  const cleanWorktrees = async () => {
    setWtCleaning(true)
    setWtError(null)
    try {
      const res = await fetch('/api/project/worktrees/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || String(res.status))
      setWtResult({
        removed: Array.isArray(body.removed) ? body.removed : [],
        skippedDirty: Array.isArray(body.skippedDirty) ? body.skippedDirty : [],
      })
      // Refresh the count so the line above the button agrees with the sweep.
      const after = await fetch(
        `/api/project/worktrees?path=${encodeURIComponent(projectPath)}`,
      )
      if (after.ok) {
        const fresh = (await after.json()) as { worktrees: ProjectWorktreeInfo[] }
        setWorktrees(Array.isArray(fresh.worktrees) ? fresh.worktrees : [])
      }
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e))
    } finally {
      setWtCleaning(false)
    }
  }

  // A saved target branch outside the offered list (deleted branch, …) stays
  // selectable. Captured ONCE at mount — with autosave the `data` prop
  // refreshes after every change, and deriving from the live prop would drop
  // the extra option the moment the user switches away (no way back without
  // reopening the dialog).
  const [savedBranch] = useState(() => (data.config?.targetBranch ?? '').trim())

  // Autosave: each committed change persists immediately (the parent debounces
  // the PUT). Local state stays the source of truth for every edited field —
  // the refreshed `data` prop is only spread for the keys this dialog does NOT
  // edit (completionFlow, the launch profile — both live on the Board's
  // run-defaults strip now), so an in-flight edit (or an IME composition) is
  // never rolled back by a save round-trip. setState is async, so each change
  // site passes its new value as an override.
  const dataRef = useRef(data)
  dataRef.current = data
  const persistChange = (over: {
    targetBranch?: string
    members?: string[]
    autoSync?: boolean
  }) => {
    const d = dataRef.current
    // Spread first: every config key this dialog doesn't currently SHOW
    // (completionFlow, verifyCommands, reviewColumn — and the
    // workflow/members fields when their sections are hidden) is carried
    // through untouched — saving must never strip data the user couldn't see.
    const config: ProjectConfig = { ...d.config }
    if (sections.workflow) {
      config.targetBranch = (over.targetBranch ?? targetBranch).trim() || undefined
      // The members list is editable in BOTH layouts: as the team roster
      // while shared, and as the plain assignee-name roster (workflow
      // section) on an unshared git project.
      const nextMembers = over.members ?? members
      config.members = nextMembers.length > 0 ? nextMembers : undefined
    }
    const launch: ProjectLaunchPrefs = { ...d.launch }
    if (sections.team) {
      // Default ON — only an explicit opt-out is stored. Only editable while
      // shared (the checkbox lives in the team section); otherwise the spread
      // above preserves whatever was saved.
      launch.autoSync = (over.autoSync ?? autoSync) ? undefined : false
    }
    onChange(config, launch)
  }

  return (
    // Scroll container OUTSIDE, centering INSIDE: `grid place-items-center`
    // on a min-h-full inner track centers short content but grows with tall
    // content, so the header can never be clipped above the scroll origin
    // (the old flex-center + my-auto pattern clipped the top edge).
    <div data-esc-overlay className="absolute inset-0 z-20 overflow-y-auto bg-bg-card">
      <div className="grid min-h-full place-items-center">
        <div className="mx-auto w-full max-w-[760px] px-8 py-10">
          <p className="label-cap text-accent mb-2">
            {t('projectPanel.settingsDialogLabel')}
          </p>
          <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
            {projectName}
          </h3>

          {/* Two columns on md+ when the project has more than Personal to
              show: 共有(team) + workflow stack on the left, Personal on the
              right; stacks vertically on narrow widths. A non-git project
              collapses to the Personal column alone. */}
          <div
            className={[
              'mt-5 grid grid-cols-1 gap-x-10',
              sections.team || sections.workflow ? 'md:grid-cols-2' : '',
            ].join(' ')}
          >
            {(sections.team || sections.workflow) && (
              <div>
                {/* ── 共有 — only while actually shared (S033/S034) ── */}
                {sections.team && (
                  <div className="border-t border-line pt-4">
                    <p className="label-cap text-ink">{t('projectPanel.settingsTeamHeading')}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                      {t('projectPanel.settingsTeamHint')}
                    </p>
                    {/* Status one-liner: where it syncs (remote · branch). */}
                    {(remoteShortName(shareStatus?.remoteUrl ?? null) || shareStatus?.branch) && (
                      <p className="mt-2 flex items-center gap-2 font-mono text-[10px] text-ink-faint">
                        {remoteShortName(shareStatus?.remoteUrl ?? null) && (
                          <span
                            title={shareStatus?.remoteUrl ?? undefined}
                            className="max-w-[180px] truncate"
                          >
                            {remoteShortName(shareStatus?.remoteUrl ?? null)}
                          </span>
                        )}
                        {shareStatus?.branch && (
                          <span className="flex items-center gap-0.5">
                            <GitBranch size={10} className="shrink-0" aria-hidden />
                            <span className="truncate">{shareStatus.branch}</span>
                          </span>
                        )}
                      </p>
                    )}

                    <div className="mt-3 space-y-3.5">
                      {/* Your display name — the GLOBAL setting, editable in
                          the share context where it matters (S009/S018). */}
                      <div>
                        <label className="mb-1 block label-cap text-ink-muted">
                          {t('projectPanel.settingsDisplayName')}
                        </label>
                        <input
                          value={displayName ?? ''}
                          onChange={e => {
                            setDisplayName(e.target.value)
                            scheduleDisplayNameSave()
                          }}
                          onBlur={flushDisplayName}
                          disabled={displayName === null}
                          placeholder={t('projectPanel.settingsDisplayName')}
                          className={FIELD_INPUT_CSS}
                        />
                        {displayNameError && (
                          <p className="mt-1 text-[11px] leading-relaxed text-accent">
                            {displayNameError}
                          </p>
                        )}
                        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                          {t('projectPanel.settingsDisplayNameHint')}
                        </p>
                      </div>

                      {/* MembersField keeps its typing draft internal — only
                          an Add-confirmed name (or a ✕ removal) reaches
                          onChange, so unconfirmed text is never persisted. */}
                      <MembersField
                        members={members}
                        onChange={next => {
                          setMembers(next)
                          persistChange({ members: next })
                        }}
                        hint={t('projectPanel.settingsMembersSyncHint')}
                      />

                      <div>
                        <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-ink transition-colors hover:text-accent">
                          <input
                            type="checkbox"
                            checked={autoSync}
                            onChange={e => {
                              setAutoSync(e.target.checked)
                              persistChange({ autoSync: e.target.checked })
                            }}
                            className="accent-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          />
                          {t('projectPanel.settingsAutoSync')}
                        </label>
                        {/* Sits in the share context but is PERSONAL — say so. */}
                        <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                          {t('projectPanel.settingsAutoSyncDeviceNote')}{' '}
                          {t('projectPanel.settingsAutoSyncHint')}
                        </p>
                      </div>

                      {/* Text links: re-show the invite instructions (S015's
                          standing entry) / stop sharing (moved here from ⋯). */}
                      <div className="flex flex-col items-start gap-1.5">
                        <button
                          type="button"
                          onClick={onShowInvite}
                          className="text-[12px] text-ink-muted underline-offset-2 transition-colors hover:text-ink hover:underline active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {t('projectPanel.settingsInviteLink')}
                        </button>
                        <button
                          type="button"
                          onClick={onStopShare}
                          className="text-[12px] text-accent underline-offset-2 transition-colors hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {t('projectPanel.unshareMenu')}
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ── タスクのワークフロー — git projects (no share words) ── */}
                {sections.workflow && (
                  <div
                    className={[
                      'border-t border-line pt-4',
                      sections.team ? 'mt-5' : '',
                    ].join(' ')}
                  >
                    <p className="label-cap text-ink">{t('projectPanel.settingsWorkflowHeading')}</p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                      {t(
                        sections.team
                          ? 'projectPanel.settingsWorkflowSharedHint'
                          : 'projectPanel.settingsWorkflowHint',
                      )}
                    </p>
                    <div className="mt-3 space-y-3.5">
                      {/* The completion-flow choice (merge/PR) moved to the
                          Board's run-defaults strip (2026-06-12) — one editor,
                          right where tasks run. This section keeps the fields
                          with no second home: base branch + roster. */}
                      <TargetBranchField
                        value={targetBranch}
                        onChange={v => {
                          setTargetBranch(v)
                          persistChange({ targetBranch: v })
                        }}
                        branches={branches}
                        branchesFailed={branchesFailed}
                        savedBranch={savedBranch}
                      />
                      {/* Assignee-name roster for UNSHARED git projects —
                          deliberately share-free vocabulary ("assignee
                          names", not "members"/"team"): solo users assign
                          cards too. While shared the same list lives in the
                          共有 section above as the team roster. */}
                      {!sections.team && (
                        <MembersField
                          members={members}
                          onChange={next => {
                            setMembers(next)
                            persistChange({ members: next })
                          }}
                          label={t('projectPanel.settingsAssigneeNames')}
                          hint={t('projectPanel.settingsAssigneeNamesHint')}
                        />
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Personal ── */}
            <div
              className={[
                'border-t border-line pt-4',
                sections.team || sections.workflow ? 'mt-5 md:mt-0' : '',
              ].join(' ')}
            >
              <p className="label-cap text-ink">{t('projectPanel.settingsPersonalHeading')}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                {t('projectPanel.settingsPersonalHint')}
              </p>

              <div className="mt-3 space-y-3.5">
                {/* The launch profile (model / effort / permission mode) moved
                    to the Board's run-defaults strip (2026-06-12) — visible
                    and editable right where tasks run, overridable per card.
                    One quiet pointer so dialog visitors aren't stranded. */}
                <p className="text-[11px] leading-relaxed text-ink-faint">
                  {t('projectPanel.settingsLaunchMovedHint')}
                </p>

                {/* Marketplace — the tab row no longer carries a bare "Market"
                    text entry; this is the settings-side way in (the "+" picker
                    carries the other). owner|tester only. */}
                {onBrowseMarket && (
                  <div>
                    <label className="mb-1 block label-cap text-ink-muted">
                      {t('customTabs.market')}
                    </label>
                    <p className="text-[12px] leading-relaxed text-ink-faint">
                      {t('customTabs.marketHint')}
                    </p>
                    <button
                      type="button"
                      onClick={onBrowseMarket}
                      className="mt-1.5 inline-flex items-center gap-2 rounded-sm border border-line px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      <Store size={13} strokeWidth={2} className="shrink-0" />
                      {t('customTabs.marketBrowse')}
                    </button>
                  </div>
                )}

                {/* ── Worktrees (B012/F082) — sweep the task/review checkouts
                    that pile up under ~/.openground/…/worktrees/. Only CLEAN
                    ones are removed; dirty ones are reported, never touched.
                    A git concept — hidden for known non-git folders (S047). */}
                {sections.worktrees && (
                <div>
                  <label className="mb-1 block label-cap text-ink-muted">
                    {t('projectPanel.settingsWorktrees')}
                  </label>
                  <p className="text-[12px] text-ink">
                    {worktreesFailed
                      ? t('projectPanel.settingsWorktreesUnavailable')
                      : worktrees === null
                        ? t('projectPanel.settingsWorktreesLoading')
                        : worktrees.length === 0
                          ? t('projectPanel.settingsWorktreesNone')
                          : t('projectPanel.settingsWorktreesCount', {
                              count: String(worktrees.length),
                              dirty: String(worktrees.filter(w => w.dirty).length),
                            })}
                  </p>
                  {worktrees !== null && worktrees.length > 0 && (
                    <button
                      type="button"
                      onClick={cleanWorktrees}
                      disabled={wtCleaning}
                      className="mt-1.5 rounded-sm border border-line px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {wtCleaning
                        ? t('projectPanel.settingsWorktreesCleaning')
                        : t('projectPanel.settingsWorktreesClean')}
                    </button>
                  )}
                  {wtResult && !wtCleaning && (
                    <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                      {t('projectPanel.settingsWorktreesResult', {
                        removed: String(wtResult.removed.length),
                        skipped: String(wtResult.skippedDirty.length),
                      })}
                    </p>
                  )}
                  {wtError && (
                    <p className="mt-1 text-[11px] leading-relaxed text-accent">
                      {t('projectPanel.settingsWorktreesFailed', { error: wtError })}
                    </p>
                  )}
                  <p className="mt-1 text-[11px] leading-relaxed text-ink-faint">
                    {t('projectPanel.settingsWorktreesHint')}
                  </p>
                </div>
                )}
              </div>
            </div>
          </div>

          {/* ── Share CTA — only for a positively-known unshared git repo
              (the second entry point besides the header Share… button). ── */}
          {sections.shareCta && (
            <div className="mt-6 border-t border-line pt-4">
              <p className="text-[11px] leading-relaxed text-ink-faint">
                {t('projectPanel.settingsShareCtaText')}
              </p>
              <button
                type="button"
                onClick={onStartShare}
                disabled={projectMissing}
                title={projectMissing ? t('projectPanel.folderGone') : undefined}
                className="mt-1.5 rounded-sm border border-line px-2.5 py-1.5 text-[11px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t('projectPanel.settingsShareCta')}
              </button>
            </div>
          )}

          {/* Autosave dialog — no Save/Cancel pair; Back just dismisses
              (every change is already persisted the moment it's made). */}
          <div className="mt-6 flex items-center justify-end">
            <Btn variant="subtle" size="md" onClick={onClose}>
              {t('projectPanel.settingsBack')}
            </Btn>
          </div>
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
  customTabs,
  onAddTab,
  customTabMenu,
  badges,
}: {
  view: PanelView
  onChange: (v: PanelView) => void
  // Per-project, normalised left-to-right tab order (ids only).
  order: PanelView[]
  // Commit a drag from index `from` to insertion slot `to` (original-array index
  // space, matching moveTab's convention).
  onReorder: (from: number, to: number) => void
  terminalInfo: TerminalInfo | null
  /** Custom-tab row metadata (`custom:<uuid>` ids — docs/CUSTOM_TABS_PLAN.md).
   *  Ids in `order` with no entry here (a module deleted elsewhere) just
   *  don't render. */
  customTabs?: TabDef[]
  /** Owner|tester "+" (open the per-project attach picker); undefined hides it. */
  onAddTab?: () => void
  /** Right-click menu on custom tabs — DETACH from this project's row only
   *  (non-destructive, no confirm; library delete lives in the "+" picker).
   *  `canDetach` decides whether a tab id gets the menu at all. Undefined
   *  disables the menu entirely. */
  customTabMenu?: {
    canDetach: (id: string) => boolean
    onDetach: (id: string) => void | Promise<void>
  }
  /** Optional per-tab count chip (e.g. board → cards waiting in Review).
   *  0/undefined renders nothing — the row stays quiet by default. */
  badges?: Partial<Record<PanelView, number>>
}) => {
  const { t } = useT()
  // Metadata (icon/label) keyed by id; the row is rendered in `order`.
  const byId = useMemo(() => {
    const m = new Map<PanelView, TabDef>()
    for (const def of enabledModules()) m.set(def.id, def)
    for (const def of customTabs ?? []) m.set(def.id, def)
    return m
  }, [customTabs])
  const tabs = order.map(id => byId.get(id)).filter((m): m is TabDef => !!m)

  // Right-click menu on a custom tab (detach from this project's row —
  // non-destructive, single click, no confirm). Fixed-positioned at the
  // cursor; dismissed by the backdrop, Escape, or completing the action.
  const [tabMenu, setTabMenu] = useState<{
    id: PanelView
    x: number
    y: number
  } | null>(null)
  useEffect(() => {
    if (!tabMenu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTabMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tabMenu])

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
            onContextMenu={e => {
              // Custom tabs only, and only when the role offers an action.
              if (!customTabMenu?.canDetach(m.id)) return
              e.preventDefault()
              setTabMenu({ id: m.id, x: e.clientX, y: e.clientY })
            }}
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
            {(badges?.[m.id] ?? 0) > 0 && (
              <span
                title={t('projectPanel.reviewWaitingTitle')}
                className="rounded-full border border-ochre/60 px-1.5 text-[9px] font-medium leading-[14px] text-[var(--beacon-waiting)]"
              >
                {badges![m.id]}
              </span>
            )}
            {barAfter && (
              <span className="pointer-events-none absolute -right-2 top-1 bottom-1 w-0.5 bg-accent" />
            )}
          </button>
        )
      })}
      {/* Custom-tab management (docs/CUSTOM_TABS_PLAN.md): a quiet trailing
          "+" (owner: create) and a text "Market" entry (owner|tester) — both
          invisible to everyone else. Text-first, no extra decoration. */}
      {onAddTab && (
        <button
          type="button"
          onClick={onAddTab}
          title={t('customTabs.addTabHint')}
          aria-label={t('customTabs.addTab')}
          className="mb-1 rounded-sm p-1 text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <Plus size={12} strokeWidth={2.25} />
        </button>
      )}
      {/* The marketplace no longer sits as a bare text entry in the tab row.
          It moved into the "+" picker (「マーケットで探す」) and Project settings,
          so the tab row stays tabs-only (docs/CUSTOM_TABS_PLAN.md). */}
      {tabMenu &&
        customTabMenu &&
        customTabMenu.canDetach(tabMenu.id) && (
          <>
            {/* Invisible backdrop: any click outside the menu dismisses it
                (a right-click outside dismisses too, without opening the
                browser menu over our UI). */}
            <div
              className="fixed inset-0 z-40"
              onMouseDown={() => setTabMenu(null)}
              onContextMenu={e => {
                e.preventDefault()
                setTabMenu(null)
              }}
            />
            <div
              role="menu"
              className="fixed z-50 min-w-[168px] overflow-hidden rounded-[6px] border border-line bg-bg-card py-1 shadow-card-hover"
              style={{ left: tabMenu.x, top: tabMenu.y }}
            >
              {/* Detach is non-destructive (the module stays in the library),
                  so it fires on the first click — no confirm, no danger
                  styling, a Minus rather than a trash can. */}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void customTabMenu.onDetach(tabMenu.id)
                  setTabMenu(null)
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-bg-inset active:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
              >
                <Minus size={13} strokeWidth={2} className="shrink-0" />
                <span className="flex-1">{t('customTabs.detach')}</span>
              </button>
            </div>
          </>
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

// The share entry points moved out of this menu (docs/SHARE_UX_FLOWS.md §2b):
// enabling lives on the header "Share…" button + the settings CTA, and
// stopping lives in the settings dialog's 共有 section.
const MoreMenu = ({
  onProjectSettings,
  projectSettingsDisabled,
  onRemove,
  onDelete,
}: {
  /** Open the Project settings dialog (workflow/team + personal launch
   *  prefs). Disabled until the project's data has loaded. */
  onProjectSettings: () => void
  projectSettingsDisabled?: boolean
  onRemove: () => void
  onDelete: () => void
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
