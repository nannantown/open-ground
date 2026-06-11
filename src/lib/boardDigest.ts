// Post-sync board digest — a compact one-liner describing WHAT a share Sync's
// pull changed on the Board, shown in ProjectPanel's share notice instead of
// the generic "Synced". Pure (tasks in → string out) so it unit-tests without
// React or the server; the caller owns snapshotting before/after task lists.
//
// Naming rule (S9/S33): up to NAME_LIMIT cards per change kind are named by
// TITLE ("Account page" → In review); larger batches fall back to the count
// forms so a big pull stays one readable line.

import type { ProjectTask } from '@/lib/types'

/** Minimal translate signature (structurally matches I18nContext's `t`) so the
 *  helper stays decoupled from the React context. */
export type TranslateFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string

/** Undefined column = 'todo' (back-compat, same rule the Board itself uses) —
 *  a card whose column key merely materialised did not actually move. */
const column = (task: ProjectTask): string => task.boardColumn ?? 'todo'

const NAME_LIMIT = 2
const TITLE_MAX = 14

/** Diff `before` → `after` board tasks into a compact digest line, e.g.
 *  `+"Login flow" (Yuki) · "API design" → In review` /
 *  `カード+「Login flow」（Yuki） · 「API design」→ レビュー待ち`.
 *
 *  Segments, in display order:
 *  - added cards — titles up to NAME_LIMIT (with the distinct assignees of
 *    the added cards when any are set), count beyond;
 *  - newly done cards (done flipped false → true). Completion usually parks
 *    the card in the done column too, so a newly-done card is NOT also
 *    counted as a column move;
 *  - column moves (same card, different column, not newly done) — named as
 *    `"title" → <column label>` up to NAME_LIMIT;
 *  - reassignments (same card, assignee changed) — `"title" → name` up to
 *    NAME_LIMIT, count beyond (a cleared assignee counts but isn't named);
 *  - removed cards — titles up to NAME_LIMIT, count beyond.
 *
 *  Returns null when nothing board-visible changed — the caller falls back to
 *  the generic success message. */
export const boardDiffDigest = (
  before: ProjectTask[],
  after: ProjectTask[],
  t: TranslateFn,
): string | null => {
  const beforeById = new Map(before.map(task => [task.id, task]))
  const afterIds = new Set(after.map(task => task.id))

  const wrap = (task: ProjectTask): string => {
    const raw = task.title.trim() || t('board.card.untitledParen')
    const title = raw.length > TITLE_MAX ? raw.slice(0, TITLE_MAX) + '…' : raw
    return t('projectPanel.syncDigestTitle', { title })
  }
  const titles = (tasks: ProjectTask[]): string => tasks.map(wrap).join(' ')

  const added = after.filter(task => !beforeById.has(task.id))
  const removed = before.filter(task => !afterIds.has(task.id))

  const doneTasks: ProjectTask[] = []
  const movedTasks: ProjectTask[] = []
  const reassigned: ProjectTask[] = []
  for (const task of after) {
    const prev = beforeById.get(task.id)
    if (!prev) continue
    if (!prev.done && task.done) doneTasks.push(task)
    else if (column(prev) !== column(task)) movedTasks.push(task)
    if ((prev.assignee ?? '').trim() !== (task.assignee ?? '').trim()) reassigned.push(task)
  }

  const segments: string[] = []
  if (added.length > 0) {
    const names = Array.from(
      new Set(added.map(task => (task.assignee ?? '').trim()).filter(Boolean)),
    ).join(', ')
    if (added.length <= NAME_LIMIT) {
      segments.push(
        t(names ? 'projectPanel.syncDigestAddedTitlesBy' : 'projectPanel.syncDigestAddedTitles', {
          titles: titles(added),
          names,
        }),
      )
    } else {
      segments.push(
        t(names ? 'projectPanel.syncDigestAddedBy' : 'projectPanel.syncDigestAdded', {
          count: added.length,
          names,
        }),
      )
    }
  }
  if (doneTasks.length > 0) {
    segments.push(
      doneTasks.length <= NAME_LIMIT
        ? t('projectPanel.syncDigestDoneTitles', { titles: titles(doneTasks) })
        : t('projectPanel.syncDigestDone', { count: doneTasks.length }),
    )
  }
  if (movedTasks.length > 0) {
    if (movedTasks.length <= NAME_LIMIT) {
      for (const task of movedTasks) {
        segments.push(
          t('projectPanel.syncDigestMovedOne', {
            title: wrap(task),
            column: t(`board.col.${column(task)}`),
          }),
        )
      }
    } else {
      segments.push(t('projectPanel.syncDigestMoved', { count: movedTasks.length }))
    }
  }
  if (reassigned.length > 0) {
    const named = reassigned.filter(task => (task.assignee ?? '').trim())
    if (reassigned.length <= NAME_LIMIT && named.length === reassigned.length) {
      for (const task of named) {
        segments.push(
          t('projectPanel.syncDigestAssigned', {
            title: wrap(task),
            name: (task.assignee ?? '').trim(),
          }),
        )
      }
    } else {
      segments.push(t('projectPanel.syncDigestAssigneeChanged', { count: reassigned.length }))
    }
  }
  if (removed.length > 0) {
    segments.push(
      removed.length <= NAME_LIMIT
        ? t('projectPanel.syncDigestRemovedTitles', { titles: titles(removed) })
        : t('projectPanel.syncDigestRemoved', { count: removed.length }),
    )
  }

  return segments.length > 0 ? segments.join(' · ') : null
}
