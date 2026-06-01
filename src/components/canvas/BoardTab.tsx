import { useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square, GripVertical, AlertTriangle, Check, Loader2, Clock, Columns3 } from 'lucide-react'
import type { BoardColumn, ProjectData, ProjectTask, RunSession } from '@/lib/types'
import type { RunTaskOpts } from '@/lib/useRuns'
import { useOnlineStatus } from '@/lib/useOnlineStatus'

// ─── Board tab ───────────────────────────────────────────────────────────────
// A kanban view over the SAME tasks the Chats tab uses (one source of truth in
// .openground/tasks.json). Columns are fixed workflow stages; a card's vertical
// position WITHIN a column is its priority (top = highest). The run lifecycle
// and the board-run loop (B4) move cards doing→done/blocked; the user can also
// drag a card anywhere.
//
// This file is the UI + drag/drop + persistence (B3). The sequential board-run
// controller is layered on in B4 via the same component state.

export const COLUMNS: { key: BoardColumn; label: string; hint: string }[] = [
  { key: 'todo', label: '未着手', hint: '上から優先度順' },
  { key: 'doing', label: '実行中', hint: '' },
  { key: 'done', label: '完了', hint: '' },
  { key: 'blocked', label: 'ブロック', hint: 'コンフリクト / 要対応' },
]

// A task's column. Explicit boardColumn wins; otherwise fall back to its done
// flag so a task completed elsewhere (Chats) shows in 完了 instead of stranding
// in 未着手, and a fresh task starts in 未着手.
export const columnOf = (t: ProjectTask): BoardColumn =>
  t.boardColumn ?? (t.done ? 'done' : 'todo')

// Sort within a column: boardOrder ascending; tasks without one fall after
// ordered cards, oldest-first (stable, back-compat for pre-board tasks).
export const byColumnOrder = (a: ProjectTask, b: ProjectTask): number => {
  const ao = a.boardOrder
  const bo = b.boardOrder
  if (ao != null && bo != null) return ao - bo
  if (ao != null) return -1
  if (bo != null) return 1
  return (a.createdAt || '') < (b.createdAt || '') ? -1 : 1
}

// ── Per-card run status (derived from the live run session) ──────────────────
type CardStatus = 'idle' | 'queued' | 'running' | 'done' | 'error' | 'cancelled' | 'conflict'

export const deriveCardStatus = (run: RunSession | undefined): CardStatus => {
  const e = run?.entries?.[0]
  if (!e) return 'idle'
  if (e.mergeStatus === 'conflict' || e.mergeStatus === 'failed-fatal') return 'conflict'
  switch (e.status) {
    case 'pending':
      return 'queued'
    case 'running':
      return 'running'
    case 'error':
      return 'error'
    case 'cancelled':
      return 'cancelled'
    case 'done':
      return 'done'
    default:
      return 'idle'
  }
}

// Terminal classification for the board-run loop. A task is only "settled for
// the board" when no entry is live (pending/running). Because the run hook
// auto-loops (resumes the same task across rounds until taskComplete /
// AUTO_MAX_ROUNDS), the controller debounces this: it waits a beat after a
// settle and re-checks that the task didn't immediately go live again.
export type TerminalKind = 'live' | 'done' | 'blocked' | 'cancelled'

export const classifyTerminal = (run: RunSession | undefined): TerminalKind => {
  const entries = run?.entries ?? []
  if (entries.some(e => e.status === 'pending' || e.status === 'running')) return 'live'
  const e = entries[0]
  if (!e) return 'live' // run not observed yet — treat as still in flight
  if (e.status === 'cancelled') return 'cancelled'
  if (e.mergeStatus === 'conflict' || e.mergeStatus === 'failed-fatal') return 'blocked'
  if (e.status === 'error') return 'blocked'
  if (e.status === 'done') return e.parsedResult?.taskComplete === true ? 'done' : 'blocked'
  return 'live'
}

// How long a task must stay settled before the board treats it as truly done
// (vs. the auto-loop firing the next round, which shows up within ~ms–1s).
const SETTLE_DEBOUNCE_MS = 2500

// If a launched task shows no run entry within this long, treat the launch as
// failed (offline / `claude` missing) and move the board on.
const LAUNCH_TIMEOUT_MS = 20000

const STATUS_META: Record<
  CardStatus,
  { label: string; cls: string; icon: React.ReactNode | null }
> = {
  idle: { label: '', cls: 'text-ink-faint', icon: null },
  queued: {
    label: '待機',
    cls: 'text-ochre bg-ochre/10',
    icon: <Clock size={10} strokeWidth={2.25} />,
  },
  running: {
    label: '実行中',
    cls: 'text-azure bg-azure/10',
    icon: <Loader2 size={10} strokeWidth={2.25} className="animate-spin" />,
  },
  done: {
    label: '完了',
    cls: 'text-moss bg-moss/10',
    icon: <Check size={10} strokeWidth={2.25} />,
  },
  error: {
    label: 'エラー',
    cls: 'text-accent bg-accent/10',
    icon: <AlertTriangle size={10} strokeWidth={2.25} />,
  },
  cancelled: { label: '中止', cls: 'text-ink-subtle bg-ink/5', icon: null },
  conflict: {
    label: 'コンフリクト',
    cls: 'text-accent bg-accent/10',
    icon: <AlertTriangle size={10} strokeWidth={2.25} />,
  },
}

// Board runs work each card to completion: auto-loop (resume until taskComplete
// or AUTO_MAX_ROUNDS) rather than a single round, so a card only leaves 実行中
// when the task is genuinely done (or blocked). Without this every card would
// stop after one round and land in ブロック.
const BOARD_RUN_OPTS: RunTaskOpts = { auto: true }

export interface BoardRun {
  boardRunning: boolean
  currentId: string | null
  startBoard: () => void
  stopBoard: () => void
}

// ── Board-run controller (sequential, priority-ordered) ──────────────────────
// Deliberately a hook OWNED BY ProjectPanel, not by BoardTab: ProjectPanel stays
// mounted while you flip between Chats/Terminal/Canvas/Board, so the board keeps
// advancing even when the Board tab isn't visible. (It still stops if you close
// or switch projects — that unmounts ProjectPanel.)
export const useBoardRun = (
  data: ProjectData | null,
  taskRuns: Map<string, RunSession>,
  onPersist: (next: ProjectData) => void,
  onRunTask: (task: ProjectTask, opts?: RunTaskOpts) => void,
): BoardRun => {
  const [boardRunning, setBoardRunning] = useState(false)
  const [currentId, setCurrentId] = useState<string | null>(null)
  // Live mirrors so the debounce timer + callbacks never read stale closures.
  const dataRef = useRef(data)
  dataRef.current = data
  const taskRunsRef = useRef(taskRuns)
  taskRunsRef.current = taskRuns
  const runningRef = useRef(false)
  const currentIdRef = useRef<string | null>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Safety net: if a launched task never produces a run entry (offline mid-run,
  // the `claude` CLI is missing → 503, etc.) the card would otherwise look
  // 'live' forever and the board would hang. After this long with no entry we
  // treat the launch as failed → block the card and move on.
  const launchWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSettle = () => {
    if (settleTimer.current) {
      clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
  }
  const clearWatchdog = () => {
    if (launchWatchdog.current) {
      clearTimeout(launchWatchdog.current)
      launchWatchdog.current = null
    }
  }

  const stopBoard = () => {
    runningRef.current = false
    currentIdRef.current = null
    clearSettle()
    clearWatchdog()
    setBoardRunning(false)
    setCurrentId(null)
  }

  // Pick the highest-priority todo card (or adopt an already-live one), run it,
  // and mark it 実行中 — all in one persist. Returns false when the queue is
  // empty (board run complete).
  const launchNext = (tasks: ProjectTask[]): boolean => {
    const base = dataRef.current
    if (!base) {
      stopBoard()
      return false
    }
    // One-at-a-time guarantee: if ANY task is already live (e.g. the user kicked
    // one off from Chats, or we're resuming after the Board tab was re-opened),
    // adopt it as the current card and wait — never launch a second concurrent
    // run. Park it in 実行中 so the board reflects reality.
    const live = tasks.find(t => classifyTerminal(taskRunsRef.current.get(t.id)) === 'live')
    if (live) {
      const parked = tasks.map(t =>
        t.id === live.id ? { ...t, boardColumn: 'doing' as BoardColumn } : t,
      )
      onPersist({ ...base, tasks: parked })
      currentIdRef.current = live.id
      setCurrentId(live.id)
      return true
    }
    const todo = tasks.filter(t => columnOf(t) === 'todo').sort(byColumnOrder)
    const next = todo[0]
    if (!next) {
      onPersist({ ...base, tasks })
      stopBoard()
      return false
    }
    const withDoing = tasks.map(t =>
      t.id === next.id ? { ...t, boardColumn: 'doing' as BoardColumn } : t,
    )
    onPersist({ ...base, tasks: withDoing })
    currentIdRef.current = next.id
    setCurrentId(next.id)
    onRunTask(next, BOARD_RUN_OPTS)
    // Arm the launch watchdog — cleared as soon as a run entry is observed.
    clearWatchdog()
    const launchedId = next.id
    launchWatchdog.current = setTimeout(() => {
      launchWatchdog.current = null
      if (!runningRef.current || currentIdRef.current !== launchedId) return
      const run = taskRunsRef.current.get(launchedId)
      if (!run || (run.entries?.length ?? 0) === 0) {
        finalizeAndAdvance(launchedId, 'blocked')
      }
    }, LAUNCH_TIMEOUT_MS)
    return true
  }

  const startBoard = () => {
    if (runningRef.current || !dataRef.current) return
    runningRef.current = true
    setBoardRunning(true)
    launchNext(dataRef.current.tasks)
  }

  // Fold the just-finished card into `col`, then advance to the next todo card.
  const finalizeAndAdvance = (finishedId: string, col: BoardColumn) => {
    const base = dataRef.current
    if (!base) {
      stopBoard()
      return
    }
    const moved = base.tasks.map(t =>
      t.id === finishedId
        ? { ...t, boardColumn: col, done: col === 'done' ? true : t.done }
        : t,
    )
    currentIdRef.current = null
    setCurrentId(null)
    if (runningRef.current) launchNext(moved)
    else onPersist({ ...base, tasks: moved })
  }

  // Watch the current task; advance when it settles (debounced so an auto-loop
  // round starting doesn't look like completion). Cancelled = user took over →
  // stop the whole board.
  useEffect(() => {
    if (!boardRunning || !currentId) return
    // A run entry exists for the current card → the launch succeeded; disarm the
    // launch watchdog (the settle logic below now owns advancing).
    if ((taskRuns.get(currentId)?.entries?.length ?? 0) > 0) clearWatchdog()
    const kind = classifyTerminal(taskRuns.get(currentId))
    if (kind === 'live') {
      clearSettle()
      return
    }
    clearSettle()
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null
      if (!runningRef.current || currentIdRef.current !== currentId) return
      const settled = classifyTerminal(taskRunsRef.current.get(currentId))
      if (settled === 'live') return // auto-loop resumed — keep waiting
      if (settled === 'cancelled') {
        // leave the card in 実行中 for the user; stop launching new ones.
        stopBoard()
        return
      }
      finalizeAndAdvance(currentId, settled === 'done' ? 'done' : 'blocked')
    }, SETTLE_DEBOUNCE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskRuns, boardRunning, currentId])

  // Tidy timers on unmount (ProjectPanel teardown = project closed/switched).
  useEffect(
    () => () => {
      clearSettle()
      clearWatchdog()
    },
    [],
  )

  return { boardRunning, currentId, startBoard, stopBoard }
}

interface BoardTabProps {
  data: ProjectData
  taskRuns: Map<string, RunSession>
  boardRun: BoardRun
  onPersist: (next: ProjectData) => void
  onRunTask: (task: ProjectTask, opts?: RunTaskOpts) => void
  onCancelTask: (taskId: string) => void
  /** Open this task in the Chats tab (to answer a question / resolve a conflict
   *  / read the full transcript). */
  onOpenTask: (taskId: string) => void
  /** Jump to the Chats tab (used by the empty-board state — tasks are authored
   *  there, then appear here as cards). */
  onGoToChats: () => void
}

// The one-line reason shown under a card — surfaces WHY a card is blocked so the
// user can act (a pending question, a merge conflict, a reported blocker),
// falling back to the run's topic/summary.
const cardReason = (
  task: ProjectTask,
  status: CardStatus,
): { text: string; tone: 'reason' | 'muted' } | null => {
  const lr = task.latestRun
  if (status === 'conflict') return { text: 'マージ競合 — Chats で解決', tone: 'reason' }
  if (lr?.question?.trim()) return { text: `❓ ${lr.question.trim()}`, tone: 'reason' }
  if (columnOf(task) === 'blocked' && lr?.blockers?.trim())
    return { text: lr.blockers.trim(), tone: 'reason' }
  const topic = lr?.topic?.trim()
  const summary = lr?.summary?.trim()
  if (topic || summary) return { text: topic || summary!, tone: 'muted' }
  return null
}

export const BoardTab = ({
  data,
  taskRuns,
  boardRun,
  onPersist,
  onRunTask,
  onCancelTask,
  onOpenTask,
  onGoToChats,
}: BoardTabProps) => {
  const online = useOnlineStatus()
  const { boardRunning, startBoard, stopBoard } = boardRun
  const [dragId, setDragId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<BoardColumn | null>(null)

  // Group tasks by column, sorted by priority within each.
  const byColumn = useMemo(() => {
    const groups: Record<BoardColumn, ProjectTask[]> = {
      todo: [],
      doing: [],
      done: [],
      blocked: [],
    }
    for (const t of data.tasks) groups[columnOf(t)].push(t)
    for (const k of Object.keys(groups) as BoardColumn[]) groups[k].sort(byColumnOrder)
    return groups
  }, [data.tasks])

  // Move `id` into `col`, inserting before `beforeId` (or at the end). Reassigns
  // boardOrder = 0..n across the target column's resulting order so the stored
  // priority always matches what's on screen; the source column keeps its gaps
  // (harmless — order is relative).
  const moveCard = (id: string, col: BoardColumn, beforeId: string | null) => {
    const moving = data.tasks.find(t => t.id === id)
    if (!moving) return
    const target = byColumn[col].filter(t => t.id !== id)
    const idx = beforeId ? target.findIndex(t => t.id === beforeId) : -1
    const ordered = [...target]
    ordered.splice(idx < 0 ? ordered.length : idx, 0, moving)
    const orderById = new Map(ordered.map((t, i) => [t.id, i]))
    const tasks = data.tasks.map(t => {
      if (t.id === id) {
        // Keep done in sync with the column so dragging into 完了 marks it done
        // and dragging back out (todo/doing/blocked) reopens it.
        return { ...t, boardColumn: col, boardOrder: orderById.get(id), done: col === 'done' }
      }
      if (orderById.has(t.id)) return { ...t, boardOrder: orderById.get(t.id) }
      return t
    })
    onPersist({ ...data, tasks })
  }

  const onDropToColumn = (col: BoardColumn, beforeId: string | null) => {
    if (dragId) moveCard(dragId, col, beforeId)
    setDragId(null)
    setDropTarget(null)
  }

  const todoCount = byColumn.todo.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-8 py-3">
        <div className="flex items-center gap-2">
          <p className="label-cap text-ink-muted">
            ボード · <span className="tabular-nums">{data.tasks.length}</span> カード
          </p>
          {boardRunning && (
            <span className="inline-flex items-center gap-1 text-[11px] text-azure">
              <Loader2 size={11} strokeWidth={2.25} className="animate-spin" />
              実行中… このタブを開いている間に進みます
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={boardRunning ? stopBoard : startBoard}
          disabled={!online || (!boardRunning && todoCount === 0)}
          title={
            boardRunning
              ? '実行を停止（実行中のタスクはそのまま完了します）'
              : !online
                ? 'オフライン'
                : todoCount === 0
                  ? '未着手のカードがありません'
                  : '未着手を優先度順に上から1件ずつ実行'
          }
          className={[
            'inline-flex items-center gap-1.5 rounded-[3px] border px-3 py-1.5 text-[12px] font-medium transition-colors',
            boardRunning
              ? 'border-accent bg-accent text-white hover:bg-accent/90'
              : 'border-line bg-bg-card text-ink hover:bg-bg-inset hover:border-line-strong',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          ].join(' ')}
        >
          {boardRunning ? <Square size={12} strokeWidth={2.25} /> : <Play size={12} strokeWidth={2.25} />}
          {boardRunning ? 'ボードを停止' : `ボードを実行${todoCount > 0 ? ` (${todoCount})` : ''}`}
        </button>
      </div>

      {/* Empty whole-board state — tasks are authored in Chats. */}
      {data.tasks.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 pb-10 text-center">
          <Columns3 size={28} strokeWidth={1.5} className="text-ink-faint" />
          <p className="text-[13px] text-ink-muted leading-relaxed">
            まだタスクがありません。
            <br />
            Chats タブでタスクを作ると、ここに看板カードとして並びます。
          </p>
          <button
            type="button"
            onClick={onGoToChats}
            className="inline-flex items-center gap-1.5 rounded-[3px] border border-line bg-bg-card px-3 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-bg-inset hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            Chats でタスクを作る
          </button>
        </div>
      ) : (
      /* Columns */
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-8 pb-6">
        {COLUMNS.map(col => {
          const cards = byColumn[col.key]
          const isDropTarget = dropTarget === col.key
          return (
            <section
              key={col.key}
              onDragOver={e => {
                e.preventDefault()
                setDropTarget(col.key)
              }}
              onDragLeave={() => setDropTarget(prev => (prev === col.key ? null : prev))}
              onDrop={() => onDropToColumn(col.key, null)}
              className={[
                'flex min-h-0 w-[260px] shrink-0 flex-col rounded-[4px] border transition-colors',
                isDropTarget ? 'border-accent bg-accent/5' : 'border-line bg-bg-inset/40',
              ].join(' ')}
            >
              <header className="flex shrink-0 items-baseline justify-between gap-2 border-b border-line px-3 py-2">
                <span className="label-cap text-ink">
                  {col.label}{' '}
                  <span className="text-ink-faint tabular-nums">{cards.length}</span>
                </span>
                {col.hint && <span className="text-[10px] text-ink-faint">{col.hint}</span>}
              </header>

              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                {cards.length === 0 ? (
                  <p className="px-1 py-6 text-center text-[11px] text-ink-faint">
                    ここにドラッグ
                  </p>
                ) : (
                  cards.map(task => {
                    const status = deriveCardStatus(taskRuns.get(task.id))
                    const meta = STATUS_META[status]
                    const reason = cardReason(task, status)
                    return (
                      <article
                        key={task.id}
                        draggable
                        role="button"
                        tabIndex={0}
                        aria-label={`${task.title || '無題'} — ${COLUMNS.find(c => c.key === col.key)?.label}。Enter で開く`}
                        onClick={() => onOpenTask(task.id)}
                        onKeyDown={e => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onOpenTask(task.id)
                          }
                        }}
                        onDragStart={() => setDragId(task.id)}
                        onDragEnd={() => {
                          setDragId(null)
                          setDropTarget(null)
                        }}
                        onDragOver={e => {
                          e.preventDefault()
                          setDropTarget(col.key)
                        }}
                        onDrop={e => {
                          e.stopPropagation()
                          onDropToColumn(col.key, task.id)
                        }}
                        className={[
                          'group cursor-grab rounded-[3px] border border-line bg-bg-card p-2.5 shadow-card transition-colors hover:border-line-strong active:cursor-grabbing',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg-inset',
                          dragId === task.id ? 'opacity-40' : '',
                        ].join(' ')}
                      >
                        <div className="flex items-start gap-1.5">
                          <GripVertical
                            size={12}
                            className="mt-0.5 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-[12.5px] leading-snug text-ink line-clamp-2">
                              {task.title || '（無題）'}
                            </p>
                            {reason && (
                              <p
                                className={[
                                  'mt-1 text-[11px] leading-snug line-clamp-2',
                                  reason.tone === 'reason' ? 'text-accent' : 'text-ink-muted',
                                ].join(' ')}
                              >
                                {reason.text}
                              </p>
                            )}
                            <div className="mt-1.5 flex items-center gap-1.5">
                              {meta.label && (
                                <span
                                  className={[
                                    'inline-flex items-center gap-1 rounded-[3px] px-1.5 py-0.5 text-[10px] font-medium',
                                    meta.cls,
                                  ].join(' ')}
                                >
                                  {meta.icon}
                                  {meta.label}
                                </span>
                              )}
                              {status === 'running' && (
                                <button
                                  type="button"
                                  onClick={e => {
                                    e.stopPropagation()
                                    onCancelTask(task.id)
                                  }}
                                  className="rounded-[2px] px-1 text-[10px] text-ink-faint hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                                >
                                  停止
                                </button>
                              )}
                              {(status === 'idle' || status === 'done' || status === 'error' || status === 'conflict') &&
                                online && (
                                  <button
                                    type="button"
                                    onClick={e => {
                                      e.stopPropagation()
                                      onRunTask(task, BOARD_RUN_OPTS)
                                    }}
                                    className="rounded-[2px] px-1 text-[10px] text-ink-faint hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                                  >
                                    実行
                                  </button>
                                )}
                            </div>
                          </div>
                        </div>
                      </article>
                    )
                  })
                )}
              </div>
            </section>
          )
        })}
      </div>
      )}
    </div>
  )
}
