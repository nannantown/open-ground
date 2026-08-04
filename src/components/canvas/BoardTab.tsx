import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, Settings2 } from 'lucide-react'
import { BoardCard } from '@/components/canvas/BoardCard'
import {
  CLAUDE_EFFORTS,
  type BoardColumn,
  type ClaudeBeaconStatus,
  type ClaudeEffort,
  type MergedBranchStatus,
  type MergedBranchesRequest,
  type MergedBranchesResponse,
  type ProjectData,
  type ProjectTask,
} from '@/lib/types'
import { newId } from '@/lib/ids'
import { dependencyCycleIds, unresolvedDeps } from '@/lib/boardDeps'
import type { BoardCardWorker } from '@/lib/boardWorker'
import { TASK_MODEL_CHOICES } from '@/lib/claudeLaunchChoices'
import { CollabPresence, type PresenceChannel } from '@/components/canvas/CollabPresence'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string

// The run-defaults strip's quiet inline selects — one shared class so the
// four pickers can't drift apart visually.
const DEFAULTS_SELECT_CLS =
  'rounded-[3px] border border-line bg-bg px-1.5 py-1 text-meta text-ink-muted transition-colors hover:border-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-40'

// ─── Board tab ───────────────────────────────────────────────────────────────
// A kanban of task cards (one source of truth in the central tasks.json).
// Columns are workflow stages — five fixed lanes (todo / doing / review / done
// / blocked), the 'review' lane (PR-waiting, between doing and done) always
// shown; a card's vertical position WITHIN a column is its priority (top =
// highest). The user drags cards between columns; each card's ▶ button (in the
// detail drawer) launches an interactive claude terminal — there is no
// batch-run machinery anymore.

// The board column keys — the five fixed lanes, always shown.
export const boardColumnKeys = (): BoardColumn[] => [
  'todo',
  'doing',
  'review',
  'done',
  'blocked',
]

const COLUMN_LABEL_KEYS: Record<BoardColumn, MessageKey> = {
  todo: 'board.col.todo',
  doing: 'board.col.doing',
  review: 'board.col.review',
  done: 'board.col.done',
  blocked: 'board.col.blocked',
}

export const columns = (
  t: TFn,
): { key: BoardColumn; label: string; hint: string }[] =>
  boardColumnKeys().map(key => ({
    key,
    label: t(COLUMN_LABEL_KEYS[key]),
    hint:
      key === 'todo'
        ? t('board.col.todo.hint')
        : key === 'blocked'
          ? t('board.col.blocked.hint')
          : '',
  }))

// A task's column. Explicit boardColumn wins; otherwise fall back to its done
// flag so a task completed elsewhere shows in 完了 instead of stranding in
// 未着手, and a fresh task starts in 未着手.
export const columnOf = (t: ProjectTask): BoardColumn =>
  t.boardColumn ?? (t.done ? 'done' : 'todo')

// "Mine only" filter predicate: case-insensitive, whitespace-trimmed compare
// of the card's assignee against the user's display name. Either side empty →
// no match (an unassigned card is never "mine").
export const assigneeMatches = (
  assignee: string | undefined,
  displayName: string | null | undefined,
): boolean => {
  const a = (assignee ?? '').trim().toLowerCase()
  const d = (displayName ?? '').trim().toLowerCase()
  return a.length > 0 && a === d
}

// Bulk-clear the Done column (F073): drop every task that DISPLAYS in 完了 —
// explicit boardColumn 'done' or the legacy done-flag fallback (columnOf).
// Deliberately ignores the Mine-only / search filters: "clear Done" means the
// whole column, and the confirm dialog states the full count.
export const withDoneCleared = (data: ProjectData): ProjectData => ({
  ...data,
  tasks: data.tasks.filter(t => columnOf(t) !== 'done'),
})

// Duplicate a card in place (F020): the copy lands in the SAME column,
// DIRECTLY BELOW the source. Title gets a literal ' (copy)' suffix (both
// locales — it's a marker, not prose); notes + assignee carry over (same kind
// of work, same owner); id is fresh and branch / prUrl / reviewedBy /
// titleAuto are deliberately NOT copied — the duplicate is NEW work, so
// inheriting another card's session artifacts or review stamp would lie.
// `done` mirrors the column (the moveCard invariant): a copy landing in the
// Done column must read as done, anywhere else as open — a done:false card
// sitting in Done would diverge from every other done-column card.
// boardOrder is renumbered 0..n across the source's column (the moveCard
// convention) with the copy slotted right after the source; other columns are
// untouched. Unknown taskId → data returned unchanged.
export const withCardDuplicated = (data: ProjectData, taskId: string): ProjectData => {
  const srcIdx = data.tasks.findIndex(t => t.id === taskId)
  if (srcIdx < 0) return data
  const src = data.tasks[srcIdx]
  const col = columnOf(src)
  const dup: ProjectTask = {
    id: newId(),
    title: `${src.title} (copy)`,
    done: col === 'done',
    createdAt: new Date().toISOString(),
    boardColumn: col,
    ...(src.notes !== undefined ? { notes: src.notes } : {}),
    ...(src.assignee !== undefined ? { assignee: src.assignee } : {}),
  }
  // Renumber the column: existing cards in display priority order, the copy
  // spliced in right after the source.
  const colCards = data.tasks.filter(t => columnOf(t) === col).sort(byColumnOrder)
  const ordered = [...colCards]
  ordered.splice(colCards.findIndex(t => t.id === taskId) + 1, 0, dup)
  const orderById = new Map(ordered.map((t, i) => [t.id, i]))
  // Array position mirrors the board: insert directly after the source.
  const tasks = [...data.tasks]
  tasks.splice(srcIdx + 1, 0, dup)
  return {
    ...data,
    tasks: tasks.map(t =>
      orderById.has(t.id) ? { ...t, boardOrder: orderById.get(t.id) } : t,
    ),
  }
}

// The branches the merged-detection poll should ask about (B018/F065): the
// branch of every card SITTING IN the review column — deduped, sorted (a
// stable identity for the effect dependency) and capped at the API's limit.
export const reviewBranchesOf = (tasks: ProjectTask[]): string[] => {
  const set = new Set<string>()
  for (const t of tasks) {
    const b = t.branch?.trim()
    if (b && columnOf(t) === 'review') set.add(b)
  }
  return Array.from(set).sort().slice(0, 50)
}

// "Mine only" toggle persistence — per project, like the terminal slot list.
const MINE_ONLY_KEY = (projectId: string) => `openground.board.mineOnly.${projectId}`

const loadMineOnly = (projectId: string | undefined): boolean => {
  if (!projectId || typeof window === 'undefined') return false
  try {
    return localStorage.getItem(MINE_ONLY_KEY(projectId)) === '1'
  } catch {
    return false
  }
}

const saveMineOnly = (projectId: string | undefined, on: boolean) => {
  if (!projectId || typeof window === 'undefined') return
  try {
    localStorage.setItem(MINE_ONLY_KEY(projectId), on ? '1' : '0')
  } catch {}
}

// Run-defaults strip disclosure — collapsed by default so the board opens clean
// (these launch prefs are set-once, not per-glance). Persisted per project, like
// "Mine only": once a user expands it, it stays expanded for that board.
const DEFAULTS_OPEN_KEY = (projectId: string) => `openground.board.defaultsOpen.${projectId}`

const loadDefaultsOpen = (projectId: string | undefined): boolean => {
  if (!projectId || typeof window === 'undefined') return false
  try {
    return localStorage.getItem(DEFAULTS_OPEN_KEY(projectId)) === '1'
  } catch {
    return false
  }
}

const saveDefaultsOpen = (projectId: string | undefined, on: boolean) => {
  if (!projectId || typeof window === 'undefined') return
  try {
    localStorage.setItem(DEFAULTS_OPEN_KEY(projectId), on ? '1' : '0')
  } catch {}
}

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

// Move `id` into `col`, inserting before `beforeId` (or at the end). Reassigns
// boardOrder = 0..n across the target column's FULL card list (columnOf
// + byColumnOrder — the same grouping the board renders from), NOT just the
// currently visible cards: while a search / "Mine only" filter is active the
// visible list is a subset, and renumbering only that subset would hand a
// hidden card and the dropped one the same boardOrder (their relative order
// then flips on every re-sort). `beforeId` — a visible card — maps to its
// insertion slot within the full column; a null `beforeId` (drop at the end /
// the merged-chip's "→ Done") appends after EVERY card in the column,
// including hidden ones. The source column keeps its gaps (harmless — order
// is relative).
export const withCardMoved = (
  data: ProjectData,
  id: string,
  col: BoardColumn,
  beforeId: string | null,
): ProjectData => {
  const moving = data.tasks.find(t => t.id === id)
  if (!moving) return data
  const target = data.tasks
    .filter(t => t.id !== id && columnOf(t) === col)
    .sort(byColumnOrder)
  const idx = beforeId ? target.findIndex(t => t.id === beforeId) : -1
  const ordered = [...target]
  ordered.splice(idx < 0 ? ordered.length : idx, 0, moving)
  const orderById = new Map(ordered.map((t, i) => [t.id, i]))
  const tasks = data.tasks.map(t => {
    if (t.id === id) {
      // Keep done in sync with the column so dragging into 完了 marks it done
      // and dragging back out (todo/doing/blocked) reopens it.
      // Moving back to an active column is a rework round — a stale
      // "reviewed" stamp would vouch for code that's about to change.
      const reviewedBy =
        col === 'todo' || col === 'doing' || col === 'blocked' ? undefined : t.reviewedBy
      // The commander engine's "needs manual integration" stamp (Card③) is only
      // meaningful while the card sits in review — any move out of it (rework or
      // completion) clears it, mirroring reviewedBy.
      const integrationConflict = col === 'review' ? t.integrationConflict : undefined
      return {
        ...t,
        boardColumn: col,
        boardOrder: orderById.get(id),
        done: col === 'done',
        reviewedBy,
        integrationConflict,
      }
    }
    if (orderById.has(t.id)) return { ...t, boardOrder: orderById.get(t.id) }
    return t
  })
  return { ...data, tasks }
}

interface BoardTabProps {
  data: ProjectData
  onPersist: (next: ProjectData) => void
  /** Open this task's conversation in the Board's in-tab detail drawer. */
  onOpenTask: (taskId: string) => void
  /** Create an empty plan card in `column` and return its id. The Board is
   *  self-contained — tasks are authored here. The card's detail drawer is
   *  then opened so the user types the title in a roomy field. */
  onCreateTask: (column: BoardColumn) => string
  /** The project folder is gone from disk — block card creation (a terminal
   *  launch into a missing cwd would just fail). */
  projectMissing?: boolean
  /** The project is a git repo — shows the completion-flow default (merge/PR
   *  is meaningless without git) in the run-defaults strip. */
  hasGit?: boolean
  /** Registry UUID — keys the per-project "Mine only" toggle in localStorage. */
  projectId?: string
  /** Absolute project path — needed by the merged-branch poll (B018). Unset
   *  disables the poll entirely (back-compat for plain hosts). */
  projectPath?: string
  /** The user's display name (Settings.displayName). Unset hides the
   *  "Mine only" filter entirely — there is nothing to compare against. */
  displayName?: string | null
  /** The card whose detail drawer is open — rendered in a selected state so
   *  the board always shows WHICH card the drawer belongs to. */
  openTaskId?: string | null
  /** Open the Project Settings dialog. Optional — unset renders no settings
   *  affordance (back-compat for hosts without the dialog). */
  onOpenProjectSettings?: () => void
  /** The task's live claude pane status — the card face carries the same
   *  marking as the Ground cards (flow F036): a coloured band along its top
   *  edge plus a "Running"/"Waiting" stamp at the head of the title. null =
   *  no live session. Optional: plain callers show no marking. */
  sessionStatus?: (taskId: string) => ClaudeBeaconStatus | null
  /** The swarm worker the commander engine dispatched onto this doing card, or
   *  null when none owns it (the ordinary case — plain cards show nothing).
   *  Read-only + owner-gated UPSTREAM (the orchestrator poll 403s for non-owners
   *  → this returns null for everyone but the owner). Drives the doing card's
   *  worker info strip + the "something is running here" band synced to the
   *  worker's live activity. Unset on plain hosts (no swarm surface). */
  workerForTask?: (taskId: string) => BoardCardWorker | null
  /** Realtime presence channel for this project's board room (u15). The owner
   *  passes their board collab binding; null when collab is OFF / not a member.
   *  Drives the toolbar avatar strip — publishes self, shows the other peers. */
  presence?: PresenceChannel | null
}

export const BoardTab = ({
  data,
  onPersist,
  onOpenTask,
  onCreateTask,
  projectMissing,
  hasGit,
  projectId,
  projectPath,
  displayName,
  openTaskId,
  onOpenProjectSettings,
  sessionStatus,
  workerForTask,
  presence,
}: BoardTabProps) => {
  const { t } = useT()
  const COLUMNS = useMemo(() => columns(t), [t])
  const [dragId, setDragId] = useState<string | null>(null)
  // Trello-style live feedback: while dragging, the source card collapses
  // (hidden one frame after dragstart — hiding it synchronously would cancel
  // the native drag) and a same-height dashed placeholder occupies the
  // would-be insertion slot, physically pushing the other cards aside so the
  // landing position is visible the whole time.
  const [dragHeight, setDragHeight] = useState(0)
  const [dragHidden, setDragHidden] = useState(false)
  const [dropPos, setDropPos] = useState<{ col: BoardColumn; index: number } | null>(null)
  // The card whose title is being typed inline (kept as a fallback editor —
  // creation opens the detail drawer instead).
  const [editingId, setEditingId] = useState<string | null>(null)

  // "Add a card" → create an empty card and OPEN ITS DETAIL DRAWER, where the
  // title is typed in a roomy field. (An untouched card the user abandons is
  // cleaned up from the drawer instead — see BoardModule.)
  const addCard = (col: BoardColumn) => onOpenTask(onCreateTask(col))

  // Mutable mirrors of the latest data / persist / drag state. The per-card
  // callbacks below are wrapped in useCallback with EMPTY dep arrays so their
  // identity is stable across renders (that stability is precisely what lets the
  // memoized BoardCard skip untouched cards); they read current values through
  // these refs instead of closing over render-scoped values. `byColumnRef` is
  // assigned just after byColumn is computed, below.
  const dataRef = useRef(data)
  dataRef.current = data
  const onPersistRef = useRef(onPersist)
  onPersistRef.current = onPersist
  const dragIdRef = useRef(dragId)
  dragIdRef.current = dragId
  const dropPosRef = useRef(dropPos)
  dropPosRef.current = dropPos
  const byColumnRef = useRef<Record<BoardColumn, ProjectTask[]> | null>(null)

  // "Mine only": show just the cards assigned to me. Offered only when the
  // user has a display name to compare against; persisted per project.
  const [mineOnly, setMineOnly] = useState(() => loadMineOnly(projectId))
  // The panel is reused across project switches (no key), so re-load this
  // project's saved toggle whenever the project changes.
  useEffect(() => {
    setMineOnly(loadMineOnly(projectId))
  }, [projectId])
  const hasDisplayName = !!displayName?.trim()
  // The toggle only means something once at least one card carries an
  // assignee — with none, "Mine only" can match nothing. Hide the button until
  // then, and neutralize a stale saved toggle so cards never silently vanish.
  const hasAssignees = data.tasks.some(task => !!task.assignee?.trim())
  const filterActive = mineOnly && hasDisplayName && hasAssignees
  const toggleMineOnly = () => {
    setMineOnly(prev => {
      saveMineOnly(projectId, !prev)
      return !prev
    })
  }

  // Run-defaults strip: collapsed by default, expand to reveal the pickers.
  // Persisted per project (same lifecycle as "Mine only" above).
  const [defaultsOpen, setDefaultsOpen] = useState(() => loadDefaultsOpen(projectId))
  useEffect(() => {
    setDefaultsOpen(loadDefaultsOpen(projectId))
  }, [projectId])
  const toggleDefaultsOpen = () => {
    setDefaultsOpen(prev => {
      saveDefaultsOpen(projectId, !prev)
      return !prev
    })
  }

  // Merged-branch detection (B018 / F065): while the review column holds
  // branch-carrying cards, ask the server (mount + every 60s) which of those
  // branches already landed in the target branch. Same power etiquette as the
  // Ground beacon poll: a hidden document skips the round (the next visible
  // tick refreshes). Nothing moves automatically — a 'merged' verdict only
  // renders a chip + an explicit "→ Done" button (F050: no surprise moves).
  const [mergedByBranch, setMergedByBranch] = useState<Record<string, MergedBranchStatus>>({})
  const reviewBranches = useMemo(
    () => reviewBranchesOf(data.tasks),
    [data.tasks],
  )
  const reviewBranchesKey = reviewBranches.join('\n')
  const targetBranch = data.config?.targetBranch
  useEffect(() => {
    // Review column empty (or off / no path / project gone) → no poll at all.
    if (!projectPath || projectMissing || reviewBranches.length === 0) {
      setMergedByBranch({})
      return
    }
    let cancelled = false
    const check = async () => {
      if (document.hidden) return
      try {
        const body: MergedBranchesRequest = {
          path: projectPath,
          branches: reviewBranches,
          ...(targetBranch?.trim() ? { targetBranch } : {}),
        }
        const res = await fetch('/api/project/merged-branches', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) return
        const json = (await res.json()) as MergedBranchesResponse
        if (!cancelled) setMergedByBranch(json)
      } catch {
        // Offline / server gone — keep the last verdicts; the next tick retries.
      }
    }
    void check()
    const id = window.setInterval(() => void check(), 60_000)
    return () => {
      cancelled = true
      window.clearInterval(id)
    }
    // reviewBranchesKey is the stable identity of reviewBranches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, projectMissing, reviewBranchesKey, targetBranch])


  // Group tasks by column, sorted by priority within each. Every task IS a
  // Board card now (legacy chat/assistant items are dropped on read). The
  // Mine-only filter narrows what renders, never what persists.
  const boardTasks = data.tasks
  const visibleTasks = useMemo(
    () =>
      boardTasks.filter(
        task => !filterActive || assigneeMatches(task.assignee, displayName),
      ),
    [boardTasks, filterActive, displayName],
  )
  const byColumn = useMemo(() => {
    const groups: Record<BoardColumn, ProjectTask[]> = {
      todo: [],
      doing: [],
      review: [],
      done: [],
      blocked: [],
    }
    for (const t of visibleTasks) groups[columnOf(t)].push(t)
    for (const k of Object.keys(groups) as BoardColumn[]) groups[k].sort(byColumnOrder)
    return groups
  }, [visibleTasks])
  byColumnRef.current = byColumn

  // One id → task lookup per render, shared by every card's unresolvedDeps call.
  // Built once over ALL tasks (the dep target may be filtered out of the visible
  // view) — this is what collapses the old per-card `new Map(tasks.map(...))`
  // (O(N²) per board render, on every drag frame) back to O(N).
  const tasksById = useMemo(
    () => new Map(boardTasks.map(task => [task.id, task] as const)),
    [boardTasks],
  )

  // Card ids sitting on a dependency CYCLE (A→B→…→A). The swarm's ⑤ DEPENDS gate
  // would hold these forever — a silent deadlock — so each one's face shows a ⚠
  // warning chip. Computed over ALL board tasks (not the mine-only visibleTasks
  // slice) so a loop running through a filtered-out card still warns. See
  // dependencyCycleIds.
  const cycleIds = useMemo(() => dependencyCycleIds(boardTasks), [boardTasks])

  // ── Stable per-card callbacks (empty deps; live state read via refs) ───────
  // Identity stability here is what makes <BoardCard>'s memo effective — a fresh
  // closure each render would re-render all N cards. The drag-hover slot is set
  // through `setDrop` with an equality guard so a dragover that doesn't move the
  // slot is a true no-op; dropPos is NOT a BoardCard prop, so a slot change
  // re-renders the board shell (placeholder) but not the cards.

  // Move `id` into `col`, inserting before `beforeId` (or at the end). Pure
  // logic lives in withCardMoved — crucially it renumbers over the column's
  // FULL card list (not the filtered/visible byColumn slice), so a drag while
  // search / "Mine only" is active can never assign a hidden card and the
  // dropped one the same boardOrder.
  const moveCard = useCallback((id: string, col: BoardColumn, beforeId: string | null) => {
    const next = withCardMoved(dataRef.current, id, col, beforeId)
    if (next !== dataRef.current) onPersistRef.current(next)
  }, [])

  const endDrag = useCallback(() => {
    setDragId(null)
    setDragHidden(false)
    setDropPos(null)
  }, [])

  const handleDragStart = useCallback((taskId: string, height: number) => {
    setDragId(taskId)
    setDragHeight(height)
    // Hide the source AFTER the browser captured its drag image — hiding
    // synchronously cancels the native drag.
    setTimeout(() => setDragHidden(true), 0)
  }, [])

  // Park the drop slot at {col,index} — but BAIL OUT when it is already there.
  // dragover fires ~30-60/s; without this guard each fire set a NEW object even
  // when col+index were unchanged, forcing a board re-render every frame.
  // Returning the previous reference makes React skip the update entirely.
  const setDrop = useCallback((col: BoardColumn, index: number) => {
    setDropPos(prev => (prev && prev.col === col && prev.index === index ? prev : { col, index }))
  }, [])

  // Drop lands where the placeholder is: `index` counts positions in the
  // column's visible cards EXCLUDING the dragged one (the same list the
  // placeholder is rendered into).
  const commitDrop = useCallback(() => {
    const draggingId = dragIdRef.current
    const slot = dropPosRef.current
    const cols = byColumnRef.current
    if (draggingId && slot && cols) {
      const others = cols[slot.col].filter(tk => tk.id !== draggingId)
      moveCard(draggingId, slot.col, others[slot.index]?.id ?? null)
    }
    endDrag()
  }, [moveCard, endDrag])

  // Card-face duplicate (F020).
  const handleDuplicate = useCallback((taskId: string) => {
    onPersistRef.current(withCardDuplicated(dataRef.current, taskId))
  }, [])

  // Merged chip "→ Done": move the card to the done column (F050 — explicit).
  const handleMoveToDone = useCallback((taskId: string) => {
    moveCard(taskId, 'done', null)
  }, [moveCard])

  // Review stamp set/clear (F062). `value === undefined` clears it.
  const handleSetReviewedBy = useCallback((taskId: string, value: string | undefined) => {
    const cur = dataRef.current
    onPersistRef.current({
      ...cur,
      tasks: cur.tasks.map(x => (x.id === taskId ? { ...x, reviewedBy: value } : x)),
    })
  }, [])

  // Commit an inline title edit (vestigial fallback editor). Empty (trimmed) →
  // the card is removed, so a card the user added but never named never lingers.
  // Otherwise save the title.
  const handleCommitTitle = useCallback(
    (taskId: string, currentTitle: string, raw: string) => {
      setEditingId(null)
      const title = raw.trim()
      const cur = dataRef.current
      if (!title) {
        onPersistRef.current({ ...cur, tasks: cur.tasks.filter(x => x.id !== taskId) })
        return
      }
      if (title !== currentTitle)
        onPersistRef.current({
          ...cur,
          tasks: cur.tasks.map(x => (x.id === taskId ? { ...x, title } : x)),
        })
    },
    [],
  )

  // Bulk-clear the Done column (F073). Counts EVERY done card (filters
  // ignored — the whole column goes), confirms (destructive + shared: on a
  // git-shared board the deletion syncs to everyone), then persists.
  const doneTotal = data.tasks.filter(t => columnOf(t) === 'done').length
  const clearDone = () => {
    if (doneTotal === 0) return
    if (!window.confirm(t('board.toolbar.clearDoneConfirm', { count: doneTotal }))) return
    onPersist(withDoneCleared(data))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 items-center justify-between gap-3 px-7 pb-2.5 pt-3.5">
        <div className="flex items-center gap-3">
          <p className="label-cap text-ink-muted">
            {t('board.toolbar.count', { count: visibleTasks.length })}
          </p>
          {/* "Mine only" — text-only filter toggle. Rendered only once some
              card has an assignee (with none it can match nothing). Needs a
              display name to match against; without one the toggle shows but
              disabled, pointing at Settings (S36). */}
          {hasAssignees && (
            <button
              type="button"
              aria-pressed={mineOnly}
              onClick={hasDisplayName ? toggleMineOnly : undefined}
              disabled={!hasDisplayName}
              title={hasDisplayName ? undefined : t('board.toolbar.mineOnlyNeedsName')}
              className={[
                'rounded-sm border px-2.5 py-1 text-meta transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                !hasDisplayName
                  ? 'cursor-not-allowed border-line text-ink-faint opacity-50'
                  : mineOnly
                    ? 'border-accent bg-accent text-bg-card hover:bg-accent-hover'
                    : 'border-line text-ink-muted hover:bg-plane hover:text-ink active:bg-plane active:text-ink',
              ].join(' ')}
            >
              {t('board.toolbar.mineOnly')}
            </button>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Presence (u15) — who else is in this project's board room right now.
              Renders nothing unless collab is live and a peer is present. */}
          <CollabPresence channel={presence ?? null} />
          {/* Project settings — surfaces the dialog that used to hide behind
              the ⋯ menu. Quiet text+icon button, same register as the review
              toggle's label. */}
          {onOpenProjectSettings && (
            <button
              type="button"
              onClick={onOpenProjectSettings}
              disabled={projectMissing}
              title={t('board.toolbar.projectSettings')}
              className="flex items-center gap-1.5 rounded-sm px-1 py-1 text-meta text-ink-muted transition-colors hover:text-ink active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-muted"
            >
              <Settings2 size={13} className="shrink-0" />
              {t('board.toolbar.projectSettings')}
            </button>
          )}
        </div>
      </div>

      {/* Run-defaults strip — the board-wide launch profile (the drawer's
          per-card settings inherit these; the dedicated Personal rows left the
          settings dialog for this strip, 2026-06-12). COLLAPSED by default —
          these are set-once prefs, so the label is a disclosure toggle and the
          pickers only render when expanded (state persisted per project). Every
          select autosaves: completion flow is SHARED policy (config), model /
          effort / permission mode are PERSONAL launch prefs (central, never in
          the repo). */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 px-8 pb-2">
        <button
          type="button"
          onClick={toggleDefaultsOpen}
          aria-expanded={defaultsOpen}
          title={t('board.defaults.title')}
          className="label-cap flex items-center gap-1 rounded-sm text-ink-faint transition-colors hover:text-ink-muted active:text-ink-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ChevronRight
            size={11}
            aria-hidden
            className={['shrink-0 transition-transform', defaultsOpen ? 'rotate-90' : ''].join(' ')}
          />
          {t('board.defaults.label')}
        </button>
        {defaultsOpen && (
          <>
            {hasGit && (
              <label className="flex items-center gap-1 text-micro text-ink-faint">
                {t('board.run.flowLabel')}
                <select
                  value={data.config?.completionFlow ?? 'merge'}
                  disabled={projectMissing}
                  onChange={e =>
                    onPersist({
                      ...data,
                      config: {
                        ...data.config,
                        completionFlow: e.target.value === 'pr' ? 'pr' : 'merge',
                      },
                    })
                  }
                  className={DEFAULTS_SELECT_CLS}
                >
                  <option value="merge">{t('board.run.flowMerge')}</option>
                  <option value="pr">{t('board.run.flowPr')}</option>
                </select>
              </label>
            )}
            <label className="flex items-center gap-1 text-micro text-ink-faint">
              {t('board.run.modelLabel')}
              <select
                value={data.launch?.model ?? ''}
                disabled={projectMissing}
                onChange={e =>
                  onPersist({
                    ...data,
                    launch: { ...data.launch, model: e.target.value || undefined },
                  })
                }
                className={DEFAULTS_SELECT_CLS}
              >
                <option value="">{t('board.defaults.cliDefault')}</option>
                {(data.launch?.model && !TASK_MODEL_CHOICES.includes(data.launch.model)
                  ? [data.launch.model, ...TASK_MODEL_CHOICES]
                  : TASK_MODEL_CHOICES
                ).map(m => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-micro text-ink-faint">
              {t('board.run.effortLabel')}
              <select
                value={data.launch?.effort ?? ''}
                disabled={projectMissing}
                onChange={e =>
                  onPersist({
                    ...data,
                    launch: {
                      ...data.launch,
                      effort: CLAUDE_EFFORTS.includes(e.target.value as ClaudeEffort)
                        ? (e.target.value as ClaudeEffort)
                        : undefined,
                    },
                  })
                }
                className={DEFAULTS_SELECT_CLS}
              >
                <option value="">{t('board.defaults.cliDefault')}</option>
                {CLAUDE_EFFORTS.map(lv => (
                  <option key={lv} value={lv}>
                    {lv}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1 text-micro text-ink-faint">
              {t('board.defaults.permLabel')}
              <select
                value={data.launch?.permissionMode ?? 'default'}
                disabled={projectMissing}
                onChange={e => {
                  const v = e.target.value
                  onPersist({
                    ...data,
                    launch: {
                      ...data.launch,
                      permissionMode:
                        v === 'acceptEdits' || v === 'plan' || v === 'bypass' ? v : undefined,
                    },
                  })
                }}
                className={DEFAULTS_SELECT_CLS}
              >
                <option value="default">{t('projectPanel.settingsPermDefault')}</option>
                <option value="acceptEdits">{t('projectPanel.settingsPermAcceptEdits')}</option>
                <option value="plan">{t('projectPanel.settingsPermPlan')}</option>
                <option value="bypass">{t('projectPanel.settingsPermBypass')}</option>
              </select>
            </label>
          </>
        )}
      </div>

      {/* Columns — always rendered, even at 0 cards, so the lane structure tasks
          flow into is visible from the very first visit. Tasks are authored
          RIGHT HERE on the Board. */}
      {/* First-run guide — one quiet line of "what happens here" while the
          board is empty (F089). Vanishes with the first card. */}
      {data.tasks.length === 0 && (
        <p className="shrink-0 px-8 pb-3 text-meta leading-relaxed text-ink-faint">
          {t('board.empty.guide')}
        </p>
      )}
      {/* 案C: 5 equal columns filling the width (`.board { gap:14px; padding:0 20px 20px }`).
          Fixed 260px columns + overflow-x meant the 5th column fell off a 1280px
          window — the mock has no horizontal scroll.
          BUT equal-split with no FLOOR is how the columns got crushed: with the
          card drawer open on a 1280px window each column lands at ~125px, and
          every Japanese label inside (「クリア」「＋ カードを追加」) had to fold or
          clip. The floor is the width at which those labels fit; below it the
          row scrolls instead of squeezing. On any window wide enough — which is
          the normal case, and the only case the mock drew — nothing scrolls and
          the split stays equal, so this costs the mock nothing.
          166, not 150 (2026-08-04): the floor was cut for 11px labels, and the
          type scale moved them to 13px. A floor is only a floor for the type it
          was measured against — when the type moves, it moves. */}
      <div className="no-scrollbar flex min-h-0 flex-1 gap-3.5 overflow-x-auto px-5 pb-5">
        {COLUMNS.map(col => {
          const cards = byColumn[col.key]
          // The column's end-of-list drop index = count of non-source cards.
          // A count, not a filtered array, so no per-render allocation (#5).
          const othersCount = dragId
            ? cards.reduce((n, c) => (c.id !== dragId ? n + 1 : n), 0)
            : cards.length
          const isDropTarget = dropPos?.col === col.key
          const placeholderIndex = isDropTarget ? dropPos.index : -1
          const renderCard = (task: ProjectTask, visIdx: number) => {
            // Resolve everything board-wide a card needs into PRIMITIVES, so the
            // memoized BoardCard can shallow-compare and skip when unchanged.
            // (Passing the raw status functions / data array would make the memo
            // inert — a fresh value every render re-renders all N cards.)
            const claudeStatus = sessionStatus?.(task.id) ?? null
            // The swarm worker dispatched onto this card — ONLY in the doing
            // column (a finished worker's card has already moved to review), and
            // ONLY for the owner (the orchestrator poll 403s otherwise → null).
            const worker = col.key === 'doing' ? workerForTask?.(task.id) ?? null : null
            // O(N) total this render: one shared id→task map, no per-card rebuild.
            const blockedBy = unresolvedDeps(task, tasksById)
            return (
              <BoardCard
                key={task.id}
                task={task}
                columnKey={col.key}
                columnLabel={col.label}
                visIdx={visIdx}
                isEditing={task.id === editingId}
                isSelected={task.id === openTaskId}
                isDragHidden={dragId === task.id && dragHidden}
                projectMissing={!!projectMissing}
                claudeStatus={claudeStatus}
                workerActivity={worker?.activity ?? null}
                workerBranch={worker?.branch}
                workerPhase={worker?.phase}
                workerNote={worker?.note}
                depCount={blockedBy.length}
                depTitlesText={blockedBy
                  .map(d => d.title.trim() || t('board.card.untitledParen'))
                  .join(', ')}
                inCycle={cycleIds.has(task.id)}
                isMerged={!!(task.branch && mergedByBranch[task.branch] === 'merged')}
                displayName={displayName}
                onOpenTask={onOpenTask}
                onDragStartCard={handleDragStart}
                onDragEndCard={endDrag}
                onDragOverCard={setDrop}
                onDropCard={commitDrop}
                onDuplicate={handleDuplicate}
                onCommitTitle={handleCommitTitle}
                onSetReviewedBy={handleSetReviewedBy}
                onMoveToDone={handleMoveToDone}
              />
            )
          }
          return (
            <section
              key={col.key}
              onDragOver={e => {
                e.preventDefault()
                // Card-level handlers (capture the precise slot) run first and
                // stop propagation; reaching here means the pointer is over
                // column chrome / empty space → park the slot at the end.
                setDrop(col.key, othersCount)
              }}
              onDrop={e => {
                e.preventDefault()
                commitDrop()
              }}
              className={[
                // 計器盤 language: columns are borderless WELLS — the surface
                // lightness difference (bg-inset vs the page) is the boundary.
                // The drop target keeps its accent signal as a ring (no border,
                // no layout shift).
                'flex min-h-0 min-w-[166px] flex-1 flex-col rounded-xl px-2.5 pb-2.5 pt-3 transition-colors',
                isDropTarget ? 'bg-accent/5 ring-1 ring-accent' : 'bg-bg-inset',
              ].join(' ')}
            >
              <header className="flex shrink-0 items-center justify-between gap-2 px-1.5 pb-1.5">
                {/* ⚠ NO TRACKING, AND NEVER WRAP (2026-08-04, owner report: 「判断待ち」
                    was breaking into 判断 / 待ち). Japanese breaks between ANY two
                    characters — there are no word boundaries to protect a short
                    label — and letter-spacing widens every gap, so a 4-character
                    name plus its count outgrew a column that also carries a hint.
                    The mock's 0.14em was measured on LATIN small caps; carrying it
                    over to 和文 buys nothing and costs the line. `shrink-0` keeps
                    the name whole and lets the hint beside it give way instead. */}
                <span className="flex shrink-0 items-center gap-[7px] whitespace-nowrap text-meta font-semibold text-ink-muted">
                  {/* Instrument lamp: lit only while the column carries work
                      that means something is HAPPENING or WAITING ON YOU —
                      doing=moss, review=azure, blocked=ochre. Neutral when
                      empty or for the passive lanes (todo/done). */}
                  {/* The mock draws a lamp ONLY on the lanes that can mean
                      「動いている」/「あなた待ち」 — todo and done carry none at all.
                      A lit lamp GLOWS; that glow is the 計器盤's signature. The
                      colour vocabulary is three: 稼働=苔 / 待ち=黄土 / 高=朱. */}
                  {(col.key === 'doing' || col.key === 'review' || col.key === 'blocked') && (
                    <span
                      aria-hidden
                      className={[
                        'inline-block h-1.5 w-1.5 rounded-full',
                        cards.length === 0
                          ? 'bg-ink/[0.18]'
                          : col.key === 'doing'
                            ? 'bg-moss shadow-lamp-moss'
                            : 'bg-ochre shadow-lamp-ochre',
                      ].join(' ')}
                    />
                  )}
                  {col.label}{' '}
                  <span className="font-mono text-meta font-normal text-ink-muted">
                    {cards.length}
                  </span>
                </span>
                {/* Text-diet: the todo mechanics note moved into a tooltip on the
                    column label; the blocked column's hint stays VISIBLE — it is a
                    decision cue (「あなたの判断待ち」), not mechanics. It is rendered
                    BELOW this row, not beside the name — see the note there. */}
                {col.hint && col.key !== 'blocked' ? (
                  <span title={col.hint} className="cursor-help text-micro text-ink-faint" aria-label={col.hint}>
                    ⓘ
                  </span>
                ) : null}
                {/* Bulk-clear (F073) — small text button, shown only while the
                    Done column holds any card (counted over ALL tasks, not the
                    filtered view: clearing always empties the whole column). */}
                {col.key === 'done' && doneTotal > 0 && (
                  <button
                    type="button"
                    onClick={clearDone}
                    disabled={projectMissing}
                    title={t('board.toolbar.clearDoneTitle')}
                    className="shrink-0 whitespace-nowrap rounded-full px-2.5 py-[3px] text-meta text-ink-muted transition-colors hover:bg-plane hover:text-ink active:bg-plane active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
                  >
                    {t('board.toolbar.clearDone')}
                  </button>
                )}
              </header>
              {/* The 判断待ち cue on its OWN line. It shared the header row until
                  2026-08-04 and lost: the name is `shrink-0`, so all the squeeze
                  landed here and 22 characters were truncated to five — a cue
                  nobody could read is not a cue. It is a SENTENCE, not a label,
                  so unlike the names above it is allowed to wrap; what was never
                  acceptable was folding short labels, not wrapping prose. */}
              {col.hint && col.key === 'blocked' ? (
                <p className="shrink-0 px-1.5 pb-1.5 text-micro leading-snug text-ink-subtle">
                  {col.hint}
                </p>
              ) : null}

              {/* Empty columns show no placeholder text: dragging a card over a
                  column already highlights it as a drop target, and the
                  "+ Add a card" composer below covers authoring. */}
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                {(() => {
                  // While dragging: every card renders IN ITS ORIGINAL ARRAY
                  // POSITION (the drag-source node must never move in the DOM —
                  // Chrome aborts a native drag the instant its source
                  // relocates; it merely turns display:none). The dashed
                  // placeholder is spliced in at the live slot, indexed over
                  // the VISIBLE (non-source) sequence.
                  const placeholder = (key: string) => (
                    <div
                      key={key}
                      style={{ height: Math.max(dragHeight, 36) }}
                      onDragOver={e => {
                        e.preventDefault()
                        // The cursor sitting ON the placeholder means the slot
                        // is already right — stop the event here, or it bubbles
                        // to the column handler which re-parks the slot at the
                        // END of the list (visible as the placeholder jumping
                        // away from under the cursor).
                        e.stopPropagation()
                      }}
                      onDrop={e => {
                        e.preventDefault()
                        e.stopPropagation()
                        commitDrop()
                      }}
                      className="rounded-[3px] border border-dashed border-accent/60 bg-accent/5"
                    />
                  )
                  const rendered: ReactNode[] = []
                  let vis = 0
                  for (const task of cards) {
                    const isSource = task.id === dragId
                    if (!isSource && dragId && placeholderIndex === vis) {
                      rendered.push(placeholder(`ph-${vis}`))
                    }
                    rendered.push(renderCard(task, isSource ? -1 : vis))
                    if (!isSource) vis++
                  }
                  if (dragId && placeholderIndex >= vis) rendered.push(placeholder('ph-end'))
                  return rendered
                })()}
                <AddCardButton
                  disabled={!!projectMissing}
                  onAdd={() => addCard(col.key)}
                />
              </div>
            </section>
          )
        })}
      </div>
    </div>
  )
}

// "Add a card" button at the bottom of a column. Clicking it creates a real
// (empty) card in this column and opens its detail drawer — the user types the
// title there.
const AddCardButton = ({
  disabled,
  onAdd,
}: {
  disabled?: boolean
  onAdd: () => void
}) => {
  const { t } = useT()
  return (
    <div className="pt-2">
      {/* 案C `.add-card`: a faint FACE of its own (cream 4%), 10px radius, 11px
          padding, centred. It used to be transparent with a hover that filled it
          with the CARD colour — which read as "a card appeared", not "a place to
          add one". */}
      <button
        type="button"
        disabled={disabled}
        onClick={onAdd}
        className="w-full whitespace-nowrap rounded-[10px] bg-ink/[0.04] p-[11px] text-center text-ui text-ink-muted transition-colors hover:bg-ink/[0.09] hover:text-ink active:bg-ink/[0.13] active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-ink/[0.04] disabled:hover:text-ink-muted"
      >
        {t('board.composer.placeholder')}
      </button>
    </div>
  )
}
