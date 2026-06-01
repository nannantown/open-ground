import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  PermissionMode,
  RunEntry,
  RunSession,
  RunStatusInfo,
  RunSummaryInfo,
} from './types'
import { runKind } from './runStatus'
import { api } from './api-client'
import {
  ensureNotifyPermission,
  notifyRunFinished,
  type NotifyOptions,
} from './notifications'

export interface RunProject {
  id: string
  name: string
  path: string
}
export interface RunTaskRef {
  id: string
  title: string
}

export interface RunTaskOpts {
  /** A comment for a fresh run, or the next instruction for a resume. */
  instruction?: string
  /** A Claude session id to resume — continues the task in full context. */
  resumeFrom?: string
  /** Auto-loop this run — auto-resume until the task reports itself complete. */
  auto?: boolean
  /** Auto-loop round (1-based); set internally as the loop advances. */
  autoRound?: number
  /** Permission mode for this round (default: 'bypass'). 'plan' makes Claude
   *  produce a plan without editing — and disables the auto-loop, since plan
   *  rounds never finish a task. */
  permissionMode?: PermissionMode
  /** Canvas picker: a Claude Code skill name to apply on this round. */
  skill?: string | null
  /** When the run was started from a Canvas chat (vs the plain Chats tab),
   *  this carries the Canvas id. The server builds an extra prompt section
   *  telling Claude where it is and how to add elements, and the observer
   *  routes Claude's `CANVAS_ADD:` markers to this Canvas. */
  canvasContext?: { canvasId: string }
}

/** Hard ceiling on auto-continue rounds — each round is a real `claude` run. */
export const AUTO_MAX_ROUNDS = 5

/** A user-queued next instruction for a task. Fires automatically when the
 *  currently-live run for that task finishes cleanly (status === 'done').
 *  Chained: if multiple are queued, each one's waitForSessionId is updated
 *  to the previous fire's new session id as it dispatches. */
export interface PendingInstruction {
  id: string
  taskId: string
  project: RunProject
  task: RunTaskRef
  instruction: string
  permissionMode?: PermissionMode
  skill?: string | null
  canvasContext?: { canvasId: string }
  /** sessionId whose `done` event triggers this instruction's dispatch. */
  waitForSessionId: string
  enqueuedAt: string
}

export interface UseRuns {
  /** Every task-run fired this page session (newest appended last). */
  sessions: RunSession[]
  /** Returns the new RunSession on success (or null on failure / non-2xx). */
  runTask: (project: RunProject, task: RunTaskRef, opts?: RunTaskOpts) => Promise<RunSession | null>
  cancelRun: (sessionId: string) => Promise<void>
  /** Drop finished runs — one by id, or every finished one with 'all'. */
  dismiss: (target: string | 'all') => void
  /** The most recent run-session for each task id. */
  taskRuns: Map<string, RunSession>
  /** Every run-session for each task id (oldest first) — feeds chat history. */
  allTaskRuns: Map<string, RunSession[]>
  /** Aggregated run status per project id. */
  statusByProject: Map<string, RunStatusInfo>
  /** Narrative of the project's most recent finished run — feeds the card hero. */
  runSummaryByProject: Map<string, RunSummaryInfo>
  /** Queued instructions per task id, in dispatch order (oldest first). */
  pendingByTask: Map<string, PendingInstruction[]>
  /** Queue a next instruction for the live (or just-fired) run on this task. */
  enqueueInstruction: (
    p: Omit<PendingInstruction, 'id' | 'enqueuedAt'>,
  ) => void
  /** Drop a single queued instruction by id. */
  cancelPending: (id: string) => void
  /** Drop every queued instruction belonging to a task. Used by the chat
   *  delete flow alongside cancelRun + (server-side) observer detach so a
   *  removed chat doesn't leave a dangling queue that fires into nothing. */
  cancelAllPending: (taskId: string) => void
  /** Bumps on every `canvas-add` SSE event from the observer. Lets the
   *  Canvas pane know its file just grew on disk so it can re-fetch.
   *  Always carries the latest signal — consumers compare `seq` against
   *  the one they've already handled to detect new arrivals. */
  canvasAddSignal: { projectPath: string; canvasId: string; seq: number } | null
  /** Bumps on every `canvas-error` SSE event — a CANVAS_ADD / CANVAS_UPDATE
   *  marker the observer rejected. The Canvas pane surfaces it as a transient
   *  toast so a malformed marker fails loudly instead of vanishing. */
  canvasErrorSignal: {
    projectPath: string
    canvasId: string
    message: string
    seq: number
  } | null
  /** Bumps when a run the server refused to start (e.g. the local `claude`
   *  CLI is missing → 503) returns an error. Surfaced as a dismissable toast
   *  in App so a refused run never fails silently. `seq` lets consumers detect
   *  a fresh failure. */
  runError: { message: string; seq: number } | null
}

const SETTLED = new Set<RunEntry['status']>(['done', 'error', 'cancelled'])

// Among concurrent **live** runs, this is which one wins the card stamp.
// Settled runs are resolved by recency instead — an old error must not
// outrank a fresh success.
const LIVE_RANK: Record<'running' | 'pending', number> = {
  running: 2,
  pending: 1,
}

const aggregate = (entries: RunEntry[]): RunStatusInfo => {
  if (entries.length === 0) return { status: 'done' }
  // A live run always wins — the card should reflect what's happening *now*.
  const live = entries.filter(e => !SETTLED.has(e.status))
  if (live.length > 0) {
    let top = live[0]
    for (const e of live) {
      const a = LIVE_RANK[e.status as 'running' | 'pending'] ?? 0
      const b = LIVE_RANK[top.status as 'running' | 'pending'] ?? 0
      if (a > b) top = e
    }
    return { status: top.status, startedAt: top.startedAt }
  }
  // No live runs — show the *latest* settled run. This way a single past
  // error doesn't shadow every successful run that follows it.
  const settled = entries
    .filter(e => SETTLED.has(e.status) && e.finishedAt)
    .sort((a, b) => (a.finishedAt! < b.finishedAt! ? 1 : -1))
  const latest = settled[0] ?? entries[entries.length - 1]
  return {
    status: latest.status,
    startedAt: latest.startedAt,
    finishedAt: latest.finishedAt,
  }
}

/**
 * Owns every task-run on the page and a single multiplexed SSE stream feeding
 * all of them. Runs are independent: same-project runs serialise server-side,
 * different projects run in parallel. `onSettled` fires per finished run.
 *
 * `notify` controls the desktop-notification + sound on completion. Pass a
 * fresh object each render — only its callbacks are reached, so it never
 * tears down the SSE.
 */
export const useRuns = (
  onSettled?: (session: RunSession) => void,
  notify?: NotifyOptions,
): UseRuns => {
  const [sessions, setSessions] = useState<RunSession[]>([])
  const sessionsRef = useRef<RunSession[]>([])
  sessionsRef.current = sessions
  const onSettledRef = useRef(onSettled)
  onSettledRef.current = onSettled
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  // Auto-loop bookkeeping: sessionId → how to fire its next round.
  const autoMeta = useRef(
    new Map<string, { project: RunProject; task: RunTaskRef; round: number; skill?: string | null }>(),
  )
  // User-queued instructions per task id. Each item waits on a specific
  // sessionId's `done` event; once dispatched, the next item in the queue is
  // re-chained to the new session id (handled in the `done` handler below).
  const [pendingByTask, setPendingByTask] = useState<Map<string, PendingInstruction[]>>(
    () => new Map(),
  )
  const pendingByTaskRef = useRef(pendingByTask)
  pendingByTaskRef.current = pendingByTask
  // Latest `canvas-add` event from the observer. ProjectCanvas reads this
  // and re-fetches its active canvas file when it matches.
  const [canvasAddSignal, setCanvasAddSignal] = useState<
    { projectPath: string; canvasId: string; seq: number } | null
  >(null)
  const canvasAddSeqRef = useRef(0)
  // Latest `canvas-error` event — a rejected marker, surfaced as a toast.
  const [canvasErrorSignal, setCanvasErrorSignal] = useState<
    { projectPath: string; canvasId: string; message: string; seq: number } | null
  >(null)
  const canvasErrorSeqRef = useRef(0)
  // Latest run-start failure (e.g. the `claude` CLI is missing — server
  // returns 503 + a hint). Surfaced as a toast so a refused run doesn't just
  // silently do nothing.
  const [runError, setRunError] = useState<{ message: string; seq: number } | null>(null)
  const runErrorSeqRef = useRef(0)

  useEffect(() => {
    // Coalesce streamed log chunks — applying them on a short timer keeps a
    // chatty run from re-rendering the canvas on every single stdout line.
    const logBuf = new Map<string, Map<string, string>>()
    type Thought = { at: string; text: string }
    const thoughtBuf = new Map<string, Map<string, Thought[]>>()
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const flushLogs = () => {
      flushTimer = null
      const pendingLogs = logBuf.size > 0 ? new Map(logBuf) : null
      const pendingThoughts = thoughtBuf.size > 0 ? new Map(thoughtBuf) : null
      logBuf.clear()
      thoughtBuf.clear()
      if (!pendingLogs && !pendingThoughts) return
      setSessions(prev =>
        prev.map(s => {
          const byProjectLog = pendingLogs?.get(s.id)
          const byProjectThought = pendingThoughts?.get(s.id)
          if (!byProjectLog && !byProjectThought) return s
          return {
            ...s,
            entries: s.entries.map(e => {
              const chunk = byProjectLog?.get(e.projectId)
              const added = byProjectThought?.get(e.projectId)
              if (!chunk && !added) return e
              let next = e
              if (chunk) next = { ...next, log: next.log + chunk }
              if (added && added.length) {
                next = { ...next, thoughts: [...(next.thoughts ?? []), ...added] }
              }
              return next
            }),
          }
        }),
      )
    }

    // Re-fetch every session from the server. Called on first mount and after
    // a `cursor` event (= the catch-up gap was wider than the server's ring
    // buffer and we need to snapshot from scratch).
    const rehydrate = () =>
      api.api.run.list
        .$get()
        .then(r => r.json())
        .then((d: { sessions: RunSession[] }) => {
          setSessions(prev => {
            const byId = new Map<string, RunSession>()
            for (const s of prev) byId.set(s.id, s)
            // Server is authoritative — its snapshot overrides any local copy.
            for (const s of d.sessions) byId.set(s.id, s)
            return Array.from(byId.values())
          })
        })
        .catch(() => {})

    // Track the highest event id seen so reconnects can ask for newer.
    let lastSeq: number | null = null
    const trackSeq = (ev: MessageEvent) => {
      const id = ev.lastEventId
      if (!id) return
      const n = parseInt(id, 10)
      if (!Number.isNaN(n) && (lastSeq === null || n > lastSeq)) lastSeq = n
    }

    // Reconnection: EventSource auto-reconnects on transient errors via
    // `Last-Event-ID`. We add a manual layer on top: indefinite reconnect with
    // exponential backoff (cap 15s) when readyState === CLOSED, plus immediate
    // reconnect on tab refocus / online events so a sleep → wake or wifi blip
    // doesn't leave the cockpit silently stale.
    let es: EventSource | null = null
    let backoffMs = 500
    let teardown = false

    const attach = (target: EventSource) => {
      target.addEventListener('cursor', ev => {
        trackSeq(ev as MessageEvent)
        // Gap was too wide for buffered catch-up OR this is a first-time
        // connection — pull a full snapshot.
        void rehydrate()
      })
      target.addEventListener('session', ev => {
        trackSeq(ev as MessageEvent)
        handleSession(ev as MessageEvent)
      })
      target.addEventListener('entry', ev => {
        trackSeq(ev as MessageEvent)
        handleEntry(ev as MessageEvent)
      })
      target.addEventListener('log', ev => {
        trackSeq(ev as MessageEvent)
        handleLog(ev as MessageEvent)
      })
      target.addEventListener('thought', ev => {
        trackSeq(ev as MessageEvent)
        handleThought(ev as MessageEvent)
      })
      target.addEventListener('done', ev => {
        trackSeq(ev as MessageEvent)
        handleDone(ev as MessageEvent)
      })
      target.addEventListener('canvas-add', ev => {
        trackSeq(ev as MessageEvent)
        handleCanvasAdd(ev as MessageEvent)
      })
      target.addEventListener('canvas-error', ev => {
        trackSeq(ev as MessageEvent)
        handleCanvasError(ev as MessageEvent)
      })
      target.onopen = () => {
        backoffMs = 500
      }
      target.onerror = () => {
        // EventSource auto-retries while CONNECTING. Only step in once it
        // gives up (CLOSED) — then we own the reconnect cadence.
        if (target.readyState === EventSource.CLOSED) {
          es = null
          const delay = backoffMs
          backoffMs = Math.min(backoffMs * 2, 15_000)
          setTimeout(() => {
            if (!teardown) connect()
          }, delay)
        }
      }
    }

    const connect = () => {
      if (teardown) return
      const url =
        lastSeq !== null ? `/api/run/events?since=${lastSeq}` : '/api/run/events'
      es = new EventSource(url)
      attach(es)
    }

    // Per-event handlers, defined once so attach() can reuse them across
    // reconnects without rebuilding closures (and without forgetting refs).
    const handleSession = (ev: MessageEvent) => {
      const d = JSON.parse(ev.data) as {
        sessionId: string
        session: RunSession
      }
      setSessions(prev => {
        const i = prev.findIndex(s => s.id === d.sessionId)
        if (i < 0) return [...prev, d.session]
        const next = prev.slice()
        next[i] = d.session
        return next
      })
    }
    const handleEntry = (ev: MessageEvent) => {
      const d = JSON.parse(ev.data) as {
        sessionId: string
        entry: RunEntry
      }
      setSessions(prev => {
        // An entry event can outrun the POST response that registers the
        // session — build a minimal shell so no early update is dropped.
        if (!prev.some(s => s.id === d.sessionId)) {
          return [
            ...prev,
            {
              id: d.sessionId,
              startedAt: d.entry.startedAt ?? new Date().toISOString(),
              entries: [d.entry],
            },
          ]
        }
        return prev.map(s =>
          s.id === d.sessionId
            ? {
                ...s,
                entries: s.entries.map(e =>
                  e.projectId === d.entry.projectId ? d.entry : e,
                ),
              }
            : s,
        )
      })
    }
    const handleLog = (ev: MessageEvent) => {
      const d = JSON.parse(ev.data) as {
        sessionId: string
        projectId: string
        chunk: string
      }
      let byProject = logBuf.get(d.sessionId)
      if (!byProject) {
        byProject = new Map()
        logBuf.set(d.sessionId, byProject)
      }
      byProject.set(d.projectId, (byProject.get(d.projectId) ?? '') + d.chunk)
      if (!flushTimer) flushTimer = setTimeout(flushLogs, 200)
    }
    const handleThought = (ev: MessageEvent) => {
      const d = JSON.parse(ev.data) as {
        sessionId: string
        projectId: string
        thought: Thought
      }
      let byProject = thoughtBuf.get(d.sessionId)
      if (!byProject) {
        byProject = new Map()
        thoughtBuf.set(d.sessionId, byProject)
      }
      const arr = byProject.get(d.projectId) ?? []
      arr.push(d.thought)
      byProject.set(d.projectId, arr)
      if (!flushTimer) flushTimer = setTimeout(flushLogs, 200)
    }
    const handleCanvasAdd = (ev: MessageEvent) => {
      try {
        const d = JSON.parse(ev.data) as { projectPath: string; canvasId: string }
        canvasAddSeqRef.current += 1
        setCanvasAddSignal({
          projectPath: d.projectPath,
          canvasId: d.canvasId,
          seq: canvasAddSeqRef.current,
        })
      } catch {}
    }
    const handleCanvasError = (ev: MessageEvent) => {
      try {
        const d = JSON.parse(ev.data) as {
          projectPath: string
          canvasId: string
          message: string
        }
        canvasErrorSeqRef.current += 1
        setCanvasErrorSignal({
          projectPath: d.projectPath,
          canvasId: d.canvasId,
          message: d.message,
          seq: canvasErrorSeqRef.current,
        })
      } catch {}
    }
    const handleDone = (ev: MessageEvent) => {
      flushLogs()
      const d = JSON.parse((ev as MessageEvent).data) as { sessionId: string }
      const finished = sessionsRef.current.find(s => s.id === d.sessionId)
      if (finished) {
        const opts = notifyRef.current
        if (opts) notifyRunFinished(finished, opts)
        onSettledRef.current?.(finished)
      }
      const e = finished?.entries[0]
      const cleanlyDone = !!(e && e.status === 'done')

      // Pending-instruction dispatch: if the queue head for any task was
      // waiting on this session, dispatch it now. Only on a clean `done` —
      // cancelled / error leaves the queue intact so the user can decide.
      let toDispatch: PendingInstruction | null = null
      let chainTaskId: string | null = null
      if (cleanlyDone) {
        setPendingByTask(prev => {
          const next = new Map(prev)
          for (const [tid, queue] of Array.from(next.entries())) {
            const headIdx = queue.findIndex(p => p.waitForSessionId === d.sessionId)
            if (headIdx < 0) continue
            toDispatch = queue[headIdx]
            chainTaskId = tid
            const rest = queue.filter((_, i) => i !== headIdx)
            if (rest.length === 0) next.delete(tid)
            else next.set(tid, rest)
            break
          }
          return next
        })
        if (toDispatch && chainTaskId) {
          const pending: PendingInstruction = toDispatch
          const targetTaskId: string = chainTaskId
          const resumeFrom = e?.agentSessionId
          runTaskRef.current(pending.project, pending.task, {
            instruction: pending.instruction,
            resumeFrom,
            permissionMode: pending.permissionMode,
            skill: pending.skill,
            canvasContext: pending.canvasContext,
          }).then(newSession => {
            if (!newSession) return
            // Chain: the next queued instruction (if any) now waits on the
            // session we just fired, so it dispatches when *that* finishes.
            setPendingByTask(prev => {
              const arr = prev.get(targetTaskId)
              if (!arr || arr.length === 0) return prev
              const next = new Map(prev)
              const updated = arr.map((p, i) =>
                i === 0 ? { ...p, waitForSessionId: newSession.id } : p,
              )
              next.set(targetTaskId, updated)
              return next
            })
          })
        }
      }

      // Auto-loop: while the task is not reported complete, resume it — up to
      // AUTO_MAX_ROUNDS, and only if the round itself finished cleanly.
      //
      // Phase 6.D: for milestone-bound runs the truth of "complete" comes
      // from the external shell verify (entry.verifiedTaskComplete.passed),
      // not from Claude's self-reported parsedResult.taskComplete. That's
      // the whole point of the Tasks tab — we no longer trust the bot's
      // own "I'm done" claim, we trust the exit codes.
      const meta = autoMeta.current.get(d.sessionId)
      if (meta) {
        autoMeta.current.delete(d.sessionId)
        const queuedForTask = pendingByTaskRef.current.get(meta.task.id)?.length ?? 0
        const selfReported = e!.parsedResult?.taskComplete === true
        const externallyVerified = e!.verifiedTaskComplete?.passed === true
        const trulyComplete = e!.milestoneId
          ? externallyVerified
          : selfReported
        if (
          cleanlyDone &&
          !trulyComplete &&
          // Claude is waiting on a user answer — auto-loop would barge past it
          // with the default resume nudge and lose the question. Pause instead.
          !e!.parsedResult?.question &&
          e!.agentSessionId &&
          meta.round < AUTO_MAX_ROUNDS &&
          // Pending user-queued instructions take priority — auto-loop sits
          // out while the user has a follow-up of their own waiting to fire.
          queuedForTask === 0
        ) {
          runTaskRef.current(meta.project, meta.task, {
            resumeFrom: e!.agentSessionId,
            auto: true,
            autoRound: meta.round + 1,
            skill: meta.skill ?? null,
          })
        }
      }
    }

    // Tab refocus / network restore → kick a fresh reconnect right now rather
    // than waiting for EventSource's auto-retry. Suspended laptops can sit on
    // a dead SSE for minutes otherwise.
    const onVis = () => {
      if (document.visibilityState !== 'visible') return
      if (es && es.readyState === EventSource.OPEN) return
      if (es) {
        try { es.close() } catch {}
        es = null
      }
      backoffMs = 500
      connect()
    }
    const onOnline = () => {
      if (es && es.readyState === EventSource.OPEN) return
      if (es) {
        try { es.close() } catch {}
        es = null
      }
      backoffMs = 500
      connect()
    }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)

    // First mount: open the stream and pull a snapshot of in-flight / recent
    // sessions. The cursor event from the initial connect will also trigger
    // a rehydrate, but kicking one off here ensures the cockpit shows data
    // immediately even before the SSE handshakes.
    connect()
    void rehydrate()

    return () => {
      teardown = true
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
      if (flushTimer) clearTimeout(flushTimer)
      if (es) try { es.close() } catch {}
    }
  }, [])

  const runTask = useCallback(
    async (
      project: RunProject,
      task: RunTaskRef,
      opts?: RunTaskOpts,
    ): Promise<RunSession | null> => {
      // First-run gesture is a good moment to ask for notification permission
      // (browsers gate the prompt behind a user gesture). Idempotent.
      ensureNotifyPermission()
      // Plan-mode rounds never complete a task, so the auto-loop would spin
      // forever — ignore the auto flag when planning.
      const planning = opts?.permissionMode === 'plan'
      const round = opts?.auto && !planning ? opts.autoRound ?? 1 : undefined
      const res = await api.api.run.$post({
        json: {
          project,
          task: { id: task.id, title: task.title },
          instruction: opts?.instruction,
          resumeFrom: opts?.resumeFrom,
          autoRound: round,
          permissionMode: opts?.permissionMode,
          skill: opts?.skill ?? null,
          canvasContext: opts?.canvasContext,
        },
      })
      if (!res.ok) {
        // Surface the server's reason (e.g. the `claude` CLI is missing, 503)
        // as a toast instead of failing silently.
        let message = 'Could not start the run. Please try again.'
        try {
          const err = (await res.json()) as { error?: string }
          if (err?.error) message = err.error
        } catch {}
        runErrorSeqRef.current += 1
        setRunError({ message, seq: runErrorSeqRef.current })
        return null
      }
      const session = (await res.json()) as RunSession
      // The SSE stream may have registered this session already — keep that
      // (newer) copy rather than clobbering it with the initial POST snapshot.
      setSessions(prev =>
        prev.some(s => s.id === session.id) ? prev : [...prev, session],
      )
      // Remember how to fire this auto-run's next round when it finishes.
      if (round !== undefined) {
        autoMeta.current.set(session.id, { project, task, round, skill: opts?.skill ?? null })
      }
      return session
    },
    [],
  )
  const runTaskRef = useRef(runTask)
  runTaskRef.current = runTask

  const cancelRun = useCallback(async (sessionId: string) => {
    await api.api.run.cancel.$post({ json: { id: sessionId } })
  }, [])

  // Lazy crypto.randomUUID with a fallback for older browsers / non-secure contexts.
  const newPendingId = () =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `pending-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

  const enqueueInstruction = useCallback(
    (p: Omit<PendingInstruction, 'id' | 'enqueuedAt'>) => {
      const item: PendingInstruction = {
        ...p,
        id: newPendingId(),
        enqueuedAt: new Date().toISOString(),
      }
      setPendingByTask(prev => {
        const next = new Map(prev)
        const arr = next.get(p.taskId) ?? []
        next.set(p.taskId, [...arr, item])
        return next
      })
    },
    [],
  )

  const cancelPending = useCallback((id: string) => {
    setPendingByTask(prev => {
      const next = new Map(prev)
      for (const [tid, arr] of Array.from(next.entries())) {
        const filtered = arr.filter(p => p.id !== id)
        if (filtered.length === arr.length) continue
        if (filtered.length === 0) next.delete(tid)
        else next.set(tid, filtered)
      }
      return next
    })
  }, [])

  const cancelAllPending = useCallback((taskId: string) => {
    setPendingByTask(prev => {
      if (!prev.has(taskId)) return prev
      const next = new Map(prev)
      next.delete(taskId)
      return next
    })
  }, [])

  const dismiss = useCallback((target: string | 'all') => {
    setSessions(prev =>
      prev.filter(s => {
        const settled = !!s.finishedAt
        if (!settled) return true // never drop a live run
        return target === 'all' ? false : s.id !== target
      }),
    )
    // Also drop it server-side so it does not rehydrate on the next reload.
    // Local state is optimistically updated above; we keep that even on
    // failure, but we must not swallow the error silently — a failed dismiss
    // means the run *will* rehydrate next reload, so at least surface it.
    api.api.run.dismiss
      .$post({ json: target === 'all' ? { all: true } : { id: target } })
      .then(res => {
        if (!res.ok) {
          // eslint-disable-next-line no-console
          console.warn(
            `[useRuns] dismiss failed (${res.status}) for ${target}; run may reappear on reload`,
          )
        }
      })
      .catch(err => {
        // eslint-disable-next-line no-console
        console.warn('[useRuns] dismiss request errored:', err)
      })
  }, [])

  // The most recent run-session per task id (oldest-first so the newest wins).
  const taskRuns = useMemo(() => {
    const m = new Map<string, RunSession>()
    const ordered = [...sessions].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    )
    for (const s of ordered) {
      for (const e of s.entries) {
        for (const t of e.targetedTasks) m.set(t.id, s)
      }
    }
    return m
  }, [sessions])

  // Every session per task id, oldest first — feeds the chat-style task pane
  // so it can show the full back-and-forth history (each resume = one round).
  const allTaskRuns = useMemo(() => {
    const m = new Map<string, RunSession[]>()
    const ordered = [...sessions].sort((a, b) =>
      a.startedAt.localeCompare(b.startedAt),
    )
    for (const s of ordered) {
      for (const e of s.entries) {
        for (const t of e.targetedTasks) {
          let arr = m.get(t.id)
          if (!arr) {
            arr = []
            m.set(t.id, arr)
          }
          if (!arr.find(x => x.id === s.id)) arr.push(s)
        }
      }
    }
    return m
  }, [sessions])

  const statusByProject = useMemo(() => {
    const byProject = new Map<string, RunEntry[]>()
    for (const s of sessions) {
      for (const e of s.entries) {
        const arr = byProject.get(e.projectId)
        if (arr) arr.push(e)
        else byProject.set(e.projectId, [e])
      }
    }
    const out = new Map<string, RunStatusInfo>()
    byProject.forEach((entries, pid) => out.set(pid, aggregate(entries)))
    return out
  }, [sessions])

  // For each project, the **most recent finished** entry's narrative — the
  // card's hero block. Live runs do not feed the hero (the top-edge bar +
  // stamp already carry their state), so the hero is stable between runs.
  const runSummaryByProject = useMemo(() => {
    const newestFinished = new Map<string, RunEntry>()
    for (const s of sessions) {
      for (const e of s.entries) {
        if (!SETTLED.has(e.status)) continue
        if (!e.finishedAt) continue
        const prev = newestFinished.get(e.projectId)
        if (!prev || (prev.finishedAt ?? '') < e.finishedAt) {
          newestFinished.set(e.projectId, e)
        }
      }
    }
    const out = new Map<string, RunSummaryInfo>()
    newestFinished.forEach((e, pid) => {
      const kind = runKind(e)
      // The hero is meant for narrative — skip transient and non-narrative states.
      if (kind === 'queued' || kind === 'running' || kind === 'merging' || kind === 'conflict') return
      const pr = e.parsedResult
      out.set(pid, {
        kind,
        taskTitle: e.targetedTasks[0]?.title ?? '',
        summary: pr?.summary?.trim() ?? '',
        blockers: pr?.blockers?.trim() ?? '',
        followups: pr?.followups ?? [],
        question: pr?.question?.trim() || undefined,
        finishedAt: e.finishedAt,
      })
    })
    return out
  }, [sessions])

  return {
    sessions,
    runTask,
    cancelRun,
    dismiss,
    taskRuns,
    allTaskRuns,
    statusByProject,
    runSummaryByProject,
    pendingByTask,
    enqueueInstruction,
    cancelPending,
    cancelAllPending,
    canvasAddSignal,
    canvasErrorSignal,
    runError,
  }
}
