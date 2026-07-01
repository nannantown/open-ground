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
import { Network, Inbox, Boxes, Gauge, Workflow } from 'lucide-react'
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
} from '@/lib/types'
import { SwarmWorkerPane, type WorkerStatus } from './SwarmWorkerPane'
import { SwarmSupplyPane } from './SwarmSupplyPane'
import { SwarmManagerPane } from './SwarmManagerPane'
import { SwarmFlowPane } from './SwarmFlowPane'
import { SwarmPowerBar } from './SwarmPowerBar'
import { SwarmOnboarding } from './SwarmOnboarding'
import { useSwarmEngine, mergeSwarmWorkers, planSwarmPower } from './useSwarmEngine'

// A dispatched worker, as remembered client-side. The PTY (terminalId) lives
// server-side and survives this tab unmounting; we persist the metadata that
// the server doesn't hand back via any GET (branch / worktree / which card) so
// a tab switch or reload reattaches the same tiles. Same localStorage-as-source
// pattern EmbeddedClaudeTerminal uses for its single PTY id.
interface SwarmWorker {
  terminalId: string
  branch: string
  worktree: string
  taskId?: string
  taskTitle: string
  startedAt: string
}

// MAX_WORKERS bounds how many manual worker entries we RESTORE from localStorage
// — a sanity cap against a forged/oversized registry, NOT a live spawn limit.
// Manual hand-dispatch was removed (the "to-do rail + dispatch" panel is gone):
// workers are now started by the autonomous engine (the master power switch in
// the header bar) or the commander session, so nothing in THIS file adds to the
// registry except a restart (which swaps a dead entry's PTY id, not a new spawn).
// The rendered grid is NOT capped: restored-manual + engine workers together can
// exceed it, and every worker must still show.
const MAX_WORKERS = 6

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

// ── localStorage worker registry (keyed by the stable project UUID) ──────────
const workersKey = (projectId: string) => `openground.swarm.workers.${projectId}`

/** Load + SANITISE the persisted worker list. localStorage is untrusted input
 *  (a user/extension can forge any JSON), so we coerce every field and drop
 *  malformed entries rather than letting a bad shape crash the render. */
const loadWorkers = (projectId: string): SwarmWorker[] => {
  try {
    const raw = localStorage.getItem(workersKey(projectId))
    if (!raw) return []
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((w): w is Record<string, unknown> => {
        if (!w || typeof w !== 'object') return false
        const o = w as Record<string, unknown>
        return (
          typeof o.terminalId === 'string' &&
          typeof o.branch === 'string' &&
          typeof o.worktree === 'string'
        )
      })
      .map((w) => ({
        terminalId: String(w.terminalId),
        branch: String(w.branch),
        worktree: String(w.worktree),
        taskId: typeof w.taskId === 'string' ? w.taskId : undefined,
        taskTitle: typeof w.taskTitle === 'string' ? w.taskTitle : '',
        startedAt: typeof w.startedAt === 'string' ? w.startedAt : '',
      }))
      .slice(0, MAX_WORKERS)
  } catch {
    return []
  }
}

const saveWorkers = (projectId: string, workers: SwarmWorker[]) => {
  try {
    localStorage.setItem(workersKey(projectId), JSON.stringify(workers))
  } catch {
    /* quota / disabled storage — the in-memory state is still authoritative */
  }
}

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

  const [workers, setWorkers] = useState<SwarmWorker[]>(() => loadWorkers(project.id))
  // PTY id → live status from GET /api/terminal/active (working|waiting).
  const [statusByPty, setStatusByPty] = useState<ReadonlyMap<string, ClaudeBeaconStatus>>(new Map())
  // PTY ids whose stream has closed (ClaudeTerminalPane.onExit / dead probe).
  const [exitedIds, setExitedIds] = useState<ReadonlySet<string>>(new Set())
  // PTY id → reason a soft terminate KEPT the worktree (dirty/locked).
  const [retained, setRetained] = useState<ReadonlyMap<string, string>>(new Map())
  // PTY ids with a terminate/force-remove in flight — a Set (not a single id) so
  // tearing one worker down doesn't block terminating another concurrently.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
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
  // the worker tab and the manager dashboard read the same snapshot. This is the
  // single-source fix: the worker tab used to render only the manual localStorage
  // registry and so showed an empty state while the engine had live workers. Now
  // `engine.workers` is merged into the unified list below, feeding both views.
  const {
    engine,
    fatalNotifications,
    available: engineAvailable,
    busy: engineBusy,
    error: engineError,
    toggleAutonomy,
    toggleAutoMerge,
  } = useSwarmEngine(project.path)

  // PTY ids ever seen alive by the active poll. If an id was seen and then drops
  // out of the poll, the PTY died — used by statusOf so a missed SSE 'exit'
  // doesn't leave a dead worker stuck on 'starting'. A ref (not state) because it
  // only refines the render that statusByPty already triggers.
  const seenRef = useRef<Set<string>>(new Set())

  // Reset per-project view state when the panel is reused for another project
  // (ProjectPanel keeps one SwarmModule instance across project switches).
  useEffect(() => {
    setWorkers(loadWorkers(project.id))
    setSupply(loadSupply(project.id))
    setManager(loadManager(project.id))
    setManagerBusy(false)
    setMainView('supply')
    setSupplyBusy(false)
    setExitedIds(new Set())
    setRetained(new Map())
    setError(null)
    setBusyIds(new Set())
    seenRef.current = new Set()
  }, [project.id])

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
  // from here was removed). Manual (restored / restarted) workers only.
  const terminate = useCallback(
    async (worker: SwarmWorker, opts?: { force?: boolean }) => {
      if (busyIds.has(worker.terminalId)) return
      const force = opts?.force ?? false
      setBusyIds((prev) => new Set(prev).add(worker.terminalId))
      setError(null)

      const drop = () => {
        setWorkers((prev) => {
          const next = prev.filter((w) => w.terminalId !== worker.terminalId)
          saveWorkers(project.id, next)
          return next
        })
        // Don't let exitedIds grow unbounded — the worker is gone.
        setExitedIds((prev) => {
          if (!prev.has(worker.terminalId)) return prev
          const s = new Set(prev)
          s.delete(worker.terminalId)
          return s
        })
        setRetained((prev) => {
          if (!prev.has(worker.terminalId)) return prev
          const m = new Map(prev)
          m.delete(worker.terminalId)
          return m
        })
        seenRef.current.delete(worker.terminalId)
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
        // Kill the PTY first (best-effort — it may already be gone).
        await api.api.terminal[':id']
          .$delete({ param: { id: worker.terminalId } })
          .catch(() => {})

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
          setRetained((prev) => new Map(prev).set(worker.terminalId, reason || 'retained'))
        }
      } finally {
        setBusyIds((prev) => {
          if (!prev.has(worker.terminalId)) return prev
          const s = new Set(prev)
          s.delete(worker.terminalId)
          return s
        })
      }
    },
    [busyIds, project.path, project.id, t],
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
  // and re-runs its /order goal. We swap the worker entry's terminalId (branch /
  // worktree stay) and clear the dead id's bookkeeping. Manual workers only — an
  // engine worker's lifecycle is the orchestrator's (read-only here).
  const restartWorker = useCallback(
    async (worker: SwarmWorker) => {
      if (busyIds.has(worker.terminalId)) return
      const old = worker.terminalId
      setBusyIds((prev) => new Set(prev).add(old))
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
            // else the remembered title (a curl-spawned worker without a card).
            ...(worker.taskId ? { taskId: worker.taskId } : { title: worker.taskTitle }),
            // Reuse the SAME worktree — relaunch in place, don't fork a new tree.
            worktree: worker.worktree,
          }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        const spawn = (await res.json()) as SpawnSwarmWorkerResponse
        setWorkers((prev) => {
          const next = prev.map((w) =>
            w.terminalId === old
              ? {
                  ...w,
                  terminalId: spawn.terminalId,
                  branch: spawn.branch,
                  worktree: spawn.worktree,
                  startedAt: new Date().toISOString(),
                }
              : w,
          )
          saveWorkers(project.id, next)
          return next
        })
        forgetPty(old, spawn.terminalId)
      } catch (e) {
        setError(
          t('projectPanel.swarm.restartFailed', {
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        setBusyIds((prev) => {
          if (!prev.has(old)) return prev
          const s = new Set(prev)
          s.delete(old)
          return s
        })
      }
    },
    [busyIds, project.path, project.id, forgetPty, t],
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
  // Fold the manual registry and the engine's own workers into ONE deduped list
  // (PTY id; manual wins). The worker TAB maps this for its tiles and the manager
  // DASHBOARD gets the same set projected to its row shape — so the two views can
  // never disagree and the worker tab is never empty while the engine has workers.
  const allWorkers = mergeSwarmWorkers(workers, engine.workers)

  // Lookup back to the full manual SwarmWorker (worktree + taskId) for the tile's
  // terminate path — engine workers have no entry here (read-only tiles).
  const manualByPty = new Map(workers.map((w) => [w.terminalId, w]))

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
        available={engineAvailable}
        busy={engineBusy}
        workerCount={allWorkers.length}
        onToggle={powerSwarm}
      />
      {/* A transient action error (worker terminate / restart, supply・commander
          launch). The old to-do rail hosted this; with the rail gone it banners
          across the top of the pane so a failure is never lost. */}
      {error && (
        <p className="shrink-0 border-b border-line-soft bg-bg px-3 py-2 text-[11px] leading-relaxed text-accent">
          {error}
        </p>
      )}

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
              // Manual workers are terminable (they own their worktree); engine
              // workers are read-only here (the engine owns their lifecycle).
              // Look the full manual entry up for the terminate path.
              const manual = w.source === 'manual' ? manualByPty.get(w.terminalId) : undefined
              return (
                <div
                  key={w.terminalId}
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
                    taskTitle={w.taskTitle}
                    status={statusOfPty(w.terminalId)}
                    source={w.source}
                    retainedReason={manual ? retained.get(w.terminalId) : undefined}
                    busy={manual ? busyIds.has(w.terminalId) : false}
                    onExit={() => handleExit(w.terminalId)}
                    onRestart={manual ? () => void restartWorker(manual) : undefined}
                    onTerminate={manual ? () => void terminate(manual) : undefined}
                    onForceRemove={manual ? () => void terminate(manual, { force: true }) : undefined}
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
