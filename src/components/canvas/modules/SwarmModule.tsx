// SwarmModule — the owner-only "swarm" experiment surface.
//
// PURPOSE (project_inapp_swarm_port): watch this project's isolated `claude`
// workers run, all from one tab — the in-app version of the tmux
// supply/manage/worker cockpit. Workers are started by the autonomous engine
// (the master power switch in this module's header bar — SwarmPowerBar) or the
// commander session — the old manual per-card "dispatch" rail was removed;
// browsing todos lives on the Board tab.
//
// SECURITY: this component is mounted ONLY from ProjectPanel's render branch
// `view === 'swarm' && experiments?.swarm` — itself behind the server-resolved
// owner+toggle gate (gateFromFlags / computeExperiments). A non-owner or a
// flag-off user never mounts it, so every side effect here (the localStorage
// worker registry, the polls, the spawns) is reached ONLY when the gate is open.
// There is therefore nothing extra to gate INSIDE this file — the trace-zero
// guarantee is structural (Task A), and this file just consumes it.
//
// SCOPE: this surface LAUNCHES the role PTYs (supply / commander / worker
// restart) and RENDERS state. It owns the master power SWITCH (start/stop +
// the idempotent launches, composed in `powerSwarm`), but NOT the autonomy
// LOOP: the auto-drain / dispatch / commander wake-ups / scheduled column
// movement all run in the server-side engine — the switch just starts/stops it
// via toggleAutonomy. (The separate auto-integrate switch was retired
// 2026-07-16 — the engine never pushes; landing is the commander's.) The only
// column move owned here is a terminate's doing→todo requeue (its todo→doing
// counterpart left with the removed manual-dispatch rail).
//
// SUBSCRIPTION-ONLY: every role PTY is spawned through the /api/swarm/* routes
// (worker restart → POST /api/swarm/worker, supply / commander → their own
// routes), each launching an interactive `claude` PTY — never `claude -p` / the
// SDK. This module never spawns claude itself.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { Network, Inbox, Boxes, Gauge, ShieldCheck, X, Power, Eye, type LucideIcon } from 'lucide-react'
import { api } from '@/lib/api-client'
import { columnOf } from '@/components/canvas/BoardTab'
import { useT } from '@/i18n/I18nContext'
import { reconcileDesk } from '@/lib/deskReconcile'
import type {
  ActiveTerminalsResponse,
  BoardColumn,
  ClaudeBeaconStatus,
  ProjectData,
  ProjectMeta,
  RemoveSwarmWorktreeResponse,
  SettingsResponse,
  SpawnSwarmManagerResponse,
  SpawnSwarmSupplyResponse,
  SpawnSwarmWorkerResponse,
  SwarmPaneId,
  SwarmWorkerRecord,
} from '@/lib/types'
import { SWARM_PANE_IDS } from '@/lib/types'
import { effectiveTabOrder, moveTab } from '@/lib/modules/tabOrder'
import { SwarmWorkerPane, type WorkerStatus } from './SwarmWorkerPane'
import { SdkWorkerPane } from './SdkWorkerPane'
import { SwarmSupplyPane } from './SwarmSupplyPane'
import { SwarmManagerPane } from './SwarmManagerPane'
import { SwarmOverseerPane } from './SwarmOverseerPane'
import { deriveOverseerAlerts } from './swarmOverseerFeed'
import { SwarmPowerStatus, SwarmPowerSwitch } from './SwarmPowerBar'
import { ExecutionModeMenu } from './ExecutionModeToggle'
import { SwarmOnboarding } from './SwarmOnboarding'
import {
  useSwarmEngine,
  planSwarmPower,
  engineWorkerKey,
  KNOWN_ENV_ISSUE_IDS,
} from './useSwarmEngine'
import type { SwarmEnvIssueId } from './useSwarmEngine'

// Worker tiles lay out as a single horizontally-scrolling row. Each tile grows
// to fill the area when there are few (1 worker → full width) but never shrinks
// below MIN_TILE_WIDTH, so the embedded terminal always stays readable; once the
// tiles together exceed the area width the row scrolls horizontally so EVERY
// worker — including the engine's, past the manual cap — stays reachable.
// (Replaces the old N-column grid, which squished every tile thinner as the
// count grew and could clip a pane off-screen with no way to scroll to it.)
const MIN_TILE_WIDTH = 360
// Vertical counterpart of MIN_TILE_WIDTH: a tile never shrinks below this height
// either, so a short viewport scrolls the row VERTICALLY (overflow-y-auto)
// instead of crushing the terminal to a couple of rows. 220 matches the old
// grid's per-row minimum (minmax(220px, 1fr)), so this restores the exact
// short-window escape hatch the grid had — symmetric with the horizontal one.
const MIN_TILE_HEIGHT = 220

// The single supply (補給官) session, remembered client-side. Like a worker the
// PTY (terminalId) lives server-side and survives this tab unmounting; we
// persist the metadata so a tab switch / reload reattaches the same session.
// Unlike a worker there is no branch/worktree — supply runs in the project's
// primary checkout — so this is just the PTY id + minted session id + start time.
interface SwarmSupply {
  terminalId: string
  agentSessionId: string
  startedAt: string
}

const supplyKey = (projectId: string) => `openground.swarm.supply.${projectId}`

/** Load + SANITISE the persisted supply session (localStorage is untrusted — a
 *  user/extension can forge any JSON, so coerce every field; a bad shape → null
 *  rather than crashing the render). */
const loadSupply = (projectId: string): SwarmSupply | null => {
  try {
    const raw = localStorage.getItem(supplyKey(projectId))
    if (!raw) return null
    const o: unknown = JSON.parse(raw)
    if (!o || typeof o !== 'object') return null
    const r = o as Record<string, unknown>
    if (typeof r.terminalId !== 'string') return null
    return {
      terminalId: String(r.terminalId),
      agentSessionId: typeof r.agentSessionId === 'string' ? r.agentSessionId : '',
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
    }
  } catch {
    return null
  }
}

const saveSupply = (projectId: string, supply: SwarmSupply | null) => {
  try {
    if (supply) localStorage.setItem(supplyKey(projectId), JSON.stringify(supply))
    else localStorage.removeItem(supplyKey(projectId))
  } catch {
    /* quota / disabled storage — the in-memory state is still authoritative */
  }
}

// The single commander (司令官) CONVERSATION session, remembered client-side —
// the exact same shape + lifecycle as the supply session (no worktree; it runs
// in the primary checkout running /manage). The PTY (terminalId) lives
// server-side and survives this tab unmounting; we persist the metadata so a
// tab switch / reload reattaches the same /manage session. It is SEPARATE from
// the autonomous orchestrator engine (which has no PTY of its own) — this is the
// conversational commander the owner talks to.
interface SwarmManager {
  /** PTY commander ⇒ its terminal id. SDK commander ⇒ '' (the identity
   *  invariant: pty ⇔ terminalId, sdk ⇔ sdkSessionId, never both). */
  terminalId: string
  /** Absent ⇒ 'pty' — every record persisted before the commander dial existed. */
  runtime?: 'pty' | 'sdk'
  sdkSessionId?: string
  agentSessionId: string
  startedAt: string
}

const managerKey = (projectId: string) => `openground.swarm.manager.${projectId}`

/** The two Agent-SDK runtime dials, as the manager dashboard's switches read them.
 *  `workerCap` is how many workers may run on the SDK AT ONCE — carried because
 *  the switch's own copy has to state it (with the shipped default of 1, "run
 *  workers on the SDK" without the number reads as a promise the dial does not
 *  keep) and because writing the dial back must not silently drop a cap the user
 *  configured: settings merges at the top level, so a `{mode}` write REPLACES the
 *  whole object. */
type RuntimeDials = { worker: 'pty' | 'sdk'; manager: 'pty' | 'sdk'; workerCap: number }
/** Last-resort display fallback for the cap, used only if the server answered
 *  with a non-number — kept in lockstep with the server's
 *  DEFAULT_SDK_MAX_WORKERS (swarmWorkerRuntimeDial.ts). The real value arrives
 *  resolved in `runtimeDialsEffective.workerCap`; this module derives nothing
 *  about the dials itself (see the note at the settings read). */
const DEFAULT_SDK_MAX_WORKERS = 1

/** Load + SANITISE the persisted commander session (localStorage is untrusted —
 *  a user/extension can forge any JSON, so coerce every field; a bad shape →
 *  null rather than crashing the render). Mirrors loadSupply. */
const loadManager = (projectId: string): SwarmManager | null => {
  try {
    const raw = localStorage.getItem(managerKey(projectId))
    if (!raw) return null
    const o: unknown = JSON.parse(raw)
    if (!o || typeof o !== 'object') return null
    const r = o as Record<string, unknown>
    if (typeof r.terminalId !== 'string') return null
    // An SDK record is only usable if it carries the handle it is addressed by;
    // a forged or torn one saying 'sdk' with no session id would render a pane
    // pointed at nothing. Fall back to 'pty' — the shape every old record has.
    const sdkSessionId = typeof r.sdkSessionId === 'string' ? r.sdkSessionId : ''
    const runtime: 'pty' | 'sdk' = r.runtime === 'sdk' && sdkSessionId ? 'sdk' : 'pty'
    return {
      terminalId: String(r.terminalId),
      runtime,
      ...(runtime === 'sdk' ? { sdkSessionId } : {}),
      agentSessionId: typeof r.agentSessionId === 'string' ? r.agentSessionId : '',
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
    }
  } catch {
    return null
  }
}

/** Tear down whichever runtime carries the commander desk.
 *
 *  Best-effort on purpose (both branches swallow): the UI drops its record
 *  either way, and a stop that 404s because the desk is already gone must not
 *  leave the owner staring at a session they cannot close. Branches on
 *  `runtime`, never on "which id happens to be non-empty" — the two pools take
 *  different ids and mixing them up would silently kill someone else's pane. */
const stopCommanderDesk = async (manager: SwarmManager, projectPath: string): Promise<void> => {
  if (manager.runtime === 'sdk' && manager.sdkSessionId) {
    await fetch(
      `/api/sdk-session/${encodeURIComponent(manager.sdkSessionId)}?path=${encodeURIComponent(projectPath)}`,
      { method: 'DELETE' },
    ).catch(() => {})
    return
  }
  if (!manager.terminalId) return
  await api.api.terminal[':id'].$delete({ param: { id: manager.terminalId } }).catch(() => {})
}

/** Tear down whichever runtime carries THIS WORKER's desk — the worker-side
 *  twin of {@link stopCommanderDesk}, and the ONE place that decides it.
 *
 *  It is a shared helper and not an inline branch because both callers
 *  (`terminate` and `restartWorker`) must make the same choice, and the second
 *  one silently did not: it killed `worker.terminalId`, which for an SDK worker
 *  is ABSENT by the identity invariant (pty ⇔ terminalId, sdk ⇔ sdkSessionId),
 *  so the call was a no-op and the old `claude` kept running — in the very
 *  worktree the restart re-enters. That is two agents on one worktree and one
 *  branch, which is precisely the twin hazard the reuse-the-worktree design
 *  exists to prevent.
 *
 *  Branches on `runtime`, NEVER on "whichever id happens to be non-empty": the
 *  two pools take different ids, and DELETE /api/terminal/<an sdk id> would at
 *  best 404 and at worst kill an unrelated pane.
 *
 *  Best-effort (both branches swallow): the desk may already be gone, and a
 *  teardown that fails must not block the worktree removal / respawn that
 *  follows. */
const stopWorkerDesk = async (worker: SwarmWorkerRecord, projectPath: string): Promise<void> => {
  if (worker.runtime === 'sdk' && worker.sdkSessionId) {
    await fetch(
      `/api/sdk-session/${encodeURIComponent(worker.sdkSessionId)}?path=${encodeURIComponent(projectPath)}`,
      { method: 'DELETE' },
    ).catch(() => {})
    return
  }
  if (!worker.terminalId) return // a heartbeat-only DEAD worker: nothing to stop
  await api.api.terminal[':id'].$delete({ param: { id: worker.terminalId } }).catch(() => {})
}

/** The runtime identity a just-restarted worker came up on, held until the next
 *  GET /api/swarm/workers poll confirms it.
 *
 *  It carries the RUNTIME and not merely a terminalId because a restart decides
 *  its runtime SERVER-side (the dial), so the fresh worker may live in the other
 *  pool than the one that died. Overlaying only the terminalId left the tile
 *  rendering the old, dead PTY — Restart button and all — for a whole poll
 *  interval after an SDK worker had already come up in that worktree; a second
 *  click there spawns a twin into a worktree that is being written to. */
interface PendingRestart {
  runtime: 'pty' | 'sdk'
  /** Set for `runtime: 'pty'` only. */
  terminalId?: string
  /** Set for `runtime: 'sdk'` only. */
  sdkSessionId?: string
}

const saveManager = (projectId: string, manager: SwarmManager | null) => {
  try {
    if (manager) localStorage.setItem(managerKey(projectId), JSON.stringify(manager))
    else localStorage.removeItem(managerKey(projectId))
  } catch {
    /* quota / disabled storage — the in-memory state is still authoritative */
  }
}

// The four faces of the main area, switched by the tab row: the supply
// conversation desk, the commander (司令官) dashboard that drives the autonomous
// engine, the worker tiles, and the overseer (監督) inbox — the swarm's
// questions + needs-attention feed, read when opened (never pinned over the
// other views). (The old todo rail was removed — todos live on the Board tab
// now; the old Flow visualization tab was removed too — its needs-attention
// content lives on the overseer tab.)
//
// The id list + type is canonical in types.ts (SWARM_PANE_IDS) so the persisted
// Settings.swarmPaneOrder and the reorder helpers share one source of truth; the
// local alias keeps the many existing `MainView` references unchanged.
type MainView = SwarmPaneId

/** A failed worker/supply/manager spawn's 503 body carries `envIssues: string[]`
 *  (see server/routes/swarm.ts — the git/shell env-preflight gate,
 *  swarmEnvPreflight.ts). Map it to the SAME localized copy the poll-driven
 *  banner uses (`projectPanel.swarm.envPreflight.<id>`), so a launch failure the
 *  owner sees IMMEDIATELY after pressing a button reads in plain language too —
 *  not the route's raw English `body.error` (2026-07-22 review round 2: that
 *  literal string, including a `git init` instruction, was reaching the error
 *  banner untranslated). Returns null when `envIssues` is absent/empty/unknown,
 *  so the caller falls back to `body.error` for every OTHER kind of failure. */
const envIssuesErrorMessage = (
  t: (key: string, vars?: Record<string, string | number>) => string,
  envIssues: unknown,
): string | null => {
  if (!Array.isArray(envIssues)) return null
  const known = envIssues.filter(
    (id): id is SwarmEnvIssueId => typeof id === 'string' && KNOWN_ENV_ISSUE_IDS.has(id),
  )
  if (known.length === 0) return null
  return known.map((id) => t(`projectPanel.swarm.envPreflight.${id}`)).join(' ')
}

/** The env-preflight banner's i18n key for "what still works" (2026-07-22
 *  review, nit6): a non-git PROJECT (`notAGitRepo`) only blocks starting new
 *  workers — supply and the commander both run in the primary checkout and
 *  never touch git, so they still work. A missing git BINARY (`gitMissing`)
 *  additionally blocks the commander (its /og-manage conversation runs git
 *  constantly), leaving only supply. `shellMissing` blocks all three (nothing
 *  can open a PTY at all), so there is nothing reassuring left to say. Without
 *  this, a banner reading "this project can't start AI workers yet" on one of
 *  the 15/42 non-git registered projects (measured 2026-07-22) reads as
 *  "nothing here works", when in fact the task desk and commander are fine.
 *  Returns null when there is nothing to add (no issues, or shellMissing). */
const envBannerFootnoteKey = (issues: readonly { id: SwarmEnvIssueId }[]): string | null => {
  if (issues.length === 0) return null
  if (issues.some((i) => i.id === 'shellMissing')) return null
  if (issues.some((i) => i.id === 'gitMissing')) return 'projectPanel.swarm.envPreflight.footnoteSupplyOnly'
  if (issues.some((i) => i.id === 'notAGitRepo')) return 'projectPanel.swarm.envPreflight.footnoteSupplyAndManager'
  return null
}

export const SwarmModule = ({ project }: { project: ProjectMeta }) => {
  const { t } = useT()

  // PTY id → live status from GET /api/terminal/active (working|waiting).
  const [statusByPty, setStatusByPty] = useState<ReadonlyMap<string, ClaudeBeaconStatus>>(new Map())
  // PTY ids whose stream has closed (ClaudeTerminalPane.onExit / dead probe).
  const [exitedIds, setExitedIds] = useState<ReadonlySet<string>>(new Set())
  // worktree → reason a soft terminate KEPT that worktree (dirty/locked). Keyed
  // by worktree (not terminalId) since a DEAD worker (server truth: no live PTY)
  // still needs to show/act on this — see the server-truth worker list below.
  const [retainedByWorktree, setRetainedByWorktree] = useState<ReadonlyMap<string, string>>(
    new Map(),
  )
  // worktrees with a terminate/force-remove/restart in flight — a Set (not a
  // single value) so tearing one worker down doesn't block acting on another.
  const [busyWorktrees, setBusyWorktrees] = useState<ReadonlySet<string>>(new Set())
  // worktree → OPTIMISTIC new terminalId right after a successful restart, so the
  // tile re-mounts its terminal immediately instead of waiting up to 5s for the
  // next GET /api/swarm/workers poll to confirm it. Cleared once the poll agrees.
  const [pendingRestarts, setPendingRestarts] = useState<ReadonlyMap<string, PendingRestart>>(
    new Map(),
  )
  // worktrees whose CONFIRMED removal (terminate) we've already acted on — hides
  // the tile immediately instead of waiting for the next poll. Cleared once the
  // poll agrees the worktree is really gone.
  const [removedWorktrees, setRemovedWorktrees] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // The single supply (補給官) session + which face of the main area is shown.
  // Supply is the conversational entry point, so the main area opens on it.
  // supplyBusy = a launch/stop round-trip is in flight.
  const [supply, setSupply] = useState<SwarmSupply | null>(() => loadSupply(project.id))
  const [mainView, setMainView] = useState<MainView>(SWARM_PANE_IDS[0])
  const [supplyBusy, setSupplyBusy] = useState(false)

  // ── Sub-tab order (条件1/2/3) ───────────────────────────────────────────────
  // The owner's saved left-to-right order of the four sub-tabs, loaded ONCE from
  // /api/settings (Settings.swarmPaneOrder — GLOBAL: the four roles are identical
  // across projects, so one order serves them all, sitting beside executionMode /
  // swarmAllowedModels which the same header edits). `order` reconciles the saved
  // list against the canonical id set so a stale/garbage save can never strand a
  // pane, and its FIRST id is the default view. `userPickedRef` stops the async
  // settings load from overriding a tab the user clicked while it was in flight;
  // the reset effect re-lands on the first tab on every project switch.
  const [paneOrder, setPaneOrder] = useState<readonly string[] | undefined>(undefined)
  // The SERVER's effective runtime dials (`runtimeDialsEffective`), for the
  // manager dashboard's switches — never derived here. `null` until the settings
  // GET answers, or if it answers without them — the switches render disabled
  // rather than briefly asserting OFF, because OFF is a real answer here.
  const [runtimeDials, setRuntimeDials] = useState<RuntimeDials | null>(null)
  const order = useMemo(
    () => effectiveTabOrder<MainView>(paneOrder, SWARM_PANE_IDS),
    [paneOrder],
  )
  const paneOrderRef = useRef(paneOrder)
  paneOrderRef.current = paneOrder
  const userPickedRef = useRef(false)
  // Drag-to-reorder state (mirrors ProjectPanel's TabRow): `dragFrom` = the pane
  // being dragged, `dropAt` = the insertion slot it would land in (0..order.length).
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dropAt, setDropAt] = useState<number | null>(null)

  // The single commander (司令官) CONVERSATION session + its in-flight flag,
  // owned here exactly like the supply session and passed down to
  // SwarmManagerPane (which only renders it). managerBusy = a launch/stop
  // round-trip is in flight.
  const [manager, setManager] = useState<SwarmManager | null>(() => loadManager(project.id))
  const [managerBusy, setManagerBusy] = useState(false)

  // OPEN escalation count, reported up by the overseer pane's inbox poll (the
  // pane stays mounted-but-hidden while another view is active, so this stays
  // live). Drives the overseer tab badge AND keeps the pre-start onboarding from
  // hiding a leftover question (see swarmIdle below).
  const [escCount, setEscCount] = useState(0)

  // The autonomous engine's state — polled ONCE here (the shared hook) so BOTH
  // the worker tab and the manager dashboard read the same snapshot. `realWorkers`
  // is the SERVER-TRUTH worker list (GET /api/swarm/workers): live PTYs + the
  // engine's own roster + heartbeat files, already unified server-side — see
  // src/lib/server/swarmWorkerRegistry.ts. This replaces the old localStorage
  // manual registry + engine merge, which missed a worker started by a direct
  // `POST /api/swarm/worker` (curl/SDK) outside both of those name-based sources.
  const {
    engine,
    fatalNotifications,
    handledFatalIds,
    markFatalHandled,
    realWorkers,
    available: engineAvailable,
    busy: engineBusy,
    error: engineError,
    toggleAutonomy,
    dismissAutonomyReminder,
    toggleOverseer,
    dismissOverseerReminder,
    sandboxWarning: engineSandboxWarning,
    envIssues,
  } = useSwarmEngine(project.path)

  // The "autonomy was restored by the restart" notice (card 2b) is dismissed LOCALLY
  // — unlike the two banners below it, there is no server marker to clear here. The
  // persisted `swarmAutonomyOn` must STAY (it is what restores the engine on the next
  // boot as well), and the stop-POST the resume reminder dismisses with would halt a
  // healthy running engine. A notice, not a decision: hiding it for this session is
  // the whole of what [×] means.
  const [restoredNoticeDismissed, setRestoredNoticeDismissed] = useState(false)

  // ── Onboarding: FIRST RUN ONLY (2026-08-03 text-diet) ──────────────────────
  // The full explainer used to return on EVERY fully-idle visit — a returning
  // owner re-read ~330 chars of roles-and-flow each time the engine was off.
  // localStorage (client-side seen flag) rather than settings: it is a display
  // preference of THIS browser profile, and the settings allowlist trap
  // (unknown keys silently dropped) is not worth a server round trip for it.
  // The full explainer stays REACHABLE (the compact idle state's 「仕組み」
  // button below) — a disclosure without an entrance is a deleted feature.
  const [onboardingSeen, setOnboardingSeen] = useState(
    () => localStorage.getItem('og-swarm-onboarding-seen-v1') === '1',
  )
  const [showOnboarding, setShowOnboarding] = useState(false)
  const markOnboardingSeen = useCallback(() => {
    localStorage.setItem('og-swarm-onboarding-seen-v1', '1')
    setOnboardingSeen(true)
    setShowOnboarding(false)
  }, [])

  // The env-preflight banner is dismissible (条件: nit5, 2026-07-22 review) —
  // keyed by the SET of issue ids currently shown, not a plain boolean, so
  // dismissing "git missing" doesn't also hide a DIFFERENT issue that appears
  // later (e.g. shell trouble surfacing after git gets fixed) — that re-shows
  // the banner instead of leaving it silently gone.
  const [dismissedEnvIssuesKey, setDismissedEnvIssuesKey] = useState<string | null>(null)
  const envIssuesKey = envIssues.map((i) => i.id).sort().join(',')
  const showEnvBanner = envIssues.length > 0 && dismissedEnvIssuesKey !== envIssuesKey

  // PTY ids ever seen alive by the active poll. If an id was seen and then drops
  // out of the poll, the PTY died — used by statusOf so a missed SSE 'exit'
  // doesn't leave a dead worker stuck on 'starting'. A ref (not state) because it
  // only refines the render that statusByPty already triggers.
  const seenRef = useRef<Set<string>>(new Set())

  // Reset per-project view state when the panel is reused for another project
  // (ProjectPanel keeps one SwarmModule instance across project switches).
  useEffect(() => {
    setSupply(loadSupply(project.id))
    setManager(loadManager(project.id))
    setManagerBusy(false)
    // Land on the FIRST sub-tab of the (global) saved order (条件3). Read the
    // latest order via the ref, NOT a dep: a reorder changes paneOrder but not
    // project.id, so keying this on project.id keeps a reorder from re-firing
    // here and yanking the active tab back to the first one.
    userPickedRef.current = false
    setMainView(effectiveTabOrder<MainView>(paneOrderRef.current, SWARM_PANE_IDS)[0])
    setDragFrom(null)
    setDropAt(null)
    setSupplyBusy(false)
    setExitedIds(new Set())
    setRetainedByWorktree(new Map())
    setError(null)
    setBusyWorktrees(new Set())
    setPendingRestarts(new Map())
    setRemovedWorktrees(new Set())
    setEscCount(0)
    setDismissedEnvIssuesKey(null)
    seenRef.current = new Set()
  }, [project.id])

  // Load the saved sub-tab order ONCE (Settings.swarmPaneOrder is GLOBAL, like
  // executionMode which the same header's mode menu reads over /api/settings). On
  // arrival, land on the saved FIRST tab (条件3) unless the user already picked
  // one while it was in flight (userPickedRef). A missing/garbage value degrades
  // to the shipped order via effectiveTabOrder, and a reorder's fire-and-forget
  // persist self-heals here on the next mount's GET.
  useEffect(() => {
    let alive = true
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!alive || !s) return
        const raw = (s as { swarmPaneOrder?: unknown }).swarmPaneOrder
        const saved = Array.isArray(raw)
          ? raw.filter((x): x is string => typeof x === 'string')
          : undefined
        setPaneOrder(saved)
        // The runtime dials ride the SAME settings read — one GET, not three.
        // ⚠ DRAWN, NOT DERIVED. These two toggles are the KILL SWITCH: the whole
        // safety story of the SDK runtime is "if anything goes wrong, turn it off
        // — no release needed". A switch that draws OFF while the server is
        // running SDK is not a switch the owner can trust, and they would be
        // reading it at exactly the moment something has gone wrong.
        //
        // This block used to resolve the raw `swarmWorkerRuntime` /
        // `swarmManagerRuntime` keys here, re-implementing the server's rule
        // client-side. It drifted twice on 2026-08-02 alone: the worker switch
        // drew ON while dispatch ran PTY (the reader between them never got the
        // flip), and a broken settings.json drew ON while the server fell to the
        // kill switch. The second one is unfixable from the raw keys — a tolerant
        // GET reports a missing key for BOTH "never written" and "unreadable",
        // and those resolve to opposite runtimes. So the server now resolves them
        // through the very readers dispatch consults and serves the answer as
        // `runtimeDialsEffective`; this reads it and nothing more.
        //
        // Absent (an older server, or a shape we do not recognise) ⇒ null, which
        // renders the switches DISABLED rather than guessing. "I do not know what
        // the server is doing" is a state the owner can act on; a confident wrong
        // answer is not.
        const eff = (s as Partial<SettingsResponse>).runtimeDialsEffective
        const dial = (v: unknown): 'pty' | 'sdk' | null =>
          v === 'pty' || v === 'sdk' ? v : null
        const worker = dial(eff?.worker)
        const manager = dial(eff?.manager)
        setRuntimeDials(
          worker && manager
            ? {
                worker,
                manager,
                workerCap:
                  typeof eff?.workerCap === 'number' && Number.isFinite(eff.workerCap)
                    ? eff.workerCap
                    : DEFAULT_SDK_MAX_WORKERS,
              }
            : null,
        )
        if (!userPickedRef.current) {
          setMainView(effectiveTabOrder<MainView>(saved, SWARM_PANE_IDS)[0])
        }
      })
      .catch(() => {
        /* offline / server not up — the strip still works, defaults to supply */
      })
    return () => {
      alive = false
    }
  }, [])

  // Reconcile the optimistic restart/terminate overlays against the latest
  // server-truth poll: once GET /api/swarm/workers confirms a restart's new
  // terminalId (or that a terminated worktree is really gone), drop the
  // now-redundant optimistic entry so the overlay never permanently diverges
  // from the server if a poll is ever missed.
  useEffect(() => {
    if (pendingRestarts.size === 0 && removedWorktrees.size === 0) return
    const byWorktree = new Map(realWorkers.map((w) => [w.worktree, w]))
    setPendingRestarts((prev) => {
      let changed = false
      const next = new Map(prev)
      for (const [worktree, pending] of Array.from(prev)) {
        const seen = byWorktree.get(worktree)
        // Compare through engineWorkerKey — the runtime-agnostic identity. An
        // `?.terminalId === pendingId` comparison could never retire an SDK
        // restart (both sides are absent there, so it matched a worker that had
        // NOT come up yet, and never matched the one that had).
        if (seen && engineWorkerKey(seen) === engineWorkerKey(pending)) {
          next.delete(worktree)
          changed = true
        }
      }
      return changed ? next : prev
    })
    setRemovedWorktrees((prev) => {
      let changed = false
      const next = new Set(prev)
      for (const worktree of Array.from(prev)) {
        if (!byWorktree.has(worktree)) {
          next.delete(worktree)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [realWorkers, pendingRestarts, removedWorktrees])

  // Live worker status — same power etiquette as the Ground beacon (App.tsx)
  // and the Board (BoardModule): poll every 5s, skip while hidden, re-poll on
  // focus, and keep the Map identity when nothing changed so tiles don't
  // re-render every tick.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.hidden) return
      try {
        const res = await api.api.terminal.active.$get()
        if (!res.ok) return
        const payload = (await res.json()) as ActiveTerminalsResponse
        if (cancelled) return
        const next = new Map<string, ClaudeBeaconStatus>()
        for (const a of payload.claude ?? []) {
          next.set(a.id, a.status)
          seenRef.current.add(a.id)
        }
        setStatusByPty((prev) =>
          prev.size === next.size && Array.from(next).every(([id, st]) => prev.get(id) === st)
            ? prev
            : next,
        )
      } catch {
        /* keep last known */
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

  // Derive a worker's display status:
  //   exited (the pane signalled close) wins,
  //   else the live poll (working|waiting),
  //   else if it was seen alive earlier but is now gone from the poll → exited
  //     (covers a missed SSE 'exit' / a stream-only drop),
  //   else 'starting' (spawned, the 5s poll hasn't observed it yet).
  const statusOfPty = useCallback(
    (terminalId: string): WorkerStatus => {
      if (exitedIds.has(terminalId)) return 'exited'
      const s = statusByPty.get(terminalId)
      if (s === 'working' || s === 'waiting') return s
      if (seenRef.current.has(terminalId)) return 'exited'
      return 'starting'
    },
    [exitedIds, statusByPty],
  )

  const handleExit = useCallback((terminalId: string) => {
    setExitedIds((prev) => (prev.has(terminalId) ? prev : new Set(prev).add(terminalId)))
  }, [])

  // ── Desk reconcile (2026-08-03 — the post-restart dead-screen fix) ──────────
  // Every engine poll now carries the LIVE desk handles (managerDesk/supplyDesk,
  // both-pools reads). Follow them: ADOPT an engine-woken desk the stored record
  // does not name (zero-click reconnect after an app restart), CLEAR a
  // confirmed-dead record with no successor (honest launch CTA instead of the
  // eternal 「セッションが終了しました」). The decision itself is pure and
  // guarded (deskReconcile.ts — busy wins, old servers change nothing); this
  // effect only applies the verdict to state + localStorage.
  useEffect(() => {
    // The stored records use OPTIONAL runtime ('pty' when absent — every old
    // record's shape); the reconcile input is the normalized strict form.
    const mv = reconcileDesk(
      manager
        ? {
            terminalId: manager.terminalId,
            runtime: manager.runtime ?? 'pty',
            ...(manager.sdkSessionId ? { sdkSessionId: manager.sdkSessionId } : {}),
            agentSessionId: manager.agentSessionId,
            startedAt: manager.startedAt,
          }
        : null,
      engine.managerDesk,
      {
        busy: managerBusy,
        storedDead: !!manager && exitedIds.has(manager.terminalId || manager.sdkSessionId || ''),
      },
    )
    if (mv.kind === 'adopt') {
      setManager(mv.record)
      saveManager(project.id, mv.record)
    } else if (mv.kind === 'clear') {
      setManager(null)
      saveManager(project.id, null)
    }
    const sv = reconcileDesk(
      supply
        ? {
            terminalId: supply.terminalId,
            runtime: 'pty', // the supply desk is PTY-only by design
            agentSessionId: supply.agentSessionId,
            startedAt: supply.startedAt,
          }
        : null,
      engine.supplyDesk,
      {
        busy: supplyBusy,
        storedDead: !!supply && exitedIds.has(supply.terminalId),
      },
    )
    if (sv.kind === 'adopt' && sv.record.runtime === 'pty') {
      const rec: SwarmSupply = {
        terminalId: sv.record.terminalId,
        agentSessionId: sv.record.agentSessionId,
        startedAt: sv.record.startedAt,
      }
      setSupply(rec)
      saveSupply(project.id, rec)
    } else if (sv.kind === 'clear') {
      setSupply(null)
      saveSupply(project.id, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters/savers are stable; keyed on the data
  }, [engine.managerDesk, engine.supplyDesk, manager, supply, managerBusy, supplyBusy, exitedIds, project.id])

  // Terminate a worker: kill the PTY, then tear the worktree down. A soft
  // attempt keeps a dirty/locked tree (removed:false) so uncommitted work isn't
  // lost — we surface a force option. Force that still refuses drops the worker
  // anyway (the PTY is dead) and reports the reason for manual cleanup. Whenever
  // the worker is dropped, its card goes back to 'todo' so it's re-queued (the
  // autonomous engine, or a fresh worker, can pick it up again — hand-dispatch
  // from here was removed). Manual (non-engine-owned) workers only — a worktree
  // may or may not have a live terminalId (a heartbeat-only DEAD worker has
  // none), so the PTY kill is best-effort/skipped rather than required.
  const terminate = useCallback(
    async (worker: SwarmWorkerRecord, opts?: { force?: boolean }) => {
      if (busyWorktrees.has(worker.worktree)) return
      const force = opts?.force ?? false
      setBusyWorktrees((prev) => new Set(prev).add(worker.worktree))
      setError(null)

      const drop = () => {
        // Hide the tile immediately (confirmed removal) — the next server-truth
        // poll will agree the worktree is gone, at which point the reconcile
        // effect above drops this optimistic entry.
        setRemovedWorktrees((prev) => new Set(prev).add(worker.worktree))
        if (worker.terminalId) {
          const id = worker.terminalId
          setExitedIds((prev) => {
            if (!prev.has(id)) return prev
            const s = new Set(prev)
            s.delete(id)
            return s
          })
          seenRef.current.delete(id)
        }
        setRetainedByWorktree((prev) => {
          if (!prev.has(worker.worktree)) return prev
          const m = new Map(prev)
          m.delete(worker.worktree)
          return m
        })
      }
      const restoreCardToTodo = async () => {
        if (!worker.taskId) return
        try {
          // Undo OUR dispatch's todo→doing, but ONLY if the card is STILL in
          // doing. If the user / another member advanced it (done / review /
          // blocked) while the worker ran, leave that explicit move alone — we
          // must never clobber a more-advanced column back to todo (it would
          // silently overwrite someone's state, worst of all in a shared
          // project). Read the live column first; touch the card only when doing.
          const res = await api.api.project.$get({ query: { path: project.path } })
          if (res.ok) {
            const data = (await res.json()) as ProjectData
            const card = (data.tasks ?? []).find((tk) => tk.id === worker.taskId)
            if (card && columnOf(card) === 'doing') {
              await api.api.project.tasks.$post({
                json: {
                  path: project.path,
                  setColumn: [{ id: worker.taskId, column: 'todo' as BoardColumn }],
                },
              })
            }
          }
        } catch {
          /* board read/write failed — the card stays put, recoverable by hand */
        }
      }

      try {
        // Stop the desk first, IN WHICHEVER POOL IT LIVES (best-effort — it may
        // already be gone, or this worker may never have had one: a
        // heartbeat-only dead worker). Asking only the PTY pool is the silent
        // half-fix this file has to keep resisting: an SDK worker's terminalId
        // is ABSENT (pty ⇔ terminalId / sdk ⇔ sdkSessionId), so a PTY-only
        // delete simply doesn't run for it — and the worktree removal that
        // follows would then execute while `claude` is still writing in that
        // tree, which is how a "terminate" leaves a live process behind. One
        // shared helper so this decision cannot be made twice, differently.
        await stopWorkerDesk(worker, project.path)

        let removed = false
        let reason: string | undefined
        try {
          const res = await fetch('/api/swarm/worktree/remove', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: project.path, worktree: worker.worktree, force }),
          })
          if (res.ok) {
            const body = (await res.json()) as RemoveSwarmWorktreeResponse
            removed = body.removed
            reason = body.reason
          } else {
            reason = `HTTP ${res.status}`
          }
        } catch (e) {
          reason = e instanceof Error ? e.message : String(e)
        }

        if (removed) {
          drop()
          await restoreCardToTodo()
        } else if (force) {
          // Force already tried and still refused — nothing more we can do.
          drop()
          setError(t('projectPanel.swarm.forceFailed', { reason: reason || '' }))
          await restoreCardToTodo()
        } else {
          // Soft remove kept a dirty/locked tree — keep the tile, offer force.
          setRetainedByWorktree((prev) => new Map(prev).set(worker.worktree, reason || 'retained'))
        }
      } finally {
        setBusyWorktrees((prev) => {
          if (!prev.has(worker.worktree)) return prev
          const s = new Set(prev)
          s.delete(worker.worktree)
          return s
        })
      }
    },
    [busyWorktrees, project.path, t],
  )

  // Launch the single supply (補給官) session: POST /api/swarm/supply spawns a
  // claude PTY in the project's PRIMARY checkout (NO worktree) running /supply.
  // No card is read — supply IS the conversation desk; the user types requests
  // into it and it files Board:todo cards. Raw fetch + typed cast, same as the
  // worker spawn (the /api/swarm/* routes aren't on the typed RPC tree).
  const launchSupply = useCallback(async () => {
    if (supply || supplyBusy) return
    setSupplyBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/swarm/supply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; envIssues?: unknown }
        throw new Error(envIssuesErrorMessage(t, body?.envIssues) ?? body?.error ?? `HTTP ${res.status}`)
      }
      const spawn = (await res.json()) as SpawnSwarmSupplyResponse
      const next: SwarmSupply = {
        terminalId: spawn.terminalId,
        agentSessionId: spawn.agentSessionId,
        startedAt: new Date().toISOString(),
      }
      setSupply(next)
      saveSupply(project.id, next)
    } catch (e) {
      setError(
        t('projectPanel.swarm.supply.launchFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setSupplyBusy(false)
    }
  }, [supply, supplyBusy, project.path, project.id, t])

  // Stop the supply session: kill the PTY. There is NO worktree to tear down
  // (supply runs in the primary checkout), so unlike a worker terminate this is
  // a plain terminal kill — the session drops back to the launch CTA, and we
  // clear its id from the exited/seen bookkeeping so a relaunch starts clean.
  const stopSupply = useCallback(async () => {
    if (!supply || supplyBusy) return
    const term = supply.terminalId
    setSupplyBusy(true)
    setError(null)
    try {
      // The intent-clearing stop (2026-08-03): kills the desk server-side AND
      // clears the persisted supplyDesired flag — without it, boot auto-resume
      // would resurrect a desk the owner just closed, every restart, forever.
      await fetch('/api/swarm/supply/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      }).catch(() => {})
      // Belt-and-braces: the raw terminal delete for the stored id (the route
      // kills by desk label; a desk the pool lost the label for still dies here).
      await api.api.terminal[':id'].$delete({ param: { id: term } }).catch(() => {})
    } finally {
      setSupply(null)
      saveSupply(project.id, null)
      setExitedIds((prev) => {
        if (!prev.has(term)) return prev
        const s = new Set(prev)
        s.delete(term)
        return s
      })
      seenRef.current.delete(term)
      setSupplyBusy(false)
    }
  }, [supply, supplyBusy, project.id])

  // Launch the single commander (司令官) conversation: POST /api/swarm/manager
  // spawns a claude PTY in the project's PRIMARY checkout (NO worktree) running
  // /manage. The exact mirror of launchSupply — the commander IS a conversation
  // desk the owner talks to (status / merge / advise). Raw fetch + typed cast,
  // same as the worker/supply spawns (the /api/swarm/* routes aren't on the
  // typed RPC tree).
  const launchManager = useCallback(async () => {
    if (manager || managerBusy) return
    setManagerBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/swarm/manager', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; envIssues?: unknown }
        throw new Error(envIssuesErrorMessage(t, body?.envIssues) ?? body?.error ?? `HTTP ${res.status}`)
      }
      const spawn = (await res.json()) as SpawnSwarmManagerResponse
      const next: SwarmManager = {
        terminalId: spawn.terminalId,
        runtime: spawn.runtime ?? 'pty',
        ...(spawn.sdkSessionId ? { sdkSessionId: spawn.sdkSessionId } : {}),
        agentSessionId: spawn.agentSessionId,
        startedAt: new Date().toISOString(),
      }
      setManager(next)
      saveManager(project.id, next)
      // The dial said 'sdk' and the server seated a PTY desk anyway. Degrading is
      // the right behaviour (a desk beats no desk), but it must not be SILENT —
      // otherwise the owner sees a terminal where they expected a structured desk
      // and concludes the switch is broken.
      if (spawn.fellBackBecause) {
        setError(t('projectPanel.swarm.runtime.fellBack', { reason: spawn.fellBackBecause }))
      }
    } catch (e) {
      setError(
        t('projectPanel.swarm.manager.launchFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setManagerBusy(false)
    }
  }, [manager, managerBusy, project.path, project.id, t])

  // Stop the commander conversation: kill the PTY. There is NO worktree to tear
  // down (it runs in the primary checkout), so — like stopSupply — this is a
  // plain terminal kill; the session drops back to the launch CTA, and we clear
  // its id from the exited/seen bookkeeping so a relaunch starts clean.
  const stopManager = useCallback(async () => {
    if (!manager || managerBusy) return
    const term = manager.terminalId
    setManagerBusy(true)
    setError(null)
    try {
      await stopCommanderDesk(manager, project.path)
    } finally {
      setManager(null)
      saveManager(project.id, null)
      setExitedIds((prev) => {
        if (!prev.has(term)) return prev
        const s = new Set(prev)
        s.delete(term)
        return s
      })
      seenRef.current.delete(term)
      setManagerBusy(false)
    }
  }, [manager, managerBusy, project.id, project.path])

  // Drop a now-dead PTY id from the exited/seen bookkeeping so a relaunched
  // session starts clean and exitedIds never grows unbounded. `keep` is the
  // freshly installed id — never evict THAT (paranoia: a relaunch that somehow
  // returned the same id must stay tracked). Shared by the three restart paths.
  const forgetPty = useCallback((id: string | undefined, keep?: string) => {
    if (!id || id === keep) return
    setExitedIds((prev) => {
      if (!prev.has(id)) return prev
      const s = new Set(prev)
      s.delete(id)
      return s
    })
    seenRef.current.delete(id)
  }, [])

  // ── Restart an EXITED role PTY (the ClaudeTerminalPane exit overlay's button) ─
  // Re-launch the role-specific PTY and SWAP IN the new terminalId, which re-keys
  // the embedded ClaudeTerminalPane's effect and clears its exited overlay. The
  // overlay only ever shows on a DEAD PTY (SSE 'exit' / dead probe) and the busy
  // guard blocks a second click, so a restart can NEVER double-launch a live
  // session (条件: 二重起動しない). On failure we surface restartFailed and leave
  // the old (exited) id in place, so the overlay stays and the user can retry.
  const restartSupply = useCallback(async () => {
    if (supplyBusy) return
    const old = supply?.terminalId
    setSupplyBusy(true)
    setError(null)
    try {
      // Best-effort kill the old PTY first. The overlay normally shows only on a
      // dead PTY, but a transient mount-probe failure could surface it for a live
      // one — killing first guarantees we never orphan a still-running session.
      if (old) await api.api.terminal[':id'].$delete({ param: { id: old } }).catch(() => {})
      const res = await fetch('/api/swarm/supply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; envIssues?: unknown }
        throw new Error(envIssuesErrorMessage(t, body?.envIssues) ?? body?.error ?? `HTTP ${res.status}`)
      }
      const spawn = (await res.json()) as SpawnSwarmSupplyResponse
      const next: SwarmSupply = {
        terminalId: spawn.terminalId,
        agentSessionId: spawn.agentSessionId,
        startedAt: new Date().toISOString(),
      }
      setSupply(next)
      saveSupply(project.id, next)
      forgetPty(old, next.terminalId)
    } catch (e) {
      setError(
        t('projectPanel.swarm.restartFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setSupplyBusy(false)
    }
  }, [supply, supplyBusy, project.path, project.id, forgetPty, t])

  const restartManager = useCallback(async () => {
    if (managerBusy) return
    const old = manager?.terminalId
    setManagerBusy(true)
    setError(null)
    try {
      // Best-effort stop the old desk first (see restartSupply) so a transient
      // probe false positive can't orphan a still-running commander. Whichever
      // runtime it was on — the one-desk-per-project guard spans both pools, so
      // leaving an SDK desk alive here would make the respawn ADOPT it and the
      // owner's Restart would silently do nothing.
      if (manager) await stopCommanderDesk(manager, project.path)
      const res = await fetch('/api/swarm/manager', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; envIssues?: unknown }
        throw new Error(envIssuesErrorMessage(t, body?.envIssues) ?? body?.error ?? `HTTP ${res.status}`)
      }
      const spawn = (await res.json()) as SpawnSwarmManagerResponse
      const next: SwarmManager = {
        terminalId: spawn.terminalId,
        runtime: spawn.runtime ?? 'pty',
        ...(spawn.sdkSessionId ? { sdkSessionId: spawn.sdkSessionId } : {}),
        agentSessionId: spawn.agentSessionId,
        startedAt: new Date().toISOString(),
      }
      setManager(next)
      saveManager(project.id, next)
      forgetPty(old, next.terminalId)
      // Same as launchManager: a degrade to PTY must not be silent. Restart is in
      // fact the MORE likely place to meet one — it is what the owner reaches for
      // right after flipping the switch.
      if (spawn.fellBackBecause) {
        setError(t('projectPanel.swarm.runtime.fellBack', { reason: spawn.fellBackBecause }))
      }
    } catch (e) {
      setError(
        t('projectPanel.swarm.restartFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      )
    } finally {
      setManagerBusy(false)
    }
  }, [manager, managerBusy, project.path, project.id, forgetPty, t])

  // A worker restart REUSES the existing worktree (passed back to /api/swarm/worker
  // as `worktree`), so the same swarm/* branch + its in-progress work is preserved
  // and NO orphan worktree / twin branch is created — claude just re-boots in place
  // and re-runs its /order goal. We optimistically record the fresh worker's
  // RUNTIME IDENTITY (pendingRestarts — runtime + the id of whichever pool it
  // came up in, never just a terminalId) so the tile re-mounts the right pane
  // before the next poll, and clear the dead id's bookkeeping. Manual
  // (non-engine-owned) workers only — an engine worker's lifecycle is the
  // orchestrator's (read-only here).
  const restartWorker = useCallback(
    async (worker: SwarmWorkerRecord) => {
      if (busyWorktrees.has(worker.worktree)) return
      const old = worker.terminalId
      setBusyWorktrees((prev) => new Set(prev).add(worker.worktree))
      setError(null)
      try {
        // Best-effort stop the old desk first (see restartSupply), IN WHICHEVER
        // POOL IT LIVES. The worktree is reused (passed below), so only the
        // dead/stale desk is cleared — and a transient probe false positive
        // can't race a second claude into the same tree. Going through
        // stopWorkerDesk is the load-bearing part: the PTY-only kill this used
        // to do was a NO-OP for an SDK worker, whose `claude` then kept running
        // in the worktree the spawn below re-enters.
        await stopWorkerDesk(worker, project.path)
        const res = await fetch('/api/swarm/worker', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            path: project.path,
            // Goal source: the Board card when we have one (live title/notes),
            // else the worker's remembered one-liner/branch (a curl-spawned
            // worker without a card — there is no title to recover otherwise).
            ...(worker.taskId
              ? { taskId: worker.taskId }
              : { title: worker.taskTitle || worker.note || worker.branch }),
            // Reuse the SAME worktree — relaunch in place, don't fork a new tree.
            worktree: worker.worktree,
          }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string; envIssues?: unknown }
          throw new Error(envIssuesErrorMessage(t, body?.envIssues) ?? body?.error ?? `HTTP ${res.status}`)
        }
        const spawn = (await res.json()) as SpawnSwarmWorkerResponse
        // Which runtime the fresh worker ACTUALLY came up on — the server's
        // answer, not the dial's wish (a dial set to sdk degrades to pty for
        // several reasons, each reported below). 'sdk' only with a handle to
        // address it by; without one the SDK tile would point at nothing.
        //
        // AN OVERLAY WITH NO ADDRESS IS WORSE THAN NO OVERLAY. The previous
        // shape was a two-arm ternary whose `else` swept up the impossible case
        // too: a response saying `runtime:'sdk'` but carrying no sdkSessionId
        // fell into the PTY arm and was recorded as `{runtime:'pty',
        // terminalId:''}` — a pending restart pointing at NOBODY. Its
        // engineWorkerKey is '', so the reconcile below can never retire it, and
        // meanwhile it overwrote the live record's whole runtime identity: a
        // working SDK worker was redrawn as a dead PTY tile, Restart button and
        // all, and stayed that way. When the answer is unaddressable we record
        // NOTHING and let the ≤5 s poll bring server truth — a tile that lags is
        // recoverable, a tile that lies is not.
        const fresh: PendingRestart | null =
          spawn.runtime === 'sdk'
            ? spawn.sdkSessionId
              ? { runtime: 'sdk', sdkSessionId: spawn.sdkSessionId }
              : null
            : spawn.terminalId
              ? { runtime: 'pty', terminalId: spawn.terminalId }
              : null
        if (fresh) setPendingRestarts((prev) => new Map(prev).set(worker.worktree, fresh))
        forgetPty(old, spawn.terminalId)
        // Same rule as launchManager / restartManager: a degrade to PTY must not
        // be SILENT. In a packaged app the server is a forked child, so the
        // server-side console.warn reaches nobody — the owner would just see a
        // terminal where they expected a structured SDK desk and conclude the
        // switch is broken. The reason rides back on the response for exactly
        // this, and until now this call site threw it away.
        if (spawn.fellBackBecause) {
          setError(t('projectPanel.swarm.runtime.fellBack', { reason: spawn.fellBackBecause }))
        }
      } catch (e) {
        setError(
          t('projectPanel.swarm.restartFailed', {
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        setBusyWorktrees((prev) => {
          if (!prev.has(worker.worktree)) return prev
          const s = new Set(prev)
          s.delete(worker.worktree)
          return s
        })
      }
    },
    [busyWorktrees, project.path, forgetPty, t],
  )

  // ── The SINGLE master power switch (条件: 単一の開始/停止スイッチ) ────────────
  // ON: start the autonomous engine (which drains todo → dispatches workers) AND
  // launch the commander + supply conversations together. OFF: stop the engine's
  // NEW dispatch only — running workers finish (the server engine leaves them
  // alone) and their worktrees/branches are kept; the conversations stay up too.
  // The PURE planner (planSwarmPower) decides what to do given what's already
  // running, so every step is IDEMPOTENT (既に起動済みなら二重起動しない). It's
  // belt-and-suspenders: each executed action ALSO self-guards — toggleAutonomy
  // no-ops when the engine is already in the target state, and launchSupply /
  // launchManager no-op when their session exists or a launch is in flight. The
  // server engine's twin-dispatch / blocked / same-file gates are untouched.
  // (No separate auto-integrate switch exists anymore — retired 2026-07-16.)
  const powerSwarm = useCallback(
    (next: boolean) => {
      const plan = planSwarmPower(next, {
        running: engine.running,
        hasSupply: !!supply,
        hasManager: !!manager,
      })
      if (plan.engine !== undefined) toggleAutonomy(plan.engine)
      if (plan.launchSupply) void launchSupply()
      if (plan.launchManager) void launchManager()
    },
    [engine.running, supply, manager, toggleAutonomy, launchSupply, launchManager],
  )

  // ── The SINGLE worker source both tabs render ────────────────────────────
  // realWorkers (GET /api/swarm/workers) is the server-truth roster — every
  // worker, however it was started, shows up here. `stage` is set ONLY on an
  // engine-tracked worker (see swarmWorkerRegistry.ts) — its presence is what
  // makes a tile read-only, exactly as the old `source: 'engine'` did.
  // Filter confirmed-removed worktrees and overlay an in-flight restart's fresh
  // terminalId (both optimistic — see the reconcile effect above), so the tab
  // reflects an action immediately instead of waiting up to 5s for the next poll.
  const allWorkers = realWorkers
    .filter((w) => !removedWorktrees.has(w.worktree))
    .map((w) => {
      const pending = pendingRestarts.get(w.worktree)
      if (!pending || engineWorkerKey(pending) === engineWorkerKey(w)) return w
      // Replace the WHOLE runtime identity, never just the terminalId: a restart
      // picks its runtime server-side, so the fresh worker can live in the other
      // pool. Overlaying half of it left an SDK restart rendering the old, DEAD
      // PTY tile (with its Restart button live) until the next poll — one more
      // click there and a twin claude is running in a worktree the fresh worker
      // is already writing to. Both id fields are rewritten together so the
      // record can never carry one from each pool.
      return pending.runtime === 'sdk'
        ? { ...w, runtime: 'sdk' as const, sdkSessionId: pending.sdkSessionId, terminalId: undefined }
        : { ...w, runtime: 'pty' as const, terminalId: pending.terminalId, sdkSessionId: undefined }
    })

  // OFF / first-run: the swarm is FULLY idle — the engine isn't running, no
  // supply / commander / worker session exists, AND no escalation is awaiting an
  // answer. In that state we replace the tab surface with the central onboarding
  // (条件1/5) so a first-time owner sees the three roles + the work-flow + what
  // Start does BEFORE pressing it. The header row stays above it (its Start, and
  // the onboarding's, run the SAME powerSwarm composition). The moment anything
  // comes up, the normal tabs return. escCount is part of the guard because a
  // LEFTOVER question from the last run must not hide behind the onboarding —
  // the tab surface (with the overseer badge) must win.
  // An UNDISMISSED alert also wins over the onboarding (2026-08-04). Several
  // fatal events fire precisely when nothing is up — 'engine-resume-suppressed'
  // means the engine did NOT come back at boot, so `running` is false, there are
  // no desks and no workers — and the onboarding replaced the whole tab surface,
  // including the needs-attention feed that carries the explanation. The alert
  // existed only in the Ground bell, on the one screen the owner opens to ask
  // "why is nothing running?".
  //
  // …but only a THIS-PROJECT alert may do so (2026-08-04, second pass). Several
  // fatal events carry no projectPath at all — the Electron self-update's
  // rollback / canary-failed, the boot-time data-integrity check, and the two
  // app-wide resume suppressions — and `useSwarmEngine` shows a project-less
  // notification on EVERY project by design (they concern the whole app). Left in
  // this term, one undismissed rollback replaced the first-run onboarding with an
  // empty tab surface on every project the owner had never touched swarm in, and
  // it never self-clears. The feed still shows those rows; they just do not
  // hijack a screen that is trying to explain what swarm IS.
  //
  // ⚠ SHIPPED WITHOUT A GUARD, deliberately. I could not build a jsdom case that
  // goes red with this filter removed — the mounted-but-hidden overseer pane puts
  // the alert row in the document either way, and the onboarding kept rendering
  // in the un-filtered build too, so every assertion I tried passed both ways. A
  // test that cannot fail is worse than none (CLAUDE.md §1), so there is none;
  // this comment is the record. The reachability argument is concrete: those
  // events carry no projectPath, useSwarmEngine shows a project-less
  // notification on every project, and none of them self-clears.
  const pendingAlerts = deriveOverseerAlerts(engine, fatalNotifications, handledFatalIds).filter(
    (a) => a.source !== 'fatal' || a.fatal?.projectPath === project.path,
  ).length
  const swarmIdle =
    !engine.running &&
    !supply &&
    !manager &&
    allWorkers.length === 0 &&
    escCount === 0 &&
    pendingAlerts === 0

  // Persist a drag/keyboard reorder to Settings.swarmPaneOrder (条件2). moveTab
  // (shared with the per-project tab row) computes the new order; the POST is
  // optimistic + fire-and-forget (the strip updates at once; a failed persist
  // self-heals on the next mount's GET). The server narrows the body to the known
  // pane ids, so a bad index/order can never poison the stored value.
  const reorderPanes = useCallback(
    (from: number, to: number) => {
      const next = moveTab(order, from, to)
      if (next.every((id, i) => id === order[i])) return
      setPaneOrder(next)
      void fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ swarmPaneOrder: next }),
      }).catch(() => {
        /* fire-and-forget; the next mount's GET re-reads the persisted order */
      })
    },
    [order],
  )
  // Flip one runtime dial and persist it. Optimistic so the switch answers the
  // click immediately, but REVERTED on a failed write — unlike the pane order
  // (cosmetic, self-heals on the next mount), a dial the user believes is ON
  // while the server still reads OFF would send them hunting a phantom.
  // The POST stays OUTSIDE the state updater on purpose: React runs updater
  // functions twice under StrictMode, so a fetch in there would fire two writes
  // per click. Read the current value from the closure and keep the updater pure.
  const toggleRuntime = useCallback(
    (which: 'worker' | 'manager', next: boolean) => {
      if (!runtimeDials) return
      const before = runtimeDials[which]
      const mode = next ? ('sdk' as const) : ('pty' as const)
      if (before === mode) return
      setRuntimeDials({ ...runtimeDials, [which]: mode })
      void fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          which === 'worker'
            ? // Carry sdkMaxWorkers BACK: settings merges at the top level, so a
              // bare `{mode}` replaces the whole object and would silently wipe a
              // cap the user configured. Omitted when it is just the default, so
              // toggling the switch does not materialise a field nobody set.
              {
                swarmWorkerRuntime: {
                  mode,
                  ...(runtimeDials.workerCap !== DEFAULT_SDK_MAX_WORKERS
                    ? { sdkMaxWorkers: runtimeDials.workerCap }
                    : {}),
                },
              }
            : { swarmManagerRuntime: { mode } },
        ),
      })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status))
        })
        .catch(() => {
          // Revert ONLY if this click's value is still the one on screen — a
          // second toggle while the first write was in flight owns the state now,
          // and stomping it would hand the user a switch that flips by itself.
          setRuntimeDials((cur) => (cur && cur[which] === mode ? { ...cur, [which]: before } : cur))
        })
    },
    [runtimeDials],
  )

  const endPaneDrag = () => {
    setDragFrom(null)
    setDropAt(null)
  }
  const commitPaneDrop = () => {
    if (dragFrom !== null && dropAt !== null) reorderPanes(dragFrom, dropAt)
    endPaneDrag()
  }
  // Alt+←/→ keyboard reorder — the accessible alternative to dragging (same idiom
  // as ProjectPanel's tab row). A move drops the focused pane one slot over.
  const onPaneKeyDown = (e: ReactKeyboardEvent, i: number) => {
    if (!e.altKey) return
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      reorderPanes(i, i - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      reorderPanes(i, i + 2)
    }
  }

  // The sub-view tab strip — per-pane metadata keyed by id (so the strip renders
  // in the reconciled `order`), with the two badges (live workers / open
  // questions) kept declarative. It renders ON the header row (one line instead
  // of the old three stacked strips: power bar + mode row + tab row). 条件5: with
  // no saved order `order` === SWARM_PANE_IDS, so `orderedTabs` is byte-for-byte
  // the old hardcoded strip.
  const paneMeta: Record<
    MainView,
    { icon: LucideIcon; label: string; badge?: number; badgeTone?: 'accent' | 'line' }
  > = {
    supply: { icon: Inbox, label: t('projectPanel.swarm.supply.tab') },
    manager: { icon: Gauge, label: t('projectPanel.swarm.manager.tab') },
    workers: {
      icon: Boxes,
      label: t('projectPanel.swarm.workersTab'),
      badge: allWorkers.length > 0 ? allWorkers.length : undefined,
      badgeTone: 'line',
    },
    overseer: {
      icon: ShieldCheck,
      label: t('projectPanel.swarm.overseer.tab'),
      // An open question needs the OWNER's action — the accent badge is what
      // makes it noticeable now that the inbox is no longer pinned over the tabs.
      badge: escCount > 0 ? escCount : undefined,
      badgeTone: 'accent',
    },
  }
  const orderedTabs = order.map((view) => ({ view, ...paneMeta[view] }))

  return (
    // Right-pane-centric layout (条件4): the old left "to-do rail + dispatch"
    // panel was removed — browsing todos now lives on the Board tab (一本化), and
    // workers are started by the autonomous engine (the master power switch on
    // the header row) or the commander session, NOT by a per-card hand "dispatch"
    // here (条件1/2/3). This wrapper is a vertical stack: ONE header row (status ·
    // sub-view tabs · mode menu · master switch) + an error banner + the
    // full-height tab surface below.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* ── The ONE header row ──────────────────────────────────────────────
          Everything the old three stacked strips carried, on a single fixed-
          height line so the terminal area below gets the vertical space back:
          the live status pill (running/stopped · N workers), the sub-view tabs
          (hidden while the pre-start onboarding is the surface), the execution-
          mode dropdown (rare operation → an options menu, not an always-on
          row), and the master Stop|Start switch (条件1 — ON starts the engine +
          launches commander & supply, idempotent; OFF halts new dispatch only). */}
      <div className="flex h-[38px] shrink-0 items-center gap-3 border-b border-line bg-bg pl-3 pr-2">
        <SwarmPowerStatus
          running={engine.running}
          manualStop={engine.manualStop}
          available={engineAvailable}
          workerCount={allWorkers.length}
        />
        {swarmIdle ? (
          <div className="min-w-0 flex-1" aria-hidden />
        ) : (
          <div
            role="tablist"
            aria-label={t('projectPanel.swarm.title')}
            className="flex min-w-0 flex-1 items-center gap-1.5 self-stretch overflow-x-auto"
          >
            {orderedTabs.map(({ view, icon: Icon, label, badge, badgeTone }, i) => {
              const active = mainView === view
              // The dragged pane dims; the cursor reads grab / grabbing.
              const dimmed = dragFrom === i
              // Accent insertion bar at the LEADING edge of the pane a drop would
              // land before (or the trailing edge of the last pane for an
              // end-drop). Suppressed where moveTab is a no-op (dropping onto self
              // or just after self). Bars sit at the pane's inner edge (left-0 /
              // right-0), NOT floating in the gap like ProjectPanel's — this strip
              // is an overflow-x-auto container, which would clip an outside bar.
              const barBefore =
                dragFrom !== null && dropAt === i && dropAt !== dragFrom && dropAt !== dragFrom + 1
              const barAfter =
                dragFrom !== null &&
                i === orderedTabs.length - 1 &&
                dropAt === orderedTabs.length &&
                dropAt !== dragFrom + 1
              return (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={active}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move'
                  // Firefox needs a payload for the drag to fire; we read state.
                  e.dataTransfer.setData('text/plain', String(i))
                  setDragFrom(i)
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  const r = e.currentTarget.getBoundingClientRect()
                  const past = e.clientX > r.left + r.width / 2
                  setDropAt(i + (past ? 1 : 0))
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  commitPaneDrop()
                }}
                onDragEnd={endPaneDrag}
                onClick={() => {
                  // Mark an explicit pick so the async settings load can't override
                  // it, then switch. (Reordering does NOT change the active tab.)
                  userPickedRef.current = true
                  setMainView(view)
                }}
                onKeyDown={(e) => onPaneKeyDown(e, i)}
                title={t('projectPanel.dragToReorder')}
                className={[
                  // 計器盤 language: same inverse-pill idiom as the panel's
                  // main tab strip (ProjectPanel) — no underline, bg+text
                  // change together.
                  'relative my-1.5 flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 label-cap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
                  active
                    ? 'bg-ink text-ink-inverse'
                    : 'text-ink-muted hover:bg-plane hover:text-ink active:bg-plane',
                  dimmed ? 'opacity-40' : '',
                  dragFrom !== null ? 'cursor-grabbing' : 'cursor-grab',
                ].join(' ')}
              >
                {barBefore && (
                  <span className="pointer-events-none absolute left-0 top-1 bottom-1 w-0.5 bg-accent" />
                )}
                <Icon size={12} strokeWidth={2} />
                {label}
                {badge !== undefined && (
                  <span
                    className={
                      badgeTone === 'accent'
                        ? 'rounded-full bg-accent-soft px-1.5 text-plate font-medium leading-[14px] text-accent'
                        : active
                          // On the active inverse pill the faint/line pair
                          // would sink into the ink surface — flip to inverse.
                          ? 'rounded-full border border-ink-inverse/40 px-1.5 text-plate font-medium leading-[14px] text-ink-inverse'
                          : 'rounded-full border border-line px-1.5 text-plate font-medium leading-[14px] text-ink-faint'
                    }
                  >
                    {badge}
                  </span>
                )}
                {barAfter && (
                  <span className="pointer-events-none absolute right-0 top-1 bottom-1 w-0.5 bg-accent" />
                )}
              </button>
              )
            })}
          </div>
        )}
        <ExecutionModeMenu />
        <SwarmPowerSwitch
          running={engine.running}
          available={engineAvailable}
          busy={engineBusy}
          onToggle={powerSwarm}
        />
      </div>
      {/* Env preflight (git/shell) — ONE banner listing every unmet prerequisite
          (GET /api/swarm/preflight, the same gate the worker/supply/manager spawn
          routes enforce), so a missing git / non-repo project / missing shell is
          visible up front instead of only surfacing as a failed-launch error. */}
      {showEnvBanner && (
        <div className="flex shrink-0 items-start gap-3 border-b border-line-soft bg-bg px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-meta font-medium leading-relaxed text-accent">
              {t('projectPanel.swarm.envPreflight.title')}
            </p>
            <ul className="mt-1 list-disc pl-4">
              {envIssues.map((issue) => (
                <li key={issue.id} className="text-meta leading-relaxed text-ink-subtle">
                  {t(`projectPanel.swarm.envPreflight.${issue.id}`)}
                </li>
              ))}
            </ul>
            {(() => {
              const footnoteKey = envBannerFootnoteKey(envIssues)
              return footnoteKey ? (
                <p className="mt-1 text-meta leading-relaxed text-ink-faint">{t(footnoteKey)}</p>
              ) : null
            })()}
          </div>
          <button
            type="button"
            onClick={() => setDismissedEnvIssuesKey(envIssuesKey)}
            aria-label={t('projectPanel.swarm.autonomyReminder.dismiss')}
            title={t('projectPanel.swarm.autonomyReminder.dismiss')}
            className="inline-flex shrink-0 items-center justify-center rounded-[4px] p-1 text-ink-muted transition-colors duration-150 enabled:hover:text-accent enabled:active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* A transient action error (worker terminate / restart, supply・commander
          launch). The old to-do rail hosted this; with the rail gone it banners
          across the top of the pane so a failure is never lost. */}
      {error && (
        <p className="shrink-0 border-b border-line-soft bg-bg px-3 py-2 text-meta leading-relaxed text-accent">
          {error}
        </p>
      )}

      {/* Restart notice (autonomyResumed, card 2b) — the OTHER half of the reminder
          below. Since card 2 a restart RESTORES the drain by itself, so the "resume?"
          prompt (gated on !running) never fires for a restored project and the
          restoration used to happen in silence. Keyed off autonomyResumed, NOT
          `autonomyRemembered && running`: that pair is equally true after a plain manual
          ON, which restored nothing. Dismiss is LOCAL on purpose — the persisted marker
          must stay (it is what restores the engine on the NEXT boot too), and the stop-
          POST the reminder below uses would STOP a healthy running engine here. */}
      {engine.autonomyResumed && engine.running && !restoredNoticeDismissed && (
        <div className="flex shrink-0 items-center gap-3 border-b border-line-soft bg-bg px-3 py-2">
          <span className="min-w-0 flex-1 text-meta leading-relaxed text-ink-muted">
            {t('projectPanel.swarm.autonomyRestored')}
          </span>
          <button
            type="button"
            onClick={() => setRestoredNoticeDismissed(true)}
            aria-label={t('projectPanel.swarm.autonomyReminder.dismiss')}
            title={t('projectPanel.swarm.autonomyReminder.dismiss')}
            className="inline-flex shrink-0 items-center justify-center rounded-[4px] p-1 text-ink-muted transition-colors duration-150 enabled:hover:text-accent enabled:active:scale-[0.99] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* Restart reminder (autonomyRemembered) — shown when the drain is NOT running
          despite the owner having had it on: either the boot resume was suppressed
          (crash-loop breaker / preflight) or this is a build where resume doesn't run.
          Offer a one-click resume (never auto-resumed). Dismiss clears the persisted
          marker (toggleAutonomy false → forgetSwarmAutonomy). */}
      {engine.autonomyRemembered && !engine.running && (
        <div className="flex shrink-0 items-center gap-3 border-b border-line-soft bg-bg px-3 py-2">
          <span className="min-w-0 flex-1 text-meta leading-relaxed text-ink-muted">
            {t('projectPanel.swarm.autonomyReminder')}
          </span>
          <button
            type="button"
            onClick={() => toggleAutonomy(true)}
            disabled={engineBusy || !engineAvailable}
            className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-accent bg-accent px-2.5 py-1 text-meta font-medium text-bg-card transition-all duration-150 enabled:hover:border-accent-hover enabled:hover:bg-accent-hover enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Power size={12} strokeWidth={2.25} aria-hidden />
            {t('projectPanel.swarm.autonomyReminder.resume')}
          </button>
          <button
            type="button"
            onClick={() => dismissAutonomyReminder()}
            disabled={engineBusy}
            aria-label={t('projectPanel.swarm.autonomyReminder.dismiss')}
            title={t('projectPanel.swarm.autonomyReminder.dismiss')}
            className="inline-flex shrink-0 items-center justify-center rounded-[4px] p-1 text-ink-muted transition-colors duration-150 enabled:hover:text-accent enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* Overseer restore banner (overseerRemembered, card 2b) — the ASYMMETRY made
          visible, which is what OVERSEER_DESIGN.md:161 asks for. Autonomy and
          self-supply come back on their own after a restart; the supervisor never
          does, deliberately — it wakes an AI, types into running work and deletes
          finished branches, and a restart is the one kill switch for that with no
          substitute layer (K2 / L9-③). So instead of arming it, we say so and offer
          one click. The plain-language line spells out those effects (no jargon) so
          the owner presses the button KNOWING what comes back on.
          Shown while the record says "was on" and it is NOT currently armed.
          [×] goes through its OWN action — toggleOverseer(false) would be a
          guaranteed no-op here (already disarmed ⇒ nothing written ⇒ banner returns
          on the next poll: the d1d6d704 dismiss trap). */}
      {engine.overseerRemembered && !engine.overseer && (
        <div className="flex shrink-0 items-start gap-3 border-b border-line-soft bg-bg px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-meta leading-relaxed text-ink-muted">
              {t('projectPanel.swarm.overseerReminder')}
            </p>
            <p className="mt-1 text-meta leading-relaxed text-ink-faint">
              {t('projectPanel.swarm.overseerReminder.effects')}
            </p>
            {/* Arming REQUIRES a running engine (the D1 gate the server enforces —
                this card adds a display, never a new way in). Say why the button is
                dimmed rather than letting the click silently do nothing. */}
            {!engine.running && (
              <p className="mt-1 text-meta leading-relaxed text-ink-faint">
                {t('projectPanel.swarm.overseerReminder.needsAutonomy')}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => toggleOverseer(true)}
            disabled={engineBusy || !engineAvailable || !engine.running}
            title={!engine.running ? t('projectPanel.swarm.overseerReminder.needsAutonomy') : undefined}
            className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-accent bg-accent px-2.5 py-1 text-meta font-medium text-bg-card transition-all duration-150 enabled:hover:border-accent-hover enabled:hover:bg-accent-hover enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Eye size={12} strokeWidth={2.25} aria-hidden />
            {t('projectPanel.swarm.overseerReminder.restore')}
          </button>
          <button
            type="button"
            onClick={() => dismissOverseerReminder()}
            disabled={engineBusy}
            aria-label={t('projectPanel.swarm.overseerReminder.dismiss')}
            title={t('projectPanel.swarm.overseerReminder.dismiss')}
            className="inline-flex shrink-0 items-center justify-center rounded-[4px] p-1 text-ink-muted transition-colors duration-150 enabled:hover:text-accent enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* ── Overseer pane (C1): the swarm's questions + needs-attention feed. ──
          ALWAYS mounted (hidden unless its tab is active): its inbox poll feeds
          the overseer tab badge AND the swarmIdle escape above — a leftover
          question from the last run must not hide behind the onboarding. The
          old pinned-above-the-tabs banner is gone: like the commander and
          worker views, this is read when its tab is opened. Fail-closed lives
          server-side; visibility lives here. */}
      <div
        className={
          !swarmIdle && mainView === 'overseer'
            ? 'flex min-h-0 min-w-0 flex-1 flex-col'
            : 'hidden'
        }
      >
        <SwarmOverseerPane
          projectPath={project.path}
          engine={engine}
          fatalNotifications={fatalNotifications}
          handledFatalIds={handledFatalIds}
          onMarkFatalHandled={markFatalHandled}
          openCount={escCount}
          onOpenCountChange={setEscCount}
        />
      </div>

      {/* ── Tab surface: supply desk ⇆ commander ⇆ worker tiles ───────────── */}
      {/* No bg on this wrapper: the empty/CTA states below are PAPER surfaces
          (bg-bg) so the paper ink tokens keep 4.5:1+ contrast. The dark terminal
          bg (#1a1a1a) is scoped to the pane branches only, where
          ClaudeTerminalPane's own light-on-dark xterm lives — putting it here
          would bury the empty states' dark ink on a dark ground. */}
      {/* min-w-0 is load-bearing: without it this flex item's min-width:auto
          would grow to the worker grid's intrinsic width and push the whole
          tile area off-screen — the bug this layout fixes. */}
      {/* OFF / first-run → the central onboarding (条件1/5): the three roles, the
          work-flow, and what Start does, shown BEFORE pressing it. Its Start fires
          the SAME powerSwarm composition as the bar above. Otherwise → the normal
          supply ⇆ commander ⇆ workers tab surface. */}
      {swarmIdle && (!onboardingSeen || showOnboarding) ? (
        <SwarmOnboarding
          onStart={() => {
            markOnboardingSeen()
            powerSwarm(true)
          }}
          busy={engineBusy}
          available={engineAvailable}
          error={engineError}
        />
      ) : swarmIdle ? (
        // The compact idle state — what a RETURNING owner sees instead of the
        // full explainer: one line, Start, and the entrance back to the manual.
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="max-w-[360px] text-center">
            <p className="mb-4 text-ui text-ink-subtle">
              {t('projectPanel.swarm.onboarding.intro')}
            </p>
            <div className="flex items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => powerSwarm(true)}
                disabled={engineBusy || !engineAvailable}
                className="inline-flex items-center gap-1.5 rounded-[3px] bg-accent px-4 py-1.5 text-ui font-medium text-bg-card transition-colors hover:opacity-90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                {t('projectPanel.swarm.power.start')}
              </button>
              <button
                type="button"
                onClick={() => setShowOnboarding(true)}
                className="text-meta text-ink-faint underline-offset-2 transition-colors hover:text-ink-muted hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
              >
                {t('projectPanel.swarm.onboarding.reopen')}
              </button>
            </div>
            {engineError ? <p className="mt-3 text-meta text-accent">{engineError}</p> : null}
          </div>
        </div>
      ) : mainView === 'overseer' ? null : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {mainView === 'supply' ? (
          supply ? (
            // The live supply session — a single reused ClaudeTerminalPane.
            <div className="min-h-0 flex-1">
              <SwarmSupplyPane
                terminalId={supply.terminalId}
                status={statusOfPty(supply.terminalId)}
                busy={supplyBusy}
                onExit={() => supply && handleExit(supply.terminalId)}
                onStop={() => void stopSupply()}
                onRestart={() => void restartSupply()}
              />
            </div>
          ) : (
            // Launch CTA — the conversation desk that turns requests into cards.
            <div className="flex flex-1 items-center justify-center bg-bg px-8 text-center">
              <div className="max-w-sm">
                <div className="mx-auto mb-4 inline-flex h-11 w-11 items-center justify-center rounded-[3px] border border-line bg-bg-inset text-ink-muted">
                  <Inbox size={20} strokeWidth={1.75} />
                </div>
                <p className="label-cap mb-2 text-ink-faint">{t('projectPanel.swarm.supply.badge')}</p>
                <h2 className="mb-2 text-read font-medium text-ink">
                  {t('projectPanel.swarm.supply.title')}
                </h2>
                <p className="mb-4 text-ui leading-relaxed text-ink-subtle">
                  {t('projectPanel.swarm.supply.empty')}
                </p>
                <button
                  type="button"
                  onClick={() => void launchSupply()}
                  disabled={supplyBusy}
                  className="inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-bg-card px-3 py-1.5 text-ui text-ink-muted transition-colors hover:border-accent hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
                >
                  <Inbox size={13} strokeWidth={2} />
                  {supplyBusy
                    ? t('projectPanel.swarm.supply.launching')
                    : t('projectPanel.swarm.supply.launch')}
                </button>
              </div>
            </div>
          )
        ) : mainView === 'manager' ? (
          // Commander (司令官) dashboard: the conversation stage + the engine
          // controls (Autonomy status / Overseer). Its engine state comes from the
          // shared useSwarmEngine hook above — no own fetch. Live worker screens
          // live on the worker tab; the Board pipeline tallies on the Board tab.
          <div className="min-h-0 flex-1">
            <SwarmManagerPane
              projectPath={project.path}
              session={
                manager
                  ? {
                      terminalId: manager.terminalId,
                      // The PTY poll cannot see an SDK desk, so `status` is sent
                      // ONLY for a PTY one. It used to be sent for both, with the
                      // constant 'working' standing in for the SDK case — so the
                      // commander's beacon said 作業中 forever: never waiting on
                      // a question, never quota-parked, never exited. A status
                      // that cannot be wrong is not a status. The SDK desk
                      // reports its own on its event stream (SwarmManagerPane
                      // reads it there); nothing here may guess it.
                      ...(manager.runtime === 'sdk' && manager.sdkSessionId
                        ? { runtime: 'sdk' as const, sdkSessionId: manager.sdkSessionId }
                        : {
                            runtime: 'pty' as const,
                            status: statusOfPty(manager.terminalId),
                          }),
                    }
                  : null
              }
              sessionBusy={managerBusy}
              onLaunchSession={() => void launchManager()}
              onStopSession={() => void stopManager()}
              onSessionExit={() => {
                if (!manager) return
                if (manager.runtime === 'sdk') {
                  // An SDK desk has no terminalId, so the PTY bookkeeping below
                  // would mark the EMPTY STRING exited — a no-op — while the
                  // manager state (whose status is deliberately pinned 'working'
                  // for SDK) kept rendering a live desk. The session is gone;
                  // clear the desk so the pane honestly shows the launch CTA.
                  setManager(null)
                  saveManager(project.id, null)
                  return
                }
                handleExit(manager.terminalId)
              }}
              onRestartSession={() => void restartManager()}
              engine={engine}
              available={engineAvailable}
              busy={engineBusy}
              error={engineError}
              onToggleOverseer={toggleOverseer}
              sandboxWarning={engineSandboxWarning}
              runtimeDials={runtimeDials}
              onToggleRuntime={toggleRuntime}
            />
          </div>
        ) : allWorkers.length === 0 ? (
          <div className="flex flex-1 items-center justify-center bg-bg px-8 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-4 inline-flex h-11 w-11 items-center justify-center rounded-[3px] border border-line bg-bg-inset text-ink-muted">
                <Network size={20} strokeWidth={1.75} />
              </div>
              <p className="label-cap mb-2 text-ink-faint">{t('projectPanel.swarm.badge')}</p>
              <h2 className="mb-2 text-read font-medium text-ink">
                {t('projectPanel.swarm.title')}
              </h2>
              <p className="text-ui leading-relaxed text-ink-subtle">
                {t('projectPanel.swarm.workersEmpty')}
              </p>
            </div>
          </div>
        ) : (
          // Single horizontally-scrolling row of worker tiles (see MIN_TILE_WIDTH).
          // min-w-0 keeps this flex item from growing to the row's intrinsic
          // (scrollable) width; overflow-x-auto provides the horizontal scrollbar
          // that makes every worker reachable once the tiles overflow the area,
          // and overflow-y-auto provides the vertical one for a short viewport
          // (see MIN_TILE_HEIGHT) — in a normal-height area neither tile reaches
          // its minimum so only the horizontal bar ever shows.
          <div className="flex min-h-0 min-w-0 flex-1 gap-px overflow-x-auto overflow-y-auto bg-line-strong">
            {allWorkers.map((w) => {
              // Engine-tracked workers (stage present — see swarmWorkerRegistry.ts)
              // are read-only here (the orchestrator owns their lifecycle); every
              // other worker — engine-dispatch-independent: curl-direct or a UI
              // restart — is terminable/restartable, matching the old
              // 'manual'/'engine' distinction but keyed off server truth now.
              const isEngine = w.stage !== undefined
              return (
                <div
                  key={w.worktree}
                  className="h-full overflow-hidden"
                  // Grow to fill when few, but never shrink below MIN_TILE_WIDTH ×
                  // MIN_TILE_HEIGHT; the explicit min-width also overrides flex's
                  // default min-width:auto so a wide xterm can't stretch the tile.
                  style={{
                    flex: `1 0 ${MIN_TILE_WIDTH}px`,
                    minWidth: MIN_TILE_WIDTH,
                    minHeight: MIN_TILE_HEIGHT,
                  }}
                >
                  {w.runtime === 'sdk' && w.sdkSessionId ? (
                    // An SDK worker has no terminal to render — its tile shows
                    // the distilled event stream instead. Same header vocabulary,
                    // so a mixed fleet still reads as one fleet.
                    <SdkWorkerPane
                      sdkSessionId={w.sdkSessionId}
                      projectPath={project.path}
                      branch={w.branch}
                      taskTitle={w.taskTitle ?? w.note ?? ''}
                      source={isEngine ? 'engine' : 'manual'}
                      // The SAME teardown affordances the PTY tile gets. Without
                      // them a manually-started SDK worker could be launched
                      // from this tab and then never cleaned up from it — its
                      // worktree survived on disk with no UI path to remove it.
                      retainedReason={!isEngine ? retainedByWorktree.get(w.worktree) : undefined}
                      busy={!isEngine ? busyWorktrees.has(w.worktree) : false}
                      onTerminate={!isEngine ? () => void terminate(w) : undefined}
                      onForceRemove={!isEngine ? () => void terminate(w, { force: true }) : undefined}
                      // …including RESTART, which this tile did not have at all.
                      // A worker that came up on (or was restarted onto) the SDK
                      // runtime renders here, and here the restart chain ended:
                      // the only remaining move was to terminate the worktree
                      // and lose the branch. Same callback the PTY tile gets, so
                      // the reuse-the-worktree contract is identical.
                      onRestart={!isEngine ? () => void restartWorker(w) : undefined}
                    />
                  ) : (
                  <SwarmWorkerPane
                    terminalId={w.terminalId}
                    branch={w.branch}
                    taskTitle={w.taskTitle ?? w.note ?? ''}
                    status={w.terminalId ? statusOfPty(w.terminalId) : 'exited'}
                    source={isEngine ? 'engine' : 'manual'}
                    retainedReason={!isEngine ? retainedByWorktree.get(w.worktree) : undefined}
                    busy={!isEngine ? busyWorktrees.has(w.worktree) : false}
                    onExit={() => w.terminalId && handleExit(w.terminalId)}
                    onRestart={!isEngine ? () => void restartWorker(w) : undefined}
                    onTerminate={!isEngine ? () => void terminate(w) : undefined}
                    onForceRemove={!isEngine ? () => void terminate(w, { force: true }) : undefined}
                  />
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
      )}
    </div>
  )
}
