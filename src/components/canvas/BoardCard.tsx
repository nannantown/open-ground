import { memo } from 'react'
import { Copy, GripVertical } from 'lucide-react'
import type { BoardColumn, ClaudeBeaconStatus, ProjectTask } from '@/lib/types'
import { formatDueShort, isOverdue } from '@/lib/boardDeps'
import { PRIORITY_META } from '@/lib/boardPriority'
import type { WorkerActivity } from '@/lib/boardWorker'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'

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

// ─── BoardCard ───────────────────────────────────────────────────────────────
// ONE kanban card, extracted out of BoardTab and wrapped in React.memo so a
// single-card edit / move / status poll reconciles ONE <article> instead of all
// N. The board's data layer preserves object identity for untouched tasks
// (patchTask / withCardMoved / withCardDuplicated all do
// `tasks.map(t => t.id === id ? {...t} : t)`), so a memo keyed on `task`
// identity skips ~199/200 cards on any single-card change.
//
// CRITICAL — every prop here is a primitive or a referentially-STABLE callback.
// Anything board-wide that a card depends on (the live claude/worker status, the
// unresolved-dependency list, the cycle/merged verdicts) is RESOLVED to a
// primitive by BoardTab before it reaches this boundary; passing the raw status
// functions / maps / data array would make the memo inert (a new value every
// render → every card re-renders). The drag-hover `dropPos` deliberately does
// NOT pass through here — only the placeholder + the dragged node react to it —
// so a dragover frame re-renders the board shell, not 200 cards.
export interface BoardCardProps {
  /** The card. Identity-stable for untouched tasks → the memo's key signal. */
  task: ProjectTask
  /** This card's column (workflow lane). */
  columnKey: BoardColumn
  /** Localized column label — for the card's aria-label (hoisted by BoardTab so
   *  no per-card COLUMNS.find runs). */
  columnLabel: string
  /** Index in the column's VISIBLE (non-source) sequence — drives the drop slot.
   *  -1 for the drag source (its dragover is a no-op). */
  visIdx: number
  /** Inline-title edit mode (vestigial fallback editor — creation uses the
   *  drawer; preserved so a future inline edit still works). */
  isEditing: boolean
  /** This card's detail drawer is open → render selected (accent border + wash). */
  isSelected: boolean
  /** This card is the drag source AND the post-dragstart hide tick has fired →
   *  display:none (the node must NOT relocate, only hide — Chrome aborts a native
   *  drag if its source moves). */
  isDragHidden: boolean
  /** The project folder is gone → card mutations are disabled. */
  projectMissing: boolean
  /** Live claude pane status for THIS card (resolved by BoardTab from the beacon
   *  map). null = no live session. */
  claudeStatus: ClaudeBeaconStatus | null
  /** Swarm worker activity owning this (doing) card, or null. Resolved to
   *  primitives so the memo can compare them — the worker view object itself is
   *  rebuilt every poll and would defeat the memo. */
  workerActivity: WorkerActivity | null
  workerBranch?: string
  workerPhase?: string
  workerNote?: string
  /** Count of unresolved dependencies (the "⛓ n" chip) + the pre-joined titles
   *  for its tooltip — resolved by BoardTab over the shared id→task map. */
  depCount: number
  depTitlesText: string
  /** This card sits on a dependency cycle (⚠ chip). */
  inCycle: boolean
  /** This review card's branch already landed in the target branch (merged chip
   *  + "→ Done"). Resolved by BoardTab from the merged-branch poll. */
  isMerged: boolean
  /** The user's display name — enables the "mark reviewed" affordance. */
  displayName?: string | null
  // ── Stable callbacks (BoardTab owns them via useCallback + refs) ───────────
  onOpenTask: (taskId: string) => void
  onDragStartCard: (taskId: string, height: number) => void
  onDragEndCard: () => void
  onDragOverCard: (col: BoardColumn, index: number) => void
  onDropCard: () => void
  onDuplicate: (taskId: string) => void
  onCommitTitle: (taskId: string, currentTitle: string, raw: string) => void
  onSetReviewedBy: (taskId: string, value: string | undefined) => void
  onMoveToDone: (taskId: string) => void
}

const BoardCardInner = ({
  task,
  columnKey,
  columnLabel,
  visIdx,
  isEditing,
  isSelected,
  isDragHidden,
  projectMissing,
  claudeStatus,
  workerActivity,
  workerBranch,
  workerPhase,
  workerNote,
  depCount,
  depTitlesText,
  inCycle,
  isMerged,
  displayName,
  onOpenTask,
  onDragStartCard,
  onDragEndCard,
  onDragOverCard,
  onDropCard,
  onDuplicate,
  onCommitTitle,
  onSetReviewedBy,
  onMoveToDone,
}: BoardCardProps) => {
  const { t } = useT()
  const isReview = columnKey === 'review'
  const isDone = columnKey === 'done'
  // A swarm worker dispatched onto this card is the AUTHORITATIVE status: it owns
  // the top edge AND the title stamp, suppressing the drawer claude band/stamp so
  // the two can never show conflicting states on one card.
  const hasWorker = workerActivity !== null
  return (
    <article
      draggable={!isEditing}
      role="button"
      tabIndex={0}
      aria-label={t('board.card.ariaLabel', {
        title: task.title || t('board.card.untitled'),
        column: columnLabel,
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
        // Some engines (Firefox; Chrome in edge cases) need data set for the
        // drag to start at all.
        e.dataTransfer?.setData('text/plain', task.id)
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
        onDragStartCard(task.id, e.currentTarget.offsetHeight)
      }}
      onDragEnd={onDragEndCard}
      onDragOver={e => {
        e.preventDefault()
        e.stopPropagation()
        if (visIdx < 0) return
        // Above the card's midline → take its slot; below → the slot after it.
        // Index space = visible cards excluding the dragged one.
        const r = e.currentTarget.getBoundingClientRect()
        const before = e.clientY < r.top + r.height / 2
        onDragOverCard(columnKey, visIdx + (before ? 0 : 1))
      }}
      onDrop={e => {
        e.preventDefault()
        e.stopPropagation()
        onDropCard()
      }}
      className={[
        'group relative rounded-[3px] border p-2.5 shadow-card transition-colors',
        isEditing
          ? 'cursor-default border-accent'
          : 'cursor-grab hover:border-line-strong active:cursor-grabbing',
        // The card whose detail drawer is open reads as selected: accent border
        // + a light accent wash.
        isSelected && !isEditing
          ? 'border-accent bg-accent/15'
          : 'border-line bg-bg-card',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg-inset',
        isDragHidden ? 'hidden' : '',
      ].join(' ')}
    >
      {/* Top edge — the surveyor's marking. A swarm worker on a doing card takes
          precedence (azure scanning while its PTY produces output, steady
          otherwise — synced to the worker; it disappears the moment the engine
          drops the worker). Otherwise the same claude-status band the Ground
          cards carry: azure scanning while claude works, steady amber while it
          waits on the human. */}
      {hasWorker ? (
        <div
          className={[
            'absolute left-0 right-0 top-0 h-[3px] overflow-hidden rounded-t-[2px]',
            WORKER_BAND[workerActivity],
          ].join(' ')}
        >
          {workerActivity === 'working' && (
            <div className="run-scan h-full w-1/3 bg-gradient-to-r from-transparent via-bg-card/85 to-transparent" />
          )}
        </div>
      ) : (
        claudeStatus && (
          <div
            className={[
              'absolute left-0 right-0 top-0 h-[3px] overflow-hidden rounded-t-[2px]',
              claudeStatus === 'working' ? 'bg-azure' : 'bg-ochre',
            ].join(' ')}
          >
            {claudeStatus === 'working' && (
              <div className="run-scan h-full w-1/3 bg-gradient-to-r from-transparent via-bg-card/85 to-transparent" />
            )}
          </div>
        )
      )}
      {/* Duplicate (F020) — small icon button in the card's top-right corner,
          revealed on hover (same opacity-on-group-hover idiom as the grip).
          Inserts a ' (copy)' twin directly below this card. Must never start a
          drag or open the drawer. */}
      {!isEditing && (
        <button
          type="button"
          draggable={false}
          disabled={projectMissing}
          aria-label={t('board.card.duplicate')}
          title={t('board.card.duplicateTitle')}
          onClick={e => {
            e.stopPropagation()
            onDuplicate(task.id)
          }}
          onKeyDown={e => {
            // Don't let Enter/Space bubble to the card's open-drawer keydown
            // handler.
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
              onBlur={e => onCommitTitle(task.id, task.title, e.target.value)}
              className="w-full resize-none rounded-[3px] border border-line bg-bg px-2 py-1.5 text-[12.5px] leading-snug text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          ) : (
            <p className="text-[12.5px] leading-snug text-ink line-clamp-2">
              {/* Drawer-claude stamp — suppressed when a swarm worker owns the
                  card (its strip below is the authoritative status), so the two
                  never show conflicting states on one card. */}
              {!hasWorker && claudeStatus === 'working' && (
                <span
                  title={t('board.card.sessionWorking')}
                  className="label-cap mr-1.5 inline-flex items-center gap-1 align-middle text-azure"
                >
                  <span className="run-pulse h-[5px] w-[5px] rounded-full bg-azure" />
                  Running
                </span>
              )}
              {!hasWorker && claudeStatus === 'waiting' && (
                // Steady, no pulse — "your turn" must stay visible at a glance
                // (same register as the Ground card's Waiting stamp).
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
          {/* Swarm worker strip (条件①②) — WHICH worker owns this doing card (its
              swarm/* branch) + whether it's running / waiting / booting, in the
              same beacon vocabulary as the band above and the Swarm pane.
              Owner-only + doing-only (gated where `worker` is resolved); the dot
              breathes only while working so "your worker is busy" reads at a
              glance without a second moving element competing with the band. */}
          {!isEditing && hasWorker && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden
                className={[
                  'h-[5px] w-[5px] shrink-0 rounded-full',
                  WORKER_DOT[workerActivity],
                  workerActivity === 'working' ? 'run-pulse' : '',
                ].join(' ')}
              />
              <span
                className={['label-cap shrink-0', WORKER_LABEL_CLS[workerActivity]].join(' ')}
              >
                {t(WORKER_LABEL_KEY[workerActivity])}
              </span>
              <span
                className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-muted"
                title={
                  workerNote
                    ? `${workerBranch} — ${workerNote}`
                    : workerPhase
                      ? `${workerBranch} · ${workerPhase}`
                      : workerBranch
                }
              >
                {workerBranch}
              </span>
            </div>
          )}
          {/* Review stamp — review-column cards carry an explicit "I looked at
              this" affordance so the second pair of eyes is visible ON the board
              (F062). Clears automatically on rework moves. */}
          {!isEditing &&
            isReview &&
            (task.reviewedBy?.trim() ? (
              <button
                type="button"
                draggable={false}
                disabled={projectMissing}
                onClick={e => {
                  e.stopPropagation()
                  onSetReviewedBy(task.id, undefined)
                }}
                // Full name in the tooltip — the visible label truncates on long
                // reviewer names (260px card).
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
                  onSetReviewedBy(task.id, displayName.trim())
                }}
                title={t('board.card.markReviewedTitle')}
                className="mt-1 rounded-sm border border-line px-1.5 py-0.5 text-[10px] text-ink-muted transition-colors hover:border-moss hover:text-moss active:border-moss active:text-moss focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-muted"
              >
                {t('board.card.markReviewed')}
              </button>
            ) : null)}
          {/* Auto-integration conflict (Card③) — the commander engine tried to
              land this review card's branch but rebasing it onto the trunk
              conflicted, so it was left for a human. A red chip surfaces it ON
              the board; it clears automatically on any move out of review
              (moveCard). */}
          {!isEditing && isReview && task.integrationConflict && (
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
          {/* Merged detection (B018/F065) — the branch this review card carries
              already landed in the target branch: a small moss chip + an EXPLICIT
              "→ Done" button. Deliberately never automatic (F050) — the user
              clicks, the card moves, the reviewedBy stamp survives (moveCard
              keeps it for the done column). */}
          {!isEditing && isReview && task.branch && isMerged && (
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
                  onMoveToDone(task.id)
                }}
                onKeyDown={e => {
                  // Don't let Enter/Space bubble to the card's open-drawer
                  // keydown handler.
                  if (e.key === 'Enter' || e.key === ' ') e.stopPropagation()
                }}
                title={t('board.card.mergedToDoneTitle')}
                className="min-w-0 truncate rounded-sm px-1 py-0.5 text-[10px] text-ink-muted transition-colors hover:bg-bg-inset hover:text-moss active:bg-bg-inset active:text-moss focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
              >
                {t('board.card.mergedToDone')}
              </button>
            </div>
          )}
          {/* Footer — PR link + dependency chip "⛓ n" (unresolved deps, B025) +
              due chip (B026) on the left; assignee (small faint text) on the
              right. The chips are pure information — not interactive, title
              carries the detail. */}
          {!isEditing &&
            (() => {
              // On a dependency cycle ⇒ the ⑤ DEPENDS gate would hold this card
              // forever. Warn with a ⚠ chip.
              // Priority chip shows only when it deviates from the default
              // ('normal'/absent) — a plain card stays visually unchanged.
              const showPriority = !!task.priority && task.priority !== 'normal'
              if (
                !task.prUrl &&
                !task.assignee?.trim() &&
                !task.dueDate &&
                depCount === 0 &&
                !inCycle &&
                !showPriority
              )
                return null
              const doneCard = task.done || isDone
              return (
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {task.priority && task.priority !== 'normal' && (
                      <span
                        title={t('board.card.priorityTitle', {
                          label: t(PRIORITY_META[task.priority].labelKey),
                        })}
                        className={`shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_META[task.priority].chipClass}`}
                      >
                        {t(PRIORITY_META[task.priority].labelKey)}
                      </span>
                    )}
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
                    {depCount > 0 && (
                      <span
                        title={t('board.card.depsTitle', { titles: depTitlesText })}
                        className="shrink-0 text-[10px] text-ink-muted"
                      >
                        {/* U+FE0E pins text presentation — without it some
                            platforms render the chain as a color emoji. */}
                        ⛓︎ {depCount}
                      </span>
                    )}
                    {inCycle && (
                      <span
                        title={t('board.card.cycleTitle')}
                        className="shrink-0 rounded-sm border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent"
                      >
                        {/* U+FE0E forces text (not emoji) rendering of the
                            warning sign — matches the chain. */}
                        ⚠︎ {t('board.card.cycleChip')}
                      </span>
                    )}
                    {task.dueDate && (
                      <span
                        title={t('board.card.dueTitle', { date: task.dueDate })}
                        className={[
                          // max-w + truncate: a malformed/long due string can't
                          // blow the card footer row; title carries the full
                          // value.
                          'max-w-[96px] truncate text-[10px]',
                          // Today (inclusive) or earlier = needs attention —
                          // unless the card is done.
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

// Default shallow prop comparison is exactly what we want: every prop is a
// primitive or a stable reference (BoardTab guarantees this), and `task` keeps
// identity for untouched cards. So an unchanged card short-circuits here and its
// subtree is neither re-rendered nor reconciled.
export const BoardCard = memo(BoardCardInner)
