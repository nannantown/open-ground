import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Copy, GripVertical, Settings2 } from 'lucide-react'
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
import { formatDueShort, isOverdue, unresolvedDeps } from '@/lib/boardDeps'
import type { BoardCardWorker, WorkerActivity } from '@/lib/boardWorker'
import { TASK_MODEL_CHOICES } from '@/lib/claudeLaunchChoices'
import { CollabPresence, type PresenceChannel } from '@/components/canvas/CollabPresence'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string

// The run-defaults strip's quiet inline selects — one shared class so the
// four pickers can't drift apart visually.
const DEFAULTS_SELECT_CLS =
  'rounded-[3px] border border-line bg-bg px-1.5 py-1 text-[11px] text-ink-muted transition-colors hover:border-ink-faint focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-40'

// ── Swarm worker status vocabulary (doing-column cards) ──────────────────────
// The SAME beacon palette the Ground/Board cards + the SwarmWorkerPane already
// use: azure = working, ochre = waiting, ink-faint = booting/idle, moss = done.
// Display-only (the strip carries no interactions) — these are status colours,
// so contrast on the paper card (azure/ochre/moss/ink-faint all clear AA) is the
// only CLAUDE.md rule that bites here.
const WORKER_BAND: Record<WorkerActivity, string> = {
  working: 'bg-azure',
  waiting: 'bg-ochre',
  starting: 'bg-ink-faint',
  done: 'bg-moss',
}
const WORKER_DOT: Record<WorkerActivity, string> = {
  working: 'bg-azure',
  waiting: 'bg-ochre',
  starting: 'bg-ink-faint',
  done: 'bg-moss',
}
const WORKER_LABEL_CLS: Record<WorkerActivity, string> = {
  working: 'text-azure',
  waiting: 'text-[var(--beacon-waiting)]',
  starting: 'text-ink-faint',
  done: 'text-moss',
}
// Localized via the SAME keys the Swarm Manager monitor + worker pane use, so a
// JA owner sees 稼働中 / 待機中 / 起動中 / 完了 — not a board-only English island.
const WORKER_LABEL_KEY: Record<WorkerActivity, MessageKey> = {
  working: 'projectPanel.swarm.manager.stageRunning',
  waiting: 'projectPanel.swarm.statusWaiting',
  starting: 'projectPanel.swarm.manager.stageStarting',
  done: 'projectPanel.swarm.manager.stageDone',
}

// ─── Board tab ───────────────────────────────────────────────────────────────
// A kanban of task cards (one source of truth in the central tasks.json).
// Columns are workflow stages — the optional 'review' fifth column (between
// doing and done) is toggled per project via config.reviewColumn; a card's
// vertical position WITHIN a column is its priority (top = highest). The user
// drags cards between columns; each card's ▶ button (in the detail drawer)
// launches an interactive claude terminal — there is no batch-run machinery
// anymore.

// The active column keys, derived from the project's review-column flag.
export const boardColumnKeys = (reviewOn: boolean): BoardColumn[] =>
  reviewOn
    ? ['todo', 'doing', 'review', 'done', 'blocked']
    : ['todo', 'doing', 'done', 'blocked']

const COLUMN_LABEL_KEYS: Record<BoardColumn, MessageKey> = {
  todo: 'board.col.todo',
  doing: 'board.col.doing',
  review: 'board.col.review',
  done: 'board.col.done',
  blocked: 'board.col.blocked',
}

export const columns = (
  t: TFn,
  reviewOn: boolean,
): { key: BoardColumn; label: string; hint: string }[] =>
  boardColumnKeys(reviewOn).map(key => ({
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

// Where a task RENDERS given the review flag. With the review column hidden a
// card parked in 'review' (the flag was just switched off, or a teammate has
// it on) folds into 'doing' — cards are never lost, only the lane is.
export const displayColumnOf = (t: ProjectTask, reviewOn: boolean): BoardColumn => {
  const col = columnOf(t)
  return col === 'review' && !reviewOn ? 'doing' : col
}

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

// Flip the shared review-column flag. Off is stored as `undefined` (never
// `false`) — the same convention the settings dialog uses, so the two entry
// points can't diverge on what "off" looks like in the persisted config.
export const withReviewColumnToggled = (data: ProjectData): ProjectData => {
  const reviewOn = !!data.config?.reviewColumn
  return { ...data, config: { ...data.config, reviewColumn: !reviewOn || undefined } }
}

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
// Review column off → no poll at all (the chip renders only there).
export const reviewBranchesOf = (tasks: ProjectTask[], reviewOn: boolean): string[] => {
  if (!reviewOn) return []
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
// boardOrder = 0..n across the target column's FULL card list (displayColumnOf
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
  reviewOn: boolean,
): ProjectData => {
  const moving = data.tasks.find(t => t.id === id)
  if (!moving) return data
  const target = data.tasks
    .filter(t => t.id !== id && displayColumnOf(t, reviewOn) === col)
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
  // The optional review lane is a SHARED per-project policy (config travels
  // with the board), so both collaborators see the same columns.
  const reviewOn = !!data.config?.reviewColumn
  const COLUMNS = useMemo(() => columns(t, reviewOn), [t, reviewOn])
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

  // Commit an inline title edit. Empty (trimmed) → the card is removed, so a
  // card the user added but never named never lingers. Otherwise save the title.
  const commitCardTitle = (task: ProjectTask, raw: string) => {
    setEditingId(null)
    const title = raw.trim()
    if (!title) {
      onPersist({ ...data, tasks: data.tasks.filter(x => x.id !== task.id) })
      return
    }
    if (title !== task.title)
      onPersist({
        ...data,
        tasks: data.tasks.map(x => (x.id === task.id ? { ...x, title } : x)),
      })
  }

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
    () => reviewBranchesOf(data.tasks, reviewOn),
    [data.tasks, reviewOn],
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
  // Board card now (legacy chat/assistant items are dropped on read). With the
  // review lane off, review-parked cards fold into doing (displayColumnOf) so
  // they stay visible; the Mine-only filter narrows what renders, never what
  // persists.
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
    for (const t of visibleTasks) groups[displayColumnOf(t, reviewOn)].push(t)
    for (const k of Object.keys(groups) as BoardColumn[]) groups[k].sort(byColumnOrder)
    return groups
  }, [visibleTasks, reviewOn])

  // Move `id` into `col`, inserting before `beforeId` (or at the end). Pure
  // logic lives in withCardMoved — crucially it renumbers over the column's
  // FULL card list (not the filtered/visible byColumn slice), so a drag while
  // search / "Mine only" is active can never assign a hidden card and the
  // dropped one the same boardOrder.
  const moveCard = (id: string, col: BoardColumn, beforeId: string | null) => {
    const next = withCardMoved(data, id, col, beforeId, reviewOn)
    if (next !== data) onPersist(next)
  }

  const endDrag = () => {
    setDragId(null)
    setDragHidden(false)
    setDropPos(null)
  }

  // Drop lands where the placeholder is: `index` counts positions in the
  // column's visible cards EXCLUDING the dragged one (the same list the
  // placeholder is rendered into).
  const commitDrop = () => {
    if (dragId && dropPos) {
      const others = byColumn[dropPos.col].filter(t => t.id !== dragId)
      moveCard(dragId, dropPos.col, others[dropPos.index]?.id ?? null)
    }
    endDrag()
  }

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
      <div className="flex shrink-0 items-center justify-between gap-3 px-8 py-3">
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
                'rounded-sm border px-2.5 py-1 text-[11px] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                !hasDisplayName
                  ? 'cursor-not-allowed border-line text-ink-faint opacity-50'
                  : mineOnly
                    ? 'border-accent bg-accent text-bg-card hover:bg-accent-hover'
                    : 'border-line text-ink-muted hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink',
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
          {/* Review-column toggle — lives in the toolbar (where the column would
              appear) for discoverability; this is the ONLY review-column switch
              (the settings dialog no longer duplicates it). Label + a small
              switch: the knob position carries the state, so it reads at a
              glance without copy. */}
          <button
            type="button"
            role="switch"
            aria-checked={reviewOn}
            onClick={() => onPersist(withReviewColumnToggled(data))}
            disabled={projectMissing}
            title={
              reviewOn
                ? t('board.toolbar.reviewColumnHideHint')
                : t('board.toolbar.reviewColumnShowHint')
            }
            className="group flex items-center gap-1.5 rounded-sm px-1 py-1 text-[11px] text-ink-muted transition-colors hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-muted"
          >
            {t('board.toolbar.reviewColumn')}
            <span
              aria-hidden
              className={[
                'relative h-[14px] w-[24px] shrink-0 rounded-full border transition-colors',
                reviewOn
                  ? 'border-accent bg-accent group-hover:bg-accent-hover'
                  : 'border-line bg-bg-inset',
              ].join(' ')}
            >
              <span
                className={[
                  'absolute top-[2px] h-[8px] w-[8px] rounded-full transition-[left,background-color]',
                  reviewOn ? 'left-[12px] bg-bg-card' : 'left-[2px] bg-ink-faint',
                ].join(' ')}
              />
            </span>
          </button>
          {/* Project settings — surfaces the dialog that used to hide behind
              the ⋯ menu. Quiet text+icon button, same register as the review
              toggle's label. */}
          {onOpenProjectSettings && (
            <button
              type="button"
              onClick={onOpenProjectSettings}
              disabled={projectMissing}
              title={t('board.toolbar.projectSettings')}
              className="flex items-center gap-1.5 rounded-sm px-1 py-1 text-[11px] text-ink-muted transition-colors hover:text-ink active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-muted"
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
              <label className="flex items-center gap-1 text-[10px] text-ink-faint">
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
            <label className="flex items-center gap-1 text-[10px] text-ink-faint">
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
            <label className="flex items-center gap-1 text-[10px] text-ink-faint">
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
            <label className="flex items-center gap-1 text-[10px] text-ink-faint">
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
        <p className="shrink-0 px-8 pb-3 text-[11.5px] leading-relaxed text-ink-faint">
          {t('board.empty.guide')}
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-8 pb-6">
        {COLUMNS.map(col => {
          const cards = byColumn[col.key]
          const others = dragId ? cards.filter(c => c.id !== dragId) : cards
          const isDropTarget = dropPos?.col === col.key
          const placeholderIndex = isDropTarget ? dropPos.index : -1
          const renderCard = (task: ProjectTask, colKey: BoardColumn, visIdx: number) => {
            const isEditing = task.id === editingId
            const claudeSt = sessionStatus?.(task.id) ?? null
            // The swarm worker dispatched onto this card — ONLY in the doing
            // column (a finished worker's card has already moved to review), and
            // ONLY for the owner (the orchestrator poll 403s otherwise → null).
            // When present, the worker is the AUTHORITATIVE status for this card:
            // it owns the top edge AND the title stamp below, suppressing the
            // drawer claude band/stamp so the two can never show conflicting
            // states (a doing card CAN host a drawer claude session too — opening
            // its drawer auto-launches plain claude — so this guard is real, not
            // theoretical).
            const worker = colKey === 'doing' ? workerForTask?.(task.id) ?? null : null
            return (
                      <article
                        key={task.id}
                        draggable={!isEditing}
                        role="button"
                        tabIndex={0}
                        aria-label={t('board.card.ariaLabel', {
                          title: task.title || t('board.card.untitled'),
                          column: COLUMNS.find(c => c.key === colKey)?.label ?? '',
                        })}
                        onClick={() => {
                          if (!isEditing) onOpenTask(task.id)
                        }}
                        onKeyDown={e => {
                          if (isEditing) return
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            onOpenTask(task.id)
                          }
                        }}
                        onDragStart={e => {
                          // Some engines (Firefox; Chrome in edge cases) need
                          // data set for the drag to start at all.
                          e.dataTransfer?.setData('text/plain', task.id)
                          if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
                          setDragId(task.id)
                          setDragHeight(e.currentTarget.offsetHeight)
                          // Hide the source AFTER the browser captured its drag
                          // image — hiding synchronously cancels the drag.
                          setTimeout(() => setDragHidden(true), 0)
                        }}
                        onDragEnd={endDrag}
                        onDragOver={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (visIdx < 0) return
                          // Above the card's midline → take its slot; below →
                          // the slot after it. Index space = visible cards
                          // excluding the dragged one.
                          const r = e.currentTarget.getBoundingClientRect()
                          const before = e.clientY < r.top + r.height / 2
                          setDropPos({ col: colKey, index: visIdx + (before ? 0 : 1) })
                        }}
                        onDrop={e => {
                          e.preventDefault()
                          e.stopPropagation()
                          commitDrop()
                        }}
                        className={[
                          'group relative rounded-[3px] border p-2.5 shadow-card transition-colors',
                          isEditing
                            ? 'cursor-default border-accent'
                            : 'cursor-grab hover:border-line-strong active:cursor-grabbing',
                          // The card whose detail drawer is open reads as
                          // selected: accent border + a light accent wash.
                          task.id === openTaskId && !isEditing
                            ? 'border-accent bg-accent/15'
                            : 'border-line bg-bg-card',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg-inset',
                          dragId === task.id && dragHidden ? 'hidden' : '',
                        ].join(' ')}
                      >
                        {/* Top edge — the surveyor's marking. A swarm worker on a
                            doing card takes precedence (azure scanning while its
                            PTY produces output, steady otherwise — synced to the
                            worker; it disappears the moment the engine drops the
                            worker). Otherwise the same claude-status band the
                            Ground cards carry: azure scanning while claude works,
                            steady amber while it waits on the human. */}
                        {worker ? (
                          <div
                            className={[
                              'absolute left-0 right-0 top-0 h-[3px] overflow-hidden rounded-t-[2px]',
                              WORKER_BAND[worker.activity],
                            ].join(' ')}
                          >
                            {worker.activity === 'working' && (
                              <div className="run-scan h-full w-1/3 bg-gradient-to-r from-transparent via-bg-card/85 to-transparent" />
                            )}
                          </div>
                        ) : (
                          claudeSt && (
                            <div
                              className={[
                                'absolute left-0 right-0 top-0 h-[3px] overflow-hidden rounded-t-[2px]',
                                claudeSt === 'working' ? 'bg-azure' : 'bg-ochre',
                              ].join(' ')}
                            >
                              {claudeSt === 'working' && (
                                <div className="run-scan h-full w-1/3 bg-gradient-to-r from-transparent via-bg-card/85 to-transparent" />
                              )}
                            </div>
                          )
                        )}
                        {/* Duplicate (F020) — small icon button in the card's
                            top-right corner, revealed on hover (same
                            opacity-on-group-hover idiom as the grip). Inserts
                            a ' (copy)' twin directly below this card. Must
                            never start a drag or open the drawer. */}
                        {!isEditing && (
                          <button
                            type="button"
                            draggable={false}
                            disabled={projectMissing}
                            aria-label={t('board.card.duplicate')}
                            title={t('board.card.duplicateTitle')}
                            onClick={e => {
                              e.stopPropagation()
                              onPersist(withCardDuplicated(data, task.id))
                            }}
                            onKeyDown={e => {
                              // Don't let Enter/Space bubble to the card's
                              // open-drawer keydown handler.
                              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                            }}
                            className={[
                              'absolute right-1 top-1 rounded-sm p-1 text-ink-faint transition-[opacity,color,background-color] focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                              projectMissing
                                ? 'cursor-not-allowed opacity-0 group-hover:opacity-40'
                                : 'opacity-0 hover:bg-bg-inset hover:text-ink active:bg-bg-inset active:text-ink group-hover:opacity-100',
                            ].join(' ')}
                          >
                            <Copy size={12} />
                          </button>
                        )}
                        <div className="flex items-start gap-1.5">
                          <GripVertical
                            size={12}
                            className={[
                              'mt-0.5 shrink-0 text-ink-faint transition-opacity',
                              isEditing ? 'opacity-0' : 'opacity-0 group-hover:opacity-100',
                            ].join(' ')}
                          />
                          <div className="min-w-0 flex-1">
                            {isEditing ? (
                              <textarea
                                autoFocus
                                rows={2}
                                defaultValue={task.title}
                                placeholder={t('board.detail.titlePlaceholder')}
                                onClick={e => e.stopPropagation()}
                                onKeyDown={e => {
                                  if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault()
                                    e.currentTarget.blur()
                                  } else if (e.key === 'Escape') {
                                    e.preventDefault()
                                    e.currentTarget.blur()
                                  }
                                }}
                                onBlur={e => commitCardTitle(task, e.target.value)}
                                className="w-full resize-none rounded-[3px] border border-line bg-bg px-2 py-1.5 text-[12.5px] leading-snug text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
                              />
                            ) : (
                            <p className="text-[12.5px] leading-snug text-ink line-clamp-2">
                              {/* Drawer-claude stamp — suppressed when a swarm
                                  worker owns the card (its strip below is the
                                  authoritative status), so the two never show
                                  conflicting states on one card. */}
                              {!worker && claudeSt === 'working' && (
                                <span
                                  title={t('board.card.sessionWorking')}
                                  className="label-cap mr-1.5 inline-flex items-center gap-1 align-middle text-azure"
                                >
                                  <span className="run-pulse h-[5px] w-[5px] rounded-full bg-azure" />
                                  Running
                                </span>
                              )}
                              {!worker && claudeSt === 'waiting' && (
                                // Steady, no pulse — "your turn" must stay
                                // visible at a glance (same register as the
                                // Ground card's Waiting stamp).
                                <span
                                  title={t('board.card.sessionWaiting')}
                                  className="label-cap mr-1.5 inline-flex items-center gap-1 align-middle text-[var(--beacon-waiting)]"
                                >
                                  <span className="h-[5px] w-[5px] rounded-full bg-ochre" />
                                  Waiting
                                </span>
                              )}
                              {task.title || t('board.card.untitledParen')}
                            </p>
                            )}
                            {!isEditing && task.notes?.trim() && (
                              <p className="mt-1 text-[11px] leading-snug line-clamp-2 text-ink-muted">
                                {task.notes.trim()}
                              </p>
                            )}
                            {/* Swarm worker strip (条件①②) — WHICH worker owns this
                                doing card (its swarm/* branch) + whether it's
                                running / waiting / booting, in the same beacon
                                vocabulary as the band above and the Swarm pane.
                                Owner-only + doing-only (gated where `worker` is
                                computed); the dot breathes only while working so
                                "your worker is busy" reads at a glance without a
                                second moving element competing with the band. */}
                            {!isEditing && worker && (
                              <div className="mt-1 flex min-w-0 items-center gap-1.5">
                                <span
                                  aria-hidden
                                  className={[
                                    'h-[5px] w-[5px] shrink-0 rounded-full',
                                    WORKER_DOT[worker.activity],
                                    worker.activity === 'working' ? 'run-pulse' : '',
                                  ].join(' ')}
                                />
                                <span
                                  className={['label-cap shrink-0', WORKER_LABEL_CLS[worker.activity]].join(' ')}
                                >
                                  {t(WORKER_LABEL_KEY[worker.activity])}
                                </span>
                                <span
                                  className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted"
                                  title={
                                    worker.note
                                      ? `${worker.branch} — ${worker.note}`
                                      : worker.phase
                                        ? `${worker.branch} · ${worker.phase}`
                                        : worker.branch
                                  }
                                >
                                  {worker.branch}
                                </span>
                              </div>
                            )}
                            {/* Review stamp — review-column cards carry an
                                explicit "I looked at this" affordance so the
                                second pair of eyes is visible ON the board
                                (F062). Clears automatically on rework moves. */}
                            {!isEditing && col.key === 'review' && (
                              task.reviewedBy?.trim() ? (
                                <button
                                  type="button"
                                  draggable={false}
                                  disabled={projectMissing}
                                  onClick={e => {
                                    e.stopPropagation()
                                    onPersist({
                                      ...data,
                                      tasks: data.tasks.map(x =>
                                        x.id === task.id ? { ...x, reviewedBy: undefined } : x,
                                      ),
                                    })
                                  }}
                                  // Full name in the tooltip — the visible label
                                  // truncates on long reviewer names (260px card).
                                  title={`${t('board.card.reviewedBy', { name: task.reviewedBy.trim() })} — ${t('board.card.reviewedClear')}`}
                                  className="mt-1 flex max-w-full items-center gap-1 rounded-sm px-0 py-0.5 text-[10px] text-moss transition-colors hover:text-ink active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-moss"
                                >
                                  <span aria-hidden className="shrink-0">✓</span>
                                  <span className="min-w-0 truncate">
                                    {t('board.card.reviewedBy', { name: task.reviewedBy.trim() })}
                                  </span>
                                </button>
                              ) : displayName?.trim() ? (
                                <button
                                  type="button"
                                  draggable={false}
                                  disabled={projectMissing}
                                  onClick={e => {
                                    e.stopPropagation()
                                    onPersist({
                                      ...data,
                                      tasks: data.tasks.map(x =>
                                        x.id === task.id
                                          ? { ...x, reviewedBy: displayName.trim() }
                                          : x,
                                      ),
                                    })
                                  }}
                                  title={t('board.card.markReviewedTitle')}
                                  className="mt-1 rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-moss hover:text-moss active:border-moss active:text-moss focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-muted"
                                >
                                  {t('board.card.markReviewed')}
                                </button>
                              ) : null
                            )}
                            {/* Auto-integration conflict (Card③) — the commander
                                engine tried to land this review card's branch but
                                rebasing it onto the trunk conflicted, so it was
                                left for a human. A red chip surfaces it ON the
                                board; it clears automatically on any move out of
                                review (moveCard). */}
                            {!isEditing && col.key === 'review' && task.integrationConflict && (
                              <div
                                className="mt-1 flex min-w-0 items-center gap-1 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent"
                                title={t('board.card.integrationConflictTitle')}
                              >
                                <span aria-hidden className="shrink-0">⚠</span>
                                <span className="min-w-0 truncate">
                                  {t('board.card.integrationConflict')}
                                </span>
                              </div>
                            )}
                            {/* Merged detection (B018/F065) — the branch this
                                review card carries already landed in the
                                target branch: a small moss chip + an EXPLICIT
                                "→ Done" button. Deliberately never automatic
                                (F050) — the user clicks, the card moves, the
                                reviewedBy stamp survives (moveCard keeps it
                                for the done column). */}
                            {!isEditing &&
                              col.key === 'review' &&
                              task.branch &&
                              mergedByBranch[task.branch] === 'merged' && (
                                <div className="mt-1 flex min-w-0 items-center gap-1.5">
                                  <span
                                    title={t('board.card.mergedTitle')}
                                    className="shrink-0 rounded-sm border border-moss/40 bg-moss/10 px-1.5 py-0.5 text-[10px] leading-none text-moss"
                                  >
                                    {t('board.card.merged')}
                                  </span>
                                  <button
                                    type="button"
                                    draggable={false}
                                    disabled={projectMissing}
                                    onClick={e => {
                                      e.stopPropagation()
                                      moveCard(task.id, 'done', null)
                                    }}
                                    onKeyDown={e => {
                                      // Don't let Enter/Space bubble to the
                                      // card's open-drawer keydown handler.
                                      if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                                    }}
                                    title={t('board.card.mergedToDoneTitle')}
                                    className="min-w-0 truncate rounded-sm px-1 py-0.5 text-[10px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-moss active:bg-bg-inset active:text-moss focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
                                  >
                                    {t('board.card.mergedToDone')}
                                  </button>
                                </div>
                              )}
                            {/* Footer — PR link + dependency chip "⛓ n"
                                (unresolved deps, B025) + due chip (B026) on
                                the left; assignee (small faint text) on the
                                right. The chips are pure information — not
                                interactive, title carries the detail. */}
                            {!isEditing && (() => {
                              const blockedBy = unresolvedDeps(task, data.tasks)
                              if (
                                !task.prUrl &&
                                !task.assignee?.trim() &&
                                !task.dueDate &&
                                blockedBy.length === 0
                              )
                                return null
                              const doneCard = task.done || col.key === 'done'
                              return (
                              <div className="mt-1 flex items-center justify-between gap-2">
                                <span className="flex min-w-0 items-center gap-1.5">
                                {task.prUrl && (
                                  <a
                                    href={task.prUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    draggable={false}
                                    onClick={e => e.stopPropagation()}
                                    title={task.prUrl}
                                    className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                                  >
                                    PR ↗
                                  </a>
                                )}
                                {blockedBy.length > 0 && (
                                  <span
                                    title={t('board.card.depsTitle', {
                                      titles: blockedBy
                                        .map(d => d.title.trim() || t('board.card.untitledParen'))
                                        .join(', '),
                                    })}
                                    className="shrink-0 text-[10px] text-ink-muted"
                                  >
                                    {/* U+FE0E pins text presentation — without
                                        it some platforms render the chain as a
                                        color emoji. */}
                                    ⛓︎ {blockedBy.length}
                                  </span>
                                )}
                                {task.dueDate && (
                                  <span
                                    title={t('board.card.dueTitle', { date: task.dueDate })}
                                    className={[
                                      // max-w + truncate: a malformed/long due
                                      // string can't blow the card footer row;
                                      // title carries the full value.
                                      'max-w-[96px] truncate text-[10px]',
                                      // Today (inclusive) or earlier = needs
                                      // attention — unless the card is done.
                                      !doneCard && isOverdue(task.dueDate)
                                        ? 'text-accent'
                                        : 'text-ink-faint',
                                    ].join(' ')}
                                  >
                                    {formatDueShort(task.dueDate)}
                                  </span>
                                )}
                                </span>
                                {task.assignee?.trim() && (
                                  <p className="min-w-0 truncate text-right text-[10px] text-ink-faint">
                                    {task.assignee.trim()}
                                  </p>
                                )}
                              </div>
                              )
                            })()}
                          </div>
                        </div>
                      </article>
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
                setDropPos({ col: col.key, index: others.length })
              }}
              onDrop={e => {
                e.preventDefault()
                commitDrop()
              }}
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
                {/* Bulk-clear (F073) — small text button, shown only while the
                    Done column holds any card (counted over ALL tasks, not the
                    filtered view: clearing always empties the whole column). */}
                {col.key === 'done' && doneTotal > 0 && (
                  <button
                    type="button"
                    onClick={clearDone}
                    disabled={projectMissing}
                    title={t('board.toolbar.clearDoneTitle')}
                    className="rounded-sm px-1 py-0.5 text-[10px] text-ink-faint transition-colors hover:text-ink active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-ink-faint"
                  >
                    {t('board.toolbar.clearDone')}
                  </button>
                )}
              </header>

              {/* Empty columns show no placeholder text: dragging a card over a
                  column already highlights it as a drop target, and the
                  "+ Add a card" composer below covers authoring. */}
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
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
                    rendered.push(renderCard(task, col.key, isSource ? -1 : vis))
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
    <div className="px-1 pb-1 pt-1">
      <button
        type="button"
        disabled={disabled}
        onClick={onAdd}
        className="w-full rounded-[3px] border border-transparent bg-transparent px-2 py-1.5 text-left text-[12px] text-ink-faint transition-colors hover:border-line hover:bg-bg-card hover:text-ink active:bg-bg-inset focus-visible:border-accent focus-visible:bg-bg-card focus-visible:text-ink focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-ink-faint"
      >
        {t('board.composer.placeholder')}
      </button>
    </div>
  )
}
