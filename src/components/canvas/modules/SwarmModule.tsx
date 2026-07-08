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
// LOOP: the auto-drain / dispatch / auto-merge / scheduled column movement all
// run in the server-side engine — the switch just starts/stops it via
// toggleAutonomy. Auto-integrate stays a separate switch on the commander
// dashboard (default off). The only column move owned here is a terminate's
// doing→todo requeue (its todo→doing counterpart left with the removed
// manual-dispatch rail).
//
// SUBSCRIPTION-ONLY: every role PTY is spawned through the /api/swarm/* routes
// (worker restart → POST /api/swarm/worker, supply / commander → their own
// routes), each launching an interactive `claude` PTY — never `claude -p` / the
// SDK. This module never spawns claude itself.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Network, Inbox, Boxes, Gauge, Workflow, X, Power } from 'lucide-react'
import { api } from '@/lib/api-client'
import { columnOf } from '@/components/canvas/BoardTab'
import { useT } from '@/i18n/I18nContext'
import type {
  ActiveTerminalsResponse,
  BoardColumn,
  ClaudeBeaconStatus,
  ProjectData,
  ProjectMeta,
  RemoveSwarmWorktreeResponse,
  SpawnSwarmManagerResponse,
  SpawnSwarmSupplyResponse,
  SpawnSwarmWorkerResponse,
  SwarmWorkerRecord,
} from '@/lib/types'
import { SwarmWorkerPane, type WorkerStatus } from './SwarmWorkerPane'
import { SwarmSupplyPane } from './SwarmSupplyPane'
import { SwarmManagerPane } from './SwarmManagerPane'
import { SwarmFlowPane } from './SwarmFlowPane'
import { SwarmEscalationsPane } from './SwarmEscalationsPane'
import { SwarmPowerBar } from './SwarmPowerBar'
import { ExecutionModeToggle } from './ExecutionModeToggle'
import { SwarmOnboarding } from './SwarmOnboarding'
import { useSwarmEngine, planSwarmPower } from './useSwarmEngine'

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
  terminalId: string
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
    return {
      terminalId: String(r.terminalId),
      agentSessionId: typeof r.agentSessionId === 'string' ? r.agentSessionId : '',
      startedAt: typeof r.startedAt === 'string' ? r.startedAt : '',
    }
  } catch {
    return null
  }
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
// conversation desk, the commander (司令官) dashboard that drives the autonomous
// engine, and the worker tiles. (The old todo rail was removed — todos live on
// the Board tab now, and workers start from the engine or the commander, not a
// per-card hand dispatch here.)
type MainView = 'supply' | 'manager' | 'workers' | 'flow'

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
  const [pendingRestarts, setPendingRestarts] = useState<ReadonlyMap<string, string>>(new Map())
  // worktrees whose CONFIRMED removal (terminate) we've already acted on — hides
  // the tile immediately instead of waiting for the next poll. Cleared once the
  // poll agrees the worktree is really gone.
  const [removedWorktrees, setRemovedWorktrees] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // The single supply (補給官) session + which face of the main area is shown.
  // Supply is the conversational entry point, so the main area opens on it.
  // supplyBusy = a launch/stop round-trip is in flight.
  const [supply, setSupply] = useState<SwarmSupply | null>(() => loadSupply(project.id))
  const [mainView, setMainView] = useState<MainView>('supply')
  const [supplyBusy, setSupplyBusy] = useState(false)

  // The single commander (司令官) CONVERSATION session + its in-flight flag,
  // owned here exactly like the supply session and passed down to
  // SwarmManagerPane (which only renders it). managerBusy = a launch/stop
  // round-trip is in flight.
  const [manager, setManager] = useState<SwarmManager | null>(() => loadManager(project.id))
  const [managerBusy, setManagerBusy] = useState(false)

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
    realWorkers,
    available: engineAvailable,
    busy: engineBusy,
    error: engineError,
    toggleAutonomy,
    dismissAutonomyReminder,
    toggleAutoMerge,
    toggleOverseer,
    sandboxWarning: engineSandboxWarning,
  } = useSwarmEngine(project.path)

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
    setMainView('supply')
    setSupplyBusy(false)
    setExitedIds(new Set())
    setRetainedByWorktree(new Map())
    setError(null)
    setBusyWorktrees(new Set())
    setPendingRestarts(new Map())
    setRemovedWorktrees(new Set())
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
      for (const [worktree, pendingId] of Array.from(prev)) {
        if (byWorktree.get(worktree)?.terminalId === pendingId) {
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
        // Kill the PTY first (best-effort — it may already be gone, or this
        // worker may already have none: a heartbeat-only dead worker).
        if (worker.terminalId) {
          await api.api.terminal[':id']
            .$delete({ param: { id: worker.terminalId } })
            .catch(() => {})
        }

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
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body?.error || `HTTP ${res.status}`)
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
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const spawn = (await res.json()) as SpawnSwarmManagerResponse
      const next: SwarmManager = {
        terminalId: spawn.terminalId,
        agentSessionId: spawn.agentSessionId,
        startedAt: new Date().toISOString(),
      }
      setManager(next)
      saveManager(project.id, next)
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
      await api.api.terminal[':id'].$delete({ param: { id: term } }).catch(() => {})
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
  }, [manager, managerBusy, project.id])

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
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body?.error || `HTTP ${res.status}`)
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
      // Best-effort kill the old PTY first (see restartSupply) so a transient
      // probe false positive can't orphan a still-running commander.
      if (old) await api.api.terminal[':id'].$delete({ param: { id: old } }).catch(() => {})
      const res = await fetch('/api/swarm/manager', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: project.path }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body?.error || `HTTP ${res.status}`)
      }
      const spawn = (await res.json()) as SpawnSwarmManagerResponse
      const next: SwarmManager = {
        terminalId: spawn.terminalId,
        agentSessionId: spawn.agentSessionId,
        startedAt: new Date().toISOString(),
      }
      setManager(next)
      saveManager(project.id, next)
      forgetPty(old, next.terminalId)
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
  // and re-runs its /order goal. We optimistically record the fresh terminalId
  // (pendingRestarts) so the tile re-mounts before the next poll, and clear the
  // dead id's bookkeeping. Manual (non-engine-owned) workers only — an engine
  // worker's lifecycle is the orchestrator's (read-only here).
  const restartWorker = useCallback(
    async (worker: SwarmWorkerRecord) => {
      if (busyWorktrees.has(worker.worktree)) return
      const old = worker.terminalId
      setBusyWorktrees((prev) => new Set(prev).add(worker.worktree))
      setError(null)
      try {
        // Best-effort kill the old PTY first (see restartSupply). The worktree is
        // reused (passed below), so only the dead/stale PTY is cleared — a transient
        // probe false positive can't race a second claude in the same tree.
        if (old) await api.api.terminal[':id'].$delete({ param: { id: old } }).catch(() => {})
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
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        const spawn = (await res.json()) as SpawnSwarmWorkerResponse
        setPendingRestarts((prev) => new Map(prev).set(worker.worktree, spawn.terminalId))
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
  // server engine's twin-dispatch / blocked / same-file gates are untouched, and
  // Auto-integrate stays a SEPARATE switch on the commander dashboard (default off).
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
      const pendingId = pendingRestarts.get(w.worktree)
      return pendingId && pendingId !== w.terminalId ? { ...w, terminalId: pendingId } : w
    })

  // OFF / first-run: the swarm is FULLY idle — the engine isn't running and no
  // supply / commander / worker session exists. In that state we replace the tab
  // surface with the central onboarding (条件1/5) so a first-time owner sees the
  // three roles + the work-flow + what Start does BEFORE pressing it. The master
  // power bar stays above it (its Start, and the onboarding's, run the SAME
  // powerSwarm composition). The moment anything comes up, the normal tabs return.
  const swarmIdle = !engine.running && !supply && !manager && allWorkers.length === 0

  return (
    // Right-pane-centric layout (条件4): the old left "to-do rail + dispatch"
    // panel was removed — browsing todos now lives on the Board tab (一本化), and
    // workers are started by the autonomous engine (the master power switch above)
    // or the commander session, NOT by a per-card hand "dispatch" here (条件1/2/3).
    // This wrapper is now a vertical stack: the power bar + an error banner +
    // the full-height tab surface below them.
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* The SINGLE master power switch (条件1) — start/stop the whole swarm from
          one control, visible above every sub-view. ON starts the engine +
          launches commander & supply (idempotent); OFF halts new dispatch only.
          Its status spells out running/stopped + the live worker count (条件4). */}
      <SwarmPowerBar
        running={engine.running}
        manualStop={engine.manualStop}
        available={engineAvailable}
        busy={engineBusy}
        workerCount={allWorkers.length}
        onToggle={powerSwarm}
      />
      {/* Token budget (card 68d8e00f): one switch sets the model/effort/parallelism every
          swarm launch (worker / supply / commander) uses — max / economy / optimize. */}
      <ExecutionModeToggle />
      {/* A transient action error (worker terminate / restart, supply・commander
          launch). The old to-do rail hosted this; with the rail gone it banners
          across the top of the pane so a failure is never lost. */}
      {error && (
        <p className="shrink-0 border-b border-line-soft bg-bg px-3 py-2 text-[11px] leading-relaxed text-accent">
          {error}
        </p>
      )}

      {/* Restart reminder (autonomyRemembered) — the engine is in-memory and always
          relaunches OFF; if the owner had autonomy ON last session, offer a one-click
          resume (never auto-resumed). Dismiss clears the persisted marker (toggleAutonomy
          false → forgetSwarmAutonomy). Shown only while !running && autonomyRemembered. */}
      {engine.autonomyRemembered && !engine.running && (
        <div className="flex shrink-0 items-center gap-3 border-b border-line-soft bg-bg px-3 py-2">
          <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-ink-muted">
            {t('projectPanel.swarm.autonomyReminder')}
          </span>
          <button
            type="button"
            onClick={() => toggleAutonomy(true)}
            disabled={engineBusy || !engineAvailable}
            className="inline-flex shrink-0 items-center gap-1 rounded-[4px] border border-accent bg-accent px-2.5 py-1 text-[11px] font-medium text-bg-card transition-all duration-150 enabled:hover:border-accent-hover enabled:hover:bg-accent-hover enabled:active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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

      {/* ── Escalations inbox (C1): the swarm's questions awaiting THE OWNER. ──
          Rendered ABOVE the tab surface so an open question stays visible no
          matter which view is active — and even in the pre-start onboarding
          state (a leftover question from the last run must not hide). The pane
          renders null while the inbox is empty, so this costs nothing in the
          common case. Fail-closed lives server-side; visibility lives here. */}
      <SwarmEscalationsPane projectPath={project.path} />

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
      {swarmIdle ? (
        <SwarmOnboarding
          onStart={() => powerSwarm(true)}
          busy={engineBusy}
          available={engineAvailable}
          error={engineError}
        />
      ) : (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Toggle: supply (補給官) ⇆ commander (司令官) ⇆ workers. Underline tabs,
            the same vocabulary as the project tab row, on a PAPER strip (bg-bg)
            regardless of the content below so the ink tokens always have contrast. */}
        <div
          role="tablist"
          aria-label={t('projectPanel.swarm.title')}
          className="flex shrink-0 items-center gap-4 border-b border-line-soft bg-bg px-3"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mainView === 'supply'}
            onClick={() => setMainView('supply')}
            className={[
              '-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 label-cap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
              mainView === 'supply'
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-muted hover:text-accent',
            ].join(' ')}
          >
            <Inbox size={12} strokeWidth={2} />
            {t('projectPanel.swarm.supply.tab')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainView === 'manager'}
            onClick={() => setMainView('manager')}
            className={[
              '-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 label-cap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
              mainView === 'manager'
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-muted hover:text-accent',
            ].join(' ')}
          >
            <Gauge size={12} strokeWidth={2} />
            {t('projectPanel.swarm.manager.tab')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainView === 'workers'}
            onClick={() => setMainView('workers')}
            className={[
              '-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 label-cap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
              mainView === 'workers'
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-muted hover:text-accent',
            ].join(' ')}
          >
            <Boxes size={12} strokeWidth={2} />
            {t('projectPanel.swarm.workersTab')}
            {allWorkers.length > 0 && (
              <span className="rounded-full border border-line px-1.5 text-[9px] font-medium leading-[14px] text-ink-faint">
                {allWorkers.length}
              </span>
            )}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mainView === 'flow'}
            onClick={() => setMainView('flow')}
            className={[
              '-mb-px flex items-center gap-1.5 border-b-2 px-1 py-2 label-cap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2',
              mainView === 'flow'
                ? 'border-accent text-accent'
                : 'border-transparent text-ink-muted hover:text-accent',
            ].join(' ')}
          >
            <Workflow size={12} strokeWidth={2} />
            {t('projectPanel.swarm.flow.tab')}
          </button>
        </div>

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
                <h2 className="mb-2 text-[15px] font-medium text-ink">
                  {t('projectPanel.swarm.supply.title')}
                </h2>
                <p className="mb-4 text-[12px] leading-relaxed text-ink-subtle">
                  {t('projectPanel.swarm.supply.empty')}
                </p>
                <button
                  type="button"
                  onClick={() => void launchSupply()}
                  disabled={supplyBusy}
                  className="inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-bg-card px-3 py-1.5 text-[12px] text-ink-muted transition-colors hover:border-accent hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
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
          // controls (Autonomy / Auto-integrate). Its engine state comes from the
          // shared useSwarmEngine hook above — no own fetch. Live worker screens
          // live on the worker tab; the Board pipeline tallies on the Board tab.
          <div className="min-h-0 flex-1">
            <SwarmManagerPane
              session={
                manager ? { terminalId: manager.terminalId, status: statusOfPty(manager.terminalId) } : null
              }
              sessionBusy={managerBusy}
              onLaunchSession={() => void launchManager()}
              onStopSession={() => void stopManager()}
              onSessionExit={() => manager && handleExit(manager.terminalId)}
              onRestartSession={() => void restartManager()}
              engine={engine}
              available={engineAvailable}
              busy={engineBusy}
              error={engineError}
              onToggleAutoMerge={toggleAutoMerge}
              onToggleOverseer={toggleOverseer}
              sandboxWarning={engineSandboxWarning}
            />
          </div>
        ) : mainView === 'flow' ? (
          // Flow: the live, read-only visualization of the autonomous loop
          // (drain → dispatch → monitor → integrate) — each worker's stage +
          // heartbeat, the integration queue, the event feed, and fatal events.
          // Reads the SAME engine snapshot (no own fetch); purely presentational.
          <SwarmFlowPane engine={engine} fatalNotifications={fatalNotifications} available={engineAvailable} />
        ) : allWorkers.length === 0 ? (
          <div className="flex flex-1 items-center justify-center bg-bg px-8 text-center">
            <div className="max-w-sm">
              <div className="mx-auto mb-4 inline-flex h-11 w-11 items-center justify-center rounded-[3px] border border-line bg-bg-inset text-ink-muted">
                <Network size={20} strokeWidth={1.75} />
              </div>
              <p className="label-cap mb-2 text-ink-faint">{t('projectPanel.swarm.badge')}</p>
              <h2 className="mb-2 text-[15px] font-medium text-ink">
                {t('projectPanel.swarm.title')}
              </h2>
              <p className="text-[12px] leading-relaxed text-ink-subtle">
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
