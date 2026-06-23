// SwarmModule — the owner-only "swarm" experiment surface (Phase 1).
//
// PURPOSE (project_inapp_swarm_port): dispatch this project's Board to-do cards
// to isolated `claude` workers and watch them run, all from one tab — the in-app
// version of the tmux supply/manage/worker cockpit, minus the autonomy.
//
// SECURITY: this component is mounted ONLY from ProjectPanel's render branch
// `view === 'swarm' && experiments?.swarm` — itself behind the server-resolved
// owner+toggle gate (gateFromFlags / computeExperiments). A non-owner or a
// flag-off user never mounts it, so every side effect here (the localStorage
// worker registry, the polls, the spawns) is reached ONLY when the gate is open.
// There is therefore nothing extra to gate INSIDE this file — the trace-zero
// guarantee is structural (Task A), and this file just consumes it.
//
// SCOPE (Phase 1, deliberately NOT autonomous): the user dispatches and
// terminates by hand. There is no auto-drain, no auto-merge, no scheduled column
// movement — those are Phase 2. The only column moves here are the two halves of
// an explicit user action: dispatch (todo→doing) and terminate (doing→todo).
//
// SUBSCRIPTION-ONLY: workers are spawned solely through the B API
// (POST /api/swarm/worker), which launches an interactive `claude` PTY — never
// `claude -p` / the SDK. This module never spawns claude itself.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Network, Send, Inbox, Boxes } from 'lucide-react'
import { api } from '@/lib/api-client'
import { columnOf } from '@/components/canvas/BoardTab'
import { useT } from '@/i18n/I18nContext'
import type {
  ActiveTerminalsResponse,
  BoardColumn,
  ClaudeBeaconStatus,
  ProjectData,
  ProjectMeta,
  ProjectTask,
  RemoveSwarmWorktreeResponse,
  SpawnSwarmSupplyResponse,
  SpawnSwarmWorkerResponse,
} from '@/lib/types'
import { SwarmWorkerPane, type WorkerStatus } from './SwarmWorkerPane'
import { SwarmSupplyPane } from './SwarmSupplyPane'

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

// Mirrors the Terminal tab's pane sizing: full width for one, halves/thirds/
// quarters up to four, then a min width + horizontal scroll beyond that.
const MAX_WORKERS = 6
const paneWidthPct = (count: number) => 100 / Math.min(Math.max(count, 1), 4)

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

// The two halves of the main area: the supply conversation desk vs the worker
// tiles. The todo rail (the queue supply feeds and dispatch drains) stays
// visible alongside both, so the supply→todo→worker pipeline is never hidden.
type MainView = 'supply' | 'workers'

export const SwarmModule = ({ project }: { project: ProjectMeta }) => {
  const { t } = useT()

  const [workers, setWorkers] = useState<SwarmWorker[]>(() => loadWorkers(project.id))
  const [todos, setTodos] = useState<ProjectTask[]>([])
  // PTY id → live status from GET /api/terminal/active (working|waiting).
  const [statusByPty, setStatusByPty] = useState<ReadonlyMap<string, ClaudeBeaconStatus>>(new Map())
  // PTY ids whose stream has closed (ClaudeTerminalPane.onExit / dead probe).
  const [exitedIds, setExitedIds] = useState<ReadonlySet<string>>(new Set())
  // PTY id → reason a soft terminate KEPT the worktree (dirty/locked).
  const [retained, setRetained] = useState<ReadonlyMap<string, string>>(new Map())
  const [dispatchingId, setDispatchingId] = useState<string | null>(null)
  // PTY ids with a terminate/force-remove in flight — a Set (not a single id) so
  // tearing one worker down doesn't block terminating another concurrently.
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  // The single supply (補給官) session + which half of the main area is shown.
  // Supply is the conversational entry point, so the main area opens on it; a
  // successful dispatch flips to the worker tiles so the user sees the worker
  // they just launched. supplyBusy = a launch/stop round-trip is in flight.
  const [supply, setSupply] = useState<SwarmSupply | null>(() => loadSupply(project.id))
  const [mainView, setMainView] = useState<MainView>('supply')
  const [supplyBusy, setSupplyBusy] = useState(false)

  // PTY ids ever seen alive by the active poll. If an id was seen and then drops
  // out of the poll, the PTY died — used by statusOf so a missed SSE 'exit'
  // doesn't leave a dead worker stuck on 'starting'. A ref (not state) because it
  // only refines the render that statusByPty already triggers.
  const seenRef = useRef<Set<string>>(new Set())

  const atLimit = workers.length >= MAX_WORKERS

  // Reset per-project view state when the panel is reused for another project
  // (ProjectPanel keeps one SwarmModule instance across project switches).
  useEffect(() => {
    setWorkers(loadWorkers(project.id))
    setSupply(loadSupply(project.id))
    setMainView('supply')
    setSupplyBusy(false)
    setExitedIds(new Set())
    setRetained(new Map())
    setError(null)
    setDispatchingId(null)
    setBusyIds(new Set())
    seenRef.current = new Set()
  }, [project.id])

  // Pull this project's to-do cards (boardColumn 'todo'), ordered by boardOrder.
  const refreshTodos = useCallback(async () => {
    try {
      const res = await api.api.project.$get({ query: { path: project.path } })
      if (!res.ok) return
      const data = (await res.json()) as ProjectData
      const next = (data.tasks ?? [])
        .filter((tk) => columnOf(tk) === 'todo')
        .sort((a, b) => (a.boardOrder ?? 0) - (b.boardOrder ?? 0))
      setTodos(next)
    } catch {
      /* server restarting / offline — keep the last known list */
    }
  }, [project.path])

  // Mount + window focus → refresh todos (another session may have edited the
  // Board). refreshTodos changes identity with project.path, so a project
  // switch re-runs this too.
  useEffect(() => {
    void refreshTodos()
    const onFocus = () => void refreshTodos()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refreshTodos])

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
  const statusOf = useCallback((w: SwarmWorker): WorkerStatus => statusOfPty(w.terminalId), [statusOfPty])

  const handleExit = useCallback((terminalId: string) => {
    setExitedIds((prev) => (prev.has(terminalId) ? prev : new Set(prev).add(terminalId)))
  }, [])

  // Dispatch a to-do card → spawn an isolated worker (B API), then move the
  // card to 'doing' and record its branch on the Board.
  const dispatch = useCallback(
    async (card: ProjectTask) => {
      if (atLimit || dispatchingId) return
      setDispatchingId(card.id)
      setError(null)
      try {
        // B API (raw fetch + typed cast): spawn the worktree + claude PTY. The
        // server reads the goal from the card (title + notes) and injects
        // `/order ゴール: …` — we pass only the taskId.
        const res = await fetch('/api/swarm/worker', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: project.path, taskId: card.id }),
        })
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string }
          throw new Error(body?.error || `HTTP ${res.status}`)
        }
        const spawn = (await res.json()) as SpawnSwarmWorkerResponse
        const worker: SwarmWorker = {
          terminalId: spawn.terminalId,
          branch: spawn.branch,
          worktree: spawn.worktree,
          taskId: card.id,
          taskTitle: card.title || '',
          startedAt: new Date().toISOString(),
        }
        setWorkers((prev) => {
          const next = [...prev, worker]
          saveWorkers(project.id, next)
          return next
        })
        // Reveal the worker the user just launched (they may have dispatched
        // from the always-visible todo rail while watching the supply desk).
        setMainView('workers')
        // Move the card to 'doing' + record the branch. The worker is already
        // live, so a failed Board write must NOT lose it — but we DO surface the
        // failure (the card stays in todo; the live-worker guard below stops a
        // second dispatch, and the user can move it by hand).
        let moved = false
        try {
          const mv = await api.api.project.tasks.$post({
            json: {
              path: project.path,
              setColumn: [{ id: card.id, column: 'doing' as BoardColumn }],
              setBranch: [{ id: card.id, branch: spawn.branch }],
            },
          })
          moved = mv.ok
        } catch {
          moved = false
        }
        if (!moved) setError(t('projectPanel.swarm.boardMoveFailed'))
        await refreshTodos()
      } catch (e) {
        setError(
          t('projectPanel.swarm.dispatchFailed', {
            error: e instanceof Error ? e.message : String(e),
          }),
        )
      } finally {
        setDispatchingId(null)
      }
    },
    [atLimit, dispatchingId, project.path, project.id, refreshTodos, t],
  )

  // Terminate a worker: kill the PTY, then tear the worktree down. A soft
  // attempt keeps a dirty/locked tree (removed:false) so uncommitted work isn't
  // lost — we surface a force option. Force that still refuses drops the worker
  // anyway (the PTY is dead) and reports the reason for manual cleanup. Whenever
  // the worker is dropped, its card goes back to 'todo' so it can be
  // re-dispatched here (the manual counterpart of dispatch — NOT autonomous).
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
        await refreshTodos()
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
    [busyIds, project.path, project.id, refreshTodos, t],
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

  // Cards that already have a live worker (their dispatch failed to move them
  // out of todo). Disable re-dispatch for these so one card never gets twins.
  const liveTaskIds = new Set(
    workers.map((w) => w.taskId).filter((id): id is string => !!id),
  )

  return (
    <div className="flex min-h-0 flex-1">
      {/* ── To-do rail: this project's todo cards, each dispatchable ───────── */}
      <aside className="flex w-[260px] shrink-0 flex-col border-r border-line bg-bg">
        <div className="flex shrink-0 items-center justify-between border-b border-line-soft px-3 py-2">
          <span className="label-cap text-ink-faint">{t('projectPanel.swarm.todoHeading')}</span>
          <span className="font-mono text-[10px] text-ink-faint">{todos.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {todos.length === 0 ? (
            <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-ink-faint">
              {t('projectPanel.swarm.todoEmpty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {todos.map((card) => {
                const live = liveTaskIds.has(card.id)
                return (
                  <li key={card.id} className="rounded-[4px] border border-line bg-bg-card p-2.5">
                    <p className="mb-2 line-clamp-2 text-[12px] leading-snug text-ink">
                      {card.title || t('projectPanel.swarm.untitled')}
                    </p>
                    <button
                      type="button"
                      onClick={() => void dispatch(card)}
                      disabled={atLimit || dispatchingId !== null || live}
                      title={
                        live
                          ? t('projectPanel.swarm.alreadyRunning')
                          : atLimit
                            ? t('projectPanel.swarm.workersFull')
                            : undefined
                      }
                      className="flex w-full items-center justify-center gap-1.5 rounded-[3px] border border-line px-2 py-1 text-[11px] text-ink-muted transition-colors hover:border-accent hover:text-ink active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
                    >
                      <Send size={11} strokeWidth={2.25} />
                      {live
                        ? t('projectPanel.swarm.alreadyRunning')
                        : dispatchingId === card.id
                          ? t('projectPanel.swarm.dispatching')
                          : t('projectPanel.swarm.dispatch')}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {error && (
          <p className="shrink-0 border-t border-line-soft px-3 py-2 text-[11px] leading-relaxed text-accent">
            {error}
          </p>
        )}
        {atLimit && (
          <p className="shrink-0 border-t border-line-soft px-3 py-1.5 text-center text-[10px] text-ink-faint">
            {t('projectPanel.swarm.workersFull')}
          </p>
        )}
      </aside>

      {/* ── Main area: supply desk ⇆ worker tiles, switched by a toggle ────── */}
      {/* No bg on this wrapper: the empty/CTA states below are PAPER surfaces
          (bg-bg) so the paper ink tokens keep 4.5:1+ contrast. The dark terminal
          bg (#1a1a1a) is scoped to the pane branches only, where
          ClaudeTerminalPane's own light-on-dark xterm lives — putting it here
          would bury the empty states' dark ink on a dark ground. */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Toggle: supply (補給官) ⇆ workers. Underline tabs, the same vocabulary
            as the project tab row, on a PAPER strip (bg-bg) regardless of the
            content below so the ink tokens always have contrast. The todo rail
            stays beside both, so the supply→todo→worker pipeline is never hidden. */}
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
            {workers.length > 0 && (
              <span className="rounded-full border border-line px-1.5 text-[9px] font-medium leading-[14px] text-ink-faint">
                {workers.length}
              </span>
            )}
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
        ) : workers.length === 0 ? (
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
          <div className="flex min-h-0 flex-1 overflow-x-auto bg-[#1a1a1a]">
            {workers.map((w) => (
              <div
                key={w.terminalId}
                className="flex min-w-[320px] flex-col border-r border-line last:border-r-0"
                style={{ width: `${paneWidthPct(workers.length)}%`, flex: '0 0 auto' }}
              >
                <SwarmWorkerPane
                  terminalId={w.terminalId}
                  branch={w.branch}
                  taskTitle={w.taskTitle}
                  status={statusOf(w)}
                  retainedReason={retained.get(w.terminalId)}
                  busy={busyIds.has(w.terminalId)}
                  onExit={() => handleExit(w.terminalId)}
                  onTerminate={() => void terminate(w)}
                  onForceRemove={() => void terminate(w, { force: true })}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
