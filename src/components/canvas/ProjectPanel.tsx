import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Archive,
  ChevronDown,
  EyeOff,
  FolderOpen,
  GitBranch,
  Loader2,
  Minus,
  MoreHorizontal,
  Plus,
  RotateCw,
  Sparkles,
  SquareCode,
  Star,
  Store,
  Terminal,
  Trash2,
  X,
} from 'lucide-react'
import { Btn } from '@/components/ui/Btn'
import { BackLink } from '@/components/ui/BackLink'
import { Overlay, DialogHeader } from '@/components/ui/overlay'
import { useT } from '@/i18n/I18nContext'
import type {
  BranchChangesResponse,
  ActiveBranchesResponse,
  DescribeActiveResponse,
  DescribeJobState,
  OpenApp,
  ProjectConfig,
  ProjectData,
  ProjectLaunchPrefs,
  ProjectMeta,
  ProjectTask,
  ProjectWorktreeInfo,
  CleanWorktreesResult,
  CustomModuleDef,
  ExperimentFlags,
  ActiveTerminalsResponse,
} from '@/lib/types'
import { api } from '@/lib/api-client'
import {
  MembersField,
  TargetBranchField,
  useProjectBranches,
} from '@/components/canvas/ProjectConfigFields'
import { CollabInviteDialog } from '@/components/canvas/CollabInviteDialog'
import { SharedProjectBody } from '@/components/canvas/SharedProjectBody'
import { useCollab } from '@/lib/collab/RealtimeContext'
import { migrateLs } from '@/lib/lsMigrate'
import {
  loadPersistedView,
  savePersistedView,
  type PersistedPanelTab,
  type PersistedView,
} from '@/lib/persistView'
import { paneHeaderTitle, paneTooltip } from '@/lib/paneTitle'
import { descriptionForLang } from '@/lib/descriptionLang'
import { reconcileExternalData } from '@/lib/projectDataReconcile'
import {
  TerminalPane,
  type TerminalInfo,
  type TerminalPaneHandle,
} from '@/components/canvas/TerminalPane'
import { ContextGauge, type ContextAction } from '@/components/canvas/ContextGauge'
import { slashOutcome, type ContextActionOutcome, type ContextLeftSource } from '@/lib/contextGauge'
import { BoardTaskTerminal } from '@/components/canvas/TaskTerminal'
import { TerminalDock } from '@/components/canvas/EmbeddedClaudeTerminal'
import { ClaudeTerminalPane } from '@/components/canvas/ClaudeTerminalPane'
import { useClaudeConnection } from '@/lib/useClaudeConnection'
import { ProjectCanvas } from '@/components/canvas/ProjectCanvas'
import { BranchChangesModal } from '@/components/canvas/BranchChangesModal'
import { SkillsModal } from '@/components/canvas/SkillsModal'
import { UsageHud } from '@/components/canvas/UsageHud'
import {
  BoardModule,
  type TaskLaunchResult,
  type TaskRunPayload,
} from '@/components/canvas/modules/BoardModule'
import {
  customModuleTabDef,
  enabledModules,
  gateFromFlags,
  isModuleIdEnabled,
  nativeDescriptors,
  tabLabel,
  type ModuleGate,
  type TabDef,
} from '@/components/canvas/moduleRegistry'
import { SwarmModule } from '@/components/canvas/modules/SwarmModule'
import { PersonaModule } from '@/components/canvas/modules/PersonaModule'
import { customTabId, customModuleIdFromTab, isCustomTabId, type ModuleId } from '@/lib/modules/ids'
import { usePlayback } from '@/lib/playback/playbackStore'
import { PlaybackEq } from '@/components/canvas/PlaybackEq'
import { effectiveTabOrder, moveTab, preserveCustomTabs } from '@/lib/modules/tabOrder'
import { attachCustomTab, detachCustomTab } from '@/lib/modules/customTabAttach'
import { disableNativeModule, enableNativeModule } from '@/lib/modules/nativeEnable'
import { useCustomModules } from '@/lib/modules/useCustomModules'
import { CustomModuleView } from '@/components/canvas/modules/CustomModuleView'
import { customModuleStorageId } from '@/components/canvas/modules/CustomModuleView'
import {
  destroyFrame,
  destroyFrameIfProject,
  destroyFramesForProject,
} from '@/components/canvas/modules/CustomFrameHost'
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

// Module-level constant so the `experiments` fallback (used when the prop is
// undefined, e.g. a non-owner render) is referentially stable across renders —
// see moduleGate's useMemo below, which depends on `experiments` by identity.
const NO_EXPERIMENT_FLAGS: ExperimentFlags = {
  swarm: false,
  sandbox: false,
  persona: false,
}

// The single right-click action a tab in the row offers: 'detach' a custom tab
// (non-destructive, the module stays in the library) or 'disable' a built-in
// (hide it from this project via disabledModules). The row's menu derives its
// label/icon from `kind`; null from the resolver means no menu for that tab.
type TabRowAction = { kind: 'detach' | 'disable'; run: () => void | Promise<void> }

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
// How often the Terminal tab re-reads each pane's context fuel gauge. Slower
// than the Ground's 5s status beacon on purpose: the reading only moves once
// per claude turn, and resolving it costs the server a transcript read per pane.
const CONTEXT_POLL_MS = 10_000
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
  /** Resolved owner-only experiment gate (owner && the settings toggle, decided
   *  server-side). Drives which experimental modules surface as tabs. Omitted /
   *  all-false ⇒ no experimental module shows — the default for every non-owner
   *  and the shipped build, so the tab row is unchanged for everyone else. */
  experiments?: ExperimentFlags
  /** Member capability flag — the SINGLE owner/member switch. When present, this
   *  project is a folder-less collab project shared WITH the user, so ProjectPanel
   *  renders the member body (Board + Canvas over the Cloudflare DO — no Terminal/
   *  Claude tabs, Share invite, branch chip, Reveal in Finder, Open in Editor, or
   *  Generate description). Absent ⇒ the owner body, byte-for-byte unchanged. */
  shared?: { id: string; label: string }
}

// The owner body — the full project surface (Terminal / Canvas / Board / Swarm /
// custom tabs, header chrome, settings, delete, share invite). Rendered by
// ProjectPanel for every NON-shared project. Unchanged from the pre-merge panel.
const OwnedProjectBody = ({
  project,
  onClose,
  onRemove,
  onSaved,
  onDeleted,
  onRename,
  onRelocate,
  frameLabel,
  feedbackEnabled,
  experiments,
}: Props) => {
  const { t, lang } = useT()
  // Per-tab contextual feedback: opening the modal here tags the submission
  // with the active tab (source + display label) so the report says which
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

  // ── Regenerate description (a navigation-safe server-side JOB) ──────────────
  // Subscription-only: the server runs claude inside a PTY (never `claude -p`).
  // POST /api/project/describe now START a JOB and returns { jobId } at once; the
  // run completes + PERSISTS the description server-side even if the user
  // navigates away, and the client polls the job. The result swaps in as the new
  // description (no edit form, no ⌘↵) once the job lands.
  //
  // `describeJob` carries the PATH it belongs to, not a bare boolean: this panel
  // is reused across project switches (no key), so a job is "mine" only while
  // its path matches the open project. `id: null` is the brief optimistic
  // "starting" window between the click and the {jobId} response.
  const [describeJob, setDescribeJob] = useState<{ id: string | null; path: string } | null>(
    null,
  )
  const describing = !!project && describeJob?.path === project.path
  // Paths whose describe was STOPPED during the optimistic "starting" window —
  // before the start POST returned a jobId, so there was nothing to cancel yet.
  // The start POST consults this the moment it learns the jobId and cancels the
  // job the server already created. Path-keyed (a Set) so a Stop on project A
  // still cancels A even if the user kicks off project B before A's POST returns.
  const describeCancelStartRef = useRef<Set<string>>(new Set())

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

  // ── "Open in editor" split button: `<>` launches, `▼` chooses ──────────────
  // The editors actually installed on this machine (macOS Applications scan)
  // plus a remembered one-click default. The `<>` half ALWAYS launches in one
  // click — the default if set, else the first detected editor, else the
  // server's CLI auto-detection — it never opens the menu. The separate `▼`
  // half is the only thing that drops the chooser (open any editor, star one as
  // the default, pick another app, clear the default).
  const [editorMenuOpen, setEditorMenuOpen] = useState(false)
  const [installedEditors, setInstalledEditors] = useState<OpenApp[]>([])
  const [defaultEditor, setDefaultEditor] = useState<OpenApp | null>(null)
  const [canPickEditor, setCanPickEditor] = useState(false)
  // The header dropdowns (editor / branch) render through a body portal at
  // overlay-modal z, NOT as in-panel absolute children: a hosted custom-tab
  // iframe (CustomFrameHost, z 45) draws OVER the whole panel stacking context
  // (z 40), so any in-panel z — however high — would sit under it. Portaling
  // to <body> at 50 keeps the menus above the frame. Position is measured from
  // the trigger when the menu opens (fixed coords; the menus close on resize).
  const editorBtnRef = useRef<HTMLButtonElement | null>(null)
  const [editorMenuPos, setEditorMenuPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!editorMenuOpen) {
      setEditorMenuPos(null)
      return
    }
    const r = editorBtnRef.current?.getBoundingClientRect()
    if (r) setEditorMenuPos({ left: r.left, top: r.bottom + 4 })
  }, [editorMenuOpen])
  useEffect(() => {
    fetch('/api/project/editors')
      .then(
        (r) =>
          r.json() as Promise<{
            editors?: OpenApp[]
            default?: OpenApp | null
            canPick?: boolean
          }>,
      )
      .then((d) => {
        setInstalledEditors(d.editors ?? [])
        setDefaultEditor(d.default ?? null)
        setCanPickEditor(!!d.canPick)
      })
      .catch(() => {})
  }, [])
  // Outside-click closes the menu. Both the trigger container AND the portaled
  // menu stop mousedown propagation (see the JSX) — React portal events bubble
  // through the REACT tree and a synthetic stopPropagation halts the native
  // event too, so clicks inside either never reach this window listener. Also
  // closes on resize: the portaled menu is fixed at coords measured on open,
  // which a resize would leave stale.
  useEffect(() => {
    if (!editorMenuOpen) return
    const close = () => setEditorMenuOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
    }
  }, [editorMenuOpen])

  // Open the folder in an editor. `editor` undefined → the server uses the
  // saved default, else CLI auto-detection. Unlike reveal this CAN meaningfully
  // fail (no editor → 503), so failures surface via alert.
  const openInEditorWith = useCallback(
    async (editor?: OpenApp) => {
      if (!project || project.missing) return
      setEditorMenuOpen(false)
      try {
        const res = await fetch('/api/project/open-editor', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(editor ? { path: project.path, editor } : { path: project.path }),
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
    },
    [project, t],
  )

  // Can we offer the chooser at all? Yes if editors were detected, or if the
  // native Finder picker is available (macOS). Otherwise — e.g. Windows/Linux
  // with nothing detected — there's nothing to choose, so the single button
  // launches directly via the server's CLI auto-detection instead.
  const canChooseEditor = installedEditors.length > 0 || canPickEditor
  // The single "Open in editor" button. Clicking it opens the chooser menu when
  // there's anything to choose (detected editors and/or the native picker) — the
  // user picks an editor there and the saved default stays starred. With nothing
  // to choose there's no menu to show, so it launches in one click via the
  // server's CLI auto-detection, preserving open-in-editor on Windows/Linux.
  const handleEditorButton = useCallback(() => {
    if (!project || project.missing) return
    if (canChooseEditor) setEditorMenuOpen((v) => !v)
    else void openInEditorWith()
  }, [project, canChooseEditor, openInEditorWith])

  // Remember / clear the one-click default (persisted server-side).
  const saveDefaultEditor = useCallback(async (editor: OpenApp | null) => {
    setDefaultEditor(editor)
    try {
      await fetch('/api/project/default-editor', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ editor }),
      })
    } catch {
      /* best-effort; the in-memory default still updates */
    }
  }, [])

  // "Choose another app…" — the native Finder .app picker (shared with the
  // generic Open-in flow). A pick becomes the new default and opens at once.
  const pickEditor = useCallback(async () => {
    setEditorMenuOpen(false)
    try {
      const res = await fetch('/api/project/open/pick', { method: 'POST' })
      const d = (await res.json()) as {
        name?: string
        path?: string
        cancelled?: boolean
        error?: string
      }
      if (d.cancelled || !d.name) return
      if (d.error) {
        alert(t('projectPanel.pickFailed', { error: d.error }))
        return
      }
      const picked: OpenApp = { name: d.name, path: d.path, mode: 'open' }
      setInstalledEditors((prev) =>
        prev.some((e) => e.name === picked.name) ? prev : [...prev, picked],
      )
      await saveDefaultEditor(picked)
      void openInEditorWith(picked)
    } catch (e: any) {
      alert(t('projectPanel.pickFailed', { error: e?.message ?? t('projectPanel.networkError') }))
    }
  }, [t, saveDefaultEditor, openInEditorWith])

  // Header branch chip: branch name + a dot when the working tree is dirty.
  // Fetched once per project open (good enough — the modal re-fetches fresh
  // data on open and pushes it back here, so the chip never drifts far).
  const [branchInfo, setBranchInfo] = useState<BranchChangesResponse | null>(null)
  const [branchModalOpen, setBranchModalOpen] = useState(false)
  const [branchMenuOpen, setBranchMenuOpen] = useState(false)
  const [activeBranches, setActiveBranches] =
    useState<ActiveBranchesResponse | null>(null)
  const [skillsOpen, setSkillsOpen] = useState(false)
  // Body-portaled like the editor menu (see editorMenuPos) — same hosted-frame
  // stacking reason, same measured-on-open fixed positioning.
  const branchBtnRef = useRef<HTMLButtonElement | null>(null)
  const [branchMenuPos, setBranchMenuPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!branchMenuOpen) {
      setBranchMenuPos(null)
      return
    }
    const r = branchBtnRef.current?.getBoundingClientRect()
    if (r) setBranchMenuPos({ left: r.left, top: r.bottom + 4 })
  }, [branchMenuOpen])
  useEffect(() => {
    setBranchInfo(null)
    setBranchModalOpen(false)
    setBranchMenuOpen(false)
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

  // The branch dropdown lists every active branch + its worktree. Fetch lazily
  // when the menu opens (the chip name itself comes from branch-changes above).
  useEffect(() => {
    if (!branchMenuOpen) return
    if (!project || project.missing) return
    let cancelled = false
    setActiveBranches(null)
    fetch(`/api/project/active-branches?path=${encodeURIComponent(project.path)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (
          !cancelled &&
          body &&
          Array.isArray((body as ActiveBranchesResponse).branches)
        ) {
          setActiveBranches(body as ActiveBranchesResponse)
        } else if (!cancelled) {
          setActiveBranches({ isGit: false, branches: [] })
        }
      })
      .catch(() => {
        if (!cancelled) setActiveBranches({ isGit: false, branches: [] })
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchMenuOpen, project?.path, project?.missing])

  // Outside-click closes the branch dropdown. The trigger container and the
  // portaled dropdown both stop mousedown propagation (see JSX), so clicks
  // inside never reach this listener. Resize closes too (fixed coords are
  // measured on open — see the editor menu's note).
  useEffect(() => {
    if (!branchMenuOpen) return
    const close = () => setBranchMenuOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', close)
    }
  }, [branchMenuOpen])

  const regenerateDescription = useCallback(async () => {
    if (!project || project.missing) return
    const path = project.path
    // The run survives navigation now, so the spinner doubles as a STOP button:
    // clicking while it's running explicitly cancels (the only thing that kills
    // the server-side session). Single-flight on the server means a stray
    // double-start can't fork the work, but cancelling needs the live job id.
    if (describing) {
      const id = describeJob?.id
      setDescribeJob((prev) => (prev?.path === path ? null : prev))
      if (id) {
        fetch(`/api/project/describe/job/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
        }).catch(() => {})
      } else {
        // Optimistic "starting" window: the start POST hasn't returned a jobId
        // yet, so there's nothing to cancel *right now*. Flag this path — the
        // POST cancels the job the server already created the instant it learns
        // the id. Without this, a Stop here is silently ignored: claude keeps
        // running, persists the description, and the 5s board poll surfaces it
        // as if the cancel never happened (plus a wasted subscription session).
        describeCancelStartRef.current.add(path)
      }
      return
    }
    // Optimistic spinner for THIS path (id:null = "starting") while the start
    // POST is in flight, then adopt the real job id. Clear any stale stop-flag.
    describeCancelStartRef.current.delete(path)
    setDescribeJob({ id: null, path })
    try {
      const res = await api.api.project.describe.$post({ query: { path } })
      if (!res.ok) {
        describeCancelStartRef.current.delete(path)
        setDescribeJob((prev) => (prev?.path === path ? null : prev))
        return
      }
      const body = (await res.json()) as { jobId?: string }
      if (!body.jobId) {
        describeCancelStartRef.current.delete(path)
        setDescribeJob((prev) => (prev?.path === path ? null : prev))
        return
      }
      const jobId = body.jobId
      // A Stop pressed during the starting window flagged this path — cancel the
      // job the server just created instead of adopting it (the Stop already
      // cleared the spinner state). This closes the "cancelled but the
      // description silently appears" gap.
      if (describeCancelStartRef.current.has(path)) {
        describeCancelStartRef.current.delete(path)
        fetch(`/api/project/describe/job/${encodeURIComponent(jobId)}/cancel`, {
          method: 'POST',
        }).catch(() => {})
        setDescribeJob((prev) => (prev?.path === path && prev.id === null ? null : prev))
        return
      }
      // Only adopt if we're still optimistically describing THIS path (a fast
      // project switch + back could have moved us; the re-attach effect covers
      // that case from the server instead).
      setDescribeJob((prev) => (prev?.path === path && prev.id === null ? { id: jobId, path } : prev))
    } catch {
      describeCancelStartRef.current.delete(path)
      setDescribeJob((prev) => (prev?.path === path ? null : prev))
    }
  }, [project, describing, describeJob])

  // Re-attach to a describe job ALREADY running for the open project — e.g. the
  // user started one, switched tab / project / went to Ground (this panel is
  // reused across switches), and came back. The run kept going server-side;
  // restore the spinner so it isn't a mystery and let the poll effect pick up
  // the result. Runs on every project switch.
  useEffect(() => {
    const path = project?.path
    // Stop tracking the previous project's job synchronously (it keeps running
    // server-side; we re-attach below if THIS project has one). Keep an
    // optimistic start we just kicked off for the same path.
    setDescribeJob((prev) => (prev && prev.path === path ? prev : null))
    if (!path || project?.missing) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch('/api/project/describe/active')
        if (!res.ok) return
        const data = (await res.json()) as DescribeActiveResponse
        if (cancelled || project?.path !== path) return
        const mine = data.jobs.find((j) => j.projectPath === path)
        if (mine) setDescribeJob({ id: mine.id, path })
      } catch {
        // offline / server restarting — nothing to re-attach to
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path, project?.missing])

  // Poll the running describe job for completion. The job persisted the
  // description into projectData server-side, so on 'done' we adopt the FRESH
  // projectData — but only while this project is still the loaded one, so a
  // stale return never writes project A's text into project B (the original
  // bug). Stops watching on unmount WITHOUT cancelling the job (the run must
  // survive navigation) — only an explicit Cancel kills it.
  useEffect(() => {
    const job = describeJob
    if (!job || !job.id) return // idle, or optimistically "starting"
    const jobId = job.id
    const path = job.path
    let cancelled = false
    // Guard against overlapping polls running past the 1.5s interval.
    let inFlight = false
    const stop = () => setDescribeJob((prev) => (prev?.id === jobId ? null : prev))
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const res = await fetch(`/api/project/describe/job/${encodeURIComponent(jobId)}`)
        if (cancelled) return
        if (res.status === 404) {
          // Swept / unknown — stop watching (any result is already persisted).
          stop()
          return
        }
        if (!res.ok) return
        const state = (await res.json()) as DescribeJobState
        if (cancelled || state.status === 'running') return
        if (state.status === 'done' && loadedDataPathRef.current === path) {
          // The job persisted the description into projectData server-side. Adopt
          // it through the SAME dual-writer policy as the live-board poll
          // (reconcileExternalData — what reloadProjectData uses): a pending local
          // edit (config/launch, a task delete, a module toggle not yet flushed)
          // must NOT be clobbered — it wins this round and the debounced persist's
          // CAS reconciles it; our own echo is dropped; only a genuine external
          // change is adopted. (A bespoke setData here silently ate unsaved edits.)
          // onSavedRef (not onSaved) keeps this consistent with the stable-identity
          // refresh pattern reloadProjectData established.
          const fresh = await api.api.project
            .$get({ query: { path } }, { init: { cache: 'no-store' } })
            .catch(() => null)
          if (!cancelled && fresh?.ok && loadedDataPathRef.current === path) {
            const d = (await fresh.json()) as ProjectData
            const decision = reconcileExternalData({
              current: dataRef.current,
              lastSavedJson: lastSavedJson.current,
              fetched: d,
            })
            if (decision.kind === 'adopt') {
              setData(decision.data)
              lastSavedJson.current = decision.json
              onSavedRef.current?.(path, decision.data)
            }
          }
        }
        // 'error' (incl. 'cancelled') → just stop; leave the description as-is.
        stop()
      } catch {
        // transient (server reloading) — keep polling
      } finally {
        inFlight = false
      }
    }
    void poll()
    const intervalId = window.setInterval(() => void poll(), 1500)
    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
    // Keyed on the job id only: (id, path) are set together and immutable, so a
    // re-subscribe is needed only when the id changes — not on every describeJob
    // object identity churn. onSaved is read via onSavedRef (stable identity), so
    // it's intentionally not a dep (App re-renders would otherwise tear the
    // 1.5s interval down before it ticks — the same trap reloadProjectData hit).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [describeJob?.id])

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
      .then(r => {
        // res.ok guard — the SAME contract as reloadProjectData / persist / the
        // describe poll. A non-2xx body is an `{ error }` envelope, NOT
        // ProjectData: if this project was unregistered in another window the
        // GET returns 403 { error }. Parsing+adopting that as `data` left
        // loadError null (no Retry) AND fed BoardModule a tasks-less object →
        // data.tasks.find TypeError → white screen. Throwing routes it through
        // the catch below to setLoadError, surfacing the designed Retry UI.
        if (!r.ok) throw new Error(`Failed to load project (${r.status})`)
        return r.json() as Promise<ProjectData>
      })
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
    marketAvailable,
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
  // Owner-only experiment gate (App resolves it server-side; all-false for
  // non-owners and the shipped build). An experiment-gated module is invisible
  // until its gate is open, so this Set is empty for everyone but the owner with
  // the toggle on — keeping the registry filter below a no-op in the common case.
  const moduleGate = useMemo<ModuleGate>(
    () => gateFromFlags(experiments ?? NO_EXPERIMENT_FLAGS),
    // Depend on the `experiments` object itself, not individual flag keys — so
    // a future ExperimentId needs no matching edit here to be tracked.
    // useExperiments() hands out a referentially-stable `flags` object that
    // only changes identity when a value actually flips (see
    // src/lib/modules/useExperiments.ts), so this doesn't recompute on every
    // no-op focus re-check the way depending on the raw object always would.
    [experiments],
  )
  // The enabled built-in module ids in registry (default) order — gated
  // experiments included only when `moduleGate` opens them — then with this
  // project's HIDDEN natives (ProjectData.disabledModules) dropped. disabledModules
  // is personal per-project state like tabOrder; a native ships pre-installed and
  // can't be uninstalled, but a project may drop it from its row. The resulting
  // order drives the tab row's left-to-right order AND the Ctrl+Tab cycle.
  const enabledNativeIds = useMemo<PanelView[]>(() => {
    const hidden = new Set(data?.disabledModules ?? [])
    return enabledModules(moduleGate).map(m => m.id).filter(id => !hidden.has(id))
  }, [data?.disabledModules, moduleGate])
  // Every id that can appear in the tab row: enabled built-ins in registry
  // order, then the ATTACHED custom tabs in attachment order. effectiveTabOrder
  // reconciles a saved per-project order against this set.
  const allTabIds = useMemo<PanelView[]>(
    () => [...enabledNativeIds, ...attachedModuleIds.map(customTabId)],
    [enabledNativeIds, attachedModuleIds],
  )
  // The per-project, normalised tab order: the user's saved drag order
  // (ProjectData.tabOrder) reconciled against the live registry + custom set,
  // falling back to the default order when a project has none. Drives the tab
  // row, the Ctrl+Tab cycle, and the first-tab default below.
  const tabOrder = useMemo(
    () => effectiveTabOrder<PanelView>(data?.tabOrder, allTabIds),
    [data?.tabOrder, allTabIds],
  )
  // The active tab is no longer in this project's row — a custom tab detached
  // here / deleted from the library (a stale localStorage value), OR a built-in
  // now hidden via disabledModules. Land on the first remaining tab. Only judged
  // once BOTH sources are in (the library list AND this project's data) — before
  // that, "not in the row" just means "haven't heard from the server yet".
  useEffect(() => {
    if (!customModulesLoaded || !data) return
    if (allTabIds.includes(view)) return
    setView(tabOrder[0] ?? 'board')
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
  // Tab-row right-click offers ONE action per tab (no confirm — both are
  // reversible from the "+" picker): DETACH a custom tab (drop it from this
  // project's customTabs + scrub its custom:<id> from tabOrder; the module stays
  // in the library) or DISABLE a built-in (hide it via disabledModules). Both
  // are personal per-project state, so no server role gate applies — detach is
  // offered to anyone who manages custom tabs (customRole !== 'none'); hiding a
  // native is everyone's right (it's just their own layout).
  const detachTabFromProject = useCallback(
    (tabId: string) => {
      if (!isCustomTabId(tabId)) return
      const base = dataRef.current
      if (!base) return
      const moduleId = customModuleIdFromTab(tabId as `custom:${string}`)
      persist({ ...base, ...detachCustomTab(base, moduleId) })
      // Detaching says "I'm done with this tab HERE" — tear down its hosted
      // frame too, so audio it was playing stops instead of living on as a
      // hidden keep-alive nobody meant to keep. Project-guarded: the same
      // module playing from ANOTHER project's tab isn't ours to kill.
      if (project?.path) destroyFrameIfProject(moduleId, project.path)
      // The dangling-view fallback effect moves the view off the detached id.
    },
    [persist, project?.path],
  )
  // Show/hide a built-in module in THIS project's row (disabledModules). Hiding
  // the LAST remaining tab is blocked by the callers (picker + tab menu); the
  // dangling-view fallback effect moves the view off a now-hidden native.
  const toggleNativeTab = useCallback(
    (moduleId: string, enabled: boolean) => {
      const base = dataRef.current
      if (!base) return
      const disabledModules = enabled
        ? enableNativeModule(base.disabledModules, moduleId as ModuleId)
        : disableNativeModule(base.disabledModules, moduleId as ModuleId)
      persist({ ...base, disabledModules })
    },
    [persist],
  )
  // The built-in modules + their per-project enabled state, for the picker's
  // "Built-in" section (enabled = not hidden via disabledModules). Gated through
  // the same `moduleGate`, so a hidden experiment never leaks into the picker
  // either.
  const nativePickerItems = useMemo(() => {
    const hidden = new Set(data?.disabledModules ?? [])
    return nativeDescriptors(moduleGate).map(d => ({
      id: d.id,
      // Same resolution as the tab row, so a localised tab reads identically in
      // both places (see tabLabel / TabDef.labelKey).
      label: tabLabel(d, t),
      enabled: !hidden.has(d.id),
    }))
  }, [data?.disabledModules, moduleGate, t])
  // The single right-click action for a tab in the row (see TabRowAction).
  // null = no menu: the role can't manage it, or it's the last remaining tab
  // (the floor invariant — never strand a project with zero visible tabs).
  const tabRowAction = useCallback(
    (tabId: string): TabRowAction | null => {
      if (tabOrder.length <= 1) return null
      if (isCustomTabId(tabId)) {
        if (customRole === 'none') return null
        return { kind: 'detach', run: () => detachTabFromProject(tabId) }
      }
      if (!isModuleIdEnabled(tabId)) return null
      return { kind: 'disable', run: () => toggleNativeTab(tabId, false) }
    },
    [tabOrder.length, customRole, detachTabFromProject, toggleNativeTab],
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
        // And the hosted iframe (kills any audio it was playing) — a deleted
        // module must not keep running as a hidden keep-alive frame.
        destroyFrame(moduleId)
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

  // ── Claude CLI sign-in (the run gate) ──────────────────────────────────────
  // useClaudeConnection REFLECTS `claude auth status`; claudeNonce re-checks it
  // (bumped when the sign-in terminal closes, so a fresh sign-in clears the gate
  // with no app restart). Enabled only while a real (non-missing) project is
  // open. claudeConn drives BoardModule's claudeLoggedIn prop (skip the
  // fire-and-forget auto-title spawn while signed out).
  const [claudeNonce, setClaudeNonce] = useState(0)
  const claudeConn = useClaudeConnection(!!project && !project.missing, claudeNonce)
  // The ONE sign-in terminal: POST /api/terminal/claude-login spawns a plain
  // claude PTY the user authenticates in (claude opens its OAuth once). The run
  // routes refuse to spawn while signed out (503 claudeLoggedOut), so this is
  // the single deliberate place a signed-out claude starts — never N OAuth tabs.
  const [claudeLoginOpen, setClaudeLoginOpen] = useState(false)
  const [claudeLoginPty, setClaudeLoginPty] = useState<string | null>(null)
  const [claudeLoginBusy, setClaudeLoginBusy] = useState(false)
  const [claudeLoginError, setClaudeLoginError] = useState<string | null>(null)
  const claudeLoginInFlight = useRef(false)
  // Open (or re-focus) the single sign-in terminal. Single-flight + single
  // instance: a second card's sign-in CTA re-focuses the open terminal instead
  // of spawning a twin, so "at most one sign-in flow" holds across cards.
  const openClaudeLogin = useCallback(async () => {
    if (!project || project.missing) return
    setClaudeLoginOpen(true)
    if (claudeLoginPty || claudeLoginInFlight.current) return
    claudeLoginInFlight.current = true
    setClaudeLoginBusy(true)
    setClaudeLoginError(null)
    try {
      const r = await fetch('/api/terminal/claude-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: project.path }),
      })
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string }
        setClaudeLoginError(b.error || `HTTP ${r.status}`)
        return
      }
      const info = (await r.json()) as TerminalInfo
      setClaudeLoginPty(info.id)
    } catch (e) {
      setClaudeLoginError(e instanceof Error ? e.message : String(e))
    } finally {
      setClaudeLoginBusy(false)
      claudeLoginInFlight.current = false
    }
  }, [project, claudeLoginPty])
  // Close the sign-in terminal: kill its PTY (sign-in persists to claude's own
  // credential store, so tearing the terminal down afterwards is safe) and
  // re-check the connection so a completed sign-in clears the run gate at once.
  const closeClaudeLogin = useCallback(() => {
    setClaudeLoginOpen(false)
    setClaudeLoginPty(prev => {
      if (prev) api.api.terminal[':id'].$delete({ param: { id: prev } }).catch(() => {})
      return null
    })
    setClaudeLoginError(null)
    setClaudeNonce(n => n + 1)
  }, [])

  // Last-known shell info per pane, so switching focus immediately repaints the
  // tab header with that pane's `zsh · cols×rows` instead of waiting for its
  // next info event.
  const terminalInfoMapRef = useRef<Record<string, TerminalInfo | null>>({})
  // Slot → its live PTY id, mirrored into STATE (the map above is a ref, which
  // can't repaint the context gauge). null once that pane's session has exited.
  const [terminalPtyIds, setTerminalPtyIds] = useState<Record<string, string | null>>({})
  // Slot → its pane's imperative handle, so the gauge's "new session" can swap
  // the pane onto a fresh claude without ProjectPanel learning the slot's
  // session-key bookkeeping (that stays inside TerminalPane).
  const termPaneRefs = useRef<Record<string, TerminalPaneHandle | null>>({})
  // PTY id → context reading, from the same beacon the Ground card polls
  // (GET /api/terminal/active). Polled ONLY while the Terminal tab is the open
  // view and the window is visible: the server resolves each pane's reading by
  // reading claude transcripts, so a tab nobody is looking at must not keep
  // paying for it. Panes absent from the map have no claude session.
  const [contextByPty, setContextByPty] = useState<
    Record<string, { pct: number | null; source: ContextLeftSource | null }>
  >({})
  useEffect(() => {
    if (view !== 'terminal' || !project?.path) return
    let cancelled = false
    const load = async () => {
      if (typeof document !== 'undefined' && document.hidden) return
      try {
        const r = await fetch('/api/terminal/active')
        if (!r.ok) return
        const body = (await r.json()) as ActiveTerminalsResponse
        if (cancelled) return
        const next: Record<string, { pct: number | null; source: ContextLeftSource | null }> = {}
        for (const c of body.claude ?? []) {
          next[c.id] = { pct: c.contextLeftPct ?? null, source: c.contextLeftSource ?? null }
        }
        setContextByPty(next)
      } catch {
        // Transient beacon failure: keep the last reading rather than blanking
        // the gauge — a dropped poll is not evidence the session ended.
      }
    }
    void load()
    const timer = setInterval(() => void load(), CONTEXT_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [view, project?.path])

  // One press of the gauge's escape hatch. `compact` / `clear` type a slash
  // command into the pane's LIVE session (the server owns the allowlist and the
  // mid-turn refusal); `fresh` replaces the session outright.
  const runContextAction = async (
    slotId: string,
    action: ContextAction,
    focus?: string,
  ): Promise<ContextActionOutcome> => {
    if (action === 'fresh') {
      const handle = termPaneRefs.current[slotId]
      if (!handle) return 'error'
      try {
        await handle.restartClaude()
        return 'ok'
      } catch {
        return 'error'
      }
    }
    const ptyId = terminalPtyIds[slotId]
    if (!ptyId) return 'gone'
    try {
      const r = await fetch(`/api/terminal/${encodeURIComponent(ptyId)}/slash`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `focus` rides along only when the user typed one; the server
        // sanitises it to a single typed line and ignores it for /clear.
        body: JSON.stringify(focus ? { command: action, focus } : { command: action }),
      })
      return slashOutcome(r.status)
    } catch {
      return 'error'
    }
  }
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
        const body = (await r.json().catch(() => ({}))) as {
          claudeMissing?: boolean
          claudeLoggedOut?: boolean
        }
        return {
          ok: false,
          reason: body.claudeMissing
            ? 'claudeMissing'
            : body.claudeLoggedOut
              ? 'claudeLoggedOut'
              : 'other',
        }
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

  // `onSaved` is an INLINE arrow from App.tsx — a fresh identity on every App
  // render (App re-renders whenever a claude beacon flips, i.e. constantly while
  // a session works). Reading it through a ref keeps reloadProjectData's identity
  // STABLE so the 5s poll's setInterval is created once per project and actually
  // reaches its 5s tick — depending on `onSaved` directly tore the interval down
  // and recreated it before it could fire, so the live board refresh never ran
  // (the dual-writer "external move silently reverts" bug, 2026-06-24).
  const onSavedRef = useRef(onSaved)
  onSavedRef.current = onSaved

  const projectPathRef = useRef<string | null>(null)
  projectPathRef.current = project?.path ?? null
  // Realtime-collab invite dialog (owner side). Gated on collab being enabled —
  // the default (no collab env) build never shows the entry or this dialog.
  const { enabled: collabEnabled } = useCollab()
  const [collabInviteOpen, setCollabInviteOpen] = useState(false)

  // Re-read ProjectData from disk after an external change — chiefly a terminal
  // claude calling POST /api/project/tasks adds board cards out-of-band; the
  // focus refetch and the 5s poll below adopt them. Skipped when a local edit
  // hasn't flushed through the debounced persist yet — the local save wins and
  // the next refetch picks the merge up.
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
      // Decide adopt / echo / skip-local-edit with the documented dual-writer
      // policy (src/lib/projectDataReconcile.ts): a pending local edit wins this
      // round (CAS reconciles it), our own echo is dropped so the poll can't
      // churn the tasks array identity (which BoardModule reads as a remote
      // replacement → wiped undo), and a genuine external change is adopted.
      const decision = reconcileExternalData({
        current: dataRef.current,
        lastSavedJson: lastSavedJson.current,
        fetched: d,
      })
      if (decision.kind === 'skip-local-edit') return null
      if (decision.kind === 'echo') return d
      setData(decision.data)
      lastSavedJson.current = decision.json
      // Keep the Ground card's mirror (description / task counts) fresh too.
      // Read through the ref so this callback's identity stays stable (see
      // onSavedRef) — otherwise the poll interval below never fires.
      onSavedRef.current?.(path, decision.data)
      return decision.data
    } catch {
      /* keep showing the data we have */
      return null
    }
    // onSaved is intentionally read via onSavedRef (stable identity) so the 5s
    // poll's interval survives App re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.path])

  // Reset collab-invite state on project switch so it never leaks across cards.
  useEffect(() => {
    setCollabInviteOpen(false)
  }, [project?.path])

  // Window focus while the panel is open: refetch the project data (a terminal
  // claude may have added board cards via the API — see the launch-time app
  // context in claudeTerminal). Debounced so a tab-switch flurry doesn't hammer
  // the server.
  const lastFocusRefetchRef = useRef(0)
  useEffect(() => {
    if (!project?.path) return
    const onFocus = () => {
      const now = Date.now()
      if (now - lastFocusRefetchRef.current < 3000) return
      lastFocusRefetchRef.current = now
      void reloadProjectData()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [project?.path, reloadProjectData])

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
      // Tear down every hosted frame this project owns — audio started from a
      // now-deleted project must not keep playing hidden. Keyed by the frame's
      // own projectPath (not the attach list), so a module that's ALSO live
      // from another project keeps that other session untouched. (Modules stay
      // in the library; a frame respawns fresh when opened elsewhere.)
      destroyFramesForProject(project.path)
      onDeleted?.(project.path)
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : 'Delete failed.')
      setDeleting(false)
    }
  }

  return (
    <Overlay position="fixed" layer="panel" backdrop="surface" placement="fill" escOverlay={false}>
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
          <BackLink label={t('projectPanel.backToGround')} onClick={onClose} />
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
            {/* Open the folder in an editor — a single button. Clicking it opens
                the chooser menu (editors installed on this machine — open any, or
                star one as the new default); with nothing to choose it launches
                directly via CLI auto-detection. mousedown stops at the container
                so the outside-click closer only fires for clicks truly outside. */}
            <div
              className="relative flex shrink-0 items-center"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <button
                ref={editorBtnRef}
                onClick={handleEditorButton}
                disabled={project.missing}
                title={t('projectPanel.openInEditor')}
                aria-label={t('projectPanel.openInEditor')}
                aria-haspopup={canChooseEditor ? 'menu' : undefined}
                aria-expanded={canChooseEditor ? editorMenuOpen : undefined}
                className={`flex shrink-0 items-center gap-0.5 rounded-sm p-1 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-faint ${
                  editorMenuOpen
                    ? 'bg-bg-inset text-ink-muted'
                    : 'text-ink-faint hover:bg-bg-inset hover:text-ink-muted active:bg-bg-inset active:text-ink-muted'
                }`}
              >
                <SquareCode size={16} strokeWidth={1.75} />
                {canChooseEditor && (
                  <ChevronDown
                    size={12}
                    strokeWidth={2}
                    className={`shrink-0 transition-transform ${editorMenuOpen ? 'rotate-180' : ''}`}
                  />
                )}
              </button>
              {editorMenuOpen && editorMenuPos && createPortal(
                // Body portal at overlay-modal z — must beat a hosted custom-
                // tab iframe (z 45), which any in-panel z cannot (the panel is
                // one z-40 stacking context). stopPropagation keeps inside
                // clicks from reaching the window outside-click closer.
                <div
                  role="menu"
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{ left: editorMenuPos.left, top: editorMenuPos.top }}
                  className="fixed z-overlay-modal w-60 overflow-hidden rounded-md border border-line bg-bg-card py-1 shadow-lg"
                >
                  <div className="label-cap px-3 pb-1 pt-1.5 text-ink-faint">
                    {t('projectPanel.openInEditor')}
                  </div>
                  {installedEditors.length === 0 && (
                    <div className="px-3 py-1.5 text-[12px] text-ink-faint">
                      {t('projectPanel.editorNoneFound')}
                    </div>
                  )}
                  {installedEditors.map((ed) => {
                    const isDefault = defaultEditor?.name === ed.name
                    return (
                      <div key={ed.name} className="group flex items-center gap-1 px-1">
                        <button
                          role="menuitem"
                          onClick={() => void openInEditorWith(ed)}
                          className="min-w-0 flex-1 truncate rounded-sm px-2 py-1.5 text-left text-[13px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:bg-bg-inset focus-visible:text-ink focus-visible:outline-none"
                        >
                          {ed.name}
                        </button>
                        <button
                          onClick={() => void saveDefaultEditor(isDefault ? null : ed)}
                          title={
                            isDefault
                              ? t('projectPanel.editorClearDefault')
                              : t('projectPanel.editorSetDefault')
                          }
                          aria-label={
                            isDefault
                              ? t('projectPanel.editorClearDefault')
                              : t('projectPanel.editorSetDefault')
                          }
                          aria-pressed={isDefault}
                          className={`shrink-0 rounded-sm p-1.5 transition-all focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent ${
                            isDefault
                              ? 'text-accent'
                              : 'text-ink-faint opacity-0 hover:text-ink-muted focus-visible:opacity-100 group-hover:opacity-100'
                          }`}
                        >
                          <Star size={14} strokeWidth={2} className={isDefault ? 'fill-current' : ''} />
                        </button>
                      </div>
                    )
                  })}
                  {(canPickEditor || defaultEditor) && (
                    <div className="my-1 border-t border-line" />
                  )}
                  {canPickEditor && (
                    <button
                      role="menuitem"
                      onClick={() => void pickEditor()}
                      className="block w-full px-3 py-1.5 text-left text-[13px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:bg-bg-inset focus-visible:text-ink focus-visible:outline-none"
                    >
                      {t('projectPanel.editorPickOther')}
                    </button>
                  )}
                  {defaultEditor && (
                    <button
                      role="menuitem"
                      onClick={() => void saveDefaultEditor(null)}
                      className="block w-full px-3 py-1.5 text-left text-[13px] text-ink-faint transition-colors hover:bg-bg-inset hover:text-ink-muted focus-visible:bg-bg-inset focus-visible:text-ink-muted focus-visible:outline-none"
                    >
                      {t('projectPanel.editorClearDefault')}
                    </button>
                  )}
                </div>,
                document.body,
              )}
            </div>
            {/* Branch chip — only for git projects: current branch, a dot when
                the working tree is dirty; opens the Branch changes modal. */}
            {branchInfo?.isGit && (
              <div
                className="relative flex shrink-0 items-center"
                onMouseDown={(e) => e.stopPropagation()}
              >
                <button
                  ref={branchBtnRef}
                  onClick={() => setBranchMenuOpen((v) => !v)}
                  disabled={project.missing}
                  title={t('projectPanel.branchMenuTitle')}
                  aria-label={t('projectPanel.branchMenuTitle')}
                  aria-haspopup="menu"
                  aria-expanded={branchMenuOpen}
                  className={`flex min-w-0 shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted ${
                    branchMenuOpen
                      ? 'border-line bg-bg-inset text-ink'
                      : 'border-line text-ink-muted hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink'
                  }`}
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
                  <ChevronDown
                    size={11}
                    strokeWidth={2}
                    className={`shrink-0 transition-transform ${
                      branchMenuOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>
                {branchMenuOpen && branchMenuPos && createPortal(
                  // Body portal at overlay-modal z — same hosted custom-tab
                  // iframe stacking reason as the editor menu above.
                  <div
                    role="menu"
                    onMouseDown={(e) => e.stopPropagation()}
                    style={{ left: branchMenuPos.left, top: branchMenuPos.top }}
                    className="fixed z-overlay-modal max-h-[60vh] w-72 overflow-y-auto rounded-md border border-line bg-bg-card py-1 shadow-lg"
                  >
                    <div className="label-cap px-3 pb-1 pt-1.5 text-ink-faint">
                      {t('projectPanel.branchMenuTitle')}
                    </div>
                    {activeBranches === null ? (
                      <div className="flex items-center gap-2 px-3 py-2 text-[12px] text-ink-faint">
                        <Loader2 size={12} className="animate-spin" />
                      </div>
                    ) : activeBranches.branches.length === 0 ? (
                      <div className="px-3 py-1.5 text-[12px] text-ink-faint">
                        {t('projectPanel.branchMenuEmpty')}
                      </div>
                    ) : (
                      activeBranches.branches.map((b) => (
                        <div
                          key={b.name}
                          role="menuitem"
                          className="flex items-start gap-2 px-3 py-1.5"
                        >
                          <GitBranch
                            size={12}
                            strokeWidth={2}
                            className={`mt-0.5 shrink-0 ${
                              b.current ? 'text-accent' : 'text-ink-faint'
                            }`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`truncate font-mono text-[12px] ${
                                  b.current ? 'text-ink' : 'text-ink-muted'
                                }`}
                                title={b.name}
                              >
                                {b.name}
                              </span>
                              {b.current && (
                                <span className="shrink-0 rounded-sm bg-bg-inset px-1 py-px text-[9px] uppercase tracking-wide text-ink-faint">
                                  {t('projectPanel.branchMenuCurrent')}
                                </span>
                              )}
                            </div>
                            {b.worktreePath && (
                              <div
                                className="truncate text-[11px] text-ink-faint"
                                title={b.worktreePath}
                              >
                                {b.worktreePath}
                              </div>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                    <div className="my-1 border-t border-line" />
                    <button
                      role="menuitem"
                      onClick={() => {
                        setBranchMenuOpen(false)
                        setBranchModalOpen(true)
                      }}
                      className="block w-full px-3 py-1.5 text-left text-[13px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-ink focus-visible:bg-bg-inset focus-visible:text-ink focus-visible:outline-none"
                    >
                      {t('projectPanel.branchChangesTitle')}
                    </button>
                  </div>,
                  document.body,
                )}
              </div>
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
                  disabled={project.missing}
                  title={
                    describing
                      ? t('projectPanel.cancelDescription')
                      : t('projectPanel.regenerateDescription')
                  }
                  aria-label={
                    describing
                      ? t('projectPanel.cancelDescription')
                      : t('projectPanel.regenerateDescription')
                  }
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
                  disabled={project.missing}
                  title={
                    describing
                      ? t('projectPanel.cancelDescription')
                      : t('projectPanel.generateDescription')
                  }
                  aria-label={
                    describing
                      ? t('projectPanel.cancelDescription')
                      : t('projectPanel.generateDescription')
                  }
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
          {/* Skills: lists the Claude skills defined inside this project
              (.claude/skills/). A quiet text+icon button — always present,
              disabled only for a vanished folder. */}
          <button
            type="button"
            onClick={() => setSkillsOpen(true)}
            disabled={project.missing}
            title={t('projectPanel.skillsButtonHint')}
            aria-label={t('projectPanel.skillsButton')}
            className="flex shrink-0 items-center gap-1 rounded-sm px-1 py-1 text-[11px] text-ink-faint transition-colors hover:text-ink active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-faint"
          >
            <Sparkles size={12} strokeWidth={1.75} className="shrink-0" />
            {t('projectPanel.skillsButton')}
          </button>
          {/* Realtime-collab invite — a quiet text button, only when collab is
              enabled (default build: hidden, no collab UI at all). */}
          {collabEnabled && !project.missing && (
            <button
              type="button"
              onClick={() => setCollabInviteOpen(true)}
              title={t('projectPanel.collabEntryTitle')}
              className="shrink-0 rounded-sm px-1 py-1 text-[11px] text-ink-faint transition-colors hover:text-ink active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('projectPanel.collabEntry')}
            </button>
          )}
          {/* Mirrors the Ground's top-right usage strip — model + token gauge,
              kept visible while working inside a project so the user always
              knows how close they are to the rate-limit cap. */}
          <UsageHud />
          {/* Text-diet 2026-08-03: feedback had THREE permanent entries (Ground
              toolbar pill, this header button, the Settings section). The
              toolbar + Settings pair covers reach; this duplicate is cut. */}
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
        // Same gate as `order` was built from, so the row can resolve a gated
        // module's icon/label; without it an open experiment's tab would have an
        // id in `order` but no metadata and silently fail to render.
        gate={moduleGate}
        // Custom tabs (label from the fetched def, fixed Puzzle icon) — the
        // row renders them wherever `order` puts them; `order` only ever
        // contains tabs ATTACHED to this project (allTabIds above).
        customTabs={customModules.map(customModuleTabDef)}
        // "+" opens the per-project picker — attach custom tabs AND show/hide
        // built-ins. Both are personal per-project layout (no server role gate),
        // so the picker is available to everyone, including role 'none'; the
        // owner-only create + owner|tester marketplace entries inside it stay
        // role-gated cosmetically (the server re-checks).
        onAddTab={() => setPickerOpen(true)}
        // Right-click menu on a tab: detach a custom (non-destructive — library
        // delete lives in the picker) or hide a built-in from this project.
        rowMenu={{ actionFor: tabRowAction }}
        // Cards waiting in Review — the reviewer's pull signal (F066).
        badges={{
          board:
            data?.tasks.filter(t => !t.done && t.boardColumn === 'review').length ?? 0,
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
            // Undefined = this pane has no claude session (a plain shell, or
            // one that has exited): the gauge shows its idle track and the two
            // "send into the session" buttons are disabled.
            const panePtyId = terminalPtyIds[slot.id]
            const contextReading = panePtyId ? contextByPty[panePtyId] : undefined
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
                  {/* Context fuel gauge — a thin bar in the tab, detail + the
                   *  manual escape hatch on press. Sits left of the close
                   *  button so the row still ends with the affordance users
                   *  reach for by muscle memory. */}
                  <ContextGauge
                    leftPct={contextReading?.pct}
                    source={contextReading?.source}
                    hasSession={!!contextReading}
                    onAction={(action, focus) => runContextAction(slot.id, action, focus)}
                  />
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
                    ref={el => {
                      termPaneRefs.current[slot.id] = el
                    }}
                    projectPath={project.path}
                    slotKey={slot.id}
                    onInfo={inf => {
                      terminalInfoMapRef.current[slot.id] = inf
                      if (activeTerminalSlotRef.current === slot.id)
                        setTerminalInfo(inf)
                      // Mirror the live PTY id into state for the gauge. A pane
                      // that has exited reports its info WITH finishedAt — that
                      // is "no session", not a session to measure.
                      setTerminalPtyIds(prev => {
                        const next = inf && !inf.finishedAt ? inf.id : null
                        return prev[slot.id] === next
                          ? prev
                          : { ...prev, [slot.id]: next }
                      })
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
      ) : view === 'swarm' && experiments?.swarm ? (
        // Owner-only experiment. Re-checking `experiments.swarm` HERE — not just
        // relying on the tab being hidden — means a forged `view: 'swarm'` (from
        // a stale/hostile localStorage value) never renders the surface for a
        // non-owner; the fallback effect then moves the view off it. Task C
        // builds the real orchestration UI; this mounted placeholder is what the
        // gate makes appear when the owner turns the experiment on.
        <SwarmModule project={project} />
      ) : view === 'persona' && experiments?.persona ? (
        // Owner-only experiment, gated exactly like Swarm above: re-checking the
        // flag HERE (not just relying on the hidden tab) means a forged
        // `view: 'persona'` from a stale/hostile localStorage value never mounts
        // the surface for a non-owner — and the fallback effect then moves the
        // view off it. Load-bearing here specifically: this tab reads the
        // owner's personal corpus.
        <PersonaModule />
      ) : isCustomTabId(view) ? (
        // Custom tab: the module's component in a sandboxed iframe, plus the
        // owner's claude sidebar. Keyed by module id so switching between two
        // custom tabs remounts cleanly (fresh poll, fresh sidebar state).
        activeCustomModule ? (
          <CustomModuleView
            key={activeCustomModule.id}
            module={activeCustomModule}
            projectPath={project.path}
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
          // Run gate: skip the fire-and-forget auto-title spawn while signed
          // out, and surface the single sign-in terminal when a run returns
          // claudeLoggedOut (instead of opening claude's OAuth browser N times).
          claudeLoggedIn={claudeConn ? claudeConn.loggedIn : undefined}
          onClaudeLogin={openClaudeLogin}
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
          onBrowseMarket={
            customRole !== 'none' && marketAvailable
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

      {collabInviteOpen && (
        <CollabInviteDialog
          projectName={project.name}
          projectPath={project.path}
          onClose={() => setCollabInviteOpen(false)}
        />
      )}

      {pickerOpen && (
        <CustomTabPickerDialog
          modules={customModules}
          role={customRole}
          attachedIds={new Set(attachedModuleIds)}
          // Built-in modules + show/hide controls (personal per-project layout,
          // available to every role). The last visible tab can't be hidden.
          natives={nativePickerItems}
          canDisableNative={tabOrder.length > 1}
          onToggleNative={toggleNativeTab}
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
            customRole !== 'none' && marketAvailable
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

      <BranchChangesModal
        open={branchModalOpen}
        path={project.path}
        onClose={() => setBranchModalOpen(false)}
        onData={setBranchInfo}
      />

      <SkillsModal
        open={skillsOpen}
        path={project.path}
        projectName={project.name}
        onClose={() => setSkillsOpen(false)}
      />

      {/* The single "sign in to Claude" terminal. A run while the CLI is signed
          out returns claudeLoggedOut (no spawn → no OAuth storm); its CTA opens
          THIS one terminal, where the user completes claude's OAuth once. After
          sign-in, closing it re-checks the connection and runs go through. */}
      {claudeLoginOpen && (
        <Overlay
          placement="center"
          backdrop="scrimStrong"
          layer="modal"
          escOverlay={false}
          role="dialog"
          aria-modal
          aria-label={t('projectPanel.claudeLogin.title')}
        >
          <div className="flex h-[70vh] max-h-[640px] w-full max-w-[780px] flex-col overflow-hidden rounded-lg border border-line bg-bg-card shadow-2xl">
            <DialogHeader
              separator="line"
              density="bar"
              align="center"
              leading={
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-medium text-ink">
                    {t('projectPanel.claudeLogin.title')}
                  </p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                    {t('projectPanel.claudeLogin.hint')}
                  </p>
                </div>
              }
              onClose={closeClaudeLogin}
              closeLabel={t('common.close')}
            />
            <div className="flex min-h-0 flex-1 flex-col bg-bg">
              {claudeLoginPty ? (
                <ClaudeTerminalPane
                  terminalId={claudeLoginPty}
                  chrome={false}
                  onExit={closeClaudeLogin}
                />
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                  {claudeLoginError ? (
                    <>
                      <p className="max-w-[90%] text-[12px] leading-relaxed text-accent">
                        {claudeLoginError}
                      </p>
                      <button
                        type="button"
                        onClick={() => void openClaudeLogin()}
                        className="rounded-sm border border-line px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-accent hover:text-ink active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      >
                        {t('projectPanel.claudeLogin.retry')}
                      </button>
                    </>
                  ) : (
                    <p className="text-[12px] text-ink-faint">
                      {t('projectPanel.claudeLogin.starting')}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        </Overlay>
      )}
    </Overlay>
  )
}

// ProjectPanel — the single project overlay App mounts. One capability flag
// (`shared`) decides owner vs member: a folder-less collab project shared WITH
// the user renders SharedProjectBody (Board + Canvas over the DO, reduced
// chrome); every other project renders OwnedProjectBody (the full owner surface,
// unchanged). There is no separate shared panel — this is the only one.
export const ProjectPanel = (props: Props) => {
  if (props.shared) {
    return (
      // key on the collab id forces a fresh member subtree per shared project —
      // an id swap can never inherit the prior project's doc/adopted/cache state.
      <SharedProjectBody
        key={props.shared.id}
        collabProjectId={props.shared.id}
        label={props.shared.label}
        onClose={props.onClose}
      />
    )
  }
  return <OwnedProjectBody {...props} />
}

// Project settings — タスクのワークフロー + Personal. (Git-share is gone; the
// team / share-CTA sections went with it.)
// AUTOSAVE dialog: every committed change persists the moment it's made (the
// parent debounces the PUT); a single Back button / ESC just dismisses.

const ProjectSettingsDialog = ({
  projectName,
  projectPath,
  data,
  onBrowseMarket,
  onClose,
  onChange,
}: {
  projectName: string
  projectPath: string
  data: ProjectData
  /** Owner|tester: open the marketplace dialog (the parent closes settings
   *  first). undefined hides the settings-side marketplace entry. */
  onBrowseMarket?: () => void
  onClose: () => void
  onChange: (config: ProjectConfig, launch: ProjectLaunchPrefs) => void
}) => {
  const { t } = useT()

  // Esc-to-dismiss (same as Back) is handled by the shared <Overlay> below via
  // closeOnEsc — IME-guarded + preventDefault so App's global Escape doesn't
  // also clear the selection / close the panel.

  // Workflow drafts. (completionFlow and the launch profile — permission
  // mode / model / effort — are edited on the Board's run-defaults strip
  // since 2026-06-12; this dialog no longer duplicates them.)
  const [targetBranch, setTargetBranch] = useState(data.config?.targetBranch ?? '')
  // Dedupe on init: legacy / shared boards can carry exact-duplicate names
  // (which would collide as React keys and make one ✕ remove all twins).
  const [members, setMembers] = useState<string[]>(() =>
    Array.from(new Set(data.config?.members ?? [])),
  )

  // The repo's branch list — a failed
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
  }) => {
    const d = dataRef.current
    // Spread first: every config key this dialog doesn't currently SHOW
    // (completionFlow, verifyCommands) is carried through untouched — saving
    // must never strip data the user couldn't see.
    const config: ProjectConfig = { ...d.config }
    config.targetBranch = (over.targetBranch ?? targetBranch).trim() || undefined
    // The assignee-name roster (solo users assign cards too).
    const nextMembers = over.members ?? members
    config.members = nextMembers.length > 0 ? nextMembers : undefined
    const launch: ProjectLaunchPrefs = { ...d.launch }
    onChange(config, launch)
  }

  return (
    // Scroll container OUTSIDE, centering INSIDE: `grid place-items-center`
    // on a min-h-full inner track centers short content but grows with tall
    // content, so the header can never be clipped above the scroll origin
    // (the old flex-center + my-auto pattern clipped the top edge).
    <Overlay position="absolute" layer="local" backdrop="surface" placement="scroll" onClose={onClose}>
      <div className="grid min-h-full place-items-center">
        <div className="mx-auto w-full max-w-[760px] px-8 py-10">
          <BackLink
            label={t('projectPanel.settingsBack')}
            onClick={onClose}
            className="mb-5"
          />
          <p className="label-cap text-accent mb-2">
            {t('projectPanel.settingsDialogLabel')}
          </p>
          <h3 className="font-display text-[20px] leading-snug text-ink tracking-tightest">
            {projectName}
          </h3>

          {/* Two columns on md+: タスクのワークフロー stack on the left,
              Personal on the right; stacks vertically on narrow widths. */}
          <div className="mt-5 grid grid-cols-1 gap-x-10 md:grid-cols-2">
            <div>
              {/* ── タスクのワークフロー ── */}
              <div className="border-t border-line pt-4">
                <p className="label-cap text-ink">{t('projectPanel.settingsWorkflowHeading')}</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                  {t('projectPanel.settingsWorkflowHint')}
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
                  {/* Assignee-name roster — solo users assign cards too. */}
                  <MembersField
                    members={members}
                    onChange={next => {
                      setMembers(next)
                      persistChange({ members: next })
                    }}
                    label={t('projectPanel.settingsAssigneeNames')}
                    hint={t('projectPanel.settingsAssigneeNamesHint')}
                  />
                </div>
              </div>
            </div>

            {/* ── Personal ── */}
            <div className="mt-5 border-t border-line pt-4 md:mt-0">
              <p className="label-cap text-ink">{t('projectPanel.settingsPersonalHeading')}</p>
              <p className="mt-0.5 text-[11px] leading-relaxed text-ink-faint">
                {t('projectPanel.settingsPersonalHint')}
              </p>

              <div className="mt-3 space-y-3.5">
                {/* Text-diet 2026-08-03: the 「起動設定は Board へ移った」
                    signage (2026-06-12 transition note) served its year. Cut. */}
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
                    ones are removed; dirty ones are reported, never touched. */}
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
              </div>
            </div>
          </div>
        </div>
      </div>
    </Overlay>
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
  <Overlay
    position="absolute"
    layer="local"
    backdrop="surface"
    placement="fill"
    padded={false}
    className="justify-center gap-5 px-6"
    onClose={onCancel}
  >
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
  </Overlay>
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
  gate,
  onAddTab,
  rowMenu,
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
  /** Owner-only experiment gate — the same one `order` was computed from, so the
   *  row can resolve a gated module's metadata. Omitted ⇒ no experiment open. */
  gate?: ModuleGate
  /** Custom-tab row metadata (`custom:<uuid>` ids — docs/CUSTOM_TABS_PLAN.md).
   *  Ids in `order` with no entry here (a module deleted elsewhere) just
   *  don't render. */
  customTabs?: TabDef[]
  /** "+" opens the per-project picker (attach customs + show/hide built-ins);
   *  undefined hides it. */
  onAddTab?: () => void
  /** Right-click menu on a tab — `actionFor(id)` returns the single action that
   *  tab offers (detach a custom / hide a built-in) or null for no menu (library
   *  delete lives in the "+" picker; the last visible tab is locked). Undefined
   *  disables the menu entirely. */
  rowMenu?: {
    actionFor: (id: string) => TabRowAction | null
  }
  /** Optional per-tab count chip (e.g. board → cards waiting in Review).
   *  0/undefined renders nothing — the row stays quiet by default. */
  badges?: Partial<Record<PanelView, number>>
}) => {
  const { t } = useT()
  // Metadata (icon/label) keyed by id; the row is rendered in `order`. Built from
  // the SAME gate as `order`, so an open experiment's module resolves its
  // icon/label (and a closed one is absent from both — never a half-rendered tab).
  const byId = useMemo(() => {
    const m = new Map<PanelView, TabDef>()
    for (const def of enabledModules(gate)) m.set(def.id, def)
    for (const def of customTabs ?? []) m.set(def.id, def)
    return m
  }, [customTabs, gate])
  const tabs = order.map(id => byId.get(id)).filter((m): m is TabDef => !!m)

  // Which custom tabs are audibly playing (the Songs tab's embedded player) —
  // drives the EQ-bars badge on the tab. Snapshot identity only moves on
  // start/stop/track change, so this re-renders the row rarely.
  const playback = usePlayback()

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

  // The action for the currently-open right-click menu, recomputed each render
  // so a state change that revokes it (e.g. the tab became the last one) closes
  // the menu rather than leaving a stale item.
  const menuAction = tabMenu ? rowMenu?.actionFor(tabMenu.id) ?? null : null

  return (
    // 計器盤 language (2026-08-03): the tab strip carries NO rule — separation
    // is spacing, and the active tab is an INVERSE PILL (ink surface, inverse
    // text — cream-on-ink in light, ink-on-cream in dark) instead of the old
    // red underline. Background+text change together (ui-interactive-states).
    <div className="flex shrink-0 items-center gap-1 px-6 py-2">
      {tabs.map((m, i) => {
        const active = m.id === view
        const dimmed = dragFrom === i
        // Audio-playing badge for a custom tab (e.g. the Songs tab): EQ bars
        // while its embedded app reports playback; the tooltip names the track.
        const tabPlayback = isCustomTabId(m.id)
          ? playback.get(customModuleIdFromTab(m.id))
          : undefined
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
              // Only when this tab offers an action (detach a custom / hide a
              // built-in); the resolver returns null otherwise (last tab, etc.).
              if (!rowMenu?.actionFor(m.id)) return
              e.preventDefault()
              setTabMenu({ id: m.id, x: e.clientX, y: e.clientY })
            }}
            onKeyDown={e => onTabKeyDown(e, i)}
            title={t('projectPanel.dragToReorder')}
            className={[
              'relative flex items-center gap-1.5 rounded-full px-3 py-1.5 label-cap transition-colors',
              active
                ? 'bg-ink text-ink-inverse'
                : 'text-ink-muted hover:bg-bg-inset hover:text-ink active:bg-bg-inset',
              dimmed ? 'opacity-40' : '',
              dragFrom !== null ? 'cursor-grabbing' : 'cursor-grab',
            ].join(' ')}
          >
            {barBefore && (
              <span className="pointer-events-none absolute -left-2 top-1 bottom-1 w-0.5 bg-accent" />
            )}
            {m.icon}
            <span>{tabLabel(m, t)}</span>
            {tabPlayback && (
              <span
                title={tabPlayback.title ?? 'Playing'}
                // On the active inverse pill the accent would sink into the ink
                // surface — flip to the inverse text colour there.
                className={active ? 'text-ink-inverse' : 'text-accent'}
              >
                <PlaybackEq size={9} />
              </span>
            )}
            {(badges?.[m.id] ?? 0) > 0 && (
              <span
                title={t('projectPanel.reviewWaitingTitle')}
                className={[
                  'rounded-full border px-1.5 text-[9px] font-medium leading-[14px]',
                  active
                    ? 'border-ink-inverse/40 text-ink-inverse'
                    : 'border-ochre/60 text-[var(--beacon-waiting)]',
                ].join(' ')}
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
      {tabMenu && menuAction && createPortal(
        // Body portal at overlay-modal z: the menu must open ABOVE a hosted
        // custom-tab iframe (CustomFrameHost, z 45), which any z inside the
        // panel's own stacking context cannot. Coordinates are already client-
        // space (the context-click position), so nothing else changes.
        <>
          {/* Invisible backdrop: any click outside the menu dismisses it
              (a right-click outside dismisses too, without opening the
              browser menu over our UI). */}
          <div
            className="fixed inset-0 z-overlay-modal"
            onMouseDown={() => setTabMenu(null)}
            onContextMenu={e => {
              e.preventDefault()
              setTabMenu(null)
            }}
          />
          <div
            role="menu"
            className="fixed z-overlay-modal min-w-[168px] overflow-hidden rounded-[6px] border border-line bg-bg-card py-1 shadow-card-hover"
            style={{ left: tabMenu.x, top: tabMenu.y }}
          >
            {/* One action, fired on the first click — both detach and hide are
                non-destructive (reversible from the "+" picker), so no confirm
                and no danger styling: a Minus to detach a custom, an EyeOff to
                hide a built-in. */}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void menuAction.run()
                setTabMenu(null)
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-ink transition-colors hover:bg-bg-inset active:bg-bg-inset focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
            >
              {menuAction.kind === 'detach' ? (
                <Minus size={13} strokeWidth={2} className="shrink-0" />
              ) : (
                <EyeOff size={13} strokeWidth={2} className="shrink-0" />
              )}
              <span className="flex-1">
                {t(menuAction.kind === 'detach' ? 'customTabs.detach' : 'customTabs.disableModule')}
              </span>
            </button>
          </div>
        </>,
        document.body,
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
  // Body-portaled at overlay-modal z, like the header editor/branch menus —
  // a hosted custom-tab iframe (z 45) covers any in-panel z, so the menu must
  // leave the panel's stacking context. Right-aligned to the trigger, measured
  // when it opens.
  const [menuPos, setMenuPos] = useState<{ right: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null)
      return
    }
    const r = ref.current?.getBoundingClientRect()
    if (r) setMenuPos({ right: window.innerWidth - r.right, top: r.bottom + 4 })
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      // Trigger clicks toggle via the IconButton; menu clicks stop propagation
      // in the portal (below) — so anything that lands here is truly outside.
      if (ref.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const closeNow = () => setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('resize', closeNow)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('resize', closeNow)
    }
  }, [open])
  return (
    <div ref={ref} className="relative" onMouseDown={e => e.stopPropagation()}>
      <IconButton title={t('projectPanel.moreActions')} onClick={() => setOpen(v => !v)}>
        <MoreHorizontal size={15} strokeWidth={1.75} />
      </IconButton>
      {open && menuPos && createPortal(
        <div
          onMouseDown={e => e.stopPropagation()}
          style={{ right: menuPos.right, top: menuPos.top }}
          className="fixed z-overlay-modal w-56 rounded-[2px] border border-line bg-bg-card py-1 shadow-card-hover"
        >
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
        </div>,
        document.body,
      )}
    </div>
  )
}


// ---------- Editable project title ----------

// Display heading; CLICK (or hit Enter while typing in the input) to set the
// project NAME — the cosmetic registry displayName, NOT the folder on disk.
// Default name is the folder basename; clearing the field reverts to it.
// Validation errors surface inline. Disabled (read-only) when onRename is
// omitted — e.g. the member side, which can't rename a shared project.
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
      onClick={start}
      title={onRename ? t('projectPanel.clickToRenameProject') : undefined}
      className={[css.text, onRename ? 'cursor-text' : ''].join(' ')}
      style={css.style}
    >
      {name}
    </h2>
  )
}
