// SwarmModule — the "swarm" experiment surface.
//
// PURPOSE (project_inapp_swarm_port): watch this project's isolated `claude`
// workers run, all from one surface — the in-app version of the tmux
// supply/manage/worker cockpit. Workers are started by the autonomous engine
// (the master power switch in this module's header bar — SwarmPowerBar) or the
// commander session — the old manual per-card "dispatch" rail was removed;
// browsing todos lives on the Board tab.
//
// WHERE IT LIVES (owner decision 2026-09-24): not a tab any more. It is the
// body of SwarmBottomBar — a strip under EVERY project tab. `collapsed` renders
// just the one header row (status · open questions · master switch) and mounts
// no seat, so a folded bar opens no EventSource (the 6-connection cap — see
// the seats-row comment further down / SwarmWorkerSeat).
//
// SECURITY: this component is mounted ONLY from SwarmBottomBar, which
// ProjectPanel renders behind `isSwarmVisible(moduleGate)` — itself the
// server-resolved experiment gate (gateFromFlags / computeExperiments). A non-owner or a
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
  useRef,
  useState,
} from 'react'
import { X, Power, ChevronUp, ChevronDown, Network } from 'lucide-react'
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
  SpawnSwarmManagerResponse,
  SpawnSwarmWorkerResponse,
  SwarmWorkerRecord,
} from '@/lib/types'
import { SwarmWorkerPane, type WorkerStatus } from './SwarmWorkerPane'
import { SdkWorkerPane, blipVerdict, type SdkSessionProbe } from './SdkWorkerPane'
import { SwarmSupplyPane } from './SwarmSupplyPane'
import { SwarmSeatHeader } from './SwarmSeatHeader'
import { SwarmWorkerSeat } from './SwarmWorkerSeat'
import { useSupplyDesk } from './useSupplyDesk'
import { SwarmManagerPane } from './SwarmManagerPane'
import { SwarmPowerSwitch } from './SwarmPowerBar'
import { SwarmOnboarding } from './SwarmOnboarding'
import {
  useSwarmEngine,
  planSwarmPower,
  engineWorkerKey,
  envIssuesErrorMessage,
} from './useSwarmEngine'
import type { SwarmEnvIssueId } from './useSwarmEngine'
import { workerBeaconStatus } from '@/lib/workerBeacon'
import { SwarmErrorBanner } from '@/components/canvas/modules/SwarmErrorBanner'
import { STREAM_BUDGET, useStreamCount } from '@/lib/streamBudget'

// Seats (社長 / manager / each worker) lay out as ONE horizontally-scrolling
// row. Each seat grows to fill the area when there are few but never shrinks
// below 360px wide (the embedded terminal / transcript stays readable) nor
// 220px tall (a short window scrolls vertically instead of crushing the seat);
// the explicit min-width also overrides flex's min-width:auto so a wide xterm
// can't stretch its seat. Past the width, the row scrolls — every seat stays
// reachable. Narrow windows therefore always SCROLL, never wrap.
const SEAT_STYLE = { flex: '1 0 360px', minWidth: 360, minHeight: 220 } as const
const SEAT_CLASS = 'h-full overflow-hidden'
// A FOLDED worker seat (SwarmWorkerSeat) carries a nameplate and a few lines,
// so it can be narrower — more of the fleet fits on one screen.
// 260 tall, not 220: a waiting worker with its question AND the opened send box
// must still show the Send button (a short bar scrolls instead).
const WORKER_SEAT_STYLE = { flex: '1 0 240px', minWidth: 240, minHeight: 260 } as const
// The manager's seat shows its recent conversation (2026-09-24) — same shape
// as a folded worker seat, a little wider for the start/stop button.
const MANAGER_SEAT_STYLE = { flex: '1 0 280px', minWidth: 280, minHeight: 220 } as const

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

/** Tear down the commander desk — through the ROUTE that also records the intent.
 *
 *  ⚠ IT IS NOT A RAW KILL ANY MORE (2026-08-26), and the distinction is the whole
 *  point. This used to DELETE the desk's handle directly, which stops the desk
 *  but can never say the owner MEANT it. Now that a commander comes back at boot
 *  (`EngineIntent.managerDesired`, added the same day to end the orphaned-commander
 *  stall), a stop that does not clear that flag resurrects a desk the owner just
 *  closed, on every restart, forever — the exact trap /api/swarm/supply/stop was
 *  built to avoid on its side. POST /api/swarm/manager/stop does both halves, and
 *  it kills across BOTH pools server-side, so this no longer has to branch on
 *  runtime at all: the identity invariant (pty ⇔ terminalId, sdk ⇔ sdkSessionId)
 *  is kept by `listManagerDesks`, which cannot hand one pool's id to the other.
 *
 *  Best-effort on purpose (swallows): the UI drops its record either way, and a
 *  stop that fails because the desk is already gone must not leave the owner
 *  staring at a session they cannot close. */
const stopCommanderDesk = async (_manager: SwarmManager, projectPath: string): Promise<void> => {
  await fetch('/api/swarm/manager/stop', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: projectPath }),
  }).catch(() => {})
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
 *  It carries the WHOLE runtime identity and not merely an id because the
 *  record being overlaid may be a legacy/dead one from the other pool (a
 *  heartbeat-only PTY-era record). Overlaying only the terminalId once left
 *  the tile rendering the old, dead PTY — Restart button and all — for a whole
 *  poll interval after an SDK worker had already come up in that worktree; a
 *  second click there spawns a twin into a worktree that is being written to. */
interface PendingRestart {
  /** SDK-only (2026-08-13): a successful worker spawn is ALWAYS an SDK session
   *  now — a spawn that cannot establish one throws server-side — so a pending
   *  restart can only ever record an SDK identity. */
  runtime: 'sdk'
  sdkSessionId: string
}

const saveManager = (projectId: string, manager: SwarmManager | null) => {
  try {
    if (manager) localStorage.setItem(managerKey(projectId), JSON.stringify(manager))
    else localStorage.removeItem(managerKey(projectId))
  } catch {
    /* quota / disabled storage — the in-memory state is still authoritative */
  }
}

// The three faces of the main area, switched by the tab row: the supply
// conversation desk (the president — the one seat the owner talks to), the
// commander (司令官) dashboard that drives the autonomous engine, and the worker
// tiles. (The overseer (監督) tab was removed 2026-09-23: its questions +
// needs-attention feed duplicated what the president is told — supplyNotice.ts
// keeps those while the desk is closed and tells them when it opens; the bell
// and the OS toast still carry them too. The old todo rail and Flow tab were
// removed earlier.)


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

/** The folded bar shows only running/workers/questions — it does not need the
 *  5 s cadence (each engine lap also runs the server's git preflight). */
const FOLDED_ENGINE_POLL_MS = 15_000

interface SwarmModuleProps {
  project: ProjectMeta
  /** Folded into the bottom bar's single strip: header row only, no seats. */
  collapsed?: boolean
  /** Present ⇒ the header row carries the bar's open/close toggle. */
  onToggleCollapsed?: () => void
}

export const SwarmModule = ({ project, collapsed = false, onToggleCollapsed }: SwarmModuleProps) => {
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
  // The ONE worker seat unfolded into its live transcript (by worktree), or
  // null. One at a time on purpose — see SwarmWorkerSeat.
  const [openWorktree, setOpenWorktree] = useState<string | null>(null)
  // sdkSessionId → the newest OPEN question that worker asked the owner. One
  // poll for the whole fleet (a folded seat opens no stream of its own).
  const [questionBySdk, setQuestionBySdk] = useState<ReadonlyMap<string, string>>(new Map())
  // How many questions wait on the owner, off the SAME poll — the folded bar's
  // one-glance count. null = not read yet (or a failed read): the strip then
  // says NOTHING, never "0" (an unread inbox must not look like a clear one).
  const [ownerQuestionCount, setOwnerQuestionCount] = useState<number | null>(null)
  // Long-lived streams the PAGE (the open tab's body) holds right now — the
  // bar may only use what they leave of STREAM_BUDGET (streamBudget.ts).
  const pageStreams = useStreamCount('page')
  useEffect(() => {
    let stopped = false
    const read = async () => {
      // Same courtesy as the terminal/active poll: a hidden window asks nothing.
      if (document.hidden) return
      try {
        // ?status=open — resolved history (and its expanded captures) must not
        // ride every 10 s poll (server/routes/swarm.ts, GET escalations).
        // ?lane=owner — a question the manager is still settling is not one
        // the owner is waiting on; showing it here would say it was.
        const r = await fetch(
          `/api/swarm/escalations?path=${encodeURIComponent(project.path)}&status=open&lane=owner`,
        )
        if (!r.ok || stopped) return
        const d = (await r.json()) as {
          escalations?: {
            status?: string
            sdkSessionId?: string
            question?: string
            plainQuestion?: string
            createdAt?: string
          }[]
        }
        const next = new Map<string, string>()
        const openCount = (d.escalations ?? []).filter((e) => e.status === 'open').length
        const open = (d.escalations ?? [])
          .filter((e) => e.status === 'open' && e.sdkSessionId && (e.plainQuestion || e.question))
          .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
        // Oldest first, so the newest question per worker is the one that stays.
        // The owner reads the PLAIN wording when the raiser wrote one
        // (Escalation.plainQuestion); the technical one is the fallback.
        for (const e of open) next.set(e.sdkSessionId!, (e.plainQuestion || e.question)!)
        if (!stopped) {
          setQuestionBySdk(next)
          setOwnerQuestionCount(openCount)
        }
      } catch {
        /* keep the last known state — a fetch hiccup must not flap the banner */
      }
    }
    void read()
    const timer = setInterval(() => void read(), 10_000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [project.path])

  // The single commander (司令官) CONVERSATION session + its in-flight flag,
  // owned here exactly like the supply session and passed down to
  // SwarmManagerPane (which only renders it). managerBusy = a launch/stop
  // round-trip is in flight.
  const [manager, setManager] = useState<SwarmManager | null>(() => loadManager(project.id))
  const [managerBusy, setManagerBusy] = useState(false)

  // The autonomous engine's state — polled ONCE here (the shared hook) so BOTH
  // every seat reads the same snapshot. `realWorkers`
  // is the SERVER-TRUTH worker list (GET /api/swarm/workers): live PTYs + the
  // engine's own roster + heartbeat files, already unified server-side — see
  // src/lib/server/swarmWorkerRegistry.ts. This replaces the old localStorage
  // manual registry + engine merge, which missed a worker started by a direct
  // `POST /api/swarm/worker` (curl/SDK) outside both of those name-based sources.
  const {
    engine,
    realWorkers,
    available: engineAvailable,
    busy: engineBusy,
    error: engineError,
    toggleAutonomy,
    dismissAutonomyReminder,
    envIssues,
    refreshEnvPreflight,
  } = useSwarmEngine(project.path, collapsed ? FOLDED_ENGINE_POLL_MS : undefined)

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

  // One-click fix for the banner's `notAGitRepo` issue: POST /api/project/git-init
  // creates the repo AND an initial commit (--allow-empty), so workers have a
  // HEAD to branch their worktrees from — the owner never types `git init`
  // themselves (the banner copy promises exactly that). Offered ONLY for
  // notAGitRepo: gitMissing means there is no git binary to run, and
  // shellMissing is a different machine problem entirely. On success the
  // preflight is re-read with force (bypassing its 10s server cache) so the
  // banner clears now, not a poll interval later; the done note below the
  // banner says what changed. The error renders INLINE under the button — the
  // shared `error` strip is the worker/desk actions' channel.
  const envHasNotAGitRepo = envIssues.some((i) => i.id === 'notAGitRepo')
  const [gitInitBusy, setGitInitBusy] = useState(false)
  const [gitInitDone, setGitInitDone] = useState(false)
  const [gitInitError, setGitInitError] = useState<string | null>(null)
  const runGitInit = useCallback(async () => {
    if (gitInitBusy) return
    setGitInitBusy(true)
    setGitInitError(null)
    try {
      const res = await api.api.project['git-init'].$post({ json: { path: project.path } })
      // 409 = already a repo (raced a by-hand `git init` / another window): the
      // goal state is reached, so fall through to the refetch — which is what
      // clears the banner — instead of showing a failure for a solved problem.
      if (!res.ok && res.status !== 409) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        setGitInitError(
          body?.error
            ? `${t('projectPanel.swarm.preflight.gitInitError')} (${body.error})`
            : t('projectPanel.swarm.preflight.gitInitError'),
        )
        return
      }
      await refreshEnvPreflight()
      setGitInitDone(true)
    } catch {
      setGitInitError(t('projectPanel.swarm.preflight.gitInitError'))
    } finally {
      setGitInitBusy(false)
    }
  }, [gitInitBusy, project.path, refreshEnvPreflight, t])

  // PTY ids ever seen alive by the active poll. If an id was seen and then drops
  // out of the poll, the PTY died — used by statusOf so a missed SSE 'exit'
  // doesn't leave a dead worker stuck on 'starting'. A ref (not state) because it
  // only refines the render that statusByPty already triggers.
  const seenRef = useRef<Set<string>>(new Set())

  // Reset per-project view state when the panel is reused for another project
  // (ProjectPanel keeps one SwarmModule instance across project switches).
  useEffect(() => {
    setManager(loadManager(project.id))
    setManagerBusy(false)
    setExitedIds(new Set())
    setRetainedByWorktree(new Map())
    setError(null)
    setBusyWorktrees(new Set())
    setPendingRestarts(new Map())
    setRemovedWorktrees(new Set())
    setOpenWorktree(null)
    setQuestionBySdk(new Map())
    setOwnerQuestionCount(null)
    setDismissedEnvIssuesKey(null)
    setGitInitBusy(false)
    setGitInitDone(false)
    setGitInitError(null)
    seenRef.current = new Set()
  }, [project.id])

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
      const s = statusByPty.get(terminalId)
      // ONE decision site, exhaustive over the beacon union — see
      // src/lib/workerBeacon.ts for why this is not three `===` checks.
      return workerBeaconStatus({
        status: s,
        seen: seenRef.current.has(terminalId),
        exited: exitedIds.has(terminalId),
      })
    },
    [exitedIds, statusByPty],
  )

  const handleExit = useCallback((terminalId: string) => {
    setExitedIds((prev) => (prev.has(terminalId) ? prev : new Set(prev).add(terminalId)))
  }, [])

  // The manager desk's ONE handle — its seat status, the liveness probe and the
  // reconcile's "confirmed dead" all key on it, so the three cannot disagree.
  // Its status is the active-desk poll's (both pools). A desk that poll saw and
  // then lost is as dead as one whose stream said so: nothing renders its
  // stream any more, and without this the record stayed, so the top bar's Start
  // (planSwarmPower's hasManager) would not relaunch it.
  const managerHandle = manager
    ? manager.runtime === 'sdk'
      ? (manager.sdkSessionId ?? '')
      : manager.terminalId
    : ''
  const managerIsSdk = manager?.runtime === 'sdk'
  const managerStatus: WorkerStatus | null = managerHandle ? statusOfPty(managerHandle) : null
  const managerDead = managerStatus === 'exited'
  const managerUnseen = managerStatus === 'starting'

  // ── COMMANDER desk reconcile (2026-08-03 — the post-restart dead-screen fix) ─
  // Every engine poll carries the LIVE desk handle (managerDesk, a both-pools
  // read). Follow it: ADOPT an engine-woken desk the stored record does not name
  // (zero-click reconnect after an app restart), CLEAR a confirmed-dead record
  // with no successor (honest launch CTA instead of the eternal
  // 「セッションが終了しました」). The decision itself is pure and guarded
  // (deskReconcile.ts — busy wins, old servers change nothing); this effect only
  // applies the verdict to state + localStorage.
  // ⚠ The SUPPLY half of this used to live here too. It now lives in
  // useSupplyDesk (it was shared with the Board's front-desk seat, deleted
  // 2026-09-24 — the hook stays the one place that reconciles the desk).
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
        storedDead: managerDead,
      },
    )
    if (mv.kind === 'adopt') {
      setManager(mv.record)
      saveManager(project.id, mv.record)
    } else if (mv.kind === 'clear') {
      setManager(null)
      saveManager(project.id, null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setters/savers are stable; keyed on the data
  }, [engine.managerDesk, manager, managerBusy, managerDead, project.id])

  // COMMANDER liveness probe. The manager's seat no longer renders the desk's
  // stream or terminal (owner decision 2026-09-23 — the owner talks only to the
  // president), and that stream used to be what noticed a desk that died before
  // the active poll ever saw it — a stored record whose desk died while the app
  // was closed, or a desk that refused on arrival (swarmManager.ts
  // watchSdkDeskForDeathOnArrival). Unseen, it reads 'starting' — 「動いている」 —
  // forever. So while the desk is still unseen, ask it directly (every 5 s, like
  // the poll); a "gone" answer feeds the SAME exit bookkeeping the stream fed,
  // so the reconcile above clears the record. Only an answer that SAYS gone
  // counts — a 5xx (the dev proxy while the server restarts) says nothing.
  useEffect(() => {
    if (!managerHandle || !managerUnseen) return
    let cancelled = false
    const url = managerIsSdk
      ? `/api/sdk-session/${encodeURIComponent(managerHandle)}?path=${encodeURIComponent(project.path)}`
      : `/api/terminal/${encodeURIComponent(managerHandle)}`
    const probe = () => {
      if (document.hidden) return
      fetch(url)
        .then(async (r) => {
          const gone = r.status === 404 || r.status === 403
          const body = r.ok ? ((await r.json().catch(() => null)) as SdkSessionProbe) : null
          const reaped = managerIsSdk && r.ok && blipVerdict(true, body).close
          if (!cancelled && (gone || reaped)) handleExit(managerHandle)
        })
        .catch(() => {
          /* server unreachable — the next probe / poll decides */
        })
    }
    probe()
    const timer = window.setInterval(probe, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [managerHandle, managerIsSdk, managerUnseen, project.path, handleExit])

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
      // (The fellBackBecause banner that lived here died 2026-08-13 with the
      // runtime auto-fallback: a desk can no longer come up on a different
      // runtime than the dial chose — an SDK failure now fails the POST and
      // lands in the catch below with the server's reason.)
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
  // ── The supply desk (補給官 / タスク窓口) ──────────────────────────────────
  // State + launch/stop/restart live in useSupplyDesk (the one reconcile of
  // the stored record openground.swarm.supply.<projectId> against the server
  // handle). The president's seat exists in exactly ONE place — this bar; the
  // Board's drawer copy was deleted 2026-09-24.
  // Names are destructured back to the historical ones so every reference below
  // — the pane, the CTA, the autopilot plan — reads exactly as it did.
  // `enabled` is unconditionally true here: this component only mounts inside
  // SwarmBottomBar, behind ProjectPanel's `isSwarmVisible(moduleGate)` — the
  // same predicate the Board receives as `swarmVisible`.
  const {
    supply,
    busy: supplyBusy,
    error: supplyError,
    launch: launchSupply,
    stop: stopSupply,
    restart: restartSupply,
  } = useSupplyDesk({
    projectId: project.id,
    projectPath: project.path,
    supplyDesk: engine.supplyDesk,
    exitedIds,
    forgetPty,
    enabled: true,
  })

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
      // (fellBackBecause banner deleted 2026-08-13 with the auto-fallback — a
      // failed SDK seat now fails the POST and lands in the catch below.)
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
        // SDK-only (2026-08-13): a successful spawn is ALWAYS an SDK session —
        // a spawn that cannot establish one THROWS (the catch below shows the
        // reason), so the old PTY arm and the fell-back banner are gone. The
        // no-address guard stays: `runtime:'sdk'` with no sdkSessionId records
        // NOTHING and lets the ≤5s poll bring server truth (a tile that lags is
        // recoverable, a tile that lies is not).
        const fresh: PendingRestart | null =
          spawn.runtime === 'sdk' && spawn.sdkSessionId
            ? { runtime: 'sdk', sdkSessionId: spawn.sdkSessionId }
            : null
        if (fresh) setPendingRestarts((prev) => new Map(prev).set(worker.worktree, fresh))
        forgetPty(old, spawn.terminalId)
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
      // Replace the WHOLE runtime identity, never just an id field: overlaying
      // half of it once left a restart rendering the old, DEAD tile (with its
      // Restart button live) until the next poll — one more click there and a
      // twin claude is running in a worktree the fresh worker is already
      // writing to. Both id fields are rewritten together so the record can
      // never carry one from each pool. (The fresh worker is always an SDK
      // session — the PTY arm died with the PTY worker runtime, 2026-08-13.)
      return { ...w, runtime: 'sdk' as const, sdkSessionId: pending.sdkSessionId, terminalId: undefined }
    })

  // OFF / first-run: the swarm is FULLY idle — the engine isn't running and no
  // supply / commander / worker session exists. In that state we replace the tab
  // surface with the central onboarding (条件1/5) so a first-time owner sees the
  // three roles + the work-flow + what Start does BEFORE pressing it. The header
  // row stays above it (its Start, and the onboarding's, run the SAME powerSwarm
  // composition). The moment anything comes up, the seats return.
  // (Open questions and fatal alerts used to keep the seats up so the overseer
  // tab could show them. That tab is gone (2026-09-23): Start opens the
  // president's desk, which is then told every open question and every notice
  // held while it was closed — supplyNotice.catchUpSupplyDesks.)
  const swarmIdle = !engine.running && !supply && !manager && allWorkers.length === 0
  // ── Connection budget (streamBudget.ts) ──────────────────────────────────
  // HTTP/1.1 gives this origin six connections; every live stream holds one.
  // The PAGE (the open tab) always wins — the bar streams only in what it
  // leaves of STREAM_BUDGET, in priority order: the president, then the one
  // unfolded worker, then any legacy PTY worker. A seat that gets no slot shows
  // its summary instead, and one line above the seats says why. Folded, the
  // bar mounts no seat at all.
  let barSlots = collapsed ? 0 : Math.max(0, STREAM_BUDGET - pageStreams)
  const takeSlot = (): boolean => {
    if (barSlots <= 0) return false
    barSlots -= 1
    return true
  }
  const supplyStreams = !!supply && takeSlot()
  let streamLimited = !!supply && !supplyStreams
  // May a folded worker be unfolded right now? (One slot left after the desk.)
  const workerSlotFree = barSlots > 0
  const streamingWorktrees = new Set<string>()
  for (const w of allWorkers) {
    // Only a seat that will actually OPEN a stream spends a slot: an SDK
    // worker with a session id that is the unfolded one, or a PTY worker that
    // has a terminal to attach to. (An id-less seat renders its summary.)
    const wantsStream =
      w.runtime === 'sdk' ? !!w.sdkSessionId && openWorktree === w.worktree : !!w.terminalId
    if (!wantsStream) continue
    if (takeSlot()) streamingWorktrees.add(w.worktree)
    else streamLimited = true
  }

  // Notices that live INSIDE the bar (below the header). Folded, they are not
  // drawn, so the strip carries one dot saying "there is something to read".
  const foldedNotice =
    showEnvBanner ||
    engine.consumption.overLimit ||
    (engine.autonomyRemembered && !engine.running)

  return (
    // Right-pane-centric layout (条件4): the old left "to-do rail + dispatch"
    // panel was removed — browsing todos now lives on the Board tab (一本化), and
    // workers are started by the autonomous engine (the master power switch on
    // the header row) or the commander session, NOT by a per-card hand "dispatch"
    // here (条件1/2/3). This wrapper is a vertical stack: ONE header row (name ·
    // counts · master switch) + an error banner + the
    // full-height row of seats below.
    <div className={collapsed ? 'flex min-w-0 shrink-0 flex-col' : 'flex min-h-0 min-w-0 flex-1 flex-col'}>
      {/* ── The ONE header row ──────────────────────────────────────────────
          The team's name, questions waiting on the owner, and the master on/off
          switch (条件1 — ON starts the engine + launches commander & supply,
          idempotent; OFF halts new dispatch only). Owner 2026-09-24: the
          monitoring switch, the execution-mode menu, the "running · N workers"
          pill and the "resumed after restart" chip are GONE from here — the
          owner asks the president in words instead (skills/supply/SKILL.md),
          and the usable-models mask moved to Settings.
          The WHOLE row opens / folds the bar (owner: "make the whole bar
          clickable"). A click that lands on a control inside it (the switch)
          stays that control's; the keyboard path is the named toggle button. */}
      <div
        onClick={
          onToggleCollapsed
            ? (e) => {
                if ((e.target as Element).closest('button, a, input, select, textarea, [role="menu"]')) return
                // A double-click is one intent, not open-then-fold; a drag that
                // selected text is reading, not toggling.
                if (e.detail > 1 || window.getSelection()?.toString()) return
                onToggleCollapsed()
              }
            : undefined
        }
        className={[
          // With the toggle, its own px-1.5 supplies the rest of the inset,
          // so the label lines up with the seats below (no negative margin).
          'flex min-h-[38px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 bg-bg py-1 pr-2',
          onToggleCollapsed
            ? 'cursor-pointer pl-1.5 transition-colors duration-150 hover:bg-plane active:bg-line-soft has-[[role=switch]:hover]:bg-bg has-[[role=switch]:active]:bg-bg'
            : 'pl-3',
          collapsed ? '' : 'border-b border-line',
        ].join(' ')}
      >
        {onToggleCollapsed && (
          // The bar's open/close toggle — the keyboard / screen-reader handle of
          // the row-wide click target, carrying the team's name.
          <button
            type="button"
            data-testid="swarm-bar-toggle"
            // Same one-intent rule as the row: a double-click opens OR folds, not
            // both. (Keyboard activation reports detail 0, so it always passes.)
            onClick={(e) => {
              if (e.detail > 1) return
              onToggleCollapsed()
            }}
            aria-expanded={!collapsed}
            aria-label={t(collapsed ? 'projectPanel.swarm.bar.expand' : 'projectPanel.swarm.bar.collapse')}
            title={t(collapsed ? 'projectPanel.swarm.bar.expand' : 'projectPanel.swarm.bar.collapse')}
            className={[
              'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[4px] px-1.5 text-ui font-medium text-ink',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
            ].join(' ')}
          >
            {collapsed ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
            <Network size={12} strokeWidth={2.25} aria-hidden />
            {t('projectPanel.swarm.power.label')}
          </button>
        )}
        {/* Something to read inside the folded bar (a banner below the header). */}
        {collapsed && foldedNotice && (
          <span
            role="status"
            title={t('projectPanel.swarm.bar.attention')}
            aria-label={t('projectPanel.swarm.bar.attention')}
            className="h-[7px] w-[7px] shrink-0 rounded-full bg-accent"
          />
        )}
        {/* Questions waiting on the owner — said only when there ARE some and
            the inbox was actually read (ownerQuestionCount's contract). */}
        {ownerQuestionCount ? (
          <span
            title={t('projectPanel.swarm.bar.questionsHint')}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-ochre-soft px-2 py-0.5 text-meta text-ink"
          >
            <span className="h-[6px] w-[6px] shrink-0 rounded-full bg-ochre" aria-hidden />
            {t('projectPanel.swarm.bar.questions', { count: ownerQuestionCount })}
          </span>
        ) : null}
        {engineAvailable && engine.reviews.length > 0 ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-plane px-2 py-0.5 text-meta text-ink">
            {t('projectPanel.swarm.bar.reviews', { count: engine.reviews.length })}
          </span>
        ) : null}
        <div className="min-w-0 flex-1" aria-hidden />
        <SwarmPowerSwitch
          running={engine.running}
          available={engineAvailable}
          busy={engineBusy}
          onToggle={(next) => {
            // First run from the FOLDED strip: open the bar onto the
            // onboarding (what Start does, before it does it) instead of
            // starting blind. Its own Start then runs the same powerSwarm.
            if (next && collapsed && onToggleCollapsed && swarmIdle && !onboardingSeen) {
              onToggleCollapsed()
              return
            }
            powerSwarm(next)
          }}
        />
      </div>
      {/* Env preflight (git/shell) — ONE banner listing every unmet prerequisite
          (GET /api/swarm/preflight, the same gate the worker/supply/manager spawn
          routes enforce), so a missing git / non-repo project / missing shell is
          visible up front instead of only surfacing as a failed-launch error. */}
      {!collapsed && showEnvBanner && (
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
            {/* One-click fix for notAGitRepo (and ONLY that issue — see
                runGitInit above): sets up git + an initial commit server-side,
                then force-refetches the preflight so the banner clears now.
                Its failure renders inline right here, tied to the button that
                caused it, not in the shared action-error strip below. */}
            {envHasNotAGitRepo && (
              <div className="mt-1.5">
                <button
                  type="button"
                  onClick={() => void runGitInit()}
                  disabled={gitInitBusy}
                  className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-accent bg-accent px-2.5 py-1 text-meta font-medium text-bg-card transition-all duration-150 enabled:hover:border-accent-hover enabled:hover:bg-accent-hover enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {t('projectPanel.swarm.preflight.gitInit')}
                </button>
                {gitInitError && (
                  <p className="mt-1 text-meta leading-relaxed text-accent">{gitInitError}</p>
                )}
              </div>
            )}
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

      {/* One-click git set-up landed (runGitInit): the env banner above is gone
          precisely BECAUSE it worked, so without this line success would look
          like the banner silently vanishing. Gated on the issue really being
          gone — while `notAGitRepo` is still listed (another window un-did it,
          a slow refetch), claiming "workers can run" would be a lie. Dismissed
          locally (a notice, not a decision), same as the restored notice below. */}
      {gitInitDone && !envHasNotAGitRepo && (
        <div className="flex shrink-0 items-center gap-3 border-b border-line-soft bg-bg px-3 py-2">
          <span className="min-w-0 flex-1 text-meta leading-relaxed text-ink-muted">
            {t('projectPanel.swarm.preflight.gitInitDone')}
          </span>
          <button
            type="button"
            onClick={() => setGitInitDone(false)}
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
      {/* An engine action's failure (power, Monitoring) joins it once the
          seats are up — the idle views below print their own. */}
      <SwarmErrorBanner
        error={error ?? (swarmIdle && !collapsed ? null : engineError)}
        supplyError={supplyError}
      />
      {/* The unattended loop passed its dispatch budget (DISPATCH_BUDGET — a
          soft nudge, the engine keeps going). It used to sit in the manager's
          dashboard; it is about spend, so the owner still hears it here. */}
      {!collapsed && (<>
      {engine.consumption.overLimit && (
        <p
          role="status"
          className="shrink-0 border-b border-line-soft bg-bg px-3 py-2 text-meta leading-relaxed text-ochre-deep"
        >
          {t('projectPanel.swarm.overLimit', {
            dispatched: engine.consumption.dispatched,
            limit: engine.consumption.limit,
          })}
        </p>
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

      {/* ── Seats: president · manager · workers, side by side ───────────── */}
      {/* OFF / first-run → the central onboarding (条件1/5): the three roles, the
          work-flow, and what Start does, shown BEFORE pressing it. Its Start fires
          the SAME powerSwarm composition as the bar above. Otherwise → the normal
          row of seats. */}
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
      ) : (
      // ONE screen (2026-09-23, owner): every seat side by side — 社長, the
      // manager, then one seat per worker — in a single row that scrolls
      // horizontally once the seats outgrow the width (never squeezes a seat
      // below SEAT_STYLE's minimum). No sub-tabs, no reordering: who is doing
      // what is readable at a glance, each seat's nameplate tinted by role.
      // min-w-0 is load-bearing: without it this flex item would grow to the
      // row's intrinsic width and push the seats off-screen.
      <>
      {streamLimited && (
        <div role="status" className="shrink-0 border-b border-line-soft bg-bg px-3 py-1.5 text-meta text-ink-muted">
          {t('projectPanel.swarm.bar.streamLimit')}
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 gap-px overflow-x-auto overflow-y-auto bg-line-strong">
        <div className={SEAT_CLASS} style={SEAT_STYLE}>
          {supply && !supplyStreams ? (
            // The desk is up but the connection budget is spent: its
            // nameplate and why, instead of a stream that would starve fetches.
            <div className="flex h-full min-h-0 flex-col bg-bg" data-seat="supply-summary">
              <SwarmSeatHeader
                role="supply"
                sprite={null}
                statusLabel={t('projectPanel.swarm.statusWorking')}
              />
              <div className="flex flex-1 items-center justify-center px-6 text-center">
                <p className="max-w-xs text-ui leading-relaxed text-ink-subtle">
                  {t('projectPanel.swarm.bar.streamLimit')}
                </p>
              </div>
            </div>
          ) : supply ? (
            // The live president's desk — the owner's one conversation.
          <SwarmSupplyPane
            terminalId={supply.terminalId}
            status={statusOfPty(supply.terminalId)}
            busy={supplyBusy}
            onExit={() => supply && handleExit(supply.terminalId)}
            onStop={() => void stopSupply()}
            onRestart={() => void restartSupply()}
          />
          ) : (
            <div className="flex h-full min-h-0 flex-col bg-bg">
              <SwarmSeatHeader role="supply" sprite={null} statusLabel={t('projectPanel.swarm.power.stopped')} />
              <div className="flex flex-1 items-center justify-center px-6 text-center">
                <div className="max-w-xs">
                  <p className="mb-4 text-ui leading-relaxed text-ink-subtle">
                    {t('projectPanel.swarm.supply.empty')}
                  </p>
                  <button
                    type="button"
                    onClick={() => void launchSupply()}
                    disabled={supplyBusy}
                    className="inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-bg-card px-3 py-1.5 text-ui text-ink-muted transition-colors hover:border-accent hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
                  >
                    <Power size={13} strokeWidth={2} />
                    {supplyBusy
                      ? t('projectPanel.swarm.supply.launching')
                      : t('projectPanel.swarm.supply.launch')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
        {/* The manager's seat — nameplate + a quiet start/stop, nothing else
            (the owner talks only to the president). Its status comes from the
            active-desk poll, which sees both pools; a desk that died is cleared
            by the reconcile above. */}
        <div className={SEAT_CLASS} style={MANAGER_SEAT_STYLE} data-seat="manager">
          <SwarmManagerPane
            status={manager ? managerStatus : null}
            busy={managerBusy}
            onLaunch={() => void launchManager()}
            onStop={() => void stopManager()}
            onRestart={() => void restartManager()}
            sdkSessionId={managerIsSdk ? manager?.sdkSessionId : undefined}
            projectPath={project.path}
          />
        </div>
        {allWorkers.length === 0 ? (
          // A vacant worker seat, so all three roles are always on the screen.
          <div className={SEAT_CLASS} style={SEAT_STYLE}>
            <div className="flex h-full min-h-0 flex-col bg-bg">
              <SwarmSeatHeader role="worker" sprite={null} statusLabel={t('projectPanel.swarm.seat.vacant')} />
              <div className="flex flex-1 items-center justify-center px-6 text-center">
                <p className="max-w-xs text-ui leading-relaxed text-ink-subtle">
                  {t('projectPanel.swarm.workersEmpty')}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <>
            {allWorkers.map((w) => {
              // Engine-tracked workers (stage present — see swarmWorkerRegistry.ts)
              // are read-only here (the orchestrator owns their lifecycle); every
              // other worker — engine-dispatch-independent: curl-direct or a UI
              // restart — is terminable/restartable, matching the old
              // 'manual'/'engine' distinction but keyed off server truth now.
              const isEngine = w.stage !== undefined
              const sdkId = w.runtime === 'sdk' ? w.sdkSessionId : undefined
              // Folded unless the stream plan above gave this seat a slot — THE
              // one unfolded SDK seat (see SwarmWorkerSeat for why at most one
              // transcript streams at a time) or a legacy PTY worker, budget
              // permitting. A seat with NO handle (a dead worker known only
              // from its heartbeat) opens no stream either way and keeps its
              // full tile, with Restart.
              const handle = sdkId ?? w.terminalId
              if (handle && !streamingWorktrees.has(w.worktree)) {
                return (
                  <div key={w.worktree} className={SEAT_CLASS} style={WORKER_SEAT_STYLE}>
                    <SwarmWorkerSeat
                      sdkSessionId={sdkId}
                      projectPath={project.path}
                      branch={w.branch}
                      taskTitle={w.taskTitle ?? w.note ?? ''}
                      status={statusOfPty(handle)}
                      question={sdkId ? (questionBySdk.get(sdkId) ?? null) : null}
                      busy={!isEngine ? busyWorktrees.has(w.worktree) : false}
                      retainedReason={!isEngine ? retainedByWorktree.get(w.worktree) : undefined}
                      onOpenLog={sdkId && workerSlotFree ? () => setOpenWorktree(w.worktree) : undefined}
                      openLogDisabledReason={t('projectPanel.swarm.bar.streamLimit')}
                      onTerminate={!isEngine ? () => void terminate(w) : undefined}
                      onForceRemove={!isEngine ? () => void terminate(w, { force: true }) : undefined}
                      onRestart={!isEngine ? () => void restartWorker(w) : undefined}
                    />
                  </div>
                )
              }
              return (
                <div key={w.worktree} className={SEAT_CLASS} style={SEAT_STYLE}>
                  {sdkId ? (
                    // An SDK worker has no terminal to render — its tile shows
                    // the distilled event stream instead. Same header vocabulary,
                    // so a mixed fleet still reads as one fleet.
                    <SdkWorkerPane
                      sdkSessionId={sdkId}
                      onCollapse={() => setOpenWorktree(null)}
                      // The fleet poll above already knows this seat's question —
                      // hand it down so the unfolded pane does not poll again.
                      question={questionBySdk.get(sdkId) ?? null}
                      questionHint={t('projectPanel.swarm.seat.questionHint')}
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
          </>
        )}
      </div>
      </>
      )}
      </>)}
    </div>
  )
}
