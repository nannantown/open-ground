import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import type { BoardColumn, ProjectData, ProjectTask } from '@/lib/types'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'

type TFn = (key: MessageKey, vars?: Record<string, string | number>) => string

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

// Flip the shared review-column flag. Off is stored as `undefined` (never
// `false`) — the same convention the settings dialog uses, so the two entry
// points can't diverge on what "off" looks like in the persisted config.
export const withReviewColumnToggled = (data: ProjectData): ProjectData => {
  const reviewOn = !!data.config?.reviewColumn
  return { ...data, config: { ...data.config, reviewColumn: !reviewOn || undefined } }
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
  /** Registry UUID — keys the per-project "Mine only" toggle in localStorage. */
  projectId?: string
  /** The user's display name (Settings.displayName). Unset hides the
   *  "Mine only" filter entirely — there is nothing to compare against. */
  displayName?: string | null
  /** The card whose detail drawer is open — rendered in a selected state so
   *  the board always shows WHICH card the drawer belongs to. */
  openTaskId?: string | null
}

export const BoardTab = ({
  data,
  onPersist,
  onOpenTask,
  onCreateTask,
  projectMissing,
  projectId,
  displayName,
  openTaskId,
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

  // Group tasks by column, sorted by priority within each. Every task IS a
  // Board card now (legacy chat/assistant items are dropped on read). With the
  // review lane off, review-parked cards fold into doing (displayColumnOf) so
  // they stay visible; the Mine-only filter narrows what renders, never what
  // persists.
  const boardTasks = data.tasks
  const visibleTasks = useMemo(
    () =>
      filterActive
        ? boardTasks.filter(task => assigneeMatches(task.assignee, displayName))
        : boardTasks,
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
        {/* Review-column toggle — lives in the toolbar (where the column would
            appear) for discoverability; the settings dialog's checkbox edits
            the SAME config.reviewColumn. Label + a small switch: the knob
            position carries the state, so it reads at a glance without copy. */}
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
      </div>

      {/* Columns — always rendered, even at 0 cards, so the lane structure tasks
          flow into is visible from the very first visit. Tasks are authored
          RIGHT HERE on the Board. */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-8 pb-6">
        {COLUMNS.map(col => {
          const cards = byColumn[col.key]
          const others = dragId ? cards.filter(c => c.id !== dragId) : cards
          const isDropTarget = dropPos?.col === col.key
          const placeholderIndex = isDropTarget ? dropPos.index : -1
          const renderCard = (task: ProjectTask, colKey: BoardColumn, visIdx: number) => {
            const isEditing = task.id === editingId
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
                          'group rounded-[3px] border p-2.5 shadow-card transition-colors',
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
                              {task.title || t('board.card.untitledParen')}
                            </p>
                            )}
                            {!isEditing && task.notes?.trim() && (
                              <p className="mt-1 text-[11px] leading-snug line-clamp-2 text-ink-muted">
                                {task.notes.trim()}
                              </p>
                            )}
                            {/* Footer — PR link (left, when claude opened one)
                                + assignee (right, small faint text). */}
                            {!isEditing && (task.prUrl || task.assignee?.trim()) && (
                              <div className="mt-1 flex items-center justify-between gap-2">
                                {task.prUrl ? (
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
                                ) : (
                                  <span />
                                )}
                                {task.assignee?.trim() && (
                                  <p className="min-w-0 truncate text-right text-[10px] text-ink-faint">
                                    {task.assignee.trim()}
                                  </p>
                                )}
                              </div>
                            )}
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
