import { memo } from 'react'
import { Copy, GripVertical } from 'lucide-react'
import type { BoardColumn, ClaudeBeaconStatus, ClaudeEffort, EscalationWhy, ProjectTask } from '@/lib/types'
import { formatDueShort, isOverdue } from '@/lib/boardDeps'
import { PRIORITY_META } from '@/lib/boardPriority'
import { deriveManagerTone } from '@/lib/boardWorker'
import type {
  ManagerPresence,
  ManagerReviewStatus,
  ManagerTone,
  WorkerActivity,
} from '@/lib/boardWorker'
import { SwarmSprite } from './SwarmSprite'
import { spriteStateFor, type SpriteState } from '@/lib/swarm/sprites'
import { useT } from '@/i18n/I18nContext'
import type { MessageKey } from '@/i18n/messages'

// ── Swarm worker status vocabulary (doing-column cards) ──────────────────────
// The SAME beacon palette the Ground/Board cards + the SwarmWorkerPane already
// use: moss = working, ochre = waiting, ink-faint = booting/idle.
// Display-only (the strip carries no interactions) — these are status colours,
// so contrast on the paper card (moss/ochre/ink-faint all clear AA) is the
// only CLAUDE.md rule that bites here.
// ⚠ THE COLOUR VOCABULARY IS THREE (案C: 「色は状態だけ — 稼働=苔・待ち=黄土・高=朱」).
// Azure was not in it. This card dropped it first; on 2026-08-04 the rest of
// the app followed and the token was deleted outright, so the fourth colour
// cannot come back by someone reaching for it.
const WORKER_BAND: Record<WorkerActivity, string> = {
  working: 'bg-moss',
  waiting: 'bg-ochre',
  starting: 'bg-ink-faint',
  done: 'bg-moss',
}
const WORKER_DOT: Record<WorkerActivity, string> = {
  // The lamps carry their glow (shadow-lamp-*) — a dot without it is a bullet.
  working: 'bg-moss shadow-lamp-moss',
  waiting: 'bg-ochre shadow-lamp-ochre',
  starting: 'bg-ink-faint',
  done: 'bg-moss',
}
const WORKER_LABEL_CLS: Record<WorkerActivity, string> = {
  // moss-TEXT, not moss: the lamp's fill is too dark to read as a label.
  working: 'text-moss-text',
  waiting: 'text-[var(--beacon-waiting)]',
  starting: 'text-ink-faint',
  done: 'text-moss-text',
}
// Localized via the SAME keys the Swarm Manager monitor + worker pane use, so a
// JA owner sees 稼働中 / 待機中 / 起動中 / 完了 — not a board-only English island.
const WORKER_LABEL_KEY: Record<WorkerActivity, MessageKey> = {
  working: 'projectPanel.swarm.manager.stageRunning',
  waiting: 'projectPanel.swarm.statusWaiting',
  starting: 'projectPanel.swarm.manager.stageStarting',
  done: 'projectPanel.swarm.manager.stageDone',
}

// ── Commander linkage vocabulary (review-column cards) ───────────────────────
// Same three-colour rule as the worker strip: moss=working, ochre=waiting,
// ink-faint=off. The ONE addition is accent for a conflict — the same red the
// integrationConflict chip below already uses for "needs the owner's hands".
const MANAGER_DOT: Record<ManagerTone, string> = {
  working: 'bg-moss shadow-lamp-moss',
  waiting: 'bg-ochre shadow-lamp-ochre',
  alert: 'bg-accent',
  off: 'bg-ink-faint',
}

/** The commander's figure, per lamp tone. EXHAUSTIVE, and `null` is a real
 *  entry rather than a gap: with the commander absent there is nobody to draw,
 *  and the dot stays. Drawing the owl anyway would need a state to draw it in,
 *  and every state in the set is a claim that it is there. */
const MANAGER_SPRITE: Record<ManagerTone, SpriteState | null> = {
  working: 'working',
  waiting: 'waiting',
  // The same rank `spriteStateFor` gives an escalation: an integration conflict
  // is the commander's hands-up, and it is the one tone that is about the owner.
  alert: 'asking',
  off: null,
}
/** What the owl's figure SAYS, in words, for a reader who cannot see it move.
 *  Keyed off the same tone the figure is drawn from so the two cannot disagree;
 *  `off` never reaches it (no figure is drawn — see MANAGER_SPRITE). */
const MANAGER_SPRITE_LABEL_KEY: Record<ManagerTone, MessageKey> = {
  working: 'projectPanel.swarm.manager.stageRunning',
  waiting: 'projectPanel.swarm.statusWaiting',
  alert: 'projectPanel.swarm.manager.reviewConflict',
  off: 'board.card.managerMissing',
}

// Presence word colour follows the PRESENCE (not the lamp tone), so a conflict
// lamp never paints 稼働中 red — the status text carries the red instead.
const MANAGER_PRESENCE_CLS: Record<Exclude<ManagerPresence, 'unknown'>, string> = {
  working: 'text-moss-text',
  quiet: 'text-[var(--beacon-waiting)]',
  missing: 'text-ink-faint',
}
// Localized via the SAME keys the Swarm tab uses (稼働中/待機中 + the review
// readiness labels), so the board never becomes a second vocabulary island.
const MANAGER_PRESENCE_KEY: Record<Exclude<ManagerPresence, 'unknown'>, MessageKey> = {
  working: 'projectPanel.swarm.manager.stageRunning',
  quiet: 'projectPanel.swarm.statusWaiting',
  missing: 'board.card.managerMissing',
}
const MANAGER_STATUS_KEY: Record<ManagerReviewStatus, MessageKey> = {
  ff: 'projectPanel.swarm.manager.reviewFf',
  rebase: 'projectPanel.swarm.manager.reviewRebase',
  conflict: 'projectPanel.swarm.manager.reviewConflict',
  unknown: 'projectPanel.swarm.manager.reviewUnknown',
}
const MANAGER_STATUS_HINT_KEY: Record<ManagerReviewStatus, MessageKey> = {
  ff: 'projectPanel.swarm.manager.reviewFfHint',
  rebase: 'projectPanel.swarm.manager.reviewRebaseHint',
  conflict: 'projectPanel.swarm.manager.reviewConflictHint',
  unknown: 'projectPanel.swarm.manager.reviewUnknownHint',
}

// ── Worker phase vocabulary (常設フェーズ表示) ───────────────────────────────
// The heartbeat phase is free-form, but the swarm's own workers speak a small
// known vocabulary (the order skill's phases) — map THOSE to owner-plain words
// (平易文: a non-programmer reads this board). Anything unknown renders
// verbatim — never invent a meaning for a word we don't know.
const WORKER_PHASE_KEY: Record<string, MessageKey> = {
  audit: 'board.card.phaseAudit',
  implement: 'board.card.phaseImplement',
  verify: 'board.card.phaseVerify',
  rework: 'board.card.phaseRework',
  blocked: 'board.card.phaseBlocked',
  done: 'board.card.phaseDone',
}

// ── Needs-you vocabulary (ANY column) ───────────────────────────────────────
// An open escalation names this card: the swarm stopped and is waiting for the
// owner's hands. The reason word is the raiser's own `whyEscalated` valve — we
// never re-classify it, and there is no fourth value to fall through to (the
// route rejects anything else at the door).
const NEEDS_YOU_REASON_KEY: Record<EscalationWhy, MessageKey> = {
  irreversible: 'board.card.needsYouIrreversible',
  'insufficient-info': 'board.card.needsYouInsufficientInfo',
  policy: 'board.card.needsYouPolicy',
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
  /** How old the worker's note is — 'fresh' = still a statement about now,
   *  'stale' = it describes the past. UNDEFINED means the engine gave us no
   *  beat time, so the note cannot be dated: the note LINE is then not rendered
   *  at all rather than presented as current (the tooltip still carries it).
   *  Absence of evidence is never rendered as evidence. */
  workerNoteFreshness?: 'fresh' | 'stale'
  /** WHAT this worker is running on, printed verbatim as `opus/high`.
   *
   *  ⚠ The owner asked for the model and the effort BY NAME, not for the
   *  internal weight bucket ("重い/軽い") that picks them — the bucket is a
   *  routing detail decided by a keyword match on the card's own text, and the
   *  thing worth checking at a glance is whether THIS card got the tier it
   *  deserved. Both are short fixed tokens (fable/opus/sonnet × low/medium/
   *  max…), so unlike the branch handle and the report that left this card on
   *  2026-08-23, the pair lands whole in the width a collapsed lane hands back. */
  workerModel?: string
  workerEffort?: ClaudeEffort
  /** An OPEN escalation names THIS card — the swarm stopped and the owner's
   *  hands are required. Lane-independent (unlike the worker/commander strips):
   *  it is rooted in `escalation.taskId`, which no column owns. false/absent ⇒
   *  no badge, and NO "all clear" claim either — the board never says nothing
   *  is waiting unless a `status=open` read actually succeeded. */
  needsYou?: boolean
  needsYouReason?: EscalationWhy
  /** 平易文 (or the raw question) for the row's tooltip — never body text. */
  needsYouHint?: string
  /** Commander linkage for THIS (review) card — resolved by BoardTab from the
   *  same orchestrator poll (the engine's review queue + the commander's
   *  presence), as primitives for the memo. null presence = no linkage (not a
   *  review card, not in the engine's queue, or not the owner). Deliberately no
   *  commander phase/note props: that heartbeat text is board-wide, and riding
   *  it on one card would claim the commander is on THIS card (差し戻し M1). */
  managerPresence: ManagerPresence | null
  managerReviewStatus?: ManagerReviewStatus
  /** The engine's OFFLINE HOLD (2026-09-02) — see BoardCardManager.offlineHold. */
  managerOfflineHold?: boolean
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
  workerNoteFreshness,
  workerModel,
  workerEffort,
  needsYou,
  needsYouReason,
  needsYouHint,
  managerPresence,
  managerReviewStatus,
  managerOfflineHold,
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
  // What the strip STOPPED showing but must not lose (owner, 2026-08-23): the
  // branch handle and the worker's own last report. Both were visible rows and
  // both were always truncated on a ~260px card — the branch to `swarm/f…`, the
  // report to a cut half-sentence — so they informed nobody while costing two
  // rows. They move here, and live in full in the Swarm tab, which has the room.
  // The freshness rule survives the move UNCHANGED: an undatable note is still
  // omitted entirely (we cannot say when it was true), and a stale one still
  // carries its 「最後の報告:」 prefix, because a bare note IS a claim about now
  // whether it sits in a row or in a tooltip.
  const workerHint = hasWorker
    ? [
        workerBranch,
        workerNote && workerNoteFreshness
          ? `${workerNoteFreshness === 'stale' ? `${t('board.card.noteStale')} ` : ''}${workerNote}`
          : '',
      ]
        .filter(Boolean)
        .join(' — ')
    : ''
  // Commander linkage on a review card — the presence/readiness pair arrives
  // together from BoardTab (split into primitives only for the memo); lamp tone
  // precomputed for the strip below.
  const manager =
    managerPresence !== null && managerReviewStatus !== undefined
      ? {
          presence: managerPresence,
          reviewStatus: managerReviewStatus,
          tone: deriveManagerTone(managerPresence, managerReviewStatus),
          ...(managerOfflineHold ? { offlineHold: true } : {}),
        }
      : null
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
        // 計器盤 language: the resting card is a borderless raised surface
        // (bg-card + shadow on the inset well); hover deepens the shadow.
        // 罫線なし・面の明度差のみ (案C). The selected/editing states use an
        // INSET ring rather than a border: a ring does not occupy layout, so the
        // card keeps the mock's 12/13px padding in every state instead of
        // reserving a transparent 1px for a border it usually does not draw.
        'group relative rounded-[10px] px-[13px] py-3 transition-[background-color,transform,box-shadow]',
        isEditing
          ? 'cursor-default ring-1 ring-inset ring-accent'
          : 'cursor-grab hover:bg-bg-card-hover active:scale-[0.99] active:cursor-grabbing',
        // The card whose detail drawer is open reads as selected: accent ring
        // + a light accent wash.
        isSelected && !isEditing ? 'bg-accent/15 ring-1 ring-inset ring-accent' : 'bg-bg-card',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink',
        isDragHidden ? 'hidden' : '',
      ].join(' ')}
    >
      {/* Top edge — the surveyor's marking. A swarm worker on a doing card takes
          precedence (moss scanning while its PTY produces output, steady
          otherwise — synced to the worker; it disappears the moment the engine
          drops the worker). Otherwise the same claude-status band the Ground
          cards carry: moss scanning while claude works, steady amber while it
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
              claudeStatus === 'working' ? 'bg-moss' : 'bg-ochre',
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
              : 'opacity-0 hover:bg-plane hover:text-ink active:bg-plane active:text-ink group-hover:opacity-100',
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
              className="w-full resize-none rounded-[3px] border border-line bg-bg px-2 py-1.5 text-ui leading-snug text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
            />
          ) : (
            <p className="text-ui leading-[1.55] text-ink line-clamp-3 [overflow-wrap:anywhere]">
              {/* Drawer-claude stamp — suppressed when a swarm worker owns the
                  card (its strip below is the authoritative status), so the two
                  never show conflicting states on one card. */}
              {!hasWorker && claudeStatus === 'working' && (
                <span
                  title={t('board.card.sessionWorking')}
                  className="mr-1.5 inline-flex shrink-0 items-center gap-1 whitespace-nowrap align-middle text-meta text-moss-text"
                >
                  <span className="run-pulse h-1.5 w-1.5 rounded-full bg-moss shadow-lamp-moss" />
                  {t('board.card.sessionWorkingLabel')}
                </span>
              )}
              {!hasWorker && claudeStatus === 'waiting' && (
                // Steady, no pulse — "your turn" must stay visible at a glance
                // (same register as the Ground card's Waiting stamp).
                <span
                  title={t('board.card.sessionWaiting')}
                  className="mr-1.5 inline-flex shrink-0 items-center gap-1 whitespace-nowrap align-middle text-meta text-[var(--beacon-waiting)]"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-ochre shadow-lamp-ochre" />
                  {t('board.card.sessionWaitingLabel')}
                </span>
              )}
              {task.title || t('board.card.untitledParen')}
            </p>
          )}
          {/* Body preview — the first two lines of the card's own notes. NOT
              shown once a swarm worker owns the card (owner, 2026-08-23): a
              dispatched card's notes open with the brief (【背景】…), which at
              two lines of a ~260px card is always cut mid-path and says
              nothing. The title already names the task; the body is one tap
              away in the drawer. On an undispatched card the notes are usually
              short and the preview earns its place, so it stays. */}
          {!isEditing && !hasWorker && task.notes?.trim() && (
            <p className="mt-[7px] text-ui leading-[1.6] line-clamp-2 text-ink-muted [overflow-wrap:anywhere]">
              {task.notes.trim()}
            </p>
          )}
          {/* Needs-you line — an OPEN escalation is rooted in THIS card, so the
              swarm has stopped and is waiting for the owner. Rendered in ANY
              column (an escalation's taskId is lane-independent) and FIRST,
              above the worker strip: "a decision is blocked here" outranks
              "something is running here".
              Accent (朱) with NO glow and NO pulse — deliberately: the three
              status colours mean 稼働=苔 / 待ち=黄土 / 高=朱, and this is a
              STOPPED thing. A breathing lamp would read as activity. It also
              does NOT suppress the worker strip below: "a worker asked you a
              question and is still sitting on the card" is two true facts, not
              a contradiction, so the single-status precedence rule (hasWorker
              suppressing the claude band/stamp) is untouched.
              Read-only by design — answering declares a declineEffect (保留 vs
              見送る are different acts), which must never ride on one tap on a
              166px card. The full question lives in the tooltip. */}
          {!isEditing && needsYou && (
            <div
              className="mt-[9px] flex min-w-0 items-center gap-1.5"
              {...(needsYouHint ? { title: needsYouHint } : {})}
            >
              <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              <span className="shrink-0 whitespace-nowrap text-meta text-accent">
                {t('board.card.needsYou')}
              </span>
              {needsYouReason && (
                <span className="min-w-0 truncate text-meta text-ink-muted">
                  · {t(NEEDS_YOU_REASON_KEY[needsYouReason])}
                </span>
              )}
            </div>
          )}
          {/* Swarm worker strip (条件①②) — that a worker is on this doing card and
              whether it's running / waiting / booting, in the same beacon
              vocabulary as the band above and the Swarm pane. ONE row, and it
              must stay one row: this card is ~260px and everything that shared
              the strip with 稼働中 got truncated away (2026-08-23). The branch
              handle it used to end with now lives in the tooltip.
              Owner-only + doing-only (gated where `worker` is resolved); the dot
              breathes only while working so "your worker is busy" reads at a
              glance without a second moving element competing with the band. */}
          {!isEditing && hasWorker && (
            <div
              className="mt-[9px] flex min-w-0 items-center gap-1.5"
              {...(workerHint ? { title: workerHint } : {})}
            >
              {/* THE WORKER, as a figure rather than a lamp (owner, 2026-08-15).
                  A 6px dot could say "something is on" and nothing else; the
                  rabbit says WHO is on the card and WHAT it is doing, because
                  each state moves differently — which at this size reads before
                  colour does. `asking` outranks the activity: a worker whose
                  question is unanswered is not "working" from where the owner
                  sits, whatever its process is doing (spriteStateFor). */}
              <SwarmSprite
                role="worker"
                state={spriteStateFor({
                  activity: workerActivity,
                  ...(needsYou ? { asking: true } : {}),
                })}
                label={`${t('board.card.workerLabel')} ${
                  needsYou ? t('board.card.needsYou') : t(WORKER_LABEL_KEY[workerActivity])
                }`}
                className="shrink-0"
              />
              <span
                className={[
                  // NOT label-cap: the mock's state line is never uppercased
                  // because it carries Japanese — and for the same reason it
                  // carries no tracking. .1em widened 稼働中 to 36.3px and left
                  // 0 chars for the branch name beside it (2026-08-04).
                  'shrink-0 whitespace-nowrap text-meta',
                  WORKER_LABEL_CLS[workerActivity],
                ].join(' ')}
              >
                {t(WORKER_LABEL_KEY[workerActivity])}
              </span>
              {/* Phase — the worker's self-reported heartbeat phase
                  (audit/implement/verify…). The ONE piece of "what is it doing"
                  that fits on this card: a single short word from a small
                  vocabulary, so 稼働中 · verify lands whole where a branch or a
                  sentence could not. Free vocabulary, so still truncate-guarded
                  — an engine that one day reports a phrase must not reflow the
                  strip into two rows. */}
              {workerPhase && (
                <span className="min-w-0 truncate whitespace-nowrap font-mono text-meta text-ink-faint">
                  · {WORKER_PHASE_KEY[workerPhase] ? t(WORKER_PHASE_KEY[workerPhase]) : workerPhase}
                </span>
              )}
              {/* The run itself. `shrink-0` on purpose: if this strip ever runs
                  out of room the PHASE above gives way first — a truncated
                  `opu…` names no tier at all, while a missing phase still leaves
                  a card that says what it is running on. Absent for a worker the
                  engine never dispatched (nothing truthful to print). */}
              {workerModel && (
                <span className="ml-auto shrink-0 whitespace-nowrap font-mono text-meta text-ink-faint">
                  {workerEffort ? `${workerModel}/${workerEffort}` : workerModel}
                </span>
              )}
            </div>
          )}
          {/* Commander strip (review-column cards) — WHO lands this card and
              whether they are around right now. The doing column shows the
              worker that BUILDS a card; review shows the COMMANDER that
              INTEGRATES it: presence lamp + word (稼働中/待機中/不在 — omitted
              when the server didn't say), then this card's integration
              readiness from the engine's review queue. Same strip idiom as the
              worker strip above; the tooltip carries ONLY this card's own
              readiness hint — never the commander's phase/note, which is
              board-wide and would falsely read as "about this card" on every
              review card at once (差し戻し M1). Owner-only + engine-listed
              only — gated where `managerForTask` resolves (BoardModule). */}
          {!isEditing && manager && (
            <div
              className="mt-[9px] flex min-w-0 items-center gap-1.5"
              title={t(MANAGER_STATUS_HINT_KEY[manager.reviewStatus])}
            >
              {/* THE COMMANDER. Same rule as the worker's rabbit above — and
                  the one tone with no figure is `off`, where the dot stays:
                  there is nobody to draw, and every state the owl has would
                  claim it is there. */}
              {MANAGER_SPRITE[manager.tone] ? (
                <SwarmSprite
                  role="commander"
                  state={MANAGER_SPRITE[manager.tone]!}
                  label={`${t('board.card.managerLabel')} ${t(
                    MANAGER_SPRITE_LABEL_KEY[manager.tone],
                  )}`}
                  className="shrink-0"
                />
              ) : (
                <span
                  aria-hidden
                  className={['h-1.5 w-1.5 shrink-0 rounded-full', MANAGER_DOT[manager.tone]].join(
                    ' ',
                  )}
                />
              )}
              <span className="shrink-0 whitespace-nowrap text-meta text-ink-muted">
                {t('board.card.managerLabel')}
              </span>
              {manager.offlineHold ? (
                // The OFFLINE HOLD (2026-09-02): the engine is not poking the
                // desk because the machine cannot reach the API. Say THAT — a
                // bare 待機中 here reads as a stalled commander, which is the
                // misreading that sent the owner to the Swarm tab by hand.
                <span className="shrink-0 whitespace-nowrap text-meta text-[var(--beacon-waiting)]">
                  {t('projectPanel.swarm.statusOfflineHold')}
                </span>
              ) : (
                manager.presence !== 'unknown' && (
                  <span
                    className={[
                      'shrink-0 whitespace-nowrap text-meta',
                      MANAGER_PRESENCE_CLS[manager.presence],
                    ].join(' ')}
                  >
                    {t(MANAGER_PRESENCE_KEY[manager.presence])}
                  </span>
                )
              )}
              <span
                className={[
                  'min-w-0 truncate text-meta',
                  manager.reviewStatus === 'conflict' ? 'text-accent' : 'text-ink-muted',
                ].join(' ')}
              >
                · {t(MANAGER_STATUS_KEY[manager.reviewStatus])}
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
                className="mt-1 flex max-w-full items-center gap-1 rounded-sm px-0 py-0.5 text-micro text-moss transition-colors hover:text-ink active:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-moss"
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
                className="mt-1 whitespace-nowrap rounded-sm border border-line px-1.5 py-0.5 text-micro text-ink-muted transition-colors hover:border-moss hover:text-moss active:border-moss active:text-moss focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-line disabled:hover:text-ink-muted"
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
              className="mt-1 flex min-w-0 items-center gap-1 rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-micro text-accent"
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
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 gap-y-1">
              <span
                title={t('board.card.mergedTitle')}
                className="shrink-0 rounded-sm border border-moss/40 bg-moss/10 px-1.5 py-0.5 text-micro leading-none text-moss"
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
                className="min-w-0 truncate rounded-sm px-1 py-0.5 text-micro text-ink-muted transition-colors hover:bg-plane hover:text-moss active:bg-plane active:text-moss focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted"
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
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 gap-y-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    {task.priority && task.priority !== 'normal' && (
                      <span
                        title={t('board.card.priorityTitle', {
                          label: t(PRIORITY_META[task.priority].labelKey),
                        })}
                        className={`shrink-0 rounded-full px-[9px] py-0.5 text-meta font-semibold ${PRIORITY_META[task.priority].chipClass}`}
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
                        className="shrink-0 rounded-sm border border-line px-1.5 py-0.5 text-micro text-ink-muted transition-colors hover:border-accent hover:bg-accent/10 hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                      >
                        PR ↗
                      </a>
                    )}
                    {depCount > 0 && (
                      <span
                        title={t('board.card.depsTitle', { titles: depTitlesText })}
                        className="shrink-0 text-micro text-ink-muted"
                      >
                        {/* U+FE0E pins text presentation — without it some
                            platforms render the chain as a color emoji. */}
                        ⛓︎ {depCount}
                      </span>
                    )}
                    {inCycle && (
                      <span
                        title={t('board.card.cycleTitle')}
                        className="shrink-0 rounded-sm border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-micro font-medium text-accent"
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
                          'max-w-[96px] truncate text-micro',
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
                    <p className="min-w-0 truncate text-right text-micro text-ink-faint">
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
