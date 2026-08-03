
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Sparkles } from 'lucide-react'
import { InfiniteCanvas } from '@/components/canvas/InfiniteCanvas'
import { CustomFrameHost, destroyFramesForProject } from '@/components/canvas/modules/CustomFrameHost'
import { usePlayback } from '@/lib/playback/playbackStore'
import { Toolbar } from '@/components/canvas/Toolbar'
import { ToolPalette } from '@/components/canvas/ToolPalette'
import { SettingsPanel } from '@/components/canvas/SettingsPanel'
import { NewProjectModal } from '@/components/canvas/NewProjectModal'
import { FeedbackModal } from '@/components/canvas/FeedbackModal'
import { GlobalSkillsPanel } from '@/components/canvas/GlobalSkillsPanel'
import { AccountModal } from '@/components/canvas/AccountModal'
import { ProjectJumpPalette } from '@/components/canvas/ProjectJumpPalette'
import { ProjectPanel } from '@/components/canvas/ProjectPanel'
import { CollabSharedDialog } from '@/components/canvas/CollabSharedDialog'
import { useCollab } from '@/lib/collab/RealtimeContext'
import { applyTheme, themeFromSettings } from '@/lib/theme'
import { useExperiments } from '@/lib/modules/useExperiments'
import { useJoinDeepLink } from '@/lib/useJoinDeepLink'
import { Onboarding } from '@/components/Onboarding'
import { BulkActionBar } from '@/components/canvas/BulkActionBar'
import { ElementBar } from '@/components/canvas/ElementBar'
import { EmptyState } from '@/components/canvas/EmptyState'
import { GroundLoadError } from '@/components/canvas/GroundLoadError'
import { UsageHud } from '@/components/canvas/UsageHud'
import { ManualPanel } from '@/components/canvas/manual/ManualPanel'
import { aggregateClaudeBeacons } from '@/lib/groundBeacon'
import { setClientLockdown } from '@/lib/lockdownClient'
import { autoLayout, frameLabelFor } from '@/lib/layout'
import { useCanvasHistory } from '@/lib/useCanvasHistory'
import { newId } from '@/lib/ids'
import { loadPersistedView, savePersistedView } from '@/lib/persistView'
import { api } from '@/lib/api-client'
import { pickFolder } from '@/lib/pickFolder'
import { useAuth } from '@/lib/auth/AuthContext'
import { useT } from '@/i18n/I18nContext'
import type {
  ActiveTerminalsResponse,
  AppNotification,
  AppNotificationsResponse,
  CanvasAiActiveResponse,
  CanvasState,
  ClaudeBeaconStatus,
  CollabInviteForMe,
  CollabInvitesResponse,
  CollabProjectListItem,
  CollabProjectsListResponse,
  NotificationStateResponse,
  ProjectMeta,
  Settings,
  ProjectsResponse,
  Tool,
  FeedbackConfigResponse,
  ModuleSubmissionsConfigResponse,
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

// Same "last seen" scheme for the owner's module-submission review queue
// (docs/CUSTOM_TABS_PLAN.md) — scoped per Supabase source so it never carries a
// stale marker across projects/tables.
const MODULE_SUBMISSION_SEEN_KEY = 'openground:moduleSubmissionSeenAt'
const moduleSubmissionSeenKey = (sourceId: string | null) =>
  sourceId ? `${MODULE_SUBMISSION_SEEN_KEY}:${sourceId}` : MODULE_SUBMISSION_SEEN_KEY

// Stable id for a collab-invite notification — the read-state key persisted
// server-side (so re-login keeps unread state). Keyed by collabProjectId, which
// is unique + stable per shared project.
const collabInviteNotifId = (collabProjectId: string) => `collab-invite:${collabProjectId}`

// Arrow-key nudge vectors for the canvas keyboard shortcuts. Static, so it
// lives outside the component (and outside the effect's dependency list).
const ARROW_NUDGE: Record<string, [number, number]> = {
  arrowleft: [-1, 0],
  arrowright: [1, 0],
  arrowup: [0, -1],
  arrowdown: [0, 1],
}

// The first-run EmptyState overlay covers the whole Ground (its backdrop is
// inset-0 and captures clicks). Show it ONLY when the Ground has nothing at all
// to act on — no owned projects AND, on a collab build, no shared (member) cards
// either. A member who joined a shared project but registered zero owned folders
// still has clickable Ground cards, so the overlay must NOT hide them. With
// collab off this collapses to the original `ownedCount === 0`, so the default
// build is byte-for-byte unchanged. Pure + exported for unit testing.
export function shouldShowEmptyState(args: {
  ownedCount: number
  collabEnabled: boolean
  sharedCount: number
}): boolean {
  return args.ownedCount === 0 && (!args.collabEnabled || args.sharedCount === 0)
}

// The next selection state when the user OPENS AN OWNED project — via ⌘K jump,
// New, Import, or clicking its Ground card. It always clears any open shared
// (member) panel: ProjectPanel renders the owner body OR the member body, never
// both, and `openShared` wins the `project` prop
// (project={openShared ? null : singleSelected}). Without clearing it, a
// lingering openShared would pin the member panel over the owned project the
// user just opened (the "shared panel sticks" bug). Mirrors the inverse of
// openSharedCard, which clears selectedIds before setting openShared. Pure +
// exported for unit testing.
export function nextSelectionOnOpenOwned(id: string): {
  selectedIds: string[]
  openShared: null
} {
  return { selectedIds: [id], openShared: null }
}

export default function App() {
  const { t } = useT()
  const [projects, setProjects] = useState<ProjectMeta[]>([])
  const [settings, setSettings] = useState<Settings | null>(null)
  const [canvas, setCanvas] = useState<CanvasState | null>(null)
  // Mirror work mode (lockdown) into the module store the srcdoc builders
  // read (src/lib/lockdownClient.ts) — covers both the initial settings load
  // and every save, in both toggle directions.
  useEffect(() => {
    setClientLockdown(settings?.lockdownMode === true)
  }, [settings?.lockdownMode])
  // Why load() last failed. Only reachable as UI before the first successful
  // load, where it replaces the blank Ground with an error + Retry.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryingLoad, setRetryingLoad] = useState(false)
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
  // Module submission review queue (docs/CUSTOM_TABS_PLAN.md) — same shape as the
  // feedback inbox. canReview (owner build: service-role key + admin allowlist)
  // gates the "Tab submissions" inbox in Settings and the gear dot; sourceId
  // scopes the "seen" marker. Public build → canReview false, nothing shows.
  const [moduleReviewCanReview, setModuleReviewCanReview] = useState(false)
  const [moduleSubmissionUnread, setModuleSubmissionUnread] = useState(0)
  const [moduleSubmissionSourceId, setModuleSubmissionSourceId] = useState<string | null>(null)
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
  // Full-screen in-app manual (the "?" toolbar entry + first-run link).
  const [manualOpen, setManualOpen] = useState(false)
  const [skillsPanelOpen, setSkillsPanelOpen] = useState(false)
  // Realtime collab (member flow). `enabled` gates collab entirely — the default
  // build (no collab env) shows nothing. `sharedDialogOpen` is the join dialog,
  // opened EITHER by the Toolbar "Shared with me" entry (the member's path to the
  // INITIAL join — paste an invite code or link) OR by an `openground://join?code=…`
  // invite deep link (which prefills the code). Already-joined projects also surface
  // as Ground cards. `openShared` is the folder-less shared project currently viewed
  // in ProjectPanel's member body (null = none).
  const { enabled: collabEnabled } = useCollab()
  // Owner-only experiment gate (hidden features, default off). `eligible` reveals
  // the Settings toggle to the owner; `flags` gates which modules surface as tabs
  // in the project panel. Refreshed after a settings save (see saveSettings) so a
  // toggle shows/hides its module immediately.
  const experiments = useExperiments()
  const [sharedDialogOpen, setSharedDialogOpen] = useState(false)
  const [openShared, setOpenShared] = useState<{ id: string; label: string } | null>(null)
  // Ground member flow: projects shared WITH the user (owned:false from
  // /api/collab/projects), rendered as read-only "Shared" cards on the Ground
  // next to the owned ones. Empty unless collab is enabled — the fetch is gated
  // in load(), so the default (collab-off) build shows zero shared cards and the
  // Ground stays byte-for-byte unchanged.
  const [sharedProjects, setSharedProjects] = useState<CollabProjectListItem[]>([])
  // An invite code carried in by an `openground://join?code=…` deep link — opens
  // the join dialog with the code PREFILLED (never auto-joined: the member still
  // ticks consent + clicks Join). Cleared when the dialog closes / opens a
  // project. null = no pending deep link.
  const [deepLinkCode, setDeepLinkCode] = useState<string | null>(null)
  const onJoinCode = useCallback(
    (code: string) => {
      // A join link is meaningless with collab off (the dialog is gated) — ignore.
      if (!collabEnabled) return
      setDeepLinkCode(code)
      setSharedDialogOpen(true)
    },
    [collabEnabled],
  )
  useJoinDeepLink(onJoinCode)
  // In-app notifications (the Ground お知らせ bell). `invites` is the first source:
  // collab invites addressed to the signed-in user (GET /api/collab/invites, which
  // is RLS-self-scoped server-side — a user only ever reads their own invites).
  // `readNotifIds` is the SERVER-persisted set of seen ids (GET /api/notifications)
  // so unread state survives a re-login. Both are fetched only when the app login
  // is configured AND the user is signed in (see the effect below); otherwise empty,
  // so the bell stays 控えめ (no badge) for the public / signed-out build.
  const [invites, setInvites] = useState<CollabInviteForMe[]>([])
  // The SECOND notification source: server-persisted FATAL swarm events (the
  // escalation safety valve's in-app half — GET /api/swarm/notifications, owner-
  // only). Polled separately from invites (it's a local/owner feature, not gated
  // on collab); a non-owner gets 403 → stays empty, so the bell is unaffected.
  const [swarmNotifs, setSwarmNotifs] = useState<AppNotification[]>([])
  const [readNotifIds, setReadNotifIds] = useState<ReadonlySet<string>>(() => new Set())
  // Per-project claude beacon: projectId → 'working' (claude is busy) |
  // 'waiting' (claude sits on the human — its turn signal). Polled from
  // /api/terminal/active; the only "something is happening here" signal on
  // Ground cards. A project absent from the map shows no beacon (plain shells
  // don't count). Several claude cwds on one project collapse with
  // working > waiting.
  const [claudeStatusById, setClaudeStatusById] = useState<
    ReadonlyMap<string, ClaudeBeaconStatus>
  >(() => new Map())
  // Count of RUNNING Canvas AI jobs (generate / tweak) across all projects —
  // polled from /api/canvas/ai/active (same cadence as the terminal beacon) so a
  // run started on one canvas stays visible from anywhere (Ground / another
  // tab). Drives the global "Claude is designing" beacon below. 0 = none.
  const [aiActiveCount, setAiActiveCount] = useState(0)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [tool, setTool] = useState<Tool>('select')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The Ground canvas state the debounced save has NOT persisted yet. Set by
  // scheduleSave, cleared ONLY once a POST /api/canvas actually lands (2xx).
  // Non-null therefore means "the screen is ahead of the server": load() must
  // flush it before fetching, and must not clobber the local canvas with the
  // (older) server snapshot while it stays set.
  const pendingCanvasSave = useRef<CanvasState | null>(null)

  // Persist the pending canvas edit NOW, cancelling the debounce timer. On
  // success the marker clears only if no newer edit arrived while the POST was
  // in flight; on failure (network error / non-2xx) it stays set, so the edit
  // survives to the next flush attempt and load()'s reconcile guard keeps the
  // local canvas on screen instead of adopting the stale server one.
  const flushCanvasSave = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
    }
    const pending = pendingCanvasSave.current
    if (!pending) return
    try {
      const res = await api.api.canvas.$post({ json: pending })
      if (res.ok && pendingCanvasSave.current === pending) pendingCanvasSave.current = null
    } catch {
      // Kept pending — retried on the next flush (next edit's timer or load()).
    }
  }, [])

  const load = useCallback(async (): Promise<ProjectsResponse | null> => {
    // FLUSH (never discard) any pending debounced canvas save before fetching.
    // This used to be a bare clearTimeout, which cancelled the unsent save and
    // let the setCanvas below clobber a sub-400ms-old edit (sticky text typed
    // right before ⌘R / a focus re-scan) with the older server state. Flushing
    // first means the fetch below returns a snapshot that already includes it.
    await flushCanvasSave()
    // Ground member flow: fetch the projects shared WITH the user (owned:false)
    // in parallel — but ONLY when collab is enabled. With collab off this is a
    // resolved-empty promise (no network at all), so everything below is the
    // owned-only path and the Ground stays byte-for-byte unchanged.
    try {
      const [res, shared] = await Promise.all([
        api.api.projects.$get({}, { init: { cache: 'no-store' } }),
        collabEnabled
          ? fetch('/api/collab/projects')
              .then((r) => (r.ok ? (r.json() as Promise<CollabProjectsListResponse>) : null))
              .then((j) => (j?.projects ?? []).filter((p) => !p.owned))
              .catch(() => [] as CollabProjectListItem[])
          : Promise.resolve([] as CollabProjectListItem[]),
      ])
      // res.ok guard — the SAME contract as ProjectPanel's initial load. A
      // non-2xx body is an `{ error }` envelope, NOT ProjectsResponse: adopting
      // it left data.canvas undefined, so autoLayout below threw, the restore
      // effect's uncaught rejection swallowed it, and settings/canvas stayed
      // null → the blank `bg-bg` div forever, with no error and no Retry.
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as unknown as { error?: string }
        throw new Error(body.error ?? `GET /api/projects failed (${res.status})`)
      }
      const data = (await res.json()) as ProjectsResponse
      // Lay out owned + shared cards through one call so the shared cards (keyed
      // by collabProjectId) get non-overlapping grid slots after the owned ones.
      // When `shared` is empty the input is the owned list itself (same reference),
      // so autoLayout's result is identical to the owned-only build.
      const layoutInput = shared.length ? [...data.projects, ...shared] : data.projects
      const positions = autoLayout(layoutInput, data.canvas.positions)
      const canvas = { ...data.canvas, positions }
      setProjects(data.projects)
      setSettings(data.settings)
      // Colour theme: settings.json is the source of truth — re-stamp
      // html[data-theme] (and the pre-paint localStorage mirror) on every load
      // so a hand-edited or another-window change lands here too.
      applyTheme(themeFromSettings(data.settings))
      // If an edit landed while we were fetching (or the flush above failed),
      // the server snapshot is stale: keep the local canvas — its save is still
      // pending — and only lay out any cards it doesn't know yet.
      setCanvas((cur) =>
        cur && pendingCanvasSave.current
          ? { ...cur, positions: autoLayout(layoutInput, cur.positions) }
          : canvas,
      )
      setSharedProjects(shared)
      setLoadError(null)
      return { ...data, canvas }
    } catch (e) {
      // Every caller already handles the null (`loaded?.projects`), and several
      // call load() as a floating promise — so failures are recorded in state
      // rather than rethrown. Before the first successful load this drives the
      // Retry screen; afterwards the Ground stays painted on a refresh miss.
      setLoadError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [collabEnabled, flushCanvasSave])

  // Open a Ground shared card (member flow) — the SAME path CollabSharedDialog's
  // onOpen uses: clear any Ground selection (so the member body and the owned
  // body can never co-exist — ProjectPanel renders one or the other), then open.
  const openSharedCard = useCallback(
    (id: string) => {
      const s = sharedProjects.find((p) => p.id === id)
      setSelectedIds([])
      setOpenShared({ id, label: s?.label || t('projectPanel.collabSharedDialogUntitled') })
    },
    [sharedProjects, t],
  )

  // One-shot re-fetch of the お知らせ invites (used right after ACCEPTING one, so the
  // bell drops it without waiting for the 5-min poll). Mirrors the effect's poll but
  // imperative; gated the same way so a signed-out / collab-off build is a no-op.
  const refreshInvites = useCallback(() => {
    if (!collabEnabled || !authUser?.id) return
    fetch('/api/collab/invites')
      .then((r) => (r.ok ? (r.json() as Promise<CollabInvitesResponse>) : null))
      .then((d) => {
        if (d) setInvites(d.invites ?? [])
      })
      .catch(() => {})
  }, [collabEnabled, authUser?.id])

  // Open (and ACCEPT) a notification's target. A collab invite is now a PENDING
  // email invite — the named person has zero collab access until they accept it —
  // so "Join" both ACCEPTS (flips their og_project_members row pending→accepted via
  // POST /api/collab/accept, which the room's ticket gate requires) and OPENS the
  // folder-less shared project via the SAME member open-flow CollabSharedDialog uses
  // (clear the Ground selection so the member body and an owned body can't co-exist,
  // then setOpenShared). Accept runs FIRST so the room's first ticket request isn't
  // racing the membership flip; then we refresh the Ground (the shared card now
  // appears) and the bell (the accepted invite drops out). Accept is idempotent +
  // best-effort — a transient failure still opens the room (it surfaces its own
  // connecting / unavailable state).
  const openNotification = useCallback(
    (n: AppNotification) => {
      if (n.kind !== 'collab-invite' || !n.collabInvite) return
      const { collabProjectId, label } = n.collabInvite
      void (async () => {
        await fetch('/api/collab/accept', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ collabProjectId }),
        }).catch(() => {})
        setSelectedIds([])
        setOpenShared({
          id: collabProjectId,
          label: label || t('projectPanel.collabSharedDialogUntitled'),
        })
        // The shared card now appears on the Ground; the invite leaves the bell.
        void load()
        refreshInvites()
      })()
    },
    [t, load, refreshInvites],
  )

  // Opening the bell marks the currently-shown UNREAD notifications read —
  // optimistically in local state, then persisted server-side so a re-login doesn't
  // resurface them as unread. Only the not-yet-read ids are sent (no redundant POST
  // when nothing is new); marking read is monotonic (the server UNIONs ids), so a
  // failed POST just leaves them unread to retry next open.
  const markNotificationsSeen = useCallback(() => {
    // Mark EVERY currently-shown notification read — both sources (collab invites
    // and fatal swarm events) — so opening the bell clears the badge for all of them.
    const shownIds = [
      ...invites.map((iv) => collabInviteNotifId(iv.collabProjectId)),
      ...swarmNotifs.map((n) => n.id),
    ]
    const unreadIds = shownIds.filter((id) => !readNotifIds.has(id))
    if (unreadIds.length === 0) return
    setReadNotifIds((prev) => {
      const next = new Set(prev)
      unreadIds.forEach((id) => next.add(id))
      return next
    })
    fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids: unreadIds }),
    }).catch(() => {})
  }, [invites, swarmNotifs, readNotifIds])

  // Restore "where the user was" exactly once, after the first project scan:
  // re-open the project they had open before reload, if it still exists. A
  // saved project that's gone (deleted / renamed / archived-and-hidden) falls
  // back to Ground. The panel tab is restored inside ProjectPanel itself.
  const didRestore = useRef(false)
  const loadAndRestore = useCallback(
    () =>
      load()
        .then((data) => {
          // A failed load must NOT burn the one-shot: Retry has to be able to
          // restore the last-open project once the server comes back.
          if (didRestore.current || !data) return
          didRestore.current = true
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
        // load() funnels its own failures into loadError, so this only catches
        // a throw from the restore body itself. Either way: never an unhandled
        // rejection, which is what hid the blank-Ground bug for so long.
        .catch(() => {}),
    [load],
  )
  useEffect(() => {
    void loadAndRestore()
  }, [loadAndRestore])

  // Retry from the bootstrap-error screen (GroundLoadError). Same path as mount.
  const retryLoad = useCallback(() => {
    setRetryingLoad(true)
    void loadAndRestore().finally(() => setRetryingLoad(false))
  }, [loadAndRestore])

  // Persist the open project so a reload re-opens it. Exactly one selected
  // project is a real "location"; zero (Ground) or a multi-select isn't, so
  // clear the saved project in those cases. Gated on `didRestore` so the
  // mount-time `selectedIds === []` doesn't clear the saved id before the
  // restore effect (which resolves async after the first scan) can read it.
  useEffect(() => {
    if (!didRestore.current) return
    savePersistedView({ projectId: selectedIds.length === 1 ? selectedIds[0] : undefined })
  }, [selectedIds])

  // (Tool keys — V/T/S/F… — live in InfiniteCanvas, the single owner for both
  // the Ground and the embedded project canvas; `n` for the new-project modal
  // sits in the global handler below, behind its panel-open gate.)

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
    // Module submission review config (same identity-dependent canReview gate as
    // feedback — re-probed on login/logout via the effect's authUser dependency).
    fetch('/api/module-submissions/config')
      .then((res) => res.json() as Promise<Partial<ModuleSubmissionsConfigResponse>>)
      .then((data) => {
        if (!cancelled) {
          setModuleReviewCanReview(!!data.canReview)
          setModuleSubmissionSourceId(data.sourceId ?? null)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // lockdownMode: both configs report disabled while work mode is on, so the
    // entries hide the moment the toggle saves (and return when it clears).
  }, [authUser?.id, settings?.lockdownMode])

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

  // Fetch the in-app notifications (collab invites) + the server-persisted read-
  // state for the お知らせ bell. Gated on collabEnabled (NOT just auth): invites are
  // a collab notification, and acting on one — opening the folder-less shared
  // project — needs the realtime transport, so we never surface a "Join" that would
  // dead-end in a collab-off build. The BELL itself stays present on authEnabled
  // (常設); in an auth-on / collab-off build it's simply always empty. Re-checks on
  // mount, on sign-in change, every 5 min, and on focus (throttled to once a minute,
  // like the feedback poll). The invites route is RLS-self-scoped server-side.
  useEffect(() => {
    if (!collabEnabled || !authUser?.id) {
      setInvites([])
      return
    }
    let cancelled = false
    let lastPoll = 0
    const pollInvites = () => {
      lastPoll = Date.now()
      fetch('/api/collab/invites')
        .then((r) => (r.ok ? (r.json() as Promise<CollabInvitesResponse>) : null))
        .then((d) => {
          if (!cancelled && d) setInvites(d.invites ?? [])
        })
        .catch(() => {})
    }
    // Load the server-persisted seen-set FIRST, then start polling invites — so the
    // badge never briefly counts an already-read invite as unread on launch. Invites
    // poll regardless of whether the seen-set read succeeds (.finally).
    fetch('/api/notifications')
      .then((r) => (r.ok ? (r.json() as Promise<NotificationStateResponse>) : null))
      .then((d) => {
        if (!cancelled && d) setReadNotifIds(new Set(d.readIds ?? []))
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) pollInvites()
      })
    const onFocus = () => {
      if (Date.now() - lastPoll >= 60_000) pollInvites()
    }
    const id = window.setInterval(pollInvites, 300_000)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [collabEnabled, authUser?.id])

  // Poll the FATAL swarm notifications (escalation safety valve). Independent of
  // collab — it's the local owner's safety valve — and gated only on sign-in (the
  // route is owner-only; a non-owner / signed-out caller gets 403, handled as
  // empty). More frequent than invites (60s + focus): these are urgent, so the bell
  // should catch up quickly after the OS toast already fired server-side. Cleared
  // when signed out so a re-login starts clean.
  useEffect(() => {
    if (!authUser?.id) {
      setSwarmNotifs([])
      return
    }
    let cancelled = false
    let lastPoll = 0
    const poll = () => {
      lastPoll = Date.now()
      fetch('/api/swarm/notifications')
        .then((r) => (r.ok ? (r.json() as Promise<AppNotificationsResponse>) : null))
        .then((d) => {
          if (!cancelled && d) setSwarmNotifs(d.notifications ?? [])
        })
        .catch(() => {})
    }
    poll()
    const onFocus = () => {
      if (Date.now() - lastPoll >= 30_000) poll()
    }
    const id = window.setInterval(poll, 60_000)
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      window.clearInterval(id)
      window.removeEventListener('focus', onFocus)
    }
  }, [authUser?.id])

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

  // The module-submission unread poll — same cadence + Settings-open pause as the
  // feedback poll above (the inbox marks everything seen the moment it loads, so a
  // stale poll must not resurrect the dot while Settings is open).
  useEffect(() => {
    if (!moduleReviewCanReview || settingsOpen) return
    let cancelled = false
    let lastPoll = 0
    const poll = () => {
      lastPoll = Date.now()
      const since = localStorage.getItem(moduleSubmissionSeenKey(moduleSubmissionSourceId)) ?? ''
      const q = since ? `?since=${encodeURIComponent(since)}` : ''
      fetch(`/api/module-submissions/unread${q}`)
        .then((res) => (res.ok ? (res.json() as Promise<{ count?: number }>) : null))
        .then((data) => {
          if (!cancelled && data) setModuleSubmissionUnread(data.count ?? 0)
        })
        .catch(() => {})
    }
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
  }, [moduleReviewCanReview, settingsOpen, moduleSubmissionSourceId])

  // Called by the review inbox once it loads: record the newest timestamp as
  // "seen" (scoped per data source) and clear the gear dot.
  const markModuleSubmissionSeen = useCallback(
    (latestCreatedAt: string | null) => {
      if (latestCreatedAt)
        localStorage.setItem(moduleSubmissionSeenKey(moduleSubmissionSourceId), latestCreatedAt)
      setModuleSubmissionUnread(0)
    },
    [moduleSubmissionSourceId],
  )

  // Poll which projects have a live claude session (every 5s, skipped while
  // the tab is hidden; an immediate re-poll on focus covers the return).
  // Attribution + the working-wins collapse live in aggregateClaudeBeacons —
  // a session belongs to the project the SERVER says owns its cwd, which is how
  // a swarm worker running in a central worktree (outside the project folder)
  // reaches its card. Best-effort: a failed poll keeps the last known state
  // rather than flashing beacons off.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.hidden) return
      try {
        const res = await api.api.terminal.active.$get()
        if (!res.ok) return
        const data = (await res.json()) as ActiveTerminalsResponse
        if (cancelled) return
        // A server predating the refined payload omits `claude` — treat that
        // as "no claude sessions" so cards show no beacon.
        const nextStatus = aggregateClaudeBeacons(projects, data.claude ?? [])
        // Keep the previous Map identity when nothing changed so the canvas
        // doesn't re-render every 5 seconds.
        setClaudeStatusById((prev) =>
          prev.size === nextStatus.size &&
          Array.from(nextStatus).every(([id, st]) => prev.get(id) === st)
            ? prev
            : nextStatus,
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

  // Poll for RUNNING Canvas AI jobs (every 5s, skipped while the tab is hidden;
  // immediate re-poll on focus) — same pattern as the claude beacon above. The
  // count drives the global "Claude is designing" beacon, so a generation / tweak
  // started on one canvas stays visible from anywhere, including Ground. Best-
  // effort: a failed poll keeps the last known count rather than flashing off.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.hidden) return
      try {
        const res = await fetch('/api/canvas/ai/active')
        if (!res.ok) return
        const data = (await res.json()) as CanvasAiActiveResponse
        if (cancelled) return
        setAiActiveCount(data.jobs?.length ?? 0)
      } catch {
        /* server restarting / offline — keep the last known count */
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
    // Re-probe when work mode (lockdown) flips: the server reports auth
    // disabled while it is on, so the Sign-in UI hides/returns with the toggle.
  }, [settings?.lockdownMode])

  const scheduleSave = useCallback(
    (c: CanvasState) => {
      pendingCanvasSave.current = c
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null
        void flushCanvasSave()
      }, 400)
    },
    [flushCanvasSave],
  )

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
    // Selecting an owned Ground card returns focus to the owner body, so clear
    // any open shared (member) panel — otherwise openShared would pin the member
    // body over it (project={openShared ? null : singleSelected}; openShared
    // wins). No-op when nothing is shared. A deselect (id === null) leaves
    // openShared alone: the shared panel's own onClose owns that close path.
    if (id) setOpenShared(null)
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

  // Audio playing somewhere (a custom tab's embedded app — the Songs tab) →
  // the matching Ground card wears a "Playing" EQ stamp. The embedded app
  // self-reports which project the audio belongs to (projectName); matched
  // against the card's display name OR its folder basename, so a cosmetic
  // rename doesn't break the badge. The playback snapshot's identity only
  // changes on start/stop/track change, so this memo is quiet in steady state.
  const playback = usePlayback()
  const playbackByProjectId = useMemo(() => {
    const m = new Map<string, { title: string | null }>()
    if (playback.size === 0) return m
    const infos = Array.from(playback.values())
    for (const p of projects) {
      const basename = p.path.split(/[\\/]/).filter(Boolean).pop()
      for (const info of infos) {
        if (!info.projectName) continue
        if (info.projectName === p.name || info.projectName === basename) {
          m.set(p.id, { title: info.title })
          break
        }
      }
    }
    return m
  }, [playback, projects])

  // Canvas-wide keyboard shortcuts: undo/redo, duplicate, select-all,
  // deselect, enter-to-edit and arrow-key nudging.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Another surface already claimed this key (the ⌘K palette / modals
      // preventDefault before this bubble listener runs) — leave it to them so
      // one keypress never drives two surfaces at once.
      if (e.defaultPrevented) return
      const ae = document.activeElement
      const typing = !!ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
      const mod = e.metaKey || e.ctrlKey
      const k = e.key.toLowerCase()

      // A project panel is open — an owner's single selected card, OR a member's
      // shared project (openShared, which has no Ground card so the selection is
      // empty) — so the ProjectPanel overlay covers the Ground and owns every
      // key: leave them to the panel's own surfaces (its canvas / board /
      // terminals have their own maps; the Board no longer has its own ⌘Z, so
      // here that combo must simply do nothing rather than drive Ground undo).
      // Two stay global: ⌘K (the jump palette overlays anything) and Escape —
      // clearing the selection IS the panel's close path; the panel's canvas
      // preventDefaults the Escapes it consumes before this bubble listener.
      if (
        (visibleProjects.filter((p) => selectedIds.includes(p.id)).length === 1 ||
          !!openShared) &&
        !(mod && k === 'k') &&
        k !== 'escape'
      )
        return

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

      if (k === 'n' && !mod && !e.altKey) {
        if (typing || editingId) return
        // ⌘N is reserved by Chrome for "new window" — single-key `n` opens the
        // new-project modal instead (same flavour as the V/T/S/F tool keys).
        e.preventDefault()
        setNewProjectOpen(true)
        return
      }
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
    openShared,
    mutateCanvas,
  ])

  // Persist settings WITHOUT closing the panel — SettingsPanel autosaves
  // (debounced) while open; closing is only the X button / overlay click.
  const saveSettings = async (s: Settings) => {
    const res = await api.api.settings.$post({ json: s })
    if (!res.ok) {
      // Don't load() on failure — that would refetch the OLD settings and
      // silently roll back the toggle the user just changed, with no
      // indication anything went wrong.
      const e = (await res.json().catch(() => ({}))) as { error?: string }
      alert(t('misc.ground.saveSettingsFailed', { error: e.error ?? res.statusText }))
      return
    }
    await load()
    // Re-resolve the experiment gate: toggling an experiment in Settings must
    // show/hide its module right away, not on the next window focus.
    await experiments.refresh()
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
    // Same invariant as the panel's delete flow: letting go of a project
    // (however you do it) tears down the hosted custom-tab frames it owns, so
    // audio started there can't keep playing from a card that no longer exists.
    destroyFramesForProject(project.path)
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
    const picked = await pickFolder()
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
      // Opening the imported (owned) card clears any open shared panel so it
      // doesn't stay stuck over the new project (see nextSelectionOnOpenOwned).
      const sel = nextSelectionOnOpenOwned(created.id)
      setOpenShared(sel.openShared)
      setSelectedIds(sel.selectedIds)
      const pos = loaded!.canvas.positions[created.id]
      if (pos) centerOnCard(pos)
    }
  }

  // Re-point a missing project at the folder the user picks, KEEPING its uuid so
  // its central data (tasks / journal / canvases) reconnects. Distinct from
  // Import (which mints a new id). Mirrors importProject's pick→call→reload flow.
  const relocateProject = async (id: string) => {
    const picked = await pickFolder()
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
    // The bootstrap fetch failed and nothing has ever painted: say so and offer
    // a way out. Without this the user sits on an indistinguishable blank
    // canvas until the server recovers (⌘R and the focus re-scan are silent).
    if (loadError) {
      return <GroundLoadError detail={loadError} retrying={retryingLoad} onRetry={retryLoad} />
    }
    // First load still in flight — a bare backdrop, not a spinner flash.
    return <div className="h-screen w-screen bg-bg" />
  }

  const showEmpty = shouldShowEmptyState({
    ownedCount: projects.length,
    collabEnabled,
    sharedCount: sharedProjects.length,
  })
  // Compose the bell's notification list from the fetched sources (today: collab
  // invites) and tally how many are still unread (id not in the server-persisted
  // seen-set). Cheap derivations — recomputed each render from `invites` /
  // `readNotifIds`. Newest-first ordering already comes from the server.
  const notificationList: AppNotification[] = [
    ...swarmNotifs,
    ...invites.map<AppNotification>((iv) => ({
      id: collabInviteNotifId(iv.collabProjectId),
      kind: 'collab-invite',
      createdAt: iv.invitedAt,
      collabInvite: iv,
    })),
  ].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const unreadNotifications = notificationList.reduce(
    (count, n) => (readNotifIds.has(n.id) ? count : count + 1),
    0,
  )
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
        claudeStatuses={claudeStatusById}
        playbackByProject={playbackByProjectId}
        // Ground member flow: pass shared cards ONLY when collab is enabled, so
        // the default build renders zero shared cards (undefined → none).
        sharedProjects={collabEnabled ? sharedProjects : undefined}
        onOpenShared={openSharedCard}
        canvas={canvas}
        onCanvasChange={onCanvasChange}
        selectedIds={selectedIds}
        onSelect={handleSelect}
        onSelectIds={setSelectedIds}
        editingId={editingId}
        onEditingIdChange={setEditingId}
        tool={tool}
        onToolChange={setTool}
        // The Ground goes keyboard-inert while a project panel covers it —
        // otherwise V/F/Delete/⌘A typed into the panel's canvas would also
        // drive this invisible surface. A shared-project panel covers it too.
        suspendKeys={!!singleSelected || !!openShared}
      />
      {showEmpty && (
        <EmptyState
          onCreateNew={() => setNewProjectOpen(true)}
          onImport={importProject}
          onOpenManual={() => setManualOpen(true)}
        />
      )}
      {/* Canvas tools are meaningless with no projects — hide them under the
          empty-state modal so the first-run screen stays focused. */}
      {!showEmpty && <ToolPalette tool={tool} onToolChange={setTool} />}
      {/* Global "Claude is designing" beacon — a Canvas AI run lives server-side
          and survives leaving its canvas, so surface it here at the header so the
          user knows it's still going from anywhere (Ground included). */}
      {aiActiveCount > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-40 -translate-x-1/2">
          <div className="flex items-center gap-1.5 rounded-full border border-line bg-bg-card/95 px-3 py-1.5 text-[11px] font-medium text-ink-muted shadow-card backdrop-blur">
            <Loader2 size={12} strokeWidth={2} className="animate-spin text-accent" />
            <Sparkles size={11} strokeWidth={2} className="text-accent" />
            <span>{t('canvas.generate.generating')}</span>
            {aiActiveCount > 1 && (
              <span className="tabular-nums text-ink-faint">{aiActiveCount}</span>
            )}
          </div>
        </div>
      )}
      <Toolbar
        onNewProject={() => setNewProjectOpen(true)}
        onImport={importProject}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenManual={() => setManualOpen(true)}
        onOpenSkills={() => setSkillsPanelOpen(true)}
        // Member entry to the join dialog — the INITIAL join needs it (a member
        // with an invite code/link has nowhere to paste it otherwise; already-
        // joined projects also show as Ground cards). Gated on collabEnabled, so
        // the default (collab-off) build never shows it.
        onOpenShared={collabEnabled ? () => setSharedDialogOpen(true) : undefined}
        onFeedback={feedbackEnabled ? () => setFeedbackOpen(true) : undefined}
        onAccount={authEnabled ? () => setAccountOpen(true) : undefined}
        // In-app notifications (Ground お知らせ bell). Provided only when the app
        // login is configured (notifications are an account feature) — undefined
        // hides the bell, so the public no-auth build shows nothing. An empty list
        // (signed out / no invites) still renders the bell, just without a badge.
        notifications={authEnabled ? notificationList : undefined}
        unreadNotifications={unreadNotifications}
        onOpenNotification={openNotification}
        onNotificationsSeen={markNotificationsSeen}
        // The settings-gear dot covers BOTH owner inboxes (feedback + tab
        // submissions); either having unread lights it, opening Settings (which
        // loads both inboxes and marks them seen) clears it.
        unreadFeedback={feedbackUnread + moduleSubmissionUnread}
        projectCount={visibleProjects.length}
        usage={<UsageHud />}
      />
      <ProjectPanel
        // One panel for both modes: `shared` (a folder-less collab project shared
        // WITH the user) flips ProjectPanel into the member body; otherwise the
        // selected card opens the owner body. Mutually exclusive — opening a
        // shared project clears the Ground selection (singleSelected → null).
        project={openShared ? null : singleSelected}
        shared={openShared ?? undefined}
        onRelocate={relocateProject}
        frameLabel={frameLabel}
        feedbackEnabled={feedbackEnabled}
        // Owner-only experiment gate: which experimental modules surface as tabs.
        // All-false for non-owners, so the row is unchanged for everyone else.
        experiments={experiments.flags}
        onClose={openShared ? () => setOpenShared(null) : () => setSelectedIds([])}
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
          // Set the cosmetic PROJECT NAME (registry displayName) — NOT a folder
          // rename. The folder on disk is untouched; the name is display-only.
          const res = await api.api.projects['display-name'].$post({
            json: { path: project.path, displayName: newName },
          })
          const json = (await res.json().catch(() => ({}))) as { error?: string }
          if (!res.ok) return { error: json.error ?? 'Rename failed' }
          // Realtime collab: keep the member-visible shared name in step with the
          // project name so a rename shows up for members too. Best-effort —
          // 412 (this project isn't shared) / 403 (not owner) are expected no-ops.
          if (collabEnabled) {
            void api.api.collab.label
              .$post({ json: { path: project.path, label: newName } })
              .catch(() => {})
          }
          // The registry id is stable, so the panel stays on the same project;
          // reload to pick up the new display name.
          await load()
          return undefined
        }}
      />
      {/* Persistent host for custom-tab iframes — mounted ONCE, unconditionally
          (a remount would reload every hosted frame and cut any audio). It
          renders nothing until a custom tab is opened; a frame whose embedded
          app is playing audio survives tab/project switches here, hidden. */}
      <CustomFrameHost />
      {/* Realtime collab — the join dialog (member flow), opened by an invite
          deep link. Gated on collabEnabled, so the default build never mounts it.
          The shared panel is a folder-less overlay (its own doc source); it
          doesn't touch the Ground selection. */}
      {collabEnabled && sharedDialogOpen && (
        <CollabSharedDialog
          // Re-key on the incoming code so a deep link arriving while the dialog is
          // already open remounts it with the fresh initialCode prefilled.
          key={deepLinkCode ?? 'shared-dialog'}
          initialCode={deepLinkCode ?? undefined}
          onClose={() => {
            setSharedDialogOpen(false)
            setDeepLinkCode(null)
          }}
          onOpen={(id, label) => {
            setSharedDialogOpen(false)
            setDeepLinkCode(null)
            // Defense-in-depth: clear any Ground selection so the shared overlay
            // and ProjectPanel (both z-20) can never co-exist.
            setSelectedIds([])
            setOpenShared({ id, label })
          }}
        />
      )}
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
        // Owner-only: reveals the experiment toggles. Non-owners never see them
        // (eligible:false), so the feature's existence stays hidden.
        experimentsEligible={experiments.eligible}
        feedbackCanRead={feedbackCanRead}
        onFeedbackSeen={markFeedbackSeen}
        moduleReviewCanReview={moduleReviewCanReview}
        onModuleSubmissionSeen={markModuleSubmissionSeen}
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
            // Opening the new (owned) card clears any open shared panel so it
            // doesn't stay stuck over it (see nextSelectionOnOpenOwned).
            const sel = nextSelectionOnOpenOwned(created.id)
            setOpenShared(sel.openShared)
            setSelectedIds(sel.selectedIds)
            const pos = data!.canvas.positions[created.id]
            if (pos) centerOnCard(pos)
          }
        }}
      />
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
      <ManualPanel open={manualOpen} onClose={() => setManualOpen(false)} />
      <GlobalSkillsPanel open={skillsPanelOpen} onClose={() => setSkillsPanelOpen(false)} />
      <ProjectJumpPalette
        open={jumpOpen}
        projects={visibleProjects}
        onClose={() => setJumpOpen(false)}
        onPick={(p) => {
          setJumpOpen(false)
          // Jumping to an owned project clears any open shared panel so the
          // panel doesn't stay stuck on the member body (the jump palette only
          // lists owned projects — see nextSelectionOnOpenOwned).
          const sel = nextSelectionOnOpenOwned(p.id)
          setOpenShared(sel.openShared)
          setSelectedIds(sel.selectedIds)
          const pos = canvas.positions[p.id]
          if (pos) centerOnCard(pos)
        }}
      />
    </main>
  )
}
